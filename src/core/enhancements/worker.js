import { parsePaperMarkdown } from '../ingestion/markdown.js';
import { readText, withFileLock } from '../../lib/fs.js';
import { loadRegistry } from '../../storage/registry.js';
import { loadCorpus } from '../../storage/corpus-store.js';
import {
  completeEnhancementJob,
  enqueueEnhancementBackfill,
  failEnhancementJob,
  getEnhancementPaths,
  markEnhancementFailure,
  reserveNextEnhancementJob,
  resolveEnhancementJobPaper,
  savePaperEnhancement,
  summarizeEnhancements
} from '../../storage/enhancement-store.js';
import { buildPaperEnhancementOverlay, summarizePaperEnhancement } from './extract.js';

function isLockTimeout(error) {
  return String(error?.message || '').includes('Timed out waiting for file lock');
}

async function loadParsedPaperForEnhancement(semanticPaper) {
  const sourcePath = semanticPaper.sourceMarkdownPath || semanticPaper.sourcePath;
  if (!sourcePath) {
    throw new Error(`No markdown source available for ${semanticPaper.paperTitle}.`);
  }

  const markdown = await readText(sourcePath);
  return parsePaperMarkdown(markdown, sourcePath);
}

async function processEnhancementJob(rootPath, job, options = {}) {
  const [{ manifestEntry, semanticPaper }, corpus] = await Promise.all([
    resolveEnhancementJobPaper(rootPath, job),
    loadCorpus(rootPath)
  ]);

  if (!manifestEntry) {
    throw new Error(`No manifest entry found for enhancement job ${job.paperId}.`);
  }
  if (!semanticPaper) {
    throw new Error(`No semantic paper snapshot found for ${job.paperTitle}.`);
  }
  if (manifestEntry.fingerprint !== job.sourceFingerprint) {
    throw new Error(`Enhancement job ${job.paperTitle} is stale because the source fingerprint changed.`);
  }

  const parsedPaper = await loadParsedPaperForEnhancement(semanticPaper);
  const overlay = buildPaperEnhancementOverlay({
    semanticPaper,
    parsedPaper,
    graph: corpus.graph,
    corpusMeta: corpus.meta,
    job,
    options
  });

  await savePaperEnhancement(rootPath, overlay);
  await completeEnhancementJob(rootPath, job.id, summarizePaperEnhancement(overlay));

  return {
    paperId: overlay.paperId,
    paperTitle: overlay.paperTitle,
    runId: overlay.runId,
    overlay
  };
}

export async function runEnhancementQueueOnce(rootPath, options = {}) {
  const { workerLockPath } = getEnhancementPaths(rootPath);

  try {
    return await withFileLock(workerLockPath, async () => {
      let reserved = await reserveNextEnhancementJob(rootPath);

      if (!reserved) {
        const backfill = await enqueueEnhancementBackfill(rootPath, {
          limit: options.backfillLimit,
          priority: options.backfillPriority,
          trigger: 'backfill'
        });

        if (backfill.queuedCount) {
          reserved = await reserveNextEnhancementJob(rootPath);
        }

        if (!reserved) {
          return {
            processed: false,
            reason: 'idle',
            summary: await summarizeEnhancements(rootPath)
          };
        }
      }

      try {
        const result = await processEnhancementJob(rootPath, reserved.job, options);
        return {
          processed: true,
          failed: false,
          paperId: result.paperId,
          paperTitle: result.paperTitle,
          summary: await summarizeEnhancements(rootPath)
        };
      } catch (error) {
        await Promise.all([
          failEnhancementJob(rootPath, reserved.job.id, error),
          markEnhancementFailure(rootPath, reserved.job, error)
        ]);
        return {
          processed: true,
          failed: true,
          paperId: reserved.job.paperId,
          paperTitle: reserved.job.paperTitle,
          error: error.message,
          summary: await summarizeEnhancements(rootPath)
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

export async function runEnhancementQueueUntilIdle(rootPath, options = {}) {
  const maxPasses = Math.max(1, Number(options.maxPasses || 24));
  const processedPapers = [];
  let failedCount = 0;
  let lastSummary = null;

  for (let index = 0; index < maxPasses; index += 1) {
    const result = await runEnhancementQueueOnce(rootPath, options);
    if (result.summary) lastSummary = result.summary;
    if (!result.processed) break;
    if (result.paperTitle) processedPapers.push(result.paperTitle);
    if (result.failed) failedCount += 1;
  }

  return {
    processedPapers,
    failedCount,
    summary: lastSummary || await summarizeEnhancements(rootPath)
  };
}

export async function runEnhancementsForAllCorporaOnce(options = {}) {
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
      ...(await runEnhancementQueueOnce(corpus.rootPath, options))
    });
  }

  return results;
}

export function startEnhancementWorker(options = {}) {
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
      const results = await runEnhancementsForAllCorporaOnce(options);
      for (const result of results) {
        if (!result.processed) continue;
        if (result.failed) {
          logger.error?.(`[enhance] ${result.corpusName || result.rootPath}: ${result.paperTitle} failed (${result.error})`);
        } else {
          logger.log?.(`[enhance] ${result.corpusName || result.rootPath}: refreshed ${result.paperTitle}`);
        }
      }
    } catch (error) {
      logger.error?.(`[enhance] ${error.message}`);
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
