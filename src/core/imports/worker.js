import { getCorpusPaths, loadCorpusMeta, loadSourceManifest } from '../../storage/corpus-store.js';
import {
  appendImportDagEvent,
  appendImportTaskLog,
  completeImportTask,
  failImportTask,
  getImportPaths,
  loadImportTask,
  listImportTasks,
  markImportTaskStage,
  quarantineImportTasks,
  recoverFailedImportTasks,
  reserveImportTaskBatch,
  reserveNextImportTask,
  updateImportTaskSemanticLifecycle,
  updateImportTaskProgress
} from '../../storage/import-store.js';
import {
  completeImportSemanticEnrichmentJob,
  enqueueImportSemanticEnrichmentJobs,
  failImportSemanticEnrichmentJob,
  getImportSemanticEnrichmentPaths,
  listImportSemanticEnrichmentJobs,
  reserveNextImportSemanticEnrichmentJob,
  updateImportSemanticEnrichmentJobProgress
} from '../../storage/import-semantic-store.js';
import {
  fastCommitCorpus,
  llmOptimizeCorpus,
  materializeCorpus,
} from '../ingestion/pipeline.js';
import { fileExists, withFileLock } from '../../lib/fs.js';
import { loadRegistry } from '../../storage/registry.js';
import { cacheMarkdownSource, convertPdfToMarkdown } from '../ingestion/pdf-parser.js';

const DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_IMPORT_WORKER_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IMPORT_TASK_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_IMPORT_PENDING_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const DEFAULT_IMPORT_PREPARSE_CONCURRENCY = 4;
const DEFAULT_IMPORT_BATCH_INITIAL_TASKS = 4;
const DEFAULT_IMPORT_BATCH_MAX_TASKS = 16;
const DEFAULT_IMPORT_BATCH_COALESCE_MS = 0;
const DEFAULT_IMPORT_BATCH_COALESCE_POLL_MS = 250;
const HARD_IMPORT_BATCH_COALESCE_MS = 5 * 60 * 1000;
const HARD_IMPORT_BATCH_COALESCE_POLL_MS = 10_000;
const IMPORT_PERFORMANCE_CONTRACT_VERSION = 'import-performance-v1';
const MATERIALIZE_PERFORMANCE_CONTRACT_VERSION = 'import-materialize-performance-v1';
const LLM_OPTIMIZE_PROGRESS_DIAGNOSTICS_CONTRACT_VERSION = 'llm-optimize-progress-diagnostics-v1';
const HARD_IMPORT_BATCH_MAX_TASKS = 16;
const importPreparseInFlight = new Map();
const importBatchProgressionByRoot = new Map();
const importWorkerSeenByRoot = new Map();

function isLockTimeout(error) {
  return String(error?.message || '').includes('Timed out waiting for file lock');
}

function createImportPreparseKey(rootPath, taskId) {
  return `${rootPath}::${taskId}`;
}

function resolveImportPreparseConcurrency(options = {}) {
  const raw = Number(options.importPreparseConcurrency || options.preparseConcurrency || DEFAULT_IMPORT_PREPARSE_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_PREPARSE_CONCURRENCY;
  }
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

function clampProgressPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function resolveImportTaskTimeoutMs(options = {}) {
  const raw = Number(options.importTaskTimeoutMs || options.taskTimeoutMs || DEFAULT_IMPORT_TASK_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_TASK_TIMEOUT_MS;
  }
  return Math.max(60_000, Math.floor(raw));
}

function resolveImportPendingTimeoutMs(options = {}) {
  const raw = Number(options.importPendingTimeoutMs || options.pendingTimeoutMs || DEFAULT_IMPORT_PENDING_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_PENDING_TIMEOUT_MS;
  }
  return Math.max(60_000, Math.floor(raw));
}

function resolveBooleanOption(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolvePositiveIntegerOption(value, fallback, minimum = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum) return fallback;
  return Math.floor(numeric);
}

function resolveOptionalPositiveIntegerOption(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function resolveNonNegativeIntegerOption(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(maximum, Math.floor(numeric));
}

function resolveImportBatchOptions(options = {}) {
  const configuredMaxTasks = resolvePositiveIntegerOption(
    options.importBatchMaxTasks ?? options.batchMaxTasks,
    DEFAULT_IMPORT_BATCH_MAX_TASKS
  );
  const maxTasks = Math.min(configuredMaxTasks, HARD_IMPORT_BATCH_MAX_TASKS);
  const initialTasks = Math.min(
    maxTasks,
    resolvePositiveIntegerOption(
      options.importBatchInitialTasks ?? options.batchInitialTasks,
      DEFAULT_IMPORT_BATCH_INITIAL_TASKS
    )
  );
  const configuredCoalesceTargetTasks = resolveOptionalPositiveIntegerOption(
    options.importBatchCoalesceTargetTasks ?? options.batchCoalesceTargetTasks
  );
  return {
    enabled: resolveBooleanOption(options.importBatchEnabled ?? options.batchEnabled, false),
    maxTasks,
    initialTasks,
    coalesceTargetTasks: configuredCoalesceTargetTasks
      ? Math.min(maxTasks, configuredCoalesceTargetTasks)
      : null,
    progressive: resolveBooleanOption(options.importBatchProgressive ?? options.batchProgressive, true),
    maxFiles: resolveOptionalPositiveIntegerOption(options.importBatchMaxFiles ?? options.batchMaxFiles),
    maxBytes: resolveOptionalPositiveIntegerOption(options.importBatchMaxBytes ?? options.batchMaxBytes),
    coalesceMs: resolveNonNegativeIntegerOption(
      options.importBatchCoalesceMs ?? options.batchCoalesceMs,
      DEFAULT_IMPORT_BATCH_COALESCE_MS,
      HARD_IMPORT_BATCH_COALESCE_MS
    ),
    coalescePollMs: Math.max(25, resolveNonNegativeIntegerOption(
      options.importBatchCoalescePollMs ?? options.batchCoalescePollMs,
      DEFAULT_IMPORT_BATCH_COALESCE_POLL_MS,
      HARD_IMPORT_BATCH_COALESCE_POLL_MS
    ))
  };
}

function getImportBatchProgressionKey(rootPath) {
  return String(rootPath || '').trim();
}

function markImportWorkerSeen(rootPath, corpusName = '') {
  const key = String(rootPath || '').trim();
  if (!key) return;
  importWorkerSeenByRoot.set(key, {
    rootPath: key,
    corpusName: corpusName || key,
    lastWorkerSeenAt: new Date().toISOString()
  });
}

export function getImportWorkerCoverageSnapshot(rootPath = '') {
  const key = String(rootPath || '').trim();
  if (key) {
    return importWorkerSeenByRoot.get(key) || null;
  }
  return [...importWorkerSeenByRoot.values()];
}

function clampImportBatchSize(value, batchOptions = {}) {
  const maxTasks = Math.max(1, Number(batchOptions.maxTasks || DEFAULT_IMPORT_BATCH_MAX_TASKS));
  const initialTasks = Math.max(1, Math.min(maxTasks, Number(batchOptions.initialTasks || DEFAULT_IMPORT_BATCH_INITIAL_TASKS)));
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return initialTasks;
  return Math.max(1, Math.min(maxTasks, Math.floor(numeric)));
}

function getProgressiveImportBatchTarget(rootPath, batchOptions = {}) {
  if (!batchOptions.progressive) {
    return clampImportBatchSize(batchOptions.maxTasks, batchOptions);
  }
  const key = getImportBatchProgressionKey(rootPath);
  return clampImportBatchSize(importBatchProgressionByRoot.get(key), batchOptions);
}

function resetProgressiveImportBatchTarget(rootPath) {
  importBatchProgressionByRoot.delete(getImportBatchProgressionKey(rootPath));
}

function countPendingImportTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    const stage = String(task?.stage || task?.progress?.stage || '').trim().toLowerCase();
    return status === 'pending' && (!stage || stage === 'queued');
  }).length;
}

async function countPendingImportTasksOnDisk(rootPath) {
  const payload = await listImportTasks(rootPath);
  return countPendingImportTasks(payload.tasks || []);
}

function summarizeImportBatchCoalesceTasks(tasks = []) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const pending = countPendingImportTasks(normalizedTasks);
  const running = normalizedTasks.filter((task) => (
    String(task?.status || '').trim().toLowerCase() === 'running'
  )).length;
  return {
    total: normalizedTasks.length,
    pending,
    running
  };
}

function pendingQueuedImportTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    const stage = String(task?.stage || task?.progress?.stage || '').trim().toLowerCase();
    return status === 'pending' && (!stage || stage === 'queued');
  });
}

function resolveImportBatchCoalesceTargetTasks(batchOptions = {}) {
  const maxTasks = Math.max(1, Number(batchOptions.maxTasks || DEFAULT_IMPORT_BATCH_MAX_TASKS) || DEFAULT_IMPORT_BATCH_MAX_TASKS);
  const configured = Number(batchOptions.coalesceTargetTasks || 0);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(maxTasks, Math.floor(configured)));
  }
  return maxTasks;
}

async function reportImportBatchCoalescingProgress(rootPath, tasks = [], summary = {}, batchOptions = {}) {
  const pendingTasks = pendingQueuedImportTasks(tasks);
  if (!pendingTasks.length) return;
  const targetTasks = resolveImportBatchCoalesceTargetTasks(batchOptions);
  const pending = Math.max(0, Number(summary.pending || pendingTasks.length) || 0);
  const stagePercent = Math.min(99, Math.round((Math.min(pending, targetTasks) / targetTasks) * 10000) / 100);
  await Promise.all(pendingTasks.map((task) => updateImportTaskProgress(rootPath, task.id, {
    stage: 'queued',
    status: 'pending',
    stagePercent,
    processedUnits: pending,
    totalUnits: targetTasks,
    currentStep: 'coalescing',
    message: `Coalescing import batch: ${pending}/${targetTasks} task(s) queued`
  }).catch(() => null)));
}

function shouldWaitForImportBatchCoalesce(summary = {}, batchOptions = {}) {
  const targetTasks = resolveImportBatchCoalesceTargetTasks(batchOptions);
  return Boolean(batchOptions.enabled)
    && Number(batchOptions.coalesceMs || 0) > 0
    && targetTasks > 1
    && Number(summary.running || 0) === 0
    && Number(summary.pending || 0) > 0
    && Number(summary.pending || 0) < targetTasks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0) || 0)));
}

async function waitForImportBatchCoalesce(rootPath, batchOptions = {}, initialPayload = null) {
  const coalesceMs = Math.max(0, Number(batchOptions.coalesceMs || 0) || 0);
  if (!coalesceMs) return null;

  const targetTasks = resolveImportBatchCoalesceTargetTasks(batchOptions);
  const startedAt = Date.now();
  let payload = initialPayload || await listImportTasks(rootPath);
  let summary = summarizeImportBatchCoalesceTasks(payload.tasks || []);
  if (!shouldWaitForImportBatchCoalesce(summary, batchOptions)) {
    return {
      waited: false,
      waitedMs: 0,
      targetTasks,
      pendingTaskCount: summary.pending,
      runningTaskCount: summary.running,
      reason: summary.running ? 'running-task' : (summary.pending >= targetTasks ? 'target-filled' : 'no-pending')
    };
  }

  const deadline = startedAt + coalesceMs;
  const pollMs = Math.max(25, Number(batchOptions.coalescePollMs || DEFAULT_IMPORT_BATCH_COALESCE_POLL_MS) || DEFAULT_IMPORT_BATCH_COALESCE_POLL_MS);
  let reason = 'timeout';
  let lastProgressSignature = '';
  while (Date.now() < deadline) {
    const progressSignature = `${summary.pending}:${summary.running}:${targetTasks}`;
    if (progressSignature !== lastProgressSignature) {
      lastProgressSignature = progressSignature;
      await reportImportBatchCoalescingProgress(rootPath, payload.tasks || [], summary, batchOptions);
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    payload = await listImportTasks(rootPath);
    summary = summarizeImportBatchCoalesceTasks(payload.tasks || []);
    if (!shouldWaitForImportBatchCoalesce(summary, batchOptions)) {
      reason = summary.running ? 'running-task' : (summary.pending >= targetTasks ? 'target-filled' : 'no-pending');
      break;
    }
  }

  return {
    waited: true,
    waitedMs: Math.max(0, Date.now() - startedAt),
    targetTasks,
    pendingTaskCount: summary.pending,
    runningTaskCount: summary.running,
    reason
  };
}

function createFastMdBurstReserveBatchOptions(tasks = [], batchOptions = {}, reserveBatchOptions = {}, options = {}) {
  const pendingTasks = pendingQueuedImportTasks(tasks);
  if (!pendingTasks.length) return reserveBatchOptions;

  const fastMdPendingTasks = pendingTasks.filter((task) => shouldUseFastMdStructuralPath(task, options));
  if (fastMdPendingTasks.length !== pendingTasks.length) {
    return reserveBatchOptions;
  }

  const minStartTasks = Math.max(1, Number(batchOptions.initialTasks || reserveBatchOptions.initialTasks || 1) || 1);
  if (fastMdPendingTasks.length < minStartTasks) {
    return reserveBatchOptions;
  }

  const maxTasks = Math.max(1, Number(batchOptions.maxTasks || reserveBatchOptions.maxTasks || 1) || 1);
  const burstTaskCount = Math.min(maxTasks, fastMdPendingTasks.length);
  return {
    ...reserveBatchOptions,
    maxTasks: burstTaskCount,
    coalesceTargetTasks: burstTaskCount,
    fastMdBurstReady: true,
    fastMdBurstTaskCount: fastMdPendingTasks.length
  };
}

function updateProgressiveImportBatchTarget(rootPath, batchOptions = {}, result = {}, pendingTaskCount = 0) {
  if (!batchOptions.progressive) {
    return null;
  }

  const key = getImportBatchProgressionKey(rootPath);
  const currentTarget = getProgressiveImportBatchTarget(rootPath, batchOptions);
  const hasPendingWork = Number(pendingTaskCount || 0) > 0;
  if (!hasPendingWork) {
    importBatchProgressionByRoot.delete(key);
    return {
      currentTarget,
      nextTarget: clampImportBatchSize(batchOptions.initialTasks, batchOptions),
      pendingTaskCount: 0,
      reset: true
    };
  }

  const processedCount = Array.isArray(result.batchTaskIds) && result.batchTaskIds.length
    ? result.batchTaskIds.length
    : (Array.isArray(result.completedTaskIds) && result.completedTaskIds.length
      ? result.completedTaskIds.length
      : (result.taskId ? 1 : 0));
  const processedAsBatch = !result.failed && Boolean(result.batchId) && processedCount > 1;
  const nextTarget = processedAsBatch
    ? clampImportBatchSize(currentTarget * 2, batchOptions)
    : clampImportBatchSize(batchOptions.initialTasks, batchOptions);

  importBatchProgressionByRoot.set(key, nextTarget);
  return {
    currentTarget,
    nextTarget,
    pendingTaskCount,
    reset: false
  };
}

function getImportTaskHeartbeatMs(task = {}) {
  return Date.parse(
    task?.progress?.lastEventAt
    || task?.updatedAt
    || task?.startedAt
    || task?.createdAt
    || 0
  ) || 0;
}

async function recoverTimedOutImportTasks(rootPath, options = {}) {
  const timeoutMs = resolveImportTaskTimeoutMs(options);
  const now = Date.now();
  const { tasks } = await listImportTasks(rootPath);
  const timedOutTasks = tasks.filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status !== 'running') return false;
    const heartbeatMs = getImportTaskHeartbeatMs(task);
    if (!heartbeatMs) return false;
    return (now - heartbeatMs) >= timeoutMs;
  });

  for (const task of timedOutTasks) {
    const heartbeatAgeMs = now - getImportTaskHeartbeatMs(task);
    const stageLabel = String(task?.stage || task?.progress?.stage || 'unknown').trim() || 'unknown';
    await failImportTask(
      rootPath,
      task.id,
      new Error(
        `Import task timed out after ${heartbeatAgeMs}ms without progress while in stage ${stageLabel}. `
        + `Configured timeout=${timeoutMs}ms.`
      )
    );
  }

  return timedOutTasks.map((task) => task.id);
}

