import { unique } from '../../lib/utils.js';
import { buildBrainstorm } from '../search/search.js';
import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy, scoreDomainDistance } from './domain-taxonomy.js';
import { queryCrossDomainBridges } from './domain-bridges.js';
import { extractTakeawaysFromBridgeNodes } from './takeaway-extraction.js';

export const INTERDISCIPLINARY_POTENTIAL_REPORT_VERSION = 'idea-catalyst-interdisciplinary-potential-v1';

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function normalizeChallenges(query, agnosticChallenges) {
  const normalized = Array.isArray(agnosticChallenges)
    ? agnosticChallenges.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (!normalized.length && String(query || '').trim()) {
    normalized.push(String(query).trim());
  }
  return normalized;
}

export function buildInterdisciplinaryPotentialReport(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);
  const query = String(params.query || '').trim();
  const limit = Math.max(1, Number(params.limit || 5));
  const excludeProximalDomains = params.excludeProximalDomains !== false;
  const agnosticChallenges = normalizeChallenges(query, params.agnosticChallenges);
  const domainDistanceMatrix = deriveDomainTaxonomyFromGraph(graph);
  const brainstorm = buildBrainstorm(graph, query, {
    mode: 'diverge',
    limit: Math.max(limit, 6),
    maxHops: Number(params.maxHops || 2),
    layers: params.layers,
    layerMode: params.layerMode || 'any'
  });
  const domainProfile = brainstorm.domainProfile || {
    contractVersion: 'idea-catalyst-domain-community-profile-v1',
    topBridgeDomains: [],
    domainBridgeScores: {},
    domainLatentNeighborCounts: {}
  };
  const bridgeQuery = queryCrossDomainBridges(graph, {
    targetDomain,
    abstractChallenge: query,
    agnosticChallenges,
    minDomainDistance: excludeProximalDomains ? 0.3 : 0,
    domainDistanceMatrix,
    limit: Math.max(limit * 3, 8)
  });
  const takeawayReport = extractTakeawaysFromBridgeNodes(graph, {
    targetDomain,
    agnosticChallenges,
    bridgeNodes: bridgeQuery.bridgeNodes
  });
  const totalLatentNeighbors = Math.max(
    1,
    Object.values(domainProfile.domainLatentNeighborCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0)
  );

  const rankedSourceDomains = unique([
    ...bridgeQuery.candidateDomains.map((entry) => entry.domain),
    ...domainProfile.topBridgeDomains.map((entry) => entry.domain)
  ])
    .map((domain) => {
      const bridgeEntry = bridgeQuery.candidateDomains.find((entry) => entry.domain === domain) || null;
      const profileEntry = domainProfile.topBridgeDomains.find((entry) => entry.domain === domain) || null;
      const domainTakeaways = takeawayReport.takeaways
        .filter((entry) => entry.source_domain === domain)
        .slice(0, 3);
      const sharedMechanisms = unique(
        bridgeQuery.bridgeNodes
          .filter((entry) => entry.domain === domain)
          .flatMap((entry) => entry.sharedMechanisms?.length ? entry.sharedMechanisms : (entry.mechanisms || []))
      ).slice(0, 8);
      const bridgeNodeCount = Number(bridgeEntry?.bridgeCount || bridgeQuery.bridgeNodes.filter((entry) => entry.domain === domain).length || 0);
      const communityBridgeWeight = Number(profileEntry?.communityBridgeWeight || domainProfile.domainBridgeScores?.[domain] || 0);
      const latentNeighborOverlap = Number(((domainProfile.domainLatentNeighborCounts?.[domain] || 0) / totalLatentNeighbors).toFixed(4));
      const domainDistance = scoreDomainDistance(domainDistanceMatrix, targetDomain, domain);
      const bridgeStrength = clampScore(Number(bridgeEntry?.score || 0) / 4.5);
      const takeawaySupport = clampScore(domainTakeaways.length / 3);
      const interdisciplinaryPotentialScore = clampScore(
        (bridgeStrength * 0.34)
        + (clampScore(domainDistance) * 0.24)
        + (clampScore(Math.min(1, communityBridgeWeight / 6)) * 0.18)
        + (takeawaySupport * 0.12)
        + (latentNeighborOverlap * 0.12)
      );

      return {
        domain,
        interdisciplinaryPotentialScore,
        bridgeNodeCount,
        sharedMechanisms,
        communityBridgeWeight: Number(communityBridgeWeight.toFixed(4)),
        domainDistance,
        topTakeaways: domainTakeaways,
        evidence: {
          crossCommunityBridges: Number(profileEntry?.bridgeCount || 0),
          latentNeighborOverlap,
          matchedChallenges: bridgeEntry?.matchedChallenges || []
        }
      };
    })
    .filter((entry) => entry.domain && entry.domain !== targetDomain)
    .sort((left, right) => (
      right.interdisciplinaryPotentialScore - left.interdisciplinaryPotentialScore
      || right.communityBridgeWeight - left.communityBridgeWeight
      || right.bridgeNodeCount - left.bridgeNodeCount
      || left.domain.localeCompare(right.domain)
    ))
    .slice(0, limit);

  return {
    contractVersion: INTERDISCIPLINARY_POTENTIAL_REPORT_VERSION,
    targetDomain,
    query,
    agnosticChallenges,
    excludeProximalDomains,
    domainProfileVersion: domainProfile.contractVersion || null,
    bridgeQueryVersion: bridgeQuery.contractVersion || null,
    rankedSourceDomains
  };
}
