import { loadCorpusMeta, loadSourceManifest } from '../../storage/corpus-store.js';
import {
  completeImportTask,
  failImportTask,
  getImportPaths,
  loadImportTask,
  markImportTaskStage,
  reserveNextImportTask
} from '../../storage/import-store.js';
import {
  fastCommitCorpus,
  llmOptimizeCorpus,
  materializeCorpus,
} from '../ingestion/pipeline.js';
import { removePath, withFileLock } from '../../lib/fs.js';
import { loadRegistry } from '../../storage/registry.js';

const DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS = 20_000;

function isLockTimeout(error) {
  return String(error?.message || '').includes('Timed out waiting for file lock');
}

async function resolveTaskInputPath(rootPath, task) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestInputPaths = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  if (!manifestInputPaths.length) {
    if (task?.sourcesDir) {
      return task.sourcesDir;
    }
    throw new Error(`Import task ${task?.id || ''} has no base input paths to rebuild from.`);
  }
  return manifestInputPaths.length === 1 ? manifestInputPaths[0] : manifestInputPaths;
}

async function processImportTask(rootPath, task, options = {}) {
  const corpusMeta = await loadCorpusMeta(rootPath);
  const inputPath = await resolveTaskInputPath(rootPath, task);
  const changedSourceKeys = (task.files || []).map((file) => file.storedPath).filter(Boolean);
  const startStage = (() => {
    switch (task.stage) {
      case 'llm-optimize':
        return 'llm-optimize';
      case 'build-graph':
      case 'merge-graph':
      case 'write-index':
      case 'fast-commit':
        return 'fast-commit';
      case 'materialize':
      case 'queued':
      default:
        return 'materialize';
    }
  })();
  const sharedOptions = {
    ...options,
    rootPath,
    quiet: true,
    name: corpusMeta.name
  };
  const result = {
    ...(task.result || {})
  };

  if (startStage === 'materialize') {
    await markImportTaskStage(rootPath, task.id, 'materialize', 'stage materialize');
    const materialized = await materializeCorpus(inputPath, sharedOptions);
    result.materialized = {
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0,
      timings: materialized?.timings || null
    };
  }

  await markImportTaskStage(rootPath, task.id, 'llm-optimize', 'stage llm-optimize');
  const optimized = await llmOptimizeCorpus(inputPath, sharedOptions);
  result.optimized = {
    reused: Boolean(optimized?.reused)
  };

  await markImportTaskStage(rootPath, task.id, 'fast-commit', 'stage fast-commit');
  const committed = await fastCommitCorpus(inputPath, {
    ...sharedOptions,
    changedSourceKeys,
    mode: 'import'
  });

  result.fastCommitted = {
    reused: Boolean(committed?.reused),
    paperCount: committed?.meta?.paperCount || 0,
    nodeCount: committed?.meta?.nodeCount || 0,
    relationshipCount: committed?.meta?.relationshipCount || 0
  };
  result.authoritativeSync = {
    status: committed?.meta?.authoritativeSyncStatus || 'pending',
    jobId: committed?.syncJob?.jobId || null
  };

  await completeImportTask(rootPath, task.id, result);

  return committed;
}

export async function runImportQueueOnce(rootPath, options = {}, retryState = { clearedTimedOutLock: false }) {
  const { workerLockPath } = getImportPaths(rootPath);
  const lockTimeoutMs = Math.max(250, Number(options.lockTimeoutMs || DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS));

  try {
    return await withFileLock(workerLockPath, async () => {
      const reserved = await reserveNextImportTask(rootPath);
      if (!reserved?.task) {
        return {
          processed: false,
          reason: 'idle'
        };
      }

      try {
        const result = await processImportTask(rootPath, reserved.task, options);
        return {
          processed: true,
          failed: false,
          taskId: reserved.task.id,
          result
        };
      } catch (error) {
        await failImportTask(rootPath, reserved.task.id, error);
        return {
          processed: true,
          failed: true,
          taskId: reserved.task.id,
          error: error.message
        };
      }
    }, {
      timeoutMs: lockTimeoutMs,
      staleMs: lockTimeoutMs
    });
  } catch (error) {
    if (isLockTimeout(error)) {
      if (!retryState.clearedTimedOutLock) {
        await removePath(workerLockPath);
        return runImportQueueOnce(rootPath, options, {
          clearedTimedOutLock: true
        });
      }
      return {
        processed: false,
        reason: 'busy'
      };
    }
    throw error;
  }
}

export async function runImportQueueUntilIdle(rootPath, options = {}) {
  const maxPasses = Math.max(1, Number(options.maxPasses || 24));
  const completedTaskIds = [];
  let failedCount = 0;

  for (let index = 0; index < maxPasses; index += 1) {
    const result = await runImportQueueOnce(rootPath, options);
    if (!result.processed) break;
    if (result.failed) {
      failedCount += 1;
    } else if (result.taskId) {
      completedTaskIds.push(result.taskId);
    }
  }

  return {
    completedTaskIds,
    failedCount
  };
}

export async function runImportsForAllCorporaOnce(options = {}) {
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
      ...(await runImportQueueOnce(corpus.rootPath, options))
    });
  }

  return results;
}

export function startImportWorker(options = {}) {
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
      const results = await runImportsForAllCorporaOnce(options);
      for (const result of results) {
        if (!result.processed) {
          if (result.reason === 'busy') {
            logger.warn?.(`[imports] ${result.corpusName || result.rootPath}: waiting for import worker lock`);
          }
          continue;
        }
        if (result.failed) {
          logger.error?.(`[imports] ${result.corpusName || result.rootPath}: task ${result.taskId} failed (${result.error})`);
        } else {
          logger.log?.(`[imports] ${result.corpusName || result.rootPath}: completed task ${result.taskId}`);
        }
      }
    } catch (error) {
      logger.error?.(`[imports] ${error.message}`);
    } finally {
      running = false;
      schedule();
    }
  };

  void tick();

  return {
    stop() {
      closed = true;
      clearTimeout(timer);
    },
    pollNow() {
      clearTimeout(timer);
      void tick();
    }
  };
}
