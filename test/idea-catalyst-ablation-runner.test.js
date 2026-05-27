import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyIdeaCatalystAblationToPacket,
  IDEA_CATALYST_ABLATION_RUNNER_VERSION,
  runIdeaCatalystAblationSuite
} from '../src/core/eval/ablation-runner.js';

function storyline() {
  return {
    beats: [
      { beat_id: 'beat:problem', trace_refs: [{ kind: 'claim', id: 'claim:1' }], claim_ids: ['claim:1'] },
      { beat_id: 'beat:why-now', trace_refs: [{ kind: 'claim', id: 'claim:1' }], claim_ids: ['claim:1'] }
    ],
    edges: [{ source_beat_id: 'beat:problem', target_beat_id: 'beat:why-now', relation: 'precedes' }],
    unsupported_beats: []
  };
}

function candidatePacket() {
  return {
    evidence_status: 'source_backed',
    must_cite_set: [
      { title: 'Anchor Method', doi: '10.1000/anchor', year: 2020 },
      { title: 'Prior Challenge', doi: '10.1000/challenge', year: 2021 }
    ],
    novelty_certificate: {
      novelty: 0.9,
      significance: 0.8,
      feasibility: 0.8,
      grounding: 1,
      must_cite_completeness: 1,
      temporal_validity: 1,
      future_leakage_count: 0
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'The proposed bridge improves grounding.',
      source_span_ids: ['span:1']
    }],
    storyline_dag: storyline(),
    review_packet: {
      reviewer_panel: [{ reviewer_role: 'novelty', verdict: 'accept' }],
      major_concerns: [{ concern_id: 'concern:1', severity: 'minor' }],
      meta_review: { recommendation: 'accept' },
      final_recommendation: 'accept'
    },
    citation_contexts: [{ id: 'ctx:1', source: 'OpenAlex' }, { id: 'ctx:2', source: 'manual' }],
    graph_summaries: [{ id: 'community:1', summary: 'GraphRAG community summary.' }],
    bridge_rerank_signals: {
      signals: [{
        source_id: 'challenge:grounding',
        target_id: 'method:bridge',
        predicted_edge_type: 'ADAPTS_METHOD',
        score: 0.92,
        rank: 1
      }]
    },
    predicted_bridge_edges: [{
      source_id: 'challenge:grounding',
      target_id: 'method:bridge',
      predicted_edge_type: 'ADAPTS_METHOD',
      score: 0.92,
      rank: 1
    }],
    counterfactuals: [{ falsification_plan_id: 'falsification:1', status: 'planned' }],
    falsification_plans: [{ falsification_plan_id: 'falsification:1', status: 'planned' }]
  };
}

function baselinePacket() {
  return {
    evidence_status: 'weak_evidence',
    must_cite_set: [{ title: 'Anchor Method', doi: '10.1000/anchor', year: 2020 }],
    novelty_certificate: {
      novelty: 0.2,
      significance: 0.2,
      feasibility: 0.2,
      grounding: 0.1,
      must_cite_completeness: 0.2,
      temporal_validity: 1,
      future_leakage_count: 0
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'The proposed bridge improves grounding.',
      source_span_ids: []
    }],
    storyline_dag: {
      beats: [{ beat_id: 'beat:problem', trace_refs: [{ kind: 'claim', id: 'claim:1' }], claim_ids: ['claim:1'] }],
      edges: [],
      unsupported_beats: []
    }
  };
}

