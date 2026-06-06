#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API_BASE = 'http://10.126.56.41:4821';
const DEFAULT_CORPUS = 'GCD';
const DEFAULT_LIMIT = 10;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120 * 1000;
const DEFAULT_TRANSPORT = 'http';
const DEFAULT_PROCESSING_PROFILE = 'fast-md-background-semantic';
const DEFAULT_COMPLETION_POLICY = 'graph-visible';
const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEFAULT_LLM_EXTRACTION_STRATEGY = 'long-context-first';
const DEFAULT_LLM_LONG_CONTEXT_MAX_PAPERS_PER_CALL = 10;
const DEFAULT_LLM_BATCH_CONCURRENCY = 1;
const DEFAULT_IDENTIFIER_PREFIX = '10.48550/papernexus.live-burst';
const CONTRACT_VERSION = 'papernexus-live-import-burst-report-v1';
const MCP_IMPORT_WORKFLOW_TOOL = 'import_workflow';

const VALUE_FLAGS = new Set([
  'api-base',
  'transport',
  'mcp-url',
  'token',
  'token-file',
  'corpus',
  'source',
  'source-dir',
  'limit',
  'report',
  'processing-profile',
  'completion-policy',
  'llm-context-window-tokens',
  'llm-extraction-strategy',
  'llm-long-context-max-papers-per-call',
  'llm-batch-concurrency',
  'poll-interval-ms',
  'timeout-ms',
  'request-timeout-ms',
  'identifier-prefix',
  'run-id'
]);

