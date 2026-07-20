import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { buildBrainstorm, buildContext, buildImpact, buildResearchIdeas, searchGraph } from '../core/search/search.js';
import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy } from '../core/graph/domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from '../core/graph/interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from '../core/graph/takeaway-extraction.js';
import { renderBrainstormResult, renderContextResult, renderCorpusList, renderIdeasResult, renderImpactResult, renderMutationResult, renderQueryResult, renderStatus } from '../lib/render.js';
import { applyCorpusMutations, loadCorpus, loadCorpusLite, loadSourceManifest, resolveCorpus } from '../storage/corpus-store.js';
import { loadRegistry } from '../storage/registry.js';
import { getDefaultRuntimeConfigRoot, loadRuntimeConfig, resolvePathWithHome, saveRuntimeConfig } from '../lib/config.js';
import { ensureDir, fileExists, readJson, writeJson } from '../lib/fs.js';
import { PAPERNEXUS_PROMPTS, getPrompt } from './prompts.js';
import { listResources, readResourcePayload } from './resources.js';
import { corpusSourcesPayload } from '../server/api.js';
import { executeIdeaCatalystTool } from './tool-idea-catalyst.js';
import { executeAgentMaterialsTool } from './tool-agent-materials.js';
import { executeImportWorkflowTool } from './tool-import-workflow.js';
import { executeLiteratureDiscoveryTool } from './tool-literature-discovery.js';
import { executeLiteratureDiscoveryProgressTool } from './tool-literature-discovery-progress.js';
import { executeResearchBriefingTool } from './tool-research-briefing.js';
import { executeResearchLookupTool } from './tool-research-lookup.js';
import { PAPERNEXUS_TOOLS } from './tools.js';

export const SERVER_INFO = {
  name: 'papernexus',
  version: '0.1.0'
};

const DEFAULT_MCP_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

export function createJsonRpcSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

export function createJsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

function normalizeMcpObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeMcpString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstMcpString(...values) {
  for (const value of values) {
    const normalized = normalizeMcpString(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstMcpValue(...values) {
  return values.find((value) => value !== undefined);
}

function normalizeMcpStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeMcpString(item))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeMcpPathListValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeMcpString(item))
      .filter(Boolean);
  }
  const normalized = normalizeMcpString(value);
  return normalized ? [normalized] : [];
}

