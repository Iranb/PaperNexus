import { normalizeText, scoreTokenOverlap, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const METHOD_EVOLUTION_BENCHMARK_EVALUATION_CONTRACT_VERSION = 'papernexus-method-evolution-benchmark-evaluation-v1';
export const METHOD_EVOLUTION_BENCHMARK_VERSION = 'method-evolution-benchmark-v1';

const DEFAULT_THRESHOLDS = {
  nodeMatchRatio: 0.7,
  edgeReachableRatio: 0.6,
  pathSemanticCorrectness: 0.7,
  quoteValidationPassRate: 0.9,
  evidenceCompleteness: 0.75,
  chainAccuracyScore: 0.7
};

const METHOD_EVOLUTION_EDGE_TYPES = new Set([
  EDGE_TYPES.EXTENDS_METHOD,
  EDGE_TYPES.IMPROVES_METHOD,
  EDGE_TYPES.REPLACES_METHOD,
  EDGE_TYPES.ADAPTS_METHOD,
  EDGE_TYPES.USES_COMPONENT_METHOD
]);

const METHOD_DAG_EDGE_TYPES = new Set([
  EDGE_TYPES.VARIANT_OF,
  EDGE_TYPES.SPECIALIZES,
  EDGE_TYPES.COMPONENT_OF
]);

const METHOD_DAG_EDGE_TYPE_BY_CITATION_TYPE = new Map([
  [EDGE_TYPES.EXTENDS_METHOD, EDGE_TYPES.VARIANT_OF],
  [EDGE_TYPES.IMPROVES_METHOD, EDGE_TYPES.VARIANT_OF],
  [EDGE_TYPES.ADAPTS_METHOD, EDGE_TYPES.SPECIALIZES],
  [EDGE_TYPES.REPLACES_METHOD, EDGE_TYPES.SPECIALIZES],
  [EDGE_TYPES.USES_COMPONENT_METHOD, EDGE_TYPES.COMPONENT_OF]
]);

const ACCEPTED_EDGE_STATUSES = new Set(['accepted', 'validated', 'authoritative']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeKey(value) {
  return normalizeText(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function metric(numerator, denominator, threshold) {
  if (!denominator) {
    return {
      value: null,
      numerator,
      denominator,
      threshold,
      passed: null,
      status: 'not_applicable'
    };
  }

  const value = normalizeScore(numerator / denominator);
  return {
    value,
    numerator,
    denominator,
    threshold,
    passed: value >= threshold,
    status: 'ok'
  };
}

function methodNodeTerms(node) {
  const properties = node?.properties || {};
  return unique([
    node?.name,
    properties.canonicalName,
    properties.methodName,
    properties.label,
    ...asArray(properties.aliases),
    ...asArray(properties.methodAliases),
    ...asArray(properties.surfaces)
  ].map(normalizeKey).filter(Boolean));
}

function goldNodeTerms(goldNode = {}) {
  return unique([
    goldNode.canonicalName,
    goldNode.name,
    ...asArray(goldNode.aliases)
  ].map(normalizeKey).filter(Boolean));
}

function matchGoldMethodNode(methodNodes, goldNode, options = {}) {
  const minTokenOverlap = Number(options.minTokenOverlap || 0.82);
  const excludedNodeIds = options.excludedNodeIds || new Set();
  const goldTerms = goldNodeTerms(goldNode);
  const candidates = [];

  for (const node of methodNodes) {
    if (excludedNodeIds.has(node.id)) continue;
    const terms = methodNodeTerms(node);
    const exactTerm = terms.find((term) => goldTerms.includes(term));
    if (exactTerm) {
      candidates.push({
        node,
        score: 1,
        matchedBy: 'exact_surface',
        matchedSurface: exactTerm
      });
      continue;
    }

    const bestOverlap = Math.max(
      0,
      ...goldTerms.flatMap((goldTerm) => {
        const goldTokens = tokenizeWithoutStopwords(goldTerm);
        return terms.map((term) => scoreTokenOverlap(goldTokens, tokenizeWithoutStopwords(term)));
      })
    );
    if (bestOverlap >= minTokenOverlap) {
      candidates.push({
        node,
        score: normalizeScore(bestOverlap),
        matchedBy: 'token_overlap',
        matchedSurface: null
      });
    }
  }

  candidates.sort((left, right) => (
    right.score - left.score
    || String(left.node.name || left.node.id).localeCompare(String(right.node.name || right.node.id))
  ));
  return candidates[0] || null;
}

function expandAllowedEdgeTypes(edge = {}) {
  const output = new Set([edge.edgeType, ...asArray(edge.acceptedAlternativeTypes)].filter(Boolean));
  for (const type of [...output]) {
    const dagType = METHOD_DAG_EDGE_TYPE_BY_CITATION_TYPE.get(type);
    if (dagType) output.add(dagType);
  }
  return output;
}

function relationshipTypeSet(relationship = {}) {
  const properties = relationship.properties || {};
  return new Set([
    relationship.type,
    properties.paperEdgeType,
    properties.dagEdgeType,
    properties.methodEvolutionType,
    properties.methodCitationType
  ].filter(Boolean));
}

function isMethodEvolutionRelationship(relationship = {}) {
  const properties = relationship.properties || {};
  const types = relationshipTypeSet(relationship);
  return (
    [...types].some((type) => METHOD_EVOLUTION_EDGE_TYPES.has(type) || METHOD_DAG_EDGE_TYPES.has(type))
    || properties.methodEvolution === true
    || properties.methodEvolutionProjection === true
  );
}

function isAcceptedMethodEvolutionRelationship(relationship = {}) {
  const properties = relationship.properties || {};
  const status = properties.validationStatus || properties.validatorStatus || '';
  return isMethodEvolutionRelationship(relationship) && ACCEPTED_EDGE_STATUSES.has(status);
}

function relationshipMatchesAllowedTypes(relationship, allowedTypes) {
  if (!allowedTypes?.size) return true;
  for (const type of relationshipTypeSet(relationship)) {
    if (allowedTypes.has(type)) return true;
  }
  return false;
}

function findDirectedMethodPath(graph, sourceId, targetId, options = {}) {
  if (!sourceId || !targetId) return null;
  const maxDepth = Math.max(1, Number(options.maxDepth || 3));
  const queue = [{ nodeId: sourceId, path: [] }];
  const visited = new Set([sourceId]);

  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxDepth) continue;

    for (const relationship of graph.getOutgoing(current.nodeId) || []) {
      if (!isAcceptedMethodEvolutionRelationship(relationship)) continue;
      if (!relationshipMatchesAllowedTypes(relationship, options.allowedTypes)) continue;

      const nextNodeId = relationship.targetId;
      const nextPath = [...current.path, relationship];
      if (nextNodeId === targetId) return nextPath;
      if (visited.has(nextNodeId)) continue;
      visited.add(nextNodeId);
      queue.push({ nodeId: nextNodeId, path: nextPath });
    }
  }

  return null;
}

function edgeSatisfiesRequiredBottleneck(edge, requiredDimension) {
  if (!requiredDimension) return null;
  const required = normalizeKey(requiredDimension);
  return normalizeKey(edge?.properties?.bottleneckDimension) === required;
}

function summarizeRelationshipPath(path = []) {
  return path.map((relationship) => ({
    edgeId: relationship.id,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    type: relationship.type,
    paperEdgeType: relationship.properties?.paperEdgeType || null,
    dagEdgeType: relationship.properties?.dagEdgeType || null,
    confidence: relationship.properties?.confidence ?? null
  }));
}

function buildNodeMatches(graph, benchmark = {}, options = {}) {
  const methodNodes = graph.getNodesByType(NODE_TYPES.METHOD);
  const matches = [];
  const byGoldId = new Map();
  const usedNodeIds = new Set();

  for (const goldNode of asArray(benchmark.nodes)) {
    const match = matchGoldMethodNode(methodNodes, goldNode, {
      ...options,
      excludedNodeIds: usedNodeIds
    });
    if (match?.node.id) usedNodeIds.add(match.node.id);
    const record = {
      goldId: goldNode.goldId || null,
      canonicalName: goldNode.canonicalName || goldNode.name || '',
      aliases: asArray(goldNode.aliases),
      predictedMethodId: match?.node.id || null,
      predictedMethodName: match?.node.name || null,
      score: match ? match.score : 0,
      matchedBy: match?.matchedBy || null,
      matchedSurface: match?.matchedSurface || null
    };
    matches.push(record);
    if (goldNode.goldId) byGoldId.set(goldNode.goldId, record);
  }

  return { matches, byGoldId };
}

function buildEdgeMatches(graph, benchmark = {}, nodeMatchByGoldId, options = {}) {
  const edgeMatches = [];

  for (const goldEdge of asArray(benchmark.edges)) {
    const sourceMatch = nodeMatchByGoldId.get(goldEdge.sourceGoldId);
    const targetMatch = nodeMatchByGoldId.get(goldEdge.targetGoldId);
    const allowedTypes = expandAllowedEdgeTypes(goldEdge);
    const directPath = sourceMatch?.predictedMethodId && targetMatch?.predictedMethodId
      ? findDirectedMethodPath(graph, sourceMatch.predictedMethodId, targetMatch.predictedMethodId, {
        maxDepth: 1,
        allowedTypes
      })
      : null;
    const path = directPath || (
      sourceMatch?.predictedMethodId && targetMatch?.predictedMethodId
        ? findDirectedMethodPath(graph, sourceMatch.predictedMethodId, targetMatch.predictedMethodId, {
          maxDepth: options.maxPathDepth || 3
        })
        : null
    );
    const requiredBottleneckMatched = goldEdge.requiredBottleneckDimension
      ? Boolean(path?.some((relationship) => edgeSatisfiesRequiredBottleneck(relationship, goldEdge.requiredBottleneckDimension)))
      : null;

    edgeMatches.push({
      sourceGoldId: goldEdge.sourceGoldId,
      targetGoldId: goldEdge.targetGoldId,
      edgeType: goldEdge.edgeType || null,
      acceptedAlternativeTypes: asArray(goldEdge.acceptedAlternativeTypes),
      requiredBottleneckDimension: goldEdge.requiredBottleneckDimension || null,
      sourceMethodId: sourceMatch?.predictedMethodId || null,
      targetMethodId: targetMatch?.predictedMethodId || null,
      endpointsMatched: Boolean(sourceMatch?.predictedMethodId && targetMatch?.predictedMethodId),
      reachable: Boolean(path),
      direct: Boolean(directPath),
      pathLength: path?.length || 0,
      path: summarizeRelationshipPath(path || []),
      requiredBottleneckMatched
    });
  }

  return edgeMatches;
}

function buildChainMatches(graph, benchmark = {}, nodeMatchByGoldId, options = {}) {
  const chainMatches = [];

  for (const chain of asArray(benchmark.chains)) {
    const goldNodeIds = asArray(chain.goldNodeIds);
    let reachableTransitions = 0;
    const transitions = [];

    for (let index = 0; index < goldNodeIds.length - 1; index += 1) {
      const sourceMatch = nodeMatchByGoldId.get(goldNodeIds[index]);
      const targetMatch = nodeMatchByGoldId.get(goldNodeIds[index + 1]);
      const path = sourceMatch?.predictedMethodId && targetMatch?.predictedMethodId
        ? findDirectedMethodPath(graph, sourceMatch.predictedMethodId, targetMatch.predictedMethodId, {
          maxDepth: options.maxChainStepDepth || 1
        })
        : null;
      if (path) reachableTransitions += 1;
      transitions.push({
        sourceGoldId: goldNodeIds[index],
        targetGoldId: goldNodeIds[index + 1],
        sourceMethodId: sourceMatch?.predictedMethodId || null,
        targetMethodId: targetMatch?.predictedMethodId || null,
        reachable: Boolean(path),
        path: summarizeRelationshipPath(path || [])
      });
    }

    const totalTransitions = Math.max(0, goldNodeIds.length - 1);
    chainMatches.push({
      chainId: chain.chainId || null,
      semanticDescription: chain.semanticDescription || '',
      goldNodeIds,
      reachableTransitions,
      totalTransitions,
      score: totalTransitions ? normalizeScore(reachableTransitions / totalTransitions) : null,
      transitions
    });
  }

  return chainMatches;
}

function hasCompleteEvidence(relationship) {
  const properties = relationship.properties || {};
  if (properties.evidenceCompletenessStatus === 'complete') return true;
  return Boolean(
    properties.bottleneckDimension
    && (properties.mechanismDescription || properties.mechanismType)
    && (properties.tradeoffDescription || properties.tradeoffDimension)
  );
}

function buildAcceptedEvidenceGroups(graph) {
  const groups = new Map();
  for (const relationship of graph.relationships || []) {
    if (!isAcceptedMethodEvolutionRelationship(relationship)) continue;
    const properties = relationship.properties || {};
    const key = properties.candidateId || properties.citationRelationshipId || relationship.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relationship);
  }
  return [...groups.entries()].map(([key, relationships]) => ({
    key,
    relationships,
    quotePass: relationships.some((relationship) => (
      relationship.properties?.exactMatch === true
      && Boolean(relationship.properties?.exactQuote || relationship.properties?.evidenceQuote)
    )),
    evidenceComplete: relationships.some((relationship) => hasCompleteEvidence(relationship))
  }));
}

export function evaluateMethodEvolutionBenchmark(graph, benchmark = {}, options = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds || {})
  };
  const { matches: nodeMatches, byGoldId } = buildNodeMatches(graph, benchmark, options);
  const edgeMatches = buildEdgeMatches(graph, benchmark, byGoldId, options);
  const chainMatches = buildChainMatches(graph, benchmark, byGoldId, options);
  const acceptedEvidenceGroups = buildAcceptedEvidenceGroups(graph);
  const chainTransitionCount = chainMatches.reduce((total, chain) => total + chain.totalTransitions, 0);
  const chainReachableCount = chainMatches.reduce((total, chain) => total + chain.reachableTransitions, 0);
  const chainScores = chainMatches.map((chain) => chain.score).filter((score) => score !== null);
  const nodeMatchMetric = metric(
    nodeMatches.filter((match) => match.predictedMethodId).length,
    asArray(benchmark.nodes).length,
    thresholds.nodeMatchRatio
  );
  const edgeReachableMetric = metric(
    edgeMatches.filter((match) => match.reachable).length,
    asArray(benchmark.edges).length,
    thresholds.edgeReachableRatio
  );
  const pathSemanticMetric = metric(
    chainReachableCount,
    chainTransitionCount,
    thresholds.pathSemanticCorrectness
  );
  const chainAccuracyMetric = metric(
    chainScores.reduce((sum, score) => sum + score, 0),
    chainScores.length,
    thresholds.chainAccuracyScore
  );
  const quotePassCount = acceptedEvidenceGroups.filter((group) => group.quotePass).length;
  const evidenceCompleteCount = acceptedEvidenceGroups.filter((group) => group.evidenceComplete).length;

  const metrics = {
    nodeMatchRatio: nodeMatchMetric,
    edgeReachableRatio: edgeReachableMetric,
    pathSemanticCorrectness: pathSemanticMetric,
    nmr: {
      ...nodeMatchMetric,
      label: 'Node Match Ratio'
    },
    err: {
      ...edgeReachableMetric,
      label: 'Edge Reachability Ratio'
    },
    psc: {
      ...pathSemanticMetric,
      label: 'Path Semantic Correctness'
    },
    nr: {
      ...nodeMatchMetric,
      label: 'Node Recall'
    },
    er: {
      ...edgeReachableMetric,
      label: 'Edge Recall'
    },
    cas: {
      ...chainAccuracyMetric,
      label: 'Chain Accuracy Score'
    },
    quoteValidationPassRate: metric(
      quotePassCount,
      acceptedEvidenceGroups.length,
      thresholds.quoteValidationPassRate
    ),
    evidenceCompleteness: metric(
      evidenceCompleteCount,
      acceptedEvidenceGroups.length,
      thresholds.evidenceCompleteness
    ),
    aliasPrecision: {
      value: null,
      status: 'not_evaluated',
      reason: 'requires human-labeled alias samples'
    },
    stubUtility: {
      value: null,
      status: 'not_evaluated',
      reason: 'requires longitudinal stub resolution labels'
    }
  };

  return {
    contractVersion: METHOD_EVOLUTION_BENCHMARK_EVALUATION_CONTRACT_VERSION,
    benchmarkVersion: benchmark.benchmarkVersion || METHOD_EVOLUTION_BENCHMARK_VERSION,
    field: benchmark.field || '',
    source: benchmark.source || null,
    thresholds,
    metrics,
    thresholdSummary: {
      passed: Object.values(metrics).filter((entry) => entry?.status === 'ok').every((entry) => entry.passed === true),
      evaluatedMetricCount: Object.values(metrics).filter((entry) => entry?.status === 'ok').length
    },
    nodeMatches,
    edgeMatches,
    chainMatches,
    diagnostics: {
      queryTimeLlmCalls: 0,
      noLlmQueryInvariant: true,
      goldNodeCount: asArray(benchmark.nodes).length,
      goldEdgeCount: asArray(benchmark.edges).length,
      goldChainCount: asArray(benchmark.chains).length,
      predictedMethodCount: graph.getNodesByType(NODE_TYPES.METHOD).length,
      acceptedMethodEvolutionEvidenceCount: acceptedEvidenceGroups.length
    }
  };
}
