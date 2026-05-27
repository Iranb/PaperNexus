import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildGraphLinkPredictionEvalReport,
  GRAPH_LINK_PREDICTION_EVAL_MANIFEST_VERSION,
  GRAPH_LINK_PREDICTION_EVAL_VERSION,
  writeGraphLinkPredictionEvalArtifacts
} from '../src/core/eval/graph-link-prediction-eval.js';
import { evaluateGraphLinkPredictionCli } from '../scripts/evaluate-graph-link-prediction.mjs';

function predictionsFixture() {
  return {
    contractVersion: 'papernexus-predicted-bridge-edges-v1',
    runId: 'predicted-edges-fixture',
    model: 'deterministic-heterogeneous-link-prediction',
    method: 'deterministic-heterogeneous-link-prediction-v1',
    timeCutoff: '2024',
    trainingSlice: '2020-2024',
    negativeSamplingPolicy: 'type_balanced_non_edges_v1',
    predicted_edges: [
      { source_id: 'challenge:bias', target_id: 'method:reflective-prompts', score: 0.98 },
      { source_id: 'challenge:bias', target_id: 'method:generic-feedback', score: 0.22 },
      { source_id: 'challenge:coverage', target_id: 'method:active-sampling', score: 0.86 },
      { source_id: 'challenge:coverage', target_id: 'method:random-sampling', score: 0.18 }
    ]
  };
}

function goldFixture() {
  return {
    metadata: {
      name: 'temporal-link-prediction-fixture',
      format: 'temporal-link-prediction',
      source: 'fixture',
      license_scope: 'test-only',
      time_cutoff: '2024',
      training_slice: '2020-2024',
      negative_sampling_policy: 'type_balanced_non_edges_v1'
    },
    heldout_positive_edges: [
      { id: 'p1', source_id: 'challenge:bias', target_id: 'method:reflective-prompts', observed_at: '2025-03-01' },
      { id: 'p2', source_id: 'challenge:coverage', target_id: 'method:active-sampling', observed_at: '2025-09-10' }
    ],
    negative_edges: [
      { id: 'n1', source_id: 'challenge:bias', target_id: 'method:generic-feedback', observed_at: '2025-03-01' },
      { id: 'n2', source_id: 'challenge:coverage', target_id: 'method:random-sampling', observed_at: '2025-09-10' }
    ]
  };
}

test('graph link-prediction eval defaults to incomplete fixture evidence', () => {
  const report = buildGraphLinkPredictionEvalReport({
    predictedBridgeEdges: predictionsFixture(),
    goldTemporalEdges: goldFixture(),
    runId: 'graph-link-prediction-eval-default',
    generatedAt: '2026-05-27T00:00:00.000Z'
  });

  assert.equal(report.contractVersion, GRAPH_LINK_PREDICTION_EVAL_VERSION);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.metrics.positive_edge_count, 2);
  assert.equal(report.metrics.hits_at_10, 1);
  assert.equal(report.metrics.mrr, 0.75);
  assert.equal(report.metrics.future_leakage_count, 0);
  assert.equal(report.gates.find((entry) => entry.name === 'release_provenance_complete').status, 'incomplete');
});

