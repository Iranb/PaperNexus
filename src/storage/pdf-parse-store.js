import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultRuntimeConfigRoot, resolvePathWithHome } from '../lib/config.js';
import { ensureDir, readJson, writeJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const PDF_PARSE_STATE_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

export function getPdfParseStoreRoot(options = {}) {
  return resolvePathWithHome(
    options.pdfParseStateRoot
    || process.env.PAPERNEXUS_PDF_PARSE_STATE_ROOT
    || path.join(getDefaultRuntimeConfigRoot(), 'pdf-parser')
  );
}

function createSourceHash(pdfPath) {
  return stableHash(path.resolve(String(pdfPath || '')), 20);
}

function createRunId(sourceHash) {
  return `pdf:${Date.now()}:${stableHash(`${sourceHash}:${process.pid}:${Math.random()}`, 10)}`;
}

function getPdfParseRunPaths(rootDir, sourceHash, runId) {
  return {
    rootDir,
    sourceHash,
    runId,
    runDir: path.join(rootDir, 'runs', runId),
    statePath: path.join(rootDir, 'runs', runId, 'state.json'),
    eventsPath: path.join(rootDir, 'runs', runId, 'events.log'),
    latestPath: path.join(rootDir, 'latest', `${sourceHash}.json`)
  };
}

function createLatestPointer(state, paths) {
  return {
    version: PDF_PARSE_STATE_VERSION,
    runId: state.runId,
    attempt: Number(state.attempt || 1),
    sourceHash: state.sourceHash,
    sourcePath: state.sourcePath,
    sourceName: state.sourceName,
    selectedParser: state.selectedParser,
    activeParser: state.activeParser,
    status: state.status,
    currentStep: state.currentStep || '',
    message: state.message || '',
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    finishedAt: state.finishedAt || null,
    statePath: paths.statePath,
    eventsPath: paths.eventsPath
  };
}

async function persistPdfParseState(state, paths) {
  await ensureDir(paths.runDir);
  await writeJson(paths.statePath, state);
  await ensureDir(path.dirname(paths.latestPath));
  await writeJson(paths.latestPath, createLatestPointer(state, paths));
}

async function appendPdfParseEvent(paths, level, message) {
  const timestamp = nowIso();
  await ensureDir(paths.runDir);
  await fs.appendFile(
    paths.eventsPath,
    `[${timestamp}] [${String(level || 'info').trim().toLowerCase() || 'info'}] ${String(message || '').trim() || 'event'}\n`,
    'utf8'
  );
}

async function loadLatestPointer(latestPath) {
  return readJson(latestPath, null);
}

async function interruptPreviousRunIfNeeded(paths, sourceHash) {
  const latest = await loadLatestPointer(paths.latestPath);
  if (!latest?.statePath) {
    return 1;
  }

  const previousState = await readJson(latest.statePath, null);
  if (!previousState || TERMINAL_STATUSES.has(String(previousState.status || '').trim().toLowerCase())) {
    return Number(previousState?.attempt || latest.attempt || 0) + 1;
  }

  const interruptedAt = nowIso();
  previousState.status = 'interrupted';
  previousState.currentStep = 'interrupted by a newer parse attempt';
  previousState.message = 'Interrupted by a newer parse attempt';
  previousState.updatedAt = interruptedAt;
  previousState.finishedAt = interruptedAt;
  await writeJson(latest.statePath, previousState);
  if (latest.eventsPath) {
    await fs.appendFile(
      latest.eventsPath,
      `[${interruptedAt}] [warn] interrupted by a newer parse attempt\n`,
      'utf8'
    ).catch(() => {});
  }

  return Number(previousState.attempt || latest.attempt || 0) + 1;
}

export async function createPdfParseTracker(pdfPath, parser, options = {}) {
  const sourcePath = path.resolve(String(pdfPath || ''));
  const sourceHash = createSourceHash(sourcePath);
  const rootDir = getPdfParseStoreRoot(options);
  const runId = createRunId(sourceHash);
  const paths = getPdfParseRunPaths(rootDir, sourceHash, runId);
  const attempt = await interruptPreviousRunIfNeeded(paths, sourceHash);
  const startedAt = nowIso();
  let state = {
    version: PDF_PARSE_STATE_VERSION,
    runId,
    attempt,
    sourceHash,
    sourcePath,
    sourceName: path.basename(sourcePath),
    selectedParser: String(options.selectedParser || parser || '').trim() || 'unknown',
    activeParser: String(parser || '').trim() || 'unknown',
    fallbackFromParser: options.fallbackFromParser || null,
    status: 'starting',
    currentStep: 'starting parser run',
    message: `Starting ${String(parser || 'pdf').trim() || 'pdf'} parse`,
    parserCommand: null,
    rootPath: options.rootPath ? path.resolve(String(options.rootPath)) : null,
    sourceKey: options.sourceKey ? String(options.sourceKey).trim() : null,
    importTaskId: options.importTaskId ? String(options.importTaskId).trim() : null,
    importStage: options.importStage ? String(options.importStage).trim() : null,
    pid: process.pid,
    host: os.hostname(),
    startedAt,
    updatedAt: startedAt,
    finishedAt: null
  };

  await persistPdfParseState(state, paths);
  await appendPdfParseEvent(paths, 'info', `created parser run ${runId} for ${sourcePath}`);

  return {
    runId,
    sourceHash,
    statePath: paths.statePath,
    eventsPath: paths.eventsPath,
    latestPath: paths.latestPath,
    getState() {
      return state;
    },
    async update(patch = {}) {
      const timestamp = nowIso();
      state = {
        ...state,
        ...patch,
        updatedAt: timestamp
      };
      const normalizedStatus = String(state.status || '').trim().toLowerCase();
      if (TERMINAL_STATUSES.has(normalizedStatus)) {
        state.finishedAt = state.finishedAt || timestamp;
      }
      await persistPdfParseState(state, paths);
      return state;
    },
    async log(level = 'info', message = '') {
      await appendPdfParseEvent(paths, level, message);
    },
    async finish(status = 'completed', message = '', patch = {}) {
      if (message) {
        await appendPdfParseEvent(paths, status === 'failed' ? 'error' : 'info', message);
      }
      return this.update({
        ...patch,
        status,
        currentStep: patch.currentStep || message || state.currentStep,
        message: message || patch.message || state.message
      });
    }
  };
}
