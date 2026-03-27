import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('authoritative sync queue store enqueues, reserves, and completes jobs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-authoritative-sync-'));

  try {
    const syncStore = await import('../src/storage/authoritative-sync-store.js');

    const queued = await syncStore.enqueueAuthoritativeSyncJob(tempRoot, {
      baseManifestToken: 'base-token',
      targetManifestToken: 'target-token',
      changedSourceKeys: ['paper-a'],
      mode: 'delta'
    });

    assert.equal(queued.status, 'queued');

    const queuedJobs = await syncStore.listAuthoritativeSyncJobs(tempRoot);
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].jobId, queued.jobId);

    const running = await syncStore.reserveNextAuthoritativeSyncJob(tempRoot, {
      workerId: 'worker-a'
    });
    assert.equal(running.jobId, queued.jobId);
    assert.equal(running.status, 'running');
    assert.equal(running.workerId, 'worker-a');

    const completed = await syncStore.completeAuthoritativeSyncJob(tempRoot, running.jobId, {
      summary: {
        synchronizedNodeCount: 12,
        synchronizedRelationshipCount: 18
      }
    });
    assert.equal(completed.status, 'completed');
    assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);

    const queueAfterCompletion = await syncStore.listAuthoritativeSyncJobs(tempRoot);
    assert.deepEqual(queueAfterCompletion, []);

    const history = await syncStore.listAuthoritativeSyncHistory(tempRoot);
    assert.equal(history.length, 1);
    assert.equal(history[0].jobId, queued.jobId);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('authoritative sync queue store dedupes queued jobs by target manifest token', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-authoritative-sync-'));

  try {
    const syncStore = await import('../src/storage/authoritative-sync-store.js');

    const first = await syncStore.enqueueAuthoritativeSyncJob(tempRoot, {
      baseManifestToken: 'base-token',
      targetManifestToken: 'target-token',
      changedSourceKeys: ['paper-a'],
      mode: 'delta'
    });

    const deduped = await syncStore.enqueueAuthoritativeSyncJob(tempRoot, {
      baseManifestToken: 'base-token',
      targetManifestToken: 'target-token',
      changedSourceKeys: ['paper-b'],
      mode: 'delta'
    });

    assert.equal(deduped.jobId, first.jobId);

    const queuedJobs = await syncStore.listAuthoritativeSyncJobs(tempRoot);
    assert.equal(queuedJobs.length, 1);
    assert.deepEqual(queuedJobs[0].changedSourceKeys, ['paper-a', 'paper-b']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
