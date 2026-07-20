import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCorpus } from '../storage/corpus-store.js';
import {
  buildDiscoveryMetadataGraph,
  buildLiteratureDiscoveryRunPlan,
  runLiteratureDiscovery
} from '../core/discovery/workflow.js';
import { submitDiscoveryImports } from '../core/discovery/import-bridge.js';
import { getImportWorkerCoverageSnapshot, runImportQueueUntilIdle } from '../core/imports/worker.js';
import {
  createDiscoveryRunId,
  listDiscoveryProgress,
  listDiscoveryRuns,
  loadDiscoveryProgress,
  loadDiscoveryRun,
  saveDiscoveryProgress,
  saveDiscoveryRun
} from '../core/discovery/store.js';
import { loadImportTask } from '../storage/import-store.js';
import { loadRegistry } from '../storage/registry.js';
import {
  createDiscoverySupplementationInterface,
  resolveDiscoverySources
} from '../core/discovery/source-resolution.js';
import { resolvePathWithHome } from '../lib/config.js';
import { createContentSha256, createSourceIdentity, normalizePaperIdentifiers } from '../lib/paper-identifiers.js';
import { configuredWorkerCoveragePayload } from '../server/api.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

const SUBMITTABLE_DISCOVERY_OPERATIONS = new Set([
  'search',
  'resolve',
  'run',
  'import',
  'ingest',
  'import_and_process'
]);
const TERMINAL_DISCOVERY_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'blocked']);
const TERMINAL_DISCOVERY_STAGES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'blocked']);
const DEFAULT_DISCOVERY_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_DISCOVERY_RECOVERY_STALE_MS = 30 * 60 * 1000;
const SECRET_RECOVERY_ARG_PATTERN = /(api.?key|token|secret|password)$/i;

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').trim();
}

function unique(values = []) {
  return [...new Set(values)];
}

function identifiersOf(entry = {}) {
  const identifiers = normalizeObject(entry.identifiers);
  return {
    ...identifiers,
    ...normalizePaperIdentifiers({ ...entry, identifiers })
  };
}

function sourceResolutionStatus(candidate = {}) {
  return candidate.source?.resolutionStatus || candidate.source?.resolution_status || '';
}

function importKey(type = '', value = '', options = {}) {
  const text = compactText(value);
  if (!text) return '';
  return `${type}:${options.caseSensitive ? text : text.toLowerCase()}`;
}

function importKeysFromCandidate(candidate = {}) {
  const identifiers = identifiersOf(candidate);
  const source = normalizeObject(candidate.source);
  return unique([
    importKey('canonical', candidate.canonicalId),
    importKey('canonical', candidate.canonical_id),
    importKey('source_path', source.sourcePath, { caseSensitive: true }),
    importKey('source_path', source.source_path, { caseSensitive: true }),
    importKey('candidate', candidate.id, { caseSensitive: true }),
    importKey('candidate', candidate.candidateId, { caseSensitive: true }),
    importKey('candidate', candidate.candidate_id, { caseSensitive: true }),
    importKey('doi', identifiers.doi),
    importKey('arxiv', identifiers.arxivId),
    importKey('pmid', identifiers.pmid),
    importKey('pmcid', identifiers.pmcid)
  ].filter(Boolean));
}

function importKeysFromResult(entry = {}) {
  const identifiers = identifiersOf(entry);
  return unique([
    importKey('canonical', entry.canonicalId),
    importKey('canonical', entry.canonical_id),
    importKey('source_path', entry.sourcePath, { caseSensitive: true }),
    importKey('source_path', entry.source_path, { caseSensitive: true }),
    importKey('candidate', entry.candidateId, { caseSensitive: true }),
    importKey('candidate', entry.candidate_id, { caseSensitive: true }),
    importKey('doi', identifiers.doi),
    importKey('arxiv', identifiers.arxivId),
    importKey('pmid', identifiers.pmid),
    importKey('pmcid', identifiers.pmcid)
  ].filter(Boolean));
}

function importResultsByKey(importResult = {}) {
  const importsByKey = new Map();
  for (const entry of importResult.results || []) {
    for (const key of importKeysFromResult(entry)) {
      if (!importsByKey.has(key)) importsByKey.set(key, entry);
    }
  }
  return importsByKey;
}

function findImportResultForCandidate(candidate = {}, importsByKey = new Map()) {
  return importKeysFromCandidate(candidate)
    .map((key) => importsByKey.get(key))
    .find(Boolean);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function resolveSubmittedDiscoveryOperation(args = {}) {
  const requested = normalizeOperation(firstDefined(
    args.discoveryOperation,
    args.discovery_operation,
    args.submittedOperation,
    args.submitted_operation,
    args.targetOperation,
    args.target_operation
  ));
  return SUBMITTABLE_DISCOVERY_OPERATIONS.has(requested) ? requested : 'search';
}

function safeProgressError(error) {
  return {
    message: error?.message || String(error || 'unknown error'),
    name: error?.name || 'Error'
  };
}

function parseTimeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDiscoveryRecoveryArgs(args = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(normalizeObject(args))) {
    if (SECRET_RECOVERY_ARG_PATTERN.test(key)) continue;
    if (value === undefined) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function isTerminalDiscoveryProgress(progress = {}) {
  const status = String(progress.status || '').trim().toLowerCase();
  const stage = String(progress.stage || '').trim().toLowerCase();
  return TERMINAL_DISCOVERY_STATUSES.has(status) || TERMINAL_DISCOVERY_STAGES.has(stage);
}

function isRecoverableDiscoveryProgress(progress = {}, staleMs = DEFAULT_DISCOVERY_RECOVERY_STALE_MS, nowMs = Date.now()) {
  if (!progress?.runId || isTerminalDiscoveryProgress(progress)) return false;
  const status = String(progress.status || '').trim().toLowerCase();
  const stage = String(progress.stage || '').trim().toLowerCase();
  if (status === 'queued' || stage === 'queued') return true;
  if (status !== 'running') return false;
  const updatedAtMs = parseTimeMs(progress.updatedAt || progress.startedAt || progress.submittedAt);
  return updatedAtMs !== null && nowMs - updatedAtMs > staleMs;
}

function collectDiscoveryImportTaskIds(...sources) {
  const ids = [];
  const push = (value) => {
    const normalized = compactText(value);
    if (normalized) ids.push(normalized);
  };

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const entry of source.importSummary?.results || []) {
      push(entry.taskId || entry.task_id);
    }
    for (const entry of source.candidates || []) {
      push(entry.import?.taskId || entry.import?.task_id);
    }
    for (const value of source.importTaskIds || source.import_task_ids || []) {
      push(value);
    }
  }

  return unique(ids);
}

function emptyDiscoveryQueueState() {
  return {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    unknown: 0
  };
}

async function summarizeDiscoveryImportQueue(rootPath, taskIds = []) {
  const queueState = emptyDiscoveryQueueState();
  const tasks = [];

  for (const taskId of taskIds) {
    const task = await loadImportTask(rootPath, taskId).catch(() => null);
    if (!task) {
      queueState.unknown += 1;
      tasks.push({ taskId, status: 'unknown', stage: '' });
      continue;
    }
    const status = normalizeOperation(task.status || 'unknown');
    queueState.total += 1;
    if (Object.prototype.hasOwnProperty.call(queueState, status)) {
      queueState[status] += 1;
    } else {
      queueState.unknown += 1;
    }
    tasks.push({
      taskId,
      status,
      stage: task.stage || '',
      updatedAt: task.updatedAt || null
    });
  }

  if (!queueState.total && queueState.unknown) {
    queueState.total = queueState.unknown;
  }

  return { queueState, tasks };
}

function inferDiscoveryLifecycleState(progress = {}, run = {}, importHandoff = null) {
  const status = normalizeOperation(progress.status || run.status || '');
  const stage = normalizeOperation(progress.stage || run.stage || '');
  if (status === 'queued') return 'queued';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'completed' || stage === 'completed') return 'completed';
  if (stage === 'import_submit') return 'waiting_import_requisition';
  if (stage === 'import_processing') return 'waiting_import_tasks';
  if (importHandoff?.taskIds?.length) {
    const queue = importHandoff.queueState || {};
    if ((queue.pending || 0) > 0 || (queue.running || 0) > 0) return 'waiting_import_tasks';
    if ((queue.completed || 0) > 0 && (queue.failed || 0) === 0) return 'graph_materialization_complete';
  }
  if (status === 'running' || stage) return 'running';
  return 'unknown';
}

