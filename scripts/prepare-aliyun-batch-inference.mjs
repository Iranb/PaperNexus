#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const DEFAULT_MODEL = 'qwen-plus';
const DEFAULT_METHOD = 'POST';
const DEFAULT_URL = '/v1/chat/completions';
const DEFAULT_ALIYUN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MAX_REQUESTS = 50000;
const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 6 * 1024 * 1024;
const DEFAULT_REMOTE_MAX_REQUESTS = 10;
const MAX_CUSTOM_ID_CHARS = 256;
const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);

const ALIYUN_BATCH_DOCS = [
  'https://help.aliyun.com/zh/model-studio/batch-inference',
  'https://help.aliyun.com/zh/model-studio/batch-interfaces-compatible-with-openai'
];

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseBytes(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = String(match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 * 1000,
    gb: 1000 * 1000 * 1000,
    kib: 1024,
    mib: 1024 * 1024,
    gib: 1024 * 1024 * 1024
  };
  return Math.floor(amount * (multipliers[unit] || 1));
}

function resolveRemoteMode(value = 'offline') {
  const normalized = compactText(value || 'offline').toLowerCase().replace(/_/g, '-');
  if (['false', 'none', 'off', 'offline', 'prepare'].includes(normalized)) return 'offline';
  if (['true', 'submit', 'upload', 'create'].includes(normalized)) return 'submit';
  if (['submit-and-wait', 'submit-wait', 'wait', 'poll', 'retrieve'].includes(normalized)) return 'submit-and-wait';
  return normalized;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }
  return resolveOptions(options);
}

