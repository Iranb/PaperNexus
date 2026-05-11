import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, fileExists, readJson, readText, withFileLock, writeJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const RUN_STORE_VERSION = 1;
const RUN_EVENT_CONTRACT_VERSION = 'papernexus-run-event-v1';
const RUN_STATE_CONTRACT_VERSION = 'papernexus-run-state-v1';
const RUN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted', 'cancelled']);
const DEFAULT_WORKER_LEASE_STALE_MS = 2 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function sanitizePathSegment(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '_';
  return normalized.replace(/[^A-Za-z0-9._=-]+/g, '_').slice(0, 160) || '_';
}

function encodeRunDirName(runId) {
  return encodeURIComponent(String(runId || '').trim());
}

function createTimestampIdPart(timestamp = new Date()) {
  return timestamp.toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
}

function normalizeStagePatch(stage, patch = {}) {
  const status = String(patch.status || 'running').trim().toLowerCase() || 'running';
  return {
    stage,
    status,
    processedUnits: Math.max(0, Number(patch.processedUnits || 0) || 0),
    totalUnits: Math.max(0, Number(patch.totalUnits || 0) || 0),
    percent: clampPercent(patch.percent),
    message: String(patch.message || '').trim(),
    startedAt: patch.startedAt || null,
    updatedAt: patch.updatedAt || nowIso(),
    completedAt: patch.completedAt || null,
    lastError: patch.lastError || null,
    checkpointKey: patch.checkpointKey || null,
    ...patch
  };
}

function clampPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function computeOverallFromStages(stages = {}, weights = {}) {
  const entries = Object.entries(stages || {});
  if (!entries.length) {
    return {
      processedUnits: 0,
      totalUnits: 0,
      percent: 0
    };
  }

  const explicitWeightSum = Object.values(weights || {})
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);
  const fallbackWeight = explicitWeightSum > 0 ? 0 : (100 / entries.length);
  let weightedPercent = 0;
  let usedWeight = 0;
  let processedUnits = 0;
  let totalUnits = 0;

  for (const [stage, state] of entries) {
    const weight = Number(weights?.[stage] || fallbackWeight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedPercent += clampPercent(state?.percent, state?.status === 'completed' ? 100 : 0) * weight;
    usedWeight += weight;
    processedUnits += Math.max(0, Number(state?.processedUnits || 0) || 0);
    totalUnits += Math.max(0, Number(state?.totalUnits || 0) || 0);
  }

  return {
    processedUnits,
    totalUnits,
    percent: usedWeight ? clampPercent(weightedPercent / usedWeight) : 0
  };
}

function createRunId(kind, rootPath, options = {}) {
  const manifestToken = String(options.manifestToken || 'no-manifest').trim() || 'no-manifest';
  const timestamp = createTimestampIdPart();
  const suffix = stableHash(`${rootPath}:${kind}:${manifestToken}:${timestamp}:${process.pid}:${Math.random()}`, 8);
  return `${String(kind || 'run').trim() || 'run'}:${stableHash(rootPath, 8)}:${stableHash(manifestToken, 8)}:${timestamp}:${suffix}`;
}

export function getRunStorePaths(rootPath, runId = '') {
  const runsDir = path.join(path.resolve(rootPath), '.papernexus', 'runs');
  const runDir = runId ? path.join(runsDir, encodeRunDirName(runId)) : '';
  return {
    rootPath: path.resolve(rootPath),
    runsDir,
    latestPath: path.join(runsDir, 'latest.json'),
    lockPath: path.join(runsDir, 'run-store.lock'),
    runId,
    runDir,
    runPath: runDir ? path.join(runDir, 'run.json') : '',
    statePath: runDir ? path.join(runDir, 'state.json') : '',
    eventsPath: runDir ? path.join(runDir, 'events.ndjson') : '',
    stagesDir: runDir ? path.join(runDir, 'stages') : '',
    checkpointsDir: runDir ? path.join(runDir, 'checkpoints') : '',
    workersDir: runDir ? path.join(runDir, 'workers') : ''
  };
}

export async function resolveRunId(rootPath, runId = 'latest') {
  const normalized = String(runId || 'latest').trim() || 'latest';
  if (normalized !== 'latest') return normalized;
  const { latestPath } = getRunStorePaths(rootPath);
  const latest = await readJson(latestPath, null);
  if (!latest?.runId) {
    throw new Error(`No PaperNexus run has been recorded for ${rootPath}.`);
  }
  return latest.runId;
}

