import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runLitSearchRetrievalPipeline } from '../scripts/run-litsearch-retrieval-pipeline.mjs';

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tinyBenchmark() {
  return {
    name: 'tiny-litsearch-pipeline-suite',
    format: 'custom',
    corpusSize: 3,
    corpus: [
      {
        id: 'd1',
        title: 'Domain shift adaptation methods',
        abstract: 'A direct lexical match for domain shift adaptation.'
      },
      {
        id: 'd2',
        title: 'Failure modes of out-of-distribution generalization',
        abstract: 'Robustness issues under distribution shift.'
      },
      {
        id: 'd3',
        title: 'Unrelated optimizer analysis',
        abstract: 'A distractor document.'
      }
    ],
    queryCount: 1,
    queries: [{
      id: 'q1',
      query: 'papers studying challenges of domain shift adaptation',
      relevant: [{ id: 'd2', title: 'Failure modes of out-of-distribution generalization' }]
    }]
  };
}

function denseArtifact() {
  return {
    contractVersion: 'fixed-corpus-dense-scores-v1',
    queries: [{
      queryId: 'q1',
      rankings: [
        { documentId: 'd2', score: 0.95 },
        { documentId: 'd1', score: 0.60 }
      ]
    }]
  };
}

function rerankArtifact() {
  return {
    contractVersion: 'fixed-corpus-rerank-scores-v1',
    queries: [{
      queryId: 'q1',
      rankings: [
        { documentId: 'd2', score: 8.4 },
        { documentId: 'd1', score: 1.1 }
      ]
    }]
  };
}

test('LitSearch retrieval pipeline dry-run writes auditable artifact commands', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-litsearch-pipeline-dry-run-'));

  try {
    const report = await runLitSearchRetrievalPipeline({
      runId: 'dry-run-pipeline',
      outputDir: tempRoot,
      dryRun: true,
      runDense: true,
      runRerank: true,
      runSuite: true,
      queries: path.join(tempRoot, 'queries.jsonl'),
      corpus: path.join(tempRoot, 'corpus.jsonl'),
      datasetPath: path.join(tempRoot, 'litsearch-dataset'),
      maxQueries: 3,
      maxCandidates: 20
    });

    assert.equal(report.status, 'planned');
    assert.ok(await fileExists(path.join(tempRoot, 'pipeline-manifest.json')));
    assert.ok(await fileExists(path.join(tempRoot, 'pipeline-commands.sh')));

    const commands = await fs.readFile(path.join(tempRoot, 'pipeline-commands.sh'), 'utf8');
    assert.match(commands, /run_litsearch_dense_fastembed\.py/);
    assert.match(commands, /run_litsearch_cross_encoder_rerank\.py/);
    assert.match(commands, /run-fixed-corpus-retrieval-suite\.mjs/);
    assert.match(commands, /--max-queries 3/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('LitSearch retrieval pipeline can reuse artifacts and run the PaperNexus suite', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-litsearch-pipeline-suite-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const densePath = path.join(tempRoot, 'dense.json');
    const rerankPath = path.join(tempRoot, 'rerank.json');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(tinyBenchmark(), null, 2)}\n`);
    await fs.writeFile(densePath, `${JSON.stringify(denseArtifact(), null, 2)}\n`);
    await fs.writeFile(rerankPath, `${JSON.stringify(rerankArtifact(), null, 2)}\n`);

    const report = await runLitSearchRetrievalPipeline({
      runId: 'suite-only-pipeline',
      outputDir: tempRoot,
      datasetPath: benchmarkPath,
      format: 'custom',
      denseTopk: densePath,
      rerankScores: rerankPath,
      modes: ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank'],
      fixedCorpusScanLimit: 2,
      maxCandidates: 1,
      cutoffs: [1]
    });

    assert.equal(report.status, 'completed');
    assert.ok(await fileExists(report.artifacts.suiteReportPath));
    assert.ok(await fileExists(report.artifacts.suiteSummaryTsvPath));

    const suiteReport = JSON.parse(await fs.readFile(report.artifacts.suiteReportPath, 'utf8'));
    assert.deepEqual(suiteReport.rows.map((row) => row.mode), ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank']);
    assert.equal(suiteReport.rows.find((row) => row.mode === 'hybrid-rerank').metrics['hit@1'], 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
