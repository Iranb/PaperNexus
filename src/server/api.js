import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyCorpusMutations,
  backupCorpus,
  hasCorpusGraphStore,
  loadCorpus,
  loadCorpusLite,
  loadCorpusMeta,
  loadSourceManifest,
  resolveCorpus
} from '../storage/corpus-store.js';
import { resolveLlmConfig, getDefaultLlmApiKeyEnv, getDefaultLlmBaseUrl } from '../core/llm/ollama.js';
import { getNodeLayer, NODE_TYPES } from '../core/graph/schema.js';
import { normalizeStorageIndexDirs, resolvePathWithHome, saveRuntimeConfig } from '../lib/config.js';
import { collapseHomePath, isServerPathReference, resolveServerPathReference } from '../lib/server-paths.js';
import { buildDefaultLlmKeychainAccount } from '../lib/keychain.js';
import { stableHash, unique } from '../lib/utils.js';
import {
  createPaperIdentifierKeys,
  createPaperIdentity,
  createSourceIdentity,
  flattenPaperIdentifiers,
  formatRequiredPaperIdentifierMessage,
  hasAnyPaperIdentifiers,
  normalizeExactPaperTitle,
  normalizePaperIdentifierQuery,
  normalizePaperIdentifiers
} from '../lib/paper-identifiers.js';
import { getCorpusPaths } from '../storage/corpus-store.js';
import { getRegistryPath, loadRegistry } from '../storage/registry.js';
import { getEnhancementPaths, getPaperEnhancementPath, loadPaperEnhancement, summarizeEnhancements } from '../storage/enhancement-store.js';
import {
  createImportTask,
  listImportTasks,
  loadImportTask,
  loadImportTaskLog,
  tailImportTaskEvents
} from '../storage/import-store.js';
import { listAuthoritativeSyncJobs } from '../storage/authoritative-sync-store.js';
import { fileExists } from '../lib/fs.js';
import {
  searchGraph,
  buildContext,
  buildImpact,
  buildResearchIdeas,
  buildBrainstorm
} from '../core/search/search.js';
import { buildCatalystQuery } from '../core/graph/catalyst-adapter.js';
import { buildIdeaCatalystInnovationArtifacts } from '../core/graph/innovation-contracts.js';
import { buildInnovationArtifactGraphMutations } from '../core/graph/innovation-writeback.js';
import {
  buildMethodEvolutionEvidenceLookup,
  buildMethodEvolutionGapAnalysis
} from '../core/graph/research-intelligence.js';
import { loadRunReport } from '../storage/run-store.js';

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sortObjectEntries(object) {
  return Object.fromEntries(
    Object.entries(object).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function getApiNodeLayer(node) {
  return node.properties?.layer || getNodeLayer(node.type);
}

const MAX_API_RESULT_LIMIT = 50;
const MAX_API_CANDIDATE_LIMIT = 20;
const MAX_API_PAPER_LIMIT = 25;
const MAX_API_IMPACT_DEPTH = 8;
const MAX_API_BRAINSTORM_HOPS = 4;
const MAX_API_PATH_DEPTH = 6;
const MAX_API_PATHS = 25;
const MAX_API_CATALYST_DOMAINS = 12;
const MAX_API_CATALYST_THRESHOLD = 25;
const IDEA_CATALYST_V2_HTTP_CONTRACT_VERSION = 'papernexus-idea-catalyst-v2-http-v1';
const NOVELTY_EVAL_HTTP_CONTRACT_VERSION = 'papernexus-novelty-eval-http-v1';
const STORYLINE_HTTP_CONTRACT_VERSION = 'papernexus-storyline-http-v1';
const REVIEWER_SIMULATION_HTTP_CONTRACT_VERSION = 'papernexus-reviewer-simulation-http-v1';
const EVAL_RUN_HTTP_CONTRACT_VERSION = 'papernexus-eval-run-http-v1';

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.floor(number);
  if (integer < min) return fallback;
  return Math.min(integer, max);
}

function firstConfiguredValue(...values) {
  return values.find((value) => (
    value !== undefined
    && value !== null
    && (typeof value !== 'string' || value.trim() !== '')
  ));
}

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function disabledFlag(value) {
  if (value === false) return true;
  if (value === true || value === undefined || value === null) return false;
  return ['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

const PORTABLE_PATH_FIELD_NAMES = new Set([
  'rootPath',
  'root_path',
  'inputPath',
  'input_path',
  'sourceKey',
  'source_key',
  'sourcePath',
  'source_path',
  'sourceMarkdownPath',
  'source_markdown_path',
  'sourcePdfPath',
  'source_pdf_path',
  'markdownCachePath',
  'markdown_cache_path',
  'storedPath',
  'stored_path',
  'sourcesDir',
  'sources_dir',
  'remoteFile',
  'remote_file',
  'serverFilePath',
  'server_file_path'
]);

const PORTABLE_PATH_LIST_FIELD_NAMES = new Set([
  'inputPaths',
  'changedSourceKeys'
]);

function shouldPresentPortablePaths(options = {}) {
  return options?.portablePaths === true;
}

function presentPortablePath(value, options = {}) {
  if (!shouldPresentPortablePaths(options)) return value;
  return collapseHomePath(String(value || '').trim());
}

function presentPortablePayload(value, options = {}, fieldName = '') {
  if (!shouldPresentPortablePaths(options)) {
    return value;
  }

  if (Array.isArray(value)) {
    if (PORTABLE_PATH_LIST_FIELD_NAMES.has(fieldName)) {
      return value.map((item) => presentPortablePath(item, options));
    }
    return value.map((item) => presentPortablePayload(item, options, fieldName));
  }

  if (!value || typeof value !== 'object') {
    if (PORTABLE_PATH_FIELD_NAMES.has(fieldName) && typeof value === 'string') {
      return presentPortablePath(value, options);
    }
    return value;
  }

  const output = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (PORTABLE_PATH_FIELD_NAMES.has(key) && typeof entryValue === 'string') {
      output[key] = presentPortablePath(entryValue, options);
      continue;
    }
    if (PORTABLE_PATH_LIST_FIELD_NAMES.has(key) && Array.isArray(entryValue)) {
      output[key] = entryValue.map((item) => presentPortablePath(item, options));
      continue;
    }
    output[key] = presentPortablePayload(entryValue, options, key);
  }
  return output;
}

export function createApiCache() {
  return {
    corporaByPath: new Map(),
    corpusByRoot: new Map(),
    corpusLiteByRoot: new Map(),
    corpusMetaByRoot: new Map(),
    enhancementSummaryByRoot: new Map(),
    enhancementPaperByKey: new Map()
  };
}

async function validateConfiguredRootPath(rootPath) {
  const { metaPath } = getCorpusPaths(rootPath);
  if (!(await fileExists(metaPath))) {
    return 'missing_meta';
  }
  if (!(await hasCorpusGraphStore(rootPath))) {
    return 'missing_graph_store';
  }
  return '';
}

function normalizeExplicitWorkerRootPaths(options = {}) {
  const rawRootPaths = Array.isArray(options.rootPaths)
    ? options.rootPaths
    : [];
  const baseDir = options.configBaseDir || process.cwd();
  const seen = new Set();
  const rootPaths = [];
  for (const entry of rawRootPaths) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    const resolved = resolvePathWithHome(raw, baseDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    rootPaths.push(resolved);
  }
  return rootPaths;
}

export async function getConfiguredRootPaths(options = {}) {
  const explicitRootPaths = normalizeExplicitWorkerRootPaths(options);
  if (explicitRootPaths.length) {
    return {
      rootPaths: explicitRootPaths,
      defaultRootPath: explicitRootPaths[0],
      invalidRootPaths: [],
      source: Array.isArray(options.rootPaths) ? 'options.rootPaths' : 'options.workerRootPaths',
      configured: true
    };
  }

  const normalized = normalizeStorageIndexDirs(options.config || {}, {
    baseDir: options.configBaseDir || process.cwd()
  });
  const rootPaths = [];
  const invalidRootPaths = [];

  for (const entry of normalized.entries) {
    const reason = await validateConfiguredRootPath(entry.resolved);
    if (reason) {
      invalidRootPaths.push({
        input: entry.input,
        resolved: entry.resolved,
        reason
      });
      continue;
    }
    rootPaths.push(entry.resolved);
  }

  const explicitDefaultRootPath = normalized.explicitDefaultRootPath && rootPaths.includes(normalized.explicitDefaultRootPath)
    ? normalized.explicitDefaultRootPath
    : null;
  const defaultRootPath = explicitDefaultRootPath || (rootPaths.length === 1 ? rootPaths[0] : null);

  return {
    rootPaths,
    defaultRootPath,
    explicitDefaultRootPath,
    defaultExplicit: Boolean(explicitDefaultRootPath),
    invalidRootPaths,
    source: normalized.source,
    configured: normalized.configured
  };
}

export async function getConfiguredRootPath(options = {}) {
  const configured = await getConfiguredRootPaths(options);
  return configured.defaultRootPath || null;
}

async function loadConfiguredCorpusEntries(options = {}) {
  const configured = await getConfiguredRootPaths(options);
  if (!configured.rootPaths.length) return [];

  const entries = [];
  for (const rootPath of configured.rootPaths) {
    try {
      const meta = await loadCorpusMeta(rootPath);
      entries.push({
        name: meta.name,
        rootPath,
        indexedAt: meta.indexedAt,
        paperCount: meta.paperCount,
        configured: true,
        default: rootPath === configured.defaultRootPath
      });
    } catch {
      // A root may become unreadable after validation; leave it out of list responses.
    }
  }
  return entries;
}

async function readPathStamp(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

async function resolveCachedPayload(cacheMap, key, stamp, loader) {
  const existing = cacheMap.get(key);
  if (existing?.stamp === stamp) {
    if (existing.promise) {
      return existing.promise;
    }
    if (existing.value) {
      return existing.value;
    }
  }

  const promise = (async () => {
    const value = await loader();
    cacheMap.set(key, {
      stamp,
      value,
      promise: null
    });
    return value;
  })().catch((error) => {
    const current = cacheMap.get(key);
    if (current?.promise === promise) {
      cacheMap.delete(key);
    }
    throw error;
  });

  cacheMap.set(key, {
    stamp,
    value: existing?.stamp === stamp ? existing.value : null,
    promise
  });
  return promise;
}

export async function listCorporaPayload(options = {}) {
  const configuredCorpora = await loadConfiguredCorpusEntries(options);
  if (configuredCorpora.length) {
    return presentPortablePayload({
      corpora: configuredCorpora,
      generatedAt: new Date().toISOString()
    }, options);
  }

  const registryPath = getRegistryPath();
  const cache = options.cache;
  const stamp = await readPathStamp(registryPath);

  if (!cache?.corporaByPath) {
    const registry = await loadRegistry();
    return presentPortablePayload({
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    }, options);
  }

  return resolveCachedPayload(cache.corporaByPath, registryPath, stamp, async () => {
    const registry = await loadRegistry();
    return presentPortablePayload({
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    }, options);
  });
}

export async function resolveCorpusForApi(candidate, options = {}) {
  const configured = await getConfiguredRootPaths(options);
  if (configured.rootPaths.length) {
    try {
      for (const configuredRoot of configured.rootPaths) {
        const configuredMeta = await loadCorpusMeta(configuredRoot);
        if (
          candidate === configuredRoot
          || candidate === configuredMeta.name
        ) {
          return configuredRoot;
        }
      }
    } catch {
      // Fall through to legacy resolution paths when configured metadata is unavailable.
    }

    if (!candidate) {
      if (configured.rootPaths.length === 1 || configured.defaultRootPath) {
        return configured.defaultRootPath || configured.rootPaths[0];
      }
      throw new Error(
        'Multiple configured storage index roots are available. Pass corpus/rootPath explicitly '
        + 'or set storage.defaultIndexDir before using graph read/write APIs without a corpus.'
      );
    }
  }

  if (candidate) {
    return resolveCorpus(candidate);
  }

  const registry = await loadRegistry();
  if (!registry.corpora.length) {
    throw new Error(
      'No indexed corpora found. Analyze or import an already-provided paper/corpus first; '
      + 'PaperNexus does not discover external literature for you.'
    );
  }

  return registry.corpora[0].rootPath;
}

export async function configuredWorkerCoveragePayload(rootPath, options = {}) {
  const explicitWorkerRootPaths = normalizeExplicitWorkerRootPaths({
    ...options,
    rootPaths: Array.isArray(options.workerRootPaths) ? options.workerRootPaths : options.rootPaths
  });
  const configured = explicitWorkerRootPaths.length
    ? {
        rootPaths: explicitWorkerRootPaths,
        invalidRootPaths: [],
        source: Array.isArray(options.workerRootPaths) ? 'options.workerRootPaths' : 'options.rootPaths'
      }
    : await getConfiguredRootPaths(options);
  const normalizedRootPath = resolvePathWithHome(rootPath, options.configBaseDir || process.cwd());
  const covered = configured.rootPaths.length
    ? configured.rootPaths.includes(normalizedRootPath)
    : true;
  const invalidRootPaths = (configured.invalidRootPaths || []).map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    reason: entry.reason
  }));

  return {
    covered,
    coveredRootPath: covered ? normalizedRootPath : null,
    configuredRootCount: configured.rootPaths.length,
    source: configured.rootPaths.length ? configured.source : 'registry_fallback',
    blockedReason: covered ? null : 'root_not_configured',
    invalidRootPaths
  };
}

