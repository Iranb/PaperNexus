#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeS2orcCitationContexts } from '../src/core/ingestion/s2orc.js';

function parseArgs(argv = []) {
  const parsed = {
    s2orcPath: '',
    outputPath: '',
    paperId: '',
    paperTitle: '',
    sourceKey: '',
    maxPapers: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--s2orc-path' || arg === '--input-path') {
      parsed.s2orcPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--paper-id') {
      parsed.paperId = next || '';
      index += 1;
    } else if (arg === '--paper-title') {
      parsed.paperTitle = next || '';
      index += 1;
    } else if (arg === '--source-key') {
      parsed.sourceKey = next || '';
      index += 1;
    } else if (arg === '--max-papers') {
      parsed.maxPapers = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-s2orc-citation-contexts.mjs --s2orc-path paper.jsonl --output-path citation-contexts.json [options]',
    '',
    'Options:',
    '  --input-path FILE       Alias for --s2orc-path',
    '  --paper-id ID          PaperNexus paper id override for a single S2ORC record',
    '  --paper-title TITLE    Human-readable title override for a single S2ORC record',
    '  --source-key KEY       Source manifest key for the source slice',
    '  --max-papers N         Limit records read from a JSONL/slice file'
  ].join('\n');
}

function finiteOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export async function prepareS2orcCitationContextsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.s2orcPath) throw new Error('--s2orc-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const payload = await writeS2orcCitationContexts(args.outputPath, args.s2orcPath, {
    paperId: args.paperId,
    paperTitle: args.paperTitle,
    sourceKey: args.sourceKey,
    maxPapers: finiteOrUndefined(args.maxPapers)
  });

  return {
    outputPath: args.outputPath,
    contractVersion: payload.contractVersion,
    paper_count: payload.diagnostics.paperCount,
    reference_count: payload.diagnostics.referenceCount,
    context_count: payload.diagnostics.contextCount,
    unresolved_reference_count: payload.diagnostics.unresolvedReferenceCount,
    warning_count: payload.diagnostics.warnings.length,
    error_count: payload.diagnostics.errors.length
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareS2orcCitationContextsCli()
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
