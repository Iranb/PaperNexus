import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImportDagComparisonReport } from '../src/storage/import-dag-comparison.js';
import {
  completeImportTask,
  createImportTask,
  getImportTaskPaths,
  loadImportTaskDag,
  markImportTaskStage,
  reserveNextImportTask
} from '../src/storage/import-store.js';

test('import DAG comparison validates serial graph-visible task against sidecar nodes', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-dag-compare-'));

  try {
    const task = await createImportTask(rootPath, {
      trigger: 'api',
      processingProfile: 'fast-md-background-semantic',
      completionPolicy: 'graph-visible',
      files: [
        {
          name: 'dag-compare-paper.md',
          contentBase64: Buffer.from('# DAG Compare Paper\n\n## Abstract\n\nA graph-visible DAG comparison test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    await reserveNextImportTask(rootPath);
    await completeImportTask(rootPath, task.id, {
      graphVisibilityStatus: 'completed',
      semanticStatus: 'queued',
      authoritativeSync: {
        status: 'pending',
        jobId: 'sync:dag-compare'
      },
      throughputMetrics: {
        graphVisibleLatencyMs: 42
      }
    });

    const report = await createImportDagComparisonReport(rootPath, task.id);
    assert.equal(report.contractVersion, 'import-dag-comparison-v1');
    assert.equal(report.ok, true);
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.graphVisible.nodes['lite_state.update'].status, 'completed');
    assert.equal(report.semantic.nodes['paper.long_context_llm'].status, 'pending');
    assert.equal(report.authoritativeSync.nodes['authoritative_sync.enqueue'].status, 'completed');
    assert.equal(report.authoritativeSync.nodes['authoritative_sync.apply'].status, 'pending');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import DAG comparison treats active llm-optimize stage as running long-context node', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-dag-llm-active-'));

  try {
    const task = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'dag-active-llm.md',
          contentBase64: Buffer.from('# DAG Active LLM\n\n## Abstract\n\nAn active LLM stage comparison test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    await markImportTaskStage(rootPath, task.id, 'llm-optimize', 'stage llm-optimize');

    const report = await createImportDagComparisonReport(rootPath, task.id);
    assert.equal(report.ok, true);
    assert.equal(report.semantic.nodes['paper.long_context_llm'].status, 'running');
    assert.deepEqual(report.semantic.expectedStatuses, ['running', 'completed']);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('import DAG comparison reports graph-visible node drift', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-dag-drift-'));

  try {
    const task = await createImportTask(rootPath, {
      trigger: 'api',
      files: [
        {
          name: 'dag-drift-paper.md',
          contentBase64: Buffer.from('# DAG Drift Paper\n\n## Abstract\n\nA comparison drift test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    await reserveNextImportTask(rootPath);
    await completeImportTask(rootPath, task.id, {
      ok: true
    });

    const dag = await loadImportTaskDag(rootPath, task.id);
    dag.nodes['lite_state.update'].status = 'pending';
    await fs.writeFile(
      path.join(getImportTaskPaths(rootPath, task.id).taskDir, 'dag.json'),
      `${JSON.stringify(dag, null, 2)}\n`,
      'utf8'
    );

    const report = await createImportDagComparisonReport(rootPath, task.id);
    assert.equal(report.ok, false);
    assert.ok(report.mismatches.some((mismatch) => (
      mismatch.kind === 'graph-visible-node-not-completed'
      && mismatch.nodeId === 'lite_state.update'
      && mismatch.actual === 'pending'
    )));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
