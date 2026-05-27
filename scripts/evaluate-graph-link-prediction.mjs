#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K,
  writeGraphLinkPredictionEvalArtifacts
} from '../src/core/eval/graph-link-prediction-eval.js';

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback = DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = []) {
  const parsed = {
    predictedBridgeEdgesPath: '',
    goldTemporalEdgesPath: '',
    benchmarkMetadataPath: '',
    outputDir: '',
    runId: '',
    benchmarkName: '',
    benchmarkFormat: '',
    datasetSource: '',
    licenseScope: '',
    model: '',
    method: '',
    timeCutoff: '',
    trainingSlice: '',
    negativeSamplingPolicy: '',
    topK: DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K,
    minHitsAt10: 0.5,
    minMrr: 0.1,
    minAucLikePairAccuracy: 0.5,
    maxFutureLeakageCount: 0,
    releaseEvidence: false,
    requirePassed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--predicted-bridge-edges' || arg === '--predictions-path' || arg === '--predictions') {
      parsed.predictedBridgeEdgesPath = next || '';
      index += 1;
    } else if (arg === '--gold-temporal-edges' || arg === '--gold-path' || arg === '--benchmark-path') {
      parsed.goldTemporalEdgesPath = next || '';
      index += 1;
    } else if (arg === '--benchmark-metadata') {
      parsed.benchmarkMetadataPath = next || '';
      index += 1;
    } else if (arg === '--output-dir' || arg === '--output') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--benchmark-name') {
      parsed.benchmarkName = next || '';
      index += 1;
    } else if (arg === '--benchmark-format') {
      parsed.benchmarkFormat = next || '';
      index += 1;
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--model') {
      parsed.model = next || '';
      index += 1;
    } else if (arg === '--method') {
      parsed.method = next || '';
      index += 1;
    } else if (arg === '--time-cutoff') {
      parsed.timeCutoff = next || '';
      index += 1;
    } else if (arg === '--training-slice') {
      parsed.trainingSlice = next || '';
      index += 1;
    } else if (arg === '--negative-sampling-policy') {
      parsed.negativeSamplingPolicy = next || '';
      index += 1;
    } else if (arg === '--top-k' || arg === '-k') {
      parsed.topK = parseInteger(next, DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K);
      index += 1;
    } else if (arg === '--min-hits-at-10') {
      parsed.minHitsAt10 = parseNumber(next, 0.5);
      index += 1;
    } else if (arg === '--min-mrr') {
      parsed.minMrr = parseNumber(next, 0.1);
      index += 1;
    } else if (arg === '--min-auc-like-pair-accuracy') {
      parsed.minAucLikePairAccuracy = parseNumber(next, 0.5);
      index += 1;
    } else if (arg === '--max-future-leakage-count') {
      parsed.maxFutureLeakageCount = parseNumber(next, 0);
      index += 1;
    } else if (arg === '--release-evidence') {
      parsed.releaseEvidence = true;
    } else if (arg === '--require-passed') {
      parsed.requirePassed = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/evaluate-graph-link-prediction.mjs --predicted-bridge-edges FILE --gold-temporal-edges FILE --output-dir DIR [options]',
    '',
    'Builds a temporal link-prediction benchmark report for graph bridge reranking sidecars.',
    'The report is release-pass evidence only with --release-evidence, non-fixture provenance, temporal gold edges, and passing thresholds.',
    '',
    'Options:',
    '  --predicted-bridge-edges FILE        predicted-bridge-edges.json from index:graph-link-prediction or an external GNN sidecar',
    '  --gold-temporal-edges FILE          Held-out positive and negative temporal edges',
    '  --benchmark-metadata FILE           Optional JSON with benchmark name/format/source/license_scope/time_cutoff',
    '  --output-dir DIR                    Output directory for graph-link-prediction-eval.json, markdown, and manifest',
    '  --run-id ID                         Stable run id',
    '  --benchmark-name TEXT               Benchmark name',
    '  --benchmark-format TEXT             Benchmark format id',
    '  --dataset-source TEXT               External benchmark source or frozen snapshot URL',
    '  --license-scope TEXT                Dataset/license scope for this run',
    '  --model TEXT                        Sidecar model name',
    '  --method TEXT                       Sidecar method name',
    '  --time-cutoff TEXT                  Training cutoff; held-out positives must be after this cutoff',
    '  --training-slice TEXT               Training snapshot or date range',
    '  --negative-sampling-policy TEXT     Negative edge sampling policy',
    `  --top-k N                            Ranking cutoff; default ${DEFAULT_GRAPH_LINK_PREDICTION_EVAL_TOP_K}`,
    '  --min-hits-at-10 NUMBER             Required Hits@10; default 0.5',
    '  --min-mrr NUMBER                    Required MRR; default 0.1',
    '  --min-auc-like-pair-accuracy NUMBER Required positive-vs-negative pair accuracy; default 0.5',
    '  --max-future-leakage-count NUMBER   Maximum allowed leakage count; default 0',
    '  --release-evidence                  Allow status=passed when gates and provenance pass',
    '  --require-passed                    Exit non-zero unless report status is passed'
  ].join('\n');
}

export async function evaluateGraphLinkPredictionCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.predictedBridgeEdgesPath) throw new Error('--predicted-bridge-edges is required.');
  if (!args.goldTemporalEdgesPath) throw new Error('--gold-temporal-edges is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const result = await writeGraphLinkPredictionEvalArtifacts({
    predictedBridgeEdgesPath: args.predictedBridgeEdgesPath,
    goldTemporalEdgesPath: args.goldTemporalEdgesPath,
    benchmarkMetadataPath: args.benchmarkMetadataPath || undefined,
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    benchmarkName: args.benchmarkName || undefined,
    benchmarkFormat: args.benchmarkFormat || undefined,
    datasetSource: args.datasetSource || undefined,
    licenseScope: args.licenseScope || undefined,
    model: args.model || undefined,
    method: args.method || undefined,
    timeCutoff: args.timeCutoff || undefined,
    trainingSlice: args.trainingSlice || undefined,
    negativeSamplingPolicy: args.negativeSamplingPolicy || undefined,
    topK: args.topK,
    minHitsAt10: args.minHitsAt10,
    minMrr: args.minMrr,
    minAucLikePairAccuracy: args.minAucLikePairAccuracy,
    maxFutureLeakageCount: args.maxFutureLeakageCount,
    releaseEvidence: args.releaseEvidence
  });
  return {
    ...result.manifest,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  evaluateGraphLinkPredictionCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        const { requirePassed, ...payload } = result;
        console.log(JSON.stringify(payload, null, 2));
        if (requirePassed && payload.status !== 'passed') {
          process.exitCode = 1;
        }
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
