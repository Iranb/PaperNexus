import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  listAuthoritativeSyncHistory,
  listAuthoritativeSyncJobs
} from '../storage/authoritative-sync-store.js';
import {
  createImportTaskPayload,
  configuredWorkerCoveragePayload,
  importTaskLogPayload,
  importTaskPayload,
  listImportTasksPayload,
  resolveCorpusForApi
} from '../server/api.js';
import { getImportWorkerCoverageSnapshot } from '../core/imports/worker.js';
import { listImportSemanticEnrichmentJobs } from '../storage/import-semantic-store.js';
import {
  loadImportTask,
  tailImportTaskDagEvents,
  tailImportTaskEvents
} from '../storage/import-store.js';
import { createImportDagComparisonReport } from '../storage/import-dag-comparison.js';
import { getDefaultRuntimeConfigRoot } from '../lib/config.js';
import { ensureDir, readJson, writeJson } from '../lib/fs.js';
import { collapseHomePath } from '../lib/server-paths.js';

const IMPORT_WORKFLOW_ASYNC_JOB_CONTRACT_VERSION = 'papernexus-import-workflow-job-v1';
const DEFAULT_ASYNC_WAIT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_ASYNC_POLL_INTERVAL_MS = 500;
const IMPORT_WORKFLOW_OPERATIONS = new Set(['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait']);
const ASYNC_JOB_OPERATIONS = new Set(['submit_async', 'async_status', 'async_wait']);

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enabledFlag(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === false) return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function compactImportSemanticEnrichmentJob(job = {}) {
  const changedSourceKeys = Array.isArray(job.changedSourceKeys) ? job.changedSourceKeys : [];
  const batchTaskIds = Array.isArray(job.batchTaskIds) ? job.batchTaskIds : [];
  const resultPerformance = job.result?.metrics?.importPerformance || null;
  const progress = job.progress && typeof job.progress === 'object' && !Array.isArray(job.progress)
    ? job.progress
    : null;
  return {
    id: String(job.id || '').trim(),
    taskId: String(job.taskId || '').trim() || null,
    status: String(job.status || '').trim() || null,
    stage: String(job.stage || '').trim() || null,
    processingProfile: job.processingProfile || null,
    completionPolicy: job.completionPolicy || null,
    trigger: job.trigger || null,
    attempts: Number(job.attempts || 0),
    maxAttempts: Number(job.maxAttempts || 0) || null,
    workerId: job.workerId || null,
    changedSourceKeyCount: changedSourceKeys.length,
    changedSourceKeys,
    batchId: job.batchId || null,
    batchTaskIds,
    enqueuedAt: job.enqueuedAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    updatedAt: job.updatedAt || null,
    progress: progress
      ? {
          contractVersion: progress.contractVersion || null,
          status: progress.status || null,
          stage: progress.stage || null,
          currentStep: progress.currentStep || null,
          message: progress.message || null,
          stagePercent: Number(progress.stagePercent || 0) || 0,
          processedUnits: Number(progress.processedUnits || 0) || 0,
          totalUnits: Number(progress.totalUnits || 0) || 0,
          updatedAt: progress.updatedAt || null
        }
      : null,
    error: job.error?.message ? { message: String(job.error.message) } : null,
    result: resultPerformance
      ? {
          stageTimingsMs: resultPerformance.stageTimingsMs || null,
          llmBatches: resultPerformance.llmBatches || null
        }
      : null
  };
}

async function importSemanticQueueProgressPayload(rootPath, args = {}) {
  const payload = await listImportSemanticEnrichmentJobs(rootPath);
  const limit = Math.max(0, Number(args.semanticJobLimit ?? args.semantic_job_limit ?? args.recentSemanticJobLimit ?? args.recent_semantic_job_limit ?? 5) || 0);
  return {
    contractVersion: 'papernexus-import-semantic-enrichment-queue-progress-v1',
    updatedAt: payload.updatedAt || null,
    summary: payload.summary || {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      remaining: 0
    },
    recentJobs: limit > 0
      ? (payload.jobs || []).slice(0, limit).map((job) => compactImportSemanticEnrichmentJob(job))
      : []
  };
}

function normalizeAsyncExecutionMode(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function shouldRunOperationAsync(args = {}, operation = '') {
  if (ASYNC_JOB_OPERATIONS.has(operation)) return false;
  if (args.async === true || args.asynchronous === true) return true;
  const executionMode = normalizeAsyncExecutionMode(args.executionMode || args.execution_mode || args.runMode || args.run_mode);
  return ['async', 'asynchronous', 'background', 'queued', 'queue'].includes(executionMode);
}

function normalizeAsyncImportWorkflowJobId(value) {
  const jobId = String(value || '').trim();
  if (!jobId) {
    throw new Error('import_workflow async_status/async_wait requires jobId.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
    throw new Error(`Invalid import_workflow async jobId: ${jobId}`);
  }
  return jobId;
}

function getAsyncImportWorkflowJobsDir(options = {}) {
  const configured = String(options.importWorkflowJobRootPath || options.importWorkflowJobsDir || '').trim();
  return configured || path.join(getDefaultRuntimeConfigRoot(), 'mcp-jobs', 'import-workflow');
}

function getAsyncImportWorkflowJobPath(jobId, options = {}) {
  return path.join(getAsyncImportWorkflowJobsDir(options), `${normalizeAsyncImportWorkflowJobId(jobId)}.json`);
}

function nowIsoString() {
  return new Date().toISOString();
}

async function writeAsyncImportWorkflowJob(job, options = {}) {
  await ensureDir(getAsyncImportWorkflowJobsDir(options));
  await writeJson(getAsyncImportWorkflowJobPath(job.jobId, options), job);
}

async function readAsyncImportWorkflowJob(jobId, options = {}) {
  const normalizedJobId = normalizeAsyncImportWorkflowJobId(jobId);
  const job = await readJson(getAsyncImportWorkflowJobPath(normalizedJobId, options), null);
  if (!job) {
    throw new Error(`import_workflow async job not found: ${normalizedJobId}`);
  }
  return job;
}

function isAsyncImportWorkflowJobInProgress(job = {}) {
  const status = String(job.status || '').trim().toLowerCase();
  return status === 'queued' || status === 'running';
}

function renderAsyncImportWorkflowJob(job, extra = {}) {
  const inProgress = isAsyncImportWorkflowJobInProgress(job);
  return {
    contractVersion: IMPORT_WORKFLOW_ASYNC_JOB_CONTRACT_VERSION,
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    requestedOperation: job.requestedOperation,
    submittedAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    corpus: job.corpus || null,
    arguments: job.arguments || {},
    result: job.result || null,
    error: job.error || null,
    next: inProgress
      ? {
          tool: 'import_workflow',
          arguments: {
            operation: 'async_status',
            jobId: job.jobId
          }
        }
      : null,
    ...extra
  };
}

function buildAsyncImportWorkflowExecutionArgs(args = {}, requestedOperation = '') {
  const executionArgs = {
    ...args,
    operation: requestedOperation
  };
  delete executionArgs.async;
  delete executionArgs.asynchronous;
  delete executionArgs.executionMode;
  delete executionArgs.execution_mode;
  delete executionArgs.runMode;
  delete executionArgs.run_mode;
  delete executionArgs.asyncOperation;
  delete executionArgs.async_operation;
  delete executionArgs.targetOperation;
  delete executionArgs.target_operation;
  delete executionArgs.jobId;
  delete executionArgs.job_id;
  delete executionArgs.waitTimeoutMs;
  delete executionArgs.wait_timeout_ms;
  delete executionArgs.timeoutMs;
  delete executionArgs.timeout_ms;
  delete executionArgs.pollIntervalMs;
  delete executionArgs.poll_interval_ms;
  return executionArgs;
}

async function runAsyncImportWorkflowJob(job, options = {}) {
  const runningJob = {
    ...job,
    status: 'running',
    stage: 'running',
    startedAt: nowIsoString(),
    updatedAt: nowIsoString()
  };
  await writeAsyncImportWorkflowJob(runningJob, options);

  try {
    const result = await executeImportWorkflowTool(job.arguments, options);
    await writeAsyncImportWorkflowJob({
      ...runningJob,
      status: 'completed',
      stage: 'completed',
      completedAt: nowIsoString(),
      updatedAt: nowIsoString(),
      result
    }, options);
  } catch (error) {
    await writeAsyncImportWorkflowJob({
      ...runningJob,
      status: 'failed',
      stage: 'failed',
      completedAt: nowIsoString(),
      updatedAt: nowIsoString(),
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error)
      }
    }, options);
  }
}

