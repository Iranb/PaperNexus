import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { NODE_TYPES } from '../src/core/graph/schema.js';
import {
  executeIngestionGraphMutations,
  INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION
} from '../src/core/ingestion/graph-mutation-executor.js';
import {
  INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
  INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION
} from '../src/core/ingestion/parser-orchestrator.js';
import { loadCorpus } from '../src/storage/corpus-store.js';

const execFileAsync = promisify(execFile);

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function mutationArtifact() {
  return {
    contractVersion: INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION,
    dryRun: true,
    writePolicy: 'preview_only',
    operations: [{
      action: 'create_node',
      id: 'claim:ingestion-executor',
      type: NODE_TYPES.CLAIM,
      name: 'Ingestion executor claim',
      properties: {
        source_span_ids: ['span:executor'],
        relationSource: 'ingestion-executor-test'
      }
    }],
    diagnostics: {
      operationCount: 1,
      nodeOperationCount: 1,
      edgeOperationCount: 0,
      warnings: []
    }
  };
}

function applyPlan(status = 'preview_only') {
  const ready = status === 'ready_to_apply';
  return {
    contractVersion: INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
    generatedAt: '2026-05-27T00:00:00.000Z',
    mode: ready ? 'release-gated' : 'preview',
    status,
    canApply: ready,
    dryRun: true,
    writePolicy: ready ? 'release-gated-apply' : 'preview-only',
    releaseGateStatus: ready ? 'passed' : 'incomplete',
    operationCount: 1,
    gates: ready
      ? [
          { name: 'graph_mutations_present', status: 'passed', ok: true },
          { name: 'multimodal_asset_audit_complete', status: 'passed', ok: true },
          { name: 'citation_intent_benchmark_passed', status: 'passed', ok: true },
          { name: 'claim_extraction_benchmark_passed', status: 'passed', ok: true },
          { name: 'explicit_release_gated_apply_requested', status: 'passed', ok: true }
        ]
      : [
          { name: 'graph_mutations_present', status: 'passed', ok: true },
          { name: 'multimodal_asset_audit_complete', status: 'incomplete', ok: false },
          { name: 'citation_intent_benchmark_passed', status: 'incomplete', ok: false },
          { name: 'claim_extraction_benchmark_passed', status: 'incomplete', ok: false },
          { name: 'explicit_release_gated_apply_requested', status: 'incomplete', ok: false }
        ],
    blockingReasons: ready ? [] : [{
      code: 'citation_intent_benchmark_passed',
      status: 'incomplete',
      message: 'missing benchmark evaluation'
    }],
    safety: {
      defaultBehavior: 'preview-only',
      authoritativeGraphWritePerformed: false
    },
    inputs: ready
      ? [
          { role: 'citation_intent_gold_labels', path: '/artifacts/ingestion/citation-intent-gold.json', sha256: 'sha-citation-intent-gold' },
          { role: 'claim_extraction_gold_labels', path: '/artifacts/ingestion/claim-extraction-gold.json', sha256: 'sha-claim-extraction-gold' },
          { role: 'multimodal_assets', path: '/artifacts/ingestion/multimodal-assets.json', sha256: 'sha-multimodal-assets' }
        ]
      : []
  };
}