function getImportTaskQueueAgeMs(task = {}) {
  return Date.parse(task?.updatedAt || task?.createdAt || 0) || 0;
}

async function quarantineStalePendingImportTasks(rootPath, options = {}) {
  const timeoutMs = resolveImportPendingTimeoutMs(options);
  const now = Date.now();
  const { tasks } = await listImportTasks(rootPath);
  const runningTasks = tasks.filter((task) => String(task?.status || '').trim().toLowerCase() === 'running');
  if (runningTasks.length) {
    return null;
  }

  const stalePendingTasks = tasks.filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    const stage = String(task?.stage || task?.progress?.stage || '').trim().toLowerCase();
    if (status !== 'pending') return false;
    if (stage && stage !== 'queued') return false;
    if (task?.startedAt) return false;
    const ageAnchor = getImportTaskQueueAgeMs(task);
    if (!ageAnchor) return false;
    return (now - ageAnchor) >= timeoutMs;
  });

  if (!stalePendingTasks.length) {
    return null;
  }

  const result = await quarantineImportTasks(
    rootPath,
    stalePendingTasks.map((task) => task.id),
    {
      reason: 'stale-pending-timeout',
      message: `Import task sat in queued/pending state longer than ${timeoutMs}ms with no active import worker progress.`
    }
  );
  return result.count ? result : null;
}

function createTaskProgressReporter(rootPath, taskId, stage) {
  let lastSignature = '';
  let chain = Promise.resolve();
  return {
    async report(event = {}) {
      const signature = JSON.stringify({
        stage,
        stagePercent: clampProgressPercent(event.stagePercent, -1),
        processedUnits: Number(event.processedUnits || 0),
        totalUnits: Number(event.totalUnits || 0),
        currentStep: String(event.currentStep || event.phase || '').trim(),
        message: String(event.message || event.label || '').trim(),
        diagnostics: event.diagnostics || null
      });
      if (signature === lastSignature) {
        return chain;
      }
      lastSignature = signature;
      chain = chain.then(() => updateImportTaskProgress(rootPath, taskId, {
        stage,
        stagePercent: event.stagePercent,
        processedUnits: event.processedUnits,
        totalUnits: event.totalUnits,
        currentStep: event.currentStep || event.phase || '',
        message: event.message || event.label || '',
        diagnostics: event.diagnostics
      })).catch(() => null);
      return chain;
    },
    async flush() {
      await chain;
    }
  };
}

function createBatchProgressReporter(rootPath, taskIds = [], stage, batchId) {
  const reporters = taskIds.map((taskId) => createTaskProgressReporter(rootPath, taskId, stage));
  return {
    async report(event = {}) {
      await Promise.all(reporters.map((reporter) => reporter.report({
        ...event,
        currentStep: event.currentStep || event.phase || `batch ${batchId}`,
        message: event.message || event.label || `Running ${stage} as import batch ${batchId}`
      })));
    },
    async flush() {
      await Promise.all(reporters.map((reporter) => reporter.flush()));
    }
  };
}

function createSemanticJobProgressReporter(rootPath, jobId, stage) {
  let lastSignature = '';
  let chain = Promise.resolve();
  return {
    async report(event = {}) {
      const signature = JSON.stringify({
        stage,
        stagePercent: clampProgressPercent(event.stagePercent, -1),
        processedUnits: Number(event.processedUnits || 0),
        totalUnits: Number(event.totalUnits || 0),
        currentStep: String(event.currentStep || event.phase || '').trim(),
        message: String(event.message || event.label || '').trim(),
        diagnostics: event.diagnostics || null
      });
      if (signature === lastSignature) {
        return chain;
      }
      lastSignature = signature;
      chain = chain.then(() => updateImportSemanticEnrichmentJobProgress(rootPath, jobId, {
        stage,
        status: 'running',
        stagePercent: event.stagePercent,
        processedUnits: event.processedUnits,
        totalUnits: event.totalUnits,
        currentStep: event.currentStep || event.phase || '',
        message: event.message || event.label || '',
        diagnostics: event.diagnostics
      })).catch(() => null);
      return chain;
    },
    async flush() {
      await chain;
    }
  };
}

function elapsedMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function roundMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.round(numeric * 100) / 100;
}

function sumKnownStageTimings(stageTimingsMs = {}) {
  return ['materialize', 'llmOptimize', 'fastCommit']
    .map((key) => Number(stageTimingsMs[key]))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((total, value) => total + value, 0);
}

function summarizeNumericValues(values = []) {
  const numbers = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!numbers.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p90: null,
      p95: null,
      total: 0
    };
  }
  const sorted = [...numbers].sort((left, right) => left - right);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  const percentile = (rank) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
    return sorted[index];
  };
  return {
    count: numbers.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round((total / numbers.length) * 100) / 100,
    p50: percentile(50),
    p90: percentile(90),
    p95: percentile(95),
    total: Math.round(total * 100) / 100
  };
}

function createCountMap(values = []) {
  const counts = {};
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeRateLimitCooldowns(events = []) {
  const cooldowns = uniqueSortedStrings(events.map((event) => event.rateLimitCooldownUntil).filter(Boolean));
  return {
    count: cooldowns.length,
    latest: cooldowns.length ? cooldowns[cooldowns.length - 1] : null,
    cooldowns
  };
}

function inferLlmBatchEventStatus(event = {}) {
  const explicit = normalizeDashedToken(event.status || event.resultStatus || event.result_status);
  if (explicit) return explicit;
  if (event.rateLimitCooldownUntil || event.skippedProviderCall) return 'rate-limited';
  if (Number(event.failureCount || event.failedCount || 0) > 0) return 'failed';
  if (event.cached) return 'cached';
  if (event.skipped) return 'skipped';
  return 'completed';
}

function inferLlmBatchEventReason(event = {}) {
  const explicit = normalizeDashedToken(
    event.reason
    || event.failureReason
    || event.failure_reason
    || event.errorCode
    || event.error_code
  );
  if (explicit) return explicit;
  if (event.rateLimitCooldownUntil || event.skippedProviderCall) return 'rate-limited';
  if (Number(event.failureCount || event.failedCount || 0) > 0) return 'failed';
  if (event.cached) return 'cached';
  if (event.skipped) return 'skipped';
  return '';
}

function createLlmBatchMetricsCollector() {
  const completedEvents = [];
  const retryEvents = [];
  return {
    recordComplete(event = {}) {
      completedEvents.push({
        phase: String(event.phase || '').trim() || null,
        batchNumber: Number(event.batchNumber || 0) || null,
        totalBatches: Number(event.totalBatches || 0) || null,
        providerBatchNumber: Number(event.providerBatchNumber || 0) || null,
        providerTotalBatches: Number(event.providerTotalBatches || 0) || null,
        completed: Number(event.completed || 0) || 0,
        total: Number(event.total || 0) || 0,
        batchSize: Number(event.batchSize || 0) || 0,
        promptChars: Number(event.promptChars || 0) || 0,
        promptMaxChars: Number(event.promptMaxChars || 0) || 0,
        durationMs: roundMs(event.durationMs),
        llmBatchConcurrency: Number(event.llmBatchConcurrency || 0) || 0,
        failureCount: Number(event.failureCount || event.failedCount || 0) || 0,
        skipped: Boolean(event.skipped),
        cached: Boolean(event.cached),
        skippedProviderCall: Boolean(event.skippedProviderCall),
        rateLimitCooldownUntil: event.rateLimitCooldownUntil ? String(event.rateLimitCooldownUntil) : null,
        status: inferLlmBatchEventStatus(event),
        reason: inferLlmBatchEventReason(event)
      });
    },
    recordRetry(event = {}) {
      retryEvents.push({
        phase: String(event.phase || '').trim() || null,
        batchNumber: Number(event.batchNumber || 0) || null,
        batchSize: Number(event.batchSize || 0) || 0,
        retryBatchCount: Number(event.retryBatchCount || 0) || 0,
        retryBatchSize: Number(event.retryBatchSize || 0) || 0,
        remainingRetries: Number(event.remainingRetries || 0) || 0,
        promptChars: Number(event.promptChars || 0) || 0,
        promptMaxChars: Number(event.promptMaxChars || 0) || 0,
        error: event.error ? String(event.error) : null
      });
    },
    summary() {
      const phases = uniqueSortedStrings(completedEvents.map((event) => event.phase).filter(Boolean));
      const effectiveBatchSizes = completedEvents.map((event) => event.batchSize).filter((value) => value > 0);
      const promptChars = completedEvents.map((event) => event.promptChars).filter((value) => value > 0);
      const promptMaxChars = completedEvents.map((event) => event.promptMaxChars).filter((value) => value > 0);
      const durationMs = completedEvents.map((event) => event.durationMs).filter((value) => value !== undefined);
      const providerDurationMs = completedEvents
        .filter((event) => !event.cached && !event.skipped && !event.skippedProviderCall)
        .map((event) => event.durationMs)
        .filter((value) => value !== undefined);
      const concurrencyValues = completedEvents
        .map((event) => event.llmBatchConcurrency)
        .filter((value) => value > 0);
      const phaseSummaries = {};
      for (const phase of phases) {
        const phaseEvents = completedEvents.filter((event) => event.phase === phase);
        const phaseDurations = phaseEvents.map((event) => event.durationMs).filter((value) => value !== undefined);
        const phasePromptChars = phaseEvents.map((event) => event.promptChars).filter((value) => value > 0);
        const phaseConcurrencyValues = phaseEvents.map((event) => event.llmBatchConcurrency).filter((value) => value > 0);
        const phaseFailureEvents = phaseEvents.filter((event) => event.failureCount > 0 || event.status === 'failed');
        const phaseRateLimitedEvents = phaseEvents.filter((event) => event.status === 'rate-limited' || event.rateLimitCooldownUntil || event.skippedProviderCall);
        phaseSummaries[phase] = {
          completedBatchCount: phaseEvents.length,
          skippedBatchCount: phaseEvents.filter((event) => event.skipped).length,
          cachedBatchCount: phaseEvents.filter((event) => event.cached).length,
          skippedProviderCallCount: phaseEvents.filter((event) => event.skippedProviderCall).length,
          rateLimitSkippedBatchCount: phaseRateLimitedEvents.length,
          failedBatchCount: phaseFailureEvents.length,
          failureReasons: createCountMap(phaseFailureEvents.map((event) => event.reason || event.status || 'failed')),
          rateLimitCooldowns: summarizeRateLimitCooldowns(phaseRateLimitedEvents),
          durationMs: summarizeNumericValues(phaseDurations),
          promptChars: summarizeNumericValues(phasePromptChars),
          maxConcurrency: phaseConcurrencyValues.length ? Math.max(...phaseConcurrencyValues) : null
        };
      }
      const failedEvents = completedEvents.filter((event) => event.failureCount > 0 || event.status === 'failed');
      const rateLimitedEvents = completedEvents.filter((event) => event.status === 'rate-limited' || event.rateLimitCooldownUntil || event.skippedProviderCall);
      return {
        completedBatchCount: completedEvents.length,
        skippedBatchCount: completedEvents.filter((event) => event.skipped).length,
        cachedBatchCount: completedEvents.filter((event) => event.cached).length,
        skippedProviderCallCount: completedEvents.filter((event) => event.skippedProviderCall).length,
        rateLimitSkippedBatchCount: rateLimitedEvents.length,
        failedBatchCount: failedEvents.length,
        retryEventCount: retryEvents.length,
        phases,
        effectiveBatchSizes,
        promptChars: summarizeNumericValues(promptChars),
        promptMaxChars: promptMaxChars.length ? Math.max(...promptMaxChars) : null,
        durationMs: summarizeNumericValues(durationMs),
        providerDurationMs: summarizeNumericValues(providerDurationMs),
        maxConcurrency: concurrencyValues.length ? Math.max(...concurrencyValues) : null,
        failureReasons: createCountMap(failedEvents.map((event) => event.reason || event.status || 'failed')),
        retryReasons: createCountMap(retryEvents.map((event) => event.error || 'retry')),
        rateLimitCooldowns: summarizeRateLimitCooldowns(rateLimitedEvents),
        byPhase: phaseSummaries,
        retries: retryEvents
      };
    }
  };
}

function inferLlmRetryEventReason(event = {}) {
  const explicit = normalizeDashedToken(
    event.reason
    || event.failureReason
    || event.failure_reason
    || event.errorCode
    || event.error_code
  );
  if (explicit) return explicit;
  if (event.rateLimitCooldownUntil || event.skippedProviderCall) return 'rate-limited';
  if (event.error) return 'provider-retry';
  return 'retry';
}

function createEmptyLlmProgressPhase() {
  return {
    completedBatchCount: 0,
    retryEventCount: 0,
    failedBatchCount: 0,
    rateLimitSkippedBatchCount: 0,
    cachedBatchCount: 0,
    skippedBatchCount: 0,
    skippedProviderCallCount: 0,
    completed: 0,
    total: 0,
    lastBatchNumber: null,
    totalBatches: null,
    maxConcurrency: null,
    rateLimitCooldownUntil: null,
    failureReasons: {},
    retryReasons: {}
  };
}

function incrementCountMap(counts = {}, key = '') {
  const normalized = String(key || '').trim() || 'unknown';
  counts[normalized] = (counts[normalized] || 0) + 1;
}

function normalizeLlmProgressPhase(event = {}, fallback = 'llm-batch') {
  return String(event.phase || fallback || '').trim() || 'llm-batch';
}

function createLlmProgressDiagnosticsCollector(context = {}) {
  const state = {
    status: 'running',
    lastEventType: null,
    latestEvent: null,
    completedBatchCount: 0,
    retryEventCount: 0,
    failedBatchCount: 0,
    rateLimitSkippedBatchCount: 0,
    cachedBatchCount: 0,
    skippedBatchCount: 0,
    skippedProviderCallCount: 0,
    completed: 0,
    total: 0,
    maxConcurrency: null,
    rateLimitCooldownUntil: null,
    failureReasons: {},
    retryReasons: {},
    phases: {}
  };

  const phaseState = (phase) => {
    if (!state.phases[phase]) {
      state.phases[phase] = createEmptyLlmProgressPhase();
    }
    return state.phases[phase];
  };

  const snapshot = (overrides = {}) => ({
    contractVersion: LLM_OPTIMIZE_PROGRESS_DIAGNOSTICS_CONTRACT_VERSION,
    status: overrides.status || state.status,
    activeStage: 'llm-optimize',
    ...(context.mode ? { mode: context.mode } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.batchId ? { batchId: context.batchId } : {}),
    ...(Number(context.batchTaskCount || 0) > 0 ? { batchTaskCount: Number(context.batchTaskCount) } : {}),
    ...(context.semanticEnrichmentJobId ? { semanticEnrichmentJobId: context.semanticEnrichmentJobId } : {}),
    ...(context.importBatchLlmConfigKey ? { importBatchLlmConfigKey: context.importBatchLlmConfigKey } : {}),
    ...(Number(context.importBatchLlmConfigGroupIndex || 0) > 0
      ? { importBatchLlmConfigGroupIndex: Number(context.importBatchLlmConfigGroupIndex) }
      : {}),
    ...(Number(context.importBatchLlmConfigGroupCount || 0) > 0
      ? { importBatchLlmConfigGroupCount: Number(context.importBatchLlmConfigGroupCount) }
      : {}),
    ...(Number(context.changedSourceKeyCount || 0) > 0 ? { changedSourceKeyCount: Number(context.changedSourceKeyCount) } : {}),
    ...(context.llmConfig && typeof context.llmConfig === 'object' && !Array.isArray(context.llmConfig)
      ? { llmConfig: { ...context.llmConfig } }
      : {}),
    lastEventType: state.lastEventType,
    latestEvent: state.latestEvent,
    completedBatchCount: state.completedBatchCount,
    retryEventCount: state.retryEventCount,
    failedBatchCount: state.failedBatchCount,
    rateLimitSkippedBatchCount: state.rateLimitSkippedBatchCount,
    cachedBatchCount: state.cachedBatchCount,
    skippedBatchCount: state.skippedBatchCount,
    skippedProviderCallCount: state.skippedProviderCallCount,
    completed: state.completed,
    total: state.total,
    maxConcurrency: state.maxConcurrency,
    rateLimitCooldownUntil: state.rateLimitCooldownUntil,
    failureReasons: { ...state.failureReasons },
    retryReasons: { ...state.retryReasons },
    phases: Object.fromEntries(Object.entries(state.phases).map(([phase, phaseSummary]) => [
      phase,
      {
        ...phaseSummary,
        failureReasons: { ...phaseSummary.failureReasons },
        retryReasons: { ...phaseSummary.retryReasons }
      }
    ])),
    ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {})
  });

  const recordComplete = (event = {}) => {
    const phase = normalizeLlmProgressPhase(event);
    const phaseSummary = phaseState(phase);
    const status = inferLlmBatchEventStatus(event);
    const reason = inferLlmBatchEventReason(event) || status;
    const completed = Number(event.completed || 0) || 0;
    const total = Number(event.total || 0) || 0;
    const concurrency = Number(event.llmBatchConcurrency || 0) || 0;
    const batchNumber = Number(event.batchNumber || 0) || null;
    const totalBatches = Number(event.totalBatches || 0) || null;
    const rateLimited = status === 'rate-limited' || Boolean(event.rateLimitCooldownUntil || event.skippedProviderCall);
    const failed = status === 'failed' || Number(event.failureCount || event.failedCount || 0) > 0;

    state.completedBatchCount += 1;
    phaseSummary.completedBatchCount += 1;
    if (event.cached) {
      state.cachedBatchCount += 1;
      phaseSummary.cachedBatchCount += 1;
    }
    if (event.skipped) {
      state.skippedBatchCount += 1;
      phaseSummary.skippedBatchCount += 1;
    }
    if (event.skippedProviderCall) {
      state.skippedProviderCallCount += 1;
      phaseSummary.skippedProviderCallCount += 1;
    }
    if (rateLimited) {
      state.rateLimitSkippedBatchCount += 1;
      phaseSummary.rateLimitSkippedBatchCount += 1;
      state.rateLimitCooldownUntil = state.rateLimitCooldownUntil || event.rateLimitCooldownUntil || null;
      phaseSummary.rateLimitCooldownUntil = phaseSummary.rateLimitCooldownUntil || event.rateLimitCooldownUntil || null;
    }
    if (failed) {
      state.failedBatchCount += 1;
      phaseSummary.failedBatchCount += 1;
      incrementCountMap(state.failureReasons, reason || 'failed');
      incrementCountMap(phaseSummary.failureReasons, reason || 'failed');
    }
    if (completed > 0) {
      state.completed = Math.max(state.completed, completed);
      phaseSummary.completed = Math.max(phaseSummary.completed, completed);
    }
    if (total > 0) {
      state.total = Math.max(state.total, total);
      phaseSummary.total = Math.max(phaseSummary.total, total);
    }
    if (concurrency > 0) {
      state.maxConcurrency = Math.max(state.maxConcurrency || 0, concurrency);
      phaseSummary.maxConcurrency = Math.max(phaseSummary.maxConcurrency || 0, concurrency);
    }
    phaseSummary.lastBatchNumber = batchNumber || phaseSummary.lastBatchNumber;
    phaseSummary.totalBatches = totalBatches || phaseSummary.totalBatches;
    state.lastEventType = 'batch-complete';
    state.latestEvent = {
      event: 'batch-complete',
      phase,
      status,
      reason: reason || null,
      batchNumber,
      totalBatches,
      providerBatchNumber: Number(event.providerBatchNumber || 0) || null,
      providerTotalBatches: Number(event.providerTotalBatches || 0) || null,
      completed,
      total,
      batchSize: Number(event.batchSize || 0) || 0,
      llmBatchConcurrency: concurrency || null,
      durationMs: roundMs(event.durationMs),
      promptChars: Number(event.promptChars || 0) || 0,
      promptMaxChars: Number(event.promptMaxChars || 0) || 0,
      rateLimitCooldownUntil: event.rateLimitCooldownUntil || null
    };
    return snapshot();
  };

  const recordRetry = (event = {}) => {
    const phase = normalizeLlmProgressPhase(event);
    const phaseSummary = phaseState(phase);
    const reason = inferLlmRetryEventReason(event);
    const concurrency = Number(event.llmBatchConcurrency || 0) || 0;
    state.retryEventCount += 1;
    phaseSummary.retryEventCount += 1;
    incrementCountMap(state.retryReasons, reason);
    incrementCountMap(phaseSummary.retryReasons, reason);
    if (concurrency > 0) {
      state.maxConcurrency = Math.max(state.maxConcurrency || 0, concurrency);
      phaseSummary.maxConcurrency = Math.max(phaseSummary.maxConcurrency || 0, concurrency);
    }
    state.lastEventType = 'batch-retry';
    state.latestEvent = {
      event: 'batch-retry',
      phase,
      reason,
      batchNumber: Number(event.batchNumber || 0) || null,
      batchSize: Number(event.batchSize || 0) || 0,
      retryBatchCount: Number(event.retryBatchCount || 0) || 0,
      retryBatchSize: Number(event.retryBatchSize || 0) || 0,
      remainingRetries: Number(event.remainingRetries || 0) || 0,
      llmBatchConcurrency: concurrency || null,
      promptChars: Number(event.promptChars || 0) || 0,
      promptMaxChars: Number(event.promptMaxChars || 0) || 0
    };
    return snapshot();
  };

  return {
    recordComplete,
    recordRetry,
    snapshot
  };
}