function printUsage() {
  console.log(`Usage:
  node scripts/run-import-burst-harness.mjs --source-dir <dir> [--execute]

Options:
  --api-base <url>             PaperNexus HTTP API base. Default: ${DEFAULT_API_BASE}
  --transport <http|mcp>       Submission/wait transport. Default: ${DEFAULT_TRANSPORT}
  --mcp-url <url>              PaperNexus MCP endpoint. Default: <api-base>/mcp
  --token <token>              API token. Prefer PAPERNEXUS_API_TOKEN in shell history-sensitive runs.
  --token-file <path>          Read API token from a local file.
  --corpus <name>              Corpus name passed as ?name=. Default: ${DEFAULT_CORPUS}
  --source <path>              Markdown file to upload. May be repeated.
  --source-dir <path>          Recursively select markdown files from a directory.
  --limit <n>                  Number of markdown files to include. Default: ${DEFAULT_LIMIT}
  --report <path>              JSON report path. Default: /tmp/papernexus-live-import-burst-report-<run-id>.json
  --processing-profile <name>  Import processing profile. Default: ${DEFAULT_PROCESSING_PROFILE}
  --completion-policy <name>   Import completion policy. Default: ${DEFAULT_COMPLETION_POLICY}
  --llm-context-window-tokens <n>
                                Expected service LLM context window recorded in the report. Default: ${DEFAULT_LLM_CONTEXT_WINDOW_TOKENS}
  --llm-extraction-strategy <name>
                                Expected markdown extraction strategy recorded in the report. Default: ${DEFAULT_LLM_EXTRACTION_STRATEGY}
  --llm-long-context-max-papers-per-call <n>
                                Expected long-context paper packing recorded in the report. Default: ${DEFAULT_LLM_LONG_CONTEXT_MAX_PAPERS_PER_CALL}
  --llm-batch-concurrency <n>  Expected LLM provider concurrency recorded in the report. Default: ${DEFAULT_LLM_BATCH_CONCURRENCY}
  --poll-interval-ms <n>       Status polling interval. Default: ${DEFAULT_POLL_INTERVAL_MS}
  --timeout-ms <n>             Overall graph-visible wait timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --request-timeout-ms <n>     Single HTTP request timeout. Default: ${DEFAULT_REQUEST_TIMEOUT_MS}
  --identifier-prefix <doi>    DOI prefix for generated per-file identifiers.
  --run-id <id>                Stable run id for reports and identifiers.
  --execute                    Submit real import tasks. Without this flag the script only writes a dry-run report.
  --reuse-content              Do not append a hidden run marker. May hit import dedupe on repeated runs.
  --wait-semantic              Also wait for semanticStatus=completed/not-required after graph-visible.
  --schema-check-only          Check MCP import_workflow fast-md/default 1M schema readiness without submitting tasks.
  --help                       Show this help.
`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    sources: [],
    execute: false,
    reuseContent: false,
    waitSemantic: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--execute') {
      options.execute = true;
      continue;
    }
    if (arg === '--reuse-content') {
      options.reuseContent = true;
      continue;
    }
    if (arg === '--wait-semantic') {
      options.waitSemantic = true;
      continue;
    }
    if (arg === '--schema-check-only') {
      options.schemaCheckOnly = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const raw = arg.slice(2);
    const equalsAt = raw.indexOf('=');
    const key = equalsAt >= 0 ? raw.slice(0, equalsAt) : raw;
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }

    let value = equalsAt >= 0 ? raw.slice(equalsAt + 1) : null;
    if (value === null) {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option --${key} requires a value.`);
      }
    }

    if (key === 'source') {
      options.sources.push(value);
    } else {
      options[toCamelCase(key)] = value;
    }
  }

  return options;
}

function toCamelCase(value) {
  return String(value).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function normalizeRunId(value) {
  const raw = String(value || '').trim();
  if (raw) return raw.replace(/[^A-Za-z0-9._-]+/g, '-');
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

async function readToken(options) {
  if (options.token) {
    return {
      token: String(options.token).trim(),
      tokenSource: 'argument'
    };
  }
  if (options.tokenFile) {
    return {
      token: (await fs.readFile(path.resolve(options.tokenFile), 'utf8')).trim(),
      tokenSource: 'file'
    };
  }
  return {
    token: String(process.env.PAPERNEXUS_API_TOKEN || '').trim(),
    tokenSource: process.env.PAPERNEXUS_API_TOKEN ? 'env:PAPERNEXUS_API_TOKEN' : 'missing'
  };
}

async function walkMarkdownFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(md|markdown)$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectSourceFiles(options) {
  const candidates = [];
  for (const source of options.sources || []) {
    candidates.push(path.resolve(source));
  }

  if (options.sourceDir) {
    const sourceDir = path.resolve(options.sourceDir);
    candidates.push(...await walkMarkdownFiles(sourceDir));
  }

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates.sort((left, right) => left.localeCompare(right))) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error(`Source is not a file: ${resolved}`);
    }
    if (!/\.(md|markdown)$/i.test(path.basename(resolved))) {
      throw new Error(`Source is not a markdown file: ${resolved}`);
    }
    unique.push({
      path: resolved,
      name: path.basename(resolved),
      bytes: stat.size
    });
  }

  if (!unique.length) {
    throw new Error('Provide at least one markdown source via --source or --source-dir.');
  }

  const limit = parsePositiveInt(options.limit, DEFAULT_LIMIT, '--limit');
  return unique.slice(0, limit);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function appendRunMarker(content, runId, index) {
  return Buffer.concat([
    content,
    Buffer.from(`\n\n<!-- papernexus-live-burst run=${runId} index=${index} -->\n`, 'utf8')
  ]);
}

function buildImportBody({ source, content, index, options }) {
  const identifierPrefix = String(options.identifierPrefix || DEFAULT_IDENTIFIER_PREFIX).replace(/\.+$/, '');
  const doi = `${identifierPrefix}.${options.runId}.${String(index + 1).padStart(2, '0')}`;
  return {
    trigger: 'live-import-burst-harness',
    processingProfile: options.processingProfile,
    completionPolicy: options.completionPolicy,
    llmContextWindowTokens: options.llmContextWindowTokens,
    llmExtractionStrategy: options.llmExtractionStrategy,
    llmLongContextMaxPapersPerCall: options.llmLongContextMaxPapersPerCall,
    llmBatchConcurrency: options.llmBatchConcurrency,
    files: [
      {
        name: source.name,
        mimeType: 'text/markdown',
        contentBase64: content.toString('base64'),
        paperMetadata: {
          identifiers: {
            doi
          },
          sourceProvider: 'papernexus-live-burst'
        }
      }
    ]
  };
}

function normalizeTransport(value) {
  const transport = String(value || DEFAULT_TRANSPORT).trim().toLowerCase();
  if (transport !== 'http' && transport !== 'mcp') {
    throw new Error('--transport must be either "http" or "mcp".');
  }
  return transport;
}

function defaultMcpUrl(apiBase) {
  return makeUrl(apiBase, '/mcp').toString().replace(/\/+$/, '');
}

function makeUrl(apiBase, pathname, params = {}) {
  const base = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  const url = new URL(pathname.replace(/^\//, ''), base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function apiJson({ apiBase, token, method, pathname, params, body, requestTimeoutMs }) {
  const url = makeUrl(apiBase, pathname, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let payload = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.error || payload?.message || text.slice(0, 500);
      throw new Error(`${method} ${url.pathname} failed with HTTP ${response.status}: ${detail}`);
    }
    return payload || {};
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonOrSsePayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]');
  if (!dataLines.length) {
    return { raw: trimmed };
  }
  return JSON.parse(dataLines[dataLines.length - 1]);
}

async function mcpJson({ mcpUrl, token, sessionId, id, method, params, requestTimeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    const response = await fetch(mcpUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Mcp-Protocol-Version': '2024-11-05',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = {};
    if (text.trim()) {
      try {
        payload = parseJsonOrSsePayload(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error || payload?.message || text.slice(0, 500);
      throw new Error(`MCP ${method} failed with HTTP ${response.status}: ${detail}`);
    }
    if (payload?.error) {
      const detail = payload.error.message || JSON.stringify(payload.error);
      throw new Error(`MCP ${method} failed: ${detail}`);
    }
    return {
      payload,
      sessionId: response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || sessionId || ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseMcpToolPayload(result = {}) {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find((entry) => typeof entry?.text === 'string');
  if (!textPart) return result;
  const text = textPart.text.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function createMcpClient({ options, token }) {
  let sessionId = '';
  let nextId = 1;
  async function request(method, params = {}) {
    const result = await mcpJson({
      mcpUrl: options.mcpUrl,
      token,
      sessionId,
      id: nextId,
      method,
      params,
      requestTimeoutMs: options.requestTimeoutMs
    });
    nextId += 1;
    sessionId = result.sessionId || sessionId;
    return result.payload?.result || {};
  }

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'papernexus-live-import-burst-harness',
      version: '1.0.0'
    }
  });

  return {
    async listTools() {
      const result = await request('tools/list');
      return Array.isArray(result.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      const result = await request('tools/call', {
        name,
        arguments: args
      });
      return parseMcpToolPayload(result);
    }
  };
}

function enumIncludes(schema, value) {
  if (!schema || !Array.isArray(schema.enum)) return false;
  return schema.enum.includes(value);
}

function hasProperty(properties, name) {
  return Boolean(properties && Object.prototype.hasOwnProperty.call(properties, name));
}

async function assertMcpImportWorkflowContract(mcp, options) {
  const tools = await mcp.listTools();
  const importTool = tools.find((tool) => tool?.name === MCP_IMPORT_WORKFLOW_TOOL);
  const properties = importTool?.inputSchema?.properties || {};
  const missing = [];

  if (!importTool) {
    missing.push('tool import_workflow');
  }
  if (!enumIncludes(properties.operation, 'submit')) {
    missing.push('operation=submit');
  }
  if (!enumIncludes(properties.operation, 'wait')) {
    missing.push('operation=wait');
  }
  if (!enumIncludes(properties.processingProfile, options.processingProfile)) {
    missing.push(`processingProfile=${options.processingProfile}`);
  }
  if (!enumIncludes(properties.completionPolicy, options.completionPolicy)) {
    missing.push(`completionPolicy=${options.completionPolicy}`);
  }
  if (!hasProperty(properties, 'llmContextWindowTokens')) {
    missing.push('llmContextWindowTokens');
  }
  if (!enumIncludes(properties.llmExtractionStrategy, options.llmExtractionStrategy)) {
    missing.push(`llmExtractionStrategy=${options.llmExtractionStrategy}`);
  }
  if (!hasProperty(properties, 'llmLongContextMaxPapersPerCall')) {
    missing.push('llmLongContextMaxPapersPerCall');
  }
  if (!hasProperty(properties, 'llmBatchConcurrency')) {
    missing.push('llmBatchConcurrency');
  }
  if (!hasProperty(properties, 'files')) {
    missing.push('files');
  }
  if (!enumIncludes(properties.waitUntil, 'graph-visible')) {
    missing.push('waitUntil=graph-visible');
  }
  if (options.waitSemantic && !enumIncludes(properties.waitUntil, 'semantic-complete')) {
    missing.push('waitUntil=semantic-complete');
  }
  if (!hasProperty(properties, 'waitForAuthoritativeSync')) {
    missing.push('waitForAuthoritativeSync');
  }

  if (missing.length) {
    throw new Error(
      `MCP import_workflow schema is not ready for fast-md/default 1M burst validation; missing ${missing.join(', ')}. Deploy or reload the updated PaperNexus MCP server before running --execute with --transport mcp.`
    );
  }
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function taskFromPayload(payload) {
  return payload?.task || payload || {};
}

function isGraphVisibleComplete(task) {
  const graphStatus = normalizeStatus(task.graphVisibilityStatus);
  if (graphStatus) return graphStatus === 'completed';
  return normalizeStatus(task.status) === 'completed';
}

function isSemanticComplete(task) {
  const status = normalizeStatus(task.semanticStatus);
  return status === 'completed' || status === 'not-required';
}

function isTaskFailed(task) {
  return ['failed', 'cancelled', 'canceled'].includes(normalizeStatus(task.status))
    || normalizeStatus(task.graphVisibilityStatus) === 'failed';
}

function isTaskSatisfied(task, options) {
  if (!isGraphVisibleComplete(task)) return false;
  if (!options.waitSemantic) return true;
  return isSemanticComplete(task);
}

function importPerformance(task = {}) {
  return task?.result?.metrics?.importPerformance || {};
}

function summarizeTask(task = {}, local = {}) {
  const perf = importPerformance(task);
  return {
    taskId: task.id || local.taskId || null,
    status: task.status || null,
    stage: task.stage || null,
    processingProfile: task.processingProfile || null,
    completionPolicy: task.completionPolicy || null,
    graphVisibilityStatus: task.graphVisibilityStatus || null,
    semanticStatus: task.semanticStatus || null,
    authoritativeSyncStatus: task.authoritativeSyncStatus || task?.result?.authoritativeSync?.status || null,
    progress: task.progress || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    finishedAt: task.finishedAt || null,
    submittedAt: local.submittedAt || null,
    observedGraphVisibleAt: local.observedGraphVisibleAt || null,
    graphVisibleLatencyMs: Number(task?.throughputMetrics?.graphVisibleLatencyMs ?? task?.result?.throughputMetrics?.graphVisibleLatencyMs ?? NaN),
    observedGraphVisibleLatencyMs: Number(local.observedGraphVisibleLatencyMs ?? NaN),
    error: local.error || task?.error?.message || task?.error || null,
    stageTimingsMs: perf.stageTimingsMs || {},
    fastCommitPhasesMs: perf.fastCommitPhasesMs || {},
    llmOptimizeSkipped: Boolean(perf.llmOptimizeSkipped),
    changedSourceKeys: task?.result?.fastCommitted?.changedSourceKeys || [],
    semanticJobIds: task?.result?.semanticEnrichment?.jobIds || [],
    fileCount: Array.isArray(task.files) ? task.files.length : null
  };
}

function percentile(values, fraction) {
  const numeric = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!numeric.length) return null;
  const index = Math.ceil(numeric.length * fraction) - 1;
  return numeric[Math.max(0, Math.min(index, numeric.length - 1))];
}

function numericMax(values) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  return numeric.length ? Math.max(...numeric) : null;
}

function buildDefault1mEffectiveConfig(options = {}) {
  const config = {
    processingProfile: options.processingProfile,
    completionPolicy: options.completionPolicy,
    llmContextWindowTokens: options.llmContextWindowTokens,
    llmExtractionStrategy: options.llmExtractionStrategy,
    llmLongContextMaxPapersPerCall: options.llmLongContextMaxPapersPerCall,
    llmBatchConcurrency: options.llmBatchConcurrency,
    graphVisibleCriticalPath: 'fast-md-structural',
    semanticEnrichmentPath: 'background-long-context-first',
    llmConfigScope: 'task-request',
    taskLevelLlmOverride: true
  };
  const deviationReasons = [];
  if (config.llmContextWindowTokens !== DEFAULT_LLM_CONTEXT_WINDOW_TOKENS) {
    deviationReasons.push('llmContextWindowTokens');
  }
  if (config.llmExtractionStrategy !== DEFAULT_LLM_EXTRACTION_STRATEGY) {
    deviationReasons.push('llmExtractionStrategy');
  }
  return {
    ...config,
    deviatesFromDefault1mContext: deviationReasons.length > 0,
    deviationReasons
  };
}

async function writeReport(reportPath, report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function submitTasks({ sources, options, token }) {
  if (options.transport === 'mcp') {
    return submitTasksMcp({ sources, options, token });
  }
  return submitTasksHttp({ sources, options, token });
}

async function submitTasksHttp({ sources, options, token }) {
  const tasks = [];
  const startedMs = Date.now();
  let lastSubmittedMs = startedMs;

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const rawContent = await fs.readFile(source.path);
    const uploadContent = options.reuseContent ? rawContent : appendRunMarker(rawContent, options.runId, index + 1);
    const body = buildImportBody({
      source,
      content: uploadContent,
      index,
      options
    });
    const submittedAtMs = Date.now();
    const payload = await apiJson({
      apiBase: options.apiBase,
      token,
      method: 'POST',
      pathname: '/api/imports',
      params: { name: options.corpus },
      body,
      requestTimeoutMs: options.requestTimeoutMs
    });
    lastSubmittedMs = Date.now();
    const task = taskFromPayload(payload);
    tasks.push({
      taskId: task.id,
      transport: 'http',
      sourcePath: source.path,
      sourceName: source.name,
      submittedAtMs,
      submittedAt: new Date(submittedAtMs).toISOString(),
      response: summarizeTask(task, {
        taskId: task.id,
        submittedAt: new Date(submittedAtMs).toISOString()
      }),
      deduped: Boolean(payload.deduped)
    });
  }

  return {
    tasks,
    transport: 'http',
    submitStartedMs: startedMs,
    lastSubmittedMs,
    submitElapsedMs: lastSubmittedMs - startedMs
  };
}

async function submitTasksMcp({ sources, options, token }) {
  const mcp = await createMcpClient({ options, token });
  await assertMcpImportWorkflowContract(mcp, options);
  const tasks = [];
  const startedMs = Date.now();
  let lastSubmittedMs = startedMs;

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const rawContent = await fs.readFile(source.path);
    const uploadContent = options.reuseContent ? rawContent : appendRunMarker(rawContent, options.runId, index + 1);
    const body = buildImportBody({
      source,
      content: uploadContent,
      index,
      options
    });
    const submittedAtMs = Date.now();
    const payload = await mcp.callTool(MCP_IMPORT_WORKFLOW_TOOL, {
      operation: 'submit',
      corpus: options.corpus,
      ...body
    });
    lastSubmittedMs = Date.now();
    const task = taskFromPayload(payload);
    tasks.push({
      taskId: task.id,
      transport: 'mcp',
      sourcePath: source.path,
      sourceName: source.name,
      submittedAtMs,
      submittedAt: new Date(submittedAtMs).toISOString(),
      response: summarizeTask(task, {
        taskId: task.id,
        submittedAt: new Date(submittedAtMs).toISOString()
      }),
      deduped: Boolean(payload.deduped)
    });
  }

  return {
    tasks,
    transport: 'mcp',
    mcp,
    submitStartedMs: startedMs,
    lastSubmittedMs,
    submitElapsedMs: lastSubmittedMs - startedMs
  };
}

async function pollTasks({ submitted, options, token }) {
  if (options.transport === 'mcp') {
    return waitTasksMcp({ submitted, options });
  }
  return pollTasksHttp({ submitted, options, token });
}

async function pollTasksHttp({ submitted, options, token }) {
  const taskStates = new Map();
  const deadline = Date.now() + options.timeoutMs;
  let timedOut = false;

  for (const entry of submitted.tasks) {
    taskStates.set(entry.taskId, {
      ...entry,
      latestTask: entry.response,
      observedGraphVisibleAtMs: null,
      observedGraphVisibleAt: null,
      observedGraphVisibleLatencyMs: null
    });
  }

  while (true) {
    for (const entry of taskStates.values()) {
      if (!entry.taskId) continue;
      if (isTaskSatisfied(entry.latestTask, options) || isTaskFailed(entry.latestTask)) continue;

      const payload = await apiJson({
        apiBase: options.apiBase,
        token,
        method: 'GET',
        pathname: `/api/imports/${encodeURIComponent(entry.taskId)}`,
        params: { name: options.corpus },
        requestTimeoutMs: options.requestTimeoutMs
      });
      const task = taskFromPayload(payload);
      entry.latestTask = task;
      if (isGraphVisibleComplete(task) && !entry.observedGraphVisibleAtMs) {
        entry.observedGraphVisibleAtMs = Date.now();
        entry.observedGraphVisibleAt = new Date(entry.observedGraphVisibleAtMs).toISOString();
        entry.observedGraphVisibleLatencyMs = entry.observedGraphVisibleAtMs - entry.submittedAtMs;
      }
    }

    const states = [...taskStates.values()];
    const allDone = states.every((entry) => isTaskSatisfied(entry.latestTask, options) || isTaskFailed(entry.latestTask));
    if (allDone) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }

  return {
    timedOut,
    tasks: [...taskStates.values()]
  };
}

async function waitTasksMcp({ submitted, options }) {
  const deadline = Date.now() + options.timeoutMs;
  const taskStates = submitted.tasks.map((entry) => ({
    ...entry,
    latestTask: entry.response,
    observedGraphVisibleAtMs: null,
    observedGraphVisibleAt: null,
    observedGraphVisibleLatencyMs: null,
    error: null
  }));

  const waitOne = async (entry) => {
    if (!entry.taskId) {
      entry.error = 'missing task id';
      return;
    }
    try {
      const remainingMs = Math.max(1000, deadline - Date.now());
      const baseArgs = {
        operation: 'wait',
        corpus: options.corpus,
        taskId: entry.taskId,
        waitForAuthoritativeSync: false,
        timeout: Math.max(1, Math.ceil(remainingMs / 1000)),
        interval: Math.max(0.05, options.pollIntervalMs / 1000)
      };
      const graphPayload = await submitted.mcp.callTool(MCP_IMPORT_WORKFLOW_TOOL, {
        ...baseArgs,
        waitUntil: 'graph-visible'
      });
      const graphTask = taskFromPayload(graphPayload);
      entry.latestTask = graphTask;
      if (isGraphVisibleComplete(graphTask) && !entry.observedGraphVisibleAtMs) {
        entry.observedGraphVisibleAtMs = Date.now();
        entry.observedGraphVisibleAt = new Date(entry.observedGraphVisibleAtMs).toISOString();
        entry.observedGraphVisibleLatencyMs = entry.observedGraphVisibleAtMs - entry.submittedAtMs;
      }

      if (options.waitSemantic && !isTaskFailed(entry.latestTask)) {
        const semanticRemainingMs = Math.max(1000, deadline - Date.now());
        const semanticPayload = await submitted.mcp.callTool(MCP_IMPORT_WORKFLOW_TOOL, {
          ...baseArgs,
          timeout: Math.max(1, Math.ceil(semanticRemainingMs / 1000)),
          waitUntil: 'semantic-complete'
        });
        entry.latestTask = taskFromPayload(semanticPayload);
      }
    } catch (error) {
      entry.error = error?.message || String(error);
    }
  };

  await Promise.all(taskStates.map(waitOne));
  const timedOut = Date.now() >= deadline
    || taskStates.some((entry) => /abort|timed?\s*out|timeout/i.test(String(entry.error || '')));

  return {
    timedOut,
    tasks: taskStates
  };
}

async function buildDryRunReport({ options, sources, tokenSource, tokenPresent }) {
  const sourceFiles = [];
  for (const source of sources) {
    const content = await fs.readFile(source.path);
    sourceFiles.push({
      ...source,
      sha256: `sha256:${sha256Hex(content)}`
    });
  }
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    runId: options.runId,
    dryRun: true,
    transport: options.transport,
    apiBase: options.apiBase,
    mcpUrl: options.transport === 'mcp' ? options.mcpUrl : null,
    corpus: options.corpus,
    token: {
      source: tokenSource,
      present: tokenPresent
    },
    effectiveConfig: buildDefault1mEffectiveConfig(options),
    options: reportOptions(options),
    sourceFiles,
    acceptance: {
      targetMs: 60_000,
      executeRequired: true,
      passedFromLastSubmit: false,
      reason: 'dry-run'
    }
  };
}

function reportOptions(options) {
  return {
    transport: options.transport,
    processingProfile: options.processingProfile,
    completionPolicy: options.completionPolicy,
    llmContextWindowTokens: options.llmContextWindowTokens,
    llmExtractionStrategy: options.llmExtractionStrategy,
    llmLongContextMaxPapersPerCall: options.llmLongContextMaxPapersPerCall,
    llmBatchConcurrency: options.llmBatchConcurrency,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    limit: options.limit,
    waitSemantic: options.waitSemantic,
    reuseContent: options.reuseContent,
    runMarkerEnabled: !options.reuseContent
  };
}

async function buildExecuteReport({ options, sources, tokenSource, submitted, polled }) {
  const sourceFiles = [];
  for (const source of sources) {
    const content = await fs.readFile(source.path);
    sourceFiles.push({
      ...source,
      sha256: `sha256:${sha256Hex(content)}`
    });
  }

  const taskRows = polled.tasks.map((entry) => summarizeTask(entry.latestTask, {
    taskId: entry.taskId,
    submittedAt: entry.submittedAt,
    observedGraphVisibleAt: entry.observedGraphVisibleAt,
    observedGraphVisibleLatencyMs: entry.observedGraphVisibleLatencyMs,
    error: entry.error
  }));
  const observedLatencies = polled.tasks.map((entry) => entry.observedGraphVisibleLatencyMs);
  const completedTimes = polled.tasks
    .map((entry) => entry.observedGraphVisibleAtMs)
    .filter((value) => Number.isFinite(value));
  const latestCompletedMs = completedTimes.length ? Math.max(...completedTimes) : null;
  const completedCount = taskRows.filter((task) => isGraphVisibleComplete(task)).length;
  const failedCount = taskRows.filter((task) => isTaskFailed(task)).length;
  const elapsedFromFirstSubmit = latestCompletedMs === null ? null : latestCompletedMs - submitted.submitStartedMs;
  const elapsedFromLastSubmit = latestCompletedMs === null ? null : latestCompletedMs - submitted.lastSubmittedMs;

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    runId: options.runId,
    dryRun: false,
    transport: options.transport,
    apiBase: options.apiBase,
    mcpUrl: options.transport === 'mcp' ? options.mcpUrl : null,
    corpus: options.corpus,
    token: {
      source: tokenSource,
      present: true
    },
    effectiveConfig: buildDefault1mEffectiveConfig(options),
    options: reportOptions(options),
    sourceFiles,
    submittedTasks: submitted.tasks.map((task) => ({
      taskId: task.taskId,
      transport: task.transport || options.transport,
      sourcePath: task.sourcePath,
      sourceName: task.sourceName,
      submittedAt: task.submittedAt,
      deduped: task.deduped
    })),
    timings: {
      submitElapsedMs: submitted.submitElapsedMs,
      graphVisibleElapsedMsFromFirstSubmit: elapsedFromFirstSubmit,
      graphVisibleElapsedMsFromLastSubmit: elapsedFromLastSubmit,
      maxGraphVisibleLatencyMs: numericMax(observedLatencies),
      p95GraphVisibleLatencyMs: percentile(observedLatencies, 0.95)
    },
    acceptance: {
      targetMs: 60_000,
      completedCount,
      failedCount,
      submittedCount: submitted.tasks.length,
      timedOut: polled.timedOut,
      passedFromLastSubmit: completedCount === submitted.tasks.length
        && failedCount === 0
        && !polled.timedOut
        && elapsedFromLastSubmit !== null
        && elapsedFromLastSubmit <= 60_000,
      passedMaxLatency: completedCount === submitted.tasks.length
        && failedCount === 0
        && !polled.timedOut
        && numericMax(observedLatencies) !== null
        && numericMax(observedLatencies) <= 60_000
    },
    tasks: taskRows
  };
}

function normalizeOptions(rawOptions) {
  const runId = normalizeRunId(rawOptions.runId);
  const apiBase = String(rawOptions.apiBase || process.env.PAPERNEXUS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const transport = normalizeTransport(rawOptions.transport || process.env.PAPERNEXUS_BURST_TRANSPORT || DEFAULT_TRANSPORT);
  const mcpUrl = String(rawOptions.mcpUrl || process.env.PAPERNEXUS_MCP_URL || defaultMcpUrl(apiBase)).replace(/\/+$/, '');
  return {
    ...rawOptions,
    runId,
    transport,
    apiBase,
    mcpUrl,
    corpus: String(rawOptions.corpus || process.env.PAPERNEXUS_CORPUS || DEFAULT_CORPUS).trim(),
    limit: parsePositiveInt(rawOptions.limit, DEFAULT_LIMIT, '--limit'),
    pollIntervalMs: parsePositiveInt(rawOptions.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, '--poll-interval-ms'),
    timeoutMs: parsePositiveInt(rawOptions.timeoutMs, DEFAULT_TIMEOUT_MS, '--timeout-ms'),
    requestTimeoutMs: parsePositiveInt(rawOptions.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, '--request-timeout-ms'),
    processingProfile: String(rawOptions.processingProfile || DEFAULT_PROCESSING_PROFILE).trim(),
    completionPolicy: String(rawOptions.completionPolicy || DEFAULT_COMPLETION_POLICY).trim(),
    llmContextWindowTokens: parsePositiveInt(rawOptions.llmContextWindowTokens, DEFAULT_LLM_CONTEXT_WINDOW_TOKENS, '--llm-context-window-tokens'),
    llmExtractionStrategy: String(rawOptions.llmExtractionStrategy || DEFAULT_LLM_EXTRACTION_STRATEGY).trim(),
    llmLongContextMaxPapersPerCall: parsePositiveInt(
      rawOptions.llmLongContextMaxPapersPerCall,
      DEFAULT_LLM_LONG_CONTEXT_MAX_PAPERS_PER_CALL,
      '--llm-long-context-max-papers-per-call'
    ),
    llmBatchConcurrency: parsePositiveInt(rawOptions.llmBatchConcurrency, DEFAULT_LLM_BATCH_CONCURRENCY, '--llm-batch-concurrency'),
    identifierPrefix: String(rawOptions.identifierPrefix || DEFAULT_IDENTIFIER_PREFIX).trim(),
    report: rawOptions.report
      ? path.resolve(rawOptions.report)
      : `/tmp/papernexus-live-import-burst-report-${runId}.json`
  };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printUsage();
    return 0;
  }

  const options = normalizeOptions(parsed);
  const { token, tokenSource } = await readToken(options);

  if (options.schemaCheckOnly) {
    if (options.transport !== 'mcp') {
      throw new Error('--schema-check-only requires --transport mcp.');
    }
    if (!token) {
      throw new Error('A PaperNexus API token is required for MCP schema checks. Use PAPERNEXUS_API_TOKEN, --token, or --token-file.');
    }
    const mcp = await createMcpClient({ options, token });
    await assertMcpImportWorkflowContract(mcp, options);
    console.log(`MCP import_workflow schema is ready for fast-md/default 1M burst validation at ${options.mcpUrl}.`);
    console.log(`Token source: ${tokenSource}; no import tasks submitted.`);
    return 0;
  }

  const sources = await collectSourceFiles(options);

  if (!options.execute) {
    const report = await buildDryRunReport({
      options,
      sources,
      tokenSource,
      tokenPresent: Boolean(token)
    });
    await writeReport(options.report, report);
    console.log(`Dry run selected ${sources.length} markdown file(s). Report: ${options.report}`);
    console.log('Add --execute to submit real PaperNexus import tasks.');
    return 0;
  }

  if (!token) {
    throw new Error('A PaperNexus API token is required in execute mode. Use PAPERNEXUS_API_TOKEN, --token, or --token-file.');
  }

  const submitted = await submitTasks({ sources, options, token });
  const polled = await pollTasks({ submitted, options, token });
  const report = await buildExecuteReport({
    options,
    sources,
    tokenSource,
    submitted,
    polled
  });
  await writeReport(options.report, report);

  const acceptance = report.acceptance;
  const elapsed = report.timings.graphVisibleElapsedMsFromLastSubmit;
  console.log(`Submitted ${acceptance.submittedCount} task(s); graph-visible completed ${acceptance.completedCount}/${acceptance.submittedCount}.`);
  console.log(`Elapsed from last submit: ${elapsed === null ? 'n/a' : `${elapsed}ms`}; report: ${options.report}`);
  if (!acceptance.passedFromLastSubmit || !acceptance.passedMaxLatency) {
    process.exitCode = 1;
  }
  return process.exitCode || 0;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

export {
  CONTRACT_VERSION,
  collectSourceFiles,
  isGraphVisibleComplete,
  normalizeOptions,
  parseArgs,
  reportOptions
};
