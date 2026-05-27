import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import {
  buildCrossDomainMechanismEvidence,
  buildMethodEvolutionEvidenceLookup,
  buildMethodEvolutionGapAnalysis,
  buildResearchIntelligenceAnswer
} from '../src/core/graph/research-intelligence.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';

function createCrossDomainFixtureGraph() {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:edu-1',
    type: NODE_TYPES.PAPER,
    name: 'Reducing Confirmation Bias in Tutoring',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
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
    id: 'question:edu-bias',
    type: NODE_TYPES.RESEARCH_QUESTION,
    name: 'how can tutoring systems reduce biased belief updates?',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      domainSpecificText: 'How can tutoring systems reduce biased learner belief updates during interactive feedback?',
      domainAgnosticText: 'How can interactive systems reduce biased belief updates during iterative feedback?',
      rationale: 'Needed to calibrate learners without reinforcing tutor framing.'
    }
  });
  graph.addNode({
    id: 'challenge:edu-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'adaptive belief calibration under asymmetric feedback',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'challenge:psych-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'belief updating under uncertainty',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy']
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
      paperTitles: ['Belief Updating Under Uncertainty'],
      text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      abstractMechanisms: ['metacontrol policy'],
      relatedChallenges: ['adaptive belief calibration under asymmetric feedback']
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
      addressesChallenges: ['adaptive belief calibration under asymmetric feedback']
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
    id: 'rel:question-challenge',
    sourceId: 'question:edu-bias',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.HAS_OPEN_CHALLENGE,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-addresses',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'challenge:psych-bias',
    type: EDGE_TYPES.ADDRESSES,
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
    id: 'rel:takeaway-snippet',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'snippet:psych-reflective',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-addresses',
    sourceId: 'idea:edu-scaffold',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  return graph;
}

function createMethodLineageFixtureGraph() {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'method:transformer',
    type: NODE_TYPES.METHOD,
    name: 'Transformer',
    properties: {
      aliases: ['self-attention network'],
      year: 2017,
      fieldOfStudy: 'Machine Learning'
    }
  });
  graph.addNode({
    id: 'method:seq2seq',
    type: NODE_TYPES.METHOD,
    name: 'Seq2Seq',
    properties: {
      aliases: ['sequence-to-sequence'],
      year: 2014,
      fieldOfStudy: 'Machine Learning'
    }
  });
  graph.addNode({
    id: 'method:rnn',
    type: NODE_TYPES.METHOD,
    name: 'Recurrent Neural Network',
    properties: {
      aliases: ['RNN'],
      year: 1986,
      fieldOfStudy: 'Machine Learning'
    }
  });
  graph.addNode({
    id: 'method:future-attention',
    type: NODE_TYPES.METHOD,
    name: 'Future Attention',
    properties: {
      year: 2025,
      fieldOfStudy: 'Machine Learning'
    }
  });

  graph.addRelationship({
    id: 'rel:transformer-seq2seq',
    sourceId: 'method:transformer',
    targetId: 'method:seq2seq',
    type: EDGE_TYPES.EXTENDS_METHOD,
    properties: {
      candidateId: 'candidate:transformer-seq2seq',
      validationStatus: 'accepted',
      confidence: 0.91,
      exactQuote: 'The Transformer dispenses with recurrence and relies on attention mechanisms.',
      paperTitle: 'Attention Is All You Need',
      bottleneckDimension: 'parallelization',
      bottleneckDescription: 'recurrence limited parallel sequence modeling',
      mechanismType: 'architectural-change',
      mechanismDescription: 'self-attention replaces recurrent updates',
      tradeoffDimension: 'training-complexity',
      tradeoffDescription: 'attention increases compute and memory at long context lengths'
    }
  });
  graph.addRelationship({
    id: 'rel:seq2seq-rnn',
    sourceId: 'method:seq2seq',
    targetId: 'method:rnn',
    type: EDGE_TYPES.IMPROVES_METHOD,
    properties: {
      validationStatus: 'validated',
      confidence: 0.82,
      exactQuote: 'Sequence-to-sequence learning maps variable length sequences with recurrent neural networks.',
      paperTitle: 'Sequence to Sequence Learning with Neural Networks',
      bottleneckDimension: 'sequence-transduction',
      bottleneckDescription: 'fixed input-output mappings limited sequence transduction',
      mechanismType: 'encoder-decoder',
      mechanismDescription: 'an encoder-decoder composition models input-output sequence pairs',
      tradeoffDimension: 'exposure-bias',
      tradeoffDescription: 'autoregressive decoding accumulates errors'
    }
  });
  graph.addRelationship({
    id: 'rel:transformer-future',
    sourceId: 'method:transformer',
    targetId: 'method:future-attention',
    type: EDGE_TYPES.EXTENDS_METHOD,
    properties: {
      validationStatus: 'accepted',
      confidence: 0.7,
      exactQuote: 'This invalid edge points to a later predecessor.',
      bottleneckDimension: 'scalability'
    }
  });

  return graph;
}

