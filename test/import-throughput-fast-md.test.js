import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createImportTask, listImportTasks } from '../src/storage/import-store.js';
import { analyzeCorpus } from '../src/core/ingestion/pipeline.js';
import { getCorpusPaths, loadCorpusLite } from '../src/storage/corpus-store.js';
import { runImportQueueUntilIdle } from '../src/core/imports/worker.js';
import { listImportSemanticEnrichmentJobs } from '../src/storage/import-semantic-store.js';

const RUN_THROUGHPUT_TEST = process.env.PAPERNEXUS_THROUGHPUT_TEST === '1';
const THROUGHPUT_REPORT_PATH = process.env.PAPERNEXUS_THROUGHPUT_REPORT_PATH || '';
const DEFAULT_PROCESSING_PROFILE = 'fast-md-background-semantic';
const DEFAULT_COMPLETION_POLICY = 'graph-visible';
const DEFAULT_LLM_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEFAULT_LLM_EXTRACTION_STRATEGY = 'long-context-first';
const DEFAULT_LLM_LONG_CONTEXT_MAX_PAPERS_PER_CALL = 10;
const DEFAULT_LLM_BATCH_CONCURRENCY = 1;

function markdownFixture(index) {
  return [
    `# Fast MD Throughput Paper ${index}`,
    '',
    '## Abstract',
    '',
    `This fixture studies graph-aware discovery for generalized category discovery case ${index}.`,
    'It includes enough section structure to exercise markdown parsing without requiring provider calls.',
    '',
    '## Method',
    '',
    'The method combines source normalization, structural snapshot extraction, and graph delta assembly.',
    'The benchmark is intended to measure the graph-visible path rather than semantic LLM enrichment.',
    '',
    '## References',
    '',
    `- Reference ${index}. Example paper for structural import benchmarking.`,
    ''
  ].join('\n');
}

function representativeGcdMarkdownFixture(index) {
  const sections = [];
  for (let repeat = 1; repeat <= 72; repeat += 1) {
    sections.push(
      `### Theory Note ${repeat}`,
      '',
      'Generalized category discovery can be framed as anchored unknown-class structure discovery.',
      'Information-theoretic regularization prevents collapse, spherical prototype geometry shapes the representation space, optimal transport handles global assignment, and non-parametric Bayesian priors control the number of emerging classes.',
      'The benchmark-like discussion mentions GCD, SimGCD, GPC, ORCA, category discovery, novel class discovery, old-new trade-off, entropy regularization, contrastive learning, prototype assignment, Sinkhorn transport, DP-means, and long-tail class priors.',
      'A structural importer should preserve title, abstract, method, benchmark, dataset, metric, limitation, and reference cues without waiting for provider-backed LLM enrichment.',
      ''
    );
  }
  return [
    `# Fast MD Throughput Paper ${index}`,
    '',
    '## Abstract',
    '',
    'This representative long markdown fixture studies generalized category discovery theory at a size similar to a local GCD research note.',
    'It intentionally contains repeated but varied research cues so the structural graph-visible path exercises markdown parsing and deterministic semantic snapshot extraction on a non-tiny input.',
    '',
    '## Method',
    '',
    'The method combines source normalization, structural snapshot extraction, graph delta assembly, and direct lite graph commit.',
    '',
    ...sections,
    '## References',
    '',
    '- Vaze et al. Generalized Category Discovery.',
    '- SimGCD parametric generalized category discovery baseline.',
    '- GPC Gaussian mixture split-merge category discovery route.',
    ''
  ].join('\n');
}

function normalizeStructuralValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeStructuralValue(entry))
      .filter((entry) => !(Array.isArray(entry) && entry.length === 0))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    const normalized = {};
    for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      if (/path|rootPath|sourceId|sourceIds|sourceVariants/i.test(key)) continue;
      const nextEntry = normalizeStructuralValue(entry);
      if (nextEntry === undefined || nextEntry === null || nextEntry === '') continue;
      if (Array.isArray(nextEntry) && nextEntry.length === 0) continue;
      if (nextEntry && typeof nextEntry === 'object' && !Array.isArray(nextEntry) && Object.keys(nextEntry).length === 0) continue;
      normalized[key] = nextEntry;
    }
    return normalized;
  }
  return value;
}