async function submitAsyncImportWorkflowJob(args = {}, options = {}) {
  const requestedOperation = normalizeOperation(args.asyncOperation || args.async_operation || args.targetOperation || args.target_operation || args.operation);
  if (!IMPORT_WORKFLOW_OPERATIONS.has(requestedOperation)) {
    throw new Error('import_workflow submit_async requires asyncOperation to be a normal import_workflow operation.');
  }
  const executionArgs = buildAsyncImportWorkflowExecutionArgs(args, requestedOperation);
  const now = nowIsoString();
  const job = {
    version: 1,
    type: 'import_workflow',
    jobId: randomUUID(),
    status: 'queued',
    stage: 'queued',
    requestedOperation,
    createdAt: now,
    updatedAt: now,
    corpus: typeof executionArgs.corpus === 'string' && executionArgs.corpus.trim() ? executionArgs.corpus.trim() : null,
    arguments: executionArgs,
    result: null,
    error: null
  };

  await writeAsyncImportWorkflowJob(job, options);
  setImmediate(() => {
    void runAsyncImportWorkflowJob(job, options);
  });
  return renderAsyncImportWorkflowJob(job);
}

async function waitForAsyncImportWorkflowJob(jobId, args = {}, options = {}) {
  const rawTimeoutMs = args.waitTimeoutMs ?? args.wait_timeout_ms ?? args.timeoutMs ?? args.timeout_ms;
  const timeoutMs = rawTimeoutMs === undefined
    ? DEFAULT_ASYNC_WAIT_TIMEOUT_MS
    : Math.max(0, Number(rawTimeoutMs) || 0);
  const timeoutSeconds = args.timeout === undefined ? undefined : Number(args.timeout);
  const effectiveTimeoutMs = timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds)
    ? timeoutMs
    : Math.max(0, timeoutSeconds * 1000);
  const rawPollIntervalMs = args.pollIntervalMs ?? args.poll_interval_ms;
  const pollIntervalMs = rawPollIntervalMs === undefined
    ? Math.max(50, Number(args.interval || 0) ? Number(args.interval) * 1000 : DEFAULT_ASYNC_POLL_INTERVAL_MS)
    : Math.max(50, Number(rawPollIntervalMs) || DEFAULT_ASYNC_POLL_INTERVAL_MS);
  const deadline = Date.now() + effectiveTimeoutMs;
  let job = await readAsyncImportWorkflowJob(jobId, options);

  while (isAsyncImportWorkflowJobInProgress(job) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    job = await readAsyncImportWorkflowJob(jobId, options);
  }

  return {
    job,
    timedOut: isAsyncImportWorkflowJobInProgress(job)
  };
}

function normalizePathLeaf(value) {
  return path.basename(String(value || '').trim());
}

function taskMatchesReference(task, args = {}) {
  const paperId = String(args.paperId || args.paper_id || '').trim();
  const sourceLeaf = normalizePathLeaf(args.source);
  const files = Array.isArray(task?.files) ? task.files : [];

  return files.some((fileEntry) => {
    const originalName = normalizePathLeaf(fileEntry?.originalName || fileEntry?.name);
    if (!originalName) return false;
    if (paperId && originalName.includes(paperId)) return true;
    if (sourceLeaf && originalName === sourceLeaf) return true;
    return false;
  });
}

function normalizeProgressToken(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return normalized || fallback;
}

function incrementSummaryCount(target, key) {
  const normalizedKey = normalizeProgressToken(key);
  target[normalizedKey] = (Number(target[normalizedKey] || 0) || 0) + 1;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compactNumericMap(value) {
  if (!isPlainObject(value)) return null;
  const compact = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      compact[key] = numeric;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

function compactCountMap(value) {
  if (!isPlainObject(value)) return null;
  const compact = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric !== 0) {
      compact[key] = numeric;
    }
  }
  return Object.keys(compact).length ? compact : null;
}

function pickNumericSummary(value) {
  if (!isPlainObject(value)) return null;
  const summary = {};
  for (const key of ['count', 'min', 'max', 'mean', 'p50', 'p90', 'p95', 'total']) {
    if (value[key] === null) {
      summary[key] = null;
      continue;
    }
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) {
      summary[key] = numeric;
    }
  }
  return Object.keys(summary).length ? summary : null;
}

function compactRateLimitCooldowns(value) {
  if (!isPlainObject(value)) return null;
  const cooldowns = Array.isArray(value.cooldowns)
    ? value.cooldowns.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const count = Number(value.count);
  if (!Number.isFinite(count) && !cooldowns.length && !value.latest) return null;
  return {
    count: Number.isFinite(count) ? count : cooldowns.length,
    latest: value.latest || (cooldowns.length ? cooldowns[cooldowns.length - 1] : null),
    cooldowns
  };
}

function compactLlmBatchPhaseSummary(value) {
  if (!isPlainObject(value)) return null;
  const compact = {};
  for (const key of [
    'completedBatchCount',
    'skippedBatchCount',
    'cachedBatchCount',
    'skippedProviderCallCount',
    'rateLimitSkippedBatchCount',
    'failedBatchCount',
    'retryEventCount',
    'maxConcurrency'
  ]) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) {
      compact[key] = numeric;
    }
  }
  for (const key of ['durationMs', 'providerDurationMs', 'promptChars']) {
    const summary = pickNumericSummary(value[key]);
    if (summary) compact[key] = summary;
  }
  const failureReasons = compactCountMap(value.failureReasons);
  if (failureReasons) compact.failureReasons = failureReasons;
  const retryReasons = compactCountMap(value.retryReasons);
  if (retryReasons) compact.retryReasons = retryReasons;
  const rateLimitCooldowns = compactRateLimitCooldowns(value.rateLimitCooldowns);
  if (rateLimitCooldowns) compact.rateLimitCooldowns = rateLimitCooldowns;
  return Object.keys(compact).length ? compact : null;
}

function compactLlmBatchSummary(value) {
  if (!isPlainObject(value)) return null;
  const compact = compactLlmBatchPhaseSummary(value) || {};
  if (Array.isArray(value.phases)) {
    compact.phases = value.phases.map((phase) => String(phase || '').trim()).filter(Boolean);
  }
  if (Array.isArray(value.effectiveBatchSizes)) {
    compact.effectiveBatchSizes = value.effectiveBatchSizes
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0);
  }
  const byPhase = {};
  if (isPlainObject(value.byPhase)) {
    for (const [phase, phaseSummary] of Object.entries(value.byPhase)) {
      const compactPhase = compactLlmBatchPhaseSummary(phaseSummary);
      if (compactPhase) byPhase[phase] = compactPhase;
    }
  }
  if (Object.keys(byPhase).length) compact.byPhase = byPhase;
  return Object.keys(compact).length ? compact : null;
}

