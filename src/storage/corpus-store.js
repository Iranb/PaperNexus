import fs from 'node:fs/promises';
import path from 'node:path';
import { applyGraphMutations } from '../core/graph/mutations.js';
import { summarizeCorpusGraph } from '../core/graph/summary.js';
import { ensureDir, fileExists, readJson, removePath, withFileLock, writeJson } from '../lib/fs.js';
import { collapseHomePath, isServerPathReference, resolveServerPathReference } from '../lib/server-paths.js';
import { loadKnowledgeGraph } from '../core/graph/graph.js';
import { slugify, stableHash } from '../lib/utils.js';
import { loadRegistry, unregisterCorpus } from './registry.js';
import { applyLiteDeltaCommit, saveLiteGraphMaterializedView } from './lite-view.js';
import { enqueueAuthoritativeSyncJob } from './authoritative-sync-store.js';
import {
  hasKuzuGraphStore,
  loadKnowledgeGraphFromKuzu,
  resolveGraphStorageBackend,
  saveKnowledgeGraphToKuzu
} from './kuzu-store.js';

export { resolveGraphStorageMode } from './kuzu-store.js';

export function getCorpusDir(rootPath) {
  return path.join(rootPath, '.papernexus');
}

export function getCorpusBackupDir(rootPath) {
  return path.join(rootPath, '.papernexus-backups');
}

export function getCorpusLockPath(rootPath) {
  return path.join(rootPath, '.papernexus.lock');
}

export function getCorpusPaths(rootPath) {
  const corpusDir = getCorpusDir(rootPath);
  const stagedDir = path.join(corpusDir, 'staged');
  const llmJobsDir = path.join(corpusDir, 'llm-jobs');
  const authoritativeSyncDir = path.join(corpusDir, 'authoritative-sync');
  const authoritativeSyncJobsDir = path.join(authoritativeSyncDir, 'jobs');
  const authoritativeSyncHistoryDir = path.join(authoritativeSyncDir, 'history');
  return {
    corpusDir,
    stagedDir,
    llmJobsDir,
    authoritativeSyncDir,
    authoritativeSyncJobsDir,
    authoritativeSyncHistoryDir,
    graphPath: path.join(corpusDir, 'graph.json'),
    kuzuGraphPath: path.join(corpusDir, 'graph.kuzu'),
    liteGraphPath: path.join(corpusDir, 'graph.lite.json'),
    liteStatePath: path.join(corpusDir, 'graph.lite.state.json'),
    metaPath: path.join(corpusDir, 'meta.json'),
    manifestPath: path.join(corpusDir, 'sources.json'),
    stagedGraphPath: path.join(stagedDir, 'graph.json'),
    stagedMetaPath: path.join(stagedDir, 'meta.json'),
    stagedManifestPath: path.join(stagedDir, 'sources.json'),
    stagedStatePath: path.join(stagedDir, 'state.json'),
    llmStage2StatePath: path.join(llmJobsDir, 'stage2.json'),
    crossPaperJudgmentCachePath: path.join(llmJobsDir, 'cross-paper-judgments.json'),
    identifierResolutionCachePath: path.join(corpusDir, 'identifier-resolution-cache.json'),
    authoritativeSyncQueuePath: path.join(authoritativeSyncDir, 'queue.json'),
    authoritativeSyncLockPath: path.join(authoritativeSyncDir, 'queue.lock'),
    authoritativeSyncWorkerLockPath: path.join(authoritativeSyncDir, 'worker.lock'),
    papersDir: path.join(corpusDir, 'papers'),
    markdownDir: path.join(corpusDir, 'markdown'),
    markerDir: path.join(corpusDir, 'marker')
  };
}

export function getSemanticPaperSnapshotPath(rootPath, sourceKey) {
  const { papersDir } = getCorpusPaths(rootPath);
  return path.join(papersDir, `${stableHash(sourceKey, 20)}.json`);
}

async function hasJsonGraphStore(graphPath) {
  return fileExists(graphPath);
}

async function loadAuthoritativeGraph(paths) {
  if (await hasKuzuGraphStore(paths.kuzuGraphPath)) {
    try {
      return await loadKnowledgeGraphFromKuzu(paths.kuzuGraphPath);
    } catch (error) {
      const graphData = await readJson(paths.graphPath, null);
      if (graphData) {
        return loadKnowledgeGraph(graphData);
      }
      throw error;
    }
  }

  const graphData = await readJson(paths.graphPath, null);
  return graphData ? loadKnowledgeGraph(graphData) : null;
}

export async function hasCorpusGraphStore(rootPath) {
  const paths = getCorpusPaths(rootPath);
  return (await hasKuzuGraphStore(paths.kuzuGraphPath)) || (await hasJsonGraphStore(paths.graphPath));
}

