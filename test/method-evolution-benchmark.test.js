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

async function loadSmallBenchmarkFixture() {
  const fixtureUrl = new URL('./fixtures/method-evolution-benchmark-v1-small.json', import.meta.url);
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

function addAcceptedMethodEdge(graph, sourceId, targetId, type, properties = {}) {
  graph.addRelationship({
    id: properties.id || `rel:${sourceId}:${targetId}`,
    sourceId,
    targetId,
    type,
    properties: {
      methodEvolution: true,
      validationStatus: 'accepted',
      candidateId: properties.candidateId || `candidate:${sourceId}:${targetId}`,
      exactQuote: properties.exactQuote || `${sourceId} connects to ${targetId}.`,
      exactMatch: properties.exactMatch ?? true,
      confidence: properties.confidence ?? 0.9,
      bottleneckDimension: properties.bottleneckDimension || 'general',
      mechanismDescription: properties.mechanismDescription || 'uses a validated method-evolution mechanism',
      tradeoffDescription: properties.tradeoffDescription || 'adds computational or modeling tradeoffs',
      evidenceCompletenessStatus: properties.evidenceCompletenessStatus || 'complete',
      ...properties
    }
  });
}

function createSmallBenchmarkPredictionGraph() {
  const graph = createKnowledgeGraph();
  addMethod(graph, 'method:tfidf', 'TF-IDF Retrieval', ['term frequency inverse document frequency retrieval']);
  addMethod(graph, 'method:bm25', 'BM25', ['Okapi BM25']);
  addMethod(graph, 'method:bert', 'BERT', ['Bidirectional Encoder Representations from Transformers']);
  addMethod(graph, 'method:dpr', 'Dense Passage Retrieval', ['DPR']);
  addMethod(graph, 'method:rag', 'Retrieval-Augmented Generation', ['RAG']);
  addMethod(graph, 'method:colbert', 'ColBERT', ['Contextualized Late Interaction over BERT']);
  addMethod(graph, 'method:rerank', 'Cross-Encoder Reranking', ['cross encoder reranker']);
  addMethod(graph, 'method:hybrid', 'Hybrid Sparse-Dense Retrieval', ['hybrid retrieval']);
  addMethod(graph, 'method:realm', 'REALM', ['Retrieval-Augmented Language Model Pre-Training']);
  addMethod(graph, 'method:atlas', 'Atlas', ['few-shot learning with retrieval augmented language models']);
  addMethod(graph, 'method:replug', 'REPLUG', ['retrieval plugged language model']);

  addAcceptedMethodEdge(graph, 'method:bm25', 'method:tfidf', EDGE_TYPES.IMPROVES_METHOD, {
    bottleneckDimension: 'lexical-matching'
  });
  addAcceptedMethodEdge(graph, 'method:dpr', 'method:bert', EDGE_TYPES.USES_COMPONENT_METHOD, {
    bottleneckDimension: 'semantic-matching'
  });
  addAcceptedMethodEdge(graph, 'method:rag', 'method:dpr', EDGE_TYPES.USES_COMPONENT_METHOD, {
    bottleneckDimension: 'knowledge-grounding'
  });
  addAcceptedMethodEdge(graph, 'method:colbert', 'method:bert', EDGE_TYPES.ADAPTS_METHOD, {
    bottleneckDimension: 'token-interaction'
  });
  addAcceptedMethodEdge(graph, 'method:rerank', 'method:bert', EDGE_TYPES.USES_COMPONENT_METHOD, {
    bottleneckDimension: 'ranking-quality'
  });
  addAcceptedMethodEdge(graph, 'method:hybrid', 'method:bm25', EDGE_TYPES.ADAPTS_METHOD, {
    bottleneckDimension: 'lexical-semantic-recall'
  });
  addAcceptedMethodEdge(graph, 'method:hybrid', 'method:dpr', EDGE_TYPES.ADAPTS_METHOD, {
    bottleneckDimension: 'lexical-semantic-recall'
  });
  addAcceptedMethodEdge(graph, 'method:realm', 'method:bert', EDGE_TYPES.ADAPTS_METHOD, {
    bottleneckDimension: 'parametric-memory'
  });
  addAcceptedMethodEdge(graph, 'method:atlas', 'method:rag', EDGE_TYPES.EXTENDS_METHOD, {
    bottleneckDimension: 'few-shot-knowledge'
  });
  addAcceptedMethodEdge(graph, 'method:replug', 'method:rag', EDGE_TYPES.ADAPTS_METHOD, {
    bottleneckDimension: 'black-box-lm'
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

test('small method-evolution fixture reports NMR, ERR, PSC, NR, ER, and CAS', async () => {
  const benchmark = await loadSmallBenchmarkFixture();
  const graph = createSmallBenchmarkPredictionGraph();
  const result = evaluateMethodEvolutionBenchmark(graph, benchmark);

  assert.equal(result.benchmarkVersion, 'method-evolution-benchmark-v1');
  assert.equal(result.diagnostics.goldNodeCount, 12);
  assert.equal(result.diagnostics.goldEdgeCount, 11);
  assert.equal(result.diagnostics.goldChainCount, 4);
  assert.equal(result.metrics.nmr.value, result.metrics.nodeMatchRatio.value);
  assert.equal(result.metrics.err.value, result.metrics.edgeReachableRatio.value);
  assert.equal(result.metrics.psc.value, result.metrics.pathSemanticCorrectness.value);
  assert.equal(result.metrics.nr.value, result.metrics.nodeMatchRatio.value);
  assert.equal(result.metrics.er.value, result.metrics.edgeReachableRatio.value);
  assert.equal(result.metrics.cas.status, 'ok');
  assert.equal(result.metrics.nmr.value, 0.9167);
  assert.equal(result.metrics.err.value, 0.9091);
  assert.equal(result.metrics.psc.value, 1);
  assert.equal(result.metrics.nr.value, 0.9167);
  assert.equal(result.metrics.er.value, 0.9091);
  assert.equal(result.metrics.cas.value, 1);

  const ambiguousEdge = result.edgeMatches.find((entry) => entry.sourceGoldId === 'g:ambiguous');
  assert.equal(ambiguousEdge.endpointsMatched, false);
  assert.equal(ambiguousEdge.reachable, false);
});
