import path from 'node:path';
import { getCorpusPaths } from './corpus-store.js';
import { readJson, withFileLock, writeJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const IMPORT_SEMANTIC_QUEUE_VERSION = 1;
const IMPORT_SEMANTIC_PROGRESS_CONTRACT_VERSION = 'import-semantic-enrichment-progress-v1';
const DEFAULT_JOB_MAX_ATTEMPTS = 3;
const DEFAULT_RUNNING_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_JOB_HISTORY = 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped']);

function normalizeStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['pending', 'running', 'completed', 'failed', 'skipped'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeStringArray(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )].sort();
}

function normalizePositiveIntegerOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function normalizeLlmExtractionStrategyOrNull(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['long-context-first', 'chunk-first', 'auto'].includes(normalized)) return normalized;
  return null;
}

function clampProgressPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function normalizeSemanticJobProgress(job = {}, progress = {}) {
  const existing = job.progress && typeof job.progress === 'object' && !Array.isArray(job.progress)
    ? job.progress
    : {};
  const status = normalizeStatus(job.status || existing.status, normalizeStatus(job.status));
  const stage = String(progress.stage || job.stage || existing.stage || 'queued').trim().toLowerCase() || 'queued';
  const totalUnits = Math.max(0, Number(
    progress.totalUnits !== undefined
      ? progress.totalUnits
      : existing.totalUnits || 0
  ) || 0);
  const processedUnits = Math.max(0, Math.min(
    totalUnits || Number.MAX_SAFE_INTEGER,
    Number(
      progress.processedUnits !== undefined
        ? progress.processedUnits
        : existing.processedUnits || 0
    ) || 0
  ));
  const stagePercent = status === 'completed'
    ? 100
    : clampProgressPercent(
      progress.stagePercent !== undefined
        ? progress.stagePercent
        : existing.stagePercent,
      stage === 'queued' ? 0 : 0
    );
  const diagnostics = progress.diagnostics && typeof progress.diagnostics === 'object' && !Array.isArray(progress.diagnostics)
    ? progress.diagnostics
    : (existing.diagnostics && typeof existing.diagnostics === 'object' && !Array.isArray(existing.diagnostics)
      ? existing.diagnostics
      : null);

  return {
    contractVersion: IMPORT_SEMANTIC_PROGRESS_CONTRACT_VERSION,
    status,
    stage,
    currentStep: String(
      progress.currentStep !== undefined
        ? progress.currentStep
        : existing.currentStep || ''
    ).trim() || null,
    message: String(
      progress.message !== undefined
        ? progress.message
        : existing.message || ''
    ).trim() || null,
    stagePercent,
    processedUnits,
    totalUnits,
    updatedAt: new Date().toISOString(),
    ...(diagnostics ? { diagnostics } : {})
  };
}