test('buildCrossDomainMechanismEvidence returns mechanism evidence bundles without query-time LLM work', () => {
  const graph = createCrossDomainFixtureGraph();
  const result = buildCrossDomainMechanismEvidence(graph, {
    query: 'reduce confirmation bias during tutoring feedback',
    targetDomain: 'Education',
    mechanisms: ['metacontrol policy'],
    relevanceThreshold: 1,
    limit: 5
  });

  assert.equal(result.contractVersion, 'papernexus-cross-domain-mechanism-evidence-v1');
  assert.equal(result.path, 'cross_domain_mechanism_evidence');
  assert.equal(result.diagnostics.queryTimeLlmCalls, 0);
  assert.ok(result.mechanismBundles.some((bundle) => bundle.mechanism === 'metacontrol policy'));
  const bundle = result.mechanismBundles.find((entry) => entry.mechanism === 'metacontrol policy');
  assert.ok(bundle.supportingSnippets.some((snippet) => snippet.quote.includes('Reflective prompts')));
  assert.ok(bundle.supportingPapers.some((paper) => paper.paperTitle === 'Belief Updating Under Uncertainty'));
  assert.ok(result.evidenceCertificate.sourceSpanCount > 0);
  assert.equal(result.evidenceCertificate.supportingSourceSpans.length, result.evidenceCertificate.sourceSpanCount);
  assert.equal(result.evidenceCertificate.supportingEvidenceRefs.length, result.evidenceCertificate.evidenceRefCount);
  assert.ok(result.evidenceCertificate.supportingBridgePaths.some((path) => path.pathId));
  assert.equal(result.evidenceCertificate.validation.noLlmQueryInvariant, true);
  assert.ok(result.evidenceCertificate.validation.gates.some((gate) => (
    gate.name === 'source_span_or_snippet' && gate.passed === true
  )));
  assert.ok(result.innovationArtifacts.must_cite_set.length > 0);
  assert.ok(result.must_cite_set.length > 0);
  assert.ok(result.novelty_certificate.grounding > 0);
  assert.ok(result.review_packet.reviewers.length > 0);
  assert.ok(result.storyline_dag.beats.length > 0);
  assert.ok(result.counterfactuals.length > 0);
  assert.deepEqual(result.falsification_plans, result.innovationArtifacts.falsification_plans);
  assert.notEqual(result.dataStarvation.status, 'starved');
});

test('buildMethodEvolutionGapAnalysis walks only validated quoted method-evolution edges', () => {
  const graph = createMethodLineageFixtureGraph();
  const result = buildMethodEvolutionGapAnalysis(graph, {
    method: 'Transformer',
    direction: 'backward',
    maxDepth: 2,
    limit: 3
  });

  assert.equal(result.contractVersion, 'papernexus-method-evolution-lineage-v1');
  assert.equal(result.path, 'method_evolution_bottleneck_gap');
  assert.equal(result.matchedMethod.methodId, 'method:transformer');
  assert.equal(result.dataStarvation.status, 'ok');
  assert.equal(result.diagnostics.queryTimeLlmCalls, 0);
  assert.equal(result.diagnostics.acceptedEdgeCount, 2);
  assert.ok(result.diagnostics.rejectedEdges.some((edge) => edge.reasons.includes('reverse_temporal_direction')));
  assert.equal(result.lineages[0].steps[0].methodName, 'Transformer');
  assert.equal(result.lineages[0].steps[1].methodName, 'Seq2Seq');
  assert.equal(result.lineages[0].steps[2].methodName, 'Recurrent Neural Network');
  assert.equal(result.lineages[0].steps[0].edgeToNext.bottleneck.dimension, 'parallelization');
  assert.ok(result.bottleneckTrajectory.some((entry) => entry.dimension === 'parallelization'));
  assert.ok(result.tradeoffTrajectory.some((entry) => entry.dimension === 'training-complexity'));
  assert.ok(result.nextGapCandidates.some((entry) => entry.groundingEdges.includes('rel:transformer-seq2seq')));
});

