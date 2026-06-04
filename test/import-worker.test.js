import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function waitFor(check, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

test('import worker grows progressive batch targets while queued work remains', async () => {
  let batching = null;
  ({ __importWorkerTestables: batching } = await import('../src/core/imports/worker.js'));
  const rootPath = path.join(os.tmpdir(), `papernexus-progressive-batch-${Date.now()}-${Math.random()}`);
  const cappedRootPath = `${rootPath}-capped`;

  try {
    const options = batching.resolveImportBatchOptions({
      batchEnabled: true
    });
    assert.equal(options.enabled, true);
    assert.equal(options.maxTasks, 16);
    assert.equal(options.initialTasks, 4);
    assert.equal(options.fastMdBurstTargetTasks, 10);
    assert.equal(options.progressive, true);
    assert.equal(options.coalesceMs, 0);

    assert.equal(batching.getProgressiveImportBatchTarget(rootPath, options), 4);

    let progression = batching.updateProgressiveImportBatchTarget(
      rootPath,
      options,
      {
        processed: true,
        failed: false,
        batchId: 'impbatch:first',
        batchTaskIds: ['a', 'b', 'c', 'd']
      },
      20
    );
    assert.equal(progression.currentTarget, 4);
    assert.equal(progression.nextTarget, 8);
    assert.equal(batching.getProgressiveImportBatchTarget(rootPath, options), 8);

    progression = batching.updateProgressiveImportBatchTarget(
      rootPath,
      options,
      {
        processed: true,
        failed: false,
        batchId: 'impbatch:second',
        batchTaskIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
      },
      20
    );
    assert.equal(progression.currentTarget, 8);
    assert.equal(progression.nextTarget, 16);
    assert.equal(batching.getProgressiveImportBatchTarget(rootPath, options), 16);

    progression = batching.updateProgressiveImportBatchTarget(
      rootPath,
      options,
      {
        processed: true,
        failed: false,
        batchId: 'impbatch:third',
        batchTaskIds: Array.from({ length: 16 }, (_, index) => `task-${index}`)
      },
      2
    );
    assert.equal(progression.currentTarget, 16);
    assert.equal(progression.nextTarget, 16);
    assert.equal(batching.getProgressiveImportBatchTarget(rootPath, options), 16);

    progression = batching.updateProgressiveImportBatchTarget(
      rootPath,
      options,
      {
        processed: true,
        failed: false,
        batchId: 'impbatch:done',
        batchTaskIds: ['last']
      },
      0
    );
    assert.equal(progression.reset, true);
    assert.equal(progression.nextTarget, 4);
    assert.equal(batching.getProgressiveImportBatchTarget(rootPath, options), 4);

    const cappedOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 64
    });
    assert.equal(cappedOptions.maxTasks, 16);

    const lowerMaxOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 4
    });
    assert.equal(batching.getProgressiveImportBatchTarget(cappedRootPath, lowerMaxOptions), 4);
    progression = batching.updateProgressiveImportBatchTarget(
      cappedRootPath,
      lowerMaxOptions,
      {
        processed: true,
        failed: false,
        batchId: 'impbatch:capped',
        batchTaskIds: ['a', 'b', 'c', 'd']
      },
      20
    );
    assert.equal(progression.nextTarget, 4);

    const coalesceOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 8,
      batchCoalesceMs: 90,
      batchCoalescePollMs: 5
    });
    assert.equal(coalesceOptions.coalesceMs, 90);
    assert.equal(coalesceOptions.coalescePollMs, 25);
    assert.equal(batching.resolveImportBatchCoalesceTargetTasks(coalesceOptions), 8);
    const coalesceSummary = batching.summarizeImportBatchCoalesceTasks([
      { id: 'pending-a', status: 'pending', stage: 'queued' },
      { id: 'pending-b', status: 'pending', stage: 'queued' }
    ]);
    assert.deepEqual(coalesceSummary, {
      total: 2,
      pending: 2,
      running: 0
    });
    assert.equal(batching.shouldWaitForImportBatchCoalesce(coalesceSummary, coalesceOptions), true);
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 8, running: 0 }, coalesceOptions),
      false
    );
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 2, running: 1 }, coalesceOptions),
      false
    );

    const explicitCoalesceTargetOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 8,
      batchInitialTasks: 4,
      batchCoalesceMs: 90,
      batchCoalesceTargetTasks: 4
    });
    assert.equal(batching.resolveImportBatchCoalesceTargetTasks(explicitCoalesceTargetOptions), 4);
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 4, running: 0 }, explicitCoalesceTargetOptions),
      false
    );

    const fastMdBurstTasks = Array.from({ length: 10 }, (_, index) => ({
      id: `fast-md-${index}`,
      status: 'pending',
      stage: 'queued',
      processingProfile: 'fast-md-background-semantic',
      files: [
        {
          originalName: `fast-md-${index}.md`,
          mimeType: 'text/markdown'
        }
      ]
    }));
    const fastMdBatchOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 16,
      batchInitialTasks: 4,
      batchCoalesceMs: 15000
    });
    const progressiveReserveOptions = {
      ...fastMdBatchOptions,
      maxTasks: 4
    };
    const fastMdBurstOptions = batching.createFastMdBurstReserveBatchOptions(
      fastMdBurstTasks,
      fastMdBatchOptions,
      progressiveReserveOptions,
      {}
    );
    assert.equal(fastMdBurstOptions.fastMdBurstReady, true);
    assert.equal(fastMdBurstOptions.maxTasks, 10);
    assert.equal(fastMdBurstOptions.coalesceTargetTasks, 10);
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 10, running: 0 }, fastMdBurstOptions),
      false
    );

    const underfilledFastMdBurstOptions = batching.createFastMdBurstReserveBatchOptions(
      fastMdBurstTasks.slice(0, 8),
      fastMdBatchOptions,
      progressiveReserveOptions,
      {}
    );
    assert.equal(underfilledFastMdBurstOptions.fastMdBurstFilling, true);
    assert.equal(underfilledFastMdBurstOptions.fastMdBurstReady, false);
    assert.equal(underfilledFastMdBurstOptions.maxTasks, 10);
    assert.equal(underfilledFastMdBurstOptions.coalesceTargetTasks, 10);
    assert.equal(underfilledFastMdBurstOptions.fastMdBurstTargetTasks, 10);
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 8, running: 0 }, underfilledFastMdBurstOptions),
      true
    );

    const smallFastMdBatchOptions = batching.resolveImportBatchOptions({
      batchEnabled: true,
      batchMaxTasks: 4,
      batchInitialTasks: 2,
      batchCoalesceMs: 60000
    });
    const smallFastMdBurstOptions = batching.createFastMdBurstReserveBatchOptions(
      fastMdBurstTasks.slice(0, 2),
      smallFastMdBatchOptions,
      {
        ...smallFastMdBatchOptions,
        maxTasks: 2
      },
      {}
    );
    assert.equal(smallFastMdBurstOptions.fastMdBurstReady, true);
    assert.equal(smallFastMdBurstOptions.maxTasks, 2);
    assert.equal(
      batching.shouldWaitForImportBatchCoalesce({ pending: 2, running: 0 }, smallFastMdBurstOptions),
      false
    );

    const mixedBurstOptions = batching.createFastMdBurstReserveBatchOptions(
      [
        ...fastMdBurstTasks.slice(0, 3),
        {
          id: 'full-import',
          status: 'pending',
          stage: 'queued',
          processingProfile: 'full',
          files: [
            {
              originalName: 'full-import.md',
              mimeType: 'text/markdown'
            }
          ]
        }
      ],
      fastMdBatchOptions,
      progressiveReserveOptions,
      {}
    );
    assert.equal(mixedBurstOptions.maxTasks, 4);
    assert.equal(mixedBurstOptions.fastMdBurstReady, undefined);
  } finally {
    batching?.resetProgressiveImportBatchTarget(rootPath);
    batching?.resetProgressiveImportBatchTarget(cappedRootPath);
  }
});

