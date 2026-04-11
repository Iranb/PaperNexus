import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('createImportTask stores uploaded files, queue state, and append-only logs', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-'));

  try {
    const {
      appendImportTaskLog,
      completeImportTask,
      createImportTask,
      listActiveImportSourceDirs,
      listImportTasks,
      loadImportTask,
      loadImportTaskLog,
      reserveNextImportTask
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'sample-paper.md',
          contentBase64: Buffer.from('# Sample Paper\n\n## Abstract\n\nA short upload test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.equal(task.status, 'pending');
    assert.equal(task.files.length, 1);
    assert.equal(task.progress.contractVersion, 'import-progress-v1');
    assert.equal(task.progress.stage, 'queued');
    assert.equal(task.progress.percent, 0);
    await fs.access(task.files[0].storedPath);

    await appendImportTaskLog(rootPath, task.id, {
      level: 'info',
      message: 'queued for processing'
    });

    const loaded = await loadImportTask(rootPath, task.id);
    assert.equal(loaded.id, task.id);
    assert.equal(loaded.trigger, 'api');

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, task.id);
    assert.equal(listed.summary.total, 1);
    assert.equal(listed.summary.pending, 1);
    assert.equal(listed.summary.overallPercent, 0);

    const beforeReserve = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(beforeReserve, []);

    const reserved = await reserveNextImportTask(rootPath);
    assert.equal(reserved.task.id, task.id);
    assert.equal(reserved.task.progress.stage, 'materialize');
    assert.equal(reserved.task.progress.stageIndex, 1);
    assert.equal(reserved.task.progress.percent, 0);

    const afterReserve = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(afterReserve, [task.sourcesDir]);

    await completeImportTask(rootPath, task.id, {
      ok: true
    });

    const completed = await loadImportTask(rootPath, task.id);
    assert.equal(completed.progress.stage, 'completed');
    assert.equal(completed.progress.percent, 100);
    assert.equal(completed.progress.stagePercent, 100);

    const afterComplete = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(afterComplete, []);

    const log = await loadImportTaskLog(rootPath, task.id);
    assert.match(log, /queued for processing/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('createImportTask ignores uploaded metadata files and keeps only real paper files', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-meta-'));

  try {
    const { createImportTask } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: '.DS_Store',
          contentBase64: Buffer.from('ignored metadata', 'utf8').toString('base64'),
          mimeType: 'application/octet-stream'
        },
        {
          name: '._sample-paper.md',
          contentBase64: Buffer.from('ignored apple double', 'utf8').toString('base64'),
          mimeType: 'application/octet-stream'
        },
        {
          name: 'sample-paper.md',
          contentBase64: Buffer.from('# Sample Paper\n\n## Abstract\n\nA short upload test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.equal(task.files.length, 1);
    assert.equal(task.files[0].originalName, 'sample-paper.md');
    await fs.access(task.files[0].storedPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('createImportTask reuses an existing task for identical uploaded content', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-dedupe-'));

  try {
    const { createImportTask, listImportTasks } = await import('../src/storage/import-store.js');
    const contentBase64 = Buffer.from('# Same Paper\n\n## Abstract\n\nSame bytes.\n', 'utf8').toString('base64');

    const firstTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'paper-a.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });

    const secondTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'paper-b.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.equal(firstTask.deduped, false);
    assert.equal(secondTask.id, firstTask.id);
    assert.equal(secondTask.deduped, true);

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks.length, 1);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('failed import tasks are not reused for identical uploaded content', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-failed-dedupe-'));

  try {
    const { createImportTask, failImportTask } = await import('../src/storage/import-store.js');
    const contentBase64 = Buffer.from('# Retry Paper\n\n## Abstract\n\nRetry after failure.\n', 'utf8').toString('base64');

    const firstTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'retry-paper.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });

    await failImportTask(rootPath, firstTask.id, new Error('expected failure'));

    const secondTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'retry-paper-copy.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.notEqual(secondTask.id, firstTask.id);
    assert.equal(secondTask.deduped, false);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('quarantineImportTasks removes stale pending tasks from the active queue and preserves a quarantine snapshot', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-quarantine-'));

  try {
    const {
      createImportTask,
      loadImportTask,
      loadImportTaskLog,
      listImportTasks,
      quarantineImportTasks
    } = await import('../src/storage/import-store.js');
    const contentBase64 = Buffer.from('# Quarantine Paper\n\n## Abstract\n\nQueue cleanup test.\n', 'utf8').toString('base64');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'quarantine-paper.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });

    const quarantined = await quarantineImportTasks(rootPath, [task.id], {
      reason: 'stale-pending-timeout',
      message: 'Task was quarantined because it remained pending too long.'
    });

    assert.equal(quarantined.count, 1);
    assert.equal(quarantined.tasks[0].taskId, task.id);
    await fs.access(path.join(quarantined.batchDir, 'summary.json'));
    await fs.access(path.join(quarantined.tasks[0].taskDir, 'task.json'));
    await fs.access(path.join(quarantined.tasks[0].taskDir, 'quarantine.json'));

    const quarantinedTask = await loadImportTask(rootPath, task.id);
    assert.equal(quarantinedTask.status, 'failed');
    assert.equal(quarantinedTask.quarantine.reason, 'stale-pending-timeout');
    const quarantinedLog = await loadImportTaskLog(rootPath, task.id);
    assert.match(quarantinedLog, /quarantined from the active queue/i);

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks.length, 0);

    const recreated = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'quarantine-paper.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });
    assert.notEqual(recreated.id, task.id);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('recoverFailedImportTasks requeues recoverable failed tasks whose uploaded files still exist', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-retry-failed-'));

  try {
    const {
      createImportTask,
      failImportTask,
      listImportTasks,
      loadImportTask,
      loadImportTaskLog,
      recoverFailedImportTasks
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'retry-failed-paper.md',
          contentBase64: Buffer.from('# Retry Failed Paper\n\n## Abstract\n\nRetry me.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    await failImportTask(rootPath, task.id, new Error('transient commit conflict'));

    const recovered = await recoverFailedImportTasks(rootPath, {
      importFailedRetryDelayMs: 0,
      importFailedRetryMax: 3
    });

    assert.deepEqual(recovered.recovered.map((entry) => entry.taskId), [task.id]);
    assert.deepEqual(recovered.superseded, []);
    const loaded = await loadImportTask(rootPath, task.id);
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.stage, 'queued');
    assert.equal(loaded.error, null);
    assert.equal(loaded.recovery.retryCount, 1);
    assert.match(loaded.progress.message, /Recovered failed import for retry 1\/3/);

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.summary.pending, 1);
    assert.equal(listed.summary.failed, 0);
    const log = await loadImportTaskLog(rootPath, task.id);
    assert.match(log, /recovered failed import for retry 1\/3/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('recoverFailedImportTasks marks historical failures completed when an equivalent task already succeeded', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-supersede-failed-'));

  try {
    const {
      completeImportTask,
      createImportTask,
      failImportTask,
      listImportTasks,
      loadImportTask,
      recoverFailedImportTasks
    } = await import('../src/storage/import-store.js');
    const contentBase64 = Buffer.from('# Superseded Paper\n\n## Abstract\n\nRecovered by a later retry.\n', 'utf8').toString('base64');

    const failedTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'superseded-paper.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });
    await failImportTask(rootPath, failedTask.id, new Error('old transient failure'));

    const completedTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'superseded-paper-copy.md',
          contentBase64,
          mimeType: 'text/markdown'
        }
      ]
    });
    await completeImportTask(rootPath, completedTask.id, {
      ok: true
    });

    const recovered = await recoverFailedImportTasks(rootPath, {
      importFailedRetryDelayMs: 0
    });

    assert.deepEqual(recovered.recovered, []);
    assert.equal(recovered.superseded.length, 1);
    assert.equal(recovered.superseded[0].taskId, failedTask.id);
    assert.deepEqual(recovered.superseded[0].supersededByTaskIds, [completedTask.id]);

    const loaded = await loadImportTask(rootPath, failedTask.id);
    assert.equal(loaded.status, 'completed');
    assert.equal(loaded.stage, 'completed');
    assert.equal(loaded.error, null);
    assert.equal(loaded.result.recovered.status, 'superseded');
    assert.deepEqual(loaded.result.recovered.supersededByTaskIds, [completedTask.id]);

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.summary.completed, 2);
    assert.equal(listed.summary.failed, 0);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('listImportTasks reconciles stale queue.json statuses back to the task.json source of truth', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-reconcile-'));

  try {
    const {
      createImportTask,
      getImportPaths,
      listImportTasks
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'reconcile-paper.md',
          contentBase64: Buffer.from('# Reconcile Paper\n\n## Abstract\n\nQueue repair test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const { queuePath } = getImportPaths(rootPath);
    const queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    queue.jobs = queue.jobs.map((job) => (
      job.id === task.id
        ? {
            ...job,
            status: 'failed',
            stage: 'materialize',
            progress: {
              ...(job.progress || {}),
              status: 'failed',
              stage: 'materialize',
              message: 'corrupted queue snapshot'
            }
          }
        : job
    ));
    await fs.writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].status, 'pending');
    assert.equal(listed.tasks[0].stage, 'queued');

    const repairedQueue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    const repairedJob = repairedQueue.jobs.find((job) => job.id === task.id);
    assert.equal(repairedJob.status, 'pending');
    assert.equal(repairedJob.stage, 'queued');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