function buildLlmDiagnosticsProgressEvent(diagnostics = {}, fallbackStep = 'llm batch progress') {
  const latest = diagnostics.latestEvent && typeof diagnostics.latestEvent === 'object'
    ? diagnostics.latestEvent
    : {};
  const total = Number(latest.total || diagnostics.total || 0) || 0;
  const completed = Number(latest.completed || diagnostics.completed || 0) || 0;
  const phase = String(latest.phase || '').trim();
  const batchNumber = latest.batchNumber || null;
  const totalBatches = latest.totalBatches || null;
  const currentStep = phase && batchNumber && totalBatches
    ? `${phase} batch ${batchNumber}/${totalBatches}`
    : (phase || fallbackStep);
  const stagePercent = total > 0
    ? Math.min(99, Math.round((Math.min(completed, total) / total) * 10000) / 100)
    : undefined;
  return {
    stagePercent,
    processedUnits: total > 0 ? completed : undefined,
    totalUnits: total > 0 ? total : undefined,
    currentStep,
    message: latest.event === 'batch-retry'
      ? `Retrying ${phase || 'LLM batch'}${latest.reason ? ` (${latest.reason})` : ''}`
      : `Completed ${phase || 'LLM'} batch progress`,
    diagnostics
  };
}

function reportLlmProgressDiagnostics(progressReporter, diagnosticsCollector, event = {}, type = 'complete') {
  if (!progressReporter || !diagnosticsCollector) return null;
  const diagnostics = type === 'retry'
    ? diagnosticsCollector.recordRetry(event)
    : diagnosticsCollector.recordComplete(event);
  return progressReporter.report(buildLlmDiagnosticsProgressEvent(diagnostics));
}

function normalizeTimingMap(values = {}) {
  const normalized = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return normalized;
  for (const [key, value] of Object.entries(values)) {
    const rounded = roundMs(value);
    if (rounded !== undefined) normalized[key] = rounded;
  }
  return normalized;
}

function setImportPerformanceMetrics(result = {}, metrics = {}) {
  const existingMetrics = result.metrics && typeof result.metrics === 'object' && !Array.isArray(result.metrics)
    ? result.metrics
    : {};
  const existingPerformance = existingMetrics.importPerformance && typeof existingMetrics.importPerformance === 'object'
    ? existingMetrics.importPerformance
    : {};
  const stageTimingsMs = normalizeTimingMap({
    ...(existingPerformance.stageTimingsMs || {}),
    ...(metrics.stageTimingsMs || {})
  });
  if (stageTimingsMs.total === undefined) {
    const summed = sumKnownStageTimings(stageTimingsMs);
    if (summed) stageTimingsMs.total = roundMs(summed);
  }

  const fastCommitPhasesMs = normalizeTimingMap({
    ...(existingPerformance.fastCommitPhasesMs || {}),
    ...(metrics.fastCommitPhasesMs || {})
  });
  const {
    stageTimingsMs: _stageTimingsMs,
    fastCommitPhasesMs: _fastCommitPhasesMs,
    ...nextMetrics
  } = metrics || {};
  const nextImportPerformance = {
    contractVersion: IMPORT_PERFORMANCE_CONTRACT_VERSION,
    ...existingPerformance,
    ...nextMetrics,
    stageTimingsMs
  };
  if (Object.keys(fastCommitPhasesMs).length) {
    nextImportPerformance.fastCommitPhasesMs = fastCommitPhasesMs;
  } else {
    delete nextImportPerformance.fastCommitPhasesMs;
  }
  result.metrics = {
    ...existingMetrics,
    importPerformance: nextImportPerformance
  };
  return result.metrics.importPerformance;
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  if (!Array.isArray(items) || !items.length) return [];

  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeDashedToken(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function firstNonEmptyOptionValue(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizeImportExecutionMode(value, fallback = 'serial') {
  const normalized = normalizeDashedToken(value);
  if (normalized === 'dag' || normalized === 'async-dag' || normalized === 'dag-sidecar') return 'dag';
  if (normalized === 'serial' || normalized === 'serial-sidecar' || normalized === 'sidecar') return 'serial';
  return fallback === 'dag' ? 'dag' : 'serial';
}

function resolveOptionImportExecutionMode(options = {}) {
  const importsConfig = options.config?.imports && typeof options.config.imports === 'object'
    ? options.config.imports
    : {};
  const importConfig = options.config?.import && typeof options.config.import === 'object'
    ? options.config.import
    : {};
  const raw = firstNonEmptyOptionValue(
    options.importExecutionMode,
    options.import_execution_mode,
    options.importsExecutionMode,
    options.imports_execution_mode,
    importsConfig.importExecutionMode,
    importsConfig.import_execution_mode,
    importsConfig.executionMode,
    importConfig.importExecutionMode,
    importConfig.import_execution_mode,
    importConfig.executionMode
  );
  return raw ? normalizeImportExecutionMode(raw, 'serial') : '';
}

function resolveTaskImportExecutionMode(task = {}, options = {}) {
  const taskModeRaw = firstNonEmptyOptionValue(
    task.importExecutionMode,
    task.import_execution_mode,
    task.importsExecutionMode,
    task.imports_execution_mode
  );
  const taskMode = taskModeRaw ? normalizeImportExecutionMode(taskModeRaw, 'serial') : 'serial';
  const taskModeSource = normalizeDashedToken(task.importExecutionModeSource || task.import_execution_mode_source);
  if (taskModeSource === 'request' || taskModeSource === 'config') return taskMode;
  return resolveOptionImportExecutionMode(options) || taskMode;
}

function normalizePositiveIntegerOption(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function normalizeLlmExtractionStrategyOption(value) {
  const normalized = normalizeDashedToken(value);
  if (normalized === 'long-context-first' || normalized === 'chunk-first' || normalized === 'auto') {
    return normalized;
  }
  return null;
}

function resolveTaskLlmOptionOverrides(input = {}) {
  const llmConfig = input?.llmConfig && typeof input.llmConfig === 'object' && !Array.isArray(input.llmConfig)
    ? input.llmConfig
    : input?.llm_config && typeof input.llm_config === 'object' && !Array.isArray(input.llm_config)
      ? input.llm_config
      : {};
  const llmContextWindowTokens = normalizePositiveIntegerOption(firstNonEmptyOptionValue(
    input.llmContextWindowTokens,
    input.llm_context_window_tokens,
    llmConfig.contextWindowTokens,
    llmConfig.llmContextWindowTokens
  ));
  const llmExtractionStrategy = normalizeLlmExtractionStrategyOption(firstNonEmptyOptionValue(
    input.llmExtractionStrategy,
    input.llm_extraction_strategy,
    llmConfig.extractionStrategy,
    llmConfig.llmExtractionStrategy
  ));
  const llmLongContextMaxPapersPerCall = normalizePositiveIntegerOption(firstNonEmptyOptionValue(
    input.llmLongContextMaxPapersPerCall,
    input.llm_long_context_max_papers_per_call,
    llmConfig.longContextMaxPapersPerCall,
    llmConfig.llmLongContextMaxPapersPerCall
  ));
  const llmBatchConcurrency = normalizePositiveIntegerOption(firstNonEmptyOptionValue(
    input.llmBatchConcurrency,
    input.llm_batch_concurrency,
    llmConfig.batchConcurrency,
    llmConfig.llmBatchConcurrency
  ));
  return {
    ...(llmContextWindowTokens ? { llmContextWindowTokens } : {}),
    ...(llmExtractionStrategy ? { llmExtractionStrategy } : {}),
    ...(llmLongContextMaxPapersPerCall ? { llmLongContextMaxPapersPerCall } : {}),
    ...(llmBatchConcurrency ? { llmBatchConcurrency } : {})
  };
}

function createTaskLlmSemanticConfigKey(overrides = {}) {
  const entries = Object.entries(overrides)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length
    ? entries.map(([key, value]) => `${key}=${value}`).join(';')
    : 'default';
}

function resolveEffectiveTaskLlmOptions(task = {}, options = {}) {
  return {
    ...resolveTaskLlmOptionOverrides(options),
    ...resolveTaskLlmOptionOverrides(task)
  };
}

function createImportBatchLlmConfigGroups(entries = [], options = {}) {
  const groupsByKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const taskId = entry?.task?.id;
    if (!taskId) continue;
    const llmOptions = resolveEffectiveTaskLlmOptions(entry.task, options);
    const key = createTaskLlmSemanticConfigKey(llmOptions);
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        key,
        llmOptions,
        entries: [],
        taskIds: [],
        changedSourceKeys: []
      });
    }
    const group = groupsByKey.get(key);
    group.entries.push(entry);
    group.taskIds.push(taskId);
    group.changedSourceKeys.push(...(Array.isArray(entry.changedSourceKeys) ? entry.changedSourceKeys : []));
  }

  return [...groupsByKey.values()].map((group) => ({
    ...group,
    taskIds: [...new Set(group.taskIds)],
    changedSourceKeys: uniqueSortedStrings(group.changedSourceKeys)
  }));
}

