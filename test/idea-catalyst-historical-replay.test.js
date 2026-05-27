import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  evaluateBridgeRerankSignal,
  evaluateClaimGrounding,
  evaluateMustCiteRecall,
  evaluateStorylineTraceability,
  evaluateTemporalCutoff,
  runIdeaCatalystHistoricalReplay
} from '../src/core/eval/historical-replay.js';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function traceableStoryline() {
  return {
    beats: [
      { beat_id: 'beat:problem', trace_refs: [{ kind: 'claim', id: 'claim:1' }], claim_ids: ['claim:1'] },
      { beat_id: 'beat:risk', trace_refs: [{ kind: 'review_concern', id: 'concern:1' }], review_concern_ids: ['concern:1'] }
    ],
    edges: [{ source_beat_id: 'beat:problem', target_beat_id: 'beat:risk', relation: 'precedes' }],
    unsupported_beats: []
  };
}

function candidatePacket() {
  return {
    evidence_status: 'source_backed',
    must_cite_set: [
      { paper_key: 'paper:a', title: 'Anchor Method', year: 2020, doi: '10.1000/anchor' },
      { paper_key: 'paper:b', title: 'Prior Challenge', year: 2022, doi: '10.1000/challenge' }
    ],
    novelty_certificate: {
      novelty: 0.9,
      significance: 0.8,
      feasibility: 0.7,
      grounding: 1,
      must_cite_completeness: 1,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: ['candidate aligns with gold']
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'Reflective prompts reduce biased tutoring feedback.',
      source_span_ids: ['span:1']
    }],
    storyline_dag: traceableStoryline()
  };
}

function baselinePacket() {
  return {
    evidence_status: 'weak_evidence',
    must_cite_set: [
      { paper_key: 'paper:a', title: 'Anchor Method', year: 2020, doi: '10.1000/anchor' },
      { paper_key: 'paper:distractor', title: 'Distractor Paper', year: 2021, doi: '10.1000/distractor' }
    ],
    novelty_certificate: {
      novelty: 0.45,
      significance: 0.55,
      feasibility: 0.4,
      grounding: 0.25,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: ['baseline misses evidence']
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'Reflective prompts reduce biased tutoring feedback.',
      source_span_ids: []
    }],
    storyline_dag: {
      beats: [{ beat_id: 'beat:problem', supported: false }],
      edges: [],
      unsupported_beats: ['beat:problem']
    }
  };
}

function passingBenchmark() {
  return {
    name: 'mini-idea-catalyst-replay',
    format: 'custom',
    cases: [{
      id: 'case:education-psychology',
      dataset: 'mini-masterset-novbench-claimcheck',
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
          feasibility: 0.7,
          grounding: 1,
          must_cite_completeness: 1,
          temporal_validity: 1
        },
        claims: [{
          claim_id: 'claim:1',
          claim_text: 'Reflective prompts reduce biased tutoring feedback.',
          label: 'supported'
        }]
      }
    }]
  };
}

