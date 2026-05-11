import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendRunEvent,
  continueRun,
  getRunStorePaths,
  loadRunStatus,
  startRun,
  tailRunEvents,
  updateRunStage,
  writeRunCheckpoint,
  writeRunWorkerLease
} from '../src/storage/run-store.js';

test('run store writes compact state, append-only events, checkpoints, and recovers stale leases', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-run-store-'));

  try {
    const started = await startRun(tempRoot, {
      kind: 'graph-v2-migration',
      command: 'build-shadow',
      currentStage: 'inventory',
      manifestToken: 'manifest:test',
      configSignature: 'config:test'
    });

    await appendRunEvent(tempRoot, started.runId, {
      event: 'stage-started',
      stage: 'inventory',
      message: 'inventory started'
    });
    await updateRunStage(tempRoot, started.runId, 'inventory', {
      status: 'running',
      processedUnits: 1,
      totalUnits: 4,
      percent: 25,
      message: 'inventory progress'
    });
    await writeRunCheckpoint(tempRoot, started.runId, 'inventory/shard-0001', {
      status: 'completed',
      inputHash: 'input:test',
      outputHash: 'output:test'
    });

    const lease = await writeRunWorkerLease(tempRoot, started.runId, 'worker-1', {
      stage: 'inventory',
      shardId: 'shard-0001'
    });
    const workerPath = path.join(getRunStorePaths(tempRoot, started.runId).workersDir, 'worker-1.json');
    await fs.writeFile(workerPath, `${JSON.stringify({
      ...lease,
      status: 'running',
      lastHeartbeatAt: '2000-01-01T00:00:00.000Z',
      leaseExpiresAt: '2000-01-01T00:00:00.000Z'
    }, null, 2)}\n`);

    const resumed = await continueRun(tempRoot, {
      runId: started.runId,
      manifestToken: 'manifest:test',
      configSignature: 'config:test',
      staleMs: 1
    });
    const status = await loadRunStatus(tempRoot, started.runId);
    const events = await tailRunEvents(tempRoot, started.runId, { tail: 4 });

    assert.equal(resumed.staleWorkers.length, 1);
    assert.equal(status.state.status, 'running');
    assert.equal(status.state.stages.inventory.status, 'running');
    assert.equal(status.state.stages.inventory.percent, 25);
    assert.equal(events.events.at(-1).event, 'run-resumed');
    assert.equal(events.events.every((event) => Number.isInteger(event.seq)), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
