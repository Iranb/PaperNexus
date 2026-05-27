import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, GRAPH_LAYERS, NODE_TYPES, getNodeLayer } from '../src/core/graph/schema.js';
import { getCompatibleRule } from '../src/core/graph/rules.js';
import {
  buildDomainDistanceMatrix,
  deriveDomainTaxonomyFromGraph,
  normalizeDomainTags,
  scoreDomainDistance
} from '../src/core/graph/domain-taxonomy.js';
import {
  enrichGraphWithDomainAndMechanismNodes,
  queryCrossDomainBridges
} from '../src/core/graph/domain-bridges.js';
import { precomputePaperGraphFragment } from '../src/core/ingestion/graph-precompute.js';

test('idea-catalyst schema exposes domain and abstract mechanism primitives', () => {
  assert.equal(NODE_TYPES.DOMAIN, 'Domain');
  assert.equal(NODE_TYPES.ABSTRACT_MECHANISM, 'AbstractMechanism');
  assert.equal(EDGE_TYPES.BELONGS_TO_DOMAIN, 'BELONGS_TO_DOMAIN');
  assert.equal(EDGE_TYPES.STUDIED_IN, 'STUDIED_IN');
  assert.equal(EDGE_TYPES.ORIGINATED_IN, 'ORIGINATED_IN');
  assert.equal(EDGE_TYPES.INSTANTIATES, 'INSTANTIATES');
  assert.equal(EDGE_TYPES.IMPLEMENTS, 'IMPLEMENTS');
  assert.equal(EDGE_TYPES.CONSTRAINS, 'CONSTRAINS');
});

test('idea-catalyst schema exposes claim, citation, review, storyline, and falsification primitives', () => {
  assert.equal(NODE_TYPES.CONTRIBUTION_CLAIM, 'ContributionClaim');
  assert.equal(NODE_TYPES.NOVELTY_CLAIM, 'NoveltyClaim');
  assert.equal(NODE_TYPES.CITATION_CONTEXT, 'CitationContext');
  assert.equal(NODE_TYPES.REVIEW_CONCERN, 'ReviewConcern');
  assert.equal(NODE_TYPES.STORY_BEAT, 'StoryBeat');
  assert.equal(NODE_TYPES.FALSIFICATION_PLAN, 'FalsificationPlan');
  assert.equal(getNodeLayer(NODE_TYPES.REVIEW_CONCERN), GRAPH_LAYERS.REVIEW);
  assert.equal(getNodeLayer(NODE_TYPES.STORY_BEAT), GRAPH_LAYERS.STORY);
  assert.equal(EDGE_TYPES.SUPPORTS_CLAIM, 'SUPPORTS_CLAIM');
  assert.equal(EDGE_TYPES.RAISES_CONCERN, 'RAISES_CONCERN');
  assert.equal(EDGE_TYPES.FORMS_BEAT, 'FORMS_BEAT');
  assert.equal(EDGE_TYPES.HAS_FALSIFICATION_PLAN, 'HAS_FALSIFICATION_PLAN');
  assert.ok(getCompatibleRule(NODE_TYPES.CITATION_CONTEXT, NODE_TYPES.CONTRIBUTION_CLAIM, EDGE_TYPES.SUPPORTS_CLAIM));
  assert.ok(getCompatibleRule(NODE_TYPES.REVIEW_CONCERN, NODE_TYPES.NOVELTY_CLAIM, EDGE_TYPES.DISPUTES_CLAIM));
  assert.ok(getCompatibleRule(NODE_TYPES.CONTRIBUTION_CLAIM, NODE_TYPES.STORY_BEAT, EDGE_TYPES.FORMS_BEAT));
  assert.ok(getCompatibleRule(NODE_TYPES.NOVELTY_CLAIM, NODE_TYPES.FALSIFICATION_PLAN, EDGE_TYPES.HAS_FALSIFICATION_PLAN));
});

