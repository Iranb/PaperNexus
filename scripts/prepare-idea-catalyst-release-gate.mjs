#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  prepareIdeaCatalystReleaseGateManifest,
  RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS,
  RELEASE_GATE_REQUIRED_ABLATIONS
} from '../src/core/eval/release-gate-manifest.js';

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv = []) {
  const parsed = {
    replaySuiteManifestPaths: [],
    ablationManifestPaths: [],
    humanAggregationPaths: [],
    graphReasoningReportPaths: [],
    graphLinkPredictionReportPaths: [],
    scientificEmbeddingEvidencePaths: [],
    innovationSidecarEvidencePaths: [],
    ingestionGraphMutationExecutionPaths: [],
    engineeringEvidencePaths: [],
    docsSyncEvidencePaths: [],
    outputDir: '',
    runId: '',
    releaseScope: 'full',
    requiredAblations: [],
    allowFixtureEvidence: false,
    requirePassed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--replay-suite-manifest') {
      parsed.replaySuiteManifestPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--ablation-manifest') {
      parsed.ablationManifestPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--human-aggregation') {
      parsed.humanAggregationPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--graph-reasoning-report') {
      parsed.graphReasoningReportPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--graph-link-prediction-report') {
      parsed.graphLinkPredictionReportPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--scientific-embedding-evidence') {
      parsed.scientificEmbeddingEvidencePaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--innovation-sidecar-evidence') {
      parsed.innovationSidecarEvidencePaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--ingestion-graph-mutation-execution') {
      parsed.ingestionGraphMutationExecutionPaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--engineering-evidence') {
      parsed.engineeringEvidencePaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--docs-sync-evidence') {
      parsed.docsSyncEvidencePaths.push(...parseList(next));
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--scope' || arg === '--release-scope') {
      parsed.releaseScope = next || 'full';
      index += 1;
    } else if (arg === '--required-ablations') {
      parsed.requiredAblations = parseList(next);
      index += 1;
    } else if (arg === '--allow-fixture-evidence') {
      parsed.allowFixtureEvidence = true;
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
    'Usage: node scripts/prepare-idea-catalyst-release-gate.mjs --output-dir DIR [options]',
    '',
    'Aggregates replay-suite, ablation, graph reasoning, ingestion graph mutation, scientific embedding, innovation sidecar, graph link-prediction, engineering-test, docs-sync, and human blind evidence into a single release-gate manifest.',
    '',
    'Options:',
    '  --replay-suite-manifest FILE[,FILE]   One or more replay-suite-manifest.json files',
    '  --ablation-manifest FILE[,FILE]       One or more ablation-manifest.json files',
    '  --human-aggregation FILE[,FILE]       One or more human blind aggregation.json files',
    '  --graph-reasoning-report FILE[,FILE]  SciRepEval/OAG-Bench/GraphRAG-Bench style report(s)',
    '  --graph-link-prediction-report FILE[,FILE]  graph-link-prediction-eval.json report(s)',
    '  --scientific-embedding-evidence FILE[,FILE]  scientific-embedding-release-evidence.json report(s) for R4',
    '  --innovation-sidecar-evidence FILE[,FILE]  innovation-sidecar-release-evidence.json report(s) for R5/R6',
    '  --ingestion-graph-mutation-execution FILE[,FILE]  graph-mutation-execution-report.json report(s) for R3',
    '  --engineering-evidence FILE[,FILE]    engineering-release-evidence.json report(s)',
    '  --docs-sync-evidence FILE[,FILE]      docs-sync-release-evidence.json report(s)',
    '  --run-id ID                           Stable run id for the release-gate manifest',
    '  --scope full|p0-p1                    Gate scope; p0-p1 omits E5 and R4-R7 deferred sidecar requirements',
    `  --required-ablations LIST             Comma list; full default ${RELEASE_GATE_REQUIRED_ABLATIONS.join(',')}; p0-p1 default ${RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS.join(',')}`,
    '  --allow-fixture-evidence              Allow fixture/synthetic inputs to count as release evidence',
    '  --require-passed                      Exit non-zero unless the release gate status is passed'
  ].join('\n');
}

export async function prepareIdeaCatalystReleaseGateCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const manifest = await prepareIdeaCatalystReleaseGateManifest({
    replaySuiteManifestPaths: args.replaySuiteManifestPaths,
    ablationManifestPaths: args.ablationManifestPaths,
    humanAggregationPaths: args.humanAggregationPaths,
    graphReasoningReportPaths: args.graphReasoningReportPaths,
    graphLinkPredictionReportPaths: args.graphLinkPredictionReportPaths,
    scientificEmbeddingEvidencePaths: args.scientificEmbeddingEvidencePaths,
    innovationSidecarEvidencePaths: args.innovationSidecarEvidencePaths,
    ingestionGraphMutationExecutionPaths: args.ingestionGraphMutationExecutionPaths,
    engineeringEvidencePaths: args.engineeringEvidencePaths,
    docsSyncEvidencePaths: args.docsSyncEvidencePaths,
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    releaseScope: args.releaseScope,
    requiredAblations: args.requiredAblations.length ? args.requiredAblations : undefined,
    allowFixtureEvidence: args.allowFixtureEvidence
  });
  return {
    ...manifest,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareIdeaCatalystReleaseGateCli()
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