async function loadRunRecord(rootPath, runId) {
  const paths = getRunStorePaths(rootPath, runId);
  const run = await readJson(paths.runPath, null);
  if (!run) {
    throw new Error(`Unknown PaperNexus run "${runId}".`);
  }
  return { paths, run };
}

function createStateFromRun(run, patch = {}) {
  const stages = {
    ...(run.stages || {}),
    ...(patch.stages || {})
  };
  const overall = patch.overall || computeOverallFromStages(stages, run.stageWeights || {});
  return {
    contractVersion: RUN_STATE_CONTRACT_VERSION,
    version: RUN_STORE_VERSION,
    runId: run.runId,
    kind: run.kind,
    status: patch.status || run.status || 'running',
    currentStage: patch.currentStage || run.currentStage || null,
    startedAt: run.startedAt || run.createdAt,
    updatedAt: patch.updatedAt || nowIso(),
    resumedAt: patch.resumedAt || run.resumedAt || null,
    completedAt: patch.completedAt || run.completedAt || null,
    manifestToken: run.manifestToken || null,
    configSignature: run.configSignature || null,
    promptVersion: run.promptVersion || null,
    overall,
    stages,
    warnings: Array.isArray(patch.warnings) ? patch.warnings : (run.warnings || []),
    lastError: patch.lastError !== undefined ? patch.lastError : (run.lastError || null),
    canContinue: patch.canContinue !== undefined ? Boolean(patch.canContinue) : !RUN_TERMINAL_STATUSES.has(String(run.status || '').toLowerCase())
  };
}

export async function startRun(rootPath, options = {}) {
  const kind = String(options.kind || 'run').trim() || 'run';
  const runId = String(options.runId || '').trim() || createRunId(kind, rootPath, options);
  const paths = getRunStorePaths(rootPath, runId);
  const startedAt = nowIso();
  const run = {
    contractVersion: RUN_STATE_CONTRACT_VERSION,
    version: RUN_STORE_VERSION,
    runId,
    kind,
    rootPath: path.resolve(rootPath),
    command: options.command || kind,
    status: 'running',
    currentStage: options.currentStage || null,
    manifestToken: options.manifestToken || null,
    configSignature: options.configSignature || null,
    promptVersion: options.promptVersion || null,
    stageWeights: options.stageWeights || {},
    stages: {},
    warnings: [],
    lastError: null,
    latestSeq: 0,
    pid: process.pid,
    host: os.hostname(),
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    metadata: options.metadata || {}
  };

  await withFileLock(getRunStorePaths(rootPath).lockPath, async () => {
    await ensureDir(paths.runDir);
    await Promise.all([
      ensureDir(paths.stagesDir),
      ensureDir(paths.checkpointsDir),
      ensureDir(paths.workersDir)
    ]);
    await writeJson(paths.runPath, run);
    await writeJson(paths.statePath, createStateFromRun(run));
    await writeJson(paths.latestPath, {
      version: RUN_STORE_VERSION,
      runId,
      kind,
      rootPath: path.resolve(rootPath),
      runPath: paths.runPath,
      statePath: paths.statePath,
      eventsPath: paths.eventsPath,
      updatedAt: startedAt
    });
  });

  await appendRunEvent(rootPath, runId, {
    event: 'run-started',
    level: 'info',
    message: options.message || `Started ${kind} run`,
    stage: options.currentStage || null
  });

  return loadRunStatus(rootPath, runId);
}

export async function appendRunEvent(rootPath, runId, event = {}) {
  const paths = getRunStorePaths(rootPath, runId);
  return withFileLock(getRunStorePaths(rootPath).lockPath, async () => {
    const run = await readJson(paths.runPath, null);
    if (!run) {
      throw new Error(`Unknown PaperNexus run "${runId}".`);
    }

    const seq = Number(run.latestSeq || 0) + 1;
    const timestamp = event.time || nowIso();
    const normalized = {
      contractVersion: RUN_EVENT_CONTRACT_VERSION,
      seq,
      time: timestamp,
      level: String(event.level || 'info').trim().toLowerCase() || 'info',
      runId,
      stage: event.stage || run.currentStage || null,
      shardId: event.shardId || null,
      workerId: event.workerId || null,
      attempt: Number(event.attempt || 1),
      event: String(event.event || 'event').trim() || 'event',
      message: String(event.message || '').trim() || 'event',
      processedUnits: event.processedUnits ?? null,
      totalUnits: event.totalUnits ?? null,
      percent: event.percent === undefined ? null : clampPercent(event.percent),
      checkpointKey: event.checkpointKey || null,
      sourceKey: event.sourceKey || null,
      paperId: event.paperId || null,
      error: event.error || null,
      data: event.data || null
    };

    run.latestSeq = seq;
    run.updatedAt = timestamp;
    await writeJson(paths.runPath, run);
    await ensureDir(paths.runDir);
    await fs.appendFile(paths.eventsPath, `${JSON.stringify(normalized)}\n`, 'utf8');
    return normalized;
  });
}