test('import worker summarizes LLM batch latency and rate-limit tuning metrics', async () => {
  let batching = null;
  ({ __importWorkerTestables: batching } = await import('../src/core/imports/worker.js'));
  const collector = batching.createLlmBatchMetricsCollector();

  collector.recordComplete({
    phase: 'semantic-extraction',
    batchNumber: 1,
    totalBatches: 2,
    completed: 2,
    total: 4,
    batchSize: 2,
    promptChars: 12000,
    promptMaxChars: 24000,
    durationMs: 101.4,
    llmBatchConcurrency: 2
  });
  collector.recordComplete({
    phase: 'semantic-extraction',
    batchNumber: 2,
    totalBatches: 2,
    completed: 4,
    total: 4,
    batchSize: 2,
    promptChars: 8000,
    promptMaxChars: 24000,
    durationMs: 0,
    llmBatchConcurrency: 2,
    cached: true,
    skipped: true
  });
  collector.recordComplete({
    phase: 'relation-extraction',
    batchNumber: 1,
    totalBatches: 1,
    completed: 1,
    total: 1,
    batchSize: 1,
    durationMs: 17.2,
    llmBatchConcurrency: 2,
    skippedProviderCall: true,
    rateLimitCooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    failureCount: 1
  });
  collector.recordRetry({
    phase: 'semantic-extraction',
    batchNumber: 1,
    batchSize: 2,
    error: 'schema failure'
  });

  const summary = collector.summary();
  assert.equal(summary.completedBatchCount, 3);
  assert.equal(summary.cachedBatchCount, 1);
  assert.equal(summary.skippedBatchCount, 1);
  assert.equal(summary.skippedProviderCallCount, 1);
  assert.equal(summary.rateLimitSkippedBatchCount, 1);
  assert.equal(summary.failedBatchCount, 1);
  assert.equal(summary.retryEventCount, 1);
  assert.equal(summary.maxConcurrency, 2);
  assert.equal(summary.durationMs.count, 3);
  assert.equal(summary.durationMs.p50, 17.2);
  assert.equal(summary.durationMs.p90, 101.4);
  assert.equal(summary.durationMs.p95, 101.4);
  assert.equal(summary.durationMs.max, 101.4);
  assert.equal(summary.providerDurationMs.count, 1);
  assert.equal(summary.providerDurationMs.total, 101.4);
  assert.equal(summary.rateLimitCooldowns.count, 1);
  assert.equal(summary.failureReasons['rate-limited'], 1);
  assert.equal(summary.retryReasons['schema failure'], 1);
  assert.equal(summary.byPhase['semantic-extraction'].cachedBatchCount, 1);
  assert.equal(summary.byPhase['semantic-extraction'].durationMs.p50, 0);
  assert.equal(summary.byPhase['relation-extraction'].rateLimitSkippedBatchCount, 1);
  assert.equal(summary.byPhase['relation-extraction'].failureReasons['rate-limited'], 1);
});

