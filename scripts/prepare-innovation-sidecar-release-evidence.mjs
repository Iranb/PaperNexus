#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  prepareInnovationSidecarReleaseEvidence,
  REQUIRED_MODEL_ASSISTED_FAMILIES
} from '../src/core/eval/innovation-sidecar-release-evidence.js';

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    runId: '',
    modelAssistedPath: '',
    counterfactualPath: '',
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
    } else if (arg === '--model-assisted-report') {
      parsed.modelAssistedPath = next || '';
      index += 1;
    } else if (arg === '--counterfactual-report') {
      parsed.counterfactualPath = next || '';
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
    'Usage: node scripts/prepare-innovation-sidecar-release-evidence.mjs --output-dir DIR [options]',
    '',
    'Builds the auditable R5/R6 sidecar evidence report consumed by the idea-catalyst release gate.',
    '',
    'R5 requires calibrated model-assisted evidence with model id, prompt version, calibration run, labels, non-fixture provenance, input hashes, and benchmark-family coverage:',
    `  ${REQUIRED_MODEL_ASSISTED_FAMILIES.map((family) => family.id).join(', ')}`,
    '',
    'R6 requires ToT/model-assisted counterfactual evidence with candidates, selected plans, labels covering selected plans, usefulness score >= 0.5, positive failure-discovery metric, non-fixture provenance, and input hashes.',
    '',
    'Options:',
    '  --model-assisted-report FILE   Calibrated model-assisted innovation/calibration report JSON',
    '  --counterfactual-report FILE    Counterfactual usefulness/search report JSON',
    '  --run-id ID                    Stable run id for the sidecar evidence report',
    '  --require-passed               Exit non-zero unless the sidecar evidence status is passed'
  ].join('\n');
}

export async function prepareInnovationSidecarReleaseEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const report = await prepareInnovationSidecarReleaseEvidence({
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    modelAssistedPath: args.modelAssistedPath || undefined,
    counterfactualPath: args.counterfactualPath || undefined
  });
  return {
    ...report,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareInnovationSidecarReleaseEvidenceCli()
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
