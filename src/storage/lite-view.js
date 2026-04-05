import {
  buildTokenIndex,
  createLiteGraphPayload,
  createLiteNodePayload,
  createLiteRelationshipPayload,
  getLiteNodeSearchTokens
} from '../core/graph/lite.js';
import { buildBrainstormViewPayload } from '../core/graph/brainstorm-view.js';
import { readJson, writeJson } from '../lib/fs.js';

const LITE_VIEW_VERSION = 1;
export const GLOBAL_SOURCE_KEY = '__global__';

function pickLiteDerivedPayload(derived = {}) {
  const payload = {};
  if (derived?.domainDistanceMatrix) {
    payload.domainDistanceMatrix = derived.domainDistanceMatrix;
  }
  return payload;
}

function cloneIdList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(Boolean))].sort() : [];
}

function cloneRefMap(value) {
  const entries = Object.entries(value || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([id, count]) => [id, Number(count)]);
  return Object.fromEntries(entries);
}

function escapeKey(value) {
  return String(value || '').trim();
}

function addMembership(target, sourceKey, id) {
  if (!sourceKey || !id) return;
  if (!target.has(sourceKey)) target.set(sourceKey, new Set());
  target.get(sourceKey).add(id);
}

function normalizeLiteState(state) {
  const normalized = {
    version: LITE_VIEW_VERSION,
    sources: {},
    nodeRefs: cloneRefMap(state?.nodeRefs),
    relationshipRefs: cloneRefMap(state?.relationshipRefs)
  };

  for (const [sourceKey, entry] of Object.entries(state?.sources || {})) {
    normalized.sources[sourceKey] = {
      sourceKey,
      paperId: entry?.paperId || '',
      paperTitle: entry?.paperTitle || '',
      fingerprint: entry?.fingerprint || '',
      nodeIds: cloneIdList(entry?.nodeIds),
      relationshipIds: cloneIdList(entry?.relationshipIds)
    };
  }

  return normalized;
}

function buildSourceResolvers(currentSources = []) {
  const byPaperId = new Map();
  const byPaperTitle = new Map();

  for (const source of currentSources) {
    const sourceKey = escapeKey(source.sourceKey);
    if (!sourceKey) continue;

    const paperId = escapeKey(source.paperId);
    const paperTitle = escapeKey(source.paperTitle);

    if (paperId) {
      if (!byPaperId.has(paperId)) byPaperId.set(paperId, new Set());
      byPaperId.get(paperId).add(sourceKey);
    }

    if (paperTitle) {
      if (!byPaperTitle.has(paperTitle)) byPaperTitle.set(paperTitle, new Set());
      byPaperTitle.get(paperTitle).add(sourceKey);
    }
  }

  return {
    byPaperId,
    byPaperTitle
  };
}

function collectNodeSourceKeys(node, resolvers) {
  const keys = new Set();
  const addPaperId = (value) => {
    const normalized = escapeKey(value);
    if (!normalized) return;
    for (const sourceKey of resolvers.byPaperId.get(normalized) || []) {
      keys.add(sourceKey);
    }
  };
  const addPaperTitle = (value) => {
    const normalized = escapeKey(value);
    if (!normalized) return;
    for (const sourceKey of resolvers.byPaperTitle.get(normalized) || []) {
      keys.add(sourceKey);
    }
  };

  addPaperId(node.id);
  addPaperId(node.properties?.paperId);
  addPaperTitle(node.properties?.paperTitle);

  for (const title of node.properties?.paperTitles || []) {
    addPaperTitle(title);
  }

  return keys.size ? [...keys].sort() : [GLOBAL_SOURCE_KEY];
}