export async function corpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const stamp = await readPathStamp(getCorpusPaths(rootPath).metaPath);

  if (!cache?.corpusByRoot) {
    const { meta, graph } = await loadCorpus(rootPath);
    return presentPortablePayload({
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    }, options);
  }

  return resolveCachedPayload(cache.corpusByRoot, rootPath, stamp, async () => {
    const { meta, graph } = await loadCorpus(rootPath);
    return presentPortablePayload({
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    }, options);
  });
}

export async function loadCorpusLiteForApi(rootPath, options = {}) {
  const cache = options.cache;
  const paths = getCorpusPaths(rootPath);
  const stamp = `${await readPathStamp(paths.metaPath)}|${await readPathStamp(paths.liteGraphPath)}|${await readPathStamp(paths.graphPath)}|${await readPathStamp(paths.kuzuGraphPath)}`;

  if (!cache?.corpusLiteByRoot) {
    return loadCorpusLite(rootPath);
  }

  return resolveCachedPayload(cache.corpusLiteByRoot, rootPath, stamp, async () => loadCorpusLite(rootPath));
}

function normalizeGraphRequestBody(body = {}) {
  const query = String(body?.query || '').trim();
  if (!query) {
    throw new Error('query is required.');
  }

  const rawOptions = body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? body.options
    : {};

  return {
    candidate: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
    query,
    options: rawOptions
  };
}

function normalizePaperIndexSource(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isServerPathReference(raw)) {
    return path.resolve(resolveServerPathReference(raw));
  }
  return path.resolve(raw);
}

function normalizePaperIndexRequest(body = {}) {
  const paperId = String(body?.paperId || '').trim();
  const canonicalId = String(body?.canonicalId || body?.canonical_id || '').trim();
  const sourceId = String(body?.sourceId || body?.source_id || '').trim();
  const sourceKey = String(body?.sourceKey || '').trim();
  const source = normalizePaperIndexSource(body?.source || body?.inputPath || '');
  const paperTitle = normalizeExactPaperTitle(body?.paperTitle || body?.title || '');
  const identifiers = normalizePaperIdentifierQuery(body?.identifiers ? { ...body, ...body.identifiers } : body);

  if (!paperId && !canonicalId && !sourceId && !sourceKey && !source && !paperTitle && !Object.keys(identifiers).length) {
    throw new Error('Pass at least one exact paper selector: paperId, canonicalId, sourceId, sourceKey, source, paperTitle/title, DOI, arXiv ID, PMID, PMCID, ISBN, or ISSN.');
  }

  return {
    paperId,
    canonicalId,
    sourceId,
    sourceKey,
    source,
    paperTitle,
    identifiers
  };
}

function manifestEntryMatchesPaperIndex(entry = {}, request = {}) {
  if (request.paperId && String(entry.paperId || '').trim() !== request.paperId) {
    return false;
  }

  if (request.canonicalId && String(entry.canonicalId || '').trim() !== request.canonicalId) {
    return false;
  }

  if (request.sourceId && String(entry.sourceId || '').trim() !== request.sourceId) {
    return false;
  }

  if (request.sourceKey && String(entry.sourceKey || '').trim() !== request.sourceKey) {
    return false;
  }

  if (request.paperTitle && normalizeExactPaperTitle(entry.paperTitle || '') !== request.paperTitle) {
    return false;
  }

  if (request.source) {
    const candidatePaths = [
      entry.inputPath,
      entry.sourcePath,
      entry.sourceMarkdownPath,
      entry.sourcePdfPath,
      entry.markdownCachePath
    ]
      .filter(Boolean)
      .map((value) => normalizePaperIndexSource(value));
    if (!candidatePaths.includes(request.source)) {
      return false;
    }
  }

  const entryIdentifiers = normalizePaperIdentifiers(entry.identifiers || entry.paperMetadata || {});
  for (const [field, value] of Object.entries(request.identifiers || {})) {
    if (!value) continue;
    if (entryIdentifiers[field] !== value) {
      return false;
    }
  }

  return true;
}

function buildPaperIndexMatchedBy(request = {}) {
  const matchedBy = [];
  if (request.paperId) matchedBy.push('paperId');
  if (request.canonicalId) matchedBy.push('canonicalId');
  if (request.sourceId) matchedBy.push('sourceId');
  if (request.sourceKey) matchedBy.push('sourceKey');
  if (request.source) matchedBy.push('source');
  if (request.paperTitle) matchedBy.push('paperTitle');
  for (const field of Object.keys(request.identifiers || {})) {
    matchedBy.push(field);
  }
  return matchedBy;
}

function summarizePaperIndexNode(node = null) {
  if (!node) return null;
  const paperIdentity = createPaperIdentity(node.properties || {});
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    properties: {
      paperId: node.properties?.paperId || node.id,
      paperTitle: node.properties?.paperTitle || node.name,
      sourceKind: node.properties?.sourceKind || null,
      canonicalId: paperIdentity.canonicalId || null,
      canonicalIdSource: paperIdentity.canonicalIdSource || null,
      identityConfidence: paperIdentity.identityConfidence || null,
      identityAliases: paperIdentity.identityAliases,
      normalizedTitle: paperIdentity.normalizedTitle || null,
      titleSignature: paperIdentity.titleSignature || null,
      identifiers: paperIdentity.identifiers,
      identifierKeys: createPaperIdentifierKeys(paperIdentity.identifiers),
      ...flattenPaperIdentifiers(paperIdentity.identifiers)
    }
  };
}

function normalizePaperIndexEntry(entry = {}) {
  const paperIdentity = createPaperIdentity(entry);
  const sourceIdentity = createSourceIdentity(entry);
  return {
    ...entry,
    ...flattenPaperIdentifiers(paperIdentity.identifiers),
    identifiers: paperIdentity.identifiers,
    normalizedTitle: paperIdentity.normalizedTitle,
    titleSignature: paperIdentity.titleSignature,
    canonicalId: paperIdentity.canonicalId,
    canonicalIdSource: paperIdentity.canonicalIdSource,
    identityConfidence: paperIdentity.identityConfidence,
    identityAliases: paperIdentity.identityAliases,
    sourceKind: entry.kind || entry.sourceKind || sourceIdentity.sourceKind || null,
    sourceProvider: entry.sourceProvider || sourceIdentity.sourceProvider || null,
    contentSha256: entry.contentSha256 || sourceIdentity.contentSha256 || null,
    normalizedTextSha256: entry.normalizedTextSha256 || sourceIdentity.normalizedTextSha256 || null,
    sourceId: entry.sourceId || sourceIdentity.sourceId || null,
    resolutionStatus: entry.resolutionStatus || sourceIdentity.resolutionStatus || null
  };
}

function groupPaperIndexEntries(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const key = String(entry.paperId || entry.canonicalSourceKey || entry.sourceKey || '').trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function normalizeQueryOptions(options = {}) {
  return {
    limit: boundedInteger(options.limit, 5, { max: MAX_API_RESULT_LIMIT }),
    layers: options.layers
  };
}

function normalizeContextOptions(options = {}) {
  return {
    layers: options.layers,
    layerMode: options.layerMode || 'any',
    nodeView: options.nodeView || 'all'
  };
}

function normalizeImpactOptions(options = {}) {
  return {
    direction: options.direction || 'upstream',
    maxDepth: boundedInteger(options.maxDepth || options.depth, 3, { max: MAX_API_IMPACT_DEPTH }),
    layers: options.layers,
    layerMode: options.layerMode || 'any',
    relationTypes: Array.isArray(options.relationTypes) ? options.relationTypes : undefined,
    nodeView: options.nodeView || 'all'
  };
}

function normalizeIdeasOptions(options = {}) {
  return {
    limit: boundedInteger(options.limit, 5, { max: MAX_API_RESULT_LIMIT }),
    layers: options.layers
  };
}

function normalizeBrainstormOptions(options = {}) {
  return {
    mode: options.mode || 'diverge',
    maxHops: boundedInteger(options.maxHops || options.hops, 2, { max: MAX_API_BRAINSTORM_HOPS }),
    limit: boundedInteger(options.limit, 5, { max: MAX_API_RESULT_LIMIT }),
    layers: options.layers,
    layerMode: options.layerMode || 'any'
  };
}

function normalizeMechanismList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeCatalystRequestBody(body = {}) {
  const targetDomain = String(body?.targetDomain || body?.domain || '').trim();
  if (!targetDomain) {
    throw new Error('targetDomain is required.');
  }

  const rawOptions = body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
    ? body.options
    : {};
  const abstractChallenge = String(body?.abstractChallenge || body?.challenge || body?.problem || body?.query || '').trim();

  return {
    candidate: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
    targetDomain,
    fineGrainedDomain: String(body?.fineGrainedDomain || body?.fine_grained_domain || '').trim(),
    coarseGrainedDomain: String(body?.coarseGrainedDomain || body?.coarse_grained_domain || '').trim(),
    abstractChallenge,
    mechanisms: normalizeMechanismList(body?.mechanisms || body?.mechanism || rawOptions.mechanisms),
    numSourceDomains: boundedInteger(body?.numSourceDomains || body?.num_source_domains || rawOptions.numSourceDomains, 3, { max: MAX_API_CATALYST_DOMAINS }),
    relevanceThreshold: boundedInteger(body?.relevanceThreshold || body?.relevance_threshold || rawOptions.relevanceThreshold, 3, { max: MAX_API_CATALYST_THRESHOLD }),
    options: rawOptions
  };
}

async function buildGraphSearchPayload(candidate, body, options, buildResult) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  return presentPortablePayload({
    rootPath,
    result: buildResult(graph, request.query, request.options),
    generatedAt: new Date().toISOString()
  }, options);
}

export async function queryGraphPayload(candidate, body = {}, options = {}) {
  return buildGraphSearchPayload(candidate, body, options, (graph, query, rawOptions) => (
    searchGraph(graph, query, normalizeQueryOptions(rawOptions))
  ));
}

export async function contextGraphPayload(candidate, body = {}, options = {}) {
  return buildGraphSearchPayload(candidate, body, options, (graph, query, rawOptions) => (
    buildContext(graph, query, normalizeContextOptions(rawOptions))
  ));
}

export async function impactGraphPayload(candidate, body = {}, options = {}) {
  return buildGraphSearchPayload(candidate, body, options, (graph, query, rawOptions) => (
    buildImpact(graph, query, normalizeImpactOptions(rawOptions))
  ));
}

export async function ideasGraphPayload(candidate, body = {}, options = {}) {
  return buildGraphSearchPayload(candidate, body, options, (graph, query, rawOptions) => (
    buildResearchIdeas(graph, query, normalizeIdeasOptions(rawOptions))
  ));
}

