#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readJson } from '../src/lib/fs.js';
import { runIdeaCatalystHistoricalReplay } from '../src/core/eval/historical-replay.js';

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function parseThresholds(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return {};
  if (raw.startsWith('@')) return readJson(raw.slice(1), {});
  return JSON.parse(raw);
}

function parseArgs(argv = []) {
  const parsed = {
    datasetPath: '',
    outputDir: '',
    runId: '',
    cutoffs: [],
    primaryCutoff: null,
    thresholdsRaw: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--dataset-path') {
      parsed.datasetPath = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--cutoffs') {
      parsed.cutoffs = parseList(next).map(Number).filter(Number.isFinite);
      index += 1;
    } else if (arg === '--primary-cutoff') {
      parsed.primaryCutoff = Number(next);
      index += 1;
    } else if (arg === '--thresholds-json') {
      parsed.thresholdsRaw = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/run-idea-catalyst-historical-replay.mjs --dataset-path replay.json [options]',
    '',
    'Options:',
    '  --output-dir DIR          Write report.json, report.md, summary.tsv, manifest.json',
    '  --run-id ID               Stable run id for artifacts',
    '  --cutoffs 5,10,20         Must-cite Recall@K cutoffs',
    '  --primary-cutoff 20       K used by release gate',
    '  --thresholds-json JSON    Inline JSON thresholds or @path/to/thresholds.json'
  ].join('\n');
}

export async function runIdeaCatalystHistoricalReplayCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    return {
      help: usage()
    };
  }
  if (!args.datasetPath) {
    throw new Error('--dataset-path is required.');
  }
  const thresholds = await parseThresholds(args.thresholdsRaw);
  return runIdeaCatalystHistoricalReplay({
    datasetPath: args.datasetPath,
    outputDir: args.outputDir || undefined,
    runId: args.runId || undefined,
    cutoffs: args.cutoffs.length ? args.cutoffs : undefined,
    primaryCutoff: Number.isFinite(args.primaryCutoff) ? args.primaryCutoff : undefined,
    thresholds
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIdeaCatalystHistoricalReplayCli()
    .then((report) => {
      if (report.help) {
        console.log(report.help);
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
