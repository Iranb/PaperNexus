#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  executeIngestionGraphMutations
} from '../src/core/ingestion/graph-mutation-executor.js';

function parseArgs(argv = []) {
  const parsed = {
    graphMutationsPath: '',
    graphApplyPlanPath: '',
    corpusRoot: '',
    outputDir: '',
    actor: '',
    apply: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--graph-mutations-path') {
      parsed.graphMutationsPath = next || '';
      index += 1;
    } else if (arg === '--graph-apply-plan-path') {
      parsed.graphApplyPlanPath = next || '';
      index += 1;
    } else if (arg === '--corpus-root' || arg === '--root-path') {
      parsed.corpusRoot = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--actor') {
      parsed.actor = next || '';
      index += 1;
    } else if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--dry-run') {
      parsed.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/apply-ingestion-graph-mutations.mjs --graph-mutations-path graph-mutations.json --graph-apply-plan-path graph-apply-plan.json --corpus-root DIR --output-dir DIR [options]',
    '',
    'Options:',
    '  --root-path DIR                  Alias for --corpus-root',
    '  --actor NAME                     Actor recorded in mutation audit properties',
    '  --dry-run                        Preview only; this is the default',
    '  --apply                          Persist graph mutations only when the apply plan is ready_to_apply and all gates passed'
  ].join('\n');
}

export async function applyIngestionGraphMutationsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };

  const { report, artifacts } = await executeIngestionGraphMutations({
    graphMutationsPath: args.graphMutationsPath,
    graphApplyPlanPath: args.graphApplyPlanPath,
    corpusRoot: args.corpusRoot,
    outputDir: args.outputDir,
    actor: args.actor,
    apply: args.apply
  });

  return {
    outputDir: args.outputDir,
    contractVersion: report.contractVersion,
    status: report.status,
    apply_status: report.applyStatus,
    dry_run: report.dryRun,
    authoritative_graph_write_performed: report.safety.authoritativeGraphWritePerformed,
    operation_count: report.operationCount,
    graph_before_checksum: report.graphBefore.checksum,
    authoritative_graph_after_checksum: report.authoritativeGraphAfter.checksum,
    reportPath: artifacts.report,
    manifestPath: artifacts.manifest,
    rollbackManifestPath: artifacts.rollbackManifest
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyIngestionGraphMutationsCli()
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