export async function brainstormGraphPayload(candidate, body = {}, options = {}) {
  return buildGraphSearchPayload(candidate, body, options, (graph, query, rawOptions) => (
    buildBrainstorm(graph, query, normalizeBrainstormOptions(rawOptions))
  ));
}

export async function paperIndexPayload(candidate, body = {}, options = {}) {
  const request = normalizePaperIndexRequest(body);
  const effectiveCandidate = typeof body?.name === 'string' && body.name.trim()
    ? body.name.trim()
    : candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const manifest = await loadSourceManifest(rootPath);
  const sources = Array.isArray(manifest?.sources) ? manifest.sources.map((entry) => normalizePaperIndexEntry(entry)) : [];
  const matchedEntries = sources.filter((entry) => manifestEntryMatchesPaperIndex(entry, request));
  const groupedEntries = groupPaperIndexEntries(matchedEntries);
  const matchedBy = buildPaperIndexMatchedBy(request);

  let graph = null;
  if (groupedEntries.size) {
    ({ graph } = await loadCorpusLiteForApi(rootPath, options));
  }

  const matches = [...groupedEntries.entries()]
    .map(([groupKey, entries]) => {
      const mergedIdentity = createPaperIdentity({
        identifiers: Object.assign({}, ...entries.map((entry) => entry.identifiers || {})),
        identityAliases: unique(entries.flatMap((entry) => entry.identityAliases || [])),
        paperTitle: entries.find((entry) => entry.paperTitle)?.paperTitle || ''
      });
      const representative = entries.find((entry) => entry.activeInGraph !== false) || entries[0];
      const paperNode = graph?.getNode(representative.paperId)
        || graph?.nodes?.find((node) => node.type === NODE_TYPES.PAPER && node.properties?.paperId === representative.paperId)
        || null;

      return {
        groupKey,
        paperId: representative.paperId || null,
        paperTitle: representative.paperTitle || null,
        matchedBy,
        exact: true,
        canonicalId: representative.canonicalId || mergedIdentity.canonicalId || null,
        canonicalIdSource: representative.canonicalIdSource || mergedIdentity.canonicalIdSource || null,
        identityConfidence: representative.identityConfidence || mergedIdentity.identityConfidence || null,
        identityAliases: unique(entries.flatMap((entry) => entry.identityAliases || [])).sort(),
        identifiers: mergedIdentity.identifiers,
        normalizedTitle: representative.normalizedTitle || mergedIdentity.normalizedTitle || null,
        titleSignature: representative.titleSignature || mergedIdentity.titleSignature || null,
        identifierKeys: createPaperIdentifierKeys(mergedIdentity.identifiers),
        ...flattenPaperIdentifiers(mergedIdentity.identifiers),
        sourceCount: entries.length,
        activeSourceCount: entries.filter((entry) => entry.activeInGraph !== false).length,
        canonicalSourceKey: representative.canonicalSourceKey || representative.sourceKey || null,
        paperNode: summarizePaperIndexNode(paperNode),
        sources: entries
          .slice()
          .sort((left, right) => String(left.sourceKey || '').localeCompare(String(right.sourceKey || '')))
          .map((entry) => ({
            sourceKey: entry.sourceKey || null,
            inputPath: entry.inputPath || null,
            sourcePath: entry.sourcePath || null,
            kind: entry.kind || null,
            sourceKind: entry.sourceKind || entry.kind || null,
            sourceProvider: entry.sourceProvider || null,
            paperId: entry.paperId || null,
            paperTitle: entry.paperTitle || null,
            canonicalId: entry.canonicalId || null,
            canonicalIdSource: entry.canonicalIdSource || null,
            identityConfidence: entry.identityConfidence || null,
            identityAliases: entry.identityAliases || [],
            sourceId: entry.sourceId || null,
            contentSha256: entry.contentSha256 || null,
            normalizedTextSha256: entry.normalizedTextSha256 || null,
            resolutionStatus: entry.resolutionStatus || null,
            activeInGraph: entry.activeInGraph !== false,
            canonicalSourceKey: entry.canonicalSourceKey || null,
            duplicateOfSourceKey: entry.duplicateOfSourceKey || null,
            identifiers: entry.identifiers || {},
            identifierKeys: createPaperIdentifierKeys(entry.identifiers || {})
          }))
      };
    })
    .sort((left, right) => (
      (right.activeSourceCount - left.activeSourceCount)
      || String(left.paperTitle || '').localeCompare(String(right.paperTitle || ''))
      || String(left.paperId || '').localeCompare(String(right.paperId || ''))
    ));

  return presentPortablePayload({
    rootPath,
    result: {
      contractVersion: 'paper-precise-index-v1',
      query: {
        paperId: request.paperId || null,
        canonicalId: request.canonicalId || null,
        sourceId: request.sourceId || null,
        sourceKey: request.sourceKey || null,
        source: request.source || null,
        paperTitle: request.paperTitle || null,
        identifiers: request.identifiers,
        identifierKeys: createPaperIdentifierKeys(request.identifiers)
      },
      matchCount: matches.length,
      matches
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function catalystGraphPayload(candidate, body = {}, options = {}) {
  const request = normalizeCatalystRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);

  const result = buildCatalystQuery(graph, {
    targetDomain: request.targetDomain,
    fineGrainedDomain: request.fineGrainedDomain,
    coarseGrainedDomain: request.coarseGrainedDomain,
    abstractChallenge: request.abstractChallenge,
    mechanisms: request.mechanisms,
    numSourceDomains: request.numSourceDomains,
    relevanceThreshold: request.relevanceThreshold,
    limit: boundedInteger(request.options.limit, 5, { max: MAX_API_RESULT_LIMIT })
  });

  return presentPortablePayload({
    rootPath,
    result,
    packetBundle: result.packetBundle,
    generatedAt: new Date().toISOString()
  }, options);
}

function resolveInnovationHttpOptions(body = {}, request = {}) {
  const rawOptions = request.options || {};
  return {
    timeCutoff: firstConfiguredValue(body.timeCutoff, body.time_cutoff, rawOptions.timeCutoff, rawOptions.time_cutoff),
    mustCiteK: firstConfiguredValue(body.mustCiteK, body.must_cite_k, rawOptions.mustCiteK, rawOptions.must_cite_k),
    reviewerPanel: firstConfiguredValue(body.reviewerPanel, body.reviewer_panel, rawOptions.reviewerPanel, rawOptions.reviewer_panel),
    storylineMode: firstConfiguredValue(body.storylineMode, body.storyline_mode, rawOptions.storylineMode, rawOptions.storyline_mode),
    counterfactualBudget: firstConfiguredValue(
      body.counterfactualBudget,
      body.counterfactual_budget,
      rawOptions.counterfactualBudget,
      rawOptions.counterfactual_budget
    ),
    writeBack: firstConfiguredValue(body.writeBack, body.write_back, rawOptions.writeBack, rawOptions.write_back),
    writeBackMode: firstConfiguredValue(body.writeBackMode, body.write_back_mode, rawOptions.writeBackMode, rawOptions.write_back_mode),
    writeBackDryRun: firstConfiguredValue(body.writeBackDryRun, body.write_back_dry_run, rawOptions.writeBackDryRun, rawOptions.write_back_dry_run),
    writeBackApply: firstConfiguredValue(body.writeBackApply, body.write_back_apply, rawOptions.writeBackApply, rawOptions.write_back_apply),
    writeBackActor: firstConfiguredValue(body.writeBackActor, body.write_back_actor, rawOptions.writeBackActor, rawOptions.write_back_actor, body.actor, rawOptions.actor),
    allowWeakEvidence: firstConfiguredValue(body.allowWeakEvidence, body.allow_weak_evidence, rawOptions.allowWeakEvidence, rawOptions.allow_weak_evidence)
  };
}

function resolveWritebackApplyRequested(options = {}) {
  const mode = String(options.writeBackMode || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return ['apply', 'commit', 'write'].includes(mode)
    || enabledFlag(options.writeBackApply)
    || disabledFlag(options.writeBackDryRun);
}

function serializeMutationResult(mutationResult = {}) {
  return {
    dryRun: mutationResult.dryRun,
    actor: mutationResult.actor,
    operationsCount: mutationResult.operationsCount,
    countsBefore: mutationResult.countsBefore,
    countsAfter: mutationResult.countsAfter,
    summary: mutationResult.summary,
    results: mutationResult.results
  };
}

async function buildInnovationWritebackPayload(rootPath, artifact, options = {}) {
  if (!enabledFlag(options.writeBack)) return null;

  const applyRequested = resolveWritebackApplyRequested(options);
  const dryRun = !applyRequested;
  const actor = String(options.writeBackActor || 'idea-catalyst-v2').trim() || 'idea-catalyst-v2';
  const preview = buildInnovationArtifactGraphMutations(artifact, {
    actor,
    allowWeakEvidence: enabledFlag(options.allowWeakEvidence)
  });
  const payload = {
    ...preview,
    requested: true,
    requestedMode: applyRequested ? 'apply' : 'dry_run',
    dryRun,
    actor,
    applyStatus: 'not_requested',
    graphValidationStatus: 'not_run'
  };

  if (!preview.operations.length || preview.writebackStatus !== 'ready') {
    payload.applyStatus = 'blocked';
    payload.dryRun = true;
    return payload;
  }

  const { mutationResult } = await applyCorpusMutations(rootPath, preview.operations, {
    actor,
    dryRun
  });
  payload.applyStatus = dryRun ? 'previewed' : 'applied';
  payload.graphValidationStatus = 'validated';
  payload.mutationResult = serializeMutationResult(mutationResult);
  return payload;
}

async function buildIdeaCatalystV2HttpContext(candidate, body = {}, options = {}, contextOptions = {}) {
  const request = normalizeCatalystRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const catalyst = buildCatalystQuery(graph, {
    targetDomain: request.targetDomain,
    fineGrainedDomain: request.fineGrainedDomain,
    coarseGrainedDomain: request.coarseGrainedDomain,
    abstractChallenge: request.abstractChallenge,
    mechanisms: request.mechanisms,
    numSourceDomains: request.numSourceDomains,
    relevanceThreshold: request.relevanceThreshold,
    limit: boundedInteger(request.options.limit, 5, { max: MAX_API_RESULT_LIMIT })
  });
  const basePacketBundle = catalyst.packetBundle || {};
  const innovationOptions = resolveInnovationHttpOptions(body, request);
  const artifacts = buildIdeaCatalystInnovationArtifacts({
    problem: request.abstractChallenge,
    targetDomain: catalyst.targetDomain || request.targetDomain,
    target_domain: catalyst.targetDomain || request.targetDomain,
    target_domain_analysis: basePacketBundle.target_domain_analysis,
    source_domain_analyses: basePacketBundle.source_domain_analyses,
    idea_fragments: basePacketBundle.idea_fragments,
    timeCutoff: innovationOptions.timeCutoff,
    mustCiteK: innovationOptions.mustCiteK,
    reviewerPanel: innovationOptions.reviewerPanel,
    storylineMode: innovationOptions.storylineMode,
    counterfactualBudget: innovationOptions.counterfactualBudget
  }, innovationOptions);
  const packetBundle = {
    ...basePacketBundle,
    ...artifacts
  };
  const writeback = contextOptions.includeWriteback
    ? await buildInnovationWritebackPayload(rootPath, packetBundle, innovationOptions)
    : null;

  return {
    rootPath,
    request,
    catalyst,
    packetBundle,
    artifacts,
    writeback,
    generatedAt: new Date().toISOString()
  };
}

function buildIdeaCatalystV2Summary(context = {}) {
  const { catalyst = {}, artifacts = {}, request = {} } = context;
  return {
    contractVersion: IDEA_CATALYST_V2_HTTP_CONTRACT_VERSION,
    mode: 'graph',
    targetDomain: catalyst.targetDomain || request.targetDomain,
    abstractChallenge: catalyst.abstractChallenge || request.abstractChallenge,
    legacyContractVersion: catalyst.contractVersion,
    bridgeContractVersion: catalyst.bridgeContractVersion,
    packet_version: artifacts.packet_version,
    innovation_contract_version: artifacts.innovation_contract_version,
    must_cite_set: artifacts.must_cite_set,
    contribution_claims: artifacts.contribution_claims,
    novelty_certificate: artifacts.novelty_certificate,
    review_packet: artifacts.review_packet,
    storyline_dag: artifacts.storyline_dag,
    counterfactuals: artifacts.counterfactuals,
    falsification_plans: artifacts.falsification_plans
  };
}

export async function ideaCatalystV2Payload(candidate, body = {}, options = {}) {
  const context = await buildIdeaCatalystV2HttpContext(candidate, body, options, { includeWriteback: true });
  const result = buildIdeaCatalystV2Summary(context);
  return presentPortablePayload({
    rootPath: context.rootPath,
    result,
    packetBundle: context.packetBundle,
    must_cite_set: result.must_cite_set,
    contribution_claims: result.contribution_claims,
    novelty_certificate: result.novelty_certificate,
    review_packet: result.review_packet,
    storyline_dag: result.storyline_dag,
    counterfactuals: result.counterfactuals,
    falsification_plans: result.falsification_plans,
    writeback: context.writeback || undefined,
    generatedAt: context.generatedAt
  }, options);
}

export async function noveltyEvalPayload(candidate, body = {}, options = {}) {
  const context = await buildIdeaCatalystV2HttpContext(candidate, body, options);
  const artifacts = context.artifacts;
  return presentPortablePayload({
    rootPath: context.rootPath,
    result: {
      contractVersion: NOVELTY_EVAL_HTTP_CONTRACT_VERSION,
      mode: 'graph',
      targetDomain: context.catalyst.targetDomain,
      abstractChallenge: context.catalyst.abstractChallenge,
      contribution_claims: artifacts.contribution_claims,
      must_cite_set: artifacts.must_cite_set,
      novelty_certificate: artifacts.novelty_certificate
    },
    generatedAt: context.generatedAt
  }, options);
}

export async function storylinePayload(candidate, body = {}, options = {}) {
  const context = await buildIdeaCatalystV2HttpContext(candidate, body, options);
  const storyline = context.artifacts.storyline_dag;
  return presentPortablePayload({
    rootPath: context.rootPath,
    result: {
      contractVersion: STORYLINE_HTTP_CONTRACT_VERSION,
      mode: 'graph',
      targetDomain: context.catalyst.targetDomain,
      abstractChallenge: context.catalyst.abstractChallenge,
      storyline_dag: storyline,
      beat_trace_coverage: {
        beat_count: Array.isArray(storyline?.beats) ? storyline.beats.length : 0,
        traceable_beat_count: Array.isArray(storyline?.beats)
          ? storyline.beats.filter((beat) => Array.isArray(beat.trace_refs) && beat.trace_refs.length > 0).length
          : 0,
        unsupported_beats: storyline?.unsupported_beats || []
      }
    },
    generatedAt: context.generatedAt
  }, options);
}

export async function reviewerSimulatePayload(candidate, body = {}, options = {}) {
  const context = await buildIdeaCatalystV2HttpContext(candidate, body, options);
  return presentPortablePayload({
    rootPath: context.rootPath,
    result: {
      contractVersion: REVIEWER_SIMULATION_HTTP_CONTRACT_VERSION,
      mode: 'graph',
      targetDomain: context.catalyst.targetDomain,
      abstractChallenge: context.catalyst.abstractChallenge,
      review_packet: context.artifacts.review_packet
    },
    generatedAt: context.generatedAt
  }, options);
}

export async function evalRunPayload(candidate, runId = 'latest', options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  let report;
  try {
    report = await loadRunReport(rootPath, runId, { tail: 50 });
  } catch (error) {
    error.statusCode = 404;
    throw error;
  }
  return presentPortablePayload({
    rootPath,
    result: {
      contractVersion: EVAL_RUN_HTTP_CONTRACT_VERSION,
      run_id: report.runId,
      kind: report.run?.kind || null,
      status: report.state?.status || report.run?.status || null,
      state: report.state,
      summary: report.summary,
      checkpoints: report.checkpoints,
      workers: report.workers,
      events: report.events
    },
    generatedAt: new Date().toISOString()
  }, options);
}

function normalizeLayerFilter(value) {
  if (!value) return null;
  const layers = Array.isArray(value) ? value : String(value).split(',');
  const normalized = layers.map((layer) => String(layer).trim()).filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
}

function nodeInAllowedLayers(node, allowedLayers) {
  if (!node) return false;
  if (!allowedLayers?.size) return true;
  return allowedLayers.has(node.properties?.layer || '');
}

function relationshipMatchesLayerMode(relationship, layerMode) {
  if (!layerMode || layerMode === 'any') return true;
  if (layerMode === 'intra') return relationship.properties?.layerScope === 'intra-layer';
  if (layerMode === 'cross') return relationship.properties?.layerScope === 'cross-layer';
  return true;
}

function buildApiRelationIndex(graph) {
  const outgoing = new Map();
  const incoming = new Map();

  for (const relationship of graph.relationships || []) {
    if (!outgoing.has(relationship.sourceId)) outgoing.set(relationship.sourceId, []);
    if (!incoming.has(relationship.targetId)) incoming.set(relationship.targetId, []);
    outgoing.get(relationship.sourceId).push(relationship);
    incoming.get(relationship.targetId).push(relationship);
  }

  return { outgoing, incoming };
}

function serializeNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    layer: node.properties?.layer || getApiNodeLayer(node),
    paperId: node.properties?.paperId || (node.type === NODE_TYPES.PAPER ? node.id : null),
    paperTitle: node.properties?.paperTitle || (node.type === NODE_TYPES.PAPER ? node.name : null),
    brainstormEligible: node.properties?.brainstormEligible === true,
    brainstormTier: node.properties?.brainstormTier || null
  };
}

function serializeRelationship(relationship) {
  return {
    id: relationship.id || null,
    type: relationship.type,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    layerPath: relationship.properties?.layerPath || '',
    layerScope: relationship.properties?.layerScope || '',
    confidence: relationship.properties?.confidence ?? null
  };
}

function buildCardIndex(overlaySection = {}) {
  const cards = Array.isArray(overlaySection.cards) ? overlaySection.cards : [];
  return new Map(cards.map((card) => [card.id, card]));
}

function serializeCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    kind: card.kind,
    title: card.title || '',
    text: card.text || '',
    confidence: card.confidence ?? null,
    explicitOrInferred: card.explicitOrInferred || null,
    verdict: card.verdict || null,
    sectionHeading: card.sectionHeading || '',
    sectionRole: card.sectionRole || '',
    anchors: Array.isArray(card.anchors) ? card.anchors : []
  };
}