test('buildMethodEvolutionEvidenceLookup returns ranked evidence for a method pair', () => {
  const graph = createMethodLineageFixtureGraph();
  graph.addRelationship({
    id: 'rel:transformer-seq2seq-dag',
    sourceId: 'method:transformer',
    targetId: 'method:seq2seq',
    type: EDGE_TYPES.VARIANT_OF,
    properties: {
      relationshipRole: 'method-dag',
      methodEvolutionProjection: true,
      citationRelationshipId: 'rel:transformer-seq2seq',
      candidateId: 'candidate:transformer-seq2seq',
      validationStatus: 'accepted',
      confidence: 0.91,
      exactQuote: 'The Transformer dispenses with recurrence and relies on attention mechanisms.',
      exactMatch: true,
      paperEdgeType: EDGE_TYPES.EXTENDS_METHOD,
      dagEdgeType: EDGE_TYPES.VARIANT_OF,
      bottleneckDimension: 'parallelization',
      bottleneckDescription: 'recurrence limited parallel sequence modeling',
      mechanismType: 'architectural-change',
      mechanismDescription: 'self-attention replaces recurrent updates',
      tradeoffDimension: 'training-complexity',
      tradeoffDescription: 'attention increases compute and memory at long context lengths',
      evidenceCompletenessStatus: 'complete'
    }
  });

  const result = buildMethodEvolutionEvidenceLookup(graph, {
    sourceMethod: 'Transformer',
    targetMethod: 'Seq2Seq'
  });

  assert.equal(result.contractVersion, 'papernexus-method-evidence-v1');
  assert.equal(result.path, 'method_evidence');
  assert.equal(result.dataStarvation.status, 'ok');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].edgeId, 'rel:transformer-seq2seq-dag');
  assert.equal(result.matches[0].citationRelationshipId, 'rel:transformer-seq2seq');
  assert.equal(result.matches[0].paperEdgeType, EDGE_TYPES.EXTENDS_METHOD);
  assert.equal(result.matches[0].dagEdgeType, EDGE_TYPES.VARIANT_OF);
  assert.equal(result.matches[0].evidence.exactQuote, 'The Transformer dispenses with recurrence and relies on attention mechanisms.');
  assert.equal(result.diagnostics.queryTimeLlmCalls, 0);
});

test('buildMethodEvolutionEvidenceLookup can inspect a rejected edge by id', () => {
  const graph = createMethodLineageFixtureGraph();
  const result = buildMethodEvolutionEvidenceLookup(graph, {
    edgeId: 'rel:transformer-future'
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].edgeId, 'rel:transformer-future');
  assert.equal(result.matches[0].validation.accepted, false);
  assert.ok(result.matches[0].validation.reasons.includes('reverse_temporal_direction'));
  assert.equal(result.dataStarvation.status, 'ok');
});

test('buildMethodEvolutionGapAnalysis reports rejected COMPONENT_OF diagnostics in lineage direction', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'method:hybrid',
    type: NODE_TYPES.METHOD,
    name: 'Hybrid Retriever',
    properties: { year: 2023 }
  });
  graph.addNode({
    id: 'method:bm25',
    type: NODE_TYPES.METHOD,
    name: 'BM25',
    properties: { year: 1994 }
  });
  graph.addRelationship({
    id: 'rel:bm25-hybrid-candidate',
    sourceId: 'method:bm25',
    targetId: 'method:hybrid',
    type: EDGE_TYPES.COMPONENT_OF,
    properties: {
      methodEvolutionProjection: true,
      relationshipRole: 'method-dag',
      paperEdgeType: EDGE_TYPES.USES_COMPONENT_METHOD,
      dagEdgeType: EDGE_TYPES.COMPONENT_OF,
      validationStatus: 'candidate',
      confidence: 0.62
    }
  });

  const result = buildMethodEvolutionGapAnalysis(graph, {
    method: 'Hybrid Retriever',
    direction: 'backward'
  });

  assert.equal(result.lineages.length, 0);
  assert.ok(result.diagnostics.rejectedEdges.some((edge) => (
    edge.edgeId === 'rel:bm25-hybrid-candidate'
    && edge.reasons.includes('not_accepted_or_validated')
  )));
});

test('buildResearchIntelligenceAnswer routes both answer paths behind one stable contract', () => {
  const graph = createMethodLineageFixtureGraph();
  const result = buildResearchIntelligenceAnswer(graph, {
    query: 'Transformer',
    method: 'Transformer',
    mode: 'both',
    targetDomain: 'Machine Learning',
    direction: 'backward',
    maxDepth: 1
  });

  assert.equal(result.contractVersion, 'papernexus-research-intelligence-v1');
  assert.equal(result.mode, 'both');
  assert.equal(result.diagnostics.noLlmQueryInvariant, true);
  assert.ok(result.crossDomainMechanismEvidence);
  assert.ok(Array.isArray(result.innovationArtifacts.must_cite_set));
  assert.ok(Array.isArray(result.innovationArtifacts.falsification_plans));
  assert.ok(result.innovationArtifacts.novelty_certificate);
  assert.ok(result.methodEvolutionGap);
});