async function writeFixtureCorpus(rootPath) {
  const corpusDir = path.join(rootPath, '.papernexus');
  const graph = createKnowledgeGraph();
  await fs.mkdir(corpusDir, { recursive: true });
  await fs.writeFile(path.join(corpusDir, 'graph.json'), `${JSON.stringify(graph.toJSON(), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(corpusDir, 'meta.json'), `${JSON.stringify({
    indexedAt: '2026-05-27T00:00:00.000Z',
    nodeCount: 0,
    relationshipCount: 0,
    topProblems: [],
    layers: {},
    layerPaths: {}
  }, null, 2)}\n`, 'utf8');
}

async function writeExecutorInputs(rootPath, planStatus = 'preview_only') {
  const graphMutationsPath = path.join(rootPath, 'graph-mutations.json');
  const graphApplyPlanPath = path.join(rootPath, 'graph-apply-plan.json');
  await fs.writeFile(graphMutationsPath, `${JSON.stringify(mutationArtifact(), null, 2)}\n`, 'utf8');
  await fs.writeFile(graphApplyPlanPath, `${JSON.stringify(applyPlan(planStatus), null, 2)}\n`, 'utf8');
  return { graphMutationsPath, graphApplyPlanPath };
}

test('ingestion graph mutation executor previews blocked plans without mutating the corpus', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ingestion-mutation-executor-preview-'));
  try {
    await writeFixtureCorpus(tempRoot);
    const { graphMutationsPath, graphApplyPlanPath } = await writeExecutorInputs(tempRoot, 'preview_only');
    const outputDir = path.join(tempRoot, 'execution');

    const { report, rollbackManifest } = await executeIngestionGraphMutations({
      graphMutationsPath,
      graphApplyPlanPath,
      corpusRoot: tempRoot,
      outputDir,
      actor: 'executor-preview-test'
    });

    assert.equal(report.contractVersion, INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION);
    assert.equal(report.status, 'previewed');
    assert.equal(report.applyStatus, 'previewed');
    assert.equal(report.safety.authoritativeGraphWritePerformed, false);
    assert.equal(report.graphBefore.nodeCount, 0);
    assert.equal(report.projectedGraphAfter.nodeCount, 1);
    assert.equal(report.inputs.length, 2);
    assert.ok(report.inputs.every((entry) => entry.sha256));
    assert.ok(report.artifacts.report.endsWith('graph-mutation-execution-report.json'));
    assert.equal(rollbackManifest.status, 'not_required');

    const corpus = await loadCorpus(tempRoot);
    assert.equal(corpus.graph.nodeCount, 0);
    assert.ok(await fs.stat(path.join(outputDir, 'graph-mutation-execution-report.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'manifest.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'rollback-manifest.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('ingestion graph mutation executor refuses actual apply when gates are not ready', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ingestion-mutation-executor-blocked-'));
  try {
    await writeFixtureCorpus(tempRoot);
    const { graphMutationsPath, graphApplyPlanPath } = await writeExecutorInputs(tempRoot, 'blocked');

    const { report } = await executeIngestionGraphMutations({
      graphMutationsPath,
      graphApplyPlanPath,
      corpusRoot: tempRoot,
      outputDir: path.join(tempRoot, 'execution'),
      actor: 'executor-blocked-test',
      apply: true
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.applyStatus, 'blocked');
    assert.equal(report.safety.blockedActualApply, true);
    assert.equal(report.blockingReasons.some((reason) => reason.code === 'apply_plan_not_ready'), true);

    const corpus = await loadCorpus(tempRoot);
    assert.equal(corpus.graph.nodeCount, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('ingestion graph mutation executor applies only ready plans with explicit apply', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ingestion-mutation-executor-apply-'));
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
    await writeFixtureCorpus(tempRoot);
    const { graphMutationsPath, graphApplyPlanPath } = await writeExecutorInputs(tempRoot, 'ready_to_apply');
    const outputDir = path.join(tempRoot, 'execution');

    const { report, rollbackManifest } = await executeIngestionGraphMutations({
      graphMutationsPath,
      graphApplyPlanPath,
      corpusRoot: tempRoot,
      outputDir,
      actor: 'executor-apply-test',
      apply: true
    });

    assert.equal(report.status, 'applied');
    assert.equal(report.applyStatus, 'applied');
    assert.equal(report.safety.authoritativeGraphWritePerformed, true);
    assert.equal(report.authoritativeGraphAfter.nodeCount, 1);
    assert.equal(report.dryRun, false);
    assert.deepEqual(
      report.inputs.map((entry) => entry.role).sort(),
      ['claim_extraction_gold_labels', 'citation_intent_gold_labels', 'graph_apply_plan', 'graph_mutations', 'multimodal_assets'].sort()
    );
    assert.ok(report.artifacts.rollbackManifest.endsWith('rollback-manifest.json'));
    assert.ok(report.artifacts.rollbackManifestSha256);
    assert.ok(report.artifacts.beforeGraphSnapshotSha256);
    assert.equal(report.safety.rollbackManifestSha256, report.artifacts.rollbackManifestSha256);
    assert.equal(report.safety.beforeGraphSnapshotSha256, report.artifacts.beforeGraphSnapshotSha256);
    assert.equal(rollbackManifest.status, 'ready_for_manual_restore');
    assert.ok(rollbackManifest.beforeGraphSnapshotPath.endsWith('before-graph-snapshot.json'));
    assert.equal(rollbackManifest.beforeGraphSnapshotSha256, report.artifacts.beforeGraphSnapshotSha256);
    assert.ok(await fs.stat(rollbackManifest.beforeGraphSnapshotPath));
    assert.equal(await sha256File(rollbackManifest.beforeGraphSnapshotPath), report.artifacts.beforeGraphSnapshotSha256);
    assert.equal(await sha256File(report.artifacts.rollbackManifest), report.artifacts.rollbackManifestSha256);

    const corpus = await loadCorpus(tempRoot);
    assert.equal(corpus.graph.nodeCount, 1);
    assert.ok(corpus.graph.getNode('claim:ingestion-executor'));
  } finally {
    if (previousBackend === undefined) {
      delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    } else {
      process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('ingestion graph mutation executor CLI prints a dry-run summary', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-ingestion-mutation-executor-cli-'));
  try {
    await writeFixtureCorpus(tempRoot);
    const { graphMutationsPath, graphApplyPlanPath } = await writeExecutorInputs(tempRoot, 'preview_only');
    const outputDir = path.join(tempRoot, 'execution');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/apply-ingestion-graph-mutations.mjs'),
      '--graph-mutations-path', graphMutationsPath,
      '--graph-apply-plan-path', graphApplyPlanPath,
      '--corpus-root', tempRoot,
      '--output-dir', outputDir,
      '--actor', 'executor-cli-test'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION);
    assert.equal(summary.status, 'previewed');
    assert.equal(summary.apply_status, 'previewed');
    assert.equal(summary.authoritative_graph_write_performed, false);
    assert.equal(summary.operation_count, 1);
    assert.ok(summary.reportPath.endsWith('graph-mutation-execution-report.json'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