function uniqueById(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function uniqueStrings(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function findNodeCandidates(graph, query, options = {}) {
  const text = String(query || '').trim();
  if (!text) return [];

  const byId = typeof graph.getNode === 'function' ? graph.getNode(text) : null;
  if (byId) {
    return [byId];
  }

  const lowered = text.toLowerCase();
  const search = searchGraph(graph, text, {
    limit: boundedInteger(options.limit, 8, { max: MAX_API_CANDIDATE_LIMIT }),
    layers: options.layers,
    nodeView: options.nodeView || 'all'
  });
  const candidateIds = [];
  for (const group of search.groups || []) {
    for (const match of group.matches || []) {
      candidateIds.push(match.nodeId);
    }
  }

  const fromSearch = uniqueById(candidateIds.map((nodeId) => graph.getNode(nodeId)).filter(Boolean));
  if (fromSearch.length) {
    return fromSearch;
  }

  return uniqueById(
    (graph.nodes || []).filter((node) => {
      const name = String(node.name || '').toLowerCase();
      return name === lowered || name.includes(lowered);
    })
  ).slice(0, 10);
}

function resolveNodeSelection(graph, query, options = {}) {
  const candidates = findNodeCandidates(graph, query, options);
  if (!candidates.length) {
    return {
      query,
      node: null,
      candidates: []
    };
  }

  if (candidates.length === 1) {
    return {
      query,
      node: candidates[0],
      candidates: []
    };
  }

  return {
    query,
    node: candidates[0],
    candidates: candidates.slice(0, 10).map(serializeNode)
  };
}

function listLinkedNodes(graph, relationIndex, nodeId, direction, allowedTypes = null) {
  const relationships = direction === 'incoming'
    ? (relationIndex.incoming.get(nodeId) || [])
    : (relationIndex.outgoing.get(nodeId) || []);

  return relationships
    .map((relationship) => {
      const linkedId = direction === 'incoming' ? relationship.sourceId : relationship.targetId;
      return {
        relationship,
        node: graph.getNode(linkedId)
      };
    })
    .filter((entry) => entry.node)
    .filter((entry) => !allowedTypes || allowedTypes.includes(entry.node.type));
}

function collectRelevantPaperNodes(graph, query, options = {}) {
  const relationIndex = buildApiRelationIndex(graph);
  const paperIds = new Set();
  const search = searchGraph(graph, query, {
    limit: boundedInteger(options.limit, 6, { max: MAX_API_PAPER_LIMIT }),
    layers: options.layers,
    nodeView: options.nodeView || 'all'
  });

  for (const group of search.groups || []) {
    if (group.scope === 'paper') {
      paperIds.add(group.id);
      continue;
    }

    for (const match of group.matches || []) {
      const node = graph.getNode(match.nodeId);
      if (!node) continue;
      if (node.type === NODE_TYPES.PAPER) {
        paperIds.add(node.id);
      }
      if (node.properties?.paperId) {
        paperIds.add(node.properties.paperId);
      }

      for (const linked of [
        ...listLinkedNodes(graph, relationIndex, node.id, 'incoming', [NODE_TYPES.PAPER]),
        ...listLinkedNodes(graph, relationIndex, node.id, 'outgoing', [NODE_TYPES.PAPER])
      ]) {
        paperIds.add(linked.node.id);
      }
    }
  }

  return [...paperIds]
    .map((paperId) => graph.getNode(paperId) || (graph.nodes || []).find((node) => node.type === NODE_TYPES.PAPER && node.properties?.paperId === paperId))
    .filter(Boolean)
    .slice(0, boundedInteger(options.limit, 5, { max: MAX_API_PAPER_LIMIT }));
}

function resolvePathTraceOptions(options = {}) {
  return {
    maxDepth: boundedInteger(options.maxDepth, 4, { max: MAX_API_PATH_DEPTH }),
    maxPaths: boundedInteger(options.maxPaths || options.limit, 3, { max: MAX_API_PATHS }),
    direction: options.direction || 'any',
    relationTypes: Array.isArray(options.relationTypes) ? new Set(options.relationTypes) : null,
    layers: normalizeLayerFilter(options.layers),
    layerMode: options.layerMode || 'any',
    nodeView: options.nodeView || 'all'
  };
}

function enumeratePathTracePaths(graph, fromNode, toNode, options = {}) {
  const relationIndex = buildApiRelationIndex(graph);
  const queue = [{
    nodeId: fromNode.id,
    nodeIds: [fromNode.id],
    relationships: []
  }];
  const paths = [];

  while (queue.length && paths.length < options.maxPaths) {
    const current = queue.shift();
    const depth = current.relationships.length;
    if (depth >= options.maxDepth) continue;

    const relationshipPool = [];
    if (options.direction === 'any' || options.direction === 'outgoing') {
      relationshipPool.push(...(relationIndex.outgoing.get(current.nodeId) || []));
    }
    if (options.direction === 'any' || options.direction === 'incoming') {
      relationshipPool.push(...(relationIndex.incoming.get(current.nodeId) || []));
    }

    for (const relationship of relationshipPool) {
      if (options.relationTypes && !options.relationTypes.has(relationship.type)) continue;
      if (!relationshipMatchesLayerMode(relationship, options.layerMode)) continue;

      const nextNodeId = relationship.sourceId === current.nodeId
        ? relationship.targetId
        : relationship.sourceId;
      if (current.nodeIds.includes(nextNodeId)) continue;

      const nextNode = graph.getNode(nextNodeId);
      if (!nodeInAllowedLayers(nextNode, options.layers)) continue;

      const nextPath = {
        nodeId: nextNodeId,
        nodeIds: [...current.nodeIds, nextNodeId],
        relationships: [...current.relationships, relationship]
      };

      if (nextNodeId === toNode.id) {
        paths.push({
          nodes: nextPath.nodeIds.map((nodeId) => serializeNode(graph.getNode(nodeId))),
          relationships: nextPath.relationships.map(serializeRelationship),
          hopCount: nextPath.relationships.length,
          score: Number((1 / Math.max(1, nextPath.relationships.length)).toFixed(3))
        });
        if (paths.length >= options.maxPaths) break;
        continue;
      }

      queue.push(nextPath);
    }
  }

  return paths;
}

function buildEvidenceChainsForPaper(graph, paperNode) {
  const relationIndex = buildApiRelationIndex(graph);
  const problems = listLinkedNodes(graph, relationIndex, paperNode.id, 'outgoing', [NODE_TYPES.PROBLEM]).map((entry) => entry.node);
  const methods = listLinkedNodes(graph, relationIndex, paperNode.id, 'outgoing', [NODE_TYPES.METHOD]).map((entry) => entry.node);
  const claims = listLinkedNodes(graph, relationIndex, paperNode.id, 'outgoing', [NODE_TYPES.CLAIM]).map((entry) => entry.node);
  const evidences = [
    ...listLinkedNodes(graph, relationIndex, paperNode.id, 'outgoing', [NODE_TYPES.EVIDENCE]).map((entry) => entry.node),
    ...claims.flatMap((claim) => listLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.EVIDENCE]).map((entry) => entry.node))
  ];
  const limitations = listLinkedNodes(graph, relationIndex, paperNode.id, 'outgoing', [NODE_TYPES.LIMITATION]).map((entry) => entry.node);

  const chains = methods.slice(0, 3).map((method) => {
    const methodClaims = claims.slice(0, 3).map((claim) => ({
      claim: serializeNode(claim),
      evidences: uniqueById(
        listLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.EVIDENCE]).map((entry) => serializeNode(entry.node))
      ).slice(0, 3)
    }));

    return {
      problem: serializeNode(problems[0] || null),
      method: serializeNode(method),
      claims: methodClaims,
      limitations: uniqueById(limitations.map(serializeNode)).slice(0, 3)
    };
  });

  return {
    paper: {
      paperId: paperNode.id,
      paperTitle: paperNode.name
    },
    problems: uniqueById(problems.map(serializeNode)).slice(0, 4),
    methods: uniqueById(methods.map(serializeNode)).slice(0, 4),
    claims: uniqueById(claims.map(serializeNode)).slice(0, 4),
    evidences: uniqueById(evidences.map(serializeNode)).slice(0, 4),
    limitations: uniqueById(limitations.map(serializeNode)).slice(0, 4),
    chains: chains.length ? chains : [{
      problem: serializeNode(problems[0] || null),
      method: serializeNode(methods[0] || null),
      claims: claims.slice(0, 2).map((claim) => ({
        claim: serializeNode(claim),
        evidences: uniqueById(
          listLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.EVIDENCE]).map((entry) => serializeNode(entry.node))
        ).slice(0, 3)
      })),
      limitations: uniqueById(limitations.map(serializeNode)).slice(0, 3)
    }]
  };
}

