import path from 'node:path';
import fs from 'node:fs/promises';
import { readJson, withFileLock, writeJson } from '../../lib/fs.js';
import {
  completeAuthoritativeSyncJob,
  failAuthoritativeSyncJob,
  listAuthoritativeSyncJobs,
  recoverStaleAuthoritativeSyncJobs,
  reserveNextAuthoritativeSyncJob
} from '../../storage/authoritative-sync-store.js';
import {
  getCorpusPaths,
  loadCorpus,
  loadSourceManifest,
  saveCorpus
} from '../../storage/corpus-store.js';
import { updateImportTasksAuthoritativeSyncLifecycle } from '../../storage/import-store.js';
import { saveGraphDeltaToKuzu } from '../../storage/kuzu-store.js';
import { writeKuzuCommitReceipt } from '../../storage/kuzu-commit-receipt-store.js';
import { loadRegistry } from '../../storage/registry.js';
import { applyGraphDeltaPayload } from '../graph/delta-commit.js';
import { summarizeCorpusGraph } from '../graph/summary.js';

const DEFAULT_AUTHORITATIVE_SYNC_WORKER_LOCK_TIMEOUT_MS = 350;
const DEFAULT_AUTHORITATIVE_SYNC_WORKER_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AUTHORITATIVE_SYNC_QUEUE_LOCK_TIMEOUT_MS = 5000;