function stableStructuralJson(value) {
  return JSON.stringify(normalizeStructuralValue(value));
}

function structuralNodeKey(node = {}) {
  if (node.type === 'Corpus') return 'Corpus:<corpus>';
  return `${node.type}:${node.name}`;
}

function structuralGraphSignature(corpus = {}) {
  const graph = corpus.graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const relationships = Array.isArray(graph.relationships) ? graph.relationships : [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes: nodes
      .map((node) => `${structuralNodeKey(node)} ${stableStructuralJson(node.properties || {})}`)
      .sort(),
    relationships: relationships
      .map((relationship) => {
        const sourceNode = nodesById.get(relationship.sourceId);
        const targetNode = nodesById.get(relationship.targetId);
        return [
          structuralNodeKey(sourceNode),
          `-${relationship.type}->`,
          structuralNodeKey(targetNode),
          stableStructuralJson(relationship.properties || {})
        ].join(' ');
      })
      .sort()
  };
}

function numericMax(values = []) {
  const numericValues = values.map(Number).filter((value) => Number.isFinite(value));
  return numericValues.length ? Math.max(...numericValues) : null;
}

function numericSum(values = []) {
  return values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
}

function summarizeTimingMaps(maps = []) {
  const phaseValues = new Map();
  for (const map of maps) {
    for (const [phase, elapsedMs] of Object.entries(map || {})) {
      if (!phaseValues.has(phase)) phaseValues.set(phase, []);
      phaseValues.get(phase).push(elapsedMs);
    }
  }
  return Object.fromEntries(
    [...phaseValues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, values]) => [phase, {
        maxMs: numericMax(values),
        sumMs: numericSum(values)
      }])
  );
}

function buildDefault1mEffectiveConfig(overrides = {}) {
  const config = {
    processingProfile: overrides.processingProfile || DEFAULT_PROCESSING_PROFILE,
    completionPolicy: overrides.completionPolicy || DEFAULT_COMPLETION_POLICY,
    llmContextWindowTokens: Number(overrides.llmContextWindowTokens || DEFAULT_LLM_CONTEXT_WINDOW_TOKENS),
    llmExtractionStrategy: overrides.llmExtractionStrategy || DEFAULT_LLM_EXTRACTION_STRATEGY,
    llmLongContextMaxPapersPerCall: Number(overrides.llmLongContextMaxPapersPerCall || DEFAULT_LLM_LONG_CONTEXT_MAX_PAPERS_PER_CALL),
    llmBatchConcurrency: Number(overrides.llmBatchConcurrency || DEFAULT_LLM_BATCH_CONCURRENCY),
    graphVisibleCriticalPath: 'fast-md-structural',
    semanticEnrichmentPath: 'background-long-context-first',
    llmConfigScope: 'worker-options',
    taskLevelLlmOverride: false
  };
  const deviationReasons = [];
  if (config.llmContextWindowTokens !== DEFAULT_LLM_CONTEXT_WINDOW_TOKENS) {
    deviationReasons.push('llmContextWindowTokens');
  }
  if (config.llmExtractionStrategy !== DEFAULT_LLM_EXTRACTION_STRATEGY) {
    deviationReasons.push('llmExtractionStrategy');
  }
  return {
    ...config,
    deviatesFromDefault1mContext: deviationReasons.length > 0,
    deviationReasons
  };
}