test('normalizeDomainTags dedupes and preserves canonical tags', () => {
  assert.deepEqual(
    normalizeDomainTags(['Computer Science', 'computer science', 'Psychology', '', null]),
    ['Computer Science', 'Psychology']
  );
});

test('buildDomainDistanceMatrix scores farther domains higher than identical ones', () => {
  const matrix = buildDomainDistanceMatrix([
    {
      targetDomain: 'Computer Science',
      relatedDomains: ['Computer Science', 'Psychology', 'Neuroscience']
    },
    {
      targetDomain: 'Psychology',
      relatedDomains: ['Computer Science', 'Psychology']
    }
  ]);

  assert.equal(scoreDomainDistance(matrix, 'Computer Science', 'Computer Science'), 0);
  assert.ok(scoreDomainDistance(matrix, 'Computer Science', 'Psychology') > 0);
  assert.ok(scoreDomainDistance(matrix, 'Computer Science', 'Neuroscience') >= 0);
});

test('deriveDomainTaxonomyFromGraph builds a domain distance matrix from graph connectivity instead of static config rows', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:edu-psych',
    type: NODE_TYPES.PAPER,
    name: 'Feedback Calibration Across Learning Contexts',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education', 'Psychology']
    }
  });
  graph.addNode({
    id: 'method:psych-hci',
    type: NODE_TYPES.METHOD,
    name: 'reflective uncertainty prompt',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology', 'Human-Computer Interaction'],
      abstractMechanisms: ['reflective control policy']
    }
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  const matrix = deriveDomainTaxonomyFromGraph(graph);

  assert.equal(matrix.version, 'idea-catalyst-domain-distance-v1');
  assert.ok(matrix.domains.includes('Education'));
  assert.ok(matrix.domains.includes('Psychology'));
  assert.ok(matrix.domains.includes('Human-computer Interaction'));
  assert.ok(matrix.neighbors.Education.includes('Psychology'));
  assert.ok(matrix.neighbors['Human-computer Interaction'].includes('Psychology'));
  assert.ok(scoreDomainDistance(matrix, 'Education', 'Psychology') > 0);
  assert.ok(
    scoreDomainDistance(matrix, 'Education', 'Human-Computer Interaction')
    >= scoreDomainDistance(matrix, 'Education', 'Psychology')
  );
  assert.equal(matrix.mechanismCoverage.Psychology.mechanismCount, 1);
  assert.ok(matrix.mechanismCoverage.Psychology.mechanisms.includes('reflective control policy'));
  assert.equal(matrix.mechanismCoverage['Human-computer Interaction'].mechanismCount, 1);
});

