#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeGrobidTeiCitationContexts } from '../src/core/ingestion/grobid-tei.js';

function parseArgs(argv = []) {
  const parsed = {
    teiPath: '',
    outputPath: '',
    paperId: '',
    paperTitle: '',
    sourceKey: '',
    sourcePath: '',
    sourcePdfPath: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--tei-path') {
      parsed.teiPath = next || '';
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
    } else if (arg === '--source-path') {
      parsed.sourcePath = next || '';
      index += 1;
    } else if (arg === '--source-pdf-path') {
      parsed.sourcePdfPath = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-grobid-tei-citation-contexts.mjs --tei-path paper.tei.xml --output-path contexts.json [options]',
    '',
    'Options:',
    '  --paper-id ID             PaperNexus paper id to attach to extracted contexts',
    '  --paper-title TITLE       Human-readable paper title',
    '  --source-key KEY          Source manifest key for the source paper',
    '  --source-path PATH        Original source path, if known',
    '  --source-pdf-path PATH    Original PDF path, if known'
  ].join('\n');
}

export async function prepareGrobidTeiCitationContextsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.teiPath) throw new Error('--tei-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');
  const payload = await writeGrobidTeiCitationContexts(args.outputPath, args.teiPath, {
    paperId: args.paperId,
    paperTitle: args.paperTitle,
    sourceKey: args.sourceKey,
    sourcePath: args.sourcePath,
    sourcePdfPath: args.sourcePdfPath
  });
  return {
    outputPath: args.outputPath,
    contractVersion: payload.contractVersion,
    reference_count: payload.diagnostics.referenceCount,
    context_count: payload.diagnostics.contextCount,
    unresolved_reference_count: payload.diagnostics.unresolvedReferenceCount,
    warning_count: payload.diagnostics.warnings.length,
    error_count: payload.diagnostics.errors.length
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareGrobidTeiCitationContextsCli()
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
