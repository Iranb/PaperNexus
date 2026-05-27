#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readJson } from '../src/lib/fs.js';
import { prepareHumanBlindEvaluation } from '../src/core/eval/human-blind-eval.js';

function parseArgs(argv = []) {
  const parsed = {
    inputPath: '',
    outputDir: '',
    labelsPath: '',
    name: '',
    runId: '',
    seed: '',
    targetSystem: '',
    requiredRolesRaw: '',
    preferenceThreshold: null,
    requirePassed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input-path') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--labels-path') {
      parsed.labelsPath = next || '';
      index += 1;
    } else if (arg === '--name') {
      parsed.name = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--seed') {
      parsed.seed = next || '';
      index += 1;
    } else if (arg === '--target-system') {
      parsed.targetSystem = next || '';
      index += 1;
    } else if (arg === '--required-roles-json') {
      parsed.requiredRolesRaw = next || '';
      index += 1;
    } else if (arg === '--preference-threshold') {
      parsed.preferenceThreshold = Number(next);
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
    'Usage: node scripts/prepare-human-blind-eval.mjs --input-path cases.json --output-dir DIR [options]',
    '',
    'Input cases may provide systems/variants/packets, or baseline/candidate/p0/p1 packet fields per case.',
    '',
    'Options:',
    '  --labels-path FILE            Optional completed review labels to aggregate',
    '  --name NAME                   Dataset or run display name',
    '  --run-id ID                   Stable run id for artifacts',
    '  --seed TEXT                   Deterministic left/right randomization seed',
    '  --target-system KEY           System key used for preference gate, default candidate',
    '  --required-roles-json JSON    Inline JSON or @path mapping roles to required counts',
    '  --preference-threshold N      Pass threshold for target preference, default 0.6',
    '  --require-passed              Exit non-zero unless aggregation status is passed'
  ].join('\n');
}

async function parseRequiredRoles(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return {};
  if (raw.startsWith('@')) return readJson(raw.slice(1), {});
  return JSON.parse(raw);
}

export async function prepareHumanBlindEvalCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.inputPath) throw new Error('--input-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const requiredRoleCounts = await parseRequiredRoles(args.requiredRolesRaw);
  const result = await prepareHumanBlindEvaluation({
    inputPath: args.inputPath,
    outputDir: args.outputDir,
    labelsPath: args.labelsPath,
    name: args.name || undefined,
    runId: args.runId || undefined,
    seed: args.seed || undefined,
    targetSystem: args.targetSystem || undefined,
    requiredRoleCounts: Object.keys(requiredRoleCounts).length ? requiredRoleCounts : undefined,
    preferenceThreshold: Number.isFinite(args.preferenceThreshold) ? args.preferenceThreshold : undefined
  });
  return {
    ...result,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareHumanBlindEvalCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        const { requirePassed, blindPack, assignments, answerKey, reviewFormSchema, ...payload } = result;
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
