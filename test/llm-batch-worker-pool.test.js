import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  createLlmBatchSlices,
  resolveLlmBatchSliceTimeoutMs,
  resolveLlmBatchConcurrency,
  runLlmBatchWorkerPool
} from '../src/core/llm/batch-worker-pool.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createLlmBatchSlices returns stable ordered batch metadata', () => {
  const slices = createLlmBatchSlices(['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(slices, [
    { start: 0, batchNumber: 1, batch: ['a', 'b'], totalBatches: 3 },
    { start: 2, batchNumber: 2, batch: ['c', 'd'], totalBatches: 3 },
    { start: 4, batchNumber: 3, batch: ['e'], totalBatches: 3 }
  ]);
});

test('resolveLlmBatchConcurrency preserves conservative default and explicit positive values', () => {
  assert.equal(resolveLlmBatchConcurrency({}), 1);
  assert.equal(resolveLlmBatchConcurrency({ llmBatchConcurrency: 2 }), 2);
  assert.equal(resolveLlmBatchConcurrency({ batchConcurrency: '3' }), 3);
  assert.equal(resolveLlmBatchConcurrency({ llmConcurrency: 0 }), 1);
});

test('resolveLlmBatchSliceTimeoutMs preserves no-timeout default and explicit positive values', () => {
  assert.equal(resolveLlmBatchSliceTimeoutMs({}), 0);
  assert.equal(resolveLlmBatchSliceTimeoutMs({ llmBatchSliceTimeoutMs: 250 }), 250);
  assert.equal(resolveLlmBatchSliceTimeoutMs({ llmSliceTimeoutMs: '500' }), 500);
  assert.equal(resolveLlmBatchSliceTimeoutMs({ sliceTimeoutMs: 0 }), 0);
});

test('runLlmBatchWorkerPool stops launching fresh calls after rate-limit cooldown', async () => {
  const processed = [];
  const skipped = [];
  const cooldownUntil = new Date(Date.now() + 60_000).toISOString();

  const results = await runLlmBatchWorkerPool([1, 2, 3, 4], {
    concurrency: 2,
    async iteratee(item) {
      processed.push(item);
      if (item === 1) {
        await sleep(5);
        return { item, rateLimitCooldownUntil: cooldownUntil };
      }
      await sleep(30);
      return { item, completed: true };
    },
    async createSkippedResult(item, detectedCooldownUntil) {
      skipped.push(item);
      return {
        item,
        skippedProviderCall: true,
        rateLimitCooldownUntil: detectedCooldownUntil
      };
    }
  });

  assert.deepEqual(processed.sort(), [1, 2]);
  assert.deepEqual(skipped, [3, 4]);
  assert.deepEqual(results.map((result) => result.item), [1, 2, 3, 4]);
  assert.equal(results[2].skippedProviderCall, true);
  assert.equal(results[3].rateLimitCooldownUntil, cooldownUntil);
});

test('runLlmBatchWorkerPool converts stuck slices to timeout results and continues', async () => {
  const processed = [];

  const results = await runLlmBatchWorkerPool([1, 2], {
    concurrency: 1,
    llmBatchSliceTimeoutMs: 10,
    async iteratee(item) {
      processed.push(item);
      if (item === 1) {
        return new Promise(() => {});
      }
      return { item, completed: true };
    },
    async createTimeoutResult(item, timeoutMs) {
      return {
        item,
        reason: 'provider-timeout',
        timeoutMs
      };
    }
  });

  assert.deepEqual(processed, [1, 2]);
  assert.equal(results[0].reason, 'provider-timeout');
  assert.equal(results[0].timeoutMs, 10);
  assert.deepEqual(results[1], { item: 2, completed: true });
});

test('runLlmBatchWorkerPool clears slice deadline timers when work fails before timeout', async () => {
  const startedAt = Date.now();
  const script = `
    const { runLlmBatchWorkerPool } = await import('./src/core/llm/batch-worker-pool.js');
    try {
      await runLlmBatchWorkerPool([1], {
        concurrency: 1,
        llmBatchSliceTimeoutMs: 1000,
        async iteratee() {
          throw new Error('provider failed before deadline');
        },
        async createSkippedResult(item) {
          return { item, skippedProviderCall: true };
        }
      });
      process.exitCode = 2;
    } catch (error) {
      if (!/provider failed before deadline/.test(String(error?.message || error))) {
        console.error(error);
        process.exitCode = 3;
      }
    }
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe']
  });

  const result = await new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stderr, durationMs: Date.now() - startedAt });
    });
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.durationMs < 500, `child process waited ${result.durationMs}ms for an uncleared timeout`);
});