function summarizeImportBatchLlmConfigGroups(groups = []) {
  return (Array.isArray(groups) ? groups : []).map((group, index) => ({
    key: group.key,
    index: index + 1,
    taskCount: Array.isArray(group.taskIds) ? group.taskIds.length : 0,
    taskIds: Array.isArray(group.taskIds) ? [...group.taskIds] : [],
    changedSourceKeyCount: Array.isArray(group.changedSourceKeys) ? group.changedSourceKeys.length : 0,
    llmConfig: { ...(group.llmOptions || {}) }
  }));
}

function resolveImportExecutionModeForFastMd(task = {}, options = {}, fastMdStructuralPath = false) {
  const requestedImportExecutionMode = resolveTaskImportExecutionMode(task, options);
  const appliedImportExecutionMode = requestedImportExecutionMode === 'dag' && fastMdStructuralPath
    ? 'dag'
    : 'serial';
  return {
    requestedImportExecutionMode,
    appliedImportExecutionMode,
    importExecutionModeFallbackReason: requestedImportExecutionMode === 'dag' && appliedImportExecutionMode !== 'dag'
      ? 'unsupported-import-profile'
      : null
  };
}

function resolveTaskProcessingProfile(task = {}, options = {}) {
  const raw = task.processingProfile
    || task.processing_profile
    || task.importProfile
    || task.import_profile
    || options.processingProfile
    || options.processing_profile
    || options.importProfile
    || options.import_profile
    || options.importProcessingProfile
    || options.import_processing_profile
    || 'full';
  const normalized = normalizeDashedToken(raw);
  if (normalized === 'fast-md' || normalized === 'fast-markdown') return 'fast-md-background-semantic';
  if (normalized === 'fast-md-structural' || normalized === 'fast-md-background-semantic') return normalized;
  if (normalized === 'long-context' || normalized === 'long-context-md') return 'long-context-full-md';
  if (normalized === 'long-context-full-md') return normalized;
  return 'full';
}

function isFastMdProcessingProfile(processingProfile) {
  return processingProfile === 'fast-md-structural' || processingProfile === 'fast-md-background-semantic';
}

function isMarkdownImportFile(file = {}) {
  const mimeType = normalizeDashedToken(file.mimeType || file.mime_type || file.type);
  const name = String(file.originalName || file.name || file.storedPath || '').trim().toLowerCase();
  return mimeType === 'text/markdown'
    || mimeType === 'text/x-markdown'
    || name.endsWith('.md')
    || name.endsWith('.markdown');
}

function taskHasOnlyMarkdownFiles(task = {}) {
  const files = Array.isArray(task?.files) ? task.files : [];
  return files.length > 0 && files.every((file) => isMarkdownImportFile(file));
}

function shouldUseFastMdStructuralPath(task = {}, options = {}) {
  return isFastMdProcessingProfile(resolveTaskProcessingProfile(task, options))
    && taskHasOnlyMarkdownFiles(task);
}

function createFastMdMaterializeOptions(options = {}) {
  return {
    ...options,
    semanticExtraction: 'heuristic-only',
    llmRelations: false,
    ollamaRelations: false,
    enableLlmEnrichment: false,
    enqueueEnhancements: false,
    incrementalMergeRecanonicalization: true
  };
}

function createFastMdCommitOptions(options = {}) {
  return {
    ...options,
    directDeltaCommit: true,
    fastMdDirectDeltaCommit: true
  };
}

async function appendImportDagNodeEvent(rootPath, taskId, nodeId, status = 'completed', options = {}) {
  if (!taskId || !nodeId) return null;
  const normalizedStatus = normalizeDashedToken(status) || 'completed';
  return appendImportDagEvent(rootPath, taskId, {
    event: options.event || `dag.node.${normalizedStatus}`,
    level: options.level || (normalizedStatus === 'failed' ? 'error' : 'info'),
    nodeId,
    status: normalizedStatus,
    stage: options.stage || null,
    batchId: options.batchId || null,
    sourceKey: Array.isArray(options.changedSourceKeys) && options.changedSourceKeys.length === 1
      ? options.changedSourceKeys[0]
      : null,
    message: options.message || `Import DAG node ${nodeId} ${normalizedStatus}`,
    inputArtifacts: options.inputArtifacts || [],
    outputArtifacts: options.outputArtifacts || [],
    data: {
      ...(options.requestedImportExecutionMode || options.importExecutionMode
        ? {
            importExecutionMode: options.requestedImportExecutionMode || options.importExecutionMode,
            requestedImportExecutionMode: options.requestedImportExecutionMode || null
          }
        : {}),
      ...(options.appliedImportExecutionMode || options.importExecutionModeApplied
        ? { importExecutionModeApplied: options.appliedImportExecutionMode || options.importExecutionModeApplied }
        : {}),
      changedSourceKeys: Array.isArray(options.changedSourceKeys) ? options.changedSourceKeys : [],
      ...(options.batchTaskIds ? { batchTaskIds: options.batchTaskIds } : {}),
      ...(options.authoritativeSyncJobId ? { authoritativeSyncJobId: options.authoritativeSyncJobId } : {}),
      ...(options.data && typeof options.data === 'object' ? options.data : {})
    },
    error: options.error || null
  });
}

function createSemanticEnrichmentDagArtifacts(rootPath, job = {}, result = null) {
  const { queuePath } = getImportSemanticEnrichmentPaths(rootPath);
  const jobId = String(job?.id || result?.jobId || '').trim();
  const queueArtifact = jobId
    ? {
        kind: 'import-semantic-enrichment-job',
        id: jobId,
        path: queuePath,
        role: 'queue-record'
      }
    : null;
  const resultArtifact = jobId && result
    ? {
        kind: 'import-semantic-enrichment-result',
        id: jobId,
        path: queuePath,
        role: 'queue-record-result'
      }
    : null;
  return {
    inputArtifacts: queueArtifact ? [queueArtifact] : [],
    outputArtifacts: resultArtifact ? [resultArtifact] : []
  };
}

async function appendSemanticEnrichmentDagNodeEvent(rootPath, taskId, job = {}, status = 'running', options = {}) {
  if (!taskId || !job?.id) return null;
  const normalizedStatus = normalizeDashedToken(status) || 'running';
  const result = options.result || null;
  const artifacts = createSemanticEnrichmentDagArtifacts(rootPath, job, result);
  const stageTimings = result?.metrics?.importPerformance?.stageTimingsMs || null;
  return appendImportDagNodeEvent(rootPath, taskId, 'paper.long_context_llm', normalizedStatus, {
    event: options.event,
    level: options.level,
    stage: 'semantic-enrichment',
    changedSourceKeys: Array.isArray(job.changedSourceKeys) ? job.changedSourceKeys : [],
    inputArtifacts: artifacts.inputArtifacts,
    outputArtifacts: artifacts.outputArtifacts,
    message: options.message || `Background semantic enrichment job ${job.id} ${normalizedStatus}`,
    error: options.error || null,
    data: {
      semanticEnrichmentJobId: job.id,
      semanticJobStatus: normalizedStatus,
      semanticJobStage: job.stage || 'semantic-enrichment',
      semanticJobAttempt: Number(job.attempts || 0),
      semanticJobMaxAttempts: Number(job.maxAttempts || 0) || null,
      semanticJobRetryable: options.retryable === undefined ? null : Boolean(options.retryable),
      changedSourceKeyCount: Array.isArray(job.changedSourceKeys) ? job.changedSourceKeys.length : 0,
      ...(stageTimings ? { semanticEnrichmentStageTimingsMs: stageTimings } : {}),
      ...(result?.metrics?.importPerformance?.llmBatches
        ? { llmBatchSummary: result.metrics.importPerformance.llmBatches }
        : {}),
      ...(result?.authoritativeSync?.jobId ? { authoritativeSyncJobId: result.authoritativeSync.jobId } : {})
    }
  });
}

async function appendFastMdDagStructuralEvents(rootPath, entries = [], options = {}) {
  await Promise.all((Array.isArray(entries) ? entries : []).map(async (entry) => {
    const task = entry?.task || entry;
    const taskId = task?.id;
    if (!taskId) return;
    const context = {
      ...options,
      ...(entry?.importExecutionMode || {}),
      changedSourceKeys: entry?.changedSourceKeys || []
    };
    for (const nodeId of ['source.materialize', 'chunk.normalize', 'paper.structural_snapshot']) {
      await appendImportDagNodeEvent(rootPath, taskId, nodeId, 'completed', {
        ...context,
        stage: 'materialize'
      });
    }
  }));
}

async function appendFastMdDagCommitEvents(rootPath, entries = [], options = {}) {
  await Promise.all((Array.isArray(entries) ? entries : []).map(async (entry) => {
    const task = entry?.task || entry;
    const taskId = task?.id;
    if (!taskId) return;
    const context = {
      ...options,
      ...(entry?.importExecutionMode || {}),
      changedSourceKeys: entry?.changedSourceKeys || []
    };
    for (const nodeId of ['paper.delta_build', 'corpus.merge', 'lite_state.update']) {
      await appendImportDagNodeEvent(rootPath, taskId, nodeId, 'completed', {
        ...context,
        stage: 'fast-commit'
      });
    }
    if (options.authoritativeSyncJobId || options.authoritativeSyncStatus) {
      await appendImportDagNodeEvent(rootPath, taskId, 'authoritative_sync.enqueue', 'completed', {
        ...context,
        stage: 'fast-commit',
        message: 'Authoritative sync enqueued after DAG fast-md graph-visible commit'
      });
    }
  }));
}

async function appendImportExecutionModeFallbackEvent(rootPath, task, options = {}) {
  if (!task?.id) return;
  await appendImportDagEvent(rootPath, task.id, {
    event: 'dag.execution.fallback',
    level: 'info',
    nodeId: 'task.queued',
    status: 'running',
    stage: task.stage || null,
    message: 'Requested DAG import execution is not implemented for this profile; using serial execution.',
    data: {
      importExecutionMode: options.requestedImportExecutionMode || 'dag',
      importExecutionModeApplied: options.appliedImportExecutionMode || 'serial',
      requestedImportExecutionMode: options.requestedImportExecutionMode || 'dag',
      fallbackReason: options.importExecutionModeFallbackReason || 'unsupported-import-profile'
    }
  });
}

function resolveFastMdMaterializeConcurrency(options = {}, taskCount = 1) {
  const raw = Number(
    options.fastMdMaterializeConcurrency
    ?? options.importFastMdMaterializeConcurrency
    ?? options.fast_md_materialize_concurrency
    ?? 8
  );
  const fallback = Math.min(8, Math.max(1, Number(taskCount || 1)));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.min(16, Math.floor(raw), Math.max(1, Number(taskCount || 1))));
}

function createMaterializePerformanceMetrics({
  mode = 'single-task',
  batchMaterialized = false,
  inputCount = 1,
  taskCount = 1,
  effectiveConcurrency = 1,
  analyzeConcurrency,
  metadataConcurrency,
  elapsedMs: materializeElapsedMs,
  reused = false,
  paperCount = 0
} = {}) {
  const normalizedInputCount = Math.max(1, Math.floor(Number(inputCount) || 1));
  const normalizedTaskCount = Math.max(1, Math.floor(Number(taskCount) || normalizedInputCount));
  const normalizedElapsedMs = roundMs(materializeElapsedMs) ?? 0;
  const normalizedEffectiveConcurrency = Math.max(1, Math.floor(Number(effectiveConcurrency) || 1));
  const normalizedAnalyzeConcurrency = Math.max(
    1,
    Math.floor(Number(analyzeConcurrency ?? normalizedEffectiveConcurrency) || normalizedEffectiveConcurrency)
  );
  const normalizedMetadataConcurrency = Math.max(
    1,
    Math.floor(Number(metadataConcurrency ?? normalizedEffectiveConcurrency) || normalizedEffectiveConcurrency)
  );

  return {
    contractVersion: MATERIALIZE_PERFORMANCE_CONTRACT_VERSION,
    mode,
    batchMaterialized: Boolean(batchMaterialized),
    inputCount: normalizedInputCount,
    taskCount: normalizedTaskCount,
    effectiveConcurrency: normalizedEffectiveConcurrency,
    analyzeConcurrency: normalizedAnalyzeConcurrency,
    metadataConcurrency: normalizedMetadataConcurrency,
    elapsedMs: normalizedElapsedMs,
    meanMsPerInput: roundMs(normalizedElapsedMs / normalizedInputCount) ?? 0,
    reused: Boolean(reused),
    paperCount: Number(paperCount) || 0
  };
}

function shouldEnqueueBackgroundSemanticEnrichment(processingProfile = '') {
  return processingProfile === 'fast-md-background-semantic';
}

function isImportSemanticEnrichmentWorkerEnabled(options = {}) {
  return resolveBooleanOption(
    options.importSemanticEnrichmentEnabled
    ?? options.semanticEnrichmentEnabled
    ?? options.backgroundSemanticEnrichment,
    false
  );
}

function createSemanticEnrichmentResultPayload(jobs = [], fallbackStatus = 'queued') {
  const normalizedJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  return {
    status: normalizedJobs.length ? 'queued' : fallbackStatus,
    jobIds: normalizedJobs.map((job) => job.id).filter(Boolean),
    jobs: normalizedJobs.map((job) => ({
      id: job.id,
      status: job.status,
      stage: job.stage,
      changedSourceKeys: job.changedSourceKeys || [],
      enqueuedAt: job.enqueuedAt || null
    }))
  };
}

async function enqueueBackgroundSemanticEnrichmentForEntries(rootPath, entries = [], options = {}, context = {}) {
  const jobEntries = [];
  const taskById = new Map();

  for (const entry of entries) {
    const task = entry?.task;
    if (!task?.id) continue;
    const processingProfile = resolveTaskProcessingProfile(task, options);
    if (!shouldEnqueueBackgroundSemanticEnrichment(processingProfile)) continue;
    const changedSourceKeys = uniqueSortedStrings(entry.changedSourceKeys || []);
    if (!changedSourceKeys.length) continue;
    const taskLlmOptions = {
      ...resolveTaskLlmOptionOverrides(options),
      ...resolveTaskLlmOptionOverrides(task)
    };
    taskById.set(task.id, task);
    jobEntries.push({
      taskId: task.id,
      processingProfile,
      completionPolicy: task.completionPolicy || task.completion_policy || 'graph-visible',
      ...taskLlmOptions,
      semanticConfigKey: createTaskLlmSemanticConfigKey(taskLlmOptions),
      changedSourceKeys,
      batchId: context.batchId || null,
      batchTaskIds: context.batchTaskIds || [],
      trigger: 'fast-md-background-semantic'
    });
  }

  if (!jobEntries.length) {
    return {
      queuedCount: 0,
      existingCount: 0,
      jobsByTaskId: new Map()
    };
  }

  const enqueueResult = await enqueueImportSemanticEnrichmentJobs(rootPath, jobEntries, options);
  const jobsByTaskId = new Map();
  for (const job of enqueueResult.jobs || []) {
    if (!taskById.has(job.taskId)) continue;
    const jobs = jobsByTaskId.get(job.taskId) || [];
    jobs.push(job);
    jobsByTaskId.set(job.taskId, jobs);
  }

  for (const [taskId, jobs] of jobsByTaskId.entries()) {
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message: `queued background semantic enrichment job(s): ${jobs.map((job) => job.id).join(', ')}`
    });
  }

  return {
    ...enqueueResult,
    jobsByTaskId
  };
}

