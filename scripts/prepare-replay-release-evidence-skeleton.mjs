#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  createReplayReleaseEvidenceSkeleton,
  REQUIRED_REPLAY_RELEASE_FAMILIES,
  REQUIRED_REPLAY_RELEASE_METADATA_FIELDS
} from '../src/core/eval/replay-release-skeleton.js';

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    runId: '',
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
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-replay-release-evidence-skeleton.mjs --output-dir DIR [options]',
    '',
    'Creates a non-passing R1 replay release evidence scaffold for the P0/P1 release workflow.',
    '',
    'Required benchmark families:',
    `  ${REQUIRED_REPLAY_RELEASE_FAMILIES.map((entry) => entry.label).join(', ')}`,
    '',
    'Required per-family metadata fields:',
    `  ${REQUIRED_REPLAY_RELEASE_METADATA_FIELDS.join(', ')}`,
    '',
    'Options:',
    '  --run-id ID                 Stable run id for the scaffold',
    '  --help, -h                  Show this help text'
  ].join('\n');
}

export async function prepareReplayReleaseEvidenceSkeletonCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.outputDir) throw new Error('--output-dir is required.');
  return createReplayReleaseEvidenceSkeleton({
    outputDir: args.outputDir,
    runId: args.runId || undefined
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareReplayReleaseEvidenceSkeletonCli()
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
