import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, writeJson, withFileLock } from '../../lib/fs.js';
import { getCorpusPaths } from '../../storage/corpus-store.js';
import { loadDiscoveryRun } from '../discovery/store.js';
import { DEFAULT_DISCOVERY_PROVIDERS, KNOWN_DISCOVERY_PROVIDERS } from '../discovery/providers.js';
import { submitDiscoveryImports } from '../discovery/import-bridge.js';
import { executeLiteratureDiscoveryTool } from '../../mcp/tool-literature-discovery.js';
import { executeImportWorkflowTool } from '../../mcp/tool-import-workflow.js';
import { configuredWorkerCoveragePayload, loadCorpusLiteForApi, resolveCorpusForApi } from '../../server/api.js';
import { buildFieldEvolution } from '../graph/field-evolution.js';
import { matchFieldResearchPaper, selectFieldResearchCandidates, summarizeFieldResearchImports } from './field-research-scope.js';
import { recoverLineageExtractions } from './lineage-evidence.js';
import { recoverLineageRefinements } from './lineage-refinement.js';

export const FIELD_RESEARCH_VERSION = 'papernexus-field-research-v1';
const activeRuns = new Map();
const now = () => new Date().toISOString();
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const START_FIELDS = new Set(['query', 'targetDomain', 'fromYear', 'toYear', 'maxDepth', 'maxNodes', 'maxEdges', 'maxPapers', 'providers', 'idempotencyKey', 'dryRun']);

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateRunId(value) {
  const runId = String(value || '');
  if (!/^field-[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(runId)) throw requestError('Invalid field research runId.');
  return runId;
}

export function fieldResearchPaths(rootPath, runId) {
  const directory = path.join(getCorpusPaths(rootPath).corpusDir, 'field-research');
  const runs = path.join(directory, 'runs');
  const run = runId ? path.join(runs, validateRunId(runId)) : '';
  return { directory, runs, record: run && path.join(run, 'request.json'),
    submitLock: run && path.join(run, 'submit.lock'), executionLock: run && path.join(run, 'execution.lock'),
    latest: path.join(directory, 'latest.json') };
}

export function normalizeFieldResearchRequest(args = {}) {
  for (const key of Object.keys(args)) if (!START_FIELDS.has(key)) throw requestError(`Field research does not accept ${key}.`);
  const text = key => {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw requestError(`${key} must be text.`);
    const value = (args[key] || '').trim();
    if (value.length > 8000) throw requestError(`${key} is too long.`);
    return value;
  };
  const integer = (key, fallback, min, max) => {
    if (args[key] === undefined || args[key] === null || args[key] === '') return fallback;
    const value = Number(args[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw requestError(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const request = { query: text('query'), targetDomain: text('targetDomain'),
    fromYear: integer('fromYear', null, 1000, 9999), toYear: integer('toYear', null, 1000, 9999),
    maxPapers: integer('maxPapers', 20, 1, 100), maxDepth: integer('maxDepth', 2, 1, 4),
    maxNodes: integer('maxNodes', 180, 1, 500), maxEdges: integer('maxEdges', 350, 1, 1000) };
  if (!request.query && !request.targetDomain) throw requestError('Enter a query or targetDomain to research.');
  if (request.fromYear && request.toYear && request.fromYear > request.toYear) throw requestError('fromYear must not exceed toYear.');
  if (args.providers !== undefined) {
    if (!Array.isArray(args.providers) || !args.providers.length || args.providers.length > 8
      || args.providers.some(provider => !KNOWN_DISCOVERY_PROVIDERS.has(provider))) throw requestError('providers must contain 1–8 supported provider names.');
    request.providers = [...new Set(args.providers)].sort();
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw requestError('dryRun must be a boolean.');
  const key = text('idempotencyKey');
  if ((!key && !args.dryRun) || (key && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(key))) {
    throw requestError('Use a stable idempotencyKey of 1–160 letters, digits, dots, underscores, colons or hyphens.');
  }
  return { request, runId: key ? 'field-' + key : null, dryRun: args.dryRun === true };
}

function researchExecutionPlan(request, options) {
  const config = options.config || {};
  const discovery = config.literatureDiscovery || config.literature_discovery || config.discovery || {};
  const configured = Array.isArray(discovery.providers) ? discovery.providers
    : typeof discovery.providers === 'string' ? discovery.providers.split(',').map(value => value.trim()) : DEFAULT_DISCOVERY_PROVIDERS;
  const providers = request.providers || configured.filter(provider => KNOWN_DISCOVERY_PROVIDERS.has(provider));
  if (!providers.length) throw requestError('No supported literature discovery providers are configured.');
  return { providers, topic: [request.query, request.targetDomain].filter(Boolean).join(' — '),
    candidateWindow: Math.min(300, request.maxPapers * 3), maxPapers: request.maxPapers,
    maxQueries: 8, maxQueriesPerProvider: 3, searchBudgetMs: 120000,
    maxCitationSeeds: 3, maxCitationsPerSeed: 8, maxRelatedPerSeed: 4,
    selection: 'decade_round_robin_existing_relevance_order',
    processingProfile: 'full', completionPolicy: 'semantic-complete',
    effects: ['Search configured literature providers', 'Download available full text', 'Import missing papers using configured extraction', 'Wait for evidence and graph synchronization', 'Build the evolution map'],
    boundary: 'A bounded corpus expansion, not proof of complete field coverage. Extraction may use the configured LLM.' };
}

async function readFieldResearch(rootPath, runId) {
  const id = runId || (await readJson(fieldResearchPaths(rootPath).latest, null))?.runId;
  if (!id) return null;
  return readJson(fieldResearchPaths(rootPath, id).record, null);
}

async function runFieldResearch(rootPath, runId, options) {
  const paths = fieldResearchPaths(rootPath, runId);
  let acquired = false;
  try {
    await withFileLock(paths.executionLock, async () => {
      acquired = true;
      let record = await readFieldResearch(rootPath, runId);
      if (!record || record.importResults || record.error) return;
      const save = async update => {
        record = { ...record, ...update, updatedAt: now() };
        await writeJson(paths.record, record);
      };
      await save({ stage: 'discovery', startedAt: record.startedAt || now() });
      const dependencies = options.fieldResearchDependencies || {};
      let discovery = await loadDiscoveryRun(rootPath, record.discoveryRunId);
      if (!discovery) {
        const { graph } = await loadCorpusLiteForApi(rootPath, { ...options, cache: undefined });
        const papers = graph.nodes.filter(node => node.type === 'Paper');
        const plan = record.execution;
        const discover = dependencies.discover || executeLiteratureDiscoveryTool;
        discovery = decode(await discover({ operation: 'run', corpus: rootPath, runId: record.discoveryRunId,
          query: plan.topic, providers: plan.providers, depth: 'deep', maxQueries: plan.maxQueries,
          maxQueriesPerProvider: plan.maxQueriesPerProvider, searchBudgetMs: plan.searchBudgetMs,
          maxResultsPerQuery: Math.min(100, plan.candidateWindow), maxCandidates: plan.candidateWindow,
          maxDownloads: plan.maxPapers, citationExpansion: true, maxCitationSeeds: plan.maxCitationSeeds,
          maxCitationsPerSeed: plan.maxCitationsPerSeed, maxRelatedPerSeed: plan.maxRelatedPerSeed,
          resolveSources: true, allowDownloads: true, persist: true
        }, { ...options,
          selectDiscoveryCandidates: (candidates, context) => selectFieldResearchCandidates(candidates, {
            papers, request: record.request, phase: context.phase
          }),
          onLiteratureDiscoveryProgress: async progress => {
            await save({ stage: ['source_resolution'].includes(progress.stage) ? 'full_text' : 'discovery',
              progress: { stage: progress.stage, event: progress.event, candidateCount: progress.candidateCount,
                rawCandidateCount: progress.rawCandidateCount, queryCount: progress.queryCount,
                providers: progress.providers, budget: progress.budget, coverage: progress.coverage } });
          }
        }));
      }
      await save({ stage: 'import_submission', discoveryCompletedAt: now() });
      const submit = dependencies.submitImports || submitDiscoveryImports;
      const imports = await submit({ corpus: rootPath, candidates: discovery.candidates || [],
        maxImported: record.request.maxPapers, processingProfile: 'full', completionPolicy: 'semantic-complete', options });
      await save({ stage: 'evidence', importResults: { submitted: imports.submitted, deduped: imports.deduped, failed: imports.failed,
        results: (imports.results || []).map(({ payload, ...entry }) => entry) }, submittedImportsAt: now() });
    }, { timeoutMs: 250, staleMs: 30000, heartbeatIntervalMs: 5000 });
  } catch (error) {
    if (!acquired) return;
    const record = await readFieldResearch(rootPath, runId);
    if (record) await writeJson(paths.record, { ...record, stage: 'failed', updatedAt: now(),
      error: { message: error.message || String(error), stage: record.stage, at: now() } });
    options.logger?.warn?.(`[field-research] ${runId}: ${error.message}`);
  }
}

function launchFieldResearch(rootPath, runId, options) {
  const key = fieldResearchPaths(rootPath, runId).record;
  if (activeRuns.has(key)) return activeRuns.get(key);
  const running = new Promise(resolve => setImmediate(resolve))
    .then(() => runFieldResearch(rootPath, runId, options))
    .catch(error => options.logger?.warn?.(`[field-research] ${runId}: ${error.message}`))
    .finally(() => activeRuns.delete(key));
  activeRuns.set(key, running);
  return running;
}

async function startFieldResearch(rootPath, args, options) {
  const { request, runId, dryRun } = normalizeFieldResearchRequest(args);
  const execution = researchExecutionPlan(request, options);
  const workerCoverage = await configuredWorkerCoveragePayload(rootPath, options);
  const workers = options.fieldResearchWorkers;
  const unavailable = !workerCoverage.covered || workers?.imports === false || workers?.synchronization === false;
  if (dryRun) return { contractVersion: FIELD_RESEARCH_VERSION, dryRun: true, request, execution,
    readiness: { ready: !unavailable, workerCoverage, workers: workers || null }, status: 'planned' };
  const paths = fieldResearchPaths(rootPath, runId);
  const response = await withFileLock(paths.submitLock, async () => {
    const previous = await readFieldResearch(rootPath, runId);
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw requestError('idempotencyKey is already used for a different field research request.', 409);
      return { record: previous, replayed: true };
    }
    if (unavailable) throw requestError('This corpus needs an enabled import worker and graph synchronization worker. Add it to the server worker roots and enable both before researching.', 409);
    const record = { contractVersion: FIELD_RESEARCH_VERSION, runId, discoveryRunId: runId,
      request, execution, stage: 'queued', createdAt: now(), updatedAt: now(), importResults: null, error: null };
    await writeJson(paths.record, record);
    await writeJson(paths.latest, { runId, createdAt: record.createdAt });
    return { record, replayed: false };
  });
  if (!response.record.importResults && !response.record.error) launchFieldResearch(rootPath, runId, options);
  return { contractVersion: FIELD_RESEARCH_VERSION, runId, status: response.record.error ? 'failed' : 'submitted',
    stage: response.record.stage, request, execution: response.record.execution, replayed: response.replayed,
    next: { operation: 'field_research_status', runId }, createdAt: response.record.createdAt };
}

async function fieldResearchStatus(rootPath, runId, options) {
  const record = await readFieldResearch(rootPath, runId);
  if (!record) return { contractVersion: FIELD_RESEARCH_VERSION, status: 'not_found', terminal: true, runId: runId || null };
  const base = { contractVersion: FIELD_RESEARCH_VERSION, runId: record.runId, request: record.request,
    execution: record.execution, createdAt: record.createdAt, updatedAt: record.updatedAt,
    progress: record.progress || null, discoveryRunId: record.discoveryRunId, terminal: false,
    coverageAssessment: { status: 'not_assessed',
      basis: 'This run processes one bounded paper batch. Field coverage requires a separate branch and citation review in a saved study.' } };
  const discovery = await loadDiscoveryRun(rootPath, record.discoveryRunId);
  const selection = discovery?.candidateSelection || null;
  const candidates = discovery?.candidates || [];
  const sources = candidates.map(candidate => ({ candidateId: candidate.id || candidate.canonicalId,
    title: candidate.title, year: candidate.year || null, identifiers: candidate.identifiers || {},
    providers: candidate.providers || [candidate.provider].filter(Boolean),
    resolutionStatus: candidate.source?.resolutionStatus || 'metadata_only',
    url: candidate.source?.landingPageUrl || candidate.landingPageUrl || candidate.url || null,
    reason: candidate.source?.downloadError || null }));
  const survey = discovery ? { topic: discovery.topic, plan: discovery.plan, providers: discovery.providers,
    queryResults: discovery.queryResults, coverage: discovery.coverage, partial: discovery.partial || false,
    candidateSelection: selection && { basis: selection.basis, counts: selection.counts, reviewedCount: selection.reviewedCount,
      selectedCount: selection.selectedCount, existing: selection.existing }, sources } : null;
  if (record.error) return { ...base, status: 'failed', stage: record.error.stage, terminal: true, survey, issues: [record.error] };
  if (!record.importResults) return { ...base, status: record.stage === 'queued' ? 'queued' : 'running', stage: record.stage, survey };
  const ids = [...new Set(record.importResults.results.map(entry => entry.taskId).filter(Boolean))];
  const reader = options.fieldResearchDependencies?.readImports || executeImportWorkflowTool;
  const imported = ids.length ? decode(await reader({ operation: 'status', corpus: rootPath, taskIds: ids }, { ...options, portablePaths: false }))
    : { tasks: [], missingTaskIds: [] };
  const imports = summarizeFieldResearchImports(record.importResults, imported.tasks, imported.missingTaskIds);
  const issues = [...imports.issues];
  for (const source of sources) if (source.resolutionStatus !== 'fulltext_ready') issues.push({
    stage: 'full_text', candidateId: source.candidateId, message: source.reason || `Full text unavailable: ${source.title}` });
  const failures = discovery?.coverage?.providerFailureSummary || [];
  for (const failure of failures) issues.push({ stage: 'discovery', message: `${failure.provider}: ${failure.reason || 'Provider query failed.'}` });
  if (!discovery) issues.push({ stage: 'discovery', message: 'The saved discovery report is missing.' });
  const status = { ...base, status: imports.stage === 'needs_attention' ? 'needs_attention' : 'running',
    stage: imports.stage, terminal: imports.terminal, survey, imports, issues };
  if (!discovery) return { ...status, status: 'needs_attention', stage: 'discovery_report', terminal: false };
  if (!imports.terminal) return status;

  const { graph, meta, quality } = await loadCorpusLiteForApi(rootPath, { ...options, cache: undefined });
  const papers = graph.nodes.filter(node => node.type === 'Paper');
  const taskMap = new Map((imported.tasks || []).map(task => [task.id, task]));
  const ready = new Set(imports.readyTaskIds);
  const linked = [];
  for (const entry of record.importResults.results) {
    if (!ready.has(entry.taskId)) continue;
    const task = taskMap.get(entry.taskId);
    const paperId = matchFieldResearchPaper(entry, papers, [entry.sourcePath, ...(task?.files || []).map(file => file.storedPath)]);
    if (paperId) linked.push(paperId);
    else issues.push({ stage: 'graph_readiness', taskId: entry.taskId, message: `Cannot uniquely locate an admitted paper for ${entry.title || entry.candidateId}.` });
  }
  for (const existing of selection?.existing || []) {
    const paperId = papers.some(paper => paper.id === existing.paperId) ? existing.paperId : matchFieldResearchPaper(existing, papers);
    if (paperId) linked.push(paperId);
  }
  const current = buildFieldEvolution(graph, record.request);
  const anchors = [...new Set([...linked, ...current.papers.filter(node => node.scopeRole === 'core').map(node => node.id),
    ...current.methods.filter(node => node.scopeRole === 'core').map(node => node.id)])];
  const result = anchors.length ? buildFieldEvolution(graph, { ...record.request, seedNodeIds: anchors.slice(0, 500) }) : current;
  result.scope.research = { runId: record.runId, basis: 'current_query_core_and_identified_research_papers',
    linkedPaperIds: [...new Set(linked)], omittedSeedCount: Math.max(0, anchors.length - 500) };
  if (anchors.length > 500) issues.push({ stage: 'map', message: `${anchors.length - 500} additional anchors exceed the research seed budget.` });
  if (!candidates.length && !(selection?.existing?.length)) issues.push({ stage: 'discovery', message: 'No papers were selected by this search.' });
  if (!result.relations.length) issues.push({ stage: 'evidence', message: 'No validated method evolution relations are available in this map.' });
  const partial = issues.length > 0 || discovery.partial || result.scope.truncated || Number(selection?.counts?.budget_omitted || 0) > 0;
  return { ...status, status: partial ? 'partial' : 'completed', stage: 'map', terminal: true,
    analysis: { meta, sourceQuality: quality, result, generatedAt: now() } };
}

export async function executeFieldResearchOperation(candidate, operation, args = {}, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (operation === 'start') return startFieldResearch(rootPath, args, options);
  if (operation !== 'status') throw requestError('Unknown field research operation.');
  if (Object.keys(args).some(key => key !== 'runId')) throw requestError('Field research status accepts runId only.');
  if (args.runId) validateRunId(args.runId);
  return fieldResearchStatus(rootPath, args.runId, options);
}

export function startFieldResearchRecoveryWorker(options = {}) {
  let stopped = false;
  let polling = false;
  const pollNow = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      for (const rootPath of options.rootPaths || options.workerRootPaths || []) {
        await recoverLineageExtractions(rootPath, options);
        await recoverLineageRefinements(rootPath, options);
        if (options.fieldResearchWorkers?.imports === false) continue;
        const runs = await fs.readdir(fieldResearchPaths(rootPath).runs).catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        for (const runId of runs) {
          if (!/^field-[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(runId)) continue;
          const record = await readFieldResearch(rootPath, runId);
          if (record && !record.importResults && !record.error) launchFieldResearch(rootPath, runId, options);
        }
      }
    } catch (error) { options.logger?.warn?.(`[field-research] recovery: ${error.message}`); }
    finally { polling = false; }
  };
  const timer = setInterval(pollNow, options.fieldResearchRecoveryIntervalMs || 15000);
  timer.unref?.();
  void pollNow();
  return { pollNow, stop() { stopped = true; clearInterval(timer); } };
}
