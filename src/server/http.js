import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backupCorpusPayload,
  corpusMetaPayload,
  corpusPayload,
  createApiCache,
  enhancementSummaryPayload,
  listCorporaPayload,
  llmConfigPayload,
  paperEnhancementPayload,
  updateLlmConfigPayload
} from './api.js';
import { startEnhancementWorker } from '../core/enhancements/worker.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

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

export async function serveCommand(options = {}) {
  const port = Number(options.port || 4821);
  const host = options.host || '127.0.0.1';
  const webRoot = buildWebRoot();
  const apiCache = createApiCache();
  const enhancementWorker = options.enableEnhancements === false
    ? null
    : startEnhancementWorker({
      intervalMs: options.enhancementIntervalMs,
      backfillLimit: options.enhancementBackfillLimit,
      logger: console
    });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}:${port}`);

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, service: 'papernexus-web' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpora') {
        sendJson(response, 200, await listCorporaPayload({ cache: apiCache }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpus') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await corpusPayload(name, { cache: apiCache }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/corpus-meta') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await corpusMetaPayload(name, { cache: apiCache }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/enhancements') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await enhancementSummaryPayload(name, { cache: apiCache }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/paper-enhancement') {
        const name = url.searchParams.get('name') || undefined;
        const paperId = url.searchParams.get('paperId') || '';
        sendJson(response, 200, await paperEnhancementPayload(name, paperId, { cache: apiCache }));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/backup') {
        const name = url.searchParams.get('name') || undefined;
        sendJson(response, 200, await backupCorpusPayload(name, {
          backupDir: options.backupDir
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
  console.log('Press Ctrl+C to stop.');

  const shutdown = () => {
    enhancementWorker?.stop();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
