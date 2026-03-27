import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { createLiteGraphPayload } from '../src/core/graph/lite.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { buildBrainstorm, buildResearchIdeas } from '../src/core/search/search.js';
import { applySemanticAdmissionPolicy } from '../src/core/ingestion/pipeline.js';

test('semantic admission policy removes low-signal surface-form nodes and annotates brainstorm-grade nodes', () => {
  const semanticPaper = {
    paperId: 'paper:test',
    paperTitle: 'A Graph-Theoretic View for Evidence-Aware Experiment Planning',
    problems: [
      {
        name: 'energy',
        text: 'energy',
        evidenceText: 'energy',
        sectionRole: 'inferred',
        confidence: 0.72
      },
      {
        name: 'evidence-aware experiment planning',
        text: 'evidence-aware experiment planning',
        evidenceText: 'We study evidence-aware experiment planning for automated research.',
        sectionRole: 'abstract',
        confidence: 0.82
      }
    ],
    methods: [
      {
        name: 'monitoring',
        text: 'monitoring',
        evidenceText: 'monitoring',
        sectionRole: 'inferred',
        confidence: 0.7
      },
      {
        name: 'retrieval-augmented planning workflow',
        text: 'retrieval-augmented planning workflow',
        evidenceText: 'We propose a retrieval-augmented planning workflow.',
        sectionRole: 'abstract',
        confidence: 0.85
      }
    ],
    datasets: [],
    benchmarks: [],
    metrics: [{ name: 'Accuracy', text: 'Accuracy', evidenceText: 'Accuracy', sectionRole: 'evidence', confidence: 0.88 }],
    claims: [
      {
        name: 'Our method improves experiment planning quality with evidence-aware retrieval.',
        text: 'Our method improves experiment planning quality with evidence-aware retrieval.',
        evidenceText: 'Our method improves experiment planning quality with evidence-aware retrieval.',
        sectionRole: 'abstract',
        confidence: 0.84
      }
    ],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [],
    futureDirections: []
  };

  applySemanticAdmissionPolicy(semanticPaper);

  assert.deepEqual(semanticPaper.problems.map((entry) => entry.name), ['evidence-aware experiment planning']);
  assert.deepEqual(semanticPaper.methods.map((entry) => entry.name), ['retrieval-augmented planning workflow']);
  assert.equal(semanticPaper.problems[0].brainstormEligible, true);
  assert.equal(semanticPaper.methods[0].brainstormEligible, true);
  assert.equal(semanticPaper.metrics[0].brainstormEligible, false);
  assert.equal(semanticPaper.problems[0].admissionSource, 'semantic-admission-v1');
});

test('brainstorm view payload only indexes brainstorm-eligible nodes', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:1',
    type: NODE_TYPES.PAPER,
    name: 'Paper One',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:1',
      paperTitle: 'Paper One'
    }
  });
  graph.addNode({
    id: 'problem:good',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence-aware experiment planning',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.88,
      brainstormTier: 'high'
    }
  });
  graph.addNode({
    id: 'problem:noise',
    type: NODE_TYPES.PROBLEM,
    name: 'energy',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: false,
      brainstormScore: 0.28,
      brainstormTier: 'low'
    }
  });

  const payload = createLiteGraphPayload(graph);

  assert.equal(payload.views.brainstorm.nodeCount, 1);
  assert.deepEqual(payload.views.brainstorm.nodeIds, ['problem:good']);
  assert.ok(payload.views.brainstorm.indexes.searchTokens.planning.includes('problem:good'));
  assert.equal(payload.views.brainstorm.indexes.searchTokens.energy, undefined);
});