function summarizeTaskImportPerformance(task = {}) {
  const performance = task?.result?.metrics?.importPerformance;
  if (!isPlainObject(performance)) return null;
  const summary = {
    contractVersion: performance.contractVersion || null,
    mode: performance.mode || null,
    batchId: performance.batchId || null,
    llmConfigKey: performance.llmConfigKey || null,
    requestedImportExecutionMode: performance.requestedImportExecutionMode || null,
    importExecutionModeApplied: performance.importExecutionModeApplied || null,
    llmOptimizeSkipped: Boolean(performance.llmOptimizeSkipped),
    directDeltaCommit: Boolean(performance.directDeltaCommit)
  };
  for (const key of [
    'batchTaskCount',
    'changedSourceKeyCount',
    'batchChangedSourceKeyCount',
    'llmConfigGroupCount'
  ]) {
    const numeric = Number(performance[key]);
    if (Number.isFinite(numeric)) summary[key] = numeric;
  }
  if (isPlainObject(performance.llmConfig)) {
    summary.llmConfig = {
      llmContextWindowTokens: Number.isFinite(Number(performance.llmConfig.llmContextWindowTokens))
        ? Number(performance.llmConfig.llmContextWindowTokens)
        : null,
      llmExtractionStrategy: performance.llmConfig.llmExtractionStrategy || null,
      llmLongContextMaxPapersPerCall: Number.isFinite(Number(performance.llmConfig.llmLongContextMaxPapersPerCall))
        ? Number(performance.llmConfig.llmLongContextMaxPapersPerCall)
        : null,
      llmBatchConcurrency: Number.isFinite(Number(performance.llmConfig.llmBatchConcurrency))
        ? Number(performance.llmConfig.llmBatchConcurrency)
        : null
    };
  }
  const stageTimingsMs = compactNumericMap(performance.stageTimingsMs);
  if (stageTimingsMs) summary.stageTimingsMs = stageTimingsMs;
  const fastCommitPhasesMs = compactNumericMap(performance.fastCommitPhasesMs);
  if (fastCommitPhasesMs) summary.fastCommitPhasesMs = fastCommitPhasesMs;
  const llmBatches = compactLlmBatchSummary(performance.llmBatches);
  if (llmBatches) summary.llmBatches = llmBatches;
  return summary;
}

function taskLifecycleStatus(task = {}, name = '') {
  const key = normalizeProgressToken(name, '');
  if (key === 'graph-visibility') {
    return normalizeProgressToken(task.graphVisibilityStatus || task.result?.graphVisibilityStatus, 'unknown');
  }
  if (key === 'semantic') {
    return normalizeProgressToken(task.semanticStatus || task.result?.semanticStatus, 'unknown');
  }
  if (key === 'authoritative-sync') {
    const sync = getCurrentTaskAuthoritativeSync(task);
    const status = normalizeAuthoritativeSyncLifecycleStatus(
      sync?.status || task.authoritativeSyncStatus || task.result?.authoritativeSyncStatus,
      'unknown'
    );
    if (shouldTreatAuthoritativeSyncAsNotRequired(task, sync, status)) {
      return 'not-required';
    }
    return status;
  }
  return 'unknown';
}

function taskOperatorPhase(task = {}) {
  const status = normalizeProgressToken(task.status, 'pending');
  const progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
  const stage = normalizeProgressToken(task.stage || progress.stage, status === 'running' ? 'materialize' : 'queued');
  const currentStep = normalizeProgressToken(progress.currentStep, '');
  const semanticStatus = taskLifecycleStatus(task, 'semantic');
  const syncStatus = taskLifecycleStatus(task, 'authoritative-sync');

  if (status === 'failed') return 'failed';
  if (status === 'pending' && currentStep === 'coalescing') return 'coalescing';
  if (status === 'pending') return stage === 'queued' ? 'queued' : stage;
  if (status === 'running') return stage;
  if (status === 'completed') {
    if (semanticStatus === 'queued' || semanticStatus === 'running') return 'semantic-enrichment';
    if (syncStatus === 'pending' || syncStatus === 'queued' || syncStatus === 'running') return 'authoritative-sync';
    return 'completed';
  }
  return stage || status || 'unknown';
}

function isTaskOperatorPhaseActive(task = {}) {
  const status = normalizeProgressToken(task.status, 'pending');
  if (status === 'pending' || status === 'running') return true;
  if (status === 'completed') {
    const phase = taskOperatorPhase(task);
    return phase === 'semantic-enrichment' || phase === 'authoritative-sync';
  }
  return false;
}

function taskOperatorPhasePriority(task = {}) {
  const status = normalizeProgressToken(task.status, 'pending');
  const phase = taskOperatorPhase(task);
  if (phase === 'coalescing') return 0;
  if (status === 'running') return 1;
  if (status === 'pending') return 2;
  if (phase === 'semantic-enrichment' || phase === 'authoritative-sync') return 3;
  if (status === 'failed') return 4;
  return 5;
}

function summarizeActiveTask(task = null) {
  if (!task) return null;
  const progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
  return {
    taskId: task.id || null,
    status: task.status || null,
    phase: taskOperatorPhase(task),
    stage: task.stage || progress.stage || null,
    currentStep: progress.currentStep || null,
    message: progress.message || null,
    percent: Number(progress.percent || 0) || 0,
    stagePercent: Number(progress.stagePercent || 0) || 0,
    processedUnits: Number(progress.processedUnits || 0) || 0,
    totalUnits: Number(progress.totalUnits || 0) || 0,
    graphVisibilityStatus: taskLifecycleStatus(task, 'graph-visibility'),
    semanticStatus: taskLifecycleStatus(task, 'semantic'),
    authoritativeSyncStatus: taskLifecycleStatus(task, 'authoritative-sync'),
    authoritativeSyncJobId: getCurrentTaskAuthoritativeSync(task)?.jobId || null,
    progressDiagnostics: isPlainObject(progress.diagnostics) ? progress.diagnostics : null,
    importPerformance: summarizeTaskImportPerformance(task)
  };
}

function summarizeProgressTasks(tasks = []) {
  const summary = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    overallPercent: 0,
    stageCounts: {},
    phaseCounts: {},
    lifecycleCounts: {
      graphVisibility: {},
      semantic: {},
      authoritativeSync: {}
    },
    activeTaskId: null,
    activePhase: null,
    activeTask: null
  };
  if (!tasks.length) return summary;

  let totalPercent = 0;
  let activeTask = null;
  let activeTaskPriority = Number.POSITIVE_INFINITY;
  for (const task of tasks) {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status === 'completed') summary.completed += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'running') summary.running += 1;
    else summary.pending += 1;
    totalPercent += Number(task?.progress?.percent || 0) || 0;
    incrementSummaryCount(summary.stageCounts, task?.stage || task?.progress?.stage || status || 'unknown');
    incrementSummaryCount(summary.phaseCounts, taskOperatorPhase(task));
    incrementSummaryCount(summary.lifecycleCounts.graphVisibility, taskLifecycleStatus(task, 'graph-visibility'));
    incrementSummaryCount(summary.lifecycleCounts.semantic, taskLifecycleStatus(task, 'semantic'));
    incrementSummaryCount(summary.lifecycleCounts.authoritativeSync, taskLifecycleStatus(task, 'authoritative-sync'));
    const priority = taskOperatorPhasePriority(task);
    if (isTaskOperatorPhaseActive(task) && priority < activeTaskPriority) {
      activeTask = task;
      activeTaskPriority = priority;
    }
  }
  summary.remaining = summary.pending + summary.running;
  summary.overallPercent = Math.max(0, Math.min(100, Math.round((totalPercent / tasks.length) * 100) / 100));
  summary.activeTask = summarizeActiveTask(activeTask);
  summary.activeTaskId = summary.activeTask?.taskId || null;
  summary.activePhase = summary.activeTask?.phase || null;
  return summary;
}

async function resolveTaskId(candidate, args = {}, options = {}) {
  const directTaskId = String(args.taskId || args.task_id || '').trim();
  if (directTaskId) {
    return directTaskId;
  }

  const paperId = String(args.paperId || args.paper_id || '').trim();
  const source = String(args.source || '').trim();
  if (!paperId && !source) {
    return '';
  }

  const listed = await listImportTasksPayload(candidate, options);
  const task = (listed.tasks || []).find((entry) => taskMatchesReference(entry, args));
  return String(task?.id || '').trim();
}

function normalizeTaskIdListValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeTaskIdListValue(entry));
  }
  return String(value || '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectRequestedTaskIds(args = {}) {
  const rawValues = [];
  if (Object.hasOwn(args, 'taskIds')) rawValues.push(args.taskIds);
  if (Object.hasOwn(args, 'task_ids')) rawValues.push(args.task_ids);

  const seen = new Set();
  const taskIds = [];
  for (const taskId of rawValues.flatMap((value) => normalizeTaskIdListValue(value))) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    taskIds.push(taskId);
  }
  return taskIds;
}

function hasBatchTaskStatusRequest(args = {}) {
  return Object.hasOwn(args, 'taskIds') || Object.hasOwn(args, 'task_ids');
}

const IMPORT_WORKFLOW_PORTABLE_PATH_FIELDS = new Set([
  'rootPath',
  'root_path',
  'storedPath',
  'stored_path',
  'sourcesDir',
  'sources_dir',
  'remoteFile',
  'remote_file',
  'serverFilePath',
  'server_file_path'
]);

const IMPORT_WORKFLOW_PORTABLE_PATH_LIST_FIELDS = new Set([
  'inputPaths',
  'changedSourceKeys'
]);

function presentImportWorkflowPortablePayload(value, options = {}, fieldName = '') {
  if (options?.portablePaths !== true) return value;
  if (Array.isArray(value)) {
    if (IMPORT_WORKFLOW_PORTABLE_PATH_LIST_FIELDS.has(fieldName)) {
      return value.map((item) => collapseHomePath(item));
    }
    return value.map((item) => presentImportWorkflowPortablePayload(item, options, fieldName));
  }
  if (!value || typeof value !== 'object') {
    return IMPORT_WORKFLOW_PORTABLE_PATH_FIELDS.has(fieldName) && typeof value === 'string'
      ? collapseHomePath(value)
      : value;
  }
  const output = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (IMPORT_WORKFLOW_PORTABLE_PATH_FIELDS.has(key) && typeof entryValue === 'string') {
      output[key] = collapseHomePath(entryValue);
      continue;
    }
    if (IMPORT_WORKFLOW_PORTABLE_PATH_LIST_FIELDS.has(key) && Array.isArray(entryValue)) {
      output[key] = entryValue.map((item) => collapseHomePath(item));
      continue;
    }
    output[key] = presentImportWorkflowPortablePayload(entryValue, options, key);
  }
  return output;
}

function createRequestedTaskQueueSummary(tasks = []) {
  return {
    contractVersion: 'import-queue-progress-v1',
    ...summarizeProgressTasks(tasks),
    source: 'requested-tasks'
  };
}

function getTaskAuthoritativeSync(task = {}) {
  const resultSync = task?.result?.authoritativeSync;
  if (resultSync && typeof resultSync === 'object' && !Array.isArray(resultSync)) {
    return resultSync;
  }
  const taskSync = task?.authoritativeSync;
  if (taskSync && typeof taskSync === 'object' && !Array.isArray(taskSync)) {
    return taskSync;
  }
  return null;
}

function getTaskSemanticAuthoritativeSync(task = {}) {
  const resultSemanticSync = task?.result?.semanticEnrichment?.result?.authoritativeSync;
  if (resultSemanticSync && typeof resultSemanticSync === 'object' && !Array.isArray(resultSemanticSync)) {
    return resultSemanticSync;
  }
  const taskSemanticSync = task?.semanticEnrichment?.result?.authoritativeSync;
  if (taskSemanticSync && typeof taskSemanticSync === 'object' && !Array.isArray(taskSemanticSync)) {
    return taskSemanticSync;
  }
  return null;
}

function getCurrentTaskAuthoritativeSync(task = {}) {
  return getTaskSemanticAuthoritativeSync(task) || getTaskAuthoritativeSync(task);
}

function getAuthoritativeSyncJobId(sync = {}) {
  return String(sync?.jobId || sync?.job_id || '').trim();
}

function collectTaskAuthoritativeSyncJobIds(task = {}) {
  const jobIds = new Set();
  for (const sync of [getTaskAuthoritativeSync(task), getTaskSemanticAuthoritativeSync(task)]) {
    const jobId = getAuthoritativeSyncJobId(sync);
    if (jobId) jobIds.add(jobId);
  }
  return Array.from(jobIds);
}

function isAuthoritativeSyncTerminal(job = {}) {
  const status = String(job?.status || '').trim().toLowerCase();
  return status === 'completed' || status === 'failed' || status === 'superseded';
}

function normalizeAuthoritativeSyncLifecycleStatus(value, fallback = 'unknown') {
  const status = normalizeProgressToken(value, fallback);
  return status === 'queued' ? 'pending' : status;
}

const NON_WAITABLE_AUTHORITATIVE_SYNC_STATUSES = new Set(['pending', 'running']);
const LEGACY_AUTHORITATIVE_SYNC_NO_JOB_SOURCE = 'legacy-no-authoritative-sync-job';

function shouldTreatAuthoritativeSyncAsNotRequired(task = {}, sync = null, normalizedStatus = '') {
  if (!isPlainObject(sync)) return false;
  if (normalizeProgressToken(task?.status, '') !== 'completed') return false;
  if (getAuthoritativeSyncJobId(sync)) return false;

  const status = normalizedStatus || normalizeAuthoritativeSyncLifecycleStatus(
    sync?.status || task?.authoritativeSyncStatus || task?.result?.authoritativeSyncStatus,
    ''
  );
  if (!NON_WAITABLE_AUTHORITATIVE_SYNC_STATUSES.has(status)) return false;

  const semanticStatus = taskLifecycleStatus(task, 'semantic');
  return semanticStatus !== 'pending' && semanticStatus !== 'queued' && semanticStatus !== 'running';
}

function createNoJobAuthoritativeSyncPayload(sync = {}) {
  const originalStatus = normalizeAuthoritativeSyncLifecycleStatus(sync?.status, '');
  return {
    ...(isPlainObject(sync) ? sync : {}),
    jobId: null,
    status: 'not-required',
    originalStatus: originalStatus || null,
    source: LEGACY_AUTHORITATIVE_SYNC_NO_JOB_SOURCE
  };
}

function createNoJobAuthoritativeSyncForTask(task = {}, sync = null) {
  if (!shouldTreatAuthoritativeSyncAsNotRequired(task, sync)) return null;
  return createNoJobAuthoritativeSyncPayload(sync);
}

function normalizeImportWaitTarget(args = {}) {
  const rawTarget = args.waitUntil
    ?? args.wait_until
    ?? args.waitTarget
    ?? args.wait_target
    ?? '';
  const target = normalizeProgressToken(rawTarget, '');

  if (target) {
    if (
      target === 'task-completed'
      || target === 'task-complete'
      || target === 'task-terminal'
      || target === 'terminal'
      || target === 'completed'
    ) {
      return 'task-completed';
    }
    if (
      target === 'graph-visible'
      || target === 'graph-visibility'
      || target === 'graph-ready'
      || target === 'graph'
    ) {
      return 'graph-visible';
    }
    if (
      target === 'semantic-complete'
      || target === 'semantic-completed'
      || target === 'semantic-terminal'
      || target === 'semantic-enrichment-complete'
      || target === 'semantic'
    ) {
      return 'semantic-complete';
    }
    if (
      target === 'authoritative-sync'
      || target === 'authoritative'
      || target === 'graph-sync'
      || target === 'sync'
    ) {
      return 'authoritative-sync';
    }
    throw new Error(`Unknown import_workflow wait target: ${rawTarget}`);
  }

  if (enabledFlag(args.waitForSemanticCompletion ?? args.wait_for_semantic_completion, false)) {
    return 'semantic-complete';
  }
  if (enabledFlag(args.waitForGraphVisibility ?? args.wait_for_graph_visibility, false)) {
    return 'graph-visible';
  }
  return 'task-completed';
}

