import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const GRAPH_LINK_PREDICTION_VERSION = 'papernexus-graph-link-prediction-v1';
export const PREDICTED_BRIDGE_EDGES_VERSION = 'papernexus-predicted-bridge-edges-v1';
export const GRAPH_LINK_PREDICTION_MANIFEST_VERSION = 'papernexus-graph-link-prediction-manifest-v1';
export const DETERMINISTIC_HETEROGENEOUS_LINK_PREDICTION_METHOD = 'deterministic-heterogeneous-link-prediction-v1';
export const DEFAULT_GRAPH_LINK_PREDICTION_TOP_K = 100;

const DEFAULT_SOURCE_TYPES = new Set(['Domain', 'Problem', 'Challenge', 'Method', 'AbstractMechanism', 'Takeaway', 'ContributionClaim', 'Claim']);
const DEFAULT_TARGET_TYPES = new Set(['Domain', 'Problem', 'Challenge', 'Method', 'AbstractMechanism', 'Takeaway', 'Paper', 'CitationContext', 'ContributionClaim']);
const BRIDGE_EDGE_TYPES = new Set([
  'ADAPTS_METHOD',
  'ABSTRACTS_TO',
  'RECONTEXTUALIZES_TO',
  'HAS_TAKEAWAY',
  'HAS_OPEN_CHALLENGE',
  'SUPPORTS_CLAIM',
  'CITES_FOR_BASELINE',
  'CITES_FOR_METHOD',
  'CITES_FOR_CONTRAST'
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTopK(value = DEFAULT_GRAPH_LINK_PREDICTION_TOP_K) {
  return Math.max(1, normalizePositiveInteger(value, DEFAULT_GRAPH_LINK_PREDICTION_TOP_K));
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(6));
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = compactText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function tokenize(text = '') {
  return unique(String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3));
}

function recordText(record = {}) {
  const properties = asObject(record.properties);
  return unique([
    record.name,
    record.title,
    record.label,
    record.text,
    record.summary,
    record.description,
    record.abstract,
    properties.name,
    properties.title,
    properties.text,
    properties.summary,
    properties.description,
    properties.domain,
    properties.mechanism,
    properties.challenge
  ]).join(' ');
}

function normalizeNode(record = {}, index = 0) {
  const properties = asObject(record.properties);
  const id = compactText(pickFirst(record.id, record.nodeId, record.node_id, record.key, properties.id, `node-${index + 1}`));
  const type = compactText(pickFirst(record.type, record.nodeType, record.node_type, record.label, properties.type, 'Node'));
  const text = recordText(record) || id;
  return {
    id,
    type,
    name: compactText(pickFirst(record.name, record.title, record.label, properties.name, properties.title, id)),
    text,
    tokens: tokenize(text),
    properties
  };
}

function normalizeRelationship(record = {}, index = 0) {
  const properties = asObject(record.properties);
  const sourceId = compactText(pickFirst(record.sourceId, record.source_id, record.source, record.from, properties.sourceId, properties.source_id));
  const targetId = compactText(pickFirst(record.targetId, record.target_id, record.target, record.to, properties.targetId, properties.target_id));
  const type = compactText(pickFirst(record.type, record.edgeType, record.edge_type, record.relation, properties.type, 'RELATED_TO'));
  return {
    id: compactText(pickFirst(record.id, record.relationshipId, record.relationship_id, `rel-${index + 1}`)),
    sourceId,
    targetId,
    type,
    properties
  };
}

function graphFromInput(input = {}) {
  const root = asObject(input);
  const graph = asObject(root.graph || root.knowledgeGraph || root.knowledge_graph || root);
  return {
    name: compactText(pickFirst(root.name, root.dataset, root.corpus, graph.name, 'graph-link-prediction-input')),
    nodes: asArray(graph.nodes || graph.vertices || root.nodes).map(normalizeNode).filter((node) => node.id),
    relationships: asArray(graph.relationships || graph.edges || root.relationships || root.edges).map(normalizeRelationship)
      .filter((relationship) => relationship.sourceId && relationship.targetId)
  };
}

export function normalizeGraphLinkPredictionInput(input = {}) {
  const graph = graphFromInput(input);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const relationships = graph.relationships.filter((relationship) => nodeIds.has(relationship.sourceId) && nodeIds.has(relationship.targetId));
  return {
    ...graph,
    relationships,
    diagnostics: {
      nodeCount: graph.nodes.length,
      relationshipCount: relationships.length,
      droppedRelationshipCount: graph.relationships.length - relationships.length
    }
  };
}

function buildNeighborState(nodes = [], relationships = []) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  const edgeTypes = new Map(nodes.map((node) => [node.id, new Set()]));
  const existingDirectedEdges = new Set();
  for (const relationship of relationships) {
    existingDirectedEdges.add(`${relationship.sourceId}->${relationship.targetId}`);
    neighbors.get(relationship.sourceId)?.add(relationship.targetId);
    neighbors.get(relationship.targetId)?.add(relationship.sourceId);
    edgeTypes.get(relationship.sourceId)?.add(relationship.type);
    edgeTypes.get(relationship.targetId)?.add(relationship.type);
  }
  return { byId, neighbors, edgeTypes, existingDirectedEdges };
}

