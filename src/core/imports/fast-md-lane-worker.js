import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runImportsForAllCorporaOnce } from './worker.js';

const FAST_MD_LANE_OPTIONS_ENV = 'PAPERNEXUS_FAST_MD_LANE_OPTIONS_JSON';
const CHILD_ARG = '--papernexus-fast-md-lane-child';
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|api[_-]?token|password|secret|token)$/i;

function sanitizeChildOptions(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeChildOptions(item));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'function') continue;
    if (key === 'logger') continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    result[key] = sanitizeChildOptions(entry);
  }
  return result;
}

function buildFastMdLaneChildOptions(options = {}) {
  return sanitizeChildOptions({
    ...options,
    importTaskLaneMode: 'fast-md-only',
    importSemanticEnrichmentEnabled: false,
    semanticEnrichmentEnabled: false,
    backgroundSemanticEnrichment: false
  });
}

function parseChildOptionsFromEnv(env = process.env) {
  const raw = String(env[FAST_MD_LANE_OPTIONS_ENV] || '').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function prefixedPipe(stream, writer, prefix) {
  let carry = '';
  stream.on('data', (chunk) => {
    const text = `${carry}${chunk.toString('utf8')}`;
    const lines = text.split(/\r?\n/);
    carry = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed) writer(`${prefix}${trimmed}`);
    }
  });
  stream.on('end', () => {
    const trimmed = carry.trimEnd();
    if (trimmed) writer(`${prefix}${trimmed}`);
    carry = '';
  });
}

async function runFastMdLanePass(options = {}) {
  const results = await runImportsForAllCorporaOnce({
    ...options,
    importTaskLaneMode: 'fast-md-only',
    importSemanticEnrichmentEnabled: false,
    semanticEnrichmentEnabled: false,
    backgroundSemanticEnrichment: false
  });
  for (const result of results) {
    if (!result.processed) continue;
    if (result.failed) {
      const failedCount = Array.isArray(result.failedTaskIds) && result.failedTaskIds.length ? result.failedTaskIds.length : 1;
      console.error(
        `[fast-md-lane] ${result.corpusName || result.rootPath}: `
        + `${result.batchId ? `batch ${result.batchId}` : `task ${result.taskId}`} failed ${failedCount} task(s)`
        + (result.error ? ` (${result.error})` : '')
      );
      continue;
    }
    const completedCount = Array.isArray(result.completedTaskIds) && result.completedTaskIds.length
      ? result.completedTaskIds.length
      : (result.taskId ? 1 : 0);
    if (completedCount) {
      console.log(
        `[fast-md-lane] ${result.corpusName || result.rootPath}: completed `
        + (result.batchId ? `batch ${result.batchId} (${completedCount} task(s))` : `task ${result.taskId}`)
      );
    }
  }
}

export async function runFastMdLaneChild(options = parseChildOptionsFromEnv()) {
  const intervalMs = Math.max(500, Number(options.fastMdImportLaneIntervalMs || options.intervalMs || 1500));
  let closed = false;
  let running = false;
  let timer = null;

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
  };

  const tick = async () => {
    if (closed || running) {
      schedule();
      return;
    }
    running = true;
    try {
      await runFastMdLanePass(options);
    } catch (error) {
      console.error(`[fast-md-lane] ${error.message || error}`);
    } finally {
      running = false;
      schedule();
    }
  };

  const shutdown = () => {
    closed = true;
    clearTimeout(timer);
  };

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('message', (message) => {
    if (message?.type === 'pollNow') {
      clearTimeout(timer);
      void tick();
    }
  });

  await tick();
}

export function startIsolatedFastMdImportWorker(options = {}) {
  const logger = options.logger || console;
  const childScript = fileURLToPath(import.meta.url);
  const childOptions = buildFastMdLaneChildOptions(options);
  let closed = false;
  let child = null;
  let restartTimer = null;

  const spawnChild = () => {
    if (closed) return;
    child = spawn(process.execPath, [childScript, CHILD_ARG], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [FAST_MD_LANE_OPTIONS_ENV]: JSON.stringify(childOptions)
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    prefixedPipe(child.stdout, (line) => logger.log?.(line), '');
    prefixedPipe(child.stderr, (line) => logger.warn?.(line), '');
    child.on('exit', (code, signal) => {
      const expected = closed || signal === 'SIGTERM' || signal === 'SIGINT';
      if (!expected) {
        logger.warn?.(`[serve] fast-md import lane exited (${signal || code}); restarting`);
        restartTimer = setTimeout(spawnChild, 2000);
      }
    });
  };

  spawnChild();

  return {
    async stop() {
      closed = true;
      clearTimeout(restartTimer);
      const activeChild = child;
      if (!activeChild || activeChild.exitCode !== null) return;
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          activeChild.kill('SIGKILL');
        }, 5000);
        activeChild.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        activeChild.kill('SIGTERM');
      });
    },
    pollNow() {
      if (child?.connected) {
        child.send({ type: 'pollNow' });
      }
    }
  };
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun && process.argv.includes(CHILD_ARG)) {
  runFastMdLaneChild().catch((error) => {
    console.error(`[fast-md-lane] fatal: ${error.message || error}`);
    process.exit(1);
  });
}