test('brainstorm search path ignores non-eligible noisy nodes', () => {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:1',
    type: NODE_TYPES.PAPER,
    name: 'Planning Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:1',
      paperTitle: 'Planning Paper',
      abstract: 'This paper studies evidence-aware experiment planning.'
    }
  });
  graph.addNode({
    id: 'problem:good',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence-aware experiment planning',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.91,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'problem:noise',
    type: NODE_TYPES.PROBLEM,
    name: 'energy',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: false,
      brainstormScore: 0.22,
      brainstormTier: 'low',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'method:1',
    type: NODE_TYPES.METHOD,
    name: 'retrieval-augmented planning workflow',
    properties: {
      layer: 'MethodLayer',
      brainstormEligible: true,
      brainstormScore: 0.89,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });

  graph.addRelationship({
    id: 'rel:paper-problem-good',
    sourceId: 'paper:1',
    targetId: 'problem:good',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:1', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:paper-problem-noise',
    sourceId: 'paper:1',
    targetId: 'problem:noise',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:1', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:paper-method',
    sourceId: 'paper:1',
    targetId: 'method:1',
    type: EDGE_TYPES.USES,
    properties: { sourcePaperId: 'paper:1', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:method-problem',
    sourceId: 'method:1',
    targetId: 'problem:good',
    type: EDGE_TYPES.APPLIES_TO,
    properties: { sourcePaperId: 'paper:1', sourcePaperTitle: 'Planning Paper' }
  });

  const brainstorm = buildBrainstorm(graph, 'planning', {
    mode: 'diverge',
    maxHops: 1
  });

  assert.ok(brainstorm.similarProblems.some((entry) => entry.name === 'evidence-aware experiment planning'));
  assert.equal(brainstorm.similarProblems.some((entry) => entry.name === 'energy'), false);
});

test('brainstorm divergence can surface same-community latent neighbors without direct edges', () => {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:seed',
    type: NODE_TYPES.PAPER,
    name: 'Planning Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:seed',
      paperTitle: 'Planning Paper',
      abstract: 'This paper studies evidence-aware experiment planning.'
    }
  });
  graph.addNode({
    id: 'paper:bridge',
    type: NODE_TYPES.PAPER,
    name: 'Auditing Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:bridge',
      paperTitle: 'Auditing Paper',
      abstract: 'This paper studies evidence trace coverage for research systems.'
    }
  });
  graph.addNode({
    id: 'problem:planning',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence-aware experiment planning',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.93,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'problem:audit',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence trace auditing',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.87,
      brainstormTier: 'high',
      paperTitles: ['Auditing Paper']
    }
  });
  graph.addNode({
    id: 'method:seed',
    type: NODE_TYPES.METHOD,
    name: 'retrieval-augmented planning workflow',
    properties: {
      layer: 'MethodLayer',
      brainstormEligible: true,
      brainstormScore: 0.91,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'method:latent',
    type: NODE_TYPES.METHOD,
    name: 'graph-backed evidence scheduler',
    properties: {
      layer: 'MethodLayer',
      brainstormEligible: true,
      brainstormScore: 0.88,
      brainstormTier: 'high',
      paperTitles: ['Auditing Paper']
    }
  });

  graph.addRelationship({
    id: 'rel:seed-paper-problem',
    sourceId: 'paper:seed',
    targetId: 'problem:planning',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:seed-paper-method',
    sourceId: 'paper:seed',
    targetId: 'method:seed',
    type: EDGE_TYPES.USES,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:seed-method-problem',
    sourceId: 'method:seed',
    targetId: 'problem:planning',
    type: EDGE_TYPES.APPLIES_TO,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-paper-problem',
    sourceId: 'paper:bridge',
    targetId: 'problem:audit',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Auditing Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-paper-method',
    sourceId: 'paper:bridge',
    targetId: 'method:latent',
    type: EDGE_TYPES.USES,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Auditing Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-method-problem',
    sourceId: 'method:latent',
    targetId: 'problem:audit',
    type: EDGE_TYPES.APPLIES_TO,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Auditing Paper' }
  });
  graph.addRelationship({
    id: 'rel:problem-related',
    sourceId: 'problem:planning',
    targetId: 'problem:audit',
    type: EDGE_TYPES.RELATED_TO,
    properties: { score: 0.82 }
  });

  const brainstorm = buildBrainstorm(graph, 'planning', {
    mode: 'diverge',
    maxHops: 2
  });

  assert.ok(
    brainstorm.relatedConcepts.some(
      (entry) => entry.name === 'graph-backed evidence scheduler' && entry.via === 'community'
    )
  );
});

