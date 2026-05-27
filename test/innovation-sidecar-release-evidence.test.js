import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInnovationSidecarReleaseEvidenceReport,
  INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION,
  prepareInnovationSidecarReleaseEvidence
} from '../src/core/eval/innovation-sidecar-release-evidence.js';
import { MODEL_ASSISTED_INNOVATION_VERSION } from '../src/core/graph/model-assisted-innovation.js';
import { COUNTERFACTUAL_SEARCH_CONTRACT_VERSION } from '../src/core/graph/counterfactual-search.js';
import { prepareInnovationSidecarReleaseEvidenceCli } from '../scripts/prepare-innovation-sidecar-release-evidence.mjs';

function modelAssistedReport(overrides = {}) {
  return {
    contractVersion: MODEL_ASSISTED_INNOVATION_VERSION,
    runId: 'model-assisted-calibration-release',
    status: 'passed',
    mode: 'calibrated',
    model_id: 'model-assisted-novelty-judge-v1',
    prompt_version: 'innovation-calibration-prompt-v1',
    calibration_dataset: 'novbench-rinobench-claim-openreview-style-gold-2026-05',
    calibration_run_id: 'calibration-run-2026-05',
    evaluation_dataset: 'novbench-rinobench-claim-openreview-style-holdout-2026-05',
    evaluation_run_id: 'holdout-eval-run-2026-05',
    holdout_policy: 'venue/year holdout with no calibration-label overlap',
    calibration_split: 'calibration',
    evaluation_split: 'holdout',
    overlap_count: 0,
    label_count: 240,
    benchmark_families: ['novbench', 'rinobench', 'claim-bench', 'claimcheck', 'openreview', 'peerread', 'moprd', 're2'],
    dataset: {
      name: 'NovBench RINoBench CLAIM-BENCH CLAIMCHECK OpenReview-style calibration set',
      format: 'novbench-rinobench-claim-openreview-style',
      source: 'https://benchmarks.papernexus.org/model-assisted-calibration/2026-05',
      license_scope: 'public benchmark research use'
    },
    inputs: [{
      role: 'calibration_dataset',
      path: '/benchmarks/model-assisted-calibration.jsonl',
      sha256: 'sha-model-assisted-calibration'
    }, {
      role: 'evaluation_dataset',
      path: '/benchmarks/model-assisted-holdout-evaluation.jsonl',
      sha256: 'sha-model-assisted-holdout-evaluation'
    }],
    gates: [
      { name: 'model_calibration_complete', status: 'passed', ok: true },
      { name: 'benchmark_metrics_passed', status: 'passed', ok: true }
    ],
    metrics: {
      novelty_auc: 0.82,
      claim_f1: 0.76,
      reviewer_agreement: 0.71
    },
    ...overrides
  };
}

function counterfactualReport(overrides = {}) {
  return {
    contractVersion: COUNTERFACTUAL_SEARCH_CONTRACT_VERSION,
    runId: 'counterfactual-usefulness-release',
    status: 'passed',
    search_mode: 'tot_model_assisted',
    backend: 'llm-provider-tree-of-thought',
    candidate_count: 48,
    selected_plan_count: 12,
    usefulness_label_count: 80,
    usefulness_score: 0.64,
    dataset: {
      name: 'OpenReview counterfactual failure discovery labels',
      format: 'openreview-counterfactual-usefulness',
      source: 'https://benchmarks.papernexus.org/counterfactual-usefulness/2026-05',
      license_scope: 'public benchmark research use'
    },
    inputs: [{
      role: 'counterfactual_candidates',
      path: '/benchmarks/counterfactual-candidates.jsonl',
      sha256: 'sha-counterfactual-candidates'
    }, {
      role: 'selected_plans',
      path: '/benchmarks/counterfactual-selected-plans.jsonl',
      sha256: 'sha-counterfactual-selected-plans'
    }, {
      role: 'usefulness_labels',
      path: '/benchmarks/counterfactual-usefulness.jsonl',
      sha256: 'sha-counterfactual-usefulness'
    }],
    gates: [
      { name: 'counterfactual_usefulness', status: 'passed', ok: true }
    ],
    metrics: {
      usefulness_score: 0.64,
      failure_discovery_rate: 0.58
    },
    ...overrides
  };
}

