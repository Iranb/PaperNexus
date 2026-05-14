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
const RELATIONSHIP_EVIDENCE_NODE_TYPE = 'RelationshipEvidence';

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

function buildGraphSnippetRecord(snippet) {
  return {
    id: snippet.id,
    name: snippet.name,
    nodeId: snippet.id,
    nodeName: snippet.name,
    nodeType: snippet.type
  };
}

function firstText(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function buildRelationshipEvidenceRecord(graph, node, relationship) {
  const sourceNode = graph.getNode(relationship.sourceId);
  if (sourceNode?.type !== NODE_TYPES.PAPER) return null;

  const properties = relationship.properties || {};
  const evidenceText = firstText(properties.evidenceText, properties.text, properties.description);
  if (!evidenceText) return null;

  const paperId = firstText(properties.sourcePaperId, sourceNode.id);
  const paperTitle = firstText(properties.sourcePaperTitle, sourceNode.name, ...(node.properties?.paperTitles || []));
  const snippetId = `relationship-evidence:${stableHash(`${relationship.id}:${node.id}:${evidenceText}`)}`;
  const evidenceName = evidenceText.length > 140 ? `${evidenceText.slice(0, 137)}...` : evidenceText;

  return {
    id: snippetId,
    name: evidenceName,
    nodeId: snippetId,
    nodeName: evidenceName,
    nodeType: RELATIONSHIP_EVIDENCE_NODE_TYPE,
    relationshipId: relationship.id,
    sourceNodeId: relationship.sourceId,
    targetNodeId: relationship.targetId,
    sourceSpan: {
      span_id: `span:${snippetId}`,
      source_type: 'relationship_evidence',
      snippet_node_id: snippetId,
      paper_id: paperId || null,
      paper_title: paperTitle || null,
      section_heading: properties.sectionHeading || properties.section || '',
      section_role: properties.sectionRole || '',
      evidence_text: evidenceText,
      source_span_available: false,
      explicit_or_inferred: properties.explicitOrInferred || 'explicit',
      confidence: normalizeConfidence(properties.confidence)
    }
  };
}

function collectSupportingSnippets(graph, node) {
  const explicitSnippets = graph.getOutgoing(node.id)
    .filter((relationship) => relationship.type === EDGE_TYPES.SUPPORTED_BY_SNIPPET)
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((candidate) => candidate?.type === NODE_TYPES.EVIDENCE_SNIPPET)
    .map((snippet) => buildGraphSnippetRecord(snippet));

  const relationshipSnippets = graph.getIncoming(node.id)
    .map((relationship) => buildRelationshipEvidenceRecord(graph, node, relationship))
    .filter(Boolean);

  return [...explicitSnippets, ...relationshipSnippets];
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

function collectSnippetEvidenceTexts(snippets = []) {
  return snippets
    .flatMap((snippet) => [
      snippet.sourceSpan?.evidence_text,
      snippet.sourceSpan?.evidenceText,
      snippet.nodeName,
      snippet.name
    ])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function scoreEvidenceTextQuality(value) {
  const text = String(value || '').trim();
  if (!text) return 0;

  const tokens = text.split(/\s+/).filter(Boolean);
  const longCompressedToken = tokens.some((token) => /[A-Za-z]{32,}/.test(token));
  const tableLike = (text.match(/\|/g) || []).length >= 4;
  const cidNoise = /\(cid:\d+\)/i.test(text);
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const alphaRatio = letters / Math.max(1, text.length);
  const tooShort = tokens.length < 4;

  if (cidNoise || tableLike || longCompressedToken) return 0.45;
  if (alphaRatio < 0.45) return 0.6;
  if (tooShort) return 0.65;
  return 1;
}

function scoreEvidenceQuality(snippets = []) {
  const texts = collectSnippetEvidenceTexts(snippets);
  if (!texts.length) return 0;
  const scores = texts.slice(0, 6).map((text) => scoreEvidenceTextQuality(text));
  return Number((scores.reduce((total, score) => total + score, 0) / scores.length).toFixed(4));
}

function scoreChallengeCoverage(params, node, challengeTexts, snippets) {
  const challengeQuery = normalizeChallengeText(params.abstractChallenge);
  const evidenceTexts = collectSnippetEvidenceTexts(snippets);
  return Number(Math.max(
    scoreTextSimilarity(challengeQuery, node.properties?.domainAgnosticText || ''),
    scoreTextSimilarity(challengeQuery, node.properties?.domainSpecificText || ''),
    scoreTextSimilarity(challengeQuery, node.properties?.retrievalText || ''),
    scoreTextSimilarity(challengeQuery, node.properties?.analogyText || ''),
    scoreTextSimilarity(challengeQuery, node.name || ''),
    ...challengeTexts.map((text) => scoreTextSimilarity(challengeQuery, text)),
    ...evidenceTexts.map((text) => scoreTextSimilarity(challengeQuery, text)),
    0
  ).toFixed(4));
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

function resolveCandidateRole(node) {
  if (node.type === NODE_TYPES.IDEA_FRAGMENT) return 'idea-fragment';
  if (node.type === NODE_TYPES.METHOD) return 'source-method';
  if (node.type === NODE_TYPES.PROBLEM) return 'source-problem';
  if (node.type === NODE_TYPES.LIMITATION) return 'source-limitation';
  return 'candidate';
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
    role: resolveCandidateRole(node),
    nodeId: node.id,
    nodeType: node.type,
    nodeName: node.name
  });

  for (const snippet of snippets.slice(0, 2)) {
    steps.push({
      role: 'evidence-snippet',
      nodeId: snippet.nodeId || snippet.id,
      nodeType: snippet.nodeType || snippet.type || NODE_TYPES.EVIDENCE_SNIPPET,
      nodeName: snippet.nodeName || snippet.name
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
  const challengeCoverageScore = scoreChallengeCoverage(params, node, challengeTexts, snippets);
  const mechanismCoverageScore = requestedMechanisms.length
    ? Number((matchedMechanisms.length / requestedMechanisms.length).toFixed(4))
    : Number(Math.min(1, nodeMechanisms.length / 3).toFixed(4));
  const evidenceQualityScore = scoreEvidenceQuality(snippets);
  const evidenceDensity = Number((Math.min(1, snippets.length / 2) * evidenceQualityScore).toFixed(4));
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
    pathRoleSet.has('shared-mechanism'),
    pathRoleSet.has('source-challenge') || pathRoleSet.has('source-takeaway'),
    pathRoleSet.has('idea-fragment')
      || pathRoleSet.has('source-method')
      || pathRoleSet.has('source-problem')
      || pathRoleSet.has('source-limitation'),
    pathRoleSet.has('evidence-snippet')
  ].filter(Boolean).length / 4).toFixed(4));
  const combinedScore = Number((
    (
      retrievalScore * 0.40
      + graphScore * 0.40
      + domainNovelty * 0.20
    )
    * (challengeCoverageScore > 0 ? 1 : 0.65)
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
    evidenceQualityScore,
    pathCompleteness,
    matchedMechanisms,
    matchedChallenges: challengeTexts,
    evidenceSnippetCount: snippets.length,
    snippets: snippets.map((snippet) => ({
      nodeId: snippet.nodeId || snippet.id,
      nodeName: snippet.nodeName || snippet.name,
      nodeType: snippet.nodeType || snippet.type || NODE_TYPES.EVIDENCE_SNIPPET,
      relationshipId: snippet.relationshipId || null,
      sourceNodeId: snippet.sourceNodeId || null,
      targetNodeId: snippet.targetNodeId || null,
      sourceSpan: snippet.sourceSpan || null
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
    NODE_TYPES.PROBLEM,
    NODE_TYPES.METHOD,
    NODE_TYPES.LIMITATION,
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
