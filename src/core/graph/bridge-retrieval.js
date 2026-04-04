import {
  normalizeText,
  scoreTokenOverlap,
  stableHash,
  tokenizeWithoutStopwords,
  unique
} from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { normalizeDomainTags, normalizeFieldOfStudy, scoreDomainDistance } from './domain-taxonomy.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const BRIDGE_RETRIEVAL_CONTRACT_VERSION = 'idea-catalyst-bridge-retrieval-v1';
export const BRIDGE_RETRIEVAL_BACKEND = 'graph-text-fallback-v1';

function normalizeMechanismQuery(value) {
  if (Array.isArray(value)) return normalizeAbstractMechanismNames(value);
  if (typeof value === 'string') {
    return normalizeAbstractMechanismNames(value.split(','));
  }
  return [];
}

function normalizeChallengeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node.properties?.fieldOfStudy,
    ...(node.properties?.fieldCandidates || []),
    ...(node.properties?.domainTags || []),
    ...(node.properties?.sourceDomains || []),
    node.properties?.targetDomain
  ]);
}

function collectSourceDomains(node, targetDomain) {
  const explicitSourceDomains = normalizeDomainTags(node.properties?.sourceDomains || [])
    .filter((domain) => domain !== targetDomain);
  if (explicitSourceDomains.length) {
    return explicitSourceDomains;
  }

  return collectNodeDomains(node).filter((domain) => domain !== targetDomain);
}

function collectNodeMechanisms(graph, node) {
  const direct = normalizeAbstractMechanismNames([
    ...(node.properties?.abstractMechanismObjects || []),
    ...(node.properties?.abstractMechanisms || []),
    ...(node.properties?.mechanismHints || [])
  ]);
  const linked = graph.getOutgoing(node.id)
    .filter((relationship) => (
      relationship.type === EDGE_TYPES.INSTANTIATES
      || relationship.type === EDGE_TYPES.IMPLEMENTS
      || relationship.type === EDGE_TYPES.CONSTRAINS
    ))
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((candidate) => candidate?.type === NODE_TYPES.ABSTRACT_MECHANISM)
    .map((candidate) => candidate.name);

  return normalizeAbstractMechanismNames([...direct, ...linked]);
}

function collectSupportingSnippets(graph, node) {
  return graph.getOutgoing(node.id)
    .filter((relationship) => relationship.type === EDGE_TYPES.SUPPORTED_BY_SNIPPET)
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((candidate) => candidate?.type === NODE_TYPES.EVIDENCE_SNIPPET);
}

function collectSourceTakeaways(graph, node) {
  if (node.type === NODE_TYPES.TAKEAWAY) {
    return [node];
  }

  return graph.getIncoming(node.id)
    .filter((relationship) => relationship.type === EDGE_TYPES.RECONTEXTUALIZES_TO)
    .map((relationship) => graph.getNode(relationship.sourceId))
    .filter((candidate) => candidate?.type === NODE_TYPES.TAKEAWAY);
}

function collectConnectedChallenges(graph, node) {
  const directChallenges = node.type === NODE_TYPES.CHALLENGE
    ? [node]
    : graph.getOutgoing(node.id)
      .filter((relationship) => relationship.type === EDGE_TYPES.ADDRESSES)
      .map((relationship) => graph.getNode(relationship.targetId))
      .filter((candidate) => candidate?.type === NODE_TYPES.CHALLENGE);

  const takeawayChallenges = collectSourceTakeaways(graph, node)
    .flatMap((takeaway) => graph.getOutgoing(takeaway.id))
    .filter((relationship) => relationship.type === EDGE_TYPES.ADDRESSES)
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((candidate) => candidate?.type === NODE_TYPES.CHALLENGE);

  return unique([...directChallenges, ...takeawayChallenges].map((candidate) => candidate.id))
    .map((id) => graph.getNode(id))
    .filter(Boolean);
}

function getSearchText(node) {
  return [
    node.name,
    node.properties?.text,
    node.properties?.description,
    node.properties?.retrievalText,
    node.properties?.analogyText,
    node.properties?.domainSpecificText,
    node.properties?.domainAgnosticText,
    ...(node.properties?.relatedChallenges || []),
    ...(node.properties?.addressesChallenges || []),
    ...(node.properties?.sourceTakeaways || []),
    ...(node.properties?.abstractMechanisms || [])
  ]
    .filter(Boolean)
    .join(' ');
}

