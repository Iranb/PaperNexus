import {
  normalizeText,
  scoreTokenOverlap,
  slugify,
  stableHash,
  tokenizeWithoutStopwords,
  unique
} from '../../lib/utils.js';
import {
  buildAbstractMechanismNode,
  buildAbstractMechanismSupportProperties,
  normalizeAbstractMechanismNames,
  normalizeAbstractMechanismRecord,
  normalizeAbstractMechanismRecords,
  scoreMechanismTransferability
} from './abstract-mechanisms.js';
import {
  deriveDomainTaxonomyFromGraph,
  normalizeDomainTags,
  normalizeFieldOfStudy,
  scoreDomainDistance
} from './domain-taxonomy.js';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from './schema.js';

const BRIDGE_CONTRACT_VERSION = 'idea-catalyst-bridge-query-v1';

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function buildDomainNode(domain) {
  return {
    id: `${NODE_TYPES.DOMAIN.toLowerCase()}:${slugify(domain)}:${stableHash(`domain:${domain}`)}`,
    type: NODE_TYPES.DOMAIN,
    name: domain,
    properties: {
      layer: getNodeLayer(NODE_TYPES.DOMAIN),
      normalized: normalizeText(domain),
      canonicalField: domain
    }
  };
}

function getOrCreateNode(graph, type, name, buildNode) {
  const key = normalizeText(name);
  const existing = graph.getNodesByType(type).find((node) => normalizeText(node.name) === key);
  if (existing) return existing;
  const node = buildNode(name);
  graph.addNode(node);
  return node;
}

function ensureRelationship(graph, sourceId, targetId, type, properties = {}) {
  const exists = graph.getOutgoing(sourceId).some(
    (relationship) => relationship.targetId === targetId && relationship.type === type
  );
  if (!exists) {
    graph.addRelationship(createRelationship(sourceId, targetId, type, properties));
  }
}

function domainRelationshipType(nodeType) {
  if (nodeType === NODE_TYPES.PAPER) return EDGE_TYPES.BELONGS_TO_DOMAIN;
  if (nodeType === NODE_TYPES.PROBLEM) return EDGE_TYPES.STUDIED_IN;
  if (nodeType === NODE_TYPES.RESEARCH_QUESTION) return EDGE_TYPES.STUDIED_IN;
  if (nodeType === NODE_TYPES.CHALLENGE) return EDGE_TYPES.STUDIED_IN;
  if (nodeType === NODE_TYPES.METHOD) return EDGE_TYPES.ORIGINATED_IN;
  if (nodeType === NODE_TYPES.TAKEAWAY) return EDGE_TYPES.ORIGINATED_IN;
  if (nodeType === NODE_TYPES.IDEA_FRAGMENT) return EDGE_TYPES.BELONGS_TO_DOMAIN;
  if (nodeType === NODE_TYPES.LIMITATION) return EDGE_TYPES.STUDIED_IN;
  return null;
}

function mechanismRelationshipType(nodeType) {
  if (nodeType === NODE_TYPES.PROBLEM) return EDGE_TYPES.INSTANTIATES;
  if (nodeType === NODE_TYPES.RESEARCH_QUESTION) return EDGE_TYPES.INSTANTIATES;
  if (nodeType === NODE_TYPES.CHALLENGE) return EDGE_TYPES.CONSTRAINS;
  if (nodeType === NODE_TYPES.METHOD) return EDGE_TYPES.IMPLEMENTS;
  if (nodeType === NODE_TYPES.TAKEAWAY) return EDGE_TYPES.IMPLEMENTS;
  if (nodeType === NODE_TYPES.IDEA_FRAGMENT) return EDGE_TYPES.IMPLEMENTS;
  if (nodeType === NODE_TYPES.LIMITATION) return EDGE_TYPES.CONSTRAINS;
  return null;
}

function mechanismRelationshipRole(type) {
  if (type === EDGE_TYPES.INSTANTIATES) return 'problem';
  if (type === EDGE_TYPES.IMPLEMENTS) return 'method';
  if (type === EDGE_TYPES.CONSTRAINS) return 'limitation';
  return 'related';
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node.properties?.fieldOfStudy,
    ...(node.properties?.fieldCandidates || []),
    ...(node.properties?.domainTags || [])
  ]);
}