function collectRelationshipSourceKeys(relationship, sourceNodeKeys = [], targetNodeKeys = [], resolvers) {
  const keys = new Set();
  const addPaperId = (value) => {
    const normalized = escapeKey(value);
    if (!normalized) return;
    for (const sourceKey of resolvers.byPaperId.get(normalized) || []) {
      keys.add(sourceKey);
    }
  };
  const addPaperTitle = (value) => {
    const normalized = escapeKey(value);
    if (!normalized) return;
    for (const sourceKey of resolvers.byPaperTitle.get(normalized) || []) {
      keys.add(sourceKey);
    }
  };

  addPaperId(relationship.properties?.sourcePaperId);
  addPaperTitle(relationship.properties?.sourcePaperTitle);

  for (const key of sourceNodeKeys) {
    if (key && key !== GLOBAL_SOURCE_KEY) keys.add(key);
  }
  for (const key of targetNodeKeys) {
    if (key && key !== GLOBAL_SOURCE_KEY) keys.add(key);
  }

  return keys.size ? [...keys].sort() : [GLOBAL_SOURCE_KEY];
}

function buildLiteMembership(graph, currentSources = []) {
  const resolvers = buildSourceResolvers(currentSources);
  const nodeMembership = new Map();
  const nodeIdsBySource = new Map();
  const relationshipIdsBySource = new Map();

  for (const node of graph.nodes) {
    const sourceKeys = collectNodeSourceKeys(node, resolvers);
    nodeMembership.set(node.id, sourceKeys);
    for (const sourceKey of sourceKeys) {
      addMembership(nodeIdsBySource, sourceKey, node.id);
    }
  }

  for (const relationship of graph.relationships) {
    const sourceKeys = collectRelationshipSourceKeys(
      relationship,
      nodeMembership.get(relationship.sourceId) || [],
      nodeMembership.get(relationship.targetId) || [],
      resolvers
    );
    for (const sourceKey of sourceKeys) {
      addMembership(relationshipIdsBySource, sourceKey, relationship.id);
    }
  }

  return {
    nodeIdsBySource,
    relationshipIdsBySource
  };
}

function sourceFingerprintOf(source = {}) {
  return escapeKey(source.sourceFingerprint || source.fingerprint || '');
}

function createSourceEntry(source, nodeIds = [], relationshipIds = []) {
  return {
    sourceKey: escapeKey(source?.sourceKey),
    paperId: escapeKey(source?.paperId),
    paperTitle: escapeKey(source?.paperTitle),
    fingerprint: sourceFingerprintOf(source),
    nodeIds: cloneIdList(nodeIds),
    relationshipIds: cloneIdList(relationshipIds)
  };
}

function createGlobalEntry(nodeIds = [], relationshipIds = []) {
  return {
    sourceKey: GLOBAL_SOURCE_KEY,
    paperId: '',
    paperTitle: '',
    fingerprint: GLOBAL_SOURCE_KEY,
    nodeIds: cloneIdList(nodeIds),
    relationshipIds: cloneIdList(relationshipIds)
  };
}

function normalizeSourceEntry(entry = {}) {
  return {
    sourceKey: escapeKey(entry.sourceKey),
    paperId: escapeKey(entry.paperId),
    paperTitle: escapeKey(entry.paperTitle),
    fingerprint: sourceFingerprintOf(entry),
    nodeIds: cloneIdList(entry.nodeIds),
    relationshipIds: cloneIdList(entry.relationshipIds)
  };
}

function removeNodeTokens(indexMap, node) {
  if (!node) return;
  for (const token of getLiteNodeSearchTokens(node)) {
    const ids = indexMap.get(token);
    if (!ids) continue;
    ids.delete(node.id);
    if (!ids.size) indexMap.delete(token);
  }
}

function addNodeTokens(indexMap, node) {
  if (!node) return;
  for (const token of getLiteNodeSearchTokens(node)) {
    if (!indexMap.has(token)) indexMap.set(token, new Set());
    indexMap.get(token).add(node.id);
  }
}

function buildTokenSetIndex(nodes) {
  const raw = buildTokenIndex(nodes);
  return new Map(
    Object.entries(raw).map(([token, ids]) => [token, new Set(ids)])
  );
}

