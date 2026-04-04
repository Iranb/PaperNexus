import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import {
  buildCatalystQuery,
  buildCoverageQuery,
  buildMechanismBridgeAnalysis,
  buildMechanismTraversal
} from '../src/core/graph/catalyst-adapter.js';

function createCatalystFixtureGraph() {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:edu-1',
    type: NODE_TYPES.PAPER,
    name: 'Reducing Confirmation Bias in Tutoring',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education', 'Learning Sciences'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'paper:psych-1',
    type: NODE_TYPES.PAPER,
    name: 'Belief Updating Under Uncertainty',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'paper:hci-1',
    type: NODE_TYPES.PAPER,
    name: 'Attention Anchoring in Decision Support',
    properties: {
      fieldOfStudy: 'Human-Computer Interaction',
      domainTags: ['Human-Computer Interaction'],
      abstractMechanisms: ['attention anchoring']
    }
  });

  graph.addNode({
    id: 'problem:edu-bias',
    type: NODE_TYPES.PROBLEM,
    name: 'confirmation bias in tutoring feedback',
    properties: {
      paperTitles: ['Reducing Confirmation Bias in Tutoring'],
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['metacontrol policy'],
      abstractMechanismObjects: [
        {
          name: 'metacontrol policy',
          mechanismType: 'control-policy',
          mechanismCategory: 'adaptive-control',
          description: 'adaptive trade-off between persistence and flexibility',
          aliases: ['cognitive control trade-off']
        }
      ]
    }
  });
  graph.addNode({
    id: 'method:edu-reflection',
    type: NODE_TYPES.METHOD,
    name: 'reflective prompt schedule',
    properties: {
      paperTitles: ['Reducing Confirmation Bias in Tutoring'],
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'problem:psych-belief',
    type: NODE_TYPES.PROBLEM,
    name: 'belief updating under uncertainty',
    properties: {
      paperTitles: ['Belief Updating Under Uncertainty'],
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['cognitive control trade-off'],
      abstractMechanismObjects: [
        {
          name: 'cognitive control trade-off',
          mechanismType: 'control-policy',
          mechanismCategory: 'adaptive-control',
          description: 'adaptive trade-off between persistence and flexibility',
          aliases: ['metacontrol policy']
        }
      ]
    }
  });
  graph.addNode({
    id: 'method:psych-metacontrol',
    type: NODE_TYPES.METHOD,
    name: 'metacontrol policy transfer',
    properties: {
      paperTitles: ['Belief Updating Under Uncertainty'],
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'limitation:hci-anchor',
    type: NODE_TYPES.LIMITATION,
    name: 'anchoring effects in interface-assisted decisions',
    properties: {
      fieldOfStudy: 'Human-Computer Interaction',
      domainTags: ['Human-Computer Interaction'],
      abstractMechanisms: ['attention anchoring']
    }
  });
  graph.addNode({
    id: 'challenge:edu-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractionLevel: 'specific',
      challengeType: 'mixed',
      domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'interactive systems calibrate beliefs asymmetric feedback loops metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.'
    }
  });
  graph.addNode({
    id: 'challenge:psych-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractionLevel: 'specific',
      challengeType: 'mixed',
      domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'interactive systems calibrate beliefs asymmetric feedback loops metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.'
    }
  });
  graph.addNode({
    id: 'takeaway:psych-reflective',
    type: NODE_TYPES.TAKEAWAY,
    name: 'reflective prompts stabilize belief updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      sourceDomains: ['Psychology'],
      text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      abstractMechanisms: ['metacontrol policy'],
      relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
      retrievalText: 'reflective prompts improve uncertainty-aware belief revision interactive systems calibrate beliefs',
      analogyText: 'Reflective prompts improve uncertainty-aware belief revision.'
    }
  });
  graph.addNode({
    id: 'idea:edu-scaffold',
    type: NODE_TYPES.IDEA_FRAGMENT,
    name: 'tutoring feedback prompt scaffold',
    properties: {
      fieldOfStudy: 'Education',
      targetDomain: 'Education',
      domainTags: ['Education', 'Psychology'],
      sourceDomains: ['Psychology'],
      text: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
      abstractMechanisms: ['metacontrol policy'],
      sourceTakeaways: ['reflective prompts stabilize belief updating'],
      addressesChallenges: ['adaptive belief calibration under asymmetric feedback'],
      retrievalText: 'adapt reflective prompts tutoring feedback confirmation bias metacontrol policy',
      analogyText: 'Transfer reflective prompt control into tutoring feedback loops.'
    }
  });
  graph.addNode({
    id: 'snippet:psych-reflective',
    type: NODE_TYPES.EVIDENCE_SNIPPET,
    name: 'Reflective prompts improve uncertainty-aware belief revision.',
    properties: {
      paperId: 'paper:psych-1',
      paperTitle: 'Belief Updating Under Uncertainty',
      text: 'Reflective prompts improve uncertainty-aware belief revision.',
      evidenceText: 'Reflective prompts improve uncertainty-aware belief revision.',
      sectionHeading: 'Discussion',
      sectionRole: 'discussion'
    }
  });

  graph.addRelationship({
    id: 'rel:edu-paper-problem',
    sourceId: 'paper:edu-1',
    targetId: 'problem:edu-bias',
    type: EDGE_TYPES.SOLVES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:psych-paper-problem',
    sourceId: 'paper:psych-1',
    targetId: 'problem:psych-belief',
    type: EDGE_TYPES.SOLVES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:hci-paper-limitation',
    sourceId: 'paper:hci-1',
    targetId: 'limitation:hci-anchor',
    type: EDGE_TYPES.DISCUSSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:edu-problem-challenge',
    sourceId: 'problem:edu-bias',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.HAS_OPEN_CHALLENGE,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-addresses-psych',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'challenge:psych-bias',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-snippet',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'snippet:psych-reflective',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-idea',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'idea:edu-scaffold',
    type: EDGE_TYPES.RECONTEXTUALIZES_TO,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-addresses-edu',
    sourceId: 'idea:edu-scaffold',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-snippet',
    sourceId: 'idea:edu-scaffold',
    targetId: 'snippet:psych-reflective',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  return graph;
}

test('buildMechanismTraversal returns a stable mechanism-centric traversal contract', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildMechanismTraversal(graph, {
    mechanisms: ['metacontrol policy', 'unknown mechanism'],
    limit: 10
  });

  assert.equal(result.contractVersion, 'idea-catalyst-mechanism-traversal-v1');
  assert.deepEqual(result.queryMechanisms, ['metacontrol policy', 'unknown mechanism']);
  assert.equal(result.matches.length, 2);

  const metacontrol = result.matches.find((entry) => entry.mechanism === 'metacontrol policy');
  assert.equal(metacontrol.matched, true);
  assert.equal(metacontrol.provenanceVersion, 'idea-catalyst-mechanism-support-v1');
  assert.equal(metacontrol.mechanismType, 'control-policy');
  assert.equal(metacontrol.mechanismCategory, 'adaptive-control');
  assert.ok(metacontrol.aliases.includes('cognitive control trade-off'));
  assert.ok(metacontrol.relatedDomains.includes('Education'));
  assert.ok(metacontrol.relatedDomains.includes('Psychology'));
  assert.ok(metacontrol.supportingPaperCount >= 2);
  assert.ok(metacontrol.supportingDomains.includes('Education'));
  assert.ok(metacontrol.supportingDomains.includes('Psychology'));
  assert.ok(metacontrol.supportingNodes.some((entry) => entry.nodeName === 'reflective prompt schedule'));

  const missing = result.matches.find((entry) => entry.mechanism === 'unknown mechanism');
  assert.equal(missing.matched, false);
  assert.equal(missing.supportingNodeCount, 0);
});