export async function saveCorpus(rootPath, graph, meta, options = {}) {
  const { graphPath, kuzuGraphPath, liteGraphPath, liteStatePath, metaPath } = getCorpusPaths(rootPath);
  const backend = await resolveGraphStorageBackend();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  if (backend === 'kuzu') {
    onProgress?.({
      phase: 'authoritative-graph',
      label: 'writing authoritative graph to Kuzu'
    });
    await saveKnowledgeGraphToKuzu(kuzuGraphPath, graph, {
      onProgress
    });
    await removePath(graphPath);
  } else {
    onProgress?.({
      phase: 'authoritative-graph',
      label: 'writing authoritative graph JSON'
    });
    await writeJson(graphPath, graph.toJSON());
    await removePath(kuzuGraphPath);
    await removePath(`${kuzuGraphPath}.wal`);
  }

  onProgress?.({
    phase: 'lite-view',
    label: 'building lite graph materialized view'
  });
  await saveLiteGraphMaterializedView(rootPath, graph, {
    liteGraphPath,
    liteStatePath,
    currentSources: options.liteViewSources || null,
    incremental: options.liteViewMode === 'incremental',
    derived: {
      domainDistanceMatrix: meta.domainDistanceMatrix || null
    },
    onProgress
  });
  onProgress?.({
    phase: 'meta',
    label: 'writing corpus metadata'
  });
  await writeJson(metaPath, meta);
}

export async function saveCorpusFastLocalDelta(rootPath, deltaPayload, meta, manifest, options = {}) {
  const {
    liteGraphPath,
    liteStatePath,
    manifestPath,
    metaPath
  } = getCorpusPaths(rootPath);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const now = new Date().toISOString();
  const targetManifestToken = options.targetManifestToken || null;

  return withFileLock(getCorpusLockPath(rootPath), async () => {
    const [currentMeta, currentManifest] = await Promise.all([
      readJson(metaPath, null),
      readJson(manifestPath, null)
    ]);

    if (targetManifestToken && currentMeta?.lastFastCommitManifestToken === targetManifestToken) {
      const syncJob = currentMeta.authoritativeSyncStatus === 'synced'
        ? {
            jobId: currentMeta.lastFastCommitJobId || currentMeta.lastAuthoritativeSyncJobId || null
          }
        : await enqueueAuthoritativeSyncJob(rootPath, {
            baseManifestToken: options.baseManifestToken || null,
            targetManifestToken,
            changedSourceKeys: deltaPayload.changedSourceKeys || [],
            deltaPayload,
            mode: options.mode || 'delta',
            dependsOnFastCommitJobId: options.dependsOnFastCommitJobId || null
          });

      return {
        rootPath,
        meta: currentMeta,
        manifest: currentManifest || manifest,
        deltaPayload,
        syncJob,
        reused: true
      };
    }

    onProgress?.({
      phase: 'lite-delta',
      label: 'applying fast local delta commit'
    });
    await applyLiteDeltaCommit(rootPath, deltaPayload, {
      liteGraphPath,
      liteStatePath,
      derived: {
        domainDistanceMatrix: meta.domainDistanceMatrix || null
      },
      onProgress
    });

    onProgress?.({
      phase: 'manifest',
      label: 'writing fast-commit source manifest'
    });
    await saveSourceManifest(rootPath, manifest);

    const checkpointMeta = {
      ...meta,
      authoritativeSyncStatus: 'pending',
      authoritativeSyncQueuedAt: now,
      lastFastCommitManifestToken: targetManifestToken,
      lastFastCommitJobId: currentMeta?.lastFastCommitJobId || null
    };

    onProgress?.({
      phase: 'meta',
      label: 'writing fast-commit checkpoint metadata'
    });
    await writeJson(metaPath, checkpointMeta);

    const job = await enqueueAuthoritativeSyncJob(rootPath, {
      baseManifestToken: options.baseManifestToken || null,
      targetManifestToken,
      changedSourceKeys: deltaPayload.changedSourceKeys || [],
      deltaPayload,
      mode: options.mode || 'delta',
      dependsOnFastCommitJobId: options.dependsOnFastCommitJobId || null
    });

    const nextMeta = {
      ...checkpointMeta,
      lastFastCommitJobId: job.jobId
    };

    onProgress?.({
      phase: 'meta',
      label: 'writing fast-commit corpus metadata'
    });
    await writeJson(metaPath, nextMeta);

    return {
      rootPath,
      meta: nextMeta,
      manifest,
      deltaPayload,
      syncJob: job,
      reused: false
    };
  }, options.lockOptions);
}

function summarizeGraph(graph) {
  return summarizeCorpusGraph(graph);
}

