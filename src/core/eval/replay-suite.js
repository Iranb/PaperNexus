import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import { adaptIdeaCatalystReplayBenchmark, IDEA_CATALYST_REPLAY_ADAPTER_VERSION } from './replay-adapters.js';
import {
  IDEA_CATALYST_HISTORICAL_REPLAY_VERSION,
  runIdeaCatalystHistoricalReplay
} from './historical-replay.js';

export const IDEA_CATALYST_REPLAY_SUITE_VERSION = 'idea-catalyst-replay-suite-v1';

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test)\b/i;
const REPLAY_RELEASE_MINIMUMS = {
  primaryCutoff: 20,
  mustCiteRecallAtKImprovement: 0.1,
  noveltyImprovement: 0.08,
  claimGroundingF1Improvement: 0.1,
  unsupportedClaimRateReduction: 0,
  historicalReplayImprovement: 0,
  minMajorMetricImprovements: 3,
  minPositiveMajorMetricThresholds: 3
};
const SIGNIFICANCE_P_VALUE_MAX = 0.05;
const SIGNIFICANCE_MIN_SAMPLE_SIZE = 2;
const SIGNIFICANCE_TEST_PATTERN = /\b(paired|bootstrap|wilcoxon|signed[-_ ]?rank|permutation|randomi[sz]ation|mcnemar|sign[-_ ]?test|confidence[-_ ]?interval)\b/i;
const SIGNIFICANCE_METRIC_GROUPS = [
  {
    id: 'must_cite_recall_at_k_improvement',
    families: ['must_cite'],
    aliases: ['must_cite_recall_at_k_improvement', 'must_cite_recall_at_20_improvement', 'recall_at_20_improvement', 'recall20_improvement']
  },
  {
    id: 'novelty_score_improvement',
    families: ['novelty'],
    aliases: ['novelty_score_improvement', 'novelty_improvement', 'novelty_lift']
  },
  {
    id: 'claim_grounding_f1_improvement',
    families: ['claim_grounding'],
    aliases: ['claim_grounding_f1_improvement', 'claim_evidence_f1_improvement', 'claim_f1_improvement']
  },
  {
    id: 'unsupported_claim_rate_reduction',
    families: ['claim_grounding'],
    aliases: ['unsupported_claim_rate_reduction', 'unsupported_rate_reduction', 'unsupported_claim_reduction']
  },
  {
    id: 'storyline_trace_coverage_improvement',
    families: ['historical_replay'],
    aliases: ['storyline_trace_coverage_improvement', 'storyline_coherence_improvement', 'story_coherence_improvement']
  },
  {
    id: 'historical_score_improvement',
    families: ['historical_replay'],
    aliases: ['historical_score_improvement', 'historical_replay_improvement', 'future_match_improvement', 'review_preference_improvement']
  },
  {
    id: 'expert_preference_improvement',
    families: ['historical_replay'],
    aliases: ['expert_preference_improvement', 'reviewer_preference_improvement', 'human_preference_improvement']
  }
];
const SIGNIFICANCE_MAJOR_METRIC_IDS = new Set([
  'must_cite_recall_at_k_improvement',
  'novelty_score_improvement',
  'claim_grounding_f1_improvement',
  'unsupported_claim_rate_reduction',
  'storyline_trace_coverage_improvement',
  'historical_score_improvement',
  'expert_preference_improvement'
]);
const SEMANTIC_NEGATIVE_CATEGORIES = [
  {
    id: 'baseline_missing_citation',
    aliases: ['baseline_missing_citation', 'missing_citation', 'missing_must_cite', 'must_cite_omission', 'baseline_omitted_citation']
  },
  {
    id: 'year_leakage',
    aliases: ['year_leakage', 'future_leakage', 'temporal_leakage', 'year_crossing', 'time_cutoff_violation']
  },
  {
    id: 'claim_evidence_swap',
    aliases: ['claim_evidence_swap', 'claim_evidence_exchange', 'claim_evidence_mismatch', 'swapped_evidence', 'evidence_swap']
  },
  {
    id: 'source_domain_mismatch',
    aliases: ['source_domain_mismatch', 'domain_mismatch', 'source_mismatch', 'domain_shift_mismatch']
  },
  {
    id: 'storyline_order_shuffle',
    aliases: ['storyline_order_shuffle', 'storyline_shuffle', 'story_order_shuffle', 'dag_order_shuffle', 'storyline_order_mismatch']
  },
  {
    id: 'terminology_only_novelty',
    aliases: ['terminology_only_novelty', 'term_swap_only', 'renaming_only', 'surface_novelty', 'terminology_swap']
  },
  {
    id: 'contribution_result_decoupling',
    aliases: ['contribution_result_decoupling', 'contribution_result_mismatch', 'claim_result_decoupling', 'experiment_result_decoupling']
  },
  {
    id: 'review_concern_false_resolution',
    aliases: ['review_concern_false_resolution', 'false_review_concern_resolution', 'concern_falsely_resolved', 'incorrect_concern_resolution']
  }
];
const SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS = SEMANTIC_NEGATIVE_CATEGORIES.map((entry) => entry.id);

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

function firstDefined(...values) {
  return values.find((value) => {
    if (value === undefined || value === null) return false;
    return !(typeof value === 'string' && !value.trim());
  });
}

