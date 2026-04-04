import { scoreTokenOverlap, tokenizeWithoutStopwords } from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { buildBridgeRetrieval } from './bridge-retrieval.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const STRUCTURAL_ANALOGY_CONTRACT_VERSION = 'idea-catalyst-analogy-v1';

function scoreTextAlignment(queryText, candidateText) {
  const queryTokens = tokenizeWithoutStopwords(String(queryText || '').toLowerCase());
  const candidateTokens = tokenizeWithoutStopwords(String(candidateText || '').toLowerCase());
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const overlap = scoreTokenOverlap(queryTokens, candidateTokens);
  const phraseBonus = String(candidateText || '').toLowerCase().includes(String(queryText || '').toLowerCase()) ? 0.15 : 0;
  return Number(Math.min(1, overlap + phraseBonus).toFixed(4));
}

function collectSupportingEvidence(graph, path) {
  return (path.path || [])
    .filter((step) => step.role === 'evidence-snippet' && step.nodeId)
    .map((step) => graph.getNode(step.nodeId))
    .filter(Boolean);
}

function collectTransferableMechanisms(path, requestedMechanisms = []) {
  const normalized = normalizeAbstractMechanismNames(path.matchedMechanisms || []);
  if (!normalized.length) return normalizeAbstractMechanismNames(requestedMechanisms || []);
  return normalized;
}

function resolveMotifs(path) {
  const roles = new Set((path.path || []).map((step) => step.role));
  const motifs = [];
  if (roles.has('source-challenge') && roles.has('source-takeaway')) {
    motifs.push('challenge-takeaway');
  }
  if (roles.has('source-takeaway') && roles.has('idea-fragment')) {
    motifs.push('takeaway-idea-transfer');
  }
  if (roles.has('shared-mechanism') && (roles.has('source-challenge') || roles.has('source-takeaway') || roles.has('idea-fragment'))) {
    motifs.push('mechanism-transfer');
  }
  if (roles.has('evidence-snippet')) {
    motifs.push('evidence-grounding');
  }
  return motifs;
}

export function buildStructuralAnalogy(graph, params = {}, bridgeRetrieval = null) {
  const retrieval = bridgeRetrieval || buildBridgeRetrieval(graph, params);
  const requestedMechanisms = normalizeAbstractMechanismNames(params.mechanisms || params.mechanism || []);
  const limit = Math.max(1, Number(params.limit || 8));

  const alignments = retrieval.candidateBridgePaths
    .map((path) => {
      const candidateNode = graph.getNode(path.candidateNodeId);
      if (!candidateNode) return null;

      const supportingEvidence = collectSupportingEvidence(graph, path);
      const transferableMechanisms = collectTransferableMechanisms(path, requestedMechanisms);
      const matchedMotifs = resolveMotifs(path);
      const challengeText = [
        ...path.matchedChallenges,
        candidateNode.properties?.domainAgnosticText,
        candidateNode.properties?.domainSpecificText,
        candidateNode.properties?.analogyText,
        candidateNode.properties?.retrievalText,
        candidateNode.name
      ]
        .filter(Boolean)
        .join(' ');

      const challengeAlignment = scoreTextAlignment(params.abstractChallenge, challengeText);
      const mechanismAlignment = requestedMechanisms.length
        ? Number((transferableMechanisms.filter((mechanism) => requestedMechanisms.includes(mechanism)).length / requestedMechanisms.length).toFixed(4))
        : Number(Math.min(1, transferableMechanisms.length / 2).toFixed(4));
      const motifCompleteness = Number(Math.min(1, matchedMotifs.length / 4).toFixed(4));
      const evidenceSupport = Number(Math.min(1, supportingEvidence.length / 2).toFixed(4));
      const analogyScore = Number((
        challengeAlignment * 0.4
        + mechanismAlignment * 0.3
        + motifCompleteness * 0.2
        + evidenceSupport * 0.1
      ).toFixed(4));

      return {
        bridgePathId: path.pathId,
        candidateNodeId: path.candidateNodeId,
        candidateNodeType: path.candidateNodeType,
        candidateNodeName: path.candidateNodeName,
        sourceDomain: path.sourceDomain,
        targetDomain: path.targetDomain,
        analogyScore,
        matchedMotifs,
        transferableMechanisms,
        supportingEvidenceNodeIds: supportingEvidence.map((node) => node.id),
        alignmentRationale: `${path.sourceDomain} ${path.candidateNodeType} aligns to ${params.targetDomain} via ${transferableMechanisms.join(', ') || 'related mechanisms'} and ${matchedMotifs.join(', ') || 'partial motif overlap'}.`,
        challengeAlignment,
        mechanismAlignment,
        motifCompleteness
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.analogyScore - left.analogyScore
      || right.motifCompleteness - left.motifCompleteness
      || left.candidateNodeName.localeCompare(right.candidateNodeName)
    ))
    .slice(0, limit);

  return {
    contractVersion: STRUCTURAL_ANALOGY_CONTRACT_VERSION,
    targetDomain: params.targetDomain || '',
    abstractChallenge: params.abstractChallenge || '',
    targetMechanisms: requestedMechanisms,
    alignments
  };
}