function shouldWaitForAuthoritativeSyncAfterTarget(args = {}, waitTarget = 'task-completed') {
  if (waitTarget === 'authoritative-sync') return true;
  const explicit = args.waitForAuthoritativeSync ?? args.wait_for_authoritative_sync;
  if (explicit !== undefined && explicit !== null) {
    return enabledFlag(explicit, true);
  }
  return waitTarget === 'task-completed';
}

function isSuccessfulLifecycleStatus(status) {
  return status === 'completed' || status === 'not-required' || status === 'skipped';
}

function isTerminalAuthoritativeSyncLifecycleStatus(status) {
  return isSuccessfulLifecycleStatus(status) || status === 'failed' || status === 'superseded';
}

function importWaitStatus(task = {}, waitTarget = 'task-completed', reason = '') {
  return {
    waitTarget,
    reason,
    taskStatus: normalizeProgressToken(task.status, 'unknown'),
    graphVisibilityStatus: taskLifecycleStatus(task, 'graph-visibility'),
    semanticStatus: taskLifecycleStatus(task, 'semantic'),
    authoritativeSyncStatus: taskLifecycleStatus(task, 'authoritative-sync')
  };
}

function isImportWaitTargetSatisfied(task = {}, waitTarget = 'task-completed') {
  const status = normalizeProgressToken(task.status, 'unknown');
  const graphVisibilityStatus = taskLifecycleStatus(task, 'graph-visibility');
  const semanticStatus = taskLifecycleStatus(task, 'semantic');

  if (status === 'failed') {
    return importWaitStatus(task, waitTarget, 'task-failed');
  }

  if (waitTarget === 'graph-visible') {
    if (graphVisibilityStatus === 'failed') {
      return importWaitStatus(task, waitTarget, 'graph-visibility-failed');
    }
    if (graphVisibilityStatus === 'completed' || status === 'completed') {
      return importWaitStatus(
        task,
        waitTarget,
        graphVisibilityStatus === 'completed' ? 'graph-visible' : 'task-completed'
      );
    }
    return null;
  }

  if (waitTarget === 'semantic-complete') {
    if (semanticStatus === 'failed') {
      return importWaitStatus(task, waitTarget, 'semantic-failed');
    }
    if (isSuccessfulLifecycleStatus(semanticStatus)) {
      return importWaitStatus(task, waitTarget, `semantic-${semanticStatus}`);
    }
    if (status === 'completed' && semanticStatus === 'unknown') {
      return importWaitStatus(task, waitTarget, 'legacy-task-completed');
    }
    return null;
  }

  if (status === 'completed') {
    return importWaitStatus(task, waitTarget, 'task-completed');
  }
  return null;
}

function createImportBatchWaitStatus(tasks = [], missingTaskIds = [], waitTarget = 'task-completed', waitForAuthoritativeSync = false) {
  const entries = tasks.map((task) => {
    const targetStatus = isImportWaitTargetSatisfied(task, waitTarget);
    const taskStatus = normalizeProgressToken(task?.status, 'unknown');
    const authoritativeSyncStatus = taskLifecycleStatus(task, 'authoritative-sync');
    let waitStatus = targetStatus || importWaitStatus(task, waitTarget, 'not-satisfied');
    let terminal = Boolean(targetStatus);
    let failed = Boolean(waitStatus?.reason?.includes('failed'));
    let satisfied = Boolean(targetStatus && !failed);

    if (
      satisfied
      && waitForAuthoritativeSync
      && taskStatus === 'completed'
      && !isTerminalAuthoritativeSyncLifecycleStatus(authoritativeSyncStatus)
    ) {
      satisfied = false;
      terminal = false;
      waitStatus = {
        ...waitStatus,
        reason: `authoritative-sync-${authoritativeSyncStatus || 'unknown'}`
      };
    } else if (
      targetStatus
      && waitForAuthoritativeSync
      && taskStatus === 'completed'
      && authoritativeSyncStatus
      && !isSuccessfulLifecycleStatus(authoritativeSyncStatus)
    ) {
      satisfied = false;
      terminal = isTerminalAuthoritativeSyncLifecycleStatus(authoritativeSyncStatus);
      waitStatus = {
        ...waitStatus,
        reason: `authoritative-sync-${authoritativeSyncStatus}`
      };
    }
    failed = Boolean(waitStatus?.reason?.includes('failed'));

    return {
      taskId: task?.id || null,
      satisfied,
      terminal,
      failed,
      waitStatus
    };
  });
  const satisfiedTaskCount = entries.filter((entry) => entry.satisfied).length;
  const terminalTaskCount = entries.filter((entry) => entry.terminal).length;
  const unsatisfiedTaskCount = entries.length - satisfiedTaskCount;
  const failedTaskCount = entries.filter((entry) => entry.failed).length;
  const allSatisfied = missingTaskIds.length === 0 && entries.length > 0 && unsatisfiedTaskCount === 0;
  const allTerminal = missingTaskIds.length === 0 && entries.length > 0 && terminalTaskCount === entries.length;
  return {
    waitTarget,
    waitForAuthoritativeSync,
    satisfied: allSatisfied,
    terminal: allTerminal,
    reason: allSatisfied ? 'all-satisfied' : (allTerminal ? 'terminal-with-failures' : 'waiting'),
    total: entries.length + missingTaskIds.length,
    taskCount: entries.length,
    missingTaskIds,
    satisfiedTaskCount,
    terminalTaskCount,
    unsatisfiedTaskCount,
    failedTaskCount,
    tasks: entries
  };
}

async function loadAuthoritativeSyncJobSnapshot(rootPath, jobId) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) return null;

  const activeJobs = await listAuthoritativeSyncJobs(rootPath);
  const active = activeJobs.find((job) => job.jobId === normalizedJobId);
  if (active) return active;

  const history = await listAuthoritativeSyncHistory(rootPath);
  return history.find((job) => job.jobId === normalizedJobId) || null;
}

async function loadAuthoritativeSyncJobSnapshotIndex(rootPath) {
  const [history, activeJobs] = await Promise.all([
    listAuthoritativeSyncHistory(rootPath),
    listAuthoritativeSyncJobs(rootPath)
  ]);
  const byJobId = new Map();
  for (const job of history) {
    if (job?.jobId) byJobId.set(job.jobId, job);
  }
  for (const job of activeJobs) {
    if (job?.jobId) byJobId.set(job.jobId, job);
  }
  return byJobId;
}

function createHydratedAuthoritativeSyncPayload(sync = {}, job = null) {
  const jobId = String(sync?.jobId || sync?.job_id || job?.jobId || job?.job_id || '').trim();
  const status = normalizeAuthoritativeSyncLifecycleStatus(job?.status || sync?.status, sync?.status || 'unknown');
  return {
    ...(sync && typeof sync === 'object' ? sync : {}),
    jobId: jobId || null,
    status,
    updatedAt: job?.updatedAt || sync?.updatedAt || null,
    queuedAt: job?.createdAt || sync?.queuedAt || null,
    reservedAt: job?.reservedAt || sync?.reservedAt || null,
    completedAt: job?.completedAt || sync?.completedAt || null,
    failedAt: job?.failedAt || sync?.failedAt || null,
    appliedAt: job?.appliedAt || sync?.appliedAt || null,
    error: job?.error || sync?.error || null,
    source: job ? 'authoritative-sync-job' : (sync?.source || 'task-result')
  };
}

