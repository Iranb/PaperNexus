import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runPaperClaimReport } from '../scripts/generate-paper-claim-report.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createSyntheticSweep(root, options = {}) {
  const sweepDir = path.join(root, options.name || 'synthetic-scifact-x2');
  const runsDir = path.join(sweepDir, 'runs');
  const repetitions = options.repetitions || 2;
  const rows = [];
  const runReports = [];

  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const runKey = `synthetic-scifact-full-rep-${repetition}`;
    const runDir = path.join(runsDir, runKey);
    const reportPath = path.join(runDir, 'report.json');
    const durations = [10 + repetition, 20 + repetition, 30 + repetition];
    const runReport = {
      contractVersion: 'retrieval-benchmark-v1',
      status: 'completed',
      benchmark: {
        name: 'synthetic-scifact',
        format: 'beir',
        evaluatedQueries: 3,
        loadedQueries: 3,
        corpusSize: 9
      },
      config: {
        evaluationMode: 'fixed-corpus',
        fixedCorpusScorer: 'hybrid-bm25-v1'
      },
      metrics: {
        'ndcg@10': 0.5,
        'recall@100': 0.75,
        'mrr@10': 0.4
      },
      diagnostics: {
        averageQueryDurationMs: durations.reduce((sum, value) => sum + value, 0) / durations.length
      },
      results: durations.map((durationMs, index) => ({
        queryKey: `q${index + 1}`,
        durationMs,
        metrics: {
          'ndcg@10': index === 0 ? 1 : 0,
          'recall@100': index === 0 ? 1 : 0,
          'mrr@10': index === 0 ? 1 : 0
        }
      }))
    };
    await writeJson(reportPath, runReport);
    await writeJson(path.join(runDir, 'run-manifest.json'), {
      contractVersion: 'retrieval-benchmark-run-v1',
      runId: runKey,
      machine: {
        host: 'paper-host',
        platform: 'darwin',
        arch: 'arm64',
        node: process.version
      }
    });
    rows.push({
      runKey,
      status: 'completed',
      scanLimitLabel: 'full',
      scanLimit: 9,
      repetition,
      durationMs: 60,
      wallMs: 65,
      evaluatedQueries: 3,
      candidatePoolRecall: 1,
      zeroMatchQueries: 0,
      reportPath,
      metrics: {
        'ndcg@10': 0.5,
        'recall@100': 0.75,
        'mrr@10': 0.4
      }
    });
    runReports.push(reportPath);
  }

  await writeJson(path.join(sweepDir, 'report.json'), {
    runId: 'synthetic-scifact-x2',
    kind: 'fixed-corpus-scan-limit-sweep',
    status: 'completed',
    datasetPath: path.join(sweepDir, 'dataset'),
    outputDir: sweepDir,
    repetitions,
    cutoffs: [10, 100],
    benchmark: {
      name: 'synthetic-scifact',
      format: 'beir',
      queryCount: 3,
      corpusSize: 9
    },
    scanLimits: [{ label: 'full', value: 9 }],
    rows,
    summaries: [{
      scanLimitLabel: 'full',
      scanLimit: 9,
      repetitions,
      durationMsMean: 60,
      durationMsStd: 0,
      wallMsMean: 65,
      wallMsStd: 0,
      candidatePoolRecallMean: 1,
      candidatePoolRecallStd: 0,
      zeroMatchQueriesMean: 0,
      metrics: {
        'ndcg@10': { mean: 0.5, std: 0 },
        'recall@100': { mean: 0.75, std: 0 },
        'mrr@10': { mean: 0.4, std: 0 }
      }
    }],
    artifacts: {
      runsDir,
      reportPath: path.join(sweepDir, 'report.json')
    }
  });

  return {
    sweepDir,
    runReports
  };
}

