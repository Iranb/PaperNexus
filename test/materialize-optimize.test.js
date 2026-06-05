import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test('materializeCorpus incrementally recanonicalizes only merge-affected manifest groups', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-incremental-merge-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-materialize-incremental-merge-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'base-papers');
  const importRoot = path.join(workspaceRoot, 'import-papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.mkdir(importRoot, { recursive: true });
    await fs.writeFile(path.join(inputRoot, 'shared-original.md'), `# Shared Duplicate Paper

Alice Example

## Abstract

This paper is already present in the corpus and should remain the canonical active source.

## Method

The method studies deterministic graph-visible imports.
`, 'utf8');
    await fs.writeFile(path.join(inputRoot, 'untouched.md'), `# Untouched Corpus Paper

Bob Example

## Abstract

This paper should not enter the recanonicalization group for an unrelated duplicate upload.
`, 'utf8');
    await fs.writeFile(path.join(importRoot, 'shared-upload.md'), `# Shared Duplicate Paper

Alice Example

## Abstract

This upload is a duplicate of the existing paper and should become an inactive source variant.

## Method

The method studies deterministic graph-visible imports.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'incremental-merge-test',
      force: true,
      identifierResolutionEnabled: false,
      semanticExtraction: 'heuristic-only'
    });

    const materialized = await ingestion.materializeCorpus(importRoot, {
      rootPath: indexRoot,
      name: 'incremental-merge-test',
      mergeWithExistingManifestSources: true,
      incrementalMergeRecanonicalization: true,
      identifierResolutionEnabled: false,
      semanticExtraction: 'heuristic-only',
      analyzeConcurrency: 2,
      metadataConcurrency: 2
    });
    const manifest = await corpusStore.loadSourceManifest(indexRoot);

    assert.equal(materialized.stage, 'materialized');
    assert.equal(materialized.meta.paperCount, 2);
    assert.equal(manifest.sources.length, 3);
    assert.equal(materialized.timings.mergePreviousSourceCount, 2);
    assert.equal(materialized.timings.mergeMaterializedSourceCount, 1);
    assert.equal(materialized.timings.mergeAffectedSourceCount, 2);
    assert.equal(materialized.timings.mergeUntouchedSourceCount, 1);
    assert.equal(materialized.timings.mergeSnapshotReloadMs, 0);
    assert.equal(typeof materialized.timings.mergeRecanonicalizeMs, 'number');

    const duplicateEntries = manifest.sources.filter((entry) => entry.paperTitle === 'Shared Duplicate Paper');
    const untouchedEntry = manifest.sources.find((entry) => entry.paperTitle === 'Untouched Corpus Paper');
    assert.equal(duplicateEntries.length, 2);
    assert.equal(duplicateEntries.filter((entry) => entry.activeInGraph !== false).length, 1);
    assert.equal(duplicateEntries.every((entry) => Number(entry.duplicateSourceCount) === 2), true);
    assert.ok(duplicateEntries.some((entry) => entry.duplicateOfSourceKey));
    assert.equal(untouchedEntry.activeInGraph, true);
    assert.equal(Number(untouchedEntry.duplicateSourceCount || 1), 1);

    const duplicateSnapshots = await Promise.all(
      duplicateEntries.map((entry) => corpusStore.loadSemanticPaperSnapshot(indexRoot, entry.sourceKey))
    );
    assert.equal(duplicateSnapshots.filter((snapshot) => snapshot.activeInGraph !== false).length, 1);
    assert.equal(duplicateSnapshots.every((snapshot) => Number(snapshot.duplicateSourceCount) === 2), true);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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
      requestedPaperIds.push(...papers.map((paper) => paper.sourceKey || paper.id));

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

test('llmOptimizeCorpus defaults to long-context paper-level extraction for 1M context models', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'long-a.md'), `# Long Context Paper A

## Abstract

Paper A studies graph-grounded markdown ingestion with long context semantic extraction.

## Method

We process the whole markdown paper in one provider call.
`, 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'long-b.md'), `# Long Context Paper B

## Abstract

Paper B studies safe semantic enrichment after structural graph visibility.

## Method

We preserve graph quality with schema-bound extraction.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);

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
                        name: `Long-context extraction for ${paper.title}`,
                        type: 'Problem',
                        evidenceText: 'The paper studies long context semantic extraction.',
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

    const [ingestion, corpusStore, artifactStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/long-context-artifact-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      identifierResolutionEnabled: false
    });

    assert.equal(prompts.length, 1);
    assert.ok(prompts.every((prompt) => !prompt.includes('paper chunks')));
    assert.equal(extractPromptPapers(prompts[0]).length, 2);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      assert.equal(snapshot.llm.semanticExtractionParticipated, true);
      assert.equal(snapshot.llm.chunkPipeline.enabled, false);
      assert.equal(snapshot.llm.chunkPipeline.reason, 'long-context-first');
      assert.equal(snapshot.llm.longContext.enabled, true);
      assert.equal(snapshot.llm.longContext.strategy, 'long-context-first');
      assert.equal(snapshot.llm.longContext.contextWindowTokens, 1_000_000);
      assert.equal(snapshot.llm.longContext.maxPapersPerCall, 2);
      assert.equal(snapshot.llmSemanticObjects.longContext.enabled, true);
      const semanticArtifact = snapshot.llm.longContext.artifacts?.semantic;
      assert.equal(semanticArtifact?.contractVersion, 'papernexus-long-context-llm-artifact-v1');
      assert.equal(semanticArtifact.phase, 'semantic');
      assert.equal(semanticArtifact.status, 'completed');
      assert.ok(semanticArtifact.artifactPath.includes('.papernexus/llm-jobs/long-context-artifacts/records/'));

      const storedArtifact = await artifactStore.loadLongContextArtifact(tempCorpusRoot, semanticArtifact.artifactKey);
      assert.equal(storedArtifact.contractVersion, 'papernexus-long-context-llm-artifact-v1');
      assert.equal(storedArtifact.phase, 'semantic');
      assert.equal(storedArtifact.status, 'completed');
      assert.equal(storedArtifact.sourceKey, manifest.sources[index].sourceKey);
      assert.equal(storedArtifact.longContext.contextWindowTokens, 1_000_000);
      assert.equal(storedArtifact.result.participated, true);
    }
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

