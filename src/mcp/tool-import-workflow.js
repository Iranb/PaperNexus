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
  listImportTasksPayload
} from '../server/api.js';
import { getImportWorkerCoverageSnapshot } from '../core/imports/worker.js';
import { getDefaultRuntimeConfigRoot } from '../lib/config.js';
import { ensureDir, readJson, writeJson } from '../lib/fs.js';

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

function summarizeProgressTasks(tasks = []) {
  const summary = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    overallPercent: 0
  };
  if (!tasks.length) return summary;

  let totalPercent = 0;
  for (const task of tasks) {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status === 'completed') summary.completed += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'running') summary.running += 1;
    else summary.pending += 1;
    totalPercent += Number(task?.progress?.percent || 0) || 0;
  }
  summary.remaining = summary.pending + summary.running;
  summary.overallPercent = Math.max(0, Math.min(100, Math.round((totalPercent / tasks.length) * 100) / 100));
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

function isAuthoritativeSyncTerminal(job = {}) {
  const status = String(job?.status || '').trim().toLowerCase();
  return status === 'completed' || status === 'failed' || status === 'superseded';
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

async function waitForAuthoritativeSyncJob(rootPath, task, deadline, intervalSeconds) {
  const sync = getTaskAuthoritativeSync(task);
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
        sourceProvider: args.sourceProvider || args.source_provider
      }, options);
    case 'list': {
      const payload = await listImportTasksPayload(candidate, options);
      const limit = Number(args.limit || 0);
      if (Number.isFinite(limit) && limit > 0) {
        payload.tasks = (payload.tasks || []).slice(0, limit);
      }
      return payload;
    }
    case 'progress':
    case 'status': {
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error(`taskId is required for import_workflow ${operation}.`);
      }
      return importTaskPayload(candidate, taskId, options);
    }
    case 'queue_progress': {
      const payload = await listImportTasksPayload(candidate, options);
      const requestedTaskIds = Array.isArray(args.taskIds)
        ? args.taskIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
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
      const workerCoverage = await configuredWorkerCoveragePayload(payload.rootPath, options);
      const workerSeen = getImportWorkerCoverageSnapshot(payload.rootPath);
      return {
        rootPath: payload.rootPath,
        summary: summarizeProgressTasks(tasks),
        queueSummary: payload.summary,
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
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow wait.');
      }
      const timeoutSeconds = Number(args.timeout || 1800);
      const intervalSeconds = Number(args.interval || 2);
      const deadline = Date.now() + (Math.max(1, timeoutSeconds) * 1000);

      while (true) {
        const [taskPayload, logPayload] = await Promise.all([
          importTaskPayload(candidate, taskId, options),
          importTaskLogPayload(candidate, taskId, options)
        ]);
        const status = String(taskPayload.task?.status || '').trim().toLowerCase();
        if (status === 'completed' || status === 'failed') {
          const authoritativeSync = status === 'completed' && enabledFlag(
            args.waitForAuthoritativeSync ?? args.wait_for_authoritative_sync,
            true
          )
            ? await waitForAuthoritativeSyncJob(
                taskPayload.rootPath,
                taskPayload.task,
                deadline,
                intervalSeconds
              )
            : getTaskAuthoritativeSync(taskPayload.task);
          return {
            rootPath: taskPayload.rootPath,
            task: taskPayload.task,
            authoritativeSync,
            log: logPayload.log || '',
            generatedAt: new Date().toISOString()
          };
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for task ${taskId}. Last status=${taskPayload.task?.status || 'unknown'} stage=${taskPayload.task?.stage || 'unknown'}`
          );
        }
        await sleep(Math.max(0.05, intervalSeconds) * 1000);
      }
    }
    default:
      throw new Error(`Unknown import_workflow operation: ${args.operation || '<missing>'}`);
  }
}