function buildReport(options = {}) {
  return buildInnovationSidecarReleaseEvidenceReport({
    generatedAt: '2026-05-27T00:00:00.000Z',
    runId: 'innovation-sidecar-release',
    modelAssistedReport: modelAssistedReport(options.model || {}),
    counterfactualReport: counterfactualReport(options.counterfactual || {}),
    inputs: options.inputs || [
      { role: 'model_assisted_calibration_report', path: '/reports/model.json', sha256: 'sha-model-report' },
      { role: 'counterfactual_usefulness_report', path: '/reports/counterfactual.json', sha256: 'sha-counterfactual-report' }
    ]
  });
}

test('innovation sidecar release evidence passes with full R5/R6 records', () => {
  const report = buildReport();

  assert.equal(report.contractVersion, INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.requirements.map((entry) => entry.status), ['passed', 'passed']);
  assert.equal(report.requirements[0].evidence[0].dataset_source, 'https://benchmarks.papernexus.org/model-assisted-calibration/2026-05');
  assert.equal(report.requirements[0].evidence[0].evaluation_split, 'holdout');
  assert.deepEqual(report.requirements[0].evidence[0].missing_input_role_hashes, []);
  assert.equal(report.requirements[1].evidence[0].input_hash_count, 3);
  assert.deepEqual(report.requirements[1].evidence[0].missing_input_role_hashes, []);
});

test('innovation sidecar evidence requires model benchmark family coverage', () => {
  const report = buildReport({
    model: {
      benchmark_families: ['novbench', 'claim-bench', 'openreview'],
      dataset: {
        name: 'NovBench CLAIM-BENCH OpenReview calibration set',
        format: 'novbench-claim-openreview-style',
        source: 'https://benchmarks.papernexus.org/model-assisted-calibration/2026-05',
        license_scope: 'public benchmark research use'
      }
    }
  });

  const modelReq = report.requirements.find((entry) => entry.id === 'R5');
  assert.equal(report.status, 'incomplete');
  assert.equal(modelReq.status, 'incomplete');
  assert.match(modelReq.message, /missing model-assisted benchmark families: rinobench/);
});

test('innovation sidecar evidence requires model-assisted required gates', () => {
  const missingGates = buildReport({
    model: {
      gates: []
    }
  });
  const incompleteGate = buildReport({
    model: {
      gates: [
        { name: 'model_calibration_complete', status: 'passed', ok: true },
        { name: 'benchmark_metrics_passed', status: 'incomplete', ok: false }
      ]
    }
  });

  const missingReq = missingGates.requirements.find((entry) => entry.id === 'R5');
  const incompleteReq = incompleteGate.requirements.find((entry) => entry.id === 'R5');
  assert.equal(missingGates.status, 'incomplete');
  assert.equal(missingReq.status, 'incomplete');
  assert.match(missingReq.message, /missing required model-assisted gates/);
  assert.deepEqual(missingReq.evidence[0].missing_required_gates, ['model_calibration_complete', 'benchmark_metrics_passed']);
  assert.equal(incompleteGate.status, 'incomplete');
  assert.equal(incompleteReq.status, 'incomplete');
  assert.match(incompleteReq.message, /model-assisted gates are not passed/);
  assert.deepEqual(incompleteReq.evidence[0].incomplete_required_gates, ['benchmark_metrics_passed']);
});

test('innovation sidecar evidence requires calibration labels', () => {
  const report = buildReport({
    model: {
      label_count: 0
    }
  });

  const modelReq = report.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelReq.status, 'incomplete');
  assert.match(modelReq.message, /missing calibration dataset, run id, or labels/);
});

