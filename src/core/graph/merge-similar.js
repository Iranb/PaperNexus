import { stableHash, normalizeText, unique } from '../../lib/utils.js';
import { createKnowledgeGraph } from './graph.js';
import { EDGE_TYPES, NODE_TYPES, getNodeLayer } from './schema.js';

const MERGEABLE_NODE_TYPES = new Set([
  NODE_TYPES.DATASET,
  NODE_TYPES.BENCHMARK
]);

const GENERIC_EVALUATION_TOKENS = new Set([
  'benchmark',
  'benchmarks',
  'corpus',
  'corpora',
  'dataset',
  'datasets'
]);

function cloneProperties(properties) {
  return properties && typeof properties === 'object'
    ? structuredClone(properties)
    : {};
}

function singularizeToken(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (normalized.length <= 3) return normalized;
  if (normalized.endsWith('ies') && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith('sses') || normalized.endsWith('uses') || normalized.endsWith('sis')) {
    return normalized;
  }
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function tokenizeMergeKey(value) {
  return normalizeText(value)
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map((token) => singularizeToken(token))
    .filter(Boolean)
    .filter((token) => !GENERIC_EVALUATION_TOKENS.has(token));
}

function createEvaluationMergeKey(node) {
  if (!MERGEABLE_NODE_TYPES.has(node?.type)) return null;
  const tokens = tokenizeMergeKey(node.name);
  if (!tokens.length) return null;
  return tokens.join(' ');
}

function getNodeDegree(graph, nodeId) {
  return graph.getIncoming(nodeId).length + graph.getOutgoing(nodeId).length;
}

function scoreRepresentativeNode(graph, node, canonicalType) {
  const properties = node.properties || {};
  const aliasCount = Array.isArray(properties.aliases) ? properties.aliases.length : 0;
  const mentionCount = Number(properties.mentionCount || 0);
  const typeBonus = node.type === canonicalType ? 500 : 0;
  const datasetBonus = canonicalType === NODE_TYPES.DATASET && /\b(dataset|corpus)\b/i.test(node.name) ? 20 : 0;
  const benchmarkBonus = canonicalType === NODE_TYPES.BENCHMARK && /\bbenchmark\b/i.test(node.name) ? 20 : 0;

  return typeBonus
    + (getNodeDegree(graph, node.id) * 10)
    + (mentionCount * 4)
    + aliasCount
    + datasetBonus
    + benchmarkBonus
    + (String(node.name || '').length / 1000);
}

function chooseCanonicalRepresentative(graph, nodes, canonicalType) {
  return [...nodes].sort((left, right) => {
    const scoreDiff = scoreRepresentativeNode(graph, right, canonicalType) - scoreRepresentativeNode(graph, left, canonicalType);
    if (scoreDiff !== 0) return scoreDiff;
    return String(left.name || '').localeCompare(String(right.name || ''));
  })[0];
}

function mergeScalarProperty(current, incoming, key) {
  if (incoming === undefined || incoming === null || incoming === '') return current;
  if (current === undefined || current === null || current === '') return incoming;

  if (typeof current === 'number' && typeof incoming === 'number') {
    if (['confidence', 'score', 'llmConfidence', 'mentionCount', 'mergeSourceCount'].includes(key)) {
      return Math.max(current, incoming);
    }
  }

  return current;
}

function mergeEvidenceText(current, incoming) {
  const values = unique([
    ...String(current || '')
      .split(' || ')
      .map((part) => part.trim())
      .filter(Boolean),
    ...String(incoming || '')
      .split(' || ')
      .map((part) => part.trim())
      .filter(Boolean)
  ]);
  return values.join(' || ');
}

function mergeProperties(baseProperties, incomingProperties, overrides = {}) {
  const result = cloneProperties(baseProperties);
  for (const [key, incomingValue] of Object.entries(incomingProperties || {})) {
    if (Array.isArray(incomingValue)) {
      result[key] = unique([
        ...(Array.isArray(result[key]) ? result[key] : []),
        ...incomingValue
      ]);
      continue;
    }

    if (key === 'evidenceText') {
      result[key] = mergeEvidenceText(result[key], incomingValue);
      continue;
    }

    result[key] = mergeScalarProperty(result[key], incomingValue, key);
  }

  return {
    ...result,
    ...overrides
  };
}

function buildMergedNode(graph, mergeKey, nodes, canonicalType) {
  const representative = chooseCanonicalRepresentative(graph, nodes, canonicalType);
  const mergedIds = nodes.map((node) => node.id);
  const mergedTypes = unique(nodes.map((node) => node.type));
  const aliases = unique(nodes.flatMap((node) => [
    node.name,
    ...(Array.isArray(node.properties?.aliases) ? node.properties.aliases : [])
  ])).filter((alias) => alias && alias !== representative.name);
  const paperTitles = unique(nodes.flatMap((node) => (
    Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles : []
  )));
  const confidenceValues = nodes
    .map((node) => Number(node.properties?.confidence))
    .filter((value) => Number.isFinite(value));
  const mergedMentionCount = nodes.reduce(
    (total, node) => total + Number(node.properties?.mentionCount || 1),
    0
  );

  return {
    ...representative,
    type: canonicalType,
    properties: {
      ...cloneProperties(representative.properties),
      layer: getNodeLayer(canonicalType),
      aliases,
      paperTitles,
      mentionCount: mergedMentionCount,
      confidence: confidenceValues.length ? Math.max(...confidenceValues) : representative.properties?.confidence || 0.6,
      canonicalMergeKey: mergeKey,
      mergeSourceCount: nodes.length,
      mergedNodeIds: mergedIds,
      mergedNodeTypes: mergedTypes
    }
  };
}

function remapEvaluationRelationshipType(relationshipType, sourceType, targetType) {
  if (targetType === NODE_TYPES.DATASET) {
    if (relationshipType === EDGE_TYPES.BENCHMARKED_ON) {
      return sourceType === NODE_TYPES.PAPER ? EDGE_TYPES.EVALUATES_ON : EDGE_TYPES.OBSERVED_ON;
    }
    return relationshipType;
  }

  if (targetType === NODE_TYPES.BENCHMARK) {
    if (relationshipType === EDGE_TYPES.EVALUATES_ON || relationshipType === EDGE_TYPES.OBSERVED_ON) {
      return EDGE_TYPES.BENCHMARKED_ON;
    }
  }

  return relationshipType;
}

function mergeRelationshipGroup(relationships, sourceId, targetId, type, sourceType, targetType) {
  const mergedProperties = relationships.reduce(
    (properties, relationship) => mergeProperties(properties, relationship.properties || {}),
    {}
  );

  const sourceLayer = getNodeLayer(sourceType);
  const targetLayer = getNodeLayer(targetType);

  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}`)}`,
    sourceId,
    targetId,
    type,
    properties: {
      ...mergedProperties,
      sourceLayer,
      targetLayer,
      layerPath: `${sourceLayer}->${targetLayer}`
    }
  };
}