function normalizeKey(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function isNonEmptyStructured(value) {
  return Array.isArray(value) ? value.length > 0 : isNonEmptyObject(value);
}

function isPositiveCount(value) {
  if (typeof value === 'boolean') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0;
  return value !== undefined && value !== null && compactText(value) !== '';
}

function resolveOptionalPath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function readOptionalJson(filePath = '') {
  const absolutePath = resolveOptionalPath(filePath);
  return absolutePath ? readJson(absolutePath, {}) : {};
}

async function hashFile(absolutePath = '') {
  if (!absolutePath) return null;
  const data = await fs.readFile(absolutePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileInputRecord(role, filePath = '') {
  const absolutePath = resolveOptionalPath(filePath);
  if (!absolutePath) return null;
  const [stats, sha256] = await Promise.all([
    fs.stat(absolutePath),
    hashFile(absolutePath)
  ]);
  return {
    role,
    path: absolutePath,
    size_bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    sha256
  };
}

function countCases(cases = [], predicate) {
  return cases.filter(predicate).length;
}

function semanticNegativeCategoryId(value = '') {
  const key = normalizeKey(value);
  if (!key) return null;
  for (const category of SEMANTIC_NEGATIVE_CATEGORIES) {
    const aliases = [category.id, ...category.aliases].map(normalizeKey);
    if (aliases.some((alias) => key === alias || key.includes(alias))) return category.id;
  }
  return null;
}

function semanticNegativeCategoriesFromObject(value = {}) {
  const raw = asObject(value);
  const categoryValues = [
    raw.category,
    raw.type,
    raw.kind,
    raw.negative_type,
    raw.negativeType,
    raw.failure_mode,
    raw.failureMode,
    raw.failure_type,
    raw.failureType,
    raw.id,
    raw.name,
    ...asArray(raw.categories),
    ...asArray(raw.types),
    ...asArray(raw.negative_types || raw.negativeTypes),
    ...asArray(raw.failure_modes || raw.failureModes),
    ...asArray(raw.failure_types || raw.failureTypes)
  ];
  const direct = categoryValues.map(semanticNegativeCategoryId).filter(Boolean);
  const keyed = Object.entries(raw)
    .filter(([, child]) => isPositiveCount(child))
    .map(([key]) => semanticNegativeCategoryId(key))
    .filter(Boolean);
  return [...new Set([...direct, ...keyed])];
}

function semanticNegativeMultiStep(value = {}) {
  const raw = asObject(value);
  const explicit = raw.multi_step_failure
    ?? raw.multiStepFailure
    ?? raw.multi_step
    ?? raw.multiStep
    ?? raw.multi_stage_failure
    ?? raw.multiStageFailure;
  if (explicit !== undefined) return Boolean(explicit);
  const text = policyText([
    raw.category,
    raw.type,
    raw.kind,
    raw.failure_mode,
    raw.failureMode,
    raw.description,
    raw.rationale,
    raw.name,
    raw.id
  ]);
  return /multi[-_ ]?step|multi[-_ ]?stage|workflow|long[-_ ]?chain/.test(text);
}

function collectSemanticNegativeEntries(value) {
  if (Array.isArray(value)) return value.flatMap(collectSemanticNegativeEntries);
  if (!isNonEmptyObject(value)) return [];
  const categories = semanticNegativeCategoriesFromObject(value);
  const entries = categories.map((category) => ({
    category,
    multi_step_failure: semanticNegativeMultiStep(value)
  }));
  const nestedKeys = [
    'semantic_negative_cases',
    'semanticNegativeCases',
    'semantic_negatives',
    'semanticNegatives',
    'negative_cases',
    'negativeCases',
    'adversarial_cases',
    'adversarialCases',
    'cases',
    'examples',
    'items'
  ];
  const nested = nestedKeys.flatMap((key) => collectSemanticNegativeEntries(value[key]));
  return [...entries, ...nested];
}

function collectReplaySemanticNegativeEntries(replay = {}) {
  const containers = [
    replay.semantic_negative_cases,
    replay.semanticNegativeCases,
    replay.semantic_negatives,
    replay.semanticNegatives,
    replay.negative_cases,
    replay.negativeCases,
    replay.adversarial_cases,
    replay.adversarialCases,
    replay.metadata?.semantic_negative_cases,
    replay.metadata?.semanticNegativeCases,
    replay.dataset?.semantic_negative_cases,
    replay.dataset?.semanticNegativeCases,
    ...asArray(replay.cases).flatMap((caseInput) => [
      caseInput.semantic_negative_cases,
      caseInput.semanticNegativeCases,
      caseInput.semantic_negatives,
      caseInput.semanticNegatives,
      caseInput.negative_cases,
      caseInput.negativeCases,
      caseInput.adversarial_cases,
      caseInput.adversarialCases,
      caseInput.gold?.semantic_negative_cases,
      caseInput.gold?.semanticNegativeCases,
      caseInput.gold?.semantic_negatives,
      caseInput.gold?.semanticNegatives
    ])
  ];
  return containers.flatMap(collectSemanticNegativeEntries);
}

function semanticNegativeCoverageFromEntries(entries = []) {
  const counts = Object.fromEntries(SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS.map((id) => [id, 0]));
  for (const entry of entries) {
    if (counts[entry.category] !== undefined) counts[entry.category] += 1;
  }
  const covered = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([category]) => category);
  const missing = SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS.filter((category) => !covered.includes(category));
  const multiStepFailureCount = entries.filter((entry) => entry.multi_step_failure).length;
  return {
    status: missing.length || multiStepFailureCount <= 0 ? 'incomplete' : 'passed',
    required_categories: SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS,
    covered_categories: covered,
    missing_categories: missing,
    category_counts: counts,
    semantic_negative_case_count: entries.length,
    multi_step_failure_count: multiStepFailureCount
  };
}

function semanticNegativeCoverageFromDiagnostics(diagnostics = {}) {
  const coverage = asObject(diagnostics.semantic_negative_coverage || diagnostics.semanticNegativeCoverage);
  if (!Object.keys(coverage).length) return null;
  return {
    status: compactText(coverage.status || (asArray(coverage.missing_categories).length ? 'incomplete' : 'passed')) || 'incomplete',
    required_categories: asArray(coverage.required_categories || coverage.requiredCategories),
    covered_categories: asArray(coverage.covered_categories || coverage.coveredCategories),
    missing_categories: asArray(coverage.missing_categories || coverage.missingCategories),
    category_counts: asObject(coverage.category_counts || coverage.categoryCounts),
    semantic_negative_case_count: Number(coverage.semantic_negative_case_count ?? coverage.semanticNegativeCaseCount ?? 0),
    multi_step_failure_count: Number(coverage.multi_step_failure_count ?? coverage.multiStepFailureCount ?? 0)
  };
}

function semanticNegativeCoverageAudit(record = {}) {
  const diagnosticCoverage = semanticNegativeCoverageFromDiagnostics(asObject(record.diagnostics));
  if (diagnosticCoverage) {
    const missing = SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS.filter((category) => !asArray(diagnosticCoverage.covered_categories).includes(category));
    return {
      ...diagnosticCoverage,
      status: missing.length || Number(diagnosticCoverage.multi_step_failure_count || 0) <= 0 ? 'incomplete' : 'passed',
      required_categories: SEMANTIC_NEGATIVE_REQUIRED_CATEGORY_IDS,
      missing_categories: missing
    };
  }
  const dataset = asObject(record.dataset);
  const metadata = asObject(record.metadata);
  const entries = [
    record.semantic_negative_cases,
    record.semanticNegativeCases,
    record.semantic_negatives,
    record.semanticNegatives,
    record.negative_cases,
    record.negativeCases,
    record.adversarial_cases,
    record.adversarialCases,
    dataset.semantic_negative_cases,
    dataset.semanticNegativeCases,
    dataset.semantic_negatives,
    dataset.semanticNegatives,
    dataset.negative_cases,
    dataset.negativeCases,
    metadata.semantic_negative_cases,
    metadata.semanticNegativeCases,
    metadata.semantic_negatives,
    metadata.semanticNegatives
  ].flatMap(collectSemanticNegativeEntries);
  return semanticNegativeCoverageFromEntries(entries);
}

function caseHasAnyGold(caseInput = {}) {
  const gold = asObject(caseInput.gold);
  return asArray(gold.must_cite_set).length > 0
    || asArray(gold.claims).length > 0
    || isNonEmptyObject(gold.novelty_certificate);
}

export function diagnoseIdeaCatalystReplaySuite(replay = {}) {
  const cases = asArray(replay.cases);
  const semanticNegativeCoverage = semanticNegativeCoverageFromEntries(collectReplaySemanticNegativeEntries(replay));
  const missingCandidateCount = countCases(cases, (entry) => !isNonEmptyObject(entry.candidate));
  const missingBaselineCount = countCases(cases, (entry) => !isNonEmptyObject(entry.baseline));
  const missingMustCiteGoldCount = countCases(cases, (entry) => !asArray(entry.gold?.must_cite_set).length);
  const missingClaimGoldCount = countCases(cases, (entry) => !asArray(entry.gold?.claims).length);
  const missingNoveltyGoldCount = countCases(cases, (entry) => !isNonEmptyObject(entry.gold?.novelty_certificate));
  const missingAnyGoldCount = countCases(cases, (entry) => !caseHasAnyGold(entry));
  const missingTimeCutoffCount = countCases(cases, (entry) => !Number.isFinite(Number(entry.timeCutoff ?? entry.time_cutoff)));
  const messages = [];

  if (!cases.length) {
    messages.push({
      severity: 'error',
      code: 'no_replay_cases',
      message: 'Replay suite has no cases after adapter normalization.'
    });
  }
  if (missingCandidateCount > 0) {
    messages.push({
      severity: 'error',
      code: 'missing_candidate_packets',
      message: `${missingCandidateCount} replay case(s) are missing candidate Idea-Catalyst packets.`
    });
  }
  if (missingBaselineCount > 0) {
    messages.push({
      severity: 'error',
      code: 'missing_baseline_packets',
      message: `${missingBaselineCount} replay case(s) are missing live-discovery baseline packets.`
    });
  }
  if (missingAnyGoldCount > 0) {
    messages.push({
      severity: 'error',
      code: 'missing_gold_labels',
      message: `${missingAnyGoldCount} replay case(s) have no must-cite, novelty, or claim-grounding gold labels.`
    });
  }
  if (missingTimeCutoffCount > 0) {
    messages.push({
      severity: 'warning',
      code: 'missing_time_cutoff',
      message: `${missingTimeCutoffCount} replay case(s) do not declare a strict historical time cutoff.`
    });
  }
  if (missingMustCiteGoldCount === cases.length && cases.length > 0) {
    messages.push({
      severity: 'warning',
      code: 'no_must_cite_gold',
      message: 'No replay cases contain MasterSet-style must-cite gold labels.'
    });
  }
  if (missingClaimGoldCount === cases.length && cases.length > 0) {
    messages.push({
      severity: 'warning',
      code: 'no_claim_gold',
      message: 'No replay cases contain CLAIM-BENCH/CLAIMCHECK-style claim gold labels.'
    });
  }
  if (missingNoveltyGoldCount === cases.length && cases.length > 0) {
    messages.push({
      severity: 'warning',
      code: 'no_novelty_gold',
      message: 'No replay cases contain NovBench/RINoBench-style novelty gold labels.'
    });
  }

  return {
    case_count: cases.length,
    missing_candidate_packet_count: missingCandidateCount,
    missing_baseline_packet_count: missingBaselineCount,
    missing_gold_must_cite_count: missingMustCiteGoldCount,
    missing_gold_claim_count: missingClaimGoldCount,
    missing_gold_novelty_count: missingNoveltyGoldCount,
    missing_any_gold_label_count: missingAnyGoldCount,
    missing_time_cutoff_count: missingTimeCutoffCount,
    evaluable_must_cite_case_count: cases.length - missingMustCiteGoldCount,
    evaluable_claim_case_count: cases.length - missingClaimGoldCount,
    evaluable_novelty_case_count: cases.length - missingNoveltyGoldCount,
    semantic_negative_coverage: semanticNegativeCoverage,
    message_count: messages.length,
    error_count: messages.filter((entry) => entry.severity === 'error').length,
    warning_count: messages.filter((entry) => entry.severity === 'warning').length,
    messages
  };
}

function suiteStatus(diagnostics = {}, replayReport = {}) {
  if (diagnostics.error_count > 0) return 'incomplete';
  if (replayReport.status === 'passed') return 'passed';
  if (replayReport.status === 'failed') return 'failed';
  return 'incomplete';
}

function gateStatus(gates = [], name = '') {
  const found = asArray(gates).find((entry) => normalizeKey(entry.name) === normalizeKey(name));
  return compactText(found?.status || 'missing') || 'missing';
}

function sourceText(record = {}) {
  const dataset = asObject(record.dataset);
  return [
    dataset.name,
    dataset.format,
    dataset.source,
    dataset.license_scope,
    record.adapter?.format,
    record.name,
    record.format
  ].map(compactText).filter(Boolean).join(' ');
}

function familyMatches(record = {}, patterns = []) {
  const text = sourceText(record).toLowerCase();
  return patterns.some((pattern) => pattern.test(text));
}

function releaseCheck(name, status, message = '', details = {}) {
  return {
    name,
    status,
    ok: status === 'passed',
    message,
    ...details
  };
}

function policyText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return compactText(value).toLowerCase();
  try {
    return compactText(JSON.stringify(value)).toLowerCase();
  } catch {
    return compactText(String(value)).toLowerCase();
  }
}

function policySummary(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return compactText(value) || null;
  try {
    return JSON.stringify(value);
  } catch {
    return compactText(String(value)) || null;
  }
}

function collectPolicyCandidates(record = {}, aliases = []) {
  const dataset = asObject(record.dataset);
  const config = asObject(record.config);
  const metadata = asObject(record.metadata);
  const provenance = asObject(record.provenance);
  const containers = [
    record,
    dataset,
    config,
    metadata,
    provenance,
    asObject(dataset.metadata),
    asObject(dataset.provenance)
  ];
  return containers.flatMap((container) => (
    aliases.map((alias) => container[alias]).filter((value) => value !== undefined && value !== null)
  ));
}

function policyMentionsVenueYearHoldout(value) {
  const text = policyText(value);
  if (!text) return false;
  if (policyNegatesVenueYearHoldout(text)) return false;
  const hasHoldout = /(holdout|held[-_ ]?out|leave[-_ ]?out|split)/.test(text);
  const hasVenue = /(venue|conference|journal)/.test(text);
  const hasYear = /(year|temporal|time[-_ ]?slice|time[-_ ]?cutoff|cutoff)/.test(text);
  return hasHoldout && hasVenue && hasYear;
}

function policyMentionsTimeSlice(value) {
  const text = policyText(value);
  if (!text) return false;
  if (policyNegatesTimeSlice(text)) return false;
  const hasTemporal = /(time[-_ ]?slice|temporal|time[-_ ]?cutoff|cutoff|historical)/.test(text);
  const hasSourceSlice = /(openalex|s2orc|semantic scholar|references?|refs?|citations?|citation[-_ ]?contexts?|corpus|snapshot|slice)/.test(text);
  return hasTemporal && hasSourceSlice;
}

function policyNegatesVenueYearHoldout(text = '') {
  return /\b(no|without|missing|absent|none)\s+(explicit\s+)?(venue[-_ /]?year\s+)?(holdout|held[-_ ]?out|split)\b/.test(text)
    || /\b(holdout|held[-_ ]?out|split)\b.{0,40}\b(disabled|absent|missing|not configured|not used|unavailable)\b/.test(text);
}

function policyNegatesTimeSlice(text = '') {
  return /\b(no|without|missing|absent|none)\s+(explicit\s+|strict\s+|historical\s+)?(time[-_ ]?slice|temporal\s+slice|time[-_ ]?cutoff|cutoff|source\s+snapshot|historical\s+snapshot)\b/.test(text)
    || /\b(time[-_ ]?slice|temporal\s+slice|time[-_ ]?cutoff|cutoff|source\s+snapshot|historical\s+snapshot)\b.{0,40}\b(disabled|absent|missing|not configured|not used|unavailable)\b/.test(text);
}

function releasePolicyEvidence(record = {}) {
  const holdoutCandidates = collectPolicyCandidates(record, [
    'holdout',
    'holdout_policy',
    'holdoutPolicy',
    'venue_year_holdout',
    'venueYearHoldout',
    'venue_year_holdout_policy',
    'venueYearHoldoutPolicy',
    'split',
    'split_policy',
    'splitPolicy'
  ]);
  const timeSliceCandidates = collectPolicyCandidates(record, [
    'time_slice_policy',
    'timeSlicePolicy',
    'temporal_slice_policy',
    'temporalSlicePolicy',
    'historical_slice_policy',
    'historicalSlicePolicy',
    'source_time_slice_policy',
    'sourceTimeSlicePolicy'
  ]);
  const venueYearHoldout = holdoutCandidates.find(policyMentionsVenueYearHoldout);
  const timeSlicePolicy = timeSliceCandidates.find(policyMentionsTimeSlice);
  return {
    venueYearHoldout,
    timeSlicePolicy,
    holdout_candidate_count: holdoutCandidates.length,
    time_slice_candidate_count: timeSliceCandidates.length
  };
}

function numericThreshold(thresholds = {}, name = '') {
  const value = Number(thresholds[name]);
  return Number.isFinite(value) ? value : null;
}

function thresholdAtLeast(thresholds = {}, name = '', minimum = 0) {
  const value = numericThreshold(thresholds, name);
  return value !== null && value >= minimum;
}

function thresholdPositive(thresholds = {}, name = '') {
  const value = numericThreshold(thresholds, name);
  return value !== null && value > 0;
}

function positiveMajorMetricThresholdCount(thresholds = {}) {
  return [
    'mustCiteRecallAtKImprovement',
    'noveltyImprovement',
    'claimGroundingF1Improvement',
    'unsupportedClaimRateReduction',
    'storylineTraceCoverageImprovement',
    'historicalReplayImprovement'
  ].filter((name) => thresholdPositive(thresholds, name)).length;
}

function numericValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function confidenceIntervalLower(entry = {}) {
  const interval = entry.confidence_interval || entry.confidenceInterval || entry.ci;
  if (Array.isArray(interval)) return numericValue(interval[0]);
  const intervalObject = asObject(interval);
  return numericValue(
    entry.confidence_interval_lower,
    entry.confidenceIntervalLower,
    entry.ci_lower,
    entry.ciLower,
    intervalObject.lower,
    intervalObject.low,
    intervalObject[0]
  );
}

function collectStatisticalEntriesFrom(value) {
  if (Array.isArray(value)) return value.flatMap(collectStatisticalEntriesFrom);
  if (!isNonEmptyObject(value)) return [];
  const nestedKeys = new Set([
    'metrics',
    'metric_results',
    'metricResults',
    'tests',
    'statistical_tests',
    'statisticalTests',
    'results',
    'evidence'
  ]);
  const nested = [...nestedKeys].flatMap((key) => collectStatisticalEntriesFrom(value[key]));
  const directMetric = firstDefined(value.metric, value.metric_id, value.metricId, value.metric_name, value.metricName);
  if (directMetric) return [value, ...nested];
  const keyed = Object.entries(value)
    .filter(([key]) => !nestedKeys.has(key))
    .flatMap(([key, entry]) => {
      if (Array.isArray(entry)) {
        return collectStatisticalEntriesFrom(entry).map((item) => ({
          metric: item.metric || item.metric_id || item.metricId || key,
          ...item
        }));
      }
      if (!isNonEmptyObject(entry)) return [];
      return [{
        metric: firstDefined(entry.metric, entry.metric_id, entry.metricId, key),
        ...entry
      }];
    });
  return [...nested, ...keyed];
}

function collectStatisticalEntries(record = {}) {
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
  ].flatMap(collectStatisticalEntriesFrom);
}

