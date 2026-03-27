import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, readJson, withFileLock, writeJson } from '../lib/fs.js';
import { stableHash, unique } from '../lib/utils.js';
import { getCorpusPaths } from './corpus-store.js';

const AUTHORITATIVE_SYNC_QUEUE_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'superseded']);

function createEmptyQueue() {
  return {
    version: AUTHORITATIVE_SYNC_QUEUE_VERSION,
    jobs: []
  };
}

function normalizeChangedSourceKeys(changedSourceKeys) {
  return unique((Array.isArray(changedSourceKeys) ? changedSourceKeys : []).filter(Boolean)).sort();
}

function createJobId(payload) {
  const seed = JSON.stringify({
    rootPath: payload.rootPath,
    baseManifestToken: payload.baseManifestToken || null,
    targetManifestToken: payload.targetManifestToken || null,
    changedSourceKeys: normalizeChangedSourceKeys(payload.changedSourceKeys),
    createdAt: payload.createdAt
  });
  return `sync:${stableHash(seed, 18)}`;
}

async function loadQueue(rootPath) {
  const { authoritativeSyncQueuePath } = getCorpusPaths(rootPath);
  return (await readJson(authoritativeSyncQueuePath, null)) || createEmptyQueue();
}

async function saveQueue(rootPath, queue) {
  const { authoritativeSyncDir, authoritativeSyncQueuePath } = getCorpusPaths(rootPath);
  await ensureDir(authoritativeSyncDir);
  await writeJson(authoritativeSyncQueuePath, queue);
}

function getJobPath(rootPath, jobId) {
  const { authoritativeSyncJobsDir } = getCorpusPaths(rootPath);
  return path.join(authoritativeSyncJobsDir, `${jobId}.json`);
}

function getHistoryPath(rootPath, jobId) {
  const { authoritativeSyncHistoryDir } = getCorpusPaths(rootPath);
  return path.join(authoritativeSyncHistoryDir, `${jobId}.json`);
}

async function saveJob(rootPath, job) {
  const { authoritativeSyncJobsDir } = getCorpusPaths(rootPath);
  await ensureDir(authoritativeSyncJobsDir);
  await writeJson(getJobPath(rootPath, job.jobId), job);
}

async function writeHistory(rootPath, job) {
  const { authoritativeSyncHistoryDir } = getCorpusPaths(rootPath);
  await ensureDir(authoritativeSyncHistoryDir);
  await writeJson(getHistoryPath(rootPath, job.jobId), job);
}

function normalizeJob(rootPath, payload, now) {
  const base = {
    rootPath,
    baseManifestToken: payload.baseManifestToken || null,
    targetManifestToken: payload.targetManifestToken || null,
    changedSourceKeys: normalizeChangedSourceKeys(payload.changedSourceKeys),
    mode: payload.mode || 'delta',
    status: payload.status || 'queued',
    createdAt: payload.createdAt || now,
    updatedAt: payload.updatedAt || now,
    deltaPayload: payload.deltaPayload || null
  };
  return {
    ...payload,
    ...base,
    jobId: payload.jobId || createJobId({ ...payload, ...base })
  };
}

function mergeChangedSourceKeys(left = [], right = []) {
  return normalizeChangedSourceKeys([...left, ...right]);
}

export async function enqueueAuthoritativeSyncJob(rootPath, payload) {
  const normalizedRootPath = path.resolve(rootPath);
  const { authoritativeSyncLockPath } = getCorpusPaths(normalizedRootPath);

  return withFileLock(authoritativeSyncLockPath, async () => {
    const queue = await loadQueue(normalizedRootPath);
    const now = new Date().toISOString();
    const existing = queue.jobs.find((job) => (
      job.targetManifestToken === (payload.targetManifestToken || null)
      && !TERMINAL_STATUSES.has(job.status)
    ));

    if (existing) {
      existing.changedSourceKeys = mergeChangedSourceKeys(existing.changedSourceKeys, payload.changedSourceKeys);
      if (payload.deltaPayload) {
        existing.deltaPayload = payload.deltaPayload;
      }
      existing.updatedAt = now;
      await saveQueue(normalizedRootPath, queue);
      await saveJob(normalizedRootPath, existing);
      return existing;
    }

    const job = normalizeJob(normalizedRootPath, payload, now);
    queue.jobs.push(job);
    await saveQueue(normalizedRootPath, queue);
    await saveJob(normalizedRootPath, job);
    return job;
  });
}