function createEmptyQueue() {
  return {
    version: IMPORT_SEMANTIC_QUEUE_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function trimJobHistory(jobs = []) {
  const active = [];
  const terminal = [];

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (TERMINAL_STATUSES.has(normalizeStatus(job?.status))) {
      terminal.push(job);
    } else {
      active.push(job);
    }
  }

  terminal.sort((left, right) => {
    const leftTime = Date.parse(left.finishedAt || left.updatedAt || left.enqueuedAt || 0) || 0;
    const rightTime = Date.parse(right.finishedAt || right.updatedAt || right.enqueuedAt || 0) || 0;
    return rightTime - leftTime;
  });

  return [...active, ...terminal.slice(0, Math.max(0, MAX_JOB_HISTORY - active.length))];
}

function sortReservableJobs(jobs = []) {
  return [...jobs].sort((left, right) => {
    const leftPriority = Number(left.priority || 0);
    const rightPriority = Number(right.priority || 0);
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    const leftTime = Date.parse(left.enqueuedAt || left.updatedAt || 0) || 0;
    const rightTime = Date.parse(right.enqueuedAt || right.updatedAt || 0) || 0;
    return leftTime - rightTime;
  });
}

function createSemanticJobReservationGroupKey(job = {}) {
  return JSON.stringify({
    semanticConfigKey: String(job.semanticConfigKey || 'default').trim() || 'default',
    processingProfile: String(job.processingProfile || '').trim() || null,
    completionPolicy: String(job.completionPolicy || '').trim() || null,
    llmContextWindowTokens: job.llmContextWindowTokens || null,
    llmExtractionStrategy: job.llmExtractionStrategy || null,
    llmLongContextMaxPapersPerCall: job.llmLongContextMaxPapersPerCall || null,
    llmBatchConcurrency: job.llmBatchConcurrency || null
  });
}

function reserveSemanticJobForWorker(job, now, options = {}) {
  job.status = 'running';
  job.stage = 'semantic-enrichment';
  job.startedAt = job.startedAt || now;
  job.updatedAt = now;
  job.attempts = Number(job.attempts || 0) + 1;
  job.workerId = String(options.workerId || `pid:${process.pid}`);
  job.error = null;
  job.progress = normalizeSemanticJobProgress(job, {
    status: 'running',
    stage: 'semantic-enrichment',
    currentStep: 'reserved',
    message: 'Reserved background semantic enrichment job'
  });
  return job;
}

function createSemanticJobId(entry = {}) {
  const taskId = String(entry.taskId || '').trim();
  const changedSourceKeys = normalizeStringArray(entry.changedSourceKeys || entry.changed_source_keys);
  const semanticConfigKey = String(entry.semanticConfigKey || entry.semantic_config_key || 'default').trim();
  return `isem:${stableHash(`${taskId}:${changedSourceKeys.join('|')}:${semanticConfigKey}`, 18)}`;
}

function normalizeEntry(entry = {}, options = {}) {
  const taskId = String(entry.taskId || entry.task_id || '').trim();
  const changedSourceKeys = normalizeStringArray(entry.changedSourceKeys || entry.changed_source_keys);
  if (!taskId || !changedSourceKeys.length) return null;

  const now = new Date().toISOString();
  const semanticConfigKey = String(
    options.semanticConfigKey
    || options.semantic_config_key
    || entry.semanticConfigKey
    || entry.semantic_config_key
    || 'default'
  ).trim() || 'default';
  const llmContextWindowTokens = normalizePositiveIntegerOrNull(entry.llmContextWindowTokens || entry.llm_context_window_tokens);
  const llmExtractionStrategy = normalizeLlmExtractionStrategyOrNull(entry.llmExtractionStrategy || entry.llm_extraction_strategy);
  const llmLongContextMaxPapersPerCall = normalizePositiveIntegerOrNull(
    entry.llmLongContextMaxPapersPerCall || entry.llm_long_context_max_papers_per_call
  );
  const llmBatchConcurrency = normalizePositiveIntegerOrNull(entry.llmBatchConcurrency || entry.llm_batch_concurrency);
  const job = {
    id: entry.id || createSemanticJobId({
      ...entry,
      changedSourceKeys,
      semanticConfigKey
    }),
    taskId,
    status: 'pending',
    stage: 'queued',
    processingProfile: String(entry.processingProfile || entry.processing_profile || '').trim() || null,
    completionPolicy: String(entry.completionPolicy || entry.completion_policy || '').trim() || null,
    semanticConfigKey,
    ...(llmContextWindowTokens ? { llmContextWindowTokens } : {}),
    ...(llmExtractionStrategy ? { llmExtractionStrategy } : {}),
    ...(llmLongContextMaxPapersPerCall ? { llmLongContextMaxPapersPerCall } : {}),
    ...(llmBatchConcurrency ? { llmBatchConcurrency } : {}),
    ...(llmContextWindowTokens || llmExtractionStrategy || llmLongContextMaxPapersPerCall || llmBatchConcurrency
      ? {
          llmConfig: {
            ...(llmContextWindowTokens ? { contextWindowTokens: llmContextWindowTokens } : {}),
            ...(llmExtractionStrategy ? { extractionStrategy: llmExtractionStrategy } : {}),
            ...(llmLongContextMaxPapersPerCall ? { longContextMaxPapersPerCall: llmLongContextMaxPapersPerCall } : {}),
            ...(llmBatchConcurrency ? { batchConcurrency: llmBatchConcurrency } : {})
          }
        }
      : {}),
    changedSourceKeys,
    batchId: entry.batchId || entry.batch_id || null,
    batchTaskIds: normalizeStringArray(entry.batchTaskIds || entry.batch_task_ids),
    trigger: String(entry.trigger || options.trigger || 'fast-md-background-semantic').trim(),
    priority: Number(entry.priority ?? options.priority ?? 0) || 0,
    attempts: 0,
    maxAttempts: Math.max(1, Number(entry.maxAttempts || options.maxAttempts || DEFAULT_JOB_MAX_ATTEMPTS) || DEFAULT_JOB_MAX_ATTEMPTS),
    enqueuedAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    workerId: null,
    progress: normalizeSemanticJobProgress({
      status: 'pending',
      stage: 'queued'
    }, {
      status: 'pending',
      stage: 'queued',
      currentStep: 'queued',
      message: 'Queued for background semantic enrichment'
    }),
    result: null,
    error: null
  };
  return job;
}

function summarizeQueue(queue = createEmptyQueue()) {
  const summary = {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    remaining: 0
  };

  for (const job of Array.isArray(queue.jobs) ? queue.jobs : []) {
    const status = normalizeStatus(job?.status);
    summary.total += 1;
    if (summary[status] !== undefined) {
      summary[status] += 1;
    }
  }
  summary.remaining = summary.pending + summary.running;
  return summary;
}

function recoverStaleRunningJobs(queue, options = {}) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const staleMs = Math.max(60_000, Number(options.runningStaleMs || DEFAULT_RUNNING_STALE_MS) || DEFAULT_RUNNING_STALE_MS);
  let changed = false;

  for (const job of queue.jobs || []) {
    if (normalizeStatus(job.status) !== 'running') continue;
    const startedAt = Date.parse(job.startedAt || job.updatedAt || 0) || 0;
    if (!startedAt || now - startedAt < staleMs) continue;
    const attempts = Number(job.attempts || 0);
    const maxAttempts = Math.max(1, Number(job.maxAttempts || DEFAULT_JOB_MAX_ATTEMPTS) || DEFAULT_JOB_MAX_ATTEMPTS);
    if (attempts >= maxAttempts) {
      job.status = 'failed';
      job.stage = 'failed';
      job.finishedAt = nowIso;
      job.error = {
        message: 'Semantic enrichment job exceeded max attempts after stale running recovery'
      };
      job.progress = normalizeSemanticJobProgress(job, {
        status: 'failed',
        stage: 'failed',
        currentStep: 'failed',
        message: job.error.message
      });
    } else {
      job.status = 'pending';
      job.stage = 'queued';
      job.startedAt = null;
      job.workerId = null;
      job.error = {
        message: 'Recovered stale running semantic enrichment job'
      };
      job.progress = normalizeSemanticJobProgress(job, {
        status: 'pending',
        stage: 'queued',
        currentStep: 'retry scheduled',
        message: job.error.message
      });
    }
    job.updatedAt = nowIso;
    changed = true;
  }

  return changed;
}

