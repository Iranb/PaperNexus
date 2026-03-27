import { EDGE_TYPES, IMPACT_RELATION_TYPES, NODE_TYPES } from '../graph/schema.js';
import { isBrainstormEligibleNode, isBrainstormSupportNode } from '../graph/brainstorm-view.js';
import { buildBrainstormCommunityContext } from './brainstorm-communities.js';
import { scoreTokenOverlap, tokenizeWithoutStopwords, truncate, jaccardSimilarity, unique } from '../../lib/utils.js';

function pushToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildRelationIndex(graph) {
  if (typeof graph.getOutgoing === 'function' && typeof graph.getIncoming === 'function') {
    return {
      outgoing: {
        get(nodeId) {
          return graph.getOutgoing(nodeId);
        }
      },
      incoming: {
        get(nodeId) {
          return graph.getIncoming(nodeId);
        }
      }
    };
  }

  const outgoing = new Map();
  const incoming = new Map();

  for (const relationship of graph.relationships) {
    pushToMap(outgoing, relationship.sourceId, relationship);
    pushToMap(incoming, relationship.targetId, relationship);
  }

  return { outgoing, incoming };
}

function getSearchText(node) {
  const propertyText = Object.values(node.properties || {})
    .flatMap((value) => {
      if (Array.isArray(value)) return value.map((item) => String(item));
      if (value && typeof value === 'object') return [];
      return value === null || value === undefined ? [] : [String(value)];
    })
    .join('\n');

  return [
    node.name,
    propertyText
  ]
    .filter(Boolean)
    .join('\n');
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

function resolveNodeScope(node) {
  if (node.type === NODE_TYPES.PAPER || (node.properties?.paperId && node.properties?.paperTitle)) {
    return {
      id: node.properties?.paperId || node.id,
      title: node.properties?.paperTitle || node.name,
      scope: 'paper'
    };
  }

  if (node.type === NODE_TYPES.CORPUS) {
    return {
      id: node.id,
      title: node.name,
      scope: 'corpus'
    };
  }

  return {
    id: node.id,
    title: `${node.type} · ${node.name}`,
    scope: 'global'
  };
}

function nodeMatchesView(node, view = 'all') {
  if (!node) return false;
  if (view === 'brainstorm') {
    return isBrainstormSupportNode(node);
  }
  return true;
}

function resolveNodeTypePriority(type) {
  const priorities = {
    [NODE_TYPES.PROBLEM]: 0,
    [NODE_TYPES.METHOD]: 1,
    [NODE_TYPES.LIMITATION]: 2,
    [NODE_TYPES.ASSUMPTION]: 3,
    [NODE_TYPES.PAPER]: 4,
    [NODE_TYPES.FUTURE_DIRECTION]: 5,
    [NODE_TYPES.CLAIM]: 6,
    [NODE_TYPES.FINDING]: 7,
    [NODE_TYPES.EVIDENCE]: 8,
    [NODE_TYPES.DATASET]: 9,
    [NODE_TYPES.BENCHMARK]: 10,
    [NODE_TYPES.METRIC]: 11,
    [NODE_TYPES.CORPUS]: 12
  };

  return priorities[type] ?? 20;
}

function scoreNode(node, queryTokens, queryText) {
  const haystack = getSearchText(node).toLowerCase();
  if (!haystack.trim()) return 0;

  let score = scoreTokenOverlap(queryTokens, tokenizeWithoutStopwords(haystack)) * 3;

  if (node.name.toLowerCase() === queryText) score += 4;
  else if (node.name.toLowerCase().includes(queryText)) score += 2;
  else if (haystack.includes(queryText)) score += 1;

  const typeBonuses = {
    [NODE_TYPES.PAPER]: 0.4,
    [NODE_TYPES.PROBLEM]: 0.95,
    [NODE_TYPES.METHOD]: 0.85,
    [NODE_TYPES.FINDING]: 0.84,
    [NODE_TYPES.LIMITATION]: 0.92,
    [NODE_TYPES.ASSUMPTION]: 0.78,
    [NODE_TYPES.CLAIM]: 0.82,
    [NODE_TYPES.EVIDENCE]: 0.58,
    [NODE_TYPES.FUTURE_DIRECTION]: 0.72,
    [NODE_TYPES.DATASET]: 0.55,
    [NODE_TYPES.BENCHMARK]: 0.53,
    [NODE_TYPES.METRIC]: 0.45,
    [NODE_TYPES.CORPUS]: 0.1
  };

  score += typeBonuses[node.type] || 0;

  if (Array.isArray(node.properties?.paperTitles) && node.properties.paperTitles.length > 1) {
    score += Math.min(0.6, node.properties.paperTitles.length * 0.08);
  }

  return score;
}

export function searchGraph(graph, query, options = {}) {
  const limit = Number(options.limit || 5);
  const queryText = String(query || '').trim().toLowerCase();
  const queryTokens = tokenizeWithoutStopwords(queryText);
  const allowedLayers = normalizeLayerFilter(options.layers);
  const nodeView = options.nodeView || 'all';
  const candidateNodes = queryTokens.length && typeof graph.getSearchCandidates === 'function'
    ? graph.getSearchCandidates(queryText)
    : graph.nodes;
  const searchPool = (candidateNodes.length >= 6 ? candidateNodes : graph.nodes)
    .filter((node) => nodeMatchesView(node, nodeView))
    .filter((node) => nodeInAllowedLayers(node, allowedLayers));

  const hits = [];
  for (const node of searchPool) {
    const score = scoreNode(node, queryTokens, queryText);
    if (score <= 0.2) continue;

    const scope = resolveNodeScope(node);
    hits.push({
      node,
      scope,
      score,
      excerpt: truncate(node.properties?.text || node.properties?.abstract || node.properties?.evidenceText || node.name, 220)
    });
  }

  hits.sort((left, right) => right.score - left.score);

  const grouped = new Map();
  for (const hit of hits) {
    const key = hit.scope.id;
    const existing = grouped.get(key) || {
      id: key,
      title: hit.scope.title,
      scope: hit.scope.scope,
      score: 0,
      matchCount: 0,
      matches: []
    };
    existing.matchCount += 1;
    existing.score += hit.score;
    if (existing.matches.length < 4) {
      existing.matches.push({
        nodeId: hit.node.id,
        nodeType: hit.node.type,
        nodeName: hit.node.name,
        excerpt: hit.excerpt
      });
    }
    grouped.set(key, existing);
  }

  return {
    query,
    groups: [...grouped.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  };
}

function resolveNodeCandidates(graph, query, options = {}) {
  const lowered = String(query || '').trim().toLowerCase();
  if (!lowered) return [];
  const nodeView = options.nodeView || 'all';

  const idMatch = graph.getNode(query);
  if (idMatch && nodeMatchesView(idMatch, nodeView)) return [idMatch];

  return graph.nodes
    .filter((node) => nodeMatchesView(node, nodeView))
    .filter((node) => node.name.toLowerCase() === lowered || node.name.toLowerCase().includes(lowered))
    .sort((left, right) => {
      const leftExact = left.name.toLowerCase() === lowered ? 0 : 1;
      const rightExact = right.name.toLowerCase() === lowered ? 0 : 1;
      return leftExact - rightExact
        || resolveNodeTypePriority(left.type) - resolveNodeTypePriority(right.type)
        || left.name.localeCompare(right.name);
    });
}

export function buildContext(graph, query, options = {}) {
  const candidates = resolveNodeCandidates(graph, query, options);
  const allowedLayers = normalizeLayerFilter(options.layers);
  const layerMode = options.layerMode || 'any';
  if (!candidates.length) {
    return { query, node: null, incoming: [], outgoing: [] };
  }

  if (candidates.length > 1) {
    return {
      query,
      candidates: candidates.slice(0, 10).map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type
      }))
    };
  }

  const node = candidates[0];
  const { outgoing, incoming } = buildRelationIndex(graph);

  return {
    query,
    node,
    outgoing: (outgoing.get(node.id) || [])
      .filter((relationship) => relationshipMatchesLayerMode(relationship, layerMode))
      .filter((relationship) => nodeInAllowedLayers(graph.getNode(relationship.targetId), allowedLayers))
      .map((relationship) => ({
      type: relationship.type,
      targetId: relationship.targetId,
      targetName: graph.getNode(relationship.targetId)?.name || relationship.targetId,
      targetType: graph.getNode(relationship.targetId)?.type || 'Unknown',
      targetLayer: graph.getNode(relationship.targetId)?.properties?.layer || ''
    })),
    incoming: (incoming.get(node.id) || [])
      .filter((relationship) => relationshipMatchesLayerMode(relationship, layerMode))
      .filter((relationship) => nodeInAllowedLayers(graph.getNode(relationship.sourceId), allowedLayers))
      .map((relationship) => ({
      type: relationship.type,
      sourceId: relationship.sourceId,
      sourceName: graph.getNode(relationship.sourceId)?.name || relationship.sourceId,
      sourceType: graph.getNode(relationship.sourceId)?.type || 'Unknown',
      sourceLayer: graph.getNode(relationship.sourceId)?.properties?.layer || ''
    }))
  };
}

