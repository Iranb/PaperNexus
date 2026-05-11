import path from 'node:path';
import { readJson, withFileLock, writeJson } from '../../lib/fs.js';
import {
  completeAuthoritativeSyncJob,
  failAuthoritativeSyncJob,
  listAuthoritativeSyncJobs,
  reserveNextAuthoritativeSyncJob
} from '../../storage/authoritative-sync-store.js';
import {
  getCorpusPaths,
  loadCorpus,
  loadSourceManifest,
  saveCorpus
} from '../../storage/corpus-store.js';
import { saveGraphDeltaToKuzu } from '../../storage/kuzu-store.js';
import { loadRegistry } from '../../storage/registry.js';
import { applyGraphDeltaPayload } from '../graph/delta-commit.js';
import { summarizeCorpusGraph } from '../graph/summary.js';

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
  let graphV2ShadowSyncResult = null;
  let graphV2ShadowSyncError = null;
  let graphV2ShadowSyncSkipped = false;
  if (graphV2Active) {
    await saveGraphDeltaToKuzu(paths.kuzuGraphPath, job.deltaPayload, {
      jobId: job.jobId,
      baseManifestToken: job.baseManifestToken || null,
      targetManifestToken: job.targetManifestToken || null,
      onProgress: options.onProgress
    });
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
          graphV2ShadowSyncError: null
        }
    : {};
  const syncedMeta = {
    ...nextMeta,
    authoritativeSyncStatus: 'synced',
    authoritativeSyncedAt: completedAt,
    authoritativeSyncFailedAt: null,
    authoritativeSyncError: null,
    lastAuthoritativeSyncJobId: job.jobId,
    graphV2Status: graphV2Active ? 'active' : nextMeta.graphV2Status || corpus?.meta?.graphV2Status || null,
    ...graphV2ShadowSyncMeta
  };
  await writeJson(metaPath, syncedMeta);

  await completeAuthoritativeSyncJob(rootPath, job.jobId, {
    summary: {
      synchronizedNodeCount: nextGraph.nodeCount,
      synchronizedRelationshipCount: nextGraph.relationshipCount
    }
  });

  return {
    rootPath,
    jobId: job.jobId,
    meta: syncedMeta
  };
}

export async function runAuthoritativeSyncQueueOnce(rootPath, options = {}) {
  const { authoritativeSyncWorkerLockPath, metaPath } = getCorpusPaths(rootPath);

  try {
    return await withFileLock(authoritativeSyncWorkerLockPath, async () => {
      const reserved = await reserveNextAuthoritativeSyncJob(rootPath, {
        workerId: options.workerId || 'authoritative-sync-worker'
      });

      if (!reserved) {
        return {
          processed: false,
          reason: 'idle',
          queuedJobs: await listAuthoritativeSyncJobs(rootPath)
        };
      }

      try {
        const result = await processAuthoritativeSyncJob(rootPath, reserved, options);
        return {
          processed: true,
          failed: false,
          jobId: reserved.jobId,
          result
        };
      } catch (error) {
        await failAuthoritativeSyncJob(rootPath, reserved.jobId, error);
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
          error: error.message
        };
      }
    }, {
      timeoutMs: Number(options.lockTimeoutMs || 350)
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
