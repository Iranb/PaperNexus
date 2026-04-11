import { getCorpusPaths, loadCorpusMeta, loadSourceManifest } from '../../storage/corpus-store.js';
import {
  appendImportTaskLog,
  completeImportTask,
  failImportTask,
  getImportPaths,
  listImportTasks,
  markImportTaskStage,
  quarantineImportTasks,
  recoverFailedImportTasks,
  reserveNextImportTask,
  updateImportTaskProgress
} from '../../storage/import-store.js';
import {
  fastCommitCorpus,
  llmOptimizeCorpus,
  materializeCorpus,
} from '../ingestion/pipeline.js';
import { fileExists, withFileLock } from '../../lib/fs.js';
import { loadRegistry } from '../../storage/registry.js';
import { cacheMarkdownSource, convertPdfToMarkdown } from '../ingestion/pdf-parser.js';

const DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_IMPORT_WORKER_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IMPORT_TASK_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_IMPORT_PENDING_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const DEFAULT_IMPORT_PREPARSE_CONCURRENCY = 4;
const importPreparseInFlight = new Map();

function isLockTimeout(error) {
  return String(error?.message || '').includes('Timed out waiting for file lock');
}

function createImportPreparseKey(rootPath, taskId) {
  return `${rootPath}::${taskId}`;
}

function resolveImportPreparseConcurrency(options = {}) {
  const raw = Number(options.importPreparseConcurrency || options.preparseConcurrency || DEFAULT_IMPORT_PREPARSE_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_PREPARSE_CONCURRENCY;
  }
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

function clampProgressPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function resolveImportTaskTimeoutMs(options = {}) {
  const raw = Number(options.importTaskTimeoutMs || options.taskTimeoutMs || DEFAULT_IMPORT_TASK_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_TASK_TIMEOUT_MS;
  }
  return Math.max(60_000, Math.floor(raw));
}

function resolveImportPendingTimeoutMs(options = {}) {
  const raw = Number(options.importPendingTimeoutMs || options.pendingTimeoutMs || DEFAULT_IMPORT_PENDING_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_IMPORT_PENDING_TIMEOUT_MS;
  }
  return Math.max(60_000, Math.floor(raw));
}

function getImportTaskHeartbeatMs(task = {}) {
  return Date.parse(
    task?.progress?.lastEventAt
    || task?.updatedAt
    || task?.startedAt
    || task?.createdAt
    || 0
  ) || 0;
}

async function recoverTimedOutImportTasks(rootPath, options = {}) {
  const timeoutMs = resolveImportTaskTimeoutMs(options);
  const now = Date.now();
  const { tasks } = await listImportTasks(rootPath);
  const timedOutTasks = tasks.filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status !== 'running') return false;
    const heartbeatMs = getImportTaskHeartbeatMs(task);
    if (!heartbeatMs) return false;
    return (now - heartbeatMs) >= timeoutMs;
  });

  for (const task of timedOutTasks) {
    const heartbeatAgeMs = now - getImportTaskHeartbeatMs(task);
    const stageLabel = String(task?.stage || task?.progress?.stage || 'unknown').trim() || 'unknown';
    await failImportTask(
      rootPath,
      task.id,
      new Error(
        `Import task timed out after ${heartbeatAgeMs}ms without progress while in stage ${stageLabel}. `
        + `Configured timeout=${timeoutMs}ms.`
      )
    );
  }

  return timedOutTasks.map((task) => task.id);
}

function getImportTaskQueueAgeMs(task = {}) {
  return Date.parse(task?.updatedAt || task?.createdAt || 0) || 0;
}

async function quarantineStalePendingImportTasks(rootPath, options = {}) {
  const timeoutMs = resolveImportPendingTimeoutMs(options);
  const now = Date.now();
  const { tasks } = await listImportTasks(rootPath);
  const runningTasks = tasks.filter((task) => String(task?.status || '').trim().toLowerCase() === 'running');
  if (runningTasks.length) {
    return null;
  }

  const stalePendingTasks = tasks.filter((task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    const stage = String(task?.stage || task?.progress?.stage || '').trim().toLowerCase();
    if (status !== 'pending') return false;
    if (stage && stage !== 'queued') return false;
    if (task?.startedAt) return false;
    const ageAnchor = getImportTaskQueueAgeMs(task);
    if (!ageAnchor) return false;
    return (now - ageAnchor) >= timeoutMs;
  });

  if (!stalePendingTasks.length) {
    return null;
  }

  const result = await quarantineImportTasks(
    rootPath,
    stalePendingTasks.map((task) => task.id),
    {
      reason: 'stale-pending-timeout',
      message: `Import task sat in queued/pending state longer than ${timeoutMs}ms with no active import worker progress.`
    }
  );
  return result.count ? result : null;
}

