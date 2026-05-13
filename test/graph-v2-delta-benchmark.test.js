import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGraphV2DeltaBenchmark } from '../scripts/benchmark-graph-v2-delta.mjs';

test('graph-v2 delta benchmark writes scratch Kuzu artifacts and supports resume', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-delta-benchmark-'));

  try {
    const first = await runGraphV2DeltaBenchmark({
      runId: 'test-graph-v2-delta',
      outputDir: tempRoot,
      paperCounts: [4],
      batchSize: 2,
      reset: true
    });
    assert.equal(first.status, 'completed');
    assert.equal(first.scenarios.length, 1);
    assert.equal(first.scenarios[0].batchSummary.completedBatchCount, 2);
    assert.equal(first.scenarios[0].batchSummary.totalPapers, 4);
    assert.equal(first.scenarios[0].graphSummary.sourceFragmentCount, 4);
    assert.ok(first.scenarios[0].graphSummary.nodeCount >= 17);
    assert.ok(first.scenarios[0].graphSummary.relationshipCount >= 20);

    const perBatchPath = first.scenarios[0].artifacts.perBatchPath;
    const beforeResume = await fs.readFile(perBatchPath, 'utf8');
    const resumed = await runGraphV2DeltaBenchmark({
      runId: 'test-graph-v2-delta',
      outputDir: tempRoot,
      paperCounts: [4],
      batchSize: 2,
      resume: true,
      reset: false
    });
    const afterResume = await fs.readFile(perBatchPath, 'utf8');
    assert.equal(resumed.status, 'completed');
    assert.equal(afterResume, beforeResume);
    assert.equal(resumed.scenarios[0].batchSummary.completedBatchCount, 2);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