async function waitForImportTaskPreparse(rootPath, taskId) {
  const promise = importPreparseInFlight.get(createImportPreparseKey(rootPath, taskId));
  if (promise) {
    await promise;
  }
}

async function preparseImportTaskSources(rootPath, task, options = {}) {
  const { markdownDir, markerDir } = getCorpusPaths(rootPath);
  const files = Array.isArray(task?.files) ? task.files : [];
  let generatedCount = 0;

  for (const file of files) {
    const storedPath = String(file?.storedPath || '').trim();
    const kind = String(file?.kind || '').trim().toLowerCase();
    const originalName = String(file?.originalName || storedPath || 'uploaded file').trim();
    if (!storedPath || (kind !== 'pdf' && kind !== 'markdown')) {
      continue;
    }

    try {
      if (kind === 'pdf') {
        const prepared = await convertPdfToMarkdown(storedPath, {
          rootPath,
          importTaskId: task.id,
          importStage: 'preparse',
          pdfParser: options.pdfParser,
          pdfCommand: options.pdfCommand,
          pythonCommand: options.pythonCommand,
          markitdownPython: options.markitdownPython,
          markitdownUseLlm: options.markitdownUseLlm,
          markitdownEnablePlugins: options.markitdownEnablePlugins,
          markitdownLlmPrompt: options.markitdownLlmPrompt,
          markpdfdownPython: options.markpdfdownPython,
          opendataloaderPdfPython: options.opendataloaderPdfPython,
          doclingPython: options.doclingPython,
          doclingCommand: options.doclingCommand,
          doclingUseVlm: options.doclingUseVlm,
          doclingVlmPreset: options.doclingVlmPreset,
          doclingOcrEngine: options.doclingOcrEngine,
          doclingSshHost: options.doclingSshHost,
          doclingPdfBackend: options.doclingPdfBackend,
          doclingDevice: options.doclingDevice,
          doclingCudaVisibleDevices: options.doclingCudaVisibleDevices,
          doclingAutoGpu: options.doclingAutoGpu,
          doclingGpuLockRoot: options.doclingGpuLockRoot,
          doclingGpuMinFreeMb: options.doclingGpuMinFreeMb,
          doclingGpuWaitTimeoutMs: options.doclingGpuWaitTimeoutMs,
          doclingGpuPollIntervalMs: options.doclingGpuPollIntervalMs,
          doclingGpuLockStaleMs: options.doclingGpuLockStaleMs,
          doclingCpuThreads: options.doclingCpuThreads,
          doclingArtifactsPath: options.doclingArtifactsPath,
          doclingImageExportMode: options.doclingImageExportMode,
          doclingEnrichPictureClasses: options.doclingEnrichPictureClasses,
          doclingEnrichPictureDescription: options.doclingEnrichPictureDescription,
          doclingPreload: options.doclingPreload,
          doclingPreloadTimeoutMs: options.doclingPreloadTimeoutMs,
          pdfParserSshHost: options.pdfParserSshHost,
          markerCommand: options.markerCommand,
          markerSshHost: options.markerSshHost,
          markerBlockBlacklist: options.markerBlockBlacklist,
          markerConcurrency: options.markerConcurrency,
          mineruCommand: options.mineruCommand,
          mineruHttpUrl: options.mineruHttpUrl,
          mineruRemoteFailureMode: options.mineruRemoteFailureMode,
          pageRange: options.pageRange,
          pdfSshHost: options.pdfSshHost,
          pdfParseTimeoutMs: options.pdfParseTimeoutMs,
          llmProvider: options.llmProvider,
          llmModel: options.llmModel,
          llmBaseUrl: options.llmBaseUrl,
          llmApiKey: options.llmApiKey,
          llmApiKeyEnv: options.llmApiKeyEnv,
          llmApiKeySource: options.llmApiKeySource,
          llmApiKeyService: options.llmApiKeyService,
          llmApiKeyAccount: options.llmApiKeyAccount,
          llmMaxTokens: options.llmMaxTokens,
          markerDir,
          markdownDir
        });
        if (prepared?.generated) {
          generatedCount += 1;
          await appendImportTaskLog(rootPath, task.id, {
            level: 'info',
            message: `background preparse prepared PDF markdown cache for ${originalName}`
          });
        }
        continue;
      }

      const prepared = await cacheMarkdownSource(storedPath, {
        markdownDir,
        force: false
      });
      if (prepared?.generated) {
        generatedCount += 1;
        await appendImportTaskLog(rootPath, task.id, {
          level: 'info',
          message: `background preparse cached markdown source for ${originalName}`
        });
      }
    } catch (error) {
      await appendImportTaskLog(rootPath, task.id, {
        level: 'warn',
        message: `background preparse failed for ${originalName}: ${error.message}`
      });
    }
  }

  return {
    taskId: task.id,
    generatedCount
  };
}

async function startQueuedImportPreparse(rootPath, options = {}, currentTaskId = '') {
  const payload = await listImportTasks(rootPath);
  const pendingTasks = (payload.tasks || [])
    .filter((task) => task?.status === 'pending' && task?.id !== currentTaskId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });

  const tasksToStart = [];
  for (const task of pendingTasks) {
    const key = createImportPreparseKey(rootPath, task.id);
    if (importPreparseInFlight.has(key)) continue;
    tasksToStart.push(task);
  }

  await mapWithConcurrency(tasksToStart, resolveImportPreparseConcurrency(options), async (task) => {
    const key = createImportPreparseKey(rootPath, task.id);
    const promise = preparseImportTaskSources(rootPath, task, options)
      .catch(() => null)
      .finally(() => {
        importPreparseInFlight.delete(key);
      });
    importPreparseInFlight.set(key, promise);
    await promise;
  });
}

async function resolveTaskInputPath(rootPath, task) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestInputPaths = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  if (!manifestInputPaths.length) {
    if (task?.sourcesDir) {
      return task.sourcesDir;
    }
    throw new Error(`Import task ${task?.id || ''} has no base input paths to rebuild from.`);
  }
  return manifestInputPaths.length === 1 ? manifestInputPaths[0] : manifestInputPaths;
}

async function resolveTaskChangedSourceKeys(rootPath, task) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestEntriesByKey = new Map(
    (manifest?.sources || []).map((entry) => [entry.sourceKey, entry])
  );
  const taskFiles = Array.isArray(task?.files) ? task.files : [];
  const changedSourceKeys = [];
  const missingFiles = [];

  for (const file of taskFiles) {
    const storedPath = String(file?.storedPath || '').trim();
    if (!storedPath) continue;
    if (manifestEntriesByKey.has(storedPath)) {
      changedSourceKeys.push(storedPath);
      continue;
    }
    missingFiles.push(file?.originalName || storedPath);
  }

  if (missingFiles.length) {
    throw new Error(
      `Imported files were not materialized into the source manifest: ${missingFiles.join(', ')}. ` +
      'The uploaded source may be missing, unreadable, or failed during parsing.'
    );
  }

  return changedSourceKeys;
}

async function assertImportTaskStoredFilesExist(task) {
  const missingFiles = [];
  for (const file of Array.isArray(task?.files) ? task.files : []) {
    const storedPath = String(file?.storedPath || '').trim();
    if (!storedPath) continue;
    if (!await fileExists(storedPath)) {
      missingFiles.push(file?.originalName || storedPath);
    }
  }
  if (missingFiles.length) {
    throw new Error(
      `Imported files were not materialized into the source manifest: ${missingFiles.join(', ')}. ` +
      'The uploaded source may be missing, unreadable, or failed during parsing.'
    );
  }
}

async function processImportTask(rootPath, task, options = {}) {
  const taskStartedAt = Date.now();
  await waitForImportTaskPreparse(rootPath, task.id);
  const corpusMeta = await loadCorpusMeta(rootPath);
  const processingProfile = resolveTaskProcessingProfile(task, options);
  const fastMdStructuralPath = shouldUseFastMdStructuralPath(task, options);
  const importExecutionMode = resolveImportExecutionModeForFastMd(task, options, fastMdStructuralPath);
  let inputPath = await resolveTaskInputPath(rootPath, task);
  const materializeInputPath = task?.sourcesDir || inputPath;
  const startStage = (() => {
    switch (task.stage) {
      case 'llm-optimize':
        return 'llm-optimize';
      case 'build-graph':
      case 'merge-graph':
      case 'write-index':
      case 'fast-commit':
        return 'fast-commit';
      case 'materialize':
      case 'queued':
      default:
      return 'materialize';
    }
  })();
  const taskLlmOptions = resolveTaskLlmOptionOverrides(task);
  const sharedOptions = {
    ...options,
    ...taskLlmOptions,
    rootPath,
    quiet: true,
    name: corpusMeta.name,
    importTaskId: task.id
  };
  const result = {
    ...(task.result || {})
  };
  const stageTimingsMs = {
    ...(result.metrics?.importPerformance?.stageTimingsMs || {})
  };
  let materializePerformance = result.metrics?.importPerformance?.materialize || null;

  if (importExecutionMode.importExecutionModeFallbackReason) {
    await appendImportExecutionModeFallbackEvent(rootPath, task, importExecutionMode);
  }

  if (startStage === 'materialize') {
    await assertImportTaskStoredFilesExist(task);
    await markImportTaskStage(rootPath, task.id, 'materialize', 'stage materialize');
    const materializeProgress = createTaskProgressReporter(rootPath, task.id, 'materialize');
    const materializeStartedAt = Date.now();
    const materialized = await materializeCorpus(materializeInputPath, {
      ...(fastMdStructuralPath ? createFastMdMaterializeOptions(sharedOptions) : sharedOptions),
      mergeWithExistingManifestSources: true,
      includeActiveImportSources: false,
      includePersistentImportSources: false,
      onProgress(event = {}) {
        void materializeProgress.report(event);
      }
    });
    await materializeProgress.report({
      stagePercent: 100,
      currentStep: 'materialization complete',
      message: 'Prepared paper snapshots',
      processedUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0,
      totalUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0
    });
    await materializeProgress.flush();
    const materializeElapsedMs = elapsedMs(materializeStartedAt);
    const materializeConcurrency = fastMdStructuralPath
      ? resolveFastMdMaterializeConcurrency(sharedOptions, 1)
      : 1;
    result.materialized = {
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0,
      timings: materialized?.timings || null,
      batchMaterialized: false,
      materializeInputCount: 1,
      materializeConcurrency
    };
    stageTimingsMs.materialize = materializeElapsedMs;
    materializePerformance = createMaterializePerformanceMetrics({
      mode: 'single-task',
      batchMaterialized: false,
      inputCount: 1,
      taskCount: 1,
      effectiveConcurrency: materializeConcurrency,
      analyzeConcurrency: materializeConcurrency,
      metadataConcurrency: materializeConcurrency,
      elapsedMs: materializeElapsedMs,
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0
    });
    if (importExecutionMode.appliedImportExecutionMode === 'dag' && fastMdStructuralPath) {
      await appendFastMdDagStructuralEvents(rootPath, [{
        task,
        changedSourceKeys: []
      }], importExecutionMode);
    }
    inputPath = await resolveTaskInputPath(rootPath, task);
  }

  const changedSourceKeys = await resolveTaskChangedSourceKeys(rootPath, task);

  const llmMetrics = createLlmBatchMetricsCollector();
  let optimized = null;
  if (fastMdStructuralPath) {
    stageTimingsMs.llmOptimize = 0;
    result.optimized = {
      skipped: true,
      reason: 'fast-md-structural-path',
      processingProfile
    };
  } else {
    await markImportTaskStage(rootPath, task.id, 'llm-optimize', 'stage llm-optimize');
    const llmProgress = createTaskProgressReporter(rootPath, task.id, 'llm-optimize');
    const llmDiagnostics = createLlmProgressDiagnosticsCollector({
      mode: 'single',
      taskId: task.id,
      changedSourceKeyCount: changedSourceKeys.length,
      llmConfig: {
        llmContextWindowTokens: sharedOptions.llmContextWindowTokens || null,
        llmExtractionStrategy: sharedOptions.llmExtractionStrategy || null,
        llmLongContextMaxPapersPerCall: sharedOptions.llmLongContextMaxPapersPerCall || null,
        llmBatchConcurrency: sharedOptions.llmBatchConcurrency || null
      }
    });
    const upstreamOnLlmBatchComplete = sharedOptions.onLlmBatchComplete;
    const upstreamOnLlmBatchRetry = sharedOptions.onLlmBatchRetry;
    const llmStartedAt = Date.now();
    optimized = await llmOptimizeCorpus(inputPath, {
      ...sharedOptions,
      changedSourceKeys,
      onProgress(event = {}) {
        void llmProgress.report(event);
      },
      onLlmBatchComplete(event = {}) {
        llmMetrics.recordComplete(event);
        void reportLlmProgressDiagnostics(llmProgress, llmDiagnostics, event, 'complete');
        upstreamOnLlmBatchComplete?.(event);
      },
      onLlmBatchRetry(event = {}) {
        llmMetrics.recordRetry(event);
        void reportLlmProgressDiagnostics(llmProgress, llmDiagnostics, event, 'retry');
        upstreamOnLlmBatchRetry?.(event);
      }
    });
    stageTimingsMs.llmOptimize = elapsedMs(llmStartedAt);
    await llmProgress.report({
      stagePercent: 100,
      currentStep: 'llm optimization complete',
      message: 'Completed LLM optimization',
      diagnostics: llmDiagnostics.snapshot({
        status: 'completed',
        completedAt: new Date().toISOString()
      })
    });
    await llmProgress.flush();
    result.optimized = {
      reused: Boolean(optimized?.reused)
    };
  }

  await markImportTaskStage(rootPath, task.id, 'fast-commit', 'stage fast-commit');
  const fastCommitProgress = createTaskProgressReporter(rootPath, task.id, 'fast-commit');
  const fastCommitStartedAt = Date.now();
  const committed = await fastCommitCorpus(inputPath, {
    ...(fastMdStructuralPath ? createFastMdCommitOptions(sharedOptions) : sharedOptions),
    changedSourceKeys,
    mode: 'import',
    onProgress(event = {}) {
      void fastCommitProgress.report(event);
    }
  });
  stageTimingsMs.fastCommit = elapsedMs(fastCommitStartedAt);
  await fastCommitProgress.report({
    stagePercent: 100,
    currentStep: 'fast commit complete',
    message: 'Applied graph update'
  });
  await fastCommitProgress.flush();

  result.fastCommitted = {
    reused: Boolean(committed?.reused),
    paperCount: committed?.meta?.paperCount || 0,
    nodeCount: committed?.meta?.nodeCount || 0,
    relationshipCount: committed?.meta?.relationshipCount || 0
  };
  if (committed?.directDeltaCommit) {
    result.fastCommitted.directDeltaCommit = true;
  }
  result.authoritativeSync = {
    status: committed?.meta?.authoritativeSyncStatus || 'pending',
    jobId: committed?.syncJob?.jobId || null
  };
  if (importExecutionMode.appliedImportExecutionMode === 'dag' && fastMdStructuralPath) {
    await appendFastMdDagCommitEvents(rootPath, [{
      task,
      changedSourceKeys
    }], {
      ...importExecutionMode,
      authoritativeSyncStatus: result.authoritativeSync.status,
      authoritativeSyncJobId: result.authoritativeSync.jobId
    });
  }
  if (fastMdStructuralPath) {
    const enrichment = await enqueueBackgroundSemanticEnrichmentForEntries(
      rootPath,
      [{ task, changedSourceKeys }],
      sharedOptions
    );
    const semanticJobs = enrichment.jobsByTaskId.get(task.id) || [];
    result.graphVisibilityStatus = 'completed';
    if (shouldEnqueueBackgroundSemanticEnrichment(processingProfile)) {
      result.semanticStatus = semanticJobs.length ? 'queued' : 'pending';
      result.semanticEnrichment = createSemanticEnrichmentResultPayload(semanticJobs, result.semanticStatus);
    } else {
      result.semanticStatus = 'not-required';
      result.semanticEnrichment = {
        status: 'not-required',
        jobIds: [],
        jobs: []
      };
    }
    result.throughputMetrics = {
      ...(result.throughputMetrics || {}),
      processingProfile,
      requestedImportExecutionMode: importExecutionMode.requestedImportExecutionMode,
      importExecutionModeApplied: importExecutionMode.appliedImportExecutionMode,
      graphVisibleLatencyMs: elapsedMs(taskStartedAt),
      changedSourceKeyCount: changedSourceKeys.length,
      directDeltaCommit: Boolean(committed?.directDeltaCommit)
    };
  }
  stageTimingsMs.total = elapsedMs(taskStartedAt);
  setImportPerformanceMetrics(result, {
    mode: 'single',
    taskId: task.id,
    batchId: null,
    batchTaskCount: 1,
    processingProfile,
    completionPolicy: task.completionPolicy || task.completion_policy || null,
    requestedImportExecutionMode: importExecutionMode.requestedImportExecutionMode,
    importExecutionModeApplied: importExecutionMode.appliedImportExecutionMode,
    importExecutionModeFallbackReason: importExecutionMode.importExecutionModeFallbackReason,
    changedSourceKeyCount: changedSourceKeys.length,
    optimizedReused: Boolean(optimized?.reused),
    llmOptimizeSkipped: fastMdStructuralPath,
    fastCommitReused: Boolean(committed?.reused),
    directDeltaCommit: Boolean(committed?.directDeltaCommit),
    fastCommitPhasesMs: committed?.fastCommitMetrics?.phaseTimingsMs,
    materialize: materializePerformance,
    stageTimingsMs,
    llmBatches: llmMetrics.summary()
  });

  await completeImportTask(rootPath, task.id, result);

  return committed;
}

function uniqueSortedStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )].sort();
}

async function materializeImportTaskForBatch(rootPath, task, options = {}, context = {}) {
  await waitForImportTaskPreparse(rootPath, task.id);
  let inputPath = await resolveTaskInputPath(rootPath, task);
  const materializeInputPath = task?.sourcesDir || inputPath;
  const sharedOptions = {
    ...options,
    rootPath,
    quiet: true,
    name: context.corpusName,
    importTaskId: task.id,
    importBatchId: context.batchId,
    importBatchTaskIds: context.batchTaskIds
  };
  const result = {
    ...(task.result || {})
  };

  await assertImportTaskStoredFilesExist(task);
  await markImportTaskStage(rootPath, task.id, 'materialize', `stage materialize batch ${context.batchId}`);
  const materializeProgress = createTaskProgressReporter(rootPath, task.id, 'materialize');
  const materializeStartedAt = Date.now();
  const materialized = await materializeCorpus(materializeInputPath, {
    ...sharedOptions,
    mergeWithExistingManifestSources: true,
    includeActiveImportSources: false,
    includePersistentImportSources: false,
    onProgress(event = {}) {
      void materializeProgress.report(event);
    }
  });
  await materializeProgress.report({
    stagePercent: 100,
    currentStep: `batch ${context.batchId} materialization complete`,
    message: 'Prepared paper snapshots',
    processedUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0,
    totalUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0
  });
  await materializeProgress.flush();
  const materializeElapsedMs = elapsedMs(materializeStartedAt);
  result.materialized = {
    reused: Boolean(materialized?.reused),
    paperCount: materialized?.meta?.paperCount || 0,
    timings: materialized?.timings || null,
    batchId: context.batchId,
    batchMaterialized: false,
    materializeInputCount: 1,
    materializeConcurrency: 1
  };

  inputPath = await resolveTaskInputPath(rootPath, task);
  const changedSourceKeys = await resolveTaskChangedSourceKeys(rootPath, task);
  setImportPerformanceMetrics(result, {
    mode: 'batch',
    taskId: task.id,
    batchId: context.batchId,
    batchTaskCount: Array.isArray(context.batchTaskIds) ? context.batchTaskIds.length : 0,
    changedSourceKeyCount: changedSourceKeys.length,
    materialize: createMaterializePerformanceMetrics({
      mode: 'batch-single-task',
      batchMaterialized: false,
      inputCount: 1,
      taskCount: 1,
      effectiveConcurrency: 1,
      analyzeConcurrency: 1,
      metadataConcurrency: 1,
      elapsedMs: materializeElapsedMs,
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0
    }),
    stageTimingsMs: {
      materialize: materializeElapsedMs
    }
  });
  return {
    task,
    inputPath,
    changedSourceKeys,
    result
  };
}

async function materializeFastMdImportTaskBatch(rootPath, tasks = [], options = {}, context = {}) {
  const eligibleTasks = [];
  const failedTaskIds = [];
  const materializeInputPaths = [];
  const materializeConcurrency = resolveFastMdMaterializeConcurrency(options, tasks.length);
  const materializeOptions = createFastMdMaterializeOptions({
    ...options,
    analyzeConcurrency: options.analyzeConcurrency ?? materializeConcurrency,
    metadataConcurrency: options.metadataConcurrency ?? materializeConcurrency
  });

  for (const task of tasks) {
    try {
      await waitForImportTaskPreparse(rootPath, task.id);
      await assertImportTaskStoredFilesExist(task);
      const inputPath = await resolveTaskInputPath(rootPath, task);
      eligibleTasks.push({
        task,
        inputPath
      });
      materializeInputPaths.push(task?.sourcesDir || inputPath);
    } catch (error) {
      await failImportTask(rootPath, task.id, error);
      failedTaskIds.push(task.id);
    }
  }

  if (!eligibleTasks.length) {
    return {
      materializedEntries: [],
      failedTaskIds
    };
  }

  await Promise.all(eligibleTasks.map(({ task }) => (
    markImportTaskStage(rootPath, task.id, 'materialize', `stage materialize batch ${context.batchId}`)
  )));
  const materializeProgress = createBatchProgressReporter(
    rootPath,
    eligibleTasks.map(({ task }) => task.id),
    'materialize',
    context.batchId
  );
  const materializeStartedAt = Date.now();
  const materialized = await materializeCorpus(materializeInputPaths, {
    ...materializeOptions,
    rootPath,
    quiet: true,
    name: context.corpusName,
    importBatchId: context.batchId,
    importBatchTaskIds: context.batchTaskIds,
    mergeWithExistingManifestSources: true,
    includeActiveImportSources: false,
    includePersistentImportSources: false,
    onProgress(event = {}) {
      void materializeProgress.report(event);
    }
  });
  await materializeProgress.report({
    stagePercent: 100,
    currentStep: `batch ${context.batchId} materialization complete`,
    message: 'Prepared fast-md paper snapshots',
    processedUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || eligibleTasks.length,
    totalUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || eligibleTasks.length
  });
  await materializeProgress.flush();

  const materializeElapsedMs = elapsedMs(materializeStartedAt);
  const materializedEntries = [];
  for (const { task } of eligibleTasks) {
    const result = {
      ...(task.result || {})
    };
    const inputPath = await resolveTaskInputPath(rootPath, task);
    const changedSourceKeys = await resolveTaskChangedSourceKeys(rootPath, task);
    result.materialized = {
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0,
      timings: materialized?.timings || null,
      batchId: context.batchId,
      batchMaterialized: true,
      materializeInputCount: materializeInputPaths.length,
      materializeConcurrency,
      analyzeConcurrency: materializeOptions.analyzeConcurrency,
      metadataConcurrency: materializeOptions.metadataConcurrency,
      meanMsPerInput: roundMs(materializeElapsedMs / Math.max(1, materializeInputPaths.length)) ?? 0
    };
    setImportPerformanceMetrics(result, {
      mode: 'batch',
      taskId: task.id,
      batchId: context.batchId,
      batchTaskCount: Array.isArray(context.batchTaskIds) ? context.batchTaskIds.length : 0,
      changedSourceKeyCount: changedSourceKeys.length,
      materialize: createMaterializePerformanceMetrics({
        mode: 'fast-md-batch',
        batchMaterialized: true,
        inputCount: materializeInputPaths.length,
        taskCount: eligibleTasks.length,
        effectiveConcurrency: materializeConcurrency,
        analyzeConcurrency: materializeOptions.analyzeConcurrency,
        metadataConcurrency: materializeOptions.metadataConcurrency,
        elapsedMs: materializeElapsedMs,
        reused: Boolean(materialized?.reused),
        paperCount: materialized?.meta?.paperCount || 0
      }),
      stageTimingsMs: {
        materialize: materializeElapsedMs
      }
    });
    materializedEntries.push({
      task,
      inputPath,
      changedSourceKeys,
      result
    });
  }

  return {
    materializedEntries,
    failedTaskIds
  };
}

async function failBatchEntries(rootPath, entries = [], error) {
  const failedTaskIds = [];
  for (const entry of entries) {
    const task = entry?.task || entry;
    if (!task?.id) continue;
    await failImportTask(rootPath, task.id, error);
    failedTaskIds.push(task.id);
  }
  return failedTaskIds;
}