function entryMetricKeys(entry = {}) {
  return [
    entry.metric,
    entry.metric_id,
    entry.metricId,
    entry.metric_name,
    entry.metricName,
    entry.name,
    entry.id
  ].map(normalizeKey).filter(Boolean);
}

function entryMatchesMetric(entry = {}, group = {}) {
  const keys = entryMetricKeys(entry);
  const aliases = [group.id, ...asArray(group.aliases)].map(normalizeKey);
  return keys.some((key) => aliases.includes(key));
}

function statisticalEntryVerdict(entry = {}) {
  const testType = compactText(firstDefined(
    entry.test,
    entry.test_type,
    entry.testType,
    entry.method,
    entry.statistical_test,
    entry.statisticalTest
  ));
  const pValue = numericValue(entry.p_value, entry.pValue, entry.p);
  const ciLower = confidenceIntervalLower(entry);
  const effectSize = numericValue(
    entry.effect_size,
    entry.effectSize,
    entry.delta,
    entry.improvement,
    entry.lift,
    entry.estimate,
    entry.mean_delta,
    entry.meanDelta
  );
  const sampleSize = numericValue(
    entry.sample_size,
    entry.sampleSize,
    entry.n,
    entry.case_count,
    entry.caseCount,
    entry.pair_count,
    entry.pairCount,
    entry.paired_sample_count,
    entry.pairedSampleCount
  );
  const hasAcceptedTest = SIGNIFICANCE_TEST_PATTERN.test(testType);
  const hasSignificanceStatistic = (pValue !== null && pValue <= SIGNIFICANCE_P_VALUE_MAX)
    || (ciLower !== null && ciLower > 0);
  const issues = [];
  if (!hasAcceptedTest) issues.push('missing_paired_or_nonparametric_test');
  if (sampleSize === null || sampleSize < SIGNIFICANCE_MIN_SAMPLE_SIZE) issues.push('sample_size_lt_2');
  if (effectSize === null || effectSize <= 0) issues.push('effect_size_not_positive');
  if (!hasSignificanceStatistic) issues.push('p_value_or_ci_not_significant');
  return {
    status: issues.length ? 'incomplete' : 'passed',
    issues,
    test_type: testType || null,
    p_value: pValue,
    confidence_interval_lower: ciLower,
    effect_size: effectSize,
    sample_size: sampleSize
  };
}