function riskFromCount(count) {
  if (count >= 18) return 'CRITICAL';
  if (count >= 10) return 'HIGH';
  if (count >= 5) return 'MEDIUM';
  return 'LOW';
}

export function buildImpact(graph, query, options = {}) {
  const direction = options.direction || 'upstream';
  const maxDepth = Number(options.maxDepth || 3);
  const relationTypes = new Set(options.relationTypes?.length ? options.relationTypes : IMPACT_RELATION_TYPES);
  const allowedLayers = normalizeLayerFilter(options.layers);
  const layerMode = options.layerMode || 'any';
  const candidates = resolveNodeCandidates(graph, query, options);

  if (!candidates.length) {
    return { query, node: null, direction, byDepth: [], risk: 'LOW' };
  }

  const node = candidates[0];
  const { outgoing, incoming } = buildRelationIndex(graph);
  const buckets = new Map();
  const visited = new Set([node.id]);
  const queue = [{ nodeId: node.id, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;

    const relationships = direction === 'upstream'
      ? (incoming.get(current.nodeId) || [])
      : (outgoing.get(current.nodeId) || []);

    for (const relationship of relationships) {
      if (!relationTypes.has(relationship.type)) continue;
      if (!relationshipMatchesLayerMode(relationship, layerMode)) continue;

      const nextNodeId = direction === 'upstream' ? relationship.sourceId : relationship.targetId;
      if (visited.has(nextNodeId)) continue;

      const nextNode = graph.getNode(nextNodeId);
      if (!nextNode) continue;
      if (!nodeInAllowedLayers(nextNode, allowedLayers)) continue;

      visited.add(nextNodeId);

      const depth = current.depth + 1;
      if (!buckets.has(depth)) buckets.set(depth, []);
      buckets.get(depth).push({
        id: nextNode.id,
        name: nextNode.name,
        type: nextNode.type,
        layer: nextNode.properties?.layer || '',
        via: [relationship.type]
      });

      queue.push({ nodeId: nextNodeId, depth });
    }
  }

  const flattened = [...buckets.values()].flat();
  return {
    query,
    node,
    direction,
    byDepth: [...buckets.entries()].map(([depth, nodes]) => ({ depth, nodes })),
    risk: riskFromCount(flattened.length)
  };
}

function findPaperById(graph, paperId) {
  return graph.getNode(paperId) || graph.nodes.find((node) => node.type === NODE_TYPES.PAPER && node.properties?.paperId === paperId) || null;
}

function findLinkedNodes(graph, relationIndex, nodeId, direction, allowedTypes = null) {
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

function collectRelevantPaperIds(graph, query, relationIndex, options = {}) {
  const paperIds = new Set();
  const searchResult = searchGraph(graph, query, {
    limit: 8,
    nodeView: options.nodeView || 'all'
  });

  for (const group of searchResult.groups) {
    if (group.scope === 'paper') {
      paperIds.add(group.id);
    }
  }

  const candidateNodes = resolveNodeCandidates(graph, query, {
    nodeView: options.nodeView || 'all'
  }).slice(0, 6);
  for (const node of candidateNodes) {
    if (node.type === NODE_TYPES.PAPER) {
      paperIds.add(node.id);
      continue;
    }

    const incomingPapers = findLinkedNodes(graph, relationIndex, node.id, 'incoming', [NODE_TYPES.PAPER]);
    const outgoingPapers = findLinkedNodes(graph, relationIndex, node.id, 'outgoing', [NODE_TYPES.PAPER]);
    for (const entry of [...incomingPapers, ...outgoingPapers]) {
      paperIds.add(entry.node.id);
    }

    if (node.properties?.paperId) {
      paperIds.add(node.properties.paperId);
    }
  }

  return [...paperIds]
    .map((paperId) => findPaperById(graph, paperId))
    .filter(Boolean)
    .slice(0, 8);
}

function countPaperSupport(relationIndex, nodeId, edgeType) {
  return (relationIndex.incoming.get(nodeId) || [])
    .filter((relationship) => relationship.type === edgeType)
    .map((relationship) => relationship.sourceId)
    .filter((value, index, array) => array.indexOf(value) === index)
    .length;
}

function scoreIdea(dimensions) {
  const weighted = (
    dimensions.relevance * 1.4
    + dimensions.novelty * 1.3
    + dimensions.feasibility * 1.1
    + dimensions.evidence * 1.2
    - dimensions.risk * 0.9
    - dimensions.cost * 0.6
  );

  return Number(weighted.toFixed(2));
}

function buildLimitationIdea(graph, relationIndex, limitation, candidateMethods, currentMethodIds, seedProblemIds) {
  const remedyMethods = findLinkedNodes(graph, relationIndex, limitation.id, 'outgoing', [NODE_TYPES.METHOD])
    .map((entry) => entry.node)
    .filter((method) => !currentMethodIds.has(method.id));

  const methodPool = remedyMethods.length ? remedyMethods : candidateMethods.filter((method) => !currentMethodIds.has(method.id));
  const rankedMethods = methodPool
    .map((method) => {
      const problemOverlap = findLinkedNodes(graph, relationIndex, method.id, 'outgoing', [NODE_TYPES.PROBLEM])
        .filter((entry) => seedProblemIds.has(entry.node.id)).length;
      const support = countPaperSupport(relationIndex, method.id, EDGE_TYPES.USES);
      const similarity = jaccardSimilarity(limitation.name, method.name);
      return {
        method,
        score: problemOverlap * 2 + support + similarity
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = rankedMethods[0];
  if (!best) return null;

  const support = countPaperSupport(relationIndex, best.method.id, EDGE_TYPES.USES);
  const relevance = Math.min(5, 2.4 + best.score);
  const novelty = currentMethodIds.has(best.method.id) ? 1.8 : 4.2;
  const feasibility = Math.min(5, 2 + support * 0.8);
  const evidence = Math.min(5, 1.6 + countPaperSupport(relationIndex, limitation.id, EDGE_TYPES.HAS_LIMITATION) * 0.7 + support * 0.5);
  const risk = 1.7 + (support < 2 ? 1.2 : 0.4);
  const cost = /\b(graph|retrieval|large|planning)\b/i.test(best.method.name) ? 2.2 : 1.5;

  return {
    template: 'limitation_reversal',
    title: `针对“${limitation.name}”引入 ${best.method.name}`,
    summary: `当前主题下反复出现的限制是“${limitation.name}”。可以优先考察 ${best.method.name}，看它能否解除这条限制并形成新的研究路线。`,
    problemNames: [],
    methodNames: [best.method.name],
    limitationNames: [limitation.name],
    supportingPapers: unique([
      ...((limitation.properties?.paperTitles || []).slice(0, 3)),
      ...((best.method.properties?.paperTitles || []).slice(0, 3))
    ]).slice(0, 5),
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildTransferIdea(graph, relationIndex, problem, candidateMethods, currentMethodIds) {
  const rankedMethods = candidateMethods
    .filter((method) => !currentMethodIds.has(method.id))
    .map((method) => {
      const relatedProblems = findLinkedNodes(graph, relationIndex, method.id, 'outgoing', [NODE_TYPES.PROBLEM]).map((entry) => entry.node.id);
      const problemSupport = relatedProblems.length;
      const paperSupport = countPaperSupport(relationIndex, method.id, EDGE_TYPES.USES);
      const similarity = jaccardSimilarity(problem.name, method.name);
      return {
        method,
        score: problemSupport + paperSupport + similarity
      };
    })
    .sort((left, right) => right.score - left.score);

  const best = rankedMethods[0];
  if (!best) return null;

  const paperSupport = countPaperSupport(relationIndex, best.method.id, EDGE_TYPES.USES);
  const relevance = Math.min(5, 2 + best.score * 0.8);
  const novelty = 4.3;
  const feasibility = Math.min(5, 2.2 + paperSupport * 0.6);
  const evidence = Math.min(5, 1.8 + paperSupport * 0.8);
  const risk = 2.1;
  const cost = /\b(graph|retrieval|planning)\b/i.test(best.method.name) ? 2.2 : 1.6;

  return {
    template: 'cross_problem_transfer',
    title: `把 ${best.method.name} 迁移到 ${problem.name}`,
    summary: `${problem.name} 是当前主题的核心问题之一，而 ${best.method.name} 在邻近问题上已有一定支持，可以优先验证跨问题迁移的可行性。`,
    problemNames: [problem.name],
    methodNames: [best.method.name],
    limitationNames: [],
    supportingPapers: (best.method.properties?.paperTitles || []).slice(0, 5),
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildEvidenceGapIdea(graph, relationIndex, claim) {
  const evidenceCount = findLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.EVIDENCE]).length;
  const datasetCount = findLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.DATASET]).length;
  const metricCount = findLinkedNodes(graph, relationIndex, claim.id, 'outgoing', [NODE_TYPES.METRIC]).length;

  if (evidenceCount >= 2 && datasetCount >= 1 && metricCount >= 1) return null;

  const relevance = 4.2;
  const novelty = 3.3;
  const feasibility = 4.1;
  const evidence = Math.max(1.2, 3.8 - evidenceCount * 0.9);
  const risk = 1.5 + (evidenceCount ? 0.4 : 1.1);
  const cost = 1.7 + (datasetCount === 0 ? 0.8 : 0.2);

  return {
    template: 'evidence_gap',
    title: `为 claim“${truncate(claim.name, 48)}”补更强证据边界`,
    summary: `这个结论目前证据仍偏薄，尤其在数据集、指标或支持证据数量上存在缺口。适合把它转成“更公平验证 / 更广设定复现 / 边界分析”的研究题目。`,
    problemNames: [],
    methodNames: [],
    limitationNames: [],
    supportingPapers: [claim.properties?.paperTitle].filter(Boolean),
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildProblemCoverageIdea(graph, relationIndex, problem, candidateMethods, currentMethodIds) {
  const linkedMethods = findLinkedNodes(graph, relationIndex, problem.id, 'incoming', [NODE_TYPES.METHOD])
    .filter((entry) => entry.relationship.type === EDGE_TYPES.APPLIES_TO || entry.relationship.type === EDGE_TYPES.TRANSFERABLE_TO)
    .map((entry) => entry.node);

  const uniqueLinkedMethods = unique(linkedMethods.map((method) => method.id));
  if (uniqueLinkedMethods.length > 2) return null;

  const suggestedMethod = candidateMethods.find((method) => !currentMethodIds.has(method.id)) || null;
  const relevance = 4.1;
  const novelty = suggestedMethod ? 4 : 3.2;
  const feasibility = suggestedMethod ? 3.4 : 4;
  const evidence = Math.max(1.8, 4.2 - uniqueLinkedMethods.length * 0.8);
  const risk = suggestedMethod ? 2.1 : 1.7;
  const cost = suggestedMethod ? 2.1 : 1.4;

  return {
    template: 'problem_method_gap',
    title: suggestedMethod
      ? `围绕 ${problem.name} 引入 ${suggestedMethod.name}`
      : `围绕 ${problem.name} 扩展方法覆盖`,
    summary: suggestedMethod
      ? `${problem.name} 当前方法覆盖偏薄，适合把 ${suggestedMethod.name} 作为迁移候选纳入实验设计。`
      : `${problem.name} 在当前语料中的方法覆盖还比较稀疏，适合把它作为“重新组织问题设定 + 扩充方法空间”的研究切入点。`,
    problemNames: [problem.name],
    methodNames: suggestedMethod ? [suggestedMethod.name] : [],
    limitationNames: [],
    supportingPapers: suggestedMethod ? (suggestedMethod.properties?.paperTitles || []).slice(0, 4) : [],
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildCombinationIdea(graph, relationIndex, method, currentMethodIds) {
  const candidates = findLinkedNodes(graph, relationIndex, method.id, 'outgoing', [NODE_TYPES.METHOD])
    .filter((entry) => entry.relationship.type === EDGE_TYPES.COMBINES_WITH || entry.relationship.type === EDGE_TYPES.COMPATIBLE_WITH)
    .map((entry) => entry.node)
    .filter((node) => !currentMethodIds.has(node.id));

  const best = candidates[0];
  if (!best) return null;

  const currentSupport = countPaperSupport(relationIndex, method.id, EDGE_TYPES.USES);
  const candidateSupport = countPaperSupport(relationIndex, best.id, EDGE_TYPES.USES);
  const relevance = Math.min(5, 2.3 + jaccardSimilarity(method.name, best.name) * 2.4);
  const novelty = 4.4;
  const feasibility = Math.min(5, 2 + candidateSupport * 0.7);
  const evidence = Math.min(5, 1.9 + currentSupport * 0.4 + candidateSupport * 0.5);
  const risk = 1.8 + (candidateSupport < 2 ? 0.7 : 0.2);
  const cost = 2.1;

  return {
    template: 'method_combination',
    title: `组合 ${method.name} 与 ${best.name}`,
    summary: `${method.name} 与 ${best.name} 在图中存在组合或兼容线索，适合把它们设计成一个跨论文的新方案候选。`,
    problemNames: [],
    methodNames: [method.name, best.name],
    limitationNames: [],
    supportingPapers: unique([
      ...((method.properties?.paperTitles || []).slice(0, 3)),
      ...((best.properties?.paperTitles || []).slice(0, 3))
    ]).slice(0, 5),
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function rankSharedNode(node, seedPaperIds = new Set()) {
  const shared = Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles.length : 0;
  const support = node.properties?.paperId && seedPaperIds.has(node.properties.paperId) ? 1 : 0;
  return shared * 2 + support + (node.properties?.confidence || 0);
}

function collectSeedConcepts(graph, relationIndex, seedPapers = [], candidateNodes = [], allowedLayers = null) {
  const concepts = new Map();

  const addConcept = (node) => {
    if (!isBrainstormEligibleNode(node)) return;
    if (!nodeInAllowedLayers(node, allowedLayers)) return;
    concepts.set(node.id, node);
  };

  for (const node of candidateNodes) {
    addConcept(node);
  }

  for (const paper of seedPapers) {
    for (const relationship of relationIndex.outgoing.get(paper.id) || []) {
      const node = graph.getNode(relationship.targetId);
      addConcept(node);
    }
  }

  return [...concepts.values()].sort((left, right) => (
    resolveNodeTypePriority(left.type) - resolveNodeTypePriority(right.type)
    || left.name.localeCompare(right.name)
  ));
}

function createBrainstormSession(graph, query, options = {}) {
  const relationIndex = buildRelationIndex(graph);
  const allowedLayers = normalizeLayerFilter(options.layers);
  const seedPapers = collectRelevantPaperIds(graph, query, relationIndex, {
    nodeView: 'brainstorm'
  });
  const candidateNodes = resolveNodeCandidates(graph, query, {
    nodeView: 'brainstorm'
  })
    .filter((node) => nodeInAllowedLayers(node, allowedLayers))
    .slice(0, 6);
  const seedNodes = unique([
    ...seedPapers.map((paper) => paper.id),
    ...candidateNodes.map((node) => node.id)
  ])
    .map((nodeId) => graph.getNode(nodeId))
    .filter(Boolean);
  const seedConcepts = collectSeedConcepts(graph, relationIndex, seedPapers, candidateNodes, allowedLayers);
  let communityContext = null;

  return {
    query,
    queryTokens: tokenizeWithoutStopwords(String(query || '').trim().toLowerCase()),
    relationIndex,
    allowedLayers,
    seedPapers,
    candidateNodes,
    seedNodes,
    seedConcepts,
    getCommunityContext() {
      if (!communityContext) {
        communityContext = buildBrainstormCommunityContext(graph, {
          query,
          queryTokens: this.queryTokens,
          relationIndex,
          seedPapers,
          seedNodes,
          seedConcepts,
          allowedLayers
        }, options);
      }

      return communityContext;
    }
  };
}

function mergeCommunityEntries(baseEntries, communityEntries, limit, toEntry) {
  const merged = new Map(
    baseEntries.map((entry, index) => [entry.id, {
      ...entry,
      __priority: 1000 - index
    }])
  );

  for (const communityEntry of communityEntries) {
    const mapped = toEntry(communityEntry);
    const existing = merged.get(mapped.id) || {};
    merged.set(mapped.id, {
      ...existing,
      ...mapped,
      __priority: Math.max(existing.__priority || 0, 2000 + (communityEntry.score || 0))
    });
  }

  return [...merged.values()]
    .sort((left, right) => right.__priority - left.__priority || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(({ __priority, ...entry }) => entry);
}

function buildCommunityMethodCombinationIdea(graph, bridge, currentMethodIds) {
  const left = graph.getNode(bridge.sourceId);
  const right = graph.getNode(bridge.targetId);
  if (!left || !right || left.type !== NODE_TYPES.METHOD || right.type !== NODE_TYPES.METHOD) return null;
  if (!(currentMethodIds.has(left.id) || currentMethodIds.has(right.id))) return null;

  const relevance = Math.min(5, 2.8 + (bridge.score * 0.35));
  const novelty = 4.5;
  const feasibility = 3.5;
  const evidence = Math.min(5, 1.9 + (bridge.supportingPapers?.length || 0) * 0.5);
  const risk = 1.8;
  const cost = 2.2;

  return {
    template: 'community_method_combination',
    title: `组合 ${left.name} 与 ${right.name}`,
    summary: `${left.name} 与 ${right.name} 分处相邻社区，但局部图显示它们之间存在稳定桥接路径，适合把它们当作跨主题组合候选。`,
    problemNames: [],
    methodNames: [left.name, right.name],
    limitationNames: [],
    supportingPapers: bridge.supportingPapers || [],
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildCommunityProblemTransferIdea(graph, bridge, currentMethodIds) {
  const problem = graph.getNode(bridge.sourceId);
  const method = graph.getNode(bridge.targetId);
  if (!problem || !method || problem.type !== NODE_TYPES.PROBLEM || method.type !== NODE_TYPES.METHOD) return null;
  if (currentMethodIds.has(method.id)) return null;

  const relevance = Math.min(5, 2.6 + (bridge.score * 0.35));
  const novelty = 4.1;
  const feasibility = 3.7;
  const evidence = Math.min(5, 1.8 + (bridge.supportingPapers?.length || 0) * 0.45);
  const risk = 2.0;
  const cost = 1.9;

  return {
    template: 'community_problem_transfer',
    title: `把 ${method.name} 迁移到 ${problem.name}`,
    summary: `${method.name} 所在社区与 ${problem.name} 所在问题社区之间存在稳定桥接路径，可以把它当作一个跨主题迁移候选。`,
    problemNames: [problem.name],
    methodNames: [method.name],
    limitationNames: [],
    supportingPapers: bridge.supportingPapers || [],
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function buildCommunityLimitationIdea(graph, bridge, currentMethodIds) {
  const limitation = graph.getNode(bridge.sourceId);
  const method = graph.getNode(bridge.targetId);
  if (!limitation || !method || limitation.type !== NODE_TYPES.LIMITATION || method.type !== NODE_TYPES.METHOD) return null;
  if (currentMethodIds.has(method.id)) return null;

  const relevance = Math.min(5, 2.7 + (bridge.score * 0.35));
  const novelty = 4.0;
  const feasibility = 3.6;
  const evidence = Math.min(5, 1.8 + (bridge.supportingPapers?.length || 0) * 0.45);
  const risk = 2.0;
  const cost = 1.9;

  return {
    template: 'community_limitation_remedy',
    title: `针对“${limitation.name}”引入 ${method.name}`,
    summary: `${limitation.name} 与 ${method.name} 之间跨社区存在局部桥接路径，适合把它当作一个跨主题 remedy 方向。`,
    problemNames: [],
    methodNames: [method.name],
    limitationNames: [limitation.name],
    supportingPapers: bridge.supportingPapers || [],
    scores: {
      relevance: Number(relevance.toFixed(1)),
      novelty: Number(novelty.toFixed(1)),
      feasibility: Number(feasibility.toFixed(1)),
      evidence: Number(evidence.toFixed(1)),
      risk: Number(risk.toFixed(1)),
      cost: Number(cost.toFixed(1))
    },
    totalScore: scoreIdea({ relevance, novelty, feasibility, evidence, risk, cost })
  };
}

function traverseNeighborhood(graph, relationIndex, seedNodes, options = {}) {
  const maxHops = Number(options.maxHops || 2);
  const allowedLayers = normalizeLayerFilter(options.layers);
  const layerMode = options.layerMode || 'any';
  const visited = new Set(seedNodes.map((node) => node.id));
  const buckets = new Map();
  const queue = seedNodes.map((node) => ({ nodeId: node.id, depth: 0 }));

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxHops) continue;

    const relationships = [
      ...(relationIndex.outgoing.get(current.nodeId) || []),
      ...(relationIndex.incoming.get(current.nodeId) || [])
    ];

    for (const relationship of relationships) {
      if (!relationshipMatchesLayerMode(relationship, layerMode)) continue;
      const nextNodeId = relationship.sourceId === current.nodeId ? relationship.targetId : relationship.sourceId;
      if (visited.has(nextNodeId)) continue;
      const nextNode = graph.getNode(nextNodeId);
      if (!nextNode || !nodeInAllowedLayers(nextNode, allowedLayers)) continue;

      visited.add(nextNodeId);
      const depth = current.depth + 1;
      if (!buckets.has(depth)) buckets.set(depth, []);
      buckets.get(depth).push({
        node: nextNode,
        via: relationship.type,
        depth
      });
      queue.push({ nodeId: nextNodeId, depth });
    }
  }

  return buckets;
}

function buildDivergence(graph, query, options = {}) {
  const session = options.session || createBrainstormSession(graph, query, options);
  const { relationIndex, allowedLayers, seedPapers, seedNodes } = session;

  if (!seedNodes.length) {
    return {
      query,
      mode: 'diverge',
      seedPapers: [],
      seedNodes: [],
      similarProblems: [],
      relatedConcepts: [],
      potentialConstraints: [],
      transferableMethods: [],
      combinableMethods: [],
      exploredHops: Number(options.maxHops || 2)
    };
  }

  const seedPaperIds = new Set(seedPapers.map((paper) => paper.id));
  const buckets = traverseNeighborhood(graph, relationIndex, seedNodes, options);
  const discovered = [
    ...seedNodes
      .filter((node) => isBrainstormEligibleNode(node))
      .map((node) => ({ node, via: 'seed', depth: 0 })),
    ...[...buckets.values()].flat()
  ]
    .filter((entry) => isBrainstormEligibleNode(entry.node));

  let similarProblems = discovered
    .filter((entry) => entry.node.type === NODE_TYPES.PROBLEM)
    .sort((left, right) => rankSharedNode(right.node, seedPaperIds) - rankSharedNode(left.node, seedPaperIds))
    .slice(0, 8)
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      layer: entry.node.properties?.layer || '',
      via: entry.via,
      support: Array.isArray(entry.node.properties?.paperTitles) ? entry.node.properties.paperTitles.length : 0
    }));

  let relatedConcepts = discovered
    .filter((entry) => [NODE_TYPES.METHOD, NODE_TYPES.CLAIM, NODE_TYPES.FINDING, NODE_TYPES.FUTURE_DIRECTION].includes(entry.node.type))
    .sort((left, right) => rankSharedNode(right.node, seedPaperIds) - rankSharedNode(left.node, seedPaperIds))
    .slice(0, 10)
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      type: entry.node.type,
      layer: entry.node.properties?.layer || '',
      via: entry.via
    }));

  let potentialConstraints = discovered
    .filter((entry) => [NODE_TYPES.LIMITATION, NODE_TYPES.ASSUMPTION, NODE_TYPES.DATASET, NODE_TYPES.BENCHMARK, NODE_TYPES.METRIC].includes(entry.node.type))
    .sort((left, right) => rankSharedNode(right.node, seedPaperIds) - rankSharedNode(left.node, seedPaperIds))
    .slice(0, 10)
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      type: entry.node.type,
      layer: entry.node.properties?.layer || '',
      via: entry.via
    }));

  const transferableMethods = discovered
    .filter((entry) => entry.node.type === NODE_TYPES.METHOD)
    .filter((entry) => {
      return findLinkedNodes(graph, relationIndex, entry.node.id, 'outgoing', [NODE_TYPES.PROBLEM])
        .some((linked) => linked.relationship.type === EDGE_TYPES.TRANSFERABLE_TO || linked.relationship.type === EDGE_TYPES.APPLIES_TO);
    })
    .sort((left, right) => rankSharedNode(right.node, seedPaperIds) - rankSharedNode(left.node, seedPaperIds))
    .slice(0, 6)
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      layer: entry.node.properties?.layer || '',
      paperCount: Array.isArray(entry.node.properties?.paperTitles) ? entry.node.properties.paperTitles.length : 0
    }));

  const combinableMethods = discovered
    .filter((entry) => entry.node.type === NODE_TYPES.METHOD)
    .filter((entry) => {
      return findLinkedNodes(graph, relationIndex, entry.node.id, 'outgoing', [NODE_TYPES.METHOD])
        .some((linked) => linked.relationship.type === EDGE_TYPES.COMBINES_WITH || linked.relationship.type === EDGE_TYPES.COMPATIBLE_WITH);
    })
    .sort((left, right) => rankSharedNode(right.node, seedPaperIds) - rankSharedNode(left.node, seedPaperIds))
    .slice(0, 6)
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      layer: entry.node.properties?.layer || '',
      paperCount: Array.isArray(entry.node.properties?.paperTitles) ? entry.node.properties.paperTitles.length : 0
    }));

  const community = session.getCommunityContext();
  if (!community.stats?.fallback) {
    const communityDerivedIds = new Set([
      ...community.latentNeighbors.map((entry) => entry.id),
      ...community.boundaryNodes.map((entry) => entry.id),
      ...community.crossCommunityBridges.flatMap((entry) => [entry.sourceId, entry.targetId])
    ]);

    similarProblems = mergeCommunityEntries(
      similarProblems,
      community.latentNeighbors.filter((entry) => entry.type === NODE_TYPES.PROBLEM),
      8,
      (entry) => ({
        id: entry.id,
        name: entry.name,
        layer: entry.layer,
        via: 'community',
        support: entry.support || 0
      })
    );

    relatedConcepts = mergeCommunityEntries(
      relatedConcepts,
      [
        ...community.latentNeighbors,
        ...community.boundaryNodes
      ].filter((entry) => [NODE_TYPES.METHOD, NODE_TYPES.CLAIM, NODE_TYPES.FINDING, NODE_TYPES.FUTURE_DIRECTION].includes(entry.type)),
      10,
      (entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        layer: entry.layer,
        via: entry.via === 'community-boundary' ? 'community-boundary' : 'community'
      })
    );

    potentialConstraints = mergeCommunityEntries(
      potentialConstraints,
      [
        ...community.latentNeighbors,
        ...community.boundaryNodes
      ].filter((entry) => [NODE_TYPES.LIMITATION, NODE_TYPES.ASSUMPTION].includes(entry.type)),
      10,
      (entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        layer: entry.layer,
        via: entry.via === 'community-boundary' ? 'community-boundary' : 'community'
      })
    );

    relatedConcepts = relatedConcepts.map((entry) => (
      communityDerivedIds.has(entry.id) && entry.via !== 'seed'
        ? {
          ...entry,
          via: 'community'
        }
        : entry
    ));
  }

  return {
    query,
    mode: 'diverge',
    seedPapers: seedPapers.map((paper) => ({ id: paper.id, title: paper.name })),
    seedNodes: seedNodes.map((node) => ({ id: node.id, name: node.name, type: node.type, layer: node.properties?.layer || '' })),
    similarProblems,
    relatedConcepts,
    potentialConstraints,
    transferableMethods,
    combinableMethods,
    exploredHops: Number(options.maxHops || 2)
  };
}