test('innovation sidecar evidence requires independent model-assisted holdout evaluation', () => {
  const missingHoldout = buildReport({
    model: {
      evaluation_dataset: '',
      evaluation_run_id: '',
      holdout_policy: ''
    }
  });
  const reusedCalibrationSplit = buildReport({
    model: {
      evaluation_dataset: 'novbench-rinobench-claim-openreview-style-gold-2026-05',
      calibration_split: 'same-split',
      evaluation_split: 'same-split',
      overlap_count: 0
    }
  });

  const missingReq = missingHoldout.requirements.find((entry) => entry.id === 'R5');
  const reusedReq = reusedCalibrationSplit.requirements.find((entry) => entry.id === 'R5');
  assert.equal(missingHoldout.status, 'incomplete');
  assert.equal(missingReq.status, 'incomplete');
  assert.match(missingReq.message, /independent evaluation\/holdout split/);
  assert.equal(reusedCalibrationSplit.status, 'incomplete');
  assert.equal(reusedReq.status, 'incomplete');
  assert.match(reusedReq.message, /independent evaluation\/holdout split/);
});

test('innovation sidecar evidence requires nested input hashes', () => {
  const report = buildReport({
    model: {
      inputs: [{ role: 'calibration_dataset', path: '/benchmarks/model-assisted-calibration.jsonl' }]
    }
  });

  const modelReq = report.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelReq.status, 'incomplete');
  assert.match(modelReq.message, /missing_input_hash/);
});

test('innovation sidecar evidence requires model-assisted role-specific input hashes', () => {
  const report = buildReport({
    model: {
      inputs: [{
        role: 'calibration_dataset',
        path: '/benchmarks/model-assisted-calibration.jsonl',
        sha256: 'sha-model-assisted-calibration'
      }]
    }
  });

  const modelReq = report.requirements.find((entry) => entry.id === 'R5');
  assert.equal(report.status, 'incomplete');
  assert.equal(modelReq.status, 'incomplete');
  assert.match(modelReq.message, /missing model-assisted role-specific input hashes: holdout_evaluation/);
  assert.deepEqual(modelReq.evidence[0].missing_input_role_hashes, ['holdout_evaluation']);
});

test('innovation sidecar evidence rejects bounded offline counterfactuals as R6 release evidence', () => {
  const report = buildReport({
    counterfactual: {
      search_mode: 'bounded_offline',
      backend: 'deterministic-local'
    }
  });

  const counterfactualReq = report.requirements.find((entry) => entry.id === 'R6');
  assert.equal(counterfactualReq.status, 'incomplete');
  assert.match(counterfactualReq.message, /not ToT\/model-assisted/);
});

test('innovation sidecar evidence requires counterfactual labels to cover selected plans', () => {
  const report = buildReport({
    counterfactual: {
      selected_plan_count: 12,
      usefulness_label_count: 3
    }
  });

  const counterfactualReq = report.requirements.find((entry) => entry.id === 'R6');
  assert.equal(report.status, 'incomplete');
  assert.equal(counterfactualReq.status, 'incomplete');
  assert.match(counterfactualReq.message, /labels do not cover selected plans/);
});

test('innovation sidecar evidence requires counterfactual required gates', () => {
  const missingGates = buildReport({
    counterfactual: {
      gates: []
    }
  });
  const incompleteGate = buildReport({
    counterfactual: {
      gates: [
        { name: 'counterfactual_usefulness', status: 'incomplete', ok: false }
      ]
    }
  });

  const missingReq = missingGates.requirements.find((entry) => entry.id === 'R6');
  const incompleteReq = incompleteGate.requirements.find((entry) => entry.id === 'R6');
  assert.equal(missingGates.status, 'incomplete');
  assert.equal(missingReq.status, 'incomplete');
  assert.match(missingReq.message, /missing required counterfactual gates/);
  assert.deepEqual(missingReq.evidence[0].missing_required_gates, ['counterfactual_usefulness']);
  assert.equal(incompleteGate.status, 'incomplete');
  assert.equal(incompleteReq.status, 'incomplete');
  assert.match(incompleteReq.message, /counterfactual gates are not passed/);
  assert.deepEqual(incompleteReq.evidence[0].incomplete_required_gates, ['counterfactual_usefulness']);
});

