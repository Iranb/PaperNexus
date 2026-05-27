import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const GRAPH_LINK_PREDICTION_EVAL_VERSION = 'papernexus-graph-link-prediction-eval-v1';
export const GRAPH_LINK_PREDICTION_EVAL_MANIFEST_VERSION = 'papernexus-graph-link-prediction-eval-manifest-v1';
export const DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K = 10;

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test)\b/i;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function roundMetric(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : 0;
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return roundMetric(Math.max(0, Math.min(1, numeric)));
}

function normalizePositiveInteger(value, fallback = DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeThreshold(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sha256Text(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value = {}) {
  return JSON.stringify(value);
}

function edgePair(sourceId = '', targetId = '') {
  return `${compactText(sourceId)}->${compactText(targetId)}`;
}

function predictionRows(input = {}) {
  const root = asObject(input);
  return [
    root.predicted_edges,
    root.predictedEdges,
    root.predictions,
    root.edges,
    root.links,
    Array.isArray(input) ? input : null
  ].find(Array.isArray) || [];
}

function normalizePrediction(record = {}, index = 0) {
  const sourceId = compactText(pickFirst(record.source_id, record.sourceId, record.source, record.from));
  const targetId = compactText(pickFirst(record.target_id, record.targetId, record.target, record.to));
  return {
    prediction_id: compactText(pickFirst(record.prediction_id, record.predictionId, record.id, `prediction:${stableHash(`${sourceId}->${targetId}:${index}`, 10)}`)),
    source_id: sourceId,
    target_id: targetId,
    predicted_edge_type: compactText(pickFirst(record.predicted_edge_type, record.predictedEdgeType, record.edge_type, record.edgeType, record.type, 'PREDICTED_BRIDGE')),
    score: normalizeScore(record.score ?? record.probability ?? record.confidence, 0),
    supplied_rank: Number.isFinite(Number(record.rank)) ? Number(record.rank) : null,
    evidence: asObject(record.evidence)
  };
}

export function normalizeGraphLinkPredictionPredictions(input = {}) {
  const rows = predictionRows(input).map(normalizePrediction)
    .filter((entry) => entry.source_id && entry.target_id);
  const sorted = rows.sort((left, right) => (
    Number(right.score) - Number(left.score)
    || Number(left.supplied_rank || Number.MAX_SAFE_INTEGER) - Number(right.supplied_rank || Number.MAX_SAFE_INTEGER)
    || left.source_id.localeCompare(right.source_id)
    || left.target_id.localeCompare(right.target_id)
  ));
  const byPair = new Map();
  for (const row of sorted) {
    const pair = edgePair(row.source_id, row.target_id);
    if (byPair.has(pair)) continue;
    byPair.set(pair, row);
  }
  return [...byPair.values()].map((row, index) => ({
    ...row,
    rank: index + 1,
    pair: edgePair(row.source_id, row.target_id)
  }));
}

function labeledGoldRows(input = {}, positive = true) {
  const root = asObject(input);
  const rows = [
    root.edges,
    root.links,
    root.items,
    Array.isArray(input) ? input : null
  ].find(Array.isArray) || [];
  return rows.filter((row = {}) => {
    const label = pickFirst(row.label, row.y, row.is_positive, row.isPositive, row.positive, row.target);
    if (label === undefined || label === null || label === '') return false;
    if (typeof label === 'boolean') return label === positive;
    const normalized = compactText(label).toLowerCase();
    return positive
      ? ['1', 'true', 'positive', 'pos', 'heldout_positive'].includes(normalized)
      : ['0', 'false', 'negative', 'neg', 'non_edge'].includes(normalized);
  });
}

function positiveGoldRows(input = {}) {
  const root = asObject(input);
  const explicit = [
    root.heldout_positive_edges,
    root.heldoutPositiveEdges,
    root.positive_edges,
    root.positiveEdges,
    root.test_positive_edges,
    root.testPositiveEdges,
    root.positives
  ].find(Array.isArray);
  return explicit || labeledGoldRows(input, true);
}

function negativeGoldRows(input = {}) {
  const root = asObject(input);
  const explicit = [
    root.negative_edges,
    root.negativeEdges,
    root.test_negative_edges,
    root.testNegativeEdges,
    root.negatives
  ].find(Array.isArray);
  return explicit || labeledGoldRows(input, false);
}

function extractYear(value = '') {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    return numeric >= 1000 && numeric <= 3000 ? Math.trunc(numeric) : null;
  }
  const match = String(value).match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeGoldEdge(record = {}, index = 0, label = 'positive') {
  const properties = asObject(record.properties);
  const sourceId = compactText(pickFirst(record.source_id, record.sourceId, record.source, record.from, properties.source_id, properties.sourceId));
  const targetId = compactText(pickFirst(record.target_id, record.targetId, record.target, record.to, properties.target_id, properties.targetId));
  const observedAt = compactText(pickFirst(
    record.observed_at,
    record.observedAt,
    record.published_at,
    record.publishedAt,
    record.date,
    record.year,
    properties.observed_at,
    properties.observedAt,
    properties.year
  ));
  return {
    edge_id: compactText(pickFirst(record.edge_id, record.edgeId, record.id, `${label}:${stableHash(`${sourceId}->${targetId}:${index}`, 10)}`)),
    source_id: sourceId,
    target_id: targetId,
    pair: edgePair(sourceId, targetId),
    label,
    observed_at: observedAt || null,
    observed_year: extractYear(observedAt),
    edge_type: compactText(pickFirst(record.edge_type, record.edgeType, record.type, properties.edge_type, properties.edgeType, 'LINK'))
  };
}

export function normalizeGraphLinkPredictionGold(input = {}) {
  const positives = positiveGoldRows(input).map((row, index) => normalizeGoldEdge(row, index, 'positive'))
    .filter((entry) => entry.source_id && entry.target_id);
  const negatives = negativeGoldRows(input).map((row, index) => normalizeGoldEdge(row, index, 'negative'))
    .filter((entry) => entry.source_id && entry.target_id);
  return { positives, negatives };
}

function mean(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function predictionIndex(predictions = []) {
  const byPair = new Map();
  for (const row of predictions) {
    byPair.set(row.pair, row);
  }
  return byPair;
}

function temporalDiagnostics(positives = [], timeCutoff = '') {
  const cutoffYear = extractYear(timeCutoff);
  let futureLeakageCount = 0;
  let undatedPositiveCount = 0;
  for (const edge of positives) {
    if (!edge.observed_year) {
      undatedPositiveCount += 1;
    } else if (cutoffYear && edge.observed_year <= cutoffYear) {
      futureLeakageCount += 1;
    }
  }
  return {
    cutoffYear,
    futureLeakageCount,
    undatedPositiveCount
  };
}

function evaluateRanking(predictions = [], positives = [], negatives = [], topK = DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K) {
  const byPair = predictionIndex(predictions);
  const positiveRanks = positives.map((edge) => byPair.get(edge.pair)?.rank || Number.POSITIVE_INFINITY);
  const positiveScores = positives.map((edge) => byPair.get(edge.pair)?.score || 0);
  const negativeScores = negatives.map((edge) => byPair.get(edge.pair)?.score || 0);
  const hitsAt1 = positives.length ? positiveRanks.filter((rank) => rank <= 1).length / positives.length : 0;
  const hitsAtK = positives.length ? positiveRanks.filter((rank) => rank <= topK).length / positives.length : 0;
  const mrr = positives.length ? mean(positiveRanks.map((rank) => Number.isFinite(rank) ? 1 / rank : 0)) : 0;
  let pairComparisons = 0;
  let pairWins = 0;
  for (const positiveScore of positiveScores) {
    for (const negativeScore of negativeScores) {
      pairComparisons += 1;
      if (positiveScore > negativeScore) pairWins += 1;
      else if (positiveScore === negativeScore) pairWins += 0.5;
    }
  }
  return {
    hits_at_1: roundMetric(hitsAt1),
    [`hits_at_${topK}`]: roundMetric(hitsAtK),
    hits_at_10: roundMetric(topK === 10 ? hitsAtK : (positives.length ? positiveRanks.filter((rank) => rank <= 10).length / positives.length : 0)),
    mrr: roundMetric(mrr),
    auc_like_pair_accuracy: roundMetric(pairComparisons ? pairWins / pairComparisons : 0),
    pair_comparison_count: pairComparisons,
    missing_positive_prediction_count: positiveRanks.filter((rank) => !Number.isFinite(rank)).length
  };
}

function thresholdsFromOptions(options = {}) {
  return {
    min_hits_at_10: normalizeThreshold(options.minHitsAt10 ?? options.min_hits_at_10, 0.5),
    min_mrr: normalizeThreshold(options.minMrr ?? options.min_mrr, 0.1),
    min_auc_like_pair_accuracy: normalizeThreshold(options.minAucLikePairAccuracy ?? options.min_auc_like_pair_accuracy, 0.5),
    max_future_leakage_count: normalizeThreshold(options.maxFutureLeakageCount ?? options.max_future_leakage_count, 0)
  };
}

function releaseMetadata(options = {}, predictionsInput = {}, goldInput = {}, inputs = []) {
  const predictedRoot = asObject(predictionsInput);
  const predictedMetadata = asObject(predictedRoot.metadata);
  const goldRoot = asObject(goldInput);
  const goldMetadata = asObject(goldRoot.metadata || goldRoot.benchmark);
  const benchmark = asObject(options.benchmark || options.benchmarkMetadata || options.benchmark_metadata);
  const name = compactText(options.benchmarkName || options.benchmark_name || benchmark.name || goldMetadata.name || 'OAG OpenAlex temporal link prediction');
  const format = compactText(options.benchmarkFormat || options.benchmark_format || benchmark.format || goldMetadata.format || 'temporal-link-prediction');
  const source = compactText(options.datasetSource || options.dataset_source || benchmark.source || goldMetadata.source || predictedMetadata.datasetSource || predictedRoot.datasetSource);
  const licenseScope = compactText(options.licenseScope || options.license_scope || benchmark.license_scope || benchmark.licenseScope || goldMetadata.license_scope || goldMetadata.licenseScope || predictedMetadata.licenseScope || predictedRoot.licenseScope);
  const model = compactText(options.model || predictedRoot.model || benchmark.model || goldMetadata.model || 'graph-link-prediction-sidecar');
  const method = compactText(options.method || predictedRoot.method || benchmark.method || goldMetadata.method || 'external-temporal-link-prediction');
  const timeCutoff = compactText(options.timeCutoff || options.time_cutoff || benchmark.time_cutoff || benchmark.timeCutoff || goldMetadata.time_cutoff || goldMetadata.timeCutoff || predictedRoot.timeCutoff || predictedRoot.time_cutoff);
  const trainingSlice = compactText(options.trainingSlice || options.training_slice || benchmark.training_slice || benchmark.trainingSlice || goldMetadata.training_slice || goldMetadata.trainingSlice || predictedRoot.trainingSlice || predictedRoot.training_slice);
  const negativeSamplingPolicy = compactText(options.negativeSamplingPolicy || options.negative_sampling_policy || benchmark.negative_sampling_policy || benchmark.negativeSamplingPolicy || goldMetadata.negative_sampling_policy || goldMetadata.negativeSamplingPolicy || predictedRoot.negativeSamplingPolicy || predictedRoot.negative_sampling_policy);
  const releaseEvidence = Boolean(options.releaseEvidence || options.release_evidence);
  const hasInputHash = inputs.some((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
  const missing = [];
  if (!source) missing.push('dataset_source');
  if (!licenseScope) missing.push('license_scope');
  if (!model) missing.push('model');
  if (!timeCutoff) missing.push('time_cutoff');
  if (!trainingSlice) missing.push('training_slice');
  if (!negativeSamplingPolicy) missing.push('negative_sampling_policy');
  if (!hasInputHash) missing.push('input_sha256');
  if (!releaseEvidence) missing.push('release_evidence_flag');
  const fixtureText = [name, format, source, licenseScope, model, method, trainingSlice, negativeSamplingPolicy].join(' ');
  return {
    benchmark: {
      name,
      format,
      source: source || null,
      license_scope: licenseScope || null
    },
    model,
    method,
    timeCutoff,
    trainingSlice,
    negativeSamplingPolicy,
    releaseEvidence,
    status: missing.length ? 'incomplete' : (FIXTURE_MARKERS.test(fixtureText) ? 'incomplete' : 'passed'),
    reason: missing.length ? `missing_${missing.join('_')}` : (FIXTURE_MARKERS.test(fixtureText) ? 'fixture_or_synthetic_evidence' : 'release_provenance_complete'),
    missing
  };
}

function gate(name, label, status, metrics = {}, message = '') {
  return {
    name,
    label,
    status,
    ok: status === 'passed',
    metrics,
    message
  };
}

function buildGates(metrics = {}, diagnostics = {}, thresholds = {}, metadata = {}) {
  const gates = [];
  const hasGold = metrics.positive_edge_count > 0 && metrics.negative_edge_count > 0;
  gates.push(gate(
    'temporal_gold_edges_present',
    'Held-out positive and negative temporal edges are present',
    hasGold ? 'passed' : 'incomplete',
    {
      positive_edge_count: metrics.positive_edge_count,
      negative_edge_count: metrics.negative_edge_count
    },
    hasGold ? '' : 'missing held-out positives or sampled negatives'
  ));
  let temporalStatus = 'passed';
  let temporalMessage = '';
  if (!metadata.timeCutoff) {
    temporalStatus = 'incomplete';
    temporalMessage = 'missing time cutoff';
  } else if (diagnostics.futureLeakageCount > thresholds.max_future_leakage_count) {
    temporalStatus = 'failed';
    temporalMessage = 'held-out positives are not strictly after the cutoff';
  } else if (diagnostics.undatedPositiveCount > 0) {
    temporalStatus = 'incomplete';
    temporalMessage = 'held-out positives need observed dates for temporal audit';
  }
  gates.push(gate(
    'temporal_split_clean',
    'Held-out positives are dated after the training cutoff',
    temporalStatus,
    {
      time_cutoff: metadata.timeCutoff || null,
      cutoff_year: diagnostics.cutoffYear,
      future_leakage_count: diagnostics.futureLeakageCount,
      undated_positive_count: diagnostics.undatedPositiveCount,
      max_future_leakage_count: thresholds.max_future_leakage_count
    },
    temporalMessage
  ));
  const qualityPass = metrics.hits_at_10 >= thresholds.min_hits_at_10
    && metrics.mrr >= thresholds.min_mrr
    && metrics.auc_like_pair_accuracy >= thresholds.min_auc_like_pair_accuracy;
  gates.push(gate(
    'link_prediction_quality',
    'Temporal link-prediction metrics meet configured thresholds',
    hasGold ? (qualityPass ? 'passed' : 'failed') : 'incomplete',
    {
      hits_at_10: metrics.hits_at_10,
      mrr: metrics.mrr,
      auc_like_pair_accuracy: metrics.auc_like_pair_accuracy,
      min_hits_at_10: thresholds.min_hits_at_10,
      min_mrr: thresholds.min_mrr,
      min_auc_like_pair_accuracy: thresholds.min_auc_like_pair_accuracy
    },
    qualityPass ? '' : 'link-prediction metrics are below threshold'
  ));
  gates.push(gate(
    'negative_sampling_declared',
    'Negative sampling policy is explicit',
    metadata.negativeSamplingPolicy ? 'passed' : 'incomplete',
    { negative_sampling_policy: metadata.negativeSamplingPolicy || null },
    metadata.negativeSamplingPolicy ? '' : 'missing negative sampling policy'
  ));
  gates.push(gate(
    'release_provenance_complete',
    'External benchmark source, license, input hashes, temporal metadata, and release intent are present',
    metadata.status,
    {
      release_evidence: metadata.releaseEvidence,
      missing: metadata.missing
    },
    metadata.reason === 'release_provenance_complete' ? '' : metadata.reason
  ));
  return gates;
}

function statusFromGates(gates = []) {
  if (gates.some((entry) => entry.status === 'failed')) return 'failed';
  if (gates.some((entry) => entry.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

function defaultInputRecords(options = {}) {
  const records = asArray(options.inputs).filter(Boolean);
  if (records.length) return records;
  const inputs = [];
  if (options.predictions) {
    inputs.push({
      role: 'predicted_bridge_edges',
      path: null,
      sha256: sha256Text(stableJson(options.predictions))
    });
  }
  if (options.gold) {
    inputs.push({
      role: 'temporal_gold_edges',
      path: null,
      sha256: sha256Text(stableJson(options.gold))
    });
  }
  return inputs;
}

export function buildGraphLinkPredictionEvalReport(options = {}) {
  const predictionsInput = options.predictedBridgeEdges || options.predicted_bridge_edges || options.predictions || {};
  const goldInput = options.goldTemporalEdges || options.gold_temporal_edges || options.gold || options.benchmarkEdges || {};
  const predictions = normalizeGraphLinkPredictionPredictions(predictionsInput);
  const gold = normalizeGraphLinkPredictionGold(goldInput);
  const inputs = defaultInputRecords({
    inputs: options.inputs,
    predictions: predictionsInput,
    gold: goldInput
  }).filter((entry) => compactText(entry.role));
  const metadata = releaseMetadata(options, predictionsInput, goldInput, inputs);
  const topK = normalizePositiveInteger(options.topK || options.top_k || options.k, DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K);
  const rankingMetrics = evaluateRanking(predictions, gold.positives, gold.negatives, topK);
  const temporal = temporalDiagnostics(gold.positives, metadata.timeCutoff);
  const metrics = {
    positive_edge_count: gold.positives.length,
    negative_edge_count: gold.negatives.length,
    prediction_count: predictions.length,
    ...rankingMetrics,
    future_leakage_count: temporal.futureLeakageCount,
    bridge_rerank_delta: null
  };
  const thresholds = thresholdsFromOptions(options);
  const diagnostics = {
    topK,
    cutoffYear: temporal.cutoffYear,
    futureLeakageCount: temporal.futureLeakageCount,
    undatedPositiveCount: temporal.undatedPositiveCount,
    missingPositivePredictionCount: rankingMetrics.missing_positive_prediction_count
  };
  const gates = buildGates(metrics, diagnostics, thresholds, metadata);
  const status = statusFromGates(gates);
  const generatedAt = compactText(options.generatedAt || options.generated_at || options.createdAt || options.created_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `graph-link-prediction-eval-${stableHash(`${generatedAt}:${metrics.positive_edge_count}:${metrics.prediction_count}`, 10)}`;
  const predictionByPair = predictionIndex(predictions);
  return {
    contractVersion: GRAPH_LINK_PREDICTION_EVAL_VERSION,
    runId,
    generatedAt,
    status,
    benchmark: metadata.benchmark,
    method: metadata.method,
    model: metadata.model,
    timeCutoff: metadata.timeCutoff || null,
    trainingSlice: metadata.trainingSlice || null,
    negativeSamplingPolicy: metadata.negativeSamplingPolicy || null,
    topK,
    thresholds,
    inputs,
    metrics,
    gates,
    diagnostics,
    releaseGate: {
      status,
      reason: status === 'passed' ? 'temporal_link_prediction_release_gates_passed' : gates.find((entry) => entry.status !== 'passed')?.message || 'temporal link-prediction evidence is incomplete',
      notes: status === 'passed'
        ? ['Temporal link-prediction benchmark passed configured thresholds with release provenance.']
        : ['This report is suitable for plumbing and audit, but it is not release-pass evidence until all gates pass.']
    },
    positive_edge_results: gold.positives.map((edge) => {
      const prediction = predictionByPair.get(edge.pair);
      return {
        edge_id: edge.edge_id,
        source_id: edge.source_id,
        target_id: edge.target_id,
        observed_at: edge.observed_at,
        rank: prediction?.rank || null,
        score: prediction?.score ?? 0,
        hit_at_1: Boolean(prediction && prediction.rank <= 1),
        hit_at_10: Boolean(prediction && prediction.rank <= 10)
      };
    })
  };
}

export function renderGraphLinkPredictionEvalMarkdown(report = {}) {
  const lines = [
    `# Graph Link Prediction Eval: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Benchmark',
    '',
    `- name: ${report.benchmark?.name || ''}`,
    `- format: ${report.benchmark?.format || ''}`,
    `- source: ${report.benchmark?.source || ''}`,
    `- license_scope: ${report.benchmark?.license_scope || ''}`,
    `- model: ${report.model || ''}`,
    `- time_cutoff: ${report.timeCutoff || ''}`,
    `- training_slice: ${report.trainingSlice || ''}`,
    `- negative_sampling_policy: ${report.negativeSamplingPolicy || ''}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---:|'
  ];
  for (const [key, value] of Object.entries(asObject(report.metrics))) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push('', '## Gates', '', '| Gate | Status | Message |', '|---|---:|---|');
  for (const entry of asArray(report.gates)) {
    lines.push(`| ${entry.name} | ${entry.status} | ${entry.message || ''} |`);
  }
  lines.push('', '## Diagnostics', '');
  for (const [key, value] of Object.entries(asObject(report.diagnostics))) {
    lines.push(`- ${key}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolvePath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function readInputRecord(filePath = '', role = '') {
  const absolutePath = resolvePath(filePath);
  if (!absolutePath) return { payload: null, input: null };
  const raw = await fs.readFile(absolutePath, 'utf8');
  return {
    payload: JSON.parse(raw),
    input: {
      role,
      path: absolutePath,
      sha256: sha256Text(raw)
    }
  };
}

async function readJsonMaybe(filePath = '', fallback = null) {
  const absolutePath = resolvePath(filePath);
  if (!absolutePath) return fallback;
  return readJson(absolutePath, fallback);
}

export async function prepareGraphLinkPredictionEvalReport(options = {}) {
  const predictionRecord = await readInputRecord(options.predictedBridgeEdgesPath || options.predicted_bridge_edges_path || options.predictionsPath || options.predictions_path || options.predictedPath || options.predicted_path, 'predicted_bridge_edges');
  const goldRecord = await readInputRecord(options.goldTemporalEdgesPath || options.gold_temporal_edges_path || options.goldPath || options.gold_path || options.benchmarkPath || options.benchmark_path, 'temporal_gold_edges');
  return buildGraphLinkPredictionEvalReport({
    ...options,
    predictedBridgeEdges: options.predictedBridgeEdges || predictionRecord.payload || {},
    goldTemporalEdges: options.goldTemporalEdges || goldRecord.payload || {},
    inputs: [
      ...asArray(options.inputs),
      predictionRecord.input,
      goldRecord.input
    ].filter(Boolean),
    benchmark: options.benchmark || await readJsonMaybe(options.benchmarkMetadataPath || options.benchmark_metadata_path, {})
  });
}

export async function writeGraphLinkPredictionEvalArtifacts(options = {}) {
  const outputDir = resolvePath(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const report = await prepareGraphLinkPredictionEvalReport(options);
  const reportJsonPath = path.join(outputDir, 'graph-link-prediction-eval.json');
  const reportMarkdownPath = path.join(outputDir, 'graph-link-prediction-eval.md');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const reportWithArtifacts = {
    ...report,
    artifacts: {
      reportJsonPath,
      reportMarkdownPath,
      manifestPath
    }
  };
  const manifest = {
    contractVersion: GRAPH_LINK_PREDICTION_EVAL_MANIFEST_VERSION,
    generatedBy: GRAPH_LINK_PREDICTION_EVAL_VERSION,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    releaseGateStatus: report.status,
    releaseGate: report.releaseGate,
    benchmark: report.benchmark,
    metrics: report.metrics,
    diagnostics: report.diagnostics,
    artifacts: reportWithArtifacts.artifacts
  };
  await ensureDir(outputDir);
  await writeJson(reportJsonPath, reportWithArtifacts);
  await writeText(reportMarkdownPath, renderGraphLinkPredictionEvalMarkdown(reportWithArtifacts));
  await writeJson(manifestPath, manifest);
  return {
    report: reportWithArtifacts,
    manifest
  };
}
