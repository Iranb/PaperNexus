import { listDiscoveryProgress, listDiscoveryRuns, loadDiscoveryProgress, loadDiscoveryRun } from '../core/discovery/store.js';
import { getImportWorkerCoverageSnapshot } from '../core/imports/worker.js';
import { configuredWorkerCoveragePayload } from '../server/api.js';
import { resolveCorpus } from '../storage/corpus-store.js';

const PROGRESS_QUERY_CONTRACT_VERSION = 'literature-discovery-progress-query-v1';
const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const DEFAULT_STALE_AFTER_MINUTES = 10;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled']);
const TERMINAL_STAGES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback) {
  const number = finiteNumber(value);
  if (!number || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function parseTimeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTime(value) {
  const ms = parseTimeMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function terminalProgress(progress = {}, run = null) {
  const status = String(progress.status || '').toLowerCase();
  const stage = String(progress.stage || '').toLowerCase();
  if (TERMINAL_STATUSES.has(status) || TERMINAL_STAGES.has(stage)) return true;
  return Boolean(!progress.runId && run?.runId);
}

function progressTopic(progress = {}, run = null) {
  return progress.topic || run?.topic || '';
}

function progressCounts(progress = {}, run = null) {
  const coverage = progress.coverage || run?.coverage || null;
  const planQueries = Array.isArray(run?.plan?.queries) ? run.plan.queries.length : null;
  const runCandidates = Array.isArray(run?.candidates) ? run.candidates.length : null;
  return {
    rawCandidateCount: firstFiniteNumber(progress.rawCandidateCount, run?.rawCandidateCount, coverage?.candidateCount),
    providerCandidateCount: firstFiniteNumber(progress.providerCandidateCount),
    candidateCount: firstFiniteNumber(progress.candidateCount, runCandidates, coverage?.candidateCount),
    queryCount: firstFiniteNumber(progress.queryCount, planQueries),
    importSummary: progress.importSummary || run?.importSummary || null,
    coverage
  };
}

function estimateWait(progress = {}, run = null, context = {}) {
  const { nowMs, isTerminal, isStale } = context;
  if (isTerminal) {
    return {
      estimatedWaitMs: 0,
      estimatedWaitMinutes: 0,
      estimatedCompletionAt: isoTime(progress.completedAt || run?.generatedAt) || new Date(nowMs).toISOString(),
      source: 'terminal',
      confidence: 'high',
      reason: 'run is already terminal'
    };
  }

  if (isStale) {
    return {
      estimatedWaitMs: null,
      estimatedWaitMinutes: null,
      estimatedCompletionAt: null,
      source: 'stale-progress',
      confidence: 'low',
      reason: 'progress updatedAt is older than staleAfterMinutes'
    };
  }

  const budget = progress.budget || run?.budget || null;
  const deadlineAt = parseTimeMs(budget?.deadlineAt ?? budget?.deadline_at);
  if (deadlineAt !== null) {
    const remainingMs = Math.max(0, deadlineAt - nowMs);
    return {
      estimatedWaitMs: remainingMs,
      estimatedWaitMinutes: Math.ceil(remainingMs / 60000),
      estimatedCompletionAt: new Date(deadlineAt).toISOString(),
      source: 'budget.deadlineAt',
      confidence: 'medium',
      reason: 'derived from discovery soft budget deadline'
    };
  }

  const remainingMs = firstFiniteNumber(budget?.remainingMs, budget?.remaining_ms);
  if (remainingMs !== null) {
    const normalizedRemainingMs = Math.max(0, remainingMs);
    return {
      estimatedWaitMs: normalizedRemainingMs,
      estimatedWaitMinutes: Math.ceil(normalizedRemainingMs / 60000),
      estimatedCompletionAt: new Date(nowMs + normalizedRemainingMs).toISOString(),
      source: 'budget.remainingMs',
      confidence: 'medium',
      reason: 'derived from discovery soft budget remainingMs'
    };
  }

  return {
    estimatedWaitMs: null,
    estimatedWaitMinutes: null,
    estimatedCompletionAt: null,
    source: 'unknown',
    confidence: 'low',
    reason: 'no discovery budget estimate is available in the progress snapshot'
  };
}

function summarizeProgress(progress = {}, run = null, context = {}) {
  const { nowMs, pollIntervalMs, staleAfterMs, workerCoverage = null } = context;
  const runId = progress.runId || run?.runId || '';
  const status = progress.status || (run ? 'completed' : 'unknown');
  const stage = progress.stage || (run ? 'completed' : 'unknown');
  const updatedAt = progress.updatedAt || progress.completedAt || run?.generatedAt || progress.startedAt || progress.submittedAt || null;
  const updatedAtMs = parseTimeMs(updatedAt);
  const ageMs = updatedAtMs === null ? null : Math.max(0, nowMs - updatedAtMs);
  const isTerminal = terminalProgress(progress, run);
  const isStale = Boolean(!isTerminal && ageMs !== null && ageMs > staleAfterMs);
  const eta = estimateWait(progress, run, {
    nowMs,
    isTerminal,
    isStale
  });
  const reportAvailable = Boolean(run?.runId);
  const action = isTerminal
    ? (status === 'failed' ? 'inspect_failure' : 'fetch_report')
    : (isStale ? 'schedule_recheck_stale_progress' : 'schedule_recheck');

  return {
    runId,
    status,
    stage,
    topic: progressTopic(progress, run),
    operation: progress.operation || run?.diagnostics?.operation || '',
    searchMode: progress.searchMode || run?.diagnostics?.searchMode || '',
    submittedAt: progress.submittedAt || null,
    startedAt: progress.startedAt || null,
    updatedAt: updatedAt ? isoTime(updatedAt) : null,
    completedAt: progress.completedAt || null,
    isTerminal,
    isStale,
    ageMs,
    ageMinutes: ageMs === null ? null : Math.floor(ageMs / 60000),
    reportAvailable,
    runLifecycle: {
      state: stage,
      status,
      updatedAt: updatedAt ? isoTime(updatedAt) : null,
      stale: isStale
    },
    workerCoverage,
    counts: progressCounts(progress, run),
    eta,
    wait: {
      recommendedAction: action,
      recommendedPollIntervalMs: isTerminal ? 0 : pollIntervalMs,
      recommendedPollIntervalMinutes: isTerminal ? 0 : Math.ceil(pollIntervalMs / 60000),
      nextPollAt: isTerminal ? null : new Date(nowMs + pollIntervalMs).toISOString(),
      staleAfterMs,
      staleAfterMinutes: Math.ceil(staleAfterMs / 60000)
    }
  };
}

async function summarizeProgressRecord(rootPath, progress, context) {
  const run = progress?.runId ? await loadDiscoveryRun(rootPath, progress.runId) : null;
  return summarizeProgress(progress || {}, run, context);
}

async function loadCompletedRunSummaries(rootPath, existingRunIds, limit, context) {
  const completedRuns = await listDiscoveryRuns(rootPath, limit);
  const summaries = [];
  for (const entry of completedRuns) {
    if (!entry.runId || existingRunIds.has(entry.runId)) continue;
    const run = await loadDiscoveryRun(rootPath, entry.runId);
    if (!run) continue;
    summaries.push(summarizeProgress({}, run, context));
    existingRunIds.add(entry.runId);
    if (summaries.length >= limit) break;
  }
  return summaries;
}

export async function executeLiteratureDiscoveryProgressTool(args = {}, options = {}) {
  const rootPath = await resolveCorpus(args.corpus);
  const nowMs = Date.now();
  const limit = positiveInteger(args.limit, 10);
  const pollIntervalMinutes = positiveInteger(args.pollIntervalMinutes ?? args.poll_interval_minutes, DEFAULT_POLL_INTERVAL_MINUTES);
  const staleAfterMinutes = positiveInteger(args.staleAfterMinutes ?? args.stale_after_minutes, DEFAULT_STALE_AFTER_MINUTES);
  const includeCompleted = args.includeCompleted ?? args.include_completed ?? true;
  const runId = String(args.runId || args.run_id || '').trim();
  const context = {
    nowMs,
    pollIntervalMs: pollIntervalMinutes * 60000,
    staleAfterMs: staleAfterMinutes * 60000,
    workerCoverage: null
  };
  const configuredCoverage = await configuredWorkerCoveragePayload(rootPath, options);
  const workerSeen = getImportWorkerCoverageSnapshot(rootPath);
  context.workerCoverage = {
    ...configuredCoverage,
    lastWorkerSeenAt: workerSeen?.lastWorkerSeenAt || null,
    workerObserved: Boolean(workerSeen)
  };

  if (runId) {
    const progress = await loadDiscoveryProgress(rootPath, runId);
    const run = await loadDiscoveryRun(rootPath, runId);
    if (!progress && !run) {
      throw new Error(`No literature discovery progress or run found for runId: ${runId}`);
    }
    return JSON.stringify({
      contractVersion: PROGRESS_QUERY_CONTRACT_VERSION,
      rootPath,
      generatedAt: new Date(nowMs).toISOString(),
      current: summarizeProgress(progress || {}, run, context),
      progress: progress || null
    }, null, 2);
  }

  const progressRecords = await listDiscoveryProgress(rootPath, limit);
  const summaries = [];
  const existingRunIds = new Set();
  for (const progress of progressRecords) {
    const summary = await summarizeProgressRecord(rootPath, progress, context);
    if (!includeCompleted && summary.isTerminal) continue;
    summaries.push(summary);
    if (summary.runId) existingRunIds.add(summary.runId);
    if (summaries.length >= limit) break;
  }

  if (includeCompleted && summaries.length < limit) {
    summaries.push(...await loadCompletedRunSummaries(rootPath, existingRunIds, limit - summaries.length, context));
  }

  return JSON.stringify({
    contractVersion: PROGRESS_QUERY_CONTRACT_VERSION,
    rootPath,
    generatedAt: new Date(nowMs).toISOString(),
    current: summaries[0] || null,
    runs: summaries
  }, null, 2);
}