function buildThroughputBenchmarkReport({
  rootPath,
  elapsedMs,
  result,
  createdTasks,
  completedTasks,
  semanticJobs,
  corpus,
  liteState,
  sourceFileSizes,
  effectiveConfig = buildDefault1mEffectiveConfig()
}) {
  const taskRows = completedTasks.map((task) => {
    const importPerformance = task?.result?.metrics?.importPerformance || {};
    return {
      taskId: task?.id || null,
      status: task?.status || null,
      processingProfile: task?.processingProfile || null,
      completionPolicy: task?.completionPolicy || null,
      graphVisibilityStatus: task?.graphVisibilityStatus || null,
      semanticStatus: task?.semanticStatus || null,
      graphVisibleLatencyMs: Number(task?.throughputMetrics?.graphVisibleLatencyMs),
      changedSourceKeys: task?.result?.fastCommitted?.changedSourceKeys || [],
      semanticJobIds: task?.result?.semanticEnrichment?.jobIds || [],
      directDeltaCommit: Boolean(task?.result?.fastCommitted?.directDeltaCommit),
      llmOptimizeSkipped: Boolean(importPerformance.llmOptimizeSkipped),
      materialize: importPerformance.materialize || null,
      materializeTimings: task?.result?.materialized?.timings || {},
      stageTimingsMs: importPerformance.stageTimingsMs || {},
      fastCommitPhasesMs: importPerformance.fastCommitPhasesMs || {}
    };
  });
  const sourceKeys = taskRows.flatMap((task) => task.changedSourceKeys);
  const materializeRows = taskRows
    .map((task) => task.materialize)
    .filter((entry) => entry && typeof entry === 'object');
  return {
    contractVersion: 'papernexus-fast-md-throughput-report-v1',
    generatedAt: new Date().toISOString(),
    rootPath,
    elapsedMs,
    effectiveConfig,
    taskCount: completedTasks.length,
    createdTaskCount: createdTasks.length,
    completedTaskCount: taskRows.filter((task) => task.status === 'completed').length,
    failedTaskCount: Number(result.failedCount || 0),
    graphVisible: {
      completedCount: taskRows.filter((task) => task.graphVisibilityStatus === 'completed').length,
      maxLatencyMs: numericMax(taskRows.map((task) => task.graphVisibleLatencyMs))
    },
    semanticEnrichment: {
      pendingJobCount: semanticJobs.summary?.pending || 0,
      totalJobCount: semanticJobs.jobs?.length || 0
    },
    sourceFiles: sourceFileSizes,
    graph: {
      paperCount: corpus.meta.paperCount,
      nodeCount: corpus.meta.nodeCount,
      relationshipCount: corpus.meta.relationshipCount,
      liteSourceCount: Object.keys(liteState.sources || {}).length,
      changedSourceKeysPresent: sourceKeys.filter((sourceKey) => liteState.sources?.[sourceKey]).length,
      signatureNodeCount: structuralGraphSignature(corpus).nodes.length,
      signatureRelationshipCount: structuralGraphSignature(corpus).relationships.length
    },
    timings: {
      materialize: {
        contractVersion: 'import-materialize-performance-summary-v1',
        batchMaterializedTaskCount: materializeRows.filter((entry) => entry.batchMaterialized).length,
        maxInputCount: numericMax(materializeRows.map((entry) => entry.inputCount)),
        maxTaskCount: numericMax(materializeRows.map((entry) => entry.taskCount)),
        maxEffectiveConcurrency: numericMax(materializeRows.map((entry) => entry.effectiveConcurrency)),
        maxAnalyzeConcurrency: numericMax(materializeRows.map((entry) => entry.analyzeConcurrency)),
        maxMetadataConcurrency: numericMax(materializeRows.map((entry) => entry.metadataConcurrency)),
        maxMeanMsPerInput: numericMax(materializeRows.map((entry) => entry.meanMsPerInput)),
        maxElapsedMs: numericMax(materializeRows.map((entry) => entry.elapsedMs)),
        taskObservedElapsedSumMs: numericSum(materializeRows.map((entry) => entry.elapsedMs))
      },
      materializePhaseMaxMs: summarizeTimingMaps(taskRows.map((task) => task.materializeTimings)),
      stageMaxMs: summarizeTimingMaps(taskRows.map((task) => task.stageTimingsMs)),
      fastCommitPhaseMaxMs: summarizeTimingMaps(taskRows.map((task) => task.fastCommitPhasesMs))
    },
    tasks: taskRows
  };
}

