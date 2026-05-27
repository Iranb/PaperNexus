import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import { MODEL_ASSISTED_INNOVATION_VERSION } from '../graph/model-assisted-innovation.js';
import { COUNTERFACTUAL_SEARCH_CONTRACT_VERSION } from '../graph/counterfactual-search.js';

export const INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION = 'papernexus-innovation-sidecar-release-evidence-v1';

export const REQUIRED_MODEL_ASSISTED_FAMILIES = [
  { id: 'novbench', patterns: [/novbench/] },
  { id: 'rinobench', patterns: [/rinobench/] },
  { id: 'claim', patterns: [/claim[-_ ]?bench/, /claimcheck/, /\bclaim\b/] },
  { id: 'openreview_style', patterns: [/openreview/, /peerread/, /moprd/, /\bre2\b/, /re²/] }
];

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test)\b/i;
const MODEL_ASSISTED_CALIBRATION_VERSION = 'papernexus-model-assisted-calibration-v1';
const COUNTERFACTUAL_USEFULNESS_VERSION = 'papernexus-counterfactual-usefulness-v1';
export const COUNTERFACTUAL_MIN_USEFULNESS_SCORE = 0.5;
const REQUIRED_MODEL_ASSISTED_GATES = ['model_calibration_complete', 'benchmark_metrics_passed'];
const REQUIRED_COUNTERFACTUAL_GATES = ['counterfactual_usefulness'];
const REQUIRED_MODEL_ASSISTED_INPUT_ROLES = [
  {
    id: 'calibration_labels',
    aliases: ['calibration_dataset', 'calibration_labels', 'calibration_gold_labels', 'model_assisted_calibration_labels']
  },
  {
    id: 'holdout_evaluation',
    aliases: ['evaluation_dataset', 'holdout_dataset', 'holdout_evaluation', 'benchmark_metrics', 'model_assisted_holdout_evaluation']
  }
];
const REQUIRED_COUNTERFACTUAL_INPUT_ROLES = [
  {
    id: 'counterfactual_candidates',
    aliases: ['counterfactual_candidates', 'candidate_plans', 'generated_candidates', 'candidates']
  },
  {
    id: 'selected_plans',
    aliases: ['selected_plans', 'selected_counterfactual_plans', 'falsification_plans', 'plans']
  },
  {
    id: 'usefulness_labels',
    aliases: ['usefulness_labels', 'counterfactual_usefulness_labels', 'failure_discovery_labels', 'labels']
  }
];

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

