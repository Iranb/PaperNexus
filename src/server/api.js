import fs from 'node:fs/promises';
import path from 'node:path';
import { backupCorpus, loadCorpus, loadCorpusLite, loadCorpusMeta, loadSourceManifest, resolveCorpus } from '../storage/corpus-store.js';
import { resolveLlmConfig, getDefaultLlmApiKeyEnv, getDefaultLlmBaseUrl } from '../core/llm/ollama.js';
import { getNodeLayer, NODE_TYPES } from '../core/graph/schema.js';
import { resolvePathWithHome, saveRuntimeConfig } from '../lib/config.js';
import { buildDefaultLlmKeychainAccount } from '../lib/keychain.js';
import { getCorpusPaths } from '../storage/corpus-store.js';
import { getRegistryPath, loadRegistry } from '../storage/registry.js';
import { getEnhancementPaths, getPaperEnhancementPath, loadPaperEnhancement, summarizeEnhancements } from '../storage/enhancement-store.js';
import {
  createImportTask,
  listImportTasks,
  loadImportTask,
  loadImportTaskLog
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

export async function getConfiguredRootPath(options = {}) {
  const raw = options.config?.storage?.indexDir;
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const rootPath = resolvePathWithHome(raw.trim(), options.configBaseDir || process.cwd());
  const { metaPath } = getCorpusPaths(rootPath);
  return (await fileExists(metaPath)) ? rootPath : null;
}

async function loadConfiguredCorpusEntry(options = {}) {
  const rootPath = await getConfiguredRootPath(options);
  if (!rootPath) {
    return null;
  }

  try {
    const meta = await loadCorpusMeta(rootPath);
    return {
      name: meta.name,
      rootPath,
      indexedAt: meta.indexedAt,
      paperCount: meta.paperCount
    };
  } catch {
    return null;
  }
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
  const configuredCorpus = await loadConfiguredCorpusEntry(options);
  if (configuredCorpus) {
    return {
      corpora: [configuredCorpus],
      generatedAt: new Date().toISOString()
    };
  }

  const registryPath = getRegistryPath();
  const cache = options.cache;
  const stamp = await readPathStamp(registryPath);

  if (!cache?.corporaByPath) {
    const registry = await loadRegistry();
    return {
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    };
  }

  return resolveCachedPayload(cache.corporaByPath, registryPath, stamp, async () => {
    const registry = await loadRegistry();
    return {
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    };
  });
}

export async function resolveCorpusForApi(candidate, options = {}) {
  const configuredRoot = await getConfiguredRootPath(options);
  if (configuredRoot) {
    if (!candidate) {
      return configuredRoot;
    }

    try {
      const configuredMeta = await loadCorpusMeta(configuredRoot);
      if (
        candidate === configuredRoot
        || candidate === configuredMeta.name
      ) {
        return configuredRoot;
      }
    } catch {
      // Fall through to legacy resolution paths when the configured root is unavailable.
    }
  }

  if (candidate) {
    return resolveCorpus(candidate);
  }

  const registryPayload = await listCorporaPayload(options);
  if (!registryPayload.corpora.length) {
    throw new Error(
      'No indexed corpora found. Analyze or import an already-provided paper/corpus first; '
      + 'PaperNexus does not discover external literature for you.'
    );
  }

  return registryPayload.corpora[0].rootPath;
}

export async function corpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const stamp = await readPathStamp(getCorpusPaths(rootPath).metaPath);

  if (!cache?.corpusByRoot) {
    const { meta, graph } = await loadCorpus(rootPath);
    return {
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    };
  }

  return resolveCachedPayload(cache.corpusByRoot, rootPath, stamp, async () => {
    const { meta, graph } = await loadCorpus(rootPath);
    return {
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    };
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

function normalizeQueryOptions(options = {}) {
  return {
    limit: Number(options.limit || 5),
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
    maxDepth: Number(options.maxDepth || options.depth || 3),
    layers: options.layers,
    layerMode: options.layerMode || 'any',
    relationTypes: Array.isArray(options.relationTypes) ? options.relationTypes : undefined,
    nodeView: options.nodeView || 'all'
  };
}

function normalizeIdeasOptions(options = {}) {
  return {
    limit: Number(options.limit || 5),
    layers: options.layers
  };
}

function normalizeBrainstormOptions(options = {}) {
  return {
    mode: options.mode || 'diverge',
    maxHops: Number(options.maxHops || options.hops || 2),
    limit: Number(options.limit || 5),
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
  const abstractChallenge = String(body?.abstractChallenge || body?.challenge || body?.query || '').trim();

  return {
    candidate: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
    targetDomain,
    abstractChallenge,
    mechanisms: normalizeMechanismList(body?.mechanisms || body?.mechanism || rawOptions.mechanisms),
    options: rawOptions
  };
}

async function buildGraphSearchPayload(candidate, body, options, buildResult) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  return {
    rootPath,
    result: buildResult(graph, request.query, request.options),
    generatedAt: new Date().toISOString()
  };
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

export async function catalystGraphPayload(candidate, body = {}, options = {}) {
  const request = normalizeCatalystRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);

  return {
    rootPath,
    result: buildCatalystQuery(graph, {
      targetDomain: request.targetDomain,
      abstractChallenge: request.abstractChallenge,
      mechanisms: request.mechanisms,
      limit: Number(request.options.limit || 5)
    }),
    generatedAt: new Date().toISOString()
  };
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
    limit: Number(options.limit || 8),
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
    limit: Number(options.limit || 6),
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
    .slice(0, Number(options.limit || 5));
}

function resolvePathTraceOptions(options = {}) {
  return {
    maxDepth: Number(options.maxDepth || 4),
    maxPaths: Number(options.maxPaths || options.limit || 3),
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
  const limit = Number(options.limit || 5);
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

  return {
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
  };
}

export async function evidenceChainPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const relevantPapers = collectRelevantPaperNodes(graph, request.query, request.options);
  const chains = relevantPapers.map((paper) => buildEvidenceChainsForPaper(graph, paper));

  return {
    rootPath,
    result: {
      query: request.query,
      chains
    },
    generatedAt: new Date().toISOString()
  };
}

export async function reflectionChainPayload(candidate, body = {}, options = {}) {
  const request = normalizeGraphRequestBody(body);
  const effectiveCandidate = request.candidate || candidate;
  const rootPath = await resolveCorpusForApi(effectiveCandidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const overlayPapers = await collectOverlayPapers(rootPath, graph, request.query, request.options);

  return {
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
  };
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

  return {
    rootPath,
    result: {
      query: request.query,
      papers,
      openRisks: summarizeOpenRisks(papers)
    },
    generatedAt: new Date().toISOString()
  };
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

  return {
    rootPath,
    result: {
      query: request.query,
      papers,
      openRisks: summarizeOpenRisks(papers)
    },
    generatedAt: new Date().toISOString()
  };
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

  return {
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
  };
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
        limit: Math.min(3, Number(request.options?.limit || 3))
      }
    }, options)
  ]);

  return {
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
  };
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

    return {
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
    };
  };

  if (!cache?.corpusMetaByRoot) {
    return buildPayload();
  }

  return resolveCachedPayload(cache.corpusMetaByRoot, rootPath, stamp, buildPayload);
}

