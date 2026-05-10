import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function createJsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

function createTextResponse(payload = '') {
  return {
    ok: true,
    async text() {
      return payload;
    }
  };
}

function createOpenAlexResponse(results = []) {
  return createJsonResponse({
    meta: {
      count: results.length,
      page: 1,
      per_page: results.length
    },
    results
  });
}

function createCrossrefResponse(items = []) {
  return createJsonResponse({
    status: 'ok',
    'message-type': 'work-list',
    'message-version': '1.0.0',
    message: {
      items
    }
  });
}

function createArxivResponse(entries = '') {
  return createTextResponse(
    `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
${entries}
</feed>`
  );
}

function createTestPaper(title, authors = []) {
  return {
    paperTitle: title,
    title,
    authors,
    titleValidation: {
      rawTitle: title,
      isValid: true,
      usedFallbackTitle: false
    }
  };
}

test('analyzeCorpus resolves missing identifiers from OpenAlex and persists them', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-resolution-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-resolution-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(
      path.join(tempCorpusRoot, 'fixmatch.md'),
      `# Towards Understanding Why FixMatch Generalizes Better Than Supervised Learning

Jingyang Li, Jiachun Pan

## Abstract

We study why FixMatch generalizes better than supervised learning.

## Introduction

This note focuses on the generalization gap between FixMatch and supervised learning.
`,
      'utf8'
    );

    let fetchCount = 0;
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.openalex.org');
      return createOpenAlexResponse([
        {
          title: 'Towards Understanding Why FixMatch Generalizes Better Than Supervised Learning',
          doi: 'https://doi.org/10.48550/arxiv.2410.11206',
          ids: {
            doi: 'https://doi.org/10.48550/arxiv.2410.11206'
          },
          authorships: [
            { author: { display_name: 'Jingyang Li' } },
            { author: { display_name: 'Jiachun Pan' } }
          ],
          primary_location: {
            id: 'pmh:oai:arXiv.org:2410.11206',
            landing_page_url: 'https://arxiv.org/abs/2410.11206',
            pdf_url: 'https://arxiv.org/pdf/2410.11206.pdf'
          }
        }
      ]);
    };

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'identifier-resolution-test',
      force: true,
      semanticExtraction: 'heuristic-only',
      identifierResolution: {
        enabled: true,
        providers: ['openalex'],
        mailto: 'user@example.org'
      }
    });

    assert.equal(fetchCount, 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const entry = manifest.sources[0];
    assert.equal(entry.canonicalId, 'arxiv:2410.11206');
    assert.deepEqual(entry.identifiers, {
      doi: '10.48550/arxiv.2410.11206',
      arxivId: '2410.11206'
    });
    assert.deepEqual(entry.paperMetadata.identifiers, {
      doi: '10.48550/arxiv.2410.11206',
      arxivId: '2410.11206'
    });

    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.identifiers, {
      doi: '10.48550/arxiv.2410.11206',
      arxivId: '2410.11206'
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus caches OpenAlex misses and avoids repeated lookups for unchanged content', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-miss-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-miss-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(
      path.join(tempCorpusRoot, 'unmatched.md'),
      `# A Study With No External Match

Jane Doe

## Abstract

This paper title should miss every OpenAlex candidate in the test.
`,
      'utf8'
    );

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return createOpenAlexResponse([]);
    };

    const [{ analyzeCorpus }, { getCorpusPaths }] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const options = {
      name: 'identifier-resolution-miss-test',
      force: true,
      semanticExtraction: 'heuristic-only',
      identifierResolution: {
        enabled: true,
        providers: ['openalex'],
        mailto: 'user@example.org'
      }
    };

    await analyzeCorpus(tempCorpusRoot, options);
    await analyzeCorpus(tempCorpusRoot, options);

    assert.equal(fetchCount, 1);

    const cache = JSON.parse(await fs.readFile(getCorpusPaths(tempCorpusRoot).identifierResolutionCachePath, 'utf8'));
    assert.equal(cache.version, 2);
    assert.equal(Object.keys(cache.misses || {}).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('resolvePaperIdentifiersExternally falls back to Crossref when OpenAlex misses', async () => {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-crossref-corpus-'));

  try {
    const requestedHosts = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === 'api.openalex.org') {
        return createOpenAlexResponse([]);
      }
      if (url.hostname === 'api.crossref.org') {
        assert.equal(url.searchParams.get('query.title'), 'Graph Transformers for Knowledge Base Completion');
        return createCrossrefResponse([
          {
            DOI: '10.1145/1234567.1234568',
            title: ['Graph Transformers for Knowledge Base Completion'],
            author: [
              { given: 'Jane', family: 'Doe' },
              { given: 'John', family: 'Smith' }
            ]
          }
        ]);
      }
      assert.fail(`unexpected host ${url.hostname}`);
    };

    const { resolvePaperIdentifiersExternally } = await import('../src/core/ingestion/identifier-resolution.js');
    const resolution = await resolvePaperIdentifiersExternally(
      tempCorpusRoot,
      createTestPaper('Graph Transformers for Knowledge Base Completion', ['Jane Doe', 'John Smith']),
      { fingerprint: 'crossref-fallback' },
      {
        identifierResolution: {
          enabled: true,
          providers: ['openalex', 'crossref'],
          mailto: 'user@example.org'
        }
      }
    );

    assert.deepEqual(requestedHosts, ['api.openalex.org', 'api.crossref.org']);
    assert.equal(resolution.provider, 'crossref');
    assert.deepEqual(resolution.identifiers, {
      doi: '10.1145/1234567.1234568'
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('resolvePaperIdentifiersExternally falls back to arXiv direct when earlier providers miss', async () => {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-arxiv-corpus-'));

  try {
    const requestedHosts = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === 'api.openalex.org') {
        return createOpenAlexResponse([]);
      }
      if (url.hostname === 'api.crossref.org') {
        return createCrossrefResponse([]);
      }
      if (url.hostname === 'export.arxiv.org') {
        assert.match(url.searchParams.get('search_query') || '', /ti:arxiv/i);
        return createArxivResponse(`
  <entry>
    <id>https://arxiv.org/abs/2410.11206v1</id>
    <updated>2024-10-15T00:00:00Z</updated>
    <published>2024-10-15T00:00:00Z</published>
    <title>ArXiv Direct Identifier Resolution</title>
    <author><name>Jane Doe</name></author>
    <author><name>John Smith</name></author>
    <arxiv:doi>10.48550/arXiv.2410.11206</arxiv:doi>
  </entry>`);
      }
      assert.fail(`unexpected host ${url.hostname}`);
    };

    const { resolvePaperIdentifiersExternally } = await import('../src/core/ingestion/identifier-resolution.js');
    const resolution = await resolvePaperIdentifiersExternally(
      tempCorpusRoot,
      createTestPaper('ArXiv Direct Identifier Resolution', ['Jane Doe', 'John Smith']),
      { fingerprint: 'arxiv-fallback' },
      {
        identifierResolution: {
          enabled: true,
          providers: ['openalex', 'crossref', 'arxiv'],
          mailto: 'user@example.org'
        }
      }
    );

    assert.deepEqual(requestedHosts, ['api.openalex.org', 'api.crossref.org', 'export.arxiv.org']);
    assert.equal(resolution.provider, 'arxiv');
    assert.deepEqual(resolution.identifiers, {
      doi: '10.48550/arxiv.2410.11206',
      arxivId: '2410.11206'
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('resolvePaperIdentifiersExternally ignores legacy miss cache entries from older provider chains', async () => {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-legacy-cache-'));

  try {
    const [{ resolvePaperIdentifiersExternally }, { getCorpusPaths }] = await Promise.all([
      import('../src/core/ingestion/identifier-resolution.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const cachePath = getCorpusPaths(tempCorpusRoot).identifierResolutionCachePath;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({
      version: 1,
      misses: {
        'fingerprint:legacy-cache': {
          reason: 'no-match',
          cachedAt: Date.now(),
          expiresAt: Date.now() + 60000
        }
      }
    }), 'utf8');

    let fetchCount = 0;
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const url = new URL(String(input));
      if (url.hostname === 'api.openalex.org') {
        return createOpenAlexResponse([]);
      }
      if (url.hostname === 'api.crossref.org') {
        return createCrossrefResponse([
          {
            DOI: '10.1145/7654321.7654322',
            title: ['Legacy Cache Recovery'],
            author: [{ given: 'Jane', family: 'Doe' }]
          }
        ]);
      }
      assert.fail(`unexpected host ${url.hostname}`);
    };

    const resolution = await resolvePaperIdentifiersExternally(
      tempCorpusRoot,
      createTestPaper('Legacy Cache Recovery', ['Jane Doe']),
      { fingerprint: 'legacy-cache' },
      {
        identifierResolution: {
          enabled: true,
          providers: ['openalex', 'crossref'],
          mailto: 'user@example.org'
        }
      }
    );

    assert.equal(fetchCount, 2);
    assert.equal(resolution.provider, 'crossref');
    assert.deepEqual(resolution.identifiers, {
      doi: '10.1145/7654321.7654322'
    });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('resolvePaperIdentifiersExternally does not cache misses when any provider request fails', async () => {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-failure-cache-'));

  try {
    const [{ resolvePaperIdentifiersExternally }, { getCorpusPaths }] = await Promise.all([
      import('../src/core/ingestion/identifier-resolution.js'),
      import('../src/storage/corpus-store.js')
    ]);

    let fetchCount = 0;
    globalThis.fetch = async (input) => {
      fetchCount += 1;
      const url = new URL(String(input));
      if (url.hostname === 'api.openalex.org') {
        throw new TypeError('socket hang up');
      }
      if (url.hostname === 'api.crossref.org') {
        return createCrossrefResponse([]);
      }
      if (url.hostname === 'export.arxiv.org') {
        return createArxivResponse('');
      }
      assert.fail(`unexpected host ${url.hostname}`);
    };

    const paper = createTestPaper('Transient Failure Should Not Cache', ['Jane Doe']);
    const sourceState = { fingerprint: 'failure-no-cache' };
    const options = {
      identifierResolution: {
        enabled: true,
        providers: ['openalex', 'crossref', 'arxiv'],
        mailto: 'user@example.org'
      }
    };

    const first = await resolvePaperIdentifiersExternally(tempCorpusRoot, paper, sourceState, options);
    const second = await resolvePaperIdentifiersExternally(tempCorpusRoot, paper, sourceState, options);

    assert.equal(first.reason, 'request-failed');
    assert.equal(second.reason, 'request-failed');
    assert.equal(fetchCount, 6);

    await assert.rejects(fs.readFile(getCorpusPaths(tempCorpusRoot).identifierResolutionCachePath, 'utf8'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('watch-mode analysis skips OpenAlex identifier resolution by default', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-watch-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identifier-watch-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(
      path.join(tempCorpusRoot, 'watch.md'),
      `# Another Paper Without Strong Identifiers

Jane Doe

## Abstract

This should not trigger external identifier resolution in watch mode.
`,
      'utf8'
    );

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return createOpenAlexResponse([]);
    };

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'identifier-resolution-watch-test',
      force: true,
      watchMode: true,
      semanticExtraction: 'heuristic-only'
    });

    assert.equal(fetchCount, 0);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.deepEqual(manifest.sources[0].identifiers || {}, {});
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
