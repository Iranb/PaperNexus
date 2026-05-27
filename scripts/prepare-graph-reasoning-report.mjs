#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  DEFAULT_GRAPH_REASONING_TOP_K,
  DETERMINISTIC_GLOBAL_LOCAL_GRAPH_REASONING_METHOD,
  writeGraphReasoningReportArtifacts
} from '../src/core/eval/graph-reasoning-report.js';

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback = DEFAULT_GRAPH_REASONING_TOP_K) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = []) {
  const parsed = {
    graphPath: '',
    tasksPath: '',
    summariesPath: '',
    benchmarkMetadataPath: '',
    outputDir: '',
    runId: '',
    benchmarkName: '',
    benchmarkFormat: '',
    datasetSource: '',
    licenseScope: '',
    method: '',
    model: '',
    topK: DEFAULT_GRAPH_REASONING_TOP_K,
    minRetrievalScoreDelta: 0,
    minGraphReasoningScoreDelta: 0,
    minGlobalLocalSummaryDelta: 0,
    minStorylineCoherenceDelta: 0,
    releaseEvidence: false,
    requirePassed: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--graph-path' || arg === '--graph') {
      parsed.graphPath = next || '';
      index += 1;
    } else if (arg === '--tasks-path' || arg === '--tasks' || arg === '--benchmark-path') {
      parsed.tasksPath = next || '';
      index += 1;
    } else if (arg === '--summaries-path' || arg === '--graphrag-summaries') {
      parsed.summariesPath = next || '';
      index += 1;
    } else if (arg === '--benchmark-metadata') {
      parsed.benchmarkMetadataPath = next || '';
      index += 1;
    } else if (arg === '--output-dir' || arg === '--output') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--benchmark-name') {
      parsed.benchmarkName = next || '';
      index += 1;
    } else if (arg === '--benchmark-format') {
      parsed.benchmarkFormat = next || '';
      index += 1;
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--method') {
      parsed.method = next || '';
      index += 1;
    } else if (arg === '--model') {
      parsed.model = next || '';
      index += 1;
    } else if (arg === '--top-k' || arg === '-k') {
      parsed.topK = parseInteger(next, DEFAULT_GRAPH_REASONING_TOP_K);
      index += 1;
    } else if (arg === '--min-retrieval-delta') {
      parsed.minRetrievalScoreDelta = parseNumber(next, 0);
      index += 1;
    } else if (arg === '--min-graph-reasoning-delta') {
      parsed.minGraphReasoningScoreDelta = parseNumber(next, 0);
      index += 1;
    } else if (arg === '--min-summary-delta') {
      parsed.minGlobalLocalSummaryDelta = parseNumber(next, 0);
      index += 1;
    } else if (arg === '--min-storyline-coherence-delta') {
      parsed.minStorylineCoherenceDelta = parseNumber(next, 0);
      index += 1;
    } else if (arg === '--release-evidence') {
      parsed.releaseEvidence = true;
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
    'Usage: node scripts/prepare-graph-reasoning-report.mjs --graph-path FILE --tasks-path FILE --output-dir DIR [options]',
    '',
    'Builds a SciRepEval/OAG-Bench/GraphRAG-Bench style graph reasoning report for the idea-catalyst release gate.',
    'The default deterministic backend is for offline contract plumbing and regression tests. It is not release evidence unless --release-evidence is set with real benchmark provenance.',
    '',
    'Options:',
    '  --graph-path FILE                       Graph snapshot JSON containing nodes and relationships',
    '  --tasks-path FILE                       Graph reasoning tasks with query and gold/relevant node ids',
    '  --summaries-path FILE                   Optional GraphRAG/global-local summaries JSON',
    '  --benchmark-metadata FILE               Optional JSON with benchmark name/format/source/license_scope',
    '  --output-dir DIR                        Output directory for report JSON, markdown, and manifest',
    '  --run-id ID                             Stable run id',
    '  --benchmark-name TEXT                   Benchmark name; should mention SciRepEval/OAG-Bench/GraphRAG-Bench for E5',
    '  --benchmark-format TEXT                 Benchmark format id',
    '  --dataset-source TEXT                   External benchmark source or frozen snapshot URL',
    '  --license-scope TEXT                    Dataset/license scope for this run',
    '  --method TEXT                           Method name',
    `  --model TEXT                            Model/backend name; default ${DETERMINISTIC_GLOBAL_LOCAL_GRAPH_REASONING_METHOD}`,
    `  --top-k N                               Ranking cutoff; default ${DEFAULT_GRAPH_REASONING_TOP_K}`,
    '  --min-retrieval-delta NUMBER            Required graph recall@k delta over lexical baseline',
    '  --min-graph-reasoning-delta NUMBER      Required graph MRR delta over lexical baseline',
    '  --min-summary-delta NUMBER              Required summary-aware recall@k delta over local graph',
    '  --min-storyline-coherence-delta NUMBER  Required coherence delta over lexical baseline',
    '  --release-evidence                      Allow status=passed when gates and provenance pass',
    '  --require-passed                        Exit non-zero unless report status is passed'
  ].join('\n');
}

export async function prepareGraphReasoningReportCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.graphPath) throw new Error('--graph-path is required.');
  if (!args.tasksPath) throw new Error('--tasks-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const result = await writeGraphReasoningReportArtifacts({
    graphPath: args.graphPath,
    tasksPath: args.tasksPath,
    summariesPath: args.summariesPath || undefined,
    benchmarkMetadataPath: args.benchmarkMetadataPath || undefined,
    outputDir: args.outputDir,
    runId: args.runId || undefined,
    benchmarkName: args.benchmarkName || undefined,
    benchmarkFormat: args.benchmarkFormat || undefined,
    datasetSource: args.datasetSource || undefined,
    licenseScope: args.licenseScope || undefined,
    method: args.method || undefined,
    model: args.model || undefined,
    topK: args.topK,
    minRetrievalScoreDelta: args.minRetrievalScoreDelta,
    minGraphReasoningScoreDelta: args.minGraphReasoningScoreDelta,
    minGlobalLocalSummaryDelta: args.minGlobalLocalSummaryDelta,
    minStorylineCoherenceDelta: args.minStorylineCoherenceDelta,
    releaseEvidence: args.releaseEvidence
  });
  return {
    ...result.manifest,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareGraphReasoningReportCli()
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
