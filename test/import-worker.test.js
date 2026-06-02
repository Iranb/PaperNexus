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
  } finally {
    batching?.resetProgressiveImportBatchTarget(rootPath);
    batching?.resetProgressiveImportBatchTarget(cappedRootPath);
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
