import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  IDEA_CATALYST_REPLAY_SUITE_VERSION,
  runIdeaCatalystReplaySuite
} from '../src/core/eval/replay-suite.js';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

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
    storyline_dag: storyline()
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

function releaseStatistics(metrics = []) {
  return {
    tests: metrics.map((metric) => ({
      metric,
      test: 'paired bootstrap',
      sample_size: 25,
      effect_size: metric === 'unsupported_claim_rate_reduction' ? 0.2 : 0.12,
      p_value: 0.01,
      confidence_interval: { lower: 0.02, upper: 0.24 }
    }))
  };
}

function semanticNegativeCases() {
  return [
    { category: 'baseline_missing_citation' },
    { category: 'year_leakage' },
    { category: 'claim_evidence_swap' },
    { category: 'source_domain_mismatch' },
    { category: 'storyline_order_shuffle' },
    { category: 'terminology_only_novelty' },
    { category: 'contribution_result_decoupling' },
    { category: 'review_concern_false_resolution', multi_step_failure: true }
  ];
}

test('replay suite writes normalized replay, historical artifacts, manifest hashes, and passing gates', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-openreview.json');
    const candidatePacketsPath = path.join(tempRoot, 'candidate-packets.json');
    const baselinePacketsPath = path.join(tempRoot, 'baseline-packets.json');
    const thresholdsPath = path.join(tempRoot, 'thresholds.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'openreview-suite-mini',
      submissions: [{
        id: 'submission:1',
        venue: 'MiniConf',
        submission_year: 2025,
        references: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1,
        semantic_negative_cases: semanticNegativeCases()
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketsPath, JSON.stringify({ 'submission:1': candidatePacket() }), 'utf8');
    await fs.writeFile(baselinePacketsPath, JSON.stringify({ 'submission:1': baselinePacket() }), 'utf8');
    await fs.writeFile(thresholdsPath, JSON.stringify({
      mustCiteRecallAtK: 1,
      noveltyImprovement: 0,
      claimGroundingF1: 1,
      historicalReplayImprovement: 0
    }), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'openreview',
      runId: 'suite-pass',
      candidatePacketsPath,
      baselinePacketsPath,
      thresholds: JSON.parse(await fs.readFile(thresholdsPath, 'utf8')),
      thresholdsPath,
      cutoffs: [1, 2],
      primaryCutoff: 2,
      datasetSource: 'fixture://openreview-suite-mini',
      licenseScope: 'test-fixture'
    });

    assert.equal(manifest.contractVersion, IDEA_CATALYST_REPLAY_SUITE_VERSION);
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    assert.equal(manifest.releaseReadiness.releaseCandidate, false);
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'not_fixture_or_synthetic').status,
      'incomplete'
    );
    assert.deepEqual(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'target_evidence_family_ready').ready_families,
      ['historical_replay']
    );
    assert.equal(manifest.diagnostics.error_count, 0);
    assert.equal(manifest.gates.every((gate) => gate.status === 'passed'), true);
    assert.ok(await fileExists(manifest.artifacts.normalizedReplayPath));
    assert.ok(await fileExists(manifest.artifacts.historicalReportPath));
    assert.ok(await fileExists(manifest.artifacts.historicalSummaryTsvPath));
    assert.ok(await fileExists(manifest.artifacts.historicalManifestPath));
    assert.ok(await fileExists(manifest.artifacts.suiteManifestPath));

    const inputRecord = manifest.inputs.find((entry) => entry.role === 'raw_dataset');
    assert.equal(inputRecord.sha256, await sha256(inputPath));
    assert.equal(manifest.inputs.some((entry) => entry.role === 'candidate_packet_map'), true);
    assert.equal(manifest.inputs.some((entry) => entry.role === 'baseline_packet_map'), true);
    assert.equal(manifest.inputs.some((entry) => entry.role === 'thresholds'), true);

    const persisted = JSON.parse(await fs.readFile(manifest.artifacts.suiteManifestPath, 'utf8'));
    assert.equal(persisted.status, 'passed');
    assert.equal(persisted.releaseReadiness.status, 'incomplete');
    assert.equal(persisted.dataset.source, 'fixture://openreview-suite-mini');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite marks non-fixture passed benchmark artifacts ready for release gate', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-release-ready-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const statisticalEvidencePath = path.join(tempRoot, 'statistical-significance.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:release',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1,
        semantic_negative_cases: semanticNegativeCases()
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');
    await fs.writeFile(statisticalEvidencePath, JSON.stringify(releaseStatistics(['must_cite_recall_at_k_improvement'])), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-ready',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      statisticalEvidencePath,
      holdoutPolicy: {
        strategy: 'venue_year_holdout',
        heldout_venues: ['ReleaseConf'],
        heldout_years: [2025],
        train_venues: ['TrainConf'],
        train_years: [2020, 2021, 2022, 2023, 2024]
      },
      timeSlicePolicy: {
        strategy: 'strict_time_slice',
        cutoff_field: 'timeCutoff',
        sliced_sources: ['OpenAlex snapshot', 'S2ORC snapshot', 'reference graph']
      }
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'ready_for_release_gate');
    assert.equal(manifest.releaseReadiness.releaseCandidate, true);
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'strict_time_cutoffs_present').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'venue_year_holdout_present').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'time_slice_policy_present').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'release_grade_improvement_thresholds_present').status,
      'passed'
    );
    const semanticNegativeCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'semantic_negative_coverage_present');
    assert.equal(semanticNegativeCheck.status, 'passed');
    assert.deepEqual(semanticNegativeCheck.missing_categories, []);
    assert.equal(semanticNegativeCheck.multi_step_failure_count, 1);
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'statistical_significance_evidence_present').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'statistical_significance_provenance_auditable').status,
      'passed'
    );
    assert.equal(manifest.statistical_significance_provenance.source, 'statistical_significance_file');
    assert.equal(manifest.inputs.some((entry) => entry.role === 'statistical_significance' && entry.sha256), true);
    assert.deepEqual(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'target_evidence_family_ready').ready_families,
      ['must_cite']
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness for inline statistical evidence without hashed provenance', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-inline-statistics-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:inline-statistics',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1,
        semantic_negative_cases: semanticNegativeCases()
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-inline-statistics',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      statisticalSignificance: releaseStatistics(['must_cite_recall_at_k_improvement']),
      holdoutPolicy: {
        strategy: 'venue_year_holdout',
        heldout_venues: ['ReleaseConf'],
        heldout_years: [2025],
        train_venues: ['TrainConf'],
        train_years: [2020, 2021, 2022, 2023, 2024]
      },
      timeSlicePolicy: {
        strategy: 'strict_time_slice',
        cutoff_field: 'timeCutoff',
        sliced_sources: ['OpenAlex snapshot', 'S2ORC snapshot', 'reference graph']
      }
    });

    const significanceCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'statistical_significance_evidence_present');
    const provenanceCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'statistical_significance_provenance_auditable');
    assert.equal(manifest.status, 'passed');
    assert.equal(significanceCheck.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    assert.equal(provenanceCheck.status, 'incomplete');
    assert.equal(provenanceCheck.source, 'inline_parameter');
    assert.match(provenanceCheck.message, /inline statistical significance evidence/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness without statistical significance evidence', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-no-statistics-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:no-statistics',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-missing-statistics',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      holdoutPolicy: 'venue/year holdout: ReleaseConf 2025 held out',
      timeSlicePolicy: 'strict historical OpenAlex/S2ORC/reference snapshot cutoff'
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    const significanceCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'statistical_significance_evidence_present');
    assert.equal(significanceCheck.status, 'incomplete');
    assert.deepEqual(significanceCheck.missing, ['must_cite_recall_at_k_improvement']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness without semantic negative coverage', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-no-semantic-negatives-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:no-semantic-negatives',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1,
        semantic_negative_cases: [
          { category: 'baseline_missing_citation' },
          { category: 'year_leakage' }
        ]
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-missing-semantic-negatives',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      statisticalSignificance: releaseStatistics(['must_cite_recall_at_k_improvement']),
      holdoutPolicy: 'venue/year holdout: ReleaseConf 2025 held out',
      timeSlicePolicy: 'strict historical OpenAlex/S2ORC/reference snapshot cutoff'
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    const semanticNegativeCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'semantic_negative_coverage_present');
    assert.equal(semanticNegativeCheck.status, 'incomplete');
    assert.deepEqual(semanticNegativeCheck.covered_categories, ['baseline_missing_citation', 'year_leakage']);
    assert.ok(semanticNegativeCheck.missing_categories.includes('claim_evidence_swap'));
    assert.equal(semanticNegativeCheck.multi_step_failure_count, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness when release-grade improvement thresholds are not configured', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-no-release-thresholds-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:no-release-thresholds',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-missing-thresholds',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      holdoutPolicy: {
        strategy: 'venue_year_holdout',
        heldout_venues: ['ReleaseConf'],
        heldout_years: [2025]
      },
      timeSlicePolicy: {
        strategy: 'strict_time_slice',
        cutoff_field: 'timeCutoff',
        sliced_sources: ['OpenAlex snapshot', 'S2ORC snapshot', 'reference graph']
      }
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    const thresholdCheck = manifest.releaseReadiness.checks.find((entry) => entry.name === 'release_grade_improvement_thresholds_present');
    assert.equal(thresholdCheck.status, 'incomplete');
    assert.deepEqual(thresholdCheck.missing, ['must_cite_recall_at_k_improvement_gte_0_10']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness without venue/year holdout and time-slice policy', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-no-holdout-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:no-holdout',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-missing-holdout',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use'
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    assert.equal(manifest.releaseReadiness.releaseCandidate, false);
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'target_evidence_family_ready').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'strict_time_cutoffs_present').status,
      'passed'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'venue_year_holdout_present').status,
      'incomplete'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'time_slice_policy_present').status,
      'incomplete'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'release_grade_improvement_thresholds_present').status,
      'passed'
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite refuses release readiness when policies explicitly negate holdout or time slicing', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-negated-policy-'));
  try {
    const inputPath = path.join(tempRoot, 'raw-masterset.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'MasterSet 2026 frozen slice',
      cases: [{
        id: 'case:negated-policy',
        venue: 'ReleaseConf',
        year: 2025,
        must_cite_set: [
          { title: 'Anchor Method', doi: '10.1000/anchor' },
          { title: 'Prior Challenge', doi: '10.1000/challenge' }
        ],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1,
        semantic_negative_cases: semanticNegativeCases()
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const manifest = await runIdeaCatalystReplaySuite({
      inputPath,
      outputDir,
      format: 'masterset',
      runId: 'suite-release-negated-policy',
      candidatePacketPath,
      baselinePacketPath,
      thresholds: { mustCiteRecallAtK: 1, mustCiteRecallAtKImprovement: 0.1, claimGroundingF1: 1 },
      cutoffs: [5, 10, 20],
      primaryCutoff: 20,
      datasetSource: 'https://benchmarks.papernexus.org/masterset/2026-05',
      licenseScope: 'public benchmark research use',
      statisticalSignificance: releaseStatistics(['must_cite_recall_at_k_improvement']),
      holdoutPolicy: 'no venue/year holdout configured for this run',
      timeSlicePolicy: 'no time slice configured for OpenAlex/S2ORC/reference snapshots'
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseReadiness.status, 'incomplete');
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'venue_year_holdout_present').status,
      'incomplete'
    );
    assert.equal(
      manifest.releaseReadiness.checks.find((entry) => entry.name === 'time_slice_policy_present').status,
      'incomplete'
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite reports missing packets and gold labels as explicit diagnostics', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-missing-'));
  try {
    const outputDir = path.join(tempRoot, 'suite-output');
    const manifest = await runIdeaCatalystReplaySuite({
      input: {
        name: 'incomplete-mini',
        cases: [{ id: 'case:missing', title: 'Missing packet and label case' }]
      },
      outputDir,
      format: 'custom',
      runId: 'suite-incomplete'
    });

    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.diagnostics.error_count, 3);
    assert.deepEqual(
      manifest.diagnostics.messages.filter((entry) => entry.severity === 'error').map((entry) => entry.code),
      ['missing_candidate_packets', 'missing_baseline_packets', 'missing_gold_labels']
    );
    assert.equal(manifest.adapter.diagnostics.missing_candidate_packet_count, 1);
    assert.ok(await fileExists(manifest.artifacts.suiteManifestPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('replay suite CLI runs prepare and replay chain in one command', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-suite-cli-'));
  try {
    const inputPath = path.join(tempRoot, 'raw.json');
    const candidatePacketPath = path.join(tempRoot, 'candidate.json');
    const baselinePacketPath = path.join(tempRoot, 'baseline.json');
    const outputDir = path.join(tempRoot, 'suite-output');
    await fs.writeFile(inputPath, JSON.stringify({
      name: 'masterset-cli-mini',
      cases: [{
        id: 'case:cli',
        year: 2025,
        must_cite_set: [{ title: 'Anchor Method', doi: '10.1000/anchor' }],
        claims: [{ claim_id: 'claim:1', claim_text: 'The proposed bridge improves grounding.', label: 'supported' }],
        novelty_score: 0.9,
        impact: 0.8,
        correctness: 0.8,
        coverage: 1
      }]
    }), 'utf8');
    await fs.writeFile(candidatePacketPath, JSON.stringify(candidatePacket()), 'utf8');
    await fs.writeFile(baselinePacketPath, JSON.stringify(baselinePacket()), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/run-idea-catalyst-replay-suite.mjs'),
      '--input-path', inputPath,
      '--output-dir', outputDir,
      '--format', 'masterset',
      '--run-id', 'suite-cli',
      '--candidate-packet', candidatePacketPath,
      '--baseline-packet', baselinePacketPath,
      '--cutoffs', '1,2',
      '--primary-cutoff', '2',
      '--thresholds-json', JSON.stringify({ mustCiteRecallAtK: 1, claimGroundingF1: 1 })
    ]);
    const manifest = JSON.parse(stdout);
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.dataset.format, 'masterset');
    assert.ok(await fileExists(path.join(outputDir, 'normalized-replay.json')));
    assert.ok(await fileExists(path.join(outputDir, 'replay-suite-manifest.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