function normalizeKey(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function inputHasHash(inputs = []) {
  return asArray(inputs).some((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
}

function datasetMetadata(record = {}) {
  const dataset = asObject(record.dataset || record.benchmark || record.source_metadata);
  return {
    name: compactText(dataset.name || record.dataset_name || record.name),
    format: compactText(dataset.format || record.dataset_format || record.format),
    source: compactText(dataset.source || record.dataset_source || record.source),
    license_scope: compactText(dataset.license_scope || dataset.licenseScope || record.license_scope || record.licenseScope)
  };
}

function inputHashCount(inputs = []) {
  return asArray(inputs).filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum)).length;
}

function hasHashedInputRole(inputs = [], role = {}) {
  const aliases = asArray(role.aliases || role.id).map(normalizeKey);
  return asArray(inputs).some((entry) => (
    aliases.includes(normalizeKey(entry.role || entry.kind || entry.name))
    && Boolean(compactText(entry.sha256 || entry.hash || entry.checksum))
  ));
}

function missingInputRoles(inputs = [], roles = []) {
  return asArray(roles)
    .filter((role) => !hasHashedInputRole(inputs, role))
    .map((role) => role.id);
}

function evidenceText(record = {}) {
  const dataset = datasetMetadata(record);
  const calibration = asObject(record.calibration || record.model_assisted?.calibration);
  const evaluation = asObject(record.evaluation || record.eval || record.model_assisted?.evaluation);
  return [
    record.contractVersion,
    record.contract_version,
    record.name,
    record.format,
    record.source,
    dataset.name,
    dataset.format,
    dataset.source,
    record.model,
    record.model_id,
    record.prompt_version,
    record.mode,
    calibration.dataset,
    calibration.run_id,
    record.evaluation_dataset,
    record.evaluationDataset,
    record.holdout_dataset,
    record.holdoutDataset,
    record.holdout_policy,
    record.holdoutPolicy,
    evaluation.dataset,
    evaluation.run_id,
    evaluation.holdout_policy,
    ...asArray(record.benchmark_families || record.benchmarkFamilies || record.families),
    ...asArray(record.inputs).map((entry) => [entry.role, entry.path, entry.source].map(compactText).join(' '))
  ].map(compactText).join(' ').toLowerCase();
}

function isPassed(record = {}) {
  return ['passed', 'ready_for_release_gate', 'calibrated'].includes(normalizeKey(record.status || record.releaseGate?.status || record.release_gate?.status));
}

function failedStatus(record = {}) {
  const status = normalizeKey(record.status || record.releaseGate?.status || record.release_gate?.status);
  return status === 'failed';
}

function externalEvidence(record = {}) {
  const dataset = datasetMetadata(record);
  const text = evidenceText(record);
  if (!dataset.source) return { ok: false, reason: 'missing_dataset_source' };
  if (!dataset.license_scope) return { ok: false, reason: 'missing_license_scope' };
  if (!inputHasHash(record.inputs)) return { ok: false, reason: 'missing_input_hash' };
  if (FIXTURE_MARKERS.test(text)) return { ok: false, reason: 'fixture_or_synthetic_evidence' };
  return { ok: true, reason: '' };
}

function missingModelFamilies(record = {}) {
  const declaredFamilies = asArray(record.benchmark_families || record.benchmarkFamilies || record.families)
    .map(compactText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const text = declaredFamilies || evidenceText(record);
  return REQUIRED_MODEL_ASSISTED_FAMILIES
    .filter((family) => !family.patterns.some((pattern) => pattern.test(text)))
    .map((family) => family.id);
}

function gateStatus(record = {}, name = '') {
  const found = asArray(record.gates).find((entry) => normalizeKey(entry.name) === normalizeKey(name));
  return found ? compactText(found.status || (found.ok === false ? 'failed' : 'passed')).toLowerCase() : '';
}

function requiredGateStatuses(record = {}, gates = []) {
  return Object.fromEntries(asArray(gates).map((name) => [name, gateStatus(record, name) || 'missing']));
}

function missingRequiredGates(statuses = {}) {
  return Object.entries(statuses)
    .filter(([, status]) => status === 'missing')
    .map(([name]) => name);
}

function incompleteRequiredGates(statuses = {}) {
  return Object.entries(statuses)
    .filter(([, status]) => status !== 'passed' && status !== 'failed' && status !== 'missing')
    .map(([name]) => name);
}

function failedRequiredGates(statuses = {}) {
  return Object.entries(statuses)
    .filter(([, status]) => status === 'failed')
    .map(([name]) => name);
}

function modelAssistedDetails(record = {}) {
  const modelAssisted = asObject(record.model_assisted || record.modelAssisted);
  const model = asObject(record.model || modelAssisted.model);
  const calibration = asObject(record.calibration || modelAssisted.calibration);
  const evaluation = asObject(record.evaluation || record.eval || modelAssisted.evaluation);
  return {
    mode: compactText(record.mode || modelAssisted.mode),
    status: compactText(record.status || modelAssisted.status),
    model_id: compactText(record.modelId || record.model_id || model.model_id || model.id || model.name),
    prompt_version: compactText(record.promptVersion || record.prompt_version || model.prompt_version),
    calibration_dataset: compactText(record.calibrationDataset || record.calibration_dataset || calibration.dataset),
    calibration_run_id: compactText(record.calibrationRunId || record.calibration_run_id || calibration.run_id),
    evaluation_dataset: compactText(record.evaluationDataset || record.evaluation_dataset || record.evalDataset || record.eval_dataset || record.holdoutDataset || record.holdout_dataset || evaluation.dataset),
    evaluation_run_id: compactText(record.evaluationRunId || record.evaluation_run_id || record.evalRunId || record.eval_run_id || evaluation.run_id),
    holdout_policy: compactText(record.holdoutPolicy || record.holdout_policy || evaluation.holdout_policy || calibration.holdout_policy),
    calibration_split: compactText(record.calibrationSplit || record.calibration_split || calibration.split || calibration.split_id),
    evaluation_split: compactText(record.evaluationSplit || record.evaluation_split || record.evalSplit || record.eval_split || evaluation.split || evaluation.split_id),
    overlap_count: Number(record.overlap_count ?? record.overlapCount ?? evaluation.overlap_count ?? evaluation.overlapCount ?? 0),
    label_count: Number(record.label_count || record.labelCount || calibration.label_count || 0),
    metrics: asObject(record.metrics || calibration.metrics)
  };
}

function independentEvaluationSatisfied(details = {}) {
  if (!details.evaluation_dataset || !details.holdout_policy) return false;
  if (details.calibration_dataset && normalizeKey(details.calibration_dataset) === normalizeKey(details.evaluation_dataset)) return false;
  if (details.calibration_split && details.evaluation_split && normalizeKey(details.calibration_split) === normalizeKey(details.evaluation_split)) return false;
  if (Number.isFinite(details.overlap_count) && details.overlap_count > 0) return false;
  return true;
}

function modelAssistedRequirement(record = {}) {
  if (!Object.keys(record).length) {
    return {
      id: 'R5',
      label: 'calibrated model-assisted innovation evidence passes benchmark calibration',
      status: 'incomplete',
      message: 'missing calibrated model-assisted evidence',
      evidence: []
    };
  }
  const details = modelAssistedDetails(record);
  const dataset = datasetMetadata(record);
  const external = externalEvidence(record);
  const missingFamilies = missingModelFamilies(record);
  const contractVersion = compactText(record.contractVersion || record.contract_version || record.model_assisted?.contract_version);
  const allowedContract = [MODEL_ASSISTED_INNOVATION_VERSION, MODEL_ASSISTED_CALIBRATION_VERSION].includes(contractVersion);
  const requiredGateStatusMap = requiredGateStatuses(record, REQUIRED_MODEL_ASSISTED_GATES);
  const missingGates = missingRequiredGates(requiredGateStatusMap);
  const incompleteGates = incompleteRequiredGates(requiredGateStatusMap);
  const failedGates = failedRequiredGates(requiredGateStatusMap);
  const missingRoleInputHashes = missingInputRoles(record.inputs, REQUIRED_MODEL_ASSISTED_INPUT_ROLES);
  const evidence = [{
    kind: 'model_assisted_calibration',
    run_id: compactText(record.runId || record.run_id),
    contract_version: contractVersion,
    status: compactText(record.status),
    mode: details.mode,
    model_id: details.model_id,
    prompt_version: details.prompt_version,
    calibration_dataset: details.calibration_dataset,
    calibration_run_id: details.calibration_run_id,
    evaluation_dataset: details.evaluation_dataset,
    evaluation_run_id: details.evaluation_run_id,
    holdout_policy: details.holdout_policy,
    calibration_split: details.calibration_split,
    evaluation_split: details.evaluation_split,
    overlap_count: Number.isFinite(details.overlap_count) ? details.overlap_count : null,
    label_count: details.label_count,
    dataset_name: dataset.name,
    dataset_format: dataset.format,
    dataset_source: dataset.source,
    license_scope: dataset.license_scope,
    input_hash_count: inputHashCount(record.inputs),
    required_input_roles: REQUIRED_MODEL_ASSISTED_INPUT_ROLES.map((role) => role.id),
    missing_input_role_hashes: missingRoleInputHashes,
    required_benchmark_families: REQUIRED_MODEL_ASSISTED_FAMILIES.map((family) => family.id),
    missing_benchmark_families: missingFamilies,
    required_gate_statuses: requiredGateStatusMap,
    missing_required_gates: missingGates,
    incomplete_required_gates: incompleteGates,
    failed_required_gates: failedGates,
    metrics: details.metrics
  }];
  if (!allowedContract) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'model-assisted evidence contract version is missing or unsupported', evidence };
  if (failedStatus(record) || failedGates.length) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'failed', message: 'model-assisted calibration evidence failed', evidence };
  if (!isPassed(record)) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'model-assisted calibration evidence is not passed', evidence };
  if (missingGates.length) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: `missing required model-assisted gates: ${missingGates.join(', ')}`, evidence };
  if (incompleteGates.length) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: `model-assisted gates are not passed: ${incompleteGates.join(', ')}`, evidence };
  if (normalizeKey(details.mode) !== 'calibrated') return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'model-assisted evidence is not calibrated', evidence };
  if (!details.model_id || !details.prompt_version) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'missing model id or prompt version', evidence };
  if (!details.calibration_dataset || !details.calibration_run_id || details.label_count <= 0) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'missing calibration dataset, run id, or labels', evidence };
  if (!independentEvaluationSatisfied(details)) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: 'missing independent evaluation/holdout split for model-assisted calibration', evidence };
  if (missingFamilies.length) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: `missing model-assisted benchmark families: ${missingFamilies.join(', ')}`, evidence };
  if (!external.ok) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: `model-assisted evidence is not release-grade: ${external.reason}`, evidence };
  if (missingRoleInputHashes.length) return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'incomplete', message: `missing model-assisted role-specific input hashes: ${missingRoleInputHashes.join(', ')}`, evidence };
  return { id: 'R5', label: 'calibrated model-assisted innovation evidence passes benchmark calibration', status: 'passed', message: '', evidence };
}