test('llmOptimizeCorpus records long-context relation artifacts without losing semantic artifacts', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-artifact-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-artifact-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'long-artifact.md'), `# Long Context Artifact Paper

## Abstract

This paper studies auditable long-context extraction artifacts for markdown semantic enrichment.

## Method

The method preserves semantic artifact references while relation extraction appends relation artifacts.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const papers = extractPromptPapers(prompt);
      const relationPrompt = prompt.includes('Key relations to capture');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: papers.map((paper) => relationPrompt
                      ? {
                          id: paper.id,
                          findings: [{
                            name: `Artifact preservation finding for ${paper.title}`,
                            type: 'Finding',
                            evidenceText: 'Relation extraction appends relation artifacts.',
                            sectionHeading: 'Method',
                            confidence: 0.9
                          }],
                          relations: []
                        }
                      : {
                          id: paper.id,
                          problems: [{
                            name: `Auditable long-context artifacts for ${paper.title}`,
                            type: 'Problem',
                            evidenceText: 'The paper studies auditable long-context extraction artifacts.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.9
                          }]
                        })
                  })
                }
              }
            ]
          };
        }
      };
    };

    const [ingestion, corpusStore, artifactStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/long-context-artifact-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-artifact-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-artifact-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      identifierResolutionEnabled: false
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    const artifacts = snapshot.llm.longContext.artifacts;
    assert.equal(artifacts.semantic?.phase, 'semantic');
    assert.equal(artifacts.relation?.phase, 'relation');
    assert.equal(snapshot.llmSemanticObjects.longContext.artifacts.semantic.artifactKey, artifacts.semantic.artifactKey);
    assert.equal(snapshot.llmSemanticObjects.longContext.artifacts.relation.artifactKey, artifacts.relation.artifactKey);

    const semanticArtifact = await artifactStore.loadLongContextArtifact(tempCorpusRoot, artifacts.semantic.artifactKey);
    const relationArtifact = await artifactStore.loadLongContextArtifact(tempCorpusRoot, artifacts.relation.artifactKey);
    assert.equal(semanticArtifact.sourceKey, manifest.sources[0].sourceKey);
    assert.equal(relationArtifact.sourceKey, manifest.sources[0].sourceKey);
    assert.equal(relationArtifact.status, 'completed');
    assert.equal(relationArtifact.result.findings.length, 1);
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

test('llmOptimizeCorpus runs long-context paper batches with bounded concurrency', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-concurrency-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-concurrency-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;
  let activeFetches = 0;
  let maxActiveFetches = 0;
  const llmBatchEvents = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(path.join(tempCorpusRoot, `long-concurrent-${index}.md`), `# Long Context Concurrency Paper ${index}

## Abstract

Paper ${index} studies bounded concurrent long-context semantic extraction for markdown import throughput.

## Method

The optimizer should submit this paper-level request concurrently without switching to chunk fallback.
`, 'utf8');
    }

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      fetchCount += 1;
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);

      try {
        await sleep(40);
        const request = JSON.parse(options.body);
        const papers = extractPromptPapers(request.messages?.[0]?.content || '');

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
                          name: `Concurrent long-context extraction for ${paper.title}`,
                          type: 'Problem',
                          evidenceText: 'The optimizer should submit this paper-level request concurrently.',
                          sectionHeading: 'Method',
                          sectionRole: 'method',
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
      } finally {
        activeFetches -= 1;
      }
    };

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-concurrency-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-concurrency-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      llmBatchConcurrency: 2,
      identifierResolutionEnabled: false,
      onLlmBatchComplete(event) {
        llmBatchEvents.push(event);
      }
    });

    assert.equal(fetchCount, 4);
    assert.equal(maxActiveFetches, 2);
    assert.equal(activeFetches, 0);
    assert.equal(llmBatchEvents.at(-1)?.llmBatchConcurrency, 2);
    assert.equal(llmBatchEvents.at(-1)?.total, 4);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    for (const snapshot of snapshots) {
      assert.equal(snapshot.llm.semanticExtractionParticipated, true);
      assert.equal(snapshot.llm.chunkPipeline.enabled, false);
      assert.equal(snapshot.llm.chunkPipeline.reason, 'long-context-first');
      assert.equal(snapshot.llm.longContext.strategy, 'long-context-first');
    }
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

test('llmOptimizeCorpus stops scheduling later long-context semantic slices after provider rate limit', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-rate-stop-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-rate-stop-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;
  const fetchedTitles = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(path.join(tempCorpusRoot, `rate-stop-${index}.md`), `# Rate Aware Scheduler Paper ${index}

## Abstract

Paper ${index} checks that the long-context scheduler stops launching fresh provider calls after rate limit.

## Method