function intersection(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function jaccard(left = [], right = []) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (!union.size) return 0;
  return intersection([...leftSet], [...rightSet]).length / union.size;
}

function typePrior(source = {}, target = {}) {
  if (source.type === target.type) return 0.08;
  const pair = `${source.type}->${target.type}`;
  if (/Challenge->(Method|Takeaway|AbstractMechanism|ContributionClaim)/.test(pair)) return 0.18;
  if (/(Method|AbstractMechanism)->(Challenge|Takeaway|ContributionClaim)/.test(pair)) return 0.16;
  if (/(Domain|Problem)->(Method|AbstractMechanism|Takeaway|Paper)/.test(pair)) return 0.14;
  if (/(CitationContext|Paper)->(ContributionClaim|Claim|Method)/.test(pair)) return 0.12;
  return 0.1;
}

function scoreCandidate(source = {}, target = {}, state = {}) {
  const sourceNeighbors = [...(state.neighbors.get(source.id) || [])];
  const targetNeighbors = [...(state.neighbors.get(target.id) || [])];
  const commonNeighbors = intersection(sourceNeighbors, targetNeighbors);
  const sharedTokens = intersection(source.tokens, target.tokens);
  const tokenScore = jaccard(source.tokens, target.tokens);
  const commonNeighborScore = Math.min(0.35, commonNeighbors.length * 0.08);
  const bridgeTypeBonus = [...(state.edgeTypes.get(source.id) || []), ...(state.edgeTypes.get(target.id) || [])]
    .some((type) => BRIDGE_EDGE_TYPES.has(type)) ? 0.08 : 0;
  const score = normalizeScore(
    0.2
    + typePrior(source, target)
    + (tokenScore * 0.35)
    + commonNeighborScore
    + bridgeTypeBonus
  );
  return {
    score,
    commonNeighbors,
    sharedTokens,
    tokenScore: normalizeScore(tokenScore),
    bridgeTypeBonus
  };
}

function normalizeTypeSet(value, fallback) {
  const types = new Set(asArray(value).map(compactText).filter(Boolean));
  return types.size ? types : fallback;
}