function serializeTokenIndex(indexMap) {
  return Object.fromEntries(
    [...indexMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([token, ids]) => [token, [...ids].sort()])
  );
}

function hydratePayloadMaps(payload = {}) {
  const nodes = new Map((payload.nodes || []).map((node) => [node.id, node]));
  const relationships = new Map((payload.relationships || []).map((relationship) => [relationship.id, relationship]));
  const tokenIndex = buildTokenSetIndex([...nodes.values()]);
  const derived = pickLiteDerivedPayload(payload.derived);

  return {
    nodes,
    relationships,
    tokenIndex,
    derived
  };
}

function serializePayload(payloadMaps) {
  const nodes = [...payloadMaps.nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const relationships = [...payloadMaps.relationships.values()].sort((left, right) => left.id.localeCompare(right.id));
  const derived = pickLiteDerivedPayload(payloadMaps.derived);
  return {
    nodes,
    relationships,
    indexes: {
      searchTokens: serializeTokenIndex(payloadMaps.tokenIndex)
    },
    views: {
      brainstorm: buildBrainstormViewPayload(nodes)
    },
    ...(Object.keys(derived).length ? { derived } : {})
  };
}

function incrementRefCount(refs, id) {
  refs[id] = Number(refs[id] || 0) + 1;
}

function decrementRefCount(refs, id) {
  const next = Number(refs[id] || 0) - 1;
  if (next > 0) {
    refs[id] = next;
    return next;
  }
  delete refs[id];
  return 0;
}

function applyNodeProjection(payloadMaps, graphNode) {
  const nextNode = createLiteNodePayload(graphNode);
  const previousNode = payloadMaps.nodes.get(nextNode.id);
  if (previousNode) {
    removeNodeTokens(payloadMaps.tokenIndex, previousNode);
  }
  payloadMaps.nodes.set(nextNode.id, nextNode);
  addNodeTokens(payloadMaps.tokenIndex, nextNode);
}

function removeNodeProjection(payloadMaps, nodeId) {
  const previousNode = payloadMaps.nodes.get(nodeId);
  if (!previousNode) return;
  removeNodeTokens(payloadMaps.tokenIndex, previousNode);
  payloadMaps.nodes.delete(nodeId);
}

function applyRelationshipProjection(payloadMaps, graphRelationship) {
  payloadMaps.relationships.set(graphRelationship.id, createLiteRelationshipPayload(graphRelationship));
}

function removeRelationshipProjection(payloadMaps, relationshipId) {
  payloadMaps.relationships.delete(relationshipId);
}

function buildFullLiteState(graph, currentSources = []) {
  const membership = buildLiteMembership(graph, currentSources);
  const state = normalizeLiteState();
  const currentSourceMap = new Map((currentSources || []).map((source) => [escapeKey(source.sourceKey), source]));

  for (const node of graph.nodes) {
    state.nodeRefs[node.id] = 0;
  }

  for (const relationship of graph.relationships) {
    state.relationshipRefs[relationship.id] = 0;
  }

  for (const [sourceKey, source] of currentSourceMap.entries()) {
    const nodeIds = [...(membership.nodeIdsBySource.get(sourceKey) || new Set())];
    const relationshipIds = [...(membership.relationshipIdsBySource.get(sourceKey) || new Set())];
    state.sources[sourceKey] = createSourceEntry(source, nodeIds, relationshipIds);

    for (const nodeId of nodeIds) incrementRefCount(state.nodeRefs, nodeId);
    for (const relationshipId of relationshipIds) incrementRefCount(state.relationshipRefs, relationshipId);
  }

  const globalNodeIds = [...(membership.nodeIdsBySource.get(GLOBAL_SOURCE_KEY) || new Set())];
  const globalRelationshipIds = [...(membership.relationshipIdsBySource.get(GLOBAL_SOURCE_KEY) || new Set())];
  state.sources[GLOBAL_SOURCE_KEY] = createGlobalEntry(globalNodeIds, globalRelationshipIds);
  for (const nodeId of globalNodeIds) incrementRefCount(state.nodeRefs, nodeId);
  for (const relationshipId of globalRelationshipIds) incrementRefCount(state.relationshipRefs, relationshipId);

  return state;
}

export function buildLiteStateSnapshot(graph, currentSources = []) {
  return buildFullLiteState(graph, currentSources);
}

export async function saveLiteGraphMaterializedView(rootPath, graph, options = {}) {
  const liteGraphPath = options.liteGraphPath;
  const liteStatePath = options.liteStatePath;
  const currentSources = Array.isArray(options.currentSources) ? options.currentSources : null;
  const incremental = Boolean(options.incremental && currentSources);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const reportProgress = (label) => {
    onProgress?.({
      phase: 'lite-view',
      label
    });
  };

  if (!incremental || !liteGraphPath || !liteStatePath) {
    reportProgress('writing full lite graph payload');
    await writeJson(liteGraphPath, createLiteGraphPayload(graph, {
      derived: options.derived
    }));
    if (liteStatePath && currentSources) {
      reportProgress('writing full lite graph state');
      await writeJson(liteStatePath, buildFullLiteState(graph, currentSources));
    }
    return;
  }

  reportProgress('loading previous lite graph state');
  const [previousPayload, previousStateRaw] = await Promise.all([
    readJson(liteGraphPath, null),
    readJson(liteStatePath, null)
  ]);

  if (!previousPayload || !previousStateRaw || previousStateRaw.version !== LITE_VIEW_VERSION) {
    reportProgress('rebuilding lite graph payload from scratch');
    await writeJson(liteGraphPath, createLiteGraphPayload(graph, {
      derived: options.derived
    }));
    reportProgress('rebuilding lite graph state from scratch');
    await writeJson(liteStatePath, buildFullLiteState(graph, currentSources));
    return;
  }

  const previousState = normalizeLiteState(previousStateRaw);
  const payloadMaps = hydratePayloadMaps(previousPayload);
  payloadMaps.derived = Object.keys(pickLiteDerivedPayload(options.derived)).length
    ? pickLiteDerivedPayload(options.derived)
    : payloadMaps.derived;
  const nextState = normalizeLiteState(previousState);
  const currentSourceMap = new Map((currentSources || []).map((source) => [escapeKey(source.sourceKey), source]));
  reportProgress('computing lite graph membership');
  const membership = buildLiteMembership(graph, currentSources);
  const graphNodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const graphRelationshipsById = new Map(graph.relationships.map((relationship) => [relationship.id, relationship]));
  const changedSourceKeys = new Set([GLOBAL_SOURCE_KEY]);

  for (const [sourceKey, source] of currentSourceMap.entries()) {
    const previous = previousState.sources[sourceKey];
    if (!previous || previous.fingerprint !== sourceFingerprintOf(source)) {
      changedSourceKeys.add(sourceKey);
    }
  }

  for (const sourceKey of Object.keys(previousState.sources || {})) {
    if (sourceKey === GLOBAL_SOURCE_KEY) continue;
    if (!currentSourceMap.has(sourceKey)) {
      changedSourceKeys.add(sourceKey);
    }
  }

  if (!changedSourceKeys.size) {
    return;
  }

  const impactedNodeIds = new Set();
  const impactedRelationshipIds = new Set();
  let projectionProgress = 0;
  let projectionTotal = 0;
  const reportProjectionProgress = () => {
    if (!projectionTotal) return;
    reportProgress(`projecting lite graph ${projectionProgress}/${projectionTotal}`);
  };

  for (const sourceKey of changedSourceKeys) {
    const previous = nextState.sources[sourceKey];
    if (!previous) continue;

    for (const nodeId of previous.nodeIds || []) {
      impactedNodeIds.add(nodeId);
      decrementRefCount(nextState.nodeRefs, nodeId);
    }
    for (const relationshipId of previous.relationshipIds || []) {
      impactedRelationshipIds.add(relationshipId);
      decrementRefCount(nextState.relationshipRefs, relationshipId);
    }

    delete nextState.sources[sourceKey];
  }

  for (const sourceKey of changedSourceKeys) {
    if (sourceKey === GLOBAL_SOURCE_KEY) continue;
    const source = currentSourceMap.get(sourceKey);
    if (!source) continue;

    const nodeIds = [...(membership.nodeIdsBySource.get(sourceKey) || new Set())];
    const relationshipIds = [...(membership.relationshipIdsBySource.get(sourceKey) || new Set())];
    nextState.sources[sourceKey] = createSourceEntry(source, nodeIds, relationshipIds);

    for (const nodeId of nodeIds) {
      impactedNodeIds.add(nodeId);
      incrementRefCount(nextState.nodeRefs, nodeId);
    }
    for (const relationshipId of relationshipIds) {
      impactedRelationshipIds.add(relationshipId);
      incrementRefCount(nextState.relationshipRefs, relationshipId);
    }
  }

  const globalNodeIds = [...(membership.nodeIdsBySource.get(GLOBAL_SOURCE_KEY) || new Set())];
  const globalRelationshipIds = [...(membership.relationshipIdsBySource.get(GLOBAL_SOURCE_KEY) || new Set())];
  nextState.sources[GLOBAL_SOURCE_KEY] = createGlobalEntry(globalNodeIds, globalRelationshipIds);

  for (const nodeId of globalNodeIds) {
    impactedNodeIds.add(nodeId);
    incrementRefCount(nextState.nodeRefs, nodeId);
  }
  for (const relationshipId of globalRelationshipIds) {
    impactedRelationshipIds.add(relationshipId);
    incrementRefCount(nextState.relationshipRefs, relationshipId);
  }

  const totalProjectionWork = impactedNodeIds.size + impactedRelationshipIds.size;
  projectionTotal = totalProjectionWork;
  projectionProgress = 0;
  for (const nodeId of impactedNodeIds) {
    if (nextState.nodeRefs[nodeId] > 0 && graphNodesById.has(nodeId)) {
      applyNodeProjection(payloadMaps, graphNodesById.get(nodeId));
    } else {
      removeNodeProjection(payloadMaps, nodeId);
    }
    projectionProgress += 1;
    if (projectionProgress % 500 === 0 || projectionProgress === totalProjectionWork) {
      reportProjectionProgress();
    }
  }

  for (const relationshipId of impactedRelationshipIds) {
    if (nextState.relationshipRefs[relationshipId] > 0 && graphRelationshipsById.has(relationshipId)) {
      applyRelationshipProjection(payloadMaps, graphRelationshipsById.get(relationshipId));
    } else {
      removeRelationshipProjection(payloadMaps, relationshipId);
    }
    projectionProgress += 1;
    if (projectionProgress % 500 === 0 || projectionProgress === totalProjectionWork) {
      reportProjectionProgress();
    }
  }

  reportProgress('writing lite graph payload');
  await writeJson(liteGraphPath, serializePayload(payloadMaps));
  reportProgress('writing lite graph state');
  await writeJson(liteStatePath, nextState);
}

export async function applyLiteDeltaCommit(rootPath, deltaPayload, options = {}) {
  const liteGraphPath = options.liteGraphPath;
  const liteStatePath = options.liteStatePath;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const reportProgress = (label) => {
    onProgress?.({
      phase: 'lite-delta',
      label
    });
  };

  if (!liteGraphPath || !liteStatePath) {
    throw new Error('Lite graph paths are required for delta commits.');
  }

  reportProgress('loading previous lite graph state');
  const [previousPayload, previousStateRaw] = await Promise.all([
    readJson(liteGraphPath, null),
    readJson(liteStatePath, null)
  ]);

  if (!previousPayload || !previousStateRaw || previousStateRaw.version !== LITE_VIEW_VERSION) {
    throw new Error('Fast local delta commit requires an existing lite graph payload and state.');
  }

  const previousState = normalizeLiteState(previousStateRaw);
  const payloadMaps = hydratePayloadMaps(previousPayload);
  payloadMaps.derived = Object.keys(pickLiteDerivedPayload(options.derived)).length
    ? pickLiteDerivedPayload(options.derived)
    : payloadMaps.derived;
  const nextState = normalizeLiteState(previousState);
  const sourceEntries = (deltaPayload.sourceEntries || []).map((entry) => normalizeSourceEntry(entry));
  const sourceEntryByKey = new Map(sourceEntries.map((entry) => [entry.sourceKey, entry]));
  const changedSourceKeys = cloneIdList(deltaPayload.liteChangedSourceKeys || deltaPayload.changedSourceKeys || sourceEntries.map((entry) => entry.sourceKey));
  const upsertNodesById = new Map((deltaPayload.upsertNodes || []).map((node) => [node.id, node]));
  const upsertRelationshipsById = new Map((deltaPayload.upsertRelationships || []).map((relationship) => [relationship.id, relationship]));
  const impactedNodeIds = new Set(deltaPayload.deleteNodeIds || []);
  const impactedRelationshipIds = new Set(deltaPayload.deleteRelationshipIds || []);

  reportProgress('updating lite graph reference counts');
  for (const sourceKey of changedSourceKeys) {
    const previousEntry = nextState.sources[sourceKey];
    if (!previousEntry) continue;

    for (const nodeId of previousEntry.nodeIds || []) {
      impactedNodeIds.add(nodeId);
      decrementRefCount(nextState.nodeRefs, nodeId);
    }
    for (const relationshipId of previousEntry.relationshipIds || []) {
      impactedRelationshipIds.add(relationshipId);
      decrementRefCount(nextState.relationshipRefs, relationshipId);
    }

    delete nextState.sources[sourceKey];
  }

  for (const sourceEntry of sourceEntries) {
    nextState.sources[sourceEntry.sourceKey] = sourceEntry;
    for (const nodeId of sourceEntry.nodeIds) {
      impactedNodeIds.add(nodeId);
      incrementRefCount(nextState.nodeRefs, nodeId);
    }
    for (const relationshipId of sourceEntry.relationshipIds) {
      impactedRelationshipIds.add(relationshipId);
      incrementRefCount(nextState.relationshipRefs, relationshipId);
    }
  }

  const totalProjectionWork = impactedNodeIds.size + impactedRelationshipIds.size;
  let projectionProgress = 0;
  const reportProjectionProgress = () => {
    if (!totalProjectionWork) return;
    reportProgress(`projecting lite delta ${projectionProgress}/${totalProjectionWork}`);
  };

  for (const nodeId of impactedNodeIds) {
    if (Number(nextState.nodeRefs[nodeId] || 0) > 0) {
      const nextNode = upsertNodesById.get(nodeId);
      if (nextNode) {
        applyNodeProjection(payloadMaps, nextNode);
      }
    } else {
      removeNodeProjection(payloadMaps, nodeId);
    }
    projectionProgress += 1;
    if (projectionProgress % 500 === 0 || projectionProgress === totalProjectionWork) {
      reportProjectionProgress();
    }
  }

  for (const relationshipId of impactedRelationshipIds) {
    if (Number(nextState.relationshipRefs[relationshipId] || 0) > 0) {
      const nextRelationship = upsertRelationshipsById.get(relationshipId);
      if (nextRelationship) {
        applyRelationshipProjection(payloadMaps, nextRelationship);
      }
    } else {
      removeRelationshipProjection(payloadMaps, relationshipId);
    }
    projectionProgress += 1;
    if (projectionProgress % 500 === 0 || projectionProgress === totalProjectionWork) {
      reportProjectionProgress();
    }
  }

  reportProgress('writing lite graph payload');
  await writeJson(liteGraphPath, serializePayload(payloadMaps));
  reportProgress('writing lite graph state');
  await writeJson(liteStatePath, nextState);

  return {
    payload: serializePayload(payloadMaps),
    state: nextState,
    sourceEntryByKey
  };
}
