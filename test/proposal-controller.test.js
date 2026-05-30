import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PROPOSAL_ACTION_TYPES,
  PROPOSAL_EDGE_TYPES,
  PROPOSAL_NODE_TYPES
} from '../src/core/graph/proposal-graph.js';
import {
  PROPOSAL_SESSION_MANIFEST_VERSION,
  replayProposalActionTrace,
  runProposalGraphSession
} from '../src/core/graph/proposal-controller.js';
import {
  PROPOSAL_BUNDLE_VERSION
} from '../src/core/graph/proposal-synthesis.js';
import { executeAgentMaterialsOperation } from '../src/core/materials/agent-materials.js';

function addNode(id, type, title, text, extra = {}) {
  return {
    id: `add-${id}`,
    type: PROPOSAL_ACTION_TYPES.ADD_NODE,
    node: {
      id,
      type,
      title,
      text,
      provenance: [{ kind: 'fixture', ref: id }],
      ...extra
    }
  };
}

function addEdge(id, edgeType, source, target) {
  return {
    id: `connect-${id}`,
    type: PROPOSAL_ACTION_TYPES.ADD_EDGE,
    edge: {
      id: `edge:${id}`,
      type: edgeType,
      source,
      target,
      provenance: [{ kind: 'fixture', ref: id }]
    }
  };
}

function completeProposalActions(problemId) {
  const claimIds = [
    'hypothesis:belief-feedback',
    'mechanism:uncertainty-transfer',
    'method:calibrated-feedback',
    'novelty:uncertainty-calibration'
  ];

  return [
    addNode(
      'hypothesis:belief-feedback',
      PROPOSAL_NODE_TYPES.HYPOTHESIS,
      'Uncertainty-aware feedback improves learner belief updates',
      'A tutoring policy that calibrates feedback against learner uncertainty will reduce biased belief updates.',
      { claim_label: 'evidence-supported' }
    ),
    addNode(
      'mechanism:uncertainty-transfer',
      PROPOSAL_NODE_TYPES.MECHANISM,
      'Uncertainty transfer mechanism',
      'The mechanism transfers uncertainty-aware reasoning into the timing and framing of feedback.',
      { claim_label: 'evidence-supported' }
    ),
    addNode(
      'method:calibrated-feedback',
      PROPOSAL_NODE_TYPES.METHOD,
      'Calibrated feedback controller',
      'The method routes learner states through a calibration controller before selecting feedback.',
      { claim_label: 'evidence-supported' }
    ),
    addNode(
      'novelty:uncertainty-calibration',
      PROPOSAL_NODE_TYPES.NOVELTY_CLAIM,
      'Calibration bridge for adaptive tutoring',
      'The novelty is an explicit bridge between uncertainty calibration and adaptive tutoring feedback.',
      { claim_label: 'evidence-supported' }
    ),
    addNode(
      'risk:dataset-generalization',
      PROPOSAL_NODE_TYPES.RISK,
      'Dataset generalization risk',
      'The result may be limited to a narrow tutoring dataset.',
      { severity: 'medium' }
    ),
    addNode(
      'risk:implementation',
      PROPOSAL_NODE_TYPES.RISK,
      'Implementation cost risk',
      'The controller may add high operational cost unless repaired.',
      { severity: 'high' }
    ),
    addNode(
      'eval:tutoring-calibration',
      PROPOSAL_NODE_TYPES.EVAL_PLAN,
      'Tutoring calibration evaluation',
      'Evaluate against direct feedback and falsify when belief update bias does not fall.',
      {
        properties: {
          datasets: ['ASSISTments'],
          baselines: ['direct-feedback tutor'],
          metrics: ['belief update bias', 'learning gain'],
          ablations: ['remove uncertainty gate'],
          leakage_controls: ['student-disjoint split'],
          falsifier: true,
          falsification_condition: 'No reduction in belief update bias versus direct feedback.'
        }
      }
    ),
    addNode(
      'story:main-contribution',
      PROPOSAL_NODE_TYPES.STORY_BEAT,
      'Main contribution story',
      'A calibrated feedback controller makes adaptive tutoring feedback testable and safer.'
    ),
    addNode(
      'evidence:uncertainty',
      PROPOSAL_NODE_TYPES.EVIDENCE_ATTACHMENT,
      'Uncertainty-aware feedback evidence',
      'Prior work shows uncertainty-aware feedback can improve belief revision.',
      {
        properties: {
          evidence_id: 'span:uncertainty-feedback',
          paper_title: 'Uncertainty-aware feedback evidence',
          citation_context: 'Prior work shows uncertainty-aware feedback can improve belief revision.',
          evidence_tier: 'strong'
        }
      }
    ),
    addEdge('problem-hypothesis', PROPOSAL_EDGE_TYPES.REFINES, problemId, 'hypothesis:belief-feedback'),
    addEdge('mechanism-method', PROPOSAL_EDGE_TYPES.SUPPORTS, 'mechanism:uncertainty-transfer', 'method:calibrated-feedback'),
    addEdge('method-hypothesis', PROPOSAL_EDGE_TYPES.SUPPORTS, 'method:calibrated-feedback', 'hypothesis:belief-feedback'),
    addEdge('novelty-method', PROPOSAL_EDGE_TYPES.REFINES, 'novelty:uncertainty-calibration', 'method:calibrated-feedback'),
    addEdge('method-risk', PROPOSAL_EDGE_TYPES.DEPENDS_ON, 'method:calibrated-feedback', 'risk:dataset-generalization'),
    addEdge('method-high-risk', PROPOSAL_EDGE_TYPES.DEPENDS_ON, 'method:calibrated-feedback', 'risk:implementation'),
    addEdge('method-eval', PROPOSAL_EDGE_TYPES.EVALUATED_BY, 'method:calibrated-feedback', 'eval:tutoring-calibration'),
    addEdge('hypothesis-falsifier', PROPOSAL_EDGE_TYPES.FALSIFIED_BY, 'hypothesis:belief-feedback', 'eval:tutoring-calibration'),
    addEdge('novelty-prior-overlap', PROPOSAL_EDGE_TYPES.OVERLAPS_PRIOR, 'novelty:uncertainty-calibration', 'evidence:uncertainty'),
    ...claimIds.flatMap((source) => [
      addEdge(`${source}-grounded`, PROPOSAL_EDGE_TYPES.GROUNDED_IN, source, 'evidence:uncertainty'),
      addEdge(`${source}-must-cite`, PROPOSAL_EDGE_TYPES.MUST_CITE, source, 'evidence:uncertainty')
    ])
  ];
}

