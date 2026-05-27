import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildBridgeRerankSignals,
  buildGraphLinkPredictionArtifacts,
  GRAPH_LINK_PREDICTION_MANIFEST_VERSION,
  PREDICTED_BRIDGE_EDGES_VERSION,
  writeGraphLinkPredictionArtifacts
} from '../src/core/index/graph-link-prediction.js';
import { prepareGraphLinkPredictionCli } from '../scripts/prepare-graph-link-prediction.mjs';

function graphFixture() {
  return {
    name: 'graph-link-prediction-fixture',
    graph: {
      nodes: [
        { id: 'domain:education', type: 'Domain', name: 'Education tutoring systems' },
        { id: 'challenge:bias', type: 'Challenge', name: 'Confirmation bias in tutoring feedback' },
        { id: 'method:reflective-prompts', type: 'Method', name: 'Reflective prompts for belief calibration' },
        { id: 'takeaway:metacontrol', type: 'Takeaway', name: 'Metacognitive control stabilizes belief updates' },
        { id: 'claim:bridge', type: 'ContributionClaim', name: 'Reflective prompts improve tutoring belief calibration' },
        { id: 'paper:psych', type: 'Paper', title: 'Belief Updating Under Uncertainty' }
      ],
      relationships: [
        { id: 'r1', sourceId: 'domain:education', targetId: 'challenge:bias', type: 'HAS_OPEN_CHALLENGE' },
        { id: 'r2', sourceId: 'method:reflective-prompts', targetId: 'takeaway:metacontrol', type: 'HAS_TAKEAWAY' },
        { id: 'r3', sourceId: 'paper:psych', targetId: 'method:reflective-prompts', type: 'USES' },
        { id: 'r4', sourceId: 'claim:bridge', targetId: 'challenge:bias', type: 'ADDRESSES' }
      ]
    }
  };
}

test('graph link prediction builds deterministic bridge edges and rerank signals', () => {
  const artifacts = buildGraphLinkPredictionArtifacts({
    input: graphFixture(),
    runId: 'graph-link-prediction-test',
    createdAt: '2026-05-26T00:00:00.000Z',
    topK: 5
  });

  assert.equal(artifacts.predictedBridgeEdges.contractVersion, PREDICTED_BRIDGE_EDGES_VERSION);
  assert.equal(artifacts.manifest.contractVersion, GRAPH_LINK_PREDICTION_MANIFEST_VERSION);
  assert.equal(artifacts.manifest.releaseGateStatus, 'incomplete');
  assert.equal(artifacts.manifest.releaseGate.reason, 'deterministic_placeholder_not_release_grade');
  assert.ok(artifacts.predictedBridgeEdges.predicted_edges.length > 0);
  assert.ok(artifacts.predictedBridgeEdges.predicted_edges.every((edge) => edge.online_use === 'rerank_signal_only'));
  assert.ok(artifacts.predictedBridgeEdges.predicted_edges.every((edge) => edge.predicted_edge_type === 'PREDICTED_BRIDGE'));
  assert.ok(artifacts.predictedBridgeEdges.predicted_edges.every((edge) => edge.evidence.shared_tokens || edge.evidence.common_neighbor_ids));
  assert.equal(artifacts.bridgeRerankSignals.contractVersion, 'papernexus-bridge-rerank-signals-v1');
  assert.equal(artifacts.bridgeRerankSignals.signalCount, artifacts.predictedBridgeEdges.predicted_edges.length);
});