test('buildCoverageQuery summarizes domain coverage and requested mechanism gaps', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildCoverageQuery(graph, {
    targetDomain: 'Education',
    mechanisms: ['metacontrol policy', 'attention anchoring']
  });

  assert.equal(result.contractVersion, 'idea-catalyst-coverage-v1');
  assert.equal(result.targetDomainCoverage.domain, 'Education');
  assert.equal(result.targetDomainCoverage.paperCount, 1);
  assert.equal(result.targetDomainCoverage.problemCount, 1);
  assert.equal(result.targetDomainCoverage.methodCount, 1);
  assert.ok(result.targetDomainCoverage.matchedMechanisms.includes('metacontrol policy'));
  assert.ok(result.targetDomainCoverage.missingMechanisms.includes('attention anchoring'));
});

test('buildCatalystQuery returns a stable scout-friendly contract with domain coverage and mechanism traversal', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  assert.equal(result.contractVersion, 'idea-catalyst-query-v1');
  assert.equal(result.bridgeContractVersion, 'idea-catalyst-bridge-query-v1');
  assert.equal(result.targetDomain, 'Education');
  assert.equal(result.abstractChallenge, 'reduce confirmation bias during tutoring feedback');
  assert.deepEqual(result.targetMechanisms, ['metacontrol policy']);
  assert.equal(result.coverage.targetDomain.paperCount, 1);
  assert.ok(result.candidateDomains.some((entry) => entry.domain === 'Psychology'));
  assert.ok(result.candidateDomains.find((entry) => entry.domain === 'Psychology').coverage.paperCount >= 1);
  assert.ok(result.bridgeNodes.some((entry) => entry.domain === 'Psychology'));
  assert.ok(result.mechanismTraversal.matches.some((entry) => entry.mechanism === 'metacontrol policy'));
  assert.ok(result.mechanismMatches.some((entry) => (
    entry.mechanism === 'metacontrol policy'
    && entry.provenanceVersion === 'idea-catalyst-mechanism-support-v1'
    && entry.supportingPaperCount >= 2
  )));
});

