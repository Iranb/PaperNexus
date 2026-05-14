#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_VERSION = 'papernexus-paper-claim-report-v1';
const DEFAULT_REQUIRED_METRICS = ['ndcg@10', 'recall@100', 'mrr@10'];
const DEFAULT_SCAN_LIMIT = 'full';
const DEFAULT_MIN_REPETITIONS = 5;

function usage() {
  return [
    'Usage:',
    '  node scripts/generate-paper-claim-report.mjs [options] <sweep-report-or-dir>...',
    '',
    'Options:',
    '  --run-id <id>',
    '  --output-dir <dir>',
    '  --min-repetitions <n>        Default: 5',
    '  --scan-limit <label>         Default: full',
    '  --required-metrics <csv>     Default: ndcg@10,recall@100,mrr@10',
    '  --baseline <label=path>      Optional JSON/TSV external baseline; repeatable',
    '',
    'Inputs should be fixed-corpus sweep report.json files or directories containing report.json.'
  ].join('\n');
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  const baselineSpecs = [];
  const inputs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      inputs.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    const rawKey = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      if (key === 'baseline') {
        baselineSpecs.push(inlineValue);
        continue;
      }
      raw[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      if (key === 'baseline') {
        baselineSpecs.push(next);
        index += 1;
        continue;
      }
      raw[key] = next;
      index += 1;
    } else {
      raw[key] = 'true';
    }
  }

  const runId = raw.runId || `stable-paper-claim-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    help: raw.help,
    runId,
    outputDir: raw.outputDir || path.join('.papernexus', 'paper-revision', 'stable-claims', runId),
    minRepetitions: parseInteger(raw.minRepetitions, DEFAULT_MIN_REPETITIONS),
    scanLimit: raw.scanLimit || DEFAULT_SCAN_LIMIT,
    requiredMetrics: parseCsv(raw.requiredMetrics, DEFAULT_REQUIRED_METRICS),
    baselines: baselineSpecs,
    inputs
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mean(values = []) {
  const numeric = values.map(numberOrNull).filter((value) => value !== null);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

function std(values = []) {
  const numeric = values.map(numberOrNull).filter((value) => value !== null);
  if (numeric.length < 2) return 0;
  const avg = mean(numeric);
  return Math.sqrt(numeric.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (numeric.length - 1));
}

function percentile(values = [], p = 50) {
  const numeric = values.map(numberOrNull).filter((value) => value !== null).sort((left, right) => left - right);
  if (!numeric.length) return null;
  if (numeric.length === 1) return numeric[0];
  const rank = (Math.max(0, Math.min(100, Number(p))) / 100) * (numeric.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return numeric[low];
  return numeric[low] + ((numeric[high] - numeric[low]) * (rank - low));
}

function formatNumber(value, digits = 4) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return numeric.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMetricCell(metric = {}) {
  const meanValue = formatNumber(metric.mean);
  const stdValue = formatNumber(metric.std);
  return stdValue ? `${meanValue} +/- ${stdValue}` : meanValue;
}

function normalizeDatasetKey(value = '') {
  return String(value ?? '').trim().toLowerCase();
}

function splitBaselineSpec(spec = '') {
  if (typeof spec === 'object' && spec !== null) return spec;
  const text = String(spec);
  const equalsIndex = text.indexOf('=');
  if (equalsIndex <= 0) {
    return {
      label: '',
      path: text
    };
  }
  return {
    label: text.slice(0, equalsIndex).trim(),
    path: text.slice(equalsIndex + 1).trim()
  };
}

function parseTsv(text = '') {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split('\t').map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function normalizeBaselineMetrics(row = {}, requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const sourceMetrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : row;
  const lowerCaseMetrics = Object.fromEntries(Object.entries(sourceMetrics).map(([key, value]) => [
    String(key).trim().toLowerCase(),
    value
  ]));
  return Object.fromEntries(requiredMetrics.map((metric) => [
    metric,
    numberOrNull(lowerCaseMetrics[String(metric).toLowerCase()])
  ]).filter(([, value]) => value !== null));
}

function normalizeBaselineRows({
  rows,
  filePath,
  specLabel,
  fileLabel,
  requiredMetrics
}) {
  const defaultLabel = specLabel || fileLabel || path.basename(filePath, path.extname(filePath));
  return rows.map((row) => {
    const dataset = row.dataset || row.benchmark || row.name || '';
    const method = specLabel || row.method || row.label || row.system || defaultLabel;
    return {
      dataset: String(dataset).trim(),
      datasetKey: normalizeDatasetKey(dataset),
      method: String(method).trim(),
      source: row.source || row.citation || filePath,
      metrics: normalizeBaselineMetrics(row, requiredMetrics),
      inputPath: filePath
    };
  }).filter((row) => row.dataset && row.method);
}

async function readBaselineSpec(spec, requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const parsed = splitBaselineSpec(spec);
  const filePath = path.resolve(process.cwd(), parsed.path || '');
  if (!parsed.path) throw new Error(`Baseline spec is missing a path: ${String(spec)}`);
  const text = await fs.readFile(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsv') {
    return {
      label: parsed.label || path.basename(filePath, extension),
      path: filePath,
      format: 'tsv',
      rows: normalizeBaselineRows({
        rows: parseTsv(text),
        filePath,
        specLabel: parsed.label,
        requiredMetrics
      })
    };
  }

  const payload = JSON.parse(text);
  const rawRows = Array.isArray(payload) ? payload : payload.rows;
  if (!Array.isArray(rawRows)) {
    throw new Error(`Baseline JSON must be an array or contain a rows array: ${filePath}`);
  }
  return {
    label: parsed.label || payload.label || path.basename(filePath, extension),
    path: filePath,
    format: 'json',
    rows: normalizeBaselineRows({
      rows: rawRows,
      filePath,
      specLabel: parsed.label,
      fileLabel: payload.label,
      requiredMetrics
    })
  };
}

async function loadExternalBaselines(specs = [], requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const entries = [];
  for (const spec of specs) {
    entries.push(await readBaselineSpec(spec, requiredMetrics));
  }
  return entries;
}

function flattenBaselineRows(baselines = []) {
  return baselines.flatMap((baseline) => baseline.rows.map((row) => ({
    ...row,
    baselineLabel: baseline.label,
    baselinePath: baseline.path,
    baselineFormat: baseline.format
  })));
}

function compareClaimToBaselines(claim = {}, baselineRows = [], requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const datasetKey = normalizeDatasetKey(claim.dataset);
  return baselineRows
    .filter((row) => row.datasetKey === datasetKey)
    .map((row) => ({
      method: row.method,
      source: row.source,
      baselineLabel: row.baselineLabel,
      metrics: Object.fromEntries(requiredMetrics.map((metric) => {
        const baseline = numberOrNull(row.metrics?.[metric]);
        const paperNexus = numberOrNull(claim.metrics?.[metric]?.mean);
        return [metric, {
          baseline,
          paperNexus,
          delta: baseline === null || paperNexus === null ? null : paperNexus - baseline
        }];
      }))
    }));
}

function buildComparisonWarnings(claims = [], baselineRows = [], requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const warnings = [];
  const methods = [...new Set(baselineRows.map((row) => row.method))];
  for (const claim of claims) {
    const claimKey = normalizeDatasetKey(claim.dataset);
    for (const method of methods) {
      const row = baselineRows.find((candidate) => candidate.method === method && candidate.datasetKey === claimKey);
      if (!row) {
        warnings.push(`missing_baseline_for_dataset:${method}:${claim.dataset}`);
        continue;
      }
      for (const metric of requiredMetrics) {
        if (numberOrNull(row.metrics?.[metric]) === null) {
          warnings.push(`missing_baseline_metric:${method}:${claim.dataset}:${metric}`);
        }
      }
    }
  }
  return warnings;
}

async function resolveSweepReportPath(input) {
  const absolute = path.resolve(process.cwd(), input);
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) {
    const reportPath = path.join(absolute, 'report.json');
    if (await fileExists(reportPath)) return reportPath;
    throw new Error(`Input directory does not contain report.json: ${absolute}`);
  }
  return absolute;
}

function scanLimitKey(value = '') {
  return String(value ?? '').trim().toLowerCase();
}

function selectSummary(report = {}, scanLimit = DEFAULT_SCAN_LIMIT) {
  const summaries = Array.isArray(report.summaries) ? report.summaries : [];
  const requested = scanLimitKey(scanLimit);
  return summaries.find((summary) => scanLimitKey(summary.scanLimitLabel) === requested)
    || summaries.find((summary) => scanLimitKey(summary.requestedScanLimit) === requested)
    || summaries[0]
    || null;
}

function rowsForSummary(report = {}, summary = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const label = scanLimitKey(summary.scanLimitLabel);
  const scanLimit = Number(summary.scanLimit);
  return rows.filter((row) => {
    if (label && scanLimitKey(row.scanLimitLabel) === label) return true;
    return Number.isFinite(scanLimit) && Number(row.scanLimit) === scanLimit;
  });
}

function metricFromSummary(summary = {}, metric) {
  const entry = summary.metrics?.[metric];
  if (!entry) return null;
  return {
    mean: numberOrNull(entry.mean),
    std: numberOrNull(entry.std)
  };
}

function runReportFallbackPath(sweepReportPath = '', row = {}) {
  if (!row.runKey) return '';
  return path.join(path.dirname(sweepReportPath), 'runs', row.runKey, 'report.json');
}

async function loadRunReportForRow(sweepReportPath, row = {}) {
  const candidates = [
    row.reportPath,
    runReportFallbackPath(sweepReportPath, row)
  ].filter(Boolean);

  for (const candidate of candidates) {
    const absolute = path.resolve(process.cwd(), candidate);
    if (await fileExists(absolute)) {
      return {
        path: absolute,
        report: await readJson(absolute),
        manifest: await readRunManifest(absolute)
      };
    }
  }
  return null;
}

async function readRunManifest(reportPath) {
  const manifestPath = path.join(path.dirname(reportPath), 'run-manifest.json');
  if (!(await fileExists(manifestPath))) return null;
  return readJson(manifestPath);
}

function collectLatencyStats(runReports = []) {
  const perQuery = [];
  const perRunAverage = [];
  for (const entry of runReports) {
    const report = entry.report || {};
    const queryDurations = Array.isArray(report.results)
      ? report.results.map((result) => numberOrNull(result.durationMs)).filter((value) => value !== null)
      : [];
    perQuery.push(...queryDurations);
    const averageDuration = numberOrNull(report.diagnostics?.averageQueryDurationMs);
    if (averageDuration !== null) perRunAverage.push(averageDuration);
  }

  return {
    perQueryCount: perQuery.length,
    perQueryMs: {
      mean: mean(perQuery),
      std: std(perQuery),
      p50: percentile(perQuery, 50),
      p95: percentile(perQuery, 95),
      p99: percentile(perQuery, 99)
    },
    perRunAverageMs: {
      mean: mean(perRunAverage),
      std: std(perRunAverage),
      p50: percentile(perRunAverage, 50),
      p95: percentile(perRunAverage, 95)
    }
  };
}

function collectMachineSummary(runReports = []) {
  const seen = new Set();
  const machines = [];
  for (const entry of runReports) {
    const machine = entry.manifest?.machine || {};
    const key = JSON.stringify({
      host: machine.host || '',
      platform: machine.platform || '',
      arch: machine.arch || '',
      node: machine.node || ''
    });
    if (seen.has(key)) continue;
    seen.add(key);
    machines.push({
      host: machine.host || '',
      platform: machine.platform || '',
      arch: machine.arch || '',
      node: machine.node || ''
    });
  }
  return machines;
}

function fixedCorpusEvidence(report = {}, runReports = []) {
  const kindEvidence = String(report.kind || '').includes('fixed-corpus');
  const nestedModes = runReports
    .map((entry) => entry.report?.config?.evaluationMode)
    .filter(Boolean);
  const nestedFixed = nestedModes.length ? nestedModes.every((mode) => mode === 'fixed-corpus') : true;
  return {
    fixedCorpusSweep: kindEvidence,
    nestedModes,
    passed: kindEvidence && nestedFixed
  };
}

function buildGate({
  report,
  summary,
  rows,
  runReports,
  requiredMetrics,
  minRepetitions
}) {
  const reasons = [];
  const benchmark = report.benchmark || {};
  const repetitions = Number(summary?.repetitions || rows.filter((row) => row.status !== 'failed').length || 0);
  const fixedCorpus = fixedCorpusEvidence(report, runReports);

  if (!summary) reasons.push('missing_scan_limit_summary');
  if (report.status && report.status !== 'completed') reasons.push(`sweep_status_${report.status}`);
  if (!fixedCorpus.passed) reasons.push('not_fixed_corpus_or_nested_mode_mismatch');
  if (!(Number(benchmark.corpusSize) > 0)) reasons.push('missing_corpus_size');
  if (!(Number(benchmark.queryCount) > 0)) reasons.push('missing_query_count');
  if (repetitions < minRepetitions) reasons.push(`needs_more_repetitions_${repetitions}_of_${minRepetitions}`);
  if (rows.some((row) => row.status === 'failed')) reasons.push('has_failed_runs');

  for (const metric of requiredMetrics) {
    if (!metricFromSummary(summary, metric)) reasons.push(`missing_required_metric_${metric}`);
  }

  const latency = collectLatencyStats(runReports);
  if (!latency.perQueryCount) reasons.push('missing_per_query_latency');
  if (!collectMachineSummary(runReports).length) reasons.push('missing_machine_manifest');

  return {
    status: reasons.length ? 'not_paper_ready' : 'paper_ready',
    passed: reasons.length === 0,
    reasons,
    fixedCorpus
  };
}

async function buildDatasetClaim(sweepReportPath, options = {}) {
  const report = await readJson(sweepReportPath);
  const summary = selectSummary(report, options.scanLimit || DEFAULT_SCAN_LIMIT);
  const rows = rowsForSummary(report, summary);
  const runReports = (await Promise.all(rows.map((row) => loadRunReportForRow(sweepReportPath, row)))).filter(Boolean);
  const requiredMetrics = options.requiredMetrics || DEFAULT_REQUIRED_METRICS;
  const gate = buildGate({
    report,
    summary,
    rows,
    runReports,
    requiredMetrics,
    minRepetitions: options.minRepetitions || DEFAULT_MIN_REPETITIONS
  });
  const benchmark = report.benchmark || {};
  const metrics = Object.fromEntries(requiredMetrics.map((metric) => [metric, metricFromSummary(summary, metric)]));
  const latency = collectLatencyStats(runReports);
  const machines = collectMachineSummary(runReports);

  return {
    dataset: benchmark.name || path.basename(path.dirname(sweepReportPath)),
    format: benchmark.format || '',
    claimClass: gate.status,
    gate,
    benchmark: {
      queryCount: numberOrNull(benchmark.queryCount),
      corpusSize: numberOrNull(benchmark.corpusSize),
      datasetPath: report.datasetPath || null,
      sweepReportPath
    },
    evaluation: {
      scanLimit: summary?.scanLimitLabel || '',
      scanLimitValue: numberOrNull(summary?.scanLimit),
      repetitions: numberOrNull(summary?.repetitions),
      completedRuns: rows.filter((row) => row.status !== 'failed').length,
      failedRuns: rows.filter((row) => row.status === 'failed').length
    },
    metrics,
    diagnostics: {
      candidatePoolRecall: {
        mean: numberOrNull(summary?.candidatePoolRecallMean),
        std: numberOrNull(summary?.candidatePoolRecallStd)
      },
      zeroMatchQueriesMean: numberOrNull(summary?.zeroMatchQueriesMean),
      durationMs: {
        mean: numberOrNull(summary?.durationMsMean),
        std: numberOrNull(summary?.durationMsStd)
      },
      wallMs: {
        mean: numberOrNull(summary?.wallMsMean),
        std: numberOrNull(summary?.wallMsStd)
      },
      latency
    },
    machines,
    artifacts: {
      inputReportPath: sweepReportPath,
      runReportCount: runReports.length,
      runReportPaths: runReports.map((entry) => entry.path)
    }
  };
}

function renderClaimTableTsv(claims = [], requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const headers = [
    'dataset',
    'format',
    'claim_class',
    'queries',
    'corpus',
    'scan_limit',
    'repetitions',
    ...requiredMetrics.flatMap((metric) => [`${metric}_mean`, `${metric}_std`]),
    'candidate_pool_recall_mean',
    'zero_match_queries_mean',
    'latency_p50_ms',
    'latency_p95_ms',
    'latency_p99_ms',
    'gate_reasons'
  ];
  const lines = [headers.join('\t')];
  for (const claim of claims) {
    lines.push([
      claim.dataset,
      claim.format,
      claim.claimClass,
      claim.benchmark.queryCount ?? '',
      claim.benchmark.corpusSize ?? '',
      claim.evaluation.scanLimit,
      claim.evaluation.repetitions ?? '',
      ...requiredMetrics.flatMap((metric) => [
        formatNumber(claim.metrics?.[metric]?.mean),
        formatNumber(claim.metrics?.[metric]?.std)
      ]),
      formatNumber(claim.diagnostics.candidatePoolRecall.mean),
      formatNumber(claim.diagnostics.zeroMatchQueriesMean),
      formatNumber(claim.diagnostics.latency.perQueryMs.p50),
      formatNumber(claim.diagnostics.latency.perQueryMs.p95),
      formatNumber(claim.diagnostics.latency.perQueryMs.p99),
      claim.gate.reasons.join(';')
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderComparisonTableTsv(claims = [], requiredMetrics = DEFAULT_REQUIRED_METRICS) {
  const headers = [
    'dataset',
    'method',
    'role',
    'source',
    ...requiredMetrics.flatMap((metric) => [
      `${metric}`,
      `${metric}_delta_vs_baseline`
    ])
  ];
  const lines = [headers.join('\t')];
  for (const claim of claims) {
    lines.push([
      claim.dataset,
      'PaperNexus',
      'papernexus',
      claim.artifacts?.inputReportPath || '',
      ...requiredMetrics.flatMap((metric) => [
        formatNumber(claim.metrics?.[metric]?.mean),
        formatNumber(0)
      ])
    ].join('\t'));
    for (const comparison of claim.comparisons || []) {
      lines.push([
        claim.dataset,
        comparison.method,
        'external_baseline',
        comparison.source || '',
        ...requiredMetrics.flatMap((metric) => [
          formatNumber(comparison.metrics?.[metric]?.baseline),
          formatNumber(comparison.metrics?.[metric]?.delta)
        ])
      ].join('\t'));
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report = {}) {
  const requiredMetrics = report.config?.requiredMetrics || DEFAULT_REQUIRED_METRICS;
  const lines = [
    `# PaperNexus Stable Paper Claim Report: ${report.runId}`,
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Claim scope: fixed-corpus retrieval on frozen/public benchmark artifacts.`,
    '',
    '## Paper-Claim Table',
    '',
    `| Dataset | Format | Queries | Corpus | Reps | ${requiredMetrics.join(' | ')} | Latency p50/p95/p99 ms | Gate |`,
    `|---|---|---:|---:|---:|${requiredMetrics.map(() => '---:').join('|')}|---:|---|`
  ];

  for (const claim of report.claims || []) {
    const latency = claim.diagnostics?.latency?.perQueryMs || {};
    const latencyCell = [
      formatNumber(latency.p50),
      formatNumber(latency.p95),
      formatNumber(latency.p99)
    ].join(' / ');
    lines.push(`| ${[
      claim.dataset,
      claim.format || '-',
      claim.benchmark?.queryCount ?? '',
      claim.benchmark?.corpusSize ?? '',
      claim.evaluation?.repetitions ?? '',
      ...requiredMetrics.map((metric) => formatMetricCell(claim.metrics?.[metric])),
      latencyCell,
      claim.claimClass
    ].join(' | ')} |`);
  }

  if (report.baselines?.inputs?.length) {
    lines.push(
      '',
      '## External Baseline Comparison',
      '',
      `| Dataset | Method | Source | ${requiredMetrics.map((metric) => `${metric} / delta`).join(' | ')} |`,
      `|---|---|---|${requiredMetrics.map(() => '---:').join('|')}|`
    );
    for (const claim of report.claims || []) {
      for (const comparison of claim.comparisons || []) {
        lines.push(`| ${[
          claim.dataset,
          comparison.method,
          comparison.source || '-',
          ...requiredMetrics.map((metric) => {
            const entry = comparison.metrics?.[metric] || {};
            return `${formatNumber(entry.baseline)} / ${formatNumber(entry.delta)}`;
          })
        ].join(' | ')} |`);
      }
    }
    if (report.baselines.warnings?.length) {
      lines.push(
        '',
        'Comparison warnings:',
        '',
        ...report.baselines.warnings.map((warning) => `- ${warning}`)
      );
    }
  }

  lines.push(
    '',
    '## Claim Boundary',
    '',
    '- `paper_ready` means fixed corpus, repeated runs, required standard metrics, per-query latency, and machine manifests are present.',
    '- These claims are comparable as fixed-corpus IR metrics; they do not claim full Intern-Atlas method-graph equivalence.',
    '- Fixture-only graph and method-evolution results should be reported separately as harness validation, not as external performance superiority.',
    '',
    '## Gate Details',
    ''
  );

  for (const claim of report.claims || []) {
    lines.push(
      `### ${claim.dataset}`,
      '',
      `- Gate: ${claim.claimClass}`,
      `- Reasons: ${claim.gate.reasons.length ? claim.gate.reasons.join(', ') : 'none'}`,
      `- Run reports: ${claim.artifacts.runReportCount}`,
      `- Machines: ${claim.machines.map((machine) => `${machine.host || 'unknown'} ${machine.platform || ''} ${machine.arch || ''} ${machine.node || ''}`.trim()).join('; ') || 'none'}`,
      ''
    );
  }

  return `${lines.join('\n')}\n`;
}

