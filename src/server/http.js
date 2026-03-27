import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePathWithHome } from '../lib/config.js';
import {
  backupCorpusPayload,
  brainstormBriefPayload,
  brainstormGraphPayload,
  contextGraphPayload,
  corpusMetaPayload,
  corpusPayload,
  createImportTaskPayload,
  evidenceChainPayload,
  createApiCache,
  enhancementSummaryPayload,
  ideasGraphPayload,
  impactGraphPayload,
  importTaskLogPayload,
  importTaskPayload,
  listImportTasksPayload,
  listCorporaPayload,
  llmConfigPayload,
  paperEnhancementPayload,
  pathTraceGraphPayload,
  queryGraphPayload,
  reflectionChainPayload,
  researchBriefPayload,
  storylineBriefPayload,
  theoryBriefPayload,
  updateLlmConfigPayload
} from './api.js';
import { startEnhancementWorker } from '../core/enhancements/worker.js';
import { startAuthoritativeSyncWorker } from '../core/authoritative-sync/worker.js';
import { startImportWorker } from '../core/imports/worker.js';
import { warmMineruHttpEndpoint } from '../core/ingestion/marker.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};
const mineruWarmupsInFlight = new Map();

function getServeConfig(options = {}) {
  const value = options.config?.serve;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getConfiguredRootPaths(options = {}) {
  const explicit = Array.isArray(options.rootPaths)
    ? options.rootPaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (explicit.length) {
    return explicit;
  }

  const raw = options.config?.storage?.indexDir;
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }

  return [resolvePathWithHome(raw.trim(), options.configBaseDir || process.cwd())];
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

function requireApiToken(request, response, expectedToken) {
  if (!expectedToken) {
    sendJson(response, 503, {
      error: 'API token is not configured for this server. Set `serve.apiToken` or `PAPERNEXUS_API_TOKEN` before using the API.'
    });
    return false;
  }

  const providedToken = readRequestApiToken(request);
  if (!providedToken || providedToken !== expectedToken) {
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

async function sendFile(response, filePath) {
  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': body.length
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
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
  const rootPaths = getConfiguredRootPaths(options);
  const webRoot = buildWebRoot();
  const apiCache = createApiCache();
  const workerLogger = options.logger || console;
  const enhancementWorker = startNamedWorker(
    'enhancement worker',
    options.enableEnhancements !== false,
    startEnhancementWorker,
    {
      rootPaths,
      intervalMs: options.enhancementIntervalMs,
      backfillLimit: options.enhancementBackfillLimit,
      logger: workerLogger
    },
    workerLogger
  );
  const authoritativeSyncWorker = startNamedWorker(
    'authoritative sync worker',
    options.enableAuthoritativeSync !== false,
    startAuthoritativeSyncWorker,
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
    startImportWorker,
    {
      rootPaths,
      intervalMs: options.importIntervalMs,
      logger: workerLogger
    },
    workerLogger
  );
  const triggerMineruWarmup = options.warmMineruBackends || warmMineruBackends;
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
        workerLogger.warn?.(`[serve] MinerU warmup failed (${error.message || error})`);
      });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}:${port}`);
      const apiOptions = {
        cache: apiCache,
        config: options.config || {},
        configBaseDir: options.configBaseDir || process.cwd()
      };

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
        const body = await readJsonBody(request);
        const payload = await createImportTaskPayload(name, body, apiOptions);
        importWorker?.pollNow();
        sendJson(response, 202, payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/query') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await queryGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/context') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await contextGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/impact') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await impactGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/ideas') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await ideasGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/brainstorm') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await brainstormGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/path-trace') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await pathTraceGraphPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/evidence-chain') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await evidenceChainPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/reflection-chain') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await reflectionChainPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/theory-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await theoryBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/storyline-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await storylineBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/research-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await researchBriefPayload(name, body, apiOptions));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/brainstorm-brief') {
        const name = url.searchParams.get('name') || undefined;
        const body = await readJsonBody(request);
        sendJson(response, 200, await brainstormBriefPayload(name, body, apiOptions));
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
        const body = await readJsonBody(request);
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
      const statusCode = error?.code === 'ENOENT' ? 404 : 500;
      sendJson(response, statusCode, {
        error: error.message || 'Internal Server Error'
      });
    }
  });

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
  console.log('Press Ctrl+C to stop.');

  const stop = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    enhancementWorker?.stop();
    authoritativeSyncWorker?.stop();
    importWorker?.stop();
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
