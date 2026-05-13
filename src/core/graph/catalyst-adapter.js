import { normalizeText } from '../../lib/utils.js';
import {
  normalizeAbstractMechanismNames,
  normalizeAbstractMechanismRecord,
  normalizeAbstractMechanismRecords
} from './abstract-mechanisms.js';
import { buildStructuralAnalogy } from './analogy.js';
import { buildBridgeRetrieval } from './bridge-retrieval.js';
import { queryCrossDomainBridges } from './domain-bridges.js';
import { buildIdeaCatalystPacketBundle } from './idea-catalyst-packets.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from './domain-taxonomy.js';
import { buildInterdisciplinaryPotentialRanking } from './interdisciplinary-ranking.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

const CATALYST_QUERY_CONTRACT_VERSION = 'idea-catalyst-query-v1';
const CATALYST_MECHANISM_TRAVERSAL_VERSION = 'idea-catalyst-mechanism-traversal-v1';
const CATALYST_COVERAGE_VERSION = 'idea-catalyst-coverage-v1';
const CATALYST_MECHANISM_BRIDGES_VERSION = 'idea-catalyst-mechanism-bridges-v1';
const MAX_CATALYST_LIMIT = 50;
const MAX_CATALYST_SOURCE_DOMAINS = 12;
const MAX_CATALYST_RELEVANCE_THRESHOLD = 25;

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.floor(number);
  if (integer < min) return fallback;
  return Math.min(integer, max);
}

function normalizeCatalystResourceParams(params = {}) {
  const normalized = { ...params };
  if (params.limit !== undefined) {
    normalized.limit = boundedInteger(params.limit, 8, { max: MAX_CATALYST_LIMIT });
  }
  if (params.numSourceDomains !== undefined || params.num_source_domains !== undefined) {
    normalized.numSourceDomains = boundedInteger(
      params.numSourceDomains || params.num_source_domains,
      3,
      { max: MAX_CATALYST_SOURCE_DOMAINS }
    );
  }
  if (params.relevanceThreshold !== undefined || params.relevance_threshold !== undefined) {
    normalized.relevanceThreshold = boundedInteger(
      params.relevanceThreshold || params.relevance_threshold,
      3,
      { max: MAX_CATALYST_RELEVANCE_THRESHOLD }
    );
  }
  return normalized;
}

function normalizeMechanismQuery(value) {
  if (Array.isArray(value)) return normalizeAbstractMechanismNames(value);
  if (typeof value === 'string') {
    return normalizeAbstractMechanismNames(value.split(','));
  }
  return [];
}

function normalizeCatalystDomainLabel(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node.properties?.fieldOfStudy,
    ...(node.properties?.fieldCandidates || []),
    ...(node.properties?.domainTags || [])
  ]);
}

function collectMechanismsForNode(graph, node) {
  const related = graph.getOutgoing(node.id)
    .filter((relationship) => (
      relationship.type === EDGE_TYPES.INSTANTIATES
      || relationship.type === EDGE_TYPES.IMPLEMENTS
      || relationship.type === EDGE_TYPES.CONSTRAINS
    ))
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((entry) => entry?.type === NODE_TYPES.ABSTRACT_MECHANISM)
    .map((entry) => entry.name);

  return normalizeAbstractMechanismNames([
    ...(node.properties?.abstractMechanismObjects || []),
    ...(node.properties?.abstractMechanisms || []),
    ...(node.properties?.mechanismHints || []),
    ...related
  ]);
}

function buildMechanismRecordFromNode(node) {
  return normalizeAbstractMechanismRecord({
    name: node?.name,
    mechanismType: node?.properties?.mechanismType,
    mechanismCategory: node?.properties?.mechanismCategory || node?.properties?.category,
    description: node?.properties?.description,
    aliases: node?.properties?.aliases
  });
}

function collectDomainNodes(graph, domain) {
  const normalizedTarget = normalizeFieldOfStudy(domain);
  if (!normalizedTarget) return [];
  return graph.nodes.filter((node) => collectNodeDomains(node).includes(normalizedTarget));
}

