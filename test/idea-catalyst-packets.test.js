import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { buildCatalystQuery } from '../src/core/graph/catalyst-adapter.js';
import { buildBridgeRetrieval } from '../src/core/graph/bridge-retrieval.js';
import { buildIdeaCatalystPacketBundle } from '../src/core/graph/idea-catalyst-packets.js';

function createPacketFixtureGraph({ includeSnippet = true } = {}) {
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
    id: 'question:edu-reflective',
    type: NODE_TYPES.RESEARCH_QUESTION,
    name: 'which reflective interventions rebalance feedback loops?',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      domainSpecificText: 'Which reflective interventions rebalance tutoring feedback loops?',
      domainAgnosticText: 'Which reflective interventions rebalance asymmetric feedback loops?'
    }
  });
  graph.addNode({
    id: 'challenge:edu-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'adaptive belief calibration under asymmetric feedback',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractionLevel: 'specific',
      challengeType: 'mixed',
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
      abstractionLevel: 'specific',
      challengeType: 'mixed',
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
  if (includeSnippet) {
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
  }

  graph.addRelationship({
    id: 'rel:question-challenge-1',
    sourceId: 'question:edu-bias',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.HAS_OPEN_CHALLENGE,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:question-challenge-2',
    sourceId: 'question:edu-reflective',
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
  if (includeSnippet) {
    graph.addRelationship({
      id: 'rel:takeaway-snippet',
      sourceId: 'takeaway:psych-reflective',
      targetId: 'snippet:psych-reflective',
      type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
      properties: {}
    });
  }
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

function createMethodEvidenceOnlyGraph() {
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
    name: 'how can feedback systems reduce biased belief updates?',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      domainSpecificText: 'How can feedback systems reduce biased belief updates?',
      domainAgnosticText: 'How can adaptive systems reduce biased belief updates during feedback?'
    }
  });
  graph.addNode({
    id: 'method:edu-calibration',
    type: NODE_TYPES.METHOD,
    name: 'calibration-aware feedback schedule',
    properties: {
      paperTitles: ['Reducing Confirmation Bias in Tutoring'],
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'feedback calibration belief updates metacontrol policy'
    }
  });
  graph.addNode({
    id: 'method:psych-metacontrol',
    type: NODE_TYPES.METHOD,
    name: 'reflective metacontrol prompt schedule',
    properties: {
      paperTitles: ['Belief Updating Under Uncertainty'],
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'reflective prompts reduce biased belief updates metacontrol policy',
      analogyText: 'Reflective prompts regulate belief updates during feedback.'
    }
  });

  graph.addRelationship({
    id: 'rel:edu-paper-method',
    sourceId: 'paper:edu-1',
    targetId: 'method:edu-calibration',
    type: EDGE_TYPES.USES,
    properties: {
      evidenceText: 'We use calibration-aware feedback scheduling to reduce biased belief updates.',
      sectionHeading: 'Method',
      sectionRole: 'method',
      confidence: 0.9
    }
  });
  graph.addRelationship({
    id: 'rel:psych-paper-method',
    sourceId: 'paper:psych-1',
    targetId: 'method:psych-metacontrol',
    type: EDGE_TYPES.USES,
    properties: {
      evidenceText: 'Reflective prompts improve uncertainty-aware belief revision during feedback.',
      sectionHeading: 'Discussion',
      sectionRole: 'discussion',
      confidence: 0.88,
      explicitOrInferred: 'explicit'
    }
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  return graph;
}

test('buildIdeaCatalystPacketBundle returns the staged public-repo packet structure', () => {
  const graph = createPacketFixtureGraph();
  const catalyst = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  const bundle = buildIdeaCatalystPacketBundle(graph, catalyst, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    numSourceDomains: 3,
    relevanceThreshold: 1,
    limit: 5
  });

  assert.equal(bundle.contractVersion, 'idea-catalyst-packet-bundle-v1');
  assert.equal(bundle.packet_version, 'idea-catalyst-packet-bundle-v2');
  assert.equal(bundle.innovation_contract_version, 'papernexus-innovation-artifacts-v1');
  assert.ok(Array.isArray(bundle.must_cite_set));
  assert.ok(bundle.must_cite_set.length > 0);
  assert.ok(Array.isArray(bundle.contribution_claims));
  assert.ok(bundle.contribution_claims.length > 0);
  assert.ok(bundle.contribution_claims.every((claim) => claim.source_span_ids.length > 0));
  assert.equal(bundle.novelty_certificate.unsupported_claim_count, 0);
  assert.ok(bundle.novelty_certificate.grounding > 0);
  assert.ok(bundle.review_packet.reviewers.length > 0);
  assert.ok(bundle.storyline_dag.beats.length > 0);
  assert.ok(bundle.counterfactuals.length > 0);
  assert.equal(bundle.decomposition.fine_grained_domain, 'Intelligent Tutoring Systems');
  assert.equal(bundle.decomposition.coarse_grained_domain, 'Education');
  assert.ok(bundle.decomposition.research_questions.length >= 2);
  assert.equal(bundle.decomposition.questions.length, bundle.decomposition.research_questions.length);
  assert.ok(bundle.target_domain_analysis.length >= 1);
  assert.ok(bundle.cross_domain_queries.length >= 1);
  assert.equal(bundle.cross_domain_searches.length, bundle.cross_domain_queries.length);
  assert.ok(bundle.source_domain_analyses.length >= 1);
  assert.equal(bundle.cross_domain_analysis.length, bundle.source_domain_analyses.length);
  assert.ok(bundle.idea_fragments.length >= 1 || bundle.requisition_report);
  assert.ok(bundle.interdisciplinary_ranking);
  assert.equal(bundle.bridge_retrieval.contract_version, 'idea-catalyst-bridge-retrieval-v1');
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.length > 0);
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.some((entry) => entry.path_id));
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.some((entry) => entry.source_spans.length > 0));
  assert.equal(bundle.structural_analogy.contract_version, 'idea-catalyst-analogy-v1');
  assert.ok(bundle.structural_analogy.alignments.length > 0);
  assert.equal(bundle.interdisciplinary_potential_ranking.contract_version, 'idea-catalyst-interdisciplinary-ranking-v1');
  assert.ok(bundle.interdisciplinary_potential_ranking.ranked_candidates.length > 0);
  assert.equal(bundle.domain_distance_policy.version, 'idea-catalyst-domain-distance-v1');
  assert.equal(bundle.domain_distance_policy.scoring_basis, 'graph-connectivity-and-mechanism-coverage');
  assert.equal(bundle.source_domain_analyses[0].takeaways[0].supporting_papers[0], 'Belief Updating Under Uncertainty');
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.bridge_path_ids.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.path_trace.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.evidence_chain_refs.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.source_spans.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.path_completeness >= 0.5));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.evidence_density > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.ranking_backend === 'graph-analogy-fusion-v1'));
  assert.equal(bundle.idea_fragments[0].idea_fragment.title, bundle.idea_fragments[0].title);
  assert.ok(bundle.idea_fragments[0].bridge_path_ids.length > 0);
  assert.ok(bundle.idea_fragments[0].path_trace.length > 0);
  assert.ok(bundle.idea_fragments[0].evidence_chain_refs.length > 0);
  assert.ok(bundle.idea_fragments[0].source_spans.length > 0);
  assert.ok(['strong', 'moderate'].includes(bundle.idea_fragments[0].evidence_tier));
  assert.ok(bundle.idea_fragments[0].source_spans.some((span) => (
    span.source_type === 'evidence_snippet'
    && span.snippet_node_id === 'snippet:psych-reflective'
    && span.source_span_available === false
  )));
  assert.deepEqual(bundle.idea_fragments[0].idea_fragment.bridge_path_ids, bundle.idea_fragments[0].bridge_path_ids);
});

