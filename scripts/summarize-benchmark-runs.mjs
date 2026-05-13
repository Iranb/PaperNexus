#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function usage() {
  return [
    'Usage:',
    '  node scripts/summarize-benchmark-runs.mjs [--label <name>] [--out-dir <dir>] <report.json|run-dir>...',
    '  node scripts/summarize-benchmark-runs.mjs --baseline bm25=base1.json,base2.json <report.json>...',
    '',
    'Outputs summary.tsv and stats.json. Paired tests use common query ids between method and baseline reports.'
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { label: 'method', outDir: process.cwd(), baselines: [], inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--label') {
      args.label = argv[++index] || args.label;
    } else if (arg === '--out-dir' || arg === '--output' || arg === '--output-dir') {
      args.outDir = argv[++index] || args.outDir;
    } else if (arg === '--baseline') {
      args.baselines.push(argv[++index] || '');
    } else if (arg.startsWith('--baseline=')) {
      args.baselines.push(arg.slice('--baseline='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.inputs.push(arg);
    }
  }
  return args;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveReportPaths(inputs = []) {
  const paths = [];
  for (const input of inputs) {
    const absolute = path.resolve(process.cwd(), input);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      const direct = path.join(absolute, 'report.json');
      if (await exists(direct)) {
        paths.push(direct);
        continue;
      }
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(absolute, entry.name, 'report.json');
        if (await exists(nested)) paths.push(nested);
      }
    } else {
      paths.push(absolute);
    }
  }
  return [...new Set(paths)].sort();
}

async function readReports(inputs = []) {
  const paths = await resolveReportPaths(inputs);
  const reports = [];
  for (const reportPath of paths) {
    reports.push({
      path: reportPath,
      report: JSON.parse(await fs.readFile(reportPath, 'utf8'))
    });
  }
  return reports;
}

function mean(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

function std(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (numeric.length < 2) return 0;
  const avg = mean(numeric);
  return Math.sqrt(numeric.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (numeric.length - 1));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-value * value);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function logGamma(z) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.9999999999998099;
  const shifted = z - 1;
  for (let index = 0; index < coefficients.length; index += 1) {
    x += coefficients[index] / (shifted + index + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return (0.5 * Math.log(2 * Math.PI)) + ((shifted + 0.5) * Math.log(t)) - t + Math.log(x);
}

function betacf(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const fpmin = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x / qap);
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < epsilon) break;
  }
  return h;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - ((bt * betacf(b, a, 1 - x)) / b);
}

function studentTCdf(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  const x = df / (df + t * t);
  const ib = regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - (0.5 * ib) : 0.5 * ib;
}

function tCritical95(df) {
  if (df <= 1) return 12.706;
  if (df === 2) return 4.303;
  if (df === 3) return 3.182;
  if (df === 4) return 2.776;
  if (df === 5) return 2.571;
  if (df <= 10) return 2.262;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  return 1.96;
}

function ci95(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return [null, null];
  const avg = mean(numeric);
  if (numeric.length === 1) return [avg, avg];
  const margin = tCritical95(numeric.length - 1) * std(numeric) / Math.sqrt(numeric.length);
  return [avg - margin, avg + margin];
}

function reportMetricValues(report = {}) {
  const metrics = { ...(report.metrics || {}) };
  for (const [key, value] of Object.entries(report.officialMetrics?.metrics || {})) {
    if (value !== null && value !== undefined) metrics[key] = value;
  }
  return metrics;
}

function metricKeys(reports = []) {
  return [...new Set(reports.flatMap(({ report }) => Object.keys(reportMetricValues(report))))].sort();
}

function resultMetricValue(result = {}, metric = '') {
  if (result.metrics?.[metric] !== undefined) return Number(result.metrics[metric] || 0);
  const officialMatch = String(metric).match(/^(broad|specific)_(.+)$/);
  if (!officialMatch) return null;
  const [, slice, baseMetric] = officialMatch;
  if (result.officialSlice !== slice) return null;
  if (result.metrics?.[baseMetric] === undefined) return null;
  return Number(result.metrics[baseMetric] || 0);
}

function perQueryMetricMap(reports = [], metric) {
  const grouped = new Map();
  for (const { report } of reports) {
    for (const result of report.results || []) {
      const key = String(result.queryKey || result.id || result.query || '').trim();
      const value = resultMetricValue(result, metric);
      if (!key || value === null || !Number.isFinite(value)) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(value);
    }
  }
  return new Map([...grouped.entries()].map(([key, values]) => [key, mean(values)]));
}