function counterfactualDetails(record = {}) {
  const metrics = asObject(record.metrics || record.usefulness_metrics || record.usefulnessMetrics);
  const plans = asArray(record.counterfactuals || record.falsification_plans || record.plans);
  const usefulnessScore = Number(record.usefulness_score || record.usefulnessScore || metrics.usefulness_score);
  const failureDiscoveryRate = Number(record.failure_discovery_rate || record.failureDiscoveryRate || metrics.failure_discovery_rate);
  return {
    search_mode: compactText(record.searchMode || record.search_mode || record.mode),
    backend: compactText(record.backend || record.expansionBackend || record.expansion_backend || record.method),
    candidate_count: Number(record.candidate_count || record.candidateCount || record.diagnostics?.candidate_count || plans.length || 0),
    selected_plan_count: Number(record.selected_plan_count || record.selectedPlanCount || record.diagnostics?.selected_plan_count || plans.length || 0),
    usefulness_label_count: Number(record.usefulness_label_count || record.usefulnessLabelCount || record.label_count || record.labelCount || record.diagnostics?.usefulness_label_count || 0),
    usefulness_score: Number.isFinite(usefulnessScore) ? usefulnessScore : null,
    failure_discovery_rate: Number.isFinite(failureDiscoveryRate) ? failureDiscoveryRate : null,
    metrics
  };
}