export function getImportSemanticEnrichmentPaths(rootPath) {
  const { corpusDir } = getCorpusPaths(rootPath);
  const semanticDir = path.join(corpusDir, 'imports', 'semantic-enrichment');
  return {
    semanticDir,
    queuePath: path.join(semanticDir, 'queue.json'),
    queueLockPath: path.join(rootPath, '.papernexus-import-semantic-enrichment.lock'),
    workerLockPath: path.join(rootPath, '.papernexus-import-semantic-enrichment-worker.lock')
  };
}

export async function loadImportSemanticEnrichmentQueue(rootPath) {
  const { queuePath } = getImportSemanticEnrichmentPaths(rootPath);
  const queue = (await readJson(queuePath, createEmptyQueue())) || createEmptyQueue();
  return {
    version: queue.version || IMPORT_SEMANTIC_QUEUE_VERSION,
    updatedAt: queue.updatedAt || new Date(0).toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  };
}

async function saveImportSemanticEnrichmentQueue(rootPath, queue) {
  const { queuePath } = getImportSemanticEnrichmentPaths(rootPath);
  await writeJson(queuePath, {
    version: IMPORT_SEMANTIC_QUEUE_VERSION,
    updatedAt: queue.updatedAt || new Date().toISOString(),
    jobs: trimJobHistory(queue.jobs || [])
  });
}