test('proposal controller waits for high-risk repair before writing committed artifacts', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-proposal-session-'));
  const result = await runProposalGraphSession({
    run_id: 'controller-artifact-test',
    problem: 'Calibrate adaptive tutoring feedback',
    target_domain: 'Education',
    max_rounds: 2,
    outputDir,
    roleRunners: [
      async ({ round_id: roundId, snapshot }) => {
        if (roundId === 'round-000') {
          return {
            round_id: roundId,
            snapshot_id: snapshot.snapshot_id,
            role_id: 'BuilderRole',
            actions: completeProposalActions(snapshot.problem_node_id)
          };
        }
        return {
          round_id: roundId,
          snapshot_id: snapshot.snapshot_id,
          role_id: 'RiskReviewerRole',
          actions: [
            {
              id: 'repair-implementation-cost',
              type: PROPOSAL_ACTION_TYPES.PROPOSE_REPAIR,
              target_id: 'risk:implementation',
              repair: {
                id: 'repair:implementation-cost',
                type: PROPOSAL_NODE_TYPES.REPAIR,
                title: 'Bound implementation cost',
                text: 'Limit deployment to a lightweight calibration gate and report latency as a constraint.',
                provenance: [{ kind: 'fixture', ref: 'repair-risk' }]
              }
            }
          ]
        };
      }
    ]
  });

  assert.equal(result.final_status, 'committed');
  assert.equal(result.round_count, 2);
  assert.equal(result.commit_decisions[0].status, 'continue');
  assert.ok(result.commit_decisions[0].blocking_reasons.includes('unresolved_high_severity_risks'));
  assert.equal(result.commit_decisions[1].status, 'committed');
  assert.equal(result.validation_report.graph.valid, true);

  const manifestPath = path.join(outputDir, 'proposal-session-manifest.json');
  const proposalPath = path.join(outputDir, 'proposal.json');
  const markdownPath = path.join(outputDir, 'proposal.md');
  const commitTracePath = path.join(outputDir, 'commit-decisions.jsonl');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const proposal = JSON.parse(await fs.readFile(proposalPath, 'utf8'));
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const commitTrace = (await fs.readFile(commitTracePath, 'utf8')).trim().split('\n').map(JSON.parse);

  assert.equal(manifest.manifest_version, PROPOSAL_SESSION_MANIFEST_VERSION);
  assert.equal(manifest.final_status, 'committed');
  assert.equal(manifest.proposal_artifact_paths.proposal_json, proposalPath);
  assert.equal(manifest.artifact_hashes.proposalJson.path, proposalPath);
  assert.ok(manifest.artifact_hashes.proposalJson.hash);
  assert.equal(proposal.proposal_version, PROPOSAL_BUNDLE_VERSION);
  assert.match(markdown, /## Evaluation Plan/);
  assert.equal(commitTrace.length, 2);
  assert.equal(commitTrace[0].status, 'continue');
  assert.equal(commitTrace[1].status, 'committed');

  const replay = replayProposalActionTrace(result.input, result.role_trace);
  assert.equal(replay.final_status, 'committed');
  assert.equal(replay.graph.graph_hash, result.graph.graph_hash);
  assert.equal(replay.proposal_bundle.proposal_json.graph_hash, result.proposal_bundle.proposal_json.graph_hash);
});

test('agent_materials exposes proposal_graph_session with hydrated first-round actions', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-agent-proposal-session-'));
  const result = await executeAgentMaterialsOperation({
    operation: 'proposal_graph_session',
    project: 'proposal-graph-test',
    runId: 'agent-proposal-session-test',
    problem: 'Calibrate adaptive tutoring feedback',
    targetDomain: 'Education',
    maxRounds: 2,
    outputDir,
    proposalActions: completeProposalActions('__problem_node_id__'),
    proposalSlates: {
      'round-001': [
        {
          role_id: 'RiskReviewerRole',
          actions: [
            {
              id: 'repair-implementation-cost',
              type: PROPOSAL_ACTION_TYPES.PROPOSE_REPAIR,
              target_id: 'risk:implementation',
              repair: {
                id: 'repair:implementation-cost',
                type: PROPOSAL_NODE_TYPES.REPAIR,
                title: 'Bound implementation cost',
                text: 'Limit deployment to a lightweight calibration gate and report latency as a constraint.',
                provenance: [{ kind: 'fixture', ref: 'repair-risk' }]
              }
            }
          ]
        }
      ]
    }
  });

  assert.equal(result.operation, 'proposal_graph_session');
  assert.equal(result.final_status, 'committed');
  assert.equal(result.round_count, 2);
  assert.equal(result.graph.status, 'committed');
  assert.ok(result.artifact_paths.proposalMarkdown.endsWith('proposal.md'));
  assert.equal(result.manifest.final_status, 'committed');
  assert.equal(result.proposal_bundle.proposal_json.proposal_version, PROPOSAL_BUNDLE_VERSION);
});
