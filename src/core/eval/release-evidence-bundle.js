import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import {
  DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
  REQUIRED_DOCS_SYNC_INPUTS
} from './docs-sync-release-evidence.js';
import {
  ENGINEERING_RELEASE_EVIDENCE_VERSION,
  REQUIRED_ENGINEERING_TESTS
} from './engineering-release-evidence.js';
import {
  IDEA_CATALYST_RELEASE_GATE_VERSION,
  RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS,
  RELEASE_GATE_REQUIRED_ABLATIONS
} from './release-gate-manifest.js';

export const RELEASE_EVIDENCE_BUNDLE_VERSION = 'papernexus-release-evidence-bundle-v1';
export const RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION = 'papernexus-release-evidence-bundle-spec-v1';
const REPLAY_SUITE_EVIDENCE_CONTRACT_VERSION = 'idea-catalyst-replay-suite-v1';
const ABLATION_RUNNER_CONTRACT_VERSION = 'idea-catalyst-ablation-runner-v1';
const HUMAN_BLIND_EVAL_CONTRACT_VERSION = 'human-blind-eval-v1';
const INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION = 'papernexus-ingestion-graph-mutation-execution-v1';

export const REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES = [
  'raw_input',
  'normalized_dataset',
  'run_config',
  'evidence_report',
  'docs_sync_release_evidence',
  'release_gate_manifest',
  'stdout_log',
  'stderr_log'
];

const EMPTY_OK_ROLES = new Set(['stdout_log', 'stderr_log']);
const DATASET_METADATA_ROLES = new Set(['raw_input', 'normalized_dataset', 'run_config', 'evidence_report']);
const REQUIRED_RELEASE_DATASET_METADATA_FIELDS = [
  'source',
  'license_scope',
  'raw_input_sha256',
  'time_cutoff',
  'adapter_format',
  'holdout_policy',
  'time_slice_policy'
];
const REQUIRED_RELEASE_DATASET_FAMILIES = [
  { id: 'masterset', label: 'MasterSet', patterns: [/masterset/, /must[-_ ]?cite/] },
  { id: 'novbench', label: 'NovBench', patterns: [/novbench/] },
  { id: 'rinobench', label: 'RINoBench', patterns: [/rinobench/] },
  { id: 'axiomatic_novelty', label: 'axiomatic novelty benchmark', patterns: [/axiomatic[-_ ]?novelty/, /axiomatic benchmark/] },
  { id: 'claim_bench', label: 'CLAIM-BENCH', patterns: [/claim[-_ ]?bench/] },
  { id: 'claimcheck', label: 'CLAIMCHECK', patterns: [/claimcheck/, /claim[-_ ]?check/] },
  { id: 'openreview', label: 'OpenReview', patterns: [/openreview/] },
  { id: 'peerread', label: 'PeerRead', patterns: [/peerread/] },
  { id: 'moprd', label: 'MOPRD', patterns: [/moprd/] },
  { id: 're2', label: 'Re2 / Re²', patterns: [/\bre2\b/, /re²/] }
];
const RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE = {
  full: [
    'replay_suite_manifest',
    'ablation_manifest',
    'human_blind_aggregation',
    'graph_reasoning_report',
    'scientific_embedding_release_evidence',
    'innovation_sidecar_release_evidence',
    'graph_link_prediction_report',
    'ingestion_graph_mutation_execution',
    'engineering_release_evidence',
    'docs_sync_release_evidence'
  ],
  p0_p1: [
    'replay_suite_manifest',
    'ablation_manifest',
    'human_blind_aggregation',
    'ingestion_graph_mutation_execution',
    'engineering_release_evidence',
    'docs_sync_release_evidence'
  ]
};
const DATASET_METADATA_FIELD_ALIASES = {
  source: ['source', 'dataset_source', 'datasetSource', 'source_url', 'sourceUrl'],
  license_scope: ['license_scope', 'licenseScope', 'license', 'usage_scope', 'usageScope'],
  raw_input_sha256: ['raw_input_sha256', 'rawInputSha256', 'raw_dataset_sha256', 'rawDatasetSha256', 'input_sha256', 'inputSha256'],
  time_cutoff: ['time_cutoff', 'timeCutoff', 'temporal_cutoff', 'temporalCutoff', 'cutoff'],
  adapter_format: ['adapter_format', 'adapterFormat', 'format', 'dataset_format', 'datasetFormat'],
  holdout_policy: ['holdout_policy', 'holdoutPolicy', 'venue_year_holdout', 'venueYearHoldout', 'venue_year_holdout_policy', 'venueYearHoldoutPolicy'],
  time_slice_policy: ['time_slice_policy', 'timeSlicePolicy', 'temporal_slice_policy', 'temporalSlicePolicy', 'source_time_slice_policy', 'sourceTimeSlicePolicy']
};

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

function normalizePathText(value = '') {
  return compactText(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeReleaseScope(value = '') {
  const key = normalizeKey(value || 'full');
  if (['p0_p1', 'p0p1', 'p0_p1_only', 'p0_and_p1', 'phase_p0_p1'].includes(key)) return 'p0_p1';
  return 'full';
}

function releaseGateEvidenceInputRolesForScope(scope = 'full') {
  return RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE[normalizeReleaseScope(scope)]
    || RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE.full;
}

function releaseScopeLabel(scope = 'full') {
  return normalizeReleaseScope(scope) === 'p0_p1' ? 'p0-p1' : 'full';
}

function requiredAblationsForReleaseScope(scope = 'full') {
  return normalizeReleaseScope(scope) === 'p0_p1'
    ? RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS
    : RELEASE_GATE_REQUIRED_ABLATIONS;
}

function datasetFamilySlug(family = {}) {
  return compactText(family.id || family.label || 'dataset').replace(/_/g, '-');
}

function releaseEvidenceReportPathForRole(role = '') {
  const paths = {
    replay_suite_manifest: 'reports/replay-suite-manifest.json',
    ablation_manifest: 'reports/ablation-manifest.json',
    human_blind_aggregation: 'reports/human-blind-aggregation.json',
    ingestion_graph_mutation_execution: 'reports/graph-mutation-execution-report.json',
    engineering_release_evidence: 'reports/engineering-release-evidence.json',
    docs_sync_release_evidence: 'reports/docs-sync-release-evidence.json',
    graph_reasoning_report: 'reports/graph-reasoning-report.json',
    scientific_embedding_release_evidence: 'reports/scientific-embedding-release-evidence.json',
    innovation_sidecar_release_evidence: 'reports/innovation-sidecar-release-evidence.json',
    graph_link_prediction_report: 'reports/graph-link-prediction-eval.json'
  };
  return paths[canonicalRole(role)] || `reports/${canonicalRole(role)}.json`;
}

function releaseEvidenceBundleSkeletonArtifacts(scope = 'full') {
  const artifacts = [];
  for (const family of REQUIRED_RELEASE_DATASET_FAMILIES) {
    const slug = datasetFamilySlug(family);
    artifacts.push({ role: 'raw_input', path: `raw-inputs/${slug}.json`, family: family.id });
    artifacts.push({ role: 'normalized_dataset', path: `normalized-datasets/${slug}-replay.json`, family: family.id });
  }
  artifacts.push(
    { role: 'run_config', path: 'run-config.json' },
    { role: 'evidence_report', path: 'reports/replay-suite-manifest.json' },
    { role: 'statistical_significance', path: 'reports/statistical-significance.json' },
    { role: 'human_blind_cases', path: 'human-blind/cases.json' },
    { role: 'human_blind_labels', path: 'human-blind/labels.json' },
    { role: 'human_blind_pack', path: 'human-blind/blind-pack.json' },
    { role: 'human_blind_assignments', path: 'human-blind/assignments.json' },
    { role: 'human_blind_answer_key', path: 'human-blind/answer-key.json' },
    { role: 'human_blind_review_form_schema', path: 'human-blind/review-form.schema.json' },
    { role: 'graph_mutations', path: 'ingestion/graph-mutations.json' },
    { role: 'graph_apply_plan', path: 'ingestion/graph-apply-plan.json' },
    { role: 'citation_intent_gold_labels', path: 'ingestion/citation-intent-gold.json' },
    { role: 'claim_extraction_gold_labels', path: 'ingestion/claim-extraction-gold.json' },
    { role: 'multimodal_assets', path: 'ingestion/multimodal-assets.json' },
    { role: 'rollback_manifest', path: 'ingestion/rollback-manifest.json' },
    { role: 'before_graph_snapshot', path: 'ingestion/before-graph-snapshot.json' },
    { role: 'ablation_benchmark', path: 'ablations/ablation-benchmark.json' }
  );
  artifacts.push({ role: 'engineering_package_manifest', path: 'source/package.json' });
  for (const testFile of REQUIRED_ENGINEERING_TESTS) {
    artifacts.push({ role: 'engineering_required_test_file', path: `source/${testFile}` });
  }
  for (const inputFile of REQUIRED_DOCS_SYNC_INPUTS) {
    artifacts.push({ role: 'docs_sync_required_input', path: `source/${inputFile}` });
  }
  for (const ablationId of requiredAblationsForReleaseScope(scope)) {
    artifacts.push({
      role: 'ablation_variant_report',
      path: `ablations/${ablationId}-report.json`,
      ablation_id: ablationId
    });
  }
  for (const role of releaseGateEvidenceInputRolesForScope(scope)) {
    if (role === 'replay_suite_manifest') continue;
    artifacts.push({ role, path: releaseEvidenceReportPathForRole(role) });
  }
  artifacts.push(
    { role: 'release_gate_manifest', path: 'release-gate-manifest.json' },
    { role: 'stdout_log', path: 'logs/stdout.log', allow_empty: true },
    { role: 'stderr_log', path: 'logs/stderr.log', allow_empty: true }
  );
  const seen = new Set();
  return artifacts.filter((entry) => {
    const key = `${entry.role}:${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderReleaseEvidenceBundleSkeletonTodo(skeleton = {}) {
  const scope = releaseScopeLabel(skeleton.releaseScope || skeleton.release_scope);
  const lines = [
    `# Release Evidence Bundle Skeleton: ${skeleton.runId || 'run'}`,
    '',
    `Scope: ${scope}`,
    '',
    'This directory is only a skeleton. It is not release evidence until every listed artifact is replaced by real run output, `eval:idea-catalyst-release-gate` passes for the same scope, and `eval:release-evidence-bundle -- --require-passed` passes.',
    '',
    '## Required Artifact Work',
    '',
    '- Fill `raw-inputs/*.json` with the external benchmark raw inputs for every required family.',
    '- Fill `normalized-datasets/*-replay.json` with replay-ready datasets that include source, license, raw input hash, time cutoff, adapter, holdout, and time-slice metadata.',
    '- Fill `reports/replay-suite-manifest.json` with a release-ready replay-suite manifest consumed by the release gate.',
    '- Fill `reports/statistical-significance.json` with paired statistical evidence and ensure the replay-suite manifest references it through a hashed input record.',
    '- Fill `reports/human-blind-aggregation.json` with real human blind labels and generated blind-review material hashes.',
    '- Fill `human-blind/cases.json`, `human-blind/labels.json`, `human-blind/blind-pack.json`, `human-blind/assignments.json`, `human-blind/answer-key.json`, and `human-blind/review-form.schema.json` with the files referenced by the aggregation hashes.',
    '- Fill `reports/graph-mutation-execution-report.json` with a real release-gated ingestion apply report and fill `ingestion/` with its graph mutations, apply plan, gold labels, multimodal assets, rollback manifest, and before-graph snapshot.',
    '- Fill `reports/engineering-release-evidence.json` and `reports/docs-sync-release-evidence.json` with passed T1/D1 evidence.',
    '- Fill `source/package.json`, `source/test/*.js`, `source/docs/**`, and `source/scripts/**` with the T1/D1 source snapshots referenced by those reports.',
    '- Fill `reports/ablation-manifest.json`, `ablations/ablation-benchmark.json`, and every `ablations/*-report.json` with real AB1 ablation evidence.',
    '- Generate `release-gate-manifest.json` by running `eval:idea-catalyst-release-gate` with the same scope.',
    '- Capture stdout/stderr logs for the release gate and bundle audit under `logs/`.',
    '',
    '## Verification Commands',
    '',
    '```bash',
    `npm run eval:idea-catalyst-release-gate -- --scope ${scope} --require-passed`,
    `npm run eval:release-evidence-bundle -- --bundle-dir ${skeleton.bundleDir || '<bundle-dir>'} --scope ${scope} --require-passed`,
    '```',
    '',
    '## Manifest Entries',
    ''
  ];
  for (const artifact of asArray(skeleton.artifacts)) {
    lines.push(`- ${artifact.role}: ${artifact.path}`);
  }
  return `${lines.join('\n')}\n`;
}

function canonicalRole(value = '') {
  const role = normalizeKey(value);
  if (['raw', 'raw_inputs', 'raw_dataset', 'raw_benchmark', 'raw_benchmarks'].includes(role)) return 'raw_input';
  if (['normalized', 'normalized_data', 'normalized_replay', 'replay_dataset'].includes(role)) return 'normalized_dataset';
  if (['config', 'run_configuration'].includes(role)) return 'run_config';
  if (['report', 'evidence', 'evidence_reports'].includes(role)) return 'evidence_report';
  if (['docs_sync', 'docs_sync_evidence', 'docs_sync_report', 'docs_sync_release_report', 'documentation_sync_release_evidence'].includes(role)) return 'docs_sync_release_evidence';
  if (['release_gate', 'release_manifest', 'release_gate_report'].includes(role)) return 'release_gate_manifest';
  if (['stdout', 'stdout_tail'].includes(role)) return 'stdout_log';
  if (['stderr', 'stderr_tail'].includes(role)) return 'stderr_log';
  return role;
}

function resolveBundlePath(bundleRoot = '', filePath = '') {
  const text = compactText(filePath);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.resolve(bundleRoot, text);
}

function pathInsideRoot(rootPath = '', candidatePath = '') {
  if (!rootPath || !candidatePath) return true;
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function artifactPath(entry = {}) {
  return compactText(entry.path || entry.file || entry.relative_path || entry.relativePath);
}

function declaredHash(entry = {}) {
  return compactText(entry.sha256 || entry.hash || entry.checksum);
}

function hasMetadataValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return Boolean(compactText(value));
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(compactText(value));
}

function metadataValueSummary(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return compactText(value) || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return compactText(String(value)) || null;
  }
}

function check(name, passed, message = '', fields = {}, failedStatus = 'incomplete') {
  return {
    name,
    status: passed ? 'passed' : failedStatus,
    ok: Boolean(passed),
    message: passed ? '' : message,
    ...fields
  };
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fileStats(filePath = '') {
  try {
    const stat = await fs.stat(filePath);
    return { exists: true, isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, isFile: false, size: 0, mtimeMs: null };
    throw error;
  }
}

async function normalizeArtifact(entry = {}, bundleRoot = '') {
  const role = canonicalRole(entry.role || entry.kind || entry.type);
  const relativePath = artifactPath(entry);
  const absolutePath = resolveBundlePath(bundleRoot, relativePath);
  const insideBundle = pathInsideRoot(bundleRoot, absolutePath);
  const stats = absolutePath ? await fileStats(absolutePath) : { exists: false, isFile: false, size: 0, mtimeMs: null };
  const expectedSha256 = declaredHash(entry);
  const sha256 = stats.exists && stats.isFile ? await sha256File(absolutePath) : '';
  const allowEmpty = entry.allow_empty === true || entry.allowEmpty === true || EMPTY_OK_ROLES.has(role);
  return {
    role,
    path: absolutePath || null,
    relative_path: relativePath || null,
    exists: stats.exists,
    is_file: stats.isFile,
    size: stats.size,
    mtime_ms: stats.mtimeMs,
    sha256: sha256 || null,
    declared_sha256: expectedSha256 || null,
    hash_matches: !expectedSha256 || expectedSha256 === sha256,
    inside_bundle: insideBundle,
    path_error: insideBundle ? null : 'artifact_path_outside_bundle',
    allow_empty: allowEmpty,
    non_empty: allowEmpty || stats.size > 0
  };
}

function bundleManifestArtifacts(manifest = {}) {
  return [
    ...asArray(manifest.artifacts),
    ...asArray(manifest.files),
    ...asArray(manifest.inputs)
  ].filter((entry) => entry && typeof entry === 'object');
}

async function readBundleManifest(bundleManifestPath = '') {
  try {
    return {
      exists: true,
      manifest: await readJson(bundleManifestPath, {})
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, manifest: {}, error: 'bundle manifest missing' };
    }
    return { exists: true, manifest: {}, error: error.message || String(error) };
  }
}

async function readReleaseGateManifest(artifacts = []) {
  const releaseGateArtifact = artifacts.find((entry) => entry.role === 'release_gate_manifest' && entry.exists && entry.is_file);
  if (!releaseGateArtifact?.path) {
    return { artifact: releaseGateArtifact || null, manifest: {}, error: 'release gate manifest artifact missing' };
  }
  try {
    return {
      artifact: releaseGateArtifact,
      manifest: await readJson(releaseGateArtifact.path, {})
    };
  } catch (error) {
    return {
      artifact: releaseGateArtifact,
      manifest: {},
      error: error.message || String(error)
    };
  }
}

function releaseGateEvidenceInputHashes(releaseGateManifest = {}) {
  return releaseGateEvidenceInputRecords(releaseGateManifest)
    .map((entry) => entry.sha256)
    .filter(Boolean);
}

function releaseGateConsumedArtifacts(artifacts = [], releaseGateInputs = []) {
  const releaseGateInputHashSet = new Set(releaseGateInputs);
  return artifacts.filter((entry) => (
    entry.sha256
      && releaseGateInputHashSet.has(entry.sha256)
      && entry.exists
      && entry.is_file
  ));
}

function releaseGateConsumedArtifactsForInputRoles(artifacts = [], releaseGateInputRecords = [], roles = []) {
  const roleKeys = new Set(asArray(roles).map(canonicalRole));
  const releaseGateInputHashSet = new Set(asArray(releaseGateInputRecords)
    .filter((entry) => roleKeys.has(canonicalRole(entry.role)))
    .map((entry) => compactText(entry.sha256))
    .filter(Boolean));
  return artifacts.filter((entry) => (
    entry.sha256
      && releaseGateInputHashSet.has(entry.sha256)
      && entry.exists
      && entry.is_file
  ));
}

function releaseGateEvidenceInputRecords(releaseGateManifest = {}) {
  return asArray(releaseGateManifest.evidence_inputs)
    .map((entry) => ({
      role: canonicalRole(entry.role || entry.kind || entry.type),
      path: compactText(entry.path || entry.file || entry.relative_path || entry.relativePath),
      sha256: compactText(entry.sha256 || entry.hash || entry.checksum)
    }));
}

async function readJsonArtifact(artifact = {}) {
  if (!artifact.path || !artifact.exists || !artifact.is_file || !DATASET_METADATA_ROLES.has(artifact.role)) {
    return { artifact, record: {}, readable: false };
  }
  try {
    return { artifact, record: await readJson(artifact.path, {}), readable: true };
  } catch (error) {
    return { artifact, record: {}, readable: false, error: error.message || String(error) };
  }
}

function metadataContainers(record = {}) {
  const dataset = asObject(record.dataset);
  const metadata = asObject(record.metadata);
  const provenance = asObject(record.provenance);
  const config = asObject(record.config);
  const adapter = asObject(record.adapter);
  const benchmark = asObject(record.benchmark);
  return [
    record,
    metadata,
    asObject(record.dataset_metadata),
    asObject(record.datasetMetadata),
    dataset,
    asObject(dataset.metadata),
    asObject(dataset.provenance),
    provenance,
    asObject(provenance.metadata),
    config,
    asObject(config.metadata),
    adapter,
    benchmark,
    asObject(benchmark.metadata)
  ];
}

function metadataSource(artifact = {}, field = '', value, sourcePath = '') {
  return {
    role: artifact.role || null,
    path: artifact.path || null,
    source_path: sourcePath || null,
    field,
    value: metadataValueSummary(value)
  };
}

function collectMetadataFieldSources(record = {}, artifact = {}, field = '') {
  const aliases = DATASET_METADATA_FIELD_ALIASES[field] || [field];
  const sources = [];
  for (const [containerIndex, container] of metadataContainers(record).entries()) {
    for (const alias of aliases) {
      if (hasMetadataValue(container[alias])) {
        sources.push(metadataSource(artifact, field, container[alias], `${containerIndex}.${alias}`));
      }
    }
  }
  if (field === 'adapter_format') {
    const adapterFormat = asObject(record.adapter).format || asObject(record.contracts).adapter;
    if (hasMetadataValue(adapterFormat)) {
      sources.push(metadataSource(artifact, field, adapterFormat, 'adapter.format'));
    }
  }
  return sources;
}

function collectRawInputHashSources(record = {}, artifact = {}) {
  const sources = collectMetadataFieldSources(record, artifact, 'raw_input_sha256');
  const inputGroups = [
    record.inputs,
    record.files,
    record.artifacts,
    asObject(record.provenance).inputs,
    asObject(record.metadata).inputs,
    asObject(record.dataset).inputs
  ];
  for (const [groupIndex, group] of inputGroups.entries()) {
    for (const [entryIndex, entry] of asArray(group).entries()) {
      const input = asObject(entry);
      const role = canonicalRole(input.role || input.kind || input.type || input.name);
      const sha256 = compactText(input.sha256 || input.hash || input.checksum || input.raw_input_sha256 || input.rawInputSha256);
      if (role === 'raw_input' && sha256) {
        sources.push(metadataSource(artifact, 'raw_input_sha256', sha256, `inputs.${groupIndex}.${entryIndex}.sha256`));
      }
    }
  }
  return sources;
}

function extractSha256Values(value) {
  const values = [];
  if (typeof value === 'string') {
    const matches = value.match(/\b[a-f0-9]{64}\b/gi) || [];
    values.push(...matches.map((entry) => entry.toLowerCase()));
  } else if (Array.isArray(value)) {
    for (const entry of value) values.push(...extractSha256Values(entry));
  } else if (value && typeof value === 'object') {
    for (const alias of ['sha256', 'hash', 'checksum', 'raw_input_sha256', 'rawInputSha256']) {
      if (Object.hasOwn(value, alias)) values.push(...extractSha256Values(value[alias]));
    }
  }
  return values;
}

function datasetFamilyIdsForValue(value = {}) {
  const object = asObject(value);
  return REQUIRED_RELEASE_DATASET_FAMILIES
    .filter((family) => (
      directObjectMatchesDatasetFamily(object, family)
        || directObjectMatchesDatasetFamily(asObject(object.metadata), family)
        || directObjectMatchesDatasetFamily(asObject(object.dataset), family)
        || directObjectMatchesDatasetFamily(asObject(object.dataset_metadata), family)
        || directObjectMatchesDatasetFamily(asObject(object.datasetMetadata), family)
        || directObjectMatchesDatasetFamily(asObject(object.benchmark), family)
    ))
    .map((family) => family.id);
}

function rawInputSha256EvidenceSources(value, sourcePath = 'record', activeFamilyIds = []) {
  const sources = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      sources.push(...rawInputSha256EvidenceSources(entry, `${sourcePath}.${index}`, activeFamilyIds));
    }
    return sources;
  }
  const object = asObject(value);
  if (Object.keys(object).length === 0) return sources;
  const directFamilyIds = datasetFamilyIdsForValue(object);
  const familyIds = directFamilyIds.length > 0 ? directFamilyIds : activeFamilyIds;
  for (const alias of DATASET_METADATA_FIELD_ALIASES.raw_input_sha256) {
    if (Object.hasOwn(object, alias)) {
      for (const sha256 of extractSha256Values(object[alias])) {
        sources.push({ sha256, source_path: `${sourcePath}.${alias}`, family_ids: familyIds });
      }
    }
  }
  for (const groupName of ['inputs', 'files', 'artifacts']) {
    for (const [entryIndex, entry] of asArray(object[groupName]).entries()) {
      const input = asObject(entry);
      const role = canonicalRole(input.role || input.kind || input.type || input.name);
      if (role !== 'raw_input') continue;
      const inputFamilyIds = datasetFamilyIdsForValue(input);
      const evidenceFamilyIds = inputFamilyIds.length > 0 ? inputFamilyIds : familyIds;
      for (const sha256 of extractSha256Values(input)) {
        sources.push({ sha256, source_path: `${sourcePath}.${groupName}.${entryIndex}`, family_ids: evidenceFamilyIds });
      }
    }
  }
  for (const [key, entry] of Object.entries(object)) {
    if (DATASET_METADATA_FIELD_ALIASES.raw_input_sha256.includes(key)) continue;
    sources.push(...rawInputSha256EvidenceSources(entry, `${sourcePath}.${key}`, familyIds));
  }
  return sources;
}