test('research ideas can add a cross-community method combination candidate', () => {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:seed',
    type: NODE_TYPES.PAPER,
    name: 'Planning Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:seed',
      paperTitle: 'Planning Paper',
      abstract: 'This paper studies evidence-aware experiment planning.'
    }
  });
  graph.addNode({
    id: 'paper:bridge',
    type: NODE_TYPES.PAPER,
    name: 'Verifier Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:bridge',
      paperTitle: 'Verifier Paper',
      abstract: 'This paper studies uncertainty-aware verification for evidence pipelines.'
    }
  });
  graph.addNode({
    id: 'problem:planning',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence-aware experiment planning',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.93,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'limitation:coverage',
    type: NODE_TYPES.LIMITATION,
    name: 'weak evidence coverage',
    properties: {
      layer: 'ConstraintLayer',
      brainstormEligible: true,
      brainstormScore: 0.86,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'method:planner',
    type: NODE_TYPES.METHOD,
    name: 'retrieval-augmented planning workflow',
    properties: {
      layer: 'MethodLayer',
      brainstormEligible: true,
      brainstormScore: 0.91,
      brainstormTier: 'high',
      paperTitles: ['Planning Paper']
    }
  });
  graph.addNode({
    id: 'method:verifier',
    type: NODE_TYPES.METHOD,
    name: 'uncertainty-aware verifier',
    properties: {
      layer: 'MethodLayer',
      brainstormEligible: true,
      brainstormScore: 0.89,
      brainstormTier: 'high',
      paperTitles: ['Verifier Paper']
    }
  });
  graph.addNode({
    id: 'problem:auditing',
    type: NODE_TYPES.PROBLEM,
    name: 'evidence trace auditing',
    properties: {
      layer: 'ProblemLayer',
      brainstormEligible: true,
      brainstormScore: 0.87,
      brainstormTier: 'high',
      paperTitles: ['Verifier Paper']
    }
  });

  graph.addRelationship({
    id: 'rel:seed-paper-problem',
    sourceId: 'paper:seed',
    targetId: 'problem:planning',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:seed-paper-method',
    sourceId: 'paper:seed',
    targetId: 'method:planner',
    type: EDGE_TYPES.USES,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:seed-paper-limitation',
    sourceId: 'paper:seed',
    targetId: 'limitation:coverage',
    type: EDGE_TYPES.HAS_LIMITATION,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:seed-method-problem',
    sourceId: 'method:planner',
    targetId: 'problem:planning',
    type: EDGE_TYPES.APPLIES_TO,
    properties: { sourcePaperId: 'paper:seed', sourcePaperTitle: 'Planning Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-paper-method',
    sourceId: 'paper:bridge',
    targetId: 'method:verifier',
    type: EDGE_TYPES.USES,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Verifier Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-paper-problem',
    sourceId: 'paper:bridge',
    targetId: 'problem:auditing',
    type: EDGE_TYPES.SOLVES,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Verifier Paper' }
  });
  graph.addRelationship({
    id: 'rel:bridge-method-problem',
    sourceId: 'method:verifier',
    targetId: 'problem:auditing',
    type: EDGE_TYPES.APPLIES_TO,
    properties: { sourcePaperId: 'paper:bridge', sourcePaperTitle: 'Verifier Paper' }
  });
  graph.addRelationship({
    id: 'rel:limitation-related-problem',
    sourceId: 'limitation:coverage',
    targetId: 'problem:auditing',
    type: EDGE_TYPES.RELATED_TO,
    properties: { score: 0.71 }
  });
  graph.addRelationship({
    id: 'rel:problem-related',
    sourceId: 'problem:planning',
    targetId: 'problem:auditing',
    type: EDGE_TYPES.RELATED_TO,
    properties: { score: 0.82 }
  });

  const ideas = buildResearchIdeas(graph, 'planning', {
    limit: 8
  });

  assert.ok(ideas.ideas.some((idea) => idea.template === 'community_method_combination'));
});