function buildConvergedDirections(divergence, ideas, limit = 5) {
  const directions = [];

  for (const idea of ideas.slice(0, limit)) {
    directions.push({
      title: idea.title,
      summary: idea.summary,
      focus: unique([...(idea.problemNames || []), ...(idea.methodNames || []), ...(idea.limitationNames || [])]).slice(0, 5),
      evidencePapers: idea.supportingPapers || [],
      score: idea.totalScore
    });
  }

  if (!directions.length && divergence.similarProblems[0]) {
    directions.push({
      title: `聚焦 ${divergence.similarProblems[0].name} 的约束重组`,
      summary: '当前图中最接近的研究问题已经识别出来，下一步适合围绕约束、假设和可迁移方法做收敛。',
      focus: [
        divergence.similarProblems[0].name,
        ...(divergence.potentialConstraints.slice(0, 2).map((item) => item.name)),
        ...(divergence.transferableMethods.slice(0, 2).map((item) => item.name))
      ].slice(0, 5),
      evidencePapers: divergence.seedPapers.map((paper) => paper.title).slice(0, 4),
      score: 0
    });
  }

  return directions;
}

export function buildBrainstorm(graph, query, options = {}) {
  const mode = options.mode === 'converge' ? 'converge' : 'diverge';
  const session = createBrainstormSession(graph, query, options);
  const divergence = buildDivergence(graph, query, {
    ...options,
    session
  });

  if (mode === 'diverge') {
    return divergence;
  }

  const ideas = buildResearchIdeas(graph, query, {
    ...options,
    limit: Number(options.limit || 5),
    layers: options.layers,
    session
  });

  return {
    ...divergence,
    mode: 'converge',
    ideas: ideas.ideas,
    convergedDirections: buildConvergedDirections(divergence, ideas.ideas, Number(options.limit || 5))
  };
}

