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

test('authoritative sync queue store clears a stale queue lock before enqueue', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-authoritative-sync-stale-lock-'));

  try {
    const [syncStore, corpusStore] = await Promise.all([
      import('../src/storage/authoritative-sync-store.js'),
      import('../src/storage/corpus-store.js')
    ]);
    const { authoritativeSyncLockPath } = corpusStore.getCorpusPaths(tempRoot);
    await fs.mkdir(authoritativeSyncLockPath, { recursive: true });
    await fs.writeFile(path.join(authoritativeSyncLockPath, 'owner.json'), JSON.stringify({
      pid: 12345,
      acquiredAt: new Date(Date.now() - 5000).toISOString()
    }, null, 2));
    const staleTime = new Date(Date.now() - 5000);
    await fs.utimes(authoritativeSyncLockPath, staleTime, staleTime);

    const queued = await syncStore.enqueueAuthoritativeSyncJob(tempRoot, {
      baseManifestToken: 'base-token',
      targetManifestToken: 'target-token',
      changedSourceKeys: ['paper-a'],
      mode: 'delta'
    }, {
      queueLockTimeoutMs: 250,
      queueLockStaleMs: 1000
    });

    assert.equal(queued.status, 'queued');
    await assert.rejects(fs.access(authoritativeSyncLockPath), (error) => error?.code === 'ENOENT');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('authoritative sync queue store recovers stale running jobs for reservation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-authoritative-sync-stale-running-'));

  try {
    const [syncStore, corpusStore] = await Promise.all([
      import('../src/storage/authoritative-sync-store.js'),
      import('../src/storage/corpus-store.js')
    ]);
    const queued = await syncStore.enqueueAuthoritativeSyncJob(tempRoot, {
      baseManifestToken: 'base-token',
      targetManifestToken: 'target-token',
      changedSourceKeys: ['paper-a'],
      mode: 'delta'
    });
    const running = await syncStore.reserveNextAuthoritativeSyncJob(tempRoot, {
      workerId: 'worker-a'
    });
    assert.equal(running.jobId, queued.jobId);
    assert.equal(running.status, 'running');

    const { authoritativeSyncQueuePath } = corpusStore.getCorpusPaths(tempRoot);
    const queuePayload = JSON.parse(await fs.readFile(authoritativeSyncQueuePath, 'utf8'));
    const staleIso = new Date(Date.now() - 5000).toISOString();
    queuePayload.jobs = queuePayload.jobs.map((job) => job.jobId === running.jobId
      ? {
          ...job,
          reservedAt: staleIso,
          updatedAt: staleIso
        }
      : job);
    await fs.writeFile(authoritativeSyncQueuePath, `${JSON.stringify(queuePayload, null, 2)}\n`);

    const recovery = await syncStore.recoverStaleAuthoritativeSyncJobs(tempRoot, {
      runningJobStaleMs: 1000
    });
    assert.equal(recovery.recoveredCount, 1);
    assert.equal(recovery.recoveredJobs[0].jobId, running.jobId);
    assert.equal(recovery.recoveredJobs[0].previousWorkerId, 'worker-a');

    const recoveredJobs = await syncStore.listAuthoritativeSyncJobs(tempRoot);
    assert.equal(recoveredJobs.length, 1);
    assert.equal(recoveredJobs[0].status, 'queued');
    assert.equal(recoveredJobs[0].workerId, null);
    assert.equal(recoveredJobs[0].recoveryCount, 1);
    assert.equal(recoveredJobs[0].lastRecovery.reason, 'stale-running-job');

    const rerun = await syncStore.reserveNextAuthoritativeSyncJob(tempRoot, {
      workerId: 'worker-b'
    });
    assert.equal(rerun.jobId, running.jobId);
    assert.equal(rerun.status, 'running');
    assert.equal(rerun.workerId, 'worker-b');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
