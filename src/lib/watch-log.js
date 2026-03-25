import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from './utils.js';

export function getWatchTmpLogPath(rootPath) {
  const seed = path.resolve(rootPath || process.cwd());
  return path.join(os.tmpdir(), `papernexus-watch-${stableHash(seed, 16)}.log`);
}

export function createWatchTmpLogger(rootPath) {
  const logPath = getWatchTmpLogPath(rootPath);
  let writeChain = Promise.resolve();

  const append = (level, message) => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    writeChain = writeChain
      .then(() => fs.appendFile(logPath, line, 'utf8'))
      .catch(() => {});
    return writeChain;
  };

  return {
    logPath,
    info(message) {
      console.log(message);
      void append('info', message);
    },
    warn(message) {
      console.warn(message);
      void append('warn', message);
    },
    error(message) {
      console.error(message);
      void append('error', message);
    },
    async flush() {
      await writeChain;
    }
  };
}