function pairedTTest(methodReports = [], baselineReports = [], metric) {
  const method = perQueryMetricMap(methodReports, metric);
  const baseline = perQueryMetricMap(baselineReports, metric);
  const pairs = [...method.keys()]
    .filter((key) => baseline.has(key))
    .map((key) => method.get(key) - baseline.get(key));
  if (pairs.length < 2) {
    return { n: pairs.length, meanDiff: pairs[0] ?? null, t: null, df: null, p: null, effectSizeDz: null };
  }
  const avg = mean(pairs);
  const spread = std(pairs);
  const t = spread ? avg / (spread / Math.sqrt(pairs.length)) : 0;
  const df = pairs.length - 1;
  const cdf = studentTCdf(Math.abs(t), df);
  const p = cdf === null ? null : Math.max(0, Math.min(1, 2 * (1 - cdf)));
  return {
    n: pairs.length,
    meanDiff: avg,
    t,
    df,
    p,
    effectSizeDz: spread ? avg / spread : 0
  };
}

function formatNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? ''
    : Number(value).toFixed(6);
}

function parseBaselineSpec(spec = '') {
  const [label, rawPaths] = spec.includes('=') ? spec.split(/=(.*)/s) : ['baseline', spec];
  return {
    label: label || 'baseline',
    inputs: String(rawPaths || '').split(',').map((entry) => entry.trim()).filter(Boolean)
  };
}

async function main() {
  const args = parseArgs();
  if (args.help || !args.inputs.length) {
    console.log(usage());
    process.exit(args.help ? 0 : 1);
  }

  const methodReports = await readReports(args.inputs);
  const baselines = [];
  for (const spec of args.baselines) {
    const parsed = parseBaselineSpec(spec);
    baselines.push({
      label: parsed.label,
      reports: await readReports(parsed.inputs)
    });
  }

  const keys = metricKeys(methodReports);
  const summary = keys.map((metric) => {
    const values = methodReports.map(({ report }) => Number(reportMetricValues(report)[metric] || 0));
    const [low, high] = ci95(values);
    const row = {
      method: args.label,
      metric,
      n: values.length,
      mean: mean(values),
      std: std(values),
      ci95Low: low,
      ci95High: high,
      comparisons: {}
    };
    for (const baseline of baselines) {
      row.comparisons[baseline.label] = pairedTTest(methodReports, baseline.reports, metric);
    }
    return row;
  });

  await fs.mkdir(path.resolve(args.outDir), { recursive: true });
  const statsPath = path.resolve(args.outDir, 'stats.json');
  const summaryPath = path.resolve(args.outDir, 'summary.tsv');
  await fs.writeFile(statsPath, `${JSON.stringify({
    contractVersion: 'papernexus-benchmark-stats-v1',
    generatedAt: new Date().toISOString(),
    method: args.label,
    reports: methodReports.map((entry) => entry.path),
    baselines: baselines.map((baseline) => ({
      label: baseline.label,
      reports: baseline.reports.map((entry) => entry.path)
    })),
    metrics: summary
  }, null, 2)}\n`);

  const lines = [[
    'method',
    'metric',
    'n',
    'mean',
    'std',
    'ci95_low',
    'ci95_high',
    'baseline',
    'paired_n',
    'paired_t',
    'paired_df',
    'paired_p',
    'effect_size_dz'
  ].join('\t')];
  for (const row of summary) {
    const comparisonEntries = Object.entries(row.comparisons);
    if (!comparisonEntries.length) comparisonEntries.push(['', {}]);
    for (const [baselineLabel, comparison] of comparisonEntries) {
      lines.push([
        row.method,
        row.metric,
        row.n,
        formatNumber(row.mean),
        formatNumber(row.std),
        formatNumber(row.ci95Low),
        formatNumber(row.ci95High),
        baselineLabel,
        comparison.n ?? '',
        formatNumber(comparison.t),
        comparison.df ?? '',
        formatNumber(comparison.p),
        formatNumber(comparison.effectSizeDz)
      ].join('\t'));
    }
  }
  await fs.writeFile(summaryPath, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ statsPath, summaryPath, metricCount: summary.length }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
