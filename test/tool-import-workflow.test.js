import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeImportWorkflowTool } from '../src/mcp/tool-import-workflow.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { completeImportTask, createImportTask } from '../src/storage/import-store.js';
import {
  completeAuthoritativeSyncJob,
  enqueueAuthoritativeSyncJob
} from '../src/storage/authoritative-sync-store.js';

test('import_workflow wait includes downstream authoritative sync readiness', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'queued-sync-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Queued Sync Paper\n\n## Abstract\n\nA queued sync test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const syncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target',
      changedSourceKeys: ['source:queued-sync-paper'],
      mode: 'delta'
    });
    await completeImportTask(rootPath, task.id, {
      authoritativeSync: {
        status: 'pending',
        jobId: syncJob.jobId
      }
    });

    const completion = setTimeout(() => {
      completeAuthoritativeSyncJob(rootPath, syncJob.jobId, {
        appliedAt: new Date().toISOString()
      }).catch(() => {});
    }, 120);

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskId: task.id,
      timeout: 5,
      interval: 0.05
    });

    clearTimeout(completion);

    assert.equal(payload.task.status, 'completed');
    assert.equal(payload.authoritativeSync.jobId, syncJob.jobId);
    assert.equal(payload.authoritativeSync.status, 'completed');
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow queue_progress reports individual tasks completed by one worker batch', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-batch-progress-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-batch-progress-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const firstTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'batch-progress-one.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Batch Progress One\n\n## Abstract\n\nFirst batch progress test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const secondTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'batch-progress-two.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Batch Progress Two\n\n## Abstract\n\nSecond batch progress test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const batchId = 'impbatch:test-progress';
    const batchTaskIds = [firstTask.id, secondTask.id];

    for (const task of [firstTask, secondTask]) {
      await completeImportTask(rootPath, task.id, {
        batch: {
          batchId,
          batchTaskIds,
          completedTaskIds: batchTaskIds,
          failedTaskIds: []
        },
        authoritativeSync: {
          status: 'pending',
          jobId: 'sync:test-progress'
        }
      });
    }

    const payload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: batchTaskIds
    });

    assert.equal(payload.summary.total, 2);
    assert.equal(payload.summary.completed, 2);
    assert.equal(payload.summary.remaining, 0);
    assert.deepEqual(
      payload.tasks.map((task) => task.id).sort(),
      batchTaskIds.slice().sort()
    );
    assert.deepEqual(
      payload.tasks.map((task) => task.result?.batch?.batchId),
      [batchId, batchId]
    );
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow queue_progress reports uncovered worker roots', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-uncovered-'));
  const otherRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-covered-other-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-uncovered-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    await createImportTask(rootPath, {
      files: [
        {
          name: 'uncovered-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Uncovered Paper\n\n## Abstract\n\nA worker coverage test.\n', 'utf8').toString('base64')
        }
      ]
    });

    const payload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath
    }, {
      workerRootPaths: [otherRootPath]
    });

    assert.equal(payload.summary.pending, 1);
    assert.equal(payload.workerCoverage.covered, false);
    assert.equal(payload.workerCoverage.blockedReason, 'root_not_configured');
    assert.equal(payload.workerCoverage.configuredRootCount, 1);
  } finally {
    await fs.rm(otherRootPath, { recursive: true, force: true });
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow can run queue_progress as an asynchronous MCP job', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-async-'));
  const jobRootPath = path.join(rootPath, '.test-mcp-jobs');

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-async-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'async-progress-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Async Progress Paper\n\n## Abstract\n\nAn async progress test.\n', 'utf8').toString('base64')
        }
      ]
    });

    const submitPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id],
      async: true
    }, {
      importWorkflowJobRootPath: jobRootPath
    });

    assert.equal(submitPayload.contractVersion, 'papernexus-import-workflow-job-v1');
    assert.equal(submitPayload.status, 'queued');
    assert.equal(submitPayload.requestedOperation, 'queue_progress');
    assert.ok(submitPayload.jobId);
    assert.equal(submitPayload.result, null);
    assert.deepEqual(submitPayload.next.arguments, {
      operation: 'async_status',
      jobId: submitPayload.jobId
    });

    const waitPayload = await executeImportWorkflowTool({
      operation: 'async_wait',
      jobId: submitPayload.jobId,
      waitTimeoutMs: 5000,
      pollIntervalMs: 25
    }, {
      importWorkflowJobRootPath: jobRootPath
    });

    assert.equal(waitPayload.contractVersion, 'papernexus-import-workflow-job-v1');
    assert.equal(waitPayload.status, 'completed');
    assert.equal(waitPayload.timedOut, false);
    assert.equal(waitPayload.result.summary.total, 1);
    assert.equal(waitPayload.result.tasks[0].id, task.id);

    const statusPayload = await executeImportWorkflowTool({
      operation: 'async_status',
      jobId: submitPayload.jobId
    }, {
      importWorkflowJobRootPath: jobRootPath
    });

    assert.equal(statusPayload.status, 'completed');
    assert.equal(statusPayload.result.summary.total, 1);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
