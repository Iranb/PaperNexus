import path from 'node:path';
import { resolveServerPathReference } from '../lib/server-paths.js';
import { NODE_TYPES } from '../core/graph/schema.js';
import { loadCorpusLite, loadSourceManifest } from './corpus-store.js';
import { loadRegistry, registerCorpus } from './registry.js';

const DEFAULT_REGISTRY_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MIN_REGISTRY_RECONCILE_INTERVAL_MS = 5000;

function normalizeRootPath(rootPath, options = {}) {
  return resolveServerPathReference(rootPath, {
    baseDir: options.cwd || process.cwd()
  });
}

function isIndexedPaperNode(node) {
  if (node?.type !== NODE_TYPES.PAPER) return false;
  const properties = node.properties || {};
  return Boolean(
    properties.sourcePath
    || properties.sourceMarkdownPath
    || properties.sourcePdfPath
    || properties.sourceFingerprint
    || properties.contentSha256
    || properties.normalizedTextSha256
  );
}

function countGraphPapers(graph) {
  const paperNodes = typeof graph.getNodesByType === 'function'
    ? graph.getNodesByType(NODE_TYPES.PAPER)
    : (graph.nodes || []).filter((node) => node.type === NODE_TYPES.PAPER);
  const indexedPaperNodes = paperNodes.filter(isIndexedPaperNode);
  return {
    graphPaperNodeCount: paperNodes.length,
    graphIndexedPaperNodeCount: indexedPaperNodes.length
  };
}

function countManifestSources(manifest) {
  if (!Array.isArray(manifest?.sources)) {
    return {
      manifestSourceCount: null,
      manifestActiveSourceCount: null
    };
  }
  return {
    manifestSourceCount: manifest.sources.length,
    manifestActiveSourceCount: manifest.sources.filter((entry) => entry?.activeInGraph !== false).length
  };
}

function pickPaperCount({ meta = {}, manifestActiveSourceCount = 0, graphIndexedPaperNodeCount = 0, graphPaperNodeCount = 0 }) {
  if (manifestActiveSourceCount !== null && manifestActiveSourceCount !== undefined) {
    return manifestActiveSourceCount;
  }
  if (graphIndexedPaperNodeCount > 0) {
    return graphIndexedPaperNodeCount;
  }
  const metaPaperCount = Number(meta.paperCount);
  if (Number.isFinite(metaPaperCount) && metaPaperCount >= 0) {
    return metaPaperCount;
  }
  return graphPaperNodeCount;
}

function buildRegistryEntry(rootPath, meta, graph, manifest, checkedAt) {
  const graphCounts = countGraphPapers(graph);
  const { manifestSourceCount, manifestActiveSourceCount } = countManifestSources(manifest);
  return {
    name: meta.name || path.basename(rootPath) || 'paper-corpus',
    rootPath,
    indexedAt: meta.indexedAt || checkedAt,
    paperCount: pickPaperCount({
      meta,
      manifestActiveSourceCount,
      ...graphCounts
    }),
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    sourceCount: manifestSourceCount ?? meta.sourceCount ?? manifestActiveSourceCount ?? 0,
    graphPaperNodeCount: graphCounts.graphPaperNodeCount,
    graphIndexedPaperNodeCount: graphCounts.graphIndexedPaperNodeCount,
    registryReconcileSource: 'graph-lite',
    lastRegistryReconciledAt: checkedAt
  };
}

function findRegistryEntry(registry, entry) {
  return (registry.corpora || []).find((item) => (
    item.name === entry.name
    || item.rootPath === entry.rootPath
  )) || null;
}

function registryEntryNeedsUpdate(current, next) {
  if (!current) return true;
  const fields = [
    'name',
    'rootPath',
    'indexedAt',
    'paperCount',
    'nodeCount',
    'relationshipCount',
    'sourceCount',
    'graphPaperNodeCount',
    'graphIndexedPaperNodeCount',
    'registryReconcileSource'
  ];
  return fields.some((field) => current[field] !== next[field])
    || !current.lastRegistryReconciledAt;
}

export async function reconcileRegistryCorpus(rootPath, options = {}) {
  const resolvedRootPath = normalizeRootPath(rootPath, options);
  const checkedAt = new Date().toISOString();
  const [{ graph, meta }, manifest] = await Promise.all([
    loadCorpusLite(resolvedRootPath),
    loadSourceManifest(resolvedRootPath).catch(() => null)
  ]);
  const computedEntry = buildRegistryEntry(resolvedRootPath, meta, graph, manifest, checkedAt);
  const registry = await loadRegistry();
  const currentEntry = findRegistryEntry(registry, computedEntry);
  const nextEntry = {
    ...(currentEntry || {}),
    ...computedEntry
  };

  if (!registryEntryNeedsUpdate(currentEntry, nextEntry)) {
    return {
      rootPath: resolvedRootPath,
      corpusName: nextEntry.name,
      updated: false,
      entry: currentEntry,
      actual: computedEntry
    };
  }

  await registerCorpus(nextEntry);
  return {
    rootPath: resolvedRootPath,
    corpusName: nextEntry.name,
    updated: true,
    previous: currentEntry,
    entry: nextEntry,
    actual: nextEntry
  };
}

async function resolveRegistryReconcileRoots(options = {}) {
  const configuredRoots = Array.isArray(options.rootPaths)
    ? options.rootPaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (configuredRoots.length) {
    return configuredRoots.map((rootPath) => ({
      rootPath,
      name: rootPath
    }));
  }

  const registry = await loadRegistry();
  return registry.corpora || [];
}

export async function runRegistryReconcileForAllCorporaOnce(options = {}) {
  const roots = await resolveRegistryReconcileRoots(options);
  const results = [];

  for (const corpus of roots) {
    const rootPath = corpus.rootPath || corpus;
    try {
      results.push(await reconcileRegistryCorpus(rootPath, options));
    } catch (error) {
      if (options.continueOnError === false) {
        throw error;
      }
      results.push({
        rootPath,
        corpusName: corpus.name || rootPath,
        updated: false,
        failed: true,
        error: error.message || String(error)
      });
    }
  }

  return results;
}

function resolveRegistryReconcileIntervalMs(options = {}) {
  const parsed = Number(options.intervalMs || options.registryReconcileIntervalMs || DEFAULT_REGISTRY_RECONCILE_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REGISTRY_RECONCILE_INTERVAL_MS;
  }
  return Math.max(MIN_REGISTRY_RECONCILE_INTERVAL_MS, Math.floor(parsed));
}

export function startRegistryReconcileWorker(options = {}) {
  const logger = options.logger || console;
  const intervalMs = resolveRegistryReconcileIntervalMs(options);
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
      const results = await runRegistryReconcileForAllCorporaOnce(options);
      for (const result of results) {
        if (result.failed) {
          logger.warn?.(`[registry-reconcile] ${result.corpusName || result.rootPath}: failed (${result.error})`);
        } else if (result.updated) {
          logger.log?.(
            `[registry-reconcile] ${result.corpusName || result.rootPath}: `
            + `registry count refreshed to ${result.entry.paperCount} papers, `
            + `${result.entry.nodeCount} nodes, ${result.entry.relationshipCount} relationships`
          );
        }
      }
    } catch (error) {
      logger.error?.(`[registry-reconcile] ${error.message || error}`);
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
