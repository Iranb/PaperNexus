#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeCociCitationGraph } from '../src/core/ingestion/coci.js';

function parseArgs(argv = []) {
  const parsed = {
    cociPath: '',
    outputPath: '',
    sourceKey: '',
    licenseScope: '',
    maxRecords: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--coci-path' || arg === '--input-path') {
      parsed.cociPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--source-key') {
      parsed.sourceKey = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--max-records') {
      parsed.maxRecords = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-coci-citation-graph.mjs --coci-path coci.csv --output-path citation-graph.json [options]',
    '',
    'Options:',
    '  --input-path FILE       Alias for --coci-path',
    '  --source-key KEY       Source manifest key for the local OpenCitations/COCI dump',
    '  --license-scope TEXT   License/provenance scope recorded on edges',
    '  --max-records N        Limit records read from a local dump slice'
  ].join('\n');
}

function finiteOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export async function prepareCociCitationGraphCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.cociPath) throw new Error('--coci-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const payload = await writeCociCitationGraph(args.outputPath, args.cociPath, {
    sourceKey: args.sourceKey,
    licenseScope: args.licenseScope,
    maxRecords: finiteOrUndefined(args.maxRecords)
  });

  return {
    outputPath: args.outputPath,
    contractVersion: payload.contractVersion,
    edge_count: payload.diagnostics.edgeCount,
    input_record_count: payload.diagnostics.inputRecordCount,
    duplicate_edge_count: payload.diagnostics.duplicateEdgeCount,
    missing_endpoint_count: payload.diagnostics.missingEndpointCount,
    graph_node_count: payload.graphProjection.nodes.length,
    graph_relationship_count: payload.graphProjection.relationships.length,
    warning_count: payload.diagnostics.warnings.length,
    error_count: payload.diagnostics.errors.length
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareCociCitationGraphCli()
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