function scoreTextSimilarity(queryText, candidateText) {
  const normalizedQuery = String(queryText || '').trim().toLowerCase();
  const normalizedCandidate = String(candidateText || '').trim().toLowerCase();
  const queryTokens = tokenizeWithoutStopwords(normalizedQuery);
  const candidateTokens = tokenizeWithoutStopwords(normalizedCandidate);
  if (!queryTokens.length || !candidateTokens.length) return 0;

  const overlap = scoreTokenOverlap(queryTokens, candidateTokens);
  const phraseBonus = normalizedQuery && normalizedCandidate.includes(normalizedQuery) ? 0.2 : 0;
  return Number(Math.min(1, overlap + phraseBonus).toFixed(4));
}

function resolveMechanismSupportDensity(graph, mechanisms = []) {
  if (!mechanisms.length) return 0;

  const supports = mechanisms.map((mechanism) => {
    const normalized = normalizeText(mechanism);
    const node = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM).find((candidate) => {
      const aliases = Array.isArray(candidate.properties?.aliases) ? candidate.properties.aliases : [];
      return normalizeText(candidate.name) === normalized
        || aliases.some((alias) => normalizeText(alias) === normalized);
    });
    return Math.min(1, Number(node?.properties?.supportingPaperCount || 0) / 4);
  });

  return Number((supports.reduce((total, value) => total + value, 0) / supports.length).toFixed(4));
}

function buildPathSteps(graph, node, params, matchedMechanisms, connectedChallenges, snippets) {
  const steps = [];
  if (params.abstractChallenge) {
    steps.push({
      role: 'target-challenge-query',
      nodeId: null,
      nodeType: 'ChallengeQuery',
      nodeName: params.abstractChallenge
    });
  }

  for (const mechanism of matchedMechanisms.slice(0, 2)) {
    steps.push({
      role: 'shared-mechanism',
      nodeId: null,
      nodeType: NODE_TYPES.ABSTRACT_MECHANISM,
      nodeName: mechanism
    });
  }

  for (const challenge of connectedChallenges.slice(0, 2)) {
    steps.push({
      role: challenge.type === NODE_TYPES.CHALLENGE ? 'source-challenge' : 'challenge',
      nodeId: challenge.id,
      nodeType: challenge.type,
      nodeName: challenge.name
    });
  }

  for (const takeaway of collectSourceTakeaways(graph, node).slice(0, 1)) {
    steps.push({
      role: 'source-takeaway',
      nodeId: takeaway.id,
      nodeType: takeaway.type,
      nodeName: takeaway.name
    });
  }

  steps.push({
    role: node.type === NODE_TYPES.IDEA_FRAGMENT ? 'idea-fragment' : 'candidate',
    nodeId: node.id,
    nodeType: node.type,
    nodeName: node.name
  });

  for (const snippet of snippets.slice(0, 2)) {
    steps.push({
      role: 'evidence-snippet',
      nodeId: snippet.id,
      nodeType: snippet.type,
      nodeName: snippet.name
    });
  }

  return steps;
}