function bestStatisticalMetricEvidence(entries = [], group = {}) {
  const matches = entries.filter((entry) => entryMatchesMetric(entry, group));
  const evaluated = matches.map((entry) => ({
    metric: group.id,
    verdict: statisticalEntryVerdict(entry)
  }));
  const passed = evaluated.find((entry) => entry.verdict.status === 'passed');
  return {
    metric: group.id,
    status: passed ? 'passed' : 'incomplete',
    match_count: matches.length,
    best: passed?.verdict || evaluated[0]?.verdict || null
  };
}

function statisticalSignificanceAudit(record = {}, evidenceFamilies = []) {
  const entries = collectStatisticalEntries(record);
  const applicableFamilies = new Set(evidenceFamilies.filter((entry) => entry.applicable).map((entry) => entry.id));
  const requiredMetricGroups = SIGNIFICANCE_METRIC_GROUPS.filter((group) => (
    group.families.some((family) => applicableFamilies.has(family))
    && (group.id !== 'storyline_trace_coverage_improvement' || applicableFamilies.has('historical_replay'))
    && (group.id !== 'expert_preference_improvement' || applicableFamilies.has('historical_replay'))
  ));
  const requiredForFamily = requiredMetricGroups.filter((group) => (
    group.id !== 'storyline_trace_coverage_improvement'
    && group.id !== 'expert_preference_improvement'
  ));
  const metricEvidence = requiredForFamily.map((group) => bestStatisticalMetricEvidence(entries, group));
  const significantMajorMetrics = SIGNIFICANCE_METRIC_GROUPS
    .filter((group) => SIGNIFICANCE_MAJOR_METRIC_IDS.has(group.id))
    .map((group) => bestStatisticalMetricEvidence(entries, group))
    .filter((entry) => entry.status === 'passed')
    .map((entry) => entry.metric);
  const missing = metricEvidence
    .filter((entry) => entry.status !== 'passed')
    .map((entry) => entry.metric);
  if (applicableFamilies.has('historical_replay')
    && significantMajorMetrics.length < REPLAY_RELEASE_MINIMUMS.minMajorMetricImprovements) {
    missing.push('major_metric_significance_count_gte_3');
  }
  return {
    status: missing.length ? 'incomplete' : 'passed',
    missing,
    evidence_entry_count: entries.length,
    required_metrics: requiredForFamily.map((entry) => entry.id),
    metric_evidence: metricEvidence,
    significant_major_metric_count: significantMajorMetrics.length,
    significant_major_metrics: significantMajorMetrics,
    minimums: {
      p_value_max: SIGNIFICANCE_P_VALUE_MAX,
      min_sample_size: SIGNIFICANCE_MIN_SAMPLE_SIZE,
      min_major_metric_significance_count: REPLAY_RELEASE_MINIMUMS.minMajorMetricImprovements
    }
  };
}

