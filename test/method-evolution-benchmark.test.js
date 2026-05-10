import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import {
  evaluateMethodEvolutionBenchmark,
  METHOD_EVOLUTION_BENCHMARK_EVALUATION_CONTRACT_VERSION
} from '../src/core/graph/method-evolution-benchmark.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';

async function loadMiniBenchmarkFixture() {
  const fixtureUrl = new URL('./fixtures/method-evolution-benchmark-v1-mini.json', import.meta.url);
  return JSON.parse(await fs.readFile(fixtureUrl, 'utf8'));
}

function addMethod(graph, id, name, aliases = []) {
  graph.addNode({
    id,
    type: NODE_TYPES.METHOD,
    name,
    properties: {
      aliases
    }
  });
}

function createBenchmarkPredictionGraph() {
  const graph = createKnowledgeGraph();
  addMethod(graph, 'method:clip', 'CLIP', ['Contrastive Language-Image Pre-training']);
  addMethod(graph, 'method:align', 'ALIGN', ['A Large-scale ImaGe and Noisy-text embedding']);
  addMethod(graph, 'method:flamingo', 'Flamingo', ['few-shot visual language model']);

  graph.addRelationship({
    id: 'rel:align-clip',
    sourceId: 'method:align',
    targetId: 'method:clip',
    type: EDGE_TYPES.IMPROVES_METHOD,
    properties: {
      methodEvolution: true,
      validationStatus: 'accepted',
      candidateId: 'candidate:align-clip',
      exactQuote: 'ALIGN scales image-text contrastive learning with noisy alt-text data.',
      exactMatch: true,
      confidence: 0.92,
      bottleneckDimension: 'data-efficiency',
      mechanismDescription: 'uses noisy web-scale image-text pairs',
      tradeoffDescription: 'requires much larger pretraining data',
      evidenceCompletenessStatus: 'complete'
    }
  });
  graph.addRelationship({
    id: 'rel:flamingo-align',
    sourceId: 'method:flamingo',
    targetId: 'method:align',
    type: EDGE_TYPES.ADAPTS_METHOD,
    properties: {
      methodEvolution: true,
      validationStatus: 'accepted',
      candidateId: 'candidate:flamingo-align',
      exactQuote: '',
      exactMatch: false,
      confidence: 0.82,
      bottleneckDimension: 'scalability',
      mechanismDescription: 'adds few-shot visual-language adaptation'
    }
  });

  return graph;
}

test('evaluateMethodEvolutionBenchmark scores gold nodes, edges, chains, and evidence gates', async () => {
  const benchmark = await loadMiniBenchmarkFixture();
  const graph = createBenchmarkPredictionGraph();
  const result = evaluateMethodEvolutionBenchmark(graph, benchmark);

  assert.equal(result.contractVersion, METHOD_EVOLUTION_BENCHMARK_EVALUATION_CONTRACT_VERSION);
  assert.equal(result.benchmarkVersion, 'method-evolution-benchmark-v1');
  assert.equal(result.metrics.nodeMatchRatio.value, 0.75);
  assert.equal(result.metrics.edgeReachableRatio.value, 1);
  assert.equal(result.metrics.pathSemanticCorrectness.value, 1);
  assert.equal(result.metrics.quoteValidationPassRate.value, 0.5);
  assert.equal(result.metrics.evidenceCompleteness.value, 0.5);
  assert.equal(result.metrics.aliasPrecision.status, 'not_evaluated');
  assert.equal(result.metrics.stubUtility.status, 'not_evaluated');
  assert.equal(result.diagnostics.queryTimeLlmCalls, 0);

  const directEdge = result.edgeMatches.find((entry) => (
    entry.sourceGoldId === 'g:align' && entry.targetGoldId === 'g:clip'
  ));
  assert.equal(directEdge.direct, true);
  assert.equal(directEdge.requiredBottleneckMatched, true);

  const reachableEdge = result.edgeMatches.find((entry) => (
    entry.sourceGoldId === 'g:flamingo' && entry.targetGoldId === 'g:clip'
  ));
  assert.equal(reachableEdge.direct, false);
  assert.equal(reachableEdge.reachable, true);
  assert.deepEqual(reachableEdge.path.map((edge) => edge.edgeId), ['rel:flamingo-align', 'rel:align-clip']);

  const unmatched = result.nodeMatches.find((entry) => entry.goldId === 'g:unmatched');
  assert.equal(unmatched.predictedMethodId, null);
});