function buildDomainCoverage(graph, domain, requestedMechanisms = []) {
  const normalizedDomain = normalizeFieldOfStudy(domain);
  const nodes = collectDomainNodes(graph, normalizedDomain);
  const mechanismCounts = new Map();
  const normalizedRequests = normalizeMechanismQuery(requestedMechanisms);

  const summary = {
    domain: normalizedDomain,
    paperCount: 0,
    problemCount: 0,
    methodCount: 0,
    limitationCount: 0,
    assumptionCount: 0,
    mechanismCount: 0,
    matchedMechanisms: [],
    missingMechanisms: [],
    topMechanisms: []
  };

  for (const node of nodes) {
    if (node.type === NODE_TYPES.PAPER) summary.paperCount += 1;
    if (node.type === NODE_TYPES.PROBLEM) summary.problemCount += 1;
    if (node.type === NODE_TYPES.METHOD) summary.methodCount += 1;
    if (node.type === NODE_TYPES.LIMITATION) summary.limitationCount += 1;
    if (node.type === NODE_TYPES.ASSUMPTION) summary.assumptionCount += 1;

    for (const mechanism of collectMechanismsForNode(graph, node)) {
      mechanismCounts.set(mechanism, (mechanismCounts.get(mechanism) || 0) + 1);
    }
  }

  const topMechanisms = [...mechanismCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([mechanism, supportCount]) => ({ mechanism, supportCount }));

  summary.mechanismCount = topMechanisms.length;
  summary.topMechanisms = topMechanisms.slice(0, 5);
  summary.matchedMechanisms = normalizedRequests.filter((mechanism) => mechanismCounts.has(mechanism));
  summary.missingMechanisms = normalizedRequests.filter((mechanism) => !mechanismCounts.has(mechanism));

  return summary;
}

function relationshipRole(type) {
  if (type === EDGE_TYPES.INSTANTIATES) return 'problem';
  if (type === EDGE_TYPES.IMPLEMENTS) return 'method';
  if (type === EDGE_TYPES.CONSTRAINS) return 'limitation';
  return 'related';
}

function buildSupportingNodeEntry(graph, relationship) {
  const node = graph.getNode(relationship.sourceId);
  if (!node) return null;
  const domains = collectNodeDomains(node);
  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    role: relationshipRole(relationship.type),
    relationshipType: relationship.type,
    domain: normalizeFieldOfStudy(domains[0] || ''),
    domains
  };
}

function findMechanismNode(graph, mechanism) {
  const queryRecord = normalizeAbstractMechanismRecord(mechanism);
  if (!queryRecord) return null;

  return graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM).find((node) => {
    const nodeRecord = buildMechanismRecordFromNode(node);
    if (!nodeRecord) return false;
    return (
      nodeRecord.canonicalId === queryRecord.canonicalId
      || nodeRecord.aliases.includes(queryRecord.name)
      || queryRecord.aliases.includes(nodeRecord.name)
      || nodeRecord.aliases.some((alias) => queryRecord.aliases.includes(alias))
    );
  }) || null;
}

function buildMechanismMetadata(mechanismNode, mechanism) {
  const mergedRecord = normalizeAbstractMechanismRecords([
    buildMechanismRecordFromNode(mechanismNode),
    mechanism
  ])[0] || normalizeAbstractMechanismRecord(mechanism);

  return {
    mechanismNodeId: mechanismNode?.id || null,
    mechanismType: mergedRecord?.mechanismType || 'general',
    mechanismCategory: mergedRecord?.mechanismCategory || null,
    description: mergedRecord?.description || mechanism,
    aliases: Array.isArray(mergedRecord?.aliases) ? mergedRecord.aliases : [],
    provenanceVersion: mechanismNode?.properties?.provenanceVersion || null,
    supportingPaperCount: Number(mechanismNode?.properties?.supportingPaperCount || 0),
    supportingDomains: Array.isArray(mechanismNode?.properties?.supportingDomains)
      ? mechanismNode.properties.supportingDomains
      : [],
    supportingNodeTypes: Array.isArray(mechanismNode?.properties?.supportingNodeTypes)
      ? mechanismNode.properties.supportingNodeTypes
      : [],
    supportingPaperTitles: Array.isArray(mechanismNode?.properties?.supportingPaperTitles)
      ? mechanismNode.properties.supportingPaperTitles
      : []
  };
}

function collectMechanismSupportingNodes(graph, mechanismNode) {
  return graph.getIncoming(mechanismNode.id)
    .filter((relationship) => (
      relationship.type === EDGE_TYPES.INSTANTIATES
      || relationship.type === EDGE_TYPES.IMPLEMENTS
      || relationship.type === EDGE_TYPES.CONSTRAINS
    ))
    .map((relationship) => buildSupportingNodeEntry(graph, relationship))
    .filter(Boolean)
    .sort((left, right) => left.nodeName.localeCompare(right.nodeName));
}

