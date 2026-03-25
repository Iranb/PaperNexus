import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileExists, readJson, writeJson } from './fs.js';

const DEFAULT_CONFIG_FILE = 'config.json';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT_DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, DEFAULT_CONFIG_FILE);

function normalizeConfig(value, sourcePath) {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Config file must contain a JSON object: ${sourcePath}`);
  }

  return value;
}

function resolvePapernexusHome() {
  if (process.env.PAPERNEXUS_HOME) {
    return resolvePathWithHome(process.env.PAPERNEXUS_HOME);
  }

  return path.join(os.homedir(), '.papernexus');
}

export function resolvePathWithHome(value, baseDir = process.cwd()) {
  const raw = String(value || '').trim();
  if (!raw) return path.resolve(baseDir);
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(baseDir, raw);
}

export function getDefaultRuntimeConfigRoot() {
  return resolvePapernexusHome();
}

export function getDefaultRuntimeConfigPath() {
  return path.join(getDefaultRuntimeConfigRoot(), DEFAULT_CONFIG_FILE);
}

async function ensureDefaultRuntimeConfig() {
  const defaultConfigPath = getDefaultRuntimeConfigPath();
  if (await fileExists(defaultConfigPath)) {
    return defaultConfigPath;
  }

  if (!(await fileExists(PROJECT_DEFAULT_CONFIG_PATH))) {
    return null;
  }

  const projectConfig = normalizeConfig(await readJson(PROJECT_DEFAULT_CONFIG_PATH), PROJECT_DEFAULT_CONFIG_PATH);
  await writeJson(defaultConfigPath, projectConfig);
  return defaultConfigPath;
}

export async function loadRuntimeConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const disabled = Boolean(options.disabled);
  const explicitPath = options.path ? resolvePathWithHome(options.path, cwd) : null;

  if (disabled) {
    return { config: {}, path: null };
  }

  const defaultRuntimeConfigPath = explicitPath ? getDefaultRuntimeConfigPath() : await ensureDefaultRuntimeConfig();
  const searchPaths = explicitPath
    ? [explicitPath]
    : [
        defaultRuntimeConfigPath,
        path.join(cwd, DEFAULT_CONFIG_FILE)
      ].filter(Boolean);
  let candidatePath = null;

  for (const searchPath of searchPaths) {
    if (await fileExists(searchPath)) {
      candidatePath = searchPath;
      break;
    }
  }

  if (!candidatePath) {
    if (explicitPath) {
      throw new Error(`Config file not found: ${explicitPath}`);
    }
    return { config: {}, path: null };
  }

  try {
    const config = normalizeConfig(await readJson(candidatePath), candidatePath);
    return { config, path: candidatePath };
  } catch (error) {
    throw new Error(`Failed to load config file ${candidatePath}: ${error.message}`);
  }
}

export async function saveRuntimeConfig(config, options = {}) {
  const cwd = options.cwd || process.cwd();
  const explicitPath = options.path ? resolvePathWithHome(options.path, cwd) : null;
  const targetPath = explicitPath || getDefaultRuntimeConfigPath();
  await writeJson(targetPath, normalizeConfig(config, targetPath));
  return {
    config,
    path: targetPath
  };
}

export function applyProcessConfig(config, baseDir = process.cwd()) {
  const storageConfig = config?.storage;
  if (!storageConfig || typeof storageConfig !== 'object' || Array.isArray(storageConfig)) {
    return;
  }

  if (typeof storageConfig.home === 'string' && storageConfig.home.trim()) {
    process.env.PAPERNEXUS_HOME = resolvePathWithHome(storageConfig.home.trim(), baseDir);
  }
}
