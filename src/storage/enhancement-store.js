import path from 'node:path';
import { withFileLock, readJson, writeJson, fileExists, removePath } from '../lib/fs.js';
import { stableHash, unique } from '../lib/utils.js';
import { getCorpusPaths, loadSemanticPaperSnapshot, loadSourceManifest } from './corpus-store.js';

const ENHANCEMENT_SCHEMA_VERSION = 1;
const DEFAULT_OVERLAY_KINDS = ['theory', 'storyline', 'reflection'];
const MAX_JOB_HISTORY = 240;

function sortJobs(jobs = []) {
  return [...jobs].sort((left, right) => {
    const priorityDelta = Number(right.priority || 0) - Number(left.priority || 0);
    if (priorityDelta) return priorityDelta;

    const leftTime = Date.parse(left.enqueuedAt || 0) || 0;
    const rightTime = Date.parse(right.enqueuedAt || 0) || 0;
    return leftTime - rightTime;
  });
}

function normalizeOverlayKinds(value) {
  const items = Array.isArray(value) ? value : DEFAULT_OVERLAY_KINDS;
  const normalized = unique(items.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  return normalized.filter((item) => DEFAULT_OVERLAY_KINDS.includes(item));
}

function createEmptyQueue() {
  return {
    version: ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function createEmptyIndex() {
  return {
    version: ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    papers: {}
  };
}

function trimJobHistory(jobs = []) {
  const completed = [];
  const active = [];

  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'running') active.push(job);
    else completed.push(job);
  }

  completed.sort((left, right) => {
    const leftTime = Date.parse(left.finishedAt || left.updatedAt || left.enqueuedAt || 0) || 0;
    const rightTime = Date.parse(right.finishedAt || right.updatedAt || right.enqueuedAt || 0) || 0;
    return rightTime - leftTime;
  });

  return [...active, ...completed.slice(0, Math.max(0, MAX_JOB_HISTORY - active.length))];
}

function createJobId(entry, overlayKinds) {
  return `enh:${stableHash(`${entry.paperId}:${entry.sourceFingerprint}:${overlayKinds.join(',')}`, 18)}`;
}

function summarizePaperOverlay(overlay) {
  return {
    theory: {
      confidence: overlay?.overlays?.theory?.confidence ?? null,
      cardCount: overlay?.overlays?.theory?.cards?.length || 0,
      riskCount: overlay?.overlays?.theory?.risks?.length || 0
    },
    storyline: {
      confidence: overlay?.overlays?.storyline?.confidence ?? null,
      beatCount: overlay?.overlays?.storyline?.beats?.length || 0,
      riskCount: overlay?.overlays?.storyline?.risks?.length || 0
    },
    reflection: {
      confidence: overlay?.overlays?.reflection?.confidence ?? null,
      innovationCount: overlay?.overlays?.reflection?.slots?.innovations?.length || 0,
      experimentCount: overlay?.overlays?.reflection?.slots?.experiments?.length || 0,
      reflectionCount: overlay?.overlays?.reflection?.slots?.reflections?.length || 0,
      riskCount: overlay?.overlays?.reflection?.risks?.length || 0
    }
  };
}

function combineStampParts(parts) {
  return parts.join('|');
}

function buildFreshness(indexEntry, manifestByPaperId) {
  if (!indexEntry?.activeRunId) return 'missing';

  const manifestEntry = manifestByPaperId.get(indexEntry.paperId);
  if (!manifestEntry) return 'orphaned';
  return manifestEntry.fingerprint === indexEntry.activeSourceFingerprint ? 'fresh' : 'stale';
}

function isActiveManifestEntry(entry) {
  return entry?.activeInGraph !== false;
}

function isJobSatisfiedByIndex(job, indexEntry) {
  if (!indexEntry?.activeRunId) return false;
  if (indexEntry.activeSourceFingerprint !== job.sourceFingerprint) return false;
  const requestedKinds = normalizeOverlayKinds(job.overlayKinds);
  return requestedKinds.every((kind) => (indexEntry.activeOverlayKinds || []).includes(kind));
}

export function getEnhancementPaths(rootPath) {
  const { corpusDir } = getCorpusPaths(rootPath);
  const enhancementDir = path.join(corpusDir, 'enhancements');
  return {
    enhancementDir,
    queuePath: path.join(enhancementDir, 'queue.json'),
    indexPath: path.join(enhancementDir, 'index.json'),
    overlaysDir: path.join(enhancementDir, 'papers'),
    queueLockPath: path.join(rootPath, '.papernexus-enhancements.lock'),
    workerLockPath: path.join(rootPath, '.papernexus-enhancement-worker.lock')
  };
}

export function getPaperEnhancementPath(rootPath, paperId) {
  return path.join(getEnhancementPaths(rootPath).overlaysDir, `${stableHash(paperId, 20)}.json`);
}

export function getEnhancementStampPaths(rootPath) {
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  return { queuePath, indexPath };
}

export async function loadEnhancementQueue(rootPath) {
  const { queuePath } = getEnhancementPaths(rootPath);
  const queue = (await readJson(queuePath, createEmptyQueue())) || createEmptyQueue();
  return {
    version: queue.version || ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date(0).toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  };
}

export async function loadEnhancementIndex(rootPath) {
  const { indexPath } = getEnhancementPaths(rootPath);
  const index = (await readJson(indexPath, createEmptyIndex())) || createEmptyIndex();
  return {
    version: index.version || ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date(0).toISOString(),
    papers: index.papers && typeof index.papers === 'object' ? index.papers : {}
  };
}

async function saveEnhancementQueue(rootPath, queue) {
  const { queuePath } = getEnhancementPaths(rootPath);
  await writeJson(queuePath, {
    version: ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date().toISOString(),
    jobs: trimJobHistory(queue.jobs || [])
  });
}

async function saveEnhancementIndex(rootPath, index) {
  const { indexPath } = getEnhancementPaths(rootPath);
  await writeJson(indexPath, {
    version: ENHANCEMENT_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date().toISOString(),
    papers: index.papers || {}
  });
}

function buildQueueSummary(queue) {
  const summary = {
    total: queue.jobs.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    stale: 0
  };

  for (const job of queue.jobs) {
    if (summary[job.status] !== undefined) {
      summary[job.status] += 1;
    }
  }

  return summary;
}

export async function summarizeEnhancements(rootPath) {
  const [queue, index, manifest] = await Promise.all([
    loadEnhancementQueue(rootPath),
    loadEnhancementIndex(rootPath),
    loadSourceManifest(rootPath)
  ]);

  const manifestByPaperId = new Map(
    (manifest?.sources || [])
      .filter(isActiveManifestEntry)
      .map((entry) => [entry.paperId, entry])
  );
  let ready = 0;
  let stale = 0;
  let failed = 0;
  const papers = Object.values(index.papers)
    .sort((left, right) => left.paperTitle.localeCompare(right.paperTitle))
    .map((entry) => {
      const freshness = buildFreshness(entry, manifestByPaperId);
      if (entry.activeRunId) ready += 1;
      if (freshness === 'stale') stale += 1;
      if (entry.lastError && !entry.activeRunId) failed += 1;

      return {
        paperId: entry.paperId,
        paperTitle: entry.paperTitle,
        sourceKey: entry.sourceKey,
        freshness,
        updatedAt: entry.updatedAt || null,
        lastSuccessfulAt: entry.lastSuccessfulAt || null,
        lastFailedAt: entry.lastFailedAt || null,
        lastError: entry.lastError || null,
        theory: entry.theory || {},
        storyline: entry.storyline || {},
        reflection: entry.reflection || {}
      };
    });

  return {
    queue: buildQueueSummary(queue),
    ready,
    stale,
    failed,
    papers
  };
}

export async function enqueuePaperEnhancements(rootPath, entries, options = {}) {
  const { queueLockPath } = getEnhancementPaths(rootPath);
  const normalizedEntries = Array.isArray(entries) ? entries : [];

  return withFileLock(queueLockPath, async () => {
    const [queue, index] = await Promise.all([
      loadEnhancementQueue(rootPath),
      loadEnhancementIndex(rootPath)
    ]);

    let queuedCount = 0;
    const now = new Date().toISOString();
    const overlayKinds = normalizeOverlayKinds(options.overlayKinds);

    for (const entry of normalizedEntries) {
      if (!entry?.paperId || !entry?.sourceFingerprint || !entry?.sourceKey) continue;

      const requestedKinds = normalizeOverlayKinds(entry.overlayKinds || overlayKinds);
      if (!requestedKinds.length) continue;

      const currentIndex = index.papers?.[entry.paperId];
      const alreadyReady = currentIndex?.activeRunId
        && currentIndex.activeSourceFingerprint === entry.sourceFingerprint
        && requestedKinds.every((kind) => (currentIndex.activeOverlayKinds || []).includes(kind));

      if (alreadyReady && !options.force) {
        continue;
      }

      const existing = queue.jobs.find((job) => {
        return job.paperId === entry.paperId
          && job.sourceFingerprint === entry.sourceFingerprint
          && (job.status === 'pending' || job.status === 'running');
      });

      if (existing) {
        existing.priority = Math.max(Number(existing.priority || 0), Number(entry.priority || options.priority || 50));
        existing.updatedAt = now;
        existing.trigger = entry.trigger || options.trigger || existing.trigger || 'ingestion';
        existing.overlayKinds = unique([...(existing.overlayKinds || []), ...requestedKinds]);
        continue;
      }

      queue.jobs.push({
        id: createJobId(entry, requestedKinds),
        paperId: entry.paperId,
        paperTitle: entry.paperTitle || entry.paperId,
        sourceKey: entry.sourceKey,
        sourceFingerprint: entry.sourceFingerprint,
        sourceMarkdownPath: entry.sourceMarkdownPath || '',
        overlayKinds: requestedKinds,
        priority: Number(entry.priority || options.priority || 50),
        trigger: entry.trigger || options.trigger || 'ingestion',
        stage: entry.stage || options.stage || '',
        status: 'pending',
        attempts: 0,
        enqueuedAt: now,
        updatedAt: now
      });
      queuedCount += 1;
    }

    queue.jobs = trimJobHistory(queue.jobs);
    queue.updatedAt = now;
    await saveEnhancementQueue(rootPath, queue);

    return {
      queuedCount,
      queue: buildQueueSummary(queue)
    };
  });
}

export async function reserveNextEnhancementJob(rootPath) {
  const { queueLockPath } = getEnhancementPaths(rootPath);

  return withFileLock(queueLockPath, async () => {
    const [queue, index, manifest] = await Promise.all([
      loadEnhancementQueue(rootPath),
      loadEnhancementIndex(rootPath),
      loadSourceManifest(rootPath)
    ]);
    const activeEntries = (manifest?.sources || []).filter(isActiveManifestEntry);
    const manifestByPaperId = new Map(activeEntries.map((entry) => [entry.paperId, entry]));
    const manifestBySourceKey = new Map(activeEntries.map((entry) => [entry.sourceKey, entry]));
    const now = new Date().toISOString();
    let queueChanged = false;

    for (const nextJob of sortJobs(queue.jobs)) {
      if (nextJob.status !== 'pending') continue;

      const job = queue.jobs.find((entry) => entry.id === nextJob.id);
      const manifestEntry = manifestBySourceKey.get(job.sourceKey) || manifestByPaperId.get(job.paperId) || null;

      if (!manifestEntry || manifestEntry.fingerprint !== job.sourceFingerprint) {
        job.status = 'stale';
        job.finishedAt = now;
        job.updatedAt = now;
        job.lastError = manifestEntry
          ? 'Skipped because the enhancement source fingerprint changed.'
          : 'Skipped because the enhancement source is no longer active in the manifest.';
        queueChanged = true;
        continue;
      }

      const indexEntry = index.papers?.[job.paperId] || null;
      if (isJobSatisfiedByIndex(job, indexEntry)) {
        job.status = 'completed';
        job.finishedAt = now;
        job.updatedAt = now;
        job.lastError = null;
        job.result = {
          reusedExisting: true
        };
        queueChanged = true;
        continue;
      }

      job.status = 'running';
      job.attempts = Number(job.attempts || 0) + 1;
      job.startedAt = now;
      job.updatedAt = now;
      queue.updatedAt = now;
      await saveEnhancementQueue(rootPath, queue);
      return { job: { ...job } };
    }

    if (queueChanged) {
      queue.updatedAt = now;
      await saveEnhancementQueue(rootPath, queue);
    }
    return null;
  });
}

export async function completeEnhancementJob(rootPath, jobId, summary = {}) {
  const { queueLockPath } = getEnhancementPaths(rootPath);

  return withFileLock(queueLockPath, async () => {
    const queue = await loadEnhancementQueue(rootPath);
    const job = queue.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;

    const now = new Date().toISOString();
    job.status = 'completed';
    job.finishedAt = now;
    job.updatedAt = now;
    job.lastError = null;
    job.result = summary;
    queue.updatedAt = now;

    await saveEnhancementQueue(rootPath, queue);
    return { ...job };
  });
}

export async function failEnhancementJob(rootPath, jobId, error) {
  const { queueLockPath } = getEnhancementPaths(rootPath);

  return withFileLock(queueLockPath, async () => {
    const queue = await loadEnhancementQueue(rootPath);
    const job = queue.jobs.find((entry) => entry.id === jobId);
    if (!job) return null;

    const now = new Date().toISOString();
    job.status = 'failed';
    job.finishedAt = now;
    job.updatedAt = now;
    job.lastError = String(error?.message || error || 'Unknown enhancement error');
    queue.updatedAt = now;

    await saveEnhancementQueue(rootPath, queue);
    return { ...job };
  });
}

export async function markEnhancementFailure(rootPath, job, error) {
  const { queueLockPath } = getEnhancementPaths(rootPath);

  return withFileLock(queueLockPath, async () => {
    const index = await loadEnhancementIndex(rootPath);
    const existing = index.papers[job.paperId] || {};
    const now = new Date().toISOString();

    index.papers[job.paperId] = {
      ...existing,
      paperId: job.paperId,
      paperTitle: job.paperTitle,
      sourceKey: job.sourceKey,
      sourceMarkdownPath: job.sourceMarkdownPath || existing.sourceMarkdownPath || '',
      lastAttemptAt: now,
      lastFailedAt: now,
      lastError: String(error?.message || error || 'Unknown enhancement error'),
      updatedAt: now
    };
    index.updatedAt = now;

    await saveEnhancementIndex(rootPath, index);
    return index.papers[job.paperId];
  });
}

export async function savePaperEnhancement(rootPath, overlay) {
  const { queueLockPath } = getEnhancementPaths(rootPath);
  const overlayPath = getPaperEnhancementPath(rootPath, overlay.paperId);

  return withFileLock(queueLockPath, async () => {
    const index = await loadEnhancementIndex(rootPath);
    const now = new Date().toISOString();

    await writeJson(overlayPath, overlay);

    const current = index.papers[overlay.paperId] || {};
    index.papers[overlay.paperId] = {
      ...current,
      paperId: overlay.paperId,
      paperTitle: overlay.paperTitle,
      sourceKey: overlay.sourceKey,
      sourceMarkdownPath: overlay.sourceMarkdownPath || current.sourceMarkdownPath || '',
      activeRunId: overlay.runId,
      activeSourceFingerprint: overlay.sourceFingerprint,
      activeOverlayKinds: normalizeOverlayKinds(Object.keys(overlay.overlays || {})),
      activeOverlayPath: path.relative(getEnhancementPaths(rootPath).enhancementDir, overlayPath),
      updatedAt: now,
      lastAttemptAt: now,
      lastSuccessfulAt: now,
      lastFailedAt: current.lastFailedAt || null,
      lastError: null,
      ...summarizePaperOverlay(overlay)
    };
    index.updatedAt = now;

    await saveEnhancementIndex(rootPath, index);
    return index.papers[overlay.paperId];
  });
}

export async function loadPaperEnhancement(rootPath, paperId) {
  const index = await loadEnhancementIndex(rootPath);
  const entry = index.papers[paperId] || null;
  const overlayPath = entry?.activeOverlayPath
    ? path.join(getEnhancementPaths(rootPath).enhancementDir, entry.activeOverlayPath)
    : getPaperEnhancementPath(rootPath, paperId);
  const overlay = await readJson(overlayPath, null);

  return {
    entry,
    overlay
  };
}

export async function pruneEnhancementsForManifest(rootPath, manifestSources = []) {
  const { queueLockPath, enhancementDir } = getEnhancementPaths(rootPath);
  const validPaperIds = new Set(manifestSources.map((entry) => entry.paperId).filter(Boolean));
  const validSourceKeys = new Set(manifestSources.map((entry) => entry.sourceKey).filter(Boolean));

  return withFileLock(queueLockPath, async () => {
    const [queue, index] = await Promise.all([
      loadEnhancementQueue(rootPath),
      loadEnhancementIndex(rootPath)
    ]);

    let removedOverlays = 0;
    for (const [paperId, entry] of Object.entries(index.papers)) {
      if (validPaperIds.has(paperId) || validSourceKeys.has(entry.sourceKey)) continue;

      if (entry.activeOverlayPath) {
        await removePath(path.join(enhancementDir, entry.activeOverlayPath));
        removedOverlays += 1;
      }
      delete index.papers[paperId];
    }

    const now = new Date().toISOString();
    for (const job of queue.jobs) {
      if (validPaperIds.has(job.paperId) || validSourceKeys.has(job.sourceKey)) continue;
      if (job.status === 'pending' || job.status === 'running') {
        job.status = 'stale';
        job.finishedAt = now;
        job.updatedAt = now;
      }
    }

    queue.updatedAt = now;
    index.updatedAt = now;
    await Promise.all([
      saveEnhancementQueue(rootPath, queue),
      saveEnhancementIndex(rootPath, index)
    ]);

    return {
      removedOverlays
    };
  });
}

export async function enqueueEnhancementBackfill(rootPath, options = {}) {
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest?.sources?.length) {
    return { queuedCount: 0 };
  }

  const [queue, index] = await Promise.all([
    loadEnhancementQueue(rootPath),
    loadEnhancementIndex(rootPath)
  ]);

  const candidates = [];
  const limit = Math.max(1, Number(options.limit || 2));

  for (const entry of manifest.sources.filter(isActiveManifestEntry)) {
    const current = index.papers?.[entry.paperId];
    const alreadyReady = current?.activeRunId
      && current.activeSourceFingerprint === entry.fingerprint
      && DEFAULT_OVERLAY_KINDS.every((kind) => (current.activeOverlayKinds || []).includes(kind));
    if (alreadyReady) continue;

    const alreadyQueued = queue.jobs.some((job) => {
      return job.paperId === entry.paperId
        && job.sourceFingerprint === entry.fingerprint
        && (job.status === 'pending' || job.status === 'running');
    });
    if (alreadyQueued) continue;

    candidates.push({
      paperId: entry.paperId,
      paperTitle: entry.paperTitle,
      sourceKey: entry.sourceKey,
      sourceFingerprint: entry.fingerprint,
      sourceMarkdownPath: entry.sourceMarkdownPath,
      priority: Number(options.priority || 15),
      trigger: options.trigger || 'backfill',
      overlayKinds: options.overlayKinds || DEFAULT_OVERLAY_KINDS
    });

    if (candidates.length >= limit) break;
  }

  if (!candidates.length) {
    return { queuedCount: 0 };
  }

  return enqueuePaperEnhancements(rootPath, candidates, {
    priority: Number(options.priority || 15),
    trigger: options.trigger || 'backfill',
    overlayKinds: options.overlayKinds || DEFAULT_OVERLAY_KINDS
  });
}

export async function resolveEnhancementJobPaper(rootPath, job) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestEntry = (manifest?.sources || []).find((entry) => {
    return isActiveManifestEntry(entry) && (entry.sourceKey === job.sourceKey || entry.paperId === job.paperId);
  }) || null;

  if (!manifestEntry) {
    return {
      manifestEntry: null,
      semanticPaper: null
    };
  }

  const semanticPaper = await loadSemanticPaperSnapshot(rootPath, manifestEntry.sourceKey);
  return {
    manifestEntry,
    semanticPaper
  };
}

export async function readEnhancementStamp(rootPath) {
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  const [queueExists, indexExists] = await Promise.all([
    fileExists(queuePath),
    fileExists(indexPath)
  ]);

  return combineStampParts([
    queueExists ? queuePath : 'queue:missing',
    indexExists ? indexPath : 'index:missing'
  ]);
}
