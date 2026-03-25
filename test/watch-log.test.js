import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWatchTmpLogger, getWatchTmpLogPath } from '../src/lib/watch-log.js';

test('getWatchTmpLogPath is stable for the same root path', () => {
  const rootPath = '/tmp/papernexus-corpus-root';
  assert.equal(getWatchTmpLogPath(rootPath), getWatchTmpLogPath(rootPath));
  assert.ok(getWatchTmpLogPath(rootPath).startsWith(path.join(os.tmpdir(), 'papernexus-watch-')));
});

test('createWatchTmpLogger appends watch events to the tmp log file', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-watch-log-'));

  try {
    const logger = createWatchTmpLogger(tempRoot);
    logger.info('[watch] Initial index ready');
    logger.warn('[watch] Falling back to polling');
    await logger.flush();

    const content = await fs.readFile(logger.logPath, 'utf8');
    assert.match(content, /\[info\] \[watch\] Initial index ready/);
    assert.match(content, /\[warn\] \[watch\] Falling back to polling/);
  } finally {
    await fs.rm(getWatchTmpLogPath(tempRoot), { force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
