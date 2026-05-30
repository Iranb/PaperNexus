import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPOSAL_ACTION_TYPES,
  PROPOSAL_EDGE_TYPES,
  PROPOSAL_NODE_TYPES,
  createProposalGraph,
  mergeValidatedActions,
  validateActionSlate,
  validateProposalGraph
} from '../src/core/graph/proposal-graph.js';
import {
  evaluateProposalCommit
} from '../src/core/graph/proposal-controller.js';
import {
  synthesizeProposalBundle
} from '../src/core/graph/proposal-synthesis.js';

function completeActions(problemId) {
  return [
    {
      id: 'add-hypothesis',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'hypothesis:adaptive-feedback',
        type: PROPOSAL_NODE_TYPES.HYPOTHESIS,
        title: 'Adaptive feedback calibration reduces biased belief updates',
        text: 'A falsifiable feedback calibration signal can reduce biased belief updates in tutoring systems.',
        claim_label: 'evidence-supported',
        provenance: [{ kind: 'fixture', ref: 'hypothesis' }]
      }
    },
    {
      id: 'add-mechanism',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'mechanism:reflective-prompts',
        type: PROPOSAL_NODE_TYPES.MECHANISM,
        title: 'Reflective prompt transfer',
        text: 'Reflective prompts transfer uncertainty-aware belief revision into tutoring feedback loops.',
        claim_label: 'evidence-supported',
        provenance: [{ kind: 'fixture', ref: 'mechanism' }]
      }
    },
    {
      id: 'add-method',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'method:calibrated-tutor',
        type: PROPOSAL_NODE_TYPES.METHOD,
        title: 'Calibrated tutoring feedback scaffold',
        text: 'The method alternates direct feedback with reflective prompts when learner uncertainty is high.',
        claim_label: 'evidence-supported',
        provenance: [{ kind: 'fixture', ref: 'method' }]
      }
    },
    {
      id: 'add-novelty',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'novelty:feedback-calibration',
        type: PROPOSAL_NODE_TYPES.NOVELTY_CLAIM,
        title: 'Reflective calibration for tutoring feedback',
        text: 'The novelty is the explicit transfer of reflective prompt calibration into adaptive tutoring feedback.',
        claim_label: 'evidence-supported',
        provenance: [{ kind: 'fixture', ref: 'novelty' }]
      }
    },
    {
      id: 'add-risk',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'risk:dataset-generalization',
        type: PROPOSAL_NODE_TYPES.RISK,
        title: 'Dataset generalization risk',
        text: 'The result may not generalize beyond one tutoring dataset.',
        severity: 'medium',
        provenance: [{ kind: 'fixture', ref: 'risk' }]
      }
    },
    {
      id: 'add-eval',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'eval:calibration-plan',
        type: PROPOSAL_NODE_TYPES.EVAL_PLAN,
        title: 'Tutoring calibration evaluation',
        text: 'Evaluate calibration against tutoring baselines and falsify when biased updates do not decrease.',
        properties: {
          datasets: ['ASSISTments'],
          baselines: ['direct feedback tutor'],
          metrics: ['belief update bias', 'learning gain'],
          ablations: ['remove reflective prompt gate'],
          leakage_controls: ['student-disjoint split'],
          falsifier: true,
          falsification_condition: 'No reduction in biased belief updates versus direct feedback.'
        },
        provenance: [{ kind: 'fixture', ref: 'eval' }]
      }
    },
    {
      id: 'add-story',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'story:contribution',
        type: PROPOSAL_NODE_TYPES.STORY_BEAT,
        title: 'Contribution story',
        text: 'A psychology-grounded calibration mechanism makes tutoring feedback more robust.',
        provenance: [{ kind: 'fixture', ref: 'story' }]
      }
    },
    {
      id: 'add-evidence',
      type: PROPOSAL_ACTION_TYPES.ADD_NODE,
      node: {
        id: 'evidence:reflective-prompts',
        type: PROPOSAL_NODE_TYPES.EVIDENCE_ATTACHMENT,
        title: 'Belief Updating Under Uncertainty',
        text: 'Reflective prompts improve uncertainty-aware belief revision.',
        properties: {
          evidence_id: 'span:reflective-prompts',
          paper_title: 'Belief Updating Under Uncertainty',
          citation_context: 'Reflective prompts improve uncertainty-aware belief revision.',
          evidence_tier: 'strong'
        },
        provenance: [{ kind: 'fixture', ref: 'span:reflective-prompts' }]
      }
    },
    {
      id: 'connect-problem-hypothesis',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:problem-hypothesis',
        type: PROPOSAL_EDGE_TYPES.REFINES,
        source: problemId,
        target: 'hypothesis:adaptive-feedback',
        provenance: [{ kind: 'fixture', ref: 'connect-problem' }]
      }
    },
    {
      id: 'connect-mechanism-method',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:mechanism-method',
        type: PROPOSAL_EDGE_TYPES.SUPPORTS,
        source: 'mechanism:reflective-prompts',
        target: 'method:calibrated-tutor',
        provenance: [{ kind: 'fixture', ref: 'connect-mechanism' }]
      }
    },
    {
      id: 'connect-method-hypothesis',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:method-hypothesis',
        type: PROPOSAL_EDGE_TYPES.SUPPORTS,
        source: 'method:calibrated-tutor',
        target: 'hypothesis:adaptive-feedback',
        provenance: [{ kind: 'fixture', ref: 'connect-method' }]
      }
    },
    {
      id: 'connect-novelty-method',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:novelty-method',
        type: PROPOSAL_EDGE_TYPES.REFINES,
        source: 'novelty:feedback-calibration',
        target: 'method:calibrated-tutor',
        provenance: [{ kind: 'fixture', ref: 'connect-novelty' }]
      }
    },
    {
      id: 'connect-risk-method',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:method-risk',
        type: PROPOSAL_EDGE_TYPES.DEPENDS_ON,
        source: 'method:calibrated-tutor',
        target: 'risk:dataset-generalization',
        provenance: [{ kind: 'fixture', ref: 'connect-risk' }]
      }
    },
    {
      id: 'connect-eval-method',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:method-eval',
        type: PROPOSAL_EDGE_TYPES.EVALUATED_BY,
        source: 'method:calibrated-tutor',
        target: 'eval:calibration-plan',
        provenance: [{ kind: 'fixture', ref: 'connect-eval' }]
      }
    },
    {
      id: 'connect-falsifier',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:hypothesis-falsifier',
        type: PROPOSAL_EDGE_TYPES.FALSIFIED_BY,
        source: 'hypothesis:adaptive-feedback',
        target: 'eval:calibration-plan',
        provenance: [{ kind: 'fixture', ref: 'connect-falsifier' }]
      }
    },
    ...['hypothesis:adaptive-feedback', 'mechanism:reflective-prompts', 'method:calibrated-tutor', 'novelty:feedback-calibration'].flatMap((source) => [
      {
        id: `ground-${source}`,
        type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
        edge: {
          id: `edge:${source}-grounded`,
          type: PROPOSAL_EDGE_TYPES.GROUNDED_IN,
          source,
          target: 'evidence:reflective-prompts',
          provenance: [{ kind: 'fixture', ref: `ground-${source}` }]
        }
      },
      {
        id: `must-cite-${source}`,
        type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
        edge: {
          id: `edge:${source}-must-cite`,
          type: PROPOSAL_EDGE_TYPES.MUST_CITE,
          source,
          target: 'evidence:reflective-prompts',
          provenance: [{ kind: 'fixture', ref: `must-cite-${source}` }]
        }
      }
    ]),
    {
      id: 'connect-prior-overlap',
      type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
      edge: {
        id: 'edge:novelty-prior',
        type: PROPOSAL_EDGE_TYPES.OVERLAPS_PRIOR,
        source: 'novelty:feedback-calibration',
        target: 'evidence:reflective-prompts',
        provenance: [{ kind: 'fixture', ref: 'prior-overlap' }]
      }
    }
  ];
}

