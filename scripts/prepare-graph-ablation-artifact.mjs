#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRetrievalBenchmark } from '../src/core/benchmarks/retrieval.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const CONTRACT_VERSION = 'papernexus-graph-ablation-artifact-preflight-v1';
const DEFAULT_MIN_QUERIES = 30;

function usage() {
  return [
    'Usage:',
    '  node scripts/prepare-graph-ablation-artifact.mjs --dataset-path <benchmark.json> [options]',
    '',
    'Options:',
    '  --run-id <id>',
    '  --output-dir <dir>',
    '  --format <format>',
    '  --root-path <dir>',
    '  --min-queries <n>            Default: 30',
    '',
    'The preflight validates that a graph-ranking ablation benchmark is frozen,',
    'real-corpus, non-manual, graph-aware, and compatible with the ablation runner.'
  ].join('\n');
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const equalsIndex = arg.indexOf('=');
    const rawKey = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
    if (inlineValue !== undefined) {
      raw[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      raw[key] = next;
      index += 1;
    } else {
      raw[key] = 'true';
    }
  }

  const runId = raw.runId || `graph-ablation-artifact-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    help: raw.help,
    runId,
    datasetPath: raw.datasetPath || raw.dataset,
    format: raw.format,
    rootPath: raw.rootPath,
    outputDir: path.resolve(raw.outputDir || path.join('.papernexus', 'benchmarks', 'graph-ablation-artifacts', runId)),
    minQueries: parseInteger(raw.minQueries, DEFAULT_MIN_QUERIES)
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function paperId(paper = {}, index = 0) {
  return compactText(
    paper.id
    || paper.paperId
    || paper.paper_id
    || paper.corpusId
    || paper.corpus_id
    || paper.canonicalId
    || paper.canonical_id
    || paper.title
    || `paper-${index}`
  );
}

function truthyFalse(value) {
  return value === false || String(value).trim().toLowerCase() === 'false';
}

function explicitTrue(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function collectGraphEdges(benchmark = {}) {
  const graph = asObject(benchmark.graph || benchmark.methodGraph || benchmark.citationGraph);
  return [
    ...asArray(graph.edges),
    ...asArray(benchmark.edges),
    ...asArray(benchmark.graphEdges)
  ];
}

function collectSeedIds(query = {}) {
  return [
    query.sourcePaperId,
    query.source_paper_id,
    ...asArray(query.sourcePaperIds || query.source_paper_ids),
    ...asArray(query.graphSeeds || query.graph_seeds),
    ...asArray(query.seedPaperIds || query.seed_paper_ids)
  ].map(compactText).filter(Boolean);
}

function collectRelevantIds(query = {}) {
  const qrels = query.qrels && typeof query.qrels === 'object' && !Array.isArray(query.qrels)
    ? Object.keys(query.qrels)
    : asArray(query.qrels);
  return [
    ...asArray(query.relevant),
    ...asArray(query.relevantPapers || query.relevant_papers),
    ...asArray(query.goldPapers || query.gold_papers),
    ...qrels
  ].map((entry) => {
    if (typeof entry === 'string' || typeof entry === 'number') return compactText(entry);
    return paperId(asObject(entry), 0);
  }).filter(Boolean);
}

function edgeEndpoint(edge = {}, keys = []) {
  for (const key of keys) {
    const value = edge[key];
    if (value !== undefined && value !== null && value !== '') return compactText(value);
  }
  return '';
}

function validationFlags(benchmark = {}) {
  const metadata = asObject(benchmark.metadata);
  const evaluation = asObject(benchmark.evaluation);
  return {
    frozen: explicitTrue(benchmark.frozen) || explicitTrue(metadata.frozen) || explicitTrue(evaluation.frozen),
    synthetic:
      explicitTrue(benchmark.synthetic)
      || explicitTrue(benchmark.syntheticGraph)
      || explicitTrue(metadata.synthetic)
      || explicitTrue(metadata.syntheticGraph),
    manualReviewRequired:
      benchmark.manualReviewRequired
      ?? benchmark.humanReviewRequired
      ?? metadata.manualReviewRequired
      ?? metadata.humanReviewRequired
      ?? evaluation.manualReviewRequired
      ?? evaluation.humanReviewRequired,
    generationScript: compactText(
      benchmark.generationScript
      || benchmark.artifactGenerationScript
      || metadata.generationScript
      || metadata.artifactGenerationScript
    )
  };
}

function validateGraphAblationArtifact(benchmark = {}, options = {}) {
  const corpus = asArray(benchmark.corpus);
  const queries = asArray(benchmark.queries);
  const edges = collectGraphEdges(benchmark);
  const minQueries = parseInteger(options.minQueries, DEFAULT_MIN_QUERIES);
  const paperIds = new Set(corpus.map(paperId).filter(Boolean));
  const reasons = [];

  if (!corpus.length) reasons.push('missing_local_corpus');
  if (!queries.length) reasons.push('missing_fixed_query_set');
  if (queries.length && queries.length < minQueries) reasons.push(`query_count_below_${minQueries}`);
  if (!edges.length) reasons.push('missing_graph_edges');

  const danglingEdges = edges.filter((edge) => {
    const source = edgeEndpoint(edge, ['source', 'sourceId', 'sourcePaperId', 'from']);
    const target = edgeEndpoint(edge, ['target', 'targetId', 'targetPaperId', 'to']);
    return !source || !target || !paperIds.has(source) || !paperIds.has(target);
  });
  if (danglingEdges.length) reasons.push('dangling_graph_edges');

  let missingSeeds = 0;
  let danglingSeeds = 0;
  let missingRelevance = 0;
  let danglingRelevance = 0;
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const seeds = collectSeedIds(query);
    const relevantIds = collectRelevantIds(query);
    if (!seeds.length) {
      missingSeeds += 1;
    } else if (seeds.some((seed) => !paperIds.has(seed))) {
      danglingSeeds += 1;
    }
    if (!relevantIds.length) {
      missingRelevance += 1;
    } else if (relevantIds.some((id) => !paperIds.has(id))) {
      danglingRelevance += 1;
    }
  }
  if (missingSeeds) reasons.push('queries_missing_graph_seeds');
  if (danglingSeeds) reasons.push('queries_with_dangling_graph_seeds');
  if (missingRelevance) reasons.push('queries_missing_gold_relevance');
  if (danglingRelevance) reasons.push('queries_with_dangling_gold_relevance');

  const flags = validationFlags(benchmark);
  if (!flags.frozen) reasons.push('artifact_not_marked_frozen');
  if (flags.synthetic) reasons.push('artifact_marked_synthetic');
  if (!truthyFalse(flags.manualReviewRequired)) reasons.push('manual_review_boundary_not_false');
  if (!flags.generationScript) reasons.push('missing_generation_script');

  const status = reasons.length ? 'not_paper_ready' : 'paper_ready';
  return {
    status,
    evidenceClass: status === 'paper_ready' ? 'paper_ready' : 'engineering_diagnostic',
    gate: {
      status,
      reasons
    },
    stats: {
      corpusSize: corpus.length,
      queryCount: queries.length,
      graphEdgeCount: edges.length,
      danglingGraphEdgeCount: danglingEdges.length,
      missingSeedQueryCount: missingSeeds,
      danglingSeedQueryCount: danglingSeeds,
      missingRelevanceQueryCount: missingRelevance,
      danglingRelevanceQueryCount: danglingRelevance,
      minQueries
    },
    flags
  };
}

function renderMarkdown(report = {}) {
  const gate = report.gate || {};
  const stats = report.stats || {};
  return [
    `# Graph Ablation Artifact Preflight: ${report.runId}`,
    '',
    `Status: \`${report.status}\``,
    `Evidence class: \`${report.evidenceClass}\``,
    '',
    '| Field | Value |',
    '|---|---:|',
    `| Corpus papers | ${stats.corpusSize || 0} |`,
    `| Queries | ${stats.queryCount || 0} |`,
    `| Graph edges | ${stats.graphEdgeCount || 0} |`,
    `| Dangling graph edges | ${stats.danglingGraphEdgeCount || 0} |`,
    `| Queries missing graph seeds | ${stats.missingSeedQueryCount || 0} |`,
    `| Queries missing gold relevance | ${stats.missingRelevanceQueryCount || 0} |`,
    '',
    '## Gate Reasons',
    '',
    ...(gate.reasons?.length ? gate.reasons.map((reason) => `- \`${reason}\``) : ['- none']),
    '',
    '## Boundary',
    '',
    report.status === 'paper_ready'
      ? 'This artifact satisfies the automated frozen graph-aware real-corpus preflight and may be passed to the graph ranking ablation runner.'
      : 'This artifact must not be promoted to a paper graph-performance claim until all gate reasons are resolved.'
  ].join('\n') + '\n';
}