async function buildDiscoveryDiagnostics(rootPath, progress = {}, run = {}, options = {}) {
  progress = normalizeObject(progress);
  run = normalizeObject(run);
  const taskIds = collectDiscoveryImportTaskIds(progress, run);
  const importQueue = await summarizeDiscoveryImportQueue(rootPath, taskIds);
  const workerCoverage = await configuredWorkerCoveragePayload(rootPath, options);
  const workerSeen = getImportWorkerCoverageSnapshot(rootPath);
  const importHandoff = {
    requisitionId: progress.importRequisitionId || progress.import_requisition_id || run.importRequisitionId || run.import_requisition_id || null,
    taskIds,
    queueState: importQueue.queueState,
    tasks: importQueue.tasks
  };
  const state = inferDiscoveryLifecycleState(progress, run, importHandoff);
  const blockedReason = progress.blockedReason || progress.blocked_reason || (workerCoverage.covered ? null : 'root_not_configured');
  const staleMs = Math.max(60_000, Number(options.discoveryRecoveryStaleMs || DEFAULT_DISCOVERY_RECOVERY_STALE_MS));

  return {
    runLifecycle: {
      state,
      status: progress.status || run.status || '',
      stage: progress.stage || run.stage || '',
      leaseOwner: progress.leaseOwner || progress.lease_owner || null,
      lastHeartbeatAt: progress.lastHeartbeatAt || progress.last_heartbeat_at || progress.updatedAt || null,
      lastRecoveredAt: progress.lastRecoveredAt || progress.last_recovered_at || progress.recoveredAt || null,
      updatedAt: progress.updatedAt || run.generatedAt || null
    },
    resumeState: {
      recoverable: Boolean(progress?.runId && isRecoverableDiscoveryProgress(progress, staleMs)),
      blockedReason,
      coveredByWorker: workerCoverage.covered
    },
    importHandoff,
    workerCoverage: {
      ...workerCoverage,
      lastWorkerSeenAt: workerSeen?.lastWorkerSeenAt || null,
      workerObserved: Boolean(workerSeen)
    }
  };
}

async function decorateDiscoveryProgressPayload(rootPath, progress = {}, options = {}) {
  return {
    ...progress,
    ...(await buildDiscoveryDiagnostics(rootPath, progress, null, options))
  };
}

async function decorateDiscoveryRunPayload(rootPath, run = {}, options = {}) {
  const progress = run?.runId ? await loadDiscoveryProgress(rootPath, run.runId) : null;
  return {
    ...run,
    ...(await buildDiscoveryDiagnostics(rootPath, progress || {}, run, options))
  };
}

function toNonNegativeInteger(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function toPositiveInteger(value, fallback = 100) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function shouldReturnCandidatePage(args = {}) {
  return enabledFlag(firstDefined(args.includeCandidates, args.include_candidates))
    || args.candidateLimit !== undefined
    || args.candidate_limit !== undefined
    || args.candidateOffset !== undefined
    || args.candidate_offset !== undefined
    || args.candidateView !== undefined
    || args.candidate_view !== undefined;
}

function sourceSummary(source = {}) {
  const normalized = normalizeObject(source);
  return {
    resolutionStatus: normalized.resolutionStatus || normalized.resolution_status || '',
    fullTextStatus: normalized.fullTextStatus || normalized.full_text_status || '',
    sourceKind: normalized.sourceKind || normalized.source_kind || '',
    sourceProvider: normalized.sourceProvider || normalized.source_provider || '',
    sourceId: normalized.sourceId || normalized.source_id || '',
    markdownUrl: normalized.markdownUrl || normalized.markdown_url || '',
    pdfUrl: normalized.pdfUrl || normalized.pdf_url || '',
    landingPageUrl: normalized.landingPageUrl || normalized.landing_page_url || ''
  };
}

function screeningCandidateView(candidate = {}) {
  const identifiers = identifiersOf(candidate);
  return {
    id: candidate.id || candidate.candidateId || candidate.candidate_id || '',
    candidateId: candidate.candidateId || candidate.id || candidate.candidate_id || '',
    candidate_id: candidate.candidate_id || candidate.candidateId || candidate.id || '',
    canonicalId: candidate.canonicalId || candidate.canonical_id || identifiers.canonicalId || '',
    canonical_id: candidate.canonical_id || candidate.canonicalId || identifiers.canonicalId || '',
    provider: candidate.provider || '',
    title: candidate.title || '',
    authors: Array.isArray(candidate.authors) ? candidate.authors : [],
    year: candidate.year ?? null,
    publicationDate: candidate.publicationDate || candidate.publication_date || '',
    venue: candidate.venue || '',
    venueFamily: candidate.venueFamily || candidate.venue_family || '',
    venueType: candidate.venueType || candidate.venue_type || '',
    publicationType: candidate.publicationType || candidate.publication_type || '',
    abstract: candidate.abstract || '',
    citationCount: candidate.citationCount ?? candidate.citation_count ?? null,
    openAccessStatus: candidate.openAccessStatus || candidate.open_access_status || '',
    license: candidate.license || '',
    identifiers,
    doi: identifiers.doi || '',
    arxivId: identifiers.arxivId || '',
    pmid: identifiers.pmid || '',
    pmcid: identifiers.pmcid || '',
    sourceHints: Array.isArray(candidate.sourceHints) ? candidate.sourceHints : [],
    fullTextUrls: Array.isArray(candidate.fullTextUrls) ? candidate.fullTextUrls : [],
    markdownUrl: candidate.markdownUrl || candidate.markdown_url || '',
    pdfUrl: candidate.pdfUrl || candidate.pdf_url || '',
    bestOaUrl: candidate.bestOaUrl || candidate.best_oa_url || '',
    landingPageUrl: candidate.landingPageUrl || candidate.landing_page_url || '',
    retrievalEvidence: Array.isArray(candidate.retrievalEvidence) ? candidate.retrievalEvidence : [],
    source: sourceSummary(candidate.source)
  };
}

function projectCandidate(candidate = {}, view = 'screening') {
  const normalizedView = String(view || 'screening').trim().toLowerCase();
  if (normalizedView === 'full') return candidate;
  return screeningCandidateView(candidate);
}

async function decorateDiscoveryCandidatePagePayload(rootPath, run = {}, args = {}, options = {}) {
  const progress = run?.runId ? await loadDiscoveryProgress(rootPath, run.runId) : null;
  const candidates = Array.isArray(run.candidates) ? run.candidates : [];
  const offset = toNonNegativeInteger(firstDefined(args.candidateOffset, args.candidate_offset, args.offset), 0);
  const requestedLimit = toPositiveInteger(firstDefined(args.candidateLimit, args.candidate_limit, args.limit), 100);
  const maxLimit = toPositiveInteger(firstDefined(args.maxCandidatePageLimit, args.max_candidate_page_limit, options.maxCandidatePageLimit), 500);
  const limit = Math.min(requestedLimit, maxLimit);
  const view = String(firstDefined(args.candidateView, args.candidate_view, 'screening') || 'screening').trim().toLowerCase();
  const page = candidates.slice(offset, offset + limit).map((candidate) => projectCandidate(candidate, view));
  const diagnostics = await buildDiscoveryDiagnostics(rootPath, progress || {}, run, options);
  return {
    contractVersion: 'literature-discovery-candidates-v1',
    runId: run.runId || '',
    rootPath,
    topic: run.topic || '',
    status: progress?.status || run.status || '',
    stage: progress?.stage || run.stage || '',
    generatedAt: run.generatedAt || null,
    coverage: run.coverage || null,
    candidatePage: {
      total: candidates.length,
      offset,
      limit,
      returned: page.length,
      hasMore: offset + page.length < candidates.length,
      nextOffset: offset + page.length < candidates.length ? offset + page.length : null,
      view
    },
    candidates: page,
    ...diagnostics
  };
}

function buildRecoveryDiscoveryArgs(progress = {}) {
  const recoveredArgs = sanitizeDiscoveryRecoveryArgs(progress.recovery?.args || progress.recoveryArgs || {});
  if (Object.keys(recoveredArgs).length) {
    return {
      ...recoveredArgs,
      operation: resolveSubmittedDiscoveryOperation(recoveredArgs),
      discoveryOperation: resolveSubmittedDiscoveryOperation(recoveredArgs),
      discovery_operation: resolveSubmittedDiscoveryOperation(recoveredArgs)
    };
  }

  const topic = compactText(progress.topic || progress.query);
  if (!topic) return null;
  const operation = resolveSubmittedDiscoveryOperation({
    operation: progress.operation || 'search'
  });
  return {
    topic,
    query: topic,
    operation,
    discoveryOperation: operation,
    discovery_operation: operation,
    searchMode: compactText(progress.searchMode || progress.search_mode),
    search_mode: compactText(progress.searchMode || progress.search_mode)
  };
}

async function writeLiteratureDiscoveryProgress(rootPath, progress = {}) {
  return saveDiscoveryProgress(rootPath, {
    ...progress,
    updatedAt: progress.updatedAt || new Date().toISOString()
  });
}

async function recoverLiteratureDiscoveryProgress(rootPath, progress = {}, options = {}) {
  const runId = compactText(progress.runId);
  if (!runId) return { recovered: false, reason: 'missing-run-id' };
  const recoveryArgs = buildRecoveryDiscoveryArgs(progress);
  const writer = createLiteratureDiscoveryProgressWriter(rootPath, {
    runId,
    rootPath,
    topic: progress.topic || recoveryArgs?.topic || '',
    operation: progress.operation || recoveryArgs?.operation || '',
    searchMode: progress.searchMode || recoveryArgs?.searchMode || '',
    submittedAt: progress.submittedAt || new Date().toISOString()
  });

  if (!recoveryArgs) {
    await writer({
      status: 'blocked',
      stage: 'blocked',
      event: 'recovery_blocked',
      blockedReason: 'missing_recovery_args',
      completedAt: new Date().toISOString()
    });
    return { recovered: false, runId, reason: 'missing_recovery_args' };
  }

  await writer({
    status: 'running',
    stage: 'recovery_claimed',
    event: 'recovery_claimed',
    recoveredAt: new Date().toISOString()
  });

  try {
    const executeDiscovery = options.executeLiteratureDiscoveryTool || executeLiteratureDiscoveryTool;
    await executeDiscovery({
      ...recoveryArgs,
      corpus: recoveryArgs.corpus || rootPath,
      runId,
      persist: recoveryArgs.persist !== false
    }, {
      ...options,
      onLiteratureDiscoveryProgress: writer
    });
    return { recovered: true, runId };
  } catch (error) {
    await writer({
      status: 'failed',
      stage: 'failed',
      event: 'recovery_failed',
      completedAt: new Date().toISOString(),
      error: safeProgressError(error)
    });
    return { recovered: false, runId, reason: error?.message || 'recovery-failed' };
  }
}

async function resolveDiscoveryRecoveryRootPaths(options = {}) {
  const baseDir = options.configBaseDir || process.cwd();
  const seen = new Set();
  const normalizeRoots = (values = []) => {
    const roots = [];
    for (const item of values) {
      const raw = String(item || '').trim();
      if (!raw) continue;
      const resolved = resolvePathWithHome(raw, baseDir);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      roots.push(resolved);
    }
    return roots;
  };
  const configuredRoots = normalizeRoots(Array.isArray(options.rootPaths) ? options.rootPaths : []);
  if (configuredRoots.length) return configuredRoots;
  const registry = await loadRegistry();
  return normalizeRoots((registry.corpora || []).map((corpus) => corpus.rootPath));
}

export function startLiteratureDiscoveryRecoveryWorker(options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(5000, Number(options.intervalMs || options.discoveryRecoveryIntervalMs || DEFAULT_DISCOVERY_RECOVERY_INTERVAL_MS));
  const staleMs = Math.max(60_000, Number(options.staleMs || options.discoveryRecoveryStaleMs || DEFAULT_DISCOVERY_RECOVERY_STALE_MS));
  let closed = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (closed || running) return;
    running = true;
    try {
      const rootPaths = await resolveDiscoveryRecoveryRootPaths(options);
      for (const rootPath of rootPaths) {
        const progressRecords = await listDiscoveryProgress(rootPath, options.discoveryRecoveryLimit || 50);
        for (const progress of progressRecords) {
          if (!isRecoverableDiscoveryProgress(progress, staleMs)) continue;
          const result = await recoverLiteratureDiscoveryProgress(rootPath, progress, options);
          if (result.recovered) {
            logger.log?.(`[literature_discovery] recovered run ${result.runId} for ${rootPath}`);
          } else {
            logger.warn?.(`[literature_discovery] recovery skipped run ${result.runId || progress.runId} for ${rootPath}: ${result.reason}`);
          }
        }
      }
    } catch (error) {
      logger.warn?.(`[literature_discovery] recovery worker failed (${error?.message || error})`);
    } finally {
      running = false;
      schedule();
    }
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, Math.min(2500, intervalMs));
  return {
    stop() {
      closed = true;
      clearTimeout(timer);
    },
    pollNow() {
      clearTimeout(timer);
      setTimeout(tick, 0);
    }
  };
}

