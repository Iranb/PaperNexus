import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash, truncate } from '../../lib/utils.js';
import { applyCorpusMutations, loadCorpus } from '../../storage/corpus-store.js';
import {
  INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
  INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION
} from './parser-orchestrator.js';

export const INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION = 'papernexus-ingestion-graph-mutation-execution-v1';
export const INGESTION_GRAPH_MUTATION_ROLLBACK_CONTRACT_VERSION = 'papernexus-ingestion-graph-mutation-rollback-v1';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '', max = 1000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(',')}}`;
  }
  return JSON.stringify(value);
}

function graphSnapshot(graph) {
  const json = graph.toJSON();
  return {
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    checksum: stableHash(canonicalJson(json), 40),
    json
  };
}

function fileName(outputDir, name) {
  return path.join(outputDir, name);
}

function dedupeInputs(inputs = []) {
  const seen = new Set();
  const output = [];
  for (const input of asArray(inputs)) {
    const role = compactText(input.role || input.kind || input.name, 120);
    const inputPath = compactText(input.path || input.file, 1000);
    const key = `${role}:${inputPath}`;
    if (!role || seen.has(key)) continue;
    seen.add(key);
    output.push({ ...input, role, path: inputPath || input.path });
  }
  return output;
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gatesReady(gates = []) {
  const normalized = asArray(gates);
  return normalized.length > 0 && normalized.every((gate) => gate?.status === 'passed' && gate?.ok !== false);
}

function planAllowsApply(applyPlan = {}, operationCount = 0) {
  return applyPlan.contractVersion === INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION
    && applyPlan.status === 'ready_to_apply'
    && applyPlan.canApply === true
    && gatesReady(applyPlan.gates)
    && operationCount > 0;
}

function buildPlanDiagnostics(applyPlan = {}, graphMutations = {}, operationCount = 0) {
  const warnings = [];
  if (graphMutations.contractVersion !== INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION) {
    warnings.push({
      code: 'unexpected_graph_mutations_contract',
      message: `Expected ${INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION}.`
    });
  }
  if (applyPlan.contractVersion !== INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION) {
    warnings.push({
      code: 'unexpected_graph_apply_plan_contract',
      message: `Expected ${INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION}.`
    });
  }
  if (Number.isFinite(Number(applyPlan.operationCount)) && Number(applyPlan.operationCount) !== operationCount) {
    warnings.push({
      code: 'operation_count_mismatch',
      message: `Apply plan expects ${applyPlan.operationCount} operations, but graph mutations contain ${operationCount}.`
    });
  }
  return warnings;
}

function buildBlockingReasons(applyPlan = {}, operationCount = 0) {
  const reasons = [...asArray(applyPlan.blockingReasons).map((reason) => ({
    code: compactText(reason.code || 'blocked', 120),
    status: compactText(reason.status || 'blocked', 80),
    message: compactText(reason.message || reason.label || 'Apply plan is not ready.', 500)
  }))];
  if (applyPlan.status !== 'ready_to_apply') {
    reasons.push({
      code: 'apply_plan_not_ready',
      status: compactText(applyPlan.status || 'missing', 80),
      message: 'Graph apply plan is not ready_to_apply.'
    });
  }
  if (applyPlan.canApply !== true) {
    reasons.push({
      code: 'can_apply_false',
      status: 'blocked',
      message: 'Graph apply plan canApply is not true.'
    });
  }
  if (!gatesReady(applyPlan.gates)) {
    reasons.push({
      code: 'gates_not_passed',
      status: 'blocked',
      message: 'One or more graph apply gates are missing or not passed.'
    });
  }
  if (operationCount <= 0) {
    reasons.push({
      code: 'no_operations',
      status: 'incomplete',
      message: 'No graph mutation operations were available to apply.'
    });
  }
  return [...new Map(reasons.map((reason) => [reason.code, reason])).values()];
}

function buildMarkdownReport(report = {}) {
  const lines = [
    '# Ingestion Graph Mutation Execution Report',
    '',
    `- status: ${report.status}`,
    `- apply status: ${report.applyStatus}`,
    `- dry run: ${report.dryRun}`,
    `- authoritative graph write performed: ${report.safety.authoritativeGraphWritePerformed}`,
    `- operation count: ${report.operationCount}`,
    `- corpus root: ${report.corpusRoot}`,
    '',
    '## Graph Counts',
    '',
    `- before: ${report.graphBefore.nodeCount} nodes / ${report.graphBefore.relationshipCount} relationships`,
    `- projected after: ${report.projectedGraphAfter.nodeCount} nodes / ${report.projectedGraphAfter.relationshipCount} relationships`,
    `- authoritative after: ${report.authoritativeGraphAfter.nodeCount} nodes / ${report.authoritativeGraphAfter.relationshipCount} relationships`,
    '',
    '## Checksums',
    '',
    `- before: ${report.graphBefore.checksum}`,
    `- projected after: ${report.projectedGraphAfter.checksum}`,
    `- authoritative after: ${report.authoritativeGraphAfter.checksum}`,
    '',
    '## Gates',
    '',
    ...asArray(report.plan.gates).map((gate) => `- ${gate.name || gate.label || 'gate'}: ${gate.status || 'unknown'}`),
    '',
    '## Blocking Reasons',
    '',
    ...(report.blockingReasons.length
      ? report.blockingReasons.map((reason) => `- ${reason.code}: ${reason.message}`)
      : ['- none']),
    ''
  ];
  return `${lines.join('\n')}\n`;
}

function buildManifest(report = {}, paths = {}) {
  return {
    contractVersion: INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION,
    status: report.status,
    applyStatus: report.applyStatus,
    generatedAt: report.generatedAt,
    dryRun: report.dryRun,
    corpusRoot: report.corpusRoot,
    operationCount: report.operationCount,
    graphBefore: report.graphBefore,
    projectedGraphAfter: report.projectedGraphAfter,
    authoritativeGraphAfter: report.authoritativeGraphAfter,
    inputs: report.inputs,
    artifacts: paths,
    safety: report.safety
  };
}

function buildRollbackManifest(report = {}, paths = {}) {
  const applied = report.safety?.authoritativeGraphWritePerformed === true;
  return {
    contractVersion: INGESTION_GRAPH_MUTATION_ROLLBACK_CONTRACT_VERSION,
    generatedAt: report.generatedAt,
    status: applied ? 'ready_for_manual_restore' : 'not_required',
    reason: applied
      ? 'Authoritative graph write was performed. Restore the pre-apply graph snapshot if rollback is needed.'
      : 'No authoritative graph write was performed.',
    corpusRoot: report.corpusRoot,
    appliedOperationCount: applied ? report.operationCount : 0,
    beforeGraphSnapshotPath: paths.beforeGraphSnapshot || null,
    beforeGraphSnapshotSha256: paths.beforeGraphSnapshotSha256 || null,
    beforeChecksum: report.graphBefore.checksum,
    afterChecksum: report.authoritativeGraphAfter.checksum,
    restorePolicy: applied
      ? 'manual_restore_from_before_graph_snapshot'
      : 'no_restore_needed_for_dry_run_or_blocked_execution'
  };
}

export async function executeIngestionGraphMutations(options = {}) {
  const graphMutationsPath = compactText(options.graphMutationsPath || options.graph_mutations_path, 1000);
  const graphApplyPlanPath = compactText(options.graphApplyPlanPath || options.graph_apply_plan_path, 1000);
  const corpusRoot = compactText(options.corpusRoot || options.rootPath || options.root_path || options.corpus_root, 1000);
  const outputDir = compactText(options.outputDir || options.output_dir, 1000);
  const actor = compactText(options.actor || 'ingestion-graph-mutation-executor', 120);
  const applyRequested = options.apply === true || options.dryRun === false || options.dry_run === false;
  const generatedAt = options.generatedAt || options.generated_at || new Date().toISOString();

  if (!graphMutationsPath) throw new Error('--graph-mutations-path is required.');
  if (!graphApplyPlanPath) throw new Error('--graph-apply-plan-path is required.');
  if (!corpusRoot) throw new Error('--corpus-root is required.');
  if (!outputDir) throw new Error('--output-dir is required.');

  await ensureDir(outputDir);

  const graphMutations = await readJson(graphMutationsPath);
  const applyPlan = await readJson(graphApplyPlanPath);
  const inputs = dedupeInputs([
    {
      role: 'graph_mutations',
      path: path.resolve(process.cwd(), graphMutationsPath),
      sha256: await sha256File(graphMutationsPath)
    },
    {
      role: 'graph_apply_plan',
      path: path.resolve(process.cwd(), graphApplyPlanPath),
      sha256: await sha256File(graphApplyPlanPath)
    },
    ...asArray(applyPlan.inputs || applyPlan.releaseEvidenceInputs || applyPlan.release_evidence_inputs)
  ]);
  const operations = asArray(graphMutations.operations);
  const diagnostics = buildPlanDiagnostics(applyPlan, graphMutations, operations.length);
  const canApply = planAllowsApply(applyPlan, operations.length);
  const blockingReasons = applyRequested && !canApply
    ? buildBlockingReasons(applyPlan, operations.length)
    : [];

  const before = await loadCorpus(corpusRoot);
  const beforeSnapshot = graphSnapshot(before.graph);
  const preview = operations.length
    ? await applyCorpusMutations(corpusRoot, operations, { actor, dryRun: true })
    : { mutationResult: null };
  const projectedSnapshot = preview.mutationResult
    ? graphSnapshot(preview.mutationResult.graph)
    : beforeSnapshot;

  let applied = null;
  let beforeGraphSnapshotPath = '';
  let beforeGraphSnapshotSha256 = '';
  let status = operations.length ? 'previewed' : 'incomplete';
  let applyStatus = applyRequested ? 'blocked' : 'previewed';
  let authoritativeSnapshot = beforeSnapshot;

  if (applyRequested && canApply) {
    beforeGraphSnapshotPath = fileName(outputDir, 'before-graph-snapshot.json');
    await writeJson(beforeGraphSnapshotPath, beforeSnapshot.json);
    beforeGraphSnapshotSha256 = await sha256File(beforeGraphSnapshotPath);
    applied = await applyCorpusMutations(corpusRoot, operations, { actor, dryRun: false });
    authoritativeSnapshot = graphSnapshot(applied.graph);
    status = 'applied';
    applyStatus = 'applied';
  } else if (applyRequested && !canApply) {
    status = 'blocked';
    applyStatus = 'blocked';
  } else if (!operations.length) {
    applyStatus = 'incomplete';
  }

  const report = {
    contractVersion: INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION,
    generatedAt,
    status,
    applyStatus,
    dryRun: !applyRequested || !canApply,
    actor,
    corpusRoot,
    graphMutationsPath,
    graphApplyPlanPath,
    inputs,
    operationCount: operations.length,
    graphBefore: {
      nodeCount: beforeSnapshot.nodeCount,
      relationshipCount: beforeSnapshot.relationshipCount,
      checksum: beforeSnapshot.checksum
    },
    projectedGraphAfter: {
      nodeCount: projectedSnapshot.nodeCount,
      relationshipCount: projectedSnapshot.relationshipCount,
      checksum: projectedSnapshot.checksum
    },
    authoritativeGraphAfter: {
      nodeCount: authoritativeSnapshot.nodeCount,
      relationshipCount: authoritativeSnapshot.relationshipCount,
      checksum: authoritativeSnapshot.checksum
    },
    mutationSummary: applied?.mutationResult?.summary || preview.mutationResult?.summary || null,
    mutationResults: applied?.mutationResult?.results || preview.mutationResult?.results || [],
    plan: {
      contractVersion: applyPlan.contractVersion || '',
      status: applyPlan.status || '',
      mode: applyPlan.mode || '',
      canApply: applyPlan.canApply === true,
      releaseGateStatus: applyPlan.releaseGateStatus || '',
      gates: asArray(applyPlan.gates)
    },
    blockingReasons,
    diagnostics: {
      warningCount: diagnostics.length,
      warnings: diagnostics
    },
    safety: {
      defaultBehavior: 'dry-run',
      explicitApplyRequested: applyRequested,
      planAllowsApply: canApply,
      authoritativeGraphWritePerformed: applyRequested && canApply,
      blockedActualApply: applyRequested && !canApply,
      rollbackManifestRequired: applyRequested && canApply
    }
  };

  const reportPath = fileName(outputDir, 'graph-mutation-execution-report.json');
  const markdownReportPath = fileName(outputDir, 'graph-mutation-execution-report.md');
  const manifestPath = fileName(outputDir, 'manifest.json');
  const rollbackManifestPath = fileName(outputDir, 'rollback-manifest.json');
  const artifactPaths = {
    report: reportPath,
    markdownReport: markdownReportPath,
    manifest: manifestPath,
    rollbackManifest: rollbackManifestPath,
    rollbackManifestSha256: null,
    beforeGraphSnapshot: beforeGraphSnapshotPath || null,
    beforeGraphSnapshotSha256: beforeGraphSnapshotSha256 || null
  };
  report.artifacts = artifactPaths;
  const rollbackManifest = buildRollbackManifest(report, artifactPaths);

  await writeJson(rollbackManifestPath, rollbackManifest);
  artifactPaths.rollbackManifestSha256 = await sha256File(rollbackManifestPath);
  report.artifacts = artifactPaths;
  report.safety.rollbackManifestSha256 = artifactPaths.rollbackManifestSha256;
  report.safety.beforeGraphSnapshotSha256 = artifactPaths.beforeGraphSnapshotSha256;
  const manifest = buildManifest(report, artifactPaths);

  await writeJson(reportPath, report);
  await writeText(markdownReportPath, buildMarkdownReport(report));
  await writeJson(manifestPath, manifest);

  return {
    report,
    manifest,
    rollbackManifest,
    artifacts: artifactPaths
  };
}
