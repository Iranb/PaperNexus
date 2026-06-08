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
      loadImportTaskDag,
      loadImportTask,
      loadImportTaskLog,
      reserveNextImportTask,
      tailImportTaskDagEvents,
      tailImportTaskEvents
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
    assert.equal(task.processingProfile, 'full');
    assert.equal(task.completionPolicy, 'full');
    assert.equal(task.importExecutionMode, 'serial');
    assert.equal(task.importExecutionModeSource, 'default');
    assert.equal(task.graphVisibilityStatus, 'pending');
    assert.equal(task.semanticStatus, 'pending');
    assert.equal(task.authoritativeSyncStatus, 'not-started');
    await fs.access(task.files[0].storedPath);

    const initialDag = await loadImportTaskDag(rootPath, task.id);
    assert.equal(initialDag.contractVersion, 'import-dag-v1');
    assert.equal(initialDag.executionMode, 'serial-sidecar');
    assert.equal(initialDag.importExecutionMode, 'serial');
    assert.ok(initialDag.nodeOrder.includes('paper.long_context_llm'));
    assert.ok(initialDag.nodeOrder.includes('lite_state.update'));
    assert.equal(initialDag.nodes['task.queued'].status, 'pending');
    assert.equal(initialDag.nodes['source.materialize'].status, 'not-started');
    assert.match(initialDag.nodes['source.materialize'].idempotencyKey, /^import-dag-node:/);
    assert.equal(initialDag.nodes['source.materialize'].idempotencyParts.processingProfile, 'full');
    assert.equal(initialDag.nodes['source.materialize'].retryOwner, 'import-worker');
    assert.equal(initialDag.nodes['source.materialize'].retryPolicy.idempotent, true);
    assert.ok(initialDag.nodes['source.materialize'].inputArtifacts.some((artifact) => (
      artifact.kind === 'stored-source'
      && artifact.path === task.files[0].storedPath
      && artifact.contentSha256 === task.files[0].contentSha256
    )));

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

    const reservedDag = await loadImportTaskDag(rootPath, task.id);
    assert.equal(reservedDag.nodes['task.queued'].status, 'completed');
    assert.equal(reservedDag.nodes['source.materialize'].status, 'running');
    assert.equal(reservedDag.nodes['source.materialize'].attempts, 1);

    const afterReserve = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(afterReserve, [task.sourcesDir]);

    await completeImportTask(rootPath, task.id, {
      ok: true
    });

    const completed = await loadImportTask(rootPath, task.id);
    assert.equal(completed.progress.stage, 'completed');
    assert.equal(completed.progress.percent, 100);
    assert.equal(completed.progress.stagePercent, 100);
    assert.equal(completed.graphVisibilityStatus, 'completed');
    assert.equal(completed.semanticStatus, 'completed');
    assert.ok(completed.structuralCompletedAt);
    assert.ok(completed.semanticCompletedAt);

    const afterComplete = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(afterComplete, []);

    const log = await loadImportTaskLog(rootPath, task.id);
    assert.match(log, /queued for processing/);

    const eventLedger = await tailImportTaskEvents(rootPath, task.id);
    assert.equal(eventLedger.contractVersion, 'import-event-v1');
    assert.equal(eventLedger.events.every((event) => Number.isInteger(event.seq)), true);
    assert.ok(eventLedger.events.some((event) => event.event === 'task.log' && /created import task/i.test(event.message)));
    assert.ok(eventLedger.events.some((event) => event.event === 'task.log' && /queued for processing/i.test(event.message)));
    assert.ok(eventLedger.events.some((event) => event.event === 'task.completed'));

    const completedDag = await loadImportTaskDag(rootPath, task.id);
    assert.equal(completedDag.status, 'completed');
    assert.equal(completedDag.processingProfile, 'full');
    assert.equal(completedDag.completionPolicy, 'full');
    assert.equal(completedDag.nodes['lite_state.update'].status, 'completed');
    assert.equal(completedDag.nodes['task.completed'].status, 'completed');
    assert.equal(completedDag.nodes['paper.long_context_llm'].status, 'completed');
    assert.equal(completedDag.nodes['paper.long_context_llm'].retryOwner, 'llm-worker-pool');

    const dagEvents = await tailImportTaskDagEvents(rootPath, task.id);
    assert.equal(dagEvents.contractVersion, 'import-dag-event-v1');
    assert.equal(dagEvents.events.every((event) => Number.isInteger(event.seq)), true);
    assert.ok(dagEvents.events.some((event) => event.nodeId === 'source.materialize' && event.status === 'running'));
    assert.ok(dagEvents.events.some((event) => event.event === 'task.completed' && event.nodeId === 'task.completed'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('reserve import tasks can be constrained to explicit task ids', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-reserve-filter-'));

  try {
    const {
      createImportTask,
      reserveImportTaskBatch,
      reserveNextImportTask
    } = await import('../src/storage/import-store.js');

    const first = await createImportTask(rootPath, {
      files: [{
        name: 'first.md',
        mimeType: 'text/markdown',
        contentBase64: Buffer.from('# First\n\nA first queued paper.', 'utf8').toString('base64')
      }]
    });
    const second = await createImportTask(rootPath, {
      files: [{
        name: 'second.md',
        mimeType: 'text/markdown',
        contentBase64: Buffer.from('# Second\n\nA second queued paper.', 'utf8').toString('base64')
      }]
    });

    const reservedSingle = await reserveNextImportTask(rootPath, {
      importReserveTaskIds: [second.id]
    });
    assert.equal(reservedSingle.task.id, second.id);

    const batchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-reserve-filter-batch-'));
    try {
      const batchTasks = [];
      for (let index = 0; index < 3; index += 1) {
        batchTasks.push(await createImportTask(batchRoot, {
          files: [{
            name: `batch-${index + 1}.md`,
            mimeType: 'text/markdown',
            contentBase64: Buffer.from(`# Batch ${index + 1}\n\nA queued paper.`, 'utf8').toString('base64')
          }]
        }));
      }

      const reservedBatch = await reserveImportTaskBatch(batchRoot, {
        maxTasks: 3,
        importReserveTaskIds: [batchTasks[2].id, batchTasks[0].id]
      });
      assert.deepEqual(
        reservedBatch.tasks.map((task) => task.id),
        [batchTasks[0].id, batchTasks[2].id]
      );
      assert.equal(reservedBatch.batchTaskIds.length, 2);
    } finally {
      await fs.rm(batchRoot, { recursive: true, force: true });
    }

    const skipped = await reserveNextImportTask(rootPath, {
      importReserveTaskIds: ['imp:missing']
    });
    assert.equal(skipped, null);
    assert.equal(first.status, 'pending');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('appendImportDagEvent records node artifact references for resumable DAG work', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-dag-artifacts-'));

  try {
    const {
      appendImportDagEvent,
      createImportTask,
      loadImportTaskDag,
      tailImportTaskDagEvents
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      processingProfile: 'long-context-full-md',
      files: [
        {
          name: 'dag-artifact-paper.md',
          contentBase64: Buffer.from('# DAG Artifact Paper\n\n## Abstract\n\nAn artifact reference projection test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const semanticArtifactPath = path.join(rootPath, '.papernexus', 'llm-jobs', 'long-context-artifacts', 'semantic.json');

    await appendImportDagEvent(rootPath, task.id, {
      event: 'dag.node.completed',
      nodeId: 'paper.long_context_llm',
      status: 'completed',
      inputArtifacts: [
        {
          kind: 'semantic-snapshot',
          path: task.files[0].storedPath,
          contentSha256: task.files[0].contentSha256
        }
      ],
      outputArtifacts: [
        {
          kind: 'long-context-artifact',
          id: 'semantic-artifact',
          path: semanticArtifactPath
        }
      ],
      message: 'long-context semantic artifact persisted'
    });

    const dag = await loadImportTaskDag(rootPath, task.id);
    const node = dag.nodes['paper.long_context_llm'];
    assert.equal(node.status, 'completed');
    assert.match(node.idempotencyKey, /^import-dag-node:/);
    assert.equal(node.idempotencyParts.processingProfile, 'long-context-full-md');
    assert.equal(node.retryOwner, 'llm-worker-pool');
    assert.ok(node.inputArtifacts.some((artifact) => artifact.kind === 'semantic-snapshot' && artifact.path === task.files[0].storedPath));
    assert.ok(node.outputArtifacts.some((artifact) => artifact.kind === 'long-context-artifact' && artifact.path === semanticArtifactPath));

    const dagEvents = await tailImportTaskDagEvents(rootPath, task.id);
    const artifactEvent = dagEvents.events.find((event) => event.event === 'dag.node.completed');
    assert.ok(artifactEvent);
    assert.equal(artifactEvent.nodeId, 'paper.long_context_llm');
    assert.ok(artifactEvent.artifactRefs.outputArtifacts.some((artifact) => artifact.path === semanticArtifactPath));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('listImportTasks reaps stale import queue locks', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-stale-lock-'));

  try {
    const {
      createImportQueueLockOptions,
      getImportPaths,
      listImportTasks
    } = await import('../src/storage/import-store.js');
    const { queueLockPath } = getImportPaths(rootPath);

    const lockOptions = createImportQueueLockOptions({
      importQueueLockTimeoutMs: 1000,
      importQueueLockStaleMs: 1000,
      importQueueLockHeartbeatIntervalMs: 250
    });
    assert.equal(lockOptions.timeoutMs, 1000);
    assert.equal(lockOptions.staleMs, 1000);
    assert.equal(lockOptions.heartbeatIntervalMs, 250);

    await fs.mkdir(queueLockPath, { recursive: true });
    await fs.writeFile(path.join(queueLockPath, 'owner.json'), `${JSON.stringify({
      pid: 99999999,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString()
    })}\n`, 'utf8');
    const staleDate = new Date(Date.now() - 60_000);
    await fs.utimes(queueLockPath, staleDate, staleDate);

    const listed = await listImportTasks(rootPath, {
      importQueueLockTimeoutMs: 1000,
      importQueueLockStaleMs: 1000,
      importQueueLockHeartbeatIntervalMs: 250
    });
    assert.equal(listed.summary.total, 0);
    await assert.rejects(fs.access(queueLockPath), /ENOENT/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('failImportTask records failed DAG node state', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-dag-fail-'));

  try {
    const {
      createImportTask,
      failImportTask,
      loadImportTaskDag,
      markImportTaskStage,
      tailImportTaskDagEvents
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'dag-failure-paper.md',
          contentBase64: Buffer.from('# DAG Failure Paper\n\n## Abstract\n\nA failure projection test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await markImportTaskStage(rootPath, task.id, 'llm-optimize', 'running long-context semantic extraction');
    await failImportTask(rootPath, task.id, new Error('provider timeout'));

    const failedDag = await loadImportTaskDag(rootPath, task.id);
    assert.equal(failedDag.status, 'failed');
    assert.equal(failedDag.nodes['paper.long_context_llm'].status, 'failed');
    assert.equal(failedDag.nodes['paper.long_context_llm'].error.message, 'provider timeout');
    assert.equal(failedDag.nodes['paper.structural_snapshot'].status, 'completed');

    const dagEvents = await tailImportTaskDagEvents(rootPath, task.id);
    assert.ok(dagEvents.events.some((event) => event.event === 'task.failed' && event.nodeId === 'paper.long_context_llm'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('createImportTask persists processing profile and completion policy', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-profile-'));

  try {
    const {
      completeImportTask,
      createImportTask,
      listImportTasks,
      loadImportTaskDag,
      loadImportTask
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      importExecutionMode: 'dag',
      files: [
        {
          name: 'profile-paper.md',
          contentBase64: Buffer.from('# Profile Paper\n\n## Abstract\n\nA fast-md profile test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.equal(task.processingProfile, 'fast-md-background-semantic');
    assert.equal(task.completionPolicy, 'graph-visible');
    assert.equal(task.importExecutionMode, 'dag');
    assert.equal(task.importExecutionModeSource, 'request');
    assert.equal(task.graphVisibilityStatus, 'pending');
    assert.equal(task.semanticStatus, 'pending');
    assert.equal(task.authoritativeSyncStatus, 'not-started');

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks[0].processingProfile, 'fast-md-background-semantic');
    assert.equal(listed.tasks[0].completionPolicy, 'graph-visible');
    assert.equal(listed.tasks[0].importExecutionMode, 'dag');

    await completeImportTask(rootPath, task.id, {
      graphVisibilityStatus: 'completed',
      semanticStatus: 'queued',
      authoritativeSync: {
        status: 'pending',
        jobId: 'sync:profile-test'
      },
      throughputMetrics: {
        graphVisibleLatencyMs: 1234
      }
    });

    const completed = await loadImportTask(rootPath, task.id);
    assert.equal(completed.processingProfile, 'fast-md-background-semantic');
    assert.equal(completed.completionPolicy, 'graph-visible');
    assert.equal(completed.importExecutionMode, 'dag');
    assert.equal(completed.graphVisibilityStatus, 'completed');
    assert.equal(completed.semanticStatus, 'queued');
    assert.equal(completed.authoritativeSyncStatus, 'pending');
    assert.equal(completed.throughputMetrics.graphVisibleLatencyMs, 1234);
    assert.ok(completed.structuralCompletedAt);
    assert.equal(completed.semanticCompletedAt, null);

    const completedDag = await loadImportTaskDag(rootPath, task.id);
    assert.equal(completedDag.executionMode, 'dag');
    assert.equal(completedDag.importExecutionMode, 'dag');
    assert.equal(completedDag.nodes['lite_state.update'].status, 'completed');
    assert.equal(completedDag.nodes['paper.long_context_llm'].status, 'pending');
    assert.equal(completedDag.nodes['authoritative_sync.enqueue'].status, 'completed');
    assert.equal(completedDag.nodes['authoritative_sync.apply'].status, 'pending');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('reserveImportTaskBatch reserves oldest pending tasks as one running batch', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-batch-'));

  try {
    const {
      createImportTask,
      listActiveImportSourceDirs,
      listImportTasks,
      loadImportTask,
      loadImportTaskLog,
      reserveImportTaskBatch
    } = await import('../src/storage/import-store.js');

    const firstTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'batch-one.md',
          contentBase64: Buffer.from('# Batch One\n\n## Abstract\n\nFirst queued paper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const secondTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'batch-two.md',
          contentBase64: Buffer.from('# Batch Two\n\n## Abstract\n\nSecond queued paper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const thirdTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'batch-three.md',
          contentBase64: Buffer.from('# Batch Three\n\n## Abstract\n\nThird queued paper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const reserved = await reserveImportTaskBatch(rootPath, {
      maxTasks: 2
    });

    assert.match(reserved.batchId, /^impbatch:/);
    assert.equal(reserved.singleTask, false);
    assert.deepEqual(reserved.batchTaskIds, [firstTask.id, secondTask.id]);
    assert.deepEqual(reserved.tasks.map((task) => task.id), [firstTask.id, secondTask.id]);

    const loadedFirst = await loadImportTask(rootPath, firstTask.id);
    const loadedSecond = await loadImportTask(rootPath, secondTask.id);
    const loadedThird = await loadImportTask(rootPath, thirdTask.id);
    assert.equal(loadedFirst.status, 'running');
    assert.equal(loadedSecond.status, 'running');
    assert.equal(loadedFirst.stage, 'materialize');
    assert.equal(loadedSecond.stage, 'materialize');
    assert.equal(loadedFirst.progress.message.includes(reserved.batchId), true);
    assert.equal(loadedThird.status, 'pending');

    const activeDirs = new Set(await listActiveImportSourceDirs(rootPath));
    assert.deepEqual(activeDirs, new Set([firstTask.sourcesDir, secondTask.sourcesDir]));

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.summary.running, 2);
    assert.equal(listed.summary.pending, 1);

    const firstLog = await loadImportTaskLog(rootPath, firstTask.id);
    const secondLog = await loadImportTaskLog(rootPath, secondTask.id);
    assert.match(firstLog, new RegExp(reserved.batchId));
    assert.match(secondLog, new RegExp(reserved.batchId));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('reserveImportTaskBatch batches all pending tasks when the queue is smaller than the target size', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-underfilled-batch-'));

  try {
    const {
      createImportTask,
      listImportTasks,
      reserveImportTaskBatch
    } = await import('../src/storage/import-store.js');

    const tasks = [];
    for (const name of ['underfilled-one.md', 'underfilled-two.md', 'underfilled-three.md']) {
      tasks.push(await createImportTask(rootPath, {
        trigger: 'api',
        files: [
          {
            name,
            contentBase64: Buffer.from(`# ${name}\n\n## Abstract\n\nQueued below the batch target.\n`, 'utf8').toString('base64'),
            mimeType: 'text/markdown'
          }
        ]
      }));
    }

    const reserved = await reserveImportTaskBatch(rootPath, {
      maxTasks: 8
    });

    assert.match(reserved.batchId, /^impbatch:/);
    assert.equal(reserved.singleTask, false);
    assert.deepEqual(reserved.batchTaskIds, tasks.map((task) => task.id));
    assert.deepEqual(reserved.tasks.map((task) => task.id), tasks.map((task) => task.id));

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.summary.pending, 0);
    assert.equal(listed.summary.running, 3);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('reserveImportTaskBatch respects expansion limits and resumes running tasks alone', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-batch-limits-'));

  try {
    const {
      createImportTask,
      loadImportTask,
      reserveImportTaskBatch
    } = await import('../src/storage/import-store.js');

    const firstTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'limit-one.md',
          contentBase64: Buffer.from('# Limit One\n\n## Abstract\n\nSmall first paper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const secondTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'limit-two-a.md',
          contentBase64: Buffer.from('# Limit Two A\n\n## Abstract\n\nLarger paper A.\n'.repeat(4), 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        },
        {
          name: 'limit-two-b.md',
          contentBase64: Buffer.from('# Limit Two B\n\n## Abstract\n\nLarger paper B.\n'.repeat(4), 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const thirdTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'limit-three.md',
          contentBase64: Buffer.from('# Limit Three\n\n## Abstract\n\nSmall third paper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const limited = await reserveImportTaskBatch(rootPath, {
      maxTasks: 3,
      maxFiles: 2,
      maxBytes: firstTask.files[0].sizeBytes + 1
    });

    assert.equal(limited.batchId, null);
    assert.equal(limited.singleTask, true);
    assert.deepEqual(limited.batchTaskIds, [firstTask.id]);
    assert.equal((await loadImportTask(rootPath, firstTask.id)).status, 'running');
    assert.equal((await loadImportTask(rootPath, secondTask.id)).status, 'pending');
    assert.equal((await loadImportTask(rootPath, thirdTask.id)).status, 'pending');

    const runningOnly = await reserveImportTaskBatch(rootPath, {
      maxTasks: 3
    });

    assert.equal(runningOnly.singleTask, true);
    assert.deepEqual(runningOnly.batchTaskIds, [firstTask.id]);
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

test('createImportTask stores per-file paper identifiers and merges them on deduped uploads', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-identifiers-'));

  try {
    const { createImportTask, loadImportTask } = await import('../src/storage/import-store.js');
    const contentBase64 = Buffer.from('# Identifier Paper\n\n## Abstract\n\nIdentifier metadata test.\n', 'utf8').toString('base64');

    const firstTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'identifier-paper.md',
          contentBase64,
          mimeType: 'text/markdown',
          identifiers: {
            doi: '10.48550/papernexus.identifier-paper'
          }
        }
      ]
    });
    assert.equal(firstTask.files[0].paperMetadata.identifiers.doi, '10.48550/papernexus.identifier-paper');

    const dedupedTask = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'identifier-paper-copy.md',
          contentBase64,
          mimeType: 'text/markdown',
          identifiers: {
            arxivId: '2401.12345'
          }
        }
      ]
    });
    assert.equal(dedupedTask.id, firstTask.id);
    assert.equal(dedupedTask.deduped, true);

    const loaded = await loadImportTask(rootPath, firstTask.id);
    assert.equal(loaded.files[0].paperMetadata.identifiers.doi, '10.48550/papernexus.identifier-paper');
    assert.equal(loaded.files[0].paperMetadata.identifiers.arxivId, '2401.12345');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('loadImportTaskFileMetadata resolves home-relative stored task file paths', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-home-paths-'));
  const previousServerHome = process.env.PAPERNEXUS_SERVER_HOME;

  try {
    process.env.PAPERNEXUS_SERVER_HOME = rootPath;

    const {
      getImportTaskPaths,
      loadImportTaskFileMetadata
    } = await import('../src/storage/import-store.js');
    const taskId = 'imp:home-relative-metadata';
    const taskPaths = getImportTaskPaths(rootPath, taskId);
    const storedPath = path.join(taskPaths.sourcesDir, 'home-relative.pdf');
    const homeRelativeStoredPath = `~/${path.relative(rootPath, storedPath).split(path.sep).join('/')}`;

    await fs.mkdir(taskPaths.sourcesDir, { recursive: true });
    await fs.writeFile(storedPath, 'fake pdf\n', 'utf8');
    await fs.writeFile(taskPaths.taskPath, JSON.stringify({
      id: taskId,
      files: [
        {
          storedPath: homeRelativeStoredPath,
          kind: 'pdf',
          paperMetadata: {
            sourceProvider: 'cvf_openaccess',
            title: 'Home Relative Metadata Paper'
          }
        }
      ]
    }), 'utf8');

    const metadata = await loadImportTaskFileMetadata(rootPath, storedPath);
    assert.equal(metadata.task.id, taskId);
    assert.equal(metadata.file.storedPath, homeRelativeStoredPath);
    assert.equal(metadata.file.paperMetadata.title, 'Home Relative Metadata Paper');
  } finally {
    if (previousServerHome === undefined) {
      delete process.env.PAPERNEXUS_SERVER_HOME;
    } else {
      process.env.PAPERNEXUS_SERVER_HOME = previousServerHome;
    }

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

test('recoverFailedImportTasks does not supersede different content just because filenames match', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-same-name-different-content-'));

  try {
    const {
      completeImportTask,
      createImportTask,
      failImportTask,
      loadImportTask,
      recoverFailedImportTasks
    } = await import('../src/storage/import-store.js');

    const failedTask = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'paper.md',
          contentBase64: Buffer.from('# Paper A\n\n## Abstract\n\nOriginal failed content.\n', 'utf8').toString('base64'),
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
          name: 'paper.md',
          contentBase64: Buffer.from('# Paper B\n\n## Abstract\n\nDifferent completed content.\n', 'utf8').toString('base64'),
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

    assert.deepEqual(recovered.superseded, []);
    assert.deepEqual(recovered.recovered.map((entry) => entry.taskId), [failedTask.id]);

    const loaded = await loadImportTask(rootPath, failedTask.id);
    assert.equal(loaded.status, 'pending');
    assert.equal(loaded.stage, 'queued');
    assert.equal(loaded.recovery.status, 'queued-retry');
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

test('listImportTasks preserves execution heartbeat while decorating queue position', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-heartbeat-'));

  try {
    const {
      createImportTask,
      getImportTaskPaths,
      listImportTasks,
      reserveNextImportTask
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'heartbeat-paper.md',
          contentBase64: Buffer.from('# Heartbeat Paper\n\n## Abstract\n\nQueue display should not refresh execution heartbeat.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    const reserved = await reserveNextImportTask(rootPath);
    assert.equal(reserved.task.id, task.id);

    const staleIso = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const { taskPath } = getImportTaskPaths(rootPath, task.id);
    const payload = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    payload.startedAt = staleIso;
    payload.updatedAt = staleIso;
    payload.progress.stageStartedAt = staleIso;
    payload.progress.lastEventAt = staleIso;
    await fs.writeFile(taskPath, `${JSON.stringify(payload, null, 2)}\n`);

    const listed = await listImportTasks(rootPath);
    const listedTask = listed.tasks.find((entry) => entry.id === task.id);
    assert.ok(listedTask);
    assert.equal(listedTask.status, 'running');
    assert.equal(listedTask.progress.queuePosition, 1);
    assert.equal(listedTask.progress.queuedAhead, 0);
    assert.equal(listedTask.progress.lastEventAt, staleIso);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