function createLiteratureDiscoveryProgressWriter(rootPath, base = {}) {
  return async (progress = {}) => {
    try {
      await writeLiteratureDiscoveryProgress(rootPath, {
        ...base,
        ...progress,
        runId: base.runId || progress.runId,
        topic: progress.topic || base.topic || '',
        operation: progress.operation || base.operation || '',
        searchMode: progress.searchMode || base.searchMode || ''
      });
    } catch {
      // Progress persistence is best-effort and should not fail discovery.
    }
  };
}

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function shouldSubmitImports(operation, args = {}) {
  return operation === 'import'
    || operation === 'ingest'
    || operation === 'import_and_process'
    || enabledFlag(firstDefined(args.importResolved, args.import_resolved));
}

function shouldProcessImports(operation, args = {}) {
  return operation === 'ingest'
    || operation === 'import_and_process'
    || enabledFlag(firstDefined(args.processImports, args.process_imports, args.waitForImports, args.wait_for_imports));
}

function explicitImportMaxPasses(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const importConfig = normalizeObject(config.imports || config.import);
  return firstDefined(
    args.importMaxPasses,
    args.import_max_passes,
    args.maxImportPasses,
    args.max_import_passes,
    importConfig.maxPasses,
    importConfig.maxImportPasses
  );
}

function countProcessableImportTasks(importResult = {}) {
  return (importResult.results || []).filter((entry) => {
    if (!entry.taskId) return false;
    if (entry.status === 'submitted') return true;
    if (entry.status !== 'deduped') return false;
    const taskStatus = String(entry.taskStatus || '').trim().toLowerCase();
    return taskStatus !== 'completed' && taskStatus !== 'failed';
  }).length;
}