export function buildResearchIdeas(graph, query, options = {}) {
  const limit = Number(options.limit || 5);
  const session = options.session || createBrainstormSession(graph, query, options);
  const { relationIndex, allowedLayers, seedPapers } = session;

  if (!seedPapers.length) {
    return {
      query,
      seedPapers: [],
      seedProblems: [],
      ideas: []
    };
  }

  const seedPaperIds = new Set(seedPapers.map((paper) => paper.id));
  const seedProblems = [];
  const seedLimitations = [];
  const seedClaims = [];
  const currentMethods = [];
  const currentMethodIds = new Set();
  const seedProblemIds = new Set();

  for (const paper of seedPapers) {
    for (const entry of findLinkedNodes(graph, relationIndex, paper.id, 'outgoing', [NODE_TYPES.PROBLEM])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      seedProblems.push(entry.node);
      seedProblemIds.add(entry.node.id);
    }

    for (const entry of findLinkedNodes(graph, relationIndex, paper.id, 'outgoing', [NODE_TYPES.METHOD])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      currentMethods.push(entry.node);
      currentMethodIds.add(entry.node.id);
    }

    for (const entry of findLinkedNodes(graph, relationIndex, paper.id, 'outgoing', [NODE_TYPES.LIMITATION])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      seedLimitations.push(entry.node);
    }

    for (const entry of findLinkedNodes(graph, relationIndex, paper.id, 'outgoing', [NODE_TYPES.CLAIM])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      seedClaims.push(entry.node);
    }
  }

  const uniqueProblems = listNodesByType(
    { nodes: seedProblems, relationships: [] },
    NODE_TYPES.PROBLEM
  );

  const relatedProblemIds = new Set(seedProblemIds);
  const relatedProblems = [...uniqueProblems];
  for (const problem of uniqueProblems) {
    for (const entry of findLinkedNodes(graph, relationIndex, problem.id, 'outgoing', [NODE_TYPES.PROBLEM])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      if (entry.relationship.type !== EDGE_TYPES.RELATED_TO || relatedProblemIds.has(entry.node.id)) continue;
      relatedProblemIds.add(entry.node.id);
      relatedProblems.push(entry.node);
    }
  }

  const candidateMethodMap = new Map();
  for (const problem of relatedProblems) {
    for (const entry of findLinkedNodes(graph, relationIndex, problem.id, 'incoming', [NODE_TYPES.METHOD])) {
      if (!nodeInAllowedLayers(entry.node, allowedLayers)) continue;
      if (!isBrainstormEligibleNode(entry.node)) continue;
      if (entry.relationship.type !== EDGE_TYPES.APPLIES_TO && entry.relationship.type !== EDGE_TYPES.TRANSFERABLE_TO) continue;
      candidateMethodMap.set(entry.node.id, entry.node);
    }
  }
  const candidateMethods = [...candidateMethodMap.values()];

  const ideas = [];
  const uniqueLimitations = listNodesByType(
    { nodes: seedLimitations, relationships: [] },
    NODE_TYPES.LIMITATION
  );

  for (const limitation of uniqueLimitations.slice(0, 3)) {
    const idea = buildLimitationIdea(graph, relationIndex, limitation, candidateMethods, currentMethodIds, seedProblemIds);
    if (idea) ideas.push(idea);
  }

  for (const problem of uniqueProblems.slice(0, 3)) {
    const idea = buildTransferIdea(graph, relationIndex, problem, candidateMethods, currentMethodIds);
    if (idea) ideas.push(idea);
  }

  for (const problem of uniqueProblems.slice(0, 3)) {
    const idea = buildProblemCoverageIdea(graph, relationIndex, problem, candidateMethods, currentMethodIds);
    if (idea) ideas.push(idea);
  }

  for (const method of currentMethods.slice(0, 3)) {
    const idea = buildCombinationIdea(graph, relationIndex, method, currentMethodIds);
    if (idea) ideas.push(idea);
  }

  for (const claim of seedClaims.slice(0, 4)) {
    const idea = buildEvidenceGapIdea(graph, relationIndex, claim);
    if (idea) ideas.push(idea);
  }

  const community = session.getCommunityContext();
  if (!community.stats?.fallback) {
    const communityIdeas = [];

    for (const bridge of community.crossCommunityBridges.slice(0, 10)) {
      let idea = null;
      if (bridge.kind === 'method_method') {
        idea = buildCommunityMethodCombinationIdea(graph, bridge, currentMethodIds);
      } else if (bridge.kind === 'problem_method') {
        idea = buildCommunityProblemTransferIdea(graph, bridge, currentMethodIds);
      } else if (bridge.kind === 'limitation_method') {
        idea = buildCommunityLimitationIdea(graph, bridge, currentMethodIds);
      }

      if (idea) {
        communityIdeas.push(idea);
      }
    }

    ideas.push(...communityIdeas.slice(0, 3));
  }

  const dedupedIdeas = [];
  const seen = new Set();
  for (const idea of ideas.sort((left, right) => right.totalScore - left.totalScore)) {
    const key = `${idea.template}:${idea.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedIdeas.push(idea);
    if (dedupedIdeas.length >= limit) break;
  }

  return {
    query,
    seedPapers: seedPapers.map((paper) => ({
      id: paper.id,
      title: paper.name
    })),
    seedProblems: uniqueProblems.slice(0, 6).map((problem) => ({
      id: problem.id,
      name: problem.name
    })),
    ideas: dedupedIdeas
  };
}

export function listNodesByType(graph, type) {
  const nodes = typeof graph.getNodesByType === 'function'
    ? graph.getNodesByType(type)
    : graph.nodes.filter((node) => node.type === type);
  return [...nodes].sort((left, right) => left.name.localeCompare(right.name));
}
