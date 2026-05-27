import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildScientificEmbeddingReleaseEvidenceReport,
  prepareScientificEmbeddingReleaseEvidence,
  SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION
} from '../src/core/eval/scientific-embedding-release-evidence.js';
import {
  DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD,
  SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION
} from '../src/core/index/scientific-embeddings.js';
import { prepareScientificEmbeddingReleaseEvidenceCli } from '../scripts/prepare-scientific-embedding-release-evidence.mjs';

function scientificEmbeddingManifest(overrides = {}) {
  return {
    contractVersion: SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION,
    runId: 'specter2-scientific-embedding-release',
    status: 'completed',
    releaseGateStatus: 'ready_for_evaluation',
    method: 'external-scientific-embedding-vectors',
    model: 'SPECTER2 scientific encoder',
    datasetSource: 'SciRepEval OAG GraphRAG benchmark snapshot 2026-05',
    licenseScope: 'public benchmark research use',
    inputs: [{
      role: 'scientific_embedding_benchmark',
      path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
      sha256: 'sha-scientific-embedding-benchmark'
    }, {
      role: 'scientific_embedding_source',
      path: '/benchmarks/specter2-vectors.jsonl',
      sha256: 'sha-specter2-vectors'
    }],
    diagnostics: {
      documentEmbeddingLoadedRows: 1000,
      queryEmbeddingLoadedRows: 100,
      deterministicFallbackDocumentCount: 0,
      deterministicFallbackQueryCount: 0
    },
    ...overrides
  };
}

function retrievalSuiteReport(overrides = {}) {
  return {
    contractVersion: 'fixed-corpus-retrieval-suite-v1',
    runId: 'scientific-embedding-retrieval-suite',
    status: 'completed',
    datasetPath: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
    benchmark: {
      name: 'SciRepEval OAG GraphRAG fixed-corpus retrieval benchmark',
      format: 'scirepeval-oag-graphrag'
    },
    inputs: [{
      role: 'fixed_corpus_dataset',
      path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
      sha256: 'sha-retrieval-suite-dataset'
    }, {
      role: 'fixed_corpus_lexical_scores',
      path: '/benchmarks/bm25-lexical-scores.json',
      sha256: 'sha-retrieval-suite-lexical'
    }, {
      role: 'fixed_corpus_dense_scores',
      path: '/benchmarks/specter2-dense-scores.json',
      sha256: 'sha-retrieval-suite-dense'
    }, {
      role: 'fixed_corpus_hybrid_scores',
      path: '/benchmarks/specter2-hybrid-scores.json',
      sha256: 'sha-retrieval-suite-hybrid'
    }],
    rows: [
      { mode: 'lexical', status: 'completed', metrics: { 'ndcg@10': 0.41, 'recall@10': 0.52 } },
      { mode: 'dense', status: 'completed', metrics: { 'ndcg@10': 0.46, 'recall@10': 0.57 } },
      { mode: 'hybrid', status: 'completed', metrics: { 'ndcg@10': 0.58, 'recall@10': 0.68 } }
    ],
    ...overrides
  };
}

test('scientific embedding release evidence passes with external vectors and dense/hybrid improvement', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    generatedAt: '2026-05-27T00:00:00.000Z',
    runId: 'scientific-embedding-release',
    scientificEmbeddingManifest: scientificEmbeddingManifest(),
    retrievalSuiteReport: retrievalSuiteReport(),
    inputs: [{ role: 'scientific_embedding_manifest', path: '/reports/manifest.json', sha256: 'sha-manifest' }]
  });

  assert.equal(report.contractVersion, SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION);
  assert.equal(report.status, 'passed');
  assert.equal(report.requirements[0].id, 'R4');
  assert.equal(report.requirements[0].status, 'passed');
  assert.equal(report.releaseGate.status, 'passed');
});

test('scientific embedding release evidence rejects deterministic token-hash placeholders', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest({
      method: DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD
    }),
    retrievalSuiteReport: retrievalSuiteReport()
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /deterministic placeholder vectors/);
});

test('scientific embedding release evidence rejects fixture provenance', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest({
      datasetSource: 'SciRepEval OAG GraphRAG fixture'
    }),
    retrievalSuiteReport: retrievalSuiteReport()
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /fixture_or_synthetic_evidence/);
});

