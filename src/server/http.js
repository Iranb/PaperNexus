import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  backupCorpusPayload,
  brainstormBriefPayload,
  brainstormGraphPayload,
  catalystGraphPayload,
  contextGraphPayload,
  corpusMetaPayload,
  corpusPayload,
  corpusSourcesPayload,
  createImportTaskPayload,
  evidenceChainPayload,
  evalRunPayload,
  createApiCache,
  enhancementSummaryPayload,
  ideaCatalystV2Payload,
  ideasGraphPayload,
  impactGraphPayload,
  importTaskLogPayload,
  importTaskPayload,
  listImportTasksPayload,
  listCorporaPayload,
  llmConfigPayload,
  methodEvidencePayload,
  methodLineagePayload,
  methodRegistryPayload,
  noveltyEvalPayload,
  paperIndexPayload,
  paperEnhancementPayload,
  pathTraceGraphPayload,
  queryGraphPayload,
  reflectionChainPayload,
  researchBriefPayload,
  reviewerSimulatePayload,
  getConfiguredRootPaths,
  storylinePayload,
  storylineBriefPayload,
  theoryBriefPayload,
  updateLlmConfigPayload
} from './api.js';
import { getMcpHttpConfig, handleMcpHttpRequest } from '../mcp/http.js';
import { startEnhancementWorker } from '../core/enhancements/worker.js';
import { startAuthoritativeSyncWorker } from '../core/authoritative-sync/worker.js';
import { startImportWorker } from '../core/imports/worker.js';
import { startLiteratureDiscoveryRecoveryWorker } from '../mcp/tool-literature-discovery.js';
import { warmDoclingRuntime, warmMineruHttpEndpoint } from '../core/ingestion/pdf-parser.js';
import { startRegistryReconcileWorker } from '../storage/registry-reconcile.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};
const DEFAULT_JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_BACKGROUND_ERROR_LENGTH = 480;
const mineruWarmupsInFlight = new Map();