function scoreMechanismBridge(targetDomainSupportCount, sourceDomainSupportCount, sourceDomainCount, typeCount) {
  return Number((
    targetDomainSupportCount * 1.2
    + sourceDomainSupportCount * 1.3
    + sourceDomainCount * 0.7
    + typeCount * 0.25
  ).toFixed(4));
}

function buildDomainSupportEntries(entries, limit) {
  return Object.values(entries.reduce((accumulator, entry) => {
    const existing = accumulator[entry.domain] || {
      domain: entry.domain,
      supportCount: 0,
      nodeTypes: new Set(),
      supportingNodes: []
    };
    existing.supportCount += 1;
    existing.nodeTypes.add(entry.nodeType);
    if (!existing.supportingNodes.some((item) => item.nodeId === entry.nodeId)) {
      existing.supportingNodes.push(entry);
    }
    accumulator[entry.domain] = existing;
    return accumulator;
  }, {}))
    .map((entry) => ({
      domain: entry.domain,
      supportCount: entry.supportCount,
      nodeTypes: [...entry.nodeTypes].sort(),
      supportingNodes: entry.supportingNodes.slice(0, limit)
    }))
    .sort((left, right) => right.supportCount - left.supportCount || left.domain.localeCompare(right.domain));
}

export function buildMechanismTraversal(graph, params = {}) {
  const queryMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);
  const limit = boundedInteger(params.limit, 8, { max: MAX_CATALYST_LIMIT });

  const matches = queryMechanisms.map((mechanism) => {
    const mechanismNode = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)
      .find((node) => normalizeText(node.name) === normalizeText(mechanism));
    if (!mechanismNode) {
      return {
        mechanism,
        matched: false,
        mechanismNodeId: null,
        mechanismType: 'general',
        mechanismCategory: null,
        description: mechanism,
        aliases: [],
        provenanceVersion: null,
        relatedDomains: [],
        supportingNodeCount: 0,
        supportingPaperCount: 0,
        supportingDomains: [],
        supportingNodeTypes: [],
        supportingPaperTitles: [],
        supportingNodes: []
      };
    }

    const supportingNodes = graph.getIncoming(mechanismNode.id)
      .filter((relationship) => (
        relationship.type === EDGE_TYPES.INSTANTIATES
        || relationship.type === EDGE_TYPES.IMPLEMENTS
        || relationship.type === EDGE_TYPES.CONSTRAINS
      ))
      .map((relationship) => buildSupportingNodeEntry(graph, relationship))
      .filter(Boolean)
      .sort((left, right) => left.nodeName.localeCompare(right.nodeName));

    const relatedDomains = [...new Set(
      supportingNodes.flatMap((entry) => entry.domains || []).filter(Boolean)
    )];

    return {
      mechanism,
      matched: true,
      ...buildMechanismMetadata(mechanismNode, mechanism),
      relatedDomains,
      supportingNodeCount: supportingNodes.length,
      supportingNodes: supportingNodes.slice(0, limit)
    };
  });

  return {
    contractVersion: CATALYST_MECHANISM_TRAVERSAL_VERSION,
    queryMechanisms,
    matches,
    unmatchedMechanisms: matches.filter((entry) => !entry.matched).map((entry) => entry.mechanism)
  };
}

