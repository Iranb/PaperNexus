#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  prepareScientificEmbeddingReleaseEvidence
} from '../src/core/eval/scientific-embedding-release-evidence.js';

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    runId: '',
    scientificEmbeddingManifestPath: '',
    retrievalSuiteReportPath: '',
    requirePassed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--scientific-embedding-manifest') {
      parsed.scientificEmbeddingManifestPath = next || '';
      index += 1;
    } else if (arg === '--retrieval-suite-report') {
      parsed.retrievalSuiteReportPath = next || '';
      index += 1;
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
    'Usage: node scripts/prepare-scientific-embedding-release-evidence.mjs --output-dir DIR [options]',
    '',
    'Wraps a scientific embedding manifest and fixed-corpus retrieval suite report into R4 release evidence.',
    '',
    'Options:',
    '  --scientific-embedding-manifest FILE  manifest.json from index:scientific-embeddings',
    '  --retrieval-suite-report FILE         report.json from run-fixed-corpus-retrieval-suite.mjs',
    '  --output-dir DIR                      Output directory for scientific-embedding-release-evidence.json',
    '  --run-id ID                           Stable run id',
    '  --require-passed                      Exit non-zero unless the release evidence status is passed'
  ].join('\n');
}

export async function prepareScientificEmbeddingReleaseEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const report = await prepareScientificEmbeddingReleaseEvidence({
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    scientificEmbeddingManifestPath: args.scientificEmbeddingManifestPath || undefined,
    retrievalSuiteReportPath: args.retrievalSuiteReportPath || undefined
  });
  return {
    ...report,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareScientificEmbeddingReleaseEvidenceCli()
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