test('buildMechanismBridgeAnalysis ranks cross-domain mechanism communities around the target domain', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildMechanismBridgeAnalysis(graph, {
    targetDomain: 'Education',
    mechanisms: ['metacontrol policy', 'attention anchoring'],
    limit: 10
  });

  assert.equal(result.contractVersion, 'idea-catalyst-mechanism-bridges-v1');
  assert.equal(result.targetDomain, 'Education');
  assert.deepEqual(result.targetMechanisms, ['metacontrol policy', 'attention anchoring']);

  const community = result.candidateMechanismCommunities.find((entry) => entry.mechanism === 'metacontrol policy');
  assert.ok(community);
  assert.ok(community.targetDomainSupportCount >= 2);
  assert.ok(community.crossDomainSupportCount >= 2);
  assert.ok(community.sourceDomains.includes('Psychology'));
  assert.equal(community.provenanceVersion, 'idea-catalyst-mechanism-support-v1');
  assert.ok(community.supportingPaperCount >= 2);
  assert.ok(community.supportingDomains.some((entry) => entry.domain === 'Psychology'));
  assert.ok(community.bridgeStrength > 0);

  const bridge = result.crossDomainMechanismBridges.find(
    (entry) => entry.mechanism === 'metacontrol policy' && entry.sourceDomain === 'Psychology'
  );
  assert.ok(bridge);
  assert.equal(bridge.targetDomain, 'Education');
  assert.ok(bridge.supportingNodeCount >= 2);
  assert.ok(bridge.sourceDomainNodeCount >= 2);

  const supportingDomain = result.supportingDomains.find((entry) => entry.domain === 'Psychology');
  assert.ok(supportingDomain);
  assert.ok(supportingDomain.bridgeCount >= 1);
  assert.ok(supportingDomain.matchedMechanismCount >= 1);
});

test('buildCatalystQuery includes additive mechanism bridge analysis without changing the stable top-level contract', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  assert.equal(result.contractVersion, 'idea-catalyst-query-v1');
  assert.equal(result.mechanismBridgeAnalysis.contractVersion, 'idea-catalyst-mechanism-bridges-v1');
  assert.ok(result.mechanismBridgeAnalysis.candidateMechanismCommunities.some((entry) => entry.mechanism === 'metacontrol policy'));
  assert.ok(result.mechanismBridgeAnalysis.crossDomainMechanismBridges.some((entry) => entry.sourceDomain === 'Psychology'));
});

test('buildCatalystQuery adds bridge retrieval, structural analogy, and interdisciplinary ranking contracts', () => {
  const graph = createCatalystFixtureGraph();
  const result = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 6
  });

  assert.equal(result.bridgeRetrieval.contractVersion, 'idea-catalyst-bridge-retrieval-v1');
  assert.equal(result.bridgeRetrieval.retrievalBackend, 'graph-text-fallback-v1');
  assert.ok(result.bridgeRetrieval.candidateBridgePaths.length > 0);
  assert.ok(result.bridgeRetrieval.candidateBridgePaths.some((entry) => entry.sourceDomain === 'Psychology'));
  assert.ok(result.bridgeRetrieval.candidateBridgePaths.some((entry) => entry.candidateNodeType === 'Takeaway'));

  assert.equal(result.structuralAnalogy.contractVersion, 'idea-catalyst-analogy-v1');
  assert.ok(result.structuralAnalogy.alignments.length > 0);
  assert.ok(result.structuralAnalogy.alignments.some((entry) => entry.transferableMechanisms.includes('metacontrol policy')));
  assert.ok(result.structuralAnalogy.alignments.some((entry) => entry.matchedMotifs.includes('challenge-takeaway')));

  assert.equal(result.interdisciplinaryPotentialRanking.contractVersion, 'idea-catalyst-interdisciplinary-ranking-v1');
  assert.ok(result.interdisciplinaryPotentialRanking.rankedCandidates.length > 0);
  const topCandidate = result.interdisciplinaryPotentialRanking.rankedCandidates[0];
  assert.equal(typeof topCandidate.interdisciplinaryPotential, 'number');
  assert.equal(typeof topCandidate.noveltyProxy, 'number');
  assert.equal(typeof topCandidate.groundingScore, 'number');
  assert.equal(typeof topCandidate.challengeCoverageScore, 'number');
  assert.equal(typeof topCandidate.storyCompleteness, 'number');
});
