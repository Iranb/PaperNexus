import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEnhancementLogMessage } from '../src/core/enhancements/worker.js';

test('formatEnhancementLogMessage prefixes messages with an ISO timestamp', () => {
  const timestamp = new Date('2026-04-07T08:09:10.111Z');
  const formatted = formatEnhancementLogMessage('[enhance] corpus-a: refreshed paper-x', timestamp);

  assert.equal(
    formatted,
    '[2026-04-07T08:09:10.111Z] [enhance] corpus-a: refreshed paper-x'
  );
});