test('paper claim report marks repeated fixed-corpus public metrics as paper-ready', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const outputDir = path.join(tempRoot, 'claim-report');
    const report = await runPaperClaimReport({
      runId: 'synthetic-paper-claim',
      outputDir,
      inputs: [sweepDir],
      minRepetitions: 2
    });

    assert.equal(report.status, 'paper_ready');
    assert.equal(report.claims.length, 1);
    assert.equal(report.claims[0].claimClass, 'paper_ready');
    assert.deepEqual(report.claims[0].gate.reasons, []);
    assert.equal(report.claims[0].metrics['ndcg@10'].mean, 0.5);
    assert.equal(report.claims[0].diagnostics.latency.perQueryCount, 6);
    assert.equal(report.claims[0].machines[0].host, 'paper-host');

    assert.ok(await fileExists(path.join(outputDir, 'paper-claim-report.json')));
    assert.ok(await fileExists(path.join(outputDir, 'paper-claim-report.md')));
    assert.ok(await fileExists(path.join(outputDir, 'paper-claim-table.tsv')));
    assert.ok(await fileExists(path.join(outputDir, 'paper-claim-manifest.json')));

    const table = await fs.readFile(path.join(outputDir, 'paper-claim-table.tsv'), 'utf8');
    assert.match(table, /synthetic-scifact/);
    assert.match(table, /paper_ready/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report imports JSON baselines without affecting paper-ready gate', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-baseline-json-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const baselinePath = path.join(tempRoot, 'baseline.json');
    await writeJson(baselinePath, {
      label: 'External BM25',
      rows: [{
        dataset: 'synthetic-scifact',
        metrics: {
          'ndcg@10': 0.45,
          'recall@100': 0.7,
          'mrr@10': 0.35
        },
        source: 'external-table-1'
      }]
    });

    const outputDir = path.join(tempRoot, 'claim-report');
    const report = await runPaperClaimReport({
      runId: 'synthetic-paper-claim-json-baseline',
      outputDir,
      inputs: [sweepDir],
      minRepetitions: 2,
      baselines: [`bm25=${baselinePath}`]
    });

    assert.equal(report.status, 'paper_ready');
    assert.equal(report.baselines.rowCount, 1);
    assert.deepEqual(report.baselines.warnings, []);
    assert.equal(report.claims[0].comparisons.length, 1);
    assert.equal(report.claims[0].comparisons[0].method, 'bm25');
    assert.equal(report.claims[0].comparisons[0].metrics['ndcg@10'].baseline, 0.45);
    assert.equal(report.claims[0].comparisons[0].metrics['ndcg@10'].delta, 0.04999999999999999);

    const comparisonTable = await fs.readFile(path.join(outputDir, 'paper-claim-comparison-table.tsv'), 'utf8');
    assert.match(comparisonTable, /external_baseline/);
    assert.match(comparisonTable, /bm25/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report imports TSV baselines and warns on missing dataset rows only', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-baseline-tsv-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const baselinePath = path.join(tempRoot, 'baseline.tsv');
    await fs.writeFile(baselinePath, [
      'dataset\tmethod\tndcg@10\trecall@100\tmrr@10\tsource',
      'synthetic-scifact\tSparseBaseline\t0.4\t0.6\t0.3\texternal-tsv',
      'other-dataset\tMissingForClaim\t0.2\t0.3\t0.1\texternal-tsv'
    ].join('\n'), 'utf8');

    const report = await runPaperClaimReport({
      runId: 'synthetic-paper-claim-tsv-baseline',
      outputDir: path.join(tempRoot, 'claim-report'),
      inputs: [sweepDir],
      minRepetitions: 2,
      baselines: [baselinePath]
    });

    assert.equal(report.status, 'paper_ready');
    assert.equal(report.claims[0].comparisons.length, 1);
    assert.equal(report.claims[0].comparisons[0].method, 'SparseBaseline');
    assert.ok(report.baselines.warnings.includes('missing_baseline_for_dataset:MissingForClaim:synthetic-scifact'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report keeps missing baseline metrics blank in comparison artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-baseline-partial-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const baselinePath = path.join(tempRoot, 'baseline.tsv');
    await fs.writeFile(baselinePath, [
      'dataset\tmethod\tndcg@10\tsource',
      'synthetic-scifact\tPartialBaseline\t0.4\tpartial-tsv'
    ].join('\n'), 'utf8');

    const outputDir = path.join(tempRoot, 'claim-report');
    const report = await runPaperClaimReport({
      runId: 'synthetic-paper-claim-partial-baseline',
      outputDir,
      inputs: [sweepDir],
      minRepetitions: 2,
      baselines: [baselinePath]
    });

    assert.equal(report.status, 'paper_ready');
    assert.equal(report.claims[0].comparisons[0].metrics['recall@100'].baseline, null);
    assert.ok(report.baselines.warnings.includes('missing_baseline_metric:PartialBaseline:synthetic-scifact:recall@100'));

    const comparisonTable = await fs.readFile(path.join(outputDir, 'paper-claim-comparison-table.tsv'), 'utf8');
    assert.match(comparisonTable, /PartialBaseline\texternal_baseline\tpartial-tsv\t0\.4\t0\.1\t\t\t\t/);

    const markdown = await fs.readFile(path.join(outputDir, 'paper-claim-report.md'), 'utf8');
    assert.match(markdown, /PartialBaseline \| partial-tsv \| 0\.4 \/ 0\.1 \|  \/  \|  \/ /);
    assert.doesNotMatch(markdown, /PartialBaseline.*0 \/ 0/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report gate fails when repetitions are below threshold', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-low-reps-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const report = await runPaperClaimReport({
      runId: 'synthetic-paper-claim-low-reps',
      outputDir: path.join(tempRoot, 'claim-report'),
      inputs: [path.join(sweepDir, 'report.json')],
      minRepetitions: 3
    });

    assert.equal(report.status, 'needs_attention');
    assert.equal(report.claims[0].claimClass, 'not_paper_ready');
    assert.ok(report.claims[0].gate.reasons.includes('needs_more_repetitions_2_of_3'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-cli-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const outputDir = path.join(tempRoot, 'claim-report');
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/generate-paper-claim-report.mjs'),
      '--run-id', 'synthetic-paper-claim-cli',
      '--output-dir', outputDir,
      '--min-repetitions', '2',
      sweepDir
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'synthetic-paper-claim-cli');
    assert.equal(cliReport.status, 'paper_ready');
    assert.equal(cliReport.claims[0].dataset, 'synthetic-scifact');
    assert.ok(await fileExists(path.join(outputDir, 'paper-claim-report.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('paper claim report CLI accepts repeated baseline options', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-claim-cli-baseline-'));

  try {
    const { sweepDir } = await createSyntheticSweep(tempRoot, { repetitions: 2 });
    const baselinePath = path.join(tempRoot, 'baseline.json');
    await writeJson(baselinePath, {
      rows: [{
        dataset: 'synthetic-scifact',
        method: 'JsonBaseline',
        metrics: {
          'ndcg@10': 0.49,
          'recall@100': 0.72,
          'mrr@10': 0.38
        }
      }]
    });
    const outputDir = path.join(tempRoot, 'claim-report');
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/generate-paper-claim-report.mjs'),
      '--run-id', 'synthetic-paper-claim-cli-baseline',
      '--output-dir', outputDir,
      '--min-repetitions', '2',
      '--baseline', `json=${baselinePath}`,
      sweepDir
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.status, 'paper_ready');
    const report = JSON.parse(await fs.readFile(path.join(outputDir, 'paper-claim-report.json'), 'utf8'));
    assert.equal(report.baselines.rowCount, 1);
    assert.equal(report.claims[0].comparisons[0].method, 'json');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
