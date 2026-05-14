#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import { runGraphAblationArtifactPreflight } from './prepare-graph-ablation-artifact.mjs';

const CONTRACT_VERSION = 'papernexus-graph-ablation-candidate-inventory-v1';
const DEFAULT_MIN_QUERIES = 30;

function usage() {
  return [
    'Usage:',
    '  node scripts/inspect-graph-ablation-candidates.mjs [options] <candidate-path>...',
    '',
    'Options:',
    '  --run-id <id>',
    '  --output-dir <dir>',
    '  --min-queries <n>            Default: 30',
    '',
    'Candidate paths may be frozen custom benchmark JSON files or BEIR-style',
    'directories containing corpus.jsonl, queries.jsonl, and qrels/*.tsv.'
  ].join('\n');
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  const inputs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      inputs.push(arg);
      continue;
    }
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

  const runId = raw.runId || `graph-ablation-candidate-inventory-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    help: raw.help,
    runId,
    outputDir: path.resolve(raw.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-artifacts', runId)),
    minQueries: parseInteger(raw.minQueries, DEFAULT_MIN_QUERIES),
    inputs
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split('\n').filter((line) => line.trim()).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function findQrelsFiles(candidatePath) {
  const qrelsDir = path.join(candidatePath, 'qrels');
  try {
    const entries = await fs.readdir(qrelsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tsv'))
      .map((entry) => path.join(qrelsDir, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function summarizeBeirDirectory(candidatePath, options = {}) {
  const corpusPath = path.join(candidatePath, 'corpus.jsonl');
  const queriesPath = path.join(candidatePath, 'queries.jsonl');
  const qrelsFiles = await findQrelsFiles(candidatePath);
  const queryCount = await countLines(queriesPath);
  const corpusSize = await countLines(corpusPath);
  const qrelsCount = (await Promise.all(qrelsFiles.map(countLines))).reduce((sum, count) => sum + count, 0);
  const reasons = [];

  if (!corpusSize) reasons.push('missing_local_corpus');
  if (!queryCount) reasons.push('missing_fixed_query_set');
  if (queryCount && queryCount < options.minQueries) reasons.push(`query_count_below_${options.minQueries}`);
  if (!qrelsCount) reasons.push('missing_gold_relevance');

  reasons.push('missing_graph_edges');
  reasons.push('queries_missing_graph_seeds');
  reasons.push('artifact_not_marked_frozen');
  reasons.push('missing_generation_script');

  return {
    path: candidatePath,
    kind: 'beir_directory',
    status: 'not_paper_ready',
    evidenceClass: 'engineering_diagnostic',
    stats: {
      corpusSize,
      queryCount,
      qrelsCount,
      graphEdgeCount: 0,
      minQueries: options.minQueries
    },
    gate: {
      status: 'not_paper_ready',
      reasons
    }
  };
}

async function inspectCandidate(candidatePath, options = {}) {
  const resolvedPath = path.resolve(candidatePath);
  const stat = await fs.stat(resolvedPath);
  if (stat.isDirectory()) {
    if (
      await fileExists(path.join(resolvedPath, 'corpus.jsonl'))
      || await fileExists(path.join(resolvedPath, 'queries.jsonl'))
      || (await findQrelsFiles(resolvedPath)).length
    ) {
      return summarizeBeirDirectory(resolvedPath, options);
    }
    return {
      path: resolvedPath,
      kind: 'directory',
      status: 'not_paper_ready',
      evidenceClass: 'engineering_diagnostic',
      stats: {
        corpusSize: 0,
        queryCount: 0,
        qrelsCount: 0,
        graphEdgeCount: 0,
        minQueries: options.minQueries
      },
      gate: {
        status: 'not_paper_ready',
        reasons: ['unsupported_candidate_directory']
      }
    };
  }

  if (resolvedPath.toLowerCase().endsWith('.json')) {
    const report = await runGraphAblationArtifactPreflight({
      datasetPath: resolvedPath,
      outputDir: path.join(options.outputDir, 'preflight', path.basename(resolvedPath, '.json')),
      runId: `${options.runId}-${path.basename(resolvedPath, '.json')}`,
      minQueries: options.minQueries
    });
    return {
      path: resolvedPath,
      kind: 'custom_json',
      status: report.status,
      evidenceClass: report.evidenceClass,
      stats: report.stats,
      gate: report.gate,
      preflightReportPath: report.artifacts.reportPath
    };
  }

  return {
    path: resolvedPath,
    kind: 'file',
    status: 'not_paper_ready',
    evidenceClass: 'engineering_diagnostic',
    stats: {
      corpusSize: 0,
      queryCount: 0,
      qrelsCount: 0,
      graphEdgeCount: 0,
      minQueries: options.minQueries
    },
    gate: {
      status: 'not_paper_ready',
      reasons: ['unsupported_candidate_file']
    }
  };
}

function renderTsv(candidates = []) {
  const header = [
    'path',
    'kind',
    'status',
    'evidence_class',
    'corpus_size',
    'query_count',
    'qrels_count',
    'graph_edge_count',
    'gate_reasons'
  ];
  const rows = candidates.map((candidate) => [
    candidate.path,
    candidate.kind,
    candidate.status,
    candidate.evidenceClass,
    candidate.stats?.corpusSize ?? '',
    candidate.stats?.queryCount ?? '',
    candidate.stats?.qrelsCount ?? '',
    candidate.stats?.graphEdgeCount ?? '',
    (candidate.gate?.reasons || []).join(',')
  ]);
  return [header, ...rows].map((row) => row.join('\t')).join('\n') + '\n';
}

function renderMarkdown(report = {}) {
  const rows = report.candidates || [];
  return [
    `# Graph Ablation Candidate Inventory: ${report.runId}`,
    '',
    `Status: \`${report.status}\``,
    '',
    '| Candidate | Kind | Status | Corpus | Queries | Qrels | Graph edges | Gate reasons |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...rows.map((candidate) => [
      path.basename(candidate.path),
      candidate.kind,
      `\`${candidate.status}\``,
      candidate.stats?.corpusSize ?? '',
      candidate.stats?.queryCount ?? '',
      candidate.stats?.qrelsCount ?? '',
      candidate.stats?.graphEdgeCount ?? '',
      (candidate.gate?.reasons || []).map((reason) => `\`${reason}\``).join(', ')
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
    '## Boundary',
    '',
    report.status === 'has_paper_ready_candidate'
      ? 'At least one candidate passed the frozen graph-aware preflight and may be used for the next graph ablation run.'
      : 'No local candidate currently supports a paper-ready graph ablation claim. Do not promote graph ablation diagnostics into the paper until a candidate passes preflight.'
  ].join('\n') + '\n';
}