function directDatasetFamilyText(value = {}) {
  const object = asObject(value);
  const metadata = asObject(object.metadata);
  const dataset = asObject(object.dataset);
  const benchmark = asObject(object.benchmark);
  return [
    object.id,
    object.slug,
    object.name,
    object.label,
    object.family,
    object.dataset_family,
    object.datasetFamily,
    object.benchmark_family,
    object.benchmarkFamily,
    metadata.id,
    metadata.slug,
    metadata.name,
    metadata.label,
    metadata.family,
    dataset.id,
    dataset.slug,
    dataset.name,
    dataset.label,
    dataset.family,
    benchmark.id,
    benchmark.slug,
    benchmark.name,
    benchmark.label,
    benchmark.family
  ].map(compactText).filter(Boolean).join(' ').toLowerCase();
}

function directObjectMatchesDatasetFamily(value = {}, family = {}) {
  const text = directDatasetFamilyText(value);
  return Boolean(text) && asArray(family.patterns).some((pattern) => pattern.test(text));
}

function artifactPathMatchesDatasetFamily(artifact = {}, family = {}) {
  const text = [artifact.path, artifact.relative_path].map(compactText).filter(Boolean).join(' ').toLowerCase();
  return Boolean(text) && asArray(family.patterns).some((pattern) => pattern.test(text));
}

function singleFamilyArtifactMatches(record = {}, artifact = {}, family = {}) {
  if (directObjectMatchesDatasetFamily(record, family)) return true;
  if (directObjectMatchesDatasetFamily(asObject(record.metadata), family)) return true;
  if (directObjectMatchesDatasetFamily(asObject(record.dataset), family)) return true;
  if (directObjectMatchesDatasetFamily(asObject(record.dataset_metadata), family)) return true;
  if (directObjectMatchesDatasetFamily(asObject(record.datasetMetadata), family)) return true;
  if (directObjectMatchesDatasetFamily(asObject(record.benchmark), family)) return true;
  return artifact.role !== 'run_config' && artifactPathMatchesDatasetFamily(artifact, family);
}

function pushMetadataContainerEntry(entries = [], sourcePath = '', value = {}) {
  const container = asObject(value);
  if (Object.keys(container).length === 0) return;
  entries.push({ sourcePath, container });
}

function pushStandardMetadataContainerEntries(entries = [], sourcePath = '', value = {}) {
  const object = asObject(value);
  const dataset = asObject(object.dataset);
  const metadata = asObject(object.metadata);
  const provenance = asObject(object.provenance);
  const config = asObject(object.config);
  const adapter = asObject(object.adapter);
  const benchmark = asObject(object.benchmark);
  pushMetadataContainerEntry(entries, sourcePath, object);
  pushMetadataContainerEntry(entries, `${sourcePath}.metadata`, metadata);
  pushMetadataContainerEntry(entries, `${sourcePath}.dataset_metadata`, asObject(object.dataset_metadata));
  pushMetadataContainerEntry(entries, `${sourcePath}.datasetMetadata`, asObject(object.datasetMetadata));
  pushMetadataContainerEntry(entries, `${sourcePath}.dataset`, dataset);
  pushMetadataContainerEntry(entries, `${sourcePath}.dataset.metadata`, asObject(dataset.metadata));
  pushMetadataContainerEntry(entries, `${sourcePath}.dataset.provenance`, asObject(dataset.provenance));
  pushMetadataContainerEntry(entries, `${sourcePath}.provenance`, provenance);
  pushMetadataContainerEntry(entries, `${sourcePath}.provenance.metadata`, asObject(provenance.metadata));
  pushMetadataContainerEntry(entries, `${sourcePath}.config`, config);
  pushMetadataContainerEntry(entries, `${sourcePath}.config.metadata`, asObject(config.metadata));
  pushMetadataContainerEntry(entries, `${sourcePath}.adapter`, adapter);
  pushMetadataContainerEntry(entries, `${sourcePath}.benchmark`, benchmark);
  pushMetadataContainerEntry(entries, `${sourcePath}.benchmark.metadata`, asObject(benchmark.metadata));
}

function familyCollectionGroups(record = {}) {
  const dataset = asObject(record.dataset);
  const metadata = asObject(record.metadata);
  const datasetMetadata = asObject(record.dataset_metadata);
  const camelDatasetMetadata = asObject(record.datasetMetadata);
  const benchmark = asObject(record.benchmark);
  return [
    { sourcePath: 'datasets', values: record.datasets },
    { sourcePath: 'dataset.datasets', values: dataset.datasets },
    { sourcePath: 'metadata.datasets', values: metadata.datasets },
    { sourcePath: 'dataset_metadata.datasets', values: datasetMetadata.datasets },
    { sourcePath: 'datasetMetadata.datasets', values: camelDatasetMetadata.datasets },
    { sourcePath: 'benchmarks', values: record.benchmarks },
    { sourcePath: 'benchmark.families', values: benchmark.families },
    { sourcePath: 'evidence_families', values: record.evidence_families },
    { sourcePath: 'evidenceFamilies', values: record.evidenceFamilies }
  ];
}

function familyScopedMetadataContainerEntries(record = {}, artifact = {}, family = {}) {
  const entries = [];
  if (singleFamilyArtifactMatches(record, artifact, family)) {
    pushStandardMetadataContainerEntries(entries, 'record', record);
  }
  for (const group of familyCollectionGroups(record)) {
    for (const [entryIndex, entry] of asArray(group.values).entries()) {
      const object = asObject(entry);
      if (!directObjectMatchesDatasetFamily(object, family)) continue;
      pushStandardMetadataContainerEntries(entries, `${group.sourcePath}.${entryIndex}`, object);
    }
  }
  return entries;
}

function collectFamilyMetadataFieldSources(record = {}, artifact = {}, family = {}, field = '') {
  const aliases = DATASET_METADATA_FIELD_ALIASES[field] || [field];
  const sources = [];
  for (const entry of familyScopedMetadataContainerEntries(record, artifact, family)) {
    for (const alias of aliases) {
      if (hasMetadataValue(entry.container[alias])) {
        sources.push(metadataSource(artifact, field, entry.container[alias], `${entry.sourcePath}.${alias}`));
      }
    }
  }
  if (field === 'adapter_format') {
    for (const entry of familyScopedMetadataContainerEntries(record, artifact, family)) {
      const adapterFormat = asObject(entry.container.adapter).format || asObject(entry.container.contracts).adapter;
      if (hasMetadataValue(adapterFormat)) {
        sources.push(metadataSource(artifact, field, adapterFormat, `${entry.sourcePath}.adapter.format`));
      }
    }
  }
  return sources;
}

function collectFamilyRawInputHashSources(record = {}, artifact = {}, family = {}) {
  const sources = collectFamilyMetadataFieldSources(record, artifact, family, 'raw_input_sha256');
  for (const entry of familyScopedMetadataContainerEntries(record, artifact, family)) {
    const inputGroups = [
      entry.container.inputs,
      entry.container.files,
      entry.container.artifacts,
      asObject(entry.container.provenance).inputs,
      asObject(entry.container.metadata).inputs,
      asObject(entry.container.dataset).inputs
    ];
    for (const [groupIndex, group] of inputGroups.entries()) {
      for (const [inputIndex, inputEntry] of asArray(group).entries()) {
        const input = asObject(inputEntry);
        const role = canonicalRole(input.role || input.kind || input.type || input.name);
        const sha256 = compactText(input.sha256 || input.hash || input.checksum || input.raw_input_sha256 || input.rawInputSha256);
        if (role === 'raw_input' && sha256) {
          sources.push(metadataSource(artifact, 'raw_input_sha256', sha256, `${entry.sourcePath}.inputs.${groupIndex}.${inputIndex}.sha256`));
        }
      }
    }
  }
  return sources;
}

function artifactDatasetText(record = {}, artifact = {}) {
  const parts = [
    artifact.role,
    artifact.path,
    artifact.relative_path,
    record.name,
    record.family,
    record.format,
    record.dataset,
    asObject(record.dataset).name,
    asObject(record.dataset).family,
    asObject(record.metadata).family,
    asObject(record.metadata).name,
    asObject(record.dataset_metadata).family,
    asObject(record.dataset_metadata).name,
    asObject(record.benchmark).name,
    asObject(record.benchmark).family
  ];
  try {
    parts.push(JSON.stringify(record));
  } catch {
    // Ignore non-serializable fixture objects; direct fields above are enough for matching.
  }
  return parts.map(compactText).filter(Boolean).join(' ').toLowerCase();
}

function artifactMatchesDatasetFamily(record = {}, artifact = {}, family = {}) {
  const text = artifactDatasetText(record, artifact);
  return asArray(family.patterns).some((pattern) => pattern.test(text));
}

