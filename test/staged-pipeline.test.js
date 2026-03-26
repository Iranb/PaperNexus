import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

test('PaperNexus supports running stages 1-4 independently with staged graph persistence', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-staged-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-staged-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Stage Split Paper A

Alice Example

## Abstract

We study stage-separated corpus builds for paper A.

## Method

We use a cache-first stage pipeline.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Stage Split Paper B

Bob Example

## Abstract

We study stage-separated corpus builds for paper B.

## Method

We use staged graph persistence.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const stage1 = await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'stage-split-test',
      force: true
    });
    assert.equal(stage1.stage, 'materialized');

    globalThis.fetch = async (_url, options) => {
      fetchCount += 1;
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const marker = 'Papers:\n';
      const markerIndex = String(prompt).lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: papers.map((paper) => ({
                      id: paper.id,
                      problems: [
                        {
                          name: `stage separated corpus build for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study stage-separated corpus builds for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.91
                        }
                      ]
                    }))
                  })
                }
              }
            ]
          };
        }
      };
    };

    const stage2 = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'stage-split-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });
    assert.equal(stage2.stage, 'llm-optimized');
    assert.ok(fetchCount > 0);

    const stage3 = await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'stage-split-test'
    });
    assert.equal(stage3.stage, 'graph-built');
    assert.ok(stage3.graph.nodeCount > 0);

    const stage3Resumed = await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'stage-split-test'
    });
    assert.equal(stage3Resumed.reused, true);

    const stagedPaths = corpusStore.getCorpusPaths(tempCorpusRoot);
    await assert.doesNotReject(fs.access(stagedPaths.stagedGraphPath));

    const stage4 = await ingestion.writeIndexCorpus(tempCorpusRoot, {});
    assert.equal(stage4.stage, 'index-written');

    const loadedCorpus = await corpusStore.loadCorpus(tempCorpusRoot);
    assert.equal(loadedCorpus.meta.name, 'stage-split-test');
    assert.ok(loadedCorpus.graph.nodeCount > 0);
    assert.equal(await fs.stat(stagedPaths.stagedDir).then(() => true).catch(() => false), false);
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

test('Stage 4 commits the staged graph against the staged manifest even if raw inputs change afterward', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-staged-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-staged-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Stage Split Paper A

Alice Example

## Abstract

We study stage-separated corpus builds for paper A.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Stage Split Paper B

Bob Example

## Abstract

We study stage-separated corpus builds for paper B.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'stage-split-raw-change-test',
      force: true
    });

    const stage3 = await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'stage-split-raw-change-test'
    });
    assert.equal(stage3.stage, 'graph-built');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-c.md'), `# Stage Split Paper C

Carol Example

## Abstract

This paper is intentionally added after Stage 3.
`, 'utf8');

    const stage4 = await ingestion.writeIndexCorpus(tempCorpusRoot, {});
    assert.equal(stage4.stage, 'index-written');

    const loadedCorpus = await corpusStore.loadCorpus(tempCorpusRoot);
    assert.equal(loadedCorpus.meta.name, 'stage-split-raw-change-test');
    assert.equal(loadedCorpus.meta.paperCount, 2);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