test('proposal graph schema rejects invalid node and edge types', () => {
  const graph = createProposalGraph({
    run_id: 'schema-test',
    problem: 'Calibrate tutoring feedback',
    target_domain: 'Education'
  });

  assert.equal(validateProposalGraph(graph).valid, true);

  const invalid = {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: 'node:bad',
        type: 'BadNodeType',
        title: 'Bad',
        text: 'Bad',
        provenance: [{ kind: 'fixture', ref: 'bad' }]
      }
    ],
    edges: [
      {
        id: 'edge:bad',
        type: 'bad_edge',
        source: graph.problem_node_id,
        target: 'node:missing',
        provenance: [{ kind: 'fixture', ref: 'bad-edge' }]
      }
    ]
  };

  const validation = validateProposalGraph(invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((entry) => entry.includes('Invalid node type')));
  assert.ok(validation.errors.some((entry) => entry.includes('Invalid edge type')));
});

test('role action slates target frozen snapshots and do not mutate directly', () => {
  const graph = createProposalGraph({
    run_id: 'action-test',
    problem: 'Calibrate tutoring feedback',
    target_domain: 'Education'
  });
  const beforeHash = graph.graph_hash;

  const slate = {
    round_id: 'round-000',
    snapshot_id: graph.snapshot_id,
    role_id: 'ProblemFramer',
    actions: completeActions(graph.problem_node_id).slice(0, 2)
  };
  const result = validateActionSlate(slate, graph);

  assert.equal(result.valid, true);
  assert.equal(graph.graph_hash, beforeHash);
  assert.equal(graph.nodes.length, 1);

  const stale = validateActionSlate({
    ...slate,
    snapshot_id: 'snapshot:stale'
  }, graph);
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((entry) => entry.includes('expected')));
});

