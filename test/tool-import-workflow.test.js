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
