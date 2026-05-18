import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runFixedCorpusRetrievalSuite } from '../scripts/run-fixed-corpus-retrieval-suite.mjs';

const execFileAsync = promisify(execFile);

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
    name: 'tiny-fixed-corpus-suite',
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

test('fixed-corpus retrieval suite evaluates comparable retrieval modes and writes artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fixed-corpus-retrieval-suite-'));

  try {
    const densePath = path.join(tempRoot, 'dense.json');
    const rerankPath = path.join(tempRoot, 'rerank.json');
    await fs.writeFile(densePath, `${JSON.stringify(denseArtifact(), null, 2)}\n`);
    await fs.writeFile(rerankPath, `${JSON.stringify(rerankArtifact(), null, 2)}\n`);

    const report = await runFixedCorpusRetrievalSuite({
      runId: 'test-fixed-corpus-suite',
      outputDir: tempRoot,
      benchmark: tinyBenchmark(),
      modes: ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank'],
      fixedCorpusDenseScoresPath: densePath,
      fixedCorpusRerankScoresPath: rerankPath,
      fixedCorpusScanLimit: 2,
      maxCandidates: 1,
      cutoffs: [1]
    });

    assert.equal(report.status, 'completed');
    assert.deepEqual(report.rows.map((row) => row.mode), ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank']);
    assert.equal(report.rows.find((row) => row.mode === 'dense').metrics['hit@1'], 1);
    assert.equal(report.rows.find((row) => row.mode === 'hybrid-rerank').metrics['hit@1'], 1);
    assert.equal(report.rows.find((row) => row.mode === 'dense').denseResolvedScoreCount, 2);
    assert.equal(report.rows.find((row) => row.mode === 'rerank').rerankResolvedScoreCount, 2);

    assert.ok(await fileExists(report.artifacts.manifestPath));
    assert.ok(await fileExists(report.artifacts.resultRowsPath));
    assert.ok(await fileExists(report.artifacts.summaryTsvPath));
    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));
    assert.ok(await fileExists(path.join(report.artifacts.runsDir, 'test-fixed-corpus-suite-hybrid-rerank', 'report.json')));

    const summaryTsv = await fs.readFile(report.artifacts.summaryTsvPath, 'utf8');
    assert.match(summaryTsv, /mode\tstatus\tscorer/);
    assert.match(summaryTsv, /hybrid-rerank/);

    const beforeResumeRows = await fs.readFile(report.artifacts.resultRowsPath, 'utf8');
    const resumed = await runFixedCorpusRetrievalSuite({
      runId: 'test-fixed-corpus-suite',
      outputDir: tempRoot,
      benchmark: tinyBenchmark(),
      modes: ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank'],
      fixedCorpusDenseScoresPath: densePath,
      fixedCorpusRerankScoresPath: rerankPath,
      fixedCorpusScanLimit: 2,
      maxCandidates: 1,
      cutoffs: [1],
      resume: true
    });
    const afterResumeRows = await fs.readFile(report.artifacts.resultRowsPath, 'utf8');
    assert.equal(resumed.rows.length, 5);
    assert.equal(afterResumeRows, beforeResumeRows);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('fixed-corpus retrieval suite CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fixed-corpus-retrieval-suite-cli-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(tinyBenchmark(), null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/run-fixed-corpus-retrieval-suite.mjs'),
      '--dataset-path', benchmarkPath,
      '--format', 'custom',
      '--output-dir', outputDir,
      '--run-id', 'cli-fixed-corpus-suite',
      '--modes', 'lexical',
      '--fixed-corpus-scan-limit', '2',
      '--max-candidates', '1',
      '--cutoffs', '1'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-fixed-corpus-suite');
    assert.equal(cliReport.status, 'completed');
    assert.equal(cliReport.outputDir, outputDir);
    assert.deepEqual(cliReport.modes.map((row) => row.mode), ['lexical']);
    assert.ok(await fileExists(path.join(outputDir, 'report.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