test('graph link-prediction eval can pass with non-fixture release provenance', () => {
  const report = buildGraphLinkPredictionEvalReport({
    predictedBridgeEdges: {
      ...predictionsFixture(),
      model: 'hgt-temporal-link-prediction',
      method: 'external-hgt-temporal-link-prediction',
      timeCutoff: '2024',
      trainingSlice: 'openalex-oag-2020-2024',
      negativeSamplingPolicy: 'type_balanced_non_edges_v1'
    },
    goldTemporalEdges: {
      ...goldFixture(),
      metadata: {
        name: 'OAG OpenAlex Internal KG Temporal Link Prediction 2026-05',
        format: 'temporal-link-prediction',
        source: 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05',
        license_scope: 'public benchmark research use',
        time_cutoff: '2024',
        training_slice: 'openalex-oag-2020-2024',
        negative_sampling_policy: 'type_balanced_non_edges_v1'
      }
    },
    runId: 'graph-link-prediction-eval-release',
    generatedAt: '2026-05-27T00:00:00.000Z',
    releaseEvidence: true,
    minHitsAt10: 1,
    minMrr: 0.5,
    minAucLikePairAccuracy: 1
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.releaseGate.reason, 'temporal_link_prediction_release_gates_passed');
  assert.equal(report.benchmark.source, 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05');
});

test('graph link-prediction eval fails when thresholds or temporal split fail', () => {
  const report = buildGraphLinkPredictionEvalReport({
    predictedBridgeEdges: {
      ...predictionsFixture(),
      predicted_edges: [
        { source_id: 'challenge:bias', target_id: 'method:generic-feedback', score: 0.99 },
        { source_id: 'challenge:bias', target_id: 'method:reflective-prompts', score: 0.1 }
      ]
    },
    goldTemporalEdges: {
      ...goldFixture(),
      heldout_positive_edges: [
        { id: 'p1', source_id: 'challenge:bias', target_id: 'method:reflective-prompts', observed_at: '2024-06-01' }
      ]
    },
    runId: 'graph-link-prediction-eval-failed',
    generatedAt: '2026-05-27T00:00:00.000Z',
    datasetSource: 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05',
    licenseScope: 'public benchmark research use',
    model: 'hgt-temporal-link-prediction',
    method: 'external-hgt-temporal-link-prediction',
    timeCutoff: '2024',
    trainingSlice: 'openalex-oag-2020-2024',
    negativeSamplingPolicy: 'type_balanced_non_edges_v1',
    releaseEvidence: true,
    minHitsAt10: 1,
    minMrr: 1,
    minAucLikePairAccuracy: 1
  });

  assert.equal(report.status, 'failed');
  assert.equal(report.metrics.future_leakage_count, 1);
  assert.equal(report.gates.find((entry) => entry.name === 'temporal_split_clean').status, 'failed');
  assert.equal(report.gates.find((entry) => entry.name === 'link_prediction_quality').status, 'failed');
});

test('graph link-prediction eval writer emits report, markdown, and manifest', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-link-prediction-eval-'));
  try {
    const predictionsPath = path.join(tempRoot, 'predicted-bridge-edges.json');
    const goldPath = path.join(tempRoot, 'gold-temporal-edges.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(predictionsPath, `${JSON.stringify(predictionsFixture(), null, 2)}\n`);
    await fs.writeFile(goldPath, `${JSON.stringify(goldFixture(), null, 2)}\n`);

    const result = await writeGraphLinkPredictionEvalArtifacts({
      predictedBridgeEdgesPath: predictionsPath,
      goldTemporalEdgesPath: goldPath,
      outputDir,
      runId: 'graph-link-prediction-eval-write'
    });

    assert.equal(result.manifest.contractVersion, GRAPH_LINK_PREDICTION_EVAL_MANIFEST_VERSION);
    assert.equal(result.report.status, 'incomplete');
    assert.equal(JSON.parse(await fs.readFile(result.manifest.artifacts.reportJsonPath, 'utf8')).runId, 'graph-link-prediction-eval-write');
    assert.match(await fs.readFile(result.manifest.artifacts.reportMarkdownPath, 'utf8'), /Graph Link Prediction Eval/);
    assert.equal(JSON.parse(await fs.readFile(result.manifest.artifacts.manifestPath, 'utf8')).contractVersion, GRAPH_LINK_PREDICTION_EVAL_MANIFEST_VERSION);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph link-prediction eval CLI supports release-evidence mode', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-link-prediction-eval-cli-'));
  try {
    const predictionsPath = path.join(tempRoot, 'predicted-bridge-edges.json');
    const goldPath = path.join(tempRoot, 'gold-temporal-edges.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(predictionsPath, `${JSON.stringify({
      ...predictionsFixture(),
      model: 'hgt-temporal-link-prediction',
      method: 'external-hgt-temporal-link-prediction'
    }, null, 2)}\n`);
    await fs.writeFile(goldPath, `${JSON.stringify({
      ...goldFixture(),
      metadata: {}
    }, null, 2)}\n`);

    const manifest = await evaluateGraphLinkPredictionCli([
      '--predicted-bridge-edges', predictionsPath,
      '--gold-temporal-edges', goldPath,
      '--output-dir', outputDir,
      '--run-id', 'graph-link-prediction-eval-cli',
      '--benchmark-name', 'OAG OpenAlex Internal KG Temporal Link Prediction 2026-05',
      '--benchmark-format', 'temporal-link-prediction',
      '--dataset-source', 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05',
      '--license-scope', 'public benchmark research use',
      '--model', 'hgt-temporal-link-prediction',
      '--method', 'external-hgt-temporal-link-prediction',
      '--time-cutoff', '2024',
      '--training-slice', 'openalex-oag-2020-2024',
      '--negative-sampling-policy', 'type_balanced_non_edges_v1',
      '--min-hits-at-10', '1',
      '--min-mrr', '0.5',
      '--min-auc-like-pair-accuracy', '1',
      '--release-evidence'
    ]);

    assert.equal(manifest.runId, 'graph-link-prediction-eval-cli');
    assert.equal(manifest.status, 'passed');
    assert.equal(JSON.parse(await fs.readFile(manifest.artifacts.reportJsonPath, 'utf8')).status, 'passed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