function createTaskProgressReporter(rootPath, taskId, stage) {
  let lastSignature = '';
  let chain = Promise.resolve();
  return {
    async report(event = {}) {
      const signature = JSON.stringify({
        stage,
        stagePercent: clampProgressPercent(event.stagePercent, -1),
        processedUnits: Number(event.processedUnits || 0),
        totalUnits: Number(event.totalUnits || 0),
        currentStep: String(event.currentStep || event.phase || '').trim(),
        message: String(event.message || event.label || '').trim()
      });
      if (signature === lastSignature) {
        return chain;
      }
      lastSignature = signature;
      chain = chain.then(() => updateImportTaskProgress(rootPath, taskId, {
        stage,
        stagePercent: event.stagePercent,
        processedUnits: event.processedUnits,
        totalUnits: event.totalUnits,
        currentStep: event.currentStep || event.phase || '',
        message: event.message || event.label || ''
      })).catch(() => null);
      return chain;
    },
    async flush() {
      await chain;
    }
  };
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  if (!Array.isArray(items) || !items.length) return [];

  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function waitForImportTaskPreparse(rootPath, taskId) {
  const promise = importPreparseInFlight.get(createImportPreparseKey(rootPath, taskId));
  if (promise) {
    await promise;
  }
}

async function preparseImportTaskSources(rootPath, task, options = {}) {
  const { markdownDir, markerDir } = getCorpusPaths(rootPath);
  const files = Array.isArray(task?.files) ? task.files : [];
  let generatedCount = 0;

  for (const file of files) {
    const storedPath = String(file?.storedPath || '').trim();
    const kind = String(file?.kind || '').trim().toLowerCase();
    const originalName = String(file?.originalName || storedPath || 'uploaded file').trim();
    if (!storedPath || (kind !== 'pdf' && kind !== 'markdown')) {
      continue;
    }

    try {
      if (kind === 'pdf') {
        const prepared = await convertPdfToMarkdown(storedPath, {
          rootPath,
          importTaskId: task.id,
          importStage: 'preparse',
          pdfParser: options.pdfParser,
          pdfCommand: options.pdfCommand,
          pythonCommand: options.pythonCommand,
          markitdownPython: options.markitdownPython,
          markitdownUseLlm: options.markitdownUseLlm,
          markitdownEnablePlugins: options.markitdownEnablePlugins,
          markitdownLlmPrompt: options.markitdownLlmPrompt,
          markpdfdownPython: options.markpdfdownPython,
          opendataloaderPdfPython: options.opendataloaderPdfPython,
          doclingPython: options.doclingPython,
          doclingCommand: options.doclingCommand,
          doclingUseVlm: options.doclingUseVlm,
          doclingVlmPreset: options.doclingVlmPreset,
          doclingOcrEngine: options.doclingOcrEngine,
          doclingSshHost: options.doclingSshHost,
          doclingPdfBackend: options.doclingPdfBackend,
          doclingDevice: options.doclingDevice,
          doclingCudaVisibleDevices: options.doclingCudaVisibleDevices,
          doclingAutoGpu: options.doclingAutoGpu,
          doclingGpuLockRoot: options.doclingGpuLockRoot,
          doclingGpuMinFreeMb: options.doclingGpuMinFreeMb,
          doclingGpuWaitTimeoutMs: options.doclingGpuWaitTimeoutMs,
          doclingGpuPollIntervalMs: options.doclingGpuPollIntervalMs,
          doclingGpuLockStaleMs: options.doclingGpuLockStaleMs,
          doclingCpuThreads: options.doclingCpuThreads,
          doclingArtifactsPath: options.doclingArtifactsPath,
          doclingImageExportMode: options.doclingImageExportMode,
          doclingEnrichPictureClasses: options.doclingEnrichPictureClasses,
          doclingEnrichPictureDescription: options.doclingEnrichPictureDescription,
          doclingPreload: options.doclingPreload,
          doclingPreloadTimeoutMs: options.doclingPreloadTimeoutMs,
          pdfParserSshHost: options.pdfParserSshHost,
          markerCommand: options.markerCommand,
          markerSshHost: options.markerSshHost,
          markerBlockBlacklist: options.markerBlockBlacklist,
          markerConcurrency: options.markerConcurrency,
          mineruCommand: options.mineruCommand,
          mineruHttpUrl: options.mineruHttpUrl,
          mineruRemoteFailureMode: options.mineruRemoteFailureMode,
          pageRange: options.pageRange,
          pdfSshHost: options.pdfSshHost,
          pdfParseTimeoutMs: options.pdfParseTimeoutMs,
          llmProvider: options.llmProvider,
          llmModel: options.llmModel,
          llmBaseUrl: options.llmBaseUrl,
          llmApiKey: options.llmApiKey,
          llmApiKeyEnv: options.llmApiKeyEnv,
          llmApiKeySource: options.llmApiKeySource,
          llmApiKeyService: options.llmApiKeyService,
          llmApiKeyAccount: options.llmApiKeyAccount,
          llmMaxTokens: options.llmMaxTokens,
          markerDir,
          markdownDir
        });
        if (prepared?.generated) {
          generatedCount += 1;
          await appendImportTaskLog(rootPath, task.id, {
            level: 'info',
            message: `background preparse prepared PDF markdown cache for ${originalName}`
          });
        }
        continue;
      }

      const prepared = await cacheMarkdownSource(storedPath, {
        markdownDir,
        force: false
      });
      if (prepared?.generated) {
        generatedCount += 1;
        await appendImportTaskLog(rootPath, task.id, {
          level: 'info',
          message: `background preparse cached markdown source for ${originalName}`
        });
      }
    } catch (error) {
      await appendImportTaskLog(rootPath, task.id, {
        level: 'warn',
        message: `background preparse failed for ${originalName}: ${error.message}`
      });
    }
  }

  return {
    taskId: task.id,
    generatedCount
  };
}

async function startQueuedImportPreparse(rootPath, options = {}, currentTaskId = '') {
  const payload = await listImportTasks(rootPath);
  const pendingTasks = (payload.tasks || [])
    .filter((task) => task?.status === 'pending' && task?.id !== currentTaskId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });

  const tasksToStart = [];
  for (const task of pendingTasks) {
    const key = createImportPreparseKey(rootPath, task.id);
    if (importPreparseInFlight.has(key)) continue;
    tasksToStart.push(task);
  }

  await mapWithConcurrency(tasksToStart, resolveImportPreparseConcurrency(options), async (task) => {
    const key = createImportPreparseKey(rootPath, task.id);
    const promise = preparseImportTaskSources(rootPath, task, options)
      .catch(() => null)
      .finally(() => {
        importPreparseInFlight.delete(key);
      });
    importPreparseInFlight.set(key, promise);
    await promise;
  });
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

async function resolveTaskChangedSourceKeys(rootPath, task) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestEntriesByKey = new Map(
    (manifest?.sources || []).map((entry) => [entry.sourceKey, entry])
  );
  const taskFiles = Array.isArray(task?.files) ? task.files : [];
  const changedSourceKeys = [];
  const missingFiles = [];

  for (const file of taskFiles) {
    const storedPath = String(file?.storedPath || '').trim();
    if (!storedPath) continue;
    if (manifestEntriesByKey.has(storedPath)) {
      changedSourceKeys.push(storedPath);
      continue;
    }
    missingFiles.push(file?.originalName || storedPath);
  }

  if (missingFiles.length) {
    throw new Error(
      `Imported files were not materialized into the source manifest: ${missingFiles.join(', ')}. ` +
      'The uploaded source may be missing, unreadable, or failed during parsing.'
    );
  }

  return changedSourceKeys;
}

