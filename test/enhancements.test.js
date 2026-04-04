import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');
const originalFetch = globalThis.fetch;

let sharedHome;
let previousHome;
let sharedModules;

before(async () => {
  sharedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-enh-home-'));
  previousHome = process.env.PAPERNEXUS_HOME;
  process.env.PAPERNEXUS_HOME = sharedHome;
  sharedModules = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/core/enhancements/worker.js'),
    import('../src/storage/enhancement-store.js'),
    import('../src/server/api.js'),
    import('../src/storage/corpus-store.js')
  ]);
});

after(async () => {
  if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = previousHome;
  await fs.rm(sharedHome, { recursive: true, force: true });
});

async function createTempCorpus() {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-enh-corpus-'));

  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(
      path.join(examplesRoot, fileName),
      path.join(tempCorpusRoot, fileName)
    );
  }

  return {
    tempCorpusRoot,
    ingestion: sharedModules[0],
    worker: sharedModules[1],
    enhancementStore: sharedModules[2],
    api: sharedModules[3],
    corpusStore: sharedModules[4]
  };
}

async function cleanupTempCorpus(context) {
  await fs.rm(context.tempCorpusRoot, { recursive: true, force: true });
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

test('analyzeCorpus enqueues theory/storyline enhancement jobs without blocking the base graph build', async () => {
  const context = await createTempCorpus();

  try {
    const result = await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-test',
      force: true
    });

    assert.equal(result.meta.paperCount, 2);
    assert.equal(result.enhancement?.queuedCount, 2);

    const summary = await context.enhancementStore.summarizeEnhancements(context.tempCorpusRoot);
    assert.equal(summary.queue.pending, 2);
    assert.equal(summary.ready, 0);
  } finally {
    await cleanupTempCorpus(context);
  }
});

test('enhancement worker materializes per-paper theory and storyline overlays', async () => {
  const context = await createTempCorpus();

  try {
    await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-worker-test',
      force: true
    });

    const runResult = await context.worker.runEnhancementQueueUntilIdle(context.tempCorpusRoot, {
      maxPasses: 8,
      backfillLimit: 2
    });
    assert.equal(runResult.summary.queue.pending, 0);
    assert.equal(runResult.summary.ready, 2);

    const manifest = await context.corpusStore.loadSourceManifest(context.tempCorpusRoot);
    const paperId = manifest.sources[0].paperId;
    const payload = await context.enhancementStore.loadPaperEnhancement(context.tempCorpusRoot, paperId);

    assert.ok(payload.overlay, 'expected an overlay to be written');
    assert.ok(payload.overlay.overlays.theory.cards.length > 0, 'expected theory cards');
    assert.ok(payload.overlay.overlays.storyline.beats.length >= 3, 'expected storyline beats');
    assert.ok(payload.overlay.overlays.reflection.cards.length > 0, 'expected reflection cards');
    assert.ok(payload.overlay.overlays.reflection.slots.innovations.length > 0, 'expected innovation cards');
    assert.ok(payload.overlay.overlays.reflection.slots.experiments.length > 0, 'expected experiment cards');
    assert.ok(payload.overlay.overlays.reflection.slots.outcomes.length > 0, 'expected outcome cards');
    assert.ok(payload.overlay.overlays.reflection.slots.reflections.length > 0, 'expected reflection note cards');
    assert.ok(payload.overlay.overlays.theory.supportNote.length > 0, 'expected theory support note');
    assert.ok(Array.isArray(payload.overlay.overlays.storyline.missingBeats), 'expected missing beat tracking');

    const summaryPayload = await context.api.enhancementSummaryPayload(context.tempCorpusRoot);
    assert.ok(summaryPayload.enhancements.papers[0].reflection, 'expected reflection summary in enhancement index');
  } finally {
    await cleanupTempCorpus(context);
  }
});

test('idle backfill can enqueue overlays for an existing corpus that skipped ingestion-time queueing', async () => {
  const context = await createTempCorpus();

  try {
    await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-backfill-test',
      force: true,
      enqueueEnhancements: false
    });

    const queued = await context.enhancementStore.enqueueEnhancementBackfill(context.tempCorpusRoot, {
      limit: 2
    });
    assert.equal(queued.queuedCount, 2);

    const summaryPayload = await context.api.enhancementSummaryPayload(context.tempCorpusRoot);
    assert.equal(summaryPayload.enhancements.queue.pending, 2);
  } finally {
    await cleanupTempCorpus(context);
  }
});