async function processImportTaskBatch(rootPath, batch, options = {}) {
  const batchStartedAt = Date.now();
  const tasks = Array.isArray(batch?.tasks) ? batch.tasks.filter(Boolean) : [];
  if (!tasks.length) {
    return {
      processed: false,
      reason: 'idle'
    };
  }
  if (tasks.length === 1) {
    const result = await processImportTask(rootPath, tasks[0], options);
    return {
      processed: true,
      failed: false,
      taskId: tasks[0].id,
      completedTaskIds: [tasks[0].id],
      failedTaskIds: [],
      batchId: batch?.batchId || null,
      batchTaskIds: [tasks[0].id],
      result
    };
  }

  const batchId = batch.batchId;
  const batchTaskIds = tasks.map((task) => task.id);
  const corpusMeta = await loadCorpusMeta(rootPath);
  const batchFastMdStructuralPath = tasks.every((task) => shouldUseFastMdStructuralPath(task, options));
  const batchProcessingProfile = batchFastMdStructuralPath
    ? resolveTaskProcessingProfile(tasks[0], options)
    : 'full';
  const importExecutionModesByTaskId = new Map(tasks.map((task) => [
    task.id,
    resolveImportExecutionModeForFastMd(task, options, batchFastMdStructuralPath)
  ]));
  const context = {
    batchId,
    batchTaskIds,
    corpusName: corpusMeta.name
  };
  const materializedEntries = [];
  const failedTaskIds = [];

  await Promise.all(tasks.map((task) => {
    const mode = importExecutionModesByTaskId.get(task.id);
    return mode?.importExecutionModeFallbackReason
      ? appendImportExecutionModeFallbackEvent(rootPath, task, mode)
      : Promise.resolve();
  }));

  if (batchFastMdStructuralPath) {
    const batchMaterialized = await materializeFastMdImportTaskBatch(rootPath, tasks, options, context);
    materializedEntries.push(...batchMaterialized.materializedEntries);
    failedTaskIds.push(...batchMaterialized.failedTaskIds);
  } else {
    for (const task of tasks) {
      try {
        materializedEntries.push(await materializeImportTaskForBatch(rootPath, task, options, context));
      } catch (error) {
        await failImportTask(rootPath, task.id, error);
        failedTaskIds.push(task.id);
      }
    }
  }

  if (!materializedEntries.length) {
    return {
      processed: true,
      failed: true,
      batchId,
      batchTaskIds,
      taskId: batchTaskIds[0] || null,
      completedTaskIds: [],
      failedTaskIds,
      error: 'All import batch tasks failed during materialize'
    };
  }
  for (const entry of materializedEntries) {
    entry.importExecutionMode = importExecutionModesByTaskId.get(entry.task.id) || {
      requestedImportExecutionMode: 'serial',
      appliedImportExecutionMode: 'serial',
      importExecutionModeFallbackReason: null
    };
  }
  if (batchFastMdStructuralPath) {
    await appendFastMdDagStructuralEvents(
      rootPath,
      materializedEntries.filter((entry) => entry.importExecutionMode?.appliedImportExecutionMode === 'dag'),
      {
        batchId,
        batchTaskIds
      }
    );
  }

  const completedTaskIds = materializedEntries.map((entry) => entry.task.id);
  const batchChangedSourceKeys = uniqueSortedStrings(
    materializedEntries.flatMap((entry) => entry.changedSourceKeys)
  );
  const inputPath = materializedEntries[0].inputPath;
  const sharedOptions = {
    ...options,
    rootPath,
    quiet: true,
    name: corpusMeta.name,
    importBatchId: batchId,
    importBatchTaskIds: batchTaskIds
  };
  let optimized = null;
  let committed = null;
  const sharedStageTimingsMs = {};
  const llmMetrics = createLlmBatchMetricsCollector();
  const upstreamOnLlmBatchComplete = sharedOptions.onLlmBatchComplete;
  const upstreamOnLlmBatchRetry = sharedOptions.onLlmBatchRetry;
  let llmOptimizationGroups = [];
  let llmOptimizationGroupSummaries = [];
  const llmOptimizationGroupByTaskId = new Map();

  try {
    if (batchFastMdStructuralPath) {
      sharedStageTimingsMs.llmOptimize = 0;
      optimized = {
        skipped: true,
        reason: 'fast-md-structural-path',
        processingProfile: batchProcessingProfile
      };
    } else {
      await Promise.all(materializedEntries.map((entry) => (
        markImportTaskStage(rootPath, entry.task.id, 'llm-optimize', `stage llm-optimize batch ${batchId}`)
      )));
      llmOptimizationGroups = createImportBatchLlmConfigGroups(materializedEntries, sharedOptions);
      llmOptimizationGroupSummaries = summarizeImportBatchLlmConfigGroups(llmOptimizationGroups);
      for (const group of llmOptimizationGroups) {
        for (const taskId of group.taskIds) {
          llmOptimizationGroupByTaskId.set(taskId, group);
        }
      }
      const batchLlmProgress = createBatchProgressReporter(rootPath, completedTaskIds, 'llm-optimize', batchId);
      const batchLlmDiagnostics = createLlmProgressDiagnosticsCollector({
        mode: 'batch',
        batchId,
        batchTaskCount: completedTaskIds.length,
        changedSourceKeyCount: batchChangedSourceKeys.length
      });
      const llmStartedAt = Date.now();
      const optimizedGroups = [];
      for (const [groupIndex, group] of llmOptimizationGroups.entries()) {
        const hasMultipleGroups = llmOptimizationGroups.length > 1;
        const groupNumber = groupIndex + 1;
        const groupProgress = hasMultipleGroups
          ? createBatchProgressReporter(rootPath, group.taskIds, 'llm-optimize', batchId)
          : batchLlmProgress;
        const groupDiagnostics = hasMultipleGroups
          ? createLlmProgressDiagnosticsCollector({
              mode: 'batch-config-group',
              batchId,
              batchTaskCount: group.taskIds.length,
              changedSourceKeyCount: group.changedSourceKeys.length,
              importBatchLlmConfigKey: group.key,
              importBatchLlmConfigGroupIndex: groupNumber,
              importBatchLlmConfigGroupCount: llmOptimizationGroups.length,
              llmConfig: { ...(group.llmOptions || {}) }
            })
          : batchLlmDiagnostics;
        const groupStartedAt = Date.now();
        const groupOptimized = await llmOptimizeCorpus(inputPath, {
          ...sharedOptions,
          ...group.llmOptions,
          changedSourceKeys: group.changedSourceKeys,
          importBatchTaskIds: group.taskIds,
          importBatchLlmConfigKey: group.key,
          importBatchLlmConfigGroupIndex: groupNumber,
          importBatchLlmConfigGroupCount: llmOptimizationGroups.length,
          onProgress(event = {}) {
            void groupProgress.report(event);
          },
          onLlmBatchComplete(event = {}) {
            const decoratedEvent = {
              ...event,
              importBatchLlmConfigKey: group.key,
              importBatchLlmConfigGroupIndex: groupNumber,
              importBatchLlmConfigGroupCount: llmOptimizationGroups.length
            };
            llmMetrics.recordComplete(decoratedEvent);
            if (hasMultipleGroups) {
              batchLlmDiagnostics.recordComplete(decoratedEvent);
            }
            void reportLlmProgressDiagnostics(groupProgress, groupDiagnostics, decoratedEvent, 'complete');
            upstreamOnLlmBatchComplete?.(decoratedEvent);
          },
          onLlmBatchRetry(event = {}) {
            const decoratedEvent = {
              ...event,
              importBatchLlmConfigKey: group.key,
              importBatchLlmConfigGroupIndex: groupNumber,
              importBatchLlmConfigGroupCount: llmOptimizationGroups.length
            };
            llmMetrics.recordRetry(decoratedEvent);
            if (hasMultipleGroups) {
              batchLlmDiagnostics.recordRetry(decoratedEvent);
            }
            void reportLlmProgressDiagnostics(groupProgress, groupDiagnostics, decoratedEvent, 'retry');
            upstreamOnLlmBatchRetry?.(decoratedEvent);
          }
        });
        optimizedGroups.push({
          key: group.key,
          reused: Boolean(groupOptimized?.reused),
          taskIds: [...group.taskIds],
          changedSourceKeys: [...group.changedSourceKeys],
          durationMs: elapsedMs(groupStartedAt),
          llmConfig: { ...(group.llmOptions || {}) }
        });
        if (hasMultipleGroups) {
          await groupProgress.report({
            stagePercent: 100,
            currentStep: `batch ${batchId} LLM config group ${groupNumber}/${llmOptimizationGroups.length} complete`,
            message: 'Completed LLM optimization for config group',
            diagnostics: groupDiagnostics.snapshot({
              status: 'completed',
              completedAt: new Date().toISOString()
            })
          });
          await groupProgress.flush();
        }
      }
      optimized = {
        reused: optimizedGroups.length > 0 && optimizedGroups.every((group) => group.reused),
        llmConfigGroupCount: llmOptimizationGroups.length,
        llmConfigGroups: optimizedGroups
      };
      sharedStageTimingsMs.llmOptimize = elapsedMs(llmStartedAt);
      await batchLlmProgress.report({
        stagePercent: 100,
        currentStep: `batch ${batchId} llm optimization complete`,
        message: 'Completed LLM optimization',
        diagnostics: batchLlmDiagnostics.snapshot({
          status: 'completed',
          completedAt: new Date().toISOString()
        })
      });
      await batchLlmProgress.flush();
    }

    await Promise.all(materializedEntries.map((entry) => (
      markImportTaskStage(rootPath, entry.task.id, 'fast-commit', `stage fast-commit batch ${batchId}`)
    )));
    const fastCommitProgress = createBatchProgressReporter(rootPath, completedTaskIds, 'fast-commit', batchId);
    const fastCommitStartedAt = Date.now();
    committed = await fastCommitCorpus(inputPath, {
      ...(batchFastMdStructuralPath ? createFastMdCommitOptions(sharedOptions) : sharedOptions),
      changedSourceKeys: batchChangedSourceKeys,
      mode: 'import-batch',
      onProgress(event = {}) {
        void fastCommitProgress.report(event);
      }
    });
    sharedStageTimingsMs.fastCommit = elapsedMs(fastCommitStartedAt);
    await fastCommitProgress.report({
      stagePercent: 100,
      currentStep: `batch ${batchId} fast commit complete`,
      message: 'Applied graph update'
    });
    await fastCommitProgress.flush();
    if (batchFastMdStructuralPath) {
      await appendFastMdDagCommitEvents(
        rootPath,
        materializedEntries.filter((entry) => entry.importExecutionMode?.appliedImportExecutionMode === 'dag'),
        {
          batchId,
          batchTaskIds,
          authoritativeSyncStatus: committed?.meta?.authoritativeSyncStatus || 'pending',
          authoritativeSyncJobId: committed?.syncJob?.jobId || null
        }
      );
    }
  } catch (error) {
    const sharedStageFailedTaskIds = await failBatchEntries(rootPath, materializedEntries, error);
    return {
      processed: true,
      failed: true,
      batchId,
      batchTaskIds,
      taskId: batchTaskIds[0] || null,
      completedTaskIds: [],
      failedTaskIds: uniqueSortedStrings([...failedTaskIds, ...sharedStageFailedTaskIds]),
      error: error.message
    };
  }

  const semanticEnrichment = batchFastMdStructuralPath
    ? await enqueueBackgroundSemanticEnrichmentForEntries(rootPath, materializedEntries, sharedOptions, {
        batchId,
        batchTaskIds
      })
    : {
        jobsByTaskId: new Map()
      };

  for (const entry of materializedEntries) {
    const entryStageTimingsMs = {
      ...(entry.result.metrics?.importPerformance?.stageTimingsMs || {}),
      ...sharedStageTimingsMs
    };
    entryStageTimingsMs.total = sumKnownStageTimings(entryStageTimingsMs);
    const entryLlmGroup = llmOptimizationGroupByTaskId.get(entry.task.id);
    const entryLlmGroupMetrics = entryLlmGroup
      ? {
          llmConfigKey: entryLlmGroup.key,
          llmConfigGroupCount: llmOptimizationGroups.length,
          llmConfigGroupTaskCount: entryLlmGroup.taskIds.length,
          llmConfigGroupChangedSourceKeyCount: entryLlmGroup.changedSourceKeys.length,
          llmConfig: { ...(entryLlmGroup.llmOptions || {}) }
        }
      : {};
    setImportPerformanceMetrics(entry.result, {
      mode: 'batch',
      taskId: entry.task.id,
      batchId,
      batchTaskCount: batchTaskIds.length,
      processingProfile: resolveTaskProcessingProfile(entry.task, options),
      completionPolicy: entry.task.completionPolicy || entry.task.completion_policy || null,
      requestedImportExecutionMode: entry.importExecutionMode?.requestedImportExecutionMode || 'serial',
      importExecutionModeApplied: entry.importExecutionMode?.appliedImportExecutionMode || 'serial',
      importExecutionModeFallbackReason: entry.importExecutionMode?.importExecutionModeFallbackReason || null,
      changedSourceKeyCount: entry.changedSourceKeys.length,
      batchChangedSourceKeyCount: batchChangedSourceKeys.length,
      optimizedReused: Boolean(optimized?.reused),
      llmOptimizeSkipped: batchFastMdStructuralPath,
      fastCommitReused: Boolean(committed?.reused),
      directDeltaCommit: Boolean(committed?.directDeltaCommit),
      fastCommitPhasesMs: committed?.fastCommitMetrics?.phaseTimingsMs,
      stageTimingsMs: entryStageTimingsMs,
      llmBatches: llmMetrics.summary(),
      ...entryLlmGroupMetrics
    });
    const taskResult = {
      ...entry.result,
      optimized: optimized?.skipped
        ? {
            skipped: true,
            reason: optimized.reason,
            processingProfile: optimized.processingProfile,
            batchId,
            batchChangedSourceKeys
          }
        : {
            reused: Boolean(optimized?.reused),
            batchId,
            batchChangedSourceKeys,
            ...(llmOptimizationGroupSummaries.length > 1 ? { llmConfigGroups: llmOptimizationGroupSummaries } : {})
          },
      fastCommitted: {
        reused: Boolean(committed?.reused),
        paperCount: committed?.meta?.paperCount || 0,
        nodeCount: committed?.meta?.nodeCount || 0,
        relationshipCount: committed?.meta?.relationshipCount || 0,
        directDeltaCommit: Boolean(committed?.directDeltaCommit),
        batchId,
        batchTaskIds,
        changedSourceKeys: entry.changedSourceKeys,
        batchChangedSourceKeys
      },
      authoritativeSync: {
        status: committed?.meta?.authoritativeSyncStatus || 'pending',
        jobId: committed?.syncJob?.jobId || null
      },
      batch: {
        batchId,
        batchTaskIds,
        completedTaskIds,
        failedTaskIds,
        changedSourceKeys: batchChangedSourceKeys
      }
    };
    if (batchFastMdStructuralPath) {
      const entryProcessingProfile = resolveTaskProcessingProfile(entry.task, options);
      const semanticJobs = semanticEnrichment.jobsByTaskId.get(entry.task.id) || [];
      taskResult.graphVisibilityStatus = 'completed';
      if (shouldEnqueueBackgroundSemanticEnrichment(entryProcessingProfile)) {
        taskResult.semanticStatus = semanticJobs.length ? 'queued' : 'pending';
        taskResult.semanticEnrichment = createSemanticEnrichmentResultPayload(semanticJobs, taskResult.semanticStatus);
      } else {
        taskResult.semanticStatus = 'not-required';
        taskResult.semanticEnrichment = {
          status: 'not-required',
          jobIds: [],
          jobs: []
        };
      }
      taskResult.throughputMetrics = {
        ...(taskResult.throughputMetrics || {}),
        processingProfile: entryProcessingProfile,
        requestedImportExecutionMode: entry.importExecutionMode?.requestedImportExecutionMode || 'serial',
        importExecutionModeApplied: entry.importExecutionMode?.appliedImportExecutionMode || 'serial',
        graphVisibleLatencyMs: elapsedMs(batchStartedAt),
        changedSourceKeyCount: entry.changedSourceKeys.length,
        batchChangedSourceKeyCount: batchChangedSourceKeys.length,
        directDeltaCommit: Boolean(committed?.directDeltaCommit)
      };
    }
    await completeImportTask(rootPath, entry.task.id, taskResult);
    await appendImportTaskLog(rootPath, entry.task.id, {
      level: 'info',
      message: `completed import task in batch ${batchId}`
    });
  }

  return {
    processed: true,
    failed: failedTaskIds.length > 0,
    batchId,
    batchTaskIds,
    taskId: completedTaskIds[0] || batchTaskIds[0] || null,
    completedTaskIds,
    failedTaskIds,
    result: committed,
    metrics: {
      importPerformance: {
        contractVersion: IMPORT_PERFORMANCE_CONTRACT_VERSION,
        mode: 'batch',
        batchId,
        batchTaskCount: batchTaskIds.length,
        completedTaskCount: completedTaskIds.length,
        failedTaskCount: failedTaskIds.length,
        batchChangedSourceKeyCount: batchChangedSourceKeys.length,
        stageTimingsMs: {
          ...sharedStageTimingsMs,
          total: elapsedMs(batchStartedAt)
        },
        llmBatches: llmMetrics.summary(),
        ...(llmOptimizationGroupSummaries.length > 1
          ? {
              llmConfigGroupCount: llmOptimizationGroupSummaries.length,
              llmConfigGroups: llmOptimizationGroupSummaries
            }
          : {})
      }
    }
  };
}

async function processImportSemanticEnrichmentJob(rootPath, job, options = {}) {
  const task = await loadImportTask(rootPath, job.taskId);
  if (!task?.id) {
    throw new Error(`Import semantic enrichment job ${job.id} references missing task ${job.taskId}.`);
  }

  const corpusMeta = await loadCorpusMeta(rootPath);
  const inputPath = await resolveTaskInputPath(rootPath, task);
  const changedSourceKeys = uniqueSortedStrings(
    job.changedSourceKeys?.length ? job.changedSourceKeys : await resolveTaskChangedSourceKeys(rootPath, task)
  );
  if (!changedSourceKeys.length) {
    throw new Error(`Import semantic enrichment job ${job.id} has no changed source keys.`);
  }

  await updateImportTaskSemanticLifecycle(rootPath, task.id, 'running', {
    jobId: job.id,
    message: `started background semantic enrichment job ${job.id}`
  });
  await appendSemanticEnrichmentDagNodeEvent(rootPath, task.id, job, 'running', {
    message: `started background semantic enrichment job ${job.id}`
  });

  const startedAt = Date.now();
  const jobLlmOptions = resolveTaskLlmOptionOverrides(job);
  const sharedOptions = {
    ...options,
    ...jobLlmOptions,
    rootPath,
    quiet: true,
    name: corpusMeta.name,
    importTaskId: task.id,
    importSemanticEnrichmentJobId: job.id
  };
  const llmMetrics = createLlmBatchMetricsCollector();
  const upstreamOnLlmBatchComplete = sharedOptions.onLlmBatchComplete;
  const upstreamOnLlmBatchRetry = sharedOptions.onLlmBatchRetry;
  const upstreamOnProgress = sharedOptions.onProgress;

  const llmStartedAt = Date.now();
  const llmProgress = createSemanticJobProgressReporter(rootPath, job.id, 'llm-optimize');
  const llmDiagnostics = createLlmProgressDiagnosticsCollector({
    mode: 'semantic-enrichment',
    taskId: task.id,
    semanticEnrichmentJobId: job.id,
    changedSourceKeyCount: changedSourceKeys.length,
    llmConfig: {
      llmContextWindowTokens: sharedOptions.llmContextWindowTokens || null,
      llmExtractionStrategy: sharedOptions.llmExtractionStrategy || null,
      llmLongContextMaxPapersPerCall: sharedOptions.llmLongContextMaxPapersPerCall || null,
      llmBatchConcurrency: sharedOptions.llmBatchConcurrency || null
    }
  });
  const optimized = await llmOptimizeCorpus(inputPath, {
    ...sharedOptions,
    changedSourceKeys,
    onProgress(event = {}) {
      void llmProgress.report(event);
      upstreamOnProgress?.(event);
    },
    onLlmBatchComplete(event = {}) {
      llmMetrics.recordComplete(event);
      void reportLlmProgressDiagnostics(llmProgress, llmDiagnostics, event, 'complete');
      upstreamOnLlmBatchComplete?.(event);
    },
    onLlmBatchRetry(event = {}) {
      llmMetrics.recordRetry(event);
      void reportLlmProgressDiagnostics(llmProgress, llmDiagnostics, event, 'retry');
      upstreamOnLlmBatchRetry?.(event);
    }
  });
  const llmOptimizeMs = elapsedMs(llmStartedAt);
  await llmProgress.report({
    stagePercent: 100,
    currentStep: 'llm optimization complete',
    message: 'Completed background semantic LLM optimization',
    diagnostics: llmDiagnostics.snapshot({
      status: 'completed',
      completedAt: new Date().toISOString()
    })
  });
  await llmProgress.flush();

  const fastCommitStartedAt = Date.now();
  const fastCommitProgress = createSemanticJobProgressReporter(rootPath, job.id, 'fast-commit');
  const committed = await fastCommitCorpus(inputPath, {
    ...sharedOptions,
    changedSourceKeys,
    mode: 'import-semantic-enrichment',
    onProgress(event = {}) {
      void fastCommitProgress.report(event);
      upstreamOnProgress?.(event);
    }
  });
  const fastCommitMs = elapsedMs(fastCommitStartedAt);
  await fastCommitProgress.report({
    stagePercent: 100,
    currentStep: 'fast commit complete',
    message: 'Applied background semantic graph update'
  });
  await fastCommitProgress.flush();
  const totalMs = elapsedMs(startedAt);
  const result = {
    taskId: task.id,
    jobId: job.id,
    changedSourceKeys,
    optimized: {
      reused: Boolean(optimized?.reused)
    },
    fastCommitted: {
      reused: Boolean(committed?.reused),
      paperCount: committed?.meta?.paperCount || 0,
      nodeCount: committed?.meta?.nodeCount || 0,
      relationshipCount: committed?.meta?.relationshipCount || 0
    },
    authoritativeSync: {
      status: committed?.meta?.authoritativeSyncStatus || 'pending',
      jobId: committed?.syncJob?.jobId || null
    },
    metrics: {
      importPerformance: {
        contractVersion: IMPORT_PERFORMANCE_CONTRACT_VERSION,
        mode: 'semantic-enrichment',
        taskId: task.id,
        semanticEnrichmentJobId: job.id,
        changedSourceKeyCount: changedSourceKeys.length,
        stageTimingsMs: {
          llmOptimize: roundMs(llmOptimizeMs),
          fastCommit: roundMs(fastCommitMs),
          total: roundMs(totalMs)
        },
        llmBatches: llmMetrics.summary()
      }
    }
  };

  await completeImportSemanticEnrichmentJob(rootPath, job.id, result);
  await updateImportTaskSemanticLifecycle(rootPath, task.id, 'completed', {
    jobId: job.id,
    result,
    throughputMetrics: {
      semanticEnrichmentLatencyMs: roundMs(totalMs),
      semanticEnrichmentJobId: job.id
    },
    message: `completed background semantic enrichment job ${job.id}`
  });
  await appendSemanticEnrichmentDagNodeEvent(rootPath, task.id, job, 'completed', {
    result,
    message: `completed background semantic enrichment job ${job.id}`
  });

  return result;
}