async function assertImportTaskStoredFilesExist(task) {
  const missingFiles = [];
  for (const file of Array.isArray(task?.files) ? task.files : []) {
    const storedPath = String(file?.storedPath || '').trim();
    if (!storedPath) continue;
    if (!await fileExists(storedPath)) {
      missingFiles.push(file?.originalName || storedPath);
    }
  }
  if (missingFiles.length) {
    throw new Error(
      `Imported files were not materialized into the source manifest: ${missingFiles.join(', ')}. ` +
      'The uploaded source may be missing, unreadable, or failed during parsing.'
    );
  }
}

async function processImportTask(rootPath, task, options = {}) {
  await waitForImportTaskPreparse(rootPath, task.id);
  const corpusMeta = await loadCorpusMeta(rootPath);
  let inputPath = await resolveTaskInputPath(rootPath, task);
  const materializeInputPath = task?.sourcesDir || inputPath;
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
    name: corpusMeta.name,
    importTaskId: task.id
  };
  const result = {
    ...(task.result || {})
  };

  if (startStage === 'materialize') {
    await assertImportTaskStoredFilesExist(task);
    await markImportTaskStage(rootPath, task.id, 'materialize', 'stage materialize');
    const materializeProgress = createTaskProgressReporter(rootPath, task.id, 'materialize');
    const materialized = await materializeCorpus(materializeInputPath, {
      ...sharedOptions,
      mergeWithExistingManifestSources: true,
      includeActiveImportSources: false,
      includePersistentImportSources: false,
      onProgress(event = {}) {
        void materializeProgress.report(event);
      }
    });
    await materializeProgress.report({
      stagePercent: 100,
      currentStep: 'materialization complete',
      message: 'Prepared paper snapshots',
      processedUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0,
      totalUnits: materialized?.meta?.paperCount || materialized?.result?.paperCount || 0
    });
    await materializeProgress.flush();
    result.materialized = {
      reused: Boolean(materialized?.reused),
      paperCount: materialized?.meta?.paperCount || 0,
      timings: materialized?.timings || null
    };
    inputPath = await resolveTaskInputPath(rootPath, task);
  }

  const changedSourceKeys = await resolveTaskChangedSourceKeys(rootPath, task);

  await markImportTaskStage(rootPath, task.id, 'llm-optimize', 'stage llm-optimize');
  const llmProgress = createTaskProgressReporter(rootPath, task.id, 'llm-optimize');
  const optimized = await llmOptimizeCorpus(inputPath, {
    ...sharedOptions,
    changedSourceKeys,
    onProgress(event = {}) {
      void llmProgress.report(event);
    }
  });
  await llmProgress.report({
    stagePercent: 100,
    currentStep: 'llm optimization complete',
    message: 'Completed LLM optimization'
  });
  await llmProgress.flush();
  result.optimized = {
    reused: Boolean(optimized?.reused)
  };

  await markImportTaskStage(rootPath, task.id, 'fast-commit', 'stage fast-commit');
  const fastCommitProgress = createTaskProgressReporter(rootPath, task.id, 'fast-commit');
  const committed = await fastCommitCorpus(inputPath, {
    ...sharedOptions,
    changedSourceKeys,
    mode: 'import',
    onProgress(event = {}) {
      void fastCommitProgress.report(event);
    }
  });
  await fastCommitProgress.report({
    stagePercent: 100,
    currentStep: 'fast commit complete',
    message: 'Applied graph update'
  });
  await fastCommitProgress.flush();

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

