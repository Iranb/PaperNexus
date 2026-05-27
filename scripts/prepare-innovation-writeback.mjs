#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeInnovationArtifactGraphMutations } from '../src/core/graph/innovation-writeback.js';

function parseArgs(argv = []) {
  const parsed = {
    inputPath: '',
    outputPath: '',
    actor: '',
    allowWeakEvidence: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input-path' || arg === '--artifact-path') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--actor') {
      parsed.actor = next || '';
      index += 1;
    } else if (arg === '--allow-weak-evidence') {
      parsed.allowWeakEvidence = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-innovation-writeback.mjs --input-path artifact.json --output-path mutation-preview.json [options]',
    '',
    'Options:',
    '  --artifact-path FILE       Alias for --input-path',
    '  --actor NAME               Actor recorded in provenance fields',
    '  --allow-weak-evidence      Emit preview operations even when writeback gates would normally block'
  ].join('\n');
}

export async function prepareInnovationWritebackCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.inputPath) throw new Error('--input-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const payload = await writeInnovationArtifactGraphMutations(args.outputPath, args.inputPath, {
    actor: args.actor,
    allowWeakEvidence: args.allowWeakEvidence
  });

  return {
    outputPath: args.outputPath,
    contractVersion: payload.contractVersion,
    writeback_status: payload.writebackStatus,
    operation_count: payload.diagnostics.operationCount,
    node_operation_count: payload.diagnostics.nodeOperationCount || 0,
    relationship_operation_count: payload.diagnostics.relationshipOperationCount || 0,
    warning_count: payload.warnings.length
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareInnovationWritebackCli()
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
