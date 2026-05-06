import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { buildCatalystQuery } from '../src/core/graph/catalyst-adapter.js';
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
  assert.ok(bundle.bridge_retrieval.candidate_bridge_paths.length > 0);
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.bridge_path_ids.length > 0));
  assert.ok(bundle.source_domain_analyses.some((analysis) => analysis.evidence_chain_refs.length > 0));
  assert.ok(bundle.source_domain_analyses.every((analysis) => analysis.source_spans.length === 0));
  assert.ok(bundle.source_domain_analyses.every((analysis) => analysis.evidence_tier === 'weak'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('source_span_or_evidence_snippet'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('evidence_density'));
  assert.ok(bundle.requisition_report.missing_evidence_types.includes('usable_idea_fragment'));
});