function resolveOptions(options = {}) {
  const runId = String(options.runId || `aliyun-batch-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const jsonMode = parseBoolean(options.jsonMode, false);
  const responseFormat = compactText(options.responseFormat || (jsonMode ? 'json_object' : ''));
  const apiKeyEnv = compactText(options.apiKeyEnv || 'DASHSCOPE_API_KEY');
  const submitRemote = parseBoolean(options.submitRemote, false);
  const remoteMode = resolveRemoteMode(options.remoteMode || (submitRemote ? 'submit' : 'offline'));
  return {
    help: Boolean(options.help),
    runId,
    inputPath: options.inputPath || options.input || null,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'llm-batch', runId)),
    model: compactText(options.model || DEFAULT_MODEL),
    method: compactText(options.method || DEFAULT_METHOD).toUpperCase(),
    url: compactText(options.url || options.endpoint || DEFAULT_URL),
    systemPrompt: options.systemPrompt || '',
    temperature: parseNumber(options.temperature, null),
    maxTokens: parseInteger(options.maxTokens || options.maxCompletionTokens, null),
    responseFormat,
    enableThinking: options.enableThinking === undefined ? null : parseBoolean(options.enableThinking, null),
    thinkingBudget: parseInteger(options.thinkingBudget, null),
    maxRequests: parseInteger(options.maxRequests, DEFAULT_MAX_REQUESTS),
    maxFileBytes: parseBytes(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    maxLineBytes: parseBytes(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES),
    resultPaths: parseCsv(options.resultPath || options.resultsPath || options.outputFile || options.resultPaths, []),
    errorPaths: parseCsv(options.errorPath || options.errorsPath || options.errorPaths, []),
    allowInvalid: parseBoolean(options.allowInvalid, false),
    remoteMode,
    confirmCost: parseBoolean(options.confirmCost || options.allowRemoteCost || options.allowCost, false),
    apiKeyEnv,
    apiKey: options.apiKey || process.env[apiKeyEnv] || '',
    baseUrl: compactText(options.baseUrl || options.aliyunBaseUrl || DEFAULT_ALIYUN_BASE_URL).replace(/\/+$/, ''),
    completionWindow: compactText(options.completionWindow || '24h'),
    remoteMaxRequests: parseInteger(options.remoteMaxRequests, DEFAULT_REMOTE_MAX_REQUESTS),
    pollIntervalMs: parseInteger(options.pollIntervalMs, 10000),
    pollTimeoutMs: parseInteger(options.pollTimeoutMs, 10 * 60 * 1000),
    downloadRemoteResults: parseBoolean(options.downloadRemoteResults || options.downloadResults, remoteMode === 'submit-and-wait'),
    remoteMetadata: parseJsonObject(options.remoteMetadata || options.metadata, {})
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/prepare-aliyun-batch-inference.mjs --input <entries.json|entries.jsonl> --output-dir <dir> [--model qwen-plus]',
    '  node scripts/prepare-aliyun-batch-inference.mjs --input entries.json --result-path output.jsonl --error-path errors.jsonl',
    '  node scripts/prepare-aliyun-batch-inference.mjs --input entries.json --remote-mode submit --confirm-cost true',
    '',
    'Input entries may already be OpenAI-compatible requests, or may contain messages/prompt/text/title/abstract fields.',
    'Default mode only prepares and validates offline artifacts. Remote upload/create/poll requires --remote-mode and --confirm-cost true.'
  ].join('\n');
}

function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function sourceIdForEntry(entry = {}, index = 0) {
  return compactText(
    entry.sourceId
    || entry.paperId
    || entry.paper_id
    || entry.id
    || entry.custom_id
    || entry.customId
    || entry.title
    || `entry-${index + 1}`
  );
}

function sanitizeCustomId(value = '') {
  return compactText(value)
    .replace(/[\r\n\t]/g, '_')
    .replace(/[^\w.:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function assignCustomId(entry = {}, index = 0, seen = new Set()) {
  const sourceId = sourceIdForEntry(entry, index);
  const requested = compactText(entry.custom_id || entry.customId || sourceId);
  const sanitized = sanitizeCustomId(requested);
  let reason = 'preserved';
  let customId = sanitized;

  if (!customId) {
    reason = 'missing';
  } else if (customId.length > MAX_CUSTOM_ID_CHARS) {
    reason = 'too_long';
  } else if (customId !== requested) {
    reason = 'unsafe_characters';
  } else if (seen.has(customId)) {
    reason = 'duplicate';
  }

  if (reason !== 'preserved') {
    const prefix = `pn_${String(index + 1).padStart(6, '0')}`;
    customId = `${prefix}_${stableHash({ requested, sourceId, index })}`;
  }

  while (seen.has(customId)) {
    customId = `pn_${String(index + 1).padStart(6, '0')}_${stableHash({ requested, sourceId, index, collision: seen.size })}`;
    reason = reason === 'preserved' ? 'duplicate' : reason;
  }

  seen.add(customId);
  return {
    customId,
    sourceId,
    requestedCustomId: requested,
    mappedReason: reason
  };
}

function normalizeMessage(message = {}) {
  const normalized = {
    role: compactText(message.role || 'user'),
    content: message.content ?? ''
  };
  if (!normalized.role) normalized.role = 'user';
  return normalized;
}

function buildPaperPrompt(entry = {}) {
  const title = compactText(entry.title || entry.paperTitle || entry.paper_title);
  const abstract = compactText(entry.abstract || entry.summary);
  const text = compactText(entry.text || entry.fullText || entry.markdown);
  const parts = [
    'Extract compact PaperNexus semantic JSON for this paper.',
    title ? `Title: ${title}` : '',
    abstract ? `Abstract: ${abstract}` : '',
    text ? `Text: ${text}` : ''
  ].filter(Boolean);
  return parts.join('\n\n');
}

function buildMessages(entry = {}, options = {}) {
  if (Array.isArray(entry.messages)) return entry.messages.map(normalizeMessage);
  const system = compactText(entry.system || entry.systemPrompt || options.systemPrompt);
  const user = entry.prompt ?? entry.user ?? entry.content ?? entry.text ?? entry.input ?? buildPaperPrompt(entry);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return messages.map(normalizeMessage);
}

function applyOptionalBodyFields(body = {}, entry = {}, options = {}) {
  const next = { ...body };
  if (!next.model) next.model = compactText(entry.model || options.model || DEFAULT_MODEL);
  if (!next.messages && !next.input) next.messages = buildMessages(entry, options);
  if (options.temperature !== null && next.temperature === undefined) next.temperature = options.temperature;
  if (options.maxTokens !== null && next.max_tokens === undefined) next.max_tokens = options.maxTokens;
  if (options.responseFormat && next.response_format === undefined) {
    next.response_format = { type: options.responseFormat };
  }
  if (options.enableThinking !== null && next.enable_thinking === undefined) {
    next.enable_thinking = options.enableThinking;
  }
  if (options.thinkingBudget !== null && next.thinking_budget === undefined) {
    next.thinking_budget = options.thinkingBudget;
  }
  return next;
}

export function normalizeAliyunBatchRequest(entry = {}, index = 0, options = {}, seenCustomIds = new Set()) {
  const idMapping = assignCustomId(entry, index, seenCustomIds);
  const body = applyOptionalBodyFields(asObject(entry.body), entry, options);
  const request = {
    custom_id: idMapping.customId,
    method: compactText(entry.method || options.method || DEFAULT_METHOD).toUpperCase(),
    url: compactText(entry.url || options.url || DEFAULT_URL),
    body
  };
  return {
    request,
    idMapping: {
      ...idMapping,
      sourceIndex: index,
      model: compactText(body.model),
      url: request.url
    }
  };
}

function thinkingSignature(body = {}) {
  return JSON.stringify({
    enable_thinking: body.enable_thinking ?? null,
    thinking_budget: body.thinking_budget ?? null
  });
}

function requestGroupKey(request = {}) {
  return [
    request.method,
    request.url,
    compactText(request.body?.model),
    thinkingSignature(request.body || {})
  ].join('\t');
}

function requestLine(request = {}) {
  return JSON.stringify(request);
}

export function validateAliyunBatchRequests(requests = [], options = {}) {
  const errors = [];
  const warnings = [];
  const customIds = new Set();
  let maxLineBytes = 0;
  let totalBytes = 0;

  if (!requests.length) {
    errors.push({ code: 'empty_input', message: 'At least one request is required.' });
  }

  requests.forEach((request, index) => {
    const line = requestLine(request);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    maxLineBytes = Math.max(maxLineBytes, lineBytes);
    totalBytes += lineBytes + 1;

    if (!request.custom_id || typeof request.custom_id !== 'string') {
      errors.push({ code: 'missing_custom_id', index, message: 'custom_id is required.' });
    } else if (request.custom_id.length > MAX_CUSTOM_ID_CHARS) {
      errors.push({ code: 'custom_id_too_long', index, customId: request.custom_id, message: 'custom_id must be at most 256 characters.' });
    } else if (customIds.has(request.custom_id)) {
      errors.push({ code: 'duplicate_custom_id', index, customId: request.custom_id, message: 'custom_id must be unique within the generated files.' });
    }
    customIds.add(request.custom_id);

    if (request.method !== 'POST') {
      errors.push({ code: 'unsupported_method', index, method: request.method, message: 'Aliyun Batch currently expects POST requests.' });
    }
    if (!String(request.url || '').startsWith('/v1/')) {
      errors.push({ code: 'invalid_url', index, url: request.url, message: 'url should be an OpenAI-compatible endpoint such as /v1/chat/completions.' });
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      errors.push({ code: 'invalid_body', index, message: 'body must be an object.' });
    } else {
      if (!compactText(request.body.model)) {
        errors.push({ code: 'missing_model', index, message: 'body.model is required.' });
      }
      if (request.url === '/v1/chat/completions' && !Array.isArray(request.body.messages)) {
        errors.push({ code: 'missing_messages', index, message: 'body.messages is required for /v1/chat/completions.' });
      }
      if (request.url === '/v1/embeddings' && request.body.input === undefined) {
        errors.push({ code: 'missing_embedding_input', index, message: 'body.input is required for /v1/embeddings.' });
      }
    }
    if (lineBytes > options.maxLineBytes) {
      errors.push({ code: 'line_too_large', index, lineBytes, maxLineBytes: options.maxLineBytes, message: 'One JSONL request exceeds the configured per-line byte limit.' });
    }
    if (lineBytes + 1 > options.maxFileBytes) {
      errors.push({ code: 'line_exceeds_file_limit', index, lineBytes, maxFileBytes: options.maxFileBytes, message: 'One JSONL request cannot fit inside one batch input file.' });
    }
  });

  if (requests.length > options.maxRequests) {
    warnings.push({
      code: 'request_count_requires_sharding',
      requestCount: requests.length,
      maxRequestsPerFile: options.maxRequests,
      message: 'Input exceeds one Batch file request limit and will be sharded into multiple JSONL files.'
    });
  }

  return {
    status: errors.length ? 'failed' : 'passed',
    requestCount: requests.length,
    totalUnshardedBytes: totalBytes,
    maxLineBytes,
    limits: {
      maxRequestsPerFile: options.maxRequests,
      maxFileBytes: options.maxFileBytes,
      maxLineBytes: options.maxLineBytes,
      maxCustomIdChars: MAX_CUSTOM_ID_CHARS
    },
    errors,
    warnings
  };
}

function planShards(requests = [], options = {}) {
  const groups = new Map();
  for (const request of requests) {
    const key = requestGroupKey(request);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }

  const shards = [];
  for (const [groupKey, groupRequests] of groups.entries()) {
    let current = [];
    let currentBytes = 0;
    for (const request of groupRequests) {
      const lineBytes = Buffer.byteLength(requestLine(request), 'utf8') + 1;
      const overRequestLimit = current.length >= options.maxRequests;
      const overByteLimit = current.length && (currentBytes + lineBytes > options.maxFileBytes);
      if (overRequestLimit || overByteLimit) {
        shards.push({ groupKey, requests: current, byteLength: currentBytes });
        current = [];
        currentBytes = 0;
      }
      current.push(request);
      currentBytes += lineBytes;
    }
    if (current.length) shards.push({ groupKey, requests: current, byteLength: currentBytes });
  }

  return shards.map((shard, index) => {
    const first = shard.requests[0] || {};
    return {
      shardIndex: index,
      groupKey: shard.groupKey,
      method: first.method,
      url: first.url,
      model: compactText(first.body?.model),
      thinkingMode: JSON.parse(thinkingSignature(first.body || {})),
      requestCount: shard.requests.length,
      byteLength: shard.byteLength,
      fileName: shards.length === 1 ? 'batch-input.jsonl' : `batch-input-${String(index + 1).padStart(4, '0')}.jsonl`,
      requests: shard.requests
    };
  });
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        error.message = `${filePath}:${index + 1}: ${error.message}`;
        throw error;
      }
    });
}

async function readInputEntries(inputPath) {
  const absolute = path.resolve(inputPath);
  if (absolute.toLowerCase().endsWith('.jsonl')) return readJsonl(absolute);
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['entries', 'requests', 'items', 'papers', 'documents']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new Error(`Unsupported input file shape: ${inputPath}`);
}

function tryParseContentJson(content) {
  if (content && typeof content === 'object') return content;
  const text = String(content || '').trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  for (const candidate of [
    unfenced,
    unfenced.slice(unfenced.indexOf('{'), unfenced.lastIndexOf('}') + 1),
    unfenced.slice(unfenced.indexOf('['), unfenced.lastIndexOf(']') + 1)
  ]) {
    if (!candidate || candidate.length < 2) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function responseContent(body = {}) {
  const choice = asArray(body.choices)[0] || {};
  if (choice.message?.content !== undefined) return choice.message.content;
  if (choice.text !== undefined) return choice.text;
  return '';
}

function usageFromBody(body = {}) {
  return asObject(body.usage);
}

function mapRowsByCustomId(rows = []) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.customId, row);
  }
  return map;
}

function parseBatchOutputRow(row = {}, idMap = new Map(), source = 'result') {
  const customId = compactText(row.custom_id || row.customId);
  const idMapping = idMap.get(customId) || {};
  const response = asObject(row.response);
  const body = asObject(response.body || row.body);
  const error = row.error || response.error || (Number(response.status_code || response.statusCode || 0) >= 400 ? body : null);
  const content = responseContent(body);
  const parsedJson = tryParseContentJson(content);
  const usage = usageFromBody(body);
  return {
    customId,
    sourceId: idMapping.sourceId || customId,
    sourceIndex: idMapping.sourceIndex ?? null,
    status: error ? 'failed' : 'completed',
    statusCode: response.status_code || response.statusCode || null,
    requestId: response.request_id || response.requestId || body.id || row.id || null,
    model: body.model || idMapping.model || null,
    finishReason: asArray(body.choices)[0]?.finish_reason || null,
    content,
    parsedJson,
    usage,
    error: error || null,
    source
  };
}

async function appendJsonl(filePath, row) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

async function parseBatchOutputs({ resultPaths = [], errorPaths = [], idMappings = [], outputDir }) {
  const idMap = mapRowsByCustomId(idMappings);
  const parsedResultsPath = path.join(outputDir, 'parsed-results.jsonl');
  const parsedErrorsPath = path.join(outputDir, 'parsed-errors.jsonl');
  const parsedSummaryPath = path.join(outputDir, 'parsed-summary.json');
  await Promise.all([
    fs.rm(parsedResultsPath, { force: true }),
    fs.rm(parsedErrorsPath, { force: true })
  ]);

  const parsedRows = [];
  for (const resultPath of resultPaths) {
    for (const row of await readJsonl(path.resolve(resultPath))) {
      const parsed = parseBatchOutputRow(row, idMap, 'result');
      parsedRows.push(parsed);
      if (parsed.status === 'completed') {
        await appendJsonl(parsedResultsPath, parsed);
      } else {
        await appendJsonl(parsedErrorsPath, parsed);
      }
    }
  }
  for (const errorPath of errorPaths) {
    for (const row of await readJsonl(path.resolve(errorPath))) {
      const parsed = parseBatchOutputRow({ ...row, error: row.error || row }, idMap, 'error');
      parsedRows.push(parsed);
      await appendJsonl(parsedErrorsPath, parsed);
    }
  }

  const completedRows = parsedRows.filter((row) => row.status === 'completed');
  const failedRows = parsedRows.filter((row) => row.status === 'failed');
  const totalUsage = parsedRows.reduce((usage, row) => ({
    promptTokens: usage.promptTokens + Number(row.usage?.prompt_tokens || row.usage?.promptTokens || 0),
    completionTokens: usage.completionTokens + Number(row.usage?.completion_tokens || row.usage?.completionTokens || 0),
    totalTokens: usage.totalTokens + Number(row.usage?.total_tokens || row.usage?.totalTokens || 0)
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const summary = {
    status: failedRows.length ? 'partial' : 'completed',
    parsedCount: parsedRows.length,
    completedCount: completedRows.length,
    failedCount: failedRows.length,
    totalUsage,
    artifacts: {
      parsedResultsPath,
      parsedErrorsPath,
      parsedSummaryPath
    }
  };
  await writeJson(parsedSummaryPath, summary);
  return summary;
}

async function readOptionalJsonl(filePath) {
  try {
    return await readJsonl(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function ledgerRow(runId, phase, event = {}) {
  return {
    contractVersion: 'papernexus-llm-batch-ledger-v1',
    runId,
    phase,
    updatedAt: new Date().toISOString(),
    ...event
  };
}

function createOfflineBatchId(runId, shard = {}) {
  return stableHash({
    runId,
    shardIndex: shard.shardIndex,
    groupKey: shard.groupKey,
    fileName: shard.fileName || path.basename(shard.filePath || ''),
    requestCount: shard.requestCount
  });
}

async function writeOfflineLlmLedger({ runId, outputDir, shards = [], idMappings = [], parseSummary = null }) {
  const phase = 'aliyun-batch-inference';
  const batchesPath = path.join(outputDir, 'llm-batches.jsonl');
  const resultsPath = path.join(outputDir, 'llm-results.jsonl');
  const failuresPath = path.join(outputDir, 'llm-failures.jsonl');
  await Promise.all([
    fs.rm(batchesPath, { force: true }),
    fs.rm(resultsPath, { force: true }),
    fs.rm(failuresPath, { force: true })
  ]);
  await Promise.all([
    writeText(batchesPath, ''),
    writeText(resultsPath, ''),
    writeText(failuresPath, '')
  ]);

  const customIdToSource = new Map(idMappings.map((mapping) => [mapping.customId, mapping]));
  const customIdToShard = new Map();
  const shardLedgerRows = [];
  for (const shard of shards) {
    const requests = Array.isArray(shard.requests) ? shard.requests : [];
    for (const request of requests) {
      customIdToShard.set(request.custom_id, shard.shardIndex);
    }
    const row = ledgerRow(runId, phase, {
      status: 'prepared',
      batchId: createOfflineBatchId(runId, shard),
      batchNumber: shard.shardIndex + 1,
      totalBatches: shards.length,
      batchSize: shard.requestCount,
      requestCount: shard.requestCount,
      byteLength: shard.byteLength,
      promptChars: null,
      promptMaxChars: null,
      provider: 'aliyun-batch',
      model: shard.model,
      method: shard.method,
      url: shard.url,
      artifactPath: path.join(outputDir, shard.fileName),
      entryIds: requests.map((request) => customIdToSource.get(request.custom_id)?.sourceId || request.custom_id),
      customIds: requests.map((request) => request.custom_id)
    });
    shardLedgerRows.push(row);
    await appendJsonl(batchesPath, row);
  }

  const parsedRows = parseSummary
    ? [
      ...await readOptionalJsonl(parseSummary.artifacts.parsedResultsPath),
      ...await readOptionalJsonl(parseSummary.artifacts.parsedErrorsPath)
    ]
    : [];
  const rowsByShard = new Map();
  for (const row of parsedRows) {
    const shardIndex = customIdToShard.get(row.customId);
    if (shardIndex === undefined) continue;
    if (!rowsByShard.has(shardIndex)) rowsByShard.set(shardIndex, []);
    rowsByShard.get(shardIndex).push(row);
  }

  for (const shardRow of shardLedgerRows) {
    const rows = rowsByShard.get(shardRow.batchNumber - 1) || [];
    if (!rows.length) continue;
    const failedRows = rows.filter((row) => row.status === 'failed');
    await appendJsonl(resultsPath, ledgerRow(runId, phase, {
      status: failedRows.length ? 'completed_with_failures' : 'completed',
      batchId: shardRow.batchId,
      batchNumber: shardRow.batchNumber,
      totalBatches: shardRow.totalBatches,
      batchSize: shardRow.batchSize,
      requestCount: shardRow.requestCount,
      entryIds: shardRow.entryIds,
      customIds: shardRow.customIds,
      provider: 'aliyun-batch',
      model: shardRow.model,
      artifactPath: shardRow.artifactPath,
      results: rows
    }));
    if (failedRows.length) {
      await appendJsonl(failuresPath, ledgerRow(runId, phase, {
        status: 'failed',
        batchId: shardRow.batchId,
        batchNumber: shardRow.batchNumber,
        totalBatches: shardRow.totalBatches,
        batchSize: shardRow.batchSize,
        requestCount: shardRow.requestCount,
        entryIds: failedRows.map((row) => row.sourceId || row.customId),
        customIds: failedRows.map((row) => row.customId),
        provider: 'aliyun-batch',
        model: shardRow.model,
        failedCount: failedRows.length,
        errors: failedRows.map((row) => row.error?.message || row.error?.code || 'request-failed').slice(0, 20)
      }));
    }
  }

  return {
    phase,
    batchesPath,
    resultsPath,
    failuresPath,
    batchCount: shardLedgerRows.length,
    parsedBatchCount: rowsByShard.size
  };
}

async function writeShardFiles(outputDir, shards = []) {
  const shardSummaries = [];
  for (const shard of shards) {
    const filePath = path.join(outputDir, shard.fileName);
    const text = `${shard.requests.map(requestLine).join('\n')}\n`;
    await writeText(filePath, text);
    shardSummaries.push({
      shardIndex: shard.shardIndex,
      groupKey: shard.groupKey,
      method: shard.method,
      url: shard.url,
      model: shard.model,
      thinkingMode: shard.thinkingMode,
      requestCount: shard.requestCount,
      byteLength: Buffer.byteLength(text, 'utf8'),
      filePath
    });
  }
  return shardSummaries;
}

function assertRemoteGuardrails(options = {}, requestCount = 0, fetchImpl = null) {
  if (options.remoteMode === 'offline') return;
  if (!['submit', 'submit-and-wait'].includes(options.remoteMode)) {
    throw new Error(`Unsupported Aliyun remote mode: ${options.remoteMode}`);
  }
  if (!options.confirmCost) {
    throw new Error('Aliyun remote Batch mode requires --confirm-cost true to acknowledge credential and inference cost risk.');
  }
  if (!options.apiKey) {
    throw new Error(`Aliyun remote Batch mode requires an API key via --api-key or ${options.apiKeyEnv}.`);
  }
  if (requestCount > options.remoteMaxRequests) {
    throw new Error(`Aliyun remote Batch guardrail blocked ${requestCount} requests. Increase --remote-max-requests explicitly for larger paid runs.`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Aliyun remote Batch mode requires a fetch implementation.');
  }
}

async function parseAliyunFetchBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

async function fetchAliyunJson(fetchImpl, url, init = {}, operation = 'Aliyun request') {
  const response = await fetchImpl(url, init);
  const body = await parseAliyunFetchBody(response);
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || body?.rawText || response.statusText || 'request failed';
    const error = new Error(`${operation} failed with HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function fetchAliyunText(fetchImpl, url, init = {}, operation = 'Aliyun download') {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    let detail = text || response.statusText || 'request failed';
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch {}
    const error = new Error(`${operation} failed with HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return text;
}

function authorizationHeaders(options = {}) {
  return {
    Authorization: `Bearer ${options.apiKey}`
  };
}

function batchStatus(value = {}) {
  return compactText(value.status || value.batch_status || value.state || 'unknown').toLowerCase();
}

function remoteBatchId(value = {}) {
  return compactText(value.id || value.batch_id || value.batchId);
}

function remoteFileId(value = {}) {
  return compactText(value.id || value.file_id || value.fileId);
}

function remoteFileContentUrl(options = {}, fileId = '') {
  return `${options.baseUrl}/files/${encodeURIComponent(fileId)}/content`;
}

function remoteBatchUrl(options = {}, batchId = '') {
  return `${options.baseUrl}/batches/${encodeURIComponent(batchId)}`;
}

function isTerminalBatchStatus(status) {
  return TERMINAL_BATCH_STATUSES.has(compactText(status).toLowerCase());
}

async function uploadAliyunBatchInput({ fetchImpl, options, shard }) {
  const form = new FormData();
  const fileBuffer = await fs.readFile(shard.filePath);
  form.append('purpose', 'batch');
  form.append('file', new Blob([fileBuffer], { type: 'application/jsonl' }), path.basename(shard.filePath));
  const body = await fetchAliyunJson(fetchImpl, `${options.baseUrl}/files`, {
    method: 'POST',
    headers: authorizationHeaders(options),
    body: form
  }, 'Aliyun Batch file upload');
  return {
    fileId: remoteFileId(body),
    response: body
  };
}

async function createAliyunBatchJob({ fetchImpl, options, runId, shard, upload }) {
  const metadata = {
    ds_name: `PaperNexus ${runId} shard ${shard.shardIndex + 1}`,
    ds_description: 'PaperNexus offline batch artifact submitted through guarded remote smoke path.',
    papernexus_run_id: runId,
    papernexus_shard_index: String(shard.shardIndex),
    papernexus_request_count: String(shard.requestCount),
    ...options.remoteMetadata
  };
  const body = {
    input_file_id: upload.fileId,
    endpoint: shard.url,
    completion_window: options.completionWindow,
    metadata
  };
  const response = await fetchAliyunJson(fetchImpl, `${options.baseUrl}/batches`, {
    method: 'POST',
    headers: {
      ...authorizationHeaders(options),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }, 'Aliyun Batch job creation');
  return {
    batchId: remoteBatchId(response),
    status: batchStatus(response),
    requestBody: body,
    response
  };
}

async function pollAliyunBatchJobs({ fetchImpl, options, jobs = [], statusPath, sleepImpl = null }) {
  const latestByBatchId = new Map(jobs.map((job) => [job.batchId, job]));
  const statusRows = [];
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + Math.max(0, options.pollTimeoutMs);
  let timedOut = false;

  while (true) {
    const pending = [...latestByBatchId.values()].filter((job) => !isTerminalBatchStatus(job.status));
    if (!pending.length) break;

    for (const job of pending) {
      const response = await fetchAliyunJson(fetchImpl, remoteBatchUrl(options, job.batchId), {
        method: 'GET',
        headers: authorizationHeaders(options)
      }, 'Aliyun Batch job status');
      const next = {
        ...job,
        status: batchStatus(response),
        outputFileId: compactText(response.output_file_id || response.outputFileId || job.outputFileId),
        errorFileId: compactText(response.error_file_id || response.errorFileId || job.errorFileId),
        statusResponse: response,
        checkedAt: new Date().toISOString()
      };
      latestByBatchId.set(job.batchId, next);
      const statusRow = {
        event: 'status',
        runId: options.runId,
        shardIndex: job.shardIndex,
        batchId: job.batchId,
        status: next.status,
        outputFileId: next.outputFileId || null,
        errorFileId: next.errorFileId || null,
        checkedAt: next.checkedAt
      };
      statusRows.push(statusRow);
      await appendJsonl(statusPath, statusRow);
    }

    const stillPending = [...latestByBatchId.values()].some((job) => !isTerminalBatchStatus(job.status));
    if (!stillPending) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    await sleep(Math.max(1, options.pollIntervalMs));
  }

  return {
    jobs: [...latestByBatchId.values()],
    statusRows,
    timedOut
  };
}

async function downloadAliyunBatchResults({ fetchImpl, options, outputDir, jobs = [], downloadsPath }) {
  const remoteResultsDir = path.join(outputDir, 'remote-results');
  await ensureDir(remoteResultsDir);
  const resultPaths = [];
  const errorPaths = [];
  const rows = [];

  for (const job of jobs) {
    if (job.outputFileId) {
      const targetPath = path.join(remoteResultsDir, `${job.batchId}-output.jsonl`);
      const text = await fetchAliyunText(fetchImpl, remoteFileContentUrl(options, job.outputFileId), {
        method: 'GET',
        headers: authorizationHeaders(options)
      }, 'Aliyun Batch output download');
      await writeText(targetPath, text.endsWith('\n') ? text : `${text}\n`);
      resultPaths.push(targetPath);
      const row = {
        event: 'downloaded_output',
        runId: options.runId,
        shardIndex: job.shardIndex,
        batchId: job.batchId,
        fileId: job.outputFileId,
        path: targetPath,
        downloadedAt: new Date().toISOString()
      };
      rows.push(row);
      await appendJsonl(downloadsPath, row);
    }
    if (job.errorFileId) {
      const targetPath = path.join(remoteResultsDir, `${job.batchId}-errors.jsonl`);
      const text = await fetchAliyunText(fetchImpl, remoteFileContentUrl(options, job.errorFileId), {
        method: 'GET',
        headers: authorizationHeaders(options)
      }, 'Aliyun Batch error download');
      await writeText(targetPath, text.endsWith('\n') ? text : `${text}\n`);
      errorPaths.push(targetPath);
      const row = {
        event: 'downloaded_error',
        runId: options.runId,
        shardIndex: job.shardIndex,
        batchId: job.batchId,
        fileId: job.errorFileId,
        path: targetPath,
        downloadedAt: new Date().toISOString()
      };
      rows.push(row);
      await appendJsonl(downloadsPath, row);
    }
  }

  return {
    rows,
    resultPaths,
    errorPaths
  };
}

async function runAliyunRemoteBatchLifecycle({ runId, outputDir, shardSummaries = [], options = {}, fetchImpl = globalThis.fetch, sleepImpl = null }) {
  if (options.remoteMode === 'offline') return null;

  const remoteJobsPath = path.join(outputDir, 'remote-jobs.jsonl');
  const remoteStatusPath = path.join(outputDir, 'remote-status.jsonl');
  const remoteDownloadsPath = path.join(outputDir, 'remote-downloads.jsonl');
  const remoteSummaryPath = path.join(outputDir, 'remote-summary.json');
  await Promise.all([
    writeText(remoteJobsPath, ''),
    writeText(remoteStatusPath, ''),
    writeText(remoteDownloadsPath, '')
  ]);

  const jobs = [];
  for (const shard of shardSummaries) {
    const upload = await uploadAliyunBatchInput({ fetchImpl, options, shard });
    const created = await createAliyunBatchJob({ fetchImpl, options, runId, shard, upload });
    const row = {
      event: 'submitted',
      runId,
      shardIndex: shard.shardIndex,
      offlineBatchId: createOfflineBatchId(runId, {
        shardIndex: shard.shardIndex,
        groupKey: shard.groupKey,
        fileName: path.basename(shard.filePath || ''),
        requestCount: shard.requestCount
      }),
      filePath: shard.filePath,
      fileId: upload.fileId,
      batchId: created.batchId,
      status: created.status,
      endpoint: shard.url,
      model: shard.model,
      requestCount: shard.requestCount,
      byteLength: shard.byteLength,
      submittedAt: new Date().toISOString()
    };
    jobs.push(row);
    await appendJsonl(remoteJobsPath, row);
  }

  let latestJobs = jobs;
  let timedOut = false;
  if (options.remoteMode === 'submit-and-wait') {
    const poll = await pollAliyunBatchJobs({
      fetchImpl,
      options,
      jobs,
      statusPath: remoteStatusPath,
      sleepImpl
    });
    latestJobs = poll.jobs;
    timedOut = poll.timedOut;
  }

  const downloads = options.downloadRemoteResults
    ? await downloadAliyunBatchResults({
      fetchImpl,
      options,
      outputDir,
      jobs: latestJobs.filter((job) => isTerminalBatchStatus(job.status)),
      downloadsPath: remoteDownloadsPath
    })
    : { rows: [], resultPaths: [], errorPaths: [] };

  const completedCount = latestJobs.filter((job) => job.status === 'completed').length;
  const failedCount = latestJobs.filter((job) => ['failed', 'expired', 'cancelled'].includes(job.status)).length;
  const terminalCount = latestJobs.filter((job) => isTerminalBatchStatus(job.status)).length;
  const summary = {
    runId,
    kind: 'aliyun-batch-remote-lifecycle',
    status: failedCount ? 'partial' : (timedOut ? 'timeout' : (terminalCount === latestJobs.length && latestJobs.length ? 'completed' : 'submitted')),
    remoteMode: options.remoteMode,
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv,
    apiKeyPresent: Boolean(options.apiKey),
    completionWindow: options.completionWindow,
    submittedCount: jobs.length,
    completedCount,
    failedCount,
    terminalCount,
    timedOut,
    downloadedResultCount: downloads.resultPaths.length,
    downloadedErrorCount: downloads.errorPaths.length,
    jobs: latestJobs,
    resultPaths: downloads.resultPaths,
    errorPaths: downloads.errorPaths,
    artifacts: {
      remoteJobsPath,
      remoteStatusPath,
      remoteDownloadsPath,
      remoteSummaryPath
    }
  };
  await writeJson(remoteSummaryPath, summary);
  return summary;
}

async function appendRemoteLlmLedger({ runId, remoteSummary = null, llmLedger = null }) {
  if (!remoteSummary || !llmLedger) return;
  const phase = 'aliyun-batch-inference';
  for (const job of remoteSummary.jobs || []) {
    await appendJsonl(llmLedger.batchesPath, ledgerRow(runId, phase, {
      status: job.status === 'completed' ? 'remote_completed' : 'remote_submitted',
      batchId: job.offlineBatchId || createOfflineBatchId(runId, { shardIndex: job.shardIndex, groupKey: job.endpoint, fileName: path.basename(job.filePath || ''), requestCount: job.requestCount }),
      remoteBatchId: job.batchId,
      remoteFileId: job.fileId,
      provider: 'aliyun-batch',
      model: job.model,
      artifactPath: job.filePath,
      remoteStatus: job.status,
      endpoint: job.endpoint
    }));
  }
  if (remoteSummary.status === 'timeout' || remoteSummary.failedCount) {
    await appendJsonl(llmLedger.failuresPath, ledgerRow(runId, phase, {
      status: remoteSummary.status === 'timeout' ? 'timeout' : 'failed',
      provider: 'aliyun-batch',
      failedCount: remoteSummary.failedCount,
      errors: (remoteSummary.jobs || [])
        .filter((job) => ['failed', 'expired', 'cancelled'].includes(job.status))
        .map((job) => `${job.batchId}:${job.status}`)
    }));
  }
}

export async function runAliyunBatchPreparation(inputOptions = {}) {
  const options = resolveOptions(inputOptions);
  if (!inputOptions.entries && !options.inputPath) {
    throw new Error('An input path or in-memory entries are required.');
  }

  const outputDir = options.outputDir;
  const manifestPath = path.join(outputDir, 'batch-manifest.json');
  const validationPath = path.join(outputDir, 'schema-validation.json');
  const customIdMapPath = path.join(outputDir, 'custom-id-map.jsonl');
  const startedAt = new Date().toISOString();
  await ensureDir(outputDir);

  const entries = inputOptions.entries || await readInputEntries(options.inputPath);
  const seenCustomIds = new Set();
  const normalized = entries.map((entry, index) => normalizeAliyunBatchRequest(entry, index, options, seenCustomIds));
  const requests = normalized.map((entry) => entry.request);
  const idMappings = normalized.map((entry) => entry.idMapping);
  const validation = validateAliyunBatchRequests(requests, options);
  const shards = validation.errors.length ? [] : planShards(requests, options);
  const fetchImpl = inputOptions.fetch || globalThis.fetch;
  assertRemoteGuardrails(options, requests.length, fetchImpl);
  const mappedCustomIdCount = idMappings.filter((row) => row.mappedReason !== 'preserved').length;
  const validationReport = {
    ...validation,
    mappedCustomIdCount,
    shardCount: shards.length,
    shards: shards.map((shard) => ({
      shardIndex: shard.shardIndex,
      groupKey: shard.groupKey,
      method: shard.method,
      url: shard.url,
      model: shard.model,
      thinkingMode: shard.thinkingMode,
      requestCount: shard.requestCount,
      byteLength: shard.byteLength
    }))
  };

  await writeJson(validationPath, validationReport);
  if (validationReport.status !== 'passed' && !options.allowInvalid) {
    const error = new Error(`Aliyun batch validation failed with ${validationReport.errors.length} error(s). See ${validationPath}`);
    error.validationReport = validationReport;
    throw error;
  }

  await writeText(customIdMapPath, `${idMappings.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const shardSummaries = await writeShardFiles(outputDir, shards);
  const remoteSummary = await runAliyunRemoteBatchLifecycle({
    runId: options.runId,
    outputDir,
    shardSummaries,
    options,
    fetchImpl,
    sleepImpl: inputOptions.sleep
  });
  const resultPaths = [
    ...options.resultPaths,
    ...(remoteSummary?.resultPaths || [])
  ];
  const errorPaths = [
    ...options.errorPaths,
    ...(remoteSummary?.errorPaths || [])
  ];
  const parseSummary = (resultPaths.length || errorPaths.length)
    ? await parseBatchOutputs({
      resultPaths,
      errorPaths,
      idMappings,
      outputDir
    })
    : null;
  const llmLedger = await writeOfflineLlmLedger({
    runId: options.runId,
    outputDir,
    shards,
    idMappings,
    parseSummary
  });
  await appendRemoteLlmLedger({
    runId: options.runId,
    remoteSummary,
    llmLedger
  });

  const manifest = {
    runId: options.runId,
    kind: remoteSummary ? 'aliyun-batch-inference-remote-artifacts' : 'aliyun-batch-inference-offline-artifacts',
    status: parseSummary?.status || remoteSummary?.status || 'prepared',
    startedAt,
    completedAt: new Date().toISOString(),
    inputPath: options.inputPath ? path.resolve(options.inputPath) : null,
    outputDir,
    requestCount: requests.length,
    shardCount: shardSummaries.length,
    modelDefault: options.model,
    methodDefault: options.method,
    urlDefault: options.url,
    docs: ALIYUN_BATCH_DOCS,
    limits: validationReport.limits,
    mappedCustomIdCount,
    shards: shardSummaries,
    llmLedger,
    remoteSummary,
    parseSummary,
    artifacts: {
      manifestPath,
      validationPath,
      customIdMapPath,
      shardPaths: shardSummaries.map((shard) => shard.filePath),
      remoteJobsPath: remoteSummary?.artifacts?.remoteJobsPath || null,
      remoteStatusPath: remoteSummary?.artifacts?.remoteStatusPath || null,
      remoteDownloadsPath: remoteSummary?.artifacts?.remoteDownloadsPath || null,
      remoteSummaryPath: remoteSummary?.artifacts?.remoteSummaryPath || null,
      llmBatchesPath: llmLedger.batchesPath,
      llmResultsPath: llmLedger.resultsPath,
      llmFailuresPath: llmLedger.failuresPath,
      parsedResultsPath: parseSummary?.artifacts?.parsedResultsPath || null,
      parsedErrorsPath: parseSummary?.artifacts?.parsedErrorsPath || null,
      parsedSummaryPath: parseSummary?.artifacts?.parsedSummaryPath || null
    }
  };

  await writeJson(manifestPath, manifest);
  return manifest;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = await runAliyunBatchPreparation(options);
  console.log(JSON.stringify(report, null, 2));
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
