#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  loadRetrievalBenchmark,
  runRetrievalBenchmark
} from '../src/core/benchmarks/retrieval.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const DEFAULT_SCAN_LIMITS = ['5000', '20000', '50000', 'full'];
const DEFAULT_CUTOFFS = [5, 10, 20, 100];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseNumberCsv(value, fallback = []) {
  const parsed = parseCsv(value, fallback)
    .map((item) => parseInteger(item, null))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }

  const runId = String(options.runId || `fixed-corpus-scan-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    datasetPath: options.datasetPath || options.dataset,
    format: options.format,
    rootPath: options.rootPath,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'fixed-corpus-scan-sweeps', runId)),
    scanLimits: parseCsv(options.scanLimits || options.scanLimit, DEFAULT_SCAN_LIMITS),
    repetitions: parseInteger(options.repetitions || options.runs, 1),
    cutoffs: parseNumberCsv(options.cutoffs || options.k, DEFAULT_CUTOFFS),
    benchmarkLimit: parseInteger(options.benchmarkLimit || options.limit, null),
    maxFixedCorpusResults: parseInteger(options.maxFixedCorpusResults || options.maxCandidates, null),
    fixedCorpusCacheDir: options.fixedCorpusCacheDir || options.fixed_corpus_cache_dir,
    resume: parseBoolean(options.resume, false),
    continueOnError: parseBoolean(options.continueOnError, false),
    titleMatchThreshold: options.titleMatchThreshold
  };
}

function resolveCorpusSize(benchmark = {}) {
  return Number(benchmark.corpusSize || (Array.isArray(benchmark.corpus) ? benchmark.corpus.length : 0)) || null;
}

function normalizeScanLimits(scanLimits = DEFAULT_SCAN_LIMITS, benchmark = {}) {
  const corpusSize = resolveCorpusSize(benchmark);
  const fallbackFull = corpusSize || Number.MAX_SAFE_INTEGER;
  const normalized = [];
  const seen = new Set();
  for (const entry of scanLimits) {
    const raw = String(entry ?? '').trim();
    if (!raw) continue;
    const label = raw.toLowerCase() === 'full' ? 'full' : String(parseInteger(raw, raw));
    const value = raw.toLowerCase() === 'full'
      ? fallbackFull
      : parseInteger(raw, null);
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      label,
      value,
      requested: raw,
      fullCorpus: raw.toLowerCase() === 'full'
    });
  }
  return normalized.length ? normalized : normalizeScanLimits(DEFAULT_SCAN_LIMITS, benchmark);
}

async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function mean(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function std(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length <= 1) return 0;
  const avg = mean(finite);
  const variance = finite.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (finite.length - 1);
  return Math.sqrt(variance);
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function metricKeysFromRows(rows = []) {
  const keys = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.metrics || {})) keys.add(key);
    for (const key of Object.keys(row.officialMetrics || {})) keys.add(`official.${key}`);
  }
  return [...keys].sort();
}

function buildSweepRow(report = {}, context = {}) {
  const evaluatedQueries = Number(report.benchmark?.evaluatedQueries || report.results?.length || 0);
  return {
    status: report.status,
    runId: context.runId,
    scanLimitLabel: context.scanLimit.label,
    scanLimit: context.scanLimit.value,
    requestedScanLimit: context.scanLimit.requested,
    repetition: context.repetition,
    durationMs: report.durationMs,
    wallMs: context.wallMs,
    evaluatedQueries,
    averageQueryDurationMs: evaluatedQueries ? report.durationMs / evaluatedQueries : null,
    candidatePoolRecall: report.diagnostics?.candidatePoolRecall ?? null,
    zeroMatchQueries: report.diagnostics?.zeroMatchQueries ?? null,
    fixedCorpusCacheHit: report.diagnostics?.fixedCorpusIndex?.cacheHit ?? null,
    fixedCorpusCachePath: report.diagnostics?.fixedCorpusIndex?.cachePath || null,
    reportPath: report.artifacts?.jsonPath || null,
    markdownPath: report.artifacts?.markdownPath || null,
    metrics: report.metrics || {},
    officialMetrics: report.officialMetrics?.metrics || {}
  };
}

function summarizeRows(rows = []) {
  const metricKeys = metricKeysFromRows(rows);
  const byScanLimit = new Map();
  for (const row of rows) {
    if (row.status === 'failed') continue;
    const key = `${row.scanLimitLabel}:${row.scanLimit}`;
    const group = byScanLimit.get(key) || [];
    group.push(row);
    byScanLimit.set(key, group);
  }

  return [...byScanLimit.values()].map((group) => {
    const first = group[0] || {};
    const summary = {
      scanLimitLabel: first.scanLimitLabel,
      scanLimit: first.scanLimit,
      repetitions: group.length,
      durationMsMean: mean(group.map((row) => row.durationMs)),
      durationMsStd: std(group.map((row) => row.durationMs)),
      wallMsMean: mean(group.map((row) => row.wallMs)),
      wallMsStd: std(group.map((row) => row.wallMs)),
      candidatePoolRecallMean: mean(group.map((row) => row.candidatePoolRecall)),
      candidatePoolRecallStd: std(group.map((row) => row.candidatePoolRecall)),
      zeroMatchQueriesMean: mean(group.map((row) => row.zeroMatchQueries))
    };
    summary.metrics = {};
    for (const key of metricKeys) {
      const values = group.map((row) => (
        key.startsWith('official.')
          ? row.officialMetrics?.[key.slice('official.'.length)]
          : row.metrics?.[key]
      ));
      summary.metrics[key] = {
        mean: mean(values),
        std: std(values)
      };
    }
    return summary;
  });
}

function renderSummaryTsv(summaries = []) {
  const metricKeys = [...new Set(summaries.flatMap((summary) => Object.keys(summary.metrics || {})))].sort();
  const headers = [
    'scan_limit',
    'scan_limit_value',
    'n',
    'duration_ms_mean',
    'duration_ms_std',
    'wall_ms_mean',
    'wall_ms_std',
    'candidate_pool_recall_mean',
    'candidate_pool_recall_std',
    'zero_match_queries_mean',
    ...metricKeys.flatMap((key) => [`${key}_mean`, `${key}_std`])
  ];
  const lines = [headers.join('\t')];
  for (const summary of summaries) {
    lines.push([
      summary.scanLimitLabel,
      summary.scanLimit,
      summary.repetitions,
      formatNumber(summary.durationMsMean),
      formatNumber(summary.durationMsStd),
      formatNumber(summary.wallMsMean),
      formatNumber(summary.wallMsStd),
      formatNumber(summary.candidatePoolRecallMean),
      formatNumber(summary.candidatePoolRecallStd),
      formatNumber(summary.zeroMatchQueriesMean),
      ...metricKeys.flatMap((key) => [
        formatNumber(summary.metrics?.[key]?.mean),
        formatNumber(summary.metrics?.[key]?.std)
      ])
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report = {}) {
  const metricKeys = [...new Set(report.summaries.flatMap((summary) => Object.keys(summary.metrics || {})))].sort();
  const preferredMetricKeys = metricKeys.filter((key) => (
    /^recall@|^ndcg@|^mrr@|^official\./.test(key)
  )).slice(0, 8);
  const headers = [
    'Scan limit',
    'n',
    'Duration ms',
    'Candidate recall',
    ...preferredMetricKeys
  ];
  const lines = [
    `# Fixed-Corpus Scan-Limit Sweep: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Benchmark: ${report.benchmark?.name || 'unknown'}`,
    `- Dataset: ${report.datasetPath || 'in-memory benchmark'}`,
    `- Repetitions: ${report.repetitions}`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---:').join(' | ')} |`
  ];
  for (const summary of report.summaries) {
    lines.push(`| ${[
      summary.scanLimitLabel,
      summary.repetitions,
      `${formatNumber(summary.durationMsMean)} +/- ${formatNumber(summary.durationMsStd)}`,
      `${formatNumber(summary.candidatePoolRecallMean)} +/- ${formatNumber(summary.candidatePoolRecallStd)}`,
      ...preferredMetricKeys.map((key) => `${formatNumber(summary.metrics?.[key]?.mean)} +/- ${formatNumber(summary.metrics?.[key]?.std)}`)
    ].join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runFixedCorpusScanLimitSweep(inputOptions = {}) {
  const runId = inputOptions.runId || `fixed-corpus-scan-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'benchmarks', 'fixed-corpus-scan-sweeps', runId));
  const datasetPath = inputOptions.datasetPath || inputOptions.dataset;
  if (!inputOptions.benchmark && !datasetPath) {
    throw new Error('A datasetPath or in-memory benchmark is required for fixed-corpus scan-limit sweep.');
  }

  const benchmark = inputOptions.benchmark || await loadRetrievalBenchmark(datasetPath, inputOptions);
  const scanLimits = normalizeScanLimits(inputOptions.scanLimits || DEFAULT_SCAN_LIMITS, benchmark);
  const repetitions = parseInteger(inputOptions.repetitions, 1);
  const cutoffs = inputOptions.cutoffs || DEFAULT_CUTOFFS;
  const runsDir = path.join(outputDir, 'runs');
  const resultRowsPath = path.join(outputDir, 'sweep-results.jsonl');
  const failuresPath = path.join(outputDir, 'failures.jsonl');
  const fixedCorpusCacheDir = inputOptions.fixedCorpusCacheDir
    || path.join(outputDir, 'fixed-corpus-cache');
  const resume = Boolean(inputOptions.resume);
  const continueOnError = Boolean(inputOptions.continueOnError);

  await ensureDir(outputDir);
  if (!resume) {
    await Promise.all([
      fs.rm(resultRowsPath, { force: true }),
      fs.rm(failuresPath, { force: true }),
      fs.rm(path.join(outputDir, 'report.json'), { force: true }),
      fs.rm(path.join(outputDir, 'report.md'), { force: true }),
      fs.rm(path.join(outputDir, 'summary.tsv'), { force: true })
    ]);
  }

  const existingRows = resume ? await readJsonl(resultRowsPath) : [];
  const completedRunKeys = new Set(existingRows.filter((row) => row.status !== 'failed').map((row) => row.runKey));
  const rows = [...existingRows];
  const startedAt = new Date().toISOString();
  await writeJson(path.join(outputDir, 'sweep-manifest.json'), {
    runId,
    kind: 'fixed-corpus-scan-limit-sweep',
    startedAt,
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: benchmark.queryCount,
      corpusSize: resolveCorpusSize(benchmark)
    },
    scanLimits,
    repetitions,
    cutoffs,
    fixedCorpusCacheDir,
    resume,
    continueOnError
  });

  for (const scanLimit of scanLimits) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const runKey = `${runId}-scan-${scanLimit.label}-rep-${repetition}`;
      if (resume && completedRunKeys.has(runKey)) continue;
      const wallStarted = performance.now();
      try {
        const report = await runRetrievalBenchmark({
          ...inputOptions,
          benchmark,
          datasetPath,
          outputDir: runsDir,
          runId: runKey,
          resume,
          evaluationMode: 'fixed-corpus',
          fixedCorpusScanLimit: scanLimit.value,
          fixedCorpusCacheDir,
          cutoffs,
          continueOnError,
          maxFixedCorpusResults: inputOptions.maxFixedCorpusResults,
          benchmarkLimit: inputOptions.benchmarkLimit,
          titleMatchThreshold: inputOptions.titleMatchThreshold
        });
        const row = {
          runKey,
          ...buildSweepRow(report, {
            runId: runKey,
            scanLimit,
            repetition,
            wallMs: performance.now() - wallStarted
          })
        };
        rows.push(row);
        await appendJsonl(resultRowsPath, row);
      } catch (error) {
        const row = {
          runKey,
          status: 'failed',
          scanLimitLabel: scanLimit.label,
          scanLimit: scanLimit.value,
          repetition,
          error: error?.message || String(error),
          failedAt: new Date().toISOString()
        };
        rows.push(row);
        await appendJsonl(resultRowsPath, row);
        await appendJsonl(failuresPath, row);
        if (!continueOnError) throw error;
      }
    }
  }

  const summaries = summarizeRows(rows);
  const endedAt = new Date().toISOString();
  const report = {
    runId,
    kind: 'fixed-corpus-scan-limit-sweep',
    status: rows.some((row) => row.status === 'failed') ? 'completed_with_failures' : 'completed',
    startedAt,
    completedAt: endedAt,
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    outputDir,
    repetitions,
    cutoffs,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: benchmark.queryCount,
      corpusSize: resolveCorpusSize(benchmark)
    },
    scanLimits,
    rows,
    summaries,
    artifacts: {
      manifestPath: path.join(outputDir, 'sweep-manifest.json'),
      resultRowsPath,
      failuresPath,
      summaryTsvPath: path.join(outputDir, 'summary.tsv'),
      reportPath: path.join(outputDir, 'report.json'),
      reportMarkdownPath: path.join(outputDir, 'report.md'),
      runsDir
    }
  };

  await writeJson(report.artifacts.reportPath, report);
  await writeText(report.artifacts.summaryTsvPath, renderSummaryTsv(summaries));
  await writeText(report.artifacts.reportMarkdownPath, renderMarkdown(report));
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runFixedCorpusScanLimitSweep(options);
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    scanLimits: report.summaries.map((summary) => ({
      scanLimit: summary.scanLimitLabel,
      n: summary.repetitions,
      candidatePoolRecallMean: summary.candidatePoolRecallMean
    }))
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
