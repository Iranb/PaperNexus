import fs from 'node:fs/promises';
import path from 'node:path';
import { getNodeLayer } from '../core/graph/schema.js';
import { applyGraphMutations } from '../core/graph/mutations.js';
import { ensureDir, fileExists, readJson, removePath, withFileLock, writeJson } from '../lib/fs.js';
import { loadKnowledgeGraph } from '../core/graph/graph.js';
import { slugify, stableHash } from '../lib/utils.js';
import { loadRegistry, unregisterCorpus } from './registry.js';
import { saveLiteGraphMaterializedView } from './lite-view.js';
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
  return {
    corpusDir,
    stagedDir,
    llmJobsDir,
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
    onProgress
  });
  onProgress?.({
    phase: 'meta',
    label: 'writing corpus metadata'
  });
  await writeJson(metaPath, meta);
}

function summarizeGraph(graph) {
  const layers = {};
  const layerPaths = {};

  for (const node of graph.nodes) {
    const layer = node.properties?.layer || getNodeLayer(node.type);
    layers[layer] = (layers[layer] || 0) + 1;
  }

  for (const relationship of graph.relationships) {
    const path = relationship.properties?.layerPath || 'unknown';
    layerPaths[path] = (layerPaths[path] || 0) + 1;
  }

  return {
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    layers,
    layerPaths
  };
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
    const absoluteCandidate = path.resolve(candidate);
    const localMeta = getCorpusPaths(absoluteCandidate).metaPath;
    if (await fileExists(localMeta)) {
      return absoluteCandidate;
    }

    const registry = await loadRegistry();
    const matched = registry.corpora.find(
      (item) => item.name === candidate || item.rootPath === candidate
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
