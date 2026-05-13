#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import { stableHash } from '../src/lib/utils.js';
import { loadKuzuV2Summary, saveGraphDeltaToKuzu } from '../src/storage/kuzu-store.js';

const DEFAULT_PAPER_COUNTS = [100, 1000, 10000];
const DEFAULT_BATCH_SIZE = 100;

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIntegerList(value, fallback) {
  if (!value) return fallback;
  const values = String(value)
    .split(',')
    .map((item) => parseInteger(item, null))
    .filter((item) => Number.isFinite(item) && item > 0);
  return values.length ? values : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }
  const runId = String(options.runId || `graph-v2-delta-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const outputDir = path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'graph-v2-delta', runId));
  return {
    runId,
    outputDir,
    paperCounts: parseIntegerList(options.paperCounts || options.paperCount, DEFAULT_PAPER_COUNTS),
    batchSize: parseInteger(options.batchSize, DEFAULT_BATCH_SIZE),
    continueOnError: parseBoolean(options.continueOnError, false),
    resume: parseBoolean(options.resume, false),
    reset: parseBoolean(options.reset, true)
  };
}

async function pathSizeBytes(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    if (!stats.isDirectory()) return stats.size;
    const entries = await fs.readdir(targetPath);
    let total = 0;
    for (const entry of entries) {
      total += await pathSizeBytes(path.join(targetPath, entry));
    }
    return total;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function makeRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`, 24)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function makeNode(id, type, name, properties = {}) {
  return {
    id,
    type,
    name,
    properties: {
      layer: properties.layer || type,
      ...properties
    }
  };
}

function buildSyntheticGraphDelta({ runId, scenarioPaperCount, batchIndex, startPaperIndex, paperCount }) {
  const corpusId = `corpus:graph-v2-delta:${stableHash(`${runId}:${scenarioPaperCount}`, 16)}`;
  const targetManifestToken = `${runId}:papers-${scenarioPaperCount}:batch-${batchIndex}`;
  const baseManifestToken = batchIndex === 0
    ? `${runId}:papers-${scenarioPaperCount}:base`
    : `${runId}:papers-${scenarioPaperCount}:batch-${batchIndex - 1}`;
  const upsertNodes = [
    makeNode(corpusId, NODE_TYPES.CORPUS, `Graph v2 delta benchmark ${scenarioPaperCount}`, {
      benchmarkRunId: runId,
      scenarioPaperCount
    })
  ];
  const upsertRelationships = [];
  const sourceEntries = [];
  const changedSourceKeys = [];

  for (let offset = 0; offset < paperCount; offset += 1) {
    const paperIndex = startPaperIndex + offset;
    const sourceKey = `source:synthetic:${scenarioPaperCount}:${paperIndex}`;
    const paperId = `paper:synthetic:${scenarioPaperCount}:${paperIndex}`;
    const problemId = `problem:synthetic:${scenarioPaperCount}:${paperIndex}`;
    const methodId = `method:synthetic:${scenarioPaperCount}:${paperIndex}`;
    const claimId = `claim:synthetic:${scenarioPaperCount}:${paperIndex}`;
    const datasetId = `dataset:synthetic:${scenarioPaperCount}:${paperIndex % 50}`;
    const paperTitle = `Synthetic Graph Delta Paper ${paperIndex}`;

    const paperNodes = [
      makeNode(paperId, NODE_TYPES.PAPER, paperTitle, {
        paperId,
        sourceKey,
        paperTitle,
        year: 2020 + (paperIndex % 7)
      }),
      makeNode(problemId, NODE_TYPES.PROBLEM, `Synthetic retrieval problem ${paperIndex % 200}`, {
        sourceKey,
        confidence: 0.82
      }),
      makeNode(methodId, NODE_TYPES.METHOD, `Synthetic graph method ${paperIndex % 300}`, {
        sourceKey,
        confidence: 0.84
      }),
      makeNode(claimId, NODE_TYPES.CLAIM, `Synthetic claim ${paperIndex}`, {
        sourceKey,
        confidence: 0.8
      }),
      makeNode(datasetId, NODE_TYPES.DATASET, `Synthetic benchmark dataset ${paperIndex % 50}`, {
        syntheticSharedNode: true
      })
    ];
    const paperRelationships = [
      makeRelationship(corpusId, paperId, EDGE_TYPES.CONTAINS, { sourceKey }),
      makeRelationship(paperId, problemId, EDGE_TYPES.STUDIED_IN, { sourceKey }),
      makeRelationship(methodId, problemId, EDGE_TYPES.SOLVES, { sourceKey }),
      makeRelationship(paperId, methodId, EDGE_TYPES.USES, { sourceKey }),
      makeRelationship(claimId, datasetId, EDGE_TYPES.EVALUATES_ON, { sourceKey })
    ];

    upsertNodes.push(...paperNodes);
    upsertRelationships.push(...paperRelationships);
    changedSourceKeys.push(sourceKey);
    sourceEntries.push({
      sourceKey,
      paperId,
      fingerprint: stableHash(`${runId}:${scenarioPaperCount}:${paperIndex}`, 24),
      nodeIds: paperNodes.map((node) => node.id),
      relationshipIds: paperRelationships.map((relationship) => relationship.id)
    });
  }

  return {
    baseManifestToken,
    targetManifestToken,
    changedSourceKeys,
    upsertNodes,
    upsertRelationships,
    deleteNodeIds: [],
    deleteRelationshipIds: [],
    sourceEntries
  };
}