test('buildIdeaCatalystPacketBundle reports DATA_STARVATION instead of usable fragments when source evidence is missing', () => {
  const graph = createPacketFixtureGraph({ includeSnippet: false });
  const catalyst = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  const bundle = buildIdeaCatalystPacketBundle(graph, catalyst, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    numSourceDomains: 3,
    relevanceThreshold: 1,
    limit: 5
  });

  assert.equal(bundle.requisition_report.status, 'DATA_STARVATION');
  assert.deepEqual(bundle.idea_fragments, []);
  assert.deepEqual(bundle.contribution_claims, []);
  assert.equal(bundle.novelty_certificate.claim_count, 0);
  assert.ok(bundle.storyline_dag.unsupported_beats.length > 0);
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.length > 0);
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.bridge_path_ids.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.evidence_chain_refs.length > 0));
  assert.ok(bundle.source_domain_analyses.every((analysis) => analysis.source_spans.length === 0));
  assert.ok(bundle.source_domain_analyses.every((analysis) => analysis.evidence_tier === 'weak'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('source_span_or_evidence_snippet'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('evidence_density'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('usable_idea_fragment'));
});

test('buildIdeaCatalystPacketBundle uses relationship evidence from source-domain methods', () => {
  const graph = createMethodEvidenceOnlyGraph();
  const catalyst = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce biased belief updates during feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5,
    relevanceThreshold: 1
  });

  const bundle = buildIdeaCatalystPacketBundle(graph, catalyst, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce biased belief updates during feedback',
    numSourceDomains: 2,
    relevanceThreshold: 1,
    limit: 5
  });

  assert.equal(bundle.requisition_report, null);
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.some((entry) => (
    entry.candidate_node_type === NODE_TYPES.METHOD
    && entry.source_spans.some((span) => (
      span.source_type === 'relationship_evidence'
      && span.paper_title === 'Belief Updating Under Uncertainty'
      && span.evidence_text.includes('Reflective prompts improve')
      && span.source_span_available === false
    ))
  )));
  assert.ok(bundle.source_domain_analyses.some((analysis) => (
    analysis.source_domain === 'Psychology'
    && analysis.bridge_path_ids.length > 0
    && analysis.source_spans.length > 0
    && analysis.evidence_density > 0
    && analysis.path_completeness >= 0.5
    && ['strong', 'moderate'].includes(analysis.evidence_tier)
  )));
  assert.ok(bundle.idea_fragments.some((fragment) => (
    fragment.source_domain === 'Psychology'
    && fragment.source_spans.some((span) => span.source_type === 'relationship_evidence')
    && ['strong', 'moderate'].includes(fragment.evidence_tier)
  )));
});