The test uses one paper per provider prompt so later slice launches are observable.
`, 'utf8');
    }

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      fetchCount += 1;
      const request = JSON.parse(options.body);
      const papers = extractPromptPapers(request.messages?.[0]?.content || '');
      const title = papers[0]?.title || '';
      fetchedTitles.push(title);

      if (title.includes('Paper 1')) {
        await sleep(20);
        return createRateLimitResponse('quota exhausted');
      }

      if (title.includes('Paper 2')) {
        await sleep(60);
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
                          name: `Completed already-in-flight extraction for ${paper.title}`,
                          type: 'Problem',
                          evidenceText: 'Already-started concurrent calls may finish after a sibling slice hits rate limit.',
                          sectionHeading: 'Method',
                          sectionRole: 'method',
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
      }

      throw new Error(`rate-aware scheduler should not fetch ${title}`);
    };

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-rate-stop-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-rate-stop-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      llmBatchConcurrency: 2,
      llmLongContextFallbackEnabled: false,
      llmRateLimitRetryCount: 0,
      llmRateLimitRetryDelayMs: 0,
      llmRateLimitRetryMaxDelayMs: 0,
      identifierResolutionEnabled: false
    });

    assert.equal(fetchCount, 2);
    assert.deepEqual([...fetchedTitles].sort(), [
      'Rate Aware Scheduler Paper 1',
      'Rate Aware Scheduler Paper 2'
    ]);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.match(manifest.llmOptimization?.rateLimitCooldownUntil || '', /^\d{4}-\d{2}-\d{2}T/);

    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const byTitle = new Map(snapshots.map((snapshot) => [snapshot.paperTitle, snapshot]));
    const paper1 = byTitle.get('Rate Aware Scheduler Paper 1');
    const paper2 = byTitle.get('Rate Aware Scheduler Paper 2');
    const paper3 = byTitle.get('Rate Aware Scheduler Paper 3');
    const paper4 = byTitle.get('Rate Aware Scheduler Paper 4');

    assert.equal(paper1.llm.semanticExtractionParticipationReason, 'rate-limited');
    assert.equal(paper1.llm.longContext.callCount, 1);
    assert.equal(paper1.llm.longContext.fallbackReason, 'rate-limited');
    assert.equal(paper1.llm.longContext.validationDetails.reason, 'rate-limited');

    assert.equal(paper2.llm.semanticExtractionParticipated, true);
    assert.equal(paper2.llm.longContext.callCount, 1);
    assert.equal(paper2.llm.longContext.fallbackReason, null);

    for (const snapshot of [paper3, paper4]) {
      assert.equal(snapshot.llm.semanticExtractionParticipationReason, 'rate-limited');
      assert.equal(snapshot.llm.longContext.callCount, 0);
      assert.equal(snapshot.llm.longContext.fallbackReason, 'rate-limited');
      assert.equal(snapshot.llm.longContext.validationDetails.reason, 'rate-limited');
      assert.equal(snapshot.llmSemanticObjects.skippedProviderCall, true);
      assert.equal(snapshot.llm.rateLimitCooldownUntil, manifest.llmOptimization.rateLimitCooldownUntil);
    }
  } finally {
    const { clearLlmRateLimitCooldowns } = await import('../src/core/llm/ollama.js');
    await clearLlmRateLimitCooldowns({ persisted: false });
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('llmOptimizeCorpus keeps chunk-first extraction when explicitly requested for a 1M context model', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-chunk-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-chunk-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'chunk-first.md'), `# Explicit Chunk First Paper

## Abstract

This paper has enough markdown structure to create chunk-level semantic candidates.

## Method