function firstMcpPathList(...values) {
  for (const value of values) {
    const normalized = normalizeMcpPathListValue(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function normalizeMcpNumber(value, fallback = undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMcpPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function resolveMcpConfigBaseDir(configPath, options = {}) {
  return configPath
    ? path.dirname(configPath)
    : (options.configBaseDir || process.cwd());
}

async function loadMcpRuntimeConfig(args = {}, options = {}, { allowMissingExplicit = false } = {}) {
  const cwd = options.configBaseDir || process.cwd();
  const configPath = firstMcpString(args.configPath, options.configPath);

  try {
    return await loadRuntimeConfig({
      cwd,
      ...(configPath ? { path: configPath } : {})
    });
  } catch (error) {
    if (allowMissingExplicit && configPath && /^Config file not found:/i.test(error.message || '')) {
      return {
        config: {},
        path: resolvePathWithHome(configPath, cwd)
      };
    }
    throw error;
  }
}

function normalizeMcpServePath(value) {
  const raw = normalizeMcpString(value);
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function sanitizeMcpLlmConfig(value) {
  const llm = normalizeMcpObject(value);
  if (!Object.keys(llm).length) return null;
  if (Object.prototype.hasOwnProperty.call(llm, 'apiKey')) {
    throw new Error('runtime_init does not accept llm.apiKey. Use llm.apiKeyEnv or keychain metadata instead.');
  }

  const sanitized = {};
  for (const key of [
    'provider',
    'model',
    'baseUrl',
    'url',
    'apiKeyEnv',
    'apiKeySource',
    'apiKeyService',
    'apiKeyAccount',
    'sshHost'
  ]) {
    const normalized = normalizeMcpString(llm[key]);
    if (normalized) sanitized[key] = normalized;
  }

  for (const key of ['relations', 'autoStart', 'autoPull']) {
    if (typeof llm[key] === 'boolean') sanitized[key] = llm[key];
  }

  for (const key of ['timeoutMs', 'batchSize', 'maxTokens']) {
    const normalized = normalizeMcpNumber(llm[key]);
    if (normalized !== undefined) sanitized[key] = normalized;
  }

  return sanitized;
}

function assertNoMcpFirecrawlApiKey(args = {}, toolName = 'runtime_init') {
  const nested = normalizeMcpObject(args.firecrawl);
  if (
    Object.prototype.hasOwnProperty.call(args, 'firecrawlApiKey')
    || Object.prototype.hasOwnProperty.call(args, 'firecrawl_api_key')
    || Object.prototype.hasOwnProperty.call(nested, 'apiKey')
    || Object.prototype.hasOwnProperty.call(nested, 'api_key')
  ) {
    throw new Error(`${toolName} does not accept Firecrawl raw API keys. Use firecrawlApiKeyEnv or FIRECRAWL_API_KEY instead.`);
  }
}

function buildMcpFirecrawlAnalyzeOptions(args = {}, currentAnalyze = {}, toolName = 'runtime_init') {
  assertNoMcpFirecrawlApiKey(args, toolName);
  const nested = normalizeMcpObject(args.firecrawl);
  const firecrawlMaxPages = normalizeMcpPositiveInteger(firstMcpValue(
    args.firecrawlMaxPages,
    args.firecrawl_max_pages,
    nested.maxPages,
    currentAnalyze.firecrawlMaxPages
  ));
  const firecrawlTimeoutMs = normalizeMcpPositiveInteger(firstMcpValue(
    args.firecrawlTimeoutMs,
    args.firecrawl_timeout_ms,
    nested.timeoutMs,
    currentAnalyze.firecrawlTimeoutMs
  ));
  return compactMcpOptions({
    firecrawlApiBaseUrl: firstMcpString(args.firecrawlApiBaseUrl, args.firecrawl_api_base_url, nested.apiBaseUrl, currentAnalyze.firecrawlApiBaseUrl) || undefined,
    firecrawlApiKeyEnv: firstMcpString(args.firecrawlApiKeyEnv, args.firecrawl_api_key_env, nested.apiKeyEnv, currentAnalyze.firecrawlApiKeyEnv) || undefined,
    firecrawlMode: firstMcpString(args.firecrawlMode, args.firecrawl_mode, nested.mode, currentAnalyze.firecrawlMode) || undefined,
    firecrawlSourceMode: firstMcpString(args.firecrawlSourceMode, args.firecrawl_source_mode, nested.sourceMode, currentAnalyze.firecrawlSourceMode) || undefined,
    firecrawlMaxPages,
    firecrawlTimeoutMs
  });
}

function redactMcpLlmConfig(value) {
  const llm = normalizeMcpObject(value);
  if (!Object.keys(llm).length) return null;
  const { apiKey, ...safeLlm } = llm;
  return safeLlm;
}

function buildMcpLlmExecutionOptions(config = {}) {
  const llm = normalizeMcpObject(config.llm);
  const ollama = normalizeMcpObject(config.ollama);
  return {
    llmProvider: firstMcpString(llm.provider, ollama.provider) || undefined,
    llmModel: firstMcpString(llm.model, ollama.model) || undefined,
    llmBaseUrl: firstMcpString(llm.baseUrl, llm.url, ollama.url) || undefined,
    llmApiKeyEnv: firstMcpString(llm.apiKeyEnv) || undefined,
    llmApiKeySource: firstMcpString(llm.apiKeySource) || undefined,
    llmApiKeyService: firstMcpString(llm.apiKeyService) || undefined,
    llmApiKeyAccount: firstMcpString(llm.apiKeyAccount) || undefined,
    llmSshHost: firstMcpString(llm.sshHost, ollama.sshHost) || undefined,
    llmRelations: firstMcpValue(llm.relations, ollama.relations),
    llmTimeoutMs: normalizeMcpNumber(firstMcpValue(llm.timeoutMs, ollama.timeoutMs)),
    llmBatchSize: normalizeMcpNumber(firstMcpValue(llm.batchSize, ollama.batchSize)),
    llmMaxTokens: normalizeMcpNumber(llm.maxTokens)
  };
}

function compactMcpOptions(options = {}) {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined)
  );
}

function waitMcpMilliseconds(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function looksLikeLocalWorkstationPath(value) {
  const normalized = normalizeMcpString(value).replace(/\\/g, '/');
  return /^\/Users\/[^/]+/.test(normalized) || /^[A-Za-z]:\//.test(normalized);
}

function buildMcpSourceVisibilityError(toolName, sourceInput, resolvedPath, index) {
  const workstationHint = looksLikeLocalWorkstationPath(sourceInput)
    ? ' This looks like a local workstation path; the MCP server cannot read files from your local machine unless they have been uploaded or mounted on the server.'
    : '';
  return `${toolName} sourceInputs[${index}] is not visible to this MCP server: ${sourceInput} (resolved: ${resolvedPath}).${workstationHint} Stage or upload the file/directory to the PaperNexus server first, then pass a server-visible path such as ~/uploads/... or a server absolute path.`;
}

async function assertMcpSourceInputsVisible(sourceInputs, resolvedSourceInputs, toolName) {
  for (let index = 0; index < resolvedSourceInputs.length; index += 1) {
    const resolvedPath = resolvedSourceInputs[index];
    if (!(await fileExists(resolvedPath))) {
      throw new Error(buildMcpSourceVisibilityError(
        toolName,
        sourceInputs[index] || resolvedPath,
        resolvedPath,
        index
      ));
    }
  }
}

function normalizeMcpCreateCorpusOperation(args = {}) {
  const raw = firstMcpString(args.operation, args.op).toLowerCase().replace(/-/g, '_');
  if (!raw || raw === 'build' || raw === 'create' || raw === 'run') return 'build';
  if (raw === 'submit' || raw === 'queue' || raw === 'start' || raw === 'background') return 'submit';
  if (raw === 'status' || raw === 'get_status') return 'status';
  if (raw === 'wait' || raw === 'await') return 'wait';
  throw new Error(`Unknown create_corpus operation: ${args.operation || args.op}`);
}

function normalizeMcpCreateCorpusExecutionMode(args = {}, sourceInputs = [], operation = 'build') {
  if (operation === 'submit') return 'async';

  const explicitMode = firstMcpString(
    args.executionMode,
    args.execution_mode,
    args.runMode,
    args.run_mode
  ).toLowerCase().replace(/-/g, '_');

  if (!explicitMode && args.async !== undefined) {
    return args.async === true ? 'async' : 'sync';
  }

  if (!explicitMode && args.waitForCompletion !== undefined) {
    return args.waitForCompletion === false ? 'async' : 'sync';
  }

  if (!explicitMode || explicitMode === 'auto') {
    return sourceInputs.length ? 'async' : 'sync';
  }

  if (['async', 'asynchronous', 'background', 'queued', 'queue', 'submit'].includes(explicitMode)) {
    return 'async';
  }

  if (['sync', 'synchronous', 'blocking', 'wait'].includes(explicitMode)) {
    return 'sync';
  }

  throw new Error(`Unknown create_corpus executionMode: ${explicitMode}`);
}

function normalizeMcpCreateCorpusJobId(value) {
  const jobId = normalizeMcpString(value);
  if (!jobId) {
    throw new Error('create_corpus status/wait requires jobId.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
    throw new Error(`Invalid create_corpus jobId: ${jobId}`);
  }
  return jobId;
}

function getMcpCreateCorpusJobsDir() {
  return path.join(getDefaultRuntimeConfigRoot(), 'mcp-jobs', 'create-corpus');
}

function getMcpCreateCorpusJobPath(jobId) {
  return path.join(getMcpCreateCorpusJobsDir(), `${normalizeMcpCreateCorpusJobId(jobId)}.json`);
}

function nowIsoString() {
  return new Date().toISOString();
}

function buildMcpCreateCorpusResult(result, context) {
  return {
    contractVersion: 'papernexus-corpus-create-v1',
    corpus: result.meta?.name || context.corpusName,
    rootPath: result.rootPath || context.rootPath || '',
    inputPath: result.inputPath || context.inputRoot,
    sourceInputs: context.sourceInputs,
    resolvedSourceInputs: context.inputRoot,
    stage: result.stage || result.meta?.stage || 'completed',
    graphCommitted: true,
    reused: Boolean(result.reused),
    changes: result.changes || result.meta?.lastChangeSummary || null,
    options: context.options,
    meta: result.meta
      ? {
          ...result.meta,
          rootPath: result.rootPath || context.rootPath || ''
        }
      : null
  };
}

async function writeMcpCreateCorpusJob(job) {
  await ensureDir(getMcpCreateCorpusJobsDir());
  await writeJson(getMcpCreateCorpusJobPath(job.jobId), job);
}

async function readMcpCreateCorpusJob(jobId) {
  const normalizedJobId = normalizeMcpCreateCorpusJobId(jobId);
  const job = await readJson(getMcpCreateCorpusJobPath(normalizedJobId), null);
  if (!job) {
    throw new Error(`create_corpus job not found: ${normalizedJobId}`);
  }
  return job;
}

function renderMcpCreateCorpusJob(job, extra = {}) {
  const inProgress = job.status === 'queued' || job.status === 'running';
  return {
    contractVersion: 'papernexus-corpus-create-job-v1',
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    graphCommitted: job.graphCommitted === true,
    submittedAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    updatedAt: job.updatedAt,
    corpus: job.corpus,
    rootPath: job.rootPath || '',
    inputPath: job.inputPath || [],
    sourceInputs: job.sourceInputs || [],
    resolvedSourceInputs: job.resolvedSourceInputs || [],
    options: job.options || {},
    result: job.result || null,
    error: job.error || null,
    next: inProgress
      ? {
          tool: 'create_corpus',
          arguments: {
            operation: 'status',
            jobId: job.jobId
          }
        }
      : null,
    ...extra
  };
}

async function waitForMcpCreateCorpusJob(jobId, options = {}) {
  const timeoutMs = Math.max(0, normalizeMcpNumber(options.timeoutMs, 0));
  const pollIntervalMs = Math.max(100, normalizeMcpNumber(options.pollIntervalMs, 500));
  const deadline = timeoutMs ? Date.now() + timeoutMs : Date.now();
  let job = await readMcpCreateCorpusJob(jobId);

  while ((job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
    await waitMcpMilliseconds(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    job = await readMcpCreateCorpusJob(jobId);
  }

  return {
    job,
    timedOut: job.status === 'queued' || job.status === 'running'
  };
}

async function runMcpCreateCorpusJob(job, context, executionArgs) {
  const runningJob = {
    ...job,
    status: 'running',
    stage: 'running',
    startedAt: nowIsoString(),
    updatedAt: nowIsoString()
  };
  await writeMcpCreateCorpusJob(runningJob);

  try {
    const { analyzeCorpus } = await import('../core/ingestion/pipeline.js');
    const result = await analyzeCorpus(context.inputRoot, executionArgs);
    await writeMcpCreateCorpusJob({
      ...runningJob,
      status: 'completed',
      stage: result.stage || result.meta?.stage || 'completed',
      graphCommitted: true,
      completedAt: nowIsoString(),
      updatedAt: nowIsoString(),
      result: buildMcpCreateCorpusResult(result, context)
    });
  } catch (error) {
    await writeMcpCreateCorpusJob({
      ...runningJob,
      status: 'failed',
      stage: 'failed',
      graphCommitted: false,
      completedAt: nowIsoString(),
      updatedAt: nowIsoString(),
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error)
      }
    });
  }
}

async function submitMcpCreateCorpusJob(context, executionArgs) {
  const now = nowIsoString();
  const job = {
    version: 1,
    type: 'create_corpus',
    jobId: randomUUID(),
    status: 'queued',
    stage: 'queued',
    graphCommitted: false,
    createdAt: now,
    updatedAt: now,
    corpus: context.corpusName,
    rootPath: context.rootPath || '',
    inputPath: context.inputRoot,
    sourceInputs: context.sourceInputs,
    resolvedSourceInputs: context.inputRoot,
    options: context.options
  };

  await writeMcpCreateCorpusJob(job);
  setImmediate(() => {
    void runMcpCreateCorpusJob(job, context, executionArgs);
  });
  return job;
}

export async function executeTool(name, args, options = {}) {
  if (name === 'list_corpora') {
    const registry = await loadRegistry();
    return renderCorpusList(registry.corpora);
  }

  if (name === 'corpus_status') {
    const rootPath = await resolveCorpus(args.corpus);
    const { meta } = await loadCorpus(rootPath);
    return renderStatus(meta);
  }

  if (name === 'corpus_sources') {
    return corpusSourcesPayload(args.corpus, options);
  }

  if (name === 'query') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderQueryResult(searchGraph(graph, args.query, {
      limit: args.limit,
      layers: args.layers
    }));
  }

  if (name === 'context') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderContextResult(buildContext(graph, args.query, {
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    }));
  }

  if (name === 'impact') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderImpactResult(buildImpact(graph, args.query, {
      direction: args.direction,
      maxDepth: args.maxDepth,
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    }));
  }

  if (name === 'ideas') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderIdeasResult(buildResearchIdeas(graph, args.query, {
      limit: args.limit,
      layers: args.layers
    }));
  }

  if (name === 'brainstorm') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    const result = buildBrainstorm(graph, args.query, {
      mode: args.mode || 'diverge',
      maxHops: args.maxHops,
      limit: args.limit,
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    });

    if ((args.mode || 'diverge') === 'diverge') {
      return [
        {
          type: 'text',
          text: renderBrainstormResult(result)
        },
        {
          type: 'text',
          text: JSON.stringify({
            domainProfile: result.domainProfile,
            communityAnalysis: result.communityAnalysis
          }, null, 2)
        }
      ];
    }

    return renderBrainstormResult(result);
  }

  if (name === 'domain_distance') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph, meta } = await loadCorpusLite(rootPath);
    const matrix = meta.domainDistanceMatrix?.mechanismCoverage
      ? meta.domainDistanceMatrix
      : deriveDomainTaxonomyFromGraph(graph);
    const targetDomain = normalizeFieldOfStudy(args.targetDomain);
    const distances = targetDomain
      ? Object.entries(matrix.distances?.[targetDomain] || {})
        .map(([domain, distance]) => ({ domain, distance }))
        .sort((left, right) => right.distance - left.distance || left.domain.localeCompare(right.domain))
      : [];

    return JSON.stringify({
      ...matrix,
      targetDomain,
      distances
    }, null, 2);
  }

  if (name === 'extract_takeaways') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return JSON.stringify(extractTakeawaysFromBridgeNodes(graph, {
      targetDomain: args.targetDomain,
      agnosticChallenges: args.agnosticChallenges,
      limit: args.limit,
      minDomainDistance: args.minDomainDistance
    }), null, 2);
  }

  if (name === 'interdisciplinary_potential') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return JSON.stringify(buildInterdisciplinaryPotentialReport(graph, {
      targetDomain: args.targetDomain,
      query: args.query,
      agnosticChallenges: args.agnosticChallenges,
      excludeProximalDomains: args.excludeProximalDomains,
      limit: args.limit
    }), null, 2);
  }

  if (name === 'mutate_graph') {
    const rootPath = await resolveCorpus(args.corpus);
    const { meta, mutationResult } = await applyCorpusMutations(rootPath, args.operations, {
      actor: args.actor,
      dryRun: args.dryRun !== false
    });
    return renderMutationResult({
      ...mutationResult,
      rootPath,
      corpusName: meta.name
    });
  }

  if (name === 'runtime_init') {
    const loaded = await loadMcpRuntimeConfig(args, options, { allowMissingExplicit: true });
    const config = normalizeMcpObject(loaded.config);
    const configBaseDir = resolveMcpConfigBaseDir(loaded.path, options);
    const currentSources = normalizeMcpObject(config.sources);
    const hasSourceInputArgs = [
      'sourceInputs',
      'sources',
      'inputPaths',
      'inputPath',
      'sourceRoot',
      'source'
    ].some((key) => args[key] !== undefined);

    const currentAnalyze = normalizeMcpObject(config.analyze);
    const currentStorage = normalizeMcpObject(config.storage);
    const currentGlobal = normalizeMcpObject(config.global);
    const currentServe = normalizeMcpObject(config.serve);
    const sourceInputs = hasSourceInputArgs
      ? normalizeMcpStringList(
        args.sourceInputs
        ?? args.sources
        ?? args.inputPaths
        ?? args.inputPath
        ?? args.sourceRoot
        ?? args.source
      )
      : normalizeMcpStringList(currentSources.inputs);
    const corpusName = firstMcpString(args.corpus, args.corpusName, args.name);
    if (!corpusName) {
      throw new Error('runtime_init requires corpus or corpusName.');
    }

    const explicitIndexDirs = firstMcpPathList(args.indexDirs, args.index_dirs);
    const configuredIndexDirs = firstMcpPathList(currentStorage.indexDirs, currentStorage.indexDir);
    const indexDirs = explicitIndexDirs.length
      ? explicitIndexDirs
      : firstMcpPathList(
        args.indexDir,
        args.rootPath,
        configuredIndexDirs,
        path.join(getDefaultRuntimeConfigRoot(), 'index-store')
      );
    const indexDir = indexDirs[0];
    const pdfParser = firstMcpString(args.pdfParser, currentAnalyze.pdfParser, 'markitdown');
    const serveHost = firstMcpString(args.serveHost, args.host, currentServe.host, '127.0.0.1');
    const servePort = normalizeMcpNumber(firstMcpValue(args.servePort, args.port, currentServe.port), 4821);
    const firecrawlAnalyzeOptions = buildMcpFirecrawlAnalyzeOptions(args, currentAnalyze, 'runtime_init');

    const nextServe = {
      ...currentServe,
      host: serveHost,
      port: servePort
    };
    if (args.serveMcpEnabled !== undefined || args.serveMcpPath !== undefined) {
      const currentMcp = normalizeMcpObject(currentServe.mcp);
      nextServe.mcp = {
        ...currentMcp,
        ...(args.serveMcpEnabled === undefined ? {} : { enabled: args.serveMcpEnabled === true }),
        ...(normalizeMcpServePath(args.serveMcpPath) ? { path: normalizeMcpServePath(args.serveMcpPath) } : {})
      };
    }

    const nextConfig = {
      ...config,
      sources: {
        ...currentSources,
        inputs: sourceInputs
      },
      storage: {
        ...currentStorage,
        indexDir,
        indexDirs: indexDirs.length > 1 ? indexDirs : []
      },
      analyze: {
        ...currentAnalyze,
        name: corpusName,
        pdfParser,
        ...firecrawlAnalyzeOptions
      },
      global: {
        ...currentGlobal,
        corpus: corpusName
      },
      serve: nextServe
    };

    const sanitizedLlm = sanitizeMcpLlmConfig(args.llm);
    if (sanitizedLlm) {
      nextConfig.llm = {
        ...normalizeMcpObject(config.llm),
        ...sanitizedLlm
      };
      delete nextConfig.llm.apiKey;
    }

    const targetConfigPath = firstMcpString(args.configPath, loaded.path, options.configPath);
    const targetConfigBaseDir = resolveMcpConfigBaseDir(
      targetConfigPath ? resolvePathWithHome(targetConfigPath, configBaseDir) : loaded.path,
      options
    );
    const resolvedSourceInputs = sourceInputs.map((input) => resolvePathWithHome(input, targetConfigBaseDir));
    await assertMcpSourceInputsVisible(sourceInputs, resolvedSourceInputs, 'runtime_init');

    const saved = await saveRuntimeConfig(nextConfig, {
      cwd: configBaseDir,
      ...(targetConfigPath ? { path: targetConfigPath } : {})
    });
    const savedBaseDir = resolveMcpConfigBaseDir(saved.path, options);
    const resolvedIndexDir = resolvePathWithHome(indexDir, savedBaseDir);
    const resolvedIndexDirs = indexDirs.map((entry) => resolvePathWithHome(entry, savedBaseDir));

    return JSON.stringify({
      contractVersion: 'papernexus-runtime-init-v1',
      configPath: saved.path,
      sourceInputs,
      resolvedSourceInputs,
      corpus: corpusName,
      indexDir,
      indexDirs,
      resolvedIndexDir,
      resolvedIndexDirs,
      pdfParser,
      firecrawl: firecrawlAnalyzeOptions,
      serve: {
        host: nextServe.host,
        port: nextServe.port,
        mcp: nextServe.mcp || null
      },
      llm: redactMcpLlmConfig(saved.config.llm),
      next: {
        tool: 'create_corpus',
        arguments: {
          sourceInputs: resolvedSourceInputs,
          corpus: corpusName,
          rootPath: resolvedIndexDir,
          executionMode: sourceInputs.length ? 'async' : 'sync'
        }
      }
    }, null, 2);
  }

  if (name === 'create_corpus') {
    const operation = normalizeMcpCreateCorpusOperation(args);
    if (operation === 'status') {
      const job = await readMcpCreateCorpusJob(args.jobId);
      return JSON.stringify(renderMcpCreateCorpusJob(job), null, 2);
    }
    if (operation === 'wait') {
      const waitResult = await waitForMcpCreateCorpusJob(args.jobId, {
        timeoutMs: normalizeMcpNumber(firstMcpValue(args.waitTimeoutMs, args.timeoutMs, args.timeout_ms), DEFAULT_MCP_WAIT_TIMEOUT_MS),
        pollIntervalMs: normalizeMcpNumber(firstMcpValue(args.pollIntervalMs, args.poll_interval_ms), 500)
      });
      return JSON.stringify(renderMcpCreateCorpusJob(waitResult.job, {
        timedOut: waitResult.timedOut
      }), null, 2);
    }

    const loaded = await loadMcpRuntimeConfig(args, options);
    const config = normalizeMcpObject(loaded.config);
    const configBaseDir = resolveMcpConfigBaseDir(loaded.path, options);
    const sourcesConfig = normalizeMcpObject(config.sources);
    const storageConfig = normalizeMcpObject(config.storage);
    const analyzeConfig = normalizeMcpObject(config.analyze);
    const globalConfig = normalizeMcpObject(config.global);
    const requestedSourceInputs = normalizeMcpStringList(
      args.sourceInputs
      ?? args.sources
      ?? args.inputPaths
      ?? args.inputPath
      ?? args.sourceRoot
      ?? args.source
    );
    const sourceInputs = requestedSourceInputs.length
      ? requestedSourceInputs
      : normalizeMcpStringList(sourcesConfig.inputs);

    const corpusName = firstMcpString(args.corpus, args.corpusName, args.name, analyzeConfig.name, globalConfig.corpus);
    if (!corpusName) {
      throw new Error('create_corpus requires corpus/corpusName or configured analyze.name/global.corpus.');
    }

    const rootPathInput = firstMcpString(
      args.rootPath,
      args.indexDir,
      firstMcpPathList(storageConfig.indexDirs, storageConfig.indexDir)[0],
      sourceInputs.length ? '' : path.join(getDefaultRuntimeConfigRoot(), 'index-store')
    );
    const rootPath = rootPathInput ? resolvePathWithHome(rootPathInput, configBaseDir) : undefined;
    const inputRoot = sourceInputs.map((input) => resolvePathWithHome(input, configBaseDir));
    await assertMcpSourceInputsVisible(sourceInputs, inputRoot, 'create_corpus');
    const semanticExtraction = firstMcpString(
      args.semanticExtraction,
      args.semantic_extraction,
      analyzeConfig.semanticExtraction
    );
    const rebuildPdfMarkdown = firstMcpValue(
      args.rebuildPdfMarkdown,
      args.rebuild_pdf_markdown,
      analyzeConfig.rebuildPdfMarkdown
    );
    const llmBatchSize = normalizeMcpPositiveInteger(
      firstMcpValue(args.llmBatchSize, args.llm_batch_size, args.batchSize, args.batch_size)
    );
    const analyzeConcurrency = normalizeMcpPositiveInteger(
      firstMcpValue(args.analyzeConcurrency, args.concurrency, analyzeConfig.analyzeConcurrency, analyzeConfig.concurrency)
    );
    const pdfParser = firstMcpString(args.pdfParser, analyzeConfig.pdfParser);
    const pdfCommand = firstMcpString(args.pdfCommand, analyzeConfig.pdfCommand);
    const firecrawlAnalyzeOptions = buildMcpFirecrawlAnalyzeOptions(args, analyzeConfig, 'create_corpus');
    const force = args.force === undefined ? Boolean(analyzeConfig.force) : args.force === true;
    const executionMode = normalizeMcpCreateCorpusExecutionMode(args, sourceInputs, operation);

    const executionArgs = compactMcpOptions({
      ...analyzeConfig,
      ...buildMcpLlmExecutionOptions(config),
      name: corpusName,
      rootPath,
      force,
      allowEmptyCorpus: true,
      semanticExtraction: semanticExtraction || undefined,
      rebuildPdfMarkdown: rebuildPdfMarkdown === undefined ? undefined : rebuildPdfMarkdown === true,
      pdfParser: pdfParser || undefined,
      pdfCommand: pdfCommand || undefined,
      ...firecrawlAnalyzeOptions,
      analyzeConcurrency,
      llmBatchSize,
      batchSize: llmBatchSize
    });
    const createContext = {
      corpusName,
      rootPath,
      inputRoot,
      sourceInputs,
      options: {
        executionMode,
        force,
        semanticExtraction: semanticExtraction || null,
        rebuildPdfMarkdown: rebuildPdfMarkdown === undefined ? null : rebuildPdfMarkdown === true,
        pdfParser: pdfParser || null,
        firecrawl: firecrawlAnalyzeOptions,
        llmBatchSize: llmBatchSize ?? null,
        analyzeConcurrency: analyzeConcurrency ?? null
      }
    };

    if (executionMode === 'async') {
      const job = await submitMcpCreateCorpusJob(createContext, executionArgs);
      return JSON.stringify(renderMcpCreateCorpusJob(job), null, 2);
    }

    const { analyzeCorpus } = await import('../core/ingestion/pipeline.js');
    const result = await analyzeCorpus(inputRoot, executionArgs);

    return JSON.stringify(buildMcpCreateCorpusResult(result, createContext), null, 2);
  }

  if (name === 'refresh_corpus') {
    const rootPath = await resolveCorpus(args.corpus);
    const {
      analyzeCorpus,
      llmOptimizeCorpus,
      materializeCorpus,
      optimizeCorpus
    } = await import('../core/ingestion/pipeline.js');
    const manifest = await loadSourceManifest(rootPath);
    const inputRoot = Array.isArray(manifest?.inputPaths) && manifest.inputPaths.length
      ? manifest.inputPaths
      : (manifest?.inputPath || rootPath.replace(/[/\\]\.papernexus$/, ''));
    const mode = String(args.mode || 'analyze').trim().toLowerCase().replace(/-/g, '_') || 'analyze';
    const rawBatchSize = (
      args.llmBatchSize
      ?? args.llm_batch_size
      ?? args.batchSize
      ?? args.batch_size
    );
    const parsedBatchSize = Number(rawBatchSize);
    const llmBatchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
      ? parsedBatchSize
      : undefined;
    const changedSourceKeys = (
      Array.isArray(args.changedSourceKeys)
        ? args.changedSourceKeys
        : (Array.isArray(args.changed_source_keys) ? args.changed_source_keys : [])
    ).map((value) => String(value || '').trim()).filter(Boolean);
    const semanticExtraction = typeof (args.semanticExtraction ?? args.semantic_extraction) === 'string'
      && String(args.semanticExtraction ?? args.semantic_extraction).trim()
      ? String(args.semanticExtraction ?? args.semantic_extraction).trim()
      : undefined;
    const rebuildPdfMarkdown = args.rebuildPdfMarkdown ?? args.rebuild_pdf_markdown;
    const incremental = args.incremental !== false;
    const force = args.force === true || (mode === 'analyze' && incremental === false);
    const executionArgs = {
      rootPath,
      force,
      ...(semanticExtraction ? { semanticExtraction } : {}),
      ...(rebuildPdfMarkdown === undefined ? {} : { rebuildPdfMarkdown: rebuildPdfMarkdown === true }),
      ...(llmBatchSize === undefined ? {} : { llmBatchSize, batchSize: llmBatchSize }),
      ...(changedSourceKeys.length ? { changedSourceKeys } : {})
    };

    let result;
    if (mode === 'materialize') {
      result = await materializeCorpus(inputRoot, executionArgs);
    } else if (mode === 'llm_optimize') {
      result = await llmOptimizeCorpus(inputRoot, executionArgs);
    } else if (mode === 'optimize') {
      result = await optimizeCorpus(inputRoot, executionArgs);
    } else if (mode === 'analyze') {
      result = await analyzeCorpus(inputRoot, executionArgs);
    } else {
      throw new Error(`Unknown refresh_corpus mode: ${args.mode || '<missing>'}`);
    }

    return JSON.stringify({
      contractVersion: 'papernexus-corpus-refresh-v1',
      corpus: result.meta?.name || '',
      rootPath: result.rootPath || rootPath,
      inputPath: result.inputPath || inputRoot,
      mode,
      stage: result.stage || result.meta?.stage || (
        mode === 'materialize'
          ? 'materialized'
          : (mode === 'llm_optimize' ? 'llm-optimized' : 'completed')
      ),
      graphCommitted: mode === 'analyze' || mode === 'optimize',
      reused: Boolean(result.reused),
      changes: result.changes || result.meta?.lastChangeSummary || null,
      options: {
        incremental: mode === 'analyze' ? incremental : null,
        force,
        semanticExtraction: semanticExtraction || null,
        rebuildPdfMarkdown: rebuildPdfMarkdown === undefined ? null : rebuildPdfMarkdown === true,
        llmBatchSize: llmBatchSize ?? null,
        changedSourceKeys
      },
      meta: result.meta
        ? {
            ...result.meta,
            rootPath: result.rootPath || rootPath
          }
        : null
    }, null, 2);
  }

  if (name === 'refresh_paper_graph') {
    const rootPath = await resolveCorpus(args.corpus);
    const { refreshPaperGraphContent } = await import('../core/ingestion/pipeline.js');
    return JSON.stringify(await refreshPaperGraphContent(rootPath, {
      rootPath,
      paperId: args.paperId,
      sourceKey: args.sourceKey,
      source: args.source,
      paperTitle: args.paperTitle,
      includeDuplicateGroup: args.includeDuplicateGroup !== false,
      rebuildPdfMarkdown: args.rebuildPdfMarkdown !== false,
      semanticExtraction: args.semanticExtraction
    }), null, 2);
  }

  if (name === 'research_lookup') {
    return executeResearchLookupTool(args, options);
  }

  if (name === 'research_briefing') {
    return executeResearchBriefingTool(args, options);
  }

  if (name === 'import_workflow') {
    return executeImportWorkflowTool(args, options);
  }

  if (name === 'literature_discovery') {
    return executeLiteratureDiscoveryTool(args, options);
  }

  if (name === 'literature_discovery_progress') {
    return executeLiteratureDiscoveryProgressTool(args, options);
  }

  if (name === 'idea_catalyst') {
    return executeIdeaCatalystTool(args, options);
  }

  if (name === 'agent_materials') {
    return executeAgentMaterialsTool(args, options);
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function normalizeToolContent(result) {
  if (Array.isArray(result)) {
    return result;
  }

  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content;
  }

  return [
    {
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    }
  ];
}

export async function handleMessage(message, options = {}) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: SERVER_INFO
      };
    case 'tools/list':
      return { tools: PAPERNEXUS_TOOLS };
    case 'tools/call':
      return {
        content: normalizeToolContent(await executeTool(message.params?.name, message.params?.arguments || {}, options))
      };
    case 'resources/list':
      return { resources: await listResources() };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      {
        const payload = await readResourcePayload(message.params?.uri);
        return {
          contents: [
            {
              uri: message.params?.uri,
              mimeType: payload.mimeType,
              text: payload.text
            }
          ]
        };
      }
    case 'prompts/list':
      return { prompts: PAPERNEXUS_PROMPTS };
    case 'prompts/get':
      return getPrompt(message.params?.name);
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}