function buildDeterministicPredictions(normalized = {}, options = {}) {
  const sourceTypes = normalizeTypeSet(options.sourceTypes || options.source_types, DEFAULT_SOURCE_TYPES);
  const targetTypes = normalizeTypeSet(options.targetTypes || options.target_types, DEFAULT_TARGET_TYPES);
  const topK = normalizeTopK(options.topK);
  const state = buildNeighborState(normalized.nodes, normalized.relationships);
  const candidates = [];
  for (const source of normalized.nodes) {
    if (!sourceTypes.has(source.type)) continue;
    for (const target of normalized.nodes) {
      if (source.id === target.id || !targetTypes.has(target.type)) continue;
      if (state.existingDirectedEdges.has(`${source.id}->${target.id}`)) continue;
      const scoring = scoreCandidate(source, target, state);
      if (scoring.score <= 0.2) continue;
      candidates.push({
        prediction_id: `predicted_bridge:${stableHash(`${source.id}->${target.id}`, 12)}`,
        source_id: source.id,
        source_type: source.type,
        source_name: source.name,
        target_id: target.id,
        target_type: target.type,
        target_name: target.name,
        predicted_edge_type: 'PREDICTED_BRIDGE',
        score: scoring.score,
        evidence: {
          common_neighbor_ids: scoring.commonNeighbors.slice(0, 10),
          shared_tokens: scoring.sharedTokens.slice(0, 12),
          token_jaccard: scoring.tokenScore,
          bridge_type_bonus: scoring.bridgeTypeBonus
        },
        status: 'candidate',
        online_use: 'rerank_signal_only'
      });
    }
  }
  return candidates
    .sort((left, right) => (
      right.score - left.score
      || left.source_id.localeCompare(right.source_id)
      || left.target_id.localeCompare(right.target_id)
    ))
    .slice(0, topK)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }));
}

function externalPredictionRows(payload = {}) {
  const root = asObject(payload);
  return asArray(root.predicted_edges || root.predictedEdges || root.predictions || root.edges || root.links);
}

