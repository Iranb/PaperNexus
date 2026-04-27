import path from 'node:path';
import { ensureDir, readJson, withFileLock, writeJson } from '../lib/fs.js';
import { getDefaultRuntimeConfigRoot, resolvePathWithHome } from '../lib/config.js';

const STORE_VERSION = 1;

function resolveStatePath() {
  const override = String(process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH || '').trim();
  if (override) {
    return resolvePathWithHome(override);
  }
  return path.join(getDefaultRuntimeConfigRoot(), 'llm-rate-limits.json');
}

function resolveLockPath(statePath) {
  return `${statePath}.lock`;
}

function normalizeEntry(entry = {}, nowMs = Date.now()) {
  const key = String(entry.key || '').trim();
  const untilMs = Number(entry.untilMs || Date.parse(String(entry.until || '')) || 0);
  if (!key || !Number.isFinite(untilMs) || untilMs <= nowMs) {
    return null;
  }

  return {
    key,
    provider: String(entry.provider || '').trim(),
    baseUrl: String(entry.baseUrl || '').trim(),
    untilMs,
    until: new Date(untilMs).toISOString(),
    statusCode: Number(entry.statusCode || 429),
    message: String(entry.message || '')
  };
}

function normalizePayload(payload = {}, nowMs = Date.now()) {
  const entries = Array.isArray(payload.cooldowns)
    ? payload.cooldowns
    : Object.entries(payload.cooldowns || {}).map(([key, value]) => ({ key, ...value }));

  return {
    version: STORE_VERSION,
    updatedAt: payload.updatedAt || null,
    cooldowns: entries
      .map((entry) => normalizeEntry(entry, nowMs))
      .filter(Boolean)
  };
}

export function getLlmRateLimitStatePath() {
  return resolveStatePath();
}

export async function loadLlmRateLimitCooldowns(nowMs = Date.now()) {
  try {
    const payload = await readJson(resolveStatePath(), { version: STORE_VERSION, cooldowns: [] });
    return normalizePayload(payload, nowMs).cooldowns;
  } catch {
    return [];
  }
}

export async function saveLlmRateLimitCooldown(entry = {}) {
  const statePath = resolveStatePath();
  const lockPath = resolveLockPath(statePath);
  await ensureDir(path.dirname(statePath));

  return withFileLock(lockPath, async () => {
    const nowMs = Date.now();
    const payload = normalizePayload(
      await readJson(statePath, { version: STORE_VERSION, cooldowns: [] }),
      nowMs
    );
    const nextEntry = normalizeEntry(entry, nowMs);
    const byKey = new Map(payload.cooldowns.map((item) => [item.key, item]));
    if (nextEntry) {
      byKey.set(nextEntry.key, nextEntry);
    }

    const nextPayload = {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      cooldowns: [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key))
    };
    await writeJson(statePath, nextPayload);
    return nextEntry;
  });
}

export async function clearLlmRateLimitCooldownStore() {
  const statePath = resolveStatePath();
  const lockPath = resolveLockPath(statePath);
  await ensureDir(path.dirname(statePath));

  await withFileLock(lockPath, async () => {
    await writeJson(statePath, {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      cooldowns: []
    });
  });
}