async function readCompletedBatchRows(jsonlPath) {
  try {
    const rows = [];
    const text = await fs.readFile(jsonlPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.status === 'completed') rows.push(row);
    }
    return rows;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function summarizeBatchRows(batchRows = []) {
  const completedRows = batchRows.filter((row) => row.status === 'completed');
  const failedRows = batchRows.filter((row) => row.status === 'failed');
  const totalWallMs = completedRows.reduce((sum, row) => sum + Number(row.wallMs || 0), 0);
  const totalPapers = completedRows.reduce((sum, row) => sum + Number(row.paperCount || 0), 0);
  const maxRssBytes = completedRows.reduce((max, row) => Math.max(max, Number(row.rssBytes || 0)), 0);
  const finalDiskBytes = completedRows.reduce((max, row) => Math.max(max, Number(row.diskBytes || 0)), 0);
  return {
    completedBatchCount: completedRows.length,
    failedBatchCount: failedRows.length,
    totalPapers,
    totalWallMs,
    throughputPapersPerSecond: totalWallMs > 0 ? totalPapers / (totalWallMs / 1000) : 0,
    maxRssBytes,
    finalDiskBytes
  };
}

async function runScenario(options, scenarioPaperCount) {
  const scenarioId = `papers-${scenarioPaperCount}`;
  const scenarioDir = path.join(options.outputDir, scenarioId);
  const dbPath = path.join(scenarioDir, 'graph-v2.kuzu');
  const perBatchPath = path.join(scenarioDir, 'per-batch-results.jsonl');
  const failuresPath = path.join(scenarioDir, 'failures.jsonl');
  const manifestPath = path.join(scenarioDir, 'run-manifest.json');

  if (!options.resume && options.reset) {
    await fs.rm(scenarioDir, { recursive: true, force: true });
  }
  await ensureDir(scenarioDir);
  if (!options.resume) {
    await Promise.all([
      fs.rm(perBatchPath, { force: true }),
      fs.rm(failuresPath, { force: true }),
      fs.rm(path.join(scenarioDir, 'report.json'), { force: true }),
      fs.rm(path.join(scenarioDir, 'report.md'), { force: true }),
      fs.rm(path.join(scenarioDir, 'time.txt'), { force: true })
    ]);
  }

  const manifest = {
    runId: options.runId,
    scenarioId,
    kind: 'graph-v2-delta-micro-benchmark',
    startedAt: new Date().toISOString(),
    paperCount: scenarioPaperCount,
    batchSize: options.batchSize,
    dbPath,
    outputDir: scenarioDir,
    nodeVersion: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    resume: options.resume,
    reset: options.reset
  };
  await writeJson(manifestPath, manifest);

  const completedRows = await readCompletedBatchRows(perBatchPath);
  const completedKeys = new Set(completedRows.map((row) => row.batchKey));
  const batchRows = [...completedRows];
  const startedAt = performance.now();

  for (let startPaperIndex = 0, batchIndex = 0; startPaperIndex < scenarioPaperCount; startPaperIndex += options.batchSize, batchIndex += 1) {
    const paperCount = Math.min(options.batchSize, scenarioPaperCount - startPaperIndex);
    const batchKey = `${scenarioId}:batch-${batchIndex}`;
    if (options.resume && completedKeys.has(batchKey)) {
      continue;
    }

    const deltaPayload = buildSyntheticGraphDelta({
      runId: options.runId,
      scenarioPaperCount,
      batchIndex,
      startPaperIndex,
      paperCount
    });
    const batchStartedAt = performance.now();
    try {
      const result = await saveGraphDeltaToKuzu(dbPath, deltaPayload, {
        baseManifestToken: deltaPayload.baseManifestToken,
        targetManifestToken: deltaPayload.targetManifestToken,
        reset: !options.resume && options.reset && batchIndex === 0
      });
      const wallMs = performance.now() - batchStartedAt;
      const diskBytes = await pathSizeBytes(dbPath);
      const memory = process.memoryUsage();
      const row = {
        status: 'completed',
        batchKey,
        batchIndex,
        startPaperIndex,
        paperCount,
        wallMs,
        throughputPapersPerSecond: paperCount / (wallMs / 1000),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        diskBytes,
        targetManifestToken: deltaPayload.targetManifestToken,
        reused: Boolean(result.reused),
        upsertedNodeCount: result.upsertedNodeCount,
        upsertedRelationshipCount: result.upsertedRelationshipCount,
        sourceFragmentCount: result.sourceFragmentCount,
        nodeContributionCount: result.nodeContributionCount,
        relationshipContributionCount: result.relationshipContributionCount,
        deltaHash: result.deltaHash,
        jobId: result.jobId,
        completedAt: new Date().toISOString()
      };
      batchRows.push(row);
      await appendJsonl(perBatchPath, row);
    } catch (error) {
      const row = {
        status: 'failed',
        batchKey,
        batchIndex,
        startPaperIndex,
        paperCount,
        error: error?.message || String(error),
        failedAt: new Date().toISOString()
      };
      batchRows.push(row);
      await appendJsonl(failuresPath, row);
      if (!options.continueOnError) throw error;
    }
  }

  const summaryStartedAt = performance.now();
  const graphSummary = await loadKuzuV2Summary(dbPath);
  const summaryLatencyMs = performance.now() - summaryStartedAt;
  const scenarioWallMs = performance.now() - startedAt;
  const batchSummary = summarizeBatchRows(batchRows);
  const report = {
    ...manifest,
    completedAt: new Date().toISOString(),
    status: batchSummary.failedBatchCount ? 'partial' : 'completed',
    wallMs: scenarioWallMs,
    batchSummary,
    graphSummary: {
      ...graphSummary,
      summaryLatencyMs,
      diskBytes: await pathSizeBytes(dbPath)
    },
    artifacts: {
      manifestPath,
      perBatchPath,
      failuresPath,
      reportPath: path.join(scenarioDir, 'report.json'),
      reportMarkdownPath: path.join(scenarioDir, 'report.md'),
      timePath: path.join(scenarioDir, 'time.txt')
    }
  };

  await writeJson(report.artifacts.reportPath, report);
  await writeText(report.artifacts.timePath, [
    `run_id=${options.runId}`,
    `scenario=${scenarioId}`,
    `status=${report.status}`,
    `wall_ms=${Math.round(report.wallMs)}`,
    `completed_batches=${batchSummary.completedBatchCount}`,
    `failed_batches=${batchSummary.failedBatchCount}`,
    `throughput_papers_per_second=${batchSummary.throughputPapersPerSecond.toFixed(3)}`
  ].join('\n') + '\n');
  await writeText(report.artifacts.reportMarkdownPath, renderScenarioReport(report));
  return report;
}

function renderScenarioReport(report) {
  return [
    `# Graph-v2 Delta Micro-Benchmark: ${report.scenarioId}`,
    '',
    `- Status: ${report.status}`,
    `- Papers: ${report.paperCount}`,
    `- Batch size: ${report.batchSize}`,
    `- Wall time: ${Math.round(report.wallMs)} ms`,
    `- Completed batches: ${report.batchSummary.completedBatchCount}`,
    `- Failed batches: ${report.batchSummary.failedBatchCount}`,
    `- Throughput: ${report.batchSummary.throughputPapersPerSecond.toFixed(3)} papers/s`,
    `- Kuzu nodes: ${report.graphSummary.nodeCount}`,
    `- Kuzu relationships: ${report.graphSummary.relationshipCount}`,
    `- Source fragments: ${report.graphSummary.sourceFragmentCount}`,
    `- Completed delta journal entries: ${report.graphSummary.completedDeltaCount}`,
    `- Summary latency: ${report.graphSummary.summaryLatencyMs.toFixed(3)} ms`,
    `- Disk bytes: ${report.graphSummary.diskBytes}`,
    `- Max RSS bytes: ${report.batchSummary.maxRssBytes}`,
    '',
    'Artifacts:',
    '',
    `- \`${report.artifacts.manifestPath}\``,
    `- \`${report.artifacts.perBatchPath}\``,
    `- \`${report.artifacts.failuresPath}\``,
    `- \`${report.artifacts.reportPath}\``
  ].join('\n') + '\n';
}

function renderAggregateReport(report) {
  const lines = [
    `# Graph-v2 Delta Micro-Benchmark: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Batch size: ${report.batchSize}`,
    '',
    '| Scenario | Status | Papers | Batches | Wall ms | Papers/s | Nodes | Rels | Disk bytes | Max RSS bytes |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const scenario of report.scenarios) {
    lines.push([
      scenario.scenarioId,
      scenario.status,
      scenario.paperCount,
      scenario.batchSummary.completedBatchCount,
      Math.round(scenario.wallMs),
      scenario.batchSummary.throughputPapersPerSecond.toFixed(3),
      scenario.graphSummary.nodeCount,
      scenario.graphSummary.relationshipCount,
      scenario.graphSummary.diskBytes,
      scenario.batchSummary.maxRssBytes
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

export async function runGraphV2DeltaBenchmark(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-v2-delta-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const options = {
    runId,
    outputDir: path.resolve(inputOptions.outputDir || path.join('.papernexus', 'benchmarks', 'graph-v2-delta', runId)),
    paperCounts: inputOptions.paperCounts || DEFAULT_PAPER_COUNTS,
    batchSize: inputOptions.batchSize || DEFAULT_BATCH_SIZE,
    continueOnError: Boolean(inputOptions.continueOnError),
    resume: Boolean(inputOptions.resume),
    reset: inputOptions.reset !== false
  };
  const startedAt = new Date().toISOString();
  await ensureDir(options.outputDir);

  const scenarios = [];
  for (const paperCount of options.paperCounts) {
    scenarios.push(await runScenario(options, paperCount));
  }

  const report = {
    runId: options.runId,
    kind: 'graph-v2-delta-micro-benchmark',
    status: scenarios.some((scenario) => scenario.status !== 'completed') ? 'partial' : 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    outputDir: options.outputDir,
    paperCounts: options.paperCounts,
    batchSize: options.batchSize,
    scenarios,
    artifacts: {
      reportPath: path.join(options.outputDir, 'report.json'),
      reportMarkdownPath: path.join(options.outputDir, 'report.md')
    }
  };
  await writeJson(report.artifacts.reportPath, report);
  await writeText(report.artifacts.reportMarkdownPath, renderAggregateReport(report));
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runGraphV2DeltaBenchmark(options);
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      papers: scenario.paperCount,
      throughputPapersPerSecond: scenario.batchSummary.throughputPapersPerSecond
    }))
  }, null, 2));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