export function buildMechanismBridgeAnalysis(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);
  const limit = boundedInteger(params.limit, 8, { max: MAX_CATALYST_LIMIT });
  const requestedMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);

  const targetMechanisms = requestedMechanisms.length
    ? requestedMechanisms
    : graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)
      .map((node) => node.name)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit);

  const candidateMechanismCommunities = [];
  const crossDomainMechanismBridges = [];

  for (const mechanism of targetMechanisms) {
    const mechanismNode = findMechanismNode(graph, mechanism);
    if (!mechanismNode) continue;

    const supportingNodes = collectMechanismSupportingNodes(graph, mechanismNode);
    const targetDomainNodes = supportingNodes.filter((entry) => entry.domains.includes(targetDomain));
    if (!targetDomainNodes.length) continue;

    const sourceEntries = supportingNodes.flatMap((entry) => (
      entry.domains
        .filter((domain) => domain && domain !== targetDomain)
        .map((domain) => ({
          ...entry,
          domain
        }))
    ));
    if (!sourceEntries.length) continue;

    const supportingDomains = buildDomainSupportEntries(sourceEntries, limit);
    const sourceDomains = supportingDomains.map((entry) => entry.domain);
    const targetDomainTypes = new Set(targetDomainNodes.map((entry) => entry.nodeType));
    const sourceTypes = new Set(sourceEntries.map((entry) => entry.nodeType));
    const bridgeStrength = scoreMechanismBridge(
      targetDomainNodes.length,
      sourceEntries.length,
      sourceDomains.length,
      new Set([...targetDomainTypes, ...sourceTypes]).size
    );

    candidateMechanismCommunities.push({
      mechanism,
      ...buildMechanismMetadata(mechanismNode, mechanism),
      targetDomain,
      sourceDomains,
      targetDomainSupportCount: targetDomainNodes.length,
      crossDomainSupportCount: sourceEntries.length,
      bridgeStrength,
      targetDomainNodes: targetDomainNodes.slice(0, limit),
      supportingDomains
    });

    for (const domainEntry of supportingDomains) {
      crossDomainMechanismBridges.push({
        mechanism,
        ...buildMechanismMetadata(mechanismNode, mechanism),
        targetDomain,
        sourceDomain: domainEntry.domain,
        targetDomainNodeCount: targetDomainNodes.length,
        sourceDomainNodeCount: domainEntry.supportCount,
        supportingNodeCount: targetDomainNodes.length + domainEntry.supportCount,
        bridgeStrength: scoreMechanismBridge(
          targetDomainNodes.length,
          domainEntry.supportCount,
          1,
          new Set([
            ...targetDomainNodes.map((entry) => entry.nodeType),
            ...domainEntry.nodeTypes
          ]).size
        ),
        supportingNodes: [
          ...targetDomainNodes.slice(0, Math.max(1, Math.floor(limit / 2))),
          ...domainEntry.supportingNodes.slice(0, Math.max(1, Math.ceil(limit / 2)))
        ]
      });
    }
  }

  candidateMechanismCommunities.sort((left, right) => (
    right.bridgeStrength - left.bridgeStrength
    || right.crossDomainSupportCount - left.crossDomainSupportCount
    || left.mechanism.localeCompare(right.mechanism)
  ));

  crossDomainMechanismBridges.sort((left, right) => (
    right.bridgeStrength - left.bridgeStrength
    || left.sourceDomain.localeCompare(right.sourceDomain)
    || left.mechanism.localeCompare(right.mechanism)
  ));

  const supportingDomains = Object.values(crossDomainMechanismBridges.reduce((accumulator, entry) => {
    const existing = accumulator[entry.sourceDomain] || {
      domain: entry.sourceDomain,
      matchedMechanisms: new Set(),
      bridgeCount: 0,
      supportCount: 0
    };
    existing.matchedMechanisms.add(entry.mechanism);
    existing.bridgeCount += 1;
    existing.supportCount += entry.sourceDomainNodeCount;
    accumulator[entry.sourceDomain] = existing;
    return accumulator;
  }, {}))
    .map((entry) => ({
      domain: entry.domain,
      matchedMechanismCount: entry.matchedMechanisms.size,
      matchedMechanisms: [...entry.matchedMechanisms].sort(),
      bridgeCount: entry.bridgeCount,
      supportCount: entry.supportCount
    }))
    .sort((left, right) => (
      right.bridgeCount - left.bridgeCount
      || right.supportCount - left.supportCount
      || left.domain.localeCompare(right.domain)
    ));

  return {
    contractVersion: CATALYST_MECHANISM_BRIDGES_VERSION,
    targetDomain,
    targetMechanisms,
    candidateMechanismCommunities: candidateMechanismCommunities.slice(0, limit),
    crossDomainMechanismBridges: crossDomainMechanismBridges.slice(0, limit),
    supportingDomains: supportingDomains.slice(0, limit),
    unmatchedMechanisms: targetMechanisms.filter((mechanism) => (
      !candidateMechanismCommunities.some((entry) => entry.mechanism === mechanism)
    ))
  };
}

export function buildCoverageQuery(graph, params = {}) {
  const requestedMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);

  return {
    contractVersion: CATALYST_COVERAGE_VERSION,
    targetDomain,
    requestedMechanisms,
    targetDomainCoverage: buildDomainCoverage(graph, targetDomain, requestedMechanisms)
  };
}

export function buildDomainRankedScoutingQuery(graph, params = {}) {
  const normalizedParams = normalizeCatalystResourceParams(params);
  const requestedMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);
  const bridgeResult = queryCrossDomainBridges(graph, normalizedParams);
  return {
    contractVersion: CATALYST_QUERY_CONTRACT_VERSION,
    targetDomain: bridgeResult.targetDomain,
    abstractChallenge: bridgeResult.abstractChallenge,
    targetMechanisms: requestedMechanisms,
    candidateDomains: bridgeResult.candidateDomains.map((entry) => ({
      ...entry,
      coverage: buildDomainCoverage(graph, entry.domain, requestedMechanisms)
    })),
    prunedDomains: bridgeResult.prunedDomains,
    relevancePolicy: bridgeResult.relevancePolicy
  };
}