test('precomputePaperGraphFragment preserves domain and mechanism metadata on graph contributions', () => {
  const fragment = precomputePaperGraphFragment({
    paperId: 'paper-1',
    paperTitle: 'Cross-Domain Adaptation via Cognitive Control',
    sourcePath: '/tmp/paper.md',
    sourceMarkdownPath: '/tmp/paper.md',
    sourcePdfPath: '/tmp/paper.pdf',
    sourceKind: 'markdown',
    sourceFingerprint: 'fp-paper-1',
    authors: [],
    abstract: 'We study adaptive memory preservation.',
    fieldOfStudy: 'Computer Science',
    fieldCandidates: ['Computer Science', 'Psychology'],
    domainTags: ['Computer Science'],
    abstractMechanisms: ['memory preservation'],
    problems: [
      {
        name: 'catastrophic forgetting',
        text: 'catastrophic forgetting',
        confidence: 0.95,
        domainTags: ['Computer Science'],
        abstractMechanisms: ['memory preservation']
      }
    ],
    methods: [
      {
        name: 'adaptive replay controller',
        text: 'adaptive replay controller',
        confidence: 0.91,
        domainTags: ['Computer Science'],
        abstractMechanisms: ['memory preservation']
      },
      {
        name: 'paper-level metadata fallback',
        text: 'paper-level metadata fallback',
        confidence: 0.7
      }
    ],
    claims: [],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [],
    futureDirections: [],
    benchmarks: [],
    datasets: [],
    metrics: [],
    llmRelations: []
  });

  assert.equal(fragment.paperNode.properties.fieldOfStudy, 'Computer Science');
  assert.deepEqual(fragment.paperNode.properties.domainTags, ['Computer Science']);
  assert.deepEqual(fragment.paperNode.properties.abstractMechanisms, ['memory preservation']);
  assert.deepEqual(
    fragment.globalContributions[0].node.properties.domainTags,
    ['Computer Science']
  );
  assert.deepEqual(
    fragment.globalContributions[0].node.properties.abstractMechanisms,
    ['memory preservation']
  );
  const fallbackMethod = fragment.globalContributions
    .map((entry) => entry.node)
    .find((node) => node.name === 'paper-level metadata fallback');
  assert.equal(fallbackMethod.properties.fieldOfStudy, 'Computer Science');
  assert.deepEqual(fallbackMethod.properties.fieldCandidates, ['Computer Science', 'Psychology']);
  assert.deepEqual(fallbackMethod.properties.domainTags, ['Computer Science']);
  assert.deepEqual(fallbackMethod.properties.abstractMechanisms, ['memory preservation']);
});