test('import worker builds pollable LLM optimize progress diagnostics', async () => {
  let batching = null;
  ({ __importWorkerTestables: batching } = await import('../src/core/imports/worker.js'));
  const collector = batching.createLlmProgressDiagnosticsCollector({
    mode: 'semantic-enrichment',
    taskId: 'imp:test',
    semanticEnrichmentJobId: 'sem:test',
    changedSourceKeyCount: 2,
    llmConfig: {
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 2
    }
  });

  const first = collector.recordComplete({
    phase: 'semantic-extraction',
    batchNumber: 1,
    totalBatches: 3,
    providerBatchNumber: 1,
    providerTotalBatches: 1,
    completed: 2,
    total: 6,
    batchSize: 2,
    promptChars: 12000,
    promptMaxChars: 24000,
    durationMs: 101.4,
    llmBatchConcurrency: 2
  });
  const retry = collector.recordRetry({
    phase: 'semantic-extraction',
    batchNumber: 2,
    batchSize: 2,
    error: 'provider timeout',
    llmBatchConcurrency: 2
  });
  const rateLimited = collector.recordComplete({
    phase: 'relation-extraction',
    batchNumber: 1,
    totalBatches: 1,
    completed: 1,
    total: 1,
    batchSize: 1,
    skippedProviderCall: true,
    rateLimitCooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    llmBatchConcurrency: 2
  });
  const completed = collector.snapshot({
    status: 'completed',
    completedAt: '2026-06-03T00:00:00.000Z'
  });

  assert.equal(first.contractVersion, 'llm-optimize-progress-diagnostics-v1');
  assert.equal(first.mode, 'semantic-enrichment');
  assert.equal(first.semanticEnrichmentJobId, 'sem:test');
  assert.equal(first.changedSourceKeyCount, 2);
  assert.equal(first.llmConfig.llmContextWindowTokens, 1_000_000);
  assert.equal(first.llmConfig.llmExtractionStrategy, 'long-context-first');
  assert.equal(first.completedBatchCount, 1);
  assert.equal(first.completed, 2);
  assert.equal(first.total, 6);
  assert.equal(first.maxConcurrency, 2);
  assert.equal(first.latestEvent.phase, 'semantic-extraction');
  assert.equal(first.latestEvent.batchNumber, 1);
  assert.equal(first.phases['semantic-extraction'].completedBatchCount, 1);
  assert.equal(retry.retryEventCount, 1);
  assert.equal(retry.retryReasons['provider-retry'], 1);
  assert.equal(retry.phases['semantic-extraction'].retryReasons['provider-retry'], 1);
  assert.equal(rateLimited.rateLimitSkippedBatchCount, 1);
  assert.equal(rateLimited.skippedProviderCallCount, 1);
  assert.equal(rateLimited.phases['relation-extraction'].rateLimitSkippedBatchCount, 1);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completedAt, '2026-06-03T00:00:00.000Z');
});

test('import worker groups batch entries by effective task LLM config', async () => {
  let batching = null;
  ({ __importWorkerTestables: batching } = await import('../src/core/imports/worker.js'));
  const groups = batching.createImportBatchLlmConfigGroups([
    {
      task: { id: 'task-a' },
      changedSourceKeys: ['source-a.md']
    },
    {
      task: {
        id: 'task-b',
        llmExtractionStrategy: 'chunk-first'
      },
      changedSourceKeys: ['source-b.md']
    },
    {
      task: {
        id: 'task-c',
        llmContextWindowTokens: 1_000_000,
        llmExtractionStrategy: 'long-context-first',
        llmLongContextMaxPapersPerCall: 2
      },
      changedSourceKeys: ['source-c.md']
    }
  ], {
    llmContextWindowTokens: 1_000_000,
    llmExtractionStrategy: 'long-context-first',
    llmLongContextMaxPapersPerCall: 2,
    llmBatchConcurrency: 1
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].taskIds, ['task-a', 'task-c']);
  assert.deepEqual(groups[0].changedSourceKeys, ['source-a.md', 'source-c.md']);
  assert.equal(groups[0].llmOptions.llmExtractionStrategy, 'long-context-first');
  assert.equal(groups[0].llmOptions.llmBatchConcurrency, 1);
  assert.deepEqual(groups[1].taskIds, ['task-b']);
  assert.deepEqual(groups[1].changedSourceKeys, ['source-b.md']);
  assert.equal(groups[1].llmOptions.llmExtractionStrategy, 'chunk-first');
  assert.equal(groups[1].llmOptions.llmContextWindowTokens, 1_000_000);
});

