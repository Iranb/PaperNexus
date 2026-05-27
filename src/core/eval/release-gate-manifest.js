import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import {
  ENGINEERING_RELEASE_EVIDENCE_VERSION,
  REQUIRED_ENGINEERING_TESTS
} from './engineering-release-evidence.js';
import {
  DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
  REQUIRED_DOCS_SYNC_CHECKS,
  REQUIRED_DOCS_SYNC_INPUTS
} from './docs-sync-release-evidence.js';
import {
  GRAPH_REASONING_REPORT_VERSION
} from './graph-reasoning-report.js';
import {
  GRAPH_LINK_PREDICTION_EVAL_VERSION
} from './graph-link-prediction-eval.js';
import {
  SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION
} from './scientific-embedding-release-evidence.js';
import {
  INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION
} from './innovation-sidecar-release-evidence.js';
import {
  INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION
} from '../ingestion/graph-mutation-executor.js';
import {
  INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION
} from '../ingestion/parser-orchestrator.js';

export const IDEA_CATALYST_RELEASE_GATE_VERSION = 'idea-catalyst-release-gate-v1';

export const RELEASE_GATE_REQUIRED_ABLATIONS = [
  'without_claim_graph',
  'without_must_cite',
  'without_reviewer_panel',
  'without_meta_reviewer',
  'without_storyline_dag',
  'without_temporal_cutoff',
  'without_coci_openalex',
  'without_graphrag_summaries',
  'without_link_prediction_signal',
  'without_counterfactual_planner'
];

export const RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS = RELEASE_GATE_REQUIRED_ABLATIONS
  .filter((id) => ![
    'without_link_prediction_signal',
    'without_counterfactual_planner'
  ].includes(id));

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test)\b/i;
const GRAPH_REASONING_REQUIRED_GATES = [
  'evaluable_gold_tasks',
  'graph_reasoning_beats_baseline',
  'global_local_summary_evaluable',
  'storyline_coherence_not_regressed',
  'release_provenance_complete'
];
const GRAPH_REASONING_REQUIRED_FAMILIES = [
  { id: 'scirepeval', patterns: [/scirepeval/] },
  { id: 'oag_bench', patterns: [/oag[-_ ]?bench/] },
  { id: 'graphrag_bench', patterns: [/graphrag[-_ ]?bench/] }
];
const GRAPH_REASONING_REQUIRED_INPUT_ROLES = [
  { id: 'graph_snapshot', aliases: ['graph_snapshot'] },
  { id: 'graph_reasoning_tasks', aliases: ['graph_reasoning_tasks'] },
  { id: 'graphrag_summaries', aliases: ['graphrag_summaries', 'graph_rag_summaries', 'global_local_summaries'] }
];
const GRAPH_LINK_PREDICTION_REQUIRED_FAMILIES = [
  { id: 'oag', patterns: [/\boag\b/] },
  { id: 'openalex', patterns: [/openalex/] },
  { id: 'internal_kg', patterns: [/internal[-_ ]?kg/, /internal knowledge graph/] }
];
const MUST_CITE_REQUIRED_SOURCE_FAMILIES = [
  { id: 'openalex', patterns: [/openalex/] },
  { id: 'coci', patterns: [/\bcoci\b/, /opencitations/, /open citations/] }
];
const INGESTION_GRAPH_APPLY_REQUIRED_GATES = [
  'graph_mutations_present',
  'multimodal_asset_audit_complete',
  'citation_intent_benchmark_passed',
  'claim_extraction_benchmark_passed',
  'explicit_release_gated_apply_requested'
];
const INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLES = [
  { id: 'graph_mutations', aliases: ['graph_mutations'] },
  { id: 'graph_apply_plan', aliases: ['graph_apply_plan'] },
  { id: 'citation_intent_gold_labels', aliases: ['citation_intent_gold_labels', 'citation_intent_gold', 'citation_gold_labels'] },
  { id: 'claim_extraction_gold_labels', aliases: ['claim_extraction_gold_labels', 'claim_extraction_gold', 'claim_gold_labels'] },
  { id: 'multimodal_assets', aliases: ['multimodal_assets', 'ocr_figure_table_formula_assets', 'ocr_assets', 'figure_table_formula_assets'] }
];
const HUMAN_REQUIRED_READINESS_CHECKS = [
  'aggregation_status_passed',
  'independent_human_labels_present',
  'reviewer_protocol_satisfied',
  'reviewer_identity_independence_satisfied',
  'assignment_coverage_satisfied',
  'review_form_completeness_satisfied',
  'comparison_coverage_satisfied',
  'blinding_protocol_satisfied',
  'target_preference_threshold_met',
  'target_pairs_present'
];
const HUMAN_BLIND_PAYLOAD_POLICY = 'proposal_and_evidence_export_only';
const ABLATION_EFFECT_REQUIRED_IDS = new Set(RELEASE_GATE_REQUIRED_ABLATIONS);
const P0_P1_EXCLUDED_REQUIREMENT_IDS = new Set(['E5', 'R4', 'R5', 'R6', 'R7']);

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

function normalizeReleaseGateScope(value = '') {
  const key = normalizeKey(value || 'full');
  if (['p0_p1', 'p0p1', 'p0_p1_only', 'p0_and_p1', 'phase_p0_p1'].includes(key)) return 'p0_p1';
  return 'full';
}

function defaultRequiredAblationsForScope(scope = 'full') {
  return normalizeReleaseGateScope(scope) === 'p0_p1'
    ? RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS
    : RELEASE_GATE_REQUIRED_ABLATIONS;
}

function roundMetric(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : null;
}

function sourceText(record = {}) {
  const dataset = asObject(record.dataset || record.benchmark || record.source_metadata);
  return [
    record.name,
    record.format,
    record.source,
    record.license_scope,
    dataset.name,
    dataset.format,
    dataset.source,
    dataset.license_scope,
    record.benchmark?.source,
    record.benchmark?.license_scope
  ].map(compactText).filter(Boolean).join(' ');
}

function sourceFamilyText(record = {}) {
  const dataset = asObject(record.dataset || record.benchmark || record.source_metadata);
  const config = asObject(record.config);
  const metadata = asObject(record.metadata);
  const provenance = asObject(record.provenance);
  return [
    sourceText(record),
    record.dataset_source,
    record.datasetSource,
    record.source_time_slice_policy,
    record.sourceTimeSlicePolicy,
    config.time_slice_policy,
    config.timeSlicePolicy,
    config.source_time_slice_policy,
    config.sourceTimeSlicePolicy,
    metadata.time_slice_policy,
    metadata.timeSlicePolicy,
    metadata.source_time_slice_policy,
    metadata.sourceTimeSlicePolicy,
    provenance.time_slice_policy,
    provenance.timeSlicePolicy,
    provenance.source_time_slice_policy,
    provenance.sourceTimeSlicePolicy,
    dataset.time_slice_policy,
    dataset.timeSlicePolicy,
    dataset.source_time_slice_policy,
    dataset.sourceTimeSlicePolicy,
    ...asArray(record.source_families || record.sourceFamilies),
    ...asArray(dataset.source_families || dataset.sourceFamilies),
    ...asArray(config.source_families || config.sourceFamilies),
    ...asArray(metadata.source_families || metadata.sourceFamilies),
    ...asArray(provenance.source_families || provenance.sourceFamilies),
    ...asArray(record.inputs).flatMap((entry) => [
      entry.role,
      entry.path,
      entry.source,
      entry.dataset_source,
      entry.datasetSource,
      entry.source_family,
      entry.sourceFamily
    ])
  ].map(compactText).filter(Boolean).join(' ').toLowerCase();
}

function missingSourceFamilies(record = {}, families = []) {
  const text = sourceFamilyText(record);
  return asArray(families)
    .filter((family) => !family.patterns.some((pattern) => pattern.test(text)))
    .map((family) => family.id);
}

function isPassed(record = {}) {
  return normalizeKey(record.status) === 'passed';
}

function isFailed(record = {}) {
  return normalizeKey(record.status) === 'failed';
}