function createHydratedAuthoritativeSyncForJob(sync = {}, job = null) {
  if (!sync || typeof sync !== 'object' || !job) return null;
  const syncJobId = getAuthoritativeSyncJobId(sync);
  const jobId = String(job?.jobId || job?.job_id || '').trim();
  if (!syncJobId || !jobId || syncJobId !== jobId) return null;
  return createHydratedAuthoritativeSyncPayload(sync, job);
}

function applyHydratedAuthoritativeSync(task = {}, job = null) {
  if (!task || typeof task !== 'object' || !job) return task;
  const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
    ? task.result
    : null;
  const taskSync = task.authoritativeSync && typeof task.authoritativeSync === 'object' && !Array.isArray(task.authoritativeSync)
    ? task.authoritativeSync
    : null;
  const resultSync = result?.authoritativeSync && typeof result.authoritativeSync === 'object' && !Array.isArray(result.authoritativeSync)
    ? result.authoritativeSync
    : null;
  const resultSemantic = result?.semanticEnrichment && typeof result.semanticEnrichment === 'object' && !Array.isArray(result.semanticEnrichment)
    ? result.semanticEnrichment
    : null;
  const resultSemanticResult = resultSemantic?.result && typeof resultSemantic.result === 'object' && !Array.isArray(resultSemantic.result)
    ? resultSemantic.result
    : null;
  const resultSemanticSync = resultSemanticResult?.authoritativeSync && typeof resultSemanticResult.authoritativeSync === 'object' && !Array.isArray(resultSemanticResult.authoritativeSync)
    ? resultSemanticResult.authoritativeSync
    : null;
  const taskSemantic = task.semanticEnrichment && typeof task.semanticEnrichment === 'object' && !Array.isArray(task.semanticEnrichment)
    ? task.semanticEnrichment
    : null;
  const taskSemanticResult = taskSemantic?.result && typeof taskSemantic.result === 'object' && !Array.isArray(taskSemantic.result)
    ? taskSemantic.result
    : null;
  const taskSemanticSync = taskSemanticResult?.authoritativeSync && typeof taskSemanticResult.authoritativeSync === 'object' && !Array.isArray(taskSemanticResult.authoritativeSync)
    ? taskSemanticResult.authoritativeSync
    : null;

  const hydratedTaskSync = createHydratedAuthoritativeSyncForJob(taskSync, job);
  const hydratedResultSync = createHydratedAuthoritativeSyncForJob(resultSync, job);
  const hydratedResultSemanticSync = createHydratedAuthoritativeSyncForJob(resultSemanticSync, job);
  const hydratedTaskSemanticSync = createHydratedAuthoritativeSyncForJob(taskSemanticSync, job);

  const updatedResult = result
    ? {
        ...result,
        ...(hydratedResultSync
          ? {
              authoritativeSyncStatus: hydratedResultSync.status,
              authoritativeSync: {
                ...resultSync,
                ...hydratedResultSync
              }
            }
          : {}),
        ...(hydratedResultSemanticSync && resultSemantic && resultSemanticResult
          ? {
              semanticEnrichment: {
                ...resultSemantic,
                result: {
                  ...resultSemanticResult,
                  authoritativeSync: {
                    ...resultSemanticSync,
                    ...hydratedResultSemanticSync
                  }
                }
              }
            }
          : {})
      }
    : task.result;

  const updatedTask = {
    ...task,
    authoritativeSync: hydratedTaskSync && taskSync
      ? {
          ...taskSync,
          ...hydratedTaskSync
        }
      : task.authoritativeSync,
    result: updatedResult,
    semanticEnrichment: hydratedTaskSemanticSync && taskSemantic && taskSemanticResult
      ? {
          ...taskSemantic,
          result: {
            ...taskSemanticResult,
            authoritativeSync: {
              ...taskSemanticSync,
              ...hydratedTaskSemanticSync
            }
          }
        }
      : task.semanticEnrichment
  };

  return {
    ...updatedTask,
    authoritativeSyncStatus: taskLifecycleStatus(updatedTask, 'authoritative-sync')
  };
}

function applyNoJobAuthoritativeSyncFallback(task = {}) {
  if (!task || typeof task !== 'object') return task;
  const currentSync = getCurrentTaskAuthoritativeSync(task);
  if (!shouldTreatAuthoritativeSyncAsNotRequired(task, currentSync)) return task;

  const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
    ? task.result
    : null;
  const taskSync = task.authoritativeSync && typeof task.authoritativeSync === 'object' && !Array.isArray(task.authoritativeSync)
    ? task.authoritativeSync
    : null;
  const resultSync = result?.authoritativeSync && typeof result.authoritativeSync === 'object' && !Array.isArray(result.authoritativeSync)
    ? result.authoritativeSync
    : null;
  const resultSemantic = result?.semanticEnrichment && typeof result.semanticEnrichment === 'object' && !Array.isArray(result.semanticEnrichment)
    ? result.semanticEnrichment
    : null;
  const resultSemanticResult = resultSemantic?.result && typeof resultSemantic.result === 'object' && !Array.isArray(resultSemantic.result)
    ? resultSemantic.result
    : null;
  const resultSemanticSync = resultSemanticResult?.authoritativeSync && typeof resultSemanticResult.authoritativeSync === 'object' && !Array.isArray(resultSemanticResult.authoritativeSync)
    ? resultSemanticResult.authoritativeSync
    : null;
  const taskSemantic = task.semanticEnrichment && typeof task.semanticEnrichment === 'object' && !Array.isArray(task.semanticEnrichment)
    ? task.semanticEnrichment
    : null;
  const taskSemanticResult = taskSemantic?.result && typeof taskSemantic.result === 'object' && !Array.isArray(taskSemantic.result)
    ? taskSemantic.result
    : null;
  const taskSemanticSync = taskSemanticResult?.authoritativeSync && typeof taskSemanticResult.authoritativeSync === 'object' && !Array.isArray(taskSemanticResult.authoritativeSync)
    ? taskSemanticResult.authoritativeSync
    : null;

  const fallbackTaskSync = createNoJobAuthoritativeSyncForTask(task, taskSync);
  const fallbackResultSync = createNoJobAuthoritativeSyncForTask(task, resultSync);
  const fallbackResultSemanticSync = createNoJobAuthoritativeSyncForTask(task, resultSemanticSync);
  const fallbackTaskSemanticSync = createNoJobAuthoritativeSyncForTask(task, taskSemanticSync);

  const updatedResult = result
    ? {
        ...result,
        ...(fallbackResultSync
          ? {
              authoritativeSyncStatus: fallbackResultSync.status,
              authoritativeSync: {
                ...resultSync,
                ...fallbackResultSync
              }
            }
          : {}),
        ...(fallbackResultSemanticSync && resultSemantic && resultSemanticResult
          ? {
              semanticEnrichment: {
                ...resultSemantic,
                result: {
                  ...resultSemanticResult,
                  authoritativeSync: {
                    ...resultSemanticSync,
                    ...fallbackResultSemanticSync
                  }
                }
              }
            }
          : {})
      }
    : task.result;

  const updatedTask = {
    ...task,
    authoritativeSync: fallbackTaskSync && taskSync
      ? {
          ...taskSync,
          ...fallbackTaskSync
        }
      : task.authoritativeSync,
    result: updatedResult,
    semanticEnrichment: fallbackTaskSemanticSync && taskSemantic && taskSemanticResult
      ? {
          ...taskSemantic,
          result: {
            ...taskSemanticResult,
            authoritativeSync: {
              ...taskSemanticSync,
              ...fallbackTaskSemanticSync
            }
          }
        }
      : task.semanticEnrichment
  };

  return {
    ...updatedTask,
    authoritativeSyncStatus: taskLifecycleStatus(updatedTask, 'authoritative-sync')
  };
}

