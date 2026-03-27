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

test('llmOptimizeCorpus reuses existing semantic and relation results when config and sources are unchanged', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;
  let relationFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Reuse Paper A

Alice Example

## Abstract

We study cache-first stage reuse for paper A.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Reuse Paper B

Bob Example

## Abstract

We study cache-first stage reuse for paper B.
`, 'utf8');

    const [ingestion] = await Promise.all([
      import('../src/core/ingestion/pipeline.js')
    ]);

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const marker = 'Papers:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(prompt.slice(markerIndex + marker.length).trim());

      if (prompt.includes('Allowed relation types:')) {
        relationFetchCount += 1;
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
                        benchmarks: [],
                        findings: [],
                        researchGoals: [],
                        relations: []
                      }))
                    })
                  }
                }
              ]
            };
          }
        };
      }

      semanticFetchCount += 1;
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
                          name: `cache reuse for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study cache-first stage reuse for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.92
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'llm-stage-reuse-test',
      force: true
    });

    const firstStage2 = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-stage-reuse-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });
    assert.equal(firstStage2.stage, 'llm-optimized');
    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);

    const firstStage3 = await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'llm-stage-reuse-test'
    });
    assert.equal(firstStage3.reused, false);

    const secondStage2 = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-stage-reuse-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });
    assert.equal(secondStage2.stage, 'llm-optimized');
    assert.equal(secondStage2.reused, true);
    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);

    const secondStage3 = await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'llm-stage-reuse-test'
    });
    assert.equal(secondStage3.reused, true);
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

test('llmOptimizeCorpus trusts a matching manifest-level optimization token and skips redundant reruns', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;
  let relationFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Manifest Token Paper A

Alice Example

## Abstract

We study manifest-level cache reuse for paper A.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const marker = 'Papers:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(prompt.slice(markerIndex + marker.length).trim());

      if (prompt.includes('Allowed relation types:')) {
        relationFetchCount += 1;
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
                        benchmarks: [],
                        findings: [],
                        researchGoals: [],
                        relations: []
                      }))
                    })
                  }
                }
              ]
            };
          }
        };
      }

      semanticFetchCount += 1;
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
                          name: `manifest-level cache reuse for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study manifest-level cache reuse for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.92
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'llm-manifest-token-test',
      force: true
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-manifest-token-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });
    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.ok(manifest.llmOptimization);

    const firstSource = manifest.sources[0];
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, firstSource.sourceKey);
    delete snapshot.llmSemanticObjects.configSignature;
    delete snapshot.llm.semanticConfigSignature;
    await corpusStore.saveSemanticPaperSnapshot(tempCorpusRoot, firstSource.sourceKey, snapshot);

    const rerun = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-manifest-token-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });

    assert.equal(rerun.stage, 'llm-optimized');
    assert.equal(rerun.reused, true);
    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);
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