function buildReflectionChainsFromOverlay(overlay) {
  const reflection = overlay?.overlays?.reflection;
  if (!reflection) {
    return [];
  }

  const cardIndex = buildCardIndex(reflection);
  const slots = reflection.slots || {};
  const innovations = (slots.innovations || []).map((id) => serializeCard(cardIndex.get(id))).filter(Boolean);
  const experiments = (slots.experiments || []).map((id) => serializeCard(cardIndex.get(id))).filter(Boolean);
  const outcomes = (slots.outcomes || []).map((id) => serializeCard(cardIndex.get(id))).filter(Boolean);
  const reflections = (slots.reflections || []).map((id) => serializeCard(cardIndex.get(id))).filter(Boolean);
  const links = Array.isArray(reflection.links) ? reflection.links : [];

  const chains = [];
  for (const innovation of innovations) {
    const experimentLinks = links.filter((link) => link.type === 'TESTED_BY' && link.sourceId === innovation.id);
    if (!experimentLinks.length) {
      chains.push({
        innovation,
        experiments: [],
        outcomes: [],
        reflections: []
      });
      continue;
    }

    for (const experimentLink of experimentLinks) {
      const experiment = serializeCard(cardIndex.get(experimentLink.targetId));
      const outcomeLinks = links.filter((link) => link.type === 'PRODUCED' && link.sourceId === experimentLink.targetId);
      const chainOutcomes = outcomeLinks.map((link) => serializeCard(cardIndex.get(link.targetId))).filter(Boolean);
      const chainReflections = outcomeLinks.flatMap((outcomeLink) => (
        links
          .filter((link) => link.type === 'SUMMARIZED_AS' && link.sourceId === outcomeLink.targetId)
          .map((link) => serializeCard(cardIndex.get(link.targetId)))
      )).filter(Boolean);

      chains.push({
        innovation,
        experiments: experiment ? [experiment] : [],
        outcomes: uniqueById(chainOutcomes),
        reflections: uniqueById(chainReflections)
      });
    }
  }

  return chains.length ? chains : [{
    innovation: innovations[0] || null,
    experiments,
    outcomes,
    reflections
  }];
}

async function loadPaperOverlayIfPresent(rootPath, paperId) {
  const payload = await loadPaperEnhancement(rootPath, paperId);
  return payload?.overlay || null;
}

async function collectOverlayPapers(rootPath, graph, query, options = {}) {
  const papers = collectRelevantPaperNodes(graph, query, options);
  const limit = boundedInteger(options.limit, 5, { max: MAX_API_PAPER_LIMIT });
  const results = [];

  for (const paper of papers) {
    const overlay = await loadPaperOverlayIfPresent(rootPath, paper.id);
    if (!overlay) continue;
    results.push({
      paper,
      overlay
    });
    if (results.length >= limit) break;
  }

  return results;
}

function buildTheoryBriefFromOverlay(paper, overlay) {
  const theory = overlay?.overlays?.theory;
  if (!theory) return null;

  const cardIndex = buildCardIndex(theory);
  const slots = theory.slots || {};
  const mapSlot = (slotName) => (slots[slotName] || []).map((id) => serializeCard(cardIndex.get(id))).filter(Boolean);

  return {
    paper: {
      paperId: paper.id,
      paperTitle: paper.name
    },
    summary: theory.summary || '',
    confidence: theory.confidence ?? null,
    supportNote: Array.isArray(theory.supportNote) ? theory.supportNote : [],
    claims: mapSlot('claims'),
    assumptions: mapSlot('assumptions'),
    mechanisms: mapSlot('mechanisms'),
    theoremLike: mapSlot('theoremLike'),
    proofIdeas: mapSlot('proofIdeas'),
    limitations: mapSlot('limitations'),
    failureModes: mapSlot('failureModes'),
    risks: Array.isArray(theory.risks) ? theory.risks : []
  };
}

function buildStorylineBriefFromOverlay(paper, overlay) {
  const storyline = overlay?.overlays?.storyline;
  if (!storyline) return null;

  return {
    paper: {
      paperId: paper.id,
      paperTitle: paper.name
    },
    summary: storyline.summary || '',
    confidence: storyline.confidence ?? null,
    sketch: Array.isArray(storyline.sketch) ? storyline.sketch : [],
    beats: Array.isArray(storyline.beats) ? storyline.beats.map(serializeCard) : [],
    missingBeats: Array.isArray(storyline.missingBeats) ? storyline.missingBeats : [],
    risks: Array.isArray(storyline.risks) ? storyline.risks : []
  };
}

function summarizeOpenRisks(papers = [], key = 'risks') {
  return papers.flatMap((paper) => Array.isArray(paper[key]) ? paper[key] : []).slice(0, 12);
}