test('innovation sidecar evidence requires strong counterfactual usefulness and failure-discovery metrics', () => {
  const weakUsefulness = buildReport({
    counterfactual: {
      usefulness_score: 0.49,
      metrics: {
        usefulness_score: 0.49,
        failure_discovery_rate: 0.58
      }
    }
  });
  const missingUsefulness = buildReport({
    counterfactual: {
      usefulness_score: undefined,
      usefulnessScore: undefined,
      metrics: {
        failure_discovery_rate: 0.58
      }
    }
  });
  const missingFailureDiscovery = buildReport({
    counterfactual: {
      failure_discovery_rate: 0,
      metrics: {
        usefulness_score: 0.64,
        failure_discovery_rate: 0
      }
    }
  });

  const weakReq = weakUsefulness.requirements.find((entry) => entry.id === 'R6');
  const missingUsefulnessReq = missingUsefulness.requirements.find((entry) => entry.id === 'R6');
  const missingFailureReq = missingFailureDiscovery.requirements.find((entry) => entry.id === 'R6');
  assert.equal(weakUsefulness.status, 'incomplete');
  assert.equal(weakReq.status, 'incomplete');
  assert.match(weakReq.message, /usefulness score is missing or below 0\.5/);
  assert.equal(missingUsefulness.status, 'incomplete');
  assert.equal(missingUsefulnessReq.status, 'incomplete');
  assert.match(missingUsefulnessReq.message, /usefulness score is missing or below 0\.5/);
  assert.equal(missingFailureDiscovery.status, 'incomplete');
  assert.equal(missingFailureReq.status, 'incomplete');
  assert.match(missingFailureReq.message, /failure-discovery metric/);
});

test('innovation sidecar evidence requires counterfactual role-specific input hashes', () => {
  const report = buildReport({
    counterfactual: {
      inputs: [{
        role: 'usefulness_labels',
        path: '/benchmarks/counterfactual-usefulness.jsonl',
        sha256: 'sha-counterfactual-usefulness'
      }]
    }
  });

  const counterfactualReq = report.requirements.find((entry) => entry.id === 'R6');
  assert.equal(report.status, 'incomplete');
  assert.equal(counterfactualReq.status, 'incomplete');
  assert.match(counterfactualReq.message, /missing counterfactual role-specific input hashes/);
  assert.deepEqual(counterfactualReq.evidence[0].missing_input_role_hashes, ['counterfactual_candidates', 'selected_plans']);
});

test('innovation sidecar evidence rejects fixture provenance', () => {
  const report = buildReport({
    model: {
      dataset: {
        name: 'model calibration fixture',
        format: 'novbench-rinobench-claim-openreview-style',
        source: 'fixture',
        license_scope: 'unit test only'
      }
    }
  });

  const modelReq = report.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelReq.status, 'incomplete');
  assert.match(modelReq.message, /fixture_or_synthetic_evidence/);
});

test('innovation sidecar preparation writes JSON and markdown artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-sidecar-evidence-'));
  try {
    const modelPath = path.join(tempRoot, 'model.json');
    const counterfactualPath = path.join(tempRoot, 'counterfactual.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(modelPath, `${JSON.stringify(modelAssistedReport(), null, 2)}\n`);
    await fs.writeFile(counterfactualPath, `${JSON.stringify(counterfactualReport(), null, 2)}\n`);

    const report = await prepareInnovationSidecarReleaseEvidence({
      outputDir,
      runId: 'sidecar-write',
      modelAssistedPath: modelPath,
      counterfactualPath
    });

    assert.equal(report.status, 'passed');
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, 'innovation-sidecar-release-evidence.json'), 'utf8')).status, 'passed');
    assert.match(await fs.readFile(path.join(outputDir, 'innovation-sidecar-release-evidence.md'), 'utf8'), /Innovation Sidecar Release Evidence/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('innovation sidecar CLI help exposes R5/R6 flags', async () => {
  const result = await prepareInnovationSidecarReleaseEvidenceCli(['--help']);

  assert.match(result.help, /--model-assisted-report/);
  assert.match(result.help, /--counterfactual-report/);
  assert.match(result.help, /--require-passed/);
});
