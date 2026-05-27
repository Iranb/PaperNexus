#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_GRAPH_LINK_PREDICTION_TOP_K,
  DETERMINISTIC_HETEROGENEOUS_LINK_PREDICTION_METHOD,
  writeGraphLinkPredictionArtifacts
} from '../src/core/index/graph-link-prediction.js';

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv = []) {
  const parsed = {
    graphPath: '',
    inputPath: '',
    predictionSourcePath: '',
    outputDir: '',
    runId: '',
    model: '',
    method: '',
    topK: DEFAULT_GRAPH_LINK_PREDICTION_TOP_K,
    sourceTypes: [],
    targetTypes: [],
    datasetSource: '',
    licenseScope: '',
    trainingSlice: '',
    timeCutoff: '',
    negativeSamplingPolicy: '',
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--graph-path' || arg === '--graph') {
      parsed.graphPath = next || '';
      index += 1;
    } else if (arg === '--input-path' || arg === '--input') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--prediction-source' || arg === '--prediction-source-path') {
      parsed.predictionSourcePath = next || '';
      index += 1;
    } else if (arg === '--output-dir' || arg === '--output') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--model') {
      parsed.model = next || '';
      index += 1;
    } else if (arg === '--method') {
      parsed.method = next || '';
      index += 1;
    } else if (arg === '--top-k') {
      parsed.topK = parseInteger(next, DEFAULT_GRAPH_LINK_PREDICTION_TOP_K);
      index += 1;
    } else if (arg === '--source-types') {
      parsed.sourceTypes = parseCsv(next);
      index += 1;
    } else if (arg === '--target-types') {
      parsed.targetTypes = parseCsv(next);
      index += 1;
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--training-slice') {
      parsed.trainingSlice = next || '';
      index += 1;
    } else if (arg === '--time-cutoff') {
      parsed.timeCutoff = next || '';
      index += 1;
    } else if (arg === '--negative-sampling-policy') {
      parsed.negativeSamplingPolicy = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-graph-link-prediction.mjs --graph-path FILE --output-dir DIR [options]',
    '',
    'Builds a graph link-prediction sidecar artifact for bridge reranking experiments.',
    'The default backend is a deterministic heterogeneous topology/text scorer. It is a contract placeholder, not GNN/OAG/OpenAlex release evidence.',
    '',
    'Options:',
    '  --graph-path FILE                  Graph snapshot JSON containing graph.nodes and graph.relationships',
    '  --input-path FILE                  Alias for --graph-path',
    '  --prediction-source FILE           Optional external JSON/JSONL predicted edges from a GNN/link-prediction sidecar',
    '  --output-dir DIR                   Output directory for predicted-bridge-edges.json, bridge-rerank-signals.json, manifest.json',
    '  --run-id ID                        Stable run id',
    '  --model NAME                       Model name; default deterministic-heterogeneous-link-prediction',
    `  --method NAME                      Method name; default ${DETERMINISTIC_HETEROGENEOUS_LINK_PREDICTION_METHOD}`,
    `  --top-k N                          Predicted edges to keep; default ${DEFAULT_GRAPH_LINK_PREDICTION_TOP_K}`,
    '  --source-types CSV                 Optional source node-type allowlist',
    '  --target-types CSV                 Optional target node-type allowlist',
    '  --dataset-source TEXT              Dataset/provenance source for release-gate manifests',
    '  --license-scope TEXT               License scope for the graph snapshot / predictions',
    '  --training-slice TEXT              Training slice id, date range, or snapshot id',
    '  --time-cutoff TEXT                 Temporal cutoff used to avoid future leakage',
    '  --negative-sampling-policy TEXT    Negative sampling policy used by the external sidecar'
  ].join('\n');
}

export async function prepareGraphLinkPredictionCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  const inputPath = args.graphPath || args.inputPath;
  if (!inputPath) throw new Error('--graph-path or --input-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const result = await writeGraphLinkPredictionArtifacts({
    inputPath,
    outputDir: args.outputDir,
    predictionSourcePath: args.predictionSourcePath || undefined,
    runId: args.runId || undefined,
    model: args.model || undefined,
    method: args.method || undefined,
    topK: args.topK,
    sourceTypes: args.sourceTypes,
    targetTypes: args.targetTypes,
    datasetSource: args.datasetSource || undefined,
    licenseScope: args.licenseScope || undefined,
    trainingSlice: args.trainingSlice || undefined,
    timeCutoff: args.timeCutoff || undefined,
    negativeSamplingPolicy: args.negativeSamplingPolicy || undefined
  });
  return result.manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareGraphLinkPredictionCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
