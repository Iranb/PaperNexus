import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { queryCrossDomainBridges } from './domain-bridges.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const TAKEAWAY_EXTRACTION_CONTRACT_VERSION = 'idea-catalyst-takeaways-v1';

function collectMechanismNodes(graph, bridgeNodeId) {
  return graph.getOutgoing(bridgeNodeId)
    .filter((relationship) => (
      relationship.type === EDGE_TYPES.INSTANTIATES
      || relationship.type === EDGE_TYPES.IMPLEMENTS
      || relationship.type === EDGE_TYPES.CONSTRAINS
    ))
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter((node) => node?.type === NODE_TYPES.ABSTRACT_MECHANISM);
}

function buildSourceFormulation({ bridge, mechanisms }) {
  if (bridge.evidence?.abstract) {
    return bridge.evidence.abstract.length > 300
      ? `${bridge.evidence.abstract.slice(0, 300)}...`
      : bridge.evidence.abstract;
  }
  if (bridge.evidence?.text) {
    return bridge.evidence.text.length > 300
      ? `${bridge.evidence.text.slice(0, 300)}...`
      : bridge.evidence.text;
  }
  const mechanismPart = mechanisms.length ? ` through ${mechanisms.join(' and ')}` : '';
  return `In ${bridge.domain}, ${bridge.nodeName} addresses this challenge${mechanismPart}.`;
}

export function extractTakeawaysFromBridgeNodes(graph, params = {}) {
  const agnosticChallenges = (Array.isArray(params.agnosticChallenges) ? params.agnosticChallenges : [])
    .map((challenge) => String(challenge || '').trim())
    .filter(Boolean);
  const bridgeResult = Array.isArray(params.bridgeNodes)
    ? { bridgeNodes: params.bridgeNodes }
    : queryCrossDomainBridges(graph, params);

  const takeaways = (bridgeResult.bridgeNodes || []).map((bridge, index) => {
    const mechanismNodes = collectMechanismNodes(graph, bridge.nodeId);
    const mechanisms = normalizeAbstractMechanismNames(mechanismNodes.map((node) => ({
      name: node.name,
      aliases: node.properties?.aliases,
      mechanismType: node.properties?.mechanismType,
      mechanismCategory: node.properties?.mechanismCategory || node.properties?.category,
      description: node.properties?.description
    })));
    const mechanismExplanation = mechanismNodes.length
      ? `${mechanismNodes[0].name}: ${mechanismNodes[0].properties?.description || 'domain-agnostic mechanism'}`
      : `${bridge.nodeName} represents a transferable pattern from ${bridge.domain}`;

    return {
      takeaway_id: `t-${bridge.nodeId}-${index + 1}`,
      source_domain: bridge.domain,
      concept: bridge.nodeName,
      mechanism: mechanismNodes[0]?.name || mechanisms[0] || bridge.nodeName,
      source_domain_formulation: buildSourceFormulation({ bridge, mechanisms }),
      mechanism_explanation: mechanismExplanation,
      selection_rationale: bridge.matchedChallenge
        ? `${bridge.nodeName} was selected because it directly matches the challenge "${bridge.matchedChallenge}" in ${bridge.domain}.`
        : `${bridge.nodeName} was selected as transferable evidence from ${bridge.domain}.`,
      supporting_papers: Array.isArray(bridge.evidence?.paperTitles) ? bridge.evidence.paperTitles.slice(0, 5) : [],
      kg_evidence: {
        node_id: bridge.nodeId,
        node_type: bridge.nodeType,
        paper_titles: Array.isArray(bridge.evidence?.paperTitles) ? bridge.evidence.paperTitles.slice(0, 5) : [],
        evidence_text: bridge.evidence?.evidenceText || bridge.evidence?.abstract || ''
      },
      relevance_to_challenge: bridge.matchedChallenge || agnosticChallenges[0] || ''
    };
  });

  return {
    contractVersion: TAKEAWAY_EXTRACTION_CONTRACT_VERSION,
    targetDomain: params.targetDomain || '',
    agnosticChallenges,
    takeaways
  };
}