function inputRecordWithHash(inputs = [], role = '') {
  return asArray(inputs).find((entry) => (
    normalizeKey(entry.role) === normalizeKey(role)
    && Boolean(compactText(entry.sha256 || entry.hash || entry.checksum))
  )) || null;
}

function statisticalSignificanceProvenanceAudit(record = {}) {
  const provenance = asObject(record.statistical_significance_provenance || record.statisticalSignificanceProvenance);
  const source = normalizeKey(provenance.source);
  const rawDatasetInput = inputRecordWithHash(record.inputs, 'raw_dataset');
  const statisticalInput = inputRecordWithHash(record.inputs, 'statistical_significance');
  const rawDatasetSources = new Set(['raw_dataset', 'raw_input', 'raw_dataset_metadata', 'raw_metadata']);
  if (source === 'statistical_significance_file') {
    return {
      status: statisticalInput ? 'passed' : 'incomplete',
      source,
      audited_by_input_role: statisticalInput ? 'statistical_significance' : null,
      statistical_significance_sha256: statisticalInput?.sha256 || statisticalInput?.hash || statisticalInput?.checksum || null,
      raw_dataset_sha256: rawDatasetInput?.sha256 || rawDatasetInput?.hash || rawDatasetInput?.checksum || null,
      message: statisticalInput ? '' : 'statistical significance file is missing a hashed input record'
    };
  }
  if (rawDatasetSources.has(source)) {
    return {
      status: rawDatasetInput ? 'passed' : 'incomplete',
      source,
      audited_by_input_role: rawDatasetInput ? 'raw_dataset' : null,
      statistical_significance_sha256: statisticalInput?.sha256 || statisticalInput?.hash || statisticalInput?.checksum || null,
      raw_dataset_sha256: rawDatasetInput?.sha256 || rawDatasetInput?.hash || rawDatasetInput?.checksum || null,
      message: rawDatasetInput ? '' : 'raw dataset statistical significance evidence is missing a hashed raw_dataset input record'
    };
  }
  return {
    status: 'incomplete',
    source: source || null,
    audited_by_input_role: null,
    statistical_significance_sha256: statisticalInput?.sha256 || statisticalInput?.hash || statisticalInput?.checksum || null,
    raw_dataset_sha256: rawDatasetInput?.sha256 || rawDatasetInput?.hash || rawDatasetInput?.checksum || null,
    message: source === 'inline_parameter'
      ? 'inline statistical significance evidence is not release-auditable; use @path or embed it in the hashed raw dataset'
      : 'statistical significance evidence provenance is missing'
  };
}