export async function updateRunState(rootPath, runId, patch = {}) {
  const paths = getRunStorePaths(rootPath, runId);
  return withFileLock(getRunStorePaths(rootPath).lockPath, async () => {
    const run = await readJson(paths.runPath, null);
    if (!run) {
      throw new Error(`Unknown PaperNexus run "${runId}".`);
    }
    const nextRun = {
      ...run,
      ...patch,
      metadata: {
        ...(run.metadata || {}),
        ...(patch.metadata || {})
      },
      stages: {
        ...(run.stages || {}),
        ...(patch.stages || {})
      },
      updatedAt: patch.updatedAt || nowIso()
    };
    if (RUN_TERMINAL_STATUSES.has(String(nextRun.status || '').toLowerCase())) {
      nextRun.completedAt = nextRun.completedAt || nextRun.updatedAt;
    }
    await writeJson(paths.runPath, nextRun);
    const state = createStateFromRun(nextRun, patch);
    await writeJson(paths.statePath, state);
    await writeJson(paths.latestPath, {
      version: RUN_STORE_VERSION,
      runId,
      kind: nextRun.kind,
      rootPath: path.resolve(rootPath),
      runPath: paths.runPath,
      statePath: paths.statePath,
      eventsPath: paths.eventsPath,
      updatedAt: nextRun.updatedAt
    });
    return state;
  });
}

export async function updateRunStage(rootPath, runId, stage, patch = {}) {
  const stageName = String(stage || '').trim();
  if (!stageName) {
    throw new Error('Run stage name is required.');
  }
  const paths = getRunStorePaths(rootPath, runId);
  const timestamp = nowIso();
  const stageState = normalizeStagePatch(stageName, {
    ...patch,
    updatedAt: patch.updatedAt || timestamp
  });
  const stagePath = path.join(paths.stagesDir, `${sanitizePathSegment(stageName)}.json`);
  await ensureDir(paths.stagesDir);
  await writeJson(stagePath, stageState);
  const statePatch = {
    currentStage: stageName,
    stages: {
      [stageName]: stageState
    },
    updatedAt: timestamp
  };
  if (patch.runStatus) {
    statePatch.status = patch.runStatus;
  }
  return updateRunState(rootPath, runId, statePatch);
}

export async function writeRunCheckpoint(rootPath, runId, checkpointKey, checkpoint = {}) {
  const normalizedKey = String(checkpointKey || '').trim();
  if (!normalizedKey) {
    throw new Error('Checkpoint key is required.');
  }
  const paths = getRunStorePaths(rootPath, runId);
  const segments = normalizedKey.split('/').map(sanitizePathSegment);
  const checkpointPath = path.join(paths.checkpointsDir, ...segments) + '.json';
  const timestamp = nowIso();
  const payload = {
    version: RUN_STORE_VERSION,
    checkpointKey: normalizedKey,
    status: checkpoint.status || 'completed',
    updatedAt: timestamp,
    ...checkpoint
  };
  await ensureDir(path.dirname(checkpointPath));
  await writeJson(checkpointPath, payload);
  await appendRunEvent(rootPath, runId, {
    event: 'shard-checkpointed',
    level: 'info',
    stage: normalizedKey.split('/')[0] || null,
    checkpointKey: normalizedKey,
    message: checkpoint.message || `checkpoint ${normalizedKey} ${payload.status}`
  });
  return {
    checkpointPath,
    checkpoint: payload
  };
}

export async function writeRunWorkerLease(rootPath, runId, workerId, lease = {}) {
  const normalizedWorkerId = String(workerId || '').trim() || `worker-${process.pid}`;
  const paths = getRunStorePaths(rootPath, runId);
  const timestamp = nowIso();
  const leaseMs = Math.max(1000, Number(lease.leaseMs || lease.ttlMs || DEFAULT_WORKER_LEASE_STALE_MS));
  const payload = {
    version: RUN_STORE_VERSION,
    workerId: normalizedWorkerId,
    status: lease.status || 'running',
    stage: lease.stage || null,
    shardId: lease.shardId || null,
    leaseToken: lease.leaseToken || stableHash(`${runId}:${normalizedWorkerId}:${timestamp}:${Math.random()}`, 16),
    claimedBy: normalizedWorkerId,
    claimedAt: lease.claimedAt || timestamp,
    lastHeartbeatAt: timestamp,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    pid: process.pid,
    host: os.hostname(),
    ...lease
  };
  await ensureDir(paths.workersDir);
  await writeJson(path.join(paths.workersDir, `${sanitizePathSegment(normalizedWorkerId)}.json`), payload);
  await appendRunEvent(rootPath, runId, {
    event: 'worker-heartbeat',
    level: 'debug',
    stage: payload.stage,
    shardId: payload.shardId,
    workerId: normalizedWorkerId,
    message: `worker ${normalizedWorkerId} heartbeat`
  });
  return payload;
}