export function mergeSimilarGraphNodes(graph, options = {}) {
  const groups = new Map();
  for (const node of graph.nodes) {
    const mergeKey = createEvaluationMergeKey(node);
    if (!mergeKey) continue;
    if (!groups.has(mergeKey)) groups.set(mergeKey, []);
    groups.get(mergeKey).push(node);
  }

  const canonicalNodes = new Map();
  const canonicalIds = new Map();
  const canonicalTypes = new Map();
  const mergeGroups = [];

  for (const [mergeKey, nodes] of groups.entries()) {
    if (nodes.length < 2) continue;
    const canonicalType = nodes.some((node) => node.type === NODE_TYPES.DATASET)
      ? NODE_TYPES.DATASET
      : NODE_TYPES.BENCHMARK;
    const mergedNode = buildMergedNode(graph, mergeKey, nodes, canonicalType);
    canonicalNodes.set(mergedNode.id, mergedNode);
    for (const node of nodes) {
      canonicalIds.set(node.id, mergedNode.id);
      canonicalTypes.set(node.id, canonicalType);
    }
    mergeGroups.push({
      mergeKey,
      canonicalNodeId: mergedNode.id,
      canonicalType,
      mergedNodeIds: nodes.map((node) => node.id),
      mergedNames: nodes.map((node) => node.name)
    });
  }

  if (!mergeGroups.length) {
    return {
      graph,
      changed: false,
      summary: {
        mergedGroupCount: 0,
        mergedNodeCount: 0,
        mergedRelationshipCount: 0,
        groups: []
      }
    };
  }

  const mergedGraph = createKnowledgeGraph();
  const originalNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    const canonicalId = canonicalIds.get(node.id);
    if (!canonicalId) {
      mergedGraph.addNode({
        ...node,
        properties: {
          ...cloneProperties(node.properties),
          layer: node.properties?.layer || getNodeLayer(node.type)
        }
      });
      canonicalIds.set(node.id, node.id);
      canonicalTypes.set(node.id, node.type);
      continue;
    }

    if (canonicalId === node.id) {
      mergedGraph.addNode(canonicalNodes.get(node.id));
    }
  }

  const relationshipGroups = new Map();
  for (const relationship of graph.relationships) {
    const sourceId = canonicalIds.get(relationship.sourceId) || relationship.sourceId;
    const targetId = canonicalIds.get(relationship.targetId) || relationship.targetId;
    if (sourceId === targetId) continue;

    const sourceType = canonicalTypes.get(relationship.sourceId) || originalNodeById.get(relationship.sourceId)?.type;
    const targetType = canonicalTypes.get(relationship.targetId) || originalNodeById.get(relationship.targetId)?.type;
    const type = remapEvaluationRelationshipType(relationship.type, sourceType, targetType);
    const key = JSON.stringify([sourceId, type, targetId]);
    if (!relationshipGroups.has(key)) {
      relationshipGroups.set(key, {
        sourceId,
        targetId,
        type,
        relationships: []
      });
    }
    relationshipGroups.get(key).relationships.push(relationship);
  }

  for (const group of relationshipGroups.values()) {
    const { sourceId, type, targetId, relationships } = group;
    const sourceType = mergedGraph.getNode(sourceId)?.type || originalNodeById.get(sourceId)?.type;
    const targetType = mergedGraph.getNode(targetId)?.type || originalNodeById.get(targetId)?.type;
    mergedGraph.addRelationship(
      mergeRelationshipGroup(relationships, sourceId, targetId, type, sourceType, targetType)
    );
  }

  return {
    graph: mergedGraph,
    changed: true,
    summary: {
      mergedGroupCount: mergeGroups.length,
      mergedNodeCount: mergeGroups.reduce((total, group) => total + (group.mergedNodeIds.length - 1), 0),
      mergedRelationshipCount: graph.relationshipCount - mergedGraph.relationshipCount,
      groups: mergeGroups.slice(0, Number(options.maxSummaryGroups || 48))
    }
  };
}
