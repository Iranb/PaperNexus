#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readJson } from '../src/lib/fs.js';
import {
  DEFAULT_IDEA_CATALYST_ABLATIONS,
  runIdeaCatalystAblationSuite
} from '../src/core/eval/ablation-runner.js';

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
    thresholdsRaw: '',
    ablations: [],
    requirePassed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--dataset-path' || arg === '--input-path') {
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
    } else if (arg === '--ablations') {
      parsed.ablations = parseList(next).map((id) => ({ id }));
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
    'Usage: node scripts/run-idea-catalyst-ablation-suite.mjs --dataset-path replay.json --output-dir DIR [options]',
    '',
    'Options:',
    '  --run-id ID               Stable run id for artifacts',
    '  --cutoffs 5,10,20         Must-cite / bridge-rerank Recall@K cutoffs',
    '  --primary-cutoff 20       K used by replay and release-gate metrics',
    '  --thresholds-json JSON    Inline JSON thresholds or @path/to/thresholds.json',
    '  --ablations LIST          Comma list; defaults to the full report-required suite',
    '  --require-passed          Exit non-zero unless the ablation suite status is passed',
    '',
    `Default ablations: ${DEFAULT_IDEA_CATALYST_ABLATIONS.map((entry) => entry.id).join(', ')}`
  ].join('\n');
}

export async function runIdeaCatalystAblationSuiteCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.datasetPath) throw new Error('--dataset-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const thresholds = await parseThresholds(args.thresholdsRaw);
  const manifest = await runIdeaCatalystAblationSuite({
    datasetPath: args.datasetPath,
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    cutoffs: args.cutoffs.length ? args.cutoffs : undefined,
    primaryCutoff: Number.isFinite(args.primaryCutoff) ? args.primaryCutoff : undefined,
    thresholds,
    ablations: args.ablations.length ? args.ablations : undefined
  });
  return {
    ...manifest,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIdeaCatalystAblationSuiteCli()
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