export async function loadCorpus(rootPath) {
  const paths = getCorpusPaths(rootPath);
  const meta = await readJson(paths.metaPath, null);

  if (!meta) {
    throw new Error(`No PaperNexus index found in ${rootPath}. Run \`papernexus analyze ${rootPath}\` first.`);
  }

  const graph = await loadAuthoritativeGraph(paths);

  if (!graph) {
    throw new Error(`No PaperNexus index found in ${rootPath}. Run \`papernexus analyze ${rootPath}\` first.`);
  }

  return {
    rootPath,
    graph,
    meta
  };
}

export async function loadCorpusLite(rootPath) {
  const paths = getCorpusPaths(rootPath);
  const [graphData, meta] = await Promise.all([
    readJson(paths.liteGraphPath, null),
    readJson(paths.metaPath, null)
  ]);

  if (!meta) {
    throw new Error(`No PaperNexus index found in ${rootPath}. Run \`papernexus analyze ${rootPath}\` first.`);
  }

  if (graphData) {
    return {
      rootPath,
      graph: loadKnowledgeGraph(graphData),
      meta
    };
  }

  const fallbackGraph = await loadAuthoritativeGraph(paths);
  if (!fallbackGraph) {
    throw new Error(`No PaperNexus index found in ${rootPath}. Run \`papernexus analyze ${rootPath}\` first.`);
  }

  return {
    rootPath,
    graph: fallbackGraph,
    meta
  };
}

export async function loadCorpusMeta(rootPath) {
  const { metaPath } = getCorpusPaths(rootPath);
  const meta = await readJson(metaPath, null);

  if (!meta) {
    throw new Error(`No PaperNexus index found in ${rootPath}. Run \`papernexus analyze ${rootPath}\` first.`);
  }

  return meta;
}

export async function applyCorpusMutations(rootPath, operations, options = {}) {
  const applyMutations = async () => {
    const { graph, meta } = await loadCorpus(rootPath);
    const mutationResult = applyGraphMutations(graph, operations, options);

    const nextMeta = {
      ...meta,
      indexedAt: new Date().toISOString(),
      ...summarizeGraph(mutationResult.graph),
      lastMutationAt: new Date().toISOString(),
      lastMutationSummary: mutationResult.summary
    };

    if (!options.dryRun) {
      await saveCorpus(rootPath, mutationResult.graph, nextMeta, {
        liteViewMode: 'rebuild'
      });
    }

    return {
      rootPath,
      graph: mutationResult.graph,
      meta: nextMeta,
      mutationResult
    };
  };

  if (options.dryRun) {
    return applyMutations();
  }

  return withFileLock(getCorpusLockPath(rootPath), applyMutations, options.lockOptions);
}

export async function loadSourceManifest(rootPath) {
  const { manifestPath } = getCorpusPaths(rootPath);
  return (await readJson(manifestPath, null)) || null;
}

export async function saveSourceManifest(rootPath, manifest) {
  const { manifestPath } = getCorpusPaths(rootPath);
  await writeJson(manifestPath, manifest);
}

export async function saveStagedCorpusBuild(rootPath, graph, meta, manifest, state = {}) {
  const {
    stagedDir,
    stagedGraphPath,
    stagedMetaPath,
    stagedManifestPath,
    stagedStatePath
  } = getCorpusPaths(rootPath);

  await ensureDir(stagedDir);
  await writeJson(stagedGraphPath, graph.toJSON());
  await writeJson(stagedMetaPath, meta);
  await writeJson(stagedManifestPath, manifest);
  await writeJson(stagedStatePath, state);
}

export async function loadStagedCorpusBuild(rootPath) {
  const {
    stagedGraphPath,
    stagedMetaPath,
    stagedManifestPath,
    stagedStatePath
  } = getCorpusPaths(rootPath);

  const [graphData, meta, manifest, state] = await Promise.all([
    readJson(stagedGraphPath, null),
    readJson(stagedMetaPath, null),
    readJson(stagedManifestPath, null),
    readJson(stagedStatePath, null)
  ]);

  if (!graphData || !meta || !manifest || !state) {
    return null;
  }

  return {
    rootPath,
    graph: loadKnowledgeGraph(graphData),
    meta,
    manifest,
    state
  };
}

export async function removeStagedCorpusBuild(rootPath) {
  const { stagedDir } = getCorpusPaths(rootPath);
  await removePath(stagedDir);
}

export async function loadStage2JobState(rootPath) {
  const { llmStage2StatePath } = getCorpusPaths(rootPath);
  return readJson(llmStage2StatePath, null);
}

export async function saveStage2JobState(rootPath, state) {
  const { llmJobsDir, llmStage2StatePath } = getCorpusPaths(rootPath);
  await ensureDir(llmJobsDir);
  await writeJson(llmStage2StatePath, state);
}