function auditDatasetFamilyMetadata(readableDatasetArtifacts = [], rawInputArtifacts = [], family = {}) {
  const familyArtifacts = readableDatasetArtifacts.filter(({ record, artifact }) => (
    artifactMatchesDatasetFamily(record, artifact, family)
      || familyScopedMetadataContainerEntries(record, artifact, family).length > 0
  ));
  const familyRawInputHashes = new Set(rawInputArtifacts
    .filter(({ record, artifact }) => artifactMatchesDatasetFamily(record, artifact, family))
    .map(({ artifact }) => artifact.sha256)
    .filter(Boolean));
  const fields = {};
  for (const field of REQUIRED_RELEASE_DATASET_METADATA_FIELDS) {
    const sources = familyArtifacts.flatMap(({ record, artifact }) => (
      field === 'raw_input_sha256'
        ? collectFamilyRawInputHashSources(record, artifact, family)
        : collectFamilyMetadataFieldSources(record, artifact, family, field)
    ));
    const values = sources.map((entry) => compactText(entry.value)).filter(Boolean);
    const matchedRawInputHashes = field === 'raw_input_sha256'
      ? [...new Set(values.filter((value) => familyRawInputHashes.has(value)))]
      : [];
    const present = field === 'raw_input_sha256' ? matchedRawInputHashes.length > 0 : values.length > 0;
    fields[field] = {
      present,
      values: [...new Set(values)],
      sources,
      matched_raw_input_hashes: matchedRawInputHashes
    };
  }
  const missingFields = REQUIRED_RELEASE_DATASET_METADATA_FIELDS.filter((field) => !fields[field]?.present);
  return {
    id: family.id,
    label: family.label,
    present: familyArtifacts.length > 0,
    complete: familyArtifacts.length > 0 && missingFields.length === 0,
    artifact_count: familyArtifacts.length,
    raw_input_hashes: [...familyRawInputHashes],
    missing_fields: missingFields,
    fields
  };
}

async function auditDatasetMetadata(artifacts = []) {
  const jsonArtifacts = await Promise.all(artifacts.map(readJsonArtifact));
  const readableDatasetArtifacts = jsonArtifacts.filter((entry) => entry.readable);
  const readableRawInputArtifacts = readableDatasetArtifacts.filter((entry) => entry.artifact.role === 'raw_input');
  const rawInputHashes = new Set(
    artifacts
      .filter((entry) => entry.role === 'raw_input' && entry.sha256)
      .map((entry) => entry.sha256)
  );
  const fields = {};
  for (const field of REQUIRED_RELEASE_DATASET_METADATA_FIELDS) {
    const sources = readableDatasetArtifacts.flatMap(({ record, artifact }) => (
      field === 'raw_input_sha256'
        ? collectRawInputHashSources(record, artifact)
        : collectMetadataFieldSources(record, artifact, field)
    ));
    const values = sources.map((entry) => compactText(entry.value)).filter(Boolean);
    const matchedRawInputHashes = field === 'raw_input_sha256'
      ? values.filter((value) => rawInputHashes.has(value))
      : [];
    const present = field === 'raw_input_sha256' ? matchedRawInputHashes.length > 0 : values.length > 0;
    fields[field] = {
      present,
      values: [...new Set(values)],
      sources,
      matched_raw_input_hashes: matchedRawInputHashes
    };
  }
  return {
    required_fields: REQUIRED_RELEASE_DATASET_METADATA_FIELDS,
    readable_artifact_count: readableDatasetArtifacts.length,
    raw_input_hashes: [...rawInputHashes],
    missing_fields: REQUIRED_RELEASE_DATASET_METADATA_FIELDS.filter((field) => !fields[field]?.present),
    unreadable_artifacts: jsonArtifacts
      .filter((entry) => DATASET_METADATA_ROLES.has(entry.artifact.role) && !entry.readable)
      .map((entry) => ({ role: entry.artifact.role, path: entry.artifact.path, error: entry.error || 'not readable as JSON' })),
    families: REQUIRED_RELEASE_DATASET_FAMILIES.map((family) => (
      auditDatasetFamilyMetadata(readableDatasetArtifacts, readableRawInputArtifacts, family)
    )),
    fields
  };
}

