import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, readJson, withFileLock, writeJson } from '../lib/fs.js';
import { resolvePathWithHome } from '../lib/config.js';

function resolveGlobalRoot() {
  if (process.env.PAPERNEXUS_HOME) {
    return resolvePathWithHome(process.env.PAPERNEXUS_HOME);
  }

  const localRoot = path.join(process.cwd(), '.papernexus-home');
  const localRegistry = path.join(localRoot, 'registry.json');
  if (fs.existsSync(localRegistry)) {
    return localRoot;
  }

  const preferred = path.join(os.homedir(), '.papernexus');
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    return localRoot;
  }
}

const GLOBAL_ROOT = resolveGlobalRoot();
const REGISTRY_PATH = path.join(GLOBAL_ROOT, 'registry.json');
const REGISTRY_LOCK_PATH = path.join(GLOBAL_ROOT, 'registry.lock');

export function getRegistryPath() {
  return REGISTRY_PATH;
}

export async function loadRegistry() {
  return (await readJson(REGISTRY_PATH, { corpora: [] })) || { corpora: [] };
}

export async function saveRegistry(registry) {
  await ensureDir(GLOBAL_ROOT);
  await writeJson(REGISTRY_PATH, registry);
}

export async function registerCorpus(entry) {
  await withFileLock(REGISTRY_LOCK_PATH, async () => {
    const registry = await loadRegistry();
    const filtered = registry.corpora.filter((item) => item.name !== entry.name && item.rootPath !== entry.rootPath);
    filtered.push(entry);
    filtered.sort((left, right) => left.name.localeCompare(right.name));
    await saveRegistry({ corpora: filtered });
  });
}

export async function unregisterCorpus(target) {
  await withFileLock(REGISTRY_LOCK_PATH, async () => {
    const registry = await loadRegistry();
    const filtered = registry.corpora.filter((item) => item.name !== target && item.rootPath !== target);
    await saveRegistry({ corpora: filtered });
  });
}
