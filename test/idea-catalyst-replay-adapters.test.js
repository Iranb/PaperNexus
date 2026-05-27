import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  adaptIdeaCatalystReplayBenchmark,
  IDEA_CATALYST_REPLAY_ADAPTER_VERSION,
  normalizeReplayAdapterFormat
} from '../src/core/eval/replay-adapters.js';
import { runIdeaCatalystHistoricalReplay } from '../src/core/eval/historical-replay.js';

const execFileAsync = promisify(execFile);

function traceableStoryline() {
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
      future_leakage_count: 0,
      reasons: ['candidate aligns with adapted gold labels']
    },
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'The proposed bridge improves grounding.',
      source_span_ids: ['span:1']
    }],
    storyline_dag: traceableStoryline()
  };
}

function baselinePacket() {
  return {
    evidence_status: 'weak_evidence',
    must_cite_set: [{ title: 'Anchor Method', doi: '10.1000/anchor', year: 2020 }],
    novelty_certificate: {
      novelty: 0.4,
      significance: 0.4,
      feasibility: 0.4,
      grounding: 0.2,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: ['baseline is intentionally weaker']
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

test('replay adapters normalize MasterSet-style cases into replay-ready must-cite gold labels', async () => {
  const replay = adaptIdeaCatalystReplayBenchmark({
    name: 'masterset-mini',
    format: 'master_set',
    cases: [{
      id: 'case:masterset',
      year: 2025,
      must_cite_set: [
        { title: 'Anchor Method', doi: '10.1000/anchor' },
        { title: 'Prior Challenge', doi: '10.1000/challenge' }
      ],
      novelty_score: 0.9,
      impact: 0.8,
      correctness: 0.8,
      coverage: 1,
      claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }]
    }]
  }, {
    candidatePackets: { 'case:masterset': candidatePacket() },
    baselinePackets: { 'case:masterset': baselinePacket() }
  });

  assert.equal(replay.adapter_contract_version, IDEA_CATALYST_REPLAY_ADAPTER_VERSION);
  assert.equal(replay.format, 'masterset');
  assert.equal(replay.cases[0].timeCutoff, 2024);
  assert.equal(replay.cases[0].gold.must_cite_set.length, 2);
  assert.equal(replay.adapter_diagnostics.missing_candidate_packet_count, 0);

  const report = await runIdeaCatalystHistoricalReplay({
    benchmark: replay,
    cutoffs: [1, 2],
    primaryCutoff: 2,
    thresholds: {
      mustCiteRecallAtK: 1,
      noveltyImprovement: 0,
      claimGroundingF1: 1,
      historicalReplayImprovement: 0
    }
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.metrics.must_cite_recall_at_k, 1);
});

test('replay adapters normalize NovBench-style score scales and CLAIMCHECK-style claim rows', () => {
  const noveltyReplay = adaptIdeaCatalystReplayBenchmark({
    name: 'novbench-mini',
    format: 'nov_bench',
    items: [{
      id: 'nov:1',
      novelty_score: 4,
      correctness: 80,
      coverage: 0.9,
      candidate: candidatePacket(),
      baseline: baselinePacket()
    }]
  });
  assert.equal(noveltyReplay.format, 'novbench');
  assert.equal(noveltyReplay.cases[0].gold.novelty_certificate.novelty, 0.8);
  assert.equal(noveltyReplay.cases[0].gold.novelty_certificate.feasibility, 0.8);
  assert.equal(noveltyReplay.cases[0].gold.novelty_certificate.grounding, 0.9);

  const claimReplay = adaptIdeaCatalystReplayBenchmark({
    name: 'claimcheck-mini',
    format: 'claim_check',
    claims: [{
      id: 'claim-row:1',
      claim: 'The method is unsupported by the cited paper.',
      verdict: 'unsupported',
      candidate: candidatePacket(),
      baseline: baselinePacket()
    }]
  });
  assert.equal(claimReplay.format, 'claimcheck');
  assert.equal(claimReplay.cases[0].gold.claims[0].claim_id, 'claim-row:1');
  assert.equal(claimReplay.cases[0].gold.claims[0].label, 'unsupported');
  assert.equal(normalizeReplayAdapterFormat('Re²'), 're2');
});

test('prepare replay dataset CLI writes adapter-normalized replay JSON', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-adapter-'));
  try {
    const inputPath = path.join(tempRoot, 'raw.json');
    const outputPath = path.join(tempRoot, 'replay.json');
    const candidatePacketsPath = path.join(tempRoot, 'candidate-packets.json');
    const baselinePacketsPath = path.join(tempRoot, 'baseline-packets.json');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'openreview-mini',
      submissions: [{
        id: 'submission:1',
        venue: 'MiniConf',
        submission_year: 2025,
        decision: 'accept',
        references: [{ title: 'Anchor Method', doi: '10.1000/anchor' }],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }]
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketsPath, JSON.stringify({ 'submission:1': candidatePacket() }), 'utf8');
    await fs.writeFile(baselinePacketsPath, JSON.stringify({ 'submission:1': baselinePacket() }), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-idea-catalyst-replay-dataset.mjs'),
      '--input-path', inputPath,
      '--output-path', outputPath,
      '--format', 'openreview',
      '--candidate-packets-path', candidatePacketsPath,
      '--baseline-packets-path', baselinePacketsPath,
      '--dataset-source', 'OpenReview snapshot 2026-05-27',
      '--license-scope', 'research evaluation'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.format, 'openreview');
    assert.equal(summary.case_count, 1);
    assert.equal(summary.input_count, 3);
    assert.equal(summary.input_hash_count, 3);

    const replay = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(replay.format, 'openreview');
    assert.equal(replay.dataset_source, 'OpenReview snapshot 2026-05-27');
    assert.equal(replay.license_scope, 'research evaluation');
    assert.equal(replay.provenance.dataset_source, 'OpenReview snapshot 2026-05-27');
    assert.equal(replay.provenance.license_scope, 'research evaluation');
    assert.equal(replay.inputs.length, 3);
    assert.deepEqual(replay.inputs.map((entry) => entry.role).sort(), [
      'baseline_packet_map',
      'candidate_packet_map',
      'raw_dataset'
    ]);
    assert.equal(replay.inputs.every((entry) => entry.sha256 && entry.path && entry.size_bytes > 0), true);
    assert.equal(replay.cases[0].timeCutoff, 2024);
    assert.equal(replay.cases[0].source_metadata.venue, 'MiniConf');
    assert.equal(replay.cases[0].gold.must_cite_set[0].doi, '10.1000/anchor');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
