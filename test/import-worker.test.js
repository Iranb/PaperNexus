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
      import('../src/core/ingestion/marker.js')
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