async function loadBenchmarkForPreflight(inputOptions = {}) {
  if (!inputOptions.benchmark && inputOptions.datasetPath) {
    const rawPath = path.resolve(inputOptions.datasetPath);
    if (rawPath.toLowerCase().endsWith('.json')) {
      const benchmark = JSON.parse(await fs.readFile(rawPath, 'utf8'));
      return {
        ...benchmark,
        sourcePath: rawPath
      };
    }
  }
  return inputOptions.benchmark || await loadRetrievalBenchmark(inputOptions.datasetPath, inputOptions);
}

export async function runGraphAblationArtifactPreflight(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-ablation-artifact-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'benchmarks', 'graph-ablation-artifacts', runId));
  const benchmark = await loadBenchmarkForPreflight(inputOptions);
  const validation = validateGraphAblationArtifact(benchmark, inputOptions);
  const startedAt = new Date().toISOString();
  const artifacts = {
    reportPath: path.join(outputDir, 'graph-ablation-artifact-preflight.json'),
    reportMarkdownPath: path.join(outputDir, 'graph-ablation-artifact-preflight.md'),
    manifestPath: path.join(outputDir, 'graph-ablation-artifact-manifest.json')
  };
  const report = {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-artifact-preflight',
    runId,
    status: validation.status,
    evidenceClass: validation.evidenceClass,
    startedAt,
    endedAt: new Date().toISOString(),
    benchmark: {
      name: benchmark.name || null,
      format: benchmark.format || inputOptions.format || null,
      sourcePath: benchmark.sourcePath || inputOptions.datasetPath || null
    },
    ...validation,
    artifacts
  };

  await ensureDir(outputDir);
  await writeJson(artifacts.reportPath, report);
  await writeText(artifacts.reportMarkdownPath, renderMarkdown(report));
  await writeJson(artifacts.manifestPath, {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-artifact-manifest',
    runId,
    status: report.status,
    evidenceClass: report.evidenceClass,
    createdAt: report.endedAt,
    machine: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    benchmark: report.benchmark,
    stats: report.stats,
    gate: report.gate,
    nextStep: report.status === 'paper_ready'
      ? 'Run scripts/benchmark-graph-ranking-ablation.mjs on this dataset and integrate any paper-facing result into the appendix before claiming it.'
      : 'Resolve gate reasons before running a paper-facing graph ablation.'
  });

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (!options.datasetPath) {
    process.stderr.write(`${usage()}\n\nMissing required --dataset-path.\n`);
    process.exitCode = 1;
  } else {
    runGraphAblationArtifactPreflight(options)
      .then((report) => {
        process.stdout.write(`${JSON.stringify({
          runId: report.runId,
          status: report.status,
          evidenceClass: report.evidenceClass,
          outputDir: path.dirname(report.artifacts.reportPath),
          reportPath: report.artifacts.reportPath,
          gateReasons: report.gate.reasons
        }, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