test('import worker marks pending tasks as coalescing during batch wait', async () => {
  let batching = null;
  ({ __importWorkerTestables: batching } = await import('../src/core/imports/worker.js'));
  const importStore = await import('../src/storage/import-store.js');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-coalesce-progress-'));

  try {
    const task = await importStore.createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'coalesce-progress.md',
          contentBase64: Buffer.from('# Coalesce Progress\n\n## Abstract\n\nA coalesce progress test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const result = await batching.waitForImportBatchCoalesce(rootPath, {
      enabled: true,
      maxTasks: 4,
      coalesceMs: 50,
      coalescePollMs: 25
    });
    const loaded = await importStore.loadImportTask(rootPath, task.id);

    assert.equal(result.waited, true);
    assert.equal(result.reason, 'timeout');
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.stage, 'queued');
    assert.equal(loaded.progress.currentStep, 'coalescing');
    assert.equal(loaded.progress.processedUnits, 1);
    assert.equal(loaded.progress.totalUnits, 4);
    assert.match(loaded.progress.message, /Coalescing import batch: 1\/4/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import worker processes queued uploads and merges them into the single graph', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      inputPaths: [path.join(workspaceRoot, 'stale-input-path')],
      files: [
        {
          name: 'uploaded-paper.md',
          contentBase64: Buffer.from('# Uploaded Paper\n\n## Abstract\n\nThis upload should enter the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    assert.equal(result.completedTaskIds.includes(task.id), true);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'completed');
    assert.equal(loadedTask.progress.contractVersion, 'import-progress-v1');
    assert.equal(loadedTask.progress.stage, 'completed');
    assert.equal(loadedTask.progress.percent, 100);
    assert.equal(typeof loadedTask.result?.materialized?.timings?.totalMs, 'number');
    assert.equal(loadedTask.result.materialized.timings.totalMs >= 0, true);

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    assert.equal(corpus.meta.authoritativeSyncStatus, 'pending');
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Uploaded Paper'));

    const manifest = await corpusStore.loadSourceManifest(indexRoot);
    assert.deepEqual(manifest.inputPaths, [inputRoot]);
    assert.equal(manifest.sources.length, 2);
    assert.equal(
      manifest.sources.some((entry) => String(entry.sourcePath || '').includes(path.join('.papernexus', 'imports'))),
      true
    );
    const queuedJobs = await import('../src/storage/authoritative-sync-store.js')
      .then((module) => module.listAuthoritativeSyncJobs(indexRoot));
    assert.equal(queuedJobs.length, 1);

    const log = await importStore.loadImportTaskLog(indexRoot, task.id);
    assert.match(log, /stage materialize/i);
    assert.match(log, /stage fast-commit/i);
    assert.doesNotMatch(log, /stage build-graph/i);
    assert.doesNotMatch(log, /stage write-index/i);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker batches queued markdown uploads into one graph commit when enabled', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-batch-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-batch-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker,
      authoritativeSyncStore
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js'),
      import('../src/storage/authoritative-sync-store.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-batch-test',
      force: true
    });

    const firstTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 1,
      files: [
        {
          name: 'batch-upload-one.md',
          contentBase64: Buffer.from('# Batch Upload One\n\n## Abstract\n\nThe first batch upload should enter the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const secondTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'chunk-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 1,
      files: [
        {
          name: 'batch-upload-two.md',
          contentBase64: Buffer.from('# Batch Upload Two\n\n## Abstract\n\nThe second batch upload should enter the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only',
      batchEnabled: true,
      batchMaxTasks: 4
    });

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.match(result.batchId, /^impbatch:/);
    assert.deepEqual(result.batchTaskIds, [firstTask.id, secondTask.id]);
    assert.deepEqual(result.completedTaskIds, [firstTask.id, secondTask.id]);

    const loadedFirstTask = await importStore.loadImportTask(indexRoot, firstTask.id);
    const loadedSecondTask = await importStore.loadImportTask(indexRoot, secondTask.id);
    assert.equal(loadedFirstTask.status, 'completed');
    assert.equal(loadedSecondTask.status, 'completed');
    assert.equal(loadedFirstTask.result.batch.batchId, result.batchId);
    assert.equal(loadedSecondTask.result.batch.batchId, result.batchId);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.contractVersion, 'import-performance-v1');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.mode, 'batch');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.batchTaskCount, 2);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.changedSourceKeyCount, 1);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.batchChangedSourceKeyCount, 2);
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.stageTimingsMs.materialize, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.stageTimingsMs.llmOptimize, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.stageTimingsMs.fastCommit, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.stageTimingsMs.total, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.loadLite, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.buildDelta, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.writeDelta, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs['write.queueAuthoritativeSync'], 'number');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.llmConfigGroupCount, 2);
    assert.equal(loadedSecondTask.result.metrics.importPerformance.llmConfigGroupCount, 2);
    assert.notEqual(
      loadedFirstTask.result.metrics.importPerformance.llmConfigKey,
      loadedSecondTask.result.metrics.importPerformance.llmConfigKey
    );
    assert.equal(loadedFirstTask.result.metrics.importPerformance.llmConfig.llmExtractionStrategy, 'long-context-first');
    assert.equal(loadedSecondTask.result.metrics.importPerformance.llmConfig.llmExtractionStrategy, 'chunk-first');
    assert.equal(loadedFirstTask.result.optimized.llmConfigGroups.length, 2);
    assert.equal(
      loadedFirstTask.result.optimized.llmConfigGroups.some((group) => (
        group.taskIds.includes(firstTask.id)
        && group.llmConfig.llmExtractionStrategy === 'long-context-first'
      )),
      true
    );
    assert.equal(
      loadedSecondTask.result.optimized.llmConfigGroups.some((group) => (
        group.taskIds.includes(secondTask.id)
        && group.llmConfig.llmExtractionStrategy === 'chunk-first'
      )),
      true
    );
    assert.equal(
      loadedFirstTask.result.authoritativeSync.jobId,
      loadedSecondTask.result.authoritativeSync.jobId
    );
    assert.deepEqual(
      loadedFirstTask.result.fastCommitted.batchTaskIds,
      [firstTask.id, secondTask.id]
    );
    assert.equal(loadedFirstTask.result.fastCommitted.batchChangedSourceKeys.length, 2);
    assert.equal(loadedSecondTask.result.fastCommitted.batchChangedSourceKeys.length, 2);

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 3);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Batch Upload One'));
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Batch Upload Two'));

    const manifest = await corpusStore.loadSourceManifest(indexRoot);
    assert.equal(manifest.sources.length, 3);

    const queuedJobs = await authoritativeSyncStore.listAuthoritativeSyncJobs(indexRoot);
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].jobId, loadedFirstTask.result.authoritativeSync.jobId);

    const firstLog = await importStore.loadImportTaskLog(indexRoot, firstTask.id);
    const secondLog = await importStore.loadImportTaskLog(indexRoot, secondTask.id);
    assert.match(firstLog, new RegExp(result.batchId));
    assert.match(secondLog, new RegExp(result.batchId));
    assert.match(firstLog, /stage llm-optimize batch/i);
    assert.match(secondLog, /stage fast-commit batch/i);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker fast-md batch skips blocking LLM and commits direct lite delta', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-fast-md-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-fast-md-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker,
      authoritativeSyncStore,
      importSemanticStore
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js'),
      import('../src/storage/authoritative-sync-store.js'),
      import('../src/storage/import-semantic-store.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-fast-md-test',
      force: true
    });

    const firstTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      importExecutionMode: 'dag',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 1,
      files: [
        {
          name: 'fast-md-upload-one.md',
          contentBase64: Buffer.from('# Fast MD Upload One\n\n## Abstract\n\nThe first fast-md upload should enter the graph without LLM.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const secondTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      importExecutionMode: 'dag',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 1,
      files: [
        {
          name: 'fast-md-upload-two.md',
          contentBase64: Buffer.from('# Fast MD Upload Two\n\n## Abstract\n\nThe second fast-md upload should enter the graph without LLM.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'llm-primary',
      batchEnabled: true,
      batchInitialTasks: 2,
      batchMaxTasks: 4,
      batchCoalesceMs: 60000,
      batchCoalescePollMs: 1000,
      importExecutionMode: 'dag',
      fastMdMaterializeConcurrency: 4
    });

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.equal(result.batchCoalescing, undefined);
    assert.deepEqual(result.completedTaskIds, [firstTask.id, secondTask.id]);

    const loadedFirstTask = await importStore.loadImportTask(indexRoot, firstTask.id);
    const loadedSecondTask = await importStore.loadImportTask(indexRoot, secondTask.id);
    assert.equal(loadedFirstTask.status, 'completed');
    assert.equal(loadedSecondTask.status, 'completed');
    assert.equal(loadedFirstTask.processingProfile, 'fast-md-background-semantic');
    assert.equal(loadedFirstTask.completionPolicy, 'graph-visible');
    assert.equal(loadedFirstTask.importExecutionMode, 'dag');
    assert.equal(loadedFirstTask.llmContextWindowTokens, 1_000_000);
    assert.equal(loadedFirstTask.llmExtractionStrategy, 'long-context-first');
    assert.equal(loadedFirstTask.graphVisibilityStatus, 'completed');
    assert.equal(loadedFirstTask.semanticStatus, 'queued');
    assert.equal(loadedFirstTask.result.semanticStatus, 'queued');
    assert.equal(loadedFirstTask.result.semanticEnrichment.status, 'queued');
    assert.equal(loadedFirstTask.result.semanticEnrichment.jobIds.length, 1);
    assert.equal(loadedFirstTask.result.optimized.skipped, true);
    assert.equal(loadedFirstTask.result.optimized.reason, 'fast-md-structural-path');
    assert.equal(loadedFirstTask.result.materialized.batchMaterialized, true);
    assert.equal(loadedFirstTask.result.materialized.materializeInputCount, 2);
    assert.equal(loadedFirstTask.result.materialized.materializeConcurrency, 2);
    assert.equal(loadedFirstTask.result.materialized.analyzeConcurrency, 2);
    assert.equal(loadedFirstTask.result.materialized.metadataConcurrency, 2);
    assert.equal(loadedFirstTask.result.fastCommitted.directDeltaCommit, true);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.llmOptimizeSkipped, true);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.directDeltaCommit, true);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.requestedImportExecutionMode, 'dag');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.importExecutionModeApplied, 'dag');
    assert.equal(
      loadedFirstTask.result.metrics.importPerformance.materialize.contractVersion,
      'import-materialize-performance-v1'
    );
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.mode, 'fast-md-batch');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.batchMaterialized, true);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.inputCount, 2);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.taskCount, 2);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.effectiveConcurrency, 2);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.analyzeConcurrency, 2);
    assert.equal(loadedFirstTask.result.metrics.importPerformance.materialize.metadataConcurrency, 2);
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.materialize.elapsedMs, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.materialize.meanMsPerInput, 'number');
    assert.equal(loadedFirstTask.result.metrics.importPerformance.stageTimingsMs.llmOptimize, 0);
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.loadLite, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.buildDelta, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.prepareDirectDelta, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs.writeDelta, 'number');
    assert.equal(typeof loadedFirstTask.result.metrics.importPerformance.fastCommitPhasesMs['write.applyLiteDelta'], 'number');
    assert.equal(
      loadedFirstTask.result.authoritativeSync.jobId,
      loadedSecondTask.result.authoritativeSync.jobId
    );
    const firstDag = await importStore.loadImportTaskDag(indexRoot, firstTask.id);
    assert.equal(firstDag.executionMode, 'dag');
    assert.equal(firstDag.importExecutionMode, 'dag');
    assert.equal(firstDag.nodes['source.materialize'].status, 'completed');
    assert.equal(firstDag.nodes['chunk.normalize'].status, 'completed');
    assert.equal(firstDag.nodes['paper.structural_snapshot'].status, 'completed');
    assert.equal(firstDag.nodes['paper.delta_build'].status, 'completed');
    assert.equal(firstDag.nodes['corpus.merge'].status, 'completed');
    assert.equal(firstDag.nodes['lite_state.update'].status, 'completed');
    assert.equal(firstDag.nodes['authoritative_sync.enqueue'].status, 'completed');
    const firstDagEvents = await importStore.tailImportTaskDagEvents(indexRoot, firstTask.id);
    assert.ok(firstDagEvents.events.some((event) => (
      event.event === 'dag.node.completed'
      && event.nodeId === 'paper.structural_snapshot'
      && event.data?.importExecutionModeApplied === 'dag'
    )));
    assert.ok(firstDagEvents.events.some((event) => (
      event.event === 'dag.node.completed'
      && event.nodeId === 'lite_state.update'
      && event.data?.requestedImportExecutionMode === 'dag'
    )));

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 3);
    assert.equal(corpus.meta.fastDeltaCommit.mode, 'direct-lite-delta');
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Fast MD Upload One'));
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Fast MD Upload Two'));

    const queuedJobs = await authoritativeSyncStore.listAuthoritativeSyncJobs(indexRoot);
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].jobId, loadedFirstTask.result.authoritativeSync.jobId);

    const semanticJobs = await importSemanticStore.listImportSemanticEnrichmentJobs(indexRoot);
    assert.equal(semanticJobs.summary.pending, 2);
    assert.equal(semanticJobs.jobs.every((job) => job.status === 'pending'), true);
    assert.equal(semanticJobs.jobs.every((job) => job.llmContextWindowTokens === 1_000_000), true);
    assert.equal(semanticJobs.jobs.every((job) => job.llmExtractionStrategy === 'long-context-first'), true);
    assert.equal(semanticJobs.jobs.every((job) => job.llmLongContextMaxPapersPerCall === 2), true);
    assert.equal(semanticJobs.jobs.every((job) => job.llmBatchConcurrency === 1), true);
    assert.equal(semanticJobs.jobs.every((job) => job.semanticConfigKey.includes('llmContextWindowTokens=1000000')), true);
    assert.deepEqual(
      semanticJobs.jobs.map((job) => job.taskId).sort(),
      [firstTask.id, secondTask.id].sort()
    );

    const firstLog = await importStore.loadImportTaskLog(indexRoot, firstTask.id);
    assert.match(firstLog, /stage materialize batch/i);
    assert.match(firstLog, /stage fast-commit batch/i);
    assert.doesNotMatch(firstLog, /stage llm-optimize batch/i);

    const semanticResult = await importWorker.runImportSemanticEnrichmentQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });
    assert.equal(semanticResult.failedCount, 0);
    assert.equal(semanticResult.completedJobIds.length, 2);

    const firstSemanticJobId = loadedFirstTask.result.semanticEnrichment.jobIds[0];
    const completedSemanticJobs = await importSemanticStore.listImportSemanticEnrichmentJobs(indexRoot);
    const completedFirstSemanticJob = completedSemanticJobs.jobs.find((job) => job.id === firstSemanticJobId);
    assert.equal(completedFirstSemanticJob.progress.contractVersion, 'import-semantic-enrichment-progress-v1');
    assert.equal(completedFirstSemanticJob.progress.status, 'completed');
    assert.equal(completedFirstSemanticJob.progress.stage, 'completed');
    assert.equal(completedFirstSemanticJob.progress.currentStep, 'semantic enrichment complete');

    const enrichedFirstTask = await importStore.loadImportTask(indexRoot, firstTask.id);
    const enrichedSecondTask = await importStore.loadImportTask(indexRoot, secondTask.id);
    assert.equal(enrichedFirstTask.semanticStatus, 'completed');
    assert.equal(enrichedSecondTask.semanticStatus, 'completed');
    assert.equal(enrichedFirstTask.result.semanticEnrichment.status, 'completed');
    assert.equal(enrichedFirstTask.result.semanticEnrichment.result.taskId, firstTask.id);
    assert.equal(enrichedFirstTask.throughputMetrics.semanticEnrichmentJobId, loadedFirstTask.result.semanticEnrichment.jobIds[0]);

    const enrichedFirstDag = await importStore.loadImportTaskDag(indexRoot, firstTask.id);
    assert.equal(enrichedFirstDag.importExecutionMode, 'dag');
    assert.equal(enrichedFirstDag.executionMode, 'dag');
    assert.equal(enrichedFirstDag.nodes['paper.long_context_llm'].status, 'completed');
    assert.equal(enrichedFirstDag.nodes['paper.long_context_llm'].attempts >= 1, true);
    const semanticQueuePath = importSemanticStore.getImportSemanticEnrichmentPaths(indexRoot).queuePath;
    assert.ok(enrichedFirstDag.nodes['paper.long_context_llm'].inputArtifacts.some((artifact) => (
      artifact.kind === 'import-semantic-enrichment-job'
      && artifact.id === firstSemanticJobId
      && artifact.path === semanticQueuePath
    )));
    assert.ok(enrichedFirstDag.nodes['paper.long_context_llm'].outputArtifacts.some((artifact) => (
      artifact.kind === 'import-semantic-enrichment-result'
      && artifact.id === firstSemanticJobId
      && artifact.path === semanticQueuePath
    )));
    const enrichedFirstDagEvents = await importStore.tailImportTaskDagEvents(indexRoot, firstTask.id);
    const runningSemanticNodeEvent = enrichedFirstDagEvents.events.find((event) => (
      event.event === 'dag.node.running'
      && event.nodeId === 'paper.long_context_llm'
      && event.data?.semanticEnrichmentJobId === firstSemanticJobId
    ));
    const completedSemanticNodeEvent = enrichedFirstDagEvents.events.find((event) => (
      event.event === 'dag.node.completed'
      && event.nodeId === 'paper.long_context_llm'
      && event.data?.semanticEnrichmentJobId === firstSemanticJobId
    ));
    assert.ok(runningSemanticNodeEvent);
    assert.equal(runningSemanticNodeEvent.data.changedSourceKeyCount, 1);
    assert.equal(runningSemanticNodeEvent.data.semanticJobAttempt >= 1, true);
    assert.ok(completedSemanticNodeEvent);
    assert.equal(completedSemanticNodeEvent.data.semanticEnrichmentStageTimingsMs.llmOptimize >= 0, true);
    assert.ok(completedSemanticNodeEvent.artifactRefs.outputArtifacts.some((artifact) => (
      artifact.kind === 'import-semantic-enrichment-result'
      && artifact.id === firstSemanticJobId
    )));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker keeps successful batch tasks moving when one task fails materialize', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-batch-partial-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-batch-partial-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-batch-partial-test',
      force: true
    });

    const failedTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'missing-batch-upload.md',
          contentBase64: Buffer.from('# Missing Batch Upload\n\n## Abstract\n\nThis upload will disappear before materialize.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const successfulTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'surviving-batch-upload.md',
          contentBase64: Buffer.from('# Surviving Batch Upload\n\n## Abstract\n\nThis upload should still enter the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await fs.rm(failedTask.files[0].storedPath, { force: true });

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only',
      batchEnabled: true,
      batchMaxTasks: 4
    });

    assert.equal(result.processed, true);
    assert.equal(result.failed, true);
    assert.match(result.batchId, /^impbatch:/);
    assert.deepEqual(result.completedTaskIds, [successfulTask.id]);
    assert.deepEqual(result.failedTaskIds, [failedTask.id]);

    const loadedFailedTask = await importStore.loadImportTask(indexRoot, failedTask.id);
    const loadedSuccessfulTask = await importStore.loadImportTask(indexRoot, successfulTask.id);
    assert.equal(loadedFailedTask.status, 'failed');
    assert.equal(loadedSuccessfulTask.status, 'completed');
    assert.equal(loadedSuccessfulTask.result.batch.batchId, result.batchId);

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    assert.equal(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Missing Batch Upload'), false);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Surviving Batch Upload'));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker processes a pre-existing running task alone when batch reserve is enabled', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-running-batch-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-running-batch-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-running-batch-test',
      force: true
    });

    const runningTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'running-batch-upload.md',
          contentBase64: Buffer.from('# Running Batch Upload\n\n## Abstract\n\nThis running task should be processed alone.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const pendingTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'pending-batch-upload.md',
          contentBase64: Buffer.from('# Pending Batch Upload\n\n## Abstract\n\nThis pending task should wait for the next pass.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await importStore.reserveNextImportTask(indexRoot);

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only',
      batchEnabled: true,
      batchMaxTasks: 4
    });

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.equal(result.batchId, null);
    assert.deepEqual(result.completedTaskIds, [runningTask.id]);

    const loadedRunningTask = await importStore.loadImportTask(indexRoot, runningTask.id);
    const loadedPendingTask = await importStore.loadImportTask(indexRoot, pendingTask.id);
    assert.equal(loadedRunningTask.status, 'completed');
    assert.equal(loadedPendingTask.status, 'pending');

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Running Batch Upload'));
    assert.equal(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Pending Batch Upload'), false);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker pre-parses the next queued PDF without pulling it into the graph early', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-preparse-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-preparse-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const fakeDoclingPath = path.join(workspaceRoot, 'fake-docling.sh');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.writeFile(fakeDoclingPath, `#!/bin/sh
input="$1"
shift
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
base=$(basename "$input" .pdf)
mkdir -p "$out"
sleep 0.2
printf '# %s\\n\\n## Abstract\\n\\nPrepared by fake docling.\\n' "$base" > "$out/$base.md"
`, { mode: 0o755 });

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker,
      marker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js'),
      import('../src/core/ingestion/pdf-parser.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-preparse-test',
      force: true
    });

    const firstTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'first-queued.pdf',
          contentBase64: Buffer.from('fake pdf one', 'utf8').toString('base64'),
          mimeType: 'application/pdf'
        }
      ]
    });
    const secondTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'second-queued.pdf',
          contentBase64: Buffer.from('fake pdf two', 'utf8').toString('base64'),
          mimeType: 'application/pdf'
        }
      ]
    });

    const { markdownDir, markerDir } = corpusStore.getCorpusPaths(indexRoot);
    const secondCachePath = marker.getPdfMarkdownCachePath(secondTask.files[0].storedPath, {
      markerDir,
      markdownDir,
      pdfParser: 'docling'
    });

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only',
      pdfParser: 'docling',
      doclingCommand: fakeDoclingPath
    });

    assert.equal(result.processed, true);
    assert.equal(result.taskId, firstTask.id);

    const preparsed = await waitFor(async () => {
      try {
        await fs.access(secondCachePath);
        return true;
      } catch {
        return false;
      }
    });

    assert.equal(preparsed, true);

    const loadedFirstTask = await importStore.loadImportTask(indexRoot, firstTask.id);
    const loadedSecondTask = await importStore.loadImportTask(indexRoot, secondTask.id);
    assert.equal(loadedFirstTask.status, 'completed');
    assert.equal(loadedSecondTask.status, 'pending');

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    assert.equal(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'second-queued'), false);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker automatically requeues and processes recoverable failed imports', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-recover-failed-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-recover-failed-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-recover-failed-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'recoverable-upload.md',
          contentBase64: Buffer.from('# Recoverable Upload\n\n## Abstract\n\nThe worker should retry this failed task.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    await importStore.failImportTask(indexRoot, task.id, new Error('transient failure'));

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only',
      importFailedRetryDelayMs: 0,
      importFailedRetryMax: 3
    });

    assert.equal(result.processed, true);
    assert.equal(result.taskId, task.id);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'completed');
    assert.equal(loadedTask.recovery.retryCount, 1);

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Recoverable Upload'));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker resumes from the persisted task stage instead of restarting materialize', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-resume-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-resume-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-resume-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'resume-paper.md',
          contentBase64: Buffer.from('# Resume Paper\n\n## Abstract\n\nThis upload should resume from stage 2.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const taskPaths = importStore.getImportTaskPaths(indexRoot, task.id);
    const persistedTask = JSON.parse(await fs.readFile(taskPaths.taskPath, 'utf8'));
    persistedTask.status = 'running';
    persistedTask.stage = 'materialize';
    persistedTask.includeInGraph = true;
    await fs.writeFile(taskPaths.taskPath, JSON.stringify(persistedTask, null, 2));

    await ingestion.materializeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-resume-test',
      semanticExtraction: 'heuristic-only'
    });

    persistedTask.status = 'running';
    persistedTask.stage = 'llm-optimize';
    persistedTask.includeInGraph = true;
    await fs.writeFile(taskPaths.taskPath, JSON.stringify(persistedTask, null, 2));

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    assert.equal(result.completedTaskIds.includes(task.id), true);

    const log = await importStore.loadImportTaskLog(indexRoot, task.id);
    assert.match(log, /stage llm-optimize/i);
    assert.doesNotMatch(log, /stage materialize/i);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker clears a stale worker lock and continues processing the queue', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-stale-lock-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-stale-lock-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-stale-lock-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'stale-lock-paper.md',
          contentBase64: Buffer.from('# Stale Lock Paper\n\n## Abstract\n\nThis upload should recover after a stale worker lock.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const workerLockPath = importStore.getImportPaths(indexRoot).workerLockPath;
    await fs.mkdir(workerLockPath, { recursive: true });
    await fs.writeFile(path.join(workerLockPath, 'owner.json'), JSON.stringify({
      pid: 12345,
      acquiredAt: new Date(Date.now() - 60_000).toISOString()
    }, null, 2));
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(workerLockPath, staleTime, staleTime);

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4,
      lockTimeoutMs: 20_000,
      lockStaleMs: 20_000
    });

    assert.equal(result.completedTaskIds.includes(task.id), true);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'completed');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker leaves a non-stale busy worker lock in place after timeout', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-busy-lock-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-busy-lock-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-busy-lock-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'busy-lock-paper.md',
          contentBase64: Buffer.from('# Busy Lock Paper\n\n## Abstract\n\nThis upload should wait while another worker still owns the lock.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const workerLockPath = importStore.getImportPaths(indexRoot).workerLockPath;
    await fs.mkdir(workerLockPath, { recursive: true });
    await fs.writeFile(path.join(workerLockPath, 'owner.json'), JSON.stringify({
      pid: 12345,
      acquiredAt: new Date().toISOString()
    }, null, 2));

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4,
      lockTimeoutMs: 250,
      lockStaleMs: 60_000
    });

    assert.deepEqual(result.completedTaskIds, []);
    assert.equal(result.failedCount, 0);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'pending');
    await assert.doesNotReject(fs.access(workerLockPath));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker quarantines stale pending tasks before processing newer queue entries', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-quarantine-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-quarantine-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-quarantine-test',
      force: true
    });

    const staleTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'stale-queued-paper.md',
          contentBase64: Buffer.from('# Stale Pending Paper\n\n## Abstract\n\nThis task should be quarantined.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const freshTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'fresh-paper.md',
          contentBase64: Buffer.from('# Fresh Paper\n\n## Abstract\n\nThis task should still be processed.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const staleTimestamp = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000)).toISOString();
    const { queuePath, quarantineDir } = importStore.getImportPaths(indexRoot);
    const stalePaths = importStore.getImportTaskPaths(indexRoot, staleTask.id);
    const staleTaskPayload = JSON.parse(await fs.readFile(stalePaths.taskPath, 'utf8'));
    staleTaskPayload.createdAt = staleTimestamp;
    staleTaskPayload.updatedAt = staleTimestamp;
    staleTaskPayload.progress.createdAt = staleTimestamp;
    staleTaskPayload.progress.lastEventAt = staleTimestamp;
    await fs.writeFile(stalePaths.taskPath, `${JSON.stringify(staleTaskPayload, null, 2)}\n`);

    const queuePayload = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    queuePayload.updatedAt = staleTimestamp;
    queuePayload.jobs = queuePayload.jobs.map((job) => (
      job.id === staleTask.id
        ? { ...job, createdAt: staleTimestamp, updatedAt: staleTimestamp }
        : job
    ));
    await fs.writeFile(queuePath, `${JSON.stringify(queuePayload, null, 2)}\n`);

    const result = await importWorker.runImportQueueOnce(indexRoot, {
      semanticExtraction: 'heuristic-only'
    });

    assert.equal(result.processed, true);
    assert.equal(result.taskId, freshTask.id);

    const listed = await importStore.listImportTasks(indexRoot);
    assert.equal(listed.tasks.some((task) => task.id === staleTask.id), false);
    assert.equal(listed.tasks.some((task) => task.id === freshTask.id), true);

    const quarantineBatches = await fs.readdir(quarantineDir);
    assert.equal(quarantineBatches.length >= 1, true);
    const summaryPath = path.join(quarantineDir, quarantineBatches[0], 'summary.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
    assert.equal(summary.reason, 'stale-pending-timeout');
    assert.equal(summary.tasks.some((entry) => entry.taskId === staleTask.id), true);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import worker fails tasks whose uploaded files never enter the source manifest', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-missing-source-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-missing-source-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-missing-source-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'missing-upload.md',
          contentBase64: Buffer.from('# Missing Upload\n\n## Abstract\n\nThis file disappears before materialize.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await fs.rm(task.files[0].storedPath, { force: true });

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    assert.equal(result.failedCount, 1);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'failed');
    assert.match(
      loadedTask.error?.message || '',
      /not materialized into the source manifest/i
    );

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 1);
    assert.equal(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Missing Upload'), false);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('completed import sources are preserved without remaining active import directories', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-preserve-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-preserve-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-preserve-test',
      force: true
    });

    const firstTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'first-upload.md',
          contentBase64: Buffer.from('# First Upload\n\n## Abstract\n\nKeep me in the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    assert.deepEqual(await importStore.listActiveImportSourceDirs(indexRoot), []);

    const secondTask = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'second-upload.md',
          contentBase64: Buffer.from('# Second Upload\n\n## Abstract\n\nAlso keep me in the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 3);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'First Upload'));
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === 'Second Upload'));
    assert.notEqual(secondTask.id, firstTask.id);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