function buildImportProcessingOptions(args = {}, options = {}, importResult = {}) {
  const config = normalizeObject(options.config);
  const importConfig = normalizeObject(config.imports || config.import);
  const ingestionConfig = normalizeObject(config.ingestion);
  const pdfConfig = normalizeObject(config.pdf || config.pdfParser || config.pdf_parser);
  const submittedTaskCount = countProcessableImportTasks(importResult);

  return {
    ...options,
    maxPasses: firstDefined(
      explicitImportMaxPasses(args, options),
      Math.max(1, submittedTaskCount)
    ),
    semanticExtraction: firstDefined(
      args.semanticExtraction,
      args.semantic_extraction,
      importConfig.semanticExtraction,
      ingestionConfig.semanticExtraction
    ),
    pdfParser: firstDefined(
      args.pdfParser,
      args.pdf_parser,
      importConfig.pdfParser,
      ingestionConfig.pdfParser,
      pdfConfig.parser
    ),
    pdfCommand: firstDefined(args.pdfCommand, args.pdf_command, importConfig.pdfCommand, pdfConfig.command),
    pythonCommand: firstDefined(args.pythonCommand, args.python_command, importConfig.pythonCommand),
    doclingCommand: firstDefined(args.doclingCommand, args.docling_command, importConfig.doclingCommand),
    doclingPython: firstDefined(args.doclingPython, args.docling_python, importConfig.doclingPython),
    markitdownPython: firstDefined(args.markitdownPython, args.markitdown_python, importConfig.markitdownPython),
    markpdfdownPython: firstDefined(args.markpdfdownPython, args.markpdfdown_python, importConfig.markpdfdownPython),
    firecrawlApiBaseUrl: firstDefined(args.firecrawlApiBaseUrl, args.firecrawl_api_base_url, importConfig.firecrawlApiBaseUrl),
    firecrawlApiKeyEnv: firstDefined(args.firecrawlApiKeyEnv, args.firecrawl_api_key_env, importConfig.firecrawlApiKeyEnv),
    firecrawlMode: firstDefined(args.firecrawlMode, args.firecrawl_mode, importConfig.firecrawlMode),
    firecrawlSourceMode: firstDefined(args.firecrawlSourceMode, args.firecrawl_source_mode, importConfig.firecrawlSourceMode),
    firecrawlMaxPages: firstDefined(args.firecrawlMaxPages, args.firecrawl_max_pages, importConfig.firecrawlMaxPages),
    firecrawlTimeoutMs: firstDefined(args.firecrawlTimeoutMs, args.firecrawl_timeout_ms, importConfig.firecrawlTimeoutMs),
    opendataloaderPdfPython: firstDefined(
      args.opendataloaderPdfPython,
      args.opendataloader_pdf_python,
      importConfig.opendataloaderPdfPython
    ),
    importPreparseConcurrency: firstDefined(
      args.importPreparseConcurrency,
      args.import_preparse_concurrency,
      importConfig.importPreparseConcurrency
    ),
    importTaskTimeoutMs: firstDefined(args.importTaskTimeoutMs, args.import_task_timeout_ms, importConfig.importTaskTimeoutMs),
    importPendingTimeoutMs: firstDefined(
      args.importPendingTimeoutMs,
      args.import_pending_timeout_ms,
      importConfig.importPendingTimeoutMs
    ),
    importBatchEnabled: firstDefined(
      args.importBatchEnabled,
      args.import_batch_enabled,
      args.batchEnabled,
      args.batch_enabled,
      options.importBatchEnabled,
      options.batchEnabled,
      importConfig.importBatchEnabled,
      importConfig.batchEnabled,
      true
    ),
    importBatchMaxTasks: firstDefined(
      args.importBatchMaxTasks,
      args.import_batch_max_tasks,
      args.batchMaxTasks,
      args.batch_max_tasks,
      options.importBatchMaxTasks,
      options.batchMaxTasks,
      importConfig.importBatchMaxTasks,
      importConfig.batchMaxTasks,
      importConfig.maxTasks,
      16
    ),
    importBatchInitialTasks: firstDefined(
      args.importBatchInitialTasks,
      args.import_batch_initial_tasks,
      args.batchInitialTasks,
      args.batch_initial_tasks,
      options.importBatchInitialTasks,
      options.batchInitialTasks,
      importConfig.importBatchInitialTasks,
      importConfig.batchInitialTasks,
      4
    ),
    importBatchProgressive: firstDefined(
      args.importBatchProgressive,
      args.import_batch_progressive,
      args.batchProgressive,
      args.batch_progressive,
      options.importBatchProgressive,
      options.batchProgressive,
      importConfig.importBatchProgressive,
      importConfig.batchProgressive,
      true
    ),
    importBatchCoalesceMs: firstDefined(
      args.importBatchCoalesceMs,
      args.import_batch_coalesce_ms,
      args.batchCoalesceMs,
      args.batch_coalesce_ms,
      options.importBatchCoalesceMs,
      options.batchCoalesceMs,
      importConfig.importBatchCoalesceMs,
      importConfig.batchCoalesceMs,
      0
    ),
    importBatchCoalescePollMs: firstDefined(
      args.importBatchCoalescePollMs,
      args.import_batch_coalesce_poll_ms,
      args.batchCoalescePollMs,
      args.batch_coalesce_poll_ms,
      options.importBatchCoalescePollMs,
      options.batchCoalescePollMs,
      importConfig.importBatchCoalescePollMs,
      importConfig.batchCoalescePollMs
    ),
    importBatchMaxFiles: firstDefined(
      args.importBatchMaxFiles,
      args.import_batch_max_files,
      args.batchMaxFiles,
      args.batch_max_files,
      options.importBatchMaxFiles,
      options.batchMaxFiles,
      importConfig.importBatchMaxFiles,
      importConfig.batchMaxFiles,
      importConfig.maxFiles
    ),
    importBatchMaxBytes: firstDefined(
      args.importBatchMaxBytes,
      args.import_batch_max_bytes,
      args.batchMaxBytes,
      args.batch_max_bytes,
      options.importBatchMaxBytes,
      options.batchMaxBytes,
      importConfig.importBatchMaxBytes,
      importConfig.batchMaxBytes,
      importConfig.maxBytes
    )
  };
}