function collectNodePaperTitles(node) {
  return unique([
    node.properties?.paperTitle,
    ...(Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles : [])
  ].filter(Boolean));
}

function collectNodeMechanismRecords(node) {
  return normalizeAbstractMechanismRecords([
    ...(Array.isArray(node.properties?.abstractMechanismObjects) ? node.properties.abstractMechanismObjects : []),
    ...(Array.isArray(node.properties?.abstractMechanisms) ? node.properties.abstractMechanisms : []),
    ...(Array.isArray(node.properties?.mechanismHints) ? node.properties.mechanismHints : [])
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

function findMatchingMechanismNode(graph, recordOrName) {
  const queryRecord = normalizeAbstractMechanismRecord(recordOrName);
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

function getOrCreateMechanismNode(graph, record) {
  const existing = findMatchingMechanismNode(graph, record);
  if (!existing) {
    const created = buildAbstractMechanismNode(record);
    graph.addNode(created);
    return created;
  }

  const merged = normalizeAbstractMechanismRecords([
    buildMechanismRecordFromNode(existing),
    record
  ])[0];

  graph.updateNode({
    ...existing,
    name: merged.name,
    properties: {
      ...existing.properties,
      ...buildAbstractMechanismNode(merged).properties
    }
  });

  return graph.getNode(existing.id) || existing;
}

function buildMechanismSupportEntry(graph, relationship) {
  const node = graph.getNode(relationship.sourceId);
  if (!node) return null;
  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    role: mechanismRelationshipRole(relationship.type),
    relationshipType: relationship.type,
    domains: collectNodeDomains(node),
    paperTitles: collectNodePaperTitles(node)
  };
}

function refreshMechanismSupportContracts(graph) {
  for (const mechanismNode of [...graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)]) {
    const supportEntries = graph.getIncoming(mechanismNode.id)
      .filter((relationship) => (
        relationship.type === EDGE_TYPES.INSTANTIATES
        || relationship.type === EDGE_TYPES.IMPLEMENTS
        || relationship.type === EDGE_TYPES.CONSTRAINS
      ))
      .map((relationship) => buildMechanismSupportEntry(graph, relationship))
      .filter(Boolean)
      .sort((left, right) => left.nodeName.localeCompare(right.nodeName));

    const transferability = scoreMechanismTransferability(graph, mechanismNode);
    graph.updateNode({
      ...mechanismNode,
      properties: {
        ...mechanismNode.properties,
        ...buildAbstractMechanismSupportProperties(supportEntries),
        canonicalForm: mechanismNode.properties?.canonicalForm || mechanismNode.name,
        domainCount: transferability.domainCount,
        instanceCount: transferability.instanceCount,
        transferPotential: transferability.transferPotential,
        relatedMechanisms: transferability.relatedMechanisms
      }
    });
  }
}

function buildTransferEdgeProperties(mechanismNode, sourceDomain, targetDomain) {
  const supportCount = Number(mechanismNode?.properties?.supportingPaperCount || 0);
  return {
    relationSource: 'idea-catalyst-transfer-enrichment',
    viaMechanism: mechanismNode?.id || null,
    viaMechanismName: mechanismNode?.name || '',
    sourceDomain,
    targetDomain,
    score: Number(Math.min(0.95, 0.3 + (supportCount * 0.08)).toFixed(4))
  };
}

export function populateTransferableEdgesFromMechanisms(graph) {
  for (const relationship of [...graph.relationships]) {
    if (relationship.type !== EDGE_TYPES.TRANSFERABLE_TO) continue;
    if (relationship.properties?.relationSource !== 'idea-catalyst-transfer-enrichment') continue;
    graph.removeRelationship(relationship.id);
  }

  let created = 0;
  for (const mechanismNode of graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)) {
    const incoming = graph.getIncoming(mechanismNode.id)
      .filter((relationship) => (
        relationship.type === EDGE_TYPES.INSTANTIATES
        || relationship.type === EDGE_TYPES.IMPLEMENTS
      ));
    const methods = incoming
      .map((relationship) => graph.getNode(relationship.sourceId))
      .filter((node) => node?.type === NODE_TYPES.METHOD);
    const problems = incoming
      .map((relationship) => graph.getNode(relationship.sourceId))
      .filter((node) => node?.type === NODE_TYPES.PROBLEM);

    for (const method of methods) {
      const methodDomain = normalizeFieldOfStudy(method.properties?.fieldOfStudy, method.properties?.domainTags || []);
      if (!methodDomain) continue;

      for (const problem of problems) {
        const problemDomain = normalizeFieldOfStudy(problem.properties?.fieldOfStudy, problem.properties?.domainTags || []);
        if (!problemDomain || problemDomain === methodDomain) continue;

        const exists = graph.getOutgoing(method.id).some((relationship) => (
          relationship.type === EDGE_TYPES.TRANSFERABLE_TO && relationship.targetId === problem.id
        ));
        if (exists) continue;

        graph.addRelationship(createRelationship(
          method.id,
          problem.id,
          EDGE_TYPES.TRANSFERABLE_TO,
          buildTransferEdgeProperties(mechanismNode, methodDomain, problemDomain)
        ));
        created += 1;
      }
    }
  }

  return created;
}

export function enrichGraphWithDomainAndMechanismNodes(graph) {
  const candidateTypes = new Set([
    NODE_TYPES.PAPER,
    NODE_TYPES.PROBLEM,
    NODE_TYPES.RESEARCH_QUESTION,
    NODE_TYPES.CHALLENGE,
    NODE_TYPES.METHOD,
    NODE_TYPES.TAKEAWAY,
    NODE_TYPES.IDEA_FRAGMENT,
    NODE_TYPES.LIMITATION
  ]);

  for (const node of graph.nodes.filter((entry) => candidateTypes.has(entry.type))) {
    const properties = node.properties || {};
    const domains = normalizeDomainTags([
      properties.fieldOfStudy,
      ...(properties.fieldCandidates || []),
      ...(properties.domainTags || [])
    ]);
    const mechanismRecords = collectNodeMechanismRecords(node);
    const mechanisms = normalizeAbstractMechanismNames(mechanismRecords);

    const domainEdge = domainRelationshipType(node.type);
    const mechanismEdge = mechanismRelationshipType(node.type);

    for (const domain of domains) {
      const domainNode = getOrCreateNode(graph, NODE_TYPES.DOMAIN, domain, buildDomainNode);
      if (domainEdge) {
        ensureRelationship(graph, node.id, domainNode.id, domainEdge, {
          source: 'idea-catalyst-domain-enrichment'
        });
      }
    }

    for (const mechanism of mechanisms) {
      const mechanismRecord = mechanismRecords.find((entry) => entry.name === mechanism)
        || normalizeAbstractMechanismRecord(mechanism);
      const mechanismNode = getOrCreateMechanismNode(graph, mechanismRecord);
      if (mechanismEdge) {
        ensureRelationship(graph, node.id, mechanismNode.id, mechanismEdge, {
          source: 'idea-catalyst-mechanism-enrichment'
        });
      }
    }
  }

  refreshMechanismSupportContracts(graph);
  populateTransferableEdgesFromMechanisms(graph);

  return graph;
}

function collectMechanismNodes(graph, node) {
  return graph.getOutgoing(node.id)
    .filter((relationship) =>
      relationship.type === EDGE_TYPES.INSTANTIATES ||
      relationship.type === EDGE_TYPES.IMPLEMENTS ||
      relationship.type === EDGE_TYPES.CONSTRAINS
    )
    .map((relationship) => graph.getNode(relationship.targetId))
    .filter(Boolean);
}

function collectDomainMechanisms(graph, targetDomain, candidateTypes) {
  const mechanisms = new Set();
  for (const node of graph.nodes) {
    if (!candidateTypes.has(node.type)) continue;
    const domain = normalizeFieldOfStudy(
      node.properties?.fieldOfStudy,
      node.properties?.domainTags || []
    );
    if (domain !== targetDomain) continue;
    for (const mechanismNode of collectMechanismNodes(graph, node)) {
      mechanisms.add(mechanismNode.name);
    }
  }
  return mechanisms;
}

function scoreBridgeNode(node, params) {
  const challengeTokens = tokenizeWithoutStopwords(params.abstractChallenge || '');
  const bridgeText = [
    node.name,
    ...(node.properties?.abstractMechanisms || []),
    ...(node.properties?.domainTags || [])
  ].join(' ').toLowerCase();
  const overlap = scoreTokenOverlap(
    challengeTokens,
    tokenizeWithoutStopwords(bridgeText)
  );
  const nodeDomain = normalizeFieldOfStudy(node.properties?.fieldOfStudy, node.properties?.domainTags || []);
  const distance = scoreDomainDistance(params.domainDistanceMatrix, params.targetDomain, nodeDomain);
  const mechanismBoost = params.sharedMechanisms?.length
    ? 1
    : params.mechanisms?.length
      ? 0.25
      : 0;
  const score = Number((overlap * 2 + distance + mechanismBoost).toFixed(4));
  return {
    overlap,
    distance,
    score,
    relevanceRatio: Number((score / 4).toFixed(4))
  };
}

function buildBridgeEvidence(sharedMechanisms, node) {
  return {
    sharedMechanisms,
    evidenceNodeIds: [node.id],
    evidenceNodeNames: [node.name],
    abstract: node.properties?.abstract || null,
    text: node.properties?.text || null,
    evidenceText: node.properties?.evidenceText || node.properties?.text || null,
    paperTitles: collectNodePaperTitles(node)
  };
}

function findMechanismNode(graph, mechanism) {
  return findMatchingMechanismNode(graph, mechanism);
}

function buildMechanismSupportContract(graph, mechanism) {
  const mechanismNode = findMechanismNode(graph, mechanism);
  return {
    mechanismNodeId: mechanismNode?.id || null,
    canonicalForm: mechanismNode?.properties?.canonicalForm || mechanism,
    mechanismType: mechanismNode?.properties?.mechanismType || 'general',
    mechanismCategory: mechanismNode?.properties?.mechanismCategory || mechanismNode?.properties?.category || null,
    description: mechanismNode?.properties?.description || mechanism,
    aliases: Array.isArray(mechanismNode?.properties?.aliases) ? mechanismNode.properties.aliases : [],
    provenanceVersion: mechanismNode?.properties?.provenanceVersion || null,
    domainCount: Number(mechanismNode?.properties?.domainCount || 0),
    instanceCount: Number(mechanismNode?.properties?.instanceCount || 0),
    transferPotential: mechanismNode?.properties?.transferPotential || null,
    relatedMechanisms: Array.isArray(mechanismNode?.properties?.relatedMechanisms)
      ? mechanismNode.properties.relatedMechanisms
      : [],
    supportingNodeCount: Number(mechanismNode?.properties?.supportingNodeCount || 0),
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

export function queryCrossDomainBridges(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);
  const limit = Math.max(1, Number(params.limit || 8));
  const agnosticChallenges = (Array.isArray(params.agnosticChallenges) ? params.agnosticChallenges : [])
    .map((challenge) => String(challenge || '').trim())
    .filter(Boolean);
  const minDomainDistance = Number.isFinite(Number(params.minDomainDistance))
    ? Number(params.minDomainDistance)
    : 0;
  const domainDistanceMatrix = params.domainDistanceMatrix || deriveDomainTaxonomyFromGraph(graph);
  const candidateTypes = new Set([
    NODE_TYPES.PROBLEM,
    NODE_TYPES.RESEARCH_QUESTION,
    NODE_TYPES.CHALLENGE,
    NODE_TYPES.METHOD,
    NODE_TYPES.TAKEAWAY,
    NODE_TYPES.IDEA_FRAGMENT,
    NODE_TYPES.LIMITATION,
    NODE_TYPES.ASSUMPTION
  ]);
  const prunedDomains = [];
  const targetDomainMechanisms = collectDomainMechanisms(graph, targetDomain, candidateTypes);

  const bridgeNodes = graph.nodes
    .filter((node) => candidateTypes.has(node.type))
    .map((node) => {
      const domain = normalizeFieldOfStudy(
        node.properties?.fieldOfStudy,
        node.properties?.domainTags || []
      );
      if (!domain) {
        return null;
      }
      if (domain === targetDomain) {
        prunedDomains.push({
          domain,
          nodeId: node.id,
          nodeName: node.name,
          reason: 'same-domain-excluded'
        });
        return null;
      }
      const mechanisms = collectMechanismNodes(graph, node).map((entry) => entry.name);
      const sharedMechanisms = mechanisms.filter((mechanism) => targetDomainMechanisms.has(mechanism));
      const challengeQueries = unique([
        ...agnosticChallenges,
        String(params.abstractChallenge || '').trim()
      ].filter(Boolean));
      const challengeScores = (challengeQueries.length ? challengeQueries : [''])
        .map((challenge) => ({
          challenge,
          ...scoreBridgeNode(node, {
            abstractChallenge: challenge,
            targetDomain,
            domainDistanceMatrix,
            mechanisms,
            sharedMechanisms
          })
        }))
        .sort((left, right) => right.score - left.score);
      const scoring = challengeScores[0] || scoreBridgeNode(node, {
        abstractChallenge: params.abstractChallenge || '',
        targetDomain,
        domainDistanceMatrix,
        mechanisms,
        sharedMechanisms
      });
      if (scoring.distance < minDomainDistance) {
        prunedDomains.push({
          domain,
          nodeId: node.id,
          nodeName: node.name,
          reason: 'proximal-domain-excluded'
        });
        return null;
      }
      return {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        domain,
        mechanisms,
        sharedMechanisms,
        domainDistance: scoring.distance,
        distanceScore: scoring.distance,
        score: scoring.score,
        relevanceRatio: scoring.relevanceRatio,
        matchedChallenge: scoring.challenge || null,
        challengeScores,
        evidence: buildBridgeEvidence(sharedMechanisms, node),
        bridgeEvidence: buildBridgeEvidence(sharedMechanisms, node),
        pruned: false
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const mechanismMatches = [];
  const seenMechanisms = new Set();
  for (const entry of bridgeNodes) {
    for (const mechanism of entry.mechanisms) {
      const key = `${entry.domain}:${mechanism}`;
      if (seenMechanisms.has(key)) continue;
      seenMechanisms.add(key);
      mechanismMatches.push({
        mechanism,
        domain: entry.domain,
        viaNodeId: entry.nodeId,
        viaNodeName: entry.nodeName,
        ...buildMechanismSupportContract(graph, mechanism)
      });
    }
  }

  const candidateDomains = Object.values(
    bridgeNodes.reduce((accumulator, entry) => {
      const existing = accumulator[entry.domain] || {
        domain: entry.domain,
        score: 0,
        bridgeCount: 0,
        domainDistance: entry.domainDistance,
        distanceScore: entry.distanceScore,
        relevanceRatio: 0,
        bridgeEvidence: []
      };
      existing.score += entry.score;
      existing.bridgeCount += 1;
      existing.relevanceRatio += entry.relevanceRatio;
      if (entry.matchedChallenge && !existing.matchedChallenges?.includes(entry.matchedChallenge)) {
        existing.matchedChallenges = [...(existing.matchedChallenges || []), entry.matchedChallenge];
      }
      for (const mechanism of entry.sharedMechanisms.length ? entry.sharedMechanisms : entry.mechanisms) {
        if (!existing.bridgeEvidence.some((item) => item.mechanism === mechanism)) {
          existing.bridgeEvidence.push({
            mechanism,
            viaNodeId: entry.nodeId,
            viaNodeName: entry.nodeName
          });
        }
      }
      accumulator[entry.domain] = existing;
      return accumulator;
    }, {})
  )
    .map((entry) => ({
      ...entry,
      score: Number((entry.score / Math.max(1, entry.bridgeCount)).toFixed(4)),
      relevanceRatio: Number((entry.relevanceRatio / Math.max(1, entry.bridgeCount)).toFixed(4)),
      pruned: false
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    contractVersion: BRIDGE_CONTRACT_VERSION,
    targetDomain,
    abstractChallenge: params.abstractChallenge || '',
      relevancePolicy: {
      targetDomainExclusion: 'same-domain-excluded',
      minDomainDistance,
      sourceDomainRanking: 'average-bridge-score',
      mechanismEvidence: 'shared-abstract-mechanisms',
      challengeMatching: agnosticChallenges.length ? 'domain-agnostic-challenge-aware' : 'single-challenge'
    },
    prunedDomains,
    candidateSourceDomains: candidateDomains,
    candidateDomains,
    bridgeNodes,
    mechanismMatches
  };
}