test('external GNN provenance is tracked without treating fixtures as release pass', () => {
  const artifacts = buildGraphLinkPredictionArtifacts({
    input: graphFixture(),
    runId: 'external-link-prediction-test',
    createdAt: '2026-05-26T00:00:00.000Z',
    model: 'hgt-link-prediction-fixture',
    method: 'external-gnn-link-prediction',
    datasetSource: 'internal KG temporal slice fixture',
    licenseScope: 'test-only',
    trainingSlice: '2020-2025-train',
    timeCutoff: '2025',
    negativeSamplingPolicy: 'type_balanced_non_edges_v1',
    predictionSourcePayload: {
      predicted_edges: [{
        source_id: 'challenge:bias',
        target_id: 'method:reflective-prompts',
        predicted_edge_type: 'ADAPTS_METHOD',
        score: 0.91,
        evidence: { model_rank: 1 }
      }]
    }
  });

  assert.equal(artifacts.manifest.releaseGateStatus, 'ready_for_evaluation');
  assert.match(artifacts.manifest.releaseGate.notes[0], /Run OAG\/OpenAlex\/internal-KG temporal link-prediction gates/);
  assert.equal(artifacts.predictedBridgeEdges.predicted_edges[0].predicted_edge_type, 'ADAPTS_METHOD');
  assert.equal(artifacts.predictedBridgeEdges.predicted_edges[0].score, 0.91);
  assert.equal(artifacts.predictedBridgeEdges.negativeSamplingPolicy, 'type_balanced_non_edges_v1');
});

test('bridge rerank signal loader exposes pair-keyed scores for main graph paths', () => {
  const payload = {
    contractVersion: PREDICTED_BRIDGE_EDGES_VERSION,
    predicted_edges: [{
      prediction_id: 'predicted_bridge:1',
      source_id: 'challenge:bias',
      target_id: 'method:reflective-prompts',
      score: 0.88,
      rank: 1
    }]
  };
  const signals = buildBridgeRerankSignals(payload);
  assert.equal(signals.signalCount, 1);
  assert.equal(signals.byPair['challenge:bias->method:reflective-prompts'].score, 0.88);
  assert.equal(signals.byPair['challenge:bias->method:reflective-prompts'].online_use, 'rerank_signal_only');
});

test('graph link prediction CLI writes predicted edges, rerank signals, and manifest', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-link-prediction-'));
  try {
    const graphPath = path.join(tempRoot, 'graph.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(graphPath, `${JSON.stringify(graphFixture(), null, 2)}\n`);

    const manifest = await prepareGraphLinkPredictionCli([
      '--graph-path', graphPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-graph-link-prediction-test',
      '--top-k', '3'
    ]);

    assert.equal(manifest.runId, 'cli-graph-link-prediction-test');
    assert.equal(manifest.topK, 3);
    assert.equal(manifest.releaseGateStatus, 'incomplete');
    const predicted = JSON.parse(await fs.readFile(manifest.artifacts.predictedBridgeEdgesPath, 'utf8'));
    const signals = JSON.parse(await fs.readFile(manifest.artifacts.bridgeRerankSignalsPath, 'utf8'));
    const manifestOnDisk = JSON.parse(await fs.readFile(manifest.artifacts.manifestPath, 'utf8'));
    assert.equal(predicted.contractVersion, PREDICTED_BRIDGE_EDGES_VERSION);
    assert.ok(predicted.predicted_edges.length <= 3);
    assert.equal(signals.signalCount, predicted.predicted_edges.length);
    assert.equal(manifestOnDisk.contractVersion, GRAPH_LINK_PREDICTION_MANIFEST_VERSION);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph link prediction artifact writer records release metadata paths', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-link-prediction-write-'));
  try {
    const graphPath = path.join(tempRoot, 'graph.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(graphPath, `${JSON.stringify(graphFixture(), null, 2)}\n`);
    const result = await writeGraphLinkPredictionArtifacts({
      inputPath: graphPath,
      outputDir,
      runId: 'writer-graph-link-prediction-test',
      topK: 2
    });

    assert.equal(result.manifest.artifacts.predictedBridgeEdgesPath.endsWith('predicted-bridge-edges.json'), true);
    assert.equal(result.manifest.artifacts.bridgeRerankSignalsPath.endsWith('bridge-rerank-signals.json'), true);
    assert.equal(result.manifest.artifacts.manifestPath.endsWith('manifest.json'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
