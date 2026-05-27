#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { writeCitationIntentArtifact } from '../src/core/ingestion/citation-intent.js';

function parseArgs(argv = []) {
  const parsed = {
    contextsPath: '',
    outputPath: '',
    goldPath: '',
    minAccuracy: null,
    minMacroF1: null,
    lowConfidenceThreshold: null,
    allowFail: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--contexts-path') {
      parsed.contextsPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--gold-path') {
      parsed.goldPath = next || '';
      index += 1;
    } else if (arg === '--min-accuracy') {
      parsed.minAccuracy = Number(next);
      index += 1;
    } else if (arg === '--min-macro-f1') {
      parsed.minMacroF1 = Number(next);
      index += 1;
    } else if (arg === '--low-confidence-threshold') {
      parsed.lowConfidenceThreshold = Number(next);
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
    'Usage: node scripts/prepare-citation-intents.mjs --contexts-path citation-contexts.json --output-path citation-intents.json [options]',
    '',
    'Options:',
    '  --gold-path FILE               Optional gold labels for citation-intent benchmark gating',
    '  --min-accuracy FLOAT           Fail unless evaluated citation-intent accuracy reaches this threshold',
    '  --min-macro-f1 FLOAT           Fail unless evaluated macro F1 reaches this threshold',
    '  --low-confidence-threshold N   Mark intents below this confidence as requiring human review',
    '  --allow-fail                   Write artifacts and return a summary even when benchmark gates fail'
  ].join('\n');
}

function finiteOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export async function prepareCitationIntentsCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.contextsPath) throw new Error('--contexts-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const artifact = await writeCitationIntentArtifact(args.outputPath, args.contextsPath, {
    goldPath: args.goldPath || undefined,
    minAccuracy: finiteOrUndefined(args.minAccuracy),
    minMacroF1: finiteOrUndefined(args.minMacroF1),
    lowConfidenceThreshold: finiteOrUndefined(args.lowConfidenceThreshold)
  });

  const summary = {
    outputPath: args.outputPath,
    contractVersion: artifact.contractVersion,
    context_count: artifact.diagnostics.contextCount,
    intent_count: artifact.diagnostics.intentCount,
    low_confidence_count: artifact.diagnostics.lowConfidenceCount,
    intent_counts: artifact.diagnostics.intentCounts,
    evaluation_status: artifact.evaluation?.status || null,
    evaluation_accuracy: artifact.evaluation?.accuracy ?? null,
    evaluation_macro_f1: artifact.evaluation?.macro_f1 ?? null
  };

  if (artifact.evaluation?.status === 'failed' && !args.allowFail) {
    const error = new Error(`Citation-intent benchmark gate failed: ${artifact.evaluation.threshold_failures.join('; ')}`);
    error.summary = summary;
    throw error;
  }

  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareCitationIntentsCli()
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