export async function runGraphAblationCandidateInventory(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-ablation-candidate-inventory-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-artifacts', runId));
  const options = {
    runId,
    outputDir,
    minQueries: parseInteger(inputOptions.minQueries, DEFAULT_MIN_QUERIES)
  };
  const candidates = [];
  for (const candidatePath of inputOptions.inputs || []) {
    candidates.push(await inspectCandidate(candidatePath, options));
  }
  const status = candidates.some((candidate) => candidate.status === 'paper_ready')
    ? 'has_paper_ready_candidate'
    : 'no_paper_ready_candidate';
  const artifacts = {
    reportPath: path.join(outputDir, 'graph-ablation-candidate-inventory.json'),
    reportMarkdownPath: path.join(outputDir, 'graph-ablation-candidate-inventory.md'),
    tablePath: path.join(outputDir, 'graph-ablation-candidate-inventory.tsv'),
    manifestPath: path.join(outputDir, 'graph-ablation-candidate-inventory-manifest.json')
  };
  const report = {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-candidate-inventory',
    runId,
    status,
    createdAt: new Date().toISOString(),
    candidates,
    artifacts
  };

  await ensureDir(outputDir);
  await writeJson(artifacts.reportPath, report);
  await writeText(artifacts.reportMarkdownPath, renderMarkdown(report));
  await writeText(artifacts.tablePath, renderTsv(candidates));
  await writeJson(artifacts.manifestPath, {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-candidate-inventory-manifest',
    runId,
    status,
    createdAt: report.createdAt,
    machine: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    candidateCount: candidates.length,
    paperReadyCandidateCount: candidates.filter((candidate) => candidate.status === 'paper_ready').length,
    minQueries: options.minQueries
  });

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (!options.inputs.length) {
    process.stderr.write(`${usage()}\n\nMissing candidate paths.\n`);
    process.exitCode = 1;
  } else {
    runGraphAblationCandidateInventory(options)
      .then((report) => {
        process.stdout.write(`${JSON.stringify({
          runId: report.runId,
          status: report.status,
          outputDir: path.dirname(report.artifacts.reportPath),
          reportPath: report.artifacts.reportPath,
          candidateCount: report.candidates.length,
          paperReadyCandidateCount: report.candidates.filter((candidate) => candidate.status === 'paper_ready').length
        }, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
