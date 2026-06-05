import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCorpusPaths } from './corpus-store.js';
import {
  ensureDir,
  fileExists,
  isMetadataFileName,
  readText,
  readJson,
  withFileLock,
  writeJson
} from '../lib/fs.js';
import {
  mergePaperIdentifiers,
  normalizePaperIdentifiers
} from '../lib/paper-identifiers.js';
import { slugify, stableHash } from '../lib/utils.js';

const IMPORT_SCHEMA_VERSION = 1;
const IMPORT_CONTENT_INDEX_SCHEMA_VERSION = 1;
const IMPORT_QUARANTINE_SCHEMA_VERSION = 1;
const IMPORT_PROGRESS_CONTRACT_VERSION = 'import-progress-v1';
const IMPORT_QUEUE_PROGRESS_CONTRACT_VERSION = 'import-queue-progress-v1';
const IMPORT_EVENT_CONTRACT_VERSION = 'import-event-v1';
const IMPORT_DAG_CONTRACT_VERSION = 'import-dag-v1';
const IMPORT_DAG_EVENT_CONTRACT_VERSION = 'import-dag-event-v1';
const IMPORT_STAGE_TOTAL = 4;
const DEFAULT_FAILED_IMPORT_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_FAILED_IMPORT_RETRY_MAX = 3;
const DEFAULT_IMPORT_QUEUE_LOCK_TIMEOUT_MS = 30 * 1000;
const DEFAULT_IMPORT_QUEUE_LOCK_STALE_MS = 30 * 1000;
const DEFAULT_IMPORT_QUEUE_LOCK_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const DEFAULT_IMPORT_BATCH_MAX_TASKS = 16;
const HARD_IMPORT_BATCH_MAX_TASKS = 16;
const IMPORT_PROCESSING_PROFILES = new Set([
  'full',
  'fast-md-structural',
  'fast-md-background-semantic',
  'long-context-full-md'
]);
const IMPORT_COMPLETION_POLICIES = new Set([
  'full',
  'graph-visible',
  'semantic-complete'
]);
const IMPORT_EXECUTION_MODES = new Set([
  'serial',
  'dag'
]);
const IMPORT_LIFECYCLE_STATUSES = new Set([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'not-started',
  'not-required',
  'skipped'
]);
const IMPORT_DAG_NODE_DEFINITIONS = [
  { id: 'task.queued', dependsOn: [] },
  { id: 'source.materialize', dependsOn: ['task.queued'] },
  { id: 'chunk.normalize', dependsOn: ['source.materialize'] },
  { id: 'paper.structural_snapshot', dependsOn: ['chunk.normalize'] },
  { id: 'paper.long_context_llm', dependsOn: ['paper.structural_snapshot'] },
  { id: 'chunk.semantic_llm', dependsOn: ['paper.structural_snapshot'] },
  { id: 'chunk.relation_llm', dependsOn: ['chunk.semantic_llm'] },
  { id: 'paper.delta_build', dependsOn: ['paper.structural_snapshot'] },
  { id: 'corpus.merge', dependsOn: ['paper.delta_build'] },
  { id: 'lite_state.update', dependsOn: ['corpus.merge'] },
  { id: 'authoritative_sync.enqueue', dependsOn: ['lite_state.update'] },
  { id: 'authoritative_sync.apply', dependsOn: ['authoritative_sync.enqueue'] },
  { id: 'task.completed', dependsOn: ['lite_state.update'] }
];
const IMPORT_DAG_NODE_IDS = new Set(IMPORT_DAG_NODE_DEFINITIONS.map((definition) => definition.id));
const IMPORT_DAG_RETRY_OWNERS = new Map([
  ['task.queued', 'import-queue'],
  ['source.materialize', 'import-worker'],
  ['chunk.normalize', 'import-worker'],
  ['paper.structural_snapshot', 'import-worker'],
  ['paper.long_context_llm', 'llm-worker-pool'],
  ['chunk.semantic_llm', 'llm-worker-pool'],
  ['chunk.relation_llm', 'llm-worker-pool'],
  ['paper.delta_build', 'graph-commit'],
  ['corpus.merge', 'graph-commit'],
  ['lite_state.update', 'graph-commit'],
  ['authoritative_sync.enqueue', 'authoritative-sync-worker'],
  ['authoritative_sync.apply', 'authoritative-sync-worker'],
  ['task.completed', 'import-worker']
]);
const IMPORT_DAG_NODE_ALIASES = new Map([
  ['queued', 'task.queued'],
  ['pending', 'task.queued'],
  ['created', 'task.queued'],
  ['materialize', 'source.materialize'],
  ['source-materialize', 'source.materialize'],
  ['source.materialize', 'source.materialize'],
  ['normalize', 'chunk.normalize'],
  ['chunk-normalize', 'chunk.normalize'],
  ['chunk.normalize', 'chunk.normalize'],
  ['structural-snapshot', 'paper.structural_snapshot'],
  ['paper-structural-snapshot', 'paper.structural_snapshot'],
  ['paper.structural-snapshot', 'paper.structural_snapshot'],
  ['paper.structural_snapshot', 'paper.structural_snapshot'],
  ['llm', 'paper.long_context_llm'],
  ['llm-optimize', 'paper.long_context_llm'],
  ['llm-optimization', 'paper.long_context_llm'],
  ['long-context', 'paper.long_context_llm'],
  ['long-context-llm', 'paper.long_context_llm'],
  ['paper-long-context-llm', 'paper.long_context_llm'],
  ['paper.long-context-llm', 'paper.long_context_llm'],
  ['paper.long_context_llm', 'paper.long_context_llm'],
  ['semantic', 'paper.long_context_llm'],
  ['semantic-enrichment', 'paper.long_context_llm'],
  ['semantic-complete', 'paper.long_context_llm'],
  ['chunk-semantic', 'chunk.semantic_llm'],
  ['chunk-semantic-llm', 'chunk.semantic_llm'],
  ['chunk.semantic-llm', 'chunk.semantic_llm'],
  ['chunk.semantic_llm', 'chunk.semantic_llm'],
  ['chunk-relation', 'chunk.relation_llm'],
  ['chunk-relation-llm', 'chunk.relation_llm'],
  ['chunk.relation-llm', 'chunk.relation_llm'],
  ['chunk.relation_llm', 'chunk.relation_llm'],
  ['fast-commit', 'paper.delta_build'],
  ['delta', 'paper.delta_build'],
  ['delta-build', 'paper.delta_build'],
  ['paper-delta-build', 'paper.delta_build'],
  ['paper.delta-build', 'paper.delta_build'],
  ['paper.delta_build', 'paper.delta_build'],
  ['commit', 'corpus.merge'],
  ['corpus-merge', 'corpus.merge'],
  ['corpus.merge', 'corpus.merge'],
  ['lite-state', 'lite_state.update'],
  ['lite-state-update', 'lite_state.update'],
  ['lite-state.update', 'lite_state.update'],
  ['lite_state.update', 'lite_state.update'],
  ['graph-visible', 'lite_state.update'],
  ['authoritative-sync', 'authoritative_sync.apply'],
  ['authoritative-sync-apply', 'authoritative_sync.apply'],
  ['authoritative-sync.apply', 'authoritative_sync.apply'],
  ['authoritative_sync.apply', 'authoritative_sync.apply'],
  ['authoritative-sync-enqueue', 'authoritative_sync.enqueue'],
  ['authoritative-sync.enqueue', 'authoritative_sync.enqueue'],
  ['authoritative_sync.enqueue', 'authoritative_sync.enqueue'],
  ['completed', 'task.completed'],
  ['complete', 'task.completed'],
  ['task-completed', 'task.completed'],
  ['task.completed', 'task.completed']
]);
const IMPORT_STAGE_WEIGHTS = {
  queued: { index: 0, startPercent: 0, weight: 0 },
  materialize: { index: 1, startPercent: 0, weight: 50 },
  'llm-optimize': { index: 2, startPercent: 50, weight: 30 },
  'fast-commit': { index: 3, startPercent: 80, weight: 20 },
  completed: { index: 4, startPercent: 100, weight: 0 }
};

function clampPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function normalizeImportStage(stage, status = '') {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'completed') return 'completed';
  if (IMPORT_STAGE_WEIGHTS[normalizedStage]) return normalizedStage;
  return normalizedStatus === 'running' ? 'materialize' : 'queued';
}

function defaultProgressMessage(stage, status = '') {
  switch (normalizeImportStage(stage, status)) {
    case 'materialize':
      return 'Preparing paper snapshots';
    case 'llm-optimize':
      return 'Running LLM optimization';
    case 'fast-commit':
      return 'Applying graph update';
    case 'completed':
      return 'Import task completed';
    case 'queued':
    default:
      return 'Queued for processing';
  }
}

function computeOverallPercent(stage, stagePercent, status = '') {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedStage = normalizeImportStage(stage, status);
  if (normalizedStatus === 'completed' || normalizedStage === 'completed') return 100;
  const stageMeta = IMPORT_STAGE_WEIGHTS[normalizedStage] || IMPORT_STAGE_WEIGHTS.queued;
  return clampPercent(stageMeta.startPercent + ((clampPercent(stagePercent) / 100) * stageMeta.weight));
}

function createImportProgress(task = {}, overrides = {}) {
  const now = new Date().toISOString();
  const existing = (task.progress && typeof task.progress === 'object' && !Array.isArray(task.progress))
    ? task.progress
    : {};
  const status = String(overrides.status || task.status || existing.status || 'pending').trim().toLowerCase() || 'pending';
  const stage = normalizeImportStage(
    overrides.stage !== undefined ? overrides.stage : (task.stage || existing.stage || 'queued'),
    status
  );
  const stageChanged = stage !== normalizeImportStage(existing.stage, existing.status || status);
  const stagePercent = status === 'completed'
    ? 100
    : clampPercent(
      overrides.stagePercent !== undefined
        ? overrides.stagePercent
        : existing.stagePercent,
      stage === 'queued' ? 0 : 0
    );
  const totalUnits = Math.max(0, Number(
    overrides.totalUnits !== undefined
      ? overrides.totalUnits
      : existing.totalUnits || 0
  ) || 0);
  const processedUnits = Math.max(0, Math.min(
    totalUnits || Number.MAX_SAFE_INTEGER,
    Number(
      overrides.processedUnits !== undefined
        ? overrides.processedUnits
        : existing.processedUnits || 0
    ) || 0
  ));
  const currentStep = String(
    overrides.currentStep !== undefined
      ? overrides.currentStep
      : (existing.currentStep || '')
  ).trim();
  const message = String(
    overrides.message !== undefined
      ? overrides.message
      : (existing.message || defaultProgressMessage(stage, status))
  ).trim() || defaultProgressMessage(stage, status);
  const stageMeta = IMPORT_STAGE_WEIGHTS[stage] || IMPORT_STAGE_WEIGHTS.queued;
  const diagnostics = overrides.diagnostics && typeof overrides.diagnostics === 'object' && !Array.isArray(overrides.diagnostics)
    ? overrides.diagnostics
    : (existing.diagnostics && typeof existing.diagnostics === 'object' && !Array.isArray(existing.diagnostics)
      ? existing.diagnostics
      : null);

  return {
    contractVersion: IMPORT_PROGRESS_CONTRACT_VERSION,
    status,
    stage,
    stageIndex: stageMeta.index,
    stageTotal: IMPORT_STAGE_TOTAL,
    percent: computeOverallPercent(stage, stagePercent, status),
    stagePercent: status === 'completed' ? 100 : stagePercent,
    currentStep,
    processedUnits,
    totalUnits,
    queuePosition: overrides.queuePosition !== undefined ? overrides.queuePosition : (existing.queuePosition ?? null),
    queuedAhead: overrides.queuedAhead !== undefined ? overrides.queuedAhead : (existing.queuedAhead ?? null),
    stageStartedAt: overrides.stageStartedAt || (stageChanged ? now : (existing.stageStartedAt || task.startedAt || now)),
    lastEventAt: overrides.lastEventAt || now,
    message,
    ...(diagnostics ? { diagnostics } : {})
  };
}

function buildQueueOrderedTasks(queue, tasks = []) {
  const taskById = new Map(tasks.filter(Boolean).map((task) => [task.id, task]));
  return (queue.jobs || []).map((job) => taskById.get(job.id)).filter(Boolean);
}

function decorateTaskWithQueueProgress(task, queueOrderedTasks = []) {
  const activeTasks = queueOrderedTasks.filter((entry) => !['completed', 'failed'].includes(String(entry?.status || '').trim().toLowerCase()));
  const queuePosition = activeTasks.findIndex((entry) => entry.id === task.id);
  const decoratedTask = decorateImportTaskLifecycle(task);
  const lastEventAt = decoratedTask.progress?.lastEventAt
    || decoratedTask.updatedAt
    || decoratedTask.startedAt
    || decoratedTask.createdAt
    || new Date(0).toISOString();
  return {
    ...decoratedTask,
    progress: createImportProgress(decoratedTask, {
      queuePosition: queuePosition === -1 ? null : queuePosition + 1,
      queuedAhead: queuePosition === -1 ? 0 : queuePosition,
      lastEventAt
    })
  };
}

