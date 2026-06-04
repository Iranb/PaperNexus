import path from 'node:path';
import { ensureDir, readJson, writeJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const LONG_CONTEXT_ARTIFACT_STORE_VERSION = 1;
export const LONG_CONTEXT_ARTIFACT_CONTRACT_VERSION = 'papernexus-long-context-llm-artifact-v1';

function nowIso() {
  return new Date().toISOString();
}

function normalizeArtifactKey(value) {
  const text = String(value || '').trim();
  return text || stableHash('', 32);
}

function normalizePhase(value) {
  const phase = String(value || '').trim();
  return phase || 'unknown';
}

function normalizeStatus(value) {
  const status = String(value || '').trim();
  return status || 'unknown';
}

export function getLongContextArtifactStorePaths(rootPath, artifactKey = '') {
  const resolvedRoot = path.resolve(rootPath);
  const artifactsDir = path.join(resolvedRoot, '.papernexus', 'llm-jobs', 'long-context-artifacts');
  const normalizedArtifactKey = artifactKey ? normalizeArtifactKey(artifactKey) : '';
  const artifactKeyHash = normalizedArtifactKey ? stableHash(normalizedArtifactKey, 32) : '';
  const artifactPath = artifactKeyHash
    ? path.join(artifactsDir, 'records', artifactKeyHash.slice(0, 2), `${artifactKeyHash}.json`)
    : '';

  return {
    rootPath: resolvedRoot,
    artifactsDir,
    recordsDir: path.join(artifactsDir, 'records'),
    lockPath: path.join(artifactsDir, 'long-context-artifacts.lock'),
    artifactKey: normalizedArtifactKey,
    artifactKeyHash,
    artifactPath,
    artifactRelativePath: artifactPath ? path.relative(resolvedRoot, artifactPath) : ''
  };
}

export function createLongContextArtifactKey(seed = {}) {
  return `lc:${stableHash(JSON.stringify({
    contractVersion: LONG_CONTEXT_ARTIFACT_CONTRACT_VERSION,
    ...seed
  }), 32)}`;
}

export async function saveLongContextArtifact(rootPath, artifactKey, payload = {}, options = {}) {
  const normalizedArtifactKey = normalizeArtifactKey(artifactKey || payload.artifactKey);
  const paths = getLongContextArtifactStorePaths(rootPath, normalizedArtifactKey);
  const previous = await readJson(paths.artifactPath, null);
  const updatedAt = options.updatedAt || payload.updatedAt || nowIso();
  const artifact = {
    ...payload,
    version: LONG_CONTEXT_ARTIFACT_STORE_VERSION,
    contractVersion: LONG_CONTEXT_ARTIFACT_CONTRACT_VERSION,
    artifactKey: normalizedArtifactKey,
    artifactKeyHash: paths.artifactKeyHash,
    phase: normalizePhase(payload.phase),
    status: normalizeStatus(payload.status),
    createdAt: previous?.createdAt || payload.createdAt || updatedAt,
    updatedAt
  };

  await ensureDir(path.dirname(paths.artifactPath));
  await writeJson(paths.artifactPath, artifact);

  return {
    contractVersion: LONG_CONTEXT_ARTIFACT_CONTRACT_VERSION,
    artifactKey: normalizedArtifactKey,
    artifactKeyHash: paths.artifactKeyHash,
    artifactPath: paths.artifactRelativePath,
    phase: artifact.phase,
    status: artifact.status,
    updatedAt
  };
}

export async function loadLongContextArtifact(rootPath, artifactKey) {
  const paths = getLongContextArtifactStorePaths(rootPath, artifactKey);
  if (!paths.artifactPath) return null;
  return readJson(paths.artifactPath, null);
}
