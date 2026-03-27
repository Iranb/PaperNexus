import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const METADATA_FILE_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.localized'
]);

const METADATA_DIRECTORY_NAMES = new Set([
  '__macosx',
  '.appledouble',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd'
]);

export function isMetadataFileName(fileName) {
  const normalized = String(fileName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('._')) return true;
  return METADATA_FILE_NAMES.has(normalized.toLowerCase());
}

export function isMetadataDirectoryName(directoryName) {
  const normalized = String(directoryName || '').trim();
  if (!normalized) return false;
  return METADATA_DIRECTORY_NAMES.has(normalized.toLowerCase());
}

export function shouldIgnoreFsEntry(entryName, options = {}) {
  const normalized = String(entryName || '').trim();
  if (!normalized) return false;
  if (normalized === '.papernexus' || normalized === 'node_modules' || normalized === '.git') {
    return true;
  }

  if (options.isDirectory) {
    return isMetadataDirectoryName(normalized);
  }

  return isMetadataFileName(normalized);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

export async function writeText(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  await ensureDir(directory);
  await fs.writeFile(tempPath, value, 'utf8');

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 30000));
  const pollIntervalMs = Math.max(25, Number(options.pollIntervalMs || 125));
  const staleMs = Math.max(timeoutMs, Number(options.staleMs || 60 * 60 * 1000));
  const startedAt = Date.now();
  const onWait = typeof options.onWait === 'function' ? options.onWait : null;
  const onAcquired = typeof options.onAcquired === 'function' ? options.onAcquired : null;
  let waitingNotified = false;

  await ensureDir(path.dirname(lockPath));

  while (true) {
    try {
      await fs.mkdir(lockPath);
      onAcquired?.({
        lockPath,
        waitedMs: Date.now() - startedAt,
        waited: waitingNotified
      });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`);
      }

      if (!waitingNotified) {
        waitingNotified = true;
        onWait?.({
          lockPath,
          waitedMs: Date.now() - startedAt
        });
      }

      await sleep(pollIntervalMs);
    }
  }

  let released = false;
  const releaseLockSync = () => {
    if (released) return;
    released = true;
    try {
      fsSync.rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  };
  const releaseLock = async () => {
    if (released) return;
    released = true;
    await fs.rm(lockPath, { recursive: true, force: true });
  };
  const handleSignal = (signal) => {
    releaseLockSync();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    return await fn();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await releaseLock();
  }
}

export async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function listFilesRecursive(rootPath) {
  if (!(await fileExists(rootPath))) return [];
  const stats = await fs.stat(rootPath);
  if (stats.isFile()) {
    return isMetadataFileName(path.basename(rootPath)) ? [] : [rootPath];
  }
  const results = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreFsEntry(entry.name, { isDirectory: entry.isDirectory() })) {
        continue;
      }
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else {
        results.push(absolutePath);
      }
    }
  }

  await walk(rootPath);
  return results.sort();
}

export async function collectFiles(rootPath, extensions = []) {
  const stats = await fs.stat(rootPath);
  if (stats.isFile()) {
    return shouldIgnoreFsEntry(path.basename(rootPath), { isDirectory: false }) ? [] : [rootPath];
  }

  const extensionSet = new Set(extensions.map((value) => value.toLowerCase()));
  const results = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreFsEntry(entry.name, { isDirectory: entry.isDirectory() })) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!extensionSet.size || extensionSet.has(path.extname(entry.name).toLowerCase())) {
        results.push(absolutePath);
      }
    }
  }

  await walk(rootPath);
  return results.sort();
}
