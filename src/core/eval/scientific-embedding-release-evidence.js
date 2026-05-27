import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import {
  DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD,
  SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION
} from '../index/scientific-embeddings.js';

export const SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION = 'papernexus-scientific-embedding-release-evidence-v1';

export const SCIENTIFIC_EMBEDDING_REQUIRED_FAMILIES = [
  { id: 'specter2_or_scientific_encoder', patterns: [/specter\s*2/, /specter2/, /scientific[-_ ]?encoder/, /scientific[-_ ]?embedding/] },
  { id: 'scirepeval', patterns: [/scirepeval/] },
  { id: 'oag', patterns: [/\boag\b/, /oag[-_ ]?bench/] },
  { id: 'graphrag', patterns: [/graphrag/] }
];

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test|test[-_\s]?only)\b/i;
const REQUIRED_RETRIEVAL_MODES = ['lexical', 'dense', 'hybrid'];
const PRIMARY_RETRIEVAL_METRICS = ['ndcg@10', 'recall@10', 'hit@10', 'mrr@10', 'recall@100', 'hit@100'];
const REQUIRED_MANIFEST_INPUT_ROLES = [
  {
    id: 'scientific_embedding_benchmark',
    aliases: ['scientific_embedding_benchmark', 'scientific_embedding_dataset', 'fixed_corpus_benchmark']
  },
  {
    id: 'scientific_embedding_source',
    aliases: ['scientific_embedding_source', 'scientific_embedding_vectors', 'external_embedding_vectors', 'specter2_vectors', 'scientific_encoder_vectors']
  }
];
const REQUIRED_RETRIEVAL_INPUT_ROLES = [
  {
    id: 'fixed_corpus_dataset',
    aliases: ['fixed_corpus_dataset', 'retrieval_dataset', 'benchmark_dataset']
  },
  {
    id: 'fixed_corpus_lexical_scores',
    aliases: ['fixed_corpus_lexical_scores', 'lexical_scores', 'lexical_baseline_scores', 'bm25_scores']
  },
  {
    id: 'fixed_corpus_dense_scores',
    aliases: ['fixed_corpus_dense_scores', 'dense_scores', 'embedding_scores', 'scientific_embedding_scores']
  },
  {
    id: 'fixed_corpus_hybrid_scores',
    aliases: ['fixed_corpus_hybrid_scores', 'hybrid_scores', 'lexical_dense_hybrid_scores', 'rerank_scores']
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

function hasInputHash(inputs = []) {
  return asArray(inputs).some((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
}

function missingInputHashes(inputs = []) {
  return asArray(inputs)
    .filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => compactText(entry.path || entry.file || entry.role) || 'unknown_input');
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

function sourceText(manifest = {}, retrievalSuite = {}) {
  return [
    manifest.runId,
    manifest.method,
    manifest.model,
    manifest.datasetSource,
    manifest.licenseScope,
    manifest.releaseGateStatus,
    retrievalSuite.runId,
    retrievalSuite.datasetPath,
    retrievalSuite.benchmark?.name,
    retrievalSuite.benchmark?.format,
    ...asArray(manifest.inputs).flatMap((entry) => [entry.role, entry.path, entry.source]),
    ...asArray(retrievalSuite.inputs).flatMap((entry) => [entry.role, entry.path, entry.source])
  ].map(compactText).join(' ').toLowerCase();
}

function missingFamilies(manifest = {}, retrievalSuite = {}) {
  const text = sourceText(manifest, retrievalSuite);
  return SCIENTIFIC_EMBEDDING_REQUIRED_FAMILIES
    .filter((family) => !family.patterns.some((pattern) => pattern.test(text)))
    .map((family) => family.id);
}

function rowByMode(retrievalSuite = {}) {
  return new Map(asArray(retrievalSuite.rows).map((row) => [normalizeKey(row.mode), row]));
}

function availableMetricKeys(...rows) {
  return PRIMARY_RETRIEVAL_METRICS.filter((key) => rows.some((row) => row?.metrics?.[key] !== undefined));
}

function metricValue(row = {}, key = '') {
  const value = Number(row.metrics?.[key]);
  return Number.isFinite(value) ? value : null;
}

function retrievalImprovementEvidence(retrievalSuite = {}) {
  const rows = rowByMode(retrievalSuite);
  const lexical = rows.get('lexical');
  const dense = rows.get('dense');
  const hybrid = rows.get('hybrid');
  const metricKeys = availableMetricKeys(lexical, dense, hybrid);
  const comparisons = metricKeys.map((metric) => {
    const lexicalValue = metricValue(lexical, metric);
    const denseValue = metricValue(dense, metric);
    const hybridValue = metricValue(hybrid, metric);
    return {
      metric,
      lexical: lexicalValue,
      dense: denseValue,
      hybrid: hybridValue,
      dense_delta: denseValue === null || lexicalValue === null ? null : Number((denseValue - lexicalValue).toFixed(6)),
      hybrid_delta: hybridValue === null || lexicalValue === null ? null : Number((hybridValue - lexicalValue).toFixed(6))
    };
  });
  return {
    metric_keys: metricKeys,
    comparisons,
    any_dense_or_hybrid_improvement: comparisons.some((entry) => (
      (entry.dense_delta !== null && entry.dense_delta > 0)
      || (entry.hybrid_delta !== null && entry.hybrid_delta > 0)
    ))
  };
}

function buildRequirement(manifest = {}, retrievalSuite = {}) {
  if (!Object.keys(manifest).length || !Object.keys(retrievalSuite).length) {
    return {
      id: 'R4',
      label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates',
      status: 'incomplete',
      message: 'missing scientific embedding manifest or retrieval suite evidence',
      evidence: []
    };
  }
  const rows = rowByMode(retrievalSuite);
  const missingModes = REQUIRED_RETRIEVAL_MODES.filter((mode) => !rows.has(mode));
  const failedModes = REQUIRED_RETRIEVAL_MODES.filter((mode) => rows.get(mode)?.status === 'failed');
  const incompleteModes = REQUIRED_RETRIEVAL_MODES.filter((mode) => {
    const status = rows.get(mode)?.status;
    return status && status !== 'completed' && status !== 'passed' && status !== 'failed';
  });
  const missingFamilyIds = missingFamilies(manifest, retrievalSuite);
  const manifestInputsMissingHashes = missingInputHashes(manifest.inputs);
  const retrievalInputsMissingHashes = missingInputHashes(retrievalSuite.inputs);
  const manifestMissingRoleHashes = missingInputRoles(manifest.inputs, REQUIRED_MANIFEST_INPUT_ROLES);
  const retrievalMissingRoleHashes = missingInputRoles(retrievalSuite.inputs, REQUIRED_RETRIEVAL_INPUT_ROLES);
  const improvement = retrievalImprovementEvidence(retrievalSuite);
  const diagnostics = asObject(manifest.diagnostics);
  const deterministicFallbackCount = Number(diagnostics.deterministicFallbackDocumentCount || 0)
    + Number(diagnostics.deterministicFallbackQueryCount || 0);
  const evidence = [{
    kind: 'scientific_embedding_release_evidence',
    manifest_run_id: compactText(manifest.runId || manifest.run_id),
    retrieval_suite_run_id: compactText(retrievalSuite.runId || retrievalSuite.run_id),
    manifest_contract_version: manifest.contractVersion || null,
    retrieval_suite_contract_version: retrievalSuite.contractVersion || null,
    manifest_status: compactText(manifest.status || 'unknown'),
    manifest_release_gate_status: compactText(manifest.releaseGateStatus || manifest.release_gate_status || 'unknown'),
    method: compactText(manifest.method),
    model: compactText(manifest.model),
    dataset_source: compactText(manifest.datasetSource || manifest.dataset_source),
    license_scope: compactText(manifest.licenseScope || manifest.license_scope),
    required_families: SCIENTIFIC_EMBEDDING_REQUIRED_FAMILIES.map((family) => family.id),
    missing_families: missingFamilyIds,
    retrieval_required_modes: REQUIRED_RETRIEVAL_MODES,
    missing_retrieval_modes: missingModes,
    failed_retrieval_modes: failedModes,
    incomplete_retrieval_modes: incompleteModes,
    deterministic_fallback_count: deterministicFallbackCount,
    external_document_vectors: diagnostics.documentEmbeddingLoadedRows ?? null,
    external_query_vectors: diagnostics.queryEmbeddingLoadedRows ?? null,
    manifest_missing_input_hashes: manifestInputsMissingHashes,
    retrieval_missing_input_hashes: retrievalInputsMissingHashes,
    required_manifest_input_roles: REQUIRED_MANIFEST_INPUT_ROLES.map((role) => role.id),
    missing_manifest_input_role_hashes: manifestMissingRoleHashes,
    required_retrieval_input_roles: REQUIRED_RETRIEVAL_INPUT_ROLES.map((role) => role.id),
    missing_retrieval_input_role_hashes: retrievalMissingRoleHashes,
    retrieval_improvement: improvement
  }];
  if (manifest.contractVersion !== SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding manifest contract version is missing or unsupported', evidence };
  }
  if (retrievalSuite.contractVersion !== 'fixed-corpus-retrieval-suite-v1') {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'fixed-corpus retrieval suite contract version is missing or unsupported', evidence };
  }
  if (FIXTURE_MARKERS.test(sourceText(manifest, retrievalSuite))) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding evidence is not release-grade: fixture_or_synthetic_evidence', evidence };
  }
  if (normalizeKey(manifest.method) === normalizeKey(DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD) || /deterministic[-_ ]?token[-_ ]?hash/.test(sourceText(manifest, {}))) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding evidence uses deterministic placeholder vectors', evidence };
  }
  if (manifest.status !== 'completed' || manifest.releaseGateStatus !== 'ready_for_evaluation') {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding manifest is not ready for evaluation', evidence };
  }
  if (!compactText(manifest.datasetSource || manifest.dataset_source) || !compactText(manifest.licenseScope || manifest.license_scope)) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'missing scientific embedding dataset source or license scope', evidence };
  }
  if (deterministicFallbackCount > 0) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding manifest used deterministic fallback vectors', evidence };
  }
  if (missingFamilyIds.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: `missing scientific embedding benchmark families: ${missingFamilyIds.join(', ')}`, evidence };
  }
  if (!hasInputHash(manifest.inputs) || manifestInputsMissingHashes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'scientific embedding manifest is missing input hashes', evidence };
  }
  if (!hasInputHash(retrievalSuite.inputs) || retrievalInputsMissingHashes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'retrieval suite evidence is missing input hashes', evidence };
  }
  if (manifestMissingRoleHashes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: `missing scientific embedding manifest role-specific input hashes: ${manifestMissingRoleHashes.join(', ')}`, evidence };
  }
  if (retrievalMissingRoleHashes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: `missing retrieval suite role-specific input hashes: ${retrievalMissingRoleHashes.join(', ')}`, evidence };
  }
  if (retrievalSuite.status !== 'completed') {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: failedModes.length ? 'failed' : 'incomplete', message: `retrieval suite status is ${retrievalSuite.status || 'unknown'}`, evidence };
  }
  if (failedModes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'failed', message: `retrieval modes failed: ${failedModes.join(', ')}`, evidence };
  }
  if (missingModes.length || incompleteModes.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: `retrieval modes are missing or incomplete: ${[...missingModes, ...incompleteModes].join(', ')}`, evidence };
  }
  if (!improvement.metric_keys.length) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'retrieval suite has no comparable primary retrieval metrics', evidence };
  }
  if (!improvement.any_dense_or_hybrid_improvement) {
    return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'incomplete', message: 'dense or hybrid retrieval does not improve over lexical baseline', evidence };
  }
  return { id: 'R4', label: 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates', status: 'passed', message: '', evidence };
}

