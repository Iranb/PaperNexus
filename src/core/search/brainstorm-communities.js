import createGraph from 'ngraph.graph';
import { detectClusters } from 'ngraph.leiden';
import { normalizeDomainTags, normalizeFieldOfStudy } from '../graph/domain-taxonomy.js';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import { isBrainstormEligibleNode } from '../graph/brainstorm-view.js';
import { jaccardSimilarity, scoreTokenOverlap, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';

const COMMUNITY_NODE_TYPES = new Set([
  NODE_TYPES.PROBLEM,
  NODE_TYPES.METHOD,
  NODE_TYPES.CLAIM,
  NODE_TYPES.FINDING,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION,
  NODE_TYPES.FUTURE_DIRECTION,
  NODE_TYPES.RESEARCH_GOAL
]);

const HIGH_VALUE_TYPES = new Set([
  NODE_TYPES.PROBLEM,
  NODE_TYPES.METHOD,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION
]);

const BRIDGE_INTERMEDIATE_TYPES = new Set([
  NODE_TYPES.PROBLEM,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION,
  NODE_TYPES.CLAIM,
  NODE_TYPES.FINDING
]);

const EXPLICIT_EDGE_WEIGHTS = {
  [EDGE_TYPES.COMBINES_WITH]: 3.2,
  [EDGE_TYPES.COMPATIBLE_WITH]: 3.0,
  [EDGE_TYPES.APPLIES_TO]: 2.4,
  [EDGE_TYPES.TRANSFERABLE_TO]: 2.2,
  [EDGE_TYPES.MAY_BE_ADDRESSED_BY]: 2.2,
  [EDGE_TYPES.RELATED_TO]: 1.8,
  [EDGE_TYPES.SIMILAR_TO]: 1.7,
  [EDGE_TYPES.LEADS_TO]: 1.4,
  [EDGE_TYPES.DEPENDS_ON]: 1.3,
  [EDGE_TYPES.REQUIRES]: 1.3
};

const DEFAULT_OPTIONS = {
  maxSeedPapers: 8,
  maxSeedConcepts: 24,
  maxCandidateConcepts: 128,
  maxBridgePapers: 8,
  maxPaperConcepts: 12,
  maxProjectedEdges: 600,
  maxBridgeDepth: 3,
  maxAnalysisMs: 80,
  minProjectedNodes: 4,
  minProjectedEdges: 3,
  randomSeed: 42
};

export const DOMAIN_COMMUNITY_PROFILE_CONTRACT_VERSION = 'idea-catalyst-domain-community-profile-v1';

function nodeTypePriority(type) {
  const priorities = {
    [NODE_TYPES.PROBLEM]: 4,
    [NODE_TYPES.METHOD]: 4,
    [NODE_TYPES.LIMITATION]: 3.6,
    [NODE_TYPES.ASSUMPTION]: 3.2,
    [NODE_TYPES.CLAIM]: 2.8,
    [NODE_TYPES.FINDING]: 2.8,
    [NODE_TYPES.FUTURE_DIRECTION]: 2.4,
    [NODE_TYPES.RESEARCH_GOAL]: 2.4
  };

  return priorities[type] || 1.5;
}

function relationshipWeight(type) {
  return EXPLICIT_EDGE_WEIGHTS[type] || 0;
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node?.properties?.fieldOfStudy,
    ...(node?.properties?.fieldCandidates || []),
    ...(node?.properties?.domainTags || []),
    ...(node?.properties?.sourceDomains || []),
    node?.properties?.targetDomain
  ]);
}

function pairKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}::${rightId}` : `${rightId}::${leftId}`;
}

function clusterKeyOf(membership) {
  if (!membership) return '';
  if (membership.subcommunityId) return membership.subcommunityId;
  return `community:${membership.communityId}`;
}

function addToMapSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function addScore(scoreMap, id, delta) {
  scoreMap.set(id, (scoreMap.get(id) || 0) + delta);
}

function addReason(reasonMap, id, reason) {
  if (!reasonMap.has(id)) reasonMap.set(id, new Set());
  reasonMap.get(id).add(reason);
}

function addPaperSupport(paperSupportMap, nodeId, paperTitle) {
  if (!paperTitle) return;
  addToMapSet(paperSupportMap, nodeId, paperTitle);
}

function addWeightedEdge(edgeMap, sourceId, targetId, update = {}) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const key = pairKey(sourceId, targetId);
  const current = edgeMap.get(key) || {
    sourceId: sourceId < targetId ? sourceId : targetId,
    targetId: sourceId < targetId ? targetId : sourceId,
    weight: 0,
    strongWeight: 0,
    weakWeight: 0,
    relationTypes: new Set(),
    paperTitles: new Set()
  };

  current.weight += Number(update.weight || 0);
  current.strongWeight += Number(update.strongWeight || 0);
  current.weakWeight += Number(update.weakWeight || 0);
  if (update.relationType) current.relationTypes.add(update.relationType);
  for (const title of update.paperTitles || []) current.paperTitles.add(title);
  edgeMap.set(key, current);
}

function isCommunityConceptNode(node, allowedLayers = null) {
  if (!node || !COMMUNITY_NODE_TYPES.has(node.type) || !isBrainstormEligibleNode(node)) return false;
  if (!allowedLayers?.size) return true;
  return allowedLayers.has(node.properties?.layer || '');
}

function collectPaperConcepts(graph, relationIndex, paperId, allowedLayers = null) {
  const concepts = [];

  for (const relationship of relationIndex.outgoing.get(paperId) || []) {
    const node = graph.getNode(relationship.targetId);
    if (!isCommunityConceptNode(node, allowedLayers)) continue;
    concepts.push(node);
  }

  return concepts;
}

function collectLinkedPapers(graph, relationIndex, nodeId) {
  const papers = [];

  for (const relationship of relationIndex.incoming.get(nodeId) || []) {
    const node = graph.getNode(relationship.sourceId);
    if (node?.type === NODE_TYPES.PAPER) papers.push(node);
  }

  for (const relationship of relationIndex.outgoing.get(nodeId) || []) {
    const node = graph.getNode(relationship.targetId);
    if (node?.type === NODE_TYPES.PAPER) papers.push(node);
  }

  return papers;
}

function collectConceptNeighbors(graph, relationIndex, nodeId, allowedLayers = null) {
  const neighbors = [];

  for (const relationship of relationIndex.outgoing.get(nodeId) || []) {
    const node = graph.getNode(relationship.targetId);
    if (!isCommunityConceptNode(node, allowedLayers)) continue;
    neighbors.push({ node, relationship });
  }

  for (const relationship of relationIndex.incoming.get(nodeId) || []) {
    const node = graph.getNode(relationship.sourceId);
    if (!isCommunityConceptNode(node, allowedLayers)) continue;
    neighbors.push({ node, relationship });
  }

  return neighbors;
}

function hasMeaningfulWeakPair(left, right) {
  if (!left || !right) return false;
  if (HIGH_VALUE_TYPES.has(left.type) || HIGH_VALUE_TYPES.has(right.type)) return true;
  return left.type === NODE_TYPES.METHOD || right.type === NODE_TYPES.METHOD;
}

function compareScoredEntries(left, right) {
  const leftName = left.name || left.node?.name || '';
  const rightName = right.name || right.node?.name || '';
  return right.score - left.score
    || right.paperCount - left.paperCount
    || right.priority - left.priority
    || leftName.localeCompare(rightName);
}

function collectCandidateConcepts(graph, session, rawOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...rawOptions
  };
  const {
    relationIndex,
    seedPapers = [],
    seedConcepts = [],
    seedNodes = [],
    query = '',
    queryTokens = [],
    allowedLayers = null
  } = session;

  const scoreMap = new Map();
  const reasonMap = new Map();
  const paperSupportMap = new Map();
  const nodeMap = new Map();
  const seedPaperIds = new Set(seedPapers.slice(0, options.maxSeedPapers).map((paper) => paper.id));
  const bridgePaperScores = new Map();
  const usedPaperIds = new Set(seedPaperIds);

  const addConcept = (node, baseScore, reason, paperTitle = '') => {
    if (!isCommunityConceptNode(node, allowedLayers)) return;
    nodeMap.set(node.id, node);
    addScore(scoreMap, node.id, baseScore);
    addReason(reasonMap, node.id, reason);
    addPaperSupport(paperSupportMap, node.id, paperTitle);

    const nameTokens = tokenizeWithoutStopwords(node.name || '');
    addScore(scoreMap, node.id, scoreTokenOverlap(queryTokens, nameTokens) * 2.2);
    addScore(scoreMap, node.id, nodeTypePriority(node.type));
    addScore(scoreMap, node.id, Math.min(0.8, (node.properties?.brainstormScore || 0) * 0.6));
  };

  for (const node of seedConcepts.slice(0, options.maxSeedConcepts)) {
    addConcept(node, 7.5, 'seed-concept');
  }

  for (const node of seedNodes) {
    if (isCommunityConceptNode(node, allowedLayers)) {
      addConcept(node, 6.4, 'seed-node');
    }
  }

  for (const paper of seedPapers.slice(0, options.maxSeedPapers)) {
    for (const concept of collectPaperConcepts(graph, relationIndex, paper.id, allowedLayers)) {
      addConcept(concept, 5.8, 'seed-paper', paper.name);
    }
  }

  const expansionConcepts = unique([
    ...seedConcepts.map((node) => node.id),
    ...[...nodeMap.keys()]
  ])
    .map((nodeId) => graph.getNode(nodeId))
    .filter(Boolean)
    .slice(0, options.maxSeedConcepts);

  for (const node of expansionConcepts) {
    for (const { node: neighbor, relationship } of collectConceptNeighbors(graph, relationIndex, node.id, allowedLayers)) {
      const weight = relationshipWeight(relationship.type);
      if (!weight) continue;
      addConcept(neighbor, 1.4 + weight, `explicit:${relationship.type}`);

      for (const paper of collectLinkedPapers(graph, relationIndex, neighbor.id)) {
        if (seedPaperIds.has(paper.id)) continue;
        bridgePaperScores.set(paper.id, (bridgePaperScores.get(paper.id) || 0) + 1 + (weight * 0.25));
      }
    }
  }

  const bridgePaperIds = [...bridgePaperScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, options.maxBridgePapers)
    .map(([paperId]) => paperId);

  for (const paperId of bridgePaperIds) {
    const paper = graph.getNode(paperId);
    usedPaperIds.add(paperId);
    for (const concept of collectPaperConcepts(graph, relationIndex, paperId, allowedLayers)) {
      addConcept(concept, 2.6, 'bridge-paper', paper?.name || '');
    }
  }

  const scoredNodes = [...nodeMap.values()]
    .map((node) => ({
      node,
      score: Number((scoreMap.get(node.id) || 0).toFixed(3)),
      paperCount: (paperSupportMap.get(node.id) || new Set()).size,
      priority: nodeTypePriority(node.type),
      reasons: [...(reasonMap.get(node.id) || [])],
      paperTitles: [...(paperSupportMap.get(node.id) || new Set())]
    }))
    .filter((entry) => entry.score > 2.4)
    .sort(compareScoredEntries)
    .slice(0, options.maxCandidateConcepts);

  return {
    concepts: scoredNodes,
    conceptMap: new Map(scoredNodes.map((entry) => [entry.node.id, entry])),
    usedPaperIds
  };
}

function buildProjectedConceptGraph(graph, session, candidateContext, rawOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...rawOptions
  };
  const { relationIndex, allowedLayers = null } = session;
  const edgeMap = new Map();
  const conceptEntries = candidateContext.concepts;
  const conceptIds = new Set(conceptEntries.map((entry) => entry.node.id));
  const conceptMap = candidateContext.conceptMap;
  const usedPaperIds = new Set(candidateContext.usedPaperIds);

  for (const entry of conceptEntries) {
    for (const relationship of relationIndex.outgoing.get(entry.node.id) || []) {
      const weight = relationshipWeight(relationship.type);
      if (!weight || !conceptIds.has(relationship.targetId)) continue;
      addWeightedEdge(edgeMap, relationship.sourceId, relationship.targetId, {
        weight,
        strongWeight: weight,
        relationType: relationship.type,
        paperTitles: [relationship.properties?.sourcePaperTitle].filter(Boolean)
      });
    }
  }

  const cooccurrenceCounts = new Map();

  for (const paperId of usedPaperIds) {
    const concepts = collectPaperConcepts(graph, relationIndex, paperId, allowedLayers)
      .filter((node) => conceptIds.has(node.id))
      .map((node) => conceptMap.get(node.id))
      .filter(Boolean)
      .sort(compareScoredEntries)
      .slice(0, options.maxPaperConcepts);

    for (let leftIndex = 0; leftIndex < concepts.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < concepts.length; rightIndex += 1) {
        const left = concepts[leftIndex].node;
        const right = concepts[rightIndex].node;
        if (!hasMeaningfulWeakPair(left, right)) continue;

        const similarity = jaccardSimilarity(left.name, right.name);
        if (similarity < 0.08 && !(HIGH_VALUE_TYPES.has(left.type) && HIGH_VALUE_TYPES.has(right.type))) continue;

        const key = pairKey(left.id, right.id);
        const current = cooccurrenceCounts.get(key) || {
          sourceId: left.id < right.id ? left.id : right.id,
          targetId: left.id < right.id ? right.id : left.id,
          count: 0,
          similarity: 0,
          paperTitles: new Set()
        };
        current.count += 1;
        current.similarity = Math.max(current.similarity, similarity);
        current.paperTitles.add(graph.getNode(paperId)?.name || '');
        cooccurrenceCounts.set(key, current);
      }
    }
  }

  for (const current of cooccurrenceCounts.values()) {
    const weakWeight = 0.35
      + Math.min(0.35, (current.count - 1) * 0.18)
      + Math.min(0.22, current.similarity * 0.3);
    addWeightedEdge(edgeMap, current.sourceId, current.targetId, {
      weight: weakWeight,
      weakWeight,
      paperTitles: [...current.paperTitles]
    });
  }

  const edges = [...edgeMap.values()]
    .map((edge) => ({
      ...edge,
      weight: Number(edge.weight.toFixed(3)),
      strongWeight: Number(edge.strongWeight.toFixed(3)),
      weakWeight: Number(edge.weakWeight.toFixed(3)),
      relationTypes: [...edge.relationTypes].sort(),
      paperTitles: [...edge.paperTitles].filter(Boolean).sort()
    }))
    .sort((left, right) => right.weight - left.weight || left.sourceId.localeCompare(right.sourceId) || left.targetId.localeCompare(right.targetId))
    .slice(0, options.maxProjectedEdges);

  const projected = createGraph();
  const adjacency = new Map();

  for (const entry of conceptEntries) {
    projected.addNode(entry.node.id, {
      type: entry.node.type,
      size: 1,
      score: entry.score
    });
    adjacency.set(entry.node.id, []);
  }

  for (const edge of edges) {
    projected.addLink(edge.sourceId, edge.targetId, { weight: edge.weight });
    adjacency.get(edge.sourceId)?.push({
      nodeId: edge.targetId,
      weight: edge.weight
    });
    adjacency.get(edge.targetId)?.push({
      nodeId: edge.sourceId,
      weight: edge.weight
    });
  }

  return {
    graph: projected,
    nodes: conceptEntries.map((entry) => entry.node),
    nodeStats: conceptEntries,
    nodeStatMap: new Map(conceptEntries.map((entry) => [entry.node.id, entry])),
    edges,
    adjacency,
    conceptIds
  };
}

function runSubcommunityDetection(projected, community, randomSeed) {
  const communitySet = new Set(community.nodeIds);
  const internalEdges = projected.edges.filter((edge) => communitySet.has(edge.sourceId) && communitySet.has(edge.targetId));
  if (community.nodeIds.length < 4 || internalEdges.length < 3) return [];

  const subgraph = createGraph();
  for (const nodeId of community.nodeIds) {
    subgraph.addNode(nodeId, projected.nodeStatMap.get(nodeId)?.node || {});
  }
  for (const edge of internalEdges) {
    subgraph.addLink(edge.sourceId, edge.targetId, { weight: edge.weight });
  }

  const resolutions = [0.8, 1.05, 1.4];
  for (const resolution of resolutions) {
    const result = detectClusters(subgraph, {
      quality: 'cpm',
      resolution,
      refine: true,
      randomSeed,
      linkWeight: (link) => link.data?.weight ?? 1
    });
    const communities = [...result.getCommunities().entries()]
      .map(([subId, nodeIds]) => ({
        id: `${community.id}:${subId}`,
        parentId: community.id,
        nodeIds: [...nodeIds].sort()
      }))
      .filter((entry) => entry.nodeIds.length > 0);

    if (communities.length > 1) {
      return communities;
    }
  }

  return [];
}

function partitionProjectedGraph(projected, rawOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...rawOptions
  };
  const result = detectClusters(projected.graph, {
    quality: 'modularity',
    refine: true,
    randomSeed: options.randomSeed,
    linkWeight: (link) => link.data?.weight ?? 1
  });
  const membership = new Map();
  const communities = [...result.getCommunities().entries()]
    .map(([communityId, nodeIds]) => ({
      id: `community:${communityId}`,
      numericId: communityId,
      nodeIds: [...nodeIds].sort()
    }))
    .sort((left, right) => right.nodeIds.length - left.nodeIds.length || left.id.localeCompare(right.id));

  for (const community of communities) {
    for (const nodeId of community.nodeIds) {
      membership.set(nodeId, {
        communityId: community.id,
        subcommunityId: null
      });
    }
  }

  const subcommunities = [];
  for (const community of communities) {
    for (const subcommunity of runSubcommunityDetection(projected, community, options.randomSeed)) {
      subcommunities.push(subcommunity);
      for (const nodeId of subcommunity.nodeIds) {
        const current = membership.get(nodeId) || {};
        membership.set(nodeId, {
          ...current,
          communityId: community.id,
          subcommunityId: subcommunity.id
        });
      }
    }
  }

  return {
    communities,
    subcommunities,
    membership,
    quality: Number(result.quality().toFixed(4))
  };
}

function buildCommunityAdjacency(projected, membership) {
  const adjacency = new Map();

  for (const edge of projected.edges) {
    const leftMembership = membership.get(edge.sourceId);
    const rightMembership = membership.get(edge.targetId);
    const leftKey = clusterKeyOf(leftMembership);
    const rightKey = clusterKeyOf(rightMembership);
    if (!leftKey || !rightKey || leftKey === rightKey) continue;
    const key = pairKey(leftKey, rightKey);
    adjacency.set(key, (adjacency.get(key) || 0) + edge.weight);
  }

  return adjacency;
}

function addDomainCounter(counterMap, domain, amount = 1) {
  if (!domain) return;
  counterMap[domain] = Number(((counterMap[domain] || 0) + amount).toFixed(4));
}

function addDomainId(map, domain, value) {
  if (!domain || !value) return;
  if (!map.has(domain)) map.set(domain, new Set());
  map.get(domain).add(value);
}

function countDomainsForNodes(graph, entries = []) {
  const counts = {};
  for (const entry of entries) {
    const node = graph.getNode(entry.id);
    const domains = collectNodeDomains(node);
    for (const domain of domains.length ? domains : [normalizeFieldOfStudy(node?.properties?.fieldOfStudy)]) {
      if (!domain) continue;
      addDomainCounter(counts, domain, 1);
    }
  }
  return counts;
}

export function deriveDomainCommunityProfile(graph, communityContext = {}) {
  const communities = Array.isArray(communityContext.communities) ? communityContext.communities : [];
  const crossCommunityBridges = Array.isArray(communityContext.crossCommunityBridges)
    ? communityContext.crossCommunityBridges
    : [];
  const latentNeighbors = Array.isArray(communityContext.latentNeighbors) ? communityContext.latentNeighbors : [];
  const boundaryNodes = Array.isArray(communityContext.boundaryNodes) ? communityContext.boundaryNodes : [];
  const communityDomains = {};
  const communityIdsByDomain = new Map();

  for (const community of communities) {
    const domainCounts = {};
    for (const nodeId of community.nodeIds || []) {
      const node = graph.getNode(nodeId);
      const domains = collectNodeDomains(node);
      for (const domain of domains) {
        addDomainCounter(domainCounts, domain, 1);
        addDomainId(communityIdsByDomain, domain, community.id);
      }
    }

    const total = Object.values(domainCounts).reduce((sum, value) => sum + value, 0) || 1;
    communityDomains[community.id] = Object.fromEntries(
      Object.entries(domainCounts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([domain, count]) => [domain, {
          count,
          share: Number((count / total).toFixed(4))
        }])
    );
  }

  const domainBridgeScores = {};
  const domainBridgeCounts = {};
  const enrichedCrossDomainBridges = [];

  for (const bridge of crossCommunityBridges) {
    const sourceNode = graph.getNode(bridge.sourceId);
    const targetNode = graph.getNode(bridge.targetId);
    const sourceDomain = normalizeFieldOfStudy(
      sourceNode?.properties?.fieldOfStudy,
      sourceNode?.properties?.domainTags || []
    );
    const targetDomain = normalizeFieldOfStudy(
      targetNode?.properties?.fieldOfStudy,
      targetNode?.properties?.domainTags || []
    );
    if (!sourceDomain || !targetDomain || sourceDomain === targetDomain) continue;

    const enriched = {
      ...bridge,
      sourceDomain,
      targetDomain,
      bridgeType: 'cross-domain'
    };
    enrichedCrossDomainBridges.push(enriched);

    addDomainCounter(domainBridgeScores, sourceDomain, bridge.score || 0);
    addDomainCounter(domainBridgeScores, targetDomain, bridge.score || 0);
    addDomainCounter(domainBridgeCounts, sourceDomain, 1);
    addDomainCounter(domainBridgeCounts, targetDomain, 1);
  }

  const domainLatentNeighborCounts = countDomainsForNodes(graph, latentNeighbors);
  const domainBoundaryCounts = countDomainsForNodes(graph, boundaryNodes);
  const topBridgeDomains = unique([
    ...Object.keys(domainBridgeScores),
    ...Object.keys(domainLatentNeighborCounts),
    ...Object.keys(domainBoundaryCounts)
  ])
    .map((domain) => ({
      domain,
      score: Number((
        (domainBridgeScores[domain] || 0)
        + ((domainLatentNeighborCounts[domain] || 0) * 0.65)
        + ((domainBoundaryCounts[domain] || 0) * 0.4)
      ).toFixed(4)),
      communityBridgeWeight: Number((domainBridgeScores[domain] || 0).toFixed(4)),
      bridgeCount: Number(domainBridgeCounts[domain] || 0),
      latentNeighborCount: Number(domainLatentNeighborCounts[domain] || 0),
      boundaryNodeCount: Number(domainBoundaryCounts[domain] || 0),
      communities: [...(communityIdsByDomain.get(domain) || [])].sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => (
      right.score - left.score
      || right.communityBridgeWeight - left.communityBridgeWeight
      || left.domain.localeCompare(right.domain)
    ))
    .slice(0, 10);

  return {
    contractVersion: DOMAIN_COMMUNITY_PROFILE_CONTRACT_VERSION,
    communityDomains,
    crossDomainBridges: enrichedCrossDomainBridges,
    domainBridgeScores,
    domainBridgeCounts,
    domainLatentNeighborCounts,
    domainBoundaryCounts,
    topBridgeDomains
  };
}

function deriveBoundaryNodes(projected, partition) {
  const boundary = [];

  for (const node of projected.nodes) {
    const membership = partition.membership.get(node.id);
    const currentKey = clusterKeyOf(membership);
    if (!currentKey) continue;

    const externalWeights = new Map();
    let internalWeight = 0;

    for (const neighbor of projected.adjacency.get(node.id) || []) {
      const neighborMembership = partition.membership.get(neighbor.nodeId);
      const neighborKey = clusterKeyOf(neighborMembership);
      if (!neighborKey) continue;
      if (neighborKey === currentKey) {
        internalWeight += neighbor.weight;
      } else {
        externalWeights.set(neighborKey, (externalWeights.get(neighborKey) || 0) + neighbor.weight);
      }
    }

    const rankedExternal = [...externalWeights.values()].sort((left, right) => right - left);
    if (!rankedExternal.length || internalWeight <= 0.4) continue;

    const topExternal = rankedExternal[0];
    if (topExternal < 0.65) continue;

    const nodeStat = projected.nodeStatMap.get(node.id);
    boundary.push({
      id: node.id,
      name: node.name,
      type: node.type,
      layer: node.properties?.layer || '',
      via: 'community-boundary',
      score: Number((topExternal + internalWeight + (nodeStat?.score || 0)).toFixed(3)),
      support: (nodeStat?.paperTitles || []).length,
      communityId: membership.communityId,
      subcommunityId: membership.subcommunityId
    });
  }

  return boundary.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function directSeedNeighborIds(projected, seedConceptIds) {
  const ids = new Set(seedConceptIds);
  for (const nodeId of seedConceptIds) {
    for (const neighbor of projected.adjacency.get(nodeId) || []) {
      ids.add(neighbor.nodeId);
    }
  }
  return ids;
}

function deriveLatentNeighbors(projected, partition, session, boundaryNodeIds = new Set()) {
  const seedConceptIds = new Set(session.seedConcepts.map((node) => node.id));
  const visibleIds = directSeedNeighborIds(projected, seedConceptIds);
  const seedCommunities = new Set();
  const communityAdjacency = new Map();

  for (const edge of projected.edges) {
    const leftMembership = partition.membership.get(edge.sourceId);
    const rightMembership = partition.membership.get(edge.targetId);
    if (!leftMembership?.communityId || !rightMembership?.communityId || leftMembership.communityId === rightMembership.communityId) continue;
    const key = pairKey(leftMembership.communityId, rightMembership.communityId);
    communityAdjacency.set(key, (communityAdjacency.get(key) || 0) + edge.weight);
  }

  for (const nodeId of seedConceptIds) {
    const membership = partition.membership.get(nodeId);
    if (membership?.communityId) seedCommunities.add(membership.communityId);
  }

  const latent = [];
  for (const node of projected.nodes) {
    if (seedConceptIds.has(node.id)) continue;

    const membership = partition.membership.get(node.id);
    if (!membership) continue;

    let communityBonus = 0;
    if (seedCommunities.has(membership.communityId)) {
      communityBonus = 2.1;
    } else {
      const linkedWeight = Math.max(
        0,
        ...[...seedCommunities].map((communityId) => (
          communityAdjacency.get(pairKey(communityId, membership.communityId)) || 0
        ))
      );
      if (linkedWeight < 1.2) continue;
      communityBonus = 1.25 + Math.min(1.1, linkedWeight * 0.2);
    }

    const nodeStat = projected.nodeStatMap.get(node.id);
    const score = (nodeStat?.score || 0)
      + communityBonus
      + (visibleIds.has(node.id) ? 0.6 : 1.6)
      + (boundaryNodeIds.has(node.id) ? 0.6 : 0);

    latent.push({
      id: node.id,
      name: node.name,
      type: node.type,
      layer: node.properties?.layer || '',
      via: 'community',
      score: Number(score.toFixed(3)),
      support: (nodeStat?.paperTitles || []).length,
      communityId: membership.communityId,
      subcommunityId: membership.subcommunityId
    });
  }

  return latent.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function hasDirectEdge(projected, leftId, rightId) {
  return projected.edges.some((edge) => (
    (edge.sourceId === leftId && edge.targetId === rightId)
    || (edge.sourceId === rightId && edge.targetId === leftId)
  ));
}

function findShortestPath(projected, startId, targetId, maxDepth, allowIntermediate) {
  const queue = [{
    nodeId: startId,
    depth: 0,
    path: [startId],
    weight: 0
  }];
  const visited = new Map([[startId, 0]]);

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;

    for (const neighbor of projected.adjacency.get(current.nodeId) || []) {
      const nextDepth = current.depth + 1;
      const nextNode = projected.nodes.find((node) => node.id === neighbor.nodeId);
      if (!nextNode) continue;

      if (neighbor.nodeId !== targetId && !allowIntermediate(nextNode, nextDepth)) continue;
      if (visited.has(neighbor.nodeId) && visited.get(neighbor.nodeId) <= nextDepth) continue;

      const next = {
        nodeId: neighbor.nodeId,
        depth: nextDepth,
        path: [...current.path, neighbor.nodeId],
        weight: current.weight + neighbor.weight
      };

      if (neighbor.nodeId === targetId) {
        return next;
      }

      visited.set(neighbor.nodeId, nextDepth);
      queue.push(next);
    }
  }

  return null;
}

function deriveCrossCommunityBridges(projected, partition, session) {
  const bridges = [];
  const adjacencyByCluster = buildCommunityAdjacency(projected, partition.membership);
  const seedConceptIds = new Set(session.seedConcepts.map((node) => node.id));
  const seedProblemIds = new Set(session.seedConcepts.filter((node) => node.type === NODE_TYPES.PROBLEM).map((node) => node.id));
  const seedLimitationIds = new Set(session.seedConcepts.filter((node) => node.type === NODE_TYPES.LIMITATION).map((node) => node.id));
  const currentMethodIds = new Set(session.seedConcepts.filter((node) => node.type === NODE_TYPES.METHOD).map((node) => node.id));
  const nodes = projected.nodes;

  const bridgeScore = (leftId, rightId, pathWeight) => {
    const leftMembership = partition.membership.get(leftId);
    const rightMembership = partition.membership.get(rightId);
    const key = pairKey(clusterKeyOf(leftMembership), clusterKeyOf(rightMembership));
    const clusterWeight = adjacencyByCluster.get(key) || 0;
    return Number((pathWeight + clusterWeight).toFixed(3));
  };

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const leftMembership = partition.membership.get(left.id);
      const rightMembership = partition.membership.get(right.id);
      if (!leftMembership || !rightMembership) continue;
      if (clusterKeyOf(leftMembership) === clusterKeyOf(rightMembership)) continue;

      if (left.type === NODE_TYPES.METHOD && right.type === NODE_TYPES.METHOD) {
        if (!(currentMethodIds.has(left.id) || currentMethodIds.has(right.id))) continue;
        if (hasDirectEdge(projected, left.id, right.id)) continue;

        const path = findShortestPath(
          projected,
          left.id,
          right.id,
          DEFAULT_OPTIONS.maxBridgeDepth,
          (node) => BRIDGE_INTERMEDIATE_TYPES.has(node.type)
        );
        if (!path) continue;

        bridges.push({
          kind: 'method_method',
          sourceId: left.id,
          targetId: right.id,
          score: bridgeScore(left.id, right.id, path.weight),
          path: path.path,
          supportingPapers: unique([
            ...(left.properties?.paperTitles || []),
            ...(right.properties?.paperTitles || [])
          ]).slice(0, 5)
        });
      }

      if (left.type === NODE_TYPES.PROBLEM && right.type === NODE_TYPES.METHOD) {
        if (!seedProblemIds.has(left.id) || currentMethodIds.has(right.id)) continue;
        const path = findShortestPath(
          projected,
          left.id,
          right.id,
          DEFAULT_OPTIONS.maxBridgeDepth,
          (node) => BRIDGE_INTERMEDIATE_TYPES.has(node.type)
        );
        if (!path) continue;
        bridges.push({
          kind: 'problem_method',
          sourceId: left.id,
          targetId: right.id,
          score: bridgeScore(left.id, right.id, path.weight),
          path: path.path,
          supportingPapers: unique([
            ...(left.properties?.paperTitles || []),
            ...(right.properties?.paperTitles || [])
          ]).slice(0, 5)
        });
      }

      if (left.type === NODE_TYPES.LIMITATION && right.type === NODE_TYPES.METHOD) {
        if (!seedLimitationIds.has(left.id) || currentMethodIds.has(right.id)) continue;
        const path = findShortestPath(
          projected,
          left.id,
          right.id,
          DEFAULT_OPTIONS.maxBridgeDepth,
          (node) => BRIDGE_INTERMEDIATE_TYPES.has(node.type)
        );
        if (!path) continue;
        bridges.push({
          kind: 'limitation_method',
          sourceId: left.id,
          targetId: right.id,
          score: bridgeScore(left.id, right.id, path.weight),
          path: path.path,
          supportingPapers: unique([
            ...(left.properties?.paperTitles || []),
            ...(right.properties?.paperTitles || [])
          ]).slice(0, 5)
        });
      }

      if (right.type === NODE_TYPES.PROBLEM && left.type === NODE_TYPES.METHOD) {
        if (!seedProblemIds.has(right.id) || currentMethodIds.has(left.id)) continue;
        const path = findShortestPath(
          projected,
          right.id,
          left.id,
          DEFAULT_OPTIONS.maxBridgeDepth,
          (node) => BRIDGE_INTERMEDIATE_TYPES.has(node.type)
        );
        if (!path) continue;
        bridges.push({
          kind: 'problem_method',
          sourceId: right.id,
          targetId: left.id,
          score: bridgeScore(right.id, left.id, path.weight),
          path: path.path,
          supportingPapers: unique([
            ...(right.properties?.paperTitles || []),
            ...(left.properties?.paperTitles || [])
          ]).slice(0, 5)
        });
      }

      if (right.type === NODE_TYPES.LIMITATION && left.type === NODE_TYPES.METHOD) {
        if (!seedLimitationIds.has(right.id) || currentMethodIds.has(left.id)) continue;
        const path = findShortestPath(
          projected,
          right.id,
          left.id,
          DEFAULT_OPTIONS.maxBridgeDepth,
          (node) => BRIDGE_INTERMEDIATE_TYPES.has(node.type)
        );
        if (!path) continue;
        bridges.push({
          kind: 'limitation_method',
          sourceId: right.id,
          targetId: left.id,
          score: bridgeScore(right.id, left.id, path.weight),
          path: path.path,
          supportingPapers: unique([
            ...(right.properties?.paperTitles || []),
            ...(left.properties?.paperTitles || [])
          ]).slice(0, 5)
        });
      }
    }
  }

  return bridges
    .filter((bridge, index, array) => array.findIndex((entry) => (
      entry.kind === bridge.kind
      && entry.sourceId === bridge.sourceId
      && entry.targetId === bridge.targetId
    )) === index)
    .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId));
}

export function buildBrainstormCommunityContext(graph, session, rawOptions = {}) {
  const options = {
    ...DEFAULT_OPTIONS,
    ...rawOptions
  };
  const startedAt = Date.now();

  const candidateContext = collectCandidateConcepts(graph, session, options);
  if (candidateContext.concepts.length < options.minProjectedNodes) {
    return {
      communities: [],
      subcommunities: [],
      latentNeighbors: [],
      boundaryNodes: [],
      crossCommunityBridges: [],
      stats: {
        prunedNodeCount: 0,
        edgeCount: 0,
        fallback: true,
        reason: 'too-few-candidates'
      }
    };
  }

  const projected = buildProjectedConceptGraph(graph, session, candidateContext, options);
  if (projected.edges.length < options.minProjectedEdges) {
    return {
      communities: [],
      subcommunities: [],
      latentNeighbors: [],
      boundaryNodes: [],
      crossCommunityBridges: [],
      stats: {
        prunedNodeCount: Math.max(0, candidateContext.concepts.length - projected.nodes.length),
        edgeCount: projected.edges.length,
        fallback: true,
        reason: 'too-few-edges'
      }
    };
  }

  const partition = partitionProjectedGraph(projected, options);
  const boundaryNodes = deriveBoundaryNodes(projected, partition);
  const latentNeighbors = deriveLatentNeighbors(projected, partition, session, new Set(boundaryNodes.map((node) => node.id)));
  const crossCommunityBridges = deriveCrossCommunityBridges(projected, partition, session);
  const durationMs = Date.now() - startedAt;

  if (durationMs > options.maxAnalysisMs && !latentNeighbors.length && !crossCommunityBridges.length) {
    return {
      communities: [],
      subcommunities: [],
      latentNeighbors: [],
      boundaryNodes: [],
      crossCommunityBridges: [],
      stats: {
        prunedNodeCount: Math.max(0, candidateContext.concepts.length - projected.nodes.length),
        edgeCount: projected.edges.length,
        fallback: true,
        reason: 'time-budget'
      }
    };
  }

  return {
    communities: partition.communities,
    subcommunities: partition.subcommunities,
    latentNeighbors,
    boundaryNodes,
    crossCommunityBridges,
    stats: {
      prunedNodeCount: Math.max(0, candidateContext.concepts.length - projected.nodes.length),
      edgeCount: projected.edges.length,
      fallback: false,
      quality: partition.quality,
      durationMs
    }
  };
}