function isLockTimeout(error) {
  return String(error?.message || '').includes('Timed out waiting for file lock');
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function shouldRunGraphV2ShadowSync(meta = {}, options = {}) {
  if (options.graphV2ShadowSync !== undefined) {
    return Boolean(options.graphV2ShadowSync);
  }
  if (isTruthyEnv(process.env.PAPERNEXUS_GRAPH_V2_SHADOW_SYNC)) {
    return true;
  }
  const status = String(meta?.graphV2Status || '').trim().toLowerCase();
  return status === 'shadow' || status === 'shadow-sync';
}

async function inspectPotentiallyStaleLock(lockPath, staleMs) {
  try {
    const stats = await fs.stat(lockPath);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs <= staleMs) {
      return null;
    }
    let owner = null;
    try {
      owner = await readJson(path.join(lockPath, 'owner.json'), null);
    } catch (error) {
      owner = {
        unreadable: true,
        error: error.message
      };
    }
    return {
      lockPath,
      reason: 'stale-worker-lock',
      staleMs,
      observedAgeMs: Math.round(ageMs),
      observedMtimeAt: new Date(stats.mtimeMs).toISOString(),
      owner
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function processAuthoritativeSyncJob(rootPath, job, options = {}) {
  if (!job?.deltaPayload) {
    throw new Error(`Authoritative sync job ${job?.jobId || ''} is missing a delta payload.`);
  }

  const [corpus, manifest] = await Promise.all([
    loadCorpus(rootPath),
    loadSourceManifest(rootPath)
  ]);

  const paths = getCorpusPaths(rootPath);
  const { metaPath } = paths;
  const runningMeta = {
    ...corpus.meta,
    authoritativeSyncStatus: 'running',
    authoritativeSyncRunningAt: new Date().toISOString(),
    lastAuthoritativeSyncJobId: job.jobId
  };
  await writeJson(metaPath, runningMeta);

  const nextGraph = applyGraphDeltaPayload(corpus.graph, job.deltaPayload);
  const nextMeta = {
    ...runningMeta,
    indexedAt: new Date().toISOString(),
    ...summarizeCorpusGraph(nextGraph)
  };
  const graphV2Active = String(corpus?.meta?.graphV2Status || '').trim().toLowerCase() === 'active';
  const graphV2ShadowSync = !graphV2Active && shouldRunGraphV2ShadowSync(corpus?.meta, options);
  const graphGeneration = Number.isFinite(Number(nextMeta.graphGeneration ?? nextMeta.graph_generation))
    ? Number(nextMeta.graphGeneration ?? nextMeta.graph_generation)
    : Date.parse(nextMeta.indexedAt);
  let kuzuCommitReceipt = null;
  let kuzuCommitReceiptPath = null;
  let graphV2ShadowSyncResult = null;
  let graphV2ShadowSyncError = null;
  let graphV2ShadowCommitReceipt = null;
  let graphV2ShadowCommitReceiptPath = null;
  let graphV2ShadowSyncSkipped = false;
  if (graphV2Active) {
    const kuzuCommitResult = await saveGraphDeltaToKuzu(paths.kuzuGraphPath, job.deltaPayload, {
      jobId: job.jobId,
      baseManifestToken: job.baseManifestToken || null,
      targetManifestToken: job.targetManifestToken || null,
      onProgress: options.onProgress
    });
    const receiptResult = await writeKuzuCommitReceipt(rootPath, {
      runId: options.runId || job.runId || job.jobId,
      traceId: options.traceId || job.traceId || null,
      jobId: job.jobId,
      graphGeneration,
      baseManifestToken: job.baseManifestToken || null,
      targetManifestToken: job.targetManifestToken || null,
      deltaHash: kuzuCommitResult.deltaHash,
      dbPath: paths.kuzuGraphPath,
      changedSourceKeys: job.deltaPayload.changedSourceKeys || [],
      upsertedNodeCount: kuzuCommitResult.upsertedNodeCount,
      upsertedRelationshipCount: kuzuCommitResult.upsertedRelationshipCount,
      sourceFragmentCount: kuzuCommitResult.sourceFragmentCount,
      status: 'committed'
    });
    kuzuCommitReceipt = receiptResult.receipt;
    kuzuCommitReceiptPath = receiptResult.receiptPath;
    if (kuzuCommitReceipt.status !== 'committed') {
      throw new Error(`Kuzu commit receipt ${kuzuCommitReceipt.receipt_id} verification status is ${kuzuCommitReceipt.status}.`);
    }
  } else {
    await saveCorpus(rootPath, nextGraph, nextMeta, {
      liteViewMode: 'incremental',
      liteViewSources: manifest?.sources || [],
      onProgress: options.onProgress
    });

    if (graphV2ShadowSync) {
      const graphV2ShadowPath = options.graphV2ShadowPath || path.join(paths.corpusDir, 'graph-v2.kuzu');
      try {
        graphV2ShadowSyncResult = await saveGraphDeltaToKuzu(graphV2ShadowPath, job.deltaPayload, {
          jobId: `shadow:${job.jobId}`,
          baseManifestToken: job.baseManifestToken || null,
          targetManifestToken: job.targetManifestToken || null,
          onProgress: options.onProgress
        });
        const receiptResult = await writeKuzuCommitReceipt(rootPath, {
          runId: options.runId || job.runId || `shadow:${job.jobId}`,
          traceId: options.traceId || job.traceId || null,
          jobId: `shadow:${job.jobId}`,
          graphGeneration,
          baseManifestToken: job.baseManifestToken || null,
          targetManifestToken: job.targetManifestToken || null,
          deltaHash: graphV2ShadowSyncResult.deltaHash,
          dbPath: graphV2ShadowPath,
          changedSourceKeys: job.deltaPayload.changedSourceKeys || [],
          upsertedNodeCount: graphV2ShadowSyncResult.upsertedNodeCount,
          upsertedRelationshipCount: graphV2ShadowSyncResult.upsertedRelationshipCount,
          sourceFragmentCount: graphV2ShadowSyncResult.sourceFragmentCount,
          status: 'committed'
        });
        graphV2ShadowCommitReceipt = receiptResult.receipt;
        graphV2ShadowCommitReceiptPath = receiptResult.receiptPath;
      } catch (error) {
        graphV2ShadowSyncError = error;
        options.onProgress?.({
          phase: 'graph-v2-shadow-sync',
          label: `graph-v2 shadow sync failed: ${error.message}`,
          error
        });
      }
      graphV2ShadowSyncSkipped = !graphV2ShadowSyncResult && !graphV2ShadowSyncError;
    }
  }

  const completedAt = new Date().toISOString();
  const graphV2ShadowSyncMeta = graphV2ShadowSync
    ? graphV2ShadowSyncError
      ? {
          graphV2ShadowSyncStatus: 'failed',
          graphV2ShadowSyncFailedAt: completedAt,
          graphV2ShadowSyncError: graphV2ShadowSyncError.message
        }
      : {
          graphV2ShadowSyncStatus: graphV2ShadowSyncSkipped ? 'skipped' : 'synced',
          graphV2ShadowSyncedAt: completedAt,
          graphV2ShadowSyncError: null,
          graphV2ShadowCommitReceiptPath,
          graphV2ShadowCommitReceiptStatus: graphV2ShadowCommitReceipt?.status || null
        }
    : {};
  const syncedMeta = {
    ...nextMeta,
    authoritativeSyncStatus: 'synced',
    authoritativeSyncedAt: completedAt,
    authoritativeSyncFailedAt: null,
    authoritativeSyncError: null,
    lastAuthoritativeSyncJobId: job.jobId,
    graphGeneration,
    lastKuzuCommitReceiptPath: kuzuCommitReceiptPath,
    lastKuzuCommitReceiptStatus: kuzuCommitReceipt?.status || null,
    graphV2Status: graphV2Active ? 'active' : nextMeta.graphV2Status || corpus?.meta?.graphV2Status || null,
    ...graphV2ShadowSyncMeta
  };
  await writeJson(metaPath, syncedMeta);

  const completedJob = await completeAuthoritativeSyncJob(rootPath, job.jobId, {
    summary: {
      synchronizedNodeCount: nextGraph.nodeCount,
      synchronizedRelationshipCount: nextGraph.relationshipCount
    }
  });
  const taskBackfill = await updateImportTasksAuthoritativeSyncLifecycle(rootPath, job.jobId, 'completed', {
    job: completedJob,
    message: `authoritative sync job ${job.jobId} completed`
  });

  return {
    rootPath,
    jobId: job.jobId,
    meta: syncedMeta,
    kuzuCommitReceipt,
    kuzuCommitReceiptPath,
    taskBackfill
  };
}

export async function runAuthoritativeSyncQueueOnce(rootPath, options = {}) {
  const { authoritativeSyncWorkerLockPath, metaPath } = getCorpusPaths(rootPath);
  const lockTimeoutMs = Math.max(
    250,
    Number(options.lockTimeoutMs || DEFAULT_AUTHORITATIVE_SYNC_WORKER_LOCK_TIMEOUT_MS)
  );
  const lockStaleMs = Math.max(
    lockTimeoutMs,
    Number(
      options.workerLockStaleMs
      || options.authoritativeSyncWorkerLockStaleMs
      || options.lockStaleMs
      || DEFAULT_AUTHORITATIVE_SYNC_WORKER_LOCK_STALE_MS
    )
  );
  const queueLockTimeoutMs = Math.max(
    250,
    Number(
      options.queueLockTimeoutMs
      || options.authoritativeSyncQueueLockTimeoutMs
      || DEFAULT_AUTHORITATIVE_SYNC_QUEUE_LOCK_TIMEOUT_MS
    )
  );
  const workerLockRecovery = await inspectPotentiallyStaleLock(authoritativeSyncWorkerLockPath, lockStaleMs);

  try {
    return await withFileLock(authoritativeSyncWorkerLockPath, async () => {
      const staleRecovery = await recoverStaleAuthoritativeSyncJobs(rootPath, {
        ...options,
        queueLockTimeoutMs
      });
      const reserved = await reserveNextAuthoritativeSyncJob(rootPath, {
        ...options,
        queueLockTimeoutMs,
        workerId: options.workerId || 'authoritative-sync-worker'
      });

      if (!reserved) {
        return {
          processed: false,
          reason: 'idle',
          queuedJobs: await listAuthoritativeSyncJobs(rootPath),
          ...(workerLockRecovery ? { workerLockRecovery } : {}),
          ...(staleRecovery?.recoveredCount
            ? { recoveredStaleSyncJobs: staleRecovery.recoveredJobs }
            : {})
        };
      }

      try {
        const result = await processAuthoritativeSyncJob(rootPath, reserved, options);
        return {
          processed: true,
          failed: false,
          jobId: reserved.jobId,
          result,
          ...(workerLockRecovery ? { workerLockRecovery } : {}),
          ...(staleRecovery?.recoveredCount
            ? { recoveredStaleSyncJobs: staleRecovery.recoveredJobs }
            : {})
        };
      } catch (error) {
        const failedJob = await failAuthoritativeSyncJob(rootPath, reserved.jobId, error, {
          ...options,
          queueLockTimeoutMs
        });
        const taskBackfill = await updateImportTasksAuthoritativeSyncLifecycle(rootPath, reserved.jobId, 'failed', {
          job: failedJob,
          error,
          message: `authoritative sync job ${reserved.jobId} failed: ${error.message}`
        });
        try {
          const failedMeta = {
            ...(await readJson(metaPath, {})),
            authoritativeSyncStatus: 'failed',
            authoritativeSyncFailedAt: new Date().toISOString(),
            authoritativeSyncError: error.message,
            lastAuthoritativeSyncJobId: reserved.jobId
          };
          await writeJson(metaPath, failedMeta);
        } catch {
          // Best-effort status update.
        }
        return {
          processed: true,
          failed: true,
          jobId: reserved.jobId,
          error: error.message,
          taskBackfill,
          ...(workerLockRecovery ? { workerLockRecovery } : {}),
          ...(staleRecovery?.recoveredCount
            ? { recoveredStaleSyncJobs: staleRecovery.recoveredJobs }
            : {})
        };
      }
    }, {
      timeoutMs: lockTimeoutMs,
      staleMs: lockStaleMs
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      return {
        processed: false,
        reason: 'busy'
      };
    }
    throw error;
  }
}

export async function runAuthoritativeSyncForAllCorporaOnce(options = {}) {
  const configuredRoots = Array.isArray(options.rootPaths)
    ? options.rootPaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const registry = configuredRoots.length ? null : await loadRegistry();
  const roots = configuredRoots.length
    ? configuredRoots.map((rootPath) => ({ rootPath, name: rootPath }))
    : (registry?.corpora || []);
  const results = [];

  for (const corpus of roots) {
    results.push({
      rootPath: corpus.rootPath,
      corpusName: corpus.name,
      ...(await runAuthoritativeSyncQueueOnce(corpus.rootPath, options))
    });
  }

  return results;
}

export function startAuthoritativeSyncWorker(options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(1500, Number(options.intervalMs || 5000));
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
      const results = await runAuthoritativeSyncForAllCorporaOnce(options);
      for (const result of results) {
        if (!result.processed) continue;
        if (result.failed) {
          logger.error?.(`[authoritative-sync] ${result.corpusName || result.rootPath}: job ${result.jobId} failed (${result.error})`);
        } else {
          logger.log?.(`[authoritative-sync] ${result.corpusName || result.rootPath}: synced job ${result.jobId}`);
        }
      }
    } catch (error) {
      logger.error?.(`[authoritative-sync] ${error.message}`);
    } finally {
      running = false;
      schedule();
    }
  };

  void tick();

  return {
    async stop() {
      closed = true;
      clearTimeout(timer);
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    pollNow() {
      clearTimeout(timer);
      void tick();
    }
  };
}
