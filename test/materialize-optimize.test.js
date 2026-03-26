import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

test('materializeCorpus prepares markdown cache and optimizeCorpus batches LLM graph optimization', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Materialize Paper A

Alice Example

## Abstract

We study staged graph materialization for paper A.

## Method

We use a cache-first corpus materializer.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Materialize Paper B

Bob Example

## Abstract

We study staged graph materialization for paper B.

## Method

We use a batched llm optimizer.
`, 'utf8');

    globalThis.fetch = async () => {
      throw new Error('materialize should not call the LLM');
    };

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const materialized = await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'materialize-optimize-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(materialized.stage, 'materialized');
    assert.equal(materialized.meta.paperCount, 2);

    const manifestAfterMaterialize = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshotsAfterMaterialize = await Promise.all(
      manifestAfterMaterialize.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    for (const snapshot of snapshotsAfterMaterialize) {
      assert.equal(snapshot.llm.provider, 'disabled');
      assert.equal(snapshot.llm.semanticExtractionParticipated, false);
    }

    const preservedSnapshot = {
      ...snapshotsAfterMaterialize[0],
      optimizeResumeSentinel: 'reuse-existing-snapshot'
    };
    await corpusStore.saveSemanticPaperSnapshot(
      tempCorpusRoot,
      manifestAfterMaterialize.sources[0].sourceKey,
      preservedSnapshot
    );

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
                          name: `staged graph materialization for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study staged graph materialization for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.9
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

    const optimized = await ingestion.optimizeCorpus(tempCorpusRoot, {
      name: 'materialize-optimize-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });

    assert.equal(fetchCount, 1);
    assert.ok(optimized.graph.nodes.some((node) => node.type === 'Problem'));

    const manifestAfterOptimize = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshotsAfterOptimize = await Promise.all(
      manifestAfterOptimize.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    for (const snapshot of snapshotsAfterOptimize) {
      assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    }
    assert.equal(snapshotsAfterOptimize[0].optimizeResumeSentinel, 'reuse-existing-snapshot');
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