function releaseThresholdAudit(record = {}, evidenceFamilies = []) {
  const thresholds = asObject(record.config?.thresholds);
  const primaryCutoff = Number(record.config?.primaryCutoff ?? record.config?.primary_cutoff);
  const applicableFamilies = new Set(evidenceFamilies.filter((entry) => entry.applicable).map((entry) => entry.id));
  const missing = [];

  if (applicableFamilies.has('must_cite')) {
    if (primaryCutoff !== REPLAY_RELEASE_MINIMUMS.primaryCutoff) {
      missing.push(`must_cite_primary_cutoff_${REPLAY_RELEASE_MINIMUMS.primaryCutoff}`);
    }
    if (!thresholdAtLeast(thresholds, 'mustCiteRecallAtKImprovement', REPLAY_RELEASE_MINIMUMS.mustCiteRecallAtKImprovement)) {
      missing.push('must_cite_recall_at_k_improvement_gte_0_10');
    }
  }
  if (applicableFamilies.has('novelty')
    && !thresholdAtLeast(thresholds, 'noveltyImprovement', REPLAY_RELEASE_MINIMUMS.noveltyImprovement)) {
    missing.push('novelty_improvement_gte_0_08');
  }
  if (applicableFamilies.has('claim_grounding')) {
    if (!thresholdAtLeast(thresholds, 'claimGroundingF1Improvement', REPLAY_RELEASE_MINIMUMS.claimGroundingF1Improvement)) {
      missing.push('claim_grounding_f1_improvement_gte_0_10');
    }
    if (!thresholdPositive(thresholds, 'unsupportedClaimRateReduction')) {
      missing.push('unsupported_claim_rate_reduction_positive');
    }
  }
  if (applicableFamilies.has('historical_replay')
    && !thresholdPositive(thresholds, 'historicalReplayImprovement')) {
    missing.push('historical_replay_improvement_positive');
  }
  const positiveMajorThresholdCount = positiveMajorMetricThresholdCount(thresholds);
  const majorMetricGate = gateStatus(record.gates, 'major_metrics_beat_baseline');
  if (applicableFamilies.has('historical_replay')) {
    if (!thresholdAtLeast(thresholds, 'minMajorMetricImprovements', REPLAY_RELEASE_MINIMUMS.minMajorMetricImprovements)) {
      missing.push('min_major_metric_improvements_gte_3');
    }
    if (positiveMajorThresholdCount < REPLAY_RELEASE_MINIMUMS.minPositiveMajorMetricThresholds) {
      missing.push('positive_major_metric_threshold_count_gte_3');
    }
    if (majorMetricGate !== 'passed') {
      missing.push('major_metrics_beat_baseline_gate_passed');
    }
  }

  return {
    status: missing.length ? 'incomplete' : 'passed',
    missing,
    thresholds,
    minimums: REPLAY_RELEASE_MINIMUMS,
    primary_cutoff: Number.isFinite(primaryCutoff) ? primaryCutoff : null,
    positive_major_metric_threshold_count: positiveMajorThresholdCount,
    major_metrics_gate_status: majorMetricGate,
    applicable_families: [...applicableFamilies]
  };
}

function buildReplaySuiteEvidenceFamilies(record = {}) {
  const diagnostics = asObject(record.diagnostics);
  const gates = asArray(record.gates);
  const families = [
    {
      id: 'must_cite',
      label: 'MasterSet-style must-cite retrieval',
      patterns: [/masterset/, /must[-_ ]?cite/],
      countField: 'evaluable_must_cite_case_count',
      gateName: 'must_cite_recall_at_k'
    },
    {
      id: 'novelty',
      label: 'NovBench/RINoBench/axiomatic novelty',
      patterns: [/novbench/, /rinobench/, /axiomatic/],
      countField: 'evaluable_novelty_case_count',
      gateName: 'novelty_beats_baseline'
    },
    {
      id: 'claim_grounding',
      label: 'CLAIM-BENCH/CLAIMCHECK claim grounding',
      patterns: [/claim[-_ ]?bench/, /claimcheck/],
      countField: 'evaluable_claim_case_count',
      gateName: 'claim_grounding'
    },
    {
      id: 'historical_replay',
      label: 'OpenReview/PeerRead/MOPRD/Re2 historical replay',
      patterns: [/openreview/, /peerread/, /moprd/, /\bre2\b/, /re²/],
      countField: null,
      gateName: 'historical_replay_beats_live_discovery',
      requiresTimeCutoff: true
    }
  ];

  return families.map((family) => {
    const applicable = familyMatches(record, family.patterns);
    const evaluableCases = family.countField
      ? Number(diagnostics[family.countField] || 0)
      : Number(diagnostics.case_count || 0);
    const gate = gateStatus(gates, family.gateName);
    const missingTimeCutoff = Number(diagnostics.missing_time_cutoff_count || 0);
    const ready = applicable
      && evaluableCases > 0
      && gate === 'passed'
      && (!family.requiresTimeCutoff || missingTimeCutoff === 0);
    return {
      id: family.id,
      label: family.label,
      applicable,
      status: ready ? 'passed' : (applicable ? 'incomplete' : 'not_applicable'),
      evaluable_case_count: evaluableCases,
      gate: family.gateName,
      gate_status: gate,
      missing_time_cutoff_count: family.requiresTimeCutoff ? missingTimeCutoff : undefined,
      message: ready
        ? ''
        : (applicable ? 'family evidence is not release-ready in this suite' : 'suite does not target this evidence family')
    };
  });
}