function buildLlmDiscoveryParams(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const llmConfig = normalizeObject(config.llm);
  const ollamaConfig = normalizeObject(config.ollama);
  const fallbackConfig = normalizeObject(llmConfig.fallback);
  const fallbackOllamaConfig = normalizeObject(fallbackConfig.ollamaBootstrap || fallbackConfig.ollama);

  return {
    llmQueryPlanner: firstDefined(args.llmQueryPlanner, args.llm_query_planner),
    maxLlmQueries: firstDefined(args.maxLlmQueries, args.max_llm_queries),
    llmProvider: firstDefined(args.llmProvider, args.llm_provider, llmConfig.provider),
    llmModel: firstDefined(args.llmModel, args.llm_model, args.ollamaModel, args.ollama_model, llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(args.llmBaseUrl, args.llm_base_url, args.ollamaUrl, args.ollama_url, llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(args.llmApiKey, args.llm_api_key, llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(args.llmApiKeyEnv, args.llm_api_key_env, llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(args.llmApiKeySource, args.llm_api_key_source, llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(args.llmApiKeyService, args.llm_api_key_service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(args.llmApiKeyAccount, args.llm_api_key_account, llmConfig.apiKeyAccount),
    llmTimeoutMs: firstDefined(args.llmTimeoutMs, args.llm_timeout_ms, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmMaxTokens: firstDefined(args.llmMaxTokens, args.llm_max_tokens, llmConfig.maxTokens),
    llmFallbackProvider: firstDefined(args.llmFallbackProvider, args.llm_fallback_provider, fallbackConfig.provider),
    llmFallbackModel: firstDefined(args.llmFallbackModel, args.llm_fallback_model, fallbackConfig.model),
    llmFallbackBaseUrl: firstDefined(args.llmFallbackBaseUrl, args.llm_fallback_base_url, fallbackConfig.baseUrl, fallbackConfig.url),
    llmFallbackApiKey: firstDefined(args.llmFallbackApiKey, args.llm_fallback_api_key, fallbackConfig.apiKey),
    llmFallbackApiKeyEnv: firstDefined(args.llmFallbackApiKeyEnv, args.llm_fallback_api_key_env, fallbackConfig.apiKeyEnv),
    llmFallbackApiKeySource: firstDefined(args.llmFallbackApiKeySource, args.llm_fallback_api_key_source, fallbackConfig.apiKeySource),
    llmFallbackApiKeyService: firstDefined(args.llmFallbackApiKeyService, args.llm_fallback_api_key_service, fallbackConfig.apiKeyService),
    llmFallbackApiKeyAccount: firstDefined(args.llmFallbackApiKeyAccount, args.llm_fallback_api_key_account, fallbackConfig.apiKeyAccount),
    llmFallbackTimeoutMs: firstDefined(args.llmFallbackTimeoutMs, args.llm_fallback_timeout_ms, fallbackConfig.timeoutMs),
    llmFallbackMaxTokens: firstDefined(args.llmFallbackMaxTokens, args.llm_fallback_max_tokens, fallbackConfig.maxTokens),
    llmFallbackAutoStart: firstDefined(args.llmFallbackAutoStart, args.llm_fallback_auto_start, fallbackConfig.autoStart),
    llmFallbackAutoPull: firstDefined(args.llmFallbackAutoPull, args.llm_fallback_auto_pull, fallbackConfig.autoPull),
    llmFallbackOllamaBootstrap: firstDefined(args.llmFallbackOllamaBootstrap, args.llm_fallback_ollama_bootstrap, fallbackOllamaConfig.mode)
  };
}

function buildDiscoveryParams(rootPath, args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const discoveryConfig = normalizeObject(config.literatureDiscovery || config.literature_discovery || config.discovery);
  return {
    rootPath,
    topic: args.topic || args.query,
    depth: firstDefined(args.depth, discoveryConfig.depth, 'deep'),
    operation: args.operation,
    discoveryOperation: args.operation,
    searchMode: firstDefined(args.searchMode, args.search_mode, discoveryConfig.searchMode, discoveryConfig.search_mode, 'deep'),
    searchBudgetMs: firstDefined(args.searchBudgetMs, args.search_budget_ms, discoveryConfig.searchBudgetMs, discoveryConfig.search_budget_ms),
    discoveryBudgetMs: firstDefined(args.discoveryBudgetMs, args.discovery_budget_ms, discoveryConfig.discoveryBudgetMs, discoveryConfig.discovery_budget_ms),
    budgetMs: firstDefined(args.budgetMs, args.budget_ms, discoveryConfig.budgetMs, discoveryConfig.budget_ms),
    maxQueriesPerProvider: firstDefined(args.maxQueriesPerProvider, args.max_queries_per_provider, discoveryConfig.maxQueriesPerProvider, discoveryConfig.max_queries_per_provider),
    minProviderQueryBudgetMs: firstDefined(args.minProviderQueryBudgetMs, args.min_provider_query_budget_ms, discoveryConfig.minProviderQueryBudgetMs, discoveryConfig.min_provider_query_budget_ms),
    returnPartial: firstDefined(args.returnPartial, args.return_partial, discoveryConfig.returnPartial, discoveryConfig.return_partial),
    skipRemainingProviderQueriesOnRateLimit: firstDefined(
      args.skipRemainingProviderQueriesOnRateLimit,
      args.skip_remaining_provider_queries_on_rate_limit,
      discoveryConfig.skipRemainingProviderQueriesOnRateLimit,
      discoveryConfig.skip_remaining_provider_queries_on_rate_limit
    ),
    planningMode: firstDefined(args.planningMode, args.planning_mode, discoveryConfig.planningMode, discoveryConfig.planning_mode),
    discipline: firstDefined(args.discipline, discoveryConfig.discipline),
    maxQueries: firstDefined(args.maxQueries, args.max_queries, discoveryConfig.maxQueries, discoveryConfig.max_queries),
    maxResultsPerQuery: firstDefined(args.maxResultsPerQuery, args.max_results_per_query, discoveryConfig.maxResultsPerQuery, discoveryConfig.max_results_per_query),
    maxCandidates: firstDefined(args.maxCandidates, args.max_candidates, discoveryConfig.maxCandidates, discoveryConfig.max_candidates),
    providerConcurrency: firstDefined(
      args.providerConcurrency,
      args.provider_concurrency,
      args.maxProviderThreads,
      args.max_provider_threads,
      discoveryConfig.providerConcurrency,
      discoveryConfig.provider_concurrency,
      discoveryConfig.maxProviderThreads,
      discoveryConfig.max_provider_threads
    ),
    providerRequestSchedulerDelayMs: firstDefined(args.providerRequestSchedulerDelayMs, args.provider_request_scheduler_delay_ms, discoveryConfig.providerRequestSchedulerDelayMs, discoveryConfig.provider_request_scheduler_delay_ms),
    providerRequestMaxConcurrent: firstDefined(args.providerRequestMaxConcurrent, args.provider_request_max_concurrent, discoveryConfig.providerRequestMaxConcurrent, discoveryConfig.provider_request_max_concurrent),
    discoveryRequestCache: firstDefined(args.discoveryRequestCache, args.discovery_request_cache, discoveryConfig.discoveryRequestCache, discoveryConfig.discovery_request_cache),
    discoveryRequestCacheTtlMs: firstDefined(args.discoveryRequestCacheTtlMs, args.discovery_request_cache_ttl_ms, discoveryConfig.discoveryRequestCacheTtlMs, discoveryConfig.discovery_request_cache_ttl_ms),
    discoveryRequestMaxResponseBytes: firstDefined(args.discoveryRequestMaxResponseBytes, args.discovery_request_max_response_bytes, discoveryConfig.discoveryRequestMaxResponseBytes, discoveryConfig.discovery_request_max_response_bytes),
    openAlexRequestDelayMs: firstDefined(args.openAlexRequestDelayMs, args.openalexRequestDelayMs, args.openalex_request_delay_ms, discoveryConfig.openAlexRequestDelayMs, discoveryConfig.openalexRequestDelayMs, discoveryConfig.openalex_request_delay_ms),
    openAlexMaxConcurrent: firstDefined(args.openAlexMaxConcurrent, args.openalexMaxConcurrent, args.openalex_max_concurrent, discoveryConfig.openAlexMaxConcurrent, discoveryConfig.openalexMaxConcurrent, discoveryConfig.openalex_max_concurrent),
    semanticScholarRequestDelayMs: firstDefined(
      args.semanticScholarRequestDelayMs,
      args.semantic_scholar_request_delay_ms,
      args.s2RequestDelayMs,
      args.s2_request_delay_ms,
      discoveryConfig.semanticScholarRequestDelayMs,
      discoveryConfig.semantic_scholar_request_delay_ms,
      discoveryConfig.s2RequestDelayMs,
      discoveryConfig.s2_request_delay_ms
    ),
    semanticScholarMaxConcurrent: firstDefined(args.semanticScholarMaxConcurrent, args.semantic_scholar_max_concurrent, discoveryConfig.semanticScholarMaxConcurrent, discoveryConfig.semantic_scholar_max_concurrent),
    papersCoolBaseUrl: firstDefined(args.papersCoolBaseUrl, args.papers_cool_base_url, discoveryConfig.papersCoolBaseUrl, discoveryConfig.papers_cool_base_url),
    papersCoolSort: firstDefined(args.papersCoolSort, args.papers_cool_sort, discoveryConfig.papersCoolSort, discoveryConfig.papers_cool_sort),
    papersCoolMaxQueries: firstDefined(args.papersCoolMaxQueries, args.papers_cool_max_queries, discoveryConfig.papersCoolMaxQueries, discoveryConfig.papers_cool_max_queries),
    pasaApiBaseUrl: firstDefined(args.pasaApiBaseUrl, args.pasa_api_base_url, discoveryConfig.pasaApiBaseUrl, discoveryConfig.pasa_api_base_url),
    pasaRequestTimeoutMs: firstDefined(args.pasaRequestTimeoutMs, args.pasa_request_timeout_ms, discoveryConfig.pasaRequestTimeoutMs, discoveryConfig.pasa_request_timeout_ms),
    pasaTimeoutSeconds: firstDefined(args.pasaTimeoutSeconds, args.pasa_timeout_seconds, discoveryConfig.pasaTimeoutSeconds, discoveryConfig.pasa_timeout_seconds),
    pasaPollIntervalSeconds: firstDefined(args.pasaPollIntervalSeconds, args.pasa_poll_interval_seconds, discoveryConfig.pasaPollIntervalSeconds, discoveryConfig.pasa_poll_interval_seconds),
    pasaMaxQueries: firstDefined(args.pasaMaxQueries, args.pasa_max_queries, discoveryConfig.pasaMaxQueries, discoveryConfig.pasa_max_queries),
    maxDownloads: firstDefined(args.maxDownloads, args.max_downloads, discoveryConfig.maxDownloads, discoveryConfig.max_downloads),
    downloadConcurrency: firstDefined(
      args.downloadConcurrency,
      args.download_concurrency,
      args.maxDownloadThreads,
      args.max_download_threads,
      discoveryConfig.downloadConcurrency,
      discoveryConfig.download_concurrency,
      discoveryConfig.maxDownloadThreads,
      discoveryConfig.max_download_threads
    ),
    preferMarkdown: firstDefined(args.preferMarkdown, args.prefer_markdown, discoveryConfig.preferMarkdown, discoveryConfig.prefer_markdown),
    generateArxivMarkdownSources: firstDefined(args.generateArxivMarkdownSources, args.generate_arxiv_markdown_sources, discoveryConfig.generateArxivMarkdownSources, discoveryConfig.generate_arxiv_markdown_sources),
    markdownStagingRoot: firstDefined(args.markdownStagingRoot, args.markdown_staging_root, args.mdStagingRoot, args.md_staging_root, discoveryConfig.markdownStagingRoot, discoveryConfig.markdown_staging_root, discoveryConfig.mdStagingRoot, discoveryConfig.md_staging_root),
    pdfStagingRoot: firstDefined(args.pdfStagingRoot, args.pdf_staging_root, discoveryConfig.pdfStagingRoot, discoveryConfig.pdf_staging_root),
    providers: firstDefined(args.providers, discoveryConfig.providers),
    mailto: firstDefined(args.mailto, args.email, discoveryConfig.mailto, discoveryConfig.email),
    unpaywallEmail: firstDefined(args.unpaywallEmail, args.unpaywall_email, discoveryConfig.unpaywallEmail, discoveryConfig.unpaywall_email),
    openAlexApiKey: firstDefined(
      args.openAlexApiKey,
      args.openalexApiKey,
      args.openalex_api_key,
      discoveryConfig.openAlexApiKey,
      discoveryConfig.openalexApiKey,
      discoveryConfig.openalex_api_key
    ),
    openAlexApiKeyFile: firstDefined(
      args.openAlexApiKeyFile,
      args.openAlexApiKeyPath,
      args.openalexApiKeyFile,
      args.openalexApiKeyPath,
      args.openalex_api_key_file,
      args.openalex_api_key_path,
      discoveryConfig.openAlexApiKeyFile,
      discoveryConfig.openAlexApiKeyPath,
      discoveryConfig.openalexApiKeyFile,
      discoveryConfig.openalexApiKeyPath,
      discoveryConfig.openalex_api_key_file,
      discoveryConfig.openalex_api_key_path
    ),
    semanticScholarApiKey: firstDefined(
      args.semanticScholarApiKey,
      args.semantic_scholar_api_key,
      args.s2ApiKey,
      args.s2_api_key,
      discoveryConfig.semanticScholarApiKey,
      discoveryConfig.semantic_scholar_api_key,
      discoveryConfig.s2ApiKey,
      discoveryConfig.s2_api_key
    ),
    coreApiKey: firstDefined(args.coreApiKey, args.core_api_key, discoveryConfig.coreApiKey, discoveryConfig.core_api_key),
    timeoutMs: firstDefined(args.timeoutMs, args.timeout_ms, discoveryConfig.timeoutMs, discoveryConfig.timeout_ms),
    retryCount: firstDefined(args.retryCount, args.retry_count, discoveryConfig.retryCount, discoveryConfig.retry_count),
    retryBackoffMs: firstDefined(args.retryBackoffMs, args.retry_backoff_ms, discoveryConfig.retryBackoffMs, discoveryConfig.retry_backoff_ms),
    providerRequestDelayMs: firstDefined(args.providerRequestDelayMs, args.provider_request_delay_ms, discoveryConfig.providerRequestDelayMs, discoveryConfig.provider_request_delay_ms),
    maxRetryAfterMs: firstDefined(args.maxRetryAfterMs, args.max_retry_after_ms, discoveryConfig.maxRetryAfterMs, discoveryConfig.max_retry_after_ms),
    resolveSources: firstDefined(args.resolveSources, args.resolve_sources, discoveryConfig.resolveSources, discoveryConfig.resolve_sources),
    allowDownloads: firstDefined(args.allowDownloads, args.allow_downloads, discoveryConfig.allowDownloads, discoveryConfig.allow_downloads),
    seedPapers: args.seedPapers || args.seed_papers || args.knownPapers || args.known_papers,
    sourceIndex: args.sourceIndex || args.source_index,
    maxSeedPapers: args.maxSeedPapers || args.max_seed_papers,
    maxSeedQueries: args.maxSeedQueries || args.max_seed_queries,
    entitySeeds: args.entitySeeds || args.entity_seeds,
    datasetSeeds: args.datasetSeeds || args.dataset_seeds,
    benchmarkSeeds: args.benchmarkSeeds || args.benchmark_seeds,
    seedTexts: args.seedTexts || args.seed_texts || args.sourceTexts || args.source_texts,
    maxSeedEntities: args.maxSeedEntities || args.max_seed_entities,
    maxExtractedEntities: args.maxExtractedEntities || args.max_extracted_entities,
    maxEntityQueries: args.maxEntityQueries || args.max_entity_queries,
    citationExpansion: firstDefined(args.citationExpansion, args.citation_expansion, discoveryConfig.citationExpansion, discoveryConfig.citation_expansion),
    maxCitationSeeds: firstDefined(args.maxCitationSeeds, args.max_citation_seeds, discoveryConfig.maxCitationSeeds, discoveryConfig.max_citation_seeds),
    maxCitationsPerSeed: firstDefined(args.maxCitationsPerSeed, args.max_citations_per_seed, discoveryConfig.maxCitationsPerSeed, discoveryConfig.max_citations_per_seed),
    maxRelatedPerSeed: firstDefined(args.maxRelatedPerSeed, args.max_related_per_seed, discoveryConfig.maxRelatedPerSeed, discoveryConfig.max_related_per_seed),
    openAlexRelatedExpansion: firstDefined(
      args.openAlexRelatedExpansion,
      args.openalexRelatedExpansion,
      args.openalex_related_expansion,
      discoveryConfig.openAlexRelatedExpansion,
      discoveryConfig.openalexRelatedExpansion,
      discoveryConfig.openalex_related_expansion
    ),
    institutionalResolverBaseUrl: args.institutionalResolverBaseUrl || args.institutional_resolver_base_url,
    institutionalAccessMode: firstDefined(args.institutionalAccessMode, args.institutional_access_mode, discoveryConfig.institutionalAccessMode, discoveryConfig.institutional_access_mode),
    browserProfileDir: firstDefined(args.browserProfileDir, args.browser_profile_dir, discoveryConfig.browserProfileDir, discoveryConfig.browser_profile_dir),
    browserProfileName: firstDefined(args.browserProfileName, args.browser_profile_name, discoveryConfig.browserProfileName, discoveryConfig.browser_profile_name),
    browserExecutablePath: firstDefined(args.browserExecutablePath, args.browser_executable_path, discoveryConfig.browserExecutablePath, discoveryConfig.browser_executable_path),
    browserChannel: firstDefined(args.browserChannel, args.browser_channel, discoveryConfig.browserChannel, discoveryConfig.browser_channel),
    browserHeadless: firstDefined(args.browserHeadless, args.browser_headless, discoveryConfig.browserHeadless, discoveryConfig.browser_headless),
    browserDownloadTimeoutMs: firstDefined(args.browserDownloadTimeoutMs, args.browser_download_timeout_ms, discoveryConfig.browserDownloadTimeoutMs, discoveryConfig.browser_download_timeout_ms),
    browserAuthHosts: firstDefined(args.browserAuthHosts, args.browser_auth_hosts, discoveryConfig.browserAuthHosts, discoveryConfig.browser_auth_hosts),
    browserAuthUrlFragments: firstDefined(args.browserAuthUrlFragments, args.browser_auth_url_fragments, discoveryConfig.browserAuthUrlFragments, discoveryConfig.browser_auth_url_fragments),
    browserAuthPageTitles: firstDefined(args.browserAuthPageTitles, args.browser_auth_page_titles, discoveryConfig.browserAuthPageTitles, discoveryConfig.browser_auth_page_titles),
    persist: args.persist,
    ...buildLlmDiscoveryParams(args, options)
  };
}

function applyImportResultsToRun(run, importResult) {
  const importsByKey = importResultsByKey(importResult);
  return {
    ...run,
    candidates: (run.candidates || []).map((candidate) => {
      const importEntry = findImportResultForCandidate(candidate, importsByKey);
      return {
        ...candidate,
        import: importEntry
          ? {
              status: importEntry.status,
              taskId: importEntry.taskId || null,
              taskStatus: importEntry.taskStatus || importEntry.status || '',
              taskStage: importEntry.taskStage || '',
              graphUpdate: importEntry.graphUpdate || null,
              error: importEntry.error || ''
            }
          : {
              status: 'not_submitted'
            }
      };
    }),
    importSummary: importResult
  };
}

function countAcceptedImportResults(importResult = {}) {
  const acceptedStatuses = new Set(['submitted', 'deduped', 'completed']);
  return (importResult.results || []).filter((entry) => acceptedStatuses.has(entry.status)).length;
}

function resolveSupplementTarget(run = {}, args = {}) {
  const candidateId = String(args.candidateId || args.candidate_id || '').trim();
  const canonicalId = String(args.canonicalId || args.canonical_id || '').trim();
  const title = String(args.title || args.paperTitle || args.paper_title || '').trim().toLowerCase();
  return (run.candidates || []).find((candidate) => {
    if (candidateId && (candidate.id === candidateId || candidate.candidateId === candidateId || candidate.candidate_id === candidateId)) return true;
    if (canonicalId && (candidate.canonicalId === canonicalId || candidate.canonical_id === canonicalId)) return true;
    if (title && String(candidate.title || '').trim().toLowerCase() === title) return true;
    return false;
  }) || null;
}

function inferSupplementSourceKind(sourcePath = '', explicit = '') {
  const requested = String(explicit || '').trim().toLowerCase();
  if (requested === 'markdown' || requested === 'md') return 'markdown';
  if (requested === 'pdf') return 'pdf';
  const extension = path.extname(String(sourcePath || '')).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.pdf') return 'pdf';
  return '';
}

function resolveLocalSupplementPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return process.env.HOME || raw;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2));
  return raw;
}

function mergeSupplementPaperMetadata(candidate = {}, args = {}) {
  const paperMetadata = normalizeObject(args.paperMetadata || args.paper_metadata);
  const identifiers = {
    ...(candidate.identifiers || {}),
    ...normalizeObject(paperMetadata.identifiers),
    ...normalizeObject(args.identifiers)
  };
  for (const key of ['doi', 'arxivId', 'pmid', 'pmcid', 'isbn', 'issn']) {
    if (args[key]) identifiers[key] = args[key];
    if (paperMetadata[key]) identifiers[key] = paperMetadata[key];
  }
  return {
    ...candidate,
    ...paperMetadata,
    title: args.title || paperMetadata.title || candidate.title,
    authors: paperMetadata.authors || candidate.authors,
    year: args.year || paperMetadata.year || candidate.year,
    identifiers
  };
}

async function createManualSupplementedCandidate(candidate = {}, args = {}) {
  const sourcePath = resolveLocalSupplementPath(args.sourcePath || args.source_path || args.serverFilePath || args.server_file_path);
  if (!sourcePath) return null;
  const sourceKind = inferSupplementSourceKind(sourcePath, args.sourceKind || args.source_kind);
  if (sourceKind !== 'markdown' && sourceKind !== 'pdf') {
    throw new Error('supplement sourcePath must point to a .md, .markdown, or .pdf file, or provide sourceKind.');
  }
  const stats = await fs.stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error('supplement sourcePath must point to a regular file.');
  }
  const buffer = await fs.readFile(sourcePath);
  const contentSha256 = createContentSha256(buffer);
  const sourceProvider = String(args.sourceProvider || args.source_provider || 'manual_supplement').trim();
  const next = mergeSupplementPaperMetadata(candidate, args);
  const identity = createSourceIdentity({
    ...next,
    sourceKind,
    sourceProvider,
    contentSha256,
    resolutionStatus: 'fulltext_ready'
  });

  return {
    ...next,
    source: {
      ...(next.source || {}),
      sourceKind,
      sourcePath,
      sourceProvider: identity.sourceProvider,
      contentSha256: identity.contentSha256,
      sourceId: identity.sourceId,
      resolutionStatus: 'fulltext_ready',
      fullTextStatus: sourceKind === 'markdown' ? 'open_markdown' : 'open_pdf',
      downloadStatus: 'downloaded',
      downloadError: null,
      localMarkdownPath: sourceKind === 'markdown' ? sourcePath : null,
      localPdfPath: sourceKind === 'pdf' ? sourcePath : null,
      markdownUrl: args.markdownUrl || args.markdown_url || next.source?.markdownUrl || '',
      pdfUrl: args.pdfUrl || args.pdf_url || next.source?.pdfUrl || '',
      supplementedAt: new Date().toISOString(),
      resolutionAttempts: [
        ...(next.source?.resolutionAttempts || []),
        {
          provider: identity.sourceProvider,
          sourceKind,
          status: 'success',
          detail: 'manual-supplement',
          path: sourcePath,
          at: new Date().toISOString()
        }
      ],
      supplementation: createDiscoverySupplementationInterface(next, {
        resolutionStatus: 'fulltext_ready'
      })
    }
  };
}

async function resolveUrlSupplementedCandidate(rootPath, candidate = {}, args = {}, options = {}) {
  const markdownUrl = String(args.markdownUrl || args.markdown_url || '').trim();
  const pdfUrl = String(args.pdfUrl || args.pdf_url || '').trim();
  if (!markdownUrl && !pdfUrl) return null;
  const supplemented = mergeSupplementPaperMetadata({
    ...candidate,
    markdownUrl: markdownUrl || candidate.markdownUrl,
    pdfUrl: pdfUrl || candidate.pdfUrl,
    sourceHints: [
      ...(candidate.sourceHints || []),
      markdownUrl,
      pdfUrl
    ].filter(Boolean),
    fullTextUrls: [
      ...(candidate.fullTextUrls || []),
      markdownUrl,
      pdfUrl
    ].filter(Boolean)
  }, args);
  const resolution = await resolveDiscoverySources({
    ...buildDiscoveryParams(rootPath, args, options),
    rootPath,
    candidates: [supplemented],
    maxDownloads: 1,
    allowDownloads: args.allowDownloads ?? args.allow_downloads ?? true,
    preferMarkdown: args.preferMarkdown ?? args.prefer_markdown ?? true
  });
  return resolution.candidates?.[0] || null;
}

function applySupplementCandidate(run = {}, candidate = {}) {
  return {
    ...run,
    candidates: (run.candidates || []).map((entry) => (
      entry === candidate
        || (candidate.canonicalId && (entry.canonicalId === candidate.canonicalId || entry.canonical_id === candidate.canonicalId))
        || (candidate.canonical_id && (entry.canonicalId === candidate.canonical_id || entry.canonical_id === candidate.canonical_id))
        || (candidate.id && (entry.id === candidate.id || entry.candidateId === candidate.id || entry.candidate_id === candidate.id))
        || (candidate.candidateId && (entry.id === candidate.candidateId || entry.candidateId === candidate.candidateId || entry.candidate_id === candidate.candidateId))
        || (candidate.candidate_id && (entry.id === candidate.candidate_id || entry.candidateId === candidate.candidate_id || entry.candidate_id === candidate.candidate_id))
        ? candidate
        : entry
    ))
  };
}

function applySupplementImportResultsToRun(run = {}, importResult = {}) {
  const importsByKey = importResultsByKey(importResult);
  return {
    ...run,
    candidates: (run.candidates || []).map((candidate) => {
      const importEntry = findImportResultForCandidate(candidate, importsByKey);
      if (!importEntry) return candidate;
      return {
        ...candidate,
        import: {
          status: importEntry.status,
          taskId: importEntry.taskId || null,
          taskStatus: importEntry.taskStatus || importEntry.status || '',
          taskStage: importEntry.taskStage || '',
          graphUpdate: importEntry.graphUpdate || null,
          error: importEntry.error || ''
        }
      };
    }),
    importSummary: importResult
  };
}

async function refreshImportTaskStatuses(rootPath, importResult = {}) {
  const results = [];

  for (const entry of importResult.results || []) {
    if (!entry.taskId) {
      results.push(entry);
      continue;
    }

    try {
      const task = await loadImportTask(rootPath, entry.taskId);
      const taskStatus = String(task?.status || '').trim().toLowerCase();
      const status = taskStatus === 'completed'
        ? 'completed'
        : (taskStatus === 'failed' ? 'failed' : entry.status);
      results.push({
        ...entry,
        status,
        taskStatus: taskStatus || entry.status,
        taskStage: task?.stage || '',
        graphUpdate: task?.result?.fastCommitted
          ? {
              paperCount: task.result.fastCommitted.paperCount || 0,
              nodeCount: task.result.fastCommitted.nodeCount || 0,
              relationshipCount: task.result.fastCommitted.relationshipCount || 0,
              authoritativeSyncStatus: task.result.authoritativeSync?.status || ''
            }
          : null,
        error: task?.error?.message || task?.error || entry.error || ''
      });
    } catch (error) {
      results.push({
        ...entry,
        status: entry.status,
        taskStatus: entry.status,
        error: entry.error || error?.message || ''
      });
    }
  }

  return {
    ...importResult,
    completed: results.filter((entry) => entry.status === 'completed').length,
    queued: results.filter((entry) => entry.status === 'submitted').length,
    deduped: results.filter((entry) => entry.status === 'deduped').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results
  };
}

export async function executeLiteratureDiscoveryTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation || 'run');

  if (operation === 'plan') {
    return JSON.stringify(await buildLiteratureDiscoveryRunPlan(buildDiscoveryParams(undefined, args, options)), null, 2);
  }

  const rootPath = await resolveCorpus(args.corpus);

  if (operation === 'list') {
    const progressRecords = await listDiscoveryProgress(rootPath, args.limit);
    return JSON.stringify({
      rootPath,
      runs: await listDiscoveryRuns(rootPath, args.limit),
      progress: await Promise.all(
        progressRecords.map((progress) => decorateDiscoveryProgressPayload(rootPath, progress, options))
      ),
      workerCoverage: (await buildDiscoveryDiagnostics(rootPath, {}, {}, options)).workerCoverage,
      generatedAt: new Date().toISOString()
    }, null, 2);
  }

  if (operation === 'submit') {
    const submittedOperation = resolveSubmittedDiscoveryOperation(args);
    const submittedAt = new Date().toISOString();
    const runId = compactText(args.runId || args.run_id) || createDiscoveryRunId(new Date(submittedAt));
    const topic = compactText(args.topic || args.query);
    const searchMode = compactText(args.searchMode || args.search_mode);
    const writer = createLiteratureDiscoveryProgressWriter(rootPath, {
      runId,
      rootPath,
      topic,
      operation: submittedOperation,
      searchMode,
      submittedAt
    });
    await writer({
      status: 'queued',
      stage: 'queued',
      event: 'submitted',
      submittedAt,
      recovery: {
        args: sanitizeDiscoveryRecoveryArgs({
          ...args,
          operation: submittedOperation,
          discoveryOperation: submittedOperation,
          discovery_operation: submittedOperation,
          runId,
          persist: true
        }),
        submittedAt
      }
    });

    const backgroundArgs = {
      ...args,
      operation: submittedOperation,
      discoveryOperation: submittedOperation,
      discovery_operation: submittedOperation,
      runId,
      persist: true
    };
    const backgroundOptions = {
      ...options,
      onLiteratureDiscoveryProgress: writer
    };

    setImmediate(() => {
      void executeLiteratureDiscoveryTool(backgroundArgs, backgroundOptions).catch(async (error) => {
        try {
          await writer({
            status: 'failed',
            stage: 'failed',
            event: 'failed',
            completedAt: new Date().toISOString(),
            error: safeProgressError(error)
          });
        } catch {
          // Background failure state is best-effort.
        }
      });
    });

    return JSON.stringify({
      contractVersion: 'literature-discovery-submit-v1',
      runId,
      rootPath,
      operation: submittedOperation,
      searchMode,
      status: 'submitted',
      stage: 'queued',
      submittedAt,
      progress: await loadDiscoveryProgress(rootPath, runId),
      next: {
        progress: {
          operation: 'progress',
          corpus: args.corpus || rootPath,
          runId
        },
        report: {
          operation: 'report',
          corpus: args.corpus || rootPath,
          runId
        }
      }
    }, null, 2);
  }

  if (operation === 'progress') {
    const progress = await loadDiscoveryProgress(rootPath, args.runId || args.run_id);
    if (!progress) {
      throw new Error('No literature discovery progress found.');
    }
    return JSON.stringify(await decorateDiscoveryProgressPayload(rootPath, progress, options), null, 2);
  }

  if (operation === 'status' || operation === 'report') {
    const run = await loadDiscoveryRun(rootPath, args.runId || args.run_id);
    if (run) {
      if (shouldReturnCandidatePage(args)) {
        return JSON.stringify(await decorateDiscoveryCandidatePagePayload(rootPath, run, args, options), null, 2);
      }
      return JSON.stringify(await decorateDiscoveryRunPayload(rootPath, run, options), null, 2);
    }
    const progress = await loadDiscoveryProgress(rootPath, args.runId || args.run_id);
    if (!progress) {
      throw new Error('No literature discovery run found.');
    }
    return JSON.stringify(await decorateDiscoveryProgressPayload(rootPath, progress, options), null, 2);
  }

  if (operation === 'supplement') {
    const run = await loadDiscoveryRun(rootPath, args.runId || args.run_id);
    if (!run) {
      throw new Error('No literature discovery run found to supplement.');
    }
    const target = resolveSupplementTarget(run, args);
    if (!target) {
      throw new Error('No matching literature discovery candidate found. Provide candidateId, canonicalId, or title.');
    }

    const supplemented = await createManualSupplementedCandidate(target, args)
      || await resolveUrlSupplementedCandidate(rootPath, target, args, options)
      || {
        ...mergeSupplementPaperMetadata(target, args),
        source: {
          ...(target.source || {}),
          supplementation: createDiscoverySupplementationInterface(target, target.source || {})
        }
      };

    let nextRun = applySupplementCandidate(run, supplemented);
    nextRun.metadataGraph = buildDiscoveryMetadataGraph(nextRun.candidates);
    nextRun.coverage = {
      ...nextRun.coverage,
      resolvedFullTextCount: nextRun.candidates.filter((candidate) => sourceResolutionStatus(candidate) === 'fulltext_ready').length,
      metadataOnlyCount: nextRun.candidates.filter((candidate) => sourceResolutionStatus(candidate) !== 'fulltext_ready').length
    };

    if (enabledFlag(firstDefined(args.importResolved, args.import_resolved, args.processImports, args.process_imports))) {
      let importResult = await submitDiscoveryImports({
        corpus: args.corpus || rootPath,
        candidates: [supplemented],
        maxImported: 1,
        options
      });
      if (shouldProcessImports(operation, args) || enabledFlag(firstDefined(args.processImports, args.process_imports))) {
        importResult = await refreshImportTaskStatuses(rootPath, importResult);
        const processableTaskCount = countProcessableImportTasks(importResult);
        const maxPasses = explicitImportMaxPasses(args, options);
        const processing = processableTaskCount > 0 || maxPasses !== undefined
          ? await runImportQueueUntilIdle(rootPath, buildImportProcessingOptions(args, options, importResult))
          : {
              completedTaskIds: [],
              failedCount: 0,
              skipped: true,
              reason: 'no-submitted-imports'
            };
        importResult = {
          ...(await refreshImportTaskStatuses(rootPath, importResult)),
          processing
        };
      }
      nextRun = applySupplementImportResultsToRun(nextRun, importResult);
      nextRun.coverage = {
        ...nextRun.coverage,
        importedCount: countAcceptedImportResults(importResult)
      };
    }

    if (args.persist !== false) {
      await saveDiscoveryRun(rootPath, nextRun);
    }
    return JSON.stringify(nextRun, null, 2);
  }

  if (
    operation === 'search'
    || operation === 'resolve'
    || operation === 'run'
    || operation === 'import'
    || operation === 'ingest'
    || operation === 'import_and_process'
  ) {
    const progressWriter = typeof options.onLiteratureDiscoveryProgress === 'function'
      ? options.onLiteratureDiscoveryProgress
      : null;
    const run = await runLiteratureDiscovery({
      ...buildDiscoveryParams(rootPath, args, options),
      runId: args.runId || args.run_id,
      operation,
      discoveryOperation: operation,
      resolveSources: operation === 'search' ? false : (args.resolveSources ?? args.resolve_sources),
      persist: args.persist !== false,
      deferCompletedProgress: shouldSubmitImports(operation, args),
      onProgress: progressWriter || undefined
    });

    if (shouldSubmitImports(operation, args)) {
      await progressWriter?.({
        runId: run.runId,
        topic: run.topic,
        operation,
        searchMode: run.diagnostics?.searchMode || '',
        status: 'running',
        stage: 'import_submit',
        event: 'import_submit_started',
        candidateCount: run.candidates.length
      });
      let importResult = await submitDiscoveryImports({
        corpus: args.corpus || rootPath,
        candidates: run.candidates,
        maxImported: args.maxImported || args.max_imported,
        options
      });
      await progressWriter?.({
        runId: run.runId,
        topic: run.topic,
        operation,
        searchMode: run.diagnostics?.searchMode || '',
        status: 'running',
        stage: 'import_submit',
        event: 'import_submit_completed',
        importSummary: {
          submitted: importResult.submitted || 0,
          deduped: importResult.deduped || 0,
          completed: importResult.completed || 0,
          failed: importResult.failed || 0
        }
      });
      if (shouldProcessImports(operation, args)) {
        importResult = await refreshImportTaskStatuses(rootPath, importResult);
        const processableTaskCount = countProcessableImportTasks(importResult);
        const maxPasses = explicitImportMaxPasses(args, options);
        await progressWriter?.({
          runId: run.runId,
          topic: run.topic,
          operation,
          searchMode: run.diagnostics?.searchMode || '',
          status: 'running',
          stage: 'import_processing',
          event: 'import_processing_started',
          processableTaskCount,
          maxPasses: maxPasses ?? null
        });
        const processing = processableTaskCount > 0 || maxPasses !== undefined
          ? await runImportQueueUntilIdle(rootPath, buildImportProcessingOptions(args, options, importResult))
          : {
              completedTaskIds: [],
              failedCount: 0,
              skipped: true,
              reason: 'no-submitted-imports'
            };
        importResult = {
          ...(await refreshImportTaskStatuses(rootPath, importResult)),
          processing
        };
        await progressWriter?.({
          runId: run.runId,
          topic: run.topic,
          operation,
          searchMode: run.diagnostics?.searchMode || '',
          status: 'running',
          stage: 'import_processing',
          event: 'import_processing_completed',
          processing
        });
      }
      const nextRun = applyImportResultsToRun(run, importResult);
      nextRun.coverage = {
        ...nextRun.coverage,
        importedCount: countAcceptedImportResults(importResult)
      };
      if (args.persist !== false) {
        await saveDiscoveryRun(rootPath, nextRun);
      }
      await progressWriter?.({
        runId: nextRun.runId,
        topic: nextRun.topic,
        operation,
        searchMode: nextRun.diagnostics?.searchMode || '',
        status: 'completed',
        stage: 'completed',
        event: 'completed',
        completedAt: new Date().toISOString(),
        coverage: nextRun.coverage,
        importSummary: nextRun.importSummary || null,
        artifacts: nextRun.artifacts || null
      });
      return JSON.stringify(nextRun, null, 2);
    }

    return JSON.stringify(run, null, 2);
  }

  throw new Error(`Unknown literature_discovery operation: ${args.operation || '<missing>'}`);
}
