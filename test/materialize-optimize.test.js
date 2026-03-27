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

test('materializeCorpus renders an initial paper progress bar before the first paper completes', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-progress-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-progress-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalWrite = process.stdout.write;
  let output = '';

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Materialize Progress Paper

## Abstract

We verify that the materialize stage shows an initial progress bar.
`, 'utf8');

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true
    });
    process.stdout.write = ((chunk, ...args) => {
      output += String(chunk);
      return originalWrite.call(process.stdout, chunk, ...args);
    });

    const ingestion = await import('../src/core/ingestion/pipeline.js');
    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'materialize-progress-test'
    });

    assert.match(output, /Processing papers: \[[^\]]+\] 0\/1 \(0%\)/);
  } finally {
    process.stdout.write = originalWrite;
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
    } else {
      delete process.stdout.isTTY;
    }

    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('materializeCorpus updates snapshot metadata without creating a backup by default', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-nobackup-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-nobackup-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Materialize Backup Test

## Abstract

We study cache-aware materialization.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(tempCorpusRoot, {
      name: 'materialize-no-backup-test',
      semanticExtraction: 'heuristic-only'
    });

    await fs.appendFile(path.join(tempCorpusRoot, 'paper-a.md'), '\n## Update\n\nWe changed the source markdown.\n', 'utf8');
    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'materialize-no-backup-test'
    });

    const backupRoot = corpusStore.getCorpusBackupDir(tempCorpusRoot);
    const backupEntries = await fs.readdir(backupRoot).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(backupEntries, []);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('llmOptimizeCorpus announces snapshot persistence and skips backups by default', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-stage2-nobackup-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-stage2-nobackup-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalWrite = process.stdout.write;
  let output = '';

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Stage 2 Backup Test

## Abstract

We study stage two persistence behavior.

## Method

We use a semantic optimizer.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
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
                          name: `stage two persistence for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study stage two persistence for ${paper.title}.`,
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(tempCorpusRoot, {
      name: 'stage2-no-backup-test',
      semanticExtraction: 'heuristic-only'
    });

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true
    });
    process.stdout.write = ((chunk, ...args) => {
      output += String(chunk);
      return originalWrite.call(process.stdout, chunk, ...args);
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'stage2-no-backup-test',
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmRelations: false
    });

    assert.match(output, /Stage 1\/1: Writing optimized snapshots - persisting LLM-enriched snapshot metadata/);

    const backupRoot = corpusStore.getCorpusBackupDir(tempCorpusRoot);
    const backupEntries = await fs.readdir(backupRoot).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(backupEntries, []);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
    } else {
      delete process.stdout.isTTY;
    }
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

test('llmOptimizeCorpus only retries semantic batches for papers that remain dirty after a partial failed run', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Resume Paper A

Alice Example

## Abstract

We study resumable batch checkpoints for paper A.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Resume Paper B

Bob Example

## Abstract

We study resumable batch checkpoints for paper B.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-c.md'), `# Resume Paper C

Cara Example

## Abstract

We study resumable batch checkpoints for paper C.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'llm-stage2-checkpoint-test',
      force: true
    });

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const marker = 'Papers:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(prompt.slice(markerIndex + marker.length).trim());

      semanticFetchCount += 1;
      if (semanticFetchCount >= 2) {
        throw new Error('simulated batch failure');
      }

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
                          name: `checkpoint resume for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study resumable batch checkpoints for ${paper.title}.`,
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

    const firstRun = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-stage2-checkpoint-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1
    });

    assert.equal(firstRun.stage, 'llm-optimized');
    const manifestAfterFirstRun = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const firstSnapshots = await Promise.all(
      manifestAfterFirstRun.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const firstParticipatedCount = firstSnapshots.filter((snapshot) => snapshot.llm?.semanticExtractionParticipated).length;
    assert.equal(firstParticipatedCount, 1);
    const fetchCountAfterFirstRun = semanticFetchCount;

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const marker = 'Papers:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(prompt.slice(markerIndex + marker.length).trim());

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
                          name: `checkpoint resume for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study resumable batch checkpoints for ${paper.title}.`,
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

    const secondRun = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-stage2-checkpoint-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1
    });

    assert.equal(secondRun.stage, 'llm-optimized');
    assert.ok(semanticFetchCount > fetchCountAfterFirstRun);
    assert.ok((semanticFetchCount - fetchCountAfterFirstRun) < 3);

    const manifestAfterSecondRun = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const secondSnapshots = await Promise.all(
      manifestAfterSecondRun.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const secondParticipatedCount = secondSnapshots.filter((snapshot) => snapshot.llm?.semanticExtractionParticipated).length;
    assert.equal(secondParticipatedCount, 3);
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

test('watch startup reuses committed stage state and does not rerun Stage 2 LLM batches when sources are unchanged', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-watch-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-watch-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;
  let relationFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Watch Reuse Paper A

Alice Example

## Abstract

We study watch startup reuse for paper A.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Watch Reuse Paper B

Bob Example

## Abstract

We study watch startup reuse for paper B.
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
                          name: `watch startup reuse for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study watch startup reuse for ${paper.title}.`,
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'watch-stage-reuse-test',
      force: true
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'watch-stage-reuse-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8
    });
    await ingestion.buildGraphCorpus(tempCorpusRoot, {
      name: 'watch-stage-reuse-test'
    });
    await ingestion.writeIndexCorpus(tempCorpusRoot, {});

    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);

    semanticFetchCount = 0;
    relationFetchCount = 0;

    const refreshed = await ingestion.__pipelineTestables.refreshWatchedCorpus(tempCorpusRoot, {
      name: 'watch-stage-reuse-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8,
      quiet: true
    });

    assert.equal(refreshed.reused, true);
    assert.equal(semanticFetchCount, 0);
    assert.equal(relationFetchCount, 0);
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

test('llmOptimizeCorpus can reuse a completed Stage 2 job from manifest and snapshots even when source files are temporarily unavailable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Offline Stage 2 Paper

Alice Example

## Abstract

We study reusing stage 2 metadata without rescanning source files.
`, 'utf8');

    const [ingestion] = await Promise.all([
      import('../src/core/ingestion/pipeline.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'llm-offline-stage2-test',
      force: true
    });

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const marker = 'Papers:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      const papers = markerIndex === -1 ? [] : JSON.parse(prompt.slice(markerIndex + marker.length).trim());

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
                          name: `offline stage2 reuse for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study reusing stage 2 metadata without rescanning source files for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.93
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

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-offline-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1
    });
    assert.equal(semanticFetchCount, 1);

    await fs.rm(path.join(tempCorpusRoot, 'paper-a.md'), { force: true });

    const rerun = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'llm-offline-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1
    });

    assert.equal(rerun.stage, 'llm-optimized');
    assert.equal(rerun.reused, true);
    assert.equal(semanticFetchCount, 1);
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