export function buildCatalystQuery(graph, params = {}) {
  const normalizedParams = normalizeCatalystResourceParams(params);
  const targetMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);
  const bridgeResult = queryCrossDomainBridges(graph, normalizedParams);
  const fineGrainedDomain = normalizeCatalystDomainLabel(normalizedParams.fineGrainedDomain, bridgeResult.targetDomain);
  const coarseGrainedDomain = normalizeCatalystDomainLabel(normalizedParams.coarseGrainedDomain, bridgeResult.targetDomain);
  const scouting = buildDomainRankedScoutingQuery(graph, normalizedParams);
  const mechanismTraversal = buildMechanismTraversal(graph, {
    mechanisms: targetMechanisms.length
      ? targetMechanisms
      : bridgeResult.mechanismMatches.map((entry) => entry.mechanism),
    limit: normalizedParams.limit
  });
  const analysisMechanisms = targetMechanisms.length
    ? targetMechanisms
    : mechanismTraversal.matches.filter((entry) => entry.matched).map((entry) => entry.mechanism);
  const mechanismBridgeAnalysis = buildMechanismBridgeAnalysis(graph, {
    targetDomain: bridgeResult.targetDomain,
    mechanisms: analysisMechanisms,
    limit: normalizedParams.limit
  });
  const bridgeRetrieval = buildBridgeRetrieval(graph, {
    targetDomain: bridgeResult.targetDomain,
    abstractChallenge: bridgeResult.abstractChallenge,
    mechanisms: analysisMechanisms,
    limit: normalizedParams.limit,
    domainDistanceMatrix: bridgeResult.domainDistanceMatrix
  });
  const structuralAnalogy = buildStructuralAnalogy(graph, {
    targetDomain: bridgeResult.targetDomain,
    abstractChallenge: bridgeResult.abstractChallenge,
    mechanisms: analysisMechanisms,
    limit: normalizedParams.limit
  }, bridgeRetrieval);
  const interdisciplinaryPotentialRanking = buildInterdisciplinaryPotentialRanking(
    bridgeRetrieval,
    structuralAnalogy,
    {
      targetDomain: bridgeResult.targetDomain,
      abstractChallenge: bridgeResult.abstractChallenge,
      mechanisms: analysisMechanisms,
      limit: normalizedParams.limit
    }
  );
  const coverage = {
    targetDomain: buildDomainCoverage(graph, bridgeResult.targetDomain, targetMechanisms),
    candidateDomains: scouting.candidateDomains.map((entry) => ({
      domain: entry.domain,
      coverage: entry.coverage
    }))
  };
  const result = {
    contractVersion: CATALYST_QUERY_CONTRACT_VERSION,
    bridgeContractVersion: bridgeResult.contractVersion,
    targetDomain: bridgeResult.targetDomain,
    fineGrainedDomain,
    coarseGrainedDomain,
    abstractChallenge: bridgeResult.abstractChallenge,
    targetMechanisms,
    relevancePolicy: bridgeResult.relevancePolicy,
    prunedDomains: bridgeResult.prunedDomains,
    candidateSourceDomains: scouting.candidateDomains,
    candidateDomains: scouting.candidateDomains,
    bridgeNodes: bridgeResult.bridgeNodes,
    mechanismMatches: bridgeResult.mechanismMatches,
    mechanismTraversal,
    mechanismBridgeAnalysis,
    bridgeRetrieval,
    structuralAnalogy,
    interdisciplinaryPotentialRanking,
    coverage
  };
  const packetBundle = buildIdeaCatalystPacketBundle(graph, result, {
    targetDomain: bridgeResult.targetDomain,
    fineGrainedDomain,
    coarseGrainedDomain,
    abstractChallenge: bridgeResult.abstractChallenge,
    mechanisms: targetMechanisms,
    numSourceDomains: normalizedParams.numSourceDomains,
    relevanceThreshold: normalizedParams.relevanceThreshold,
    limit: normalizedParams.limit
  });

  return {
    ...result,
    researchQuestions: packetBundle.decomposition.research_questions,
    remainingChallenges: packetBundle.target_domain_analysis[0]?.remaining_challenges || [],
    crossDomainSearches: packetBundle.cross_domain_queries,
    packetBundle
  };
}
