import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeImportWorkflowTool } from '../src/mcp/tool-import-workflow.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import {
  completeImportTask,
  createImportTask,
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

    const completion = setTimeout(() => {
      updateImportTaskSemanticLifecycle(rootPath, task.id, 'completed', {
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

    clearTimeout(completion);

    assert.equal(payload.waitTarget, 'semantic-complete');
    assert.equal(payload.waitForAuthoritativeSync, false);
    assert.equal(payload.waitStatus.reason, 'semantic-completed');
    assert.equal(payload.task.status, 'completed');
    assert.equal(payload.task.graphVisibilityStatus, 'completed');
    assert.equal(payload.task.semanticStatus, 'completed');
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