export function buildReplaySuiteReleaseReadiness(record = {}) {
  const dataset = asObject(record.dataset);
  const diagnostics = asObject(record.diagnostics);
  const inputs = asArray(record.inputs);
  const checks = [];
  const hasSource = Boolean(compactText(dataset.source));
  const hasLicense = Boolean(compactText(dataset.license_scope || dataset.licenseScope));
  const hasRawInputHash = inputs.some((entry) => compactText(entry.role) === 'raw_dataset' && compactText(entry.sha256 || entry.hash || entry.checksum));
  const text = sourceText(record);
  const fixtureEvidence = FIXTURE_MARKERS.test(text);
  const policyEvidence = releasePolicyEvidence(record);
  const caseCount = Number(diagnostics.case_count || 0);
  const missingTimeCutoff = Number(diagnostics.missing_time_cutoff_count || 0);
  const strictTimeCutoffs = caseCount > 0 && missingTimeCutoff === 0;

  checks.push(releaseCheck(
    'suite_status_passed',
    record.status === 'passed' ? 'passed' : 'incomplete',
    record.status === 'passed' ? '' : 'replay suite did not pass historical replay gates',
    { suite_status: compactText(record.status || 'unknown') }
  ));
  checks.push(releaseCheck(
    'dataset_source_present',
    hasSource ? 'passed' : 'incomplete',
    hasSource ? '' : 'missing dataset source',
    { dataset_source: compactText(dataset.source) || null }
  ));
  checks.push(releaseCheck(
    'license_scope_present',
    hasLicense ? 'passed' : 'incomplete',
    hasLicense ? '' : 'missing license scope',
    { license_scope: compactText(dataset.license_scope || dataset.licenseScope) || null }
  ));
  checks.push(releaseCheck(
    'raw_input_hash_present',
    hasRawInputHash ? 'passed' : 'incomplete',
    hasRawInputHash ? '' : 'missing raw dataset input hash'
  ));
  checks.push(releaseCheck(
    'not_fixture_or_synthetic',
    fixtureEvidence ? 'incomplete' : 'passed',
    fixtureEvidence ? 'fixture/synthetic/mock/mini evidence cannot be release evidence' : ''
  ));
  checks.push(releaseCheck(
    'strict_time_cutoffs_present',
    strictTimeCutoffs ? 'passed' : 'incomplete',
    strictTimeCutoffs ? '' : 'all replay cases must carry strict historical time cutoffs',
    { case_count: caseCount, missing_time_cutoff_count: missingTimeCutoff }
  ));
  checks.push(releaseCheck(
    'venue_year_holdout_present',
    policyEvidence.venueYearHoldout ? 'passed' : 'incomplete',
    policyEvidence.venueYearHoldout ? '' : 'missing explicit venue/year holdout policy',
    {
      holdout_candidate_count: policyEvidence.holdout_candidate_count,
      policy: policySummary(policyEvidence.venueYearHoldout)
    }
  ));
  checks.push(releaseCheck(
    'time_slice_policy_present',
    policyEvidence.timeSlicePolicy ? 'passed' : 'incomplete',
    policyEvidence.timeSlicePolicy ? '' : 'missing OpenAlex/S2ORC/reference time-slice policy',
    {
      time_slice_candidate_count: policyEvidence.time_slice_candidate_count,
      policy: policySummary(policyEvidence.timeSlicePolicy)
    }
  ));

  const evidenceFamilies = buildReplaySuiteEvidenceFamilies(record);
  const applicableFamilies = evidenceFamilies.filter((entry) => entry.applicable);
  const readyFamilies = evidenceFamilies.filter((entry) => entry.status === 'passed');
  checks.push(releaseCheck(
    'target_evidence_family_ready',
    readyFamilies.length ? 'passed' : 'incomplete',
    readyFamilies.length ? '' : 'no targeted evidence family is release-ready',
    {
      applicable_family_count: applicableFamilies.length,
      ready_family_count: readyFamilies.length,
      ready_families: readyFamilies.map((entry) => entry.id)
    }
  ));
  const thresholdAudit = releaseThresholdAudit(record, evidenceFamilies);
  checks.push(releaseCheck(
    'release_grade_improvement_thresholds_present',
    thresholdAudit.status,
    thresholdAudit.status === 'passed'
      ? ''
      : `release replay suites must configure deep-research improvement thresholds: ${thresholdAudit.missing.join(', ')}`,
    thresholdAudit
  ));
  const semanticNegativeAudit = semanticNegativeCoverageAudit(record);
  checks.push(releaseCheck(
    'semantic_negative_coverage_present',
    semanticNegativeAudit.status,
    semanticNegativeAudit.status === 'passed'
      ? ''
      : `release replay suites must cover report-required semantic negative cases: ${semanticNegativeAudit.missing_categories.join(', ')}`,
    semanticNegativeAudit
  ));
  const significanceAudit = statisticalSignificanceAudit(record, evidenceFamilies);
  checks.push(releaseCheck(
    'statistical_significance_evidence_present',
    significanceAudit.status,
    significanceAudit.status === 'passed'
      ? ''
      : `release replay suites must include paired statistical significance evidence: ${significanceAudit.missing.join(', ')}`,
    significanceAudit
  ));
  const significanceProvenanceAudit = statisticalSignificanceProvenanceAudit(record);
  checks.push(releaseCheck(
    'statistical_significance_provenance_auditable',
    significanceProvenanceAudit.status,
    significanceProvenanceAudit.status === 'passed'
      ? ''
      : significanceProvenanceAudit.message,
    significanceProvenanceAudit
  ));

  const status = checks.every((entry) => entry.status === 'passed') ? 'ready_for_release_gate' : 'incomplete';
  return {
    status,
    releaseCandidate: status === 'ready_for_release_gate',
    reason: status === 'ready_for_release_gate'
      ? 'release_metadata_and_family_gates_present'
      : checks.find((entry) => entry.status !== 'passed')?.message || 'release readiness incomplete',
    checks,
    evidenceFamilies
  };
}

async function loadPacketOptions(params = {}) {
  return {
    candidatePacket: isNonEmptyObject(params.candidatePacket)
      ? params.candidatePacket
      : await readOptionalJson(params.candidatePacketPath),
    baselinePacket: isNonEmptyObject(params.baselinePacket)
      ? params.baselinePacket
      : await readOptionalJson(params.baselinePacketPath),
    candidatePackets: isNonEmptyObject(params.candidatePackets)
      ? params.candidatePackets
      : await readOptionalJson(params.candidatePacketsPath),
    baselinePackets: isNonEmptyObject(params.baselinePackets)
      ? params.baselinePackets
      : await readOptionalJson(params.baselinePacketsPath)
  };
}

async function buildInputRecords(params = {}) {
  const records = await Promise.all([
    fileInputRecord('raw_dataset', params.inputPath),
    fileInputRecord('candidate_packet', params.candidatePacketPath),
    fileInputRecord('baseline_packet', params.baselinePacketPath),
    fileInputRecord('candidate_packet_map', params.candidatePacketsPath),
    fileInputRecord('baseline_packet_map', params.baselinePacketsPath),
    fileInputRecord('thresholds', params.thresholdsPath),
    fileInputRecord('statistical_significance', params.statisticalEvidencePath || params.statistical_significance_path)
  ]);
  return records.filter(Boolean);
}