test('reserveNextEnhancementJob skips pending jobs that are already satisfied by the current enhancement index', async () => {
  const context = await createTempCorpus();

  try {
    await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-satisfied-job-test',
      force: true
    });

    await context.worker.runEnhancementQueueUntilIdle(context.tempCorpusRoot, {
      maxPasses: 8,
      backfillLimit: 2
    });

    const manifest = await context.corpusStore.loadSourceManifest(context.tempCorpusRoot);
    const first = manifest.sources[0];

    await context.enhancementStore.enqueuePaperEnhancements(context.tempCorpusRoot, [
      {
        paperId: first.paperId,
        paperTitle: first.paperTitle,
        sourceKey: first.sourceKey,
        sourceFingerprint: first.fingerprint,
        sourceMarkdownPath: first.sourceMarkdownPath,
        overlayKinds: ['theory', 'storyline', 'reflection'],
        trigger: 'test'
      }
    ]);

    const reserved = await context.enhancementStore.reserveNextEnhancementJob(context.tempCorpusRoot);
    assert.equal(reserved, null);

    const summary = await context.enhancementStore.summarizeEnhancements(context.tempCorpusRoot);
    assert.equal(summary.queue.pending, 0);
  } finally {
    await cleanupTempCorpus(context);
  }
});

test('runEnhancementQueueOnce stays idle when automatic backfill is disabled', async () => {
  const context = await createTempCorpus();

  try {
    await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-no-auto-backfill-test',
      force: true,
      enqueueEnhancements: false
    });

    const result = await context.worker.runEnhancementQueueOnce(context.tempCorpusRoot, {
      backfillLimit: 0
    });

    assert.equal(result.processed, false);
    assert.equal(result.reason, 'idle');

    const summary = await context.enhancementStore.summarizeEnhancements(context.tempCorpusRoot);
    assert.equal(summary.queue.pending, 0);
    assert.equal(summary.ready, 0);
  } finally {
    await cleanupTempCorpus(context);
  }
});

test('enhance backfill refreshes stale catalyst metadata for an existing corpus before overlays', async () => {
  const context = await createTempCorpus();
  let fetchCount = 0;

  try {
    globalThis.fetch = async (_url, options) => {
      fetchCount += 1;
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
                    papers: papers.map((paper) => ({
                      id: paper.id,
                      fieldOfStudy: 'Psychology',
                      fieldCandidates: ['Psychology', 'Learning Sciences'],
                      domainTags: ['Psychology', 'Education'],
                      abstractMechanisms: ['metacontrol policy']
                    }))
                  })
                }
              }
            ]
          };
        }
      };
    };

    await context.ingestion.analyzeCorpus(context.tempCorpusRoot, {
      name: 'enhancement-catalyst-backfill-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      enqueueEnhancements: false
    });

    const manifest = await context.corpusStore.loadSourceManifest(context.tempCorpusRoot);
    const firstEntry = manifest.sources[0];
    const snapshot = await context.corpusStore.loadSemanticPaperSnapshot(context.tempCorpusRoot, firstEntry.sourceKey);
    const oldSemanticSignature = JSON.stringify({
      version: 0,
      mode: 'llm-primary',
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1'
    });

    delete snapshot.fieldOfStudy;
    delete snapshot.fieldCandidates;
    delete snapshot.domainTags;
    delete snapshot.abstractMechanisms;
    snapshot.llmSemanticObjects = {
      ...snapshot.llmSemanticObjects,
      fieldOfStudy: null,
      fieldCandidates: [],
      domainTags: [],
      abstractMechanisms: [],
      configSignature: oldSemanticSignature
    };
    snapshot.llm = {
      ...snapshot.llm,
      semanticConfigSignature: oldSemanticSignature
    };
    await context.corpusStore.saveSemanticPaperSnapshot(context.tempCorpusRoot, firstEntry.sourceKey, snapshot);

    manifest.llmOptimization = {
      ...manifest.llmOptimization,
      catalystMetadataContractVersion: 0
    };
    await context.corpusStore.saveSourceManifest(context.tempCorpusRoot, manifest);

    const result = await context.worker.runEnhancementQueueOnce(context.tempCorpusRoot, {
      backfillLimit: 0,
      catalystBackfill: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.equal(result.catalystBackfilled, true);
    assert.ok(fetchCount > 0, 'expected LLM semantic extraction to rerun during backfill');

    const nextManifest = await context.corpusStore.loadSourceManifest(context.tempCorpusRoot);
    const nextSnapshot = await context.corpusStore.loadSemanticPaperSnapshot(context.tempCorpusRoot, firstEntry.sourceKey);

    assert.equal(nextManifest.llmOptimization.catalystMetadataContractVersion, 1);
    assert.equal(nextSnapshot.fieldOfStudy, 'Psychology');
    assert.ok(nextSnapshot.domainTags.includes('Education'));
    assert.ok(nextSnapshot.abstractMechanisms.includes('metacontrol policy'));
  } finally {
    globalThis.fetch = originalFetch;
    await cleanupTempCorpus(context);
  }
});
