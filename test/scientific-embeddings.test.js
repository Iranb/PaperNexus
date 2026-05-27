import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runRetrievalBenchmark } from '../src/core/benchmarks/retrieval.js';
import {
  buildScientificEmbeddingArtifacts,
  FIXED_CORPUS_DENSE_SCORES_VERSION,
  SCIENTIFIC_EMBEDDING_INDEX_VERSION,
  SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION,
  tokenizeScientificText,
  writeScientificEmbeddingArtifacts
} from '../src/core/index/scientific-embeddings.js';
import { prepareScientificEmbeddingsCli } from '../scripts/prepare-scientific-embeddings.mjs';

function benchmarkFixture() {
  return {
    name: 'scientific-embedding-fixture',
    format: 'custom',
    corpusSize: 3,
    corpus: [
      {
        id: 'd1',
        title: 'Graph neural retrieval for scientific literature review',
        abstract: 'Graph neural retrieval improves literature review and GraphRAG evidence ranking.'
      },
      {
        id: 'd2',
        title: 'Protein folding diffusion models',
        abstract: 'Diffusion models support protein structure prediction and molecular folding.'
      },
      {
        id: 'd3',
        title: 'Compiler optimization for vectorized kernels',
        abstract: 'Compiler passes improve vectorized numerical kernels and memory locality.'
      }
    ],
    queryCount: 1,
    queries: [{
      id: 'q1',
      query: 'graph neural retrieval literature review',
      relevant: [{ id: 'd1', title: 'Graph neural retrieval for scientific literature review' }]
    }]
  };
}

test('scientific tokenization keeps scientific bigrams and strips filler', () => {
  const tokens = tokenizeScientificText('We study Graph Neural Retrieval for scientific literature reviews.');
  assert.ok(tokens.includes('graph'));
  assert.ok(tokens.includes('neural'));
  assert.ok(tokens.includes('graph_neural'));
  assert.equal(tokens.includes('the'), false);
});

test('scientific embeddings produce deterministic fixed-corpus dense artifacts', () => {
  const options = {
    input: benchmarkFixture(),
    runId: 'scientific-embedding-test',
    createdAt: '2026-05-26T00:00:00.000Z',
    dimension: 256,
    topK: 3
  };
  const first = buildScientificEmbeddingArtifacts(options);
  const second = buildScientificEmbeddingArtifacts(options);

  assert.equal(first.denseScores.contractVersion, FIXED_CORPUS_DENSE_SCORES_VERSION);
  assert.equal(first.embeddingIndex.contractVersion, SCIENTIFIC_EMBEDDING_INDEX_VERSION);
  assert.equal(first.manifest.contractVersion, SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION);
  assert.deepEqual(first.denseScores, second.denseScores);
  assert.deepEqual(first.embeddingIndex.documents[0].embedding, second.embeddingIndex.documents[0].embedding);
  assert.equal(first.denseScores.queries[0].rankings[0].documentId, 'd1');
  assert.equal(first.embeddingIndex.dimension, 256);
  assert.equal(first.embeddingIndex.documents[0].embedding.length, 256);
  assert.equal(first.manifest.releaseGateStatus, 'incomplete');
  assert.equal(first.manifest.releaseGate.reason, 'deterministic_placeholder_not_release_grade');
});

test('scientific dense artifact can drive fixed-corpus retrieval benchmark', async () => {
  const benchmark = benchmarkFixture();
  const artifacts = buildScientificEmbeddingArtifacts({
    input: benchmark,
    runId: 'scientific-embedding-retrieval-test',
    createdAt: '2026-05-26T00:00:00.000Z',
    dimension: 256,
    topK: 3
  });

  const report = await runRetrievalBenchmark({
    benchmark,
    evaluationMode: 'fixed-corpus',
    fixedCorpusRetrievalMode: 'dense',
    fixedCorpusDenseScorePayload: artifacts.denseScores,
    maxCandidates: 1,
    cutoffs: [1]
  });

  assert.equal(report.config.fixedCorpusRetrievalMode, 'dense');
  assert.equal(report.config.fixedCorpusDenseScoresLoadedQueries, 1);
  assert.equal(report.diagnostics.fixedCorpusDenseIndex.resolvedScoreCount, 3);
  assert.equal(report.metrics['hit@1'], 1);
  assert.equal(report.results[0].topMatches[0].title, 'Graph neural retrieval for scientific literature review');
});

test('external embedding provenance is tracked without treating fixtures as SPECTER2 evidence', () => {
  const artifacts = buildScientificEmbeddingArtifacts({
    input: benchmarkFixture(),
    runId: 'external-embedding-test',
    createdAt: '2026-05-26T00:00:00.000Z',
    dimension: 2,
    topK: 2,
    model: 'specter2-sidecar-fixture',
    method: 'external-scientific-embedding-vectors',
    datasetSource: 'local SciRepEval-style fixture',
    licenseScope: 'test-only',
    embeddingSourcePayload: {
      documents: [
        { documentId: 'd1', embedding: [1, 0] },
        { documentId: 'd2', embedding: [0, 1] },
        { documentId: 'd3', embedding: [0.5, 0.5] }
      ],
      queries: [
        { queryId: 'q1', embedding: [0, 1] }
      ]
    }
  });

  assert.equal(artifacts.denseScores.queries[0].rankings[0].documentId, 'd2');
  assert.equal(artifacts.manifest.releaseGateStatus, 'ready_for_evaluation');
  assert.match(artifacts.manifest.releaseGate.notes[0], /Run SciRepEval\/OAG\/GraphRAG-style retrieval gates/);
});

test('scientific embedding CLI writes dense scores, vector index, and manifest', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scientific-embeddings-'));
  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(benchmarkFixture(), null, 2)}\n`);

    const manifest = await prepareScientificEmbeddingsCli([
      '--benchmark-path', benchmarkPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-scientific-embedding-test',
      '--dimension', '64',
      '--top-k', '1'
    ]);

    assert.equal(manifest.runId, 'cli-scientific-embedding-test');
    assert.equal(manifest.dimension, 64);
    assert.equal(manifest.topK, 1);
    assert.equal(manifest.releaseGateStatus, 'incomplete');
    const dense = JSON.parse(await fs.readFile(manifest.artifacts.denseScoresPath, 'utf8'));
    const index = JSON.parse(await fs.readFile(manifest.artifacts.embeddingIndexPath, 'utf8'));
    const manifestOnDisk = JSON.parse(await fs.readFile(manifest.artifacts.manifestPath, 'utf8'));
    assert.equal(dense.contractVersion, FIXED_CORPUS_DENSE_SCORES_VERSION);
    assert.equal(dense.queries[0].rankings.length, 1);
    assert.equal(index.contractVersion, SCIENTIFIC_EMBEDDING_INDEX_VERSION);
    assert.equal(manifestOnDisk.contractVersion, SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION);
    assert.equal(manifestOnDisk.inputs.length, 1);
    assert.equal(manifestOnDisk.inputs[0].role, 'scientific_embedding_benchmark');
    assert.match(manifestOnDisk.inputs[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
