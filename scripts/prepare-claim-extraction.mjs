#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeClaimExtractionArtifact } from '../src/core/ingestion/claim-extraction.js';

function parseArgs(argv = []) {
  const parsed = {
    inputPath: '',
    outputPath: '',
    citationContextsPath: '',
    citationIntentsPath: '',
    goldPath: '',
    maxClaims: null,
    matchThreshold: null,
    minClaimRecall: null,
    minSourceSpanCompleteness: null,
    minTypeAccuracy: null,
    allowFail: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input-path') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--citation-contexts-path') {
      parsed.citationContextsPath = next || '';
      index += 1;
    } else if (arg === '--citation-intents-path') {
      parsed.citationIntentsPath = next || '';
      index += 1;
    } else if (arg === '--gold-path') {
      parsed.goldPath = next || '';
      index += 1;
    } else if (arg === '--max-claims') {
      parsed.maxClaims = Number(next);
      index += 1;
    } else if (arg === '--match-threshold') {
      parsed.matchThreshold = Number(next);
      index += 1;
    } else if (arg === '--min-claim-recall') {
      parsed.minClaimRecall = Number(next);
      index += 1;
    } else if (arg === '--min-source-span-completeness') {
      parsed.minSourceSpanCompleteness = Number(next);
      index += 1;
    } else if (arg === '--min-type-accuracy') {
      parsed.minTypeAccuracy = Number(next);
      index += 1;
    } else if (arg === '--allow-fail') {
      parsed.allowFail = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-claim-extraction.mjs --input-path paper.json --output-path claims.json [options]',
    '',
    'Options:',
    '  --citation-contexts-path FILE       Optional papernexus-citation-contexts-v1 or GROBID TEI contexts artifact',
    '  --citation-intents-path FILE        Optional papernexus-citation-intents-v1 artifact for intent links',
    '  --gold-path FILE                    Optional gold claim labels for benchmark gating',
    '  --max-claims N                      Maximum extracted claims to keep',
    '  --match-threshold FLOAT             Jaccard threshold for matching gold claim text',
    '  --min-claim-recall FLOAT            Fail unless claim recall reaches this threshold',
    '  --min-source-span-completeness N     Fail unless all/most claims have source spans',
    '  --min-type-accuracy FLOAT           Fail unless typed gold claims match this threshold',
    '  --allow-fail                        Write artifacts and return a summary even when benchmark gates fail'
  ].join('\n');
}

function finiteOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export async function prepareClaimExtractionCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.inputPath) throw new Error('--input-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const artifact = await writeClaimExtractionArtifact(args.outputPath, args.inputPath, {
    citationContextsPath: args.citationContextsPath || undefined,
    citationIntentsPath: args.citationIntentsPath || undefined,
    goldPath: args.goldPath || undefined,
    maxClaims: finiteOrUndefined(args.maxClaims),
    matchThreshold: finiteOrUndefined(args.matchThreshold),
    minClaimRecall: finiteOrUndefined(args.minClaimRecall),
    minSourceSpanCompleteness: finiteOrUndefined(args.minSourceSpanCompleteness),
    minTypeAccuracy: finiteOrUndefined(args.minTypeAccuracy)
  });

  const summary = {
    outputPath: args.outputPath,
    contractVersion: artifact.contractVersion,
    claim_count: artifact.diagnostics.claimCount,
    source_span_count: artifact.diagnostics.sourceSpanCount,
    citation_context_link_count: artifact.diagnostics.citationContextLinkCount,
    graph_node_count: artifact.graph.nodes.length,
    graph_edge_count: artifact.graph.edges.length,
    evaluation_status: artifact.evaluation?.status || null,
    evaluation_claim_recall: artifact.evaluation?.claim_recall ?? null,
    evaluation_source_span_completeness: artifact.evaluation?.source_span_completeness ?? null,
    evaluation_type_accuracy: artifact.evaluation?.type_accuracy ?? null
  };

  if (artifact.evaluation?.status === 'failed' && !args.allowFail) {
    const error = new Error(`Claim-extraction benchmark gate failed: ${artifact.evaluation.threshold_failures.join('; ')}`);
    error.summary = summary;
    throw error;
  }

  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareClaimExtractionCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch((error) => {
      if (error?.summary) console.error(JSON.stringify(error.summary, null, 2));
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