The explicit strategy should keep chunk map reduce enabled even with a one million token context window.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);
      const isChunkPrompt = prompt.includes('paper chunks');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(isChunkPrompt
                    ? {
                        chunks: papers.map((paper) => ({
                          id: paper.id,
                          problems: [{
                            name: 'explicit chunk-first extraction',
                            type: 'Problem',
                            evidenceText: 'The explicit strategy should keep chunk map reduce enabled.',
                            sectionHeading: paper.sectionHeading || 'Method',
                            sectionRole: paper.sectionRole || 'method',
                            confidence: 0.91
                          }]
                        }))
                      }
                    : {
                        papers: papers.map((paper) => ({
                          id: paper.id,
                          problems: [{
                            name: 'unexpected paper-level fallback',
                            type: 'Problem',
                            evidenceText: 'Fallback should not be required in this test.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.5
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'chunk-first-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'chunk-first-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'chunk-first',
      identifierResolutionEnabled: false
    });

    assert.ok(prompts.some((prompt) => prompt.includes('paper chunks')));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.enabled, false);
    assert.equal(snapshot.llm.longContext.strategy, 'chunk-first');
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

test('llmOptimizeCorpus stops scheduling later chunk semantic slices after provider rate limit', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-rate-stop-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-rate-stop-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(path.join(tempCorpusRoot, `chunk-rate-stop-${index}.md`), `# Chunk Rate Aware Scheduler Paper ${index}

## Abstract

Paper ${index} checks that chunk fallback semantic extraction stops launching fresh provider calls after rate limit.

## Method

The explicit chunk-first path uses one selected chunk per paper in this fixture.
`, 'utf8');
    }

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      fetchCount += 1;
      const request = JSON.parse(options.body);
      const papers = extractPromptPapers(request.messages?.[0]?.content || '');

      if (fetchCount === 1) {
        await sleep(20);
        return createRateLimitResponse('chunk quota exhausted');
      }

      if (fetchCount === 2) {
        await sleep(60);
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      chunks: papers.map((paper) => ({
                        id: paper.id,
                        problems: [{
                          name: `Completed already-in-flight chunk extraction for ${paper.title || paper.id}`,
                          type: 'Problem',
                          evidenceText: 'Already-started chunk calls may finish after a sibling slice hits rate limit.',
                          sectionHeading: paper.sectionHeading || 'Method',
                          sectionRole: paper.sectionRole || 'method',
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
      }

      throw new Error('rate-aware chunk scheduler should not fetch later slices');
    };

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'chunk-rate-stop-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'chunk-rate-stop-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'chunk-first',
      llmBatchSize: 1,
      llmBatchConcurrency: 2,
      llmRateLimitRetryCount: 0,
      llmRateLimitRetryDelayMs: 0,
      llmRateLimitRetryMaxDelayMs: 0,
      identifierResolutionEnabled: false
    });

    assert.equal(fetchCount, 2);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.match(manifest.llmOptimization?.rateLimitCooldownUntil || '', /^\d{4}-\d{2}-\d{2}T/);

    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const completed = snapshots.filter((snapshot) => snapshot.llm.semanticExtractionParticipated);
    const rateLimited = snapshots.filter((snapshot) => snapshot.llm.semanticExtractionParticipationReason === 'rate-limited');
    const skipped = snapshots.filter((snapshot) => snapshot.llmSemanticObjects.skippedProviderCall);

    assert.equal(completed.length, 1);
    assert.equal(rateLimited.length, 3);
    assert.ok(skipped.length >= 2);
    assert.ok(skipped.length <= rateLimited.length);

    for (const snapshot of snapshots) {
      assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    }
    for (const snapshot of rateLimited) {
      assert.equal(snapshot.llm.semanticExtractionParticipationReason, 'rate-limited');
      assert.ok(snapshot.llm.chunkPipeline.rateLimitedChunkCount >= 1);
      assert.equal(snapshot.llm.rateLimitCooldownUntil, manifest.llmOptimization.rateLimitCooldownUntil);
    }
    for (const snapshot of skipped) {
      assert.equal(snapshot.llmSemanticObjects.skippedProviderCall, true);
      assert.ok(snapshot.llm.chunkPipeline.skippedProviderCallCount >= 1);
    }
  } finally {
    const { clearLlmRateLimitCooldowns } = await import('../src/core/llm/ollama.js');
    await clearLlmRateLimitCooldowns({ persisted: false });
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('llmOptimizeCorpus stops scheduling later chunk relation slices after provider rate limit', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-relation-rate-stop-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-relation-rate-stop-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;
  let relationFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    for (let index = 1; index <= 4; index += 1) {
      await fs.writeFile(path.join(tempCorpusRoot, `chunk-relation-rate-stop-${index}.md`), `# Chunk Relation Rate Aware Scheduler Paper ${index}

## Abstract

Paper ${index} first completes chunk semantic extraction, then checks relation extraction rate-limit scheduling.

## Method

The explicit chunk-first path should not launch later relation provider calls after a cooldown starts.
`, 'utf8');
    }

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const papers = extractPromptPapers(prompt);
      const isRelationPrompt = prompt.includes('Allowed relation types:');

      if (isRelationPrompt) {
        relationFetchCount += 1;
        if (relationFetchCount === 1) {
          await sleep(20);
          return createRateLimitResponse('relation quota exhausted');
        }
        if (relationFetchCount === 2) {
          await sleep(60);
          return {
            ok: true,
            async json() {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        chunks: papers.map((paper) => ({
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
        throw new Error('rate-aware chunk relation scheduler should not fetch later slices');
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
                    chunks: papers.map((paper) => ({
                      id: paper.id,
                      problems: [{
                        name: `Semantic prerequisite for ${paper.title || paper.id}`,
                        type: 'Problem',
                        evidenceText: 'Semantic extraction must complete before relation extraction starts.',
                        sectionHeading: paper.sectionHeading || 'Method',
                        sectionRole: paper.sectionRole || 'method',
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'chunk-relation-rate-stop-stage2-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'chunk-relation-rate-stop-stage2-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'chunk-first',
      llmBatchSize: 1,
      llmBatchConcurrency: 2,
      llmRateLimitRetryCount: 0,
      llmRateLimitRetryDelayMs: 0,
      llmRateLimitRetryMaxDelayMs: 0,
      identifierResolutionEnabled: false
    });

    assert.ok(semanticFetchCount >= 1);
    assert.equal(relationFetchCount, 2);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.match(manifest.llmOptimization?.rateLimitCooldownUntil || '', /^\d{4}-\d{2}-\d{2}T/);

    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    assert.equal(snapshots.filter((snapshot) => snapshot.llm.semanticExtractionParticipated).length, 4);
    const relationRateLimited = snapshots
      .filter((snapshot) => snapshot.llm.relationParticipationReason === 'rate-limited');
    const relationSkipped = snapshots
      .filter((snapshot) => Number(snapshot.llm.chunkPipeline.relationSkippedProviderCallCount || 0) > 0);

    assert.ok(relationRateLimited.length >= 2);
    assert.ok(relationSkipped.length >= 2);
    assert.ok(relationSkipped.length <= relationRateLimited.length);
    for (const snapshot of relationRateLimited) {
      assert.ok(snapshot.llm.chunkPipeline.relationRateLimitedChunkCount >= 1);
      assert.equal(snapshot.llm.rateLimitCooldownUntil, manifest.llmOptimization.rateLimitCooldownUntil);
    }
  } finally {
    const { clearLlmRateLimitCooldowns } = await import('../src/core/llm/ollama.js');
    await clearLlmRateLimitCooldowns({ persisted: false });
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('llmOptimizeCorpus circuit-breaks repeated failed chunk relation batches', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-relation-circuit-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-relation-circuit-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let semanticFetchCount = 0;
  let relationFetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    for (let index = 1; index <= 5; index += 1) {
      await fs.writeFile(path.join(tempCorpusRoot, `chunk-relation-circuit-${index}.md`), `# Chunk Relation Circuit Paper ${index}

## Abstract

Paper ${index} should complete semantic extraction before relation extraction begins.

## Method

Repeated relation failures should trip the circuit breaker and skip later relation provider calls.
`, 'utf8');
    }

    globalThis.fetch = async (url, options) => {
      if (!String(url || '').startsWith('https://api.openai.com/v1')) {
        return createIdentifierResolutionMissResponse();
      }

      const request = JSON.parse(options.body);
      const prompt = String(request.messages?.[0]?.content || '');
      const papers = extractPromptPapers(prompt);
      const isRelationPrompt = prompt.includes('Allowed relation types:');

      if (isRelationPrompt) {
        relationFetchCount += 1;
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      chunks: papers.map((paper) => ({
                        id: paper.id,
                        error: 'simulated relation failure'
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
                    chunks: papers.map((paper) => ({
                      id: paper.id,
                      problems: [{
                        name: `Semantic prerequisite for ${paper.title || paper.id}`,
                        type: 'Problem',
                        evidenceText: 'Semantic extraction succeeds before relation circuit breaking is evaluated.',
                        sectionHeading: paper.sectionHeading || 'Method',
                        sectionRole: paper.sectionRole || 'method',
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'chunk-relation-circuit-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'chunk-relation-circuit-test',
      semanticExtraction: 'llm-primary',
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'chunk-first',
      llmBatchSize: 1,
      llmBatchConcurrency: 1,
      llmBatchFailureSplitRetryCount: 0,
      llmRelationCircuitBreakerMinBatches: 2,
      llmRelationCircuitBreakerMinFailedBatches: 2,
      llmRelationCircuitBreakerFailureRate: 1,
      llmRelationCircuitBreakerConsecutiveFailedBatches: 2,
      identifierResolutionEnabled: false
    });

    assert.ok(semanticFetchCount >= 1);
    assert.equal(relationFetchCount, 2);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    assert.equal(snapshots.filter((snapshot) => snapshot.llm.semanticExtractionParticipated).length, 5);

    const circuitSkipped = snapshots.filter((snapshot) => (
      Number(snapshot.llm.chunkPipeline.relationCircuitBreakerSkippedChunkCount || 0) > 0
    ));
    assert.ok(circuitSkipped.length >= 1);
    for (const snapshot of circuitSkipped) {
      assert.equal(snapshot.llm.relationParticipationReason, 'relation-circuit-breaker');
      assert.match(snapshot.llm.error || '', /Relation extraction circuit breaker tripped/);
      assert.ok(snapshot.llm.chunkPipeline.relationSkippedProviderCallCount >= 1);
    }
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

test('llmOptimizeCorpus falls back to chunk extraction when long-context paper output is invalid', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-invalid-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-invalid-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'invalid-fallback.md'), `# Invalid Long Context Fallback

## Abstract

This paper should fall back to chunk extraction when the paper-level result is missing.

## Method

The chunk extractor can still recover a grounded problem from this method section.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);
      const isChunkPrompt = prompt.includes('paper chunks');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(isChunkPrompt
                    ? {
                        chunks: papers.map((paper) => ({
                          id: paper.id,
                          problems: [{
                            name: 'chunk fallback recovered semantic object',
                            type: 'Problem',
                            evidenceText: 'The chunk extractor can still recover a grounded problem.',
                            sectionHeading: paper.sectionHeading || 'Method',
                            sectionRole: paper.sectionRole || 'method',
                            confidence: 0.92
                          }]
                        }))
                      }
                    : {
                        papers: []
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
      name: 'long-context-invalid-fallback-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-invalid-fallback-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      identifierResolutionEnabled: false
    });

    assert.ok(prompts.some((prompt) => !prompt.includes('paper chunks')));
    assert.ok(prompts.some((prompt) => prompt.includes('paper chunks')));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.enabled, true);
    assert.equal(snapshot.llm.longContext.fallbackUsed, true);
    assert.equal(snapshot.llm.longContext.fallbackReason, 'missing-result');
    assert.equal(snapshot.llm.longContext.callCount, 1);
    assert.equal(snapshot.llm.longContext.validationStatus, 'fallback');
    assert.equal(snapshot.llm.longContext.validationDetails.reason, 'missing-result');
    assert.equal(snapshot.llm.longContext.validationDetails.attempted, true);
    assert.equal(snapshot.llm.longContext.validationDetails.participated, false);
    assert.equal(snapshot.llm.longContext.validationDetails.semanticObjectCount, 0);
    assert.equal(snapshot.llmSemanticObjects.longContext.fallbackUsed, true);
    assert.equal(snapshot.llmSemanticObjects.longContext.validationDetails.reason, 'missing-result');
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

test('llmOptimizeCorpus records schema-validation fallback for malformed long-context paper fields', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-schema-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-schema-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'schema-fallback.md'), `# Long Context Schema Fallback

## Abstract

This paper should fall back when the long-context response has malformed schema fields.

## Method

The chunk fallback should recover a schema validation problem object.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);
      const isChunkPrompt = prompt.includes('paper chunks');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(isChunkPrompt
                    ? {
                        chunks: papers.map((paper) => ({
                          id: paper.id,
                          problems: [{
                            name: 'schema validation chunk fallback',
                            type: 'Problem',
                            evidenceText: 'The chunk fallback should recover a schema validation problem object.',
                            sectionHeading: paper.sectionHeading || 'Method',
                            sectionRole: paper.sectionRole || 'method',
                            confidence: 0.9
                          }]
                        }))
                      }
                    : {
                        papers: papers.map((paper) => ({
                          id: paper.id,
                          problems: 'malformed-problems-field'
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-schema-fallback-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-schema-fallback-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      identifierResolutionEnabled: false
    });

    assert.ok(prompts.some((prompt) => !prompt.includes('paper chunks')));
    assert.ok(prompts.some((prompt) => prompt.includes('paper chunks')));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.fallbackUsed, true);
    assert.equal(snapshot.llm.longContext.fallbackReason, 'schema-validation-failed');
    assert.equal(snapshot.llm.longContext.validationStatus, 'fallback');
    assert.equal(snapshot.llm.longContext.validationDetails.reason, 'schema-validation-failed');
    assert.equal(snapshot.llm.longContext.validationDetails.attempted, true);
    assert.equal(snapshot.llm.longContext.validationDetails.participated, false);
    assert.match(snapshot.llm.longContext.validationDetails.error, /problems/i);
    assert.equal(snapshot.llmSemanticObjects.longContext.validationDetails.reason, 'schema-validation-failed');
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

test('llmOptimizeCorpus falls back to chunk extraction when long-context output has no semantic objects', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-quality-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-quality-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'quality-guard.md'), `# Long Context Quality Guard

## Abstract

This paper-level response participates but returns no semantic objects.

## Method

The chunk fallback should recover the concrete quality guard problem.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);
      const isChunkPrompt = prompt.includes('paper chunks');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(isChunkPrompt
                    ? {
                        chunks: papers.map((paper) => ({
                          id: paper.id,
                          problems: [{
                            name: 'quality guard chunk fallback',
                            type: 'Problem',
                            evidenceText: 'The chunk fallback should recover the concrete quality guard problem.',
                            sectionHeading: paper.sectionHeading || 'Method',
                            sectionRole: paper.sectionRole || 'method',
                            confidence: 0.91
                          }]
                        }))
                      }
                    : {
                        papers: papers.map((paper) => ({
                          id: paper.id,
                          problems: [],
                          methods: [],
                          claims: []
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

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-quality-guard-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-quality-guard-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      identifierResolutionEnabled: false
    });

    assert.ok(prompts.some((prompt) => !prompt.includes('paper chunks')));
    assert.ok(prompts.some((prompt) => prompt.includes('paper chunks')));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.enabled, true);
    assert.equal(snapshot.llm.longContext.fallbackUsed, true);
    assert.equal(snapshot.llm.longContext.fallbackReason, 'semantic-quality-guard');
    assert.equal(snapshot.llm.longContext.callCount, 1);
    assert.equal(snapshot.llm.longContext.validationStatus, 'fallback');
    assert.equal(snapshot.llm.longContext.validationDetails.reason, 'semantic-quality-guard');
    assert.equal(snapshot.llm.longContext.validationDetails.attempted, true);
    assert.equal(snapshot.llm.longContext.validationDetails.participated, true);
    assert.equal(snapshot.llm.longContext.validationDetails.semanticObjectCount, 0);
    assert.equal(snapshot.llmSemanticObjects.longContext.validationDetails.reason, 'semantic-quality-guard');
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

test('llmOptimizeCorpus records specific long-context fallback reasons for provider failures', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-reasons-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-reasons-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'timeout.md'), `# Timeout Classification

## Abstract

This paper simulates a provider timeout during long-context extraction.
`, 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'truncated.md'), `# Truncation Classification

## Abstract

This paper simulates a truncated provider output during long-context extraction.
`, 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'invalid-json.md'), `# Invalid Json Classification

## Abstract

This paper simulates an invalid JSON provider output during long-context extraction.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const papers = extractPromptPapers(prompt);
      const isChunkPrompt = prompt.includes('paper chunks');

      if (isChunkPrompt) {
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      chunks: papers.map((paper) => ({
                        id: paper.id,
                        problems: [{
                          name: `fallback object for ${paper.title}`,
                          type: 'Problem',
                          evidenceText: 'The chunk fallback recovers a semantic object.',
                          sectionHeading: paper.sectionHeading || 'Abstract',
                          sectionRole: paper.sectionRole || 'abstract',
                          confidence: 0.88
                        }]
                      }))
                    })
                  }
                }
              ]
            };
          }
        };
      }

      const promptText = String(prompt || '').toLowerCase();
      if (promptText.includes('timeout classification')) {
        throw new Error('Request timed out after 30000ms');
      }
      if (promptText.includes('truncation classification')) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          async text() {
            return JSON.stringify({
              error: {
                message: 'finish_reason=length: output truncated because max_tokens was too small'
              }
            });
          }
        };
      }

      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        async text() {
          return JSON.stringify({
            error: {
              message: 'invalid json parse error in provider response'
            }
          });
        }
      };
    };

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-fallback-reason-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-fallback-reason-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      identifierResolutionEnabled: false
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const snapshotsByFile = new Map(snapshots.map((snapshot) => [path.basename(snapshot.sourcePath), snapshot]));
    const expectations = new Map([
      ['timeout.md', 'timeout'],
      ['truncated.md', 'output-truncated'],
      ['invalid-json.md', 'invalid-json']
    ]);

    for (const [fileName, reason] of expectations) {
      const snapshot = snapshotsByFile.get(fileName);
      assert.ok(snapshot, `missing snapshot for ${fileName}`);
      assert.equal(snapshot.llm.semanticExtractionParticipated, true);
      assert.equal(snapshot.llm.chunkPipeline.enabled, true);
      assert.equal(snapshot.llm.longContext.fallbackUsed, true);
      assert.equal(snapshot.llm.longContext.fallbackReason, reason);
      assert.equal(snapshot.llm.longContext.validationStatus, 'fallback');
      assert.equal(snapshot.llm.longContext.validationDetails.reason, reason);
      assert.equal(snapshot.llm.longContext.callCount, 1);
    }
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

test('llmOptimizeCorpus bounds stuck long-context slices and falls back to chunks', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-slice-timeout-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-slice-timeout-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];
  const batchEvents = [];
  let releaseStuckProvider = null;
  let stuckProviderReleased = false;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'stuck-provider.md'), `# Stuck Provider Timeout

## Abstract

This paper simulates an LLM provider call that never resolves on the long-context path.

## Method

The chunk fallback should recover a concrete semantic object after the import-layer slice timeout.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);

      if (!prompt.includes('paper chunks')) {
        return new Promise((resolve) => {
          releaseStuckProvider = () => {
            if (stuckProviderReleased) return;
            stuckProviderReleased = true;
            resolve({
              ok: true,
              async json() {
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          papers: papers.map((paper) => ({
                            id: paper.id,
                            problems: [],
                            methods: [],
                            claims: []
                          }))
                        })
                      }
                    }
                  ]
                };
              }
            });
          };
        });
      }

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    chunks: papers.map((paper) => ({
                      id: paper.id,
                      problems: [{
                        name: 'bounded timeout chunk fallback',
                        type: 'Problem',
                        evidenceText: 'The chunk fallback recovered after a stuck long-context provider call.',
                        sectionHeading: paper.sectionHeading || 'Method',
                        sectionRole: paper.sectionRole || 'method',
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-slice-timeout-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-slice-timeout-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmBatchSize: 1,
      llmBatchSliceTimeoutMs: 20,
      identifierResolutionEnabled: false,
      onLlmBatchComplete(event = {}) {
        batchEvents.push(event);
      }
    });
    releaseStuckProvider?.();
    await sleep(5);

    assert.ok(prompts.some((prompt) => !prompt.includes('paper chunks')));
    assert.ok(prompts.some((prompt) => prompt.includes('paper chunks')));
    assert.ok(batchEvents.some((event) => event.reason === 'provider-timeout' && event.timeoutMs === 20));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.fallbackUsed, true);
    assert.equal(snapshot.llm.longContext.fallbackReason, 'timeout');
    assert.equal(snapshot.llm.longContext.validationStatus, 'fallback');
    assert.equal(snapshot.llm.longContext.validationDetails.reason, 'timeout');
    assert.equal(snapshot.llm.longContext.validationDetails.attempted, true);
    assert.equal(snapshot.llm.longContext.validationDetails.participated, false);
  } finally {
    releaseStuckProvider?.();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('llmOptimizeCorpus bounds stuck chunk persistence and job-state writes', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-persistence-timeout-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-chunk-persistence-timeout-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const persistenceEvents = [];
  let blockedJobStateSave = false;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'stuck-persistence.md'), `# Stuck Persistence Timeout

## Abstract

This paper simulates a chunk result persistence write that never resolves.

## Method

The LLM result should not be trusted as completed when the corresponding chunk
extraction artifact cannot be saved within the configured deadline.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const papers = extractPromptPapers(prompt);
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    chunks: papers.map((paper) => ({
                      id: paper.id,
                      problems: [{
                        name: 'untrusted unsaved chunk result',
                        type: 'Problem',
                        evidenceText: 'This result should be downgraded if chunk persistence times out.',
                        sectionHeading: paper.sectionHeading || 'Method',
                        sectionRole: paper.sectionRole || 'method',
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'chunk-persistence-timeout-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'chunk-persistence-timeout-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmExtractionStrategy: 'chunk-first',
      llmBatchSize: 1,
      llmPersistenceTimeoutMs: 20,
      llmJobStateTimeoutMs: 20,
      identifierResolutionEnabled: false,
      onBeforeSaveStage2JobState() {
        if (blockedJobStateSave) return undefined;
        blockedJobStateSave = true;
        return new Promise(() => {});
      },
      onBeforeSaveChunkExtractionResult() {
        return new Promise(() => {});
      },
      onLlmPersistenceTimeout(event = {}) {
        persistenceEvents.push(event);
      }
    });

    assert.ok(persistenceEvents.some((event) => event.reason === 'job-state-save-timeout'));
    assert.ok(persistenceEvents.some((event) => event.reason === 'chunk-result-save-timeout'));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, false);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.ok(snapshot.llm.chunkPipeline.failedChunkCount >= 1);
    assert.match(snapshot.llmSemanticObjects.error || '', /chunk-result-save-timeout/);
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

test('llmOptimizeCorpus falls back to chunks before provider calls when long-context input is over budget', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-budget-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-long-context-budget-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const prompts = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'budget-fallback.md'), `# Over Budget Long Context Fallback

## Abstract

This markdown paper is deliberately forced over the configured long-context budget.

## Method

The chunk fallback should run without first submitting the whole paper to the provider.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      prompts.push(prompt);
      const papers = extractPromptPapers(prompt);
      assert.equal(prompt.includes('paper chunks'), true);

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    chunks: papers.map((paper) => ({
                      id: paper.id,
                      problems: [{
                        name: 'over-budget chunk fallback',
                        type: 'Problem',
                        evidenceText: 'The chunk fallback should run without first submitting the whole paper.',
                        sectionHeading: paper.sectionHeading || 'Method',
                        sectionRole: paper.sectionRole || 'method',
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

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.materializeCorpus(tempCorpusRoot, {
      name: 'long-context-budget-fallback-test',
      force: true,
      identifierResolutionEnabled: false
    });

    await ingestion.llmOptimizeCorpus(tempCorpusRoot, {
      name: 'long-context-budget-fallback-test',
      semanticExtraction: 'llm-primary',
      llmRelations: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmContextWindowTokens: 1_000_000,
      llmLongContextPromptMaxChars: 100,
      llmBatchPromptMaxChars: 1_000_000,
      identifierResolutionEnabled: false
    });

    assert.ok(prompts.length >= 1);
    assert.equal(prompts.every((prompt) => prompt.includes('paper chunks')), true);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.longContext.enabled, true);
    assert.equal(snapshot.llm.longContext.fallbackUsed, true);
    assert.equal(snapshot.llm.longContext.fallbackReason, 'over-budget');
    assert.equal(snapshot.llm.longContext.callCount, 0);
    assert.ok(snapshot.llm.longContext.inputChars > snapshot.llm.longContext.inputBudgetChars);
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
  const llmBatchEvents = [];
  const legacyBatchEvents = [];

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
      llmBatchSize: 8,
      onLlmBatchComplete(event) {
        llmBatchEvents.push(event);
      },
      onBatchComplete(event) {
        legacyBatchEvents.push(event);
      }
    });
    assert.equal(firstStage2.stage, 'llm-optimized');
    assert.equal(semanticFetchCount, 1);
    assert.equal(relationFetchCount, 1);
    assert.deepEqual(llmBatchEvents.map((event) => event.phase), [
      'chunk-semantic-extraction',
      'chunk-relation-extraction'
    ]);
    assert.deepEqual(llmBatchEvents.map((event) => event.stage), [
      'llm-optimize',
      'llm-optimize'
    ]);
    for (const event of llmBatchEvents) {
      assert.equal(event.batchNumber, 1);
      assert.equal(event.totalBatches, 1);
      assert.equal(event.batchSize, event.total);
      assert.ok(event.total >= 2);
      assert.equal(typeof event.promptChars, 'number');
      assert.ok(event.promptChars > 0);
      assert.equal(typeof event.durationMs, 'number');
      assert.ok(event.durationMs >= 0);
      assert.equal(typeof event.failureCount, 'number');
    }
    assert.deepEqual(legacyBatchEvents.map((event) => event.phase), [
      'chunk-semantic-extraction',
      'chunk-relation-extraction'
    ]);
    const ledgerRoot = path.join(tempCorpusRoot, '.papernexus', 'llm-jobs', 'stage2-ledger');
    const ledgerRuns = await fs.readdir(ledgerRoot);
    assert.equal(ledgerRuns.length, 1);
    assert.match(ledgerRuns[0], /^stage2-/);
    const ledgerRows = (await fs.readFile(path.join(ledgerRoot, ledgerRuns[0], 'llm-results.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(ledgerRows.some((row) => row.phase === 'semantic-extraction' || row.phase === 'chunk-semantic-extraction'));
    assert.ok(ledgerRows.some((row) => row.phase === 'relation-extraction' || row.phase === 'chunk-relation-extraction'));

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
      researchRelations: 'research-relations-v1',
      chunkSemanticObjects: 'chunk-semantic-objects-v1',
      chunkResearchRelations: 'chunk-research-relations-v1'
    });
    assert.ok(manifest.llmOptimization.chunkPipelineConfigSignature);
    assert.equal(JSON.parse(manifest.llmOptimization.semanticConfigSignature).promptVersion, 'semantic-objects-v2');
    assert.equal(JSON.parse(manifest.llmOptimization.relationConfigSignature).promptVersion, 'research-relations-v1');

    const firstSource = manifest.sources[0];
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, firstSource.sourceKey);
    assert.equal(snapshot.llmSemanticObjects.promptVersion, 'semantic-objects-v2');
    assert.equal(snapshot.llm.semanticPromptVersion, 'semantic-objects-v2');
    assert.equal(snapshot.llm.relationPromptVersion, 'research-relations-v1');
    assert.equal(snapshot.llm.chunkPipeline.enabled, true);
    assert.equal(snapshot.llm.chunkPipeline.configSignature, manifest.llmOptimization.chunkPipelineConfigSignature);
    assert.equal(snapshot.llmSemanticObjects.chunkPipeline.enabled, true);
    const chunkStore = await import('../src/storage/chunk-store.js');
    const storedChunks = await chunkStore.loadPaperChunks(tempCorpusRoot, firstSource.sourceKey);
    assert.ok(storedChunks.chunkCount >= 1);
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
      llmBatchSize: 1,
      llmChunkLimitPerPaper: 1
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
      llmBatchSize: 1,
      llmChunkLimitPerPaper: 1
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
      llmBatchSize: 1,
      llmChunkLimitPerPaper: 1
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
      llmBatchSize: 1,
      llmChunkLimitPerPaper: 1
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