function normalizeExternalPredictions(payload = {}, normalized = {}, options = {}) {
  const state = buildNeighborState(normalized.nodes, normalized.relationships);
  const rows = externalPredictionRows(payload);
  const topK = normalizeTopK(options.topK);
  return rows.map((row, index) => {
    const sourceId = compactText(pickFirst(row.source_id, row.sourceId, row.source, row.from));
    const targetId = compactText(pickFirst(row.target_id, row.targetId, row.target, row.to));
    const source = state.byId.get(sourceId) || { id: sourceId, type: compactText(row.source_type || row.sourceType || 'Node'), name: sourceId };
    const target = state.byId.get(targetId) || { id: targetId, type: compactText(row.target_type || row.targetType || 'Node'), name: targetId };
    return {
      prediction_id: compactText(row.prediction_id || row.predictionId || row.id || `predicted_bridge:${stableHash(`${sourceId}->${targetId}:${index}`, 12)}`),
      source_id: sourceId,
      source_type: compactText(row.source_type || row.sourceType || source.type),
      source_name: compactText(row.source_name || row.sourceName || source.name || sourceId),
      target_id: targetId,
      target_type: compactText(row.target_type || row.targetType || target.type),
      target_name: compactText(row.target_name || row.targetName || target.name || targetId),
      predicted_edge_type: compactText(row.predicted_edge_type || row.predictedEdgeType || row.edge_type || row.edgeType || 'PREDICTED_BRIDGE'),
      score: normalizeScore(row.score ?? row.probability ?? row.confidence, 0),
      evidence: asObject(row.evidence),
      status: compactText(row.status || 'candidate'),
      online_use: compactText(row.online_use || row.onlineUse || 'rerank_signal_only')
    };
  }).filter((row) => row.source_id && row.target_id)
    .sort((left, right) => (
      right.score - left.score
      || left.source_id.localeCompare(right.source_id)
      || left.target_id.localeCompare(right.target_id)
    ))
    .slice(0, topK)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

async function readJsonMaybe(filePath = '') {
  if (!filePath) return null;
  return readJson(filePath, null);
}

export async function loadGraphLinkPredictionInput(filePath = '') {
  const payload = await readJsonMaybe(filePath);
  if (!payload) throw new Error(`Unable to read graph link prediction input: ${filePath}`);
  return payload;
}

export async function loadGraphLinkPredictionSource(filePath = '') {
  if (!filePath) return null;
  const absolutePath = path.resolve(process.cwd(), filePath);
  const text = await fs.readFile(absolutePath, 'utf8');
  if (absolutePath.endsWith('.jsonl') || absolutePath.endsWith('.ndjson')) {
    const rows = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    return { contractVersion: 'external-graph-link-prediction-jsonl-v1', predicted_edges: rows };
  }
  return JSON.parse(text);
}

function resolveMethod(options = {}, hasExternalSource = false) {
  if (options.method) return String(options.method);
  return hasExternalSource ? String(options.model || 'external-graph-link-prediction') : DETERMINISTIC_HETEROGENEOUS_LINK_PREDICTION_METHOD;
}

function resolveModel(options = {}, hasExternalSource = false) {
  if (options.model) return String(options.model);
  return hasExternalSource ? 'external-graph-link-prediction' : 'deterministic-heterogeneous-link-prediction';
}

function releaseGateForGraphLinkPrediction(context = {}) {
  if (!context.hasExternalSource) {
    return {
      status: 'incomplete',
      reason: 'deterministic_placeholder_not_release_grade',
      notes: [
        'The deterministic heterogeneous scorer is an offline contract placeholder.',
        'It is useful for artifact plumbing and regression tests, but it is not GNN/OAG/OpenAlex release evidence.'
      ]
    };
  }
  const missing = [];
  if (!context.datasetSource) missing.push('dataset_source');
  if (!context.licenseScope) missing.push('license_scope');
  if (!context.model) missing.push('model');
  if (!context.trainingSlice) missing.push('training_slice');
  if (!context.timeCutoff) missing.push('time_cutoff');
  return {
    status: missing.length ? 'incomplete' : 'ready_for_evaluation',
    reason: missing.length ? `missing_${missing.join('_')}` : 'external_link_prediction_provenance_present',
    notes: missing.length
      ? [`External link predictions were supplied, but release metadata is incomplete: ${missing.join(', ')}.`]
      : ['External link-prediction provenance is present. Run OAG/OpenAlex/internal-KG temporal link-prediction gates before treating it as release evidence.']
  };
}

export function buildBridgeRerankSignals(predictedBridgeEdges = {}) {
  const rows = asArray(predictedBridgeEdges.predicted_edges || predictedBridgeEdges.predictedEdges || predictedBridgeEdges.predictions);
  const byPair = {};
  for (const row of rows) {
    const key = `${row.source_id || row.sourceId}->${row.target_id || row.targetId}`;
    byPair[key] = {
      score: normalizeScore(row.score, 0),
      rank: row.rank || null,
      prediction_id: row.prediction_id || row.predictionId || null,
      online_use: row.online_use || row.onlineUse || 'rerank_signal_only'
    };
  }
  return {
    contractVersion: 'papernexus-bridge-rerank-signals-v1',
    generatedBy: predictedBridgeEdges.contractVersion || PREDICTED_BRIDGE_EDGES_VERSION,
    signalCount: Object.keys(byPair).length,
    byPair
  };
}

export function buildGraphLinkPredictionArtifacts(options = {}) {
  const input = options.input || options.graph || {};
  const normalized = normalizeGraphLinkPredictionInput(input);
  const runId = String(options.runId || `graph-link-prediction-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const createdAt = String(options.createdAt || new Date().toISOString());
  const topK = normalizeTopK(options.topK);
  const predictionSourcePayload = options.predictionSourcePayload || null;
  const hasExternalSource = Boolean(predictionSourcePayload);
  const method = resolveMethod(options, hasExternalSource);
  const model = resolveModel(options, hasExternalSource);
  const datasetSource = compactText(options.datasetSource || options.dataset_source);
  const licenseScope = compactText(options.licenseScope || options.license_scope);
  const trainingSlice = compactText(options.trainingSlice || options.training_slice);
  const timeCutoff = compactText(options.timeCutoff || options.time_cutoff);
  const negativeSamplingPolicy = compactText(options.negativeSamplingPolicy || options.negative_sampling_policy || 'non_edge_type_balanced_deterministic');
  const predictions = hasExternalSource
    ? normalizeExternalPredictions(predictionSourcePayload, normalized, { topK })
    : buildDeterministicPredictions(normalized, { ...options, topK });
  const releaseGate = releaseGateForGraphLinkPrediction({
    hasExternalSource,
    datasetSource,
    licenseScope,
    model,
    trainingSlice,
    timeCutoff
  });
  const predictedBridgeEdges = {
    contractVersion: PREDICTED_BRIDGE_EDGES_VERSION,
    generatedBy: GRAPH_LINK_PREDICTION_VERSION,
    runId,
    createdAt,
    method,
    model,
    timeCutoff: timeCutoff || null,
    trainingSlice: trainingSlice || null,
    negativeSamplingPolicy,
    predicted_edges: predictions,
    metadata: {
      inputName: normalized.name,
      datasetSource: datasetSource || null,
      licenseScope: licenseScope || null,
      releaseGate,
      diagnostics: {
        ...normalized.diagnostics,
        topK,
        predictionCount: predictions.length,
        hasExternalSource
      }
    }
  };
  const bridgeRerankSignals = buildBridgeRerankSignals(predictedBridgeEdges);
  const manifest = {
    contractVersion: GRAPH_LINK_PREDICTION_MANIFEST_VERSION,
    generatedBy: GRAPH_LINK_PREDICTION_VERSION,
    runId,
    createdAt,
    status: predictions.length ? 'completed' : 'incomplete',
    releaseGateStatus: releaseGate.status,
    releaseGate,
    method,
    model,
    topK,
    timeCutoff: timeCutoff || null,
    trainingSlice: trainingSlice || null,
    negativeSamplingPolicy,
    datasetSource: datasetSource || null,
    licenseScope: licenseScope || null,
    artifacts: {
      predictedBridgeEdgesPath: null,
      bridgeRerankSignalsPath: null,
      manifestPath: null
    },
    diagnostics: predictedBridgeEdges.metadata.diagnostics
  };
  return {
    predictedBridgeEdges,
    bridgeRerankSignals,
    manifest
  };
}

export async function prepareGraphLinkPredictionArtifacts(options = {}) {
  const inputPath = options.inputPath || options.graphPath || options.graphSnapshotPath || '';
  const input = options.input || (inputPath ? await loadGraphLinkPredictionInput(inputPath) : {});
  const predictionSourcePayload = options.predictionSourcePayload
    || (options.predictionSourcePath ? await loadGraphLinkPredictionSource(options.predictionSourcePath) : null);
  return buildGraphLinkPredictionArtifacts({
    ...options,
    input,
    predictionSourcePayload
  });
}

export async function writeGraphLinkPredictionArtifacts(options = {}) {
  const outputDir = options.outputDir || options.output_path || options.output;
  if (!outputDir) throw new Error('outputDir is required.');
  const artifacts = await prepareGraphLinkPredictionArtifacts(options);
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const predictedBridgeEdgesPath = path.join(absoluteOutputDir, 'predicted-bridge-edges.json');
  const bridgeRerankSignalsPath = path.join(absoluteOutputDir, 'bridge-rerank-signals.json');
  const manifestPath = path.join(absoluteOutputDir, 'manifest.json');

  await ensureDir(absoluteOutputDir);
  const manifest = {
    ...artifacts.manifest,
    artifacts: {
      predictedBridgeEdgesPath,
      bridgeRerankSignalsPath,
      manifestPath
    }
  };
  await writeJson(predictedBridgeEdgesPath, artifacts.predictedBridgeEdges);
  await writeJson(bridgeRerankSignalsPath, artifacts.bridgeRerankSignals);
  await writeJson(manifestPath, manifest);
  return {
    predictedBridgeEdges: artifacts.predictedBridgeEdges,
    bridgeRerankSignals: artifacts.bridgeRerankSignals,
    manifest
  };
}