export async function removeStage2JobState(rootPath) {
  const { llmStage2StatePath } = getCorpusPaths(rootPath);
  await removePath(llmStage2StatePath);
}

export async function loadCrossPaperJudgmentCache(rootPath) {
  const { crossPaperJudgmentCachePath } = getCorpusPaths(rootPath);
  const data = await readJson(crossPaperJudgmentCachePath, null);
  if (!data || typeof data !== 'object') {
    return new Map();
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  const cache = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const [key, value] = entry;
    if (typeof key !== 'string' || !value || typeof value !== 'object') {
      continue;
    }
    cache.set(key, value);
  }
  return cache;
}

export async function saveCrossPaperJudgmentCache(rootPath, cache) {
  const { llmJobsDir, crossPaperJudgmentCachePath } = getCorpusPaths(rootPath);
  await ensureDir(llmJobsDir);
  const entries = cache instanceof Map ? Array.from(cache.entries()) : [];
  await writeJson(crossPaperJudgmentCachePath, {
    version: 1,
    entries
  });
}

export async function loadSemanticPaperSnapshot(rootPath, sourceKey) {
  return readJson(getSemanticPaperSnapshotPath(rootPath, sourceKey), null);
}

export async function saveSemanticPaperSnapshot(rootPath, sourceKey, snapshot) {
  await writeJson(getSemanticPaperSnapshotPath(rootPath, sourceKey), snapshot);
}

export async function removeSemanticPaperSnapshot(rootPath, sourceKey) {
  await removePath(getSemanticPaperSnapshotPath(rootPath, sourceKey));
}

export async function resolveCorpus(candidate, cwd = process.cwd()) {
  if (candidate) {
    const rawCandidate = String(candidate).trim();
    const absoluteCandidate = isServerPathReference(rawCandidate)
      ? resolveServerPathReference(rawCandidate, { baseDir: cwd })
      : path.resolve(cwd, rawCandidate);
    const localMeta = getCorpusPaths(absoluteCandidate).metaPath;
    if (await fileExists(localMeta)) {
      return absoluteCandidate;
    }

    const registry = await loadRegistry();
    const matched = registry.corpora.find(
      (item) => item.name === candidate
        || item.rootPath === candidate
        || item.rootPath === absoluteCandidate
        || collapseHomePath(item.rootPath) === rawCandidate
    );
    if (matched) return matched.rootPath;

    throw new Error(`Could not resolve corpus "${candidate}".`);
  }

  const cwdMeta = getCorpusPaths(cwd).metaPath;
  if (await fileExists(cwdMeta)) {
    return cwd;
  }

  const registry = await loadRegistry();
  if (registry.corpora.length === 1) {
    return registry.corpora[0].rootPath;
  }

  if (!registry.corpora.length) {
    throw new Error('No indexed corpora found. Run `papernexus analyze <path>` first.');
  }

  throw new Error('Multiple corpora are indexed. Pass `--corpus <name>`.');
}

export async function cleanCorpus(target, cwd = process.cwd()) {
  const rootPath = await resolveCorpus(target, cwd);
  const { corpusDir } = getCorpusPaths(rootPath);
  await withFileLock(getCorpusLockPath(rootPath), async () => {
    await removePath(corpusDir);
    await unregisterCorpus(rootPath);
  });
  return rootPath;
}

function createBackupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function backupCorpus(target, options = {}) {
  const rootPath = await resolveCorpus(target);
  return backupExistingCorpusRoot(rootPath, options);
}

export async function backupExistingCorpusRoot(rootPath, options = {}) {
  const { corpusDir, metaPath } = getCorpusPaths(rootPath);
  const hasIndexedCorpus = (await fileExists(metaPath)) && (await hasCorpusGraphStore(rootPath));
  if (!hasIndexedCorpus) {
    return null;
  }

  const meta = await loadCorpusMeta(rootPath);
  const backupRoot = path.resolve(options.backupDir || getCorpusBackupDir(rootPath));
  const backupLabel = `${slugify(meta.name || path.basename(rootPath))}-${createBackupStamp()}`;
  const backupPath = path.join(backupRoot, backupLabel);
  const backupCorpusDir = path.join(backupPath, '.papernexus');

  await ensureDir(backupRoot);
  await fs.cp(corpusDir, backupCorpusDir, {
    recursive: true,
    errorOnExist: true
  });

  const manifest = {
    corpusName: meta.name,
    sourceRoot: rootPath,
    backupPath,
    backupCorpusDir,
    createdAt: new Date().toISOString(),
    paperCount: meta.paperCount,
    nodeCount: meta.nodeCount,
    relationshipCount: meta.relationshipCount
  };
  await writeJson(path.join(backupPath, 'backup.json'), manifest);

  return manifest;
}