export async function listImportSemanticEnrichmentJobs(rootPath) {
  const queue = await loadImportSemanticEnrichmentQueue(rootPath);
  return {
    updatedAt: queue.updatedAt,
    summary: summarizeQueue(queue),
    jobs: [...queue.jobs].sort((left, right) => {
      const leftTime = Date.parse(left.enqueuedAt || left.updatedAt || 0) || 0;
      const rightTime = Date.parse(right.enqueuedAt || right.updatedAt || 0) || 0;
      return rightTime - leftTime;
    })
  };
}

export async function enqueueImportSemanticEnrichmentJobs(rootPath, entries = [], options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeEntry(entry, options))
    .filter(Boolean);

  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const byId = new Map((queue.jobs || []).map((job) => [job.id, job]));
    const queuedJobs = [];
    const existingJobs = [];
    const now = new Date().toISOString();

    for (const job of normalizedEntries) {
      const existing = byId.get(job.id);
      if (existing && !TERMINAL_STATUSES.has(normalizeStatus(existing.status))) {
        existingJobs.push(existing);
        continue;
      }
      if (existing && normalizeStatus(existing.status) === 'completed' && options.force !== true) {
        existingJobs.push(existing);
        continue;
      }
      const nextJob = {
        ...job,
        enqueuedAt: existing?.enqueuedAt || now,
        updatedAt: now
      };
      if (existing) {
        const index = queue.jobs.findIndex((item) => item.id === existing.id);
        queue.jobs[index] = nextJob;
      } else {
        queue.jobs.push(nextJob);
      }
      byId.set(nextJob.id, nextJob);
      queuedJobs.push(nextJob);
    }

    if (queuedJobs.length) {
      queue.updatedAt = now;
      await saveImportSemanticEnrichmentQueue(rootPath, queue);
    }

    return {
      queuedCount: queuedJobs.length,
      existingCount: existingJobs.length,
      jobs: [...queuedJobs, ...existingJobs],
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}