function summarizeImportTasks(tasks = []) {
  const summary = {
    contractVersion: IMPORT_QUEUE_PROGRESS_CONTRACT_VERSION,
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    overallPercent: 0,
    activeTaskId: null,
    activeStage: null
  };
  if (!tasks.length) {
    return summary;
  }

  let totalPercent = 0;
  for (const task of tasks) {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status === 'completed') summary.completed += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'running') summary.running += 1;
    else summary.pending += 1;
    totalPercent += clampPercent(task?.progress?.percent, 0);
    if (!summary.activeTaskId && (status === 'running' || status === 'pending')) {
      summary.activeTaskId = task.id;
      summary.activeStage = String(task?.stage || '').trim() || null;
    }
  }
  summary.remaining = summary.pending + summary.running;
  summary.overallPercent = clampPercent(totalPercent / tasks.length, tasks.every((task) => String(task?.status || '').trim().toLowerCase() === 'completed') ? 100 : 0);
  return summary;
}

function createImportValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeDashedToken(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function normalizeImportProcessingProfile(value, fallback = 'full') {
  const normalized = normalizeDashedToken(value);
  if (IMPORT_PROCESSING_PROFILES.has(normalized)) return normalized;
  if (normalized === 'fast-md' || normalized === 'fast-markdown') {
    return 'fast-md-background-semantic';
  }
  if (normalized === 'long-context' || normalized === 'long-context-md') {
    return 'long-context-full-md';
  }
  return IMPORT_PROCESSING_PROFILES.has(fallback) ? fallback : 'full';
}

function defaultCompletionPolicyForProfile(processingProfile = 'full') {
  switch (normalizeImportProcessingProfile(processingProfile)) {
    case 'fast-md-structural':
    case 'fast-md-background-semantic':
      return 'graph-visible';
    case 'long-context-full-md':
    case 'full':
    default:
      return 'full';
  }
}

function normalizeImportCompletionPolicy(value, processingProfile = 'full') {
  const normalized = normalizeDashedToken(value);
  if (IMPORT_COMPLETION_POLICIES.has(normalized)) return normalized;
  if (normalized === 'graph') return 'graph-visible';
  if (normalized === 'semantic') return 'semantic-complete';
  return defaultCompletionPolicyForProfile(processingProfile);
}

function normalizeImportExecutionMode(value, fallback = 'serial') {
  const normalized = normalizeDashedToken(value);
  if (IMPORT_EXECUTION_MODES.has(normalized)) return normalized;
  if (normalized === 'serial-sidecar' || normalized === 'sidecar') return 'serial';
  if (normalized === 'dag-sidecar' || normalized === 'async-dag') return 'dag';
  return IMPORT_EXECUTION_MODES.has(fallback) ? fallback : 'serial';
}

function normalizeImportLifecycleStatus(value, fallback = 'pending') {
  const normalized = normalizeDashedToken(value);
  if (IMPORT_LIFECYCLE_STATUSES.has(normalized)) return normalized;
  return IMPORT_LIFECYCLE_STATUSES.has(fallback) ? fallback : 'pending';
}

function taskResultObject(result) {
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstLifecycleValue(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function normalizePositiveIntegerOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function normalizeLlmExtractionStrategyOrNull(value) {
  const normalized = normalizeDashedToken(value);
  if (['long-context-first', 'chunk-first', 'auto'].includes(normalized)) return normalized;
  return null;
}

function createImportTaskLlmConfigFields(input = {}, options = {}) {
  const result = taskResultObject(input.result);
  const resultLlmConfig = objectOrNull(result.llmConfig || result.llm_config) || {};
  const inputLlmConfig = objectOrNull(input.llmConfig || input.llm_config) || {};
  const optionsLlmConfig = objectOrNull(options.llmConfig || options.llm_config) || {};
  const llmContextWindowTokens = normalizePositiveIntegerOrNull(firstLifecycleValue(
    options.llmContextWindowTokens,
    options.llm_context_window_tokens,
    optionsLlmConfig.contextWindowTokens,
    optionsLlmConfig.llmContextWindowTokens,
    input.llmContextWindowTokens,
    input.llm_context_window_tokens,
    inputLlmConfig.contextWindowTokens,
    inputLlmConfig.llmContextWindowTokens,
    result.llmContextWindowTokens,
    result.llm_context_window_tokens,
    resultLlmConfig.contextWindowTokens,
    resultLlmConfig.llmContextWindowTokens
  ));
  const llmExtractionStrategy = normalizeLlmExtractionStrategyOrNull(firstLifecycleValue(
    options.llmExtractionStrategy,
    options.llm_extraction_strategy,
    optionsLlmConfig.extractionStrategy,
    optionsLlmConfig.llmExtractionStrategy,
    input.llmExtractionStrategy,
    input.llm_extraction_strategy,
    inputLlmConfig.extractionStrategy,
    inputLlmConfig.llmExtractionStrategy,
    result.llmExtractionStrategy,
    result.llm_extraction_strategy,
    resultLlmConfig.extractionStrategy,
    resultLlmConfig.llmExtractionStrategy
  ));
  const llmLongContextMaxPapersPerCall = normalizePositiveIntegerOrNull(firstLifecycleValue(
    options.llmLongContextMaxPapersPerCall,
    options.llm_long_context_max_papers_per_call,
    optionsLlmConfig.longContextMaxPapersPerCall,
    optionsLlmConfig.llmLongContextMaxPapersPerCall,
    input.llmLongContextMaxPapersPerCall,
    input.llm_long_context_max_papers_per_call,
    inputLlmConfig.longContextMaxPapersPerCall,
    inputLlmConfig.llmLongContextMaxPapersPerCall,
    result.llmLongContextMaxPapersPerCall,
    result.llm_long_context_max_papers_per_call,
    resultLlmConfig.longContextMaxPapersPerCall,
    resultLlmConfig.llmLongContextMaxPapersPerCall
  ));
  const llmBatchConcurrency = normalizePositiveIntegerOrNull(firstLifecycleValue(
    options.llmBatchConcurrency,
    options.llm_batch_concurrency,
    optionsLlmConfig.batchConcurrency,
    optionsLlmConfig.llmBatchConcurrency,
    input.llmBatchConcurrency,
    input.llm_batch_concurrency,
    inputLlmConfig.batchConcurrency,
    inputLlmConfig.llmBatchConcurrency,
    result.llmBatchConcurrency,
    result.llm_batch_concurrency,
    resultLlmConfig.batchConcurrency,
    resultLlmConfig.llmBatchConcurrency
  ));
  const hasLlmConfig = llmContextWindowTokens !== null
    || llmExtractionStrategy !== null
    || llmLongContextMaxPapersPerCall !== null
    || llmBatchConcurrency !== null;
  const llmConfigSource = firstLifecycleValue(
    options.llmConfigSource,
    options.llm_config_source,
    input.llmConfigSource,
    input.llm_config_source,
    result.llmConfigSource,
    result.llm_config_source
  ) || (hasLlmConfig ? 'request' : null);
  return {
    ...(llmContextWindowTokens !== null ? { llmContextWindowTokens } : {}),
    ...(llmExtractionStrategy !== null ? { llmExtractionStrategy } : {}),
    ...(llmLongContextMaxPapersPerCall !== null ? { llmLongContextMaxPapersPerCall } : {}),
    ...(llmBatchConcurrency !== null ? { llmBatchConcurrency } : {}),
    ...(hasLlmConfig
      ? {
          llmConfig: {
            ...(llmContextWindowTokens !== null ? { contextWindowTokens: llmContextWindowTokens } : {}),
            ...(llmExtractionStrategy !== null ? { extractionStrategy: llmExtractionStrategy } : {}),
            ...(llmLongContextMaxPapersPerCall !== null ? { longContextMaxPapersPerCall: llmLongContextMaxPapersPerCall } : {}),
            ...(llmBatchConcurrency !== null ? { batchConcurrency: llmBatchConcurrency } : {})
          },
          llmConfigSource
        }
      : {})
  };
}

function defaultSemanticStatusForProfile(processingProfile = 'full') {
  return normalizeImportProcessingProfile(processingProfile) === 'fast-md-structural'
    ? 'not-required'
    : 'pending';
}

function createImportLifecycleFields(input = {}, options = {}) {
  const result = taskResultObject(input.result);
  const processingProfile = normalizeImportProcessingProfile(firstLifecycleValue(
    options.processingProfile,
    options.processing_profile,
    options.importProfile,
    options.import_profile,
    input.processingProfile,
    input.processing_profile,
    input.importProfile,
    input.import_profile
  ));
  const completionPolicy = normalizeImportCompletionPolicy(firstLifecycleValue(
    options.completionPolicy,
    options.completion_policy,
    input.completionPolicy,
    input.completion_policy
  ), processingProfile);
  const importExecutionModeRaw = firstLifecycleValue(
    options.importExecutionMode,
    options.import_execution_mode,
    options.importsExecutionMode,
    options.imports_execution_mode,
    input.importExecutionMode,
    input.import_execution_mode,
    input.importsExecutionMode,
    input.imports_execution_mode,
    result.importExecutionMode,
    result.import_execution_mode
  );
  const importExecutionMode = normalizeImportExecutionMode(importExecutionModeRaw, 'serial');
  const importExecutionModeSource = firstLifecycleValue(
    options.importExecutionModeSource,
    options.import_execution_mode_source,
    input.importExecutionModeSource,
    input.import_execution_mode_source,
    result.importExecutionModeSource,
    result.import_execution_mode_source
  ) || (importExecutionModeRaw ? 'request' : 'default');
  const taskStatus = normalizeDashedToken(input.status);
  const completed = taskStatus === 'completed';
  const failed = taskStatus === 'failed';
  const graphFallback = completed ? 'completed' : failed ? 'failed' : 'pending';
  const semanticFallback = completed
    ? 'completed'
    : failed
      ? 'failed'
      : defaultSemanticStatusForProfile(processingProfile);

  return {
    processingProfile,
    completionPolicy,
    importExecutionMode,
    importExecutionModeSource,
    ...createImportTaskLlmConfigFields(input, options),
    graphVisibilityStatus: normalizeImportLifecycleStatus(firstLifecycleValue(
      options.graphVisibilityStatus,
      options.graph_visibility_status,
      result.graphVisibilityStatus,
      result.graph_visibility_status,
      input.graphVisibilityStatus,
      input.graph_visibility_status
    ), graphFallback),
    semanticStatus: normalizeImportLifecycleStatus(firstLifecycleValue(
      options.semanticStatus,
      options.semantic_status,
      result.semanticStatus,
      result.semantic_status,
      input.semanticStatus,
      input.semantic_status
    ), semanticFallback),
    authoritativeSyncStatus: normalizeImportLifecycleStatus(firstLifecycleValue(
      options.authoritativeSyncStatus,
      options.authoritative_sync_status,
      result.authoritativeSync?.status,
      result.authoritative_sync?.status,
      input.authoritativeSyncStatus,
      input.authoritative_sync_status
    ), 'not-started'),
    structuralCompletedAt: firstLifecycleValue(
      options.structuralCompletedAt,
      options.structural_completed_at,
      result.structuralCompletedAt,
      result.structural_completed_at,
      input.structuralCompletedAt,
      input.structural_completed_at
    ) || null,
    semanticCompletedAt: firstLifecycleValue(
      options.semanticCompletedAt,
      options.semantic_completed_at,
      result.semanticCompletedAt,
      result.semantic_completed_at,
      input.semanticCompletedAt,
      input.semantic_completed_at
    ) || null,
    throughputMetrics: options.throughputMetrics !== undefined
      ? options.throughputMetrics
      : result.throughputMetrics || result.throughput_metrics || input.throughputMetrics || input.throughput_metrics || null
  };
}

function decorateImportTaskLifecycle(task = {}) {
  if (!task || typeof task !== 'object') return task;
  return {
    ...task,
    ...createImportLifecycleFields(task)
  };
}

function createCompletedImportLifecycleFields(task = {}, result = null, finishedAt = new Date().toISOString()) {
  const resultObject = taskResultObject(result);
  const base = createImportLifecycleFields({
    ...task,
    result: resultObject
  });
  const completionPolicy = normalizeImportCompletionPolicy(base.completionPolicy, base.processingProfile);
  const explicitSemanticStatus = firstLifecycleValue(
    resultObject.semanticStatus,
    resultObject.semantic_status
  );
  const semanticFallback = base.processingProfile === 'fast-md-structural'
    ? 'not-required'
    : completionPolicy === 'graph-visible'
      ? base.semanticStatus || 'queued'
      : 'completed';
  const graphVisibilityStatus = normalizeImportLifecycleStatus(firstLifecycleValue(
    resultObject.graphVisibilityStatus,
    resultObject.graph_visibility_status
  ), 'completed');
  const semanticStatus = normalizeImportLifecycleStatus(explicitSemanticStatus, semanticFallback);

  return {
    ...base,
    graphVisibilityStatus,
    semanticStatus,
    authoritativeSyncStatus: normalizeImportLifecycleStatus(firstLifecycleValue(
      resultObject.authoritativeSync?.status,
      resultObject.authoritative_sync?.status,
      base.authoritativeSyncStatus
    ), 'not-started'),
    structuralCompletedAt: firstLifecycleValue(
      resultObject.structuralCompletedAt,
      resultObject.structural_completed_at,
      base.structuralCompletedAt
    ) || (graphVisibilityStatus === 'completed' ? finishedAt : null),
    semanticCompletedAt: firstLifecycleValue(
      resultObject.semanticCompletedAt,
      resultObject.semantic_completed_at,
      base.semanticCompletedAt
    ) || (semanticStatus === 'completed' ? finishedAt : null),
    throughputMetrics: resultObject.throughputMetrics || resultObject.throughput_metrics || base.throughputMetrics
  };
}

function createEmptyQueue() {
  return {
    version: IMPORT_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function createEmptyContentIndex() {
  return {
    version: IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    entries: {}
  };
}

function createImportQuarantineBatchId(timestamp = new Date()) {
  return `quarantine-${timestamp.toISOString().replace(/[:.]/g, '-')}`;
}

function getFileKind(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  throw createImportValidationError(`Unsupported import file "${fileName}". Expected .pdf, .md, or .markdown.`);
}

function sanitizeUploadedFileName(fileName, index = 0) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const baseName = path.basename(String(fileName || ''), extension);
  const normalizedBase = slugify(baseName || `upload-${index + 1}`) || `upload-${index + 1}`;
  return `${normalizedBase}${extension || '.md'}`;
}

function createTaskId(inputPaths = [], files = []) {
  return `imp:${stableHash(`${Date.now()}:${process.pid}:${inputPaths.join('|')}:${files.map((file) => file.name).join('|')}:${Math.random()}`, 18)}`;
}

function createImportBatchId(taskIds = [], timestamp = new Date()) {
  return `impbatch:${stableHash(`${timestamp.toISOString()}:${taskIds.join('|')}:${Math.random()}`, 18)}`;
}

function resolvePositiveInteger(value, fallback, minimum = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum) return fallback;
  return Math.floor(numeric);
}

function resolveOptionalPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function resolveImportBatchReserveLimits(options = {}) {
  const maxTasks = resolvePositiveInteger(options.maxTasks ?? options.batchMaxTasks, DEFAULT_IMPORT_BATCH_MAX_TASKS);
  return {
    maxTasks: Math.min(maxTasks, HARD_IMPORT_BATCH_MAX_TASKS),
    maxFiles: resolveOptionalPositiveInteger(options.maxFiles ?? options.batchMaxFiles),
    maxBytes: resolveOptionalPositiveInteger(options.maxBytes ?? options.batchMaxBytes)
  };
}

function normalizeImportReserveTaskIdSet(options = {}) {
  const raw = options.importReserveTaskIds ?? options.reserveTaskIds;
  if (raw === undefined || raw === null) return null;
  const values = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  const ids = values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : new Set();
}

function importTaskAllowedByReserveSet(taskOrJob = {}, reserveTaskIds = null) {
  if (!reserveTaskIds) return true;
  const id = String(taskOrJob?.id || '').trim();
  return Boolean(id && reserveTaskIds.has(id));
}

function getImportTaskFileCount(task = {}) {
  return Array.isArray(task.files) ? task.files.length : 0;
}

function getImportTaskSizeBytes(task = {}) {
  return (Array.isArray(task.files) ? task.files : [])
    .reduce((total, file) => total + Math.max(0, Number(file?.sizeBytes || 0) || 0), 0);
}

function createContentFingerprint(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resolveImportFileContent(file = {}) {
  if (Buffer.isBuffer(file.content)) {
    return file.content;
  }

  if (file.content instanceof Uint8Array) {
    return Buffer.from(file.content);
  }

  return Buffer.from(String(file.contentBase64 || ''), 'base64');
}

function createImportFingerprint(rootPath, files = []) {
  const normalizedFiles = files
    .map((file) => ({
      contentFingerprint: file.contentFingerprint,
      kind: file.kind,
      sizeBytes: file.sizeBytes
    }))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.contentFingerprint}:${left.sizeBytes}`;
      const rightKey = `${right.kind}:${right.contentFingerprint}:${right.sizeBytes}`;
      return leftKey.localeCompare(rightKey);
    });
  return crypto.createHash('sha256').update(JSON.stringify({
    rootPath: path.resolve(rootPath),
    files: normalizedFiles
  })).digest('hex');
}

function createImportFileSignature(file = {}) {
  const kind = String(file?.kind || '').trim().toLowerCase();
  const size = Number(file?.sizeBytes || 0);
  const contentFingerprint = String(file?.contentFingerprint || '').trim();
  return `${kind}:${size}:${contentFingerprint}`;
}

function normalizeStoredPaperMetadata(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  const sourceProvider = String(
    input?.sourceProvider
    || input?.provider
    || input?.paperMetadata?.sourceProvider
    || ''
  ).trim();
  if (!Object.keys(identifiers).length && !sourceProvider) {
    return null;
  }
  return {
    ...(Object.keys(identifiers).length ? { identifiers } : {}),
    ...(sourceProvider ? { sourceProvider } : {})
  };
}

function mergeStoredPaperMetadata(existingMetadata = null, incomingMetadata = null) {
  const merged = mergePaperIdentifiers(existingMetadata || {}, incomingMetadata || {});
  const sourceProvider = String(
    incomingMetadata?.sourceProvider
    || existingMetadata?.sourceProvider
    || ''
  ).trim();
  if (!Object.keys(merged.identifiers).length && !sourceProvider) {
    return null;
  }
  return {
    ...(Object.keys(merged.identifiers).length ? { identifiers: merged.identifiers } : {}),
    ...(sourceProvider ? { sourceProvider } : {})
  };
}

function mergeTaskFileMetadata(existingTask = {}, incomingFiles = []) {
  const queuedBySignature = new Map();
  for (const file of incomingFiles) {
    const signature = createImportFileSignature(file);
    if (!queuedBySignature.has(signature)) {
      queuedBySignature.set(signature, []);
    }
    queuedBySignature.get(signature).push(normalizeStoredPaperMetadata(file.paperMetadata));
  }

  let changed = false;
  const files = (existingTask.files || []).map((file) => {
    const signature = createImportFileSignature(file);
    const queue = queuedBySignature.get(signature) || [];
    const incomingMetadata = queue.length ? queue.shift() : null;
    const currentMetadata = normalizeStoredPaperMetadata(file.paperMetadata);
    const nextMetadata = mergeStoredPaperMetadata(currentMetadata, incomingMetadata);
    if (JSON.stringify(currentMetadata) !== JSON.stringify(nextMetadata)) {
      changed = true;
    }
    return {
      ...file,
      paperMetadata: nextMetadata
    };
  });

  return {
    changed,
    files
  };
}

function normalizeImportFileIdentityName(value = '') {
  return path.basename(String(value || '').trim(), path.extname(String(value || '').trim()))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function createImportTaskContentKey(task = {}) {
  const files = Array.isArray(task.files) ? task.files : [];
  const parts = files
    .map((file) => {
      const fingerprint = String(file?.contentFingerprint || '').trim();
      const kind = String(file?.kind || '').trim().toLowerCase();
      const size = Number(file?.sizeBytes || 0);
      if (!fingerprint || !kind || !Number.isFinite(size) || size <= 0) return '';
      return `${kind}:${size}:${fingerprint}`;
    })
    .filter(Boolean)
    .sort();
  return parts.length === files.length && parts.length ? parts.join('|') : '';
}

function createImportTaskNameKey(task = {}) {
  const files = Array.isArray(task.files) ? task.files : [];
  const parts = files
    .map((file) => normalizeImportFileIdentityName(
      file?.originalName || file?.storedName || file?.storedPath || ''
    ))
    .filter(Boolean)
    .sort();
  return parts.length ? parts.join('|') : '';
}

function getImportFailedRetryCount(task = {}) {
  return Math.max(0, Number(task?.recovery?.retryCount || task?.retryCount || 0) || 0);
}

function resolveFailedImportRetryDelayMs(options = {}) {
  const raw = Number(options.importFailedRetryDelayMs ?? options.failedRetryDelayMs ?? DEFAULT_FAILED_IMPORT_RETRY_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_FAILED_IMPORT_RETRY_DELAY_MS;
  return Math.floor(raw);
}

function resolveFailedImportRetryMax(options = {}) {
  const raw = Number(options.importFailedRetryMax ?? options.failedRetryMax ?? DEFAULT_FAILED_IMPORT_RETRY_MAX);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_FAILED_IMPORT_RETRY_MAX;
  return Math.floor(raw);
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return null;
}

export function createImportQueueLockOptions(options = {}) {
  const baseLockOptions = options.lockOptions && typeof options.lockOptions === 'object' && !Array.isArray(options.lockOptions)
    ? options.lockOptions
    : {};
  const timeoutMs = firstPositiveNumber(
    options.importQueueLockTimeoutMs,
    options.queueLockTimeoutMs,
    options.importsQueueLockTimeoutMs,
    baseLockOptions.timeoutMs,
    DEFAULT_IMPORT_QUEUE_LOCK_TIMEOUT_MS
  );
  const staleMs = Math.max(timeoutMs, firstPositiveNumber(
    options.importQueueLockStaleMs,
    options.queueLockStaleMs,
    options.importsQueueLockStaleMs,
    baseLockOptions.staleMs,
    DEFAULT_IMPORT_QUEUE_LOCK_STALE_MS
  ));
  const heartbeatIntervalMs = firstPositiveNumber(
    options.importQueueLockHeartbeatIntervalMs,
    options.queueLockHeartbeatIntervalMs,
    options.importsQueueLockHeartbeatIntervalMs,
    baseLockOptions.heartbeatIntervalMs,
    DEFAULT_IMPORT_QUEUE_LOCK_HEARTBEAT_INTERVAL_MS
  );
  const pollIntervalMs = firstPositiveNumber(
    options.importQueueLockPollIntervalMs,
    options.queueLockPollIntervalMs,
    options.importsQueueLockPollIntervalMs,
    baseLockOptions.pollIntervalMs
  );
  return {
    ...baseLockOptions,
    timeoutMs,
    staleMs,
    heartbeatIntervalMs,
    ...(pollIntervalMs ? { pollIntervalMs } : {})
  };
}

function withImportQueueLock(queueLockPath, fn, options = {}) {
  return withFileLock(queueLockPath, fn, createImportQueueLockOptions(options));
}

export function getImportPaths(rootPath) {
  const { corpusDir } = getCorpusPaths(rootPath);
  const importsDir = path.join(corpusDir, 'imports');
  return {
    importsDir,
    contentIndexPath: path.join(importsDir, 'content-index.json'),
    quarantineDir: path.join(importsDir, 'quarantine'),
    tasksDir: path.join(importsDir, 'tasks'),
    queuePath: path.join(importsDir, 'queue.json'),
    queueLockPath: path.join(rootPath, '.papernexus-imports.lock'),
    workerLockPath: path.join(rootPath, '.papernexus-import-worker.lock')
  };
}

export function getImportTaskPaths(rootPath, taskId) {
  const { tasksDir } = getImportPaths(rootPath);
  const taskDir = path.join(tasksDir, stableHash(taskId, 20));
  return {
    taskDir,
    taskPath: path.join(taskDir, 'task.json'),
    logPath: path.join(taskDir, 'events.log'),
    sourcesDir: path.join(taskDir, 'sources')
  };
}

export async function loadImportTaskFileMetadata(rootPath, storedPath) {
  const normalizedPath = path.resolve(String(storedPath || '').trim());
  if (!normalizedPath) return null;

  const { tasksDir } = getImportPaths(rootPath);
  const relative = path.relative(tasksDir, normalizedPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..') {
    return null;
  }

  const segments = relative.split(path.sep);
  if (segments.length < 3 || segments[1] !== 'sources') {
    return null;
  }

  const taskPath = path.join(tasksDir, segments[0], 'task.json');
  const task = await readJson(taskPath, null);
  if (!task?.id) {
    return null;
  }

  const file = (task.files || []).find((entry) => path.resolve(String(entry?.storedPath || '')) === normalizedPath) || null;
  if (!file) {
    return null;
  }

  return {
    task,
    file
  };
}

async function findQuarantinedImportTaskDir(rootPath, taskId) {
  const { quarantineDir } = getImportPaths(rootPath);
  if (!await fileExists(quarantineDir)) {
    return null;
  }

  const taskDirPrefix = stableHash(taskId, 20);
  const batches = await fs.readdir(quarantineDir, { withFileTypes: true });
  const batchDirectories = batches
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const batchName of batchDirectories) {
    const batchDir = path.join(quarantineDir, batchName);
    const entries = await fs.readdir(batchDir, { withFileTypes: true });
    const matchedEntry = entries.find((entry) => entry.isDirectory() && (entry.name === taskDirPrefix || entry.name.startsWith(`${taskDirPrefix}-`)));
    if (matchedEntry) {
      return path.join(batchDir, matchedEntry.name);
    }
  }

  return null;
}

export async function loadImportQueue(rootPath) {
  const { queuePath } = getImportPaths(rootPath);
  const queue = (await readJson(queuePath, createEmptyQueue())) || createEmptyQueue();
  return {
    version: queue.version || IMPORT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date(0).toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  };
}

async function saveImportQueue(rootPath, queue) {
  const { queuePath } = getImportPaths(rootPath);
  await writeJson(queuePath, {
    version: IMPORT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date().toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  });
}

async function loadImportContentIndex(rootPath) {
  const { contentIndexPath } = getImportPaths(rootPath);
  const index = (await readJson(contentIndexPath, createEmptyContentIndex())) || createEmptyContentIndex();
  return {
    version: index.version || IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date(0).toISOString(),
    entries: (index.entries && typeof index.entries === 'object' && !Array.isArray(index.entries))
      ? index.entries
      : {}
  };
}

async function saveImportContentIndex(rootPath, index) {
  const { contentIndexPath } = getImportPaths(rootPath);
  await writeJson(contentIndexPath, {
    version: IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date().toISOString(),
    entries: (index.entries && typeof index.entries === 'object' && !Array.isArray(index.entries))
      ? index.entries
      : {}
  });
}

export async function loadImportTask(rootPath, taskId) {
  const activeTask = await readJson(getImportTaskPaths(rootPath, taskId).taskPath, null);
  if (activeTask) return activeTask;
  const quarantinedTaskDir = await findQuarantinedImportTaskDir(rootPath, taskId);
  if (!quarantinedTaskDir) return null;
  return readJson(path.join(quarantinedTaskDir, 'task.json'), null);
}

async function saveImportTask(rootPath, task) {
  const { taskDir, taskPath } = getImportTaskPaths(rootPath, task.id);
  await ensureDir(taskDir);
  await writeJson(taskPath, task);
}

function createQueueJobSnapshot(task = {}) {
  return {
    id: task.id,
    status: task.status,
    stage: task.stage,
    progress: task.progress || null,
    includeInGraph: Boolean(task.includeInGraph),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt || null,
    trigger: task.trigger || 'api',
    fileCount: Array.isArray(task.files) ? task.files.length : 0,
    inputPaths: Array.isArray(task.inputPaths) ? task.inputPaths : []
  };
}

function queueJobMatchesTask(job = {}, task = {}) {
  return JSON.stringify(createQueueJobSnapshot(task)) === JSON.stringify({
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress || null,
    includeInGraph: Boolean(job.includeInGraph),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    trigger: job.trigger || 'api',
    fileCount: Number(job.fileCount || 0),
    inputPaths: Array.isArray(job.inputPaths) ? job.inputPaths : []
  });
}

function updateQueuedJob(queue, task) {
  const index = queue.jobs.findIndex((job) => job.id === task.id);
  const nextJob = createQueueJobSnapshot(task);

  if (index === -1) queue.jobs.push(nextJob);
  else queue.jobs[index] = nextJob;
}

function removeQueuedJob(queue, taskId) {
  queue.jobs = (queue.jobs || []).filter((job) => job.id !== taskId);
}

async function loadImportTasksOnDisk(rootPath) {
  const { tasksDir } = getImportPaths(rootPath);
  if (!await fileExists(tasksDir)) {
    return [];
  }

  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const task = await readJson(path.join(tasksDir, entry.name, 'task.json'), null);
    if (task?.id) {
      tasks.push(task);
    }
  }
  return tasks;
}

function buildReconciledImportQueue(queue, tasks = []) {
  const taskById = new Map(tasks.filter(Boolean).map((task) => [task.id, task]));
  const seen = new Set();
  let changed = false;
  const jobs = [];

  for (const job of queue.jobs || []) {
    const task = taskById.get(job.id);
    if (!task) {
      jobs.push(job);
      continue;
    }
    seen.add(task.id);
    jobs.push(createQueueJobSnapshot(task));
    if (!queueJobMatchesTask(job, task)) {
      changed = true;
    }
  }

  const missingTasks = tasks
    .filter((task) => task?.id && !seen.has(task.id))
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });
  if (missingTasks.length) {
    changed = true;
    for (const task of missingTasks) {
      jobs.push(createQueueJobSnapshot(task));
    }
  }

  return {
    changed,
    queue: {
      version: queue.version || IMPORT_SCHEMA_VERSION,
      updatedAt: changed ? new Date().toISOString() : (queue.updatedAt || new Date(0).toISOString()),
      jobs
    }
  };
}

export async function reconcileImportQueue(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  return withImportQueueLock(queueLockPath, async () => {
    const [queue, tasks] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportTasksOnDisk(rootPath)
    ]);
    const reconciled = buildReconciledImportQueue(queue, tasks);
    if (reconciled.changed) {
      await saveImportQueue(rootPath, reconciled.queue);
    }
    return reconciled.queue;
  }, options);
}

export async function appendImportTaskLog(rootPath, taskId, entry = {}) {
  const { taskDir, logPath } = getImportTaskPaths(rootPath, taskId);
  const timestamp = entry.timestamp || new Date().toISOString();
  const level = String(entry.level || 'info').trim().toLowerCase() || 'info';
  const message = String(entry.message || '').trim() || 'event';
  await ensureDir(taskDir);
  await fs.appendFile(logPath, `[${timestamp}] [${level}] ${message}\n`, 'utf8');
  if (entry.eventLedger !== false) {
    await appendImportTaskEvent(rootPath, taskId, {
      ...entry,
      timestamp,
      level,
      message,
      event: entry.event || 'task.log'
    });
  }
}

export async function loadImportTaskLog(rootPath, taskId) {
  const { logPath } = getImportTaskPaths(rootPath, taskId);
  if (await fileExists(logPath)) {
    return readText(logPath);
  }
  const quarantinedTaskDir = await findQuarantinedImportTaskDir(rootPath, taskId);
  if (!quarantinedTaskDir) return '';
  const quarantinedLogPath = path.join(quarantinedTaskDir, 'events.log');
  return (await fileExists(quarantinedLogPath)) ? readText(quarantinedLogPath) : '';
}

function getImportTaskEventLedgerPath(rootPath, taskId) {
  const { taskDir } = getImportTaskPaths(rootPath, taskId);
  return path.join(taskDir, 'events.ndjson');
}

async function findImportTaskEventLedgerPath(rootPath, taskId) {
  const activePath = getImportTaskEventLedgerPath(rootPath, taskId);
  if (await fileExists(activePath)) {
    return activePath;
  }
  const quarantinedTaskDir = await findQuarantinedImportTaskDir(rootPath, taskId);
  if (!quarantinedTaskDir) return activePath;
  return path.join(quarantinedTaskDir, 'events.ndjson');
}

function jsonSafeImportEventValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { stringValue: String(value) };
  }
}

async function readLastImportTaskEventSeq(eventsPath) {
  if (!await fileExists(eventsPath)) return 0;
  const raw = await readText(eventsPath);
  const lines = raw.trimEnd().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      const seq = Number(parsed?.seq || 0);
      if (Number.isInteger(seq) && seq > 0) return seq;
    } catch {
      // Keep scanning older lines; a partially written line must not hide history.
    }
  }
  return 0;
}

function normalizeImportTaskEvent(task = null, event = {}, seq = 1) {
  const progress = task?.progress && typeof task.progress === 'object' ? task.progress : {};
  const timestamp = event.timestamp || event.time || new Date().toISOString();
  const error = event.error || null;
  return {
    contractVersion: IMPORT_EVENT_CONTRACT_VERSION,
    seq,
    timestamp,
    event: String(event.event || 'task.event').trim() || 'task.event',
    level: String(event.level || 'info').trim().toLowerCase() || 'info',
    taskId: String(event.taskId || task?.id || '').trim(),
    status: event.status || task?.status || progress.status || null,
    stage: event.stage || task?.stage || progress.stage || null,
    currentStep: event.currentStep || progress.currentStep || null,
    message: String(event.message || progress.message || '').trim() || null,
    percent: event.percent === undefined ? (progress.percent ?? null) : clampPercent(event.percent),
    stagePercent: event.stagePercent === undefined ? (progress.stagePercent ?? null) : clampPercent(event.stagePercent),
    processedUnits: event.processedUnits === undefined ? (progress.processedUnits ?? null) : event.processedUnits,
    totalUnits: event.totalUnits === undefined ? (progress.totalUnits ?? null) : event.totalUnits,
    batchId: event.batchId || task?.batchId || progress.batchId || null,
    sourceKey: event.sourceKey || null,
    paperId: event.paperId || null,
    data: jsonSafeImportEventValue(event.data === undefined ? null : event.data),
    error: error
      ? jsonSafeImportEventValue({
          message: String(error?.message || error),
          ...(error?.name ? { name: String(error.name) } : {}),
          ...(error?.code ? { code: String(error.code) } : {})
        })
      : null
  };
}

export async function appendImportTaskEvent(rootPath, taskId, event = {}) {
  const { taskDir } = getImportTaskPaths(rootPath, taskId);
  const eventsPath = getImportTaskEventLedgerPath(rootPath, taskId);
  const task = await loadImportTask(rootPath, taskId);
  const seq = await readLastImportTaskEventSeq(eventsPath) + 1;
  const normalized = normalizeImportTaskEvent(task, { ...event, taskId }, seq);
  await ensureDir(taskDir);
  await fs.appendFile(eventsPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  if (event.dagLedger !== false) {
    await appendImportDagEvent(rootPath, taskId, normalized, { task });
  }
  return normalized;
}

export async function tailImportTaskEvents(rootPath, taskId, options = {}) {
  const eventsPath = await findImportTaskEventLedgerPath(rootPath, taskId);
  const raw = (await fileExists(eventsPath)) ? await readText(eventsPath) : '';
  const lines = raw.trimEnd().split('\n').filter(Boolean);
  const tail = Math.max(0, Number(options.tail || options.limit || 0) || 0);
  const selected = tail > 0 ? lines.slice(-tail) : lines;
  return {
    contractVersion: IMPORT_EVENT_CONTRACT_VERSION,
    taskId,
    eventsPath,
    events: selected.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
  };
}

function getImportTaskDagPath(rootPath, taskId) {
  const { taskDir } = getImportTaskPaths(rootPath, taskId);
  return path.join(taskDir, 'dag.json');
}

function getImportTaskDagEventLedgerPath(rootPath, taskId) {
  const { taskDir } = getImportTaskPaths(rootPath, taskId);
  return path.join(taskDir, 'dag-events.ndjson');
}

async function findImportTaskDagPath(rootPath, taskId) {
  const activePath = getImportTaskDagPath(rootPath, taskId);
  if (await fileExists(activePath)) {
    return activePath;
  }
  const quarantinedTaskDir = await findQuarantinedImportTaskDir(rootPath, taskId);
  if (!quarantinedTaskDir) return activePath;
  return path.join(quarantinedTaskDir, 'dag.json');
}

async function findImportTaskDagEventLedgerPath(rootPath, taskId) {
  const activePath = getImportTaskDagEventLedgerPath(rootPath, taskId);
  if (await fileExists(activePath)) {
    return activePath;
  }
  const quarantinedTaskDir = await findQuarantinedImportTaskDir(rootPath, taskId);
  if (!quarantinedTaskDir) return activePath;
  return path.join(quarantinedTaskDir, 'dag-events.ndjson');
}

function createImportDagTaskContentFingerprint(task = {}) {
  const files = Array.isArray(task.files) ? task.files : [];
  return files
    .map((file) => String(file?.contentSha256 || file?.contentFingerprint || '').trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

function createImportDagIdempotencyParts(task = {}, nodeId = 'task.queued') {
  return {
    nodeId,
    taskId: String(task?.id || '').trim(),
    importFingerprint: String(task?.importFingerprint || '').trim(),
    contentFingerprint: createImportDagTaskContentFingerprint(task),
    processingProfile: normalizeImportProcessingProfile(task?.processingProfile, 'full'),
    completionPolicy: normalizeImportCompletionPolicy(task?.completionPolicy, task?.processingProfile || 'full')
  };
}

function createImportDagIdempotencyKey(task = {}, nodeId = 'task.queued') {
  return `import-dag-node:${stableHash(JSON.stringify(createImportDagIdempotencyParts(task, nodeId)), 24)}`;
}

function getImportDagRetryOwner(nodeId = 'task.queued') {
  return IMPORT_DAG_RETRY_OWNERS.get(nodeId) || 'import-worker';
}

function createImportDagRetryPolicy(nodeId = 'task.queued') {
  const owner = getImportDagRetryOwner(nodeId);
  return {
    owner,
    retryable: !['task.queued', 'task.completed'].includes(nodeId),
    idempotent: true,
    maxAttempts: owner === 'llm-worker-pool' ? null : 3
  };
}

function normalizeImportDagArtifactRef(value = null) {
  if (!value) return null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? { kind: 'path', path: normalized } : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || value.type || '').trim() || 'artifact';
  const pathValue = String(value.path || value.filePath || value.file || '').trim();
  const id = String(value.id || value.key || value.sourceKey || value.paperId || pathValue || '').trim();
  if (!id && !pathValue) return null;
  return {
    kind,
    ...(id ? { id } : {}),
    ...(pathValue ? { path: pathValue } : {}),
    ...(value.role ? { role: String(value.role) } : {}),
    ...(value.contentSha256 ? { contentSha256: String(value.contentSha256) } : {}),
    ...(value.contentFingerprint ? { contentFingerprint: String(value.contentFingerprint) } : {}),
    ...(value.sourceKey ? { sourceKey: String(value.sourceKey) } : {}),
    ...(value.paperId ? { paperId: String(value.paperId) } : {})
  };
}

function normalizeImportDagArtifactRefs(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => normalizeImportDagArtifactRef(value)).filter(Boolean);
}

function mergeImportDagArtifactRefs(...artifactLists) {
  const merged = [];
  const seen = new Set();
  for (const artifact of artifactLists.flatMap((list) => normalizeImportDagArtifactRefs(list))) {
    const key = JSON.stringify(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

function createStoredSourceArtifactRefs(task = {}) {
  return (Array.isArray(task.files) ? task.files : [])
    .map((file) => normalizeImportDagArtifactRef({
      kind: 'stored-source',
      id: file?.storedName || file?.originalName || file?.storedPath,
      path: file?.storedPath,
      contentSha256: file?.contentSha256,
      contentFingerprint: file?.contentFingerprint
    }))
    .filter(Boolean);
}

function createImportDagNodeArtifactRefs(task = {}, nodeId = 'task.queued') {
  const taskArtifacts = [
    normalizeImportDagArtifactRef({
      kind: 'import-task',
      id: task?.id || '',
      path: task?.id ? 'task.json' : ''
    })
  ].filter(Boolean);
  const storedSources = createStoredSourceArtifactRefs(task);
  const sourceDirArtifact = task?.sourcesDir
    ? [normalizeImportDagArtifactRef({ kind: 'sources-dir', path: task.sourcesDir })].filter(Boolean)
    : [];

  switch (nodeId) {
    case 'task.queued':
      return {
        inputArtifacts: storedSources,
        outputArtifacts: taskArtifacts
      };
    case 'source.materialize':
      return {
        inputArtifacts: storedSources,
        outputArtifacts: sourceDirArtifact
      };
    case 'chunk.normalize':
    case 'paper.structural_snapshot':
      return {
        inputArtifacts: sourceDirArtifact,
        outputArtifacts: []
      };
    case 'paper.long_context_llm':
    case 'chunk.semantic_llm':
    case 'chunk.relation_llm':
      return {
        inputArtifacts: sourceDirArtifact,
        outputArtifacts: []
      };
    case 'task.completed':
      return {
        inputArtifacts: taskArtifacts,
        outputArtifacts: taskArtifacts
      };
    default:
      return {
        inputArtifacts: taskArtifacts,
        outputArtifacts: []
      };
  }
}

function createImportDagNode(definition, now = new Date().toISOString(), task = {}) {
  const artifactRefs = createImportDagNodeArtifactRefs(task, definition.id);
  const retryPolicy = createImportDagRetryPolicy(definition.id);
  return {
    id: definition.id,
    dependsOn: [...definition.dependsOn],
    idempotencyKey: createImportDagIdempotencyKey(task, definition.id),
    idempotencyParts: createImportDagIdempotencyParts(task, definition.id),
    retryOwner: retryPolicy.owner,
    retryPolicy,
    status: 'not-started',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastEventAt: null,
    progress: null,
    error: null,
    inputArtifacts: artifactRefs.inputArtifacts,
    outputArtifacts: artifactRefs.outputArtifacts,
    artifacts: mergeImportDagArtifactRefs(artifactRefs.inputArtifacts, artifactRefs.outputArtifacts)
  };
}

function normalizeImportDagNodeId(value, fallback = 'task.queued') {
  const raw = String(value || '').trim().toLowerCase();
  if (IMPORT_DAG_NODE_IDS.has(raw)) return raw;
  const normalized = normalizeDashedToken(raw);
  if (IMPORT_DAG_NODE_IDS.has(normalized)) return normalized;
  if (IMPORT_DAG_NODE_ALIASES.has(raw)) return IMPORT_DAG_NODE_ALIASES.get(raw);
  if (IMPORT_DAG_NODE_ALIASES.has(normalized)) return IMPORT_DAG_NODE_ALIASES.get(normalized);
  const normalizedFallback = normalizeDashedToken(fallback);
  if (IMPORT_DAG_NODE_IDS.has(fallback)) return fallback;
  if (IMPORT_DAG_NODE_IDS.has(normalizedFallback)) return normalizedFallback;
  if (IMPORT_DAG_NODE_ALIASES.has(normalizedFallback)) return IMPORT_DAG_NODE_ALIASES.get(normalizedFallback);
  return 'task.queued';
}

function normalizeImportDagStatus(value, fallback = 'pending') {
  const normalized = normalizeImportLifecycleStatus(value, fallback);
  return normalized === 'queued' ? 'pending' : normalized;
}

function normalizeImportTaskDag(task = {}, dag = null) {
  const now = new Date().toISOString();
  const existing = objectOrNull(dag) || {};
  const existingNodes = objectOrNull(existing.nodes) || {};
  const importExecutionMode = normalizeImportExecutionMode(task?.importExecutionMode || task?.import_execution_mode || existing.importExecutionMode || existing.executionMode, 'serial');
  const nodes = {};
  for (const definition of IMPORT_DAG_NODE_DEFINITIONS) {
    const existingNode = objectOrNull(existingNodes[definition.id]) || {};
    const baseNode = createImportDagNode(definition, existingNode.createdAt || existing.createdAt || task?.createdAt || now, task);
    nodes[definition.id] = {
      ...baseNode,
      ...existingNode,
      id: definition.id,
      dependsOn: [...definition.dependsOn],
      idempotencyKey: existingNode.idempotencyKey || baseNode.idempotencyKey,
      idempotencyParts: {
        ...baseNode.idempotencyParts,
        ...(objectOrNull(existingNode.idempotencyParts) || {})
      },
      retryOwner: existingNode.retryOwner || baseNode.retryOwner,
      retryPolicy: {
        ...baseNode.retryPolicy,
        ...(objectOrNull(existingNode.retryPolicy) || {})
      },
      status: normalizeImportDagStatus(existingNode.status || 'not-started', 'not-started'),
      inputArtifacts: mergeImportDagArtifactRefs(baseNode.inputArtifacts, existingNode.inputArtifacts),
      outputArtifacts: mergeImportDagArtifactRefs(baseNode.outputArtifacts, existingNode.outputArtifacts),
      artifacts: mergeImportDagArtifactRefs(baseNode.artifacts, existingNode.artifacts, existingNode.inputArtifacts, existingNode.outputArtifacts)
    };
  }

  return {
    contractVersion: IMPORT_DAG_CONTRACT_VERSION,
    taskId: String(existing.taskId || task?.id || '').trim(),
    status: normalizeImportDagStatus(existing.status || task?.status || 'pending', 'pending'),
    executionMode: importExecutionMode === 'dag' ? 'dag' : 'serial-sidecar',
    importExecutionMode,
    createdAt: existing.createdAt || task?.createdAt || now,
    updatedAt: existing.updatedAt || task?.updatedAt || now,
    processingProfile: task?.processingProfile || existing.processingProfile || null,
    completionPolicy: task?.completionPolicy || existing.completionPolicy || null,
    nodeOrder: IMPORT_DAG_NODE_DEFINITIONS.map((definition) => definition.id),
    nodes
  };
}

function inferImportDagNodeId(task = null, event = {}) {
  const eventName = String(event.event || '').trim().toLowerCase();
  if (eventName === 'task.completed') return 'task.completed';
  if (eventName.startsWith('task.authoritative_sync.')) {
    const syncStatus = normalizeImportLifecycleStatus(
      event.data?.authoritativeSyncStatus || event.data?.authoritative_sync_status || event.status,
      'pending'
    );
    return ['pending', 'queued', 'running'].includes(syncStatus)
      ? 'authoritative_sync.enqueue'
      : 'authoritative_sync.apply';
  }
  if (eventName.startsWith('task.semantic.')) return 'paper.long_context_llm';

  return normalizeImportDagNodeId(
    event.nodeId
      || event.node
      || event.stage
      || task?.stage
      || task?.progress?.stage,
    eventName === 'task.failed' ? 'source.materialize' : 'task.queued'
  );
}

function inferImportDagStatus(task = null, event = {}, nodeId = 'task.queued') {
  const eventName = String(event.event || '').trim().toLowerCase();
  if (eventName === 'task.completed') return 'completed';
  if (eventName === 'task.failed') return 'failed';
  if (eventName === 'task.created') return 'pending';
  if (eventName === 'task.stage') return 'running';
  if (eventName.startsWith('task.semantic.')) {
    return normalizeImportDagStatus(eventName.split('.').pop(), event.status || 'pending');
  }
  if (eventName.startsWith('task.authoritative_sync.')) {
    const syncStatus = normalizeImportLifecycleStatus(
      event.data?.authoritativeSyncStatus || event.data?.authoritative_sync_status || eventName.split('.').pop(),
      'pending'
    );
    return nodeId === 'authoritative_sync.enqueue' ? 'completed' : normalizeImportDagStatus(syncStatus, 'pending');
  }
  return normalizeImportDagStatus(event.status || task?.status || task?.progress?.status || 'pending', 'pending');
}

function normalizeImportDagEvent(task = null, event = {}, seq = 1) {
  const timestamp = event.timestamp || event.time || new Date().toISOString();
  const nodeId = inferImportDagNodeId(task, event);
  const status = inferImportDagStatus(task, event, nodeId);
  const progress = task?.progress && typeof task.progress === 'object' ? task.progress : {};
  const error = event.error || null;
  const eventData = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const eventArtifactRefs = event.artifactRefs && typeof event.artifactRefs === 'object' && !Array.isArray(event.artifactRefs)
    ? event.artifactRefs
    : {};
  const inputArtifacts = mergeImportDagArtifactRefs(
    event.inputArtifacts,
    eventArtifactRefs.inputArtifacts,
    eventArtifactRefs.inputs,
    eventData.inputArtifacts,
    eventData.artifactRefs?.inputArtifacts,
    eventData.artifactRefs?.inputs
  );
  const outputArtifacts = mergeImportDagArtifactRefs(
    event.outputArtifacts,
    eventArtifactRefs.outputArtifacts,
    eventArtifactRefs.outputs,
    eventData.outputArtifacts,
    eventData.artifactRefs?.outputArtifacts,
    eventData.artifactRefs?.outputs
  );
  return {
    contractVersion: IMPORT_DAG_EVENT_CONTRACT_VERSION,
    seq,
    timestamp,
    event: String(event.event || 'task.event').trim() || 'task.event',
    level: String(event.level || 'info').trim().toLowerCase() || 'info',
    taskId: String(event.taskId || task?.id || '').trim(),
    nodeId,
    status,
    stage: event.stage || task?.stage || progress.stage || null,
    currentStep: event.currentStep || progress.currentStep || null,
    message: String(event.message || progress.message || '').trim() || null,
    percent: event.percent === undefined ? (progress.percent ?? null) : clampPercent(event.percent),
    stagePercent: event.stagePercent === undefined ? (progress.stagePercent ?? null) : clampPercent(event.stagePercent),
    processedUnits: event.processedUnits === undefined ? (progress.processedUnits ?? null) : event.processedUnits,
    totalUnits: event.totalUnits === undefined ? (progress.totalUnits ?? null) : event.totalUnits,
    batchId: event.batchId || task?.batchId || progress.batchId || null,
    sourceKey: event.sourceKey || null,
    paperId: event.paperId || null,
    idempotencyKey: event.idempotencyKey || null,
    inputArtifacts,
    outputArtifacts,
    artifactRefs: {
      inputArtifacts,
      outputArtifacts
    },
    data: jsonSafeImportEventValue(event.data === undefined ? null : event.data),
    error: error
      ? jsonSafeImportEventValue({
          message: String(error?.message || error),
          ...(error?.name ? { name: String(error.name) } : {}),
          ...(error?.code ? { code: String(error.code) } : {})
        })
      : null
  };
}

function shouldKeepImportDagNodeStatus(previousStatus, nextStatus) {
  return previousStatus === 'completed' && ['not-started', 'pending', 'running'].includes(nextStatus);
}

function setImportDagNodeStatus(dag, nodeId, status, timestamp, event = {}) {
  const node = dag.nodes?.[nodeId];
  if (!node) return;
  const nextStatus = normalizeImportDagStatus(status, node.status || 'pending');
  const previousStatus = normalizeImportDagStatus(node.status || 'not-started', 'not-started');
  if (!shouldKeepImportDagNodeStatus(previousStatus, nextStatus)) {
    node.status = nextStatus;
  }
  node.updatedAt = timestamp;
  node.lastEventAt = timestamp;
  if (nextStatus === 'running') {
    if (previousStatus !== 'running') {
      node.attempts = Math.max(1, Number(node.attempts || 0) + 1);
    } else {
      node.attempts = Math.max(1, Number(node.attempts || 0));
    }
    node.startedAt = node.startedAt || timestamp;
  }
  if (nextStatus === 'pending') {
    node.attempts = Math.max(0, Number(node.attempts || 0));
  }
  if (nextStatus === 'completed') {
    node.startedAt = node.startedAt || timestamp;
    node.completedAt = node.completedAt || timestamp;
    node.error = null;
    node.attempts = Math.max(1, Number(node.attempts || 0));
  }
  if (nextStatus === 'failed') {
    node.startedAt = node.startedAt || timestamp;
    node.failedAt = timestamp;
    node.error = event.error || { message: event.message || 'Import DAG node failed' };
    node.attempts = Math.max(1, Number(node.attempts || 0));
  }
  if (nextStatus === 'skipped' || nextStatus === 'not-required') {
    node.completedAt = node.completedAt || timestamp;
  }
  if (event.idempotencyKey && !node.idempotencyKey) {
    node.idempotencyKey = String(event.idempotencyKey);
  }
  node.inputArtifacts = mergeImportDagArtifactRefs(node.inputArtifacts, event.inputArtifacts, event.artifactRefs?.inputArtifacts, event.artifactRefs?.inputs);
  node.outputArtifacts = mergeImportDagArtifactRefs(node.outputArtifacts, event.outputArtifacts, event.artifactRefs?.outputArtifacts, event.artifactRefs?.outputs);
  node.artifacts = mergeImportDagArtifactRefs(node.artifacts, node.inputArtifacts, node.outputArtifacts);
  const progressFields = {
    percent: event.percent,
    stagePercent: event.stagePercent,
    processedUnits: event.processedUnits,
    totalUnits: event.totalUnits,
    currentStep: event.currentStep || null,
    message: event.message || null
  };
  if (Object.values(progressFields).some((value) => value !== undefined && value !== null && value !== '')) {
    node.progress = progressFields;
  }
}

function completeImportDagDependencies(dag, nodeId, timestamp, seen = new Set()) {
  if (seen.has(nodeId)) return;
  seen.add(nodeId);
  const node = dag.nodes?.[nodeId];
  if (!node) return;
  for (const dependencyId of node.dependsOn || []) {
    completeImportDagDependencies(dag, dependencyId, timestamp, seen);
    const dependency = dag.nodes?.[dependencyId];
    if (!dependency) continue;
    const dependencyStatus = normalizeImportDagStatus(dependency.status || 'not-started', 'not-started');
    if (['not-started', 'pending', 'running'].includes(dependencyStatus)) {
      setImportDagNodeStatus(dag, dependencyId, 'completed', timestamp, {
        event: 'dag.dependency.completed',
        message: `Dependency completed before ${nodeId}`
      });
    }
  }
}

function setGraphVisibleImportDagCompleted(dag, timestamp) {
  for (const nodeId of [
    'task.queued',
    'source.materialize',
    'chunk.normalize',
    'paper.structural_snapshot',
    'paper.delta_build',
    'corpus.merge',
    'lite_state.update',
    'task.completed'
  ]) {
    completeImportDagDependencies(dag, nodeId, timestamp);
    setImportDagNodeStatus(dag, nodeId, 'completed', timestamp, {
      event: 'task.completed',
      message: 'Graph-visible import path completed'
    });
  }
}

function applyImportDagLifecycleProjection(dag, task = {}, timestamp) {
  const semanticStatus = normalizeImportLifecycleStatus(task.semanticStatus || task.result?.semanticStatus, 'pending');
  if (semanticStatus === 'not-required') {
    for (const nodeId of ['paper.long_context_llm', 'chunk.semantic_llm', 'chunk.relation_llm']) {
      setImportDagNodeStatus(dag, nodeId, 'not-required', timestamp, {
        event: 'task.semantic.not_required',
        message: 'Semantic enrichment is not required for this import profile'
      });
    }
  } else if (semanticStatus && semanticStatus !== 'pending') {
    setImportDagNodeStatus(dag, 'paper.long_context_llm', semanticStatus, timestamp, {
      event: `task.semantic.${semanticStatus}`,
      message: `Semantic enrichment ${semanticStatus}`
    });
  }

  const authoritativeSyncStatus = normalizeImportLifecycleStatus(
    task.authoritativeSyncStatus || task.result?.authoritativeSyncStatus || task.result?.authoritativeSync?.status,
    'not-started'
  );
  if (authoritativeSyncStatus !== 'not-started') {
    setImportDagNodeStatus(dag, 'authoritative_sync.enqueue', 'completed', timestamp, {
      event: 'task.authoritative_sync.enqueued',
      message: 'Authoritative sync job enqueued'
    });
    setImportDagNodeStatus(dag, 'authoritative_sync.apply', authoritativeSyncStatus, timestamp, {
      event: `task.authoritative_sync.${authoritativeSyncStatus}`,
      message: `Authoritative sync ${authoritativeSyncStatus}`
    });
  }
}

function applyImportDagEvent(dag, task = {}, event = {}) {
  const timestamp = event.timestamp || new Date().toISOString();
  const eventImportExecutionMode = event.data?.importExecutionMode
    || event.data?.import_execution_mode
    || event.importExecutionMode
    || event.import_execution_mode
    || task?.importExecutionMode
    || task?.import_execution_mode
    || dag.importExecutionMode;
  const importExecutionMode = normalizeImportExecutionMode(eventImportExecutionMode, dag.importExecutionMode || 'serial');
  dag.importExecutionMode = importExecutionMode;
  if (!dag.executionMode || dag.executionMode === 'serial-sidecar' || dag.executionMode === 'dag') {
    dag.executionMode = importExecutionMode === 'dag' ? 'dag' : 'serial-sidecar';
  }
  const nodeId = normalizeImportDagNodeId(event.nodeId, 'task.queued');
  if (['running', 'completed'].includes(event.status) || nodeId === 'task.completed') {
    completeImportDagDependencies(dag, nodeId, timestamp);
  }
  if (event.event === 'task.completed') {
    setGraphVisibleImportDagCompleted(dag, timestamp);
  }
  setImportDagNodeStatus(dag, nodeId, event.status, timestamp, event);
  if (event.event === 'task.completed' || String(event.event || '').startsWith('task.semantic.') || String(event.event || '').startsWith('task.authoritative_sync.')) {
    applyImportDagLifecycleProjection(dag, task, timestamp);
  }
  dag.status = event.event === 'task.failed' || event.status === 'failed'
    ? 'failed'
    : event.event === 'task.completed'
      ? 'completed'
      : normalizeImportDagStatus(task?.status || dag.status || event.status || 'pending', 'pending');
  dag.updatedAt = timestamp;
  dag.processingProfile = task?.processingProfile || dag.processingProfile || null;
  dag.completionPolicy = task?.completionPolicy || dag.completionPolicy || null;
}

export async function loadImportTaskDag(rootPath, taskId) {
  const dagPath = await findImportTaskDagPath(rootPath, taskId);
  const [task, dag] = await Promise.all([
    loadImportTask(rootPath, taskId),
    readJson(dagPath, null)
  ]);
  return normalizeImportTaskDag(task || { id: taskId }, dag);
}

export async function appendImportDagEvent(rootPath, taskId, event = {}, options = {}) {
  const task = options.task || await loadImportTask(rootPath, taskId);
  const { taskDir } = getImportTaskPaths(rootPath, taskId);
  const dagPath = getImportTaskDagPath(rootPath, taskId);
  const eventsPath = getImportTaskDagEventLedgerPath(rootPath, taskId);
  const existingDag = await readJson(dagPath, null);
  const dag = normalizeImportTaskDag(task || { id: taskId }, existingDag);
  const seq = await readLastImportTaskEventSeq(eventsPath) + 1;
  const normalized = normalizeImportDagEvent(task, { ...event, taskId }, seq);
  applyImportDagEvent(dag, task || { id: taskId }, normalized);
  await ensureDir(taskDir);
  await writeJson(dagPath, dag);
  await fs.appendFile(eventsPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return normalized;
}

export async function tailImportTaskDagEvents(rootPath, taskId, options = {}) {
  const eventsPath = await findImportTaskDagEventLedgerPath(rootPath, taskId);
  const raw = (await fileExists(eventsPath)) ? await readText(eventsPath) : '';
  const lines = raw.trimEnd().split('\n').filter(Boolean);
  const tail = Math.max(0, Number(options.tail || options.limit || 0) || 0);
  const selected = tail > 0 ? lines.slice(-tail) : lines;
  return {
    contractVersion: IMPORT_DAG_EVENT_CONTRACT_VERSION,
    taskId,
    eventsPath,
    events: selected.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
  };
}

async function clearImportFingerprintEntry(rootPath, importFingerprint, taskId = null, options = {}) {
  if (!importFingerprint) return false;
  const { queueLockPath } = getImportPaths(rootPath);
  return withImportQueueLock(queueLockPath, async () => {
    const index = await loadImportContentIndex(rootPath);
    const entry = index.entries?.[importFingerprint];
    if (!entry) return false;
    if (taskId && entry.taskId && entry.taskId !== taskId) return false;
    delete index.entries[importFingerprint];
    index.updatedAt = new Date().toISOString();
    await saveImportContentIndex(rootPath, index);
    return true;
  }, options);
}

async function importTaskStoredFilesExist(task = {}) {
  const files = Array.isArray(task.files) ? task.files : [];
  if (!files.length) return false;
  for (const file of files) {
    const storedPath = String(file?.storedPath || '').trim();
    if (!storedPath || !await fileExists(storedPath)) {
      return false;
    }
  }
  return true;
}

function indexCompletedEquivalentTasks(tasks = []) {
  const byContentKey = new Map();
  const byNameKey = new Map();
  for (const task of tasks) {
    if (String(task?.status || '').trim().toLowerCase() !== 'completed') continue;
    const contentKey = createImportTaskContentKey(task);
    const nameKey = createImportTaskNameKey(task);
    if (contentKey) {
      if (!byContentKey.has(contentKey)) byContentKey.set(contentKey, []);
      byContentKey.get(contentKey).push(task);
    }
    if (nameKey) {
      if (!byNameKey.has(nameKey)) byNameKey.set(nameKey, []);
      byNameKey.get(nameKey).push(task);
    }
  }
  return {
    byContentKey,
    byNameKey
  };
}

function findCompletedEquivalentImportTasks(task = {}, completedIndex = {}) {
  const contentKey = createImportTaskContentKey(task);
  if (contentKey) {
    return completedIndex.byContentKey?.get(contentKey) || [];
  }

  const nameKey = createImportTaskNameKey(task);
  if (nameKey && completedIndex.byNameKey?.has(nameKey)) {
    return completedIndex.byNameKey.get(nameKey);
  }

  return [];
}

export async function recoverFailedImportTasks(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  return withImportQueueLock(queueLockPath, async () => {
    const [queue, contentIndex, tasks] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportContentIndex(rootPath),
      loadImportTasksOnDisk(rootPath)
    ]);
    const activeQueue = buildReconciledImportQueue(queue, tasks).queue;
    const completedIndex = indexCompletedEquivalentTasks(tasks);
    const retryDelayMs = resolveFailedImportRetryDelayMs(options);
    const retryMax = resolveFailedImportRetryMax(options);
    const now = new Date();
    const nowIso = now.toISOString();
    const recovered = [];
    const superseded = [];
    const skipped = [];

    for (const task of tasks) {
      if (String(task?.status || '').trim().toLowerCase() !== 'failed') continue;

      const equivalents = findCompletedEquivalentImportTasks(task, completedIndex)
        .filter((entry) => entry.id !== task.id);
      if (equivalents.length) {
        const nextTask = {
          ...task,
          status: 'completed',
          stage: 'completed',
          includeInGraph: true,
          finishedAt: task.finishedAt || nowIso,
          error: null,
          result: {
            ...(task.result || {}),
            recovered: {
              status: 'superseded',
              reason: 'equivalent-completed-import',
              recoveredAt: nowIso,
              supersededByTaskIds: equivalents.map((entry) => entry.id)
            }
          },
          recovery: {
            ...(task.recovery || {}),
            status: 'superseded',
            recoveredAt: nowIso,
            supersededByTaskIds: equivalents.map((entry) => entry.id),
            previousError: task.error || null
          }
        };
        nextTask.progress = createImportProgress(nextTask, {
          stage: 'completed',
          status: 'completed',
          stagePercent: 100,
          processedUnits: task.progress?.processedUnits,
          totalUnits: task.progress?.totalUnits,
          currentStep: 'superseded by completed retry',
          message: `Recovered historical failed import as completed; equivalent completed task ${equivalents[0].id}.`
        });
        nextTask.updatedAt = nowIso;
        await saveImportTask(rootPath, nextTask);
        updateQueuedJob(activeQueue, nextTask);
        superseded.push({
          taskId: task.id,
          supersededByTaskIds: equivalents.map((entry) => entry.id)
        });
        await appendImportTaskLog(rootPath, task.id, {
          level: 'info',
          timestamp: nowIso,
          message: `recovered failed import as completed; superseded by ${equivalents.map((entry) => entry.id).join(', ')}`
        });
        continue;
      }

      const retryCount = getImportFailedRetryCount(task);
      if (retryCount >= retryMax) {
        skipped.push({
          taskId: task.id,
          reason: 'retry-limit'
        });
        continue;
      }

      if (!await importTaskStoredFilesExist(task)) {
        skipped.push({
          taskId: task.id,
          reason: 'missing-uploaded-files'
        });
        continue;
      }

      const lastFailureMs = Date.parse(task.finishedAt || task.updatedAt || task.createdAt || 0) || 0;
      if (lastFailureMs && now.getTime() - lastFailureMs < retryDelayMs) {
        skipped.push({
          taskId: task.id,
          reason: 'retry-delay'
        });
        continue;
      }

      const nextTask = {
        ...task,
        status: 'pending',
        stage: 'queued',
        includeInGraph: false,
        startedAt: null,
        finishedAt: null,
        error: null,
        recovery: {
          ...(task.recovery || {}),
          status: 'queued-retry',
          retryCount: retryCount + 1,
          recoveredAt: nowIso,
          previousError: task.error || null
        }
      };
      nextTask.progress = createImportProgress(nextTask, {
        stage: 'queued',
        status: 'pending',
        stagePercent: 0,
        processedUnits: 0,
        totalUnits: 0,
        currentStep: 'queued for retry',
        message: `Recovered failed import for retry ${retryCount + 1}/${retryMax}.`
      });
      nextTask.updatedAt = nowIso;
      await saveImportTask(rootPath, nextTask);
      updateQueuedJob(activeQueue, nextTask);
      if (nextTask.importFingerprint) {
        contentIndex.entries[nextTask.importFingerprint] = {
          taskId: nextTask.id,
          updatedAt: nowIso
        };
        contentIndex.updatedAt = nowIso;
      }
      recovered.push({
        taskId: nextTask.id,
        retryCount: retryCount + 1
      });
      await appendImportTaskLog(rootPath, nextTask.id, {
        level: 'info',
        timestamp: nowIso,
        message: `recovered failed import for retry ${retryCount + 1}/${retryMax}`
      });
    }

    if (recovered.length || superseded.length) {
      activeQueue.updatedAt = nowIso;
      await Promise.all([
        saveImportQueue(rootPath, activeQueue),
        saveImportContentIndex(rootPath, contentIndex)
      ]);
    }

    return {
      recovered,
      superseded,
      skipped
    };
  }, options);
}

export async function createImportTask(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  const inputPaths = Array.isArray(options.inputPaths)
    ? options.inputPaths.map((item) => path.resolve(String(item))).filter(Boolean)
    : [];
  const files = Array.isArray(options.files)
    ? options.files.filter((file) => !isMetadataFileName(path.basename(String(file?.name || ''))))
    : [];

  if (!files.length) {
    throw new Error('At least one non-metadata uploaded file is required to create an import task.');
  }

  const normalizedFiles = files.map((file, index) => {
    const originalName = path.basename(String(file.name || '').trim() || `upload-${index + 1}.md`);
    const kind = getFileKind(originalName);
    const content = resolveImportFileContent(file);
    return {
      originalName,
      kind,
      content,
      sizeBytes: content.length,
      mimeType: String(file.mimeType || '').trim() || (kind === 'pdf' ? 'application/pdf' : 'text/markdown'),
      contentFingerprint: createContentFingerprint(content),
      contentSha256: `sha256:${createContentFingerprint(content)}`,
      paperMetadata: normalizeStoredPaperMetadata(file.paperMetadata || file)
    };
  });
  const importFingerprint = createImportFingerprint(rootPath, normalizedFiles);

  return withImportQueueLock(queueLockPath, async () => {
    const [queue, contentIndex] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportContentIndex(rootPath)
    ]);
    const indexedTaskId = contentIndex.entries?.[importFingerprint]?.taskId || null;
    if (indexedTaskId) {
      const existingTask = await loadImportTask(rootPath, indexedTaskId);
      if (existingTask && ['pending', 'running', 'completed'].includes(existingTask.status)) {
        const mergedMetadata = mergeTaskFileMetadata(existingTask, normalizedFiles);
        if (mergedMetadata.changed) {
          const nextTask = {
            ...decorateImportTaskLifecycle(existingTask),
            files: mergedMetadata.files,
            updatedAt: new Date().toISOString()
          };
          await saveImportTask(rootPath, nextTask);
          updateQueuedJob(queue, nextTask);
          queue.updatedAt = nextTask.updatedAt;
          await saveImportQueue(rootPath, queue);
          return {
            ...nextTask,
            deduped: true,
            metadataUpdated: true
          };
        }
        return {
          ...decorateImportTaskLifecycle(existingTask),
          deduped: true
        };
      }

      delete contentIndex.entries[importFingerprint];
      contentIndex.updatedAt = new Date().toISOString();
      await saveImportContentIndex(rootPath, contentIndex);
    }

    const taskId = createTaskId(inputPaths, normalizedFiles.map((file) => ({ name: file.originalName })));
    const now = new Date().toISOString();
    const { sourcesDir } = getImportTaskPaths(rootPath, taskId);
    await ensureDir(sourcesDir);

    const storedFiles = [];
    const usedNames = new Set();

    for (let index = 0; index < normalizedFiles.length; index += 1) {
      const file = normalizedFiles[index];
      const { originalName, kind } = file;
      let storedName = sanitizeUploadedFileName(originalName, index);
      let suffix = 2;
      while (usedNames.has(storedName)) {
        const extension = path.extname(storedName);
        const base = path.basename(storedName, extension);
        storedName = `${base}-${suffix}${extension}`;
        suffix += 1;
      }
      usedNames.add(storedName);

      const storedPath = path.join(sourcesDir, storedName);
      await fs.writeFile(storedPath, file.content);
      storedFiles.push({
        originalName,
        storedName,
        storedPath,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        kind,
        contentFingerprint: file.contentFingerprint,
        contentSha256: file.contentSha256,
        paperMetadata: file.paperMetadata
      });
    }

    const task = {
      id: taskId,
      importFingerprint,
      status: 'pending',
      stage: 'queued',
      includeInGraph: false,
      trigger: String(options.trigger || 'api'),
      ...createImportLifecycleFields(options),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      inputPaths,
      sourcesDir,
      files: storedFiles,
      result: null,
      error: null
    };
    task.progress = createImportProgress(task, {
      stage: 'queued',
      status: 'pending',
      stagePercent: 0,
      processedUnits: 0,
      totalUnits: 0,
      message: 'Queued for processing'
    });

    await saveImportTask(rootPath, task);
    updateQueuedJob(queue, task);
    queue.updatedAt = now;
    contentIndex.entries[importFingerprint] = {
      taskId,
      updatedAt: now
    };
    contentIndex.updatedAt = now;
    await Promise.all([
      saveImportQueue(rootPath, queue),
      saveImportContentIndex(rootPath, contentIndex)
    ]);
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message: `created import task with ${storedFiles.length} file(s)`
    });

    return {
      ...task,
      deduped: false
    };
  }, options);
}

export async function listImportTasks(rootPath, options = {}) {
  const queue = await reconcileImportQueue(rootPath, options);
  const tasks = await Promise.all(queue.jobs.map((job) => loadImportTask(rootPath, job.id)));
  const rawQueueOrderedTasks = buildQueueOrderedTasks(queue, tasks);
  const queueOrderedTasks = rawQueueOrderedTasks.map((task) => decorateTaskWithQueueProgress(task, rawQueueOrderedTasks));
  const summary = summarizeImportTasks(queueOrderedTasks);
  return {
    updatedAt: queue.updatedAt,
    summary,
    tasks: queueOrderedTasks.sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return rightTime - leftTime;
    })
  };
}

export async function listActiveImportSourceDirs(rootPath, options = {}) {
  const { tasks } = await listImportTasks(rootPath, options);
  return tasks
    .filter((task) => task.includeInGraph && task.status === 'running')
    .map((task) => task.sourcesDir);
}

async function updateTaskWithQueue(rootPath, taskId, mutate, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  return withImportQueueLock(queueLockPath, async () => {
    const [queue, existingTask] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportTask(rootPath, taskId)
    ]);

    if (!existingTask) {
      return null;
    }

    const nextTask = {
      ...existingTask
    };
    await mutate(nextTask, queue);
    nextTask.updatedAt = new Date().toISOString();
    await saveImportTask(rootPath, nextTask);
    updateQueuedJob(queue, nextTask);
    queue.updatedAt = nextTask.updatedAt;
    await saveImportQueue(rootPath, queue);
    return nextTask;
  }, options);
}

export async function reserveNextImportTask(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  const reserveTaskIds = normalizeImportReserveTaskIdSet(options);
  return withImportQueueLock(queueLockPath, async () => {
    const [queue, tasks] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportTasksOnDisk(rootPath)
    ]);
    const reconciled = buildReconciledImportQueue(queue, tasks);
    const activeQueue = reconciled.queue;
    if (reconciled.changed) {
      await saveImportQueue(rootPath, activeQueue);
    }
    const jobs = [...activeQueue.jobs].sort((left, right) => {
      const leftRunning = left.status === 'running' ? 0 : 1;
      const rightRunning = right.status === 'running' ? 0 : 1;
      if (leftRunning !== rightRunning) return leftRunning - rightRunning;
      const leftTime = Date.parse(left.updatedAt || left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });
    const candidate = jobs.find((job) => (
      (job.status === 'pending' || job.status === 'running')
      && importTaskAllowedByReserveSet(job, reserveTaskIds)
    ));
    if (!candidate) return null;

    const task = await loadImportTask(rootPath, candidate.id);
    if (!task || !importTaskAllowedByReserveSet(task, reserveTaskIds)) return null;

    const now = new Date().toISOString();
    task.status = 'running';
    task.stage = task.stage && task.stage !== 'queued' ? task.stage : 'materialize';
    task.includeInGraph = true;
    task.startedAt = task.startedAt || now;
    task.updatedAt = now;
    task.progress = createImportProgress(task, {
      stage: task.stage,
      status: 'running',
      stagePercent: task.stage === 'materialize' ? 0 : task.progress?.stagePercent,
      processedUnits: 0,
      totalUnits: 0,
      stageStartedAt: task.progress?.stage === task.stage ? task.progress?.stageStartedAt : now,
      message: `Running ${task.stage}`
    });
    await saveImportTask(rootPath, task);
    updateQueuedJob(activeQueue, task);
    activeQueue.updatedAt = now;
    await saveImportQueue(rootPath, activeQueue);
    await appendImportTaskLog(rootPath, task.id, {
      level: 'info',
      message: `reserved import task for stage ${task.stage}`
    });

    return {
      task
    };
  }, options);
}

export async function reserveImportTaskBatch(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  const limits = resolveImportBatchReserveLimits(options);
  const reserveTaskIds = normalizeImportReserveTaskIdSet(options);

  return withImportQueueLock(queueLockPath, async () => {
    const [queue, tasks] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportTasksOnDisk(rootPath)
    ]);
    const reconciled = buildReconciledImportQueue(queue, tasks);
    const activeQueue = reconciled.queue;
    if (reconciled.changed) {
      await saveImportQueue(rootPath, activeQueue);
    }

    const taskById = new Map(tasks.filter(Boolean).map((task) => [task.id, task]));
    const jobsByReserveAge = [...activeQueue.jobs].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });
    const runningJob = jobsByReserveAge.find((job) => (
      String(job?.status || '').trim().toLowerCase() === 'running'
      && importTaskAllowedByReserveSet(job, reserveTaskIds)
    ));
    const runningTask = runningJob ? taskById.get(runningJob.id) : null;

    const pendingTasks = runningTask
      ? [runningTask]
      : activeQueue.jobs
        .map((job) => taskById.get(job.id))
        .filter((task) => {
          const status = String(task?.status || '').trim().toLowerCase();
          const stage = String(task?.stage || task?.progress?.stage || 'queued').trim().toLowerCase();
          return status === 'pending'
            && (!stage || stage === 'queued')
            && importTaskAllowedByReserveSet(task, reserveTaskIds);
        });

    if (!pendingTasks.length) {
      return null;
    }

    const selectedTasks = [];
    let selectedFileCount = 0;
    let selectedSizeBytes = 0;

    for (const task of pendingTasks) {
      if (selectedTasks.length >= limits.maxTasks) break;
      const fileCount = getImportTaskFileCount(task);
      const sizeBytes = getImportTaskSizeBytes(task);
      const wouldExceedFiles = limits.maxFiles !== null && selectedTasks.length > 0 && selectedFileCount + fileCount > limits.maxFiles;
      const wouldExceedBytes = limits.maxBytes !== null && selectedTasks.length > 0 && selectedSizeBytes + sizeBytes > limits.maxBytes;
      if (wouldExceedFiles || wouldExceedBytes) break;
      selectedTasks.push(task);
      selectedFileCount += fileCount;
      selectedSizeBytes += sizeBytes;
    }

    if (!selectedTasks.length) {
      return null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const isBatch = !runningTask && selectedTasks.length > 1;
    const batchId = isBatch ? createImportBatchId(selectedTasks.map((task) => task.id), now) : null;
    const batchTaskIds = selectedTasks.map((task) => task.id);
    const reservedTasks = [];

    for (const task of selectedTasks) {
      const nextTask = {
        ...task,
        status: 'running',
        stage: task.stage && task.stage !== 'queued' ? task.stage : 'materialize',
        includeInGraph: true,
        startedAt: task.startedAt || nowIso,
        updatedAt: nowIso
      };
      nextTask.progress = createImportProgress(nextTask, {
        stage: nextTask.stage,
        status: 'running',
        stagePercent: nextTask.stage === 'materialize' ? 0 : nextTask.progress?.stagePercent,
        processedUnits: 0,
        totalUnits: 0,
        stageStartedAt: nextTask.progress?.stage === nextTask.stage ? nextTask.progress?.stageStartedAt : nowIso,
        currentStep: isBatch ? `batch ${batchId}` : '',
        message: isBatch
          ? `Running ${nextTask.stage} as import batch ${batchId}`
          : `Running ${nextTask.stage}`
      });
      await saveImportTask(rootPath, nextTask);
      updateQueuedJob(activeQueue, nextTask);
      reservedTasks.push(nextTask);
    }

    activeQueue.updatedAt = nowIso;
    await saveImportQueue(rootPath, activeQueue);

    for (const task of reservedTasks) {
      await appendImportTaskLog(rootPath, task.id, {
        level: 'info',
        timestamp: nowIso,
        message: isBatch
          ? `reserved import task in batch ${batchId} (${batchTaskIds.length} task(s))`
          : `reserved import task for stage ${task.stage}`
      });
    }

    return {
      batchId,
      batchTaskIds,
      task: reservedTasks[0],
      tasks: reservedTasks,
      singleTask: reservedTasks.length === 1,
      limits,
      fileCount: selectedFileCount,
      sizeBytes: selectedSizeBytes
    };
  }, options);
}

export async function markImportTaskStage(rootPath, taskId, stage, message = '', options = {}) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.stage = stage;
    nextTask.status = 'running';
    nextTask.includeInGraph = true;
    nextTask.progress = createImportProgress(nextTask, {
      stage,
      status: 'running',
      stagePercent: 0,
      processedUnits: 0,
      totalUnits: 0,
      stageStartedAt: new Date().toISOString(),
      message: message || defaultProgressMessage(stage, 'running')
    });
  }, options);
  if (!task) return null;
  if (message) {
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message
    });
  }
  await appendImportTaskEvent(rootPath, taskId, {
    event: 'task.stage',
    level: 'info',
    stage,
    status: 'running',
    message: message || defaultProgressMessage(stage, 'running')
  });
  return task;
}

export async function updateImportTaskProgress(rootPath, taskId, progress = {}, options = {}) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.progress = createImportProgress(nextTask, progress);
    const diagnostics = progress.diagnostics && typeof progress.diagnostics === 'object' && !Array.isArray(progress.diagnostics)
      ? progress.diagnostics
      : null;
    if (diagnostics) {
      nextTask.progress.diagnostics = {
        ...(nextTask.progress.diagnostics && typeof nextTask.progress.diagnostics === 'object' && !Array.isArray(nextTask.progress.diagnostics)
          ? nextTask.progress.diagnostics
          : {}),
        ...diagnostics
      };
    }
  }, options);
  if (!task) return null;
  await appendImportTaskEvent(rootPath, taskId, {
    event: 'task.progress',
    level: 'debug',
    stage: task.progress?.stage || task.stage || progress.stage || null,
    status: task.progress?.status || task.status || progress.status || null,
    currentStep: task.progress?.currentStep || progress.currentStep || null,
    message: task.progress?.message || progress.message || null,
    percent: task.progress?.percent,
    stagePercent: task.progress?.stagePercent,
    processedUnits: task.progress?.processedUnits,
    totalUnits: task.progress?.totalUnits,
    data: {
      progress: task.progress || null,
      diagnostics: task.progress?.diagnostics || null
    }
  });
  return task;
}

export async function updateImportTaskSemanticLifecycle(rootPath, taskId, status, options = {}) {
  const normalizedStatus = normalizeImportLifecycleStatus(status, 'pending');
  const updatedAt = new Date().toISOString();
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    const result = taskResultObject(nextTask.result);
    const existingEnrichment = result.semanticEnrichment && typeof result.semanticEnrichment === 'object'
      ? result.semanticEnrichment
      : {};
    nextTask.semanticStatus = normalizedStatus;
    if (normalizedStatus === 'running') {
      nextTask.semanticStartedAt = nextTask.semanticStartedAt || updatedAt;
    }
    if (normalizedStatus === 'completed') {
      nextTask.semanticCompletedAt = options.semanticCompletedAt || updatedAt;
    }
    if (normalizedStatus === 'failed') {
      nextTask.semanticFailedAt = options.semanticFailedAt || updatedAt;
    }
    if (options.throughputMetrics && typeof options.throughputMetrics === 'object') {
      nextTask.throughputMetrics = {
        ...(nextTask.throughputMetrics || {}),
        ...options.throughputMetrics
      };
    }
    nextTask.result = {
      ...result,
      semanticStatus: normalizedStatus,
      semanticEnrichment: {
        ...existingEnrichment,
        status: normalizedStatus,
        jobId: options.jobId || existingEnrichment.jobId || null,
        jobIds: Array.isArray(options.jobIds) ? options.jobIds : (existingEnrichment.jobIds || []),
        updatedAt,
        ...(options.result !== undefined ? { result: options.result } : {}),
        ...(options.error ? { error: { message: String(options.error?.message || options.error) } } : {})
      },
      throughputMetrics: options.throughputMetrics
        ? {
            ...(result.throughputMetrics || nextTask.throughputMetrics || {}),
            ...options.throughputMetrics
          }
        : (result.throughputMetrics || nextTask.throughputMetrics || null)
    };
  }, options);
  if (!task) return null;
  if (options.message) {
    await appendImportTaskLog(rootPath, taskId, {
      level: options.logLevel || (normalizedStatus === 'failed' ? 'error' : 'info'),
      message: options.message
    });
  }
  await appendImportTaskEvent(rootPath, taskId, {
    event: `task.semantic.${normalizedStatus}`,
    level: normalizedStatus === 'failed' ? 'error' : 'info',
    status: task.status,
    stage: task.stage,
    message: options.message || `semantic lifecycle ${normalizedStatus}`,
    data: {
      semanticStatus: normalizedStatus,
      jobId: options.jobId || null,
      jobIds: Array.isArray(options.jobIds) ? options.jobIds : []
    },
    error: options.error || null
  });
  return task;
}

function getImportTaskAuthoritativeSyncJobId(task = {}) {
  const result = taskResultObject(task.result);
  const syncCandidates = [
    objectOrNull(result.authoritativeSync),
    objectOrNull(result.authoritative_sync),
    objectOrNull(task.authoritativeSync),
    objectOrNull(task.authoritative_sync)
  ].filter(Boolean);
  for (const sync of syncCandidates) {
    const jobId = String(sync.jobId || sync.job_id || '').trim();
    if (jobId) return jobId;
  }
  return '';
}

function createAuthoritativeSyncTaskPayload(jobId, status, options = {}) {
  const job = objectOrNull(options.job) || {};
  const updatedAt = options.updatedAt || job.updatedAt || new Date().toISOString();
  const payload = {
    jobId,
    status,
    updatedAt
  };
  const completedAt = options.completedAt || job.completedAt || null;
  if (completedAt || status === 'completed') {
    payload.completedAt = completedAt || updatedAt;
  }
  const failedAt = options.failedAt || job.failedAt || null;
  if (failedAt || status === 'failed') {
    payload.failedAt = failedAt || updatedAt;
  }
  const appliedAt = options.appliedAt || job.appliedAt || null;
  if (appliedAt) {
    payload.appliedAt = appliedAt;
  }
  const error = options.error || job.error || null;
  if (error) {
    payload.error = error && typeof error === 'object'
      ? {
          message: String(error.message || error),
          ...(error.name ? { name: String(error.name) } : {})
        }
      : { message: String(error) };
  } else if (status === 'completed') {
    payload.error = null;
  }
  return payload;
}

export async function updateImportTasksAuthoritativeSyncLifecycle(rootPath, jobId, status, options = {}) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) {
    return {
      jobId: '',
      status: normalizeImportLifecycleStatus(status, 'pending'),
      updatedTaskIds: [],
      updatedCount: 0
    };
  }
  const normalizedStatus = normalizeImportLifecycleStatus(status, 'pending');
  const { tasks } = await listImportTasks(rootPath, options);
  const matchingTaskIds = (tasks || [])
    .filter((task) => getImportTaskAuthoritativeSyncJobId(task) === normalizedJobId)
    .map((task) => task.id)
    .filter(Boolean);
  const updatedTaskIds = [];

  for (const taskId of matchingTaskIds) {
    const updatedTask = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
      if (getImportTaskAuthoritativeSyncJobId(nextTask) !== normalizedJobId) return;
      const result = taskResultObject(nextTask.result);
      const existingSync = objectOrNull(result.authoritativeSync) || {};
      const syncPayload = createAuthoritativeSyncTaskPayload(normalizedJobId, normalizedStatus, options);
      nextTask.authoritativeSyncStatus = normalizedStatus;
      if (normalizedStatus === 'completed') {
        nextTask.authoritativeSyncCompletedAt = syncPayload.completedAt || syncPayload.updatedAt;
        nextTask.authoritativeSyncFailedAt = null;
      }
      if (normalizedStatus === 'failed') {
        nextTask.authoritativeSyncFailedAt = syncPayload.failedAt || syncPayload.updatedAt;
      }
      nextTask.result = {
        ...result,
        authoritativeSyncStatus: normalizedStatus,
        authoritativeSync: {
          ...existingSync,
          ...syncPayload
        }
      };
    }, options);
    if (!updatedTask) continue;
    updatedTaskIds.push(updatedTask.id);
    if (options.message !== false) {
      await appendImportTaskLog(rootPath, updatedTask.id, {
        level: normalizedStatus === 'failed' ? 'error' : 'info',
        message: options.message || `authoritative sync job ${normalizedJobId} ${normalizedStatus}`
      });
    }
    await appendImportTaskEvent(rootPath, updatedTask.id, {
      event: `task.authoritative_sync.${normalizedStatus}`,
      level: normalizedStatus === 'failed' ? 'error' : 'info',
      status: updatedTask.status,
      stage: updatedTask.stage,
      message: options.message || `authoritative sync job ${normalizedJobId} ${normalizedStatus}`,
      data: {
        jobId: normalizedJobId,
        authoritativeSyncStatus: normalizedStatus
      },
      error: options.error || null
    });
  }

  return {
    jobId: normalizedJobId,
    status: normalizedStatus,
    updatedTaskIds,
    updatedCount: updatedTaskIds.length
  };
}

export async function completeImportTask(rootPath, taskId, result = null) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    const finishedAt = new Date().toISOString();
    const lifecycleFields = createCompletedImportLifecycleFields(nextTask, result, finishedAt);
    nextTask.status = 'completed';
    nextTask.stage = 'completed';
    nextTask.includeInGraph = true;
    nextTask.finishedAt = finishedAt;
    Object.assign(nextTask, lifecycleFields);
    nextTask.result = result;
    nextTask.error = null;
    nextTask.progress = createImportProgress(nextTask, {
      stage: 'completed',
      status: 'completed',
      stagePercent: 100,
      percent: 100,
      message: 'Import task completed'
    });
  });
  if (!task) return null;
  await appendImportTaskLog(rootPath, taskId, {
    level: 'info',
    message: 'completed import task'
  });
  await appendImportTaskEvent(rootPath, taskId, {
    event: 'task.completed',
    level: 'info',
    status: 'completed',
    stage: 'completed',
    message: 'Import task completed'
  });
  return task;
}

export async function failImportTask(rootPath, taskId, error) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.status = 'failed';
    nextTask.includeInGraph = false;
    nextTask.finishedAt = new Date().toISOString();
    nextTask.graphVisibilityStatus = 'failed';
    nextTask.semanticStatus = 'failed';
    nextTask.error = {
      message: String(error?.message || error || 'Import task failed')
    };
    nextTask.progress = createImportProgress(nextTask, {
      status: 'failed',
      message: String(error?.message || error || 'Import task failed')
    });
  });
  if (!task) return null;
  await appendImportTaskLog(rootPath, taskId, {
    level: 'error',
    message: String(error?.message || error || 'Import task failed')
  });
  await appendImportTaskEvent(rootPath, taskId, {
    event: 'task.failed',
    level: 'error',
    status: 'failed',
    message: String(error?.message || error || 'Import task failed'),
    error
  });
  await clearImportFingerprintEntry(rootPath, task.importFingerprint, task.id);
  return task;
}

async function resolveUniqueQuarantineTaskDir(baseDir) {
  let candidate = baseDir;
  let suffix = 2;
  while (await fileExists(candidate)) {
    candidate = `${baseDir}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function quarantineImportTasks(rootPath, taskIds = [], options = {}) {
  const normalizedTaskIds = [...new Set(
    (Array.isArray(taskIds) ? taskIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
  if (!normalizedTaskIds.length) {
    return {
      batchId: '',
      batchDir: '',
      count: 0,
      tasks: []
    };
  }

  const { queueLockPath, quarantineDir } = getImportPaths(rootPath);
  return withImportQueueLock(queueLockPath, async () => {
    const [queue, contentIndex] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportContentIndex(rootPath)
    ]);
    const timestamp = new Date();
    const quarantinedAt = timestamp.toISOString();
    const batchId = String(options.batchId || createImportQuarantineBatchId(timestamp)).trim() || createImportQuarantineBatchId(timestamp);
    const batchDir = path.join(quarantineDir, batchId);
    await ensureDir(batchDir);

    const tasks = [];

    for (const taskId of normalizedTaskIds) {
      const existingTask = await loadImportTask(rootPath, taskId);
      if (!existingTask) continue;

      const nextTask = {
        ...existingTask,
        status: 'failed',
        includeInGraph: false,
        finishedAt: quarantinedAt,
        updatedAt: quarantinedAt,
        quarantinedAt,
        quarantine: {
          batchId,
          reason: String(options.reason || 'stale-pending-timeout'),
          queueStatusAtQuarantine: String(existingTask.status || '').trim().toLowerCase() || 'pending',
          queueStageAtQuarantine: String(existingTask.stage || '').trim() || 'queued'
        },
        error: {
          message: String(options.message || 'Import task was quarantined from the active queue.')
        }
      };
      nextTask.progress = createImportProgress(nextTask, {
        status: 'failed',
        stage: nextTask.stage || 'queued',
        message: nextTask.error.message
      });

      await saveImportTask(rootPath, nextTask);
      await appendImportTaskLog(rootPath, taskId, {
        level: 'warn',
        message: `quarantined from the active queue: ${nextTask.error.message} reason=${nextTask.quarantine.reason}`
      });

      const sourceTaskDir = getImportTaskPaths(rootPath, taskId).taskDir;
      const targetTaskDir = await resolveUniqueQuarantineTaskDir(path.join(batchDir, stableHash(taskId, 20)));
      if (await fileExists(sourceTaskDir)) {
        await fs.rename(sourceTaskDir, targetTaskDir);
      } else {
        await ensureDir(targetTaskDir);
      }

      await writeJson(path.join(targetTaskDir, 'quarantine.json'), {
        version: IMPORT_QUARANTINE_SCHEMA_VERSION,
        taskId,
        quarantinedAt,
        reason: nextTask.quarantine.reason,
        message: nextTask.error.message,
        originalStatus: nextTask.quarantine.queueStatusAtQuarantine,
        originalStage: nextTask.quarantine.queueStageAtQuarantine
      });

      tasks.push({
        taskId,
        batchId,
        taskDir: targetTaskDir,
        originalStatus: nextTask.quarantine.queueStatusAtQuarantine,
        originalStage: nextTask.quarantine.queueStageAtQuarantine,
        createdAt: nextTask.createdAt,
        quarantinedAt,
        reason: nextTask.quarantine.reason,
        fileCount: Array.isArray(nextTask.files) ? nextTask.files.length : 0
      });

      removeQueuedJob(queue, taskId);
      if (nextTask.importFingerprint && contentIndex.entries?.[nextTask.importFingerprint]?.taskId === taskId) {
        delete contentIndex.entries[nextTask.importFingerprint];
      }
    }

    queue.updatedAt = quarantinedAt;
    contentIndex.updatedAt = quarantinedAt;
    await Promise.all([
      saveImportQueue(rootPath, queue),
      saveImportContentIndex(rootPath, contentIndex),
      writeJson(path.join(batchDir, 'summary.json'), {
        version: IMPORT_QUARANTINE_SCHEMA_VERSION,
        batchId,
        rootPath: path.resolve(rootPath),
        quarantinedAt,
        reason: String(options.reason || 'stale-pending-timeout'),
        message: String(options.message || 'Import tasks were quarantined from the active queue.'),
        count: tasks.length,
        tasks
      })
    ]);

    return {
      batchId,
      batchDir,
      count: tasks.length,
      tasks
    };
  }, options);
}