function benchmark() {
  return {
    name: 'ablation-mini',
    format: 'custom',
    cases: [{
      id: 'case:ablation',
      timeCutoff: 2024,
      candidate: candidatePacket(),
      baseline: baselinePacket(),
      gold: {
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        novelty_certificate: {
          novelty: 0.9,
          significance: 0.8,
          feasibility: 0.8,
          grounding: 1,
          must_cite_completeness: 1,
          temporal_validity: 1
        },
        claims: [{
          claim_id: 'claim:1',
          claim_text: 'The proposed bridge improves grounding.',
          label: 'supported'
        }],
        bridge_edges: [{
          source_id: 'challenge:grounding',
          target_id: 'method:bridge',
          edge_type: 'ADAPTS_METHOD'
        }]
      }
    }]
  };
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('idea-catalyst ablation runner degrades expected gates when key artifacts are removed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ablation-runner-'));
  try {
    const manifest = await runIdeaCatalystAblationSuite({
      benchmark: benchmark(),
      outputDir: tempRoot,
      runId: 'ablation-mini',
      cutoffs: [1, 2],
      primaryCutoff: 2,
      thresholds: {
        mustCiteRecallAtK: 1,
        claimGroundingF1: 1,
        historicalReplayImprovement: 0
      }
    });

    assert.equal(manifest.contractVersion, IDEA_CATALYST_ABLATION_RUNNER_VERSION);
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.ablations.find((entry) => entry.ablation_id === 'full').status, 'passed');

    const noMustCite = manifest.ablations.find((entry) => entry.ablation_id === 'without_must_cite');
    const noClaimGraph = manifest.ablations.find((entry) => entry.ablation_id === 'without_claim_graph');
    const noStorylineDag = manifest.ablations.find((entry) => entry.ablation_id === 'without_storyline_dag');
    const noTemporalCutoff = manifest.ablations.find((entry) => entry.ablation_id === 'without_temporal_cutoff');
    const noReviewerPanel = manifest.ablations.find((entry) => entry.ablation_id === 'without_reviewer_panel');
    const noMetaReviewer = manifest.ablations.find((entry) => entry.ablation_id === 'without_meta_reviewer');
    const noCociOpenAlex = manifest.ablations.find((entry) => entry.ablation_id === 'without_coci_openalex');
    const noGraphRag = manifest.ablations.find((entry) => entry.ablation_id === 'without_graphrag_summaries');
    const noLinkPrediction = manifest.ablations.find((entry) => entry.ablation_id === 'without_link_prediction_signal');
    const noCounterfactualPlanner = manifest.ablations.find((entry) => entry.ablation_id === 'without_counterfactual_planner');

    assert.equal(manifest.ablations.every((entry) => entry.control || entry.artifact_removal_audit?.status === 'passed'), true);
    assert.equal(manifest.ablations.every((entry) => entry.ablation_effect_audit?.status), true);
    assert.deepEqual(
      manifest.ablations
        .filter((entry) => !entry.control)
        .map((entry) => entry.artifact_removal_audit?.target_removed),
      Array(manifest.ablations.filter((entry) => !entry.control).length).fill(true)
    );
    assert.equal(noMustCite.gates_failed.includes('must_cite_recall_at_k'), true);
    assert.equal(noMustCite.deltas_from_control.must_cite_recall_at_k < 0, true);
    assert.equal(noMustCite.ablation_effect_audit.status, 'passed');
    assert.equal(noMustCite.ablation_effect_audit.effect_observed, true);
    assert.equal(noMustCite.artifact_removal_audit.before_count, 2);
    assert.equal(noMustCite.artifact_removal_audit.after_count, 0);
    assert.equal(noClaimGraph.gates_failed.includes('claim_grounding'), true);
    assert.equal(noClaimGraph.deltas_from_control.claim_source_span_completeness < 0, true);
    assert.equal(noClaimGraph.ablation_effect_audit.status, 'passed');
    assert.equal(noStorylineDag.status, 'incomplete');
    assert.equal(noStorylineDag.deltas_from_control.storyline_trace_coverage < 0, true);
    assert.equal(noStorylineDag.ablation_effect_audit.status, 'passed');
    assert.equal(noTemporalCutoff.status, 'incomplete');
    assert.equal(noTemporalCutoff.ablation_effect_audit.status, 'passed');
    for (const structuralLane of [noReviewerPanel, noMetaReviewer, noCociOpenAlex, noGraphRag, noCounterfactualPlanner]) {
      assert.equal(structuralLane.ablation_effect_audit.status, 'incomplete');
      assert.equal(structuralLane.ablation_effect_audit.effect_required, true);
      assert.match(structuralLane.ablation_effect_audit.reason, /measured downstream effect audit is required/);
    }
    assert.equal(noLinkPrediction.metrics.bridge_rerank_recall_at_k, 0);
    assert.equal(noLinkPrediction.deltas_from_control.bridge_rerank_recall_at_k < 0, true);
    assert.equal(noLinkPrediction.ablation_effect_audit.status, 'passed');
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_reviewer_panel'), true);
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_meta_reviewer'), true);
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_coci_openalex'), true);
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_graphrag_summaries'), true);
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_link_prediction_signal'), true);
    assert.equal(manifest.ablations.some((entry) => entry.ablation_id === 'without_counterfactual_planner'), true);
    assert.equal(manifest.ablations.every((entry) => entry.report_artifact?.sha256), true);
    assert.equal(manifest.ablations.find((entry) => entry.ablation_id === 'without_claim_graph').report_artifact.role, 'ablation_variant_report');

    const persisted = JSON.parse(await fs.readFile(path.join(tempRoot, 'ablation-manifest.json'), 'utf8'));
    assert.equal(persisted.report_count, 11);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('idea-catalyst ablation runner records benchmark input hash for file-backed runs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ablation-runner-input-'));
  try {
    const datasetPath = path.join(tempRoot, 'benchmark.json');
    await fs.writeFile(datasetPath, `${JSON.stringify(benchmark(), null, 2)}\n`, 'utf8');
    const manifest = await runIdeaCatalystAblationSuite({
      datasetPath,
      outputDir: path.join(tempRoot, 'out'),
      runId: 'ablation-input-hash',
      ablations: [{ id: 'without_must_cite' }],
      cutoffs: [1, 2],
      primaryCutoff: 2,
      thresholds: {
        mustCiteRecallAtK: 1,
        historicalReplayImprovement: 0
      }
    });

    assert.equal(manifest.inputs.length, 1);
    assert.equal(manifest.inputs[0].role, 'ablation_benchmark');
    assert.equal(manifest.inputs[0].path, datasetPath);
    assert.equal(manifest.inputs[0].sha256, await sha256File(datasetPath));
    assert.ok(manifest.ablations.find((entry) => entry.ablation_id === 'without_must_cite').report_artifact.sha256);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('packet ablation helper keeps the original packet immutable', () => {
  const packet = candidatePacket();
  const ablated = applyIdeaCatalystAblationToPacket(packet, { id: 'without_claim_spans' });

  assert.equal(packet.evidence_status, 'source_backed');
  assert.deepEqual(packet.contribution_claims[0].source_span_ids, ['span:1']);
  assert.equal(ablated.evidence_status, 'weak_evidence');
  assert.deepEqual(ablated.contribution_claims, []);
});

test('packet ablation helper removes report-required optional artifact lanes', () => {
  const packet = candidatePacket();

  const noReviewer = applyIdeaCatalystAblationToPacket(packet, { id: 'without_reviewer_panel' });
  assert.equal(packet.review_packet.reviewer_panel.length, 1);
  assert.equal(noReviewer.review_packet, null);

  const noMetaReviewer = applyIdeaCatalystAblationToPacket(packet, { id: 'without_meta_reviewer' });
  assert.equal(noMetaReviewer.review_packet.meta_review, null);
  assert.equal(noMetaReviewer.review_packet.final_recommendation, null);

  const noCociOpenAlex = applyIdeaCatalystAblationToPacket(packet, { id: 'without_coci_openalex' });
  assert.deepEqual(noCociOpenAlex.citation_contexts.map((entry) => entry.id), ['ctx:2']);

  const noGraphRag = applyIdeaCatalystAblationToPacket(packet, { id: 'without_graphrag_summaries' });
  assert.deepEqual(noGraphRag.graph_summaries, []);

  const noLinkPrediction = applyIdeaCatalystAblationToPacket(packet, { id: 'without_link_prediction_signal' });
  assert.deepEqual(noLinkPrediction.bridge_rerank_signals.signals, []);
  assert.deepEqual(noLinkPrediction.predicted_bridge_edges, []);

  const noCounterfactual = applyIdeaCatalystAblationToPacket(packet, { id: 'without_counterfactual_planner' });
  assert.deepEqual(noCounterfactual.counterfactuals, []);
  assert.deepEqual(noCounterfactual.falsification_plans, []);
});
