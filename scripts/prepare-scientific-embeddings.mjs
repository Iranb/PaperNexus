#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION,
  DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K,
  DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD,
  writeScientificEmbeddingArtifacts
} from '../src/core/index/scientific-embeddings.js';

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = []) {
  const parsed = {
    benchmarkPath: '',
    inputPath: '',
    embeddingSourcePath: '',
    outputDir: '',
    runId: '',
    model: '',
    method: '',
    dimension: DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION,
    topK: DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K,
    datasetSource: '',
    licenseScope: '',
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--benchmark-path' || arg === '--benchmark') {
      parsed.benchmarkPath = next || '';
      index += 1;
    } else if (arg === '--input-path' || arg === '--input') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--embedding-source' || arg === '--embedding-source-path') {
      parsed.embeddingSourcePath = next || '';
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
    } else if (arg === '--dimension') {
      parsed.dimension = parseInteger(next, DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION);
      index += 1;
    } else if (arg === '--top-k') {
      parsed.topK = parseInteger(next, DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K);
      index += 1;
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-scientific-embeddings.mjs --benchmark-path FILE --output-dir DIR [options]',
    '',
    'Builds a scientific embedding sidecar artifact for fixed-corpus retrieval benchmarks.',
    'The default backend is deterministic token hashing. It is a contract placeholder, not SPECTER2/SciRepEval release evidence.',
    '',
    'Options:',
    '  --benchmark-path FILE              Benchmark/input JSON containing corpus[] and queries[]',
    '  --input-path FILE                  Alias for --benchmark-path',
    '  --embedding-source FILE            Optional external JSON/JSONL embedding vectors',
    '  --output-dir DIR                   Output directory for dense-scores.json, embedding-index.json, manifest.json',
    '  --run-id ID                        Stable run id',
    `  --model NAME                       Model name; default deterministic-scientific-token-hash`,
    `  --method NAME                      Method name; default ${DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD}`,
    `  --dimension N                      Embedding dimension; default ${DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION}`,
    `  --top-k N                          Rankings per query; default ${DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K}`,
    '  --dataset-source TEXT              Dataset/provenance source for release-gate manifests',
    '  --license-scope TEXT               License scope for the input/embedding source'
  ].join('\n');
}

export async function prepareScientificEmbeddingsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  const inputPath = args.benchmarkPath || args.inputPath;
  if (!inputPath) throw new Error('--benchmark-path or --input-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const result = await writeScientificEmbeddingArtifacts({
    inputPath,
    outputDir: args.outputDir,
    embeddingSourcePath: args.embeddingSourcePath || undefined,
    runId: args.runId || undefined,
    model: args.model || undefined,
    method: args.method || undefined,
    dimension: args.dimension,
    topK: args.topK,
    datasetSource: args.datasetSource || undefined,
    licenseScope: args.licenseScope || undefined
  });
  return result.manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareScientificEmbeddingsCli()
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