export async function pathTraceGraphPayload(candidate, body = {}, options = {}) {
  const from = String(body?.from || '').trim();
  const to = String(body?.to || '').trim();
  if (!from || !to) {
    throw new Error('from and to are required.');
  }

  const effectiveCandidate = (typeof body?.name === 'string' && body.name.trim()) ? body.name.trim() : candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const traceOptions = resolvePathTraceOptions(body?.options || {});
  const fromSelection = resolveNodeSelection(graph, from, traceOptions);
  const toSelection = resolveNodeSelection(graph, to, traceOptions);
  const paths = fromSelection.node && toSelection.node
    ? enumeratePathTracePaths(graph, fromSelection.node, toSelection.node, traceOptions)
    : [];

  return presentPortablePayload({
    rootPath,
    result: {
      from: {
        query: from,
        node: serializeNode(fromSelection.node),
        candidates: fromSelection.candidates
      },
      to: {
        query: to,
        node: serializeNode(toSelection.node),
        candidates: toSelection.candidates
      },
      paths
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function evidenceChainPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const relevantPapers = collectRelevantPaperNodes(graph, request.query, request.options);
  const chains = relevantPapers.map((paper) => buildEvidenceChainsForPaper(graph, paper));

  return presentPortablePayload({
    rootPath,
    result: {
      query: request.query,
      chains
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function methodLineagePayload(candidate, body = {}, options = {}) {
  const effectiveCandidate = (typeof body?.name === 'string' && body.name.trim()) ? body.name.trim() : candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);

  return presentPortablePayload({
    rootPath,
    result: buildMethodEvolutionGapAnalysis(graph, {
      ...body,
      ...(body?.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {})
    }),
    generatedAt: new Date().toISOString()
  }, options);
}

export async function methodEvidencePayload(candidate, body = {}, options = {}) {
  const effectiveCandidate = (typeof body?.name === 'string' && body.name.trim()) ? body.name.trim() : candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);

  return presentPortablePayload({
    rootPath,
    result: buildMethodEvolutionEvidenceLookup(graph, {
      ...body,
      ...(body?.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {})
    }),
    generatedAt: new Date().toISOString()
  }, options);
}

export async function methodRegistryPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const corpusNode = graph.getNodesByType(NODE_TYPES.CORPUS)[0] || null;
  const overlay = corpusNode?.properties?.methodEvolutionOverlay || {};
  const registry = overlay.registry || {};

  return presentPortablePayload({
    rootPath,
    result: {
      contractVersion: 'papernexus-method-registry-v1',
      path: 'method_registry',
      generatedAt: overlay.generatedAt || null,
      source: overlay.source || null,
      summary: overlay.summary || corpusNode?.properties?.methodEvolutionOverlaySummary || {},
      registry: {
        contractVersion: registry.contractVersion || overlay.contractVersion || null,
        methods: Array.isArray(registry.methods) ? registry.methods : [],
        aliases: Array.isArray(registry.aliases) ? registry.aliases : [],
        stubs: Array.isArray(registry.stubs) ? registry.stubs : [],
        diagnostics: registry.diagnostics || {}
      },
      diagnostics: {
        queryTimeLlmCalls: 0,
        source: 'graph-only',
        overlayAvailable: Boolean(overlay.contractVersion || registry.contractVersion)
      }
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function reflectionChainPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const overlayPapers = await collectOverlayPapers(rootPath, graph, request.query, request.options);

  return presentPortablePayload({
    rootPath,
    result: {
      query: request.query,
      chains: overlayPapers.map(({ paper, overlay }) => {
        const reflection = overlay.overlays?.reflection;
        const cardIndex = buildCardIndex(reflection);
        return {
          paper: {
            paperId: paper.id,
            paperTitle: paper.name,
            risks: Array.isArray(reflection?.risks) ? reflection.risks : []
          },
          innovations: (reflection?.slots?.innovations || [])
            .map((id) => serializeCard(cardIndex.get(id)))
            .filter(Boolean),
          experiments: (reflection?.slots?.experiments || [])
            .map((id) => serializeCard(cardIndex.get(id)))
            .filter(Boolean),
          outcomes: (reflection?.slots?.outcomes || [])
            .map((id) => serializeCard(cardIndex.get(id)))
            .filter(Boolean),
          reflections: (reflection?.slots?.reflections || [])
            .map((id) => serializeCard(cardIndex.get(id)))
            .filter(Boolean),
          chains: buildReflectionChainsFromOverlay(overlay)
        };
      })
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function theoryBriefPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const overlayPapers = await collectOverlayPapers(rootPath, graph, request.query, request.options);
  const papers = overlayPapers
    .map(({ paper, overlay }) => buildTheoryBriefFromOverlay(paper, overlay))
    .filter(Boolean);

  return presentPortablePayload({
    rootPath,
    result: {
      query: request.query,
      papers,
      openRisks: summarizeOpenRisks(papers)
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function storylineBriefPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const overlayPapers = await collectOverlayPapers(rootPath, graph, request.query, request.options);
  const papers = overlayPapers
    .map(({ paper, overlay }) => buildStorylineBriefFromOverlay(paper, overlay))
    .filter(Boolean);

  return presentPortablePayload({
    rootPath,
    result: {
      query: request.query,
      papers,
      openRisks: summarizeOpenRisks(papers)
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function researchBriefPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const [querySummary, evidenceChains, reflectionChains, theoryBrief, storylineBrief] = await Promise.all([
    queryGraphPayload(effectiveCandidate, request, options),
    evidenceChainPayload(effectiveCandidate, request, options),
    reflectionChainPayload(effectiveCandidate, request, options),
    theoryBriefPayload(effectiveCandidate, request, options),
    storylineBriefPayload(effectiveCandidate, request, options)
  ]);

  return presentPortablePayload({
    rootPath: querySummary.rootPath,
    result: {
      query: request.query,
      querySummary: querySummary.result,
      evidenceChains: evidenceChains.result,
      reflectionChains: reflectionChains.result,
      theory: theoryBrief.result,
      storyline: storylineBrief.result,
      openRisks: uniqueStrings([
        ...(theoryBrief.result.openRisks || []),
        ...(storylineBrief.result.openRisks || []),
        ...((reflectionChains.result.chains || []).flatMap((entry) => entry.paper?.risks || []))
      ]).slice(0, 16)
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function brainstormBriefPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const [brainstorm, ideas, evidenceChains] = await Promise.all([
    brainstormGraphPayload(effectiveCandidate, {
      ...request,
      options: {
        ...request.options,
        mode: request.options?.mode || 'converge'
      }
    }, options),
    ideasGraphPayload(effectiveCandidate, request, options),
    evidenceChainPayload(effectiveCandidate, {
      ...request,
      options: {
        ...request.options,
        limit: Math.min(3, boundedInteger(request.options?.limit, 3, { max: MAX_API_RESULT_LIMIT }))
      }
    }, options)
  ]);

  return presentPortablePayload({
    rootPath: brainstorm.rootPath,
    result: {
      query: request.query,
      directions: brainstorm.result.convergedDirections || [],
      ideas: ideas.result.ideas || [],
      supportingChains: evidenceChains.result.chains || [],
      relatedConcepts: brainstorm.result.relatedConcepts || [],
      constraints: brainstorm.result.potentialConstraints || [],
      risks: uniqueStrings([
        ...(brainstorm.result.potentialConstraints || []).map((entry) => `${entry.type}: ${entry.name}`),
        ...((evidenceChains.result.chains || []).flatMap((entry) => (entry.limitations || []).map((limitation) => limitation.name)).filter(Boolean))
      ]).slice(0, 12)
    },
    generatedAt: new Date().toISOString()
  }, options);
}

export async function corpusMetaPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const { metaPath, authoritativeSyncQueuePath } = getCorpusPaths(rootPath);
  const stamp = `${await readPathStamp(metaPath)}|${await readPathStamp(authoritativeSyncQueuePath)}`;

  const buildPayload = async () => {
    const [meta, syncJobs] = await Promise.all([
      loadCorpusMeta(rootPath),
      listAuthoritativeSyncJobs(rootPath)
    ]);

    return presentPortablePayload({
      meta,
      authoritativeSync: {
        status: meta.authoritativeSyncStatus || (syncJobs.length ? 'pending' : 'synced'),
        pendingJobCount: syncJobs.length,
        jobs: syncJobs.map((job) => ({
          jobId: job.jobId,
          status: job.status,
          targetManifestToken: job.targetManifestToken,
          changedSourceKeys: job.changedSourceKeys || [],
          updatedAt: job.updatedAt
        }))
      }
    }, options);
  };

  if (!cache?.corpusMetaByRoot) {
    return buildPayload();
  }

  return resolveCachedPayload(cache.corpusMetaByRoot, rootPath, stamp, buildPayload);
}

function compactString(value) {
  return String(value || '').trim();
}

function firstString(...values) {
  for (const value of values) {
    const normalized = compactString(value);
    if (normalized) return normalized;
  }
  return '';
}

function resolveCorpusSourcePath(rootPath, value) {
  const raw = compactString(value);
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('file:')) return '';
  if (raw.startsWith('file:')) {
    try {
      return new URL(raw).pathname;
    } catch {
      return '';
    }
  }
  return path.isAbsolute(raw) ? raw : path.resolve(rootPath, raw);
}

async function firstReadableSourcePath(rootPath, entry = {}) {
  const candidates = unique([
    entry.sourceMarkdownPath,
    entry.source_markdown_path,
    entry.markdownCachePath,
    entry.markdown_cache_path,
    entry.sourcePath,
    entry.source_path,
    entry.inputPath,
    entry.input_path,
    entry.sourceKey,
    entry.source_key
  ].map((value) => resolveCorpusSourcePath(rootPath, value)).filter(Boolean));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return '';
}

async function readTextPrefix(filePath, maxBytes = 262144) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const byteLength = Math.max(0, Math.min(stat.size, maxBytes));
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return {
      text: buffer.slice(0, bytesRead).toString('utf8'),
      byteLength: stat.size,
      truncated: stat.size > bytesRead
    };
  } finally {
    await handle.close();
  }
}

function lineStartsForText(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineNumberForOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(1, high + 1);
}

function createTextSpan({ text, lineStarts, start, end, role, sourcePath, sourceKey, paperId }) {
  if (start < 0 || end <= start) return null;
  const evidenceText = text.slice(start, end);
  if (!evidenceText.trim()) return null;
  return {
    span_id: `source-span:${stableHash(`${sourceKey || sourcePath}:${start}:${end}:${evidenceText}`, 16)}`,
    source_type: 'source_text',
    role,
    paper_id: paperId || null,
    source_key: sourceKey || null,
    source_path: sourcePath || null,
    start_char: start,
    end_char: end,
    start_line: lineNumberForOffset(lineStarts, start),
    end_line: lineNumberForOffset(lineStarts, Math.max(start, end - 1)),
    evidence_text: evidenceText,
    evidence_text_sha1: stableHash(evidenceText, 40),
    source_span_available: true
  };
}

function addUniqueSpan(spans, span) {
  if (!span) return;
  if (spans.some((entry) => entry.start_char === span.start_char && entry.end_char === span.end_char)) return;
  spans.push(span);
}

function findNextTextBlock(text, startOffset, maxLength = 640) {
  const rest = text.slice(startOffset);
  const match = rest.match(/\S[\s\S]*?(?=\n\s*\n|$)/);
  if (!match || match.index === undefined) return null;
  const rawStart = startOffset + match.index;
  const rawEnd = rawStart + match[0].length;
  const block = text.slice(rawStart, rawEnd);
  const leading = block.match(/^\s*/)?.[0].length || 0;
  const trailing = block.match(/\s*$/)?.[0].length || 0;
  const start = rawStart + leading;
  const end = Math.min(rawEnd - trailing, start + maxLength);
  return end > start ? { start, end } : null;
}

function buildSourceTextSpans({ text, title, sourcePath, sourceKey, paperId }) {
  const normalizedText = String(text || '').replace(/\r\n?/g, '\n');
  const lineStarts = lineStartsForText(normalizedText);
  const spans = [];
  const normalizedTitle = compactString(title);
  if (normalizedTitle) {
    const titleIndex = normalizedText.toLowerCase().indexOf(normalizedTitle.toLowerCase());
    if (titleIndex >= 0) {
      addUniqueSpan(spans, createTextSpan({
        text: normalizedText,
        lineStarts,
        start: titleIndex,
        end: titleIndex + normalizedTitle.length,
        role: 'title',
        sourcePath,
        sourceKey,
        paperId
      }));
    }
  }

  const abstractHeading = normalizedText.match(/^#{1,6}\s*abstract\s*$/im);
  const abstractBlock = abstractHeading
    ? findNextTextBlock(normalizedText, abstractHeading.index + abstractHeading[0].length)
    : null;
  if (abstractBlock) {
    addUniqueSpan(spans, createTextSpan({
      text: normalizedText,
      lineStarts,
      start: abstractBlock.start,
      end: abstractBlock.end,
      role: 'abstract',
      sourcePath,
      sourceKey,
      paperId
    }));
  }

  if (!spans.length) {
    const fallbackBlock = findNextTextBlock(normalizedText, 0);
    if (fallbackBlock) {
      addUniqueSpan(spans, createTextSpan({
        text: normalizedText,
        lineStarts,
        start: fallbackBlock.start,
        end: fallbackBlock.end,
        role: 'source_excerpt',
        sourcePath,
        sourceKey,
        paperId
      }));
    }
  }

  return spans.slice(0, 3);
}

function findPaperNodeForSource(graph, entry = {}) {
  if (!graph) return null;
  const paperId = firstString(entry.paperId, entry.paper_id);
  if (paperId && typeof graph.getNode === 'function') {
    const direct = graph.getNode(paperId);
    if (direct) return direct;
  }

  const sourceKey = firstString(entry.sourceKey, entry.source_key);
  const canonicalSourceKey = firstString(entry.canonicalSourceKey, entry.canonical_source_key, sourceKey);
  const title = firstString(entry.paperTitle, entry.paper_title, entry.title).toLowerCase();
  const candidates = typeof graph.getNodesByType === 'function'
    ? graph.getNodesByType(NODE_TYPES.PAPER)
    : (graph.nodes || []).filter((node) => node.type === NODE_TYPES.PAPER);
  return candidates.find((node) => {
    const props = node.properties || {};
    if (paperId && (node.id === paperId || props.paperId === paperId)) return true;
    if (sourceKey && [props.sourceKey, props.sourcePath, props.sourceMarkdownPath, props.sourcePdfPath].includes(sourceKey)) return true;
    if (canonicalSourceKey && Array.isArray(props.sourceVariants) && props.sourceVariants.includes(canonicalSourceKey)) return true;
    if (title && String(node.name || props.paperTitle || '').trim().toLowerCase() === title) return true;
    return false;
  }) || null;
}

function buildGraphIndexEvidence(graph, entry = {}) {
  const sourceKey = firstString(entry.sourceKey, entry.source_key);
  const paperId = firstString(entry.paperId, entry.paper_id);
  const paperNode = findPaperNodeForSource(graph, entry);
  const incoming = paperNode && typeof graph?.getIncoming === 'function' ? graph.getIncoming(paperNode.id) : [];
  const outgoing = paperNode && typeof graph?.getOutgoing === 'function' ? graph.getOutgoing(paperNode.id) : [];
  const neighborNodeIds = unique([
    ...incoming.map((relationship) => relationship.sourceId),
    ...outgoing.map((relationship) => relationship.targetId)
  ].filter(Boolean)).slice(0, 12);
  const props = paperNode?.properties || {};

  return {
    available: Boolean(paperNode),
    paper_id: props.paperId || paperId || paperNode?.id || null,
    paper_node_id: paperNode?.id || null,
    paper_node_type: paperNode?.type || null,
    paper_node_name: paperNode?.name || null,
    source_key: sourceKey || null,
    canonical_source_key: firstString(entry.canonicalSourceKey, entry.canonical_source_key, sourceKey) || null,
    active_in_graph: entry.activeInGraph !== false && entry.active_in_graph !== false,
    graph_relationship_count: incoming.length + outgoing.length,
    graph_neighbor_node_ids: neighborNodeIds,
    identifiers: props.identifiers || entry.identifiers || {},
    normalized_title: props.normalizedTitle || entry.normalizedTitle || entry.normalized_title || null,
    title_signature: props.titleSignature || entry.titleSignature || entry.title_signature || null
  };
}

async function buildSourceSpanEvidence(rootPath, entry = {}) {
  const sourcePath = await firstReadableSourcePath(rootPath, entry);
  const sourceKey = firstString(entry.sourceKey, entry.source_key);
  const paperId = firstString(entry.paperId, entry.paper_id);
  if (!sourcePath) {
    return {
      available: false,
      count: 0,
      source_key: sourceKey || null,
      source_path: null,
      spans: []
    };
  }

  try {
    const prefix = await readTextPrefix(sourcePath);
    const spans = buildSourceTextSpans({
      text: prefix.text,
      title: firstString(entry.paperTitle, entry.paper_title, entry.title),
      sourcePath,
      sourceKey,
      paperId
    });
    return {
      available: spans.length > 0,
      count: spans.length,
      source_key: sourceKey || null,
      source_path: sourcePath,
      byte_length: prefix.byteLength,
      prefix_truncated: prefix.truncated,
      spans
    };
  } catch (error) {
    return {
      available: false,
      count: 0,
      source_key: sourceKey || null,
      source_path: sourcePath,
      error: error instanceof Error ? error.message : String(error),
      spans: []
    };
  }
}

async function attachSourceProvenance(rootPath, graph, entry = {}) {
  const graphIndexEvidence = buildGraphIndexEvidence(graph, entry);
  const sourceSpanEvidence = await buildSourceSpanEvidence(rootPath, entry);
  return {
    ...entry,
    graph_index_evidence: graphIndexEvidence,
    source_span_evidence: sourceSpanEvidence
  };
}

export async function corpusSourcesPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const [meta, manifest, corpusLiteResult] = await Promise.all([
    loadCorpusMeta(rootPath),
    loadSourceManifest(rootPath),
    loadCorpusLiteForApi(rootPath, options).catch((error) => ({ error }))
  ]);
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const graph = corpusLiteResult?.graph || null;
  const provenanceSources = await Promise.all(
    sources.map((entry) => attachSourceProvenance(rootPath, graph, entry))
  );
  const graphIndexEvidenceCount = provenanceSources.filter((entry) => (
    entry.graph_index_evidence?.available === true
  )).length;
  const sourceSpanEvidenceCount = provenanceSources.filter((entry) => (
    entry.source_span_evidence?.available === true
    && Number(entry.source_span_evidence?.count || 0) > 0
  )).length;

  return presentPortablePayload({
    rootPath,
    meta,
    manifest: {
      version: manifest?.version ?? null,
      corpusName: manifest?.corpusName || meta.name,
      rootPath: manifest?.rootPath || rootPath,
      inputPath: manifest?.inputPath || null,
      inputPaths: Array.isArray(manifest?.inputPaths) ? manifest.inputPaths : [],
      indexedAt: manifest?.indexedAt || meta.indexedAt || null,
      sourceMode: manifest?.sourceMode || meta.sourceMode || null,
      sourceCount: sources.length,
      activeSourceCount: sources.filter((entry) => entry?.activeInGraph !== false).length
    },
    provenance: {
      contractVersion: 'papernexus-corpus-source-provenance-v1',
      graphIndexEvidenceCount,
      sourceSpanEvidenceCount,
      graphAvailable: Boolean(graph),
      graphLoadError: corpusLiteResult?.error ? (corpusLiteResult.error.message || String(corpusLiteResult.error)) : null
    },
    sources: provenanceSources,
    generatedAt: new Date().toISOString()
  }, options);
}

export async function backupCorpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate);
  return presentPortablePayload({
    backup: await backupCorpus(rootPath, {
      backupDir: options.backupDir
    }),
    generatedAt: new Date().toISOString()
  }, options);
}

function pickImportPaperTitle(input = {}) {
  return String(
    input?.title
    || input?.paperTitle
    || input?.paper_title
    || input?.paperMetadata?.title
    || input?.paperMetadata?.paperTitle
    || input?.paperMetadata?.paper_title
    || ''
  ).trim();
}

function pickImportSourceProvider(input = {}) {
  return String(
    input?.sourceProvider
    || input?.provider
    || input?.paperMetadata?.sourceProvider
    || input?.paperMetadata?.provider
    || ''
  ).trim();
}

function createImportPaperIdentityInput(input = {}) {
  const title = pickImportPaperTitle(input);
  return {
    ...(input?.paperMetadata || {}),
    ...(input || {}),
    ...(title ? { title } : {})
  };
}

function normalizeImportPaperMetadata(input = {}) {
  const identityInput = createImportPaperIdentityInput(input);
  const paperIdentity = createPaperIdentity(identityInput);
  const explicitSourceProvider = pickImportSourceProvider(input);
  const titleDerivedIdentity = paperIdentity.canonicalIdSource === 'title' && explicitSourceProvider;
  if (!Object.keys(paperIdentity.identifiers).length && !explicitSourceProvider && !titleDerivedIdentity) {
    return null;
  }
  return {
    ...(Object.keys(paperIdentity.identifiers).length ? { identifiers: paperIdentity.identifiers } : {}),
    ...(explicitSourceProvider ? { sourceProvider: explicitSourceProvider } : {}),
    ...(titleDerivedIdentity
      ? {
          title: pickImportPaperTitle(input),
          normalizedTitle: paperIdentity.normalizedTitle,
          titleSignature: paperIdentity.titleSignature,
          canonicalId: paperIdentity.canonicalId,
          canonicalIdSource: paperIdentity.canonicalIdSource,
          identityConfidence: paperIdentity.identityConfidence,
          identityAliases: paperIdentity.identityAliases
        }
      : {})
  };
}

function hasImportPaperIdentity(input = {}) {
  if (hasAnyPaperIdentifiers(input)) return true;
  const paperIdentity = createPaperIdentity(createImportPaperIdentityInput(input));
  const sourceProvider = pickImportSourceProvider(input);
  return Boolean(sourceProvider && paperIdentity.canonicalIdSource === 'title');
}

function normalizeImportFiles(files = [], defaultPaperMetadata = null) {
  const normalized = Array.isArray(files) ? files : [];
  return normalized.map((file) => ({
    name: String(file?.name || '').trim(),
    mimeType: String(file?.mimeType || '').trim(),
    contentBase64: String(file?.contentBase64 || '').trim(),
    paperMetadata: normalizeImportPaperMetadata({
      ...(defaultPaperMetadata || {}),
      ...(file || {}),
      paperMetadata: file?.paperMetadata || defaultPaperMetadata || null
    })
  })).filter((file) => file.name && file.contentBase64);
}

function createApiRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function normalizeServerImportFile(serverFilePath = '', paperMetadata = null) {
  const normalizedPath = String(serverFilePath || '').trim();
  if (!normalizedPath) {
    return [];
  }

  if (!isServerPathReference(normalizedPath)) {
    throw createApiRequestError('`serverFilePath` must be an absolute path or `~/...` path on the API server.');
  }

  const resolvedPath = resolveServerPathReference(normalizedPath);

  let stats = null;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createApiRequestError(`No file exists at \`serverFilePath\`: ${normalizedPath}`);
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw createApiRequestError('`serverFilePath` must point to a regular file. Directory recursion is not supported.');
  }

  return [
    {
      name: path.basename(resolvedPath),
      mimeType: '',
      content: await fs.readFile(resolvedPath),
      paperMetadata
    }
  ];
}

async function normalizeImportRequest(body = {}) {
  const topLevelPaperMetadata = normalizeImportPaperMetadata(body.paperMetadata || body || {});
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  const uploadedFiles = normalizeImportFiles(
    rawFiles,
    rawFiles.length === 1 ? topLevelPaperMetadata : null
  );
  const serverFilePath = String(body?.serverFilePath || '').trim();

  if (serverFilePath && uploadedFiles.length) {
    throw createApiRequestError('Provide either `files` or `serverFilePath`, not both.');
  }

  if (serverFilePath) {
    const serverFiles = await normalizeServerImportFile(serverFilePath, topLevelPaperMetadata);
    if (!hasImportPaperIdentity(topLevelPaperMetadata || {})) {
      throw createApiRequestError(formatRequiredPaperIdentifierMessage());
    }
    return serverFiles;
  }

  if (rawFiles.length > 1 && hasImportPaperIdentity(topLevelPaperMetadata || {})) {
    throw createApiRequestError('When uploading multiple files, attach per-file paper identity metadata instead of one top-level identifier block.');
  }

  for (const file of uploadedFiles) {
    if (!hasImportPaperIdentity(file.paperMetadata || {})) {
      throw createApiRequestError(`Uploaded file "${file.name}" is missing a precise identifier. ${formatRequiredPaperIdentifierMessage()}`);
    }
  }

  return uploadedFiles;
}

async function resolveImportInputPaths(rootPath, options = {}) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestInputs = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  if (manifestInputs.length) {
    return manifestInputs;
  }

  const configuredInputs = Array.isArray(options.config?.sources?.inputs)
    ? options.config.sources.inputs
    : [];
  const baseDir = options.configBaseDir || process.cwd();
  return configuredInputs
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => resolvePathWithHome(item, baseDir));
}

async function notifyImportTaskCreated(rootPath, task, payload, options = {}) {
  const callback = options.onImportTaskCreated || options.onImportSubmitted;
  if (typeof callback !== 'function') return;
  if (task?.deduped || String(task?.status || '').trim().toLowerCase() === 'completed') return;

  try {
    await callback({
      rootPath,
      task,
      payload
    });
  } catch (error) {
    options.logger?.warn?.(`[imports] import task notification failed (${error.message || error})`);
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function getImportConfigSection(options = {}, name) {
  const section = options.config?.[name];
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

function pickImportQueueLockOptions(options = {}) {
  const importsConfig = getImportConfigSection(options, 'imports');
  const importConfig = getImportConfigSection(options, 'import');
  return {
    importQueueLockTimeoutMs: firstConfiguredValue(
      options.importQueueLockTimeoutMs,
      options.queueLockTimeoutMs,
      importsConfig.importQueueLockTimeoutMs,
      importsConfig.queueLockTimeoutMs,
      importConfig.importQueueLockTimeoutMs,
      importConfig.queueLockTimeoutMs
    ),
    importQueueLockStaleMs: firstConfiguredValue(
      options.importQueueLockStaleMs,
      options.queueLockStaleMs,
      importsConfig.importQueueLockStaleMs,
      importsConfig.queueLockStaleMs,
      importConfig.importQueueLockStaleMs,
      importConfig.queueLockStaleMs
    ),
    importQueueLockHeartbeatIntervalMs: firstConfiguredValue(
      options.importQueueLockHeartbeatIntervalMs,
      options.queueLockHeartbeatIntervalMs,
      importsConfig.importQueueLockHeartbeatIntervalMs,
      importsConfig.queueLockHeartbeatIntervalMs,
      importConfig.importQueueLockHeartbeatIntervalMs,
      importConfig.queueLockHeartbeatIntervalMs
    )
  };
}

function pickConfiguredImportExecutionMode(options = {}) {
  const importsConfig = getImportConfigSection(options, 'imports');
  const importConfig = getImportConfigSection(options, 'import');
  return firstNonEmptyString(
    options.importExecutionMode,
    options.import_execution_mode,
    options.importsExecutionMode,
    options.imports_execution_mode,
    importsConfig.importExecutionMode,
    importsConfig.import_execution_mode,
    importsConfig.executionMode,
    importConfig.importExecutionMode,
    importConfig.import_execution_mode,
    importConfig.executionMode
  );
}

function pickImportTaskExecutionOptions(body = {}, options = {}) {
  const requestImportExecutionMode = firstNonEmptyString(
    body.importExecutionMode,
    body.import_execution_mode,
    body.importsExecutionMode,
    body.imports_execution_mode
  );
  const configuredImportExecutionMode = requestImportExecutionMode
    ? ''
    : pickConfiguredImportExecutionMode(options);
  return {
    processingProfile: body.processingProfile || body.processing_profile || body.importProfile || body.import_profile,
    completionPolicy: body.completionPolicy || body.completion_policy,
    importExecutionMode: requestImportExecutionMode || configuredImportExecutionMode || undefined,
    importExecutionModeSource: requestImportExecutionMode
      ? 'request'
      : configuredImportExecutionMode
        ? 'config'
        : undefined,
    llmContextWindowTokens: body.llmContextWindowTokens || body.llm_context_window_tokens || body.contextWindowTokens || body.context_window_tokens,
    llmExtractionStrategy: body.llmExtractionStrategy || body.llm_extraction_strategy,
    llmLongContextMaxPapersPerCall: body.llmLongContextMaxPapersPerCall || body.llm_long_context_max_papers_per_call,
    llmBatchConcurrency: body.llmBatchConcurrency || body.llm_batch_concurrency || body.batchConcurrency || body.batch_concurrency,
    llmConfigSource: body.llmContextWindowTokens || body.llm_context_window_tokens || body.contextWindowTokens || body.context_window_tokens
      || body.llmExtractionStrategy || body.llm_extraction_strategy
      || body.llmLongContextMaxPapersPerCall || body.llm_long_context_max_papers_per_call
      || body.llmBatchConcurrency || body.llm_batch_concurrency || body.batchConcurrency || body.batch_concurrency
      ? 'request'
      : undefined
  };
}

export async function createImportTaskPayload(candidate, body = {}, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const files = await normalizeImportRequest(body);
  if (!files.length) {
    throw createApiRequestError('At least one uploaded file is required.');
  }

  const inputPaths = await resolveImportInputPaths(rootPath, options);
  const task = await createImportTask(rootPath, {
    trigger: body.trigger || 'api',
    inputPaths,
    files,
    ...pickImportTaskExecutionOptions(body, options),
    ...pickImportQueueLockOptions(options)
  });

  let identifierSync = null;
  if (task?.deduped && String(task?.status || '').trim().toLowerCase() === 'completed') {
    const { backfillPaperIdentifiers } = await import('../core/ingestion/pipeline.js');
    const syncResults = [];
    for (const file of task.files || []) {
      if (!hasAnyPaperIdentifiers(file.paperMetadata || {})) continue;
      syncResults.push(await backfillPaperIdentifiers(rootPath, {
        sourcePaths: [file.storedPath],
        identifiers: file.paperMetadata.identifiers
      }));
    }
    identifierSync = {
      updated: syncResults.some((entry) => entry.updated),
      results: syncResults
    };
  }

  const payload = presentPortablePayload({
    rootPath,
    task,
    deduped: Boolean(task?.deduped),
    identifierSync,
    generatedAt: new Date().toISOString()
  }, options);
  await notifyImportTaskCreated(rootPath, task, payload, options);
  return payload;
}

export async function listImportTasksPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const payload = await listImportTasks(rootPath, pickImportQueueLockOptions(options));
  return presentPortablePayload({
    rootPath,
    summary: payload.summary,
    tasks: payload.tasks,
    generatedAt: new Date().toISOString()
  }, options);
}

export async function importTaskPayload(candidate, taskId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!taskId) {
    throw new Error('taskId is required.');
  }
  const listed = await listImportTasks(rootPath, pickImportQueueLockOptions(options));
  const task = (listed.tasks || []).find((entry) => entry.id === taskId) || await loadImportTask(rootPath, taskId);
  if (!task) {
    throw new Error(`No import task found for ${taskId}.`);
  }
  return presentPortablePayload({
    rootPath,
    task,
    queueSummary: listed.summary,
    generatedAt: new Date().toISOString()
  }, options);
}

export async function importTaskLogPayload(candidate, taskId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!taskId) {
    throw new Error('taskId is required.');
  }
  const task = await loadImportTask(rootPath, taskId);
  if (!task) {
    throw new Error(`No import task found for ${taskId}.`);
  }
  return presentPortablePayload({
    rootPath,
    taskId,
    log: await loadImportTaskLog(rootPath, taskId),
    eventLedger: await tailImportTaskEvents(rootPath, taskId, {
      tail: options.eventTail ?? options.event_tail ?? options.tailEvents ?? options.tail_events ?? 50
    }),
    generatedAt: new Date().toISOString()
  }, options);
}

export async function enhancementSummaryPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  const stamp = `${await readPathStamp(queuePath)}|${await readPathStamp(indexPath)}`;

  if (!cache?.enhancementSummaryByRoot) {
    return {
      rootPath,
      enhancements: await summarizeEnhancements(rootPath)
    };
  }

  return resolveCachedPayload(cache.enhancementSummaryByRoot, rootPath, stamp, async () => ({
    rootPath,
    enhancements: await summarizeEnhancements(rootPath)
  }));
}

export async function paperEnhancementPayload(candidate, paperId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!paperId) {
    throw new Error('paperId is required.');
  }

  const cache = options.cache;
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  const overlayPath = getPaperEnhancementPath(rootPath, paperId);
  const stamp = `${await readPathStamp(queuePath)}|${await readPathStamp(indexPath)}|${await readPathStamp(overlayPath)}`;
  const cacheKey = `${rootPath}:${paperId}`;

  if (!cache?.enhancementPaperByKey) {
    const payload = await loadPaperEnhancement(rootPath, paperId);
    if (!payload.overlay) {
      throw new Error(`No enhancement overlay found for paper ${paperId}.`);
    }
    return {
      rootPath,
      paperId,
      ...payload
    };
  }

  return resolveCachedPayload(cache.enhancementPaperByKey, cacheKey, stamp, async () => {
    const payload = await loadPaperEnhancement(rootPath, paperId);
    if (!payload.overlay) {
      throw new Error(`No enhancement overlay found for paper ${paperId}.`);
    }
    return {
      rootPath,
      paperId,
      ...payload
    };
  });
}

function normalizeLlmProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'anthropic') return 'anthropic';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'deepseek') return 'deepseek';
  return 'ollama';
}

export function llmConfigPayload(config = {}) {
  const effective = resolveLlmConfig({
    llmProvider: config?.llm?.provider,
    llmModel: config?.llm?.model,
    llmBaseUrl: config?.llm?.baseUrl || config?.llm?.url,
    llmApiKeyEnv: config?.llm?.apiKeyEnv,
    llmApiKeySource: config?.llm?.apiKeySource,
    llmApiKeyService: config?.llm?.apiKeyService,
    llmApiKeyAccount: config?.llm?.apiKeyAccount,
    llmRelations: config?.llm?.relations,
    llmTimeoutMs: config?.llm?.timeoutMs,
    llmBatchSize: config?.llm?.batchSize,
    llmMaxTokens: config?.llm?.maxTokens,
    llmSshHost: config?.llm?.sshHost,
    ollamaModel: config?.ollama?.model,
    ollamaUrl: config?.ollama?.url,
    ollamaRelations: config?.ollama?.relations,
    ollamaTimeoutMs: config?.ollama?.timeoutMs,
    ollamaBatchSize: config?.ollama?.batchSize,
    ollamaSshHost: config?.ollama?.sshHost
  });

  return {
    llm: {
      provider: effective.provider,
      model: effective.model,
      baseUrl: effective.baseUrl,
      apiKeySource: config?.llm?.apiKeySource || effective.apiKeySource || '',
      apiKeyEnv: config?.llm?.apiKeyEnv || effective.apiKeyEnv || '',
      relations: effective.enabled,
      timeoutMs: effective.timeoutMs,
      batchSize: effective.batchSize,
      batchConcurrency: config?.llm?.batchConcurrency ?? config?.llm?.llmBatchConcurrency,
      contextWindowTokens: config?.llm?.contextWindowTokens ?? config?.llm?.llmContextWindowTokens,
      maxTokens: effective.maxTokens,
      sshHost: effective.sshHost || '',
      apiKeyService: config?.llm?.apiKeyService || effective.apiKeyService || '',
      apiKeyAccount: config?.llm?.apiKeyAccount || effective.apiKeyAccount || '',
      source: config?.llm ? 'llm' : config?.ollama ? 'ollama-legacy' : 'defaults'
    }
  };
}

export async function updateLlmConfigPayload(nextLlmConfig, options = {}) {
  const currentConfig = options.config && typeof options.config === 'object' ? options.config : {};
  const provider = normalizeLlmProvider(nextLlmConfig?.provider || currentConfig?.llm?.provider || currentConfig?.ollama?.provider || 'ollama');
  const model = String(nextLlmConfig?.model || '').trim();

  if (!model) {
    throw new Error('LLM model is required.');
  }

  const previousProvider = normalizeLlmProvider(currentConfig?.llm?.provider || currentConfig?.ollama?.provider || 'ollama');
  const previousBaseUrl = currentConfig?.llm?.baseUrl || currentConfig?.llm?.url || '';
  const previousDefaultAccount = buildDefaultLlmKeychainAccount({
    provider: previousProvider,
    baseUrl: previousBaseUrl || getDefaultLlmBaseUrl(previousProvider)
  });
  const shouldRotateBaseUrl = !previousBaseUrl || previousBaseUrl === getDefaultLlmBaseUrl(previousProvider);
  const nextBaseUrl = shouldRotateBaseUrl ? getDefaultLlmBaseUrl(provider) : previousBaseUrl;
  const currentApiKeyEnv = currentConfig?.llm?.apiKeyEnv || '';
  const previousDefaultApiKeyEnv = getDefaultLlmApiKeyEnv(previousProvider);
  const shouldRotateApiKeyEnv = !currentApiKeyEnv || currentApiKeyEnv === previousDefaultApiKeyEnv;
  const currentApiKeyAccount = currentConfig?.llm?.apiKeyAccount || '';
  const shouldRotateApiKeyAccount = !currentApiKeyAccount || currentApiKeyAccount === previousDefaultAccount;
  const nextConfig = {
    ...currentConfig,
    llm: {
      ...(currentConfig.llm || {}),
      provider,
      model,
      baseUrl: nextBaseUrl,
      relations: currentConfig?.llm?.relations ?? currentConfig?.ollama?.relations ?? true,
      timeoutMs: currentConfig?.llm?.timeoutMs ?? currentConfig?.ollama?.timeoutMs,
      batchSize: provider === 'deepseek' ? 1 : currentConfig?.llm?.batchSize ?? currentConfig?.ollama?.batchSize,
      batchConcurrency: nextLlmConfig?.batchConcurrency ?? nextLlmConfig?.llmBatchConcurrency ?? currentConfig?.llm?.batchConcurrency,
      contextWindowTokens: nextLlmConfig?.contextWindowTokens ?? nextLlmConfig?.llmContextWindowTokens ?? currentConfig?.llm?.contextWindowTokens,
      maxTokens: currentConfig?.llm?.maxTokens,
      apiKeyEnv: shouldRotateApiKeyEnv
        ? getDefaultLlmApiKeyEnv(provider)
        : currentApiKeyEnv,
      apiKeySource: currentConfig?.llm?.apiKeySource,
      apiKeyService: currentConfig?.llm?.apiKeyService,
      apiKeyAccount: shouldRotateApiKeyAccount
        ? buildDefaultLlmKeychainAccount({ provider, baseUrl: nextBaseUrl })
        : currentApiKeyAccount,
      sshHost: currentConfig?.llm?.sshHost ?? currentConfig?.ollama?.sshHost
    }
  };

  const saved = await saveRuntimeConfig(nextConfig, {
    cwd: options.configBaseDir,
    path: options.configPath
  });

  return {
    ...llmConfigPayload(saved.config),
    configPath: saved.path,
    message: 'LLM configuration saved. Restart any running analyze/watch process to apply it there.'
  };
}