function counterfactualIsModelBacked(details = {}) {
  const text = [details.search_mode, details.backend].join(' ').toLowerCase();
  return /tot|tree[-_ ]?of[-_ ]?thought|model[-_ ]?assisted|llm|provider/.test(text);
}

function counterfactualRequirement(record = {}) {
  if (!Object.keys(record).length) {
    return {
      id: 'R6',
      label: 'model-assisted counterfactual search has usefulness evidence',
      status: 'incomplete',
      message: 'missing counterfactual usefulness evidence',
      evidence: []
    };
  }
  const details = counterfactualDetails(record);
  const dataset = datasetMetadata(record);
  const external = externalEvidence(record);
  const contractVersion = compactText(record.contractVersion || record.contract_version || record.search_contract_version);
  const allowedContract = [COUNTERFACTUAL_SEARCH_CONTRACT_VERSION, COUNTERFACTUAL_USEFULNESS_VERSION].includes(contractVersion);
  const requiredGateStatusMap = requiredGateStatuses(record, REQUIRED_COUNTERFACTUAL_GATES);
  const missingGates = missingRequiredGates(requiredGateStatusMap);
  const incompleteGates = incompleteRequiredGates(requiredGateStatusMap);
  const failedGates = failedRequiredGates(requiredGateStatusMap);
  const missingRoleInputHashes = missingInputRoles(record.inputs, REQUIRED_COUNTERFACTUAL_INPUT_ROLES);
  const evidence = [{
    kind: 'counterfactual_usefulness',
    run_id: compactText(record.runId || record.run_id),
    contract_version: contractVersion,
    status: compactText(record.status),
    search_mode: details.search_mode,
    backend: details.backend,
    candidate_count: details.candidate_count,
    selected_plan_count: details.selected_plan_count,
    usefulness_label_count: details.usefulness_label_count,
    usefulness_score: details.usefulness_score,
    min_usefulness_score: COUNTERFACTUAL_MIN_USEFULNESS_SCORE,
    failure_discovery_rate: details.failure_discovery_rate,
    dataset_name: dataset.name,
    dataset_format: dataset.format,
    dataset_source: dataset.source,
    license_scope: dataset.license_scope,
    input_hash_count: inputHashCount(record.inputs),
    required_input_roles: REQUIRED_COUNTERFACTUAL_INPUT_ROLES.map((role) => role.id),
    missing_input_role_hashes: missingRoleInputHashes,
    required_gate_statuses: requiredGateStatusMap,
    missing_required_gates: missingGates,
    incomplete_required_gates: incompleteGates,
    failed_required_gates: failedGates,
    metrics: details.metrics
  }];
  if (!allowedContract) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'counterfactual evidence contract version is missing or unsupported', evidence };
  if (failedStatus(record) || failedGates.length) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'failed', message: 'counterfactual usefulness evidence failed', evidence };
  if (!isPassed(record)) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'counterfactual usefulness evidence is not passed', evidence };
  if (missingGates.length) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: `missing required counterfactual gates: ${missingGates.join(', ')}`, evidence };
  if (incompleteGates.length) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: `counterfactual gates are not passed: ${incompleteGates.join(', ')}`, evidence };
  if (!counterfactualIsModelBacked(details)) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'counterfactual search is not ToT/model-assisted', evidence };
  if (details.candidate_count <= 0 || details.selected_plan_count <= 0) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'missing counterfactual candidates or selected plans', evidence };
  if (details.usefulness_label_count < details.selected_plan_count) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'counterfactual usefulness labels do not cover selected plans', evidence };
  if (!(details.usefulness_score >= COUNTERFACTUAL_MIN_USEFULNESS_SCORE)) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: `counterfactual usefulness score is missing or below ${COUNTERFACTUAL_MIN_USEFULNESS_SCORE}`, evidence };
  if (!(details.failure_discovery_rate > 0)) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: 'missing positive counterfactual failure-discovery metric', evidence };
  if (!external.ok) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: `counterfactual evidence is not release-grade: ${external.reason}`, evidence };
  if (missingRoleInputHashes.length) return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'incomplete', message: `missing counterfactual role-specific input hashes: ${missingRoleInputHashes.join(', ')}`, evidence };
  return { id: 'R6', label: 'model-assisted counterfactual search has usefulness evidence', status: 'passed', message: '', evidence };
}