test('buildIdeaCatalystPacketBundle preserves evidence-bearing bridge domains absent from cross-domain queries', () => {
  const graph = createMethodEvidenceOnlyGraph();
  const catalyst = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce biased belief updates during feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5,
    relevanceThreshold: 1
  });
  const mismatchedCatalyst = {
    ...catalyst,
    candidateDomains: [
      {
        domain: 'Computer Science',
        bridgeEvidence: [],
        matchedChallenges: [],
        score: 1
      }
    ],
    bridgeNodes: []
  };

  const bundle = buildIdeaCatalystPacketBundle(graph, mismatchedCatalyst, {
    targetDomain: 'Education',
    fineGrainedDomain: 'Intelligent Tutoring Systems',
    abstractChallenge: 'reduce biased belief updates during feedback',
    numSourceDomains: 1,
    relevanceThreshold: 1,
    limit: 5
  });

  const psychologyAnalysis = bundle.source_domain_analyses.find((analysis) => analysis.source_domain === 'Psychology');
  assert.ok(psychologyAnalysis);
  assert.equal(psychologyAnalysis.takeaways.length, 0);
  assert.ok(psychologyAnalysis.bridge_path_ids.length > 0);
  assert.ok(psychologyAnalysis.source_spans.some((span) => span.source_type === 'relationship_evidence'));
  assert.ok(['strong', 'moderate'].includes(psychologyAnalysis.evidence_tier));
  assert.equal(bundle.requisition_report, null);
  assert.ok(bundle.idea_fragments.some((fragment) => (
    fragment.source_domain === 'Psychology'
    && fragment.source_spans.some((span) => span.source_type === 'relationship_evidence')
  )));
});

test('buildBridgeRetrieval scores target challenge alignment from method text and relationship evidence', () => {
  const graph = createMethodEvidenceOnlyGraph();
  const retrieval = buildBridgeRetrieval(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce biased belief updates during feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });

  const methodPath = retrieval.candidateBridgePaths.find((entry) => (
    entry.candidateNodeId === 'method:psych-metacontrol'
  ));

  assert.ok(methodPath);
  assert.ok(methodPath.challengeCoverageScore > 0);
  assert.ok(methodPath.evidenceQualityScore > 0);
  assert.ok(methodPath.evidenceDensity > 0);
  assert.ok(methodPath.combinedScore > 0);
});

test('buildBridgeRetrieval downweights OCR-compressed relationship evidence density', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:clean',
    type: NODE_TYPES.PAPER,
    name: 'Clean Belief Updating Evidence',
    properties: { fieldOfStudy: 'Psychology', domainTags: ['Psychology'] }
  });
  graph.addNode({
    id: 'paper:noisy',
    type: NODE_TYPES.PAPER,
    name: 'Noisy Active Learning Evidence',
    properties: { fieldOfStudy: 'Psychology', domainTags: ['Psychology'] }
  });
  graph.addNode({
    id: 'method:clean',
    type: NODE_TYPES.METHOD,
    name: 'reflective feedback calibration',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'reflective feedback reduces biased belief updates'
    }
  });
  graph.addNode({
    id: 'method:noisy',
    type: NODE_TYPES.METHOD,
    name: 'active leverage sampling limitation',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'biased feedback updates'
    }
  });
  graph.addRelationship({
    id: 'rel:clean',
    sourceId: 'paper:clean',
    targetId: 'method:clean',
    type: EDGE_TYPES.USES,
    properties: {
      evidenceText: 'Reflective feedback prompts reduce biased belief updates during iterative feedback.'
    }
  });
  graph.addRelationship({
    id: 'rel:noisy',
    sourceId: 'paper:noisy',
    targetId: 'method:noisy',
    type: EDGE_TYPES.USES,
    properties: {
      evidenceText: 'ActiveLearningbyStatisticalLeverageSampling stanceswithhighstatisticalleveragescores specific limitations or assumptions'
    }
  });

  const retrieval = buildBridgeRetrieval(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'reduce biased belief updates during feedback',
    mechanisms: ['metacontrol policy'],
    limit: 5
  });
  const clean = retrieval.candidateBridgePaths.find((entry) => entry.candidateNodeId === 'method:clean');
  const noisy = retrieval.candidateBridgePaths.find((entry) => entry.candidateNodeId === 'method:noisy');

  assert.ok(clean);
  assert.ok(noisy);
  assert.ok(clean.evidenceQualityScore > noisy.evidenceQualityScore);
  assert.ok(clean.evidenceDensity > noisy.evidenceDensity);
});