function buildCandidateRecord(graph, node, params, targetDomain, requestedMechanisms) {
  const sourceDomains = collectSourceDomains(node, targetDomain);
  const nodeTargetDomain = normalizeFieldOfStudy(node.properties?.targetDomain);
  if (node.type === NODE_TYPES.IDEA_FRAGMENT && nodeTargetDomain && nodeTargetDomain !== targetDomain) {
    return null;
  }
  if (!sourceDomains.length && node.type !== NODE_TYPES.IDEA_FRAGMENT) {
    return null;
  }

  const nodeMechanisms = collectNodeMechanisms(graph, node);
  const matchedMechanisms = requestedMechanisms.length
    ? nodeMechanisms.filter((mechanism) => requestedMechanisms.includes(mechanism))
    : nodeMechanisms.slice(0, 4);
  const connectedChallenges = collectConnectedChallenges(graph, node);
  const challengeTexts = connectedChallenges.map((challenge) => (
    challenge.properties?.domainAgnosticText
    || challenge.properties?.domainSpecificText
    || challenge.name
  ));
  const snippets = collectSupportingSnippets(graph, node);
  const sourceDomain = sourceDomains[0] || normalizeFieldOfStudy(node.properties?.fieldOfStudy, node.properties?.domainTags || []);
  const domainNovelty = Number(Math.max(
    sourceDomain ? scoreDomainDistance(params.domainDistanceMatrix, targetDomain, sourceDomain) : 0,
    ...sourceDomains.map((domain) => scoreDomainDistance(params.domainDistanceMatrix, targetDomain, domain)),
    0
  ).toFixed(4));
  const retrievalScore = scoreTextSimilarity(params.abstractChallenge, [
    getSearchText(node),
    ...challengeTexts
  ].join(' '));
  const challengeCoverageScore = Number(Math.max(
    scoreTextSimilarity(params.abstractChallenge, node.properties?.domainAgnosticText || ''),
    ...challengeTexts.map((text) => scoreTextSimilarity(params.abstractChallenge, text)),
    0
  ).toFixed(4));
  const mechanismCoverageScore = requestedMechanisms.length
    ? Number((matchedMechanisms.length / requestedMechanisms.length).toFixed(4))
    : Number(Math.min(1, nodeMechanisms.length / 3).toFixed(4));
  const evidenceDensity = Number(Math.min(1, snippets.length / 2).toFixed(4));
  const mechanismSupportDensity = resolveMechanismSupportDensity(graph, matchedMechanisms.length ? matchedMechanisms : nodeMechanisms);
  const graphScore = Number((
    mechanismCoverageScore * 0.35
    + challengeCoverageScore * 0.35
    + evidenceDensity * 0.15
    + mechanismSupportDensity * 0.15
  ).toFixed(4));
  const pathSteps = buildPathSteps(graph, node, params, matchedMechanisms, connectedChallenges, snippets);
  const pathRoleSet = new Set(pathSteps.map((step) => step.role));
  const pathCompleteness = Number(([
    pathRoleSet.has('source-challenge'),
    pathRoleSet.has('source-takeaway'),
    pathRoleSet.has('idea-fragment'),
    pathRoleSet.has('evidence-snippet')
  ].filter(Boolean).length / 4).toFixed(4));
  const combinedScore = Number((
    retrievalScore * 0.45
    + graphScore * 0.35
    + domainNovelty * 0.20
  ).toFixed(4));

  return {
    pathId: `bridge-path:${stableHash(`${node.id}:${targetDomain}:${params.abstractChallenge || ''}`)}`,
    sourceDomain,
    sourceDomains,
    targetDomain,
    candidateNodeId: node.id,
    candidateNodeType: node.type,
    candidateNodeName: node.name,
    retrievalBackend: BRIDGE_RETRIEVAL_BACKEND,
    retrievalScore,
    graphScore,
    combinedScore,
    domainNovelty,
    challengeCoverageScore,
    mechanismCoverageScore,
    mechanismSupportDensity,
    evidenceDensity,
    pathCompleteness,
    matchedMechanisms,
    matchedChallenges: challengeTexts,
    evidenceSnippetCount: snippets.length,
    snippets: snippets.map((snippet) => ({
      nodeId: snippet.id,
      nodeName: snippet.name
    })),
    path: pathSteps
  };
}

export function buildBridgeRetrieval(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);
  const limit = Math.max(1, Number(params.limit || 8));
  const requestedMechanisms = normalizeMechanismQuery(params.mechanisms || params.mechanism);
  const candidateTypes = new Set([
    NODE_TYPES.CHALLENGE,
    NODE_TYPES.TAKEAWAY,
    NODE_TYPES.IDEA_FRAGMENT
  ]);
  const prunedNodes = [];

  const candidateBridgePaths = graph.nodes
    .filter((node) => candidateTypes.has(node.type))
    .map((node) => {
      const record = buildCandidateRecord(graph, node, params, targetDomain, requestedMechanisms);
      if (!record) {
        prunedNodes.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          reason: 'same-domain-or-unresolved-source-domain'
        });
        return null;
      }
      return record;
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.combinedScore - left.combinedScore
      || right.graphScore - left.graphScore
      || left.candidateNodeName.localeCompare(right.candidateNodeName)
    ))
    .slice(0, limit);

  return {
    contractVersion: BRIDGE_RETRIEVAL_CONTRACT_VERSION,
    retrievalBackend: BRIDGE_RETRIEVAL_BACKEND,
    targetDomain,
    abstractChallenge: normalizeChallengeText(params.abstractChallenge),
    targetMechanisms: requestedMechanisms,
    retrievedNodeTypes: unique(candidateBridgePaths.map((entry) => entry.candidateNodeType)).sort(),
    candidateBridgePaths,
    prunedNodes
  };
}
