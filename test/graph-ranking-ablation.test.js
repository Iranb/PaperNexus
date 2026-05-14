import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGraphRankingAblation } from '../scripts/benchmark-graph-ranking-ablation.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function graphBenchmarkFixture() {
  return {
    name: 'tiny-graph-ablation',
    format: 'custom',
    corpusSize: 4,
    corpus: [
      {
        id: 'seed',
        title: 'Graph retrieval seed paper',
        abstract: 'A seed paper for relation-aware graph retrieval.'
      },
      {
        id: 'target',
        title: 'Neighborhood reranking for scholarly discovery',
        abstract: 'Citation neighborhood evidence improves scientific paper discovery.'
      },
      {
        id: 'decoy',
        title: 'Graph retrieval survey',
        abstract: 'A broad survey of graph retrieval systems.'
      },
      {
        id: 'batch',
        title: 'Batch extraction pipeline',
        abstract: 'LLM extraction and batch processing.'
      }
    ],
    graph: {
      edges: [
        { source: 'seed', target: 'target', type: 'uses' },
        { source: 'seed', target: 'batch', type: 'related' }
      ]
    },
    queryCount: 1,
    queries: [
      {
        id: 'q1',
        query: 'graph retrieval',
        sourcePaperId: 'seed',
        relevant: [{ id: 'target', title: 'Neighborhood reranking for scholarly discovery' }]
      }
    ]
  };
}

function graphRankerQualityFixture() {
  const decoys = Array.from({ length: 20 }, (_, index) => ({
    id: `decoy-${index + 1}`,
    title: `Retrieval methods source evidence decoy ${index + 1}`,
    abstract: 'A lexical match about retrieval methods, source evidence, and graph search.',
    references: []
  }));
  return {
    name: 'graph-ranker-quality-fixture',
    format: 'custom',
    corpus: [
      {
        id: 'anchor',
        title: 'Sparse anchor study',
        abstract: 'Anchor paper with typed method evidence.'
      },
      {
        id: 'target',
        title: 'Neighborhood reranking for scholarly discovery',
        abstract: 'Typed graph evidence recovers the relevant method paper.',
        exactQuote: 'Typed graph evidence recovers the relevant method paper.',
        sourceSpan: { sourceId: 'source:target', start: 0, end: 58 }
      },
      ...decoys
    ],
    graph: {
      edges: [
        { source: 'anchor', target: 'target', type: 'uses' },
        ...decoys.flatMap((paper, index) => [
          { source: 'anchor', target: paper.id, type: 'related' },
          { source: paper.id, target: `decoy-${((index + 1) % decoys.length) + 1}`, type: 'same_topic' }
        ])
      ]
    },
    queries: [
      {
        id: 'q-quality',
        query: 'retrieval methods that use source evidence',
        graphSeeds: ['anchor'],
        relationTypes: ['uses'],
        relevant: [{ id: 'target', title: 'Neighborhood reranking for scholarly discovery' }]
      }
    ]
  };
}

test('graph ranking ablation writes mode artifacts and resumes without duplicate rows', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-ranking-ablation-'));

  try {
    const report = await runGraphRankingAblation({
      runId: 'test-graph-ranking-ablation',
      outputDir: tempRoot,
      benchmark: graphBenchmarkFixture(),
      modes: ['text-only', 'graph-only', 'hybrid'],
      cutoffs: [1, 2],
      maxCandidates: 3,
      graphHopLimit: 1
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows.length, 3);
    assert.equal(report.graph.edgeCount, 2);
    assert.deepEqual(report.modeSummaries.map((summary) => summary.mode), ['text-only', 'graph-only', 'hybrid']);
    assert.equal(report.modeSummaries.find((summary) => summary.mode === 'text-only').metrics['hit@1'], 0);
    assert.equal(report.modeSummaries.find((summary) => summary.mode === 'graph-only').metrics['hit@1'], 1);
    assert.ok(await fileExists(report.artifacts.manifestPath));
    assert.ok(await fileExists(report.artifacts.perQueryResultsPath));
    assert.ok(await fileExists(report.artifacts.summaryTsvPath));
    assert.ok(await fileExists(report.artifacts.reportPath));

    const summaryTsv = await fs.readFile(report.artifacts.summaryTsvPath, 'utf8');
    assert.match(summaryTsv, /mode\tevaluated_queries/);
    assert.match(summaryTsv, /p95_latency_ms/);
    assert.match(summaryTsv, /graph-only/);

    const beforeResumeRows = await fs.readFile(report.artifacts.perQueryResultsPath, 'utf8');
    const resumed = await runGraphRankingAblation({
      runId: 'test-graph-ranking-ablation',
      outputDir: tempRoot,
      benchmark: graphBenchmarkFixture(),
      modes: ['text-only', 'graph-only', 'hybrid'],
      cutoffs: [1, 2],
      maxCandidates: 3,
      graphHopLimit: 1,
      resume: true
    });
    const afterResumeRows = await fs.readFile(report.artifacts.perQueryResultsPath, 'utf8');

    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.rows.length, 3);
    assert.equal(afterResumeRows, beforeResumeRows);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ranking all-improvements mode promotes evidence-backed graph expansion into top ten', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-ranker-quality-'));

  try {
    const report = await runGraphRankingAblation({
      runId: 'test-graph-ranker-quality',
      outputDir: tempRoot,
      benchmark: graphRankerQualityFixture(),
      modes: ['hybrid', 'hybrid+all'],
      cutoffs: [10, 100],
      maxCandidates: 30,
      graphHopLimit: 1,
      hubDegreeThreshold: 2,
      hybridTextWeight: 0.25,
      hybridGraphWeight: 0.75,
      evidenceBoostWeight: 0.3
    });

    const summaries = Object.fromEntries(report.modeSummaries.map((summary) => [summary.mode, summary]));
    assert.equal(summaries.hybrid.metrics['hit@10'], 0);
    assert.equal(summaries['hybrid+all'].metrics['hit@10'], 1);
    assert.ok(summaries['hybrid+all'].averageHubSuppressedCount > 0);
    assert.ok(summaries['hybrid+all'].averageEvidenceBoostedCount > 0);

    const allRow = report.rows.find((row) => row.mode === 'hybrid+all');
    assert.equal(allRow.firstRelevantRank <= 10, true);
    assert.equal(allRow.ablation.seedPaperIds.includes('anchor'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ranking ablation CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-ranking-ablation-cli-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(graphBenchmarkFixture(), null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/benchmark-graph-ranking-ablation.mjs'),
      '--dataset-path', benchmarkPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-graph-ranking-ablation',
      '--modes', 'text-only,graph-only',
      '--cutoffs', '1,2',
      '--max-candidates', '3',
      '--graph-hop-limit', '1'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-graph-ranking-ablation');
    assert.equal(cliReport.status, 'completed');
    assert.equal(cliReport.outputDir, outputDir);
    assert.ok(await fileExists(path.join(outputDir, 'report.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ranking ablation API default output dir follows the provided run id', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-ranking-ablation-default-cwd-'));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempRoot);
    const report = await runGraphRankingAblation({
      runId: 'api-default-run-id',
      benchmark: graphBenchmarkFixture(),
      modes: ['graph-only'],
      cutoffs: [1],
      maxCandidates: 3,
      graphHopLimit: 1
    });

    assert.ok(path.dirname(report.artifacts.reportPath).endsWith(path.join('.papernexus', 'benchmarks', 'graph-ranking-ablations', 'api-default-run-id')));
    assert.ok(await fileExists(report.artifacts.reportPath));
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