function reportStatus(claims = []) {
  if (!claims.length) return 'empty';
  return claims.every((claim) => claim.gate.passed) ? 'paper_ready' : 'needs_attention';
}

function outputPaths(outputDir) {
  const absolute = path.resolve(process.cwd(), outputDir);
  return {
    outputDir: absolute,
    reportPath: path.join(absolute, 'paper-claim-report.json'),
    reportMarkdownPath: path.join(absolute, 'paper-claim-report.md'),
    tablePath: path.join(absolute, 'paper-claim-table.tsv'),
    comparisonTablePath: path.join(absolute, 'paper-claim-comparison-table.tsv'),
    manifestPath: path.join(absolute, 'paper-claim-manifest.json')
  };
}

export async function runPaperClaimReport(inputOptions = {}) {
  const inputs = inputOptions.inputs || [];
  if (!inputs.length) throw new Error('At least one sweep report or directory is required.');
  const runId = inputOptions.runId || `stable-paper-claim-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const requiredMetrics = inputOptions.requiredMetrics || DEFAULT_REQUIRED_METRICS;
  const scanLimit = inputOptions.scanLimit || DEFAULT_SCAN_LIMIT;
  const minRepetitions = inputOptions.minRepetitions || DEFAULT_MIN_REPETITIONS;
  const paths = outputPaths(inputOptions.outputDir || path.join('.papernexus', 'paper-revision', 'stable-claims', runId));
  const startedAt = new Date().toISOString();
  const sweepReportPaths = await Promise.all(inputs.map(resolveSweepReportPath));
  const baselineInputs = inputOptions.baselines || [];
  const baselineReports = await loadExternalBaselines(baselineInputs, requiredMetrics);
  const baselineRows = flattenBaselineRows(baselineReports);
  const claims = await Promise.all(sweepReportPaths.map((sweepReportPath) => buildDatasetClaim(sweepReportPath, {
    requiredMetrics,
    scanLimit,
    minRepetitions
  })));
  for (const claim of claims) {
    claim.comparisons = compareClaimToBaselines(claim, baselineRows, requiredMetrics);
  }
  const baselineWarnings = buildComparisonWarnings(claims, baselineRows, requiredMetrics);
  const generatedAt = new Date().toISOString();
  const report = {
    contractVersion: CONTRACT_VERSION,
    runId,
    status: reportStatus(claims),
    startedAt,
    generatedAt,
    config: {
      scanLimit,
      minRepetitions,
      requiredMetrics
    },
    machine: {
      host: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    inputs: sweepReportPaths,
    baselines: {
      inputs: baselineReports.map((baseline) => ({
        label: baseline.label,
        path: baseline.path,
        format: baseline.format,
        rowCount: baseline.rows.length
      })),
      rowCount: baselineRows.length,
      warnings: baselineWarnings
    },
    claims,
    artifacts: {
      reportPath: paths.reportPath,
      reportMarkdownPath: paths.reportMarkdownPath,
      tablePath: paths.tablePath,
      comparisonTablePath: paths.comparisonTablePath,
      manifestPath: paths.manifestPath
    }
  };

  await writeJson(paths.reportPath, report);
  await writeText(paths.reportMarkdownPath, renderMarkdown(report));
  await writeText(paths.tablePath, renderClaimTableTsv(claims, requiredMetrics));
  await writeText(paths.comparisonTablePath, renderComparisonTableTsv(claims, requiredMetrics));
  await writeJson(paths.manifestPath, {
    contractVersion: `${CONTRACT_VERSION}-manifest`,
    runId,
    generatedAt,
    status: report.status,
    inputs: sweepReportPaths,
    baselines: report.baselines,
    artifacts: report.artifacts,
    machine: report.machine
  });

  return report;
}

async function main() {
  const options = parseArgs();
  if (options.help || !options.inputs.length) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }
  const report = await runPaperClaimReport(options);
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: path.dirname(report.artifacts.reportPath),
    claims: report.claims.map((claim) => ({
      dataset: claim.dataset,
      claimClass: claim.claimClass,
      reasons: claim.gate.reasons
    }))
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