export async function listAuthoritativeSyncJobs(rootPath) {
  const normalizedRootPath = path.resolve(rootPath);
  const queue = await loadQueue(normalizedRootPath);
  return queue.jobs;
}

export async function reserveNextAuthoritativeSyncJob(rootPath, options = {}) {
  const normalizedRootPath = path.resolve(rootPath);
  const { authoritativeSyncLockPath } = getCorpusPaths(normalizedRootPath);

  return withFileLock(authoritativeSyncLockPath, async () => {
    const queue = await loadQueue(normalizedRootPath);
    const nextJob = queue.jobs.find((job) => job.status === 'queued');
    if (!nextJob) {
      return null;
    }

    nextJob.status = 'running';
    nextJob.workerId = options.workerId || null;
    nextJob.reservedAt = new Date().toISOString();
    nextJob.updatedAt = nextJob.reservedAt;
    await saveQueue(normalizedRootPath, queue);
    await saveJob(normalizedRootPath, nextJob);
    return nextJob;
  });
}

export async function completeAuthoritativeSyncJob(rootPath, jobId, details = {}) {
  const normalizedRootPath = path.resolve(rootPath);
  const { authoritativeSyncLockPath } = getCorpusPaths(normalizedRootPath);

  return withFileLock(authoritativeSyncLockPath, async () => {
    const queue = await loadQueue(normalizedRootPath);
    const index = queue.jobs.findIndex((job) => job.jobId === jobId);
    const current = index >= 0
      ? queue.jobs[index]
      : await readJson(getJobPath(normalizedRootPath, jobId), null);

    if (!current) {
      throw new Error(`Unknown authoritative sync job "${jobId}".`);
    }

    const completedAt = new Date().toISOString();
    const completed = {
      ...current,
      ...details,
      status: 'completed',
      completedAt,
      updatedAt: completedAt
    };

    if (index >= 0) {
      queue.jobs.splice(index, 1);
      await saveQueue(normalizedRootPath, queue);
    }
    await saveJob(normalizedRootPath, completed);
    await writeHistory(normalizedRootPath, completed);
    return completed;
  });
}

export async function failAuthoritativeSyncJob(rootPath, jobId, error) {
  const normalizedRootPath = path.resolve(rootPath);
  const { authoritativeSyncLockPath } = getCorpusPaths(normalizedRootPath);

  return withFileLock(authoritativeSyncLockPath, async () => {
    const queue = await loadQueue(normalizedRootPath);
    const index = queue.jobs.findIndex((job) => job.jobId === jobId);
    const current = index >= 0
      ? queue.jobs[index]
      : await readJson(getJobPath(normalizedRootPath, jobId), null);

    if (!current) {
      throw new Error(`Unknown authoritative sync job "${jobId}".`);
    }

    const failedAt = new Date().toISOString();
    const failed = {
      ...current,
      status: 'failed',
      error: error
        ? {
            message: error.message || String(error),
            name: error.name || 'Error'
          }
        : null,
      failedAt,
      updatedAt: failedAt
    };

    if (index >= 0) {
      queue.jobs.splice(index, 1);
      await saveQueue(normalizedRootPath, queue);
    }
    await saveJob(normalizedRootPath, failed);
    await writeHistory(normalizedRootPath, failed);
    return failed;
  });
}

export async function listAuthoritativeSyncHistory(rootPath) {
  const normalizedRootPath = path.resolve(rootPath);
  const { authoritativeSyncHistoryDir } = getCorpusPaths(normalizedRootPath);
  try {
    const fileNames = (await fs.readdir(authoritativeSyncHistoryDir))
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();
    const records = await Promise.all(
      fileNames.map((fileName) => readJson(path.join(authoritativeSyncHistoryDir, fileName), null))
    );
    return records.filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