async function hydrateTaskAuthoritativeSync(rootPath, task = {}) {
  const jobIds = collectTaskAuthoritativeSyncJobIds(task);
  if (!jobIds.length) return applyNoJobAuthoritativeSyncFallback(task);
  let hydratedTask = task;
  for (const jobId of jobIds) {
    const job = await loadAuthoritativeSyncJobSnapshot(rootPath, jobId);
    hydratedTask = applyHydratedAuthoritativeSync(hydratedTask, job);
  }
  return applyNoJobAuthoritativeSyncFallback(hydratedTask);
}

async function hydrateTasksAuthoritativeSync(rootPath, tasks = []) {
  if (!Array.isArray(tasks) || !tasks.length) return tasks;
  const hasSyncJobs = tasks.some((task) => collectTaskAuthoritativeSyncJobIds(task).length > 0);
  if (!hasSyncJobs) return tasks.map((task) => applyNoJobAuthoritativeSyncFallback(task));

  const jobIndex = await loadAuthoritativeSyncJobSnapshotIndex(rootPath);
  return tasks.map((task) => {
    let hydratedTask = task;
    for (const jobId of collectTaskAuthoritativeSyncJobIds(task)) {
      hydratedTask = applyHydratedAuthoritativeSync(hydratedTask, jobIndex.get(jobId) || null);
    }
    return applyNoJobAuthoritativeSyncFallback(hydratedTask);
  });
}

async function hydrateImportTaskPayloadAuthoritativeSync(payload = {}, rootPath = '') {
  if (!payload?.task) return payload;
  const hydrationRootPath = rootPath || payload.rootPath;
  return {
    ...payload,
    task: await hydrateTaskAuthoritativeSync(hydrationRootPath, payload.task)
  };
}

async function loadImportTaskBatch(candidate, taskIds = [], options = {}) {
  const internalRootPath = await resolveImportWorkflowInternalRootPath(candidate, {}, options);
  const tasks = [];
  const missingTaskIds = [];

  const loadedTasks = await Promise.all(taskIds.map(async (taskId) => ({
    taskId,
    task: await loadImportTask(internalRootPath, taskId)
  })));
  for (const { taskId, task } of loadedTasks) {
    if (task) {
      tasks.push(task);
    } else {
      missingTaskIds.push(taskId);
    }
  }

  const hydratedTasks = await hydrateTasksAuthoritativeSync(internalRootPath, tasks);
  return {
    internalRootPath,
    tasks: hydratedTasks,
    missingTaskIds
  };
}

async function importTaskBatchPayload(candidate, taskIds = [], operation = 'status', options = {}) {
  const {
    internalRootPath,
    tasks,
    missingTaskIds
  } = await loadImportTaskBatch(candidate, taskIds, options);
  const presentedTasks = presentImportWorkflowPortablePayload(tasks, options, 'tasks');
  return {
    contractVersion: 'papernexus-import-workflow-task-batch-v1',
    rootPath: presentImportWorkflowPortablePayload(internalRootPath, options, 'rootPath'),
    operation,
    requestedTaskIds: taskIds,
    missingTaskIds,
    taskCount: presentedTasks.length,
    tasks: presentedTasks,
    summary: summarizeProgressTasks(tasks),
    queueSummary: createRequestedTaskQueueSummary(tasks),
    generatedAt: new Date().toISOString()
  };
}

async function importTaskBatchWaitPayload(candidate, taskIds = [], args = {}, options = {}) {
  const timeoutSeconds = Number(args.timeout || 1800);
  const intervalSeconds = Number(args.interval || 2);
  const deadline = Date.now() + (Math.max(1, timeoutSeconds) * 1000);
  const waitTarget = normalizeImportWaitTarget(args);
  const waitForAuthoritativeSync = shouldWaitForAuthoritativeSyncAfterTarget(args, waitTarget);

  while (true) {
    const {
      internalRootPath,
      tasks,
      missingTaskIds
    } = await loadImportTaskBatch(candidate, taskIds, options);
    const waitStatus = createImportBatchWaitStatus(
      tasks,
      missingTaskIds,
      waitTarget,
      waitForAuthoritativeSync
    );

    if (waitStatus.satisfied || waitStatus.terminal) {
      const presentedTasks = presentImportWorkflowPortablePayload(tasks, options, 'tasks');
      return {
        contractVersion: 'papernexus-import-workflow-task-batch-v1',
        rootPath: presentImportWorkflowPortablePayload(internalRootPath, options, 'rootPath'),
        operation: 'wait',
        requestedTaskIds: taskIds,
        missingTaskIds,
        taskCount: presentedTasks.length,
        tasks: presentedTasks,
        summary: summarizeProgressTasks(tasks),
        queueSummary: createRequestedTaskQueueSummary(tasks),
        waitTarget,
        waitForAuthoritativeSync,
        waitStatus,
        generatedAt: new Date().toISOString()
      };
    }

    if (Date.now() >= deadline) {
      const missing = missingTaskIds.length ? ` missing=${missingTaskIds.join(',')}` : '';
      const unsatisfied = waitStatus.tasks
        .filter((entry) => !entry.satisfied)
        .map((entry) => `${entry.taskId || 'unknown'}:${entry.waitStatus?.reason || 'waiting'}`)
        .join(',');
      throw new Error(
        `Timed out waiting for task batch target=${waitTarget}.${missing} unsatisfied=${unsatisfied || 'none'}`
      );
    }

    await sleep(Math.max(0.05, intervalSeconds) * 1000);
  }
}

async function resolveImportWorkflowInternalRootPath(candidate, payload = {}, options = {}) {
  const payloadRoot = String(payload?.rootPath || '').trim();
  if (payloadRoot && !payloadRoot.startsWith('~')) return payloadRoot;
  try {
    return await resolveCorpusForApi(candidate, {
      ...options,
      portablePaths: false
    });
  } catch {
    return payloadRoot;
  }
}

async function waitForAuthoritativeSyncJob(rootPath, task, deadline, intervalSeconds) {
  const sync = getCurrentTaskAuthoritativeSync(task);
  const jobId = String(sync?.jobId || sync?.job_id || '').trim();
  if (!jobId) return sync;

  while (true) {
    const job = await loadAuthoritativeSyncJobSnapshot(rootPath, jobId);
    if (job && isAuthoritativeSyncTerminal(job)) {
      return {
        ...(sync || {}),
        jobId,
        status: job.status,
        job
      };
    }

    if (Date.now() >= deadline) {
      const status = job?.status || sync?.status || 'unknown';
      throw new Error(`Timed out waiting for authoritative sync job ${jobId}. Last status=${status}`);
    }

    await sleep(Math.max(0.05, intervalSeconds) * 1000);
  }
}

