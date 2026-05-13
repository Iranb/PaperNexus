import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runFixedCorpusScanLimitSweep } from '../scripts/sweep-fixed-corpus-scan-limit.mjs';

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
    name: 'tiny-fixed-corpus-sweep',
    format: 'custom',
    corpusSize: 3,
    corpus: [
      {
        id: 'p1',
        title: 'Neural graph retrieval for papers',
        abstract: 'Graph retrieval and ranking for literature discovery.'
      },
      {
        id: 'p2',
        title: 'LLM batch paper extraction',
        abstract: 'Structured extraction from paper metadata and abstracts.'
      },
      {
        id: 'p3',
        title: 'Kuzu graph migration',
        abstract: 'Incremental graph migration and validation.'
      }
    ],
    queryCount: 2,
    queries: [
      {
        id: 'q1',
        query: 'neural graph retrieval papers',
        relevant: [{ id: 'p1', title: 'Neural graph retrieval for papers' }]
      },
      {
        id: 'q2',
        query: 'llm batch paper extraction',
        relevant: [{ id: 'p2', title: 'LLM batch paper extraction' }]
      }
    ]
  };
}

test('fixed-corpus scan-limit sweep writes summary artifacts and resumes without duplicate rows', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fixed-corpus-scan-sweep-'));

  try {
    const report = await runFixedCorpusScanLimitSweep({
      runId: 'test-fixed-corpus-scan-sweep',
      outputDir: tempRoot,
      benchmark: tinyBenchmark(),
      scanLimits: [1, 'full'],
      repetitions: 2,
      cutoffs: [1, 2],
      maxFixedCorpusResults: 2
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows.length, 4);
    assert.equal(report.summaries.length, 2);
    assert.deepEqual(report.summaries.map((summary) => summary.scanLimitLabel), ['1', 'full']);
    assert.equal(report.summaries[0].repetitions, 2);
    assert.equal(report.summaries[1].repetitions, 2);
    assert.equal(report.summaries[0].metrics['hit@1'].mean, 1);
    assert.ok(report.rows.some((row) => row.fixedCorpusCacheHit === false));
    assert.ok(report.rows.some((row) => row.fixedCorpusCacheHit === true));

    assert.ok(await fileExists(report.artifacts.manifestPath));
    assert.ok(await fileExists(report.artifacts.resultRowsPath));
    assert.ok(await fileExists(report.artifacts.summaryTsvPath));
    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));
    assert.ok(await fileExists(path.join(report.artifacts.runsDir, 'test-fixed-corpus-scan-sweep-scan-1-rep-1', 'report.json')));

    const summaryTsv = await fs.readFile(report.artifacts.summaryTsvPath, 'utf8');
    assert.match(summaryTsv, /scan_limit\tscan_limit_value\tn/);
    assert.match(summaryTsv, /hit@1_mean/);

    const beforeResumeRows = await fs.readFile(report.artifacts.resultRowsPath, 'utf8');
    const resumed = await runFixedCorpusScanLimitSweep({
      runId: 'test-fixed-corpus-scan-sweep',
      outputDir: tempRoot,
      benchmark: tinyBenchmark(),
      scanLimits: [1, 'full'],
      repetitions: 2,
      cutoffs: [1, 2],
      maxFixedCorpusResults: 2,
      resume: true
    });
    const afterResumeRows = await fs.readFile(report.artifacts.resultRowsPath, 'utf8');

    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.rows.length, 4);
    assert.equal(afterResumeRows, beforeResumeRows);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('fixed-corpus scan-limit sweep CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fixed-corpus-scan-sweep-cli-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(tinyBenchmark(), null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/sweep-fixed-corpus-scan-limit.mjs'),
      '--dataset-path', benchmarkPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-fixed-corpus-scan-sweep',
      '--scan-limits', '1',
      '--repetitions', '1',
      '--cutoffs', '1',
      '--max-fixed-corpus-results', '2'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-fixed-corpus-scan-sweep');
    assert.equal(cliReport.status, 'completed');
    assert.equal(cliReport.outputDir, outputDir);
    assert.ok(await fileExists(path.join(outputDir, 'report.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