function statisticalEvidenceCandidates(params = {}, rawInput = {}, rawDataset = {}, rawMetadata = {}, statisticalEvidenceFromPath = {}) {
  return [
    {
      source: 'statistical_significance_file',
      path: resolveOptionalPath(params.statisticalEvidencePath || params.statistical_significance_path),
      value: statisticalEvidenceFromPath
    },
    { source: 'inline_parameter', value: params.statisticalSignificance },
    { source: 'inline_parameter', value: params.statistical_significance },
    { source: 'raw_dataset', value: rawInput.statistical_significance },
    { source: 'raw_dataset', value: rawInput.statisticalSignificance },
    { source: 'raw_dataset', value: rawInput.statistical_tests },
    { source: 'raw_dataset', value: rawInput.statisticalTests },
    { source: 'raw_dataset', value: rawDataset.statistical_significance },
    { source: 'raw_dataset', value: rawDataset.statisticalSignificance },
    { source: 'raw_dataset', value: rawMetadata.statistical_significance },
    { source: 'raw_dataset', value: rawMetadata.statisticalSignificance }
  ].filter((entry) => isNonEmptyStructured(entry.value));
}

export async function runIdeaCatalystReplaySuite(params = {}) {
  const inputPath = resolveOptionalPath(params.inputPath);
  if (!inputPath && !isNonEmptyObject(params.input)) {
    throw new Error('runIdeaCatalystReplaySuite requires inputPath or input.');
  }
  const outputDir = resolveOptionalPath(params.outputDir);
  if (!outputDir) {
    throw new Error('runIdeaCatalystReplaySuite requires outputDir so artifacts and manifests are preserved.');
  }

  const rawInput = isNonEmptyObject(params.input) ? params.input : await readJson(inputPath);
  const rawDataset = asObject(rawInput.dataset);
  const rawMetadata = asObject(rawInput.metadata);
  const packetOptions = await loadPacketOptions(params);
  const statisticalEvidenceFromPath = await readOptionalJson(params.statisticalEvidencePath || params.statistical_significance_path);
  const replay = adaptIdeaCatalystReplayBenchmark(rawInput, {
    format: params.format,
    name: params.name,
    timeCutoff: params.timeCutoff ?? params.time_cutoff,
    ...packetOptions
  });
  const generatedAt = new Date().toISOString();
  const runId = compactText(params.runId || params.run_id)
    || `idea-catalyst-replay-suite-${stableHash(`${replay.name}:${generatedAt}`, 10)}`;
  const normalizedReplayPath = path.join(outputDir, 'normalized-replay.json');
  const historicalReplayOutputDir = path.join(outputDir, 'historical-replay');
  const suiteManifestPath = path.join(outputDir, 'replay-suite-manifest.json');
  const diagnostics = diagnoseIdeaCatalystReplaySuite(replay);
  const thresholds = asObject(params.thresholds);
  const selectedStatisticalEvidence = statisticalEvidenceCandidates(
    params,
    rawInput,
    rawDataset,
    rawMetadata,
    statisticalEvidenceFromPath
  )[0];
  const statisticalSignificance = selectedStatisticalEvidence?.value;
  const cutoffs = asArray(params.cutoffs).length ? params.cutoffs : undefined;
  const primaryCutoff = Number.isFinite(Number(params.primaryCutoff ?? params.primary_cutoff))
    ? Number(params.primaryCutoff ?? params.primary_cutoff)
    : undefined;

  await ensureDir(outputDir);
  await writeJson(normalizedReplayPath, replay);

  const replayReport = await runIdeaCatalystHistoricalReplay({
    benchmark: replay,
    outputDir: historicalReplayOutputDir,
    runId,
    cutoffs,
    primaryCutoff,
    thresholds
  });
  const status = suiteStatus(diagnostics, replayReport);
  const inputs = await buildInputRecords(params);
  const manifestDraft = {
    contractVersion: IDEA_CATALYST_REPLAY_SUITE_VERSION,
    runId,
    status,
    generatedAt,
    dataset: {
      name: replay.name,
      format: replay.format,
      source: compactText(params.datasetSource || params.dataset_source),
      license_scope: compactText(params.licenseScope || params.license_scope),
      holdout_policy: firstDefined(
        params.holdoutPolicy,
        params.holdout_policy,
        rawInput.holdout_policy,
        rawInput.holdoutPolicy,
        rawInput.holdout,
        rawInput.venue_year_holdout,
        rawInput.venueYearHoldout,
        rawDataset.holdout_policy,
        rawDataset.holdoutPolicy,
        rawDataset.holdout,
        rawDataset.venue_year_holdout,
        rawDataset.venueYearHoldout,
        rawMetadata.holdout_policy,
        rawMetadata.holdoutPolicy,
        rawMetadata.holdout
      ),
      time_slice_policy: firstDefined(
        params.timeSlicePolicy,
        params.time_slice_policy,
        rawInput.time_slice_policy,
        rawInput.timeSlicePolicy,
        rawInput.temporal_slice_policy,
        rawInput.temporalSlicePolicy,
        rawInput.source_time_slice_policy,
        rawInput.sourceTimeSlicePolicy,
        rawDataset.time_slice_policy,
        rawDataset.timeSlicePolicy,
        rawDataset.temporal_slice_policy,
        rawDataset.temporalSlicePolicy,
        rawDataset.source_time_slice_policy,
        rawDataset.sourceTimeSlicePolicy,
        rawMetadata.time_slice_policy,
        rawMetadata.timeSlicePolicy,
        rawMetadata.temporal_slice_policy,
        rawMetadata.temporalSlicePolicy
      )
    },
    contracts: {
      adapter: IDEA_CATALYST_REPLAY_ADAPTER_VERSION,
      historical_replay: IDEA_CATALYST_HISTORICAL_REPLAY_VERSION
    },
    inputs,
    adapter: {
      format: replay.format,
      diagnostics: replay.adapter_diagnostics || {}
    },
    diagnostics,
    config: {
      cutoffs: replayReport.config?.cutoffs || [],
      primaryCutoff: replayReport.config?.primaryCutoff,
      thresholds: replayReport.config?.thresholds || thresholds
    },
    statistical_significance: statisticalSignificance || {},
    statistical_significance_provenance: {
      source: selectedStatisticalEvidence?.source || null,
      path: selectedStatisticalEvidence?.path || null
    },
    gates: replayReport.gates || [],
    metrics: replayReport.metrics || {},
    artifacts: {
      outputDir,
      normalizedReplayPath,
      historicalReplayOutputDir,
      historicalReportPath: replayReport.artifacts?.reportPath || '',
      historicalReportMarkdownPath: replayReport.artifacts?.reportMarkdownPath || '',
      historicalSummaryTsvPath: replayReport.artifacts?.summaryTsvPath || '',
      historicalManifestPath: replayReport.artifacts?.manifestPath || '',
      suiteManifestPath
    }
  };
  const manifest = {
    ...manifestDraft,
    releaseReadiness: buildReplaySuiteReleaseReadiness(manifestDraft)
  };
  await writeJson(suiteManifestPath, manifest);
  return manifest;
}
