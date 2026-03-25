import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLaunchdServices } from '../src/lib/launchd.js';

test('normalizeLaunchdServices defaults to both watch and serve', () => {
  assert.deepEqual(normalizeLaunchdServices(undefined), ['watch', 'serve']);
  assert.deepEqual(normalizeLaunchdServices(''), ['watch', 'serve']);
});

test('normalizeLaunchdServices still supports explicit subsets', () => {
  assert.deepEqual(normalizeLaunchdServices('watch'), ['watch']);
  assert.deepEqual(normalizeLaunchdServices('serve'), ['serve']);
  assert.deepEqual(normalizeLaunchdServices('watch,serve'), ['watch', 'serve']);
});