export async function executeImportWorkflowTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation);
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;

  if (operation === 'submit_async') {
    return submitAsyncImportWorkflowJob(args, options);
  }
  if (operation === 'async_status') {
    const job = await readAsyncImportWorkflowJob(args.jobId || args.job_id, options);
    return renderAsyncImportWorkflowJob(job);
  }
  if (operation === 'async_wait') {
    const waitResult = await waitForAsyncImportWorkflowJob(args.jobId || args.job_id, args, options);
    return renderAsyncImportWorkflowJob(waitResult.job, {
      timedOut: waitResult.timedOut
    });
  }
  if (shouldRunOperationAsync(args, operation)) {
    return submitAsyncImportWorkflowJob({
      ...args,
      asyncOperation: operation,
      operation: 'submit_async'
    }, options);
  }

  switch (operation) {
    case 'submit':
      return createImportTaskPayload(candidate, {
        trigger: args.trigger || 'mcp',
        serverFilePath: args.serverFilePath || args.server_file_path,
        files: Array.isArray(args.files) ? args.files : undefined,
        identifiers: args.identifiers,
        doi: args.doi,
        arxivId: args.arxivId || args.arxiv_id,
        pmid: args.pmid,
        pmcid: args.pmcid,
        isbn: args.isbn,
        issn: args.issn,
        sourceProvider: args.sourceProvider || args.source_provider,
        processingProfile: args.processingProfile || args.processing_profile || args.importProfile || args.import_profile,
        completionPolicy: args.completionPolicy || args.completion_policy,
        importExecutionMode: args.importExecutionMode
          || args.import_execution_mode
          || args.importsExecutionMode
          || args.imports_execution_mode,
        llmContextWindowTokens: args.llmContextWindowTokens
          || args.llm_context_window_tokens
          || args.contextWindowTokens
          || args.context_window_tokens,
        llmExtractionStrategy: args.llmExtractionStrategy || args.llm_extraction_strategy,
        llmLongContextMaxPapersPerCall: args.llmLongContextMaxPapersPerCall || args.llm_long_context_max_papers_per_call,
        llmBatchConcurrency: args.llmBatchConcurrency
          || args.llm_batch_concurrency
          || args.batchConcurrency
          || args.batch_concurrency
      }, options);
    case 'list': {
      const payload = await listImportTasksPayload(candidate, options);
      const limit = Number(args.limit || 0);
      if (Number.isFinite(limit) && limit > 0) {
        payload.tasks = (payload.tasks || []).slice(0, limit);
      }
      const internalRootPath = await resolveImportWorkflowInternalRootPath(candidate, payload, options);
      payload.tasks = await hydrateTasksAuthoritativeSync(internalRootPath, payload.tasks || []);
      return payload;
    }
    case 'progress':
    case 'status': {
      if (hasBatchTaskStatusRequest(args)) {
        const requestedTaskIds = collectRequestedTaskIds(args);
        if (!requestedTaskIds.length) {
          throw new Error(`taskIds is required for import_workflow ${operation} batch lookup.`);
        }
        return importTaskBatchPayload(candidate, requestedTaskIds, operation, options);
      }
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error(`taskId is required for import_workflow ${operation}.`);
      }
      const payload = await importTaskPayload(candidate, taskId, options);
      const internalRootPath = await resolveImportWorkflowInternalRootPath(candidate, payload, options);
      return hydrateImportTaskPayloadAuthoritativeSync(payload, internalRootPath);
    }
    case 'queue_progress': {
      const payload = await listImportTasksPayload(candidate, options);
      const internalRootPath = await resolveImportWorkflowInternalRootPath(candidate, payload, options);
      const requestedTaskIds = collectRequestedTaskIds(args);
      let tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      if (requestedTaskIds.length) {
        const requested = new Set(requestedTaskIds);
        tasks = tasks.filter((task) => requested.has(String(task?.id || '').trim()));
      }
      const paperId = String(args.paperId || args.paper_id || '').trim();
      const source = String(args.source || '').trim();
      if (paperId || source) {
        tasks = tasks.filter((task) => taskMatchesReference(task, { paperId, source }));
      }
      const limit = Number(args.limit || 0);
      if (Number.isFinite(limit) && limit > 0) {
        tasks = tasks.slice(0, limit);
      }
      tasks = await hydrateTasksAuthoritativeSync(internalRootPath, tasks);
      const summary = summarizeProgressTasks(tasks);
      const eventTail = Math.max(0, Number(args.eventTail ?? args.event_tail ?? args.recentEventLimit ?? args.recent_event_limit ?? 5) || 0);
      const dagTail = Math.max(0, Number(args.dagTail ?? args.dag_tail ?? args.recentDagEventLimit ?? args.recent_dag_event_limit ?? eventTail) || 0);
      const includeDagComparison = enabledFlag(args.includeDagComparison ?? args.include_dag_comparison, true);
      if (summary.activeTaskId && summary.activeTask && eventTail > 0) {
        summary.activeTask.eventLedger = await tailImportTaskEvents(internalRootPath, summary.activeTaskId, {
          tail: eventTail
        });
      }
      if (summary.activeTaskId && summary.activeTask && dagTail > 0) {
        summary.activeTask.dagEventLedger = await tailImportTaskDagEvents(internalRootPath, summary.activeTaskId, {
          tail: dagTail
        });
      }
      if (summary.activeTaskId && summary.activeTask && includeDagComparison) {
        summary.activeTask.dagComparison = await createImportDagComparisonReport(internalRootPath, summary.activeTaskId);
      }
      const workerCoverage = await configuredWorkerCoveragePayload(internalRootPath, options);
      const workerRootPath = workerCoverage.coveredRootPath || internalRootPath;
      const workerSeen = getImportWorkerCoverageSnapshot(workerRootPath) || getImportWorkerCoverageSnapshot(internalRootPath);
      const includeSemanticQueue = enabledFlag(args.includeSemanticQueue ?? args.include_semantic_queue, true);
      return {
        rootPath: payload.rootPath,
        summary,
        queueSummary: payload.summary,
        semanticQueue: includeSemanticQueue
          ? await importSemanticQueueProgressPayload(workerRootPath, args)
          : null,
        workerCoverage: {
          ...workerCoverage,
          lastWorkerSeenAt: workerSeen?.lastWorkerSeenAt || null,
          workerObserved: Boolean(workerSeen)
        },
        tasks,
        generatedAt: new Date().toISOString()
      };
    }
    case 'log': {
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow log.');
      }
      return importTaskLogPayload(candidate, taskId, options);
    }
    case 'wait': {
      if (hasBatchTaskStatusRequest(args)) {
        const requestedTaskIds = collectRequestedTaskIds(args);
        if (!requestedTaskIds.length) {
          throw new Error('taskIds is required for import_workflow wait batch lookup.');
        }
        return importTaskBatchWaitPayload(candidate, requestedTaskIds, args, options);
      }
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow wait.');
      }
      const timeoutSeconds = Number(args.timeout || 1800);
      const intervalSeconds = Number(args.interval || 2);
      const deadline = Date.now() + (Math.max(1, timeoutSeconds) * 1000);
      const waitTarget = normalizeImportWaitTarget(args);
      const waitForAuthoritativeSync = shouldWaitForAuthoritativeSyncAfterTarget(args, waitTarget);
      const internalRootPath = await resolveImportWorkflowInternalRootPath(candidate, {}, options);

      while (true) {
        const [taskPayload, logPayload] = await Promise.all([
          importTaskPayload(candidate, taskId, options),
          importTaskLogPayload(candidate, taskId, options)
        ]);
        const task = await hydrateTaskAuthoritativeSync(internalRootPath, taskPayload.task);
        const waitStatus = isImportWaitTargetSatisfied(task, waitTarget);
        const taskStatus = normalizeProgressToken(task?.status, 'unknown');
        if (waitStatus) {
          const authoritativeSync = taskStatus === 'completed' && waitForAuthoritativeSync
            ? await waitForAuthoritativeSyncJob(
                internalRootPath,
                task,
                deadline,
                intervalSeconds
              )
            : getTaskAuthoritativeSync(task);
          const hydratedTask = authoritativeSync?.job
            ? applyHydratedAuthoritativeSync(task, authoritativeSync.job)
            : task;
          return {
            rootPath: taskPayload.rootPath,
            task: hydratedTask,
            authoritativeSync,
            waitTarget,
            waitForAuthoritativeSync,
            waitStatus,
            log: logPayload.log || '',
            generatedAt: new Date().toISOString()
          };
        }
        if (Date.now() >= deadline) {
          const latestWaitStatus = importWaitStatus(task, waitTarget, 'timeout');
          throw new Error(
            `Timed out waiting for task ${taskId} target=${waitTarget}. Last status=${latestWaitStatus.taskStatus} graph=${latestWaitStatus.graphVisibilityStatus} semantic=${latestWaitStatus.semanticStatus} stage=${task?.stage || 'unknown'}`
          );
        }
        await sleep(Math.max(0.05, intervalSeconds) * 1000);
      }
    }
    default:
      throw new Error(`Unknown import_workflow operation: ${args.operation || '<missing>'}`);
  }
}