export async function runImportQueueOnce(rootPath, options = {}) {
  const { workerLockPath } = getImportPaths(rootPath);
  const lockTimeoutMs = Math.max(250, Number(options.lockTimeoutMs || DEFAULT_IMPORT_WORKER_LOCK_TIMEOUT_MS));
  const lockStaleMs = Math.max(lockTimeoutMs, Number(options.lockStaleMs || DEFAULT_IMPORT_WORKER_LOCK_STALE_MS));

  try {
    return await withFileLock(workerLockPath, async () => {
      const timedOutTaskIds = await recoverTimedOutImportTasks(rootPath, options);
      const failedRecovery = await recoverFailedImportTasks(rootPath, options);
      const quarantineResult = await quarantineStalePendingImportTasks(rootPath, options);
      const reserved = await reserveNextImportTask(rootPath);
      if (!reserved?.task) {
        return {
          processed: false,
          reason: quarantineResult?.count
            ? 'recovered-pending'
            : (failedRecovery.recovered.length || failedRecovery.superseded.length ? 'recovered-failed' : 'idle'),
          timedOutTaskIds,
          recoveredFailedTaskIds: failedRecovery.recovered.map((entry) => entry.taskId),
          supersededFailedTaskIds: failedRecovery.superseded.map((entry) => entry.taskId),
          quarantinedTaskIds: quarantineResult?.tasks?.map((task) => task.taskId) || [],
          quarantineBatchId: quarantineResult?.batchId || null
        };
      }

      try {
        void startQueuedImportPreparse(rootPath, options, reserved.task.id).catch(() => {});
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
          if (result.reason === 'recovered-pending' && result.quarantinedTaskIds?.length) {
            logger.warn?.(
              `[imports] ${result.corpusName || result.rootPath}: quarantined ${result.quarantinedTaskIds.length} stale pending task(s)`
              + (result.quarantineBatchId ? ` batch=${result.quarantineBatchId}` : '')
            );
          }
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
