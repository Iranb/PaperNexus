#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { runParserOrchestrator } from '../src/core/ingestion/parser-orchestrator.js';

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    teiPath: '',
    s2orcPath: '',
    cociPath: '',
    cociFormat: '',
    multimodalAssetsPath: '',
    paperPath: '',
    paperId: '',
    paperTitle: '',
    sourceKey: '',
    sourcePath: '',
    sourcePdfPath: '',
    citationIntentGoldPath: '',
    claimGoldPath: '',
    maxS2orcPapers: null,
    maxCociRecords: null,
    maxClaims: null,
    minCitationIntentAccuracy: null,
    minCitationIntentMacroF1: null,
    lowConfidenceThreshold: null,
    minClaimRecall: null,
    minSourceSpanCompleteness: null,
    minTypeAccuracy: null,
    matchThreshold: null,
    graphApplyMode: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--tei-path') {
      parsed.teiPath = next || '';
      index += 1;
    } else if (arg === '--s2orc-path') {
      parsed.s2orcPath = next || '';
      index += 1;
    } else if (arg === '--coci-path') {
      parsed.cociPath = next || '';
      index += 1;
    } else if (arg === '--coci-format') {
      parsed.cociFormat = next || '';
      index += 1;
    } else if (arg === '--multimodal-assets-path') {
      parsed.multimodalAssetsPath = next || '';
      index += 1;
    } else if (arg === '--paper-path') {
      parsed.paperPath = next || '';
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
    } else if (arg === '--citation-intent-gold-path') {
      parsed.citationIntentGoldPath = next || '';
      index += 1;
    } else if (arg === '--claim-gold-path') {
      parsed.claimGoldPath = next || '';
      index += 1;
    } else if (arg === '--max-s2orc-papers') {
      parsed.maxS2orcPapers = Number(next);
      index += 1;
    } else if (arg === '--max-coci-records') {
      parsed.maxCociRecords = Number(next);
      index += 1;
    } else if (arg === '--max-claims') {
      parsed.maxClaims = Number(next);
      index += 1;
    } else if (arg === '--min-citation-intent-accuracy') {
      parsed.minCitationIntentAccuracy = Number(next);
      index += 1;
    } else if (arg === '--min-citation-intent-macro-f1') {
      parsed.minCitationIntentMacroF1 = Number(next);
      index += 1;
    } else if (arg === '--low-confidence-threshold') {
      parsed.lowConfidenceThreshold = Number(next);
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
    } else if (arg === '--match-threshold') {
      parsed.matchThreshold = Number(next);
      index += 1;
    } else if (arg === '--graph-apply-mode') {
      parsed.graphApplyMode = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/run-ingestion-orchestrator.mjs --output-dir DIR [inputs]',
    '',
    'Inputs:',
    '  --tei-path FILE                         GROBID TEI XML; default citation parser when provided',
    '  --s2orc-path FILE                       Optional S2ORC JSON/JSONL citation-context supplement',
    '  --coci-path FILE                        Optional COCI/OpenCitations CSV/TSV/JSONL citation graph supplement',
    '  --multimodal-assets-path FILE           Optional figure/table/formula OCR asset artifact to link into graph mutations',
    '  --paper-path FILE                       Parsed paper JSON for claim extraction',
    '',
    'Metadata:',
    '  --paper-id ID                           PaperNexus paper id for GROBID contexts',
    '  --paper-title TITLE                     Human-readable paper title',
    '  --source-key KEY                        Source manifest key',
    '  --source-path FILE                      Original source path',
    '  --source-pdf-path FILE                  Original PDF path',
    '',
    'Benchmark gates:',
    '  --citation-intent-gold-path FILE        Optional SciCite-style citation-intent gold labels',
    '  --claim-gold-path FILE                  Optional CLAIM-BENCH/CLAIMCHECK-style gold claims',
    '  --min-citation-intent-accuracy FLOAT    Citation-intent gate threshold',
    '  --min-citation-intent-macro-f1 FLOAT    Citation-intent macro-F1 gate threshold',
    '  --min-claim-recall FLOAT                Claim extraction recall gate threshold',
    '  --min-source-span-completeness FLOAT    Source-span completeness gate threshold',
    '  --min-type-accuracy FLOAT               Claim type accuracy gate threshold',
    '  --graph-apply-mode MODE                 preview or release-gated; release-gated writes only a readiness plan',
    '',
    'Limits:',
    '  --max-s2orc-papers N                    Limit S2ORC papers read from JSONL',
    '  --max-coci-records N                    Limit COCI/OpenCitations records',
    '  --max-claims N                          Limit extracted claims',
    '  --coci-format FORMAT                    Force coci-csv, coci-tsv, coci-json, or coci-jsonl'
  ].join('\n');
}

function finiteOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export async function runIngestionOrchestratorCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.outputDir) throw new Error('--output-dir is required.');

  const { manifest } = await runParserOrchestrator({
    outputDir: args.outputDir,
    teiPath: args.teiPath,
    s2orcPath: args.s2orcPath,
    cociPath: args.cociPath,
    cociFormat: args.cociFormat,
    multimodalAssetsPath: args.multimodalAssetsPath,
    paperPath: args.paperPath,
    paperId: args.paperId,
    paperTitle: args.paperTitle,
    sourceKey: args.sourceKey,
    sourcePath: args.sourcePath,
    sourcePdfPath: args.sourcePdfPath,
    citationIntentGoldPath: args.citationIntentGoldPath,
    claimGoldPath: args.claimGoldPath,
    maxS2orcPapers: finiteOrUndefined(args.maxS2orcPapers),
    maxCociRecords: finiteOrUndefined(args.maxCociRecords),
    maxClaims: finiteOrUndefined(args.maxClaims),
    minCitationIntentAccuracy: finiteOrUndefined(args.minCitationIntentAccuracy),
    minCitationIntentMacroF1: finiteOrUndefined(args.minCitationIntentMacroF1),
    lowConfidenceThreshold: finiteOrUndefined(args.lowConfidenceThreshold),
    minClaimRecall: finiteOrUndefined(args.minClaimRecall),
    minSourceSpanCompleteness: finiteOrUndefined(args.minSourceSpanCompleteness),
    minTypeAccuracy: finiteOrUndefined(args.minTypeAccuracy),
    matchThreshold: finiteOrUndefined(args.matchThreshold),
    graphApplyMode: args.graphApplyMode || undefined
  });

  return {
    outputDir: args.outputDir,
    contractVersion: manifest.contractVersion,
    status: manifest.status,
    releaseGateStatus: manifest.releaseGateStatus,
    citation_context_count: manifest.diagnostics.citationContextCount,
    citation_intent_count: manifest.diagnostics.citationIntentCount,
    claim_count: manifest.diagnostics.claimCount,
    multimodal_asset_count: manifest.diagnostics.multimodalAssetCount,
    multimodal_asset_edge_count: manifest.diagnostics.multimodalAssetEdgeCount,
    coci_citation_edge_count: manifest.diagnostics.cociCitationEdgeCount,
    graph_mutation_operation_count: manifest.diagnostics.graphMutationOperationCount,
    graph_apply_plan_status: manifest.graphApplyPlan?.status || null,
    graph_apply_can_apply: Boolean(manifest.graphApplyPlan?.canApply),
    manifestPath: manifest.artifacts.manifest || ''
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestionOrchestratorCli()
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