export async function reserveNextImportSemanticEnrichmentJob(rootPath, options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const recovered = recoverStaleRunningJobs(queue, options);
    const candidates = sortReservableJobs(queue.jobs || []);
    const job = candidates.find((entry) => normalizeStatus(entry.status) === 'pending');

    if (!job) {
      if (recovered) {
        queue.updatedAt = new Date().toISOString();
        await saveImportSemanticEnrichmentQueue(rootPath, queue);
      }
      return null;
    }

    const now = new Date().toISOString();
    reserveSemanticJobForWorker(job, now, options);
    queue.updatedAt = now;
    await saveImportSemanticEnrichmentQueue(rootPath, queue);
    return {
      job: { ...job },
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}

export async function reserveImportSemanticEnrichmentJobBatch(rootPath, options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  const maxJobs = Math.max(1, Math.min(16, Number(options.maxJobs || options.batchMaxJobs || 1) || 1));
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const recovered = recoverStaleRunningJobs(queue, options);
    const candidates = sortReservableJobs(queue.jobs || [])
      .filter((entry) => normalizeStatus(entry.status) === 'pending');
    const anchor = candidates[0] || null;

    if (!anchor) {
      if (recovered) {
        queue.updatedAt = new Date().toISOString();
        await saveImportSemanticEnrichmentQueue(rootPath, queue);
      }
      return null;
    }

    const groupKey = createSemanticJobReservationGroupKey(anchor);
    const jobs = candidates
      .filter((entry) => createSemanticJobReservationGroupKey(entry) === groupKey)
      .slice(0, maxJobs);
    const now = new Date().toISOString();

    for (const job of jobs) {
      reserveSemanticJobForWorker(job, now, options);
      if (jobs.length > 1) {
        job.progress = normalizeSemanticJobProgress(job, {
          status: 'running',
          stage: 'semantic-enrichment',
          currentStep: 'reserved batch',
          message: `Reserved background semantic enrichment batch with ${jobs.length} job(s)`
        });
      }
    }

    queue.updatedAt = now;
    await saveImportSemanticEnrichmentQueue(rootPath, queue);
    return {
      job: { ...jobs[0] },
      jobs: jobs.map((job) => ({ ...job })),
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}

export async function updateImportSemanticEnrichmentJobProgress(rootPath, jobId, progress = {}, options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const job = (queue.jobs || []).find((entry) => entry.id === jobId);
    if (!job) return null;
    const status = normalizeStatus(job.status);
    if (TERMINAL_STATUSES.has(status)) {
      return {
        job: { ...job },
        summary: summarizeQueue(queue)
      };
    }
    job.progress = normalizeSemanticJobProgress(job, progress);
    if (progress.stage) {
      job.stage = job.progress.stage;
    }
    job.updatedAt = job.progress.updatedAt;
    queue.updatedAt = job.updatedAt;
    await saveImportSemanticEnrichmentQueue(rootPath, queue);
    return {
      job: { ...job },
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}

export async function completeImportSemanticEnrichmentJob(rootPath, jobId, result = null, options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const job = (queue.jobs || []).find((entry) => entry.id === jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    job.status = 'completed';
    job.stage = 'completed';
    job.updatedAt = now;
    job.finishedAt = now;
    job.result = result;
    job.error = null;
    job.progress = normalizeSemanticJobProgress(job, {
      status: 'completed',
      stage: 'completed',
      currentStep: 'semantic enrichment complete',
      message: 'Completed background semantic enrichment job',
      stagePercent: 100
    });
    queue.updatedAt = now;
    await saveImportSemanticEnrichmentQueue(rootPath, queue);
    return {
      job: { ...job },
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}

export async function failImportSemanticEnrichmentJob(rootPath, jobId, error, options = {}) {
  const { queueLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportSemanticEnrichmentQueue(rootPath);
    const job = (queue.jobs || []).find((entry) => entry.id === jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    const attempts = Number(job.attempts || 0);
    const maxAttempts = Math.max(1, Number(job.maxAttempts || DEFAULT_JOB_MAX_ATTEMPTS) || DEFAULT_JOB_MAX_ATTEMPTS);
    const retryable = options.retry !== false && attempts < maxAttempts;
    job.status = retryable ? 'pending' : 'failed';
    job.stage = retryable ? 'queued' : 'failed';
    job.updatedAt = now;
    job.startedAt = retryable ? null : job.startedAt;
    job.finishedAt = retryable ? null : now;
    job.workerId = retryable ? null : job.workerId;
    job.error = {
      message: String(error?.message || error || 'Semantic enrichment job failed')
    };
    job.progress = normalizeSemanticJobProgress(job, {
      status: job.status,
      stage: job.stage,
      currentStep: retryable ? 'retry scheduled' : 'failed',
      message: job.error.message
    });
    queue.updatedAt = now;
    await saveImportSemanticEnrichmentQueue(rootPath, queue);
    return {
      job: { ...job },
      retryable,
      summary: summarizeQueue(queue)
    };
  }, {
    timeoutMs: Number(options.lockTimeoutMs || 5000)
  });
}