function statusFromRequirements(requirements = []) {
  if (requirements.some((entry) => entry.status === 'failed')) return 'failed';
  if (requirements.some((entry) => entry.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

export function buildInnovationSidecarReleaseEvidenceReport(options = {}) {
  const modelRecord = asObject(options.modelAssistedReport || options.model_assisted_report || options.modelAssisted || options.model_assisted);
  const counterfactualRecord = asObject(options.counterfactualReport || options.counterfactual_report || options.counterfactual);
  const inputs = asArray(options.inputs).filter(Boolean);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `innovation-sidecar-release-evidence-${stableHash(`${generatedAt}:${inputs.length}`, 10)}`;
  const requirements = [
    modelAssistedRequirement(modelRecord),
    counterfactualRequirement(counterfactualRecord)
  ];
  const status = statusFromRequirements(requirements);
  return {
    contractVersion: INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION,
    runId,
    generatedAt,
    status,
    inputs,
    requirements,
    diagnostics: {
      model_assisted_status: requirements.find((entry) => entry.id === 'R5')?.status || 'missing',
      counterfactual_status: requirements.find((entry) => entry.id === 'R6')?.status || 'missing',
      missing_input_hashes: inputs.filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum)).map((entry) => compactText(entry.path || entry.file || entry.role))
    },
    releaseGate: {
      status,
      reason: status === 'passed' ? 'innovation_sidecar_release_evidence_passed' : requirements.find((entry) => entry.status !== 'passed')?.message || 'innovation sidecar evidence is incomplete'
    }
  };
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readEvidenceFile(filePath = '', role = '') {
  const absolutePath = path.resolve(process.cwd(), compactText(filePath));
  return {
    role,
    path: absolutePath,
    sha256: await sha256File(absolutePath),
    record: await readJson(absolutePath, {})
  };
}

export async function prepareInnovationSidecarReleaseEvidence(options = {}) {
  const outputDir = compactText(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const modelPath = compactText(options.modelAssistedPath || options.model_assisted_path);
  const counterfactualPath = compactText(options.counterfactualPath || options.counterfactual_path);
  const modelInput = modelPath ? await readEvidenceFile(modelPath, 'model_assisted_calibration_report') : null;
  const counterfactualInput = counterfactualPath ? await readEvidenceFile(counterfactualPath, 'counterfactual_usefulness_report') : null;
  const inputs = [modelInput, counterfactualInput].filter(Boolean).map(({ record, ...input }) => input);
  const report = buildInnovationSidecarReleaseEvidenceReport({
    ...options,
    modelAssistedReport: modelInput?.record || options.modelAssistedReport,
    counterfactualReport: counterfactualInput?.record || options.counterfactualReport,
    inputs
  });
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const reportPath = path.join(absoluteOutputDir, 'innovation-sidecar-release-evidence.json');
  const reportMarkdownPath = path.join(absoluteOutputDir, 'innovation-sidecar-release-evidence.md');
  const manifestPath = path.join(absoluteOutputDir, 'manifest.json');
  const reportWithArtifacts = {
    ...report,
    artifacts: {
      outputDir: absoluteOutputDir,
      reportPath,
      reportMarkdownPath,
      manifestPath
    }
  };
  await ensureDir(absoluteOutputDir);
  await writeJson(reportPath, reportWithArtifacts);
  await writeText(reportMarkdownPath, renderInnovationSidecarReleaseEvidenceMarkdown(reportWithArtifacts));
  await writeJson(manifestPath, {
    contractVersion: INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    releaseGate: report.releaseGate,
    requirements: report.requirements,
    diagnostics: report.diagnostics,
    artifacts: reportWithArtifacts.artifacts
  });
  return reportWithArtifacts;
}

export function renderInnovationSidecarReleaseEvidenceMarkdown(report = {}) {
  const lines = [
    `# Innovation Sidecar Release Evidence: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Requirements',
    '',
    '| ID | Requirement | Status | Message |',
    '|---|---|---:|---|'
  ];
  for (const entry of asArray(report.requirements)) {
    lines.push(`| ${entry.id} | ${entry.label} | ${entry.status} | ${entry.message || ''} |`);
  }
  lines.push('', '## Diagnostics', '');
  for (const [key, value] of Object.entries(asObject(report.diagnostics))) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  return `${lines.join('\n')}\n`;
}