test('proposal patches merge deterministically and committed graphs synthesize bundles', () => {
  const graph = createProposalGraph({
    run_id: 'merge-test',
    problem: 'Calibrate tutoring feedback',
    target_domain: 'Education'
  });
  const slate = validateActionSlate({
    round_id: 'round-000',
    snapshot_id: graph.snapshot_id,
    role_id: 'FixtureRole',
    actions: completeActions(graph.problem_node_id)
  }, graph);
  assert.equal(slate.valid, true);

  const first = mergeValidatedActions(graph, slate.valid_actions, {
    round_id: 'round-000',
    edit_decision_id: 'edit:fixture'
  });
  const second = mergeValidatedActions(graph, slate.valid_actions, {
    round_id: 'round-000',
    edit_decision_id: 'edit:fixture'
  });

  assert.equal(first.graph.graph_hash, second.graph.graph_hash);
  assert.equal(first.patch.validation.valid, true);

  const decision = evaluateProposalCommit(first.graph, { round_id: 'round-000' });
  assert.equal(decision.status, 'committed');

  const committedGraph = {
    ...first.graph,
    status: 'committed',
    committed_subgraph_id: decision.committed_subgraph_id
  };
  const bundle = synthesizeProposalBundle(committedGraph, {
    commitDecision: decision
  });

  assert.match(bundle.markdown, /## Evaluation Plan/);
  assert.match(bundle.markdown, /## Must-Cite Evidence/);
  assert.equal(bundle.proposal_json.core_hypothesis.claim_label, 'evidence-supported');
  assert.ok(bundle.proposal_json.must_cite_evidence.length >= 1);
});

test('final synthesis refuses to run without a committed subgraph', () => {
  const graph = createProposalGraph({
    run_id: 'uncommitted-test',
    problem: 'Calibrate tutoring feedback',
    target_domain: 'Education'
  });

  assert.throws(
    () => synthesizeProposalBundle(graph, { commitDecision: { status: 'continue' } }),
    /committed proposal graph/
  );
});
