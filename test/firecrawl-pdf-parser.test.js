import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { convertPdfToMarkdown } from '../src/core/ingestion/pdf-parser.js';

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function startFirecrawlServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      await handler(request, response, requests);
    } catch (error) {
      writeJson(response, 500, { success: false, error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function createFirecrawlFixture(prefix) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const pdfPath = path.join(rootPath, 'paper.pdf');
  const markerDir = path.join(rootPath, '.papernexus', 'marker');
  const markdownDir = path.join(rootPath, '.papernexus', 'markdown');
  const pdfParseStateRoot = path.join(rootPath, '.papernexus', 'pdf-parser');
  await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
  return { rootPath, pdfPath, markerDir, markdownDir, pdfParseStateRoot };
}

function withFirecrawlEnv(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

test('Firecrawl upload parser writes markdown cache and reuses it', async () => {
  const restoreEnv = withFirecrawlEnv('PAPERNEXUS_TEST_FIRECRAWL_KEY', 'test-firecrawl-key');
  const fixture = await createFirecrawlFixture('papernexus-firecrawl-upload-');
  const server = await startFirecrawlServer(async (request, response, requests) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: body.toString('utf8')
    });
    writeJson(response, 200, {
      success: true,
      data: {
        markdown: '# Firecrawl Upload\n\nBody text from upload.',
        metadata: { title: 'Firecrawl Upload' }
      }
    });
  });

  try {
    const options = {
      pdfParser: 'firecrawl',
      firecrawlApiBaseUrl: server.baseUrl,
      firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_KEY',
      firecrawlMode: 'ocr',
      disableDoclingFallback: true,
      ...fixture
    };
    const result = await convertPdfToMarkdown(fixture.pdfPath, options);
    assert.equal(result.parser, 'firecrawl');
    assert.equal(result.generated, true);
    assert.match(result.markdownPath, /firecrawl/);
    assert.equal(result.parserCommand, 'firecrawl:/v2/parse mode=ocr source=upload');
    assert.equal(typeof result.timings?.firecrawlRequestMs, 'number');
    assert.equal(result.timings?.mineruRequestMs, 0);

    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Body text from upload/);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, 'POST');
    assert.equal(server.requests[0].url, '/v2/parse');
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-firecrawl-key');
    assert.match(server.requests[0].headers['content-type'], /multipart\/form-data/);
    assert.match(server.requests[0].body, /"mode":"ocr"/);
    assert.doesNotMatch(JSON.stringify(result), /test-firecrawl-key/);

    const state = await fs.readFile(result.pdfParseStatePath, 'utf8');
    const events = await fs.readFile(result.pdfParseLogPath, 'utf8');
    assert.doesNotMatch(state, /test-firecrawl-key/);
    assert.doesNotMatch(events, /test-firecrawl-key/);

    const cached = await convertPdfToMarkdown(fixture.pdfPath, options);
    assert.equal(cached.generated, false);
    assert.equal(server.requests.length, 1);
  } finally {
    restoreEnv();
    await server.close();
    await fs.rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test('Firecrawl parser feeds analyzeCorpus source manifest and semantic snapshots', async () => {
  const restoreEnv = withFirecrawlEnv('PAPERNEXUS_TEST_FIRECRAWL_KEY_ANALYZE', 'test-firecrawl-analyze-key');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-firecrawl-analyze-'));
  const pdfPath = path.join(rootPath, 'firecrawl-analysis.pdf');
  const server = await startFirecrawlServer(async (request, response, requests) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: body.toString('utf8')
    });
    const repeatedEvidence = Array.from({ length: 8 }, (_, index) => (
      `Evidence paragraph ${index + 1} describes retrieval augmented academic paper parsing, `
      + 'table-aware extraction, citation-grounded metadata, and markdown normalization for scientific corpora.'
    )).join('\n\n');
    writeJson(response, 200, {
      success: true,
      data: {
        markdown: [
          '# Firecrawl Academic Parser Study',
          '',
          '## Abstract',
          '',
          'We evaluate Firecrawl as an optional PDF-to-Markdown parser for academic corpora.',
          '',
          '## Method',
          '',
          repeatedEvidence,
          '',
          '## Experiments',
          '',
          repeatedEvidence
        ].join('\n')
      }
    });
  });

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    const [
      ingestion,
      corpusStore
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await ingestion.analyzeCorpus(rootPath, {
      name: 'firecrawl-analyze-test',
      force: true,
      pdfParser: 'firecrawl',
      firecrawlApiBaseUrl: server.baseUrl,
      firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_KEY_ANALYZE',
      firecrawlMode: 'auto',
      firecrawlSourceMode: 'upload',
      semanticExtraction: 'heuristic-only',
      disableDoclingFallback: true
    });

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/v2/parse');
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-firecrawl-analyze-key');
    assert.equal(result.meta.pdfParser, 'firecrawl');
    assert.ok(result.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Firecrawl Academic Parser Study'));

    const manifest = await corpusStore.loadSourceManifest(rootPath);
    assert.equal(manifest.pdfParser, 'firecrawl');
    const entry = manifest.sources.find((source) => source.sourcePath === pdfPath);
    assert.ok(entry, 'expected source manifest entry for the Firecrawl-parsed PDF');
    assert.match(entry.sourceMarkdownPath, /\.papernexus\/markdown\/firecrawl\//);
    assert.doesNotMatch(JSON.stringify(entry), /test-firecrawl-analyze-key/);

    const snapshot = await corpusStore.loadSemanticPaperSnapshot(rootPath, entry.sourceKey);
    assert.equal(snapshot.paperTitle, 'Firecrawl Academic Parser Study');
    assert.equal(snapshot.llm.semanticExtractionMode, 'heuristic-only');
    assert.equal(snapshot.llm.semanticExtractionParticipated, false);
  } finally {
    restoreEnv();
    await server.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('Firecrawl URL parser sends scrape request with PDF parser options', async () => {
  const restoreEnv = withFirecrawlEnv('PAPERNEXUS_TEST_FIRECRAWL_KEY_URL', 'test-firecrawl-url-key');
  const fixture = await createFirecrawlFixture('papernexus-firecrawl-url-');
  const server = await startFirecrawlServer(async (request, response, requests) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(body.toString('utf8'))
    });
    writeJson(response, 200, {
      success: true,
      data: {
        markdown: '# Firecrawl URL\n\nBody text from URL scrape.'
      }
    });
  });

  try {
    const result = await convertPdfToMarkdown(fixture.pdfPath, {
      pdfParser: 'firecrawl',
      firecrawlApiBaseUrl: server.baseUrl,
      firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_KEY_URL',
      firecrawlMode: 'fast',
      firecrawlSourceMode: 'url',
      firecrawlSourceUrl: 'https://example.test/paper.pdf',
      firecrawlMaxPages: 3,
      disableDoclingFallback: true,
      ...fixture
    });

    assert.equal(result.parser, 'firecrawl');
    assert.equal(result.parserCommand, 'firecrawl:/v2/scrape mode=fast source=url');
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/v2/scrape');
    assert.equal(server.requests[0].body.url, 'https://example.test/paper.pdf');
    assert.deepEqual(server.requests[0].body.formats, ['markdown']);
    assert.deepEqual(server.requests[0].body.parsers, [{ type: 'pdf', mode: 'fast', maxPages: 3 }]);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Body text from URL scrape/);
  } finally {
    restoreEnv();
    await server.close();
    await fs.rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test('Firecrawl parser errors do not leak API keys', async () => {
  const restoreEnv = withFirecrawlEnv('PAPERNEXUS_TEST_FIRECRAWL_KEY_FAIL', 'test-firecrawl-fail-key');
  const fixture = await createFirecrawlFixture('papernexus-firecrawl-fail-');
  const server = await startFirecrawlServer(async (request, response) => {
    await readRequestBody(request);
    writeJson(response, 401, {
      success: false,
      error: 'bad token test-firecrawl-fail-key'
    });
  });

  try {
    await assert.rejects(
      () => convertPdfToMarkdown(fixture.pdfPath, {
        pdfParser: 'firecrawl',
        firecrawlApiBaseUrl: server.baseUrl,
        firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_KEY_FAIL',
        disableDoclingFallback: true,
        ...fixture
      }),
      (error) => {
        assert.match(error.message, /Firecrawl .* failed with HTTP 401/);
        assert.match(error.message, /bad token \[REDACTED\]/);
        assert.doesNotMatch(error.message, /test-firecrawl-fail-key/);
        return true;
      }
    );
  } finally {
    restoreEnv();
    await server.close();
    await fs.rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test('Firecrawl parser fails clearly when the configured key env is missing', async () => {
  const fixture = await createFirecrawlFixture('papernexus-firecrawl-missing-key-');
  try {
    delete process.env.PAPERNEXUS_TEST_FIRECRAWL_MISSING_KEY;
    await assert.rejects(
      () => convertPdfToMarkdown(fixture.pdfPath, {
        pdfParser: 'firecrawl',
        firecrawlApiBaseUrl: 'http://127.0.0.1:9',
        firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_MISSING_KEY',
        disableDoclingFallback: true,
        ...fixture
      }),
      /PAPERNEXUS_TEST_FIRECRAWL_MISSING_KEY/
    );
  } finally {
    await fs.rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test('Firecrawl parser honors explicit timeout', async () => {
  const restoreEnv = withFirecrawlEnv('PAPERNEXUS_TEST_FIRECRAWL_KEY_TIMEOUT', 'test-firecrawl-timeout-key');
  const fixture = await createFirecrawlFixture('papernexus-firecrawl-timeout-');
  const server = await startFirecrawlServer(async (request, response) => {
    await readRequestBody(request);
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeJson(response, 200, { success: true, data: { markdown: '# Slow' } });
  });

  try {
    await assert.rejects(
      () => convertPdfToMarkdown(fixture.pdfPath, {
        pdfParser: 'firecrawl',
        firecrawlApiBaseUrl: server.baseUrl,
        firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_FIRECRAWL_KEY_TIMEOUT',
        firecrawlTimeoutMs: 10,
        disableDoclingFallback: true,
        ...fixture
      }),
      /timed out after 10ms/
    );
  } finally {
    restoreEnv();
    await server.close();
    await fs.rm(fixture.rootPath, { recursive: true, force: true });
  }
});
