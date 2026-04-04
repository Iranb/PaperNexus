import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { buildBridgeRetrieval } from '../src/core/graph/bridge-retrieval.js';
import { buildStructuralAnalogy } from '../src/core/graph/analogy.js';
import { buildInterdisciplinaryPotentialRanking } from '../src/core/graph/interdisciplinary-ranking.js';

function createAnalogyFixtureGraph() {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'challenge:edu',
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
      retrievalText: 'interactive systems calibrate beliefs tutoring feedback metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.'
    }
  });
  graph.addNode({
    id: 'challenge:psych',
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
      retrievalText: 'interactive systems calibrate beliefs biased priors metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.'
    }
  });
  graph.addNode({
    id: 'takeaway:psych',
    type: NODE_TYPES.TAKEAWAY,
    name: 'reflective prompts stabilize belief updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      sourceDomains: ['Psychology'],
      text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      abstractMechanisms: ['metacontrol policy'],
      relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
      retrievalText: 'reflective prompts improve uncertainty-aware belief revision metacontrol policy',
      analogyText: 'Reflective prompts improve uncertainty-aware belief revision.'
    }
  });
  graph.addNode({
    id: 'idea:edu',
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
    id: 'snippet:psych',
    type: NODE_TYPES.EVIDENCE_SNIPPET,
    name: 'Reflective prompts improve uncertainty-aware belief revision.',
    properties: {
      paperId: 'paper:psych',
      paperTitle: 'Belief Updating Under Uncertainty',
      text: 'Reflective prompts improve uncertainty-aware belief revision.',
      evidenceText: 'Reflective prompts improve uncertainty-aware belief revision.',
      sectionHeading: 'Discussion',
      sectionRole: 'discussion'
    }
  });

  graph.addRelationship({
    id: 'rel:takeaway-addresses',
    sourceId: 'takeaway:psych',
    targetId: 'challenge:psych',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-snippet',
    sourceId: 'takeaway:psych',
    targetId: 'snippet:psych',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-idea',
    sourceId: 'takeaway:psych',
    targetId: 'idea:edu',
    type: EDGE_TYPES.RECONTEXTUALIZES_TO,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-addresses',
    sourceId: 'idea:edu',
    targetId: 'challenge:edu',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-snippet',
    sourceId: 'idea:edu',
    targetId: 'snippet:psych',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  return graph;
}

test('buildBridgeRetrieval ranks cross-domain bridge paths for a target challenge', () => {
  const graph = createAnalogyFixtureGraph();
  const result = buildBridgeRetrieval(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  assert.equal(result.contractVersion, 'idea-catalyst-bridge-retrieval-v1');
  assert.equal(result.retrievalBackend, 'graph-text-fallback-v1');
  assert.ok(result.candidateBridgePaths.length > 0);
  const takeawayPath = result.candidateBridgePaths.find((entry) => entry.candidateNodeType === 'Takeaway');
  assert.ok(takeawayPath);
  assert.equal(takeawayPath.sourceDomain, 'Psychology');
  assert.ok(takeawayPath.matchedMechanisms.includes('metacontrol policy'));
  assert.ok(takeawayPath.path.some((step) => step.role === 'evidence-snippet'));
});

test('buildStructuralAnalogy aligns transfer motifs over bridge retrieval candidates', () => {
  const graph = createAnalogyFixtureGraph();
  const bridgeRetrieval = buildBridgeRetrieval(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });
  const result = buildStructuralAnalogy(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  }, bridgeRetrieval);

  assert.equal(result.contractVersion, 'idea-catalyst-analogy-v1');
  assert.ok(result.alignments.length > 0);
  const topAlignment = result.alignments[0];
  assert.equal(typeof topAlignment.analogyScore, 'number');
  assert.ok(topAlignment.transferableMechanisms.includes('metacontrol policy'));
  assert.ok(topAlignment.matchedMotifs.length > 0);
  assert.match(topAlignment.alignmentRationale, /Psychology|metacontrol policy/i);
});

test('buildInterdisciplinaryPotentialRanking exposes decomposed ranking signals for bridge candidates', () => {
  const graph = createAnalogyFixtureGraph();
  const bridgeRetrieval = buildBridgeRetrieval(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });
  const structuralAnalogy = buildStructuralAnalogy(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  }, bridgeRetrieval);
  const result = buildInterdisciplinaryPotentialRanking(bridgeRetrieval, structuralAnalogy, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  assert.equal(result.contractVersion, 'idea-catalyst-interdisciplinary-ranking-v1');
  assert.ok(result.rankedCandidates.length > 0);
  const topCandidate = result.rankedCandidates[0];
  assert.equal(typeof topCandidate.interdisciplinaryPotential, 'number');
  assert.equal(typeof topCandidate.noveltyProxy, 'number');
  assert.equal(typeof topCandidate.groundingScore, 'number');
  assert.equal(typeof topCandidate.challengeCoverageScore, 'number');
  assert.equal(typeof topCandidate.storyCompleteness, 'number');
  assert.ok(topCandidate.transferableMechanisms.includes('metacontrol policy'));
});