export async function markStaleRunWorkers(rootPath, runId, options = {}) {
  const paths = getRunStorePaths(rootPath, runId);
  const nowMs = Date.now();
  const stale = [];
  let fileNames = [];
  try {
    fileNames = await fs.readdir(paths.workersDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  for (const fileName of fileNames.filter((name) => name.endsWith('.json'))) {
    const leasePath = path.join(paths.workersDir, fileName);
    const lease = await readJson(leasePath, null);
    if (!lease) continue;
    const status = String(lease.status || '').trim().toLowerCase();
    if (status !== 'running' && status !== 'claimed') continue;
    const expiresAt = Date.parse(lease.leaseExpiresAt || lease.lastHeartbeatAt || 0) || 0;
    const staleMs = Math.max(1000, Number(options.staleMs || DEFAULT_WORKER_LEASE_STALE_MS));
    const heartbeatMs = Date.parse(lease.lastHeartbeatAt || 0) || 0;
    if ((expiresAt && expiresAt >= nowMs) || (heartbeatMs && nowMs - heartbeatMs < staleMs)) {
      continue;
    }
    const nextLease = {
      ...lease,
      status: 'stale',
      staleAt: nowIso(),
      staleReason: 'lease-expired'
    };
    await writeJson(leasePath, nextLease);
    stale.push(nextLease);
    await appendRunEvent(rootPath, runId, {
      event: 'shard-failed',
      level: 'warn',
      stage: nextLease.stage,
      shardId: nextLease.shardId,
      workerId: nextLease.workerId,
      message: `worker lease ${nextLease.workerId} is stale`,
      error: { message: 'worker lease expired' }
    });
  }

  return stale;
}

export async function loadRunStatus(rootPath, runId = 'latest') {
  const resolvedRunId = await resolveRunId(rootPath, runId);
  const paths = getRunStorePaths(rootPath, resolvedRunId);
  const [run, state, latest] = await Promise.all([
    readJson(paths.runPath, null),
    readJson(paths.statePath, null),
    readJson(paths.latestPath, null)
  ]);
  if (!run) {
    throw new Error(`Unknown PaperNexus run "${resolvedRunId}".`);
  }
  return {
    rootPath: path.resolve(rootPath),
    runId: resolvedRunId,
    run,
    state: state || createStateFromRun(run),
    latest,
    paths
  };
}

export async function tailRunEvents(rootPath, runId = 'latest', options = {}) {
  const resolvedRunId = await resolveRunId(rootPath, runId);
  const { eventsPath } = getRunStorePaths(rootPath, resolvedRunId);
  const raw = await (fileExists(eventsPath).then((exists) => exists ? readText(eventsPath) : ''));
  const lines = raw.trimEnd().split('\n').filter(Boolean);
  const tail = Math.max(0, Number(options.tail || options.limit || 0) || 0);
  const selected = tail > 0 ? lines.slice(-tail) : lines;
  return {
    runId: resolvedRunId,
    eventsPath,
    events: selected.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
  };
}

async function listJsonFilesRecursive(rootDir) {
  const results = [];

  async function visit(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const payload = await readJson(entryPath, null);
      if (!payload) continue;
      results.push({
        path: entryPath,
        relativePath: path.relative(rootDir, entryPath).split(path.sep).join('/'),
        payload
      });
    }
  }

  await visit(rootDir);
  return results;
}

export async function listRunCheckpoints(rootPath, runId = 'latest') {
  const resolvedRunId = await resolveRunId(rootPath, runId);
  const { checkpointsDir } = getRunStorePaths(rootPath, resolvedRunId);
  const entries = await listJsonFilesRecursive(checkpointsDir);
  return entries
    .map((entry) => ({
      ...entry.payload,
      checkpointPath: entry.path,
      checkpointKey: entry.payload.checkpointKey
        || entry.relativePath.replace(/\.json$/i, '')
    }))
    .sort((left, right) => String(left.checkpointKey || '').localeCompare(String(right.checkpointKey || '')));
}

export async function listRunWorkers(rootPath, runId = 'latest') {
  const resolvedRunId = await resolveRunId(rootPath, runId);
  const { workersDir } = getRunStorePaths(rootPath, resolvedRunId);
  const entries = await listJsonFilesRecursive(workersDir);
  return entries
    .map((entry) => ({
      ...entry.payload,
      leasePath: entry.path,
      workerId: entry.payload.workerId || entry.relativePath.replace(/\.json$/i, '')
    }))
    .sort((left, right) => String(left.workerId || '').localeCompare(String(right.workerId || '')));
}

function countByStatus(items = []) {
  const counts = {};
  for (const item of items) {
    const status = String(item?.status || 'unknown').trim().toLowerCase() || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export async function loadRunReport(rootPath, runId = 'latest', options = {}) {
  const status = await loadRunStatus(rootPath, runId);
  const [events, checkpoints, workers] = await Promise.all([
    tailRunEvents(rootPath, status.runId, {
      tail: Math.max(1, Number(options.tail || 50) || 50)
    }),
    listRunCheckpoints(rootPath, status.runId),
    listRunWorkers(rootPath, status.runId)
  ]);

  return {
    ...status,
    events: events.events,
    eventsPath: events.eventsPath,
    checkpoints,
    workers,
    summary: {
      checkpointCount: checkpoints.length,
      checkpointStatuses: countByStatus(checkpoints),
      workerCount: workers.length,
      workerStatuses: countByStatus(workers),
      recentEventCount: events.events.length,
      lastEvent: events.events.at(-1) || null
    }
  };
}

export async function continueRun(rootPath, options = {}) {
  const runId = await resolveRunId(rootPath, options.runId || 'latest');
  const { run } = await loadRunRecord(rootPath, runId);
  const manifestToken = options.manifestToken || null;
  const configSignature = options.configSignature || null;

  if (manifestToken && run.manifestToken && manifestToken !== run.manifestToken && !options.acceptManifestDrift) {
    throw new Error(
      `Run ${runId} was created for manifest ${run.manifestToken}, but current manifest is ${manifestToken}. `
      + 'Use --accept-manifest-drift only if you intentionally want to rebase this run.'
    );
  }
  if (configSignature && run.configSignature && configSignature !== run.configSignature && !options.acceptConfigDrift) {
    throw new Error(
      `Run ${runId} was created for config ${run.configSignature}, but current config is ${configSignature}.`
    );
  }

  const staleWorkers = await markStaleRunWorkers(rootPath, runId, options);
  const resumedAt = nowIso();
  const state = await updateRunState(rootPath, runId, {
    status: 'running',
    resumedAt,
    canContinue: true,
    lastError: null,
    updatedAt: resumedAt
  });
  await appendRunEvent(rootPath, runId, {
    event: 'run-resumed',
    level: 'info',
    message: staleWorkers.length
      ? `resumed run and reclaimed ${staleWorkers.length} stale worker lease(s)`
      : 'resumed run'
  });
  return {
    runId,
    state,
    staleWorkers
  };
}

export async function retryFailedRun(rootPath, options = {}) {
  const runId = await resolveRunId(rootPath, options.runId || 'latest');
  const { run } = await loadRunRecord(rootPath, runId);
  const stages = {};
  for (const [stage, stageState] of Object.entries(run.stages || {})) {
    if (String(stageState?.status || '').toLowerCase() === 'failed') {
      stages[stage] = {
        ...stageState,
        status: 'pending',
        lastError: null,
        retryRequestedAt: nowIso()
      };
    }
  }
  const state = await updateRunState(rootPath, runId, {
    status: 'running',
    stages,
    lastError: null,
    canContinue: true
  });
  await appendRunEvent(rootPath, runId, {
    event: 'retry-started',
    level: 'info',
    message: Object.keys(stages).length
      ? `scheduled retry for ${Object.keys(stages).join(', ')}`
      : 'scheduled retry for failed run'
  });
  return {
    runId,
    state,
    retriedStages: Object.keys(stages)
  };
}

export async function abortRun(rootPath, options = {}) {
  const runId = await resolveRunId(rootPath, options.runId || 'latest');
  const abortedAt = nowIso();
  const state = await updateRunState(rootPath, runId, {
    status: 'aborted',
    completedAt: abortedAt,
    canContinue: false,
    lastError: null,
    updatedAt: abortedAt
  });
  await appendRunEvent(rootPath, runId, {
    event: 'run-aborted',
    level: 'warn',
    message: options.reason || 'run aborted by operator'
  });
  return {
    runId,
    state
  };
}