async function writeThroughputBenchmarkReport(report) {
  if (!THROUGHPUT_REPORT_PATH) return;
  await fs.mkdir(path.dirname(THROUGHPUT_REPORT_PATH), { recursive: true });
  await fs.writeFile(THROUGHPUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function createMarkdownTask(rootPath, name, content, options = {}) {
  return createImportTask(rootPath, {
    trigger: 'throughput-test',
    processingProfile: options.processingProfile || DEFAULT_PROCESSING_PROFILE,
    completionPolicy: options.completionPolicy || DEFAULT_COMPLETION_POLICY,
    files: [
      {
        name,
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
        mimeType: 'text/markdown'
      }
    ]
  });
}

async function createFastMdTask(rootPath, name, content) {
  return createMarkdownTask(rootPath, name, content, {
    processingProfile: DEFAULT_PROCESSING_PROFILE,
    completionPolicy: DEFAULT_COMPLETION_POLICY
  });
}

test('fast-md direct structural commit matches full heuristic graph layer metadata', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-equivalence-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-equivalence-workspace-'));
  const fullInputRoot = path.join(workspaceRoot, 'full-papers');
  const fastSeedRoot = path.join(workspaceRoot, 'fast-seed');
  const fullRootPath = path.join(workspaceRoot, 'full-index');
  const fastRootPath = path.join(workspaceRoot, 'fast-index');
  const previousHome = process.env.PAPERNEXUS_HOME;
  const uploads = [
    ['fast-md-one.md', markdownFixture('Equivalence One')],
    ['fast-md-two.md', markdownFixture('Equivalence Two')]
  ];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(fullInputRoot, { recursive: true });
    await fs.mkdir(fastSeedRoot, { recursive: true });
    await fs.writeFile(path.join(fullInputRoot, 'seed.md'), markdownFixture('Equivalence Seed'));
    await fs.writeFile(path.join(fastSeedRoot, 'seed.md'), markdownFixture('Equivalence Seed'));
    for (const [fileName, content] of uploads) {
      await fs.writeFile(path.join(fullInputRoot, fileName), content);
    }

    await analyzeCorpus(fullInputRoot, {
      rootPath: fullRootPath,
      name: 'fast-md-equivalence-full',
      force: true,
      semanticExtraction: 'heuristic-only'
    });
    await analyzeCorpus(fastSeedRoot, {
      rootPath: fastRootPath,
      name: 'fast-md-equivalence-fast',
      force: true,
      semanticExtraction: 'heuristic-only'
    });

    for (const [fileName, content] of uploads) {
      await createFastMdTask(fastRootPath, fileName, content);
    }

    const result = await runImportQueueUntilIdle(fastRootPath, {
      semanticExtraction: 'llm-primary',
      batchEnabled: true,
      batchProgressive: false,
      batchInitialTasks: uploads.length,
      batchMaxTasks: uploads.length,
      fastMdMaterializeConcurrency: 4,
      maxPasses: 3
    });
    assert.equal(result.failedCount, 0);
    assert.equal(result.completedTaskIds.length, uploads.length);

    const fullCorpus = await loadCorpusLite(fullRootPath);
    const fastCorpus = await loadCorpusLite(fastRootPath);
    assert.deepEqual(
      structuralGraphSignature(fastCorpus),
      structuralGraphSignature(fullCorpus)
    );
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('fast-md graph-visible throughput benchmark for ten markdown papers', {
  skip: RUN_THROUGHPUT_TEST ? false : 'set PAPERNEXUS_THROUGHPUT_TEST=1 to run the fast-md throughput benchmark'
}, async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-throughput-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-throughput-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const rootPath = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.writeFile(path.join(inputRoot, 'seed.md'), markdownFixture('Seed'));
    await analyzeCorpus(inputRoot, {
      rootPath,
      name: 'fast-md-throughput-test',
      force: true,
      semanticExtraction: 'heuristic-only'
    });

    const createdTasks = [];
    const sourceFileSizes = [];
    for (let index = 1; index <= 10; index += 1) {
      const content = index === 10
        ? representativeGcdMarkdownFixture(index)
        : markdownFixture(index);
      sourceFileSizes.push({
        name: `fast-md-paper-${index}.md`,
        bytes: Buffer.byteLength(content, 'utf8')
      });
      createdTasks.push(await createFastMdTask(rootPath, `fast-md-paper-${index}.md`, content));
    }

    const listed = await listImportTasks(rootPath);
    assert.equal(createdTasks.length, 10);
    assert.equal(listed.summary.pending, 10);
    assert.equal(listed.tasks.every((task) => task.processingProfile === 'fast-md-background-semantic'), true);
    assert.equal(listed.tasks.every((task) => task.completionPolicy === 'graph-visible'), true);

    const startedAt = Date.now();
    const effectiveConfig = buildDefault1mEffectiveConfig();
    const result = await runImportQueueUntilIdle(rootPath, {
      semanticExtraction: 'llm-primary',
      batchEnabled: true,
      batchProgressive: false,
      batchInitialTasks: 10,
      batchMaxTasks: 10,
      fastMdMaterializeConcurrency: 8,
      llmContextWindowTokens: effectiveConfig.llmContextWindowTokens,
      llmExtractionStrategy: effectiveConfig.llmExtractionStrategy,
      llmLongContextMaxPapersPerCall: effectiveConfig.llmLongContextMaxPapersPerCall,
      llmBatchConcurrency: effectiveConfig.llmBatchConcurrency,
      maxPasses: 3
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.failedCount, 0);
    assert.equal(result.completedTaskIds.length, 10);

    const completed = await listImportTasks(rootPath);
    const taskById = new Map(completed.tasks.map((task) => [task.id, task]));
    const completedTasks = createdTasks.map((task) => taskById.get(task.id));
    assert.equal(completedTasks.every((task) => task?.status === 'completed'), true);
    assert.equal(completedTasks.every((task) => task?.graphVisibilityStatus === 'completed'), true);
    assert.equal(completedTasks.every((task) => task?.semanticStatus === 'queued'), true);
    assert.equal(completedTasks.every((task) => task?.result?.semanticEnrichment?.jobIds?.length === 1), true);
    assert.equal(completedTasks.every((task) => task?.result?.optimized?.skipped === true), true);
    assert.equal(completedTasks.every((task) => task?.result?.fastCommitted?.directDeltaCommit === true), true);
    assert.equal(completedTasks.every((task) => task?.result?.metrics?.importPerformance?.llmOptimizeSkipped === true), true);
    assert.equal(completedTasks.every((task) => (
      task?.result?.metrics?.importPerformance?.materialize?.mode === 'fast-md-batch'
    )), true);
    assert.equal(completedTasks.every((task) => (
      task?.result?.metrics?.importPerformance?.materialize?.inputCount === 10
    )), true);
    assert.equal(completedTasks.every((task) => (
      task?.result?.metrics?.importPerformance?.materialize?.effectiveConcurrency === 8
    )), true);
    const semanticJobs = await listImportSemanticEnrichmentJobs(rootPath);
    assert.equal(semanticJobs.summary.pending, 10);

    const corpus = await loadCorpusLite(rootPath);
    assert.equal(corpus.meta.paperCount, 11);
    for (let index = 1; index <= 10; index += 1) {
      assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper' && node.name === `Fast MD Throughput Paper ${index}`));
    }

    const sourceKeys = completedTasks.flatMap((task) => task.result.fastCommitted.changedSourceKeys);
    const { liteStatePath } = getCorpusPaths(rootPath);
    const liteState = JSON.parse(await fs.readFile(liteStatePath, 'utf8'));
    for (const sourceKey of sourceKeys) {
      assert.ok(liteState.sources[sourceKey]);
    }

    const graphVisibleLatencies = completedTasks
      .map((task) => Number(task.throughputMetrics?.graphVisibleLatencyMs))
      .filter((value) => Number.isFinite(value));
    assert.equal(graphVisibleLatencies.length, 10);
    assert.ok(Math.max(...graphVisibleLatencies) <= 60_000);
    assert.ok(elapsedMs <= 60_000);

    const report = buildThroughputBenchmarkReport({
      rootPath,
      elapsedMs,
      result,
      createdTasks,
      completedTasks,
      semanticJobs,
      corpus,
      liteState,
      sourceFileSizes,
      effectiveConfig
    });
    assert.equal(report.contractVersion, 'papernexus-fast-md-throughput-report-v1');
    assert.equal(report.effectiveConfig.llmContextWindowTokens, 1_000_000);
    assert.equal(report.effectiveConfig.llmExtractionStrategy, 'long-context-first');
    assert.equal(report.effectiveConfig.llmLongContextMaxPapersPerCall, 10);
    assert.equal(report.effectiveConfig.llmBatchConcurrency, 1);
    assert.equal(report.effectiveConfig.deviatesFromDefault1mContext, false);
    assert.deepEqual(report.effectiveConfig.deviationReasons, []);
    assert.equal(report.taskCount, 10);
    assert.equal(report.completedTaskCount, 10);
    assert.equal(report.graphVisible.completedCount, 10);
    assert.equal(report.graph.changedSourceKeysPresent, 10);
    assert.equal(report.semanticEnrichment.pendingJobCount, 10);
    assert.equal(report.tasks.every((task) => task.directDeltaCommit), true);
    assert.equal(report.tasks.every((task) => task.llmOptimizeSkipped), true);
    assert.equal(report.tasks.every((task) => task.materialize.mode === 'fast-md-batch'), true);
    assert.equal(report.timings.materialize.batchMaterializedTaskCount, 10);
    assert.equal(report.timings.materialize.maxInputCount, 10);
    assert.equal(report.timings.materialize.maxTaskCount, 10);
    assert.equal(report.timings.materialize.maxEffectiveConcurrency, 8);
    assert.equal(report.timings.materialize.maxAnalyzeConcurrency, 8);
    assert.equal(report.timings.materialize.maxMetadataConcurrency, 8);
    assert.equal(typeof report.timings.materialize.maxMeanMsPerInput, 'number');
    assert.equal(report.timings.materializePhaseMaxMs.mergePreviousSourceCount.maxMs, 1);
    assert.equal(report.timings.materializePhaseMaxMs.mergeMaterializedSourceCount.maxMs, 10);
    assert.equal(report.timings.materializePhaseMaxMs.mergeAffectedSourceCount.maxMs, 10);
    assert.equal(report.timings.materializePhaseMaxMs.mergeUntouchedSourceCount.maxMs, 1);
    assert.equal(report.timings.materializePhaseMaxMs.mergeSnapshotReloadMs.maxMs, 0);
    assert.ok(Math.max(...report.sourceFiles.map((file) => file.bytes)) >= 30_000);
    assert.equal(typeof report.timings.fastCommitPhaseMaxMs.buildDelta?.maxMs, 'number');
    assert.equal(typeof report.timings.fastCommitPhaseMaxMs.writeDelta?.maxMs, 'number');
    await writeThroughputBenchmarkReport(report);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('full markdown import control does not use fast-md graph-visible shortcut', {
  skip: RUN_THROUGHPUT_TEST ? false : 'set PAPERNEXUS_THROUGHPUT_TEST=1 to run the fast-md throughput benchmark controls'
}, async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-control-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-md-control-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const rootPath = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.writeFile(path.join(inputRoot, 'seed.md'), markdownFixture('Control Seed'));
    await analyzeCorpus(inputRoot, {
      rootPath,
      name: 'fast-md-throughput-control',
      force: true,
      semanticExtraction: 'heuristic-only'
    });

    const task = await createMarkdownTask(rootPath, 'full-control.md', markdownFixture('Full Control'), {
      processingProfile: 'full',
      completionPolicy: 'full'
    });
    const result = await runImportQueueUntilIdle(rootPath, {
      semanticExtraction: 'heuristic-only',
      batchEnabled: false,
      maxPasses: 3
    });
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.completedTaskIds, [task.id]);

    const completed = await listImportTasks(rootPath);
    const completedTask = completed.tasks.find((entry) => entry.id === task.id);
    const importPerformance = completedTask?.result?.metrics?.importPerformance || {};
    assert.equal(completedTask?.status, 'completed');
    assert.equal(completedTask?.processingProfile, 'full');
    assert.equal(completedTask?.completionPolicy, 'full');
    assert.equal(completedTask?.graphVisibilityStatus, 'completed');
    assert.equal(completedTask?.semanticStatus, 'completed');
    assert.equal(completedTask?.result?.semanticEnrichment, undefined);
    assert.equal(completedTask?.result?.optimized?.skipped, undefined);
    assert.equal(completedTask?.result?.fastCommitted?.directDeltaCommit, undefined);
    assert.equal(importPerformance.llmOptimizeSkipped, false);
    assert.equal(importPerformance.directDeltaCommit, false);
    assert.equal(importPerformance.materialize.mode, 'single-task');
    assert.equal(importPerformance.materialize.batchMaterialized, false);
    assert.equal(importPerformance.materialize.inputCount, 1);
    assert.equal(importPerformance.materialize.effectiveConcurrency, 1);
    assert.equal(typeof importPerformance.stageTimingsMs.materialize, 'number');
    assert.equal(typeof importPerformance.stageTimingsMs.llmOptimize, 'number');
    assert.equal(typeof importPerformance.stageTimingsMs.fastCommit, 'number');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