export async function runImportSemanticEnrichmentQueueOnce(rootPath, options = {}) {
  const { workerLockPath } = getImportSemanticEnrichmentPaths(rootPath);
  try {
    return await withFileLock(workerLockPath, async () => {
      const reserved = await reserveNextImportSemanticEnrichmentJob(rootPath, options);
      if (!reserved?.job) {
        return {
          processed: false,
          reason: 'idle',
          summary: (await listImportSemanticEnrichmentJobs(rootPath)).summary
        };
      }

      try {
        const result = await processImportSemanticEnrichmentJob(rootPath, reserved.job, options);
        return {
          processed: true,
          failed: false,
          semanticEnrichment: true,
          jobId: reserved.job.id,
          taskId: reserved.job.taskId,
          result,
          summary: (await listImportSemanticEnrichmentJobs(rootPath)).summary
        };
      } catch (error) {
        const failed = await failImportSemanticEnrichmentJob(rootPath, reserved.job.id, error, options);
        const nextStatus = failed?.retryable ? 'queued' : 'failed';
        await updateImportTaskSemanticLifecycle(rootPath, reserved.job.taskId, nextStatus, {
          jobId: reserved.job.id,
          error,
          message: `background semantic enrichment job ${reserved.job.id} ${failed?.retryable ? 'will retry' : 'failed'}: ${error.message}`
        });
        await appendSemanticEnrichmentDagNodeEvent(
          rootPath,
          reserved.job.taskId,
          failed?.job || reserved.job,
          failed?.retryable ? 'pending' : 'failed',
          {
            event: failed?.retryable ? 'dag.node.retry_scheduled' : 'dag.node.failed',
            level: failed?.retryable ? 'warning' : 'error',
            retryable: Boolean(failed?.retryable),
            error,
            message: `background semantic enrichment job ${reserved.job.id} ${failed?.retryable ? 'will retry' : 'failed'}: ${error.message}`
          }
        );
        return {
          processed: true,
          failed: true,
          semanticEnrichment: true,
          retryable: Boolean(failed?.retryable),
          jobId: reserved.job.id,
          taskId: reserved.job.taskId,
          error: error.message,
          summary: failed?.summary || (await listImportSemanticEnrichmentJobs(rootPath)).summary
        };
      }
    }, {
      timeoutMs: Number(options.semanticWorkerLockTimeoutMs || options.lockTimeoutMs || 350)
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      return {
        processed: false,
        reason: 'busy'
      };
    }
    throw error;
  }
}

export async function runImportSemanticEnrichmentQueueUntilIdle(rootPath, options = {}) {
  const maxPasses = Math.max(1, Number(options.maxPasses || 24));
  const completedJobIds = [];
  let failedCount = 0;
  let lastSummary = null;

  for (let index = 0; index < maxPasses; index += 1) {
    const result = await runImportSemanticEnrichmentQueueOnce(rootPath, options);
    if (result.summary) lastSummary = result.summary;
    if (!result.processed) break;
    if (result.jobId && !result.failed) completedJobIds.push(result.jobId);
    if (result.failed && result.retryable !== true) failedCount += 1;
  }

  return {
    completedJobIds,
    failedCount,
    summary: lastSummary || (await listImportSemanticEnrichmentJobs(rootPath)).summary
  };
}

export async function runImportQueueOnce(rootPath, options = {}) {
  const { workerLockPath } = getImportPaths(rootPath);
  const lockTimeoutMs = Math.max(250, Number(options.lockTimeoutMs || DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS));
  const lockStaleMs = Math.max(lockTimeoutMs, Number(options.lockStaleMs || DEFAULT_IMPORT_WORKER_LOCK_STALE_MS));

  try {
    return await withFileLock(workerLockPath, async () => {
      const timedOutTaskIds = await recoverTimedOutImportTasks(rootPath, options);
      const failedRecovery = await recoverFailedImportTasks(rootPath, options);
      const quarantineResult = await quarantineStalePendingImportTasks(rootPath, options);
      const batchOptions = resolveImportBatchOptions(options);
      const progressiveTarget = getProgressiveImportBatchTarget(rootPath, batchOptions);
      const reserveBatchOptions = batchOptions.progressive
        ? {
            ...batchOptions,
            maxTasks: progressiveTarget
          }
        : batchOptions;
      const useBatchReserve = reserveBatchOptions.enabled && reserveBatchOptions.maxTasks > 1;
      const initialImportQueue = useBatchReserve ? await listImportTasks(rootPath) : null;
      const effectiveReserveBatchOptions = useBatchReserve
        ? createFastMdBurstReserveBatchOptions(
            initialImportQueue?.tasks || [],
            batchOptions,
            reserveBatchOptions,
            options
          )
        : reserveBatchOptions;
      const batchCoalescing = useBatchReserve
        ? await waitForImportBatchCoalesce(rootPath, effectiveReserveBatchOptions, initialImportQueue)
        : null;
      const reserved = useBatchReserve
        ? await reserveImportTaskBatch(rootPath, effectiveReserveBatchOptions)
        : await reserveNextImportTask(rootPath);
      const reservedTasks = Array.isArray(reserved?.tasks)
        ? reserved.tasks.filter(Boolean)
        : (reserved?.task ? [reserved.task] : []);
      if (!reservedTasks.length) {
        if (batchOptions.progressive) {
          resetProgressiveImportBatchTarget(rootPath);
        }
        return {
          processed: false,
          reason: quarantineResult?.count
            ? 'recovered-pending'
            : (failedRecovery.recovered.length || failedRecovery.superseded.length ? 'recovered-failed' : 'idle'),
          timedOutTaskIds,
          recoveredFailedTaskIds: failedRecovery.recovered.map((entry) => entry.taskId),
          supersededFailedTaskIds: failedRecovery.superseded.map((entry) => entry.taskId),
          quarantinedTaskIds: quarantineResult?.tasks?.map((task) => task.taskId) || [],
          quarantineBatchId: quarantineResult?.batchId || null,
          ...(batchCoalescing?.waited ? { batchCoalescing } : {})
        };
      }

      try {
        void startQueuedImportPreparse(rootPath, options, reservedTasks[0]?.id || '').catch(() => {});
        let result;
        if (useBatchReserve) {
          result = await processImportTaskBatch(rootPath, reserved, options);
        } else {
          const processed = await processImportTask(rootPath, reservedTasks[0], options);
          result = {
            processed: true,
            failed: false,
            taskId: reservedTasks[0].id,
            completedTaskIds: [reservedTasks[0].id],
            failedTaskIds: [],
            result: processed
          };
        }
        if (useBatchReserve && batchOptions.progressive) {
          const batchProgression = updateProgressiveImportBatchTarget(
            rootPath,
            batchOptions,
            result,
            await countPendingImportTasksOnDisk(rootPath)
          );
          return {
            ...result,
            batchProgression,
            ...(batchCoalescing?.waited ? { batchCoalescing } : {})
          };
        }
        return {
          ...result,
          ...(batchCoalescing?.waited ? { batchCoalescing } : {})
        };
      } catch (error) {
        for (const task of reservedTasks) {
          await failImportTask(rootPath, task.id, error);
        }
        const failedTaskIds = reservedTasks.map((task) => task.id);
        const batchProgression = useBatchReserve && batchOptions.progressive
          ? updateProgressiveImportBatchTarget(
              rootPath,
              batchOptions,
              {
                processed: true,
                failed: true,
                taskId: reservedTasks[0]?.id || null
              },
              await countPendingImportTasksOnDisk(rootPath)
            )
          : null;
        return {
          processed: true,
          failed: true,
          taskId: reservedTasks[0]?.id || null,
          batchId: reserved?.batchId || null,
          batchTaskIds: reserved?.batchTaskIds || failedTaskIds,
          completedTaskIds: [],
          failedTaskIds,
          error: error.message,
          ...(batchProgression ? { batchProgression } : {}),
          ...(batchCoalescing?.waited ? { batchCoalescing } : {})
        };
      }
    }, {
      timeoutMs: lockTimeoutMs,
      staleMs: lockStaleMs
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      return {
        processed: false,
        reason: 'busy'
      };
    }
    throw error;
  }
}

export async function runImportQueueUntilIdle(rootPath, options = {}) {
  const maxPasses = Math.max(1, Number(options.maxPasses || 24));
  const completedTaskIds = [];
  let failedCount = 0;

  for (let index = 0; index < maxPasses; index += 1) {
    const result = await runImportQueueOnce(rootPath, options);
    if (!result.processed) break;
    const resultCompletedTaskIds = Array.isArray(result.completedTaskIds) && result.completedTaskIds.length
      ? result.completedTaskIds
      : (!result.failed && result.taskId ? [result.taskId] : []);
    const resultFailedTaskIds = Array.isArray(result.failedTaskIds) && result.failedTaskIds.length
      ? result.failedTaskIds
      : (result.failed ? [result.taskId].filter(Boolean) : []);
    completedTaskIds.push(...resultCompletedTaskIds);
    failedCount += resultFailedTaskIds.length;
    if (result.failed && !resultFailedTaskIds.length) {
      failedCount += 1;
    }
  }

  return {
    completedTaskIds,
    failedCount
  };
}

export async function runImportsForAllCorporaOnce(options = {}) {
  const configuredRoots = Array.isArray(options.rootPaths)
    ? options.rootPaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const registry = configuredRoots.length ? null : await loadRegistry();
  const roots = configuredRoots.length
    ? configuredRoots.map((rootPath) => ({ rootPath, name: rootPath }))
    : (registry?.corpora || []);
  const results = [];

  for (const corpus of roots) {
    markImportWorkerSeen(corpus.rootPath, corpus.name);
    const importResult = await runImportQueueOnce(corpus.rootPath, options);
    if (!importResult.processed && isImportSemanticEnrichmentWorkerEnabled(options)) {
      const semanticResult = await runImportSemanticEnrichmentQueueOnce(corpus.rootPath, options);
      if (semanticResult.processed) {
        results.push({
          rootPath: corpus.rootPath,
          corpusName: corpus.name,
          ...semanticResult
        });
        continue;
      }
    }
    results.push({
      rootPath: corpus.rootPath,
      corpusName: corpus.name,
      ...importResult
    });
  }

  return results;
}

export const __importWorkerTestables = {
  resolveImportBatchOptions,
  getProgressiveImportBatchTarget,
  updateProgressiveImportBatchTarget,
  resetProgressiveImportBatchTarget,
  countPendingImportTasks,
  summarizeImportBatchCoalesceTasks,
  waitForImportBatchCoalesce,
  shouldWaitForImportBatchCoalesce,
  resolveImportBatchCoalesceTargetTasks,
  createFastMdBurstReserveBatchOptions,
  createImportBatchLlmConfigGroups,
  createLlmBatchMetricsCollector,
  createLlmProgressDiagnosticsCollector
};

export function startImportWorker(options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(1500, Number(options.intervalMs || 5000));
  let closed = false;
  let running = false;
  let timer = null;

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  };

  const tick = async () => {
    if (closed || running) {
      schedule();
      return;
    }

    running = true;
    try {
      const results = await runImportsForAllCorporaOnce(options);
      for (const result of results) {
        if (result.semanticEnrichment) {
          if (result.failed) {
            logger.error?.(
              `[imports] ${result.corpusName || result.rootPath}: semantic enrichment job ${result.jobId} failed`
              + (result.error ? ` (${result.error})` : '')
            );
          } else {
            logger.log?.(
              `[imports] ${result.corpusName || result.rootPath}: completed semantic enrichment job ${result.jobId}`
            );
          }
          continue;
        }
        if (!result.processed) {
          if (result.reason === 'recovered-pending' && result.quarantinedTaskIds?.length) {
            logger.warn?.(
              `[imports] ${result.corpusName || result.rootPath}: quarantined ${result.quarantinedTaskIds.length} stale pending task(s)`
              + (result.quarantineBatchId ? ` batch=${result.quarantineBatchId}` : '')
            );
          }
          if (result.reason === 'busy') {
            logger.warn?.(`[imports] ${result.corpusName || result.rootPath}: waiting for import worker lock`);
          }
          continue;
        }
        if (result.failed) {
          const failedCount = Array.isArray(result.failedTaskIds) && result.failedTaskIds.length ? result.failedTaskIds.length : 1;
          logger.error?.(
            `[imports] ${result.corpusName || result.rootPath}: `
            + `${result.batchId ? `batch ${result.batchId}` : `task ${result.taskId}`} failed ${failedCount} task(s)`
            + (result.error ? ` (${result.error})` : '')
          );
        }
        const completedCount = Array.isArray(result.completedTaskIds) && result.completedTaskIds.length
          ? result.completedTaskIds.length
          : (!result.failed && result.taskId ? 1 : 0);
        if (completedCount) {
          logger.log?.(
            `[imports] ${result.corpusName || result.rootPath}: completed `
            + (result.batchId ? `batch ${result.batchId} (${completedCount} task(s))` : `task ${result.taskId}`)
          );
        }
      }
    } catch (error) {
      logger.error?.(`[imports] ${error.message}`);
    } finally {
      running = false;
      schedule();
    }
  };

  void tick();

  return {
    async stop() {
      closed = true;
      clearTimeout(timer);
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    pollNow() {
      clearTimeout(timer);
      void tick();
    }
  };
}