test('scientific embedding release evidence requires all scientific benchmark families', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest({
      model: 'SPECTER2 scientific encoder',
      datasetSource: 'SciRepEval OAG benchmark snapshot 2026-05',
      inputs: [{
        role: 'scientific_embedding_benchmark',
        path: '/benchmarks/scirepeval-oag-fixed-corpus.json',
        sha256: 'sha-scientific-embedding-benchmark'
      }, {
        role: 'scientific_embedding_source',
        path: '/benchmarks/specter2-vectors.jsonl',
        sha256: 'sha-specter2-vectors'
      }]
    }),
    retrievalSuiteReport: retrievalSuiteReport({
      datasetPath: '/benchmarks/scirepeval-oag-fixed-corpus.json',
      benchmark: {
        name: 'SciRepEval OAG fixed-corpus retrieval benchmark',
        format: 'scirepeval-oag'
      },
      inputs: [{
        role: 'fixed_corpus_dataset',
        path: '/benchmarks/scirepeval-oag-fixed-corpus.json',
        sha256: 'sha-retrieval-suite-dataset'
      }, {
        role: 'fixed_corpus_dense_scores',
        path: '/benchmarks/specter2-dense-scores.json',
        sha256: 'sha-retrieval-suite-dense'
      }]
    })
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /missing scientific embedding benchmark families: graphrag/);
});

test('scientific embedding release evidence requires manifest and retrieval input hashes', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest({
      inputs: [{ role: 'scientific_embedding_benchmark', path: '/benchmarks/input.json' }]
    }),
    retrievalSuiteReport: retrievalSuiteReport()
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /manifest is missing input hashes/);
});

test('scientific embedding release evidence requires manifest role-specific input hashes', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest({
      inputs: [{
        role: 'scientific_embedding_benchmark',
        path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
        sha256: 'sha-scientific-embedding-benchmark'
      }]
    }),
    retrievalSuiteReport: retrievalSuiteReport()
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /missing scientific embedding manifest role-specific input hashes: scientific_embedding_source/);
  assert.deepEqual(report.requirements[0].evidence[0].missing_manifest_input_role_hashes, ['scientific_embedding_source']);
});

test('scientific embedding release evidence requires retrieval role-specific input hashes', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest(),
    retrievalSuiteReport: retrievalSuiteReport({
      inputs: [{
        role: 'fixed_corpus_dataset',
        path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
        sha256: 'sha-retrieval-suite-dataset'
      }, {
        role: 'fixed_corpus_dense_scores',
        path: '/benchmarks/specter2-dense-scores.json',
        sha256: 'sha-retrieval-suite-dense'
      }]
    })
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /missing retrieval suite role-specific input hashes: fixed_corpus_lexical_scores, fixed_corpus_hybrid_scores/);
  assert.deepEqual(report.requirements[0].evidence[0].missing_retrieval_input_role_hashes, [
    'fixed_corpus_lexical_scores',
    'fixed_corpus_hybrid_scores'
  ]);
});

test('scientific embedding release evidence requires dense or hybrid improvement over lexical', () => {
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    scientificEmbeddingManifest: scientificEmbeddingManifest(),
    retrievalSuiteReport: retrievalSuiteReport({
      rows: [
        { mode: 'lexical', status: 'completed', metrics: { 'ndcg@10': 0.60, 'recall@10': 0.70 } },
        { mode: 'dense', status: 'completed', metrics: { 'ndcg@10': 0.55, 'recall@10': 0.65 } },
        { mode: 'hybrid', status: 'completed', metrics: { 'ndcg@10': 0.60, 'recall@10': 0.70 } }
      ]
    })
  });

  assert.equal(report.status, 'incomplete');
  assert.match(report.requirements[0].message, /does not improve over lexical/);
});

test('scientific embedding release evidence writes auditable artifacts from input files', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scientific-embedding-release-evidence-'));
  try {
    const manifestPath = path.join(tempRoot, 'scientific-manifest.json');
    const retrievalPath = path.join(tempRoot, 'retrieval-report.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(manifestPath, `${JSON.stringify(scientificEmbeddingManifest(), null, 2)}\n`);
    await fs.writeFile(retrievalPath, `${JSON.stringify(retrievalSuiteReport(), null, 2)}\n`);

    const report = await prepareScientificEmbeddingReleaseEvidence({
      outputDir,
      runId: 'scientific-embedding-release-files',
      scientificEmbeddingManifestPath: manifestPath,
      retrievalSuiteReportPath: retrievalPath
    });

    assert.equal(report.status, 'passed');
    assert.equal(report.inputs.length, 2);
    assert.ok(report.inputs.every((entry) => entry.sha256));
    assert.ok(await fs.stat(report.artifacts.reportPath));
    assert.ok(await fs.stat(report.artifacts.reportMarkdownPath));
    assert.ok(await fs.stat(report.artifacts.manifestPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('scientific embedding release evidence CLI help exposes required flags', async () => {
  const result = await prepareScientificEmbeddingReleaseEvidenceCli(['--help']);
  assert.match(result.help, /--scientific-embedding-manifest/);
  assert.match(result.help, /--retrieval-suite-report/);
  assert.match(result.help, /--require-passed/);
});
