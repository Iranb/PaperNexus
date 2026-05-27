#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  loadRetrievalBenchmark,
  runRetrievalBenchmark
} from '../src/core/benchmarks/retrieval.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const DEFAULT_CUTOFFS = [10, 100];
const DEFAULT_SCAN_LIMIT = 50000;
const MODE_ORDER = ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank'];

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

  const runId = String(options.runId || `fixed-corpus-retrieval-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    datasetPath: options.datasetPath || options.dataset,
    format: options.format,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'fixed-corpus-retrieval-suites', runId)),
    modes: parseCsv(options.modes || options.mode, null),
    fixedCorpusDenseScoresPath: options.fixedCorpusDenseScores || options.fixedCorpusDenseScoresPath || options.denseScores,
    fixedCorpusRerankScoresPath: options.fixedCorpusRerankScores || options.fixedCorpusRerankScoresPath || options.rerankScores,
    fixedCorpusRrfK: parseInteger(options.fixedCorpusRrfK || options.rrfK, null),
    fixedCorpusScanLimit: parseInteger(options.fixedCorpusScanLimit || options.scanLimit, DEFAULT_SCAN_LIMIT),
    fixedCorpusCacheDir: options.fixedCorpusCacheDir || options.cacheDir,
    fixedCorpusQueryAnalysis: options.fixedCorpusQueryAnalysis || options.queryAnalysis || 'off',
    fixedCorpusQueryAnalysisExtraLimit: parseInteger(options.fixedCorpusQueryAnalysisExtraLimit || options.queryAnalysisExtraLimit, null),
    cutoffs: parseNumberCsv(options.cutoffs || options.k, DEFAULT_CUTOFFS),
    benchmarkLimit: parseInteger(options.benchmarkLimit || options.maxQueries || options.limit, null),
    maxCandidates: parseInteger(options.maxCandidates || options.maxFixedCorpusResults, null),
    resume: parseBoolean(options.resume, false),
    continueOnError: parseBoolean(options.continueOnError, false)
  };
}

function normalizeMode(mode = '') {
  const normalized = String(mode || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'embedding' || normalized === 'dense-artifact') return 'dense';
  if (normalized === 'rrf' || normalized === 'hybrid-rrf' || normalized === 'lexical-dense') return 'hybrid';
  if (normalized === 'reranker' || normalized === 'cross-encoder' || normalized === 'rerank-artifact') return 'rerank';
  if (normalized === 'rrf-rerank' || normalized === 'rerank-hybrid' || normalized === 'hybrid-rrf-rerank') return 'hybrid-rerank';
  if (MODE_ORDER.includes(normalized)) return normalized;
  return null;
}

function resolveSuiteModes(inputModes = null, options = {}) {
  const explicit = Array.isArray(inputModes) && inputModes.length > 0;
  const requested = explicit
    ? inputModes.map(normalizeMode).filter(Boolean)
    : [
      'lexical',
      ...(options.fixedCorpusDenseScoresPath ? ['dense', 'hybrid'] : []),
      ...(options.fixedCorpusRerankScoresPath ? ['rerank'] : []),
      ...(options.fixedCorpusDenseScoresPath && options.fixedCorpusRerankScoresPath ? ['hybrid-rerank'] : [])
    ];
  const seen = new Set();
  const modes = requested.filter((mode) => {
    if (!mode || seen.has(mode)) return false;
    seen.add(mode);
    return true;
  }).sort((left, right) => MODE_ORDER.indexOf(left) - MODE_ORDER.indexOf(right));
  if (!modes.length) return ['lexical'];

  const missing = [];
  for (const mode of modes) {
    if (['dense', 'hybrid', 'hybrid-rerank'].includes(mode) && !options.fixedCorpusDenseScoresPath) {
      missing.push(`${mode} requires --fixed-corpus-dense-scores`);
    }
    if (['rerank', 'hybrid-rerank'].includes(mode) && !options.fixedCorpusRerankScoresPath) {
      missing.push(`${mode} requires --fixed-corpus-rerank-scores`);
    }
  }
  if (missing.length) throw new Error(`Cannot run fixed-corpus retrieval suite: ${missing.join('; ')}`);
  return modes;
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
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

async function hashedInputRecord(role = '', filePath = '') {
  if (!filePath) return null;
  const absolutePath = path.resolve(filePath);
  const buffer = await fs.readFile(absolutePath);
  return {
    role,
    path: absolutePath,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

async function buildSuiteInputRecords(options = {}) {
  const entries = [
    ['fixed_corpus_dataset', options.datasetPath],
    ['fixed_corpus_dense_scores', options.fixedCorpusDenseScoresPath],
    ['fixed_corpus_rerank_scores', options.fixedCorpusRerankScoresPath]
  ];
  const records = [];
  for (const [role, filePath] of entries) {
    const record = await hashedInputRecord(role, filePath);
    if (record) records.push(record);
  }
  return records;
}

function metricKeysFromRows(rows = []) {
  const keys = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.metrics || {})) keys.add(key);
  }
  return [...keys].sort();
}

function buildSuiteRow(report = {}, context = {}) {
  const denseDiagnostics = report.diagnostics?.fixedCorpusDenseIndex || null;
  const rerankDiagnostics = report.diagnostics?.fixedCorpusRerankIndex || null;
  return {
    status: report.status,
    runKey: context.runKey,
    mode: context.mode,
    scorer: report.config?.fixedCorpusScorer || null,
    durationMs: report.durationMs,
    wallMs: context.wallMs,
    evaluatedQueries: report.benchmark?.evaluatedQueries || report.results?.length || 0,
    fixedCorpusScanLimit: report.config?.fixedCorpusScanLimit ?? null,
    fixedCorpusCacheHit: report.diagnostics?.fixedCorpusIndex?.cacheHit ?? null,
    denseLoadedQueries: report.config?.fixedCorpusDenseScoresLoadedQueries ?? null,
    denseResolvedScoreCount: denseDiagnostics?.resolvedScoreCount ?? null,
    denseUnresolvedScoreCount: denseDiagnostics?.unresolvedScoreCount ?? null,
    rerankLoadedQueries: report.config?.fixedCorpusRerankScoresLoadedQueries ?? null,
    rerankResolvedScoreCount: rerankDiagnostics?.resolvedScoreCount ?? null,
    rerankUnresolvedScoreCount: rerankDiagnostics?.unresolvedScoreCount ?? null,
    reportPath: report.artifacts?.jsonPath || null,
    markdownPath: report.artifacts?.markdownPath || null,
    metrics: report.metrics || {}
  };
}

function renderSummaryTsv(rows = []) {
  const metricKeys = metricKeysFromRows(rows);
  const headers = [
    'mode',
    'status',
    'scorer',
    'evaluated_queries',
    'duration_ms',
    'wall_ms',
    'scan_limit',
    'cache_hit',
    'dense_loaded_queries',
    'dense_resolved_rows',
    'dense_unresolved_rows',
    'rerank_loaded_queries',
    'rerank_resolved_rows',
    'rerank_unresolved_rows',
    ...metricKeys
  ];
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push([
      row.mode,
      row.status,
      row.scorer || '',
      row.evaluatedQueries,
      formatNumber(row.durationMs),
      formatNumber(row.wallMs),
      row.fixedCorpusScanLimit ?? '',
      row.fixedCorpusCacheHit ?? '',
      row.denseLoadedQueries ?? '',
      row.denseResolvedScoreCount ?? '',
      row.denseUnresolvedScoreCount ?? '',
      row.rerankLoadedQueries ?? '',
      row.rerankResolvedScoreCount ?? '',
      row.rerankUnresolvedScoreCount ?? '',
      ...metricKeys.map((key) => formatNumber(row.metrics?.[key]))
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report = {}) {
  const rows = report.rows || [];
  const preferredMetricKeys = ['ndcg@10', 'recall@10', 'recall@100', 'mrr@10', 'hit@10', 'hit@100']
    .filter((key) => rows.some((row) => row.metrics?.[key] !== undefined));
  const headers = ['Mode', 'Scorer', 'Queries', 'Runtime', ...preferredMetricKeys];
  const lines = [
    `# Fixed-Corpus Retrieval Suite: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Benchmark: ${report.benchmark?.name || 'unknown'}`,
    `- Dataset: ${report.datasetPath || 'in-memory benchmark'}`,
    `- Modes: ${report.modes.join(', ')}`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---:').join(' | ')} |`
  ];
  for (const row of rows) {
    lines.push(`| ${[
      row.mode,
      row.scorer || '',
      row.evaluatedQueries,
      formatNumber(row.wallMs || row.durationMs),
      ...preferredMetricKeys.map((key) => formatNumber(row.metrics?.[key]))
    ].join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function modeRunOptions(mode, options = {}) {
  const runOptions = {
    fixedCorpusRetrievalMode: mode
  };
  if (['dense', 'hybrid', 'hybrid-rerank'].includes(mode)) {
    runOptions.fixedCorpusDenseScoresPath = options.fixedCorpusDenseScoresPath;
  }
  if (['rerank', 'hybrid-rerank'].includes(mode)) {
    runOptions.fixedCorpusRerankScoresPath = options.fixedCorpusRerankScoresPath;
  }
  return runOptions;
}

export async function runFixedCorpusRetrievalSuite(inputOptions = {}) {
  const runId = inputOptions.runId || `fixed-corpus-retrieval-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'benchmarks', 'fixed-corpus-retrieval-suites', runId));
  const datasetPath = inputOptions.datasetPath || inputOptions.dataset;
  if (!inputOptions.benchmark && !datasetPath) {
    throw new Error('A datasetPath or in-memory benchmark is required for fixed-corpus retrieval suite.');
  }

  const modes = resolveSuiteModes(inputOptions.modes, inputOptions);
  const benchmark = inputOptions.benchmark || await loadRetrievalBenchmark(datasetPath, inputOptions);
  const startedAt = new Date().toISOString();
  const runsDir = path.join(outputDir, 'runs');
  const resultRowsPath = path.join(outputDir, 'suite-results.jsonl');
  const failuresPath = path.join(outputDir, 'failures.jsonl');
  const fixedCorpusCacheDir = inputOptions.fixedCorpusCacheDir || path.join(outputDir, 'fixed-corpus-cache');
  const resume = Boolean(inputOptions.resume);
  const continueOnError = Boolean(inputOptions.continueOnError);
  const cutoffs = inputOptions.cutoffs || DEFAULT_CUTOFFS;
  const fixedCorpusScanLimit = parseInteger(inputOptions.fixedCorpusScanLimit, DEFAULT_SCAN_LIMIT);
  const inputs = await buildSuiteInputRecords({
    datasetPath,
    fixedCorpusDenseScoresPath: inputOptions.fixedCorpusDenseScoresPath,
    fixedCorpusRerankScoresPath: inputOptions.fixedCorpusRerankScoresPath
  });

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

  await writeJson(path.join(outputDir, 'suite-manifest.json'), {
    runId,
    kind: 'fixed-corpus-retrieval-suite',
    startedAt,
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: benchmark.queryCount,
      corpusSize: benchmark.corpusSize || (Array.isArray(benchmark.corpus) ? benchmark.corpus.length : null)
    },
    modes,
    cutoffs,
    fixedCorpusScanLimit,
    fixedCorpusCacheDir,
    fixedCorpusDenseScoresPath: inputOptions.fixedCorpusDenseScoresPath || null,
    fixedCorpusRerankScoresPath: inputOptions.fixedCorpusRerankScoresPath || null,
    fixedCorpusRrfK: inputOptions.fixedCorpusRrfK || null,
    fixedCorpusQueryAnalysis: inputOptions.fixedCorpusQueryAnalysis || 'off',
    inputs,
    resume,
    continueOnError
  });

  const existingRows = resume ? await readJsonl(resultRowsPath) : [];
  const completedRunKeys = new Set(existingRows.filter((row) => row.status !== 'failed').map((row) => row.runKey));
  const rows = [...existingRows];

  for (const mode of modes) {
    const runKey = `${runId}-${mode}`;
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
        fixedCorpusScanLimit,
        fixedCorpusCacheDir,
        fixedCorpusRrfK: inputOptions.fixedCorpusRrfK,
        fixedCorpusQueryAnalysis: inputOptions.fixedCorpusQueryAnalysis || 'off',
        fixedCorpusQueryAnalysisExtraLimit: inputOptions.fixedCorpusQueryAnalysisExtraLimit,
        cutoffs,
        benchmarkLimit: inputOptions.benchmarkLimit,
        maxQueries: inputOptions.maxQueries,
        maxCandidates: inputOptions.maxCandidates,
        maxFixedCorpusResults: inputOptions.maxFixedCorpusResults || inputOptions.maxCandidates,
        continueOnError,
        ...modeRunOptions(mode, inputOptions)
      });
      const row = buildSuiteRow(report, {
        runKey,
        mode,
        wallMs: performance.now() - wallStarted
      });
      rows.push(row);
      await appendJsonl(resultRowsPath, row);
    } catch (error) {
      const row = {
        runKey,
        mode,
        status: 'failed',
        error: error?.message || String(error),
        failedAt: new Date().toISOString()
      };
      rows.push(row);
      await appendJsonl(resultRowsPath, row);
      await appendJsonl(failuresPath, row);
      if (!continueOnError) throw error;
    }
  }

  const completedAt = new Date().toISOString();
  const report = {
    contractVersion: 'fixed-corpus-retrieval-suite-v1',
    runId,
    kind: 'fixed-corpus-retrieval-suite',
    status: rows.some((row) => row.status === 'failed') ? 'completed_with_failures' : 'completed',
    startedAt,
    completedAt,
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    outputDir,
    modes,
    cutoffs,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: benchmark.queryCount,
      corpusSize: benchmark.corpusSize || (Array.isArray(benchmark.corpus) ? benchmark.corpus.length : null)
    },
    inputs,
    rows,
    artifacts: {
      manifestPath: path.join(outputDir, 'suite-manifest.json'),
      resultRowsPath,
      failuresPath,
      summaryTsvPath: path.join(outputDir, 'summary.tsv'),
      reportPath: path.join(outputDir, 'report.json'),
      reportMarkdownPath: path.join(outputDir, 'report.md'),
      runsDir
    }
  };

  await writeJson(report.artifacts.reportPath, report);
  await writeText(report.artifacts.summaryTsvPath, renderSummaryTsv(rows));
  await writeText(report.artifacts.reportMarkdownPath, renderMarkdown(report));
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runFixedCorpusRetrievalSuite(options);
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    modes: report.rows.map((row) => ({
      mode: row.mode,
      status: row.status,
      ndcg10: row.metrics?.['ndcg@10'] ?? null,
      recall100: row.metrics?.['recall@100'] ?? null,
      mrr10: row.metrics?.['mrr@10'] ?? null
    }))
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