function hasStructuredEvidence(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function hasReplayStatisticalEvidence(record = {}) {
  const statistics = asObject(record.statistics);
  return [
    record.statistical_significance,
    record.statisticalSignificance,
    record.statistical_tests,
    record.statisticalTests,
    statistics.significance,
    statistics.statistical_significance,
    statistics.statisticalSignificance,
    statistics.statistical_tests,
    statistics.statisticalTests
  ].some(hasStructuredEvidence);
}

function externalEvidence(record = {}, options = {}) {
  if (options.allowFixtureEvidence) {
    return { ok: true, reason: '' };
  }
  const text = sourceText(record);
  const dataset = asObject(record.dataset || record.benchmark);
  const inputs = asArray(record.inputs);
  const releaseReadiness = asObject(record.releaseReadiness || record.release_readiness);
  const hasSource = Boolean(compactText(dataset.source || record.source || record.dataset_source || record.datasetSource));
  const hasLicenseScope = Boolean(compactText(dataset.license_scope || dataset.licenseScope || record.license_scope || record.licenseScope));
  const hasInputHash = inputs.some((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
  if (!hasSource) return { ok: false, reason: 'missing_dataset_source' };
  if (!hasLicenseScope) return { ok: false, reason: 'missing_license_scope' };
  if (FIXTURE_MARKERS.test(text)) return { ok: false, reason: 'fixture_or_synthetic_evidence' };
  if (record.contractVersion === 'idea-catalyst-replay-suite-v1' && !hasInputHash) {
    return { ok: false, reason: 'missing_raw_input_hash' };
  }
  if (record.contractVersion === GRAPH_LINK_PREDICTION_EVAL_VERSION && !hasInputHash) {
    return { ok: false, reason: 'missing_raw_input_hash' };
  }
  if (record.contractVersion === GRAPH_REASONING_REPORT_VERSION && !hasInputHash) {
    return { ok: false, reason: 'missing_raw_input_hash' };
  }
  if (record.contractVersion === 'idea-catalyst-replay-suite-v1') {
    if (!hasReplayStatisticalEvidence(record)) {
      return { ok: false, reason: 'missing_statistical_significance_evidence' };
    }
    if (!Object.keys(releaseReadiness).length) {
      return { ok: false, reason: 'missing_replay_suite_release_readiness' };
    }
    if (releaseReadiness.status !== 'ready_for_release_gate' || releaseReadiness.releaseCandidate !== true) {
      return { ok: false, reason: `replay_suite_release_readiness_${releaseReadiness.status || 'incomplete'}` };
    }
    const requiredReadinessChecks = [
      'strict_time_cutoffs_present',
      'venue_year_holdout_present',
      'time_slice_policy_present',
      'release_grade_improvement_thresholds_present',
      'semantic_negative_coverage_present',
      'statistical_significance_evidence_present',
      'statistical_significance_provenance_auditable'
    ];
    const readinessChecks = asArray(releaseReadiness.checks);
    for (const checkName of requiredReadinessChecks) {
      const found = readinessChecks.find((entry) => normalizeKey(entry.name) === normalizeKey(checkName));
      if (!found) return { ok: false, reason: `replay_suite_release_readiness_missing_${checkName}` };
      if (found.status !== 'passed' || found.ok !== true) {
        return { ok: false, reason: `replay_suite_release_readiness_${checkName}_${found.status || 'incomplete'}` };
      }
    }
  }
  return { ok: true, reason: '' };
}

function gate(record = {}, name = '') {
  return asArray(record.gates).find((entry) => normalizeKey(entry.name) === normalizeKey(name)) || null;
}

function gatePassed(record = {}, name = '') {
  const found = gate(record, name);
  return Boolean(found && normalizeKey(found.status) === 'passed');
}

function familyText(record = {}) {
  const dataset = asObject(record.dataset || record.benchmark);
  const adapter = asObject(record.adapter);
  return [
    dataset.name,
    dataset.format,
    dataset.source,
    adapter.format,
    record.format,
    record.name
  ].map(compactText).join(' ').toLowerCase();
}

function matchesFamily(record = {}, patterns = []) {
  const text = familyText(record);
  return patterns.some((pattern) => pattern.test(text));
}

function hasHashedInputRole(inputs = [], role = {}) {
  const aliases = asArray(role.aliases || role.id).map(normalizeKey);
  return asArray(inputs).some((entry) => (
    aliases.includes(normalizeKey(entry.role))
    && Boolean(compactText(entry.sha256 || entry.hash || entry.checksum))
  ));
}

function graphReasoningInputHashIssues(record = {}) {
  const inputs = asArray(record.inputs);
  return GRAPH_REASONING_REQUIRED_INPUT_ROLES
    .filter((role) => !hasHashedInputRole(inputs, role))
    .map((role) => `missing_${role.id}_input_hash`);
}

function replaySuites(params = {}) {
  return asArray(params.replaySuites || params.replay_suite_manifests || params.replaySuiteManifests)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function ablationManifests(params = {}) {
  return asArray(params.ablationManifests || params.ablation_manifests)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function humanAggregations(params = {}) {
  return asArray(params.humanAggregations || params.human_aggregations || params.humanBlindAggregations)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function graphReasoningReports(params = {}) {
  return asArray(params.graphReasoningReports || params.graph_reasoning_reports)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function graphLinkPredictionReports(params = {}) {
  return asArray(params.graphLinkPredictionReports || params.graph_link_prediction_reports)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function scientificEmbeddingEvidenceReports(params = {}) {
  return asArray(params.scientificEmbeddingEvidenceReports || params.scientific_embedding_evidence_reports || params.scientificEmbeddingEvidence)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function innovationSidecarEvidenceReports(params = {}) {
  return asArray(params.innovationSidecarEvidenceReports || params.innovation_sidecar_evidence_reports || params.innovationSidecarEvidence)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function ingestionGraphMutationExecutionReports(params = {}) {
  return asArray(params.ingestionGraphMutationExecutionReports || params.ingestion_graph_mutation_execution_reports || params.ingestionGraphMutationExecutionEvidence)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function engineeringEvidenceReports(params = {}) {
  return asArray(params.engineeringEvidenceReports || params.engineering_evidence_reports || params.engineeringReleaseEvidence)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function docsSyncEvidenceReports(params = {}) {
  return asArray(params.docsSyncEvidenceReports || params.docs_sync_evidence_reports || params.docsSyncEvidence)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function evidenceInputRecords(params = {}) {
  return asArray(params.evidenceInputs || params.evidence_inputs || params.releaseEvidenceInputs || params.release_evidence_inputs)
    .map(asObject)
    .filter((entry) => Object.keys(entry).length);
}

function requirement(id, label, status, evidence = [], message = '') {
  return {
    id,
    label,
    status,
    ok: status === 'passed',
    message: message || (status === 'passed' ? '' : 'requirement is not satisfied'),
    evidence
  };
}

function evidenceRecord(kind, record = {}, extra = {}) {
  const dataset = asObject(record.dataset || record.benchmark);
  return {
    kind,
    run_id: compactText(record.runId || record.run_id),
    status: compactText(record.status || 'unknown'),
    dataset_name: compactText(dataset.name || record.name),
    dataset_format: compactText(dataset.format || record.format),
    dataset_source: compactText(dataset.source || record.source),
    license_scope: compactText(dataset.license_scope || dataset.licenseScope || record.license_scope),
    ...extra
  };
}

function bestReplayEvidence(records = [], predicate, options = {}) {
  const candidates = records.filter(predicate);
  if (!candidates.length) return { record: null, external: null };
  const passed = candidates.find((entry) => isPassed(entry)) || candidates[0];
  return {
    record: passed,
    external: externalEvidence(passed, options)
  };
}

function replayRequirement(records = [], config = {}) {
  const { id, label, predicate, gateName, metricFields = [], requiredSourceFamilies = [] } = config;
  const { record, external } = bestReplayEvidence(records, predicate, config);
  if (!record) return requirement(id, label, 'incomplete', [], 'missing replay-suite evidence');
  const gateOk = gateName ? gatePassed(record, gateName) : isPassed(record);
  const missingFamilies = missingSourceFamilies(record, requiredSourceFamilies);
  const evidence = [evidenceRecord('replay_suite', record, {
    gate: gateName || null,
    gate_status: gateName ? (gate(record, gateName)?.status || 'missing') : null,
    required_source_families: asArray(requiredSourceFamilies).map((family) => family.id),
    missing_source_families: missingFamilies,
    release_readiness_status: record.releaseReadiness?.status || record.release_readiness?.status || null,
    release_candidate: record.releaseReadiness?.releaseCandidate ?? record.release_readiness?.releaseCandidate ?? null,
    metrics: Object.fromEntries(metricFields.map((field) => [field, record.metrics?.[field] ?? null]))
  })];
  if (isFailed(record) || (gateName && gate(record, gateName)?.status === 'failed')) {
    return requirement(id, label, 'failed', evidence, 'replay-suite evidence failed');
  }
  if (!isPassed(record) || !gateOk) {
    return requirement(id, label, 'incomplete', evidence, 'replay-suite evidence is not passed');
  }
  if (!external.ok) {
    return requirement(id, label, 'incomplete', evidence, `replay-suite evidence is not release-grade: ${external.reason}`);
  }
  if (missingFamilies.length) {
    return requirement(id, label, 'incomplete', evidence, `missing required citation source families: ${missingFamilies.join(', ')}`);
  }
  return requirement(id, label, 'passed', evidence);
}

function metricEvaluable(record = {}, field = '') {
  const diagnostics = asObject(record.diagnostics);
  return Number(diagnostics[field] || 0) > 0;
}

function replayFamilyEvidence(records = [], family = {}, options = {}) {
  const { record, external } = bestReplayEvidence(records, family.predicate, options);
  if (!record) {
    return {
      family: family.id,
      status: 'missing',
      requirementStatus: 'incomplete',
      evidence: evidenceRecord('replay_suite', {}, {
        family: family.id,
        gate: family.gateName || null,
        missing: true
      }),
      message: `missing ${family.id} replay-suite evidence`
    };
  }
  const gateOk = family.gateName ? gatePassed(record, family.gateName) : isPassed(record);
  const gateEntry = family.gateName ? gate(record, family.gateName) : null;
  const evidence = evidenceRecord('replay_suite', record, {
    family: family.id,
    gate: family.gateName || null,
    gate_status: gateEntry?.status || null,
    release_readiness_status: record.releaseReadiness?.status || record.release_readiness?.status || null,
    release_candidate: record.releaseReadiness?.releaseCandidate ?? record.release_readiness?.releaseCandidate ?? null,
    metrics: Object.fromEntries(asArray(family.metricFields).map((field) => [field, record.metrics?.[field] ?? null]))
  });
  if (isFailed(record) || (family.gateName && gateEntry?.status === 'failed')) {
    return {
      family: family.id,
      status: 'failed',
      requirementStatus: 'failed',
      evidence,
      message: `${family.id} replay-suite evidence failed`
    };
  }
  if (!isPassed(record) || !gateOk) {
    return {
      family: family.id,
      status: 'incomplete',
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} replay-suite evidence is not passed`
    };
  }
  if (!external.ok) {
    return {
      family: family.id,
      status: 'incomplete',
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} replay-suite evidence is not release-grade: ${external.reason}`
    };
  }
  return {
    family: family.id,
    status: 'passed',
    requirementStatus: 'passed',
    evidence
  };
}

function replayBenchmarkSetRequirement(records = [], config = {}) {
  const { id, label, families = [] } = config;
  const results = families.map((family) => replayFamilyEvidence(records, family, config));
  const evidence = results.map((result) => result.evidence);
  const failed = results.filter((result) => result.requirementStatus === 'failed');
  const incomplete = results.filter((result) => result.requirementStatus === 'incomplete');
  if (failed.length) {
    return requirement(id, label, 'failed', evidence, failed.map((entry) => entry.message).filter(Boolean).join('; '));
  }
  if (incomplete.length) {
    return requirement(id, label, 'incomplete', evidence, incomplete.map((entry) => entry.message).filter(Boolean).join('; '));
  }
  return requirement(id, label, 'passed', evidence);
}

function buildReplayRequirements(records = [], options = {}) {
  return [
    replayRequirement(records, {
      ...options,
      id: 'E1',
      label: 'current baseline comparison has at least three major metric lifts',
      predicate: (record) => Boolean(gate(record, 'major_metrics_beat_baseline'))
        && Boolean(gate(record, 'historical_replay_beats_live_discovery'))
        && matchesFamily(record, [/openreview/, /peerread/, /moprd/, /\bre2\b/, /re²/]),
      gateName: 'major_metrics_beat_baseline',
      metricFields: [
        'major_metric_improvement_count',
        'evaluated_major_metric_count',
        'major_metric_improvements',
        'historical_score',
        'historical_score_improvement'
      ]
    }),
    replayBenchmarkSetRequirement(records, {
      ...options,
      id: 'E2',
      label: 'novelty benchmark passes NovBench/RINoBench/axiomatic novelty evidence',
      families: [
        {
          id: 'novbench',
          predicate: (record) => metricEvaluable(record, 'evaluable_novelty_case_count') && matchesFamily(record, [/novbench/]),
          gateName: 'novelty_beats_baseline',
          metricFields: ['novelty_score', 'novelty_score_improvement', 'historical_score']
        },
        {
          id: 'rinobench',
          predicate: (record) => metricEvaluable(record, 'evaluable_novelty_case_count') && matchesFamily(record, [/rinobench/]),
          gateName: 'novelty_beats_baseline',
          metricFields: ['novelty_score', 'novelty_score_improvement', 'historical_score']
        },
        {
          id: 'axiomatic_novelty',
          predicate: (record) => metricEvaluable(record, 'evaluable_novelty_case_count') && matchesFamily(record, [/axiomatic/]),
          gateName: 'novelty_beats_baseline',
          metricFields: ['novelty_score', 'novelty_score_improvement', 'historical_score']
        }
      ]
    }),
    replayBenchmarkSetRequirement(records, {
      ...options,
      id: 'E3',
      label: 'claim grounding passes CLAIM-BENCH/CLAIMCHECK evidence',
      families: [
        {
          id: 'claim_bench',
          predicate: (record) => metricEvaluable(record, 'evaluable_claim_case_count') && matchesFamily(record, [/claim[-_ ]?bench/]),
          gateName: 'claim_grounding',
          metricFields: ['claim_grounding_f1', 'claim_grounding_f1_improvement', 'unsupported_claim_rate_reduction', 'claim_source_span_completeness']
        },
        {
          id: 'claimcheck',
          predicate: (record) => metricEvaluable(record, 'evaluable_claim_case_count') && matchesFamily(record, [/claimcheck/]),
          gateName: 'claim_grounding',
          metricFields: ['claim_grounding_f1', 'claim_grounding_f1_improvement', 'unsupported_claim_rate_reduction', 'claim_source_span_completeness']
        }
      ]
    }),
    replayRequirement(records, {
      ...options,
      id: 'E4',
      label: 'must-cite retrieval passes MasterSet-style evidence',
      predicate: (record) => metricEvaluable(record, 'evaluable_must_cite_case_count')
        && matchesFamily(record, [/masterset/, /must[-_ ]?cite/]),
      gateName: 'must_cite_recall_at_k',
      metricFields: ['must_cite_recall_at_k', 'must_cite_recall_at_k_improvement'],
      requiredSourceFamilies: MUST_CITE_REQUIRED_SOURCE_FAMILIES
    }),
    replayBenchmarkSetRequirement(records, {
      ...options,
      id: 'E6',
      label: 'historical replay passes strict time-cutoff evidence',
      families: [
        {
          id: 'openreview',
          predicate: (record) => Boolean(gate(record, 'historical_replay_beats_live_discovery'))
            && Number(record.diagnostics?.missing_time_cutoff_count || 0) === 0
            && matchesFamily(record, [/openreview/]),
          gateName: 'historical_replay_beats_live_discovery',
          metricFields: ['historical_score', 'historical_score_improvement']
        },
        {
          id: 'peerread',
          predicate: (record) => Boolean(gate(record, 'historical_replay_beats_live_discovery'))
            && Number(record.diagnostics?.missing_time_cutoff_count || 0) === 0
            && matchesFamily(record, [/peerread/]),
          gateName: 'historical_replay_beats_live_discovery',
          metricFields: ['historical_score', 'historical_score_improvement']
        },
        {
          id: 'moprd',
          predicate: (record) => Boolean(gate(record, 'historical_replay_beats_live_discovery'))
            && Number(record.diagnostics?.missing_time_cutoff_count || 0) === 0
            && matchesFamily(record, [/moprd/]),
          gateName: 'historical_replay_beats_live_discovery',
          metricFields: ['historical_score', 'historical_score_improvement']
        },
        {
          id: 're2',
          predicate: (record) => Boolean(gate(record, 'historical_replay_beats_live_discovery'))
            && Number(record.diagnostics?.missing_time_cutoff_count || 0) === 0
            && matchesFamily(record, [/\bre2\b/, /re²/]),
          gateName: 'historical_replay_beats_live_discovery',
          metricFields: ['historical_score', 'historical_score_improvement']
        }
      ]
    })
  ];
}

function graphReasoningFamilyEvidence(records = [], family = {}, options = {}) {
  const { record, external } = bestReplayEvidence(
    records,
    (entry) => matchesFamily(entry, family.patterns),
    options
  );
  if (!record) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence: evidenceRecord('graph_reasoning_report', {}, {
        family: family.id,
        missing: true
      }),
      message: `missing ${family.id} graph reasoning evidence`
    };
  }
  const releaseGate = asObject(record.releaseGate || record.release_gate);
  const gateStatuses = Object.fromEntries(GRAPH_REASONING_REQUIRED_GATES.map((name) => [
    name,
    gate(record, name)?.status || 'missing'
  ]));
  const metrics = asObject(record.metrics);
  const summaryDelta = Number(metrics.global_local_summary_delta);
  const missingInputHashes = graphReasoningInputHashIssues(record);
  const evidence = evidenceRecord('graph_reasoning_report', record, {
    family: family.id,
    contract_version: record.contractVersion || null,
    release_gate_status: releaseGate.status || null,
    gate_statuses: gateStatuses,
    required_input_roles: GRAPH_REASONING_REQUIRED_INPUT_ROLES.map((entry) => entry.id),
    missing_input_hashes: missingInputHashes,
    metrics,
    global_local_summary_delta: Number.isFinite(summaryDelta) ? roundMetric(summaryDelta) : null
  });
  if (record.contractVersion !== GRAPH_REASONING_REPORT_VERSION) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning evidence contract version is missing or unsupported`
    };
  }
  if (missingInputHashes.length) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning evidence is missing required input hashes: ${missingInputHashes.join(', ')}`
    };
  }
  const failedGates = GRAPH_REASONING_REQUIRED_GATES.filter((name) => gate(record, name)?.status === 'failed');
  if (isFailed(record) || releaseGate.status === 'failed' || failedGates.length) {
    return {
      family: family.id,
      requirementStatus: 'failed',
      evidence,
      message: `${family.id} graph reasoning evidence failed${failedGates.length ? ` gates: ${failedGates.join(', ')}` : ''}`
    };
  }
  if (!isPassed(record)) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning report is not passed`
    };
  }
  if (releaseGate.status && releaseGate.status !== 'passed') {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning release gate is ${releaseGate.status}`
    };
  }
  const missingGates = GRAPH_REASONING_REQUIRED_GATES.filter((name) => !gate(record, name));
  if (missingGates.length) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning evidence is missing gates: ${missingGates.join(', ')}`
    };
  }
  const incompleteGates = GRAPH_REASONING_REQUIRED_GATES.filter((name) => !gatePassed(record, name));
  if (incompleteGates.length) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning gates are not passed: ${incompleteGates.join(', ')}`
    };
  }
  if (!Number.isFinite(summaryDelta)) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning evidence is missing global_local_summary_delta`
    };
  }
  if (summaryDelta <= 0) {
    return {
      family: family.id,
      requirementStatus: 'failed',
      evidence,
      message: `${family.id} graph reasoning global_local_summary_delta must be positive`
    };
  }
  if (!external.ok) {
    return {
      family: family.id,
      requirementStatus: 'incomplete',
      evidence,
      message: `${family.id} graph reasoning evidence is not release-grade: ${external.reason}`
    };
  }
  return {
    family: family.id,
    requirementStatus: 'passed',
    evidence
  };
}

function buildGraphReasoningRequirement(records = [], options = {}) {
  const results = GRAPH_REASONING_REQUIRED_FAMILIES.map((family) => graphReasoningFamilyEvidence(records, family, options));
  const evidence = results.map((result) => result.evidence);
  const failed = results.filter((result) => result.requirementStatus === 'failed');
  const incomplete = results.filter((result) => result.requirementStatus === 'incomplete');
  if (failed.length) {
    return requirement('E5', 'scholarly graph reasoning passes SciRepEval/OAG-Bench/GraphRAG-Bench evidence', 'failed', evidence, failed.map((entry) => entry.message).filter(Boolean).join('; '));
  }
  if (incomplete.length) {
    return requirement('E5', 'scholarly graph reasoning passes SciRepEval/OAG-Bench/GraphRAG-Bench evidence', 'incomplete', evidence, incomplete.map((entry) => entry.message).filter(Boolean).join('; '));
  }
  return requirement('E5', 'scholarly graph reasoning passes SciRepEval/OAG-Bench/GraphRAG-Bench evidence', 'passed', evidence);
}

function graphLinkPredictionEvidenceText(record = {}) {
  return [
    sourceText(record),
    record.model,
    record.method,
    record.trainingSlice,
    record.training_slice,
    record.timeCutoff,
    record.time_cutoff,
    record.negativeSamplingPolicy,
    record.negative_sampling_policy,
    ...asArray(record.inputs).map((entry) => [
      entry.role,
      entry.path,
      entry.source
    ].map(compactText).join(' '))
  ].map(compactText).join(' ').toLowerCase();
}

function missingGraphLinkPredictionFamilies(record = {}) {
  const text = graphLinkPredictionEvidenceText(record);
  return GRAPH_LINK_PREDICTION_REQUIRED_FAMILIES
    .filter((family) => !family.patterns.some((pattern) => pattern.test(text)))
    .map((family) => family.id);
}

function buildGraphLinkPredictionRequirement(records = [], options = {}) {
  const candidates = records.filter((record) => {
    const text = graphLinkPredictionEvidenceText(record);
    return /oag|openalex|internal[-_ ]?kg|temporal[-_ ]?link|link[-_ ]?prediction/.test(text);
  });
  if (!candidates.length) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', [], 'missing graph link-prediction benchmark evidence');
  }
  const record = candidates.find((entry) => isPassed(entry)) || candidates[0];
  const external = externalEvidence(record, options);
  const releaseGate = asObject(record.releaseGate || record.release_gate);
  const temporalGate = gate(record, 'temporal_split_clean');
  const qualityGate = gate(record, 'link_prediction_quality');
  const provenanceGate = gate(record, 'release_provenance_complete');
  const missingFamilies = missingGraphLinkPredictionFamilies(record);
  const evidence = [evidenceRecord('graph_link_prediction_report', record, {
    contract_version: record.contractVersion || null,
    model: compactText(record.model),
    time_cutoff: compactText(record.timeCutoff || record.time_cutoff),
    training_slice: compactText(record.trainingSlice || record.training_slice),
    negative_sampling_policy: compactText(record.negativeSamplingPolicy || record.negative_sampling_policy),
    release_gate_status: releaseGate.status || null,
    required_source_families: GRAPH_LINK_PREDICTION_REQUIRED_FAMILIES.map((family) => family.id),
    missing_source_families: missingFamilies,
    metrics: {
      hits_at_1: record.metrics?.hits_at_1 ?? null,
      hits_at_10: record.metrics?.hits_at_10 ?? null,
      mrr: record.metrics?.mrr ?? null,
      auc_like_pair_accuracy: record.metrics?.auc_like_pair_accuracy ?? null,
      future_leakage_count: record.metrics?.future_leakage_count ?? null
    }
  })];
  if (record.contractVersion !== GRAPH_LINK_PREDICTION_EVAL_VERSION) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, 'graph link-prediction evidence contract version is missing or unsupported');
  }
  if (missingFamilies.length) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, `missing graph link-prediction source families: ${missingFamilies.join(', ')}`);
  }
  if (isFailed(record) || temporalGate?.status === 'failed' || qualityGate?.status === 'failed' || provenanceGate?.status === 'failed') {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'failed', evidence, 'graph link-prediction report failed');
  }
  if (!isPassed(record)) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, 'graph link-prediction report is not passed');
  }
  if (releaseGate.status && releaseGate.status !== 'passed') {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, `graph link-prediction release gate is ${releaseGate.status}`);
  }
  if (!gatePassed(record, 'temporal_split_clean')) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, 'graph link-prediction temporal split gate is not passed');
  }
  if (!gatePassed(record, 'link_prediction_quality')) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, 'graph link-prediction quality gate is not passed');
  }
  if (!gatePassed(record, 'release_provenance_complete')) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, 'graph link-prediction release provenance gate is not passed');
  }
  if (!external.ok) {
    return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'incomplete', evidence, `graph link-prediction evidence is not release-grade: ${external.reason}`);
  }
  return requirement('R7', 'graph link-prediction temporal benchmark passes OAG/OpenAlex/internal-KG evidence', 'passed', evidence);
}

function sidecarReleaseGateStatus(record = {}) {
  return compactText(asObject(record.releaseGate || record.release_gate).status);
}

function sidecarRequirement(record = {}, requirementId = '') {
  return asArray(record.requirements).find((entry) => normalizeKey(entry.id) === normalizeKey(requirementId)) || null;
}

function sidecarInputHashIssues(record = {}) {
  const inputs = asArray(record.inputs);
  if (!inputs.length) return ['missing_sidecar_inputs'];
  return inputs
    .filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => compactText(entry.path || entry.file || entry.role) || 'unknown_input');
}

function sidecarEvidenceText(record = {}, requirementEntry = {}) {
  return [
    record.runId,
    record.run_id,
    record.status,
    sidecarReleaseGateStatus(record),
    requirementEntry?.id,
    requirementEntry?.status,
    requirementEntry?.message,
    ...asArray(requirementEntry?.evidence).flatMap((entry) => [
      entry.kind,
      entry.run_id,
      entry.status,
      entry.dataset_name,
      entry.dataset_format,
      entry.dataset_source,
      entry.license_scope,
      entry.model_id,
      entry.prompt_version,
      entry.search_mode,
      entry.backend
    ]),
    ...asArray(record.inputs).flatMap((entry) => [
      entry.role,
      entry.path,
      entry.source
    ])
  ].map(compactText).join(' ').toLowerCase();
}

function scientificEmbeddingEvidenceText(record = {}, requirementEntry = {}) {
  return [
    record.runId,
    record.run_id,
    record.status,
    sidecarReleaseGateStatus(record),
    requirementEntry?.id,
    requirementEntry?.status,
    requirementEntry?.message,
    ...asArray(requirementEntry?.evidence).flatMap((entry) => [
      entry.kind,
      entry.manifest_run_id,
      entry.retrieval_suite_run_id,
      entry.manifest_status,
      entry.manifest_release_gate_status,
      entry.method,
      entry.model,
      entry.dataset_source,
      entry.license_scope,
      ...asArray(entry.required_families),
      ...asArray(entry.missing_families),
      ...asArray(entry.retrieval_required_modes),
      ...asArray(entry.missing_retrieval_modes)
    ]),
    ...asArray(record.inputs).flatMap((entry) => [
      entry.role,
      entry.path,
      entry.source
    ])
  ].map(compactText).join(' ').toLowerCase();
}

function buildScientificEmbeddingRequirement(records = [], options = {}) {
  const id = 'R4';
  const label = 'scientific embedding retrieval evidence passes external encoder and dense/hybrid gates';
  if (!records.length) return requirement(id, label, 'incomplete', [], 'missing scientific embedding release evidence');
  const record = records.find((entry) => {
    const nested = sidecarRequirement(entry, id);
    return isPassed(entry) && nested?.status === 'passed';
  }) || records[0];
  const nested = sidecarRequirement(record, id);
  const releaseGateStatus = sidecarReleaseGateStatus(record);
  const missingInputHashes = sidecarInputHashIssues(record);
  const evidence = [evidenceRecord('scientific_embedding_release_evidence', record, {
    contract_version: record.contractVersion || null,
    sidecar_status: compactText(record.status || 'unknown'),
    release_gate_status: releaseGateStatus || null,
    requirement_id: id,
    requirement_status: nested?.status || 'missing',
    requirement_message: nested?.message || '',
    missing_input_hashes: missingInputHashes,
    nested_evidence: asArray(nested?.evidence)
  })];
  if (record.contractVersion !== SCIENTIFIC_EMBEDDING_RELEASE_EVIDENCE_VERSION) {
    return requirement(id, label, 'incomplete', evidence, 'scientific embedding evidence contract version is missing or unsupported');
  }
  if (!nested) {
    return requirement(id, label, 'incomplete', evidence, 'scientific embedding evidence is missing R4');
  }
  if (!options.allowFixtureEvidence && FIXTURE_MARKERS.test(scientificEmbeddingEvidenceText(record, nested))) {
    return requirement(id, label, 'incomplete', evidence, 'scientific embedding evidence is not release-grade: fixture_or_synthetic_evidence');
  }
  if (missingInputHashes.length) {
    return requirement(id, label, 'incomplete', evidence, 'scientific embedding evidence is missing input hashes');
  }
  if (nested.status === 'failed') {
    return requirement(id, label, 'failed', evidence, nested.message || 'scientific embedding evidence failed');
  }
  if (nested.status !== 'passed') {
    return requirement(id, label, 'incomplete', evidence, nested.message || 'R4 scientific embedding requirement is not passed');
  }
  if (isFailed(record) || releaseGateStatus === 'failed') {
    return requirement(id, label, 'failed', evidence, 'scientific embedding evidence failed');
  }
  if (!isPassed(record)) {
    return requirement(id, label, 'incomplete', evidence, 'scientific embedding evidence is not passed');
  }
  if (releaseGateStatus && releaseGateStatus !== 'passed') {
    return requirement(id, label, 'incomplete', evidence, `scientific embedding release gate is ${releaseGateStatus}`);
  }
  return requirement(id, label, 'passed', evidence);
}

function buildInnovationSidecarRequirement(records = [], config = {}, options = {}) {
  const { id, label } = config;
  if (!records.length) return requirement(id, label, 'incomplete', [], 'missing innovation sidecar release evidence');
  const record = records.find((entry) => {
    const nested = sidecarRequirement(entry, id);
    return isPassed(entry) && nested?.status === 'passed';
  }) || records[0];
  const nested = sidecarRequirement(record, id);
  const releaseGateStatus = sidecarReleaseGateStatus(record);
  const missingInputHashes = sidecarInputHashIssues(record);
  const evidence = [evidenceRecord('innovation_sidecar_release_evidence', record, {
    contract_version: record.contractVersion || null,
    sidecar_status: compactText(record.status || 'unknown'),
    release_gate_status: releaseGateStatus || null,
    requirement_id: id,
    requirement_status: nested?.status || 'missing',
    requirement_message: nested?.message || '',
    missing_input_hashes: missingInputHashes,
    nested_evidence: asArray(nested?.evidence)
  })];
  if (record.contractVersion !== INNOVATION_SIDECAR_RELEASE_EVIDENCE_VERSION) {
    return requirement(id, label, 'incomplete', evidence, 'innovation sidecar evidence contract version is missing or unsupported');
  }
  if (!nested) {
    return requirement(id, label, 'incomplete', evidence, `innovation sidecar evidence is missing ${id}`);
  }
  if (!options.allowFixtureEvidence && FIXTURE_MARKERS.test(sidecarEvidenceText(record, nested))) {
    return requirement(id, label, 'incomplete', evidence, 'innovation sidecar evidence is not release-grade: fixture_or_synthetic_evidence');
  }
  if (missingInputHashes.length) {
    return requirement(id, label, 'incomplete', evidence, 'innovation sidecar evidence is missing input hashes');
  }
  if (nested.status === 'failed') {
    return requirement(id, label, 'failed', evidence, nested.message || 'innovation sidecar evidence failed');
  }
  if (nested.status !== 'passed') {
    return requirement(id, label, 'incomplete', evidence, nested.message || `${id} innovation sidecar requirement is not passed`);
  }
  if (isFailed(record) || releaseGateStatus === 'failed') {
    return requirement(id, label, 'failed', evidence, 'innovation sidecar evidence failed');
  }
  if (!isPassed(record)) {
    return requirement(id, label, 'incomplete', evidence, 'innovation sidecar evidence is not passed');
  }
  if (releaseGateStatus && releaseGateStatus !== 'passed') {
    return requirement(id, label, 'incomplete', evidence, `innovation sidecar release gate is ${releaseGateStatus}`);
  }
  return requirement(id, label, 'passed', evidence);
}

function buildInnovationSidecarRequirements(records = [], options = {}) {
  return [
    buildInnovationSidecarRequirement(records, {
      id: 'R5',
      label: 'calibrated model-assisted innovation evidence passes benchmark calibration'
    }, options),
    buildInnovationSidecarRequirement(records, {
      id: 'R6',
      label: 'model-assisted counterfactual search has usefulness evidence'
    }, options)
  ];
}

function reportInputHashIssues(record = {}) {
  const inputs = asArray(record.inputs);
  if (!inputs.length) return ['missing_inputs'];
  return inputs
    .filter((entry) => !compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => compactText(entry.path || entry.file || entry.role) || 'unknown_input');
}

function gateStatuses(record = {}, gateNames = []) {
  return Object.fromEntries(gateNames.map((name) => [
    name,
    gate(record.plan || record, name)?.status || 'missing'
  ]));
}

function ingestionExecutionEvidenceText(record = {}) {
  return [
    record.actor,
    record.corpusRoot,
    record.graphMutationsPath,
    record.graphApplyPlanPath,
    ...asArray(record.inputs).flatMap((entry) => [entry.role, entry.path, entry.source])
  ].map(compactText).join(' ').toLowerCase();
}

function buildIngestionGraphMutationRequirement(records = [], options = {}) {
  if (!records.length) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', [], 'missing ingestion graph mutation execution evidence');
  }
  const record = records.find((entry) => entry.status === 'applied' && entry.applyStatus === 'applied') || records[0];
  const plan = asObject(record.plan);
  const safety = asObject(record.safety);
  const artifacts = asObject(record.artifacts);
  const graphBefore = asObject(record.graphBefore);
  const projectedGraphAfter = asObject(record.projectedGraphAfter);
  const authoritativeGraphAfter = asObject(record.authoritativeGraphAfter);
  const missingInputHashes = reportInputHashIssues(record);
  const requiredGateStatuses = gateStatuses(record, INGESTION_GRAPH_APPLY_REQUIRED_GATES);
  const missingGates = INGESTION_GRAPH_APPLY_REQUIRED_GATES.filter((name) => requiredGateStatuses[name] === 'missing');
  const failedGates = INGESTION_GRAPH_APPLY_REQUIRED_GATES.filter((name) => requiredGateStatuses[name] === 'failed');
  const incompleteGates = INGESTION_GRAPH_APPLY_REQUIRED_GATES.filter((name) => {
    const status = requiredGateStatuses[name];
    return status !== 'passed' && status !== 'failed' && status !== 'missing';
  });
  const graphBeforeChecksum = compactText(graphBefore.checksum);
  const projectedChecksum = compactText(projectedGraphAfter.checksum);
  const authoritativeChecksum = compactText(authoritativeGraphAfter.checksum);
  const rollbackManifestPath = compactText(artifacts.rollbackManifest || artifacts.rollback_manifest);
  const rollbackManifestSha256 = compactText(artifacts.rollbackManifestSha256 || artifacts.rollback_manifest_sha256 || safety.rollbackManifestSha256 || safety.rollback_manifest_sha256);
  const beforeGraphSnapshotPath = compactText(artifacts.beforeGraphSnapshot || artifacts.before_graph_snapshot);
  const beforeGraphSnapshotSha256 = compactText(artifacts.beforeGraphSnapshotSha256 || artifacts.before_graph_snapshot_sha256 || safety.beforeGraphSnapshotSha256 || safety.before_graph_snapshot_sha256);
  const missingRoleInputHashes = INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLES
    .filter((role) => !hasHashedInputRole(record.inputs, role))
    .map((role) => role.id);
  const evidence = [evidenceRecord('ingestion_graph_mutation_execution', record, {
    contract_version: record.contractVersion || null,
    status: compactText(record.status || 'unknown'),
    apply_status: compactText(record.applyStatus || record.apply_status || 'unknown'),
    dry_run: record.dryRun ?? record.dry_run ?? null,
    operation_count: Number(record.operationCount || record.operation_count || 0),
    authoritative_graph_write_performed: safety.authoritativeGraphWritePerformed === true,
    rollback_manifest_required: safety.rollbackManifestRequired === true,
    rollback_manifest_path: rollbackManifestPath || null,
    rollback_manifest_sha256: rollbackManifestSha256 || null,
    before_graph_snapshot_path: beforeGraphSnapshotPath || null,
    before_graph_snapshot_sha256: beforeGraphSnapshotSha256 || null,
    plan_contract_version: plan.contractVersion || null,
    plan_status: compactText(plan.status),
    plan_mode: compactText(plan.mode),
    plan_can_apply: plan.canApply === true,
    plan_release_gate_status: compactText(plan.releaseGateStatus || plan.release_gate_status),
    required_gate_statuses: requiredGateStatuses,
    missing_required_gates: missingGates,
    failed_required_gates: failedGates,
    incomplete_required_gates: incompleteGates,
    graph_before_checksum: graphBeforeChecksum,
    projected_graph_after_checksum: projectedChecksum,
    authoritative_graph_after_checksum: authoritativeChecksum,
    required_input_roles: INGESTION_GRAPH_MUTATION_REQUIRED_INPUT_ROLES.map((role) => role.id),
    missing_input_hashes: missingInputHashes,
    missing_input_role_hashes: missingRoleInputHashes
  })];
  if (record.contractVersion !== INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'ingestion graph mutation execution contract version is missing or unsupported');
  }
  if (!options.allowFixtureEvidence && FIXTURE_MARKERS.test(ingestionExecutionEvidenceText(record))) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'ingestion graph mutation execution evidence is not release-grade: fixture_or_synthetic_evidence');
  }
  if (failedGates.length || record.status === 'failed' || record.applyStatus === 'failed') {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'failed', evidence, `ingestion graph mutation execution failed gates: ${failedGates.join(', ') || 'unknown'}`);
  }
  if (record.status !== 'applied' || record.applyStatus !== 'applied') {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'ingestion graph mutation execution did not apply authoritative graph mutations');
  }
  if (record.dryRun !== false) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'ingestion graph mutation execution is only a dry run');
  }
  if (Number(record.operationCount || 0) <= 0) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'missing graph mutation operations');
  }
  if (plan.contractVersion !== INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION || plan.status !== 'ready_to_apply' || plan.canApply !== true) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'graph apply plan is not ready_to_apply');
  }
  if (plan.releaseGateStatus && plan.releaseGateStatus !== 'passed') {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, `graph apply plan release gate is ${plan.releaseGateStatus}`);
  }
  if (missingGates.length || incompleteGates.length) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, `graph apply plan gates are not passed: ${[...missingGates, ...incompleteGates].join(', ')}`);
  }
  if (safety.authoritativeGraphWritePerformed !== true || safety.rollbackManifestRequired !== true) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'missing authoritative write or rollback safety evidence');
  }
  if (!rollbackManifestPath || !rollbackManifestSha256 || !beforeGraphSnapshotPath || !beforeGraphSnapshotSha256) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'missing rollback manifest or before-graph snapshot hash evidence');
  }
  if (!graphBeforeChecksum || !projectedChecksum || !authoritativeChecksum) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'missing graph checksum evidence');
  }
  if (graphBeforeChecksum === authoritativeChecksum) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'authoritative graph checksum did not change');
  }
  if (projectedChecksum !== authoritativeChecksum) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'projected and authoritative graph checksums diverge');
  }
  if (missingInputHashes.length) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, 'ingestion graph mutation execution is missing input hashes');
  }
  if (missingRoleInputHashes.length) {
    return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'incomplete', evidence, `missing ingestion role-specific input hashes: ${missingRoleInputHashes.join(', ')}`);
  }
  return requirement('R3', 'ingestion graph mutations are applied through release-gated claim/citation evidence', 'passed', evidence);
}

function normalizePathText(value = '') {
  return compactText(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function buildEngineeringRequirement(records = []) {
  if (!records.length) {
    return requirement('T1', 'required engineering release tests pass', 'incomplete', [], 'missing engineering release test evidence');
  }
  const record = records.find((entry) => isPassed(entry)) || records[0];
  const required = REQUIRED_ENGINEERING_TESTS.map(normalizePathText);
  const diagnostics = asObject(record.diagnostics);
  const inputs = asArray(record.inputs);
  const testRuns = asArray(record.test_runs || record.testRuns);
  const coveredInputs = inputs
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizePathText(entry.path || entry.file || ''));
  const missingInputHashes = required.filter((file) => !coveredInputs.some((entry) => entry.endsWith(file)));
  const runStatuses = new Map();
  for (const run of testRuns) {
    const status = compactText(run.status);
    for (const file of asArray(run.test_files || run.testFiles || run.test_file || run.testFile).map(normalizePathText)) {
      runStatuses.set(file, status);
    }
  }
  const missingTests = required.filter((file) => !runStatuses.has(file));
  const failedTests = required.filter((file) => runStatuses.get(file) && runStatuses.get(file) !== 'passed');
  const evidence = [evidenceRecord('engineering_release_evidence', record, {
    contract_version: record.contractVersion || null,
    required_tests: required,
    missing_required_tests: diagnostics.missing_required_tests || missingTests,
    failed_required_tests: diagnostics.failed_required_tests || failedTests,
    missing_input_hashes: diagnostics.missing_input_hashes || missingInputHashes,
    node_version: record.environment?.node_version || null
  })];
  if (record.contractVersion !== ENGINEERING_RELEASE_EVIDENCE_VERSION) {
    return requirement('T1', 'required engineering release tests pass', 'incomplete', evidence, 'engineering evidence contract version is missing or unsupported');
  }
  if (isFailed(record) || failedTests.length || asArray(diagnostics.failed_required_tests).length) {
    return requirement('T1', 'required engineering release tests pass', 'failed', evidence, 'required engineering release tests failed');
  }
  if (!isPassed(record)) {
    return requirement('T1', 'required engineering release tests pass', 'incomplete', evidence, 'engineering release evidence is not passed');
  }
  if (missingTests.length || asArray(diagnostics.missing_required_tests).length) {
    return requirement('T1', 'required engineering release tests pass', 'incomplete', evidence, 'missing required engineering test runs');
  }
  if (missingInputHashes.length || asArray(diagnostics.missing_input_hashes).length) {
    return requirement('T1', 'required engineering release tests pass', 'incomplete', evidence, 'missing required engineering test input hashes');
  }
  return requirement('T1', 'required engineering release tests pass', 'passed', evidence);
}

function buildDocsSyncRequirement(records = []) {
  if (!records.length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', [], 'missing docs sync release evidence');
  }
  const record = records.find((entry) => isPassed(entry)) || records[0];
  const requiredChecks = REQUIRED_DOCS_SYNC_CHECKS.map((entry) => normalizeKey(entry.id));
  const requiredInputs = REQUIRED_DOCS_SYNC_INPUTS.map(normalizePathText);
  const diagnostics = asObject(record.diagnostics);
  const checks = asArray(record.checks || record.check_runs);
  const inputs = asArray(record.inputs);
  const inputStability = asObject(record.input_stability || record.inputStability);
  const checkStatuses = new Map();
  for (const check of checks) {
    const id = normalizeKey(check.id || check.check_id || check.name);
    if (id) checkStatuses.set(id, compactText(check.status));
  }
  const missingChecks = requiredChecks.filter((id) => !checkStatuses.has(id));
  const failedChecks = requiredChecks.filter((id) => checkStatuses.get(id) === 'failed');
  const incompleteChecks = requiredChecks.filter((id) => {
    const status = checkStatuses.get(id);
    return status && status !== 'passed' && status !== 'failed';
  });
  const coveredInputs = inputs
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizePathText(entry.relative_path || entry.path || entry.file || ''));
  const missingInputHashes = requiredInputs.filter((file) => !coveredInputs.some((entry) => entry === file || entry.endsWith(file)));
  const stabilityChecked = inputStability.checked === true;
  const changedInputHashes = [
    ...asArray(diagnostics.changed_input_hashes || diagnostics.changedInputHashes).map(normalizePathText),
    ...asArray(inputStability.changed_inputs || inputStability.changedInputs)
      .map((entry) => normalizePathText(entry.relative_path || entry.relativePath || entry.path || entry.file || entry))
  ].filter(Boolean);
  const changedInputCount = Number.isFinite(Number(inputStability.changed_input_count ?? inputStability.changedInputCount))
    ? Number(inputStability.changed_input_count ?? inputStability.changedInputCount)
    : changedInputHashes.length;
  const evidence = [evidenceRecord('docs_sync_release_evidence', record, {
    contract_version: record.contractVersion || null,
    required_checks: requiredChecks,
    missing_required_checks: diagnostics.missing_required_checks || missingChecks,
    failed_required_checks: diagnostics.failed_required_checks || failedChecks,
    incomplete_required_checks: diagnostics.incomplete_required_checks || incompleteChecks,
    missing_input_hashes: diagnostics.missing_input_hashes || missingInputHashes,
    input_stability_checked: stabilityChecked,
    changed_input_count: changedInputCount,
    changed_input_hashes: changedInputHashes,
    node_version: record.environment?.node_version || null
  })];
  if (record.contractVersion !== DOCS_SYNC_RELEASE_EVIDENCE_VERSION) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'docs sync evidence contract version is missing or unsupported');
  }
  if (changedInputCount > 0 || changedInputHashes.length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'failed', evidence, 'docs sync inputs changed during checks');
  }
  if (isFailed(record) || failedChecks.length || asArray(diagnostics.failed_required_checks).length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'failed', evidence, 'docs sync checks failed');
  }
  if (!isPassed(record)) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'docs sync release evidence is not passed');
  }
  if (missingChecks.length || asArray(diagnostics.missing_required_checks).length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'missing required docs sync checks');
  }
  if (incompleteChecks.length || asArray(diagnostics.incomplete_required_checks).length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'required docs sync checks are incomplete');
  }
  if (missingInputHashes.length || asArray(diagnostics.missing_input_hashes).length) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'missing required docs sync input hashes');
  }
  if (!stabilityChecked) {
    return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'incomplete', evidence, 'docs sync input stability was not checked');
  }
  return requirement('D1', 'docs, schema snapshots, packet fixtures, and migration notes are synced', 'passed', evidence);
}

function canonicalAblationId(value = '') {
  const key = normalizeKey(value);
  if (['without_claim_spans', 'without_source_spans'].includes(key)) return 'without_claim_graph';
  if (['without_storyline_trace', 'without_storyline'].includes(key)) return 'without_storyline_dag';
  if (['without_counterfactual', 'without_counterfactuals'].includes(key)) return 'without_counterfactual_planner';
  if (['without_openalex_coci', 'without_coci', 'without_openalex'].includes(key)) return 'without_coci_openalex';
  if ([
    'without_link_prediction',
    'without_link_prediction_signals',
    'without_graph_link_prediction',
    'without_bridge_rerank',
    'without_bridge_rerank_signals'
  ].includes(key)) return 'without_link_prediction_signal';
  return key;
}

function ablationAuditFor(entry = {}) {
  return asObject(entry.artifact_removal_audit || entry.artifactRemovalAudit || entry.audit);
}

function ablationAuditResult(entry = {}) {
  const id = canonicalAblationId(entry.ablation_id || entry.id);
  const audit = ablationAuditFor(entry);
  if (!Object.keys(audit).length) {
    return {
      id,
      status: 'missing',
      message: `${id} is missing artifact removal audit`
    };
  }
  const beforeCount = Number(audit.before_count ?? audit.beforeCount);
  const afterCount = Number(audit.after_count ?? audit.afterCount);
  const targetPresentBefore = audit.target_present_before ?? audit.targetPresentBefore;
  const targetRemoved = audit.target_removed ?? audit.targetRemoved;
  if (audit.status === 'failed' || (targetPresentBefore === true && targetRemoved !== true)) {
    return {
      id,
      status: 'failed',
      message: `${id} did not remove its target artifact family`
    };
  }
  if (audit.status !== 'passed' || targetPresentBefore !== true || targetRemoved !== true) {
    return {
      id,
      status: 'incomplete',
      message: `${id} artifact removal audit is not evaluable`
    };
  }
  if (!Number.isFinite(beforeCount) || beforeCount <= 0 || !Number.isFinite(afterCount) || afterCount !== 0) {
    return {
      id,
      status: 'incomplete',
      message: `${id} artifact removal counts are incomplete`
    };
  }
  return {
    id,
    status: 'passed',
    message: ''
  };
}

function ablationEffectFor(entry = {}) {
  return asObject(entry.ablation_effect_audit || entry.ablationEffectAudit || entry.effect_audit || entry.effectAudit);
}

function ablationEffectResult(entry = {}) {
  const id = canonicalAblationId(entry.ablation_id || entry.id);
  const effect = ablationEffectFor(entry);
  if (!Object.keys(effect).length) {
    return {
      id,
      status: 'missing',
      message: `${id} is missing ablation effect audit`
    };
  }
  if (ABLATION_EFFECT_REQUIRED_IDS.has(id) && effect.effect_required !== true) {
    return {
      id,
      status: 'incomplete',
      message: `${id} requires a measured ablation effect audit`
    };
  }
  if (effect.effect_required === false) {
    return ['structural_only', 'not_required', 'control', 'passed'].includes(effect.status)
      ? { id, status: 'passed', message: '' }
      : {
          id,
          status: 'incomplete',
          message: `${id} structural-only effect audit is not explicit`
        };
  }
  const delta = Number(effect.delta_from_control ?? effect.deltaFromControl);
  const effectObserved = effect.effect_observed ?? effect.effectObserved;
  const relevantGateStatus = compactText(effect.relevant_gate_status || effect.relevantGateStatus);
  if (effect.status === 'failed' || effectObserved === false) {
    return {
      id,
      status: 'failed',
      message: `${id} did not show the expected ablation effect`
    };
  }
  if (effect.status !== 'passed' || effectObserved !== true) {
    return {
      id,
      status: 'incomplete',
      message: `${id} ablation effect audit is not evaluable`
    };
  }
  if (!Number.isFinite(delta) && ['passed', ''].includes(relevantGateStatus)) {
    return {
      id,
      status: 'incomplete',
      message: `${id} ablation effect audit lacks metric delta or gate degradation`
    };
  }
  return {
    id,
    status: 'passed',
    message: ''
  };
}

function ablationLineageIssues(record = {}, required = []) {
  const issues = [];
  if (!hasHashedInputRole(record.inputs, {
    id: 'ablation_benchmark',
    aliases: ['ablation_benchmark', 'benchmark_dataset', 'replay_dataset', 'ablation_dataset']
  })) {
    issues.push('missing_ablation_benchmark_input_hash');
  }
  const ablations = asArray(record.ablations);
  for (const id of required) {
    const entry = ablations.find((item) => canonicalAblationId(item.ablation_id || item.id) === id);
    const reportArtifact = asObject(entry?.report_artifact || entry?.reportArtifact || entry?.report);
    if (!compactText(reportArtifact.sha256 || reportArtifact.hash || reportArtifact.checksum)) {
      issues.push(`${id}:missing_variant_report_hash`);
    }
  }
  return issues;
}

function buildAblationRequirement(records = [], options = {}) {
  if (!records.length) return requirement('AB1', 'required structural ablations are complete', 'incomplete', [], 'missing ablation manifest');
  const scope = normalizeReleaseGateScope(options.releaseScope || options.release_scope || options.scope);
  const required = asArray(options.requiredAblations || options.required_ablations).length
    ? asArray(options.requiredAblations || options.required_ablations).map(canonicalAblationId)
    : defaultRequiredAblationsForScope(scope);
  const record = records.find((entry) => isPassed(entry)) || records[0];
  const ablations = asArray(record.ablations);
  const ablationIds = new Set(ablations.map((entry) => canonicalAblationId(entry.ablation_id || entry.id)).filter(Boolean));
  const missing = required.filter((id) => !ablationIds.has(id));
  const auditResults = required
    .filter((id) => ablationIds.has(id))
    .map((id) => ablationAuditResult(ablations.find((entry) => canonicalAblationId(entry.ablation_id || entry.id) === id)));
  const failedAudits = auditResults.filter((entry) => entry.status === 'failed');
  const incompleteAudits = auditResults.filter((entry) => entry.status !== 'passed' && entry.status !== 'failed');
  const effectResults = required
    .filter((id) => ablationIds.has(id))
    .map((id) => ablationEffectResult(ablations.find((entry) => canonicalAblationId(entry.ablation_id || entry.id) === id)));
  const failedEffects = effectResults.filter((entry) => entry.status === 'failed');
  const incompleteEffects = effectResults.filter((entry) => entry.status !== 'passed' && entry.status !== 'failed');
  const lineageIssues = ablationLineageIssues(record, required);
  const evidence = [evidenceRecord('ablation_manifest', record, {
    ablation_count: ablationIds.size,
    required_ablations: required,
    missing_ablations: missing,
    failed_ablation_audits: failedAudits.map((entry) => entry.id),
    incomplete_ablation_audits: incompleteAudits.map((entry) => entry.id),
    failed_ablation_effect_audits: failedEffects.map((entry) => entry.id),
    incomplete_ablation_effect_audits: incompleteEffects.map((entry) => entry.id),
    ablation_lineage_issues: lineageIssues
  })];
  if (isFailed(record)) return requirement('AB1', 'required structural ablations are complete', 'failed', evidence, 'ablation manifest failed');
  if (!isPassed(record)) return requirement('AB1', 'required structural ablations are complete', 'incomplete', evidence, 'ablation manifest is not passed');
  if (missing.length) return requirement('AB1', 'required structural ablations are complete', 'incomplete', evidence, `missing required ablations: ${missing.join(', ')}`);
  if (lineageIssues.length) {
    return requirement('AB1', 'required structural ablations are complete', 'incomplete', evidence, `ablation manifest is missing hash lineage: ${lineageIssues.join(', ')}`);
  }
  if (failedAudits.length) {
    return requirement('AB1', 'required structural ablations are complete', 'failed', evidence, failedAudits.map((entry) => entry.message).join('; '));
  }
  if (incompleteAudits.length) {
    return requirement('AB1', 'required structural ablations are complete', 'incomplete', evidence, incompleteAudits.map((entry) => entry.message).join('; '));
  }
  if (failedEffects.length) {
    return requirement('AB1', 'required structural ablations are complete', 'failed', evidence, failedEffects.map((entry) => entry.message).join('; '));
  }
  if (incompleteEffects.length) {
    return requirement('AB1', 'required structural ablations are complete', 'incomplete', evidence, incompleteEffects.map((entry) => entry.message).join('; '));
  }
  return requirement('AB1', 'required structural ablations are complete', 'passed', evidence);
}

function buildHumanRequirement(records = []) {
  if (!records.length) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', [], 'missing human blind aggregation');
  const record = records.find((entry) => isPassed(entry)) || records[0];
  const releaseReadiness = asObject(record.releaseReadiness || record.release_readiness);
  const inputs = asArray(record.inputs);
  const inputRoles = inputs
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizeKey(entry.role || entry.kind || entry.name));
  const artifactRoles = asArray(record.blind_review_artifacts || record.blindReviewArtifacts || record.artifact_inputs || record.artifactInputs)
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizeKey(entry.role || entry.kind || entry.name));
  const hasCasesInputHash = inputRoles.some((role) => (
    role === 'human_blind_cases'
    || role === 'human_blind_input_cases'
    || (role.includes('human') && role.includes('case'))
  ));
  const hasLabelsInputHash = inputRoles.some((role) => (
    role === 'human_blind_labels'
    || role === 'human_blind_completed_labels'
    || (role.includes('human') && (role.includes('label') || role.includes('review')))
  ));
  const missingInputHashes = [
    ...(hasCasesInputHash ? [] : ['human_blind_cases']),
    ...(hasLabelsInputHash ? [] : ['human_blind_labels'])
  ];
  const requiredArtifactRoles = [
    'human_blind_pack',
    'human_blind_assignments',
    'human_blind_answer_key',
    'human_blind_review_form_schema'
  ];
  const missingArtifactHashes = requiredArtifactRoles.filter((role) => !artifactRoles.includes(role));
  const reviewerProtocol = asObject(record.reviewer_protocol);
  const assignmentProtocol = asObject(record.assignment_protocol || record.assignmentProtocol);
  const reviewFormProtocol = asObject(record.review_form_protocol || record.reviewFormProtocol);
  const comparisonProtocol = asObject(record.comparison_protocol || record.comparisonProtocol);
  const blindingProtocol = asObject(record.blinding_protocol || record.blindingProtocol);
  const blindingPayloadPolicy = compactText(blindingProtocol.payload_policy || blindingProtocol.payloadPolicy);
  const unexpectedPublicPayloadFields = asArray(
    blindingProtocol.unexpected_public_payload_fields || blindingProtocol.unexpectedPublicPayloadFields
  ).map(compactText).filter(Boolean);
  const targetPreferenceRate = Number(record.target_preference_rate ?? record.targetPreferenceRate);
  const preferenceThreshold = Number(record.preference_threshold ?? record.preferenceThreshold);
  const targetPairCount = Math.max(
    Number(reviewerProtocol.target_pair_count || reviewerProtocol.targetPairCount || 0),
    Number(comparisonProtocol.target_pair_count || comparisonProtocol.targetPairCount || 0)
  );
  const reviewerProtocolPairs = asArray(reviewerProtocol.pairs);
  const pairsWithoutIndependentReviewers = reviewerProtocolPairs
    .filter((entry) => entry.independent_reviewers !== true)
    .map((entry) => compactText(entry.pair_id))
    .filter(Boolean);
  const duplicateReviewerIds = [...new Set(reviewerProtocolPairs
    .flatMap((entry) => asArray(entry.duplicate_reviewer_ids))
    .map(compactText)
    .filter(Boolean))].sort();
  const evidence = [evidenceRecord('human_blind_aggregation', record, {
    target_preference_rate: record.target_preference_rate ?? null,
    valid_human_target_pair_count: record.label_counts?.valid_human_target_pair ?? null,
    excluded_non_human_count: record.label_counts?.excluded_non_human ?? null,
    preference_threshold: Number.isFinite(preferenceThreshold) ? preferenceThreshold : null,
    target_pair_count: Number.isFinite(targetPairCount) ? targetPairCount : null,
    sufficient_reviewers: Boolean(reviewerProtocol.sufficient_reviewers),
    independent_reviewers: reviewerProtocol.independent_reviewers === true,
    pairs_without_independent_reviewers: pairsWithoutIndependentReviewers,
    duplicate_reviewer_ids: duplicateReviewerIds,
    assignment_coverage_complete: assignmentProtocol.complete ?? null,
    target_pair_assignment_count: assignmentProtocol.target_pair_assignment_count ?? assignmentProtocol.targetPairAssignmentCount ?? null,
    required_target_pair_assignment_count: assignmentProtocol.required_target_pair_assignment_count ?? assignmentProtocol.requiredTargetPairAssignmentCount ?? null,
    completed_assignment_count: assignmentProtocol.completed_assignment_count ?? assignmentProtocol.completedAssignmentCount ?? null,
    missing_assignment_id_label_count: assignmentProtocol.missing_assignment_id_label_count ?? assignmentProtocol.missingAssignmentIdLabelCount ?? null,
    invalid_assignment_label_count: assignmentProtocol.invalid_assignment_label_count ?? assignmentProtocol.invalidAssignmentLabelCount ?? null,
    duplicate_assignment_ids: asArray(assignmentProtocol.duplicate_assignment_ids || assignmentProtocol.duplicateAssignmentIds),
    missing_required_assignments: asArray(assignmentProtocol.missing_required_assignments || assignmentProtocol.missingRequiredAssignments),
    release_readiness_status: releaseReadiness.status || null,
    release_candidate: releaseReadiness.releaseCandidate ?? null,
    review_form_complete: reviewFormProtocol.complete ?? null,
    comparison_coverage_complete: comparisonProtocol.complete ?? null,
    blinding_protocol_complete: blindingProtocol.complete ?? null,
    blinding_payload_policy: blindingPayloadPolicy || null,
    blinding_missing_public_artifacts: asArray(blindingProtocol.missing_public_artifacts || blindingProtocol.missingPublicArtifacts),
    blinding_forbidden_public_fields: asArray(blindingProtocol.forbidden_public_fields || blindingProtocol.forbiddenPublicFields),
    blinding_unexpected_public_payload_fields: unexpectedPublicPayloadFields,
    blinding_answer_key_private: blindingProtocol.answer_key_private ?? blindingProtocol.answerKeyPrivate ?? null,
    required_comparison_families: asArray(comparisonProtocol.required_comparison_families),
    covered_comparison_families: asArray(comparisonProtocol.covered_comparison_families),
    missing_comparison_families: asArray(comparisonProtocol.missing_comparison_families),
    missing_input_hashes: missingInputHashes,
    missing_blind_artifact_hashes: missingArtifactHashes
  })];
  if (isFailed(record)) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'failed', evidence, 'human blind aggregation failed');
  if (!isPassed(record)) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind aggregation is not passed');
  if (!reviewerProtocol.sufficient_reviewers) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human reviewer role counts are insufficient');
  if (reviewerProtocol.independent_reviewers !== true) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human reviewer identities are not independent');
  if (Number(record.label_counts?.valid_human_target_pair || 0) <= 0) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing independent human labels');
  if (missingInputHashes.length) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind input hashes');
  if (missingArtifactHashes.length) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind artifact hashes');
  if (!Object.keys(releaseReadiness).length) return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind release readiness preflight');
  if (releaseReadiness.status !== 'ready_for_release_gate' || releaseReadiness.releaseCandidate !== true) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, `human blind release readiness is ${releaseReadiness.status || 'incomplete'}`);
  }
  const readinessChecks = asArray(releaseReadiness.checks);
  const assignmentCoverageCheck = readinessChecks.find((entry) => normalizeKey(entry.name) === 'assignment_coverage_satisfied');
  if (!assignmentCoverageCheck) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind assignment coverage check');
  }
  if (assignmentCoverageCheck.status !== 'passed' || assignmentCoverageCheck.ok !== true || assignmentProtocol.complete !== true) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind assignment coverage is not satisfied');
  }
  const formCompletenessCheck = readinessChecks.find((entry) => normalizeKey(entry.name) === 'review_form_completeness_satisfied');
  if (!formCompletenessCheck) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind review form completeness check');
  }
  if (formCompletenessCheck.status !== 'passed' || formCompletenessCheck.ok !== true || reviewFormProtocol.complete !== true) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind review form completeness is not satisfied');
  }
  const comparisonCoverageCheck = readinessChecks.find((entry) => normalizeKey(entry.name) === 'comparison_coverage_satisfied');
  if (!comparisonCoverageCheck) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind comparison coverage check');
  }
  if (comparisonCoverageCheck.status !== 'passed' || comparisonCoverageCheck.ok !== true || comparisonProtocol.complete !== true) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind comparison coverage is not satisfied');
  }
  const blindingCheck = readinessChecks.find((entry) => normalizeKey(entry.name) === 'blinding_protocol_satisfied');
  if (!blindingCheck) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing human blind blinding protocol check');
  }
  if (blindingCheck.status !== 'passed' || blindingCheck.ok !== true || blindingProtocol.complete !== true) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind blinding protocol is not satisfied');
  }
  if (normalizeKey(blindingPayloadPolicy) !== HUMAN_BLIND_PAYLOAD_POLICY) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind payload policy is not satisfied');
  }
  if (unexpectedPublicPayloadFields.length) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind public payload exposes unexpected fields');
  }
  const readinessByName = new Map(readinessChecks.map((entry) => [normalizeKey(entry.name), entry]));
  const missingReadinessChecks = HUMAN_REQUIRED_READINESS_CHECKS.filter((name) => !readinessByName.has(normalizeKey(name)));
  if (missingReadinessChecks.length) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, `missing human blind release readiness checks: ${missingReadinessChecks.join(', ')}`);
  }
  const incompleteReadinessChecks = HUMAN_REQUIRED_READINESS_CHECKS.filter((name) => {
    const entry = readinessByName.get(normalizeKey(name));
    return entry.status !== 'passed' || entry.ok !== true;
  });
  if (incompleteReadinessChecks.length) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, `human blind release readiness checks are not passed: ${incompleteReadinessChecks.join(', ')}`);
  }
  if (!Number.isFinite(targetPreferenceRate) || !Number.isFinite(preferenceThreshold) || targetPreferenceRate < preferenceThreshold) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'human blind target preference threshold is not satisfied');
  }
  if (!Number.isFinite(targetPairCount) || targetPairCount <= 0) {
    return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'incomplete', evidence, 'missing target-system blind pairs');
  }
  return requirement('E7', 'human expert blind pairwise preference passes 60 percent threshold', 'passed', evidence);
}

function manifestStatus(requirements = []) {
  if (requirements.some((entry) => entry.status === 'failed')) return 'failed';
  if (requirements.some((entry) => entry.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

export function buildIdeaCatalystReleaseGateManifest(params = {}) {
  const releaseScope = normalizeReleaseGateScope(params.releaseScope || params.release_scope || params.scope);
  const replayRecords = replaySuites(params);
  const ablationRecords = ablationManifests(params);
  const humanRecords = humanAggregations(params);
  const graphRecords = graphReasoningReports(params);
  const graphLinkRecords = graphLinkPredictionReports(params);
  const scientificEmbeddingRecords = scientificEmbeddingEvidenceReports(params);
  const innovationSidecarRecords = innovationSidecarEvidenceReports(params);
  const ingestionGraphMutationRecords = ingestionGraphMutationExecutionReports(params);
  const engineeringRecords = engineeringEvidenceReports(params);
  const docsSyncRecords = docsSyncEvidenceReports(params);
  const releaseEvidenceInputs = evidenceInputRecords(params);
  const generatedAt = compactText(params.generatedAt || params.generated_at) || new Date().toISOString();
  const runId = compactText(params.runId || params.run_id)
    || `idea-catalyst-release-gate-${stableHash(`${generatedAt}:${replayRecords.length}:${humanRecords.length}`, 10)}`;
  const allRequirements = [
    ...buildReplayRequirements(replayRecords, params),
    buildGraphReasoningRequirement(graphRecords, params),
    buildIngestionGraphMutationRequirement(ingestionGraphMutationRecords, params),
    buildScientificEmbeddingRequirement(scientificEmbeddingRecords, params),
    ...buildInnovationSidecarRequirements(innovationSidecarRecords, params),
    buildGraphLinkPredictionRequirement(graphLinkRecords, params),
    buildEngineeringRequirement(engineeringRecords),
    buildDocsSyncRequirement(docsSyncRecords),
    buildHumanRequirement(humanRecords),
    buildAblationRequirement(ablationRecords, { ...params, releaseScope })
  ];
  const requirements = releaseScope === 'p0_p1'
    ? allRequirements.filter((entry) => !P0_P1_EXCLUDED_REQUIREMENT_IDS.has(entry.id))
    : allRequirements;
  const status = manifestStatus(requirements);
  return {
    contractVersion: IDEA_CATALYST_RELEASE_GATE_VERSION,
    runId,
    generatedAt,
    releaseScope,
    status,
    summary: {
      passed: requirements.filter((entry) => entry.status === 'passed').length,
      failed: requirements.filter((entry) => entry.status === 'failed').length,
      incomplete: requirements.filter((entry) => entry.status === 'incomplete').length,
      requirement_count: requirements.length,
      evidence_input_count: releaseEvidenceInputs.length,
      evidence_input_hash_count: releaseEvidenceInputs.filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum)).length,
      release_pass: status === 'passed'
    },
    evidence_counts: {
      replay_suite_manifests: replayRecords.length,
      ablation_manifests: ablationRecords.length,
      human_blind_aggregations: humanRecords.length,
      graph_reasoning_reports: graphRecords.length,
      ingestion_graph_mutation_execution_reports: ingestionGraphMutationRecords.length,
      scientific_embedding_evidence_reports: scientificEmbeddingRecords.length,
      innovation_sidecar_evidence_reports: innovationSidecarRecords.length,
      graph_link_prediction_reports: graphLinkRecords.length,
      engineering_evidence_reports: engineeringRecords.length,
      docs_sync_evidence_reports: docsSyncRecords.length
    },
    evidence_inputs: releaseEvidenceInputs,
    requirements
  };
}

export function renderIdeaCatalystReleaseGateReport(manifest = {}) {
  const lines = [
    `# Idea-Catalyst Release Gate: ${manifest.runId || 'run'}`,
    '',
    `Status: ${manifest.status || 'unknown'}`,
    '',
    '## Requirements',
    '',
    '| ID | Requirement | Status | Message |',
    '|---|---|---:|---|'
  ];
  for (const entry of asArray(manifest.requirements)) {
    lines.push(`| ${entry.id} | ${entry.label} | ${entry.status} | ${entry.message || ''} |`);
  }
  lines.push('', '## Evidence Counts', '');
  for (const [key, value] of Object.entries(asObject(manifest.evidence_counts))) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('', '## Evidence Inputs', '');
  const evidenceInputs = asArray(manifest.evidence_inputs);
  if (!evidenceInputs.length) {
    lines.push('- none recorded');
  } else {
    for (const input of evidenceInputs) {
      lines.push(`- ${input.role || 'evidence_report'}: ${input.path || 'unknown'} (${input.sha256 || 'missing-sha256'})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function resolvePath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readEvidenceJsonList(paths = [], role = 'evidence_report') {
  const records = [];
  const inputs = [];
  for (const filePath of asArray(paths).map(resolvePath).filter(Boolean)) {
    const record = await readJson(filePath, {});
    records.push(record);
    inputs.push({
      role,
      path: filePath,
      sha256: await sha256File(filePath),
      contract_version: record.contractVersion || null,
      run_id: compactText(record.runId || record.run_id),
      status: compactText(record.status || 'unknown')
    });
  }
  return { records, inputs };
}

export async function prepareIdeaCatalystReleaseGateManifest(params = {}) {
  const replaySuiteFileRecords = await readEvidenceJsonList(params.replaySuiteManifestPaths || params.replay_suite_manifest_paths, 'replay_suite_manifest');
  const replaySuiteManifests = [
    ...replaySuites(params),
    ...replaySuiteFileRecords.records
  ];
  const ablationFileRecords = await readEvidenceJsonList(params.ablationManifestPaths || params.ablation_manifest_paths, 'ablation_manifest');
  const ablationManifestRecords = [
    ...ablationManifests(params),
    ...ablationFileRecords.records
  ];
  const humanAggregationFileRecords = await readEvidenceJsonList(params.humanAggregationPaths || params.human_aggregation_paths, 'human_blind_aggregation');
  const humanAggregationRecords = [
    ...humanAggregations(params),
    ...humanAggregationFileRecords.records
  ];
  const graphReasoningFileRecords = await readEvidenceJsonList(params.graphReasoningReportPaths || params.graph_reasoning_report_paths, 'graph_reasoning_report');
  const graphReasoningRecords = [
    ...graphReasoningReports(params),
    ...graphReasoningFileRecords.records
  ];
  const graphLinkPredictionFileRecords = await readEvidenceJsonList(params.graphLinkPredictionReportPaths || params.graph_link_prediction_report_paths, 'graph_link_prediction_report');
  const graphLinkPredictionRecords = [
    ...graphLinkPredictionReports(params),
    ...graphLinkPredictionFileRecords.records
  ];
  const scientificEmbeddingEvidenceFileRecords = await readEvidenceJsonList(params.scientificEmbeddingEvidencePaths || params.scientific_embedding_evidence_paths, 'scientific_embedding_release_evidence');
  const scientificEmbeddingEvidenceRecords = [
    ...scientificEmbeddingEvidenceReports(params),
    ...scientificEmbeddingEvidenceFileRecords.records
  ];
  const innovationSidecarEvidenceFileRecords = await readEvidenceJsonList(params.innovationSidecarEvidencePaths || params.innovation_sidecar_evidence_paths, 'innovation_sidecar_release_evidence');
  const innovationSidecarEvidenceRecords = [
    ...innovationSidecarEvidenceReports(params),
    ...innovationSidecarEvidenceFileRecords.records
  ];
  const ingestionGraphMutationExecutionFileRecords = await readEvidenceJsonList(params.ingestionGraphMutationExecutionPaths || params.ingestion_graph_mutation_execution_paths, 'ingestion_graph_mutation_execution');
  const ingestionGraphMutationExecutionRecords = [
    ...ingestionGraphMutationExecutionReports(params),
    ...ingestionGraphMutationExecutionFileRecords.records
  ];
  const engineeringEvidenceFileRecords = await readEvidenceJsonList(params.engineeringEvidencePaths || params.engineering_evidence_paths, 'engineering_release_evidence');
  const engineeringEvidenceRecords = [
    ...engineeringEvidenceReports(params),
    ...engineeringEvidenceFileRecords.records
  ];
  const docsSyncEvidenceFileRecords = await readEvidenceJsonList(params.docsSyncEvidencePaths || params.docs_sync_evidence_paths, 'docs_sync_release_evidence');
  const docsSyncEvidenceRecords = [
    ...docsSyncEvidenceReports(params),
    ...docsSyncEvidenceFileRecords.records
  ];
  const releaseEvidenceInputs = [
    ...evidenceInputRecords(params),
    ...replaySuiteFileRecords.inputs,
    ...ablationFileRecords.inputs,
    ...humanAggregationFileRecords.inputs,
    ...graphReasoningFileRecords.inputs,
    ...graphLinkPredictionFileRecords.inputs,
    ...scientificEmbeddingEvidenceFileRecords.inputs,
    ...innovationSidecarEvidenceFileRecords.inputs,
    ...ingestionGraphMutationExecutionFileRecords.inputs,
    ...engineeringEvidenceFileRecords.inputs,
    ...docsSyncEvidenceFileRecords.inputs
  ];
  const manifest = buildIdeaCatalystReleaseGateManifest({
    ...params,
    replaySuites: replaySuiteManifests,
    ablationManifests: ablationManifestRecords,
    humanAggregations: humanAggregationRecords,
    graphReasoningReports: graphReasoningRecords,
    graphLinkPredictionReports: graphLinkPredictionRecords,
    scientificEmbeddingEvidenceReports: scientificEmbeddingEvidenceRecords,
    innovationSidecarEvidenceReports: innovationSidecarEvidenceRecords,
    ingestionGraphMutationExecutionReports: ingestionGraphMutationExecutionRecords,
    engineeringEvidenceReports: engineeringEvidenceRecords,
    docsSyncEvidenceReports: docsSyncEvidenceRecords,
    evidenceInputs: releaseEvidenceInputs
  });
  const outputDir = resolvePath(params.outputDir || params.output_dir);
  if (outputDir) {
    await ensureDir(outputDir);
    manifest.artifacts = {
      outputDir,
      manifestPath: path.join(outputDir, 'release-gate-manifest.json'),
      reportMarkdownPath: path.join(outputDir, 'release-gate-report.md')
    };
    await writeJson(manifest.artifacts.manifestPath, manifest);
    await writeText(manifest.artifacts.reportMarkdownPath, renderIdeaCatalystReleaseGateReport(manifest));
  }
  return manifest;
}
