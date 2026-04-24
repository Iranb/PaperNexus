import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function createOpenAlexResponse(results = []) {
  return {
    ok: true,
    async json() {
      return {
        meta: {
          count: results.length,
          page: 1,
          per_page: results.length
        },
        results
      };
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
        mailto: 'hyq@example.com'
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
        mailto: 'hyq@example.com'
      }
    };

    await analyzeCorpus(tempCorpusRoot, options);
    await analyzeCorpus(tempCorpusRoot, options);

    assert.equal(fetchCount, 1);

    const cache = JSON.parse(await fs.readFile(getCorpusPaths(tempCorpusRoot).identifierResolutionCachePath, 'utf8'));
    assert.equal(cache.version, 1);
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