export async function corpusSourcesPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const [meta, manifest] = await Promise.all([
    loadCorpusMeta(rootPath),
    loadSourceManifest(rootPath)
  ]);
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];

  return {
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
    sources,
    generatedAt: new Date().toISOString()
  };
}

export async function backupCorpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate);
  return {
    backup: await backupCorpus(rootPath, {
      backupDir: options.backupDir
    }),
    generatedAt: new Date().toISOString()
  };
}

function normalizeImportFiles(files = []) {
  const normalized = Array.isArray(files) ? files : [];
  return normalized.map((file) => ({
    name: String(file?.name || '').trim(),
    mimeType: String(file?.mimeType || '').trim(),
    contentBase64: String(file?.contentBase64 || '').trim()
  })).filter((file) => file.name && file.contentBase64);
}

function createApiRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function normalizeServerImportFile(serverFilePath = '') {
  const normalizedPath = String(serverFilePath || '').trim();
  if (!normalizedPath) {
    return [];
  }

  if (!path.isAbsolute(normalizedPath)) {
    throw createApiRequestError('`serverFilePath` must be an absolute path on the API server.');
  }

  let stats = null;
  try {
    stats = await fs.stat(normalizedPath);
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
      name: path.basename(normalizedPath),
      mimeType: '',
      content: await fs.readFile(normalizedPath)
    }
  ];
}

async function normalizeImportRequest(body = {}) {
  const uploadedFiles = normalizeImportFiles(body.files);
  const serverFilePath = String(body?.serverFilePath || '').trim();

  if (serverFilePath && uploadedFiles.length) {
    throw createApiRequestError('Provide either `files` or `serverFilePath`, not both.');
  }

  if (serverFilePath) {
    return normalizeServerImportFile(serverFilePath);
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
  return configuredInputs.map((item) => String(item || '').trim()).filter(Boolean);
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
    files
  });

  return {
    rootPath,
    task,
    deduped: Boolean(task?.deduped),
    generatedAt: new Date().toISOString()
  };
}

export async function listImportTasksPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const payload = await listImportTasks(rootPath);
  return {
    rootPath,
    summary: payload.summary,
    tasks: payload.tasks,
    generatedAt: new Date().toISOString()
  };
}

export async function importTaskPayload(candidate, taskId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!taskId) {
    throw new Error('taskId is required.');
  }
  const listed = await listImportTasks(rootPath);
  const task = (listed.tasks || []).find((entry) => entry.id === taskId) || await loadImportTask(rootPath, taskId);
  if (!task) {
    throw new Error(`No import task found for ${taskId}.`);
  }
  return {
    rootPath,
    task,
    queueSummary: listed.summary,
    generatedAt: new Date().toISOString()
  };
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
  return {
    rootPath,
    taskId,
    log: await loadImportTaskLog(rootPath, taskId),
    generatedAt: new Date().toISOString()
  };
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
      batchSize: currentConfig?.llm?.batchSize ?? currentConfig?.ollama?.batchSize,
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