test('queryCrossDomainBridges returns a stable bridge contract with pruned and ranked domains', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:cs-1',
    type: NODE_TYPES.PAPER,
    name: 'Paper CS',
    properties: { fieldOfStudy: 'Computer Science', domainTags: ['Computer Science'] }
  });
  graph.addNode({
    id: 'problem:forgetting',
    type: NODE_TYPES.PROBLEM,
    name: 'catastrophic forgetting',
    properties: {
      paperTitles: ['Paper CS'],
      domainTags: ['Computer Science'],
      abstractMechanisms: ['memory preservation']
    }
  });
  graph.addNode({
    id: 'method:psych-1',
    type: NODE_TYPES.METHOD,
    name: 'metacontrol policy',
    properties: {
      paperTitles: ['Paper Psych'],
      domainTags: ['Psychology'],
      abstractMechanisms: ['memory preservation']
    }
  });
  graph.addRelationship({
    id: 'rel:paper-problem',
    sourceId: 'paper:cs-1',
    targetId: 'problem:forgetting',
    type: EDGE_TYPES.SOLVES,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  const mechanismNode = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)
    .find((node) => node.name === 'memory preservation');
  const matrix = buildDomainDistanceMatrix([
    { targetDomain: 'Computer Science', relatedDomains: ['Computer Science', 'Psychology'] },
    { targetDomain: 'Psychology', relatedDomains: ['Computer Science', 'Psychology'] }
  ]);

  const result = queryCrossDomainBridges(graph, {
    targetDomain: 'Computer Science',
    abstractChallenge: 'preserve old knowledge while integrating new knowledge',
    agnosticChallenges: ['preserve old knowledge while integrating new knowledge'],
    minDomainDistance: 0,
    domainDistanceMatrix: matrix,
    limit: 5
  });

  assert.equal(result.contractVersion, 'idea-catalyst-bridge-query-v1');
  assert.equal(result.targetDomain, 'Computer Science');
  assert.equal(result.abstractChallenge, 'preserve old knowledge while integrating new knowledge');
  assert.equal(result.relevancePolicy.targetDomainExclusion, 'same-domain-excluded');
  assert.ok(result.prunedDomains.some((entry) => entry.domain === 'Computer Science'));
  assert.ok(result.candidateSourceDomains.some((entry) => entry.domain === 'Psychology'));
  assert.ok(result.candidateDomains.some((entry) => entry.domain === 'Psychology'));
  assert.ok(result.bridgeNodes.some((entry) => entry.nodeName === 'metacontrol policy'));
  assert.ok(result.mechanismMatches.some((entry) => entry.mechanism === 'memory preservation'));
  assert.ok(mechanismNode);
  assert.equal(mechanismNode.properties.provenanceVersion, 'idea-catalyst-mechanism-support-v1');
  assert.equal(mechanismNode.properties.supportingNodeCount, 2);
  assert.equal(mechanismNode.properties.supportingPaperCount, 2);
  assert.ok(mechanismNode.properties.supportingDomains.includes('Computer Science'));
  assert.ok(mechanismNode.properties.supportingDomains.includes('Psychology'));
  assert.ok(mechanismNode.properties.supportingNodeTypes.includes('Problem'));
  assert.ok(mechanismNode.properties.supportingNodeTypes.includes('Method'));
  assert.ok(mechanismNode.properties.supportingSourceNodes.some((entry) => entry.nodeName === 'catastrophic forgetting'));
  assert.equal(mechanismNode.properties.domainCount, 2);
  assert.equal(mechanismNode.properties.instanceCount, 2);
  assert.equal(mechanismNode.properties.transferPotential, 'medium');

  const psychologyDomain = result.candidateSourceDomains.find((entry) => entry.domain === 'Psychology');
  assert.equal(Number.isFinite(psychologyDomain.distanceScore), true);
  assert.ok(psychologyDomain.relevanceRatio > 0);
  assert.ok(psychologyDomain.bridgeEvidence.some((entry) => entry.mechanism === 'memory preservation'));

  const bridgeNode = result.bridgeNodes.find((entry) => entry.nodeName === 'metacontrol policy');
  assert.equal(bridgeNode.pruned, false);
  assert.equal(Number.isFinite(bridgeNode.distanceScore), true);
  assert.ok(bridgeNode.bridgeEvidence.sharedMechanisms.includes('memory preservation'));
  assert.equal(bridgeNode.matchedChallenge, 'preserve old knowledge while integrating new knowledge');
  assert.ok(Array.isArray(bridgeNode.evidence.paperTitles));
  assert.ok(Object.prototype.hasOwnProperty.call(bridgeNode.evidence, 'evidenceText'));

  const mechanismMatch = result.mechanismMatches.find((entry) => entry.mechanism === 'memory preservation');
  assert.equal(mechanismMatch.provenanceVersion, 'idea-catalyst-mechanism-support-v1');
  assert.equal(mechanismMatch.supportingNodeCount, 2);
  assert.equal(mechanismMatch.supportingPaperCount, 2);
  assert.ok(mechanismMatch.supportingDomains.includes('Computer Science'));
  assert.ok(mechanismMatch.supportingDomains.includes('Psychology'));
});

test('enrichGraphWithDomainAndMechanismNodes merges alias-linked mechanism records into one typed node', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'problem:1',
    type: NODE_TYPES.PROBLEM,
    name: 'catastrophic forgetting',
    properties: {
      fieldOfStudy: 'Computer Science',
      domainTags: ['Computer Science'],
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
    id: 'method:1',
    type: NODE_TYPES.METHOD,
    name: 'belief updater',
    properties: {
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

  enrichGraphWithDomainAndMechanismNodes(graph);

  const mechanismNodes = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)
    .filter((node) => node.properties.canonicalId === 'metacontrol-policy');

  assert.equal(mechanismNodes.length, 1);
  assert.equal(mechanismNodes[0].properties.mechanismType, 'control-policy');
  assert.equal(mechanismNodes[0].properties.mechanismCategory, 'adaptive-control');
  assert.ok(mechanismNodes[0].properties.aliases.includes('metacontrol policy'));
  assert.ok(mechanismNodes[0].properties.aliases.includes('cognitive control trade-off'));
  assert.equal(mechanismNodes[0].properties.supportingNodeCount, 2);
  assert.equal(mechanismNodes[0].properties.domainCount, 2);
  assert.equal(mechanismNodes[0].properties.transferPotential, 'medium');
});
