import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  executeImportWorkflowTool,
  startImportWorkflowRecoveryWorker
} from '../src/mcp/tool-import-workflow.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import {
  completeImportTask,
  createImportTask,
  failImportTask,
  getImportPaths,
  loadImportTask,
  markImportTaskStage,
  updateImportTaskProgress,
  updateImportTaskSemanticLifecycle
} from '../src/storage/import-store.js';
import {
  completeAuthoritativeSyncJob,
  enqueueAuthoritativeSyncJob
} from '../src/storage/authoritative-sync-store.js';
import {
  enqueueImportSemanticEnrichmentJobs,
  reserveNextImportSemanticEnrichmentJob,
  updateImportSemanticEnrichmentJobProgress
} from '../src/storage/import-semantic-store.js';

test('import_workflow submit persists processing profile and completion policy', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-submit-profile-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-submit-profile-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const payload = await executeImportWorkflowTool({
      operation: 'submit',
      corpus: rootPath,
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      importExecutionMode: 'dag',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      llmLongContextMaxPapersPerCall: 2,
      llmBatchConcurrency: 1,
      files: [
        {
          name: 'workflow-profile.md',
          mimeType: 'text/markdown',
          identifiers: {
            doi: '10.48550/papernexus.workflow-profile'
          },
          contentBase64: Buffer.from('# Workflow Profile\n\n## Abstract\n\nA profile submit test.\n', 'utf8').toString('base64')
        }
      ]
    });

    assert.equal(payload.task.processingProfile, 'fast-md-background-semantic');
    assert.equal(payload.task.completionPolicy, 'graph-visible');
    assert.equal(payload.task.importExecutionMode, 'dag');
    assert.equal(payload.task.llmContextWindowTokens, 1_000_000);
    assert.equal(payload.task.llmExtractionStrategy, 'long-context-first');
    assert.equal(payload.task.llmLongContextMaxPapersPerCall, 2);
    assert.equal(payload.task.llmBatchConcurrency, 1);
    assert.equal(payload.task.graphVisibilityStatus, 'pending');
    assert.equal(payload.task.semanticStatus, 'pending');

    const stored = await loadImportTask(rootPath, payload.task.id);
    assert.equal(stored.processingProfile, 'fast-md-background-semantic');
    assert.equal(stored.completionPolicy, 'graph-visible');
    assert.equal(stored.importExecutionMode, 'dag');
    assert.equal(stored.llmContextWindowTokens, 1_000_000);
    assert.equal(stored.llmExtractionStrategy, 'long-context-first');
    assert.equal(stored.llmLongContextMaxPapersPerCall, 2);
    assert.equal(stored.llmBatchConcurrency, 1);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait includes downstream authoritative sync readiness', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-'));
  let completion = null;
  let completionWrite = Promise.resolve();

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

    completion = setTimeout(() => {
      completionWrite = completeAuthoritativeSyncJob(rootPath, syncJob.jobId, {
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

    assert.equal(payload.task.status, 'completed');
    assert.equal(payload.authoritativeSync.jobId, syncJob.jobId);
    assert.equal(payload.authoritativeSync.status, 'completed');
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    if (completion) clearTimeout(completion);
    await completionWrite;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait batch includes downstream authoritative sync readiness', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-batch-sync-'));
  let completion = null;
  let completionWrite = Promise.resolve();

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-batch-sync-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'queued-batch-sync-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Queued Batch Sync Paper\n\n## Abstract\n\nA queued batch sync test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const syncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target',
      changedSourceKeys: ['source:queued-batch-sync-paper'],
      mode: 'delta'
    });
    await completeImportTask(rootPath, task.id, {
      authoritativeSync: {
        status: 'pending',
        jobId: syncJob.jobId
      }
    });

    completion = setTimeout(() => {
      completionWrite = completeAuthoritativeSyncJob(rootPath, syncJob.jobId, {
        appliedAt: new Date().toISOString()
      }).catch(() => {});
    }, 120);

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskIds: [task.id],
      timeout: 5,
      interval: 0.05
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.equal(payload.waitTarget, 'task-completed');
    assert.equal(payload.waitForAuthoritativeSync, true);
    assert.equal(payload.waitStatus.satisfied, true);
    assert.equal(payload.waitStatus.satisfiedTaskCount, 1);
    assert.equal(payload.tasks[0].authoritativeSyncStatus, 'completed');
    assert.equal(payload.tasks[0].result.authoritativeSync.jobId, syncJob.jobId);
    assert.equal(payload.tasks[0].result.authoritativeSync.status, 'completed');
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    if (completion) clearTimeout(completion);
    await completionWrite;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait can return at graph-visible without waiting for authoritative sync', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-graph-visible-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-graph-visible-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      files: [
        {
          name: 'graph-visible-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Graph Visible Paper\n\n## Abstract\n\nA graph-visible wait test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const syncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target',
      changedSourceKeys: ['source:graph-visible-paper'],
      mode: 'delta'
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'queued',
      authoritativeSync: {
        status: 'pending',
        jobId: syncJob.jobId
      }
    });

    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskId: task.id,
      waitUntil: 'graph-visible',
      timeout: 1,
      interval: 0.05
    });

    assert.equal(payload.waitTarget, 'graph-visible');
    assert.equal(payload.waitForAuthoritativeSync, false);
    assert.equal(payload.waitStatus.reason, 'graph-visible');
    assert.equal(payload.task.status, 'completed');
    assert.equal(payload.task.graphVisibilityStatus, 'completed');
    assert.equal(payload.task.semanticStatus, 'queued');
    assert.equal(payload.authoritativeSync.jobId, syncJob.jobId);
    assert.equal(payload.authoritativeSync.status, 'pending');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait can target semantic-complete for background enrichment', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-semantic-'));
  let completion = null;
  let completionWrite = Promise.resolve();

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-semantic-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      llmContextWindowTokens: 1_000_000,
      llmExtractionStrategy: 'long-context-first',
      files: [
        {
          name: 'semantic-complete-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Semantic Complete Paper\n\n## Abstract\n\nA semantic wait test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'queued'
    });

    completion = setTimeout(() => {
      completionWrite = updateImportTaskSemanticLifecycle(rootPath, task.id, 'completed', {
        message: 'semantic enrichment completed'
      }).catch(() => {});
    }, 120);

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskId: task.id,
      waitUntil: 'semantic-complete',
      timeout: 5,
      interval: 0.05
    });

    assert.equal(payload.waitTarget, 'semantic-complete');
    assert.equal(payload.waitForAuthoritativeSync, false);
    assert.equal(payload.waitStatus.reason, 'semantic-completed');
    assert.equal(payload.task.status, 'completed');
    assert.equal(payload.task.graphVisibilityStatus, 'completed');
    assert.equal(payload.task.semanticStatus, 'completed');
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    if (completion) clearTimeout(completion);
    await completionWrite;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait can return a requested task id batch at graph-visible', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-batch-graph-'));
  let completion = null;
  let completionWrite = Promise.resolve();

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-batch-graph-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const completedTask = await createImportTask(rootPath, {
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      files: [
        {
          name: 'wait-batch-completed.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Completed\n\n## Abstract\n\nA completed batch wait test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const pendingTask = await createImportTask(rootPath, {
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      files: [
        {
          name: 'wait-batch-pending.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Pending\n\n## Abstract\n\nA pending batch wait test.\n', 'utf8').toString('base64')
        }
      ]
    });

    await completeImportTask(rootPath, completedTask.id, {
      semanticStatus: 'queued'
    });

    completion = setTimeout(() => {
      completionWrite = completeImportTask(rootPath, pendingTask.id, {
        semanticStatus: 'queued'
      }).catch(() => {});
    }, 120);

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskIds: [completedTask.id, pendingTask.id],
      waitUntil: 'graph-visible',
      timeout: 5,
      interval: 0.05
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.equal(payload.operation, 'wait');
    assert.equal(payload.waitTarget, 'graph-visible');
    assert.equal(payload.waitForAuthoritativeSync, false);
    assert.equal(payload.waitStatus.satisfied, true);
    assert.equal(payload.waitStatus.satisfiedTaskCount, 2);
    assert.equal(payload.waitStatus.unsatisfiedTaskCount, 0);
    assert.deepEqual(payload.requestedTaskIds, [completedTask.id, pendingTask.id]);
    assert.deepEqual(payload.tasks.map((task) => task.id), [completedTask.id, pendingTask.id]);
    assert.equal(payload.summary.completed, 2);
    assert.equal(payload.queueSummary.source, 'requested-tasks');
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    if (completion) clearTimeout(completion);
    await completionWrite;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait batch returns terminal failure without marking it satisfied', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-batch-failed-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-batch-failed-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'wait-batch-failed.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Failed\n\n## Abstract\n\nA failed batch wait test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await failImportTask(rootPath, task.id, new Error('materialize failed'));

    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskIds: [task.id],
      waitUntil: 'graph-visible',
      timeout: 1,
      interval: 0.05
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.equal(payload.waitStatus.satisfied, false);
    assert.equal(payload.waitStatus.terminal, true);
    assert.equal(payload.waitStatus.reason, 'terminal-with-failures');
    assert.equal(payload.waitStatus.satisfiedTaskCount, 0);
    assert.equal(payload.waitStatus.terminalTaskCount, 1);
    assert.equal(payload.waitStatus.failedTaskCount, 1);
    assert.equal(payload.waitStatus.tasks[0].failed, true);
    assert.equal(payload.waitStatus.tasks[0].satisfied, false);
    assert.equal(payload.waitStatus.tasks[0].terminal, true);
    assert.equal(payload.waitStatus.tasks[0].waitStatus.reason, 'task-failed');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow wait batch reads requested task ids without waiting for queue lock', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-wait-batch-lock-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-wait-batch-lock-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'wait-batch-lock.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Lock\n\n## Abstract\n\nA wait batch lock test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'completed',
        jobId: null
      }
    });

    const { queueLockPath } = getImportPaths(rootPath);
    await fs.mkdir(queueLockPath, { recursive: true });
    await fs.writeFile(path.join(queueLockPath, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    })}\n`, 'utf8');

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskIds: [task.id],
      waitUntil: 'graph-visible',
      timeout: 1,
      interval: 0.05,
      importQueueLockTimeoutMs: 25,
      importQueueLockStaleMs: 60_000
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.equal(payload.taskCount, 1);
    assert.equal(payload.tasks[0].id, task.id);
    assert.equal(payload.waitStatus.satisfied, true);
    assert.equal(payload.queueSummary.source, 'requested-tasks');
    assert.ok(Date.now() - startedAt < 1000);
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

test('import_workflow queue_progress summarizes operator phases and lifecycle status', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-phase-summary-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-phase-summary-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const coalescingTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-coalescing.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase Coalescing\n\n## Abstract\n\nA coalescing phase test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await updateImportTaskProgress(rootPath, coalescingTask.id, {
      stage: 'queued',
      status: 'pending',
      stagePercent: 25,
      processedUnits: 1,
      totalUnits: 4,
      currentStep: 'coalescing',
      message: 'Coalescing import batch: 1/4 task(s) queued'
    });

    const llmTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-llm.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase LLM\n\n## Abstract\n\nAn LLM phase test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await markImportTaskStage(rootPath, llmTask.id, 'llm-optimize', 'stage llm-optimize');
    await updateImportTaskProgress(rootPath, llmTask.id, {
      stage: 'llm-optimize',
      status: 'running',
      stagePercent: 37.5,
      processedUnits: 3,
      totalUnits: 8,
      currentStep: 'semantic batch 3/8',
      message: 'Running semantic LLM batch 3/8'
    });

    const commitTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-commit.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase Commit\n\n## Abstract\n\nA commit phase test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await markImportTaskStage(rootPath, commitTask.id, 'fast-commit', 'stage fast-commit');
    await updateImportTaskProgress(rootPath, commitTask.id, {
      stage: 'fast-commit',
      status: 'running',
      stagePercent: 50,
      currentStep: 'write delta',
      message: 'Writing lite graph delta'
    });

    const syncTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-sync.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase Sync\n\n## Abstract\n\nA sync phase test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, syncTask.id, {
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'pending',
        jobId: 'sync:phase-summary'
      }
    });
    const semanticEnqueue = await enqueueImportSemanticEnrichmentJobs(rootPath, [
      {
        taskId: llmTask.id,
        changedSourceKeys: ['phase-llm.md'],
        processingProfile: 'fast-md-background-semantic',
        completionPolicy: 'graph-visible'
      },
      {
        taskId: commitTask.id,
        changedSourceKeys: ['phase-commit.md'],
        processingProfile: 'fast-md-background-semantic',
        completionPolicy: 'graph-visible'
      }
    ]);
    assert.equal(semanticEnqueue.queuedCount, 2);
    const reservedSemanticJob = await reserveNextImportSemanticEnrichmentJob(rootPath, {
      workerId: 'test-semantic-progress'
    });
    assert.equal(reservedSemanticJob.job.taskId, llmTask.id);
    await updateImportSemanticEnrichmentJobProgress(rootPath, reservedSemanticJob.job.id, {
      status: 'running',
      stage: 'llm-optimize',
      currentStep: 'semantic extraction',
      message: 'Running background semantic batch 1/2',
      stagePercent: 50,
      processedUnits: 1,
      totalUnits: 2
    });

    const payload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [coalescingTask.id, llmTask.id, commitTask.id, syncTask.id],
      semanticJobLimit: 1
    });

    assert.equal(payload.summary.phaseCounts.coalescing, 1);
    assert.equal(payload.summary.phaseCounts['llm-optimize'], 1);
    assert.equal(payload.summary.phaseCounts['fast-commit'], 1);
    assert.equal(payload.summary.phaseCounts['authoritative-sync'], 1);
    assert.equal(payload.summary.lifecycleCounts.authoritativeSync.pending, 1);
    assert.equal(payload.summary.lifecycleCounts.semantic.completed, 1);
    assert.equal(payload.summary.activePhase, 'coalescing');
    assert.equal(payload.summary.activeTask.currentStep, 'coalescing');
    assert.equal(payload.semanticQueue.contractVersion, 'papernexus-import-semantic-enrichment-queue-progress-v1');
    assert.equal(payload.semanticQueue.summary.pending, 1);
    assert.equal(payload.semanticQueue.summary.running, 1);
    assert.equal(payload.semanticQueue.summary.remaining, 2);
    assert.equal(payload.semanticQueue.recentJobs.length, 1);
    assert.equal(payload.semanticQueue.recentJobs[0].changedSourceKeyCount, 1);
    assert.equal(payload.semanticQueue.recentJobs[0].processingProfile, 'fast-md-background-semantic');
    assert.equal(payload.semanticQueue.recentJobs[0].progress.contractVersion, 'import-semantic-enrichment-progress-v1');
    assert.equal(payload.semanticQueue.recentJobs[0].progress.stage, 'llm-optimize');
    assert.equal(payload.semanticQueue.recentJobs[0].progress.currentStep, 'semantic extraction');
    assert.equal(payload.semanticQueue.recentJobs[0].progress.processedUnits, 1);
    assert.equal(payload.semanticQueue.recentJobs[0].progress.totalUnits, 2);

    const llmPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [llmTask.id],
      eventTail: 5
    });

    assert.equal(llmPayload.summary.activePhase, 'llm-optimize');
    assert.equal(llmPayload.summary.activeTask.currentStep, 'semantic batch 3/8');
    assert.equal(llmPayload.summary.activeTask.processedUnits, 3);
    assert.equal(llmPayload.summary.activeTask.totalUnits, 8);
    assert.equal(llmPayload.summary.activeTask.eventLedger.contractVersion, 'import-event-v1');
    assert.ok(llmPayload.summary.activeTask.eventLedger.events.some((event) => event.event === 'task.progress'));
    assert.equal(llmPayload.summary.activeTask.dagEventLedger.contractVersion, 'import-dag-event-v1');
    assert.ok(llmPayload.summary.activeTask.dagEventLedger.events.some((event) => event.nodeId === 'paper.long_context_llm'));
    assert.equal(llmPayload.summary.activeTask.dagComparison.contractVersion, 'import-dag-comparison-v1');
    assert.equal(llmPayload.summary.activeTask.dagComparison.ok, true);
    assert.equal(llmPayload.summary.activeTask.dagComparison.semantic.nodes['paper.long_context_llm'].status, 'running');

    const performanceTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-performance.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase Performance\n\n## Abstract\n\nA performance summary test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, performanceTask.id, {
      graphVisibilityStatus: 'completed',
      semanticStatus: 'running',
      authoritativeSyncStatus: 'completed',
      metrics: {
        importPerformance: {
          contractVersion: 'import-performance-v1',
          mode: 'batch',
          batchId: 'impbatch:phase-performance',
          batchTaskCount: 2,
          changedSourceKeyCount: 1,
          batchChangedSourceKeyCount: 2,
          llmConfigGroupCount: 1,
          llmConfigKey: 'llm:default-1m',
          requestedImportExecutionMode: 'dag',
          importExecutionModeApplied: 'dag',
          llmOptimizeSkipped: false,
          directDeltaCommit: true,
          llmConfig: {
            llmContextWindowTokens: 1_000_000,
            llmExtractionStrategy: 'long-context-first',
            llmLongContextMaxPapersPerCall: 2,
            llmBatchConcurrency: 2
          },
          stageTimingsMs: {
            materialize: 1200,
            llmOptimize: 6400,
            fastCommit: 900,
            total: 8500
          },
          fastCommitPhasesMs: {
            buildDelta: 42,
            writeDelta: 131,
            'write.applyLiteDelta': 87
          },
          llmBatches: {
            completedBatchCount: 2,
            failedBatchCount: 1,
            retryEventCount: 1,
            maxConcurrency: 2,
            phases: ['semantic-extraction'],
            durationMs: {
              count: 2,
              min: 100,
              max: 220,
              mean: 160,
              p50: 100,
              p90: 220,
              p95: 220,
              total: 320
            },
            providerDurationMs: {
              count: 1,
              min: 220,
              max: 220,
              mean: 220,
              p50: 220,
              p90: 220,
              p95: 220,
              total: 220
            },
            failureReasons: {
              'schema-validation-failed': 1
            },
            retryReasons: {
              'provider-timeout': 1
            },
            byPhase: {
              'semantic-extraction': {
                completedBatchCount: 2,
                failedBatchCount: 1,
                durationMs: {
                  count: 2,
                  p95: 220,
                  total: 320
                },
                failureReasons: {
                  'schema-validation-failed': 1
                }
              }
            }
          }
        }
      }
    });

    const performancePayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [performanceTask.id],
      eventTail: 0,
      includeDagComparison: false
    });
    const activePerformance = performancePayload.summary.activeTask.importPerformance;
    assert.equal(performancePayload.summary.activePhase, 'semantic-enrichment');
    assert.equal(activePerformance.contractVersion, 'import-performance-v1');
    assert.equal(activePerformance.mode, 'batch');
    assert.equal(activePerformance.batchTaskCount, 2);
    assert.equal(activePerformance.directDeltaCommit, true);
    assert.equal(activePerformance.llmConfig.llmContextWindowTokens, 1_000_000);
    assert.equal(activePerformance.llmConfig.llmExtractionStrategy, 'long-context-first');
    assert.equal(activePerformance.llmConfig.llmBatchConcurrency, 2);
    assert.equal(activePerformance.stageTimingsMs.llmOptimize, 6400);
    assert.equal(activePerformance.fastCommitPhasesMs.buildDelta, 42);
    assert.equal(activePerformance.fastCommitPhasesMs['write.applyLiteDelta'], 87);
    assert.equal(activePerformance.llmBatches.completedBatchCount, 2);
    assert.equal(activePerformance.llmBatches.failedBatchCount, 1);
    assert.equal(activePerformance.llmBatches.durationMs.p95, 220);
    assert.equal(activePerformance.llmBatches.providerDurationMs.count, 1);
    assert.equal(activePerformance.llmBatches.failureReasons['schema-validation-failed'], 1);
    assert.equal(activePerformance.llmBatches.retryReasons['provider-timeout'], 1);
    assert.equal(activePerformance.llmBatches.byPhase['semantic-extraction'].durationMs.p95, 220);

    const llmDiagnosticTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'llm-phase-diagnostic.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# LLM Phase Diagnostic\n\n## Abstract\n\nAn LLM progress diagnostics test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await markImportTaskStage(rootPath, llmDiagnosticTask.id, 'llm-optimize', 'stage llm-optimize');
    await updateImportTaskProgress(rootPath, llmDiagnosticTask.id, {
      stage: 'llm-optimize',
      status: 'running',
      stagePercent: 33.33,
      processedUnits: 2,
      totalUnits: 6,
      currentStep: 'semantic-extraction batch 1/3',
      message: 'Completed semantic extraction batch progress',
      diagnostics: {
        contractVersion: 'llm-optimize-progress-diagnostics-v1',
        activeStage: 'llm-optimize',
        mode: 'semantic-enrichment',
        taskId: llmDiagnosticTask.id,
        semanticEnrichmentJobId: 'sem:test',
        changedSourceKeyCount: 2,
        llmConfig: {
          llmContextWindowTokens: 1_000_000,
          llmExtractionStrategy: 'long-context-first',
          llmLongContextMaxPapersPerCall: 2,
          llmBatchConcurrency: 2
        },
        completedBatchCount: 1,
        retryEventCount: 1,
        rateLimitSkippedBatchCount: 0,
        completed: 2,
        total: 6,
        maxConcurrency: 2,
        latestEvent: {
          event: 'batch-complete',
          phase: 'semantic-extraction',
          batchNumber: 1,
          totalBatches: 3,
          completed: 2,
          total: 6
        },
        phases: {
          'semantic-extraction': {
            completedBatchCount: 1,
            retryEventCount: 1,
            completed: 2,
            total: 6,
            maxConcurrency: 2
          }
        }
      }
    });
    const llmDiagnosticPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [llmDiagnosticTask.id],
      eventTail: 0,
      includeDagComparison: false
    });
    assert.equal(llmDiagnosticPayload.summary.activePhase, 'llm-optimize');
    assert.equal(llmDiagnosticPayload.summary.activeTask.currentStep, 'semantic-extraction batch 1/3');
    assert.equal(llmDiagnosticPayload.summary.activeTask.progressDiagnostics.contractVersion, 'llm-optimize-progress-diagnostics-v1');
    assert.equal(llmDiagnosticPayload.summary.activeTask.progressDiagnostics.llmConfig.llmContextWindowTokens, 1_000_000);
    assert.equal(llmDiagnosticPayload.summary.activeTask.progressDiagnostics.latestEvent.phase, 'semantic-extraction');
    assert.equal(llmDiagnosticPayload.summary.activeTask.progressDiagnostics.completed, 2);
    assert.equal(llmDiagnosticPayload.summary.activeTask.progressDiagnostics.total, 6);

    const diagnosticTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'phase-diagnostic.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Phase Diagnostic\n\n## Abstract\n\nA progress diagnostics test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await markImportTaskStage(rootPath, diagnosticTask.id, 'fast-commit', 'stage fast-commit');
    await updateImportTaskProgress(rootPath, diagnosticTask.id, {
      stage: 'fast-commit',
      status: 'running',
      stagePercent: 50,
      processedUnits: 3,
      totalUnits: 6,
      currentStep: 'applying refinement',
      message: 'Applied graph refinement and computed lite diff',
      diagnostics: {
        contractVersion: 'fast-commit-progress-diagnostics-v1',
        fastCommitMode: 'delta',
        changedSourceKeyCount: 2,
        fastCommitPhasesMs: {
          loadLite: 12,
          buildDelta: 34,
          applyGraphDelta: 56
        }
      }
    });
    const diagnosticPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [diagnosticTask.id],
      eventTail: 0,
      includeDagComparison: false
    });
    assert.equal(diagnosticPayload.summary.activePhase, 'fast-commit');
    assert.equal(diagnosticPayload.summary.activeTask.currentStep, 'applying refinement');
    assert.equal(diagnosticPayload.summary.activeTask.progressDiagnostics.contractVersion, 'fast-commit-progress-diagnostics-v1');
    assert.equal(diagnosticPayload.summary.activeTask.progressDiagnostics.fastCommitMode, 'delta');
    assert.equal(diagnosticPayload.summary.activeTask.progressDiagnostics.changedSourceKeyCount, 2);
    assert.equal(diagnosticPayload.summary.activeTask.progressDiagnostics.fastCommitPhasesMs.buildDelta, 34);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow queue_progress reads semantic queue from covered absolute root when paths are portable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-portable-home-'));
  const rootPath = path.join(tempHome, 'corpus');
  const previousHome = process.env.HOME;
  const previousServerHome = process.env.PAPERNEXUS_SERVER_HOME;

  try {
    process.env.HOME = tempHome;
    process.env.PAPERNEXUS_SERVER_HOME = tempHome;

    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-portable-semantic-queue-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'portable-semantic.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Portable Semantic\n\n## Abstract\n\nA portable semantic queue test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const semanticEnqueue = await enqueueImportSemanticEnrichmentJobs(rootPath, [
      {
        taskId: task.id,
        changedSourceKeys: ['portable-semantic.md'],
        processingProfile: 'fast-md-background-semantic',
        completionPolicy: 'graph-visible'
      }
    ]);
    assert.equal(semanticEnqueue.queuedCount, 1);

    const payload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id],
      semanticJobLimit: 5
    }, {
      portablePaths: true,
      workerRootPaths: [rootPath]
    });

    assert.equal(payload.rootPath, '~/corpus');
    assert.equal(payload.workerCoverage.covered, true);
    assert.equal(payload.workerCoverage.coveredRootPath, rootPath);
    assert.equal(payload.semanticQueue.summary.pending, 1);
    assert.equal(payload.semanticQueue.summary.remaining, 1);
    assert.equal(payload.semanticQueue.recentJobs[0].taskId, task.id);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServerHome === undefined) delete process.env.PAPERNEXUS_SERVER_HOME;
    else process.env.PAPERNEXUS_SERVER_HOME = previousServerHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import_workflow status can return a requested task id batch', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-status-batch-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-status-batch-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const pendingTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'status-batch-pending.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Pending\n\n## Abstract\n\nA pending status batch test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const completedTask = await createImportTask(rootPath, {
      files: [
        {
          name: 'status-batch-completed.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Completed\n\n## Abstract\n\nA completed status batch test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, completedTask.id, {
      graphVisibilityStatus: 'completed',
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'completed',
        jobId: null
      }
    });

    const payload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskIds: [completedTask.id, 'imp:missing-status-batch', pendingTask.id]
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.deepEqual(payload.requestedTaskIds, [completedTask.id, 'imp:missing-status-batch', pendingTask.id]);
    assert.deepEqual(payload.missingTaskIds, ['imp:missing-status-batch']);
    assert.deepEqual(payload.tasks.map((task) => task.id), [completedTask.id, pendingTask.id]);
    assert.equal(payload.taskCount, 2);
    assert.equal(payload.summary.completed, 1);
    assert.equal(payload.summary.pending, 1);
    assert.equal(payload.summary.remaining, 1);
    assert.equal(payload.queueSummary.total >= 2, true);
    assert.equal(payload.queueSummary.source, 'requested-tasks');

    const stringPayload = await executeImportWorkflowTool({
      operation: 'progress',
      corpus: rootPath,
      task_ids: `${pendingTask.id}, ${completedTask.id} ${pendingTask.id}`
    });

    assert.equal(stringPayload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.deepEqual(stringPayload.requestedTaskIds, [pendingTask.id, completedTask.id]);
    assert.deepEqual(stringPayload.tasks.map((task) => task.id), [pendingTask.id, completedTask.id]);

    const singularBatchPayload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskId: `${pendingTask.id}, ${completedTask.id}`
    });

    assert.equal(singularBatchPayload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.deepEqual(singularBatchPayload.requestedTaskIds, [pendingTask.id, completedTask.id]);

    const aliasPayload = await executeImportWorkflowTool({
      operation: 'status_batch',
      corpus: rootPath,
      task_id: pendingTask.id
    });

    assert.equal(aliasPayload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.deepEqual(aliasPayload.requestedTaskIds, [pendingTask.id]);
    assert.equal(aliasPayload.operation, 'status');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow status batch reads requested task ids without waiting for queue lock', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-status-batch-lock-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-status-batch-lock-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'status-batch-lock.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Lock\n\n## Abstract\n\nA status batch lock test.\n', 'utf8').toString('base64')
        }
      ]
    });

    const { queueLockPath } = getImportPaths(rootPath);
    await fs.mkdir(queueLockPath, { recursive: true });
    await fs.writeFile(path.join(queueLockPath, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    })}\n`, 'utf8');

    const startedAt = Date.now();
    const payload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskIds: [task.id],
      importQueueLockTimeoutMs: 25,
      importQueueLockStaleMs: 60_000
    });

    assert.equal(payload.contractVersion, 'papernexus-import-workflow-task-batch-v1');
    assert.equal(payload.taskCount, 1);
    assert.equal(payload.tasks[0].id, task.id);
    assert.equal(payload.missingTaskIds.length, 0);
    assert.equal(payload.queueSummary.source, 'requested-tasks');
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow hydrates authoritative sync lifecycle from job history', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-sync-hydration-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-sync-hydration-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'sync-hydration-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Sync Hydration\n\n## Abstract\n\nA sync hydration test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const syncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:sync-hydration-base',
      targetManifestToken: 'manifest:sync-hydration-target',
      changedSourceKeys: ['source:sync-hydration-paper'],
      mode: 'delta'
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'pending',
        jobId: syncJob.jobId
      }
    });
    await completeAuthoritativeSyncJob(rootPath, syncJob.jobId, {
      appliedAt: new Date().toISOString()
    });

    const progressPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id]
    });

    assert.equal(progressPayload.summary.phaseCounts.completed, 1);
    assert.equal(progressPayload.summary.phaseCounts['authoritative-sync'], undefined);
    assert.equal(progressPayload.summary.lifecycleCounts.authoritativeSync.completed, 1);
    assert.equal(progressPayload.summary.activeTask, null);
    assert.equal(progressPayload.tasks[0].authoritativeSyncStatus, 'completed');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.status, 'completed');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.jobId, syncJob.jobId);

    const statusPayload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskId: task.id
    });

    assert.equal(statusPayload.task.authoritativeSyncStatus, 'completed');
    assert.equal(statusPayload.task.result.authoritativeSync.status, 'completed');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow treats completed authoritative sync without job as non-blocking legacy state', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-sync-no-job-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-sync-no-job-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'sync-no-job-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Sync No Job\n\n## Abstract\n\nA legacy sync no-job test.\n', 'utf8').toString('base64')
        }
      ]
    });
    await completeImportTask(rootPath, task.id, {
      graphVisibilityStatus: 'completed',
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'pending',
        jobId: null
      }
    });

    const progressPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id],
      eventTail: 0,
      includeDagComparison: false
    });

    assert.equal(progressPayload.summary.phaseCounts.completed, 1);
    assert.equal(progressPayload.summary.phaseCounts['authoritative-sync'], undefined);
    assert.equal(progressPayload.summary.lifecycleCounts.authoritativeSync['not-required'], 1);
    assert.equal(progressPayload.summary.activeTask, null);
    assert.equal(progressPayload.tasks[0].authoritativeSyncStatus, 'not-required');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.status, 'not-required');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.originalStatus, 'pending');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.source, 'legacy-no-authoritative-sync-job');

    const statusPayload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskId: task.id
    });

    assert.equal(statusPayload.task.authoritativeSyncStatus, 'not-required');
    assert.equal(statusPayload.task.result.authoritativeSync.status, 'not-required');

    const startedAt = Date.now();
    const waitPayload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskId: task.id,
      waitUntil: 'authoritative-sync',
      timeout: 1,
      interval: 0.05
    });

    assert.ok(Date.now() - startedAt < 500);
    assert.equal(waitPayload.authoritativeSync.status, 'not-required');
    assert.equal(waitPayload.authoritativeSync.source, 'legacy-no-authoritative-sync-job');
    assert.equal(waitPayload.waitStatus.authoritativeSyncStatus, 'not-required');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow hydrates semantic enrichment authoritative sync lifecycle', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-semantic-sync-hydration-'));

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-semantic-sync-hydration-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'semantic-sync-hydration-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Semantic Sync Hydration\n\n## Abstract\n\nA semantic sync hydration test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const importSyncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:semantic-sync-import-base',
      targetManifestToken: 'manifest:semantic-sync-import-target',
      changedSourceKeys: ['source:semantic-sync-import'],
      mode: 'delta'
    });
    const semanticSyncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:semantic-sync-semantic-base',
      targetManifestToken: 'manifest:semantic-sync-semantic-target',
      changedSourceKeys: ['source:semantic-sync-semantic'],
      mode: 'delta'
    });
    await completeAuthoritativeSyncJob(rootPath, importSyncJob.jobId, {
      appliedAt: new Date().toISOString()
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'queued',
      authoritativeSync: {
        status: 'completed',
        jobId: importSyncJob.jobId
      }
    });
    await updateImportTaskSemanticLifecycle(rootPath, task.id, 'completed', {
      jobId: 'isem:semantic-sync-hydration',
      jobIds: ['isem:semantic-sync-hydration'],
      result: {
        taskId: task.id,
        authoritativeSync: {
          status: 'pending',
          jobId: semanticSyncJob.jobId
        }
      }
    });

    const pendingPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id]
    });

    assert.equal(pendingPayload.summary.lifecycleCounts.authoritativeSync.pending, 1);
    assert.equal(pendingPayload.summary.phaseCounts['authoritative-sync'], 1);
    assert.equal(pendingPayload.summary.activeTask.authoritativeSyncJobId, semanticSyncJob.jobId);
    assert.equal(pendingPayload.tasks[0].authoritativeSyncStatus, 'pending');
    assert.equal(pendingPayload.tasks[0].result.authoritativeSync.jobId, importSyncJob.jobId);
    assert.equal(
      pendingPayload.tasks[0].result.semanticEnrichment.result.authoritativeSync.jobId,
      semanticSyncJob.jobId
    );
    assert.equal(
      pendingPayload.tasks[0].result.semanticEnrichment.result.authoritativeSync.status,
      'pending'
    );

    await completeAuthoritativeSyncJob(rootPath, semanticSyncJob.jobId, {
      appliedAt: new Date().toISOString()
    });

    const statusPayload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskId: task.id
    });

    assert.equal(statusPayload.task.authoritativeSyncStatus, 'completed');
    assert.equal(statusPayload.task.result.authoritativeSync.jobId, importSyncJob.jobId);
    assert.equal(statusPayload.task.result.authoritativeSync.status, 'completed');
    assert.equal(
      statusPayload.task.result.semanticEnrichment.result.authoritativeSync.jobId,
      semanticSyncJob.jobId
    );
    assert.equal(
      statusPayload.task.result.semanticEnrichment.result.authoritativeSync.status,
      'completed'
    );
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow hydrates authoritative sync lifecycle when paths are portable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-portable-sync-home-'));
  const rootPath = path.join(tempHome, 'corpus');
  const previousHome = process.env.HOME;
  const previousServerHome = process.env.PAPERNEXUS_SERVER_HOME;

  try {
    process.env.HOME = tempHome;
    process.env.PAPERNEXUS_SERVER_HOME = tempHome;

    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-portable-sync-hydration-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const task = await createImportTask(rootPath, {
      files: [
        {
          name: 'portable-sync-hydration-paper.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# Portable Sync Hydration\n\n## Abstract\n\nA portable sync hydration test.\n', 'utf8').toString('base64')
        }
      ]
    });
    const syncJob = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: 'manifest:portable-sync-base',
      targetManifestToken: 'manifest:portable-sync-target',
      changedSourceKeys: ['source:portable-sync-hydration-paper'],
      mode: 'delta'
    });
    await completeImportTask(rootPath, task.id, {
      semanticStatus: 'completed',
      authoritativeSync: {
        status: 'pending',
        jobId: syncJob.jobId
      }
    });
    await completeAuthoritativeSyncJob(rootPath, syncJob.jobId, {
      appliedAt: new Date().toISOString()
    });

    const progressPayload = await executeImportWorkflowTool({
      operation: 'queue_progress',
      corpus: rootPath,
      taskIds: [task.id],
      eventTail: 0,
      includeDagComparison: false
    }, {
      portablePaths: true
    });

    assert.equal(progressPayload.rootPath, '~/corpus');
    assert.equal(progressPayload.summary.lifecycleCounts.authoritativeSync.completed, 1);
    assert.equal(progressPayload.summary.lifecycleCounts.authoritativeSync.pending, undefined);
    assert.equal(progressPayload.tasks[0].authoritativeSyncStatus, 'completed');
    assert.equal(progressPayload.tasks[0].result.authoritativeSync.status, 'completed');

    const statusPayload = await executeImportWorkflowTool({
      operation: 'status',
      corpus: rootPath,
      taskId: task.id
    }, {
      portablePaths: true
    });

    assert.equal(statusPayload.rootPath, '~/corpus');
    assert.equal(statusPayload.task.authoritativeSyncStatus, 'completed');
    assert.equal(statusPayload.task.result.authoritativeSync.status, 'completed');

    const waitPayload = await executeImportWorkflowTool({
      operation: 'wait',
      corpus: rootPath,
      taskId: task.id,
      waitUntil: 'authoritative-sync',
      timeout: 1,
      interval: 0.05
    }, {
      portablePaths: true
    });

    assert.equal(waitPayload.rootPath, '~/corpus');
    assert.equal(waitPayload.task.authoritativeSyncStatus, 'completed');
    assert.equal(waitPayload.authoritativeSync.status, 'completed');
    assert.equal(waitPayload.authoritativeSync.jobId, syncJob.jobId);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServerHome === undefined) delete process.env.PAPERNEXUS_SERVER_HOME;
    else process.env.PAPERNEXUS_SERVER_HOME = previousServerHome;
    await fs.rm(tempHome, { recursive: true, force: true });
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
    assert.equal(submitPayload.statusEnvelope.contractVersion, 'papernexus-operation-status-v1');
    assert.equal(submitPayload.statusEnvelope.stateClass, 'active_wait');
    assert.equal(submitPayload.statusEnvelope.blockingScope, 'papernexus_operation');
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
    assert.equal(statusPayload.statusEnvelope.stateClass, 'complete');
    assert.equal(statusPayload.statusEnvelope.blockingScope, 'none');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow async idempotency keys deduplicate matching requests and reject conflicts', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-idempotency-'));
  const jobRootPath = path.join(rootPath, '.test-mcp-jobs');

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-idempotency-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));

    const argumentsPayload = {
      operation: 'queue_progress',
      corpus: rootPath,
      async: true,
      idempotencyKey: 'workflow:round-1:queue-progress',
      projectId: 'project-1',
      workflowRunId: 'round-1',
      selectionRevision: 'selection-3'
    };
    const [first, duplicate] = await Promise.all([
      executeImportWorkflowTool(argumentsPayload, { importWorkflowJobRootPath: jobRootPath }),
      executeImportWorkflowTool(argumentsPayload, { importWorkflowJobRootPath: jobRootPath })
    ]);

    assert.equal(first.jobId, duplicate.jobId);
    assert.equal([first.deduplicated, duplicate.deduplicated].filter(Boolean).length, 1);
    assert.equal(first.statusEnvelope.projectId, 'project-1');
    assert.equal(first.statusEnvelope.workflowRunId, 'round-1');
    assert.equal(first.statusEnvelope.selectionRevision, 'selection-3');

    await assert.rejects(
      executeImportWorkflowTool({
        ...argumentsPayload,
        limit: 1
      }, {
        importWorkflowJobRootPath: jobRootPath
      }),
      /idempotency key conflict/
    );

    const completed = await executeImportWorkflowTool({
      operation: 'async_wait',
      jobId: first.jobId,
      waitTimeoutMs: 5000,
      pollIntervalMs: 25
    }, {
      importWorkflowJobRootPath: jobRootPath
    });
    assert.equal(completed.status, 'completed');

    const jobFiles = (await fs.readdir(jobRootPath)).filter((name) => name.endsWith('.json'));
    assert.deepEqual(jobFiles, [`${first.jobId}.json`]);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import_workflow recovery resumes replay-safe jobs and blocks ambiguous mutating jobs', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-workflow-recovery-'));
  const jobRootPath = path.join(rootPath, '.test-mcp-jobs');
  let worker = null;

  try {
    const { corpusDir, metaPath } = getCorpusPaths(rootPath);
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify({
      name: 'import-workflow-recovery-test',
      indexedAt: new Date().toISOString(),
      paperCount: 0,
      nodeCount: 0,
      relationshipCount: 0
    }, null, 2));
    await fs.mkdir(jobRootPath, { recursive: true });

    const staleAt = '2000-01-01T00:00:00.000Z';
    const safeJob = {
      version: 1,
      type: 'import_workflow',
      jobId: 'stale-safe-job',
      status: 'running',
      stage: 'running',
      requestedOperation: 'queue_progress',
      replaySafe: true,
      attempts: 1,
      recoveryCount: 0,
      createdAt: staleAt,
      startedAt: staleAt,
      updatedAt: staleAt,
      corpus: rootPath,
      arguments: {
        operation: 'queue_progress',
        corpus: rootPath
      },
      result: null,
      error: null
    };
    const unsafeJob = {
      ...safeJob,
      jobId: 'stale-submit-job',
      requestedOperation: 'submit',
      replaySafe: false,
      arguments: {
        operation: 'submit',
        corpus: rootPath,
        files: []
      }
    };
    await fs.writeFile(path.join(jobRootPath, `${safeJob.jobId}.json`), `${JSON.stringify(safeJob, null, 2)}\n`);
    await fs.writeFile(path.join(jobRootPath, `${unsafeJob.jobId}.json`), `${JSON.stringify(unsafeJob, null, 2)}\n`);

    worker = startImportWorkflowRecoveryWorker({
      importWorkflowJobRootPath: jobRootPath,
      importWorkflowRecoveryStaleMs: 0,
      importWorkflowRecoveryIntervalMs: 60_000,
      logger: { warn() {} }
    });
    const recovery = await worker.pollNow();
    assert.equal(recovery.scanned, 2);
    assert.equal(recovery.candidates, 2);
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.manualRecoveryRequired, 1);

    const recoveredSafe = await executeImportWorkflowTool({
      operation: 'async_status',
      jobId: safeJob.jobId
    }, {
      importWorkflowJobRootPath: jobRootPath
    });
    assert.equal(recoveredSafe.status, 'completed');
    assert.equal(recoveredSafe.result.summary.total, 0);
    assert.equal(recoveredSafe.statusEnvelope.stateClass, 'complete');

    const blockedUnsafe = await executeImportWorkflowTool({
      operation: 'async_status',
      jobId: unsafeJob.jobId
    }, {
      importWorkflowJobRootPath: jobRootPath
    });
    assert.equal(blockedUnsafe.status, 'manual_recovery_required');
    assert.equal(blockedUnsafe.result, null);
    assert.equal(blockedUnsafe.statusEnvelope.stateClass, 'manual_recovery_required');
    assert.equal(blockedUnsafe.statusEnvelope.blockerCode, 'unsafe_replay_requires_manual_recovery');
  } finally {
    await worker?.stop?.();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
