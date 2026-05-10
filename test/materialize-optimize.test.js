import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function extractPromptPapers(prompt) {
  const marker = 'Papers:\n';
  const markerIndex = String(prompt || '').lastIndexOf(marker);
  if (markerIndex === -1) return [];

  try {
    return JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
  } catch {
    return [];
  }
}

function createRateLimitResponse(message = 'rate limited') {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'retry-after' ? '0' : '';
      }
    },
    async text() {
      return JSON.stringify({ error: { message } });
    }
  };
}

function createIdentifierResolutionMissResponse() {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    async json() {
      return {};
    },
    async text() {
      return '';
    }
  };
}

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
      identifierResolutionEnabled: false,
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

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }
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
      llmBatchSize: 8,
      identifierResolutionEnabled: false
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

test('llmOptimizeCorpus can scope Stage 2 work to changed source keys for import-sized updates', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scoped-stage2-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scoped-stage2-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const requestedPaperIds = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Scoped Stage Two Paper A

## Abstract

Paper A should remain heuristic-only during the scoped import optimization.
`, 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Scoped Stage Two Paper B

## Abstract

Paper B is the only changed import source that should call the LLM.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'scoped-stage2-test',
      force: true
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const changedEntry = manifest.sources.find((entry) => entry.inputPath.endsWith('paper-b.md'));
    assert.ok(changedEntry);

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const papers = extractPromptPapers(request.messages?.[0]?.content || '');
      requestedPaperIds.push(...papers.map((paper) => paper.id));

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
                      problems: [{
                        name: `Scoped problem for ${paper.title}`,
                        type: 'Problem',
                        evidenceText: 'Paper B is the only changed import source.',
                        sectionHeading: 'Abstract',
                        sectionRole: 'abstract',
                        confidence: 0.9
                      }]
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
      name: 'scoped-stage2-test',
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmRelations: false,
      changedSourceKeys: [changedEntry.sourceKey],
      llmBatchSize: 8
    });

    assert.deepEqual(requestedPaperIds, [changedEntry.sourceKey]);

    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const paperA = snapshots.find((snapshot) => snapshot.sourcePath.endsWith('paper-a.md'));
    const paperB = snapshots.find((snapshot) => snapshot.sourcePath.endsWith('paper-b.md'));
    assert.equal(paperA.llm.semanticExtractionParticipated, false);
    assert.equal(paperB.llm.semanticExtractionParticipated, true);

    const nextManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(nextManifest.llmOptimization, null);
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

test('llmOptimizeCorpus records provider 429 cooldown without snapshot errors or repeated requests', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-rate-limit-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-rate-limit-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Rate Limited Stage Two Paper

## Abstract

The provider returns 429 while enriching this paper.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'rate-limit-stage2-test',
      force: true,
      identifierResolutionEnabled: false,
      semanticExtraction: 'llm-primary'
    });

    globalThis.fetch = async (url) => {
      if (!String(url || '').startsWith('https://rate-limit.example/v1')) {
        return createIdentifierResolutionMissResponse();
      }
      fetchCount += 1;
      return createRateLimitResponse('quota exhausted');
    };

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'rate-limit-stage2-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://rate-limit.example/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1,
      identifierResolutionEnabled: false
    });

    assert.equal(fetchCount, 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(manifest.llmOptimization?.token, null);
    assert.match(manifest.llmOptimization?.rateLimitCooldownUntil || '', /^\d{4}-\d{2}-\d{2}T/);
    const rateLimitStore = JSON.parse(await fs.readFile(path.join(tempHome, 'llm-rate-limits.json'), 'utf8'));
    assert.equal(rateLimitStore.cooldowns.length, 1);
    assert.equal(rateLimitStore.cooldowns[0].until, manifest.llmOptimization.rateLimitCooldownUntil);

    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.error, null);
    assert.equal(snapshot.llm.semanticExtractionParticipationReason, 'rate-limited');
    assert.equal(snapshot.llmSemanticObjects.error, null);
    assert.equal(snapshot.llmSemanticObjects.reason, 'rate-limited');
    assert.equal(snapshot.llm.rateLimitCooldownUntil, manifest.llmOptimization.rateLimitCooldownUntil);

    const second = await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'rate-limit-stage2-test',
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://rate-limit.example/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 1,
      identifierResolutionEnabled: false
    });

    assert.equal(second.reused, true);
    assert.equal(fetchCount, 1);
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
    assert.match(output, /workers 1\/1 \| paper-a \[markdown\] (reading markdown|writing snapshot|cache hit)/);
    assert.match(output, /\[lock\] corpus lock acquired for Stage 1 source manifest write/);
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
    assert.match(output, /\[lock\] corpus lock acquired for Stage 2 optimized snapshot write/);

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
    assert.deepEqual(manifest.llmOptimization.promptVersions, {
      semanticObjects: 'semantic-objects-v2',
      researchRelations: 'research-relations-v1'
    });
    assert.equal(JSON.parse(manifest.llmOptimization.semanticConfigSignature).promptVersion, 'semantic-objects-v2');
    assert.equal(JSON.parse(manifest.llmOptimization.relationConfigSignature).promptVersion, 'research-relations-v1');

    const firstSource = manifest.sources[0];
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, firstSource.sourceKey);
    assert.equal(snapshot.llmSemanticObjects.promptVersion, 'semantic-objects-v2');
    assert.equal(snapshot.llm.semanticPromptVersion, 'semantic-objects-v2');
    assert.equal(snapshot.llm.relationPromptVersion, 'research-relations-v1');
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

test('backfillCatalystMetadataCorpus refreshes an old corpus and rebuilds domain/mechanism graph primitives', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-backfill-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-backfill-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Cross-Domain Bias Mitigation

Jane Doe

## Abstract

We study bias mitigation in tutoring feedback and reuse metacontrol ideas from psychology.

## Method

We propose a metacontrol policy transfer framework.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }
      semanticFetchCount += 1;
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        fieldOfStudy: 'Education',
                        fieldCandidates: ['Education', 'Psychology'],
                        domainTags: ['Education', 'Psychology'],
                        abstractMechanisms: ['metacontrol policy'],
                        problems: [
                          {
                            name: 'bias mitigation in tutoring feedback',
                            type: 'Problem',
                            evidenceText: 'We study bias mitigation in tutoring feedback.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.93
                          }
                        ],
                        methods: [
                          {
                            name: 'metacontrol policy transfer framework',
                            type: 'Method',
                            evidenceText: 'We propose a metacontrol policy transfer framework.',
                            sectionHeading: 'Method',
                            sectionRole: 'method',
                            confidence: 0.91
                          }
                        ]
                      }
                    ]
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'catalyst-backfill-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'catalyst-backfill-test',
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      identifierResolutionEnabled: false
    });
    assert.equal(semanticFetchCount, 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const sourceKey = manifest.sources[0].sourceKey;
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, sourceKey);
    delete snapshot.fieldOfStudy;
    delete snapshot.fieldCandidates;
    delete snapshot.domainTags;
    delete snapshot.abstractMechanisms;
    delete snapshot.llmSemanticObjects.fieldOfStudy;
    delete snapshot.llmSemanticObjects.fieldCandidates;
    delete snapshot.llmSemanticObjects.domainTags;
    delete snapshot.llmSemanticObjects.abstractMechanisms;
    const oldSemanticSignature = JSON.stringify({
      kind: 'semantic',
      version: 0,
      requestedMode: 'llm-assisted',
      effectiveMode: 'llm-assisted',
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1'
    });
    snapshot.llmSemanticObjects.configSignature = oldSemanticSignature;
    snapshot.llm.semanticConfigSignature = oldSemanticSignature;
    await corpusStore.saveSemanticPaperSnapshot(tempCorpusRoot, sourceKey, snapshot);

    manifest.llmOptimization = {
      ...manifest.llmOptimization,
      catalystMetadataContractVersion: 0
    };
    await corpusStore.saveSourceManifest(tempCorpusRoot, manifest);

    const result = await ingestion.backfillCatalystMetadataCorpus(tempCorpusRoot, {
      name: 'catalyst-backfill-test',
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      identifierResolutionEnabled: false
    });

    assert.equal(result.stage, 'index-written');
    assert.equal(semanticFetchCount, 2);
    assert.ok(result.graph.nodes.some((node) => node.type === 'Domain' && node.name === 'Psychology'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'AbstractMechanism' && node.name === 'metacontrol policy'));

    const nextManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const nextSnapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, sourceKey);
    assert.equal(nextManifest.llmOptimization.catalystMetadataContractVersion, 1);
    assert.equal(nextSnapshot.llmSemanticObjects.fieldOfStudy, 'Education');
    assert.deepEqual(nextSnapshot.llmSemanticObjects.domainTags, ['Education', 'Psychology']);
    assert.deepEqual(nextSnapshot.llmSemanticObjects.abstractMechanisms, ['metacontrol policy']);
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
