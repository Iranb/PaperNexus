import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadLatestKuzuCommitReceipt,
  verifyKuzuCommitReceipt,
  writeKuzuCommitReceipt
} from '../src/storage/kuzu-commit-receipt-store.js';

test('Kuzu commit receipt persists passed verification and latest pointer', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-kuzu-receipt-'));

  try {
    const result = await writeKuzuCommitReceipt(tempRoot, {
      runId: 'run:test',
      traceId: 'trace:test',
      jobId: 'job:test',
      graphGeneration: 42,
      deltaHash: 'delta:test',
      dbPath: path.join(tempRoot, '.papernexus', 'graph.kuzu'),
      changedSourceKeys: ['source:test'],
      upsertedNodeCount: 3,
      upsertedRelationshipCount: 2,
      verificationQueries: [
        { name: 'paper_node_visible', status: 'passed', row_count: 1 },
        { name: 'source_fragment_visible', status: 'passed', row_count: 1, source_key: 'source:test' }
      ]
    });
    const latest = await loadLatestKuzuCommitReceipt(tempRoot);

    assert.equal(result.receipt.receipt_version, 'papernexus-kuzu-commit-v1');
    assert.equal(result.receipt.status, 'committed');
    assert.equal(result.receipt.nodes_written, 3);
    assert.equal(latest.receipt_id, result.receipt.receipt_id);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Kuzu receipt verifier reports missing receipts without throwing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-kuzu-receipt-missing-'));

  try {
    const report = await verifyKuzuCommitReceipt(tempRoot, 'latest');
    assert.equal(report.ok, false);
    assert.equal(report.status, 'missing');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