async function auditReleaseGateRawInputLineage(artifacts = [], releaseGateInputs = [], datasetMetadata = {}) {
  const consumedEvidenceReports = releaseGateConsumedArtifacts(artifacts, releaseGateInputs)
    .filter((entry) => entry.role === 'evidence_report');
  const sourcesByHash = {};
  const sourcesByFamilyHash = {};
  const unreadableReports = [];
  for (const artifact of consumedEvidenceReports) {
    try {
      const record = await readJson(artifact.path, {});
      for (const source of rawInputSha256EvidenceSources(record)) {
        if (!sourcesByHash[source.sha256]) sourcesByHash[source.sha256] = [];
        sourcesByHash[source.sha256].push({
          report_path: artifact.path,
          report_sha256: artifact.sha256,
          source_path: source.source_path
        });
        for (const familyId of asArray(source.family_ids).map(compactText).filter(Boolean)) {
          if (!sourcesByFamilyHash[familyId]) sourcesByFamilyHash[familyId] = {};
          if (!sourcesByFamilyHash[familyId][source.sha256]) sourcesByFamilyHash[familyId][source.sha256] = [];
          sourcesByFamilyHash[familyId][source.sha256].push({
            report_path: artifact.path,
            report_sha256: artifact.sha256,
            source_path: source.source_path
          });
        }
      }
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const families = asArray(datasetMetadata.families).map((family) => {
    const rawInputHashes = asArray(family.fields?.raw_input_sha256?.matched_raw_input_hashes)
      .map((entry) => compactText(entry).toLowerCase())
      .filter(Boolean);
    const familySourcesByHash = asObject(sourcesByFamilyHash[family.id]);
    const coveredRawInputHashes = rawInputHashes.filter((sha256) => asArray(familySourcesByHash[sha256]).length > 0);
    return {
      id: family.id,
      label: family.label,
      raw_input_hashes: rawInputHashes,
      covered_raw_input_hashes: [...new Set(coveredRawInputHashes)],
      missing_release_gate_lineage_hashes: rawInputHashes.filter((sha256) => !coveredRawInputHashes.includes(sha256)),
      complete: rawInputHashes.length > 0 && coveredRawInputHashes.length > 0
    };
  });
  return {
    consumed_evidence_report_count: consumedEvidenceReports.length,
    consumed_evidence_report_hashes: consumedEvidenceReports.map((entry) => entry.sha256),
    raw_input_hashes_in_consumed_evidence_reports: Object.keys(sourcesByHash).sort(),
    sources_by_hash: sourcesByHash,
    sources_by_family_hash: sourcesByFamilyHash,
    unreadable_evidence_reports: unreadableReports,
    families,
    missing_family_lineage: families.filter((entry) => !entry.complete).map((entry) => entry.id)
  };
}

function inputHashRecordsByRole(record = {}, roles = []) {
  const roleKeys = new Set(asArray(roles).map(canonicalRole));
  return asArray(record.inputs)
    .map((entry) => ({
      role: canonicalRole(entry.role || entry.kind || entry.type || entry.name),
      path: compactText(entry.path || entry.file || entry.relative_path || entry.relativePath),
      sha256: compactText(entry.sha256 || entry.hash || entry.checksum)
    }))
    .filter((entry) => roleKeys.has(entry.role) && entry.sha256);
}

function hashRecordFromEntry(entry = {}, source = '') {
  return {
    role: canonicalRole(entry.role || entry.kind || entry.type || entry.name),
    path: compactText(entry.path || entry.file || entry.relative_path || entry.relativePath),
    relative_path: compactText(entry.relative_path || entry.relativePath || ''),
    sha256: compactText(entry.sha256 || entry.hash || entry.checksum),
    source
  };
}

function uniqueHashRecords(records = []) {
  const seen = new Set();
  const uniqueRecords = [];
  for (const record of asArray(records)) {
    const key = [
      canonicalRole(record.role),
      normalizePathText(record.path || ''),
      normalizePathText(record.relative_path || record.relativePath || ''),
      compactText(record.sha256 || '')
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueRecords.push(record);
  }
  return uniqueRecords;
}

function hashRecordPathCandidates(record = {}) {
  return [
    record.relative_path,
    record.relativePath,
    record.path,
    record.file
  ].map(normalizePathText).filter(Boolean);
}

function hashRecordMatchesRequiredPath(record = {}, requiredPath = '') {
  const required = normalizePathText(requiredPath);
  if (!required) return false;
  return hashRecordPathCandidates(record).some((candidate) => (
    candidate === required
      || candidate.endsWith(`/${required}`)
      || candidate.endsWith(required)
  ));
}

function missingRequiredInputPaths(requiredPaths = [], hashRecords = []) {
  const recordsWithHashes = asArray(hashRecords)
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
  return asArray(requiredPaths)
    .map(normalizePathText)
    .filter(Boolean)
    .filter((requiredPath) => !recordsWithHashes.some((record) => (
      hashRecordMatchesRequiredPath(record, requiredPath)
    )));
}

function changedInputCount(value = {}) {
  const inputStability = asObject(value);
  const count = Number(inputStability.changed_input_count ?? inputStability.changedInputCount ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function changedInputRecords(value = {}, diagnostics = {}) {
  const inputStability = asObject(value);
  return [
    ...asArray(inputStability.changed_inputs),
    ...asArray(inputStability.changedInputs),
    ...asArray(asObject(diagnostics).changed_input_hashes),
    ...asArray(asObject(diagnostics).changedInputHashes)
  ].filter(Boolean);
}

function engineeringReleaseEvidenceHashRecords(record = {}) {
  const requiredTests = asArray(record.required_tests || record.requiredTests || REQUIRED_ENGINEERING_TESTS)
    .map(normalizePathText)
    .filter(Boolean);
  const inputRecords = uniqueHashRecords(asArray(record.inputs)
    .map((entry) => hashRecordFromEntry(entry, 'inputs'))
    .filter((entry) => entry.sha256));
  const requiredTestInputRecords = inputRecords.filter((entry) => (
    entry.role === 'required_test_file'
      || requiredTests.some((requiredPath) => hashRecordMatchesRequiredPath(entry, requiredPath))
  ));
  return {
    required_tests: requiredTests,
    input_records: inputRecords,
    required_test_input_records: requiredTestInputRecords,
    missing_required_test_input_paths: missingRequiredInputPaths(requiredTests, requiredTestInputRecords)
  };
}

async function auditEngineeringReleaseEvidenceLineage(artifacts = [], releaseGateInputRecords = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifactsForInputRoles(
    artifacts,
    releaseGateInputRecords,
    'engineering_release_evidence'
  );
  const engineeringReports = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      const contractVersion = compactText(record.contractVersion || record.contract_version);
      const hashRecords = engineeringReleaseEvidenceHashRecords(record);
      const requiredHashes = hashRecords.input_records.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const contractMatches = contractVersion === ENGINEERING_RELEASE_EVIDENCE_VERSION;
      const status = contractMatches
        && hashRecords.missing_required_test_input_paths.length === 0
        && requiredHashes.length > 0
        && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      engineeringReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        contract_version: contractVersion || null,
        required_tests: hashRecords.required_tests,
        input_hash_records: hashRecords.input_records,
        required_test_input_hash_records: hashRecords.required_test_input_records,
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        missing_required_test_input_paths: hashRecords.missing_required_test_input_paths,
        status,
        message: status === 'passed'
          ? ''
          : 'engineering release evidence test input hashes must resolve to bundled source artifacts'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteReports = engineeringReports.filter((entry) => entry.status !== 'passed');
  return {
    consumed_engineering_release_evidence_count: engineeringReports.length,
    status: engineeringReports.length > 0 && unreadableReports.length === 0 && incompleteReports.length === 0
      ? 'passed'
      : 'incomplete',
    engineering_release_evidence_reports: engineeringReports,
    unreadable_engineering_release_evidence_reports: unreadableReports,
    missing_bundled_input_hashes: engineeringReports.flatMap((entry) => entry.missing_bundled_input_hashes),
    missing_required_test_input_paths: [...new Set(engineeringReports.flatMap((entry) => (
      entry.missing_required_test_input_paths
    )))].sort(),
    incomplete_engineering_release_evidence_hashes: incompleteReports.map((entry) => entry.sha256)
  };
}

function docsSyncReleaseEvidenceHashRecords(record = {}) {
  const requiredInputs = asArray(record.required_inputs || record.requiredInputs || REQUIRED_DOCS_SYNC_INPUTS)
    .map(normalizePathText)
    .filter(Boolean);
  const inputRecords = uniqueHashRecords(asArray(record.inputs)
    .map((entry) => hashRecordFromEntry(entry, 'inputs'))
    .filter((entry) => entry.sha256));
  const precheckInputRecords = uniqueHashRecords(asArray(record.precheck_inputs || record.precheckInputs)
    .map((entry) => hashRecordFromEntry(entry, 'precheck_inputs'))
    .filter((entry) => entry.sha256));
  return {
    required_inputs: requiredInputs,
    input_records: inputRecords,
    precheck_input_records: precheckInputRecords,
    missing_required_input_paths: missingRequiredInputPaths(requiredInputs, inputRecords),
    missing_precheck_input_paths: missingRequiredInputPaths(requiredInputs, precheckInputRecords)
  };
}

async function auditDocsSyncReleaseEvidenceLineage(artifacts = [], releaseGateInputRecords = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifactsForInputRoles(
    artifacts,
    releaseGateInputRecords,
    'docs_sync_release_evidence'
  );
  const docsSyncReports = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      const contractVersion = compactText(record.contractVersion || record.contract_version);
      const hashRecords = docsSyncReleaseEvidenceHashRecords(record);
      const allInputRecords = uniqueHashRecords([
        ...hashRecords.input_records,
        ...hashRecords.precheck_input_records
      ]);
      const requiredHashes = allInputRecords.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const inputStability = asObject(record.input_stability || record.inputStability);
      const diagnostics = asObject(record.diagnostics);
      const stabilityChecked = inputStability.checked === true;
      const hasChangedInputs = changedInputCount(inputStability) > 0
        || changedInputRecords(inputStability, diagnostics).length > 0;
      const contractMatches = contractVersion === DOCS_SYNC_RELEASE_EVIDENCE_VERSION;
      const status = contractMatches
        && stabilityChecked
        && !hasChangedInputs
        && hashRecords.missing_required_input_paths.length === 0
        && hashRecords.missing_precheck_input_paths.length === 0
        && requiredHashes.length > 0
        && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      docsSyncReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        contract_version: contractVersion || null,
        required_inputs: hashRecords.required_inputs,
        input_hash_records: hashRecords.input_records,
        precheck_input_hash_records: hashRecords.precheck_input_records,
        input_stability_checked: stabilityChecked,
        changed_input_count: changedInputCount(inputStability),
        changed_inputs: changedInputRecords(inputStability, diagnostics),
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        missing_required_input_paths: hashRecords.missing_required_input_paths,
        missing_precheck_input_paths: hashRecords.missing_precheck_input_paths,
        status,
        message: status === 'passed'
          ? ''
          : 'docs-sync release evidence input and precheck hashes must resolve to bundled source artifacts'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteReports = docsSyncReports.filter((entry) => entry.status !== 'passed');
  return {
    consumed_docs_sync_release_evidence_count: docsSyncReports.length,
    status: docsSyncReports.length > 0 && unreadableReports.length === 0 && incompleteReports.length === 0
      ? 'passed'
      : 'incomplete',
    docs_sync_release_evidence_reports: docsSyncReports,
    unreadable_docs_sync_release_evidence_reports: unreadableReports,
    missing_bundled_input_hashes: docsSyncReports.flatMap((entry) => entry.missing_bundled_input_hashes),
    missing_required_input_paths: [...new Set(docsSyncReports.flatMap((entry) => (
      entry.missing_required_input_paths
    )))].sort(),
    missing_precheck_input_paths: [...new Set(docsSyncReports.flatMap((entry) => (
      entry.missing_precheck_input_paths
    )))].sort(),
    incomplete_docs_sync_release_evidence_hashes: incompleteReports.map((entry) => entry.sha256)
  };
}

function humanBlindInputRequirementForRole(role = '') {
  const key = canonicalRole(role);
  if (
    key === 'human_blind_cases'
    || key === 'human_blind_input_cases'
    || (key.includes('human') && key.includes('case'))
  ) {
    return 'human_blind_cases';
  }
  if (
    key === 'human_blind_labels'
    || key === 'human_blind_completed_labels'
    || (key.includes('human') && (key.includes('label') || key.includes('review')))
  ) {
    return 'human_blind_labels';
  }
  return '';
}

const HUMAN_BLIND_REQUIRED_ARTIFACT_ROLES = [
  'human_blind_pack',
  'human_blind_assignments',
  'human_blind_answer_key',
  'human_blind_review_form_schema'
];

function humanBlindAggregationHashRecords(record = {}) {
  const inputRecords = asArray(record.inputs)
    .map((entry) => hashRecordFromEntry(entry, 'inputs'))
    .map((entry) => ({
      ...entry,
      required_role: humanBlindInputRequirementForRole(entry.role)
    }))
    .filter((entry) => entry.required_role && entry.sha256);
  const blindReviewArtifacts = [
    ...asArray(record.blind_review_artifacts),
    ...asArray(record.blindReviewArtifacts),
    ...asArray(record.artifact_inputs),
    ...asArray(record.artifactInputs)
  ];
  const artifactRecords = blindReviewArtifacts
    .map((entry) => hashRecordFromEntry(entry, 'blind_review_artifacts'))
    .map((entry) => ({
      ...entry,
      required_role: HUMAN_BLIND_REQUIRED_ARTIFACT_ROLES.includes(entry.role) ? entry.role : ''
    }))
    .filter((entry) => entry.required_role && entry.sha256);
  const missingInputHashRoles = ['human_blind_cases', 'human_blind_labels']
    .filter((role) => !inputRecords.some((entry) => entry.required_role === role));
  const missingBlindArtifactHashRoles = HUMAN_BLIND_REQUIRED_ARTIFACT_ROLES
    .filter((role) => !artifactRecords.some((entry) => entry.required_role === role));
  return {
    input_records: inputRecords,
    blind_review_artifact_records: artifactRecords,
    hash_records: [...inputRecords, ...artifactRecords],
    missing_input_hash_roles: missingInputHashRoles,
    missing_blind_artifact_hash_roles: missingBlindArtifactHashRoles
  };
}

async function auditHumanBlindAggregationLineage(artifacts = [], releaseGateInputRecords = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifactsForInputRoles(
    artifacts,
    releaseGateInputRecords,
    'human_blind_aggregation'
  );
  const aggregations = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      const contractVersion = compactText(record.contractVersion || record.contract_version);
      const hashRecords = humanBlindAggregationHashRecords(record);
      const requiredHashes = hashRecords.hash_records.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const contractMatches = contractVersion === HUMAN_BLIND_EVAL_CONTRACT_VERSION;
      const status = contractMatches
        && hashRecords.missing_input_hash_roles.length === 0
        && hashRecords.missing_blind_artifact_hash_roles.length === 0
        && requiredHashes.length > 0
        && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      aggregations.push({
        path: artifact.path,
        sha256: artifact.sha256,
        contract_version: contractVersion || null,
        input_hash_records: hashRecords.input_records,
        blind_review_artifact_hash_records: hashRecords.blind_review_artifact_records,
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        missing_input_hash_roles: hashRecords.missing_input_hash_roles,
        missing_blind_artifact_hash_roles: hashRecords.missing_blind_artifact_hash_roles,
        status,
        message: status === 'passed'
          ? ''
          : 'human blind aggregation input and blind-review artifact hashes must resolve to bundled artifacts'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteAggregations = aggregations.filter((entry) => entry.status !== 'passed');
  return {
    consumed_human_blind_aggregation_count: aggregations.length,
    status: aggregations.length > 0 && unreadableReports.length === 0 && incompleteAggregations.length === 0
      ? 'passed'
      : 'incomplete',
    human_blind_aggregations: aggregations,
    unreadable_human_blind_aggregations: unreadableReports,
    missing_bundled_input_hashes: aggregations.flatMap((entry) => entry.missing_bundled_input_hashes),
    missing_input_hash_roles: [...new Set(aggregations.flatMap((entry) => entry.missing_input_hash_roles))].sort(),
    missing_blind_artifact_hash_roles: [...new Set(aggregations.flatMap((entry) => entry.missing_blind_artifact_hash_roles))].sort(),
    incomplete_human_blind_aggregation_hashes: incompleteAggregations.map((entry) => entry.sha256)
  };
}

const INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLE_ALIASES = [
  { id: 'graph_mutations', aliases: ['graph_mutations'] },
  { id: 'graph_apply_plan', aliases: ['graph_apply_plan'] },
  { id: 'citation_intent_gold_labels', aliases: ['citation_intent_gold_labels', 'citation_intent_gold', 'citation_gold_labels'] },
  { id: 'claim_extraction_gold_labels', aliases: ['claim_extraction_gold_labels', 'claim_extraction_gold', 'claim_gold_labels'] },
  { id: 'multimodal_assets', aliases: ['multimodal_assets', 'ocr_figure_table_formula_assets', 'ocr_assets', 'figure_table_formula_assets'] }
];
const INGESTION_GRAPH_MUTATION_REQUIRED_ARTIFACT_ROLES = [
  'rollback_manifest',
  'before_graph_snapshot'
];

function ingestionGraphMutationInputRequirementForRole(role = '') {
  const key = canonicalRole(role);
  const match = INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLE_ALIASES.find((entry) => (
    entry.aliases.map(canonicalRole).includes(key)
  ));
  return match?.id || '';
}

function ingestionGraphMutationArtifactHashRecords(record = {}) {
  const artifacts = asObject(record.artifacts);
  const safety = asObject(record.safety);
  const rollbackSha256 = compactText(
    artifacts.rollbackManifestSha256
      || artifacts.rollback_manifest_sha256
      || safety.rollbackManifestSha256
      || safety.rollback_manifest_sha256
  );
  const beforeSnapshotSha256 = compactText(
    artifacts.beforeGraphSnapshotSha256
      || artifacts.before_graph_snapshot_sha256
      || safety.beforeGraphSnapshotSha256
      || safety.before_graph_snapshot_sha256
  );
  return [
    {
      role: 'rollback_manifest',
      required_role: 'rollback_manifest',
      path: compactText(artifacts.rollbackManifest || artifacts.rollback_manifest),
      sha256: rollbackSha256,
      source: 'artifacts'
    },
    {
      role: 'before_graph_snapshot',
      required_role: 'before_graph_snapshot',
      path: compactText(artifacts.beforeGraphSnapshot || artifacts.before_graph_snapshot),
      sha256: beforeSnapshotSha256,
      source: 'artifacts'
    }
  ].filter((entry) => entry.sha256);
}

function ingestionGraphMutationHashRecords(record = {}) {
  const inputRecords = asArray(record.inputs)
    .map((entry) => hashRecordFromEntry(entry, 'inputs'))
    .map((entry) => ({
      ...entry,
      required_role: ingestionGraphMutationInputRequirementForRole(entry.role)
    }))
    .filter((entry) => entry.required_role && entry.sha256);
  const artifactRecords = ingestionGraphMutationArtifactHashRecords(record);
  const missingInputHashRoles = INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLE_ALIASES
    .map((entry) => entry.id)
    .filter((role) => !inputRecords.some((entry) => entry.required_role === role));
  const missingArtifactHashRoles = INGESTION_GRAPH_MUTATION_REQUIRED_ARTIFACT_ROLES
    .filter((role) => !artifactRecords.some((entry) => entry.required_role === role));
  return {
    input_records: inputRecords,
    artifact_records: artifactRecords,
    hash_records: [...inputRecords, ...artifactRecords],
    missing_input_hash_roles: missingInputHashRoles,
    missing_artifact_hash_roles: missingArtifactHashRoles
  };
}

async function auditIngestionGraphMutationLineage(artifacts = [], releaseGateInputRecords = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifactsForInputRoles(
    artifacts,
    releaseGateInputRecords,
    'ingestion_graph_mutation_execution'
  );
  const executionReports = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      const contractVersion = compactText(record.contractVersion || record.contract_version);
      const hashRecords = ingestionGraphMutationHashRecords(record);
      const requiredHashes = hashRecords.hash_records.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const contractMatches = contractVersion === INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION;
      const status = contractMatches
        && hashRecords.missing_input_hash_roles.length === 0
        && hashRecords.missing_artifact_hash_roles.length === 0
        && requiredHashes.length > 0
        && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      executionReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        contract_version: contractVersion || null,
        input_hash_records: hashRecords.input_records,
        artifact_hash_records: hashRecords.artifact_records,
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        missing_input_hash_roles: hashRecords.missing_input_hash_roles,
        missing_artifact_hash_roles: hashRecords.missing_artifact_hash_roles,
        status,
        message: status === 'passed'
          ? ''
          : 'ingestion graph mutation execution input, rollback, and snapshot hashes must resolve to bundled artifacts'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteExecutionReports = executionReports.filter((entry) => entry.status !== 'passed');
  return {
    consumed_ingestion_graph_mutation_execution_count: executionReports.length,
    status: executionReports.length > 0 && unreadableReports.length === 0 && incompleteExecutionReports.length === 0
      ? 'passed'
      : 'incomplete',
    ingestion_graph_mutation_executions: executionReports,
    unreadable_ingestion_graph_mutation_executions: unreadableReports,
    missing_bundled_input_hashes: executionReports.flatMap((entry) => entry.missing_bundled_input_hashes),
    missing_input_hash_roles: [...new Set(executionReports.flatMap((entry) => entry.missing_input_hash_roles))].sort(),
    missing_artifact_hash_roles: [...new Set(executionReports.flatMap((entry) => entry.missing_artifact_hash_roles))].sort(),
    incomplete_ingestion_graph_mutation_execution_hashes: incompleteExecutionReports.map((entry) => entry.sha256)
  };
}

async function auditReplayStatisticalSignificanceLineage(artifacts = [], releaseGateInputs = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifacts(artifacts, releaseGateInputs);
  const replaySuites = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      if (record.contractVersion !== REPLAY_SUITE_EVIDENCE_CONTRACT_VERSION) continue;
      const provenance = asObject(record.statistical_significance_provenance || record.statisticalSignificanceProvenance);
      const source = normalizeKey(provenance.source);
      const statisticalInputs = inputHashRecordsByRole(record, 'statistical_significance');
      const rawDatasetInputs = inputHashRecordsByRole(record, ['raw_dataset', 'raw_input']);
      const sourceAuditable = source === 'statistical_significance_file'
        || ['raw_dataset', 'raw_input', 'raw_dataset_metadata', 'raw_metadata'].includes(source);
      const requiredInputRole = source === 'statistical_significance_file'
        ? 'statistical_significance'
        : 'raw_dataset';
      const requiredInputs = source === 'statistical_significance_file'
        ? statisticalInputs
        : rawDatasetInputs;
      const requiredHashes = requiredInputs.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const status = sourceAuditable && requiredHashes.length > 0 && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      replaySuites.push({
        path: artifact.path,
        sha256: artifact.sha256,
        source: source || null,
        required_input_role: sourceAuditable ? requiredInputRole : null,
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        status,
        message: status === 'passed'
          ? ''
          : 'replay-suite statistical significance provenance must resolve to bundled input hashes'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteReplaySuites = replaySuites.filter((entry) => entry.status !== 'passed');
  return {
    consumed_replay_suite_count: replaySuites.length,
    status: replaySuites.length > 0 && unreadableReports.length === 0 && incompleteReplaySuites.length === 0
      ? 'passed'
      : 'incomplete',
    replay_suites: replaySuites,
    unreadable_replay_suites: unreadableReports,
    missing_bundled_input_hashes: replaySuites.flatMap((entry) => entry.missing_bundled_input_hashes),
    incomplete_replay_suite_hashes: incompleteReplaySuites.map((entry) => entry.sha256)
  };
}

function ablationManifestHashRecords(record = {}) {
  const benchmarkInputs = inputHashRecordsByRole(record, [
    'ablation_benchmark',
    'benchmark_dataset',
    'replay_dataset',
    'ablation_dataset'
  ]);
  const variantReports = asArray(record.ablations)
    .map((entry) => {
      const reportArtifact = asObject(entry.report_artifact || entry.reportArtifact || entry.report);
      return {
        role: canonicalRole(reportArtifact.role || 'ablation_variant_report'),
        ablation_id: compactText(entry.ablation_id || entry.id),
        path: compactText(reportArtifact.path || reportArtifact.file || reportArtifact.relative_path || reportArtifact.relativePath),
        sha256: compactText(reportArtifact.sha256 || reportArtifact.hash || reportArtifact.checksum)
      };
    })
    .filter((entry) => entry.sha256);
  return [...benchmarkInputs, ...variantReports];
}

async function auditAblationManifestLineage(artifacts = [], releaseGateInputs = []) {
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const consumedArtifacts = releaseGateConsumedArtifacts(artifacts, releaseGateInputs);
  const ablationManifests = [];
  const unreadableReports = [];
  for (const artifact of consumedArtifacts) {
    try {
      const record = await readJson(artifact.path, {});
      if (record.contractVersion !== ABLATION_RUNNER_CONTRACT_VERSION) continue;
      const hashRecords = ablationManifestHashRecords(record);
      const requiredHashes = hashRecords.map((entry) => entry.sha256).filter(Boolean);
      const coveredHashes = requiredHashes.filter((sha256) => artifactHashes.has(sha256));
      const missingBundledHashes = requiredHashes.filter((sha256) => !artifactHashes.has(sha256));
      const status = requiredHashes.length > 0 && missingBundledHashes.length === 0
        ? 'passed'
        : 'incomplete';
      ablationManifests.push({
        path: artifact.path,
        sha256: artifact.sha256,
        ablation_count: asArray(record.ablations).length,
        required_input_hashes: requiredHashes,
        covered_input_hashes: coveredHashes,
        missing_bundled_input_hashes: missingBundledHashes,
        status,
        message: status === 'passed'
          ? ''
          : 'ablation manifest input and variant report hashes must resolve to bundled artifacts'
      });
    } catch (error) {
      unreadableReports.push({
        path: artifact.path,
        sha256: artifact.sha256,
        error: error.message || String(error)
      });
    }
  }
  const incompleteAblationManifests = ablationManifests.filter((entry) => entry.status !== 'passed');
  return {
    consumed_ablation_manifest_count: ablationManifests.length,
    status: ablationManifests.length > 0 && unreadableReports.length === 0 && incompleteAblationManifests.length === 0
      ? 'passed'
      : 'incomplete',
    ablation_manifests: ablationManifests,
    unreadable_ablation_manifests: unreadableReports,
    missing_bundled_input_hashes: ablationManifests.flatMap((entry) => entry.missing_bundled_input_hashes),
    incomplete_ablation_manifest_hashes: incompleteAblationManifests.map((entry) => entry.sha256)
  };
}

function statusFromChecks(checks = []) {
  if (checks.some((entry) => entry.status === 'failed')) return 'failed';
  if (checks.some((entry) => entry.status !== 'passed')) return 'incomplete';
  return 'passed';
}

function uniqueBy(values = [], keyFn = (value) => value) {
  const seen = new Set();
  const uniqueValues = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueValues.push(value);
  }
  return uniqueValues;
}

function bundleManifestArtifactEntriesByRole(manifest = {}, role = '') {
  const key = canonicalRole(role);
  return bundleManifestArtifacts(manifest)
    .filter((entry) => canonicalRole(entry.role || entry.kind || entry.type) === key);
}

function sourceRelativePathFromRecord(record = {}, requiredPaths = [], sourceRoot = '') {
  const requiredPath = asArray(requiredPaths)
    .map(normalizePathText)
    .filter(Boolean)
    .find((entry) => hashRecordMatchesRequiredPath(record, entry));
  if (requiredPath) return requiredPath;
  for (const candidate of [record.relative_path, record.relativePath]) {
    const normalized = normalizePathText(candidate);
    if (normalized && !path.isAbsolute(normalized)) return normalized.replace(/^source\//, '');
  }
  const sourceRootText = compactText(sourceRoot);
  for (const candidate of [record.path, record.file]) {
    const text = compactText(candidate);
    if (!text) continue;
    if (path.isAbsolute(text) && sourceRootText) {
      const relative = normalizePathText(path.relative(sourceRootText, text));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
    const normalized = normalizePathText(text);
    if (normalized && !path.isAbsolute(normalized)) return normalized.replace(/^source\//, '');
  }
  return '';
}

function sourceCandidatePathsForRecord(record = {}, relativePath = '', sourceRoot = '') {
  const candidates = [];
  for (const candidate of [record.path, record.file]) {
    const text = compactText(candidate);
    if (text && path.isAbsolute(text)) candidates.push(text);
  }
  const sourceRootText = compactText(sourceRoot);
  if (sourceRootText && relativePath) candidates.push(path.resolve(sourceRootText, relativePath));
  for (const candidate of [record.path, record.file]) {
    const normalized = normalizePathText(candidate);
    if (sourceRootText && normalized && !path.isAbsolute(normalized)) {
      candidates.push(path.resolve(sourceRootText, normalized.replace(/^source\//, '')));
    }
  }
  return uniqueBy(candidates.map((entry) => path.resolve(entry)));
}

function sourceSnapshotManifestEntry(snapshot = {}) {
  return {
    role: snapshot.bundle_role,
    path: snapshot.bundle_relative_path,
    source_role: snapshot.source_report_role,
    source_relative_path: snapshot.source_relative_path,
    sha256: snapshot.sha256
  };
}

function manifestHasArtifact(manifestArtifacts = [], artifact = {}) {
  const role = canonicalRole(artifact.role);
  const artifactPathKey = normalizePathText(artifact.path);
  return asArray(manifestArtifacts).some((entry) => (
    canonicalRole(entry.role || entry.kind || entry.type) === role
      && normalizePathText(artifactPath(entry)) === artifactPathKey
  ));
}

const LINEAGE_ARTIFACT_DESTINATION_BY_ROLE = {
  statistical_significance: 'reports/statistical-significance.json',
  human_blind_cases: 'human-blind/cases.json',
  human_blind_labels: 'human-blind/labels.json',
  human_blind_pack: 'human-blind/blind-pack.json',
  human_blind_assignments: 'human-blind/assignments.json',
  human_blind_answer_key: 'human-blind/answer-key.json',
  human_blind_review_form_schema: 'human-blind/review-form.schema.json',
  graph_mutations: 'ingestion/graph-mutations.json',
  graph_apply_plan: 'ingestion/graph-apply-plan.json',
  citation_intent_gold_labels: 'ingestion/citation-intent-gold.json',
  claim_extraction_gold_labels: 'ingestion/claim-extraction-gold.json',
  multimodal_assets: 'ingestion/multimodal-assets.json',
  rollback_manifest: 'ingestion/rollback-manifest.json',
  before_graph_snapshot: 'ingestion/before-graph-snapshot.json',
  ablation_benchmark: 'ablations/ablation-benchmark.json'
};

function pathLooksLikeLineageReport(artifact = {}, patterns = []) {
  const text = normalizePathText(artifact.relative_path || artifact.path || '');
  return Boolean(text) && asArray(patterns).some((pattern) => pattern.test(text));
}

function lineageArtifactRole(record = {}) {
  return canonicalRole(record.required_role || record.requiredRole || record.role || record.kind || record.type);
}

function lineageArtifactPathBase(record = {}, fallback = '') {
  const text = normalizePathText(record.relative_path || record.relativePath || record.path || record.file || '');
  const base = path.basename(text);
  return base || fallback;
}

function ablationVariantReportId(record = {}) {
  const explicit = normalizeKey(record.ablation_id || record.ablationId || record.id);
  if (explicit) return explicit;
  const base = lineageArtifactPathBase(record, '');
  return normalizeKey(base.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]?report$/i, ''));
}

function lineageArtifactBundlePath(record = {}) {
  const role = lineageArtifactRole(record);
  if (role === 'raw_input') {
    const base = lineageArtifactPathBase(record, `raw-input-${stableHash(record.sha256 || '', 10)}.json`);
    return `raw-inputs/${base}`;
  }
  if (role === 'ablation_variant_report') {
    const ablationId = ablationVariantReportId(record) || stableHash(record.sha256 || '', 10);
    return `ablations/${ablationId}-report.json`;
  }
  return LINEAGE_ARTIFACT_DESTINATION_BY_ROLE[role] || '';
}

function lineageArtifactManifestEntry(snapshot = {}) {
  const entry = {
    role: snapshot.bundle_role,
    path: snapshot.bundle_relative_path,
    source_role: snapshot.source_report_role,
    source_report_path: snapshot.source_report_path,
    source_relative_path: snapshot.source_relative_path,
    sha256: snapshot.sha256
  };
  if (snapshot.ablation_id) entry.ablation_id = snapshot.ablation_id;
  return entry;
}

function lineageArtifactSourceCandidatePaths(record = {}, artifactRoot = '', bundleRoot = '') {
  const candidates = [];
  const roots = [artifactRoot, bundleRoot].map(compactText).filter(Boolean);
  for (const candidate of [record.path, record.file]) {
    const text = compactText(candidate);
    if (text && path.isAbsolute(text)) candidates.push(text);
  }
  for (const candidate of [record.relative_path, record.relativePath, record.path, record.file]) {
    const normalized = normalizePathText(candidate);
    if (!normalized || path.isAbsolute(normalized)) continue;
    for (const root of roots) {
      candidates.push(path.resolve(root, normalized));
    }
  }
  return uniqueBy(candidates.map((entry) => path.resolve(entry)));
}

function lineageArtifactSnapshotFromRecord(record = {}, sourceReport = {}) {
  const role = lineageArtifactRole(record);
  const sha256 = compactText(record.sha256 || record.hash || record.checksum);
  const bundleRelativePath = lineageArtifactBundlePath({ ...record, role, sha256 });
  if (!role || !sha256 || !bundleRelativePath) return null;
  return {
    source_report_role: sourceReport.role,
    source_report_path: sourceReport.path,
    bundle_role: role,
    bundle_relative_path: bundleRelativePath,
    source_relative_path: normalizePathText(record.relative_path || record.relativePath || record.path || record.file || ''),
    sha256,
    ablation_id: record.ablation_id || record.ablationId || null,
    input_record: { ...record, role, sha256 }
  };
}

function replaySuiteLineageArtifactRecords(report = {}) {
  const provenance = asObject(report.statistical_significance_provenance || report.statisticalSignificanceProvenance);
  const source = normalizeKey(provenance.source);
  if (source === 'statistical_significance_file') {
    return inputHashRecordsByRole(report, 'statistical_significance')
      .map((entry) => ({ ...entry, role: 'statistical_significance' }));
  }
  if (['raw_dataset', 'raw_input', 'raw_dataset_metadata', 'raw_metadata'].includes(source)) {
    return inputHashRecordsByRole(report, ['raw_dataset', 'raw_input'])
      .map((entry) => ({ ...entry, role: 'raw_input' }));
  }
  return [];
}

function humanBlindLineageArtifactRecords(report = {}) {
  return humanBlindAggregationHashRecords(report).hash_records
    .map((entry) => ({
      ...entry,
      role: entry.required_role || entry.role
    }));
}

function ingestionGraphMutationLineageArtifactRecords(report = {}) {
  return ingestionGraphMutationHashRecords(report).hash_records
    .map((entry) => ({
      ...entry,
      role: entry.required_role || entry.role
    }));
}

function ablationManifestLineageArtifactRecords(report = {}) {
  return ablationManifestHashRecords(report);
}

const LINEAGE_REPORT_DESCRIPTORS = [
  {
    role: 'replay_suite_manifest',
    contractVersion: REPLAY_SUITE_EVIDENCE_CONTRACT_VERSION,
    defaultPath: 'reports/replay-suite-manifest.json',
    manifestRoles: ['replay_suite_manifest', 'evidence_report'],
    pathPatterns: [/replay[-_]?suite.*manifest/i],
    records: replaySuiteLineageArtifactRecords
  },
  {
    role: 'human_blind_aggregation',
    contractVersion: HUMAN_BLIND_EVAL_CONTRACT_VERSION,
    defaultPath: 'reports/human-blind-aggregation.json',
    manifestRoles: ['human_blind_aggregation'],
    pathPatterns: [/human[-_]?blind.*aggregation/i],
    records: humanBlindLineageArtifactRecords
  },
  {
    role: 'ingestion_graph_mutation_execution',
    contractVersion: INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION,
    defaultPath: 'reports/graph-mutation-execution-report.json',
    manifestRoles: ['ingestion_graph_mutation_execution'],
    pathPatterns: [/graph[-_]?mutation[-_]?execution/i],
    records: ingestionGraphMutationLineageArtifactRecords
  },
  {
    role: 'ablation_manifest',
    contractVersion: ABLATION_RUNNER_CONTRACT_VERSION,
    defaultPath: 'reports/ablation-manifest.json',
    manifestRoles: ['ablation_manifest', 'evidence_report'],
    pathPatterns: [/ablation[-_]?manifest/i],
    records: ablationManifestLineageArtifactRecords
  }
];

async function lineageReportCandidateArtifacts(bundleRoot = '', artifacts = [], releaseGateInputRecords = [], descriptor = {}) {
  const consumedArtifacts = releaseGateConsumedArtifactsForInputRoles(
    artifacts,
    releaseGateInputRecords,
    descriptor.role
  );
  const descriptorRoles = asArray(descriptor.manifestRoles).map(canonicalRole);
  const manifestArtifacts = artifacts.filter((artifact) => {
    const role = canonicalRole(artifact.role);
    if (role === 'evidence_report') return pathLooksLikeLineageReport(artifact, descriptor.pathPatterns);
    return descriptorRoles.includes(role);
  });
  const defaultArtifact = await normalizeArtifact({
    role: descriptor.role,
    path: descriptor.defaultPath,
    allow_empty: false
  }, bundleRoot);
  return uniqueBy([
    ...consumedArtifacts,
    ...manifestArtifacts,
    ...(defaultArtifact.exists && defaultArtifact.is_file ? [defaultArtifact] : [])
  ], (entry) => entry.path);
}

async function readLineageReportCandidates(bundleRoot = '', artifacts = [], releaseGateInputRecords = []) {
  const reports = [];
  const unreadableReports = [];
  for (const descriptor of LINEAGE_REPORT_DESCRIPTORS) {
    const candidates = await lineageReportCandidateArtifacts(bundleRoot, artifacts, releaseGateInputRecords, descriptor);
    for (const artifact of candidates) {
      try {
        const record = await readJson(artifact.path, {});
        const contractVersion = compactText(record.contractVersion || record.contract_version);
        if (contractVersion !== descriptor.contractVersion) continue;
        reports.push({
          role: descriptor.role,
          path: artifact.path,
          sha256: artifact.sha256,
          descriptor,
          record
        });
      } catch (error) {
        unreadableReports.push({
          role: descriptor.role,
          path: artifact.path,
          sha256: artifact.sha256 || null,
          error: error.message || String(error)
        });
      }
    }
  }
  return {
    reports: uniqueBy(reports, (entry) => `${entry.role}:${entry.path}`),
    unreadableReports
  };
}

async function collectLineageArtifactSnapshot(snapshot = {}, options = {}) {
  const artifactRoot = options.artifactRoot || process.cwd();
  const bundleRoot = options.bundleRoot || process.cwd();
  const overwrite = options.overwrite === true;
  const sourceCandidates = lineageArtifactSourceCandidatePaths(snapshot.input_record, artifactRoot, bundleRoot);
  const destinationPath = path.resolve(bundleRoot, snapshot.bundle_relative_path);
  let sourcePath = '';
  let sourceHash = '';
  for (const candidate of sourceCandidates) {
    const stats = await fileStats(candidate);
    if (!stats.exists || !stats.isFile) continue;
    const candidateHash = await sha256File(candidate);
    if (candidateHash === snapshot.sha256) {
      sourcePath = candidate;
      sourceHash = candidateHash;
      break;
    }
    if (!sourcePath) {
      sourcePath = candidate;
      sourceHash = candidateHash;
    }
  }
  if (!sourcePath) {
    return {
      ...snapshot,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      status: 'missing_source',
      message: 'lineage artifact referenced by evidence report was not found'
    };
  }
  if (sourceHash !== snapshot.sha256) {
    return {
      ...snapshot,
      source_path: sourcePath,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      observed_sha256: sourceHash,
      status: 'source_hash_mismatch',
      message: 'lineage artifact hash does not match the evidence report'
    };
  }
  const destinationStats = await fileStats(destinationPath);
  if (destinationStats.exists && destinationStats.isFile) {
    const destinationHash = await sha256File(destinationPath);
    if (destinationHash === snapshot.sha256) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'already_present',
        message: ''
      };
    }
    if (!overwrite) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'destination_hash_mismatch',
        message: 'destination lineage artifact exists with a different hash; rerun with overwrite if intentional'
      };
    }
  }
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
  return {
    ...snapshot,
    source_path: sourcePath,
    destination_path: destinationPath,
    observed_sha256: await sha256File(destinationPath),
    status: destinationStats.exists ? 'overwritten' : 'copied',
    message: ''
  };
}

const RELEASE_GATE_INPUT_BUNDLE_ROLE_BY_ROLE = {
  replay_suite_manifest: 'evidence_report',
  graph_reasoning_report: 'evidence_report',
  graph_link_prediction_report: 'evidence_report'
};

function releaseGateInputBundleRole(role = '') {
  const key = canonicalRole(role);
  return RELEASE_GATE_INPUT_BUNDLE_ROLE_BY_ROLE[key] || key;
}

function releaseGateInputSnapshotFromRecord(record = {}, releaseGatePath = '') {
  const role = canonicalRole(record.role || record.kind || record.type);
  const sha256 = compactText(record.sha256 || record.hash || record.checksum);
  if (!role || !sha256) {
    return {
      source_report_role: 'release_gate_manifest',
      release_gate_input_role: role,
      source_release_gate_path: releaseGatePath,
      source_relative_path: normalizePathText(record.path || record.file || record.relative_path || record.relativePath || ''),
      sha256,
      input_record: record,
      status: 'missing_hash',
      message: 'release gate evidence input must include a SHA-256 hash'
    };
  }
  return {
    source_report_role: 'release_gate_manifest',
    release_gate_input_role: role,
    source_release_gate_path: releaseGatePath,
    bundle_role: releaseGateInputBundleRole(role),
    bundle_relative_path: releaseEvidenceReportPathForRole(role),
    source_relative_path: normalizePathText(record.path || record.file || record.relative_path || record.relativePath || ''),
    sha256,
    input_record: { ...record, role, sha256 }
  };
}

function releaseGateInputManifestEntry(snapshot = {}) {
  return {
    role: snapshot.bundle_role,
    path: snapshot.bundle_relative_path,
    source_role: snapshot.release_gate_input_role,
    source_release_gate_path: snapshot.source_release_gate_path,
    source_relative_path: snapshot.source_relative_path,
    sha256: snapshot.sha256
  };
}

function releaseGateInputSourceCandidatePaths(record = {}, evidenceRoot = '', bundleRoot = '', releaseGatePath = '') {
  const candidates = [];
  const releaseGateDir = releaseGatePath ? path.dirname(releaseGatePath) : '';
  const roots = [evidenceRoot, releaseGateDir, bundleRoot].map(compactText).filter(Boolean);
  for (const candidate of [record.path, record.file]) {
    const text = compactText(candidate);
    if (text && path.isAbsolute(text)) candidates.push(text);
  }
  for (const candidate of [record.relative_path, record.relativePath, record.path, record.file]) {
    const normalized = normalizePathText(candidate);
    if (!normalized || path.isAbsolute(normalized)) continue;
    for (const root of roots) candidates.push(path.resolve(root, normalized));
  }
  return uniqueBy(candidates.map((entry) => path.resolve(entry)));
}

async function collectReleaseGateManifestFile(options = {}) {
  const bundleRoot = options.bundleRoot || process.cwd();
  const releaseGateManifestPath = options.releaseGateManifestPath || path.join(bundleRoot, 'release-gate-manifest.json');
  const overwrite = options.overwrite === true;
  const sourcePath = path.resolve(releaseGateManifestPath);
  const destinationPath = path.resolve(bundleRoot, 'release-gate-manifest.json');
  const stats = await fileStats(sourcePath);
  if (!stats.exists || !stats.isFile) {
    return {
      role: 'release_gate_manifest',
      source_path: sourcePath,
      destination_path: destinationPath,
      status: 'missing_source',
      message: 'release gate manifest was not found'
    };
  }
  const sourceHash = await sha256File(sourcePath);
  const destinationStats = await fileStats(destinationPath);
  if (destinationStats.exists && destinationStats.isFile) {
    const destinationHash = await sha256File(destinationPath);
    if (destinationHash === sourceHash) {
      return {
        role: 'release_gate_manifest',
        bundle_role: 'release_gate_manifest',
        bundle_relative_path: 'release-gate-manifest.json',
        source_path: sourcePath,
        destination_path: destinationPath,
        sha256: sourceHash,
        observed_sha256: destinationHash,
        status: 'already_present',
        message: ''
      };
    }
    if (!overwrite) {
      return {
        role: 'release_gate_manifest',
        bundle_role: 'release_gate_manifest',
        bundle_relative_path: 'release-gate-manifest.json',
        source_path: sourcePath,
        destination_path: destinationPath,
        sha256: sourceHash,
        observed_sha256: destinationHash,
        status: 'destination_hash_mismatch',
        message: 'destination release gate manifest exists with a different hash; rerun with overwrite if intentional'
      };
    }
  }
  if (sourcePath !== destinationPath) {
    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
  }
  return {
    role: 'release_gate_manifest',
    bundle_role: 'release_gate_manifest',
    bundle_relative_path: 'release-gate-manifest.json',
    source_path: sourcePath,
    destination_path: destinationPath,
    sha256: sourceHash,
    observed_sha256: await sha256File(destinationPath),
    status: destinationStats.exists ? 'overwritten' : 'copied',
    message: ''
  };
}

async function collectReleaseGateInputSnapshot(snapshot = {}, options = {}) {
  if (snapshot.status === 'missing_hash') return snapshot;
  const evidenceRoot = options.evidenceRoot || process.cwd();
  const bundleRoot = options.bundleRoot || process.cwd();
  const releaseGatePath = options.releaseGatePath || '';
  const overwrite = options.overwrite === true;
  const sourceCandidates = releaseGateInputSourceCandidatePaths(
    snapshot.input_record,
    evidenceRoot,
    bundleRoot,
    releaseGatePath
  );
  const destinationPath = path.resolve(bundleRoot, snapshot.bundle_relative_path);
  let sourcePath = '';
  let sourceHash = '';
  for (const candidate of sourceCandidates) {
    const stats = await fileStats(candidate);
    if (!stats.exists || !stats.isFile) continue;
    const candidateHash = await sha256File(candidate);
    if (candidateHash === snapshot.sha256) {
      sourcePath = candidate;
      sourceHash = candidateHash;
      break;
    }
    if (!sourcePath) {
      sourcePath = candidate;
      sourceHash = candidateHash;
    }
  }
  if (!sourcePath) {
    return {
      ...snapshot,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      status: 'missing_source',
      message: 'release gate evidence input file was not found'
    };
  }
  if (sourceHash !== snapshot.sha256) {
    return {
      ...snapshot,
      source_path: sourcePath,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      observed_sha256: sourceHash,
      status: 'source_hash_mismatch',
      message: 'release gate evidence input hash does not match the source file'
    };
  }
  const destinationStats = await fileStats(destinationPath);
  if (destinationStats.exists && destinationStats.isFile) {
    const destinationHash = await sha256File(destinationPath);
    if (destinationHash === snapshot.sha256) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'already_present',
        message: ''
      };
    }
    if (!overwrite) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'destination_hash_mismatch',
        message: 'destination evidence input exists with a different hash; rerun with overwrite if intentional'
      };
    }
  }
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
  return {
    ...snapshot,
    source_path: sourcePath,
    destination_path: destinationPath,
    observed_sha256: await sha256File(destinationPath),
    status: destinationStats.exists ? 'overwritten' : 'copied',
    message: ''
  };
}

async function readSourceSnapshotEvidenceReport(bundleRoot = '', manifest = {}, role = '') {
  const roleKey = canonicalRole(role);
  const manifestEntries = bundleManifestArtifactEntriesByRole(manifest, roleKey);
  const candidates = uniqueBy(
    manifestEntries.length > 0 ? manifestEntries : [{ role: roleKey, path: releaseEvidenceReportPathForRole(roleKey) }],
    (entry) => `${canonicalRole(entry.role || entry.kind || entry.type)}:${artifactPath(entry)}`
  );
  const reports = [];
  const missing = [];
  for (const entry of candidates) {
    const reportPath = resolveBundlePath(bundleRoot, artifactPath(entry));
    try {
      reports.push({
        role: roleKey,
        path: reportPath,
        record: await readJson(reportPath, {})
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missing.push({ role: roleKey, path: reportPath, reason: 'missing' });
      } else {
        missing.push({ role: roleKey, path: reportPath, reason: error.message || String(error) });
      }
    }
  }
  return { reports, missing };
}

function engineeringSnapshotRecords(report = {}, sourceRoot = '') {
  const hashRecords = engineeringReleaseEvidenceHashRecords(report);
  const requiredPaths = ['package.json', ...hashRecords.required_tests];
  return hashRecords.input_records
    .map((record) => {
      const relativePath = sourceRelativePathFromRecord(record, requiredPaths, sourceRoot);
      if (!relativePath) return null;
      const bundleRole = normalizePathText(relativePath) === 'package.json'
        ? 'engineering_package_manifest'
        : 'engineering_required_test_file';
      return {
        source_report_role: 'engineering_release_evidence',
        bundle_role: bundleRole,
        source_relative_path: relativePath,
        bundle_relative_path: `source/${relativePath}`,
        sha256: record.sha256,
        input_record: record
      };
    })
    .filter(Boolean);
}

function docsSyncSnapshotRecords(report = {}, sourceRoot = '') {
  const hashRecords = docsSyncReleaseEvidenceHashRecords(report);
  return uniqueHashRecords([
    ...hashRecords.input_records,
    ...hashRecords.precheck_input_records
  ])
    .map((record) => {
      const relativePath = sourceRelativePathFromRecord(record, hashRecords.required_inputs, sourceRoot);
      if (!relativePath) return null;
      return {
        source_report_role: 'docs_sync_release_evidence',
        bundle_role: 'docs_sync_required_input',
        source_relative_path: relativePath,
        bundle_relative_path: `source/${relativePath}`,
        sha256: record.sha256,
        input_record: record
      };
    })
    .filter(Boolean);
}

async function collectSourceSnapshot(snapshot = {}, options = {}) {
  const sourceRoot = options.sourceRoot || process.cwd();
  const bundleRoot = options.bundleRoot || process.cwd();
  const overwrite = options.overwrite === true;
  const sourceCandidates = sourceCandidatePathsForRecord(snapshot.input_record, snapshot.source_relative_path, sourceRoot);
  const destinationPath = path.resolve(bundleRoot, snapshot.bundle_relative_path);
  let sourcePath = '';
  let sourceHash = '';
  for (const candidate of sourceCandidates) {
    const stats = await fileStats(candidate);
    if (!stats.exists || !stats.isFile) continue;
    const candidateHash = await sha256File(candidate);
    if (candidateHash === snapshot.sha256) {
      sourcePath = candidate;
      sourceHash = candidateHash;
      break;
    }
    if (!sourcePath) {
      sourcePath = candidate;
      sourceHash = candidateHash;
    }
  }
  if (!sourcePath) {
    return {
      ...snapshot,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      status: 'missing_source',
      message: 'source input file referenced by release evidence report was not found'
    };
  }
  if (sourceHash !== snapshot.sha256) {
    return {
      ...snapshot,
      source_path: sourcePath,
      source_candidates: sourceCandidates,
      destination_path: destinationPath,
      observed_sha256: sourceHash,
      status: 'source_hash_mismatch',
      message: 'source input file hash does not match the release evidence report'
    };
  }
  const destinationStats = await fileStats(destinationPath);
  if (destinationStats.exists && destinationStats.isFile) {
    const destinationHash = await sha256File(destinationPath);
    if (destinationHash === snapshot.sha256) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'already_present',
        message: ''
      };
    }
    if (!overwrite) {
      return {
        ...snapshot,
        source_path: sourcePath,
        destination_path: destinationPath,
        observed_sha256: destinationHash,
        status: 'destination_hash_mismatch',
        message: 'destination source snapshot exists with a different hash; rerun with overwrite if intentional'
      };
    }
  }
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
  return {
    ...snapshot,
    source_path: sourcePath,
    destination_path: destinationPath,
    observed_sha256: await sha256File(destinationPath),
    status: destinationStats.exists ? 'overwritten' : 'copied',
    message: ''
  };
}

export async function collectReleaseEvidenceSourceSnapshots(options = {}) {
  const cwd = options.cwd || process.cwd();
  const bundleDir = compactText(options.bundleDir || options.bundle_dir || options.bundleRoot || options.bundle_root);
  if (!bundleDir) throw new Error('bundleDir is required.');
  const absoluteBundleDir = path.resolve(cwd, bundleDir);
  const sourceRoot = path.resolve(cwd, compactText(options.sourceRoot || options.source_root) || cwd);
  const bundleManifestPath = path.resolve(
    cwd,
    compactText(options.bundleManifestPath || options.bundle_manifest_path)
      || path.join(absoluteBundleDir, 'release-evidence-bundle.json')
  );
  const manifestRead = await readBundleManifest(bundleManifestPath);
  if (!manifestRead.exists || manifestRead.error) {
    return {
      contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
      status: 'incomplete',
      bundleDir: absoluteBundleDir,
      sourceRoot,
      bundleManifestPath,
      error: manifestRead.error || 'bundle manifest missing',
      snapshots: []
    };
  }
  const manifest = asObject(manifestRead.manifest);
  const engineeringRead = await readSourceSnapshotEvidenceReport(
    absoluteBundleDir,
    manifest,
    'engineering_release_evidence'
  );
  const docsSyncRead = await readSourceSnapshotEvidenceReport(
    absoluteBundleDir,
    manifest,
    'docs_sync_release_evidence'
  );
  const requestedSnapshots = uniqueBy([
    ...engineeringRead.reports.flatMap((entry) => engineeringSnapshotRecords(entry.record, sourceRoot)),
    ...docsSyncRead.reports.flatMap((entry) => docsSyncSnapshotRecords(entry.record, sourceRoot))
  ], (entry) => `${entry.source_report_role}:${entry.bundle_role}:${entry.bundle_relative_path}:${entry.sha256}`);
  const snapshots = [];
  for (const snapshot of requestedSnapshots) {
    snapshots.push(await collectSourceSnapshot(snapshot, {
      sourceRoot,
      bundleRoot: absoluteBundleDir,
      overwrite: options.overwrite === true || options.overwriteSourceSnapshots === true
    }));
  }
  const successfulStatuses = new Set(['copied', 'already_present', 'overwritten']);
  const successfulSnapshots = snapshots.filter((entry) => successfulStatuses.has(entry.status));
  const manifestArtifacts = asArray(manifest.artifacts);
  const appendedArtifacts = [];
  for (const snapshot of successfulSnapshots) {
    const artifact = sourceSnapshotManifestEntry(snapshot);
    if (!manifestHasArtifact([...manifestArtifacts, ...appendedArtifacts], artifact)) {
      appendedArtifacts.push(artifact);
    }
  }
  if (appendedArtifacts.length > 0) {
    await writeJson(bundleManifestPath, {
      ...manifest,
      artifacts: [
        ...manifestArtifacts,
        ...appendedArtifacts
      ]
    });
  }
  const failures = snapshots.filter((entry) => !successfulStatuses.has(entry.status));
  const missingReports = [...engineeringRead.missing, ...docsSyncRead.missing];
  const status = snapshots.length > 0 && failures.length === 0 && missingReports.length === 0
    ? 'source_snapshots_collected'
    : 'incomplete';
  return {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    status,
    bundleDir: absoluteBundleDir,
    sourceRoot,
    bundleManifestPath,
    copied_count: snapshots.filter((entry) => entry.status === 'copied').length,
    already_present_count: snapshots.filter((entry) => entry.status === 'already_present').length,
    overwritten_count: snapshots.filter((entry) => entry.status === 'overwritten').length,
    failed_count: failures.length,
    missing_report_count: missingReports.length,
    appended_manifest_artifact_count: appendedArtifacts.length,
    missing_reports: missingReports,
    snapshots,
    appended_manifest_artifacts: appendedArtifacts
  };
}

export async function collectReleaseEvidenceLineageArtifacts(options = {}) {
  const cwd = options.cwd || process.cwd();
  const bundleDir = compactText(options.bundleDir || options.bundle_dir || options.bundleRoot || options.bundle_root);
  if (!bundleDir) throw new Error('bundleDir is required.');
  const absoluteBundleDir = path.resolve(cwd, bundleDir);
  const artifactRoot = path.resolve(cwd, compactText(options.artifactRoot || options.artifact_root) || cwd);
  const bundleManifestPath = path.resolve(
    cwd,
    compactText(options.bundleManifestPath || options.bundle_manifest_path)
      || path.join(absoluteBundleDir, 'release-evidence-bundle.json')
  );
  const manifestRead = await readBundleManifest(bundleManifestPath);
  if (!manifestRead.exists || manifestRead.error) {
    return {
      contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
      status: 'incomplete',
      bundleDir: absoluteBundleDir,
      artifactRoot,
      bundleManifestPath,
      error: manifestRead.error || 'bundle manifest missing',
      lineage_artifacts: []
    };
  }
  const manifest = asObject(manifestRead.manifest);
  const artifacts = await Promise.all(bundleManifestArtifacts(manifest).map((entry) => (
    normalizeArtifact(entry, absoluteBundleDir)
  )));
  const releaseGate = await readReleaseGateManifest(artifacts);
  const releaseGateInputRecords = releaseGate.error
    ? []
    : releaseGateEvidenceInputRecords(asObject(releaseGate.manifest));
  const reportRead = await readLineageReportCandidates(
    absoluteBundleDir,
    artifacts,
    releaseGateInputRecords
  );
  const requestedArtifacts = uniqueBy(reportRead.reports.flatMap((report) => (
    asArray(report.descriptor.records(report.record))
      .map((record) => lineageArtifactSnapshotFromRecord(record, report))
      .filter(Boolean)
  )), (entry) => `${entry.source_report_role}:${entry.bundle_role}:${entry.bundle_relative_path}:${entry.sha256}`);
  const lineageArtifacts = [];
  for (const snapshot of requestedArtifacts) {
    lineageArtifacts.push(await collectLineageArtifactSnapshot(snapshot, {
      artifactRoot,
      bundleRoot: absoluteBundleDir,
      overwrite: options.overwrite === true || options.overwriteLineageArtifacts === true
    }));
  }
  const successfulStatuses = new Set(['copied', 'already_present', 'overwritten']);
  const successfulArtifacts = lineageArtifacts.filter((entry) => successfulStatuses.has(entry.status));
  const manifestArtifacts = asArray(manifest.artifacts);
  const appendedArtifacts = [];
  for (const snapshot of successfulArtifacts) {
    const artifact = lineageArtifactManifestEntry(snapshot);
    if (!manifestHasArtifact([...manifestArtifacts, ...appendedArtifacts], artifact)) {
      appendedArtifacts.push(artifact);
    }
  }
  if (appendedArtifacts.length > 0) {
    await writeJson(bundleManifestPath, {
      ...manifest,
      artifacts: [
        ...manifestArtifacts,
        ...appendedArtifacts
      ]
    });
  }
  const failures = lineageArtifacts.filter((entry) => !successfulStatuses.has(entry.status));
  const status = lineageArtifacts.length > 0
    && failures.length === 0
    && reportRead.unreadableReports.length === 0
    ? 'lineage_artifacts_collected'
    : 'incomplete';
  return {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    status,
    bundleDir: absoluteBundleDir,
    artifactRoot,
    bundleManifestPath,
    copied_count: lineageArtifacts.filter((entry) => entry.status === 'copied').length,
    already_present_count: lineageArtifacts.filter((entry) => entry.status === 'already_present').length,
    overwritten_count: lineageArtifacts.filter((entry) => entry.status === 'overwritten').length,
    failed_count: failures.length,
    report_count: reportRead.reports.length,
    unreadable_report_count: reportRead.unreadableReports.length,
    appended_manifest_artifact_count: appendedArtifacts.length,
    unreadable_reports: reportRead.unreadableReports,
    lineage_artifacts: lineageArtifacts,
    appended_manifest_artifacts: appendedArtifacts
  };
}

export async function collectReleaseGateEvidenceInputs(options = {}) {
  const cwd = options.cwd || process.cwd();
  const bundleDir = compactText(options.bundleDir || options.bundle_dir || options.bundleRoot || options.bundle_root);
  if (!bundleDir) throw new Error('bundleDir is required.');
  const absoluteBundleDir = path.resolve(cwd, bundleDir);
  const evidenceRoot = path.resolve(cwd, compactText(options.evidenceRoot || options.evidence_root) || cwd);
  const bundleManifestPath = path.resolve(
    cwd,
    compactText(options.bundleManifestPath || options.bundle_manifest_path)
      || path.join(absoluteBundleDir, 'release-evidence-bundle.json')
  );
  const manifestRead = await readBundleManifest(bundleManifestPath);
  if (!manifestRead.exists || manifestRead.error) {
    return {
      contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
      status: 'incomplete',
      bundleDir: absoluteBundleDir,
      evidenceRoot,
      bundleManifestPath,
      error: manifestRead.error || 'bundle manifest missing',
      evidence_inputs: []
    };
  }
  const manifest = asObject(manifestRead.manifest);
  const overwrite = options.overwrite === true || options.overwriteReleaseGateInputs === true;
  const releaseGateManifestEntry = bundleManifestArtifactEntriesByRole(manifest, 'release_gate_manifest')[0];
  const requestedReleaseGatePath = compactText(
    options.releaseGateManifestPath
      || options.release_gate_manifest_path
      || artifactPath(releaseGateManifestEntry)
  );
  const releaseGateManifestPath = requestedReleaseGatePath
    ? resolveBundlePath(absoluteBundleDir, requestedReleaseGatePath)
    : path.join(absoluteBundleDir, 'release-gate-manifest.json');
  const releaseGateFile = await collectReleaseGateManifestFile({
    bundleRoot: absoluteBundleDir,
    releaseGateManifestPath,
    overwrite
  });
  let releaseGateManifest = {};
  let releaseGateReadError = '';
  if (['copied', 'already_present', 'overwritten'].includes(releaseGateFile.status)) {
    try {
      releaseGateManifest = await readJson(releaseGateFile.destination_path, {});
    } catch (error) {
      releaseGateReadError = error.message || String(error);
    }
  }
  const releaseGateSourcePath = releaseGateFile.source_path || releaseGateManifestPath;
  const requestedInputs = asArray(releaseGateManifest.evidence_inputs)
    .map((entry) => releaseGateInputSnapshotFromRecord(entry, releaseGateSourcePath));
  const evidenceInputs = [];
  for (const snapshot of requestedInputs) {
    evidenceInputs.push(await collectReleaseGateInputSnapshot(snapshot, {
      evidenceRoot,
      bundleRoot: absoluteBundleDir,
      releaseGatePath: releaseGateSourcePath,
      overwrite
    }));
  }
  const successfulStatuses = new Set(['copied', 'already_present', 'overwritten']);
  const successfulInputs = evidenceInputs.filter((entry) => successfulStatuses.has(entry.status));
  const successfulReleaseGateManifest = successfulStatuses.has(releaseGateFile.status);
  const manifestArtifacts = asArray(manifest.artifacts);
  const appendedArtifacts = [];
  if (successfulReleaseGateManifest) {
    const releaseGateArtifact = {
      role: 'release_gate_manifest',
      path: 'release-gate-manifest.json',
      sha256: releaseGateFile.sha256
    };
    if (!manifestHasArtifact([...manifestArtifacts, ...appendedArtifacts], releaseGateArtifact)) {
      appendedArtifacts.push(releaseGateArtifact);
    }
  }
  for (const snapshot of successfulInputs) {
    const artifact = releaseGateInputManifestEntry(snapshot);
    if (!manifestHasArtifact([...manifestArtifacts, ...appendedArtifacts], artifact)) {
      appendedArtifacts.push(artifact);
    }
  }
  if (appendedArtifacts.length > 0) {
    await writeJson(bundleManifestPath, {
      ...manifest,
      artifacts: [
        ...manifestArtifacts,
        ...appendedArtifacts
      ]
    });
  }
  const failures = [
    ...(!successfulReleaseGateManifest ? [releaseGateFile] : []),
    ...evidenceInputs.filter((entry) => !successfulStatuses.has(entry.status))
  ];
  const status = successfulReleaseGateManifest
    && !releaseGateReadError
    && evidenceInputs.length > 0
    && failures.length === 0
    ? 'release_gate_inputs_collected'
    : 'incomplete';
  return {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    status,
    bundleDir: absoluteBundleDir,
    evidenceRoot,
    bundleManifestPath,
    releaseGateManifestPath: releaseGateFile.destination_path || releaseGateManifestPath,
    copied_count: [
      releaseGateFile,
      ...evidenceInputs
    ].filter((entry) => entry.status === 'copied').length,
    already_present_count: [
      releaseGateFile,
      ...evidenceInputs
    ].filter((entry) => entry.status === 'already_present').length,
    overwritten_count: [
      releaseGateFile,
      ...evidenceInputs
    ].filter((entry) => entry.status === 'overwritten').length,
    failed_count: failures.length,
    evidence_input_count: evidenceInputs.length,
    release_gate_read_error: releaseGateReadError || null,
    appended_manifest_artifact_count: appendedArtifacts.length,
    release_gate_manifest: releaseGateFile,
    evidence_inputs: evidenceInputs,
    appended_manifest_artifacts: appendedArtifacts
  };
}

export async function createReleaseEvidenceBundleSkeleton(options = {}) {
  const cwd = options.cwd || process.cwd();
  const bundleDir = compactText(options.bundleDir || options.bundle_dir || options.bundleRoot || options.bundle_root);
  if (!bundleDir) throw new Error('bundleDir is required.');
  const absoluteBundleDir = path.resolve(cwd, bundleDir);
  const releaseScope = normalizeReleaseScope(options.releaseScope || options.release_scope || options.scope || 'p0-p1');
  const releaseScopeText = releaseScopeLabel(releaseScope);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `${releaseScopeText}-release-evidence-${stableHash(`${generatedAt}:${absoluteBundleDir}`, 10)}`;
  const artifacts = releaseEvidenceBundleSkeletonArtifacts(releaseScope);
  const directories = [...new Set([
    '',
    ...artifacts.map((entry) => path.dirname(artifactPath(entry))).filter((entry) => entry && entry !== '.')
  ])];
  for (const directory of directories) {
    await ensureDir(path.join(absoluteBundleDir, directory));
  }
  const manifestPath = path.join(absoluteBundleDir, 'release-evidence-bundle.json');
  const todoPath = path.join(absoluteBundleDir, 'RELEASE-EVIDENCE-TODO.md');
  const manifest = {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
    runId,
    generatedAt,
    releaseScope: releaseScopeText,
    status: 'skeleton',
    artifacts
  };
  const skeleton = {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    runId,
    generatedAt,
    status: 'skeleton_created',
    bundleDir: absoluteBundleDir,
    releaseScope: releaseScopeText,
    requiredDatasetFamilies: REQUIRED_RELEASE_DATASET_FAMILIES.map((family) => ({
      id: family.id,
      label: family.label
    })),
    requiredReleaseGateEvidenceInputRoles: releaseGateEvidenceInputRolesForScope(releaseScope),
    requiredAblations: requiredAblationsForReleaseScope(releaseScope),
    artifacts,
    outputArtifacts: {
      manifestPath,
      todoPath
    }
  };
  await writeJson(manifestPath, manifest);
  await writeText(todoPath, renderReleaseEvidenceBundleSkeletonTodo(skeleton));
  return skeleton;
}

export async function prepareReleaseEvidenceBundleAudit(options = {}) {
  const cwd = options.cwd || process.cwd();
  const bundleDir = compactText(options.bundleDir || options.bundle_dir || options.bundleRoot || options.bundle_root);
  if (!bundleDir) throw new Error('bundleDir is required.');
  const absoluteBundleDir = path.resolve(cwd, bundleDir);
  const outputDir = path.resolve(cwd, compactText(options.outputDir || options.output_dir || options.output) || absoluteBundleDir);
  const bundleManifestPath = path.resolve(
    cwd,
    compactText(options.bundleManifestPath || options.bundle_manifest_path)
      || path.join(absoluteBundleDir, 'release-evidence-bundle.json')
  );
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `release-evidence-bundle-${stableHash(`${generatedAt}:${absoluteBundleDir}`, 10)}`;

  const manifestRead = await readBundleManifest(bundleManifestPath);
  const bundleManifest = asObject(manifestRead.manifest);
  const expectedReleaseScope = normalizeReleaseScope(
    options.releaseScope
      || options.release_scope
      || bundleManifest.releaseScope
      || bundleManifest.release_scope
      || bundleManifest.scope
  );
  const manifestArtifact = await normalizeArtifact({
    role: 'bundle_manifest',
    path: bundleManifestPath,
    allow_empty: false
  }, absoluteBundleDir);
  const artifacts = [
    manifestArtifact,
    ...await Promise.all(bundleManifestArtifacts(bundleManifest).map((entry) => normalizeArtifact(entry, absoluteBundleDir)))
  ];
  const roles = new Set(artifacts.map((entry) => entry.role).filter(Boolean));
  const missingRoles = REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES.filter((role) => !roles.has(role));
  const missingFiles = artifacts.filter((entry) => !entry.exists || !entry.is_file);
  const emptyArtifacts = artifacts.filter((entry) => !entry.non_empty);
  const hashMismatches = artifacts.filter((entry) => entry.exists && entry.is_file && !entry.hash_matches);
  const outOfBundleArtifacts = artifacts.filter((entry) => !entry.inside_bundle);
  const releaseGate = await readReleaseGateManifest(artifacts);
  const releaseGateManifest = asObject(releaseGate.manifest);
  const releaseGateScope = normalizeReleaseScope(
    releaseGateManifest.releaseScope
      || releaseGateManifest.release_scope
      || releaseGateManifest.scope
  );
  const releaseGateInputRecords = releaseGateEvidenceInputRecords(releaseGateManifest);
  const releaseGateInputRoles = [...new Set(releaseGateInputRecords.map((entry) => entry.role).filter(Boolean))].sort();
  const requiredReleaseGateEvidenceInputRoles = releaseGateEvidenceInputRolesForScope(expectedReleaseScope);
  const missingReleaseGateEvidenceInputRoles = requiredReleaseGateEvidenceInputRoles
    .filter((role) => !releaseGateInputRoles.includes(role));
  const releaseGateInputs = releaseGateEvidenceInputHashes(releaseGateManifest);
  const artifactHashes = new Set(artifacts.map((entry) => entry.sha256).filter(Boolean));
  const missingEvidenceInputHashes = releaseGateInputs.filter((sha256) => !artifactHashes.has(sha256));
  const unhashedReleaseGateInputs = asArray(releaseGateManifest.evidence_inputs)
    .filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum));
  const docsSyncArtifactHashes = artifacts
    .filter((entry) => entry.role === 'docs_sync_release_evidence' && entry.sha256)
    .map((entry) => entry.sha256);
  const docsSyncReleaseGateInputHashes = releaseGateInputRecords
    .filter((entry) => entry.role === 'docs_sync_release_evidence')
    .map((entry) => entry.sha256)
    .filter(Boolean);
  const matchedDocsSyncReleaseGateHashes = docsSyncReleaseGateInputHashes
    .filter((sha256) => docsSyncArtifactHashes.includes(sha256));
  const datasetMetadata = await auditDatasetMetadata(artifacts);
  const releaseGateRawInputLineage = await auditReleaseGateRawInputLineage(artifacts, releaseGateInputs, datasetMetadata);
  const replayStatisticalSignificanceLineage = await auditReplayStatisticalSignificanceLineage(artifacts, releaseGateInputs);
  const engineeringReleaseEvidenceLineage = await auditEngineeringReleaseEvidenceLineage(artifacts, releaseGateInputRecords);
  const docsSyncReleaseEvidenceLineage = await auditDocsSyncReleaseEvidenceLineage(artifacts, releaseGateInputRecords);
  const humanBlindLineage = await auditHumanBlindAggregationLineage(artifacts, releaseGateInputRecords);
  const ingestionGraphMutationLineage = await auditIngestionGraphMutationLineage(artifacts, releaseGateInputRecords);
  const ablationManifestLineage = await auditAblationManifestLineage(artifacts, releaseGateInputs);
  const datasetMetadataChecks = REQUIRED_RELEASE_DATASET_METADATA_FIELDS.map((field) => {
    const result = datasetMetadata.fields[field] || {};
    const message = field === 'raw_input_sha256'
      ? 'dataset metadata must include raw_input_sha256 matching a bundled raw_input artifact'
      : `dataset metadata must include ${field}`;
    return check(
      `dataset_metadata_${field}_present`,
      result.present,
      message,
      {
        values: result.values || [],
        sources: result.sources || [],
        matched_raw_input_hashes: result.matched_raw_input_hashes || []
      }
    );
  });
  const datasetFamilyMetadataChecks = asArray(datasetMetadata.families).map((family) => check(
    `dataset_family_metadata_${family.id}_complete`,
    family.complete,
    family.present
      ? `${family.label} dataset metadata is missing required fields`
      : `${family.label} dataset family metadata is missing from the release bundle`,
    {
      family_id: family.id,
      family_label: family.label,
      artifact_count: family.artifact_count,
      raw_input_hashes: family.raw_input_hashes,
      missing_fields: family.missing_fields
    }
  ));
  const datasetFamilyLineageChecks = asArray(releaseGateRawInputLineage.families).map((family) => check(
    `dataset_family_raw_input_lineage_${family.id}_covered`,
    family.complete,
    family.raw_input_hashes.length > 0
      ? `${family.label} raw_input_sha256 must appear in a release-gate consumed evidence_report`
      : `${family.label} raw_input_sha256 must match a bundled raw_input before lineage can be verified`,
    {
      family_id: family.id,
      family_label: family.label,
      raw_input_hashes: family.raw_input_hashes,
      covered_raw_input_hashes: family.covered_raw_input_hashes,
      missing_release_gate_lineage_hashes: family.missing_release_gate_lineage_hashes
    }
  ));

  const checks = [
    check(
      'bundle_manifest_present',
      manifestRead.exists && !manifestRead.error,
      manifestRead.error || 'release evidence bundle manifest is required',
      { bundle_manifest_path: bundleManifestPath }
    ),
    check(
      'bundle_manifest_contract_version',
      bundleManifest.contractVersion === RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
      `bundle manifest contractVersion must be ${RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION}`,
      { contract_version: bundleManifest.contractVersion || null }
    ),
    check(
      'required_artifact_roles_present',
      missingRoles.length === 0,
      'release evidence bundle is missing required artifact roles',
      { missing_roles: missingRoles }
    ),
    check(
      'artifact_files_exist',
      missingFiles.length === 0,
      'all bundle artifacts must resolve to files',
      { missing_files: missingFiles.map((entry) => ({ role: entry.role, path: entry.path })) }
    ),
    check(
      'artifact_paths_inside_bundle',
      outOfBundleArtifacts.length === 0,
      'all bundle artifact paths must resolve inside the bundle root',
      {
        bundle_root: absoluteBundleDir,
        out_of_bundle_artifacts: outOfBundleArtifacts.map((entry) => ({
          role: entry.role,
          path: entry.path,
          relative_path: entry.relative_path
        }))
      },
      'failed'
    ),
    check(
      'non_log_artifacts_non_empty',
      emptyArtifacts.length === 0,
      'non-log bundle artifacts must be non-empty',
      { empty_artifacts: emptyArtifacts.map((entry) => ({ role: entry.role, path: entry.path })) }
    ),
    check(
      'artifact_hashes_match',
      hashMismatches.length === 0,
      'declared artifact hashes must match file content',
      { hash_mismatches: hashMismatches.map((entry) => ({ role: entry.role, path: entry.path })) },
      'failed'
    ),
    check(
      'release_gate_manifest_readable',
      !releaseGate.error && Boolean(releaseGate.artifact),
      releaseGate.error || 'release gate manifest must be bundled',
      { release_gate_manifest_path: releaseGate.artifact?.path || null }
    ),
    check(
      'release_gate_manifest_contract_version',
      releaseGateManifest.contractVersion === IDEA_CATALYST_RELEASE_GATE_VERSION,
      `release gate manifest contractVersion must be ${IDEA_CATALYST_RELEASE_GATE_VERSION}`,
      { contract_version: releaseGateManifest.contractVersion || null }
    ),
    check(
      'release_gate_manifest_passed',
      releaseGateManifest.status === 'passed',
      'release gate manifest must be passed before the evidence bundle is release-ready',
      { release_gate_status: releaseGateManifest.status || null },
      releaseGateManifest.status === 'failed' ? 'failed' : 'incomplete'
    ),
    check(
      'release_scope_matches_release_gate',
      expectedReleaseScope === releaseGateScope,
      'release evidence bundle scope must match the bundled release gate manifest scope',
      {
        expected_release_scope: expectedReleaseScope,
        release_gate_scope: releaseGateScope
      }
    ),
    check(
      'release_gate_evidence_inputs_hashed',
      asArray(releaseGateManifest.evidence_inputs).length > 0 && unhashedReleaseGateInputs.length === 0,
      'release gate manifest must record hashed evidence_inputs',
      {
        evidence_input_count: asArray(releaseGateManifest.evidence_inputs).length,
        unhashed_evidence_input_count: unhashedReleaseGateInputs.length
      }
    ),
    check(
      'release_gate_required_evidence_input_roles_present',
      missingReleaseGateEvidenceInputRoles.length === 0,
      'release gate manifest must record every evidence input role required by the release scope',
      {
        release_scope: expectedReleaseScope,
        required_evidence_input_roles: requiredReleaseGateEvidenceInputRoles,
        observed_evidence_input_roles: releaseGateInputRoles,
        missing_evidence_input_roles: missingReleaseGateEvidenceInputRoles
      }
    ),
    check(
      'release_gate_evidence_inputs_bundled',
      releaseGateInputs.length > 0 && missingEvidenceInputHashes.length === 0,
      'bundle must include every file consumed by the release gate evidence_inputs hash chain',
      { missing_evidence_input_hashes: missingEvidenceInputHashes }
    ),
    check(
      'docs_sync_release_evidence_bundled_and_consumed',
      docsSyncArtifactHashes.length > 0
        && docsSyncReleaseGateInputHashes.length > 0
        && matchedDocsSyncReleaseGateHashes.length > 0,
      'bundle must include docs_sync_release_evidence consumed by release gate evidence_inputs',
      {
        bundled_docs_sync_hashes: docsSyncArtifactHashes,
        release_gate_docs_sync_input_hashes: docsSyncReleaseGateInputHashes,
        matched_docs_sync_hashes: matchedDocsSyncReleaseGateHashes
      }
    ),
    check(
      'release_gate_engineering_release_evidence_inputs_bundled',
      engineeringReleaseEvidenceLineage.status === 'passed',
      'release engineering evidence required test input hashes must be bundled',
      {
        consumed_engineering_release_evidence_count: engineeringReleaseEvidenceLineage.consumed_engineering_release_evidence_count,
        missing_bundled_input_hashes: engineeringReleaseEvidenceLineage.missing_bundled_input_hashes,
        missing_required_test_input_paths: engineeringReleaseEvidenceLineage.missing_required_test_input_paths,
        incomplete_engineering_release_evidence_hashes: engineeringReleaseEvidenceLineage.incomplete_engineering_release_evidence_hashes,
        unreadable_engineering_release_evidence_reports: engineeringReleaseEvidenceLineage.unreadable_engineering_release_evidence_reports
      }
    ),
    check(
      'release_gate_docs_sync_release_evidence_inputs_bundled',
      docsSyncReleaseEvidenceLineage.status === 'passed',
      'release docs-sync evidence required input and precheck hashes must be bundled',
      {
        consumed_docs_sync_release_evidence_count: docsSyncReleaseEvidenceLineage.consumed_docs_sync_release_evidence_count,
        missing_bundled_input_hashes: docsSyncReleaseEvidenceLineage.missing_bundled_input_hashes,
        missing_required_input_paths: docsSyncReleaseEvidenceLineage.missing_required_input_paths,
        missing_precheck_input_paths: docsSyncReleaseEvidenceLineage.missing_precheck_input_paths,
        incomplete_docs_sync_release_evidence_hashes: docsSyncReleaseEvidenceLineage.incomplete_docs_sync_release_evidence_hashes,
        unreadable_docs_sync_release_evidence_reports: docsSyncReleaseEvidenceLineage.unreadable_docs_sync_release_evidence_reports
      }
    ),
    ...datasetMetadataChecks,
    ...datasetFamilyMetadataChecks,
    check(
      'release_gate_replay_statistical_significance_inputs_bundled',
      replayStatisticalSignificanceLineage.status === 'passed',
      'release replay-suite statistical significance input hashes must be bundled',
      {
        consumed_replay_suite_count: replayStatisticalSignificanceLineage.consumed_replay_suite_count,
        missing_bundled_input_hashes: replayStatisticalSignificanceLineage.missing_bundled_input_hashes,
        incomplete_replay_suite_hashes: replayStatisticalSignificanceLineage.incomplete_replay_suite_hashes,
        unreadable_replay_suites: replayStatisticalSignificanceLineage.unreadable_replay_suites
      }
    ),
    check(
      'release_gate_human_blind_inputs_bundled',
      humanBlindLineage.status === 'passed',
      'release human blind aggregation input and blind-review artifact hashes must be bundled',
      {
        consumed_human_blind_aggregation_count: humanBlindLineage.consumed_human_blind_aggregation_count,
        missing_bundled_input_hashes: humanBlindLineage.missing_bundled_input_hashes,
        missing_input_hash_roles: humanBlindLineage.missing_input_hash_roles,
        missing_blind_artifact_hash_roles: humanBlindLineage.missing_blind_artifact_hash_roles,
        incomplete_human_blind_aggregation_hashes: humanBlindLineage.incomplete_human_blind_aggregation_hashes,
        unreadable_human_blind_aggregations: humanBlindLineage.unreadable_human_blind_aggregations
      }
    ),
    check(
      'release_gate_ingestion_graph_mutation_inputs_bundled',
      ingestionGraphMutationLineage.status === 'passed',
      'release ingestion graph mutation execution input, rollback, and snapshot hashes must be bundled',
      {
        consumed_ingestion_graph_mutation_execution_count: ingestionGraphMutationLineage.consumed_ingestion_graph_mutation_execution_count,
        missing_bundled_input_hashes: ingestionGraphMutationLineage.missing_bundled_input_hashes,
        missing_input_hash_roles: ingestionGraphMutationLineage.missing_input_hash_roles,
        missing_artifact_hash_roles: ingestionGraphMutationLineage.missing_artifact_hash_roles,
        incomplete_ingestion_graph_mutation_execution_hashes: ingestionGraphMutationLineage.incomplete_ingestion_graph_mutation_execution_hashes,
        unreadable_ingestion_graph_mutation_executions: ingestionGraphMutationLineage.unreadable_ingestion_graph_mutation_executions
      }
    ),
    check(
      'release_gate_ablation_manifest_inputs_bundled',
      ablationManifestLineage.status === 'passed',
      'release ablation manifest input and variant report hashes must be bundled',
      {
        consumed_ablation_manifest_count: ablationManifestLineage.consumed_ablation_manifest_count,
        missing_bundled_input_hashes: ablationManifestLineage.missing_bundled_input_hashes,
        incomplete_ablation_manifest_hashes: ablationManifestLineage.incomplete_ablation_manifest_hashes,
        unreadable_ablation_manifests: ablationManifestLineage.unreadable_ablation_manifests
      }
    ),
    check(
      'release_gate_consumed_evidence_reports_readable_for_raw_input_lineage',
      releaseGateRawInputLineage.consumed_evidence_report_count > 0
        && releaseGateRawInputLineage.unreadable_evidence_reports.length === 0,
      'release-gate consumed evidence_report artifacts must be readable JSON for raw-input lineage audit',
      {
        consumed_evidence_report_count: releaseGateRawInputLineage.consumed_evidence_report_count,
        unreadable_evidence_reports: releaseGateRawInputLineage.unreadable_evidence_reports
      }
    ),
    ...datasetFamilyLineageChecks
  ];
  const status = statusFromChecks(checks);
  const reportPath = path.join(outputDir, 'release-evidence-bundle-audit.json');
  const reportMarkdownPath = path.join(outputDir, 'release-evidence-bundle-audit.md');
  const manifestPath = path.join(outputDir, 'release-evidence-bundle-audit-manifest.json');
  const report = {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    runId,
    generatedAt,
    status,
    bundle: {
      root: absoluteBundleDir,
      manifest_path: bundleManifestPath,
      manifest_contract_version: bundleManifest.contractVersion || null,
      manifest_run_id: compactText(bundleManifest.runId || bundleManifest.run_id) || null,
      release_scope: expectedReleaseScope
    },
    diagnostics: {
      artifact_count: artifacts.length,
      required_role_count: REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES.length,
      missing_roles: missingRoles,
      missing_file_count: missingFiles.length,
      out_of_bundle_artifact_count: outOfBundleArtifacts.length,
      hash_mismatch_count: hashMismatches.length,
      release_gate_evidence_input_count: releaseGateInputs.length,
      release_gate_evidence_input_roles: releaseGateInputRoles,
      required_release_gate_evidence_input_roles: requiredReleaseGateEvidenceInputRoles,
      missing_release_gate_evidence_input_roles: missingReleaseGateEvidenceInputRoles,
      missing_evidence_input_hashes: missingEvidenceInputHashes,
      docs_sync_release_evidence_hashes: docsSyncArtifactHashes,
      release_gate_docs_sync_input_hashes: docsSyncReleaseGateInputHashes,
      dataset_metadata_readable_artifact_count: datasetMetadata.readable_artifact_count,
      dataset_metadata_missing_fields: datasetMetadata.missing_fields,
      dataset_metadata_missing_families: asArray(datasetMetadata.families).filter((entry) => !entry.present).map((entry) => entry.id),
      dataset_metadata_incomplete_families: asArray(datasetMetadata.families).filter((entry) => entry.present && !entry.complete).map((entry) => entry.id),
      release_gate_consumed_engineering_release_evidence_count: engineeringReleaseEvidenceLineage.consumed_engineering_release_evidence_count,
      engineering_release_evidence_missing_bundled_hashes: engineeringReleaseEvidenceLineage.missing_bundled_input_hashes,
      engineering_release_evidence_missing_required_test_input_paths: engineeringReleaseEvidenceLineage.missing_required_test_input_paths,
      release_gate_consumed_docs_sync_release_evidence_count: docsSyncReleaseEvidenceLineage.consumed_docs_sync_release_evidence_count,
      docs_sync_release_evidence_missing_bundled_hashes: docsSyncReleaseEvidenceLineage.missing_bundled_input_hashes,
      docs_sync_release_evidence_missing_required_input_paths: docsSyncReleaseEvidenceLineage.missing_required_input_paths,
      docs_sync_release_evidence_missing_precheck_input_paths: docsSyncReleaseEvidenceLineage.missing_precheck_input_paths,
      release_gate_consumed_replay_suite_count: replayStatisticalSignificanceLineage.consumed_replay_suite_count,
      replay_statistical_significance_missing_bundled_hashes: replayStatisticalSignificanceLineage.missing_bundled_input_hashes,
      release_gate_consumed_human_blind_aggregation_count: humanBlindLineage.consumed_human_blind_aggregation_count,
      human_blind_missing_bundled_hashes: humanBlindLineage.missing_bundled_input_hashes,
      human_blind_missing_input_hash_roles: humanBlindLineage.missing_input_hash_roles,
      human_blind_missing_blind_artifact_hash_roles: humanBlindLineage.missing_blind_artifact_hash_roles,
      release_gate_consumed_ingestion_graph_mutation_execution_count: ingestionGraphMutationLineage.consumed_ingestion_graph_mutation_execution_count,
      ingestion_graph_mutation_missing_bundled_hashes: ingestionGraphMutationLineage.missing_bundled_input_hashes,
      ingestion_graph_mutation_missing_input_hash_roles: ingestionGraphMutationLineage.missing_input_hash_roles,
      ingestion_graph_mutation_missing_artifact_hash_roles: ingestionGraphMutationLineage.missing_artifact_hash_roles,
      release_gate_consumed_ablation_manifest_count: ablationManifestLineage.consumed_ablation_manifest_count,
      ablation_manifest_missing_bundled_hashes: ablationManifestLineage.missing_bundled_input_hashes,
      release_gate_consumed_evidence_report_count: releaseGateRawInputLineage.consumed_evidence_report_count,
      raw_input_lineage_missing_families: releaseGateRawInputLineage.missing_family_lineage
    },
    release_gate: {
      path: releaseGate.artifact?.path || null,
      status: releaseGateManifest.status || null,
      contractVersion: releaseGateManifest.contractVersion || null,
      release_scope: releaseGateScope,
      evidence_input_count: asArray(releaseGateManifest.evidence_inputs).length,
      evidence_input_roles: releaseGateInputRoles,
      required_evidence_input_roles: requiredReleaseGateEvidenceInputRoles,
      missing_evidence_input_roles: missingReleaseGateEvidenceInputRoles,
      missing_evidence_input_hashes: missingEvidenceInputHashes
    },
    dataset_metadata: datasetMetadata,
    raw_input_lineage: releaseGateRawInputLineage,
    replay_statistical_significance_lineage: replayStatisticalSignificanceLineage,
    engineering_release_evidence_lineage: engineeringReleaseEvidenceLineage,
    docs_sync_release_evidence_lineage: docsSyncReleaseEvidenceLineage,
    human_blind_lineage: humanBlindLineage,
    ingestion_graph_mutation_lineage: ingestionGraphMutationLineage,
    ablation_manifest_lineage: ablationManifestLineage,
    checks,
    artifacts,
    output_artifacts: {
      outputDir,
      reportPath,
      reportMarkdownPath,
      manifestPath
    }
  };

  await ensureDir(outputDir);
  await writeJson(reportPath, report);
  await writeText(reportMarkdownPath, renderReleaseEvidenceBundleMarkdown(report));
  await writeJson(manifestPath, {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_VERSION,
    runId,
    generatedAt,
    status,
    bundle: report.bundle,
    diagnostics: report.diagnostics,
    release_gate: report.release_gate,
    output_artifacts: report.output_artifacts
  });
  return report;
}

export function renderReleaseEvidenceBundleMarkdown(report = {}) {
  const lines = [
    `# Release Evidence Bundle Audit: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    `Bundle root: ${report.bundle?.root || ''}`,
    '',
    '## Checks',
    '',
    '| Check | Status | Message |',
    '|---|---:|---|'
  ];
  for (const entry of asArray(report.checks)) {
    lines.push(`| ${entry.name} | ${entry.status} | ${entry.message || ''} |`);
  }
  lines.push('', '## Required Roles', '');
  for (const role of REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES) {
    const count = asArray(report.artifacts).filter((entry) => entry.role === role).length;
    lines.push(`- ${role}: ${count}`);
  }
  lines.push('', '## Release Gate Evidence Inputs', '');
  const releaseGate = asObject(report.release_gate);
  for (const role of asArray(releaseGate.required_evidence_input_roles)) {
    const present = asArray(releaseGate.evidence_input_roles).includes(role);
    lines.push(`- ${role}: ${present ? 'present' : 'missing'}`);
  }
  lines.push('', '## Dataset Metadata', '');
  const metadata = asObject(report.dataset_metadata);
  const fields = asObject(metadata.fields);
  for (const field of REQUIRED_RELEASE_DATASET_METADATA_FIELDS) {
    const entry = asObject(fields[field]);
    lines.push(`- ${field}: ${entry.present ? 'present' : 'missing'}`);
  }
  lines.push('', '## Dataset Family Metadata', '');
  for (const family of asArray(metadata.families)) {
    lines.push(`- ${family.label || family.id}: ${family.complete ? 'complete' : 'incomplete'}`);
  }
  lines.push('', '## Raw Input Lineage', '');
  const lineage = asObject(report.raw_input_lineage);
  lines.push(`- release-gate consumed evidence reports: ${lineage.consumed_evidence_report_count || 0}`);
  for (const family of asArray(lineage.families)) {
    lines.push(`- ${family.label || family.id}: ${family.complete ? 'covered' : 'missing lineage'}`);
  }
  lines.push('', '## Statistical Significance Lineage', '');
  const statisticalLineage = asObject(report.replay_statistical_significance_lineage);
  lines.push(`- replay-suite reports: ${statisticalLineage.consumed_replay_suite_count || 0}`);
  for (const replay of asArray(statisticalLineage.replay_suites)) {
    lines.push(`- ${replay.path || replay.sha256}: ${replay.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Engineering Release Evidence Lineage', '');
  const engineeringLineage = asObject(report.engineering_release_evidence_lineage);
  lines.push(`- engineering release evidence reports: ${engineeringLineage.consumed_engineering_release_evidence_count || 0}`);
  for (const engineeringReport of asArray(engineeringLineage.engineering_release_evidence_reports)) {
    lines.push(`- ${engineeringReport.path || engineeringReport.sha256}: ${engineeringReport.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Docs Sync Release Evidence Lineage', '');
  const docsSyncLineage = asObject(report.docs_sync_release_evidence_lineage);
  lines.push(`- docs sync release evidence reports: ${docsSyncLineage.consumed_docs_sync_release_evidence_count || 0}`);
  for (const docsSyncReport of asArray(docsSyncLineage.docs_sync_release_evidence_reports)) {
    lines.push(`- ${docsSyncReport.path || docsSyncReport.sha256}: ${docsSyncReport.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Human Blind Lineage', '');
  const humanBlindLineage = asObject(report.human_blind_lineage);
  lines.push(`- human blind aggregations: ${humanBlindLineage.consumed_human_blind_aggregation_count || 0}`);
  for (const aggregation of asArray(humanBlindLineage.human_blind_aggregations)) {
    lines.push(`- ${aggregation.path || aggregation.sha256}: ${aggregation.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Ingestion Graph Mutation Lineage', '');
  const ingestionLineage = asObject(report.ingestion_graph_mutation_lineage);
  lines.push(`- ingestion graph mutation executions: ${ingestionLineage.consumed_ingestion_graph_mutation_execution_count || 0}`);
  for (const execution of asArray(ingestionLineage.ingestion_graph_mutation_executions)) {
    lines.push(`- ${execution.path || execution.sha256}: ${execution.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Ablation Manifest Lineage', '');
  const ablationLineage = asObject(report.ablation_manifest_lineage);
  lines.push(`- ablation manifests: ${ablationLineage.consumed_ablation_manifest_count || 0}`);
  for (const ablation of asArray(ablationLineage.ablation_manifests)) {
    lines.push(`- ${ablation.path || ablation.sha256}: ${ablation.status === 'passed' ? 'covered' : 'missing bundled input'}`);
  }
  lines.push('', '## Artifacts', '');
  for (const artifact of asArray(report.artifacts)) {
    lines.push(`- ${artifact.role || 'artifact'}: ${artifact.path || 'missing'} (${artifact.sha256 || 'missing-sha256'})`);
  }
  return `${lines.join('\n')}\n`;
}
