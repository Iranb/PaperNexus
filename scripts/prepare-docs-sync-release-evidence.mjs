#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  prepareDocsSyncReleaseEvidence,
  REQUIRED_DOCS_SYNC_CHECKS
} from '../src/core/eval/docs-sync-release-evidence.js';

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    runId: '',
    timeoutMs: null,
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
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(next);
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
    'Usage: node scripts/prepare-docs-sync-release-evidence.mjs --output-dir DIR [options]',
    '',
    'Runs the docs/schema/fixtures/migration-note checks required by the deep-research release definition and writes an auditable evidence report.',
    '',
    'Default checks:',
    ...REQUIRED_DOCS_SYNC_CHECKS.map((check) => `  - ${check.id}: ${check.label}`),
    '',
    'Options:',
    '  --run-id ID                 Stable run id for the evidence report',
    '  --timeout-ms N              Per-check timeout in milliseconds; default 120000',
    '  --require-passed            Exit non-zero unless the evidence report status is passed'
  ].join('\n');
}

export async function prepareDocsSyncReleaseEvidenceCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const report = await prepareDocsSyncReleaseEvidence({
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
  });
  return {
    ...report,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareDocsSyncReleaseEvidenceCli()
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