function statusFromRequirements(requirements = []) {
  if (requirements.some((entry) => entry.status === 'failed')) return 'failed';
  if (requirements.some((entry) => entry.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

export function buildScientificEmbeddingReleaseEvidenceReport(options = {}) {
  const manifest = asObject(options.scientificEmbeddingManifest || options.scientific_embedding_manifest || options.manifest);
  const retrievalSuite = asObject(options.retrievalSuiteReport || options.retrieval_suite_report || options.retrievalSuite);
  const inputs = asArray(options.inputs).filter(Boolean);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `scientific-embedding-release-evidence-${stableHash(`${generatedAt}:${inputs.length}`, 10)}`;
  const requirements = [buildRequirement(manifest, retrievalSuite)];
  const status = statusFromRequirements(requirements);
  return {
    contractVersion: SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION,
    runId,
    generatedAt,
    status,
    inputs,
    requirements,
    diagnostics: {
      r4_status: requirements[0]?.status || 'missing',
      missing_input_hashes: inputs.filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum)).map((entry) => compactText(entry.path || entry.file || entry.role))
    },
    releaseGate: {
      status,
      reason: status === 'passed' ? 'scientific_embedding_release_evidence_passed' : requirements.find((entry) => entry.status !== 'passed')?.message || 'scientific embedding release evidence is incomplete'
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

export async function prepareScientificEmbeddingReleaseEvidence(options = {}) {
  const outputDir = compactText(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const manifestPath = compactText(options.scientificEmbeddingManifestPath || options.scientific_embedding_manifest_path || options.manifestPath || options.manifest_path);
  const retrievalSuitePath = compactText(options.retrievalSuiteReportPath || options.retrieval_suite_report_path || options.retrievalSuitePath || options.retrieval_suite_path);
  const manifestInput = manifestPath ? await readEvidenceFile(manifestPath, 'scientific_embedding_manifest') : null;
  const retrievalInput = retrievalSuitePath ? await readEvidenceFile(retrievalSuitePath, 'fixed_corpus_retrieval_suite_report') : null;
  const inputs = [manifestInput, retrievalInput].filter(Boolean).map(({ record, ...input }) => input);
  const report = buildScientificEmbeddingReleaseEvidenceReport({
    ...options,
    scientificEmbeddingManifest: manifestInput?.record || options.scientificEmbeddingManifest,
    retrievalSuiteReport: retrievalInput?.record || options.retrievalSuiteReport,
    inputs
  });
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const reportPath = path.join(absoluteOutputDir, 'scientific-embedding-release-evidence.json');
  const reportMarkdownPath = path.join(absoluteOutputDir, 'scientific-embedding-release-evidence.md');
  const manifestOutputPath = path.join(absoluteOutputDir, 'manifest.json');
  const reportWithArtifacts = {
    ...report,
    artifacts: {
      outputDir: absoluteOutputDir,
      reportPath,
      reportMarkdownPath,
      manifestPath: manifestOutputPath
    }
  };
  await ensureDir(absoluteOutputDir);
  await writeJson(reportPath, reportWithArtifacts);
  await writeText(reportMarkdownPath, renderScientificEmbeddingReleaseEvidenceMarkdown(reportWithArtifacts));
  await writeJson(manifestOutputPath, {
    contractVersion: SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION,
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

export function renderScientificEmbeddingReleaseEvidenceMarkdown(report = {}) {
  const lines = [
    `# Scientific Embedding Release Evidence: ${report.runId || 'run'}`,
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