function getServeConfig(options = {}) {
  const value = options.config?.serve;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getConfigSection(options = {}, name) {
  const value = options.config?.[name];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(...values) {
  const raw = firstDefined(...values);
  if (raw === undefined) return undefined;
  const normalized = Number(raw);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function isFalseLike(value) {
  if (value === false) return true;
  if (value === true || value === undefined || value === null) return false;
  return ['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function resolveJsonBodyLimitBytes(options = {}) {
  const serveConfig = getServeConfig(options);
  const raw = firstDefined(
    options.maxJsonBodyBytes,
    options.jsonBodyLimitBytes,
    serveConfig.maxJsonBodyBytes,
    serveConfig.jsonBodyLimitBytes
  );
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JSON_BODY_LIMIT_BYTES;
  }
  return Math.floor(parsed);
}

function formatBackgroundError(error) {
  const raw = String(error?.message || error || 'unknown error').trim();
  const compact = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
  if (compact.length <= MAX_BACKGROUND_ERROR_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MAX_BACKGROUND_ERROR_LENGTH - 3)}...`;
}

function resolveApiToken(options = {}) {
  const serveConfig = getServeConfig(options);
  const raw = options.apiToken ?? serveConfig.apiToken ?? process.env.PAPERNEXUS_API_TOKEN;
  if (typeof raw !== 'string') return '';
  const normalized = raw.trim();
  return normalized || '';
}

function readRequestApiToken(request) {
  const authHeader = request.headers?.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  for (const headerName of ['x-papernexus-token', 'x-api-key']) {
    const headerValue = request.headers?.[headerName];
    if (typeof headerValue === 'string' && headerValue.trim()) {
      return headerValue.trim();
    }
  }

  return '';
}

function timingSafeStringEqual(left = '', right = '') {
  const leftDigest = crypto.createHash('sha256').update(String(left), 'utf8').digest();
  const rightDigest = crypto.createHash('sha256').update(String(right), 'utf8').digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requireApiToken(request, response, expectedToken) {
  if (!expectedToken) {
    sendJson(response, 503, {
      error: 'API token is not configured for this server. Set `serve.apiToken` or `PAPERNEXUS_API_TOKEN` before using the API.'
    });
    return false;
  }

  const providedToken = readRequestApiToken(request);
  if (!providedToken || !timingSafeStringEqual(providedToken, expectedToken)) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="PaperNexus API"');
    sendJson(response, 401, {
      error: 'Unauthorized. Provide the PaperNexus API token as `Authorization: Bearer <token>`.'
    });
    return false;
  }

  return true;
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': MIME_TYPES['.json'],
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function logMcpHttpRequest(logger, request, method, statusCode, durationMs, transport) {
  const timestamp = new Date().toISOString();
  const remoteAddress = request.socket?.remoteAddress || 'unknown';
  logger.log?.(`[${timestamp}] [mcp-http] ${remoteAddress} method=${method} status=${statusCode} durationMs=${durationMs} transport=${transport}`);
}

async function sendFile(response, filePath) {
  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': body.length
  });
  response.end(body);
}

async function readJsonBody(request, options = {}) {
  const maxBytes = resolveJsonBodyLimitBytes(options);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > maxBytes) {
      const error = new Error(`JSON request body exceeds the configured limit of ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

function buildWebRoot() {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '../../web');
}

function describeWorkerRoots(rootPaths) {
  if (!Array.isArray(rootPaths) || !rootPaths.length) {
    return 'all indexed corpora';
  }
  if (rootPaths.length === 1) {
    return rootPaths[0];
  }
  return `${rootPaths.length} configured corpora`;
}

function logConfiguredWorkerRoots(rootResolution = {}, logger = console) {
  const rootPaths = rootResolution.rootPaths || [];
  if (!rootResolution.configured && !rootPaths.length) {
    logger.log?.('[serve] worker root scope: registry fallback (all indexed corpora)');
    return;
  }

  logger.log?.(
    `[serve] configured worker roots: ${rootPaths.length} valid`
    + (rootResolution.invalidRootPaths?.length ? `, ${rootResolution.invalidRootPaths.length} invalid` : '')
  );
  for (const rootPath of rootPaths) {
    logger.log?.(`[serve] worker root: ${rootPath}`);
  }
  for (const invalid of rootResolution.invalidRootPaths || []) {
    logger.warn?.(`[serve] invalid worker root ignored: ${invalid.input || invalid.resolved} (${invalid.reason || 'invalid'})`);
  }
}

function startNamedWorker(name, enabled, starter, options, logger = console) {
  if (!enabled) {
    logger.log?.(`[serve] ${name} disabled`);
    return null;
  }

  try {
    const worker = starter(options);
    logger.log?.(`[serve] ${name} started (${describeWorkerRoots(options.rootPaths)})`);
    return worker;
  } catch (error) {
    logger.error?.(`[serve] ${name} failed to start (${error.message || error})`);
    throw error;
  }
}

function resolveRegistryReconcileEnabled(options = {}) {
  const serveConfig = getServeConfig(options);
  return !isFalseLike(firstDefined(
    options.enableRegistryReconcile,
    serveConfig.enableRegistryReconcile
  ));
}

function resolveRegistryReconcileIntervalMs(options = {}) {
  const serveConfig = getServeConfig(options);
  return firstNumber(
    options.registryReconcileIntervalMs,
    serveConfig.registryReconcileIntervalMs
  );
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function collectMineruWarmupUrls(options = {}) {
  const analyzeConfig = options.config?.analyze;
  const materializeConfig = options.config?.materialize;
  const watchConfig = options.config?.watch;
  const urls = [
    options.mineruHttpUrl,
    analyzeConfig?.mineruHttpUrl,
    materializeConfig?.mineruHttpUrl,
    watchConfig?.mineruHttpUrl,
    process.env.PAPERNEXUS_MINERU_HTTP_URL
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value && isHttpUrl(value));

  return [...new Set(urls)];
}

function buildImportWorkerOptions(options = {}, rootPaths, logger = console) {
  const analyzeConfig = getConfigSection(options, 'analyze');
  const materializeConfig = getConfigSection(options, 'materialize');
  const watchConfig = getConfigSection(options, 'watch');
  const importsConfig = getConfigSection(options, 'imports');
  const importConfig = getConfigSection(options, 'import');
  const llmConfig = getConfigSection(options, 'llm');
  const ollamaConfig = getConfigSection(options, 'ollama');
  const llmSshHost = firstDefined(
    options.llmSshHost,
    options.ollamaSshHost,
    llmConfig.sshHost,
    ollamaConfig.sshHost
  );

  return {
    ...options,
    rootPaths,
    intervalMs: options.importIntervalMs,
    logger,
    batchEnabled: firstDefined(
      options.importBatchEnabled,
      options.batchEnabled,
      importsConfig.batchEnabled,
      importConfig.batchEnabled,
      true
    ),
    batchMaxTasks: firstNumber(
      options.importBatchMaxTasks,
      options.batchMaxTasks,
      importsConfig.batchMaxTasks,
      importsConfig.maxTasks,
      importConfig.batchMaxTasks,
      importConfig.maxTasks,
      16
    ),
    batchInitialTasks: firstNumber(
      options.importBatchInitialTasks,
      options.batchInitialTasks,
      importsConfig.batchInitialTasks,
      importConfig.batchInitialTasks,
      4
    ),
    batchProgressive: firstDefined(
      options.importBatchProgressive,
      options.batchProgressive,
      importsConfig.batchProgressive,
      importConfig.batchProgressive,
      true
    ),
    batchCoalesceMs: firstNumber(
      options.importBatchCoalesceMs,
      options.batchCoalesceMs,
      importsConfig.batchCoalesceMs,
      importConfig.batchCoalesceMs,
      0
    ),
    batchCoalescePollMs: firstNumber(
      options.importBatchCoalescePollMs,
      options.batchCoalescePollMs,
      importsConfig.batchCoalescePollMs,
      importConfig.batchCoalescePollMs
    ),
    batchMaxFiles: firstNumber(
      options.importBatchMaxFiles,
      options.batchMaxFiles,
      importsConfig.batchMaxFiles,
      importsConfig.maxFiles,
      importConfig.batchMaxFiles,
      importConfig.maxFiles
    ),
    batchMaxBytes: firstNumber(
      options.importBatchMaxBytes,
      options.batchMaxBytes,
      importsConfig.batchMaxBytes,
      importsConfig.maxBytes,
      importConfig.batchMaxBytes,
      importConfig.maxBytes
    ),
    name: firstDefined(options.name, analyzeConfig.name, materializeConfig.name, watchConfig.name),
    force: firstDefined(options.force, analyzeConfig.force, materializeConfig.force, watchConfig.force),
    quiet: Boolean(firstDefined(options.quiet, analyzeConfig.quiet, materializeConfig.quiet, watchConfig.quiet, true)),
    analyzeConcurrency: firstNumber(
      options.analyzeConcurrency,
      options.concurrency,
      analyzeConfig.concurrency,
      analyzeConfig.analyzeConcurrency,
      materializeConfig.concurrency,
      materializeConfig.analyzeConcurrency,
      watchConfig.concurrency,
      watchConfig.analyzeConcurrency
    ),
    semanticExtraction: firstDefined(
      options.semanticExtraction,
      importsConfig.semanticExtraction,
      importConfig.semanticExtraction,
      materializeConfig.semanticExtraction,
      analyzeConfig.semanticExtraction,
      watchConfig.semanticExtraction
    ),
    nodeLlmCheck: firstDefined(options.nodeLlmCheck, analyzeConfig.nodeLlmCheck, watchConfig.nodeLlmCheck),
    rebuildPdfMarkdown: firstDefined(
      options.rebuildPdfMarkdown,
      materializeConfig.rebuildPdfMarkdown,
      analyzeConfig.rebuildPdfMarkdown,
      watchConfig.rebuildPdfMarkdown
    ),
    pdfParser: firstDefined(options.pdfParser, materializeConfig.pdfParser, analyzeConfig.pdfParser, watchConfig.pdfParser),
    pdfCommand: firstDefined(options.pdfCommand, materializeConfig.pdfCommand, analyzeConfig.pdfCommand, watchConfig.pdfCommand),
    pythonCommand: firstDefined(options.pythonCommand, materializeConfig.pythonCommand, analyzeConfig.pythonCommand, watchConfig.pythonCommand),
    markitdownPython: firstDefined(
      options.markitdownPython,
      materializeConfig.markitdownPython,
      analyzeConfig.markitdownPython,
      watchConfig.markitdownPython,
      options.pythonCommand,
      materializeConfig.pythonCommand,
      analyzeConfig.pythonCommand,
      watchConfig.pythonCommand
    ),
    markitdownUseLlm: firstDefined(
      options.markitdownUseLlm,
      materializeConfig.markitdownUseLlm,
      analyzeConfig.markitdownUseLlm,
      watchConfig.markitdownUseLlm
    ),
    markitdownEnablePlugins: firstDefined(
      options.markitdownEnablePlugins,
      materializeConfig.markitdownEnablePlugins,
      analyzeConfig.markitdownEnablePlugins,
      watchConfig.markitdownEnablePlugins
    ),
    markitdownLlmPrompt: firstDefined(
      options.markitdownLlmPrompt,
      materializeConfig.markitdownLlmPrompt,
      analyzeConfig.markitdownLlmPrompt,
      watchConfig.markitdownLlmPrompt
    ),
    markpdfdownPython: firstDefined(
      options.markpdfdownPython,
      materializeConfig.markpdfdownPython,
      analyzeConfig.markpdfdownPython,
      watchConfig.markpdfdownPython,
      options.pythonCommand,
      materializeConfig.pythonCommand,
      analyzeConfig.pythonCommand,
      watchConfig.pythonCommand
    ),
    pdfParserSshHost: firstDefined(
      options.pdfParserSshHost,
      materializeConfig.pdfParserSshHost,
      analyzeConfig.pdfParserSshHost,
      watchConfig.pdfParserSshHost
    ),
    opendataloaderPdfPython: firstDefined(
      options.opendataloaderPdfPython,
      materializeConfig.opendataloaderPdfPython,
      analyzeConfig.opendataloaderPdfPython,
      watchConfig.opendataloaderPdfPython,
      options.pythonCommand,
      materializeConfig.pythonCommand,
      analyzeConfig.pythonCommand,
      watchConfig.pythonCommand
    ),
    doclingPython: firstDefined(
      options.doclingPython,
      materializeConfig.doclingPython,
      analyzeConfig.doclingPython,
      watchConfig.doclingPython,
      options.pythonCommand,
      materializeConfig.pythonCommand,
      analyzeConfig.pythonCommand,
      watchConfig.pythonCommand
    ),
    doclingCommand: firstDefined(
      options.doclingCommand,
      materializeConfig.doclingCommand,
      analyzeConfig.doclingCommand,
      watchConfig.doclingCommand
    ),
    doclingUseVlm: firstDefined(
      options.doclingUseVlm,
      materializeConfig.doclingUseVlm,
      analyzeConfig.doclingUseVlm,
      watchConfig.doclingUseVlm
    ),
    doclingVlmPreset: firstDefined(
      options.doclingVlmPreset,
      materializeConfig.doclingVlmPreset,
      analyzeConfig.doclingVlmPreset,
      watchConfig.doclingVlmPreset
    ),
    doclingSshHost: firstDefined(
      options.doclingSshHost,
      materializeConfig.doclingSshHost,
      analyzeConfig.doclingSshHost,
      watchConfig.doclingSshHost
    ),
    doclingOcrEngine: firstDefined(
      options.doclingOcrEngine,
      materializeConfig.doclingOcrEngine,
      analyzeConfig.doclingOcrEngine,
      watchConfig.doclingOcrEngine
    ),
    doclingPdfBackend: firstDefined(
      options.doclingPdfBackend,
      materializeConfig.doclingPdfBackend,
      analyzeConfig.doclingPdfBackend,
      watchConfig.doclingPdfBackend
    ),
    doclingDevice: firstDefined(
      options.doclingDevice,
      materializeConfig.doclingDevice,
      analyzeConfig.doclingDevice,
      watchConfig.doclingDevice
    ),
    doclingCudaVisibleDevices: firstDefined(
      options.doclingCudaVisibleDevices,
      materializeConfig.doclingCudaVisibleDevices,
      analyzeConfig.doclingCudaVisibleDevices,
      watchConfig.doclingCudaVisibleDevices
    ),
    doclingAutoGpu: firstDefined(
      options.doclingAutoGpu,
      materializeConfig.doclingAutoGpu,
      analyzeConfig.doclingAutoGpu,
      watchConfig.doclingAutoGpu
    ),
    doclingGpuLockRoot: firstDefined(
      options.doclingGpuLockRoot,
      materializeConfig.doclingGpuLockRoot,
      analyzeConfig.doclingGpuLockRoot,
      watchConfig.doclingGpuLockRoot
    ),
    doclingGpuMinFreeMb: firstDefined(
      options.doclingGpuMinFreeMb,
      materializeConfig.doclingGpuMinFreeMb,
      analyzeConfig.doclingGpuMinFreeMb,
      watchConfig.doclingGpuMinFreeMb
    ),
    doclingGpuWaitTimeoutMs: firstDefined(
      options.doclingGpuWaitTimeoutMs,
      materializeConfig.doclingGpuWaitTimeoutMs,
      analyzeConfig.doclingGpuWaitTimeoutMs,
      watchConfig.doclingGpuWaitTimeoutMs
    ),
    doclingGpuPollIntervalMs: firstDefined(
      options.doclingGpuPollIntervalMs,
      materializeConfig.doclingGpuPollIntervalMs,
      analyzeConfig.doclingGpuPollIntervalMs,
      watchConfig.doclingGpuPollIntervalMs
    ),
    doclingGpuLockStaleMs: firstDefined(
      options.doclingGpuLockStaleMs,
      materializeConfig.doclingGpuLockStaleMs,
      analyzeConfig.doclingGpuLockStaleMs,
      watchConfig.doclingGpuLockStaleMs
    ),
    doclingCpuThreads: firstDefined(
      options.doclingCpuThreads,
      materializeConfig.doclingCpuThreads,
      analyzeConfig.doclingCpuThreads,
      watchConfig.doclingCpuThreads
    ),
    doclingArtifactsPath: firstDefined(
      options.doclingArtifactsPath,
      materializeConfig.doclingArtifactsPath,
      analyzeConfig.doclingArtifactsPath,
      watchConfig.doclingArtifactsPath
    ),
    doclingImageExportMode: firstDefined(
      options.doclingImageExportMode,
      materializeConfig.doclingImageExportMode,
      analyzeConfig.doclingImageExportMode,
      watchConfig.doclingImageExportMode
    ),
    doclingEnrichPictureClasses: firstDefined(
      options.doclingEnrichPictureClasses,
      materializeConfig.doclingEnrichPictureClasses,
      analyzeConfig.doclingEnrichPictureClasses,
      watchConfig.doclingEnrichPictureClasses
    ),
    doclingEnrichPictureDescription: firstDefined(
      options.doclingEnrichPictureDescription,
      materializeConfig.doclingEnrichPictureDescription,
      analyzeConfig.doclingEnrichPictureDescription,
      watchConfig.doclingEnrichPictureDescription
    ),
    doclingPreload: firstDefined(
      options.doclingPreload,
      materializeConfig.doclingPreload,
      analyzeConfig.doclingPreload,
      watchConfig.doclingPreload
    ),
    doclingPreloadTimeoutMs: firstDefined(
      options.doclingPreloadTimeoutMs,
      materializeConfig.doclingPreloadTimeoutMs,
      analyzeConfig.doclingPreloadTimeoutMs,
      watchConfig.doclingPreloadTimeoutMs
    ),
    markerCommand: firstDefined(
      options.markerCommand,
      materializeConfig.markerCommand,
      analyzeConfig.markerCommand,
      watchConfig.markerCommand
    ),
    markerSshHost: firstDefined(
      options.markerSshHost,
      materializeConfig.markerSshHost,
      analyzeConfig.markerSshHost,
      watchConfig.markerSshHost
    ),
    markerConcurrency: firstNumber(
      options.markerConcurrency,
      materializeConfig.markerConcurrency,
      analyzeConfig.markerConcurrency,
      watchConfig.markerConcurrency
    ),
    mineruCommand: firstDefined(
      options.mineruCommand,
      materializeConfig.mineruCommand,
      analyzeConfig.mineruCommand,
      watchConfig.mineruCommand
    ),
    mineruHttpUrl: firstDefined(
      options.mineruHttpUrl,
      materializeConfig.mineruHttpUrl,
      analyzeConfig.mineruHttpUrl,
      watchConfig.mineruHttpUrl
    ),
    mineruRemoteFailureMode: firstDefined(
      options.mineruRemoteFailureMode,
      materializeConfig.mineruRemoteFailureMode,
      analyzeConfig.mineruRemoteFailureMode,
      watchConfig.mineruRemoteFailureMode
    ),
    paddleocrVlPython: firstDefined(
      options.paddleocrVlPython,
      materializeConfig.paddleocrVlPython,
      analyzeConfig.paddleocrVlPython,
      watchConfig.paddleocrVlPython,
      options.pythonCommand,
      materializeConfig.pythonCommand,
      analyzeConfig.pythonCommand,
      watchConfig.pythonCommand
    ),
    paddleocrVlServerUrl: firstDefined(
      options.paddleocrVlServerUrl,
      materializeConfig.paddleocrVlServerUrl,
      analyzeConfig.paddleocrVlServerUrl,
      watchConfig.paddleocrVlServerUrl
    ),
    paddleocrVlLayoutModel: firstDefined(
      options.paddleocrVlLayoutModel,
      materializeConfig.paddleocrVlLayoutModel,
      analyzeConfig.paddleocrVlLayoutModel,
      watchConfig.paddleocrVlLayoutModel
    ),
    pageRange: firstDefined(options.pageRange, materializeConfig.pageRange, analyzeConfig.pageRange, watchConfig.pageRange),
    pdfSshHost: firstDefined(options.pdfSshHost, materializeConfig.pdfSshHost, analyzeConfig.pdfSshHost, watchConfig.pdfSshHost),
    pdfParseTimeoutMs: firstNumber(
      options.pdfParseTimeoutMs,
      materializeConfig.pdfParseTimeoutMs,
      analyzeConfig.pdfParseTimeoutMs,
      watchConfig.pdfParseTimeoutMs
    ),
    llmProvider: firstDefined(options.llmProvider, llmConfig.provider),
    llmModel: firstDefined(options.llmModel, llmConfig.model),
    llmBaseUrl: firstDefined(options.llmBaseUrl, llmConfig.baseUrl),
    llmApiKey: firstDefined(options.llmApiKey, llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(options.llmApiKeyEnv, llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(options.llmApiKeySource, llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(options.llmApiKeyService, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(options.llmApiKeyAccount, llmConfig.apiKeyAccount),
    llmSshHost,
    llmRelations: firstDefined(
      options.importLlmRelations,
      importsConfig.llmRelations,
      importsConfig.relations,
      importConfig.llmRelations,
      importConfig.relations,
      options.llmRelations,
      false
    ),
    llmTimeoutMs: firstNumber(options.llmTimeoutMs, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmBatchSize: firstNumber(
      options.importLlmBatchSize,
      importsConfig.llmBatchSize,
      importsConfig.batchSize,
      importConfig.llmBatchSize,
      importConfig.batchSize,
      options.llmBatchSize,
      12,
      llmConfig.batchSize,
      ollamaConfig.batchSize
    ),
    llmMaxTokens: firstNumber(options.llmMaxTokens, llmConfig.maxTokens),
    ollamaModel: firstDefined(options.ollamaModel, ollamaConfig.model),
    ollamaUrl: firstDefined(options.ollamaUrl, ollamaConfig.url),
    ollamaSshHost: firstDefined(options.ollamaSshHost, llmSshHost),
    ollamaRelations: firstDefined(
      options.importOllamaRelations,
      importsConfig.ollamaRelations,
      importConfig.ollamaRelations,
      options.ollamaRelations,
      false
    ),
    ollamaTimeoutMs: firstNumber(options.ollamaTimeoutMs, ollamaConfig.timeoutMs),
    ollamaBatchSize: firstNumber(options.ollamaBatchSize, ollamaConfig.batchSize)
  };
}

function buildEnhancementWorkerOptions(options = {}, rootPaths, logger = console) {
  const enhanceConfig = getConfigSection(options, 'enhance');
  const analyzeConfig = getConfigSection(options, 'analyze');
  const llmConfig = getConfigSection(options, 'llm');
  const ollamaConfig = getConfigSection(options, 'ollama');

  return {
    ...options,
    rootPaths,
    logger,
    intervalMs: options.enhancementIntervalMs,
    backfillLimit: options.enhancementBackfillLimit,
    catalystBackfill: firstDefined(options.enhancementCatalystBackfill, enhanceConfig.catalystBackfill, false) !== false,
    catalystSemanticExtraction: firstDefined(
      options.catalystSemanticExtraction,
      enhanceConfig.catalystSemanticExtraction,
      enhanceConfig.semanticExtraction,
      analyzeConfig.semanticExtraction,
      'llm-assisted'
    ),
    llmProvider: firstDefined(options.llmProvider, llmConfig.provider),
    llmModel: firstDefined(options.llmModel, llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(options.llmBaseUrl, llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(options.llmApiKey, llmConfig.apiKey, process.env[llmConfig.apiKeyEnv || '']),
    llmApiKeyEnv: firstDefined(options.llmApiKeyEnv, llmConfig.apiKeyEnv),
    llmKeychainService: firstDefined(options.llmKeychainService, llmConfig.keychainService),
    llmKeychainAccount: firstDefined(options.llmKeychainAccount, llmConfig.keychainAccount),
    llmSshHost: firstDefined(options.llmSshHost, llmConfig.sshHost, ollamaConfig.sshHost),
    llmRelations: firstDefined(options.llmRelations, llmConfig.relations, ollamaConfig.relations),
    llmTimeoutMs: firstDefined(options.llmTimeoutMs, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmBatchSize: firstDefined(options.llmBatchSize, llmConfig.batchSize, ollamaConfig.batchSize),
    ollamaModel: firstDefined(options.ollamaModel, ollamaConfig.model),
    ollamaUrl: firstDefined(options.ollamaUrl, ollamaConfig.url),
    ollamaSshHost: firstDefined(options.ollamaSshHost, ollamaConfig.sshHost),
    ollamaRelations: firstDefined(options.ollamaRelations, ollamaConfig.relations),
    ollamaTimeoutMs: firstDefined(options.ollamaTimeoutMs, ollamaConfig.timeoutMs),
    ollamaBatchSize: firstDefined(options.ollamaBatchSize, ollamaConfig.batchSize)
  };
}

async function warmMineruBackends(options = {}) {
  const urls = collectMineruWarmupUrls(options);
  const attempted = [];
  const warmed = [];
  const failed = [];

  await Promise.all(urls.map(async (url) => {
    attempted.push(url);
    if (!mineruWarmupsInFlight.has(url)) {
      mineruWarmupsInFlight.set(url, warmMineruHttpEndpoint(url, {
        timeoutMs: options.mineruWarmupTimeoutMs,
        mineruProbeCacheTtlMs: options.mineruProbeCacheTtlMs
      }));
    }

    try {
      const result = await mineruWarmupsInFlight.get(url);
      if (!result.reachable) {
        throw new Error(result.error || `MinerU warmup probe failed with status ${result.status || 'unknown'}`);
      }
      warmed.push(url);
    } catch (error) {
      failed.push({
        url,
        error: error.message || String(error)
      });
    } finally {
      mineruWarmupsInFlight.delete(url);
    }
  }));

  return {
    attempted,
    warmed,
    failed
  };
}

export async function serveCommand(options = {}) {
  const port = Number(options.port || 4821);
  const host = options.host || '127.0.0.1';
  const apiToken = resolveApiToken(options);
  const mcpConfig = getMcpHttpConfig(options);
  const rootResolution = await getConfiguredRootPaths(options);
  const rootPaths = rootResolution.rootPaths.length ? rootResolution.rootPaths : undefined;
  const webRoot = buildWebRoot();
  const apiCache = createApiCache();
  const workerLogger = options.logger || console;
  logConfiguredWorkerRoots(rootResolution, workerLogger);
  const enhancementWorkerStarter = options.startEnhancementWorker || startEnhancementWorker;
  const authoritativeSyncWorkerStarter = options.startAuthoritativeSyncWorker || startAuthoritativeSyncWorker;
  const importWorkerStarter = options.startImportWorker || startImportWorker;
  const literatureDiscoveryRecoveryWorkerStarter = options.startLiteratureDiscoveryRecoveryWorker || startLiteratureDiscoveryRecoveryWorker;
  const registryReconcileWorkerStarter = options.startRegistryReconcileWorker || startRegistryReconcileWorker;
  const importWorkerOptions = buildImportWorkerOptions(options, rootPaths, workerLogger);
  const enhancementWorker = startNamedWorker(
    'enhancement worker',
    options.enableEnhancements !== false,
    enhancementWorkerStarter,
    buildEnhancementWorkerOptions(options, rootPaths, workerLogger),
    workerLogger
  );
  const authoritativeSyncWorker = startNamedWorker(
    'authoritative sync worker',
    options.enableAuthoritativeSync !== false,
    authoritativeSyncWorkerStarter,
    {
      rootPaths,
      intervalMs: options.authoritativeSyncIntervalMs,
      logger: workerLogger
    },
    workerLogger
  );
  const importWorker = startNamedWorker(
    'import worker',
    options.enableImports !== false,
    importWorkerStarter,
    importWorkerOptions,
    workerLogger
  );
  const literatureDiscoveryRecoveryWorker = startNamedWorker(
    'literature discovery recovery worker',
    options.enableLiteratureDiscoveryRecovery !== false,
    literatureDiscoveryRecoveryWorkerStarter,
    {
      ...options,
      rootPaths,
      intervalMs: options.literatureDiscoveryRecoveryIntervalMs,
      logger: workerLogger
    },
    workerLogger
  );
  const registryReconcileWorker = startNamedWorker(
    'registry reconcile worker',
    resolveRegistryReconcileEnabled(options),
    registryReconcileWorkerStarter,
    {
      rootPaths,
      intervalMs: resolveRegistryReconcileIntervalMs(options),
      logger: workerLogger
    },
    workerLogger
  );
  const triggerMineruWarmup = options.warmMineruBackends || warmMineruBackends;
  const triggerDoclingWarmup = options.warmDoclingRuntime || warmDoclingRuntime;
  const shouldWarmDocling = options.enableImports !== false
    && options.enableDoclingWarmup !== false
    && importWorkerOptions.doclingPreload !== false
    && (
      importWorkerOptions.pdfParser === 'docling'
      || options.enableDoclingWarmup === true
    );
  if (options.enableImports !== false && options.enableMineruWarmup !== false) {
    workerLogger.log?.('[serve] MinerU warmup started');
    Promise.resolve()
      .then(() => triggerMineruWarmup({
        ...options,
        rootPaths,
        logger: workerLogger
      }))
      .then((summary) => {
        if (summary?.attempted?.length) {
          const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0;
          workerLogger.log?.(`[serve] MinerU warmup finished (${summary.warmed.length}/${summary.attempted.length} reachable, ${failedCount} failed)`);
          return;
        }
        workerLogger.log?.('[serve] MinerU warmup finished (no MinerU HTTP backends configured)');
      })
      .catch((error) => {
        workerLogger.warn?.(`[serve] MinerU warmup failed (${formatBackgroundError(error)})`);
      });
  }
  if (shouldWarmDocling) {
    workerLogger.log?.('[serve] Docling warmup started');
    Promise.resolve()
      .then(() => triggerDoclingWarmup({
        ...importWorkerOptions,
        rootPaths,
        logger: workerLogger,
        skipDoclingWarmup: true
      }))
      .then(() => {
        workerLogger.log?.('[serve] Docling warmup finished');
      })
      .catch((error) => {
        workerLogger.warn?.(`[serve] Docling warmup failed (${formatBackgroundError(error)})`);
      });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}:${port}`);
      const apiOptions = {
        cache: apiCache,
        config: options.config || {},
        configBaseDir: options.configBaseDir || process.cwd(),
        portablePaths: true,
        logger: workerLogger,
        workerRootPaths: rootPaths,
        onImportTaskCreated() {
          importWorker?.pollNow?.();
        }
      };

      if (url.pathname === mcpConfig.path) {
        if (!mcpConfig.enabled) {
          sendJson(response, 404, { error: 'Not Found' });
          return;
        }

        request.setTimeout?.(mcpConfig.requestTimeoutMs);
        response.setTimeout?.(mcpConfig.requestTimeoutMs);

        if (!requireApiToken(request, response, apiToken)) {
          return;
        }

        const startedAt = Date.now();
        const result = await handleMcpHttpRequest(request, response, {
          config: options.config || {},
          configBaseDir: options.configBaseDir || process.cwd(),
          maxJsonBodyBytes: options.maxJsonBodyBytes,
          jsonBodyLimitBytes: options.jsonBodyLimitBytes,
          portablePaths: true,
          logger: workerLogger,
          workerRootPaths: rootPaths,
          onImportTaskCreated() {
            importWorker?.pollNow?.();
          }
        });
        logMcpHttpRequest(
          workerLogger,
          request,
          result?.rpcMethod || request.method || 'UNKNOWN',
          result?.statusCode || response.statusCode || 200,
          Date.now() - startedAt,
          mcpConfig.transport
        );
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!requireApiToken(request, response, apiToken)) {
          return;
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, service: 'papernexus-web' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpora') {
        sendJson(response, 200, await listCorporaPayload(apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpus') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await corpusPayload(name, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpus-meta') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await corpusMetaPayload(name, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpus-sources') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await corpusSourcesPayload(name, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/method-registry') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await methodRegistryPayload(name, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/enhancements') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await enhancementSummaryPayload(name, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/imports') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await listImportTasksPayload(name, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/imports') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        const payload = await createImportTaskPayload(name, body, apiOptions);
        sendJson(response, 202, payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/paper-index') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await paperIndexPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/query') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await queryGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/context') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await contextGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/impact') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await impactGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/ideas') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await ideasGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/brainstorm') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await brainstormGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/catalyst') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await catalystGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/idea-catalyst-v2') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await ideaCatalystV2Payload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/novelty-eval') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await noveltyEvalPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/storyline') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await storylinePayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/reviewer-simulate') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await reviewerSimulatePayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/path-trace') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await pathTraceGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/evidence-chain') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await evidenceChainPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/method-lineage') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await methodLineagePayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/method-evidence') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await methodEvidencePayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/reflection-chain') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await reflectionChainPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/theory-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await theoryBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/storyline-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await storylineBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/research-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await researchBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/brainstorm-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request, options);
        sendJson(response, 200, await brainstormBriefPayload(name, body, apiOptions));
        return;
      }

      const evalRunMatch = request.method === 'GET'
        ? url.pathname.match(/^\/api\/eval\/runs\/([^/]+)$/)
        : null;
      if (evalRunMatch) {
        const name = url.searchParams.get('name') || undefined;
        const runId = decodeURIComponent(evalRunMatch[1]);
        sendJson(response, 200, await evalRunPayload(name, runId, apiOptions));
        return;
      }

      const importTaskMatch = request.method === 'GET'
        ? url.pathname.match(/^\/api\/imports\/([^/]+)(?:\/log)?$/)
        : null;
      if (importTaskMatch) {
        const name = url.searchParams.get('name') || undefined;
        const taskId = decodeURIComponent(importTaskMatch[1]);
        if (url.pathname.endsWith('/log')) {
          sendJson(response, 200, await importTaskLogPayload(name, taskId, apiOptions));
          return;
        }

        sendJson(response, 200, await importTaskPayload(name, taskId, apiOptions));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/paper-enhancement') {
        const name = url.searchParams.get('name') || undefined;
        const paperId = url.searchParams.get('paperId') || '';
        sendJson(response, 200, await paperEnhancementPayload(name, paperId, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/backup') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await backupCorpusPayload(name, {
          backupDir: options.backupDir,
          config: options.config || {},
          configBaseDir: options.configBaseDir || process.cwd()
        }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/llm-config') {
        sendJson(response, 200, {
          ...llmConfigPayload(options.config || {}),
          configPath: options.configPath || path.join(options.configBaseDir || process.cwd(), 'config.json')
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/llm-config') {
        const body = await readJsonBody(request, options);
        const payload = await updateLlmConfigPayload(body?.llm || {}, {
          config: options.config || {},
          configBaseDir: options.configBaseDir || process.cwd(),
          configPath: options.configPath || null
        });
        options.config = {
          ...(options.config || {}),
          llm: {
            ...((options.config || {}).llm || {}),
            ...payload.llm
          }
        };
        options.configPath = payload.configPath || options.configPath;
        sendJson(response, 200, payload);
        return;
      }

      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method Not Allowed' });
        return;
      }

      const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
      const absolutePath = path.join(webRoot, safePath);

      if (!absolutePath.startsWith(webRoot)) {
        sendJson(response, 403, { error: 'Forbidden' });
        return;
      }

      await sendFile(response, absolutePath);
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0) || (error?.code === 'ENOENT' ? 404 : 500);
      sendJson(response, statusCode, {
        error: error.message || 'Internal Server Error'
      });
    }
  });

  if (mcpConfig.enabled) {
    server.requestTimeout = Math.max(Number(server.requestTimeout || 0), mcpConfig.requestTimeoutMs);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  console.log(`PaperNexus UI available at http://${host}:${port}`);
  if (apiToken) {
    console.log('API authentication: enabled (Bearer token required for all /api/* routes).');
  } else {
    console.warn('API authentication: token missing. All /api/* requests will return 503 until `serve.apiToken` or `PAPERNEXUS_API_TOKEN` is configured.');
  }
  if (mcpConfig.enabled) {
    console.log(`MCP transport: ${mcpConfig.transport} enabled at http://${host}:${port}${mcpConfig.path}`);
    if (!apiToken) {
      console.warn('MCP authentication: token missing. All MCP requests will return 503 until `serve.apiToken` or `PAPERNEXUS_API_TOKEN` is configured.');
    }
  } else {
    console.log(`MCP transport: disabled (configure serve.mcp.enabled to expose ${mcpConfig.path})`);
  }
  console.log('Press Ctrl+C to stop.');

  const stop = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await Promise.all([
      enhancementWorker?.stop?.(),
      authoritativeSyncWorker?.stop?.(),
      importWorker?.stop?.(),
      literatureDiscoveryRecoveryWorker?.stop?.(),
      registryReconcileWorker?.stop?.()
    ]);
    await new Promise((resolve) => {
      server.close(resolve);
    });
  };

  const shutdown = () => {
    stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    host,
    port,
    stop
  };
}