test('idea-catalyst historical replay evaluates must-cite, novelty, claims, storyline, and cutoff gates', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-idea-catalyst-replay-'));

  try {
    const report = await runIdeaCatalystHistoricalReplay({
      runId: 'mini-replay',
      outputDir: tempRoot,
      benchmark: passingBenchmark(),
      cutoffs: [1, 2],
      primaryCutoff: 2,
      thresholds: {
        mustCiteRecallAtK: 1,
        noveltyImprovement: 0.1,
        claimGroundingF1: 1,
        historicalReplayImprovement: 0.05,
        minMajorMetricImprovements: 3
      }
    });

    assert.equal(report.contractVersion, 'idea-catalyst-historical-replay-v1');
    assert.equal(report.status, 'passed');
    assert.equal(report.metrics.must_cite_recall_at_k, 1);
    assert.equal(report.metrics.claim_grounding_f1, 1);
    assert.equal(report.metrics.storyline_trace_coverage, 1);
    assert.equal(report.metrics.major_metric_improvement_count >= 3, true);
    assert.ok(report.gates.every((gate) => gate.status === 'passed'));
    assert.equal(report.gates.find((gate) => gate.name === 'major_metrics_beat_baseline').status, 'passed');
    assert.ok(report.gates.find((gate) => gate.name === 'historical_replay_beats_live_discovery').mean_improvement > 0);

    assert.ok(await fileExists(path.join(tempRoot, 'report.json')));
    assert.ok(await fileExists(path.join(tempRoot, 'report.md')));
    assert.ok(await fileExists(path.join(tempRoot, 'summary.tsv')));
    assert.ok(await fileExists(path.join(tempRoot, 'manifest.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('idea-catalyst replay gates fail on future leakage and source-backed ungrounded claims', async () => {
  const leakyPacket = {
    ...candidatePacket(),
    must_cite_set: [{ paper_key: 'paper:future', title: 'Future Paper', year: 2026, doi: '10.1000/future' }],
    novelty_certificate: {
      ...candidatePacket().novelty_certificate,
      future_leakage_count: 1,
      temporal_validity: 0
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'Reflective prompts reduce biased tutoring feedback.',
      source_span_ids: []
    }],
    storyline_dag: {
      beats: [{ beat_id: 'beat:problem', supported: true }],
      edges: [],
      unsupported_beats: []
    }
  };
  const report = await runIdeaCatalystHistoricalReplay({
    runId: 'leaky-replay',
    benchmark: {
      name: 'leaky-mini',
      cases: [{
        id: 'case:leak',
        timeCutoff: 2024,
        candidate: leakyPacket,
        baseline: baselinePacket(),
        gold: {
          must_cite_set: [{ title: 'Future Paper', doi: '10.1000/future' }],
          claims: [{ claim_id: 'claim:1', label: 'supported' }],
          novelty_certificate: candidatePacket().novelty_certificate
        }
      }]
    },
    cutoffs: [1],
    primaryCutoff: 1
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.gates.find((gate) => gate.name === 'claim_grounding').status, 'failed');
  assert.equal(report.gates.find((gate) => gate.name === 'storyline_traceability').status, 'failed');
  assert.equal(report.gates.find((gate) => gate.name === 'historical_replay_beats_live_discovery').status, 'failed');
});

test('idea-catalyst replay primitive evaluators expose release-gate evidence', () => {
  const packet = candidatePacket();
  const caseInput = passingBenchmark().cases[0];

  assert.equal(evaluateMustCiteRecall(packet, caseInput, { cutoffs: [1, 2] }).metrics['recall@2'], 1);
  assert.equal(evaluateClaimGrounding(packet, caseInput).f1, 1);
  assert.equal(evaluateStorylineTraceability(packet).trace_coverage, 1);
  assert.equal(evaluateTemporalCutoff(packet, caseInput).future_leakage_count, 0);
});

test('storyline traceability only counts claim, challenge, takeaway, or review-concern refs', () => {
  const packet = {
    storyline_dag: {
      beats: [
        { beat_id: 'beat:paper-only', trace_refs: [{ kind: 'paper', id: 'paper:1' }] },
        { beat_id: 'beat:claim', trace_refs: [{ kind: 'claim', id: 'claim:1' }] }
      ],
      edges: [],
      unsupported_beats: []
    }
  };

  const traceability = evaluateStorylineTraceability(packet);
  assert.equal(traceability.beat_count, 2);
  assert.equal(traceability.traceable_beat_count, 1);
  assert.equal(traceability.trace_coverage, 0.5);
});

test('idea-catalyst replay reads nested graph link-prediction bridge rerank signals', () => {
  const packet = {
    graph_link_prediction: {
      predicted_bridge_edges: [{
        source_id: 'challenge:grounding',
        target_id: 'method:bridge',
        predicted_edge_type: 'ADAPTS_METHOD',
        score: 0.92,
        rank: 1
      }]
    }
  };
  const caseInput = {
    gold: {
      bridge_edges: [{
        source_id: 'challenge:grounding',
        target_id: 'method:bridge',
        edge_type: 'ADAPTS_METHOD'
      }]
    }
  };

  const metrics = evaluateBridgeRerankSignal(packet, caseInput, { cutoffs: [1] });

  assert.equal(metrics.evaluated, true);
  assert.equal(metrics.metrics['recall@1'], 1);
});

test('idea-catalyst historical replay CLI writes comparable benchmark artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-idea-catalyst-replay-cli-'));

  try {
    const datasetPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(datasetPath, `${JSON.stringify(passingBenchmark(), null, 2)}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/run-idea-catalyst-historical-replay.mjs'),
      '--dataset-path', datasetPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-mini-replay',
      '--cutoffs', '1,2',
      '--primary-cutoff', '2',
      '--thresholds-json', '{"mustCiteRecallAtK":1,"noveltyImprovement":0.1,"historicalReplayImprovement":0.05}'
    ], {
      cwd: process.cwd()
    });

    const report = JSON.parse(stdout);
    assert.equal(report.runId, 'cli-mini-replay');
    assert.equal(report.status, 'passed');
    assert.equal(report.artifacts.outputDir, outputDir);
    assert.ok(await fileExists(path.join(outputDir, 'report.json')));
    assert.ok(await fileExists(path.join(outputDir, 'summary.tsv')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
