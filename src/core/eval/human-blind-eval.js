import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const HUMAN_BLIND_EVAL_VERSION = 'human-blind-eval-v1';

export const HUMAN_BLIND_EVAL_DIMENSIONS = [
  'novelty',
  'significance',
  'feasibility',
  'grounding',
  'storyline_coherence',
  'must_cite_completeness'
];

export const DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL = {
  preference_threshold: 0.6,
  target_system: 'candidate',
  required_comparison_families: ['baseline', 'p0', 'p1', 'ablation'],
  required_role_counts: {
    domain_expert: 3,
    methodology: 1,
    reproducibility: 1
  },
  dimensions: HUMAN_BLIND_EVAL_DIMENSIONS
};

const SCRUBBED_PACKET_KEYS = new Set([
  'system',
  'system_key',
  'systemKey',
  'system_label',
  'systemLabel',
  'candidate_system',
  'candidateSystem',
  'baseline_system',
  'baselineSystem',
  'variant',
  'variant_id',
  'variantId',
  'model',
  'model_name',
  'modelName',
  'model_provider',
  'modelProvider'
]);
const BLINDING_FORBIDDEN_PUBLIC_KEYS = new Set([
  ...[...SCRUBBED_PACKET_KEYS].map((key) => key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')),
  'system_key',
  'target_system',
  'target_side',
  'packet_key',
  'answer_key'
]);
const REVIEW_VISIBLE_PACKET_KEYS = new Set([
  'proposal',
  'evidence_export'
]);

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

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clamp01(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function average(values = [], fallback = null) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return fallback;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function roundMetric(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : null;
}

function parseHashParity(value = '') {
  return Number.parseInt(stableHash(value, 8), 16) % 2;
}

function normalizeRole(role = '') {
  const key = normalizeKey(role);
  if (['domain', 'domain_reviewer', 'domain_expert_reviewer', 'expert', 'subject_expert'].includes(key)) return 'domain_expert';
  if (['method', 'methodology_reviewer', 'methods', 'methods_reviewer'].includes(key)) return 'methodology';
  if (['repro', 'reproducibility_reviewer', 'replication', 'reproducibility_expert'].includes(key)) return 'reproducibility';
  return key || 'domain_expert';
}

function reviewerSlots(requiredRoleCounts = {}) {
  const slots = [];
  for (const [rawRole, rawCount] of Object.entries(requiredRoleCounts)) {
    const role = normalizeRole(rawRole);
    const count = Math.max(0, Number.parseInt(rawCount, 10) || 0);
    for (let index = 0; index < count; index += 1) {
      slots.push({
        reviewer_role: role,
        reviewer_slot: `${role}:${index + 1}`
      });
    }
  }
  return slots.length ? slots : reviewerSlots(DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.required_role_counts);
}

function normalizeComparisonFamily(value = '') {
  const key = normalizeKey(value);
  if (!key) return '';
  if (['baseline', 'current_baseline', 'current_repo_baseline', 'live_discovery', 'repo_baseline', 'graph_baseline'].includes(key)) return 'baseline';
  if (['p0', 'phase0', 'phase_0', 'v0'].includes(key)) return 'p0';
  if (['p1', 'phase1', 'phase_1', 'v1'].includes(key)) return 'p1';
  if (key === 'ablation' || key.startsWith('ablation_') || key.includes('_ablation') || key.includes('without_')) return 'ablation';
  return key;
}

function normalizeProtocol(params = {}, input = {}) {
  const raw = asObject(params.protocol || input.protocol);
  const requiredRoleCounts = asObject(
    params.requiredRoleCounts
      || params.required_role_counts
      || raw.required_role_counts
      || raw.requiredRoleCounts
      || DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.required_role_counts
  );
  const dimensions = asArray(params.dimensions || raw.dimensions).map(normalizeKey).filter(Boolean);
  const comparisonFamilies = asArray(
    params.requiredComparisonFamilies
      || params.required_comparison_families
      || raw.required_comparison_families
      || raw.requiredComparisonFamilies
      || DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.required_comparison_families
  ).map(normalizeComparisonFamily).filter(Boolean);
  return {
    contract_version: HUMAN_BLIND_EVAL_VERSION,
    preference_threshold: clamp01(
      params.preferenceThreshold
        ?? params.preference_threshold
        ?? raw.preference_threshold
        ?? raw.preferenceThreshold,
      DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.preference_threshold
    ),
    target_system: normalizeKey(
      params.targetSystem
        || params.target_system
        || raw.target_system
        || raw.targetSystem
        || DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.target_system
    ),
    required_role_counts: Object.fromEntries(
      Object.entries(requiredRoleCounts).map(([role, count]) => [normalizeRole(role), Math.max(0, Number.parseInt(count, 10) || 0)])
    ),
    required_comparison_families: comparisonFamilies.length
      ? [...new Set(comparisonFamilies)]
      : [...DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.required_comparison_families],
    dimensions: dimensions.length ? dimensions : [...DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.dimensions]
  };
}

function normalizeInputCases(input = {}) {
  const rawCases = asArray(input.cases || input.replays || input.items || input.queries);
  return rawCases.map((rawCase, index) => {
    const record = asObject(rawCase);
    const caseId = compactText(record.case_id || record.caseId || record.id || record.query_id || record.queryId) || `case:${index + 1}`;
    return {
      ...record,
      case_id: caseId,
      title: compactText(record.title || record.topic || record.problem || record.query || record.question),
      systems: collectSystems(record)
    };
  });
}

function addSystem(systems, key, packet) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey || !isObject(packet) || !Object.keys(packet).length) return;
  if (systems.some((entry) => entry.system_key === normalizedKey)) return;
  systems.push({
    system_key: normalizedKey,
    packet
  });
}

function collectSystems(caseInput = {}) {
  const systems = [];
  for (const [key, packet] of Object.entries(asObject(caseInput.systems))) addSystem(systems, key, packet);
  for (const [key, packet] of Object.entries(asObject(caseInput.variants))) addSystem(systems, key, packet);
  for (const [key, packet] of Object.entries(asObject(caseInput.packets))) addSystem(systems, key, packet);

  addSystem(systems, 'baseline', caseInput.baseline || caseInput.baseline_packet || caseInput.baselinePacket);
  addSystem(systems, 'candidate', caseInput.candidate || caseInput.candidate_packet || caseInput.candidatePacket);
  addSystem(systems, 'p0', caseInput.p0 || caseInput.p0_packet || caseInput.p0Packet);
  addSystem(systems, 'p1', caseInput.p1 || caseInput.p1_packet || caseInput.p1Packet);

  for (const [key, packet] of Object.entries(asObject(caseInput.ablations))) {
    addSystem(systems, `ablation_${key}`, packet);
  }

  return systems;
}

function scrubPacketForBlindReview(value) {
  if (Array.isArray(value)) return value.map((entry) => scrubPacketForBlindReview(entry));
  if (!isObject(value)) return value;
  const scrubbed = {};
  for (const [key, child] of Object.entries(value)) {
    if (SCRUBBED_PACKET_KEYS.has(key)) continue;
    scrubbed[key] = scrubPacketForBlindReview(child);
  }
  return scrubbed;
}

function reviewerVisiblePacketPayload(packet = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(asObject(packet))) {
    if (REVIEW_VISIBLE_PACKET_KEYS.has(normalizeKey(key))) {
      payload[key] = scrubPacketForBlindReview(cloneJson(value));
    }
  }
  return Object.keys(payload).length ? payload : scrubPacketForBlindReview(cloneJson(packet));
}

function normalizePairSpecs(caseInput = {}, protocol = {}, params = {}) {
  const systems = caseInput.systems.map((entry) => entry.system_key);
  const requestedPairs = asArray(params.pairs || caseInput.pairs || caseInput.pairings)
    .map((pair) => {
      const raw = asObject(pair);
      const left = normalizeKey(raw.left || raw.a || raw.system_a || raw.systemA || raw.first);
      const right = normalizeKey(raw.right || raw.b || raw.system_b || raw.systemB || raw.second);
      return left && right && systems.includes(left) && systems.includes(right) && left !== right
        ? [left, right]
        : null;
    })
    .filter(Boolean);
  if (requestedPairs.length) return requestedPairs;

  const target = protocol.target_system;
  if (systems.includes(target) && systems.length > 1) {
    return systems.filter((system) => system !== target).map((system) => [target, system]);
  }

  const pairs = [];
  for (let leftIndex = 0; leftIndex < systems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < systems.length; rightIndex += 1) {
      pairs.push([systems[leftIndex], systems[rightIndex]]);
    }
  }
  return pairs;
}

function reviewFormSchema(dimensions = HUMAN_BLIND_EVAL_DIMENSIONS) {
  const dimensionProperties = Object.fromEntries(dimensions.map((dimension) => [dimension, {
    type: 'number',
    minimum: 1,
    maximum: 5
  }]));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'PaperNexus human blind pairwise review form',
    type: 'object',
    required: ['pair_id', 'reviewer_id', 'reviewer_role', 'reviewer_source', 'selected_side', 'confidence'],
    properties: {
      pair_id: { type: 'string' },
      assignment_id: { type: 'string' },
      reviewer_id: { type: 'string' },
      reviewer_role: { enum: ['domain_expert', 'methodology', 'reproducibility'] },
      reviewer_source: {
        description: 'Use human/expert for independent human reviewers. AI, model, author, or self labels are logged but excluded from release-pass evidence.',
        type: 'string'
      },
      selected_side: { enum: ['left', 'right', 'tie', 'unclear'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      scores: {
        type: 'object',
        properties: {
          left: { type: 'object', properties: dimensionProperties, additionalProperties: true },
          right: { type: 'object', properties: dimensionProperties, additionalProperties: true }
        },
        additionalProperties: true
      },
      major_concerns: {
        type: 'array',
        items: { type: 'string' }
      },
      notes: { type: 'string' }
    },
    additionalProperties: true
  };
}

export function buildHumanBlindEvaluationPack(params = {}) {
  const input = asObject(params.input || params.benchmark || params.replay || params.dataset);
  const protocol = normalizeProtocol(params, input);
  const cases = normalizeInputCases(input);
  const seed = compactText(params.seed || input.seed || 'papernexus-human-blind-eval');
  const generatedAt = compactText(params.generatedAt || params.generated_at) || new Date().toISOString();
  const runId = compactText(params.runId || params.run_id || input.runId || input.run_id)
    || `human-blind-eval-${stableHash(`${input.name || 'dataset'}:${generatedAt}`, 10)}`;
  const blindPackets = [];
  const blindPairs = [];
  const answerKeyPairs = [];
  const assignments = [];
  const messages = [];
  const packetIdByCaseSystem = new Map();

  for (const caseInput of cases) {
    if (caseInput.systems.length < 2) {
      messages.push({
        severity: 'error',
        code: 'insufficient_systems',
        case_id: caseInput.case_id,
        message: 'Human blind evaluation requires at least two systems per case.'
      });
      continue;
    }

    for (const system of caseInput.systems) {
      const packetId = `blindpkt:${stableHash(`${runId}:${caseInput.case_id}:${system.system_key}`, 12)}`;
      const lookupKey = `${caseInput.case_id}:${system.system_key}`;
      packetIdByCaseSystem.set(lookupKey, packetId);
      blindPackets.push({
        packet_id: packetId,
        case_id: caseInput.case_id,
        payload: reviewerVisiblePacketPayload(system.packet)
      });
    }

    const pairSpecs = normalizePairSpecs(caseInput, protocol, params);
    pairSpecs.forEach(([firstSystem, secondSystem], pairIndex) => {
      const swap = parseHashParity(`${seed}:${caseInput.case_id}:${firstSystem}:${secondSystem}:${pairIndex}`) === 1;
      const leftSystem = swap ? secondSystem : firstSystem;
      const rightSystem = swap ? firstSystem : secondSystem;
      const pairId = `pair:${stableHash(`${runId}:${caseInput.case_id}:${firstSystem}:${secondSystem}:${pairIndex}`, 12)}`;
      const leftPacketId = packetIdByCaseSystem.get(`${caseInput.case_id}:${leftSystem}`);
      const rightPacketId = packetIdByCaseSystem.get(`${caseInput.case_id}:${rightSystem}`);
      const targetSide = leftSystem === protocol.target_system ? 'left' : (rightSystem === protocol.target_system ? 'right' : null);

      blindPairs.push({
        pair_id: pairId,
        case_id: caseInput.case_id,
        left_packet_id: leftPacketId,
        right_packet_id: rightPacketId,
        dimensions: protocol.dimensions
      });
      answerKeyPairs.push({
        pair_id: pairId,
        case_id: caseInput.case_id,
        left: {
          packet_id: leftPacketId,
          system_key: leftSystem,
          role: targetSide === 'left' ? 'target' : 'comparator'
        },
        right: {
          packet_id: rightPacketId,
          system_key: rightSystem,
          role: targetSide === 'right' ? 'target' : 'comparator'
        },
        target_system: protocol.target_system,
        target_side: targetSide
      });

      for (const slot of reviewerSlots(protocol.required_role_counts)) {
        assignments.push({
          assignment_id: `assignment:${stableHash(`${pairId}:${slot.reviewer_slot}`, 12)}`,
          pair_id: pairId,
          case_id: caseInput.case_id,
          reviewer_slot: slot.reviewer_slot,
          reviewer_role: slot.reviewer_role,
          left_packet_id: leftPacketId,
          right_packet_id: rightPacketId,
          status: 'unassigned'
        });
      }
    });
  }

  const blindPack = {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    runId,
    generatedAt,
    protocol: {
      preference_threshold: protocol.preference_threshold,
      required_role_counts: protocol.required_role_counts,
      dimensions: protocol.dimensions,
      blinding: 'system labels are withheld from blind-pack and assignments; answer-key.json is private'
    },
    dataset: {
      name: compactText(input.name || params.name || 'human-blind-eval'),
      case_count: cases.length,
      pair_count: blindPairs.length
    },
    cases: cases.map((caseInput) => ({
      case_id: caseInput.case_id,
      title: caseInput.title
    })),
    packets: blindPackets,
    pairs: blindPairs,
    diagnostics: {
      message_count: messages.length,
      error_count: messages.filter((entry) => entry.severity === 'error').length,
      messages
    }
  };

  const assignmentPack = {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    runId,
    generatedAt,
    assignments,
    assignment_count: assignments.length
  };

  const answerKey = {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    runId,
    generatedAt,
    target_system: protocol.target_system,
    pairs: answerKeyPairs,
    packet_key: cases.flatMap((caseInput) => caseInput.systems.map((system) => ({
      case_id: caseInput.case_id,
      packet_id: packetIdByCaseSystem.get(`${caseInput.case_id}:${system.system_key}`),
      system_key: system.system_key
    }))),
    private: true
  };

  return {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    runId,
    generatedAt,
    protocol,
    blindPack,
    assignments: assignmentPack,
    answerKey,
    reviewFormSchema: reviewFormSchema(protocol.dimensions)
  };
}

function normalizeSelectedSide(value = '') {
  const key = normalizeKey(value);
  if (['left', 'a', 'packet_a', 'side_a'].includes(key)) return 'left';
  if (['right', 'b', 'packet_b', 'side_b'].includes(key)) return 'right';
  if (['tie', 'draw', 'equal', 'neither'].includes(key)) return 'tie';
  return 'unclear';
}

function reviewerSource(label = {}) {
  return normalizeKey(
    label.reviewer_source
      || label.reviewerSource
      || label.label_source
      || label.labelSource
      || label.source
      || label.reviewer_type
      || label.reviewerType
      || label.annotator_type
      || label.annotatorType
  );
}

function humanLabelStatus(label = {}) {
  const source = reviewerSource(label);
  if (label.is_ai === true || label.isAi === true) return { human: false, reason: 'ai_label' };
  if (label.is_human === false || label.isHuman === false || label.human === false) return { human: false, reason: 'not_marked_human' };
  if (label.is_author === true || label.isAuthor === true || label.author === true) return { human: false, reason: 'author_label' };
  if (['ai', 'llm', 'model', 'machine', 'synthetic', 'auto', 'automatic'].includes(source)) return { human: false, reason: 'ai_label' };
  if (['author', 'self', 'self_review', 'developer', 'system_builder'].includes(source)) return { human: false, reason: 'author_or_self_label' };
  if (label.is_human === true || label.isHuman === true || label.human === true) return { human: true, reason: 'verified_human' };
  if (['human', 'expert', 'domain_expert', 'methodology', 'reproducibility', 'independent_human'].includes(source)) {
    return { human: true, reason: 'verified_human' };
  }
  return { human: false, reason: 'unverified_reviewer_source' };
}

function normalizeLabels(labelsInput = {}) {
  return asArray(Array.isArray(labelsInput) ? labelsInput : (labelsInput.labels || labelsInput.reviews || labelsInput.records));
}

function scoreForSide(label = {}, side = '', dimension = '') {
  const scores = asObject(label.scores || label.dimension_scores || label.dimensionScores);
  const sideScores = asObject(scores[side]);
  if (Number.isFinite(Number(sideScores[dimension]))) return Number(sideScores[dimension]);
  const dimensionScores = asObject(scores[dimension]);
  if (Number.isFinite(Number(dimensionScores[side]))) return Number(dimensionScores[side]);
  return null;
}

function hasExplicitConfidence(label = {}) {
  return [
    label.confidence,
    label.confidence_score,
    label.confidenceScore
  ].some((value) => Number.isFinite(Number(value)));
}

function hasRecordedMajorConcerns(label = {}) {
  return Array.isArray(label.major_concerns || label.majorConcerns);
}

function assignmentIdForLabel(label = {}) {
  return compactText(label.assignment_id || label.assignmentId || label.assignment);
}

function normalizeAssignmentRecords(assignmentsInput = {}) {
  const rawAssignments = Array.isArray(assignmentsInput)
    ? assignmentsInput
    : asArray(asObject(assignmentsInput).assignments);
  return rawAssignments
    .map((entry) => {
      const record = asObject(entry);
      const rawReviewerRole = compactText(record.reviewer_role || record.reviewerRole || record.role);
      return {
        assignment_id: compactText(record.assignment_id || record.assignmentId || record.id),
        pair_id: compactText(record.pair_id || record.pairId),
        case_id: compactText(record.case_id || record.caseId),
        reviewer_slot: compactText(record.reviewer_slot || record.reviewerSlot),
        reviewer_role: rawReviewerRole ? normalizeRole(rawReviewerRole) : ''
      };
    })
    .filter((entry) => entry.assignment_id && entry.pair_id && entry.reviewer_role);
}

function assignmentLinkAudit(label = {}, assignmentById = new Map()) {
  const assignmentId = assignmentIdForLabel(label);
  if (!assignmentId) {
    return {
      assignment_id: '',
      assignment_valid: false,
      assignment_issue: 'missing_assignment_id'
    };
  }
  const assignment = assignmentById.get(assignmentId);
  if (!assignment) {
    return {
      assignment_id: assignmentId,
      assignment_valid: false,
      assignment_issue: 'unknown_assignment_id'
    };
  }
  const pairId = compactText(label.pair_id || label.pairId);
  const rawReviewerRole = compactText(label.reviewer_role || label.reviewerRole || label.role);
  if (!rawReviewerRole) {
    return {
      assignment_id: assignmentId,
      assignment_valid: false,
      assignment_issue: 'missing_reviewer_role',
      assignment_pair_id: assignment.pair_id,
      assignment_reviewer_role: assignment.reviewer_role
    };
  }
  const reviewerRole = normalizeRole(rawReviewerRole);
  if (assignment.pair_id !== pairId) {
    return {
      assignment_id: assignmentId,
      assignment_valid: false,
      assignment_issue: 'assignment_pair_mismatch',
      assignment_pair_id: assignment.pair_id,
      assignment_reviewer_role: assignment.reviewer_role
    };
  }
  if (assignment.reviewer_role !== reviewerRole) {
    return {
      assignment_id: assignmentId,
      assignment_valid: false,
      assignment_issue: 'assignment_role_mismatch',
      assignment_pair_id: assignment.pair_id,
      assignment_reviewer_role: assignment.reviewer_role
    };
  }
  return {
    assignment_id: assignmentId,
    assignment_valid: true,
    assignment_issue: '',
    assignment_pair_id: assignment.pair_id,
    assignment_reviewer_role: assignment.reviewer_role,
    reviewer_slot: assignment.reviewer_slot
  };
}

function scoreCompletenessForLabel(label = {}, pair = {}, dimensions = []) {
  const targetSide = pair.target_side || null;
  const sides = targetSide
    ? [targetSide, targetSide === 'left' ? 'right' : 'left']
    : ['left', 'right'];
  const missing = [];
  for (const side of sides) {
    for (const dimension of dimensions) {
      if (!Number.isFinite(scoreForSide(label, side, dimension))) {
        missing.push(`${side}.${dimension}`);
      }
    }
  }
  return {
    complete: missing.length === 0,
    missing
  };
}

function summarizeDimensionScores(validTargetLabels = [], pairById = new Map(), dimensions = []) {
  const summaries = {};
  for (const dimension of dimensions) {
    const targetScores = [];
    const comparatorScores = [];
    for (const label of validTargetLabels) {
      const key = pairById.get(label.pair_id);
      if (!key?.target_side) continue;
      const comparatorSide = key.target_side === 'left' ? 'right' : 'left';
      const targetScore = scoreForSide(label.raw, key.target_side, dimension);
      const comparatorScore = scoreForSide(label.raw, comparatorSide, dimension);
      if (Number.isFinite(targetScore)) targetScores.push(targetScore);
      if (Number.isFinite(comparatorScore)) comparatorScores.push(comparatorScore);
    }
    summaries[dimension] = {
      target_average: roundMetric(average(targetScores, null)),
      comparator_average: roundMetric(average(comparatorScores, null)),
      average_margin: roundMetric(
        targetScores.length && comparatorScores.length
          ? average(targetScores.map((score, index) => score - comparatorScores[index]).filter(Number.isFinite), null)
          : null
      ),
      count: Math.max(targetScores.length, comparatorScores.length)
    };
  }
  return summaries;
}

function summarizeReviewFormCompleteness(validTargetLabels = [], dimensions = []) {
  const labelCount = validTargetLabels.length;
  const missingDimensionScores = validTargetLabels
    .filter((label) => label.score_completeness?.complete !== true)
    .map((label) => ({
      pair_id: label.pair_id,
      reviewer_id: label.reviewer_id,
      missing_scores: asArray(label.score_completeness?.missing)
    }));
  const missingConfidence = validTargetLabels
    .filter((label) => label.explicit_confidence !== true)
    .map((label) => ({ pair_id: label.pair_id, reviewer_id: label.reviewer_id }));
  const missingMajorConcerns = validTargetLabels
    .filter((label) => label.major_concerns_recorded !== true)
    .map((label) => ({ pair_id: label.pair_id, reviewer_id: label.reviewer_id }));
  return {
    complete: labelCount > 0
      && missingDimensionScores.length === 0
      && missingConfidence.length === 0
      && missingMajorConcerns.length === 0,
    required_dimensions: dimensions,
    valid_human_target_pair_label_count: labelCount,
    complete_dimension_score_label_count: labelCount - missingDimensionScores.length,
    explicit_confidence_label_count: labelCount - missingConfidence.length,
    major_concerns_label_count: labelCount - missingMajorConcerns.length,
    missing_dimension_score_labels: missingDimensionScores,
    missing_confidence_labels: missingConfidence,
    missing_major_concerns_labels: missingMajorConcerns
  };
}

function summarizeAssignmentCoverage(validTargetLabels = [], targetPairs = [], assignmentRecords = [], requiredRoleCounts = {}) {
  const targetPairIds = new Set(targetPairs.map((pair) => compactText(pair.pair_id)).filter(Boolean));
  const targetAssignments = assignmentRecords.filter((assignment) => targetPairIds.has(assignment.pair_id));
  const requiredAssignmentIds = new Set(targetAssignments.map((assignment) => assignment.assignment_id));
  const expectedAssignmentsPerPair = reviewerSlots(requiredRoleCounts).length;
  const requiredTargetPairAssignmentCount = targetPairs.length * expectedAssignmentsPerPair;
  const labelsByAssignmentId = new Map();

  const missingAssignmentIdLabels = [];
  const invalidAssignmentLabels = [];
  for (const label of validTargetLabels) {
    if (!label.assignment_id) {
      missingAssignmentIdLabels.push({
        pair_id: label.pair_id,
        reviewer_id: label.reviewer_id,
        reviewer_role: label.reviewer_role
      });
      continue;
    }
    if (label.assignment_valid !== true || !requiredAssignmentIds.has(label.assignment_id)) {
      invalidAssignmentLabels.push({
        pair_id: label.pair_id,
        reviewer_id: label.reviewer_id,
        reviewer_role: label.reviewer_role,
        assignment_id: label.assignment_id,
        issue: label.assignment_issue || 'assignment_not_required_for_target_pair'
      });
      continue;
    }
    if (!labelsByAssignmentId.has(label.assignment_id)) labelsByAssignmentId.set(label.assignment_id, []);
    labelsByAssignmentId.get(label.assignment_id).push(label);
  }

  const duplicateAssignmentIds = [...labelsByAssignmentId.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([assignmentId]) => assignmentId)
    .sort();
  const completedAssignmentIds = [...labelsByAssignmentId.entries()]
    .filter(([, labels]) => labels.length === 1)
    .map(([assignmentId]) => assignmentId);
  const missingRequiredAssignments = targetAssignments
    .filter((assignment) => !labelsByAssignmentId.has(assignment.assignment_id))
    .map((assignment) => ({
      assignment_id: assignment.assignment_id,
      pair_id: assignment.pair_id,
      reviewer_slot: assignment.reviewer_slot,
      reviewer_role: assignment.reviewer_role
    }));
  const pairAssignmentCounts = targetPairs.map((pair) => {
    const pairId = compactText(pair.pair_id);
    const assignmentsForPair = targetAssignments.filter((assignment) => assignment.pair_id === pairId);
    const roleCounts = {};
    for (const assignment of assignmentsForPair) {
      roleCounts[assignment.reviewer_role] = (roleCounts[assignment.reviewer_role] || 0) + 1;
    }
    const missingRoleCounts = [];
    for (const [role, requiredCount] of Object.entries(requiredRoleCounts)) {
      const actual = roleCounts[role] || 0;
      if (actual < requiredCount) {
        missingRoleCounts.push({
          reviewer_role: role,
          required: requiredCount,
          actual
        });
      }
    }
    return {
      pair_id: pairId,
      required_assignment_count: expectedAssignmentsPerPair,
      assignment_count: assignmentsForPair.length,
      completed_assignment_count: assignmentsForPair.filter((assignment) => completedAssignmentIds.includes(assignment.assignment_id)).length,
      missing_role_counts: missingRoleCounts
    };
  });
  const pairsWithMissingAssignmentSlots = pairAssignmentCounts
    .filter((entry) => entry.assignment_count < entry.required_assignment_count || entry.missing_role_counts.length)
    .map((entry) => entry.pair_id);

  return {
    complete: targetPairs.length > 0
      && targetAssignments.length === requiredTargetPairAssignmentCount
      && missingAssignmentIdLabels.length === 0
      && invalidAssignmentLabels.length === 0
      && duplicateAssignmentIds.length === 0
      && missingRequiredAssignments.length === 0
      && pairsWithMissingAssignmentSlots.length === 0,
    target_pair_count: targetPairs.length,
    target_pair_assignment_count: targetAssignments.length,
    required_target_pair_assignment_count: requiredTargetPairAssignmentCount,
    completed_assignment_count: completedAssignmentIds.length,
    missing_assignment_id_label_count: missingAssignmentIdLabels.length,
    invalid_assignment_label_count: invalidAssignmentLabels.length,
    duplicate_assignment_ids: duplicateAssignmentIds,
    missing_required_assignments: missingRequiredAssignments,
    missing_assignment_id_labels: missingAssignmentIdLabels,
    invalid_assignment_labels: invalidAssignmentLabels,
    pairs_with_missing_assignment_slots: pairsWithMissingAssignmentSlots,
    pairs: pairAssignmentCounts
  };
}

function reviewerKey(label = {}, index = 0) {
  return compactText(label.reviewer_id || label.reviewerId || label.annotator_id || label.annotatorId) || `anonymous:${index + 1}`;
}

function roleCountsForPair(labels = []) {
  const seen = new Set();
  const counts = {};
  for (const label of labels) {
    const key = `${label.reviewer_id}:${label.reviewer_role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[label.reviewer_role] = (counts[label.reviewer_role] || 0) + 1;
  }
  return counts;
}

function reviewerIdentityCoverageForPair(labels = [], requiredRoleCounts = {}) {
  const reviewersByRole = new Map();
  const rolesByReviewer = new Map();
  for (const label of labels) {
    const reviewerId = compactText(label.reviewer_id);
    const reviewerRole = normalizeRole(label.reviewer_role);
    if (!reviewerId || !reviewerRole) continue;
    if (!reviewersByRole.has(reviewerRole)) reviewersByRole.set(reviewerRole, new Set());
    reviewersByRole.get(reviewerRole).add(reviewerId);
    if (!rolesByReviewer.has(reviewerId)) rolesByReviewer.set(reviewerId, new Set());
    rolesByReviewer.get(reviewerId).add(reviewerRole);
  }

  const slots = reviewerSlots(requiredRoleCounts);
  const sortedSlots = slots
    .map((slot, index) => ({
      ...slot,
      index,
      candidates: [...(reviewersByRole.get(slot.reviewer_role) || new Set())].sort()
    }))
    .sort((left, right) => left.candidates.length - right.candidates.length || left.reviewer_slot.localeCompare(right.reviewer_slot));
  const matchedSlotByReviewer = new Map();
  const assignmentBySlotIndex = new Map();

  function assign(slot, seenReviewers = new Set()) {
    for (const reviewerId of slot.candidates) {
      if (seenReviewers.has(reviewerId)) continue;
      seenReviewers.add(reviewerId);
      const previousSlot = matchedSlotByReviewer.get(reviewerId);
      if (previousSlot === undefined || assign(sortedSlots[previousSlot], seenReviewers)) {
        matchedSlotByReviewer.set(reviewerId, sortedSlots.indexOf(slot));
        assignmentBySlotIndex.set(slot.index, reviewerId);
        return true;
      }
    }
    return false;
  }

  for (let slotIndex = 0; slotIndex < sortedSlots.length; slotIndex += 1) {
    assign(sortedSlots[slotIndex], new Set());
  }

  const duplicateReviewerIds = [...rolesByReviewer.entries()]
    .filter(([, roles]) => roles.size > 1)
    .map(([reviewerId]) => reviewerId)
    .sort();
  const reviewerAssignments = slots.map((slot, index) => ({
    reviewer_slot: slot.reviewer_slot,
    reviewer_role: slot.reviewer_role,
    reviewer_id: assignmentBySlotIndex.get(index) || null
  }));
  const assignedCount = reviewerAssignments.filter((entry) => entry.reviewer_id).length;
  const requiredDistinctReviewerCount = slots.length;
  return {
    independent_reviewers: requiredDistinctReviewerCount > 0 && assignedCount === requiredDistinctReviewerCount,
    distinct_reviewer_count: rolesByReviewer.size,
    required_distinct_reviewer_count: requiredDistinctReviewerCount,
    duplicate_reviewer_ids: duplicateReviewerIds,
    reviewer_assignments: reviewerAssignments
  };
}

function agreementSummary(labelsByPair = new Map()) {
  const pairSummaries = [];
  for (const [pairId, labels] of labelsByPair.entries()) {
    const choices = labels.map((label) => label.selected_side).filter((side) => ['left', 'right', 'tie'].includes(side));
    if (choices.length < 2) continue;
    const counts = {};
    choices.forEach((choice) => {
      counts[choice] = (counts[choice] || 0) + 1;
    });
    const majorityCount = Math.max(...Object.values(counts));
    pairSummaries.push({
      pair_id: pairId,
      label_count: choices.length,
      majority_choice: Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] || null,
      majority_agreement: roundMetric(majorityCount / choices.length)
    });
  }
  return {
    pair_count: pairSummaries.length,
    average_majority_agreement: roundMetric(average(pairSummaries.map((entry) => entry.majority_agreement), null)),
    pairs: pairSummaries
  };
}

function comparisonCoverage(answerKey = {}, protocol = {}) {
  const requiredFamilies = asArray(protocol.required_comparison_families).map(normalizeComparisonFamily).filter(Boolean);
  const targetSystem = normalizeKey(protocol.target_system || answerKey.target_system || DEFAULT_HUMAN_BLIND_REVIEW_PROTOCOL.target_system);
  const targetPairs = asArray(answerKey.pairs).filter((pair) => pair.target_side);
  const covered = new Set();
  const pairs = [];
  for (const pair of targetPairs) {
    const targetSide = pair.target_side;
    const comparatorSide = targetSide === 'left' ? 'right' : 'left';
    const comparatorSystem = normalizeKey(pair[comparatorSide]?.system_key);
    const comparatorFamily = normalizeComparisonFamily(comparatorSystem);
    if (comparatorFamily) covered.add(comparatorFamily);
    pairs.push({
      pair_id: pair.pair_id,
      target_system: targetSystem,
      comparator_system: comparatorSystem || null,
      comparator_family: comparatorFamily || null
    });
  }
  const coveredFamilies = [...covered].sort();
  const missingFamilies = requiredFamilies.filter((family) => !covered.has(family));
  return {
    complete: requiredFamilies.length > 0 && missingFamilies.length === 0,
    target_system: targetSystem,
    required_comparison_families: requiredFamilies,
    covered_comparison_families: coveredFamilies,
    missing_comparison_families: missingFamilies,
    target_pair_count: targetPairs.length,
    pairs
  };
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

function collectForbiddenPublicKeys(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectForbiddenPublicKeys(entry, `${prefix}[${index}]`));
  }
  if (!isObject(value)) return [];
  const findings = [];
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (BLINDING_FORBIDDEN_PUBLIC_KEYS.has(normalizeKey(key))) findings.push(keyPath);
    findings.push(...collectForbiddenPublicKeys(child, keyPath));
  }
  return findings;
}

function auditBlindReviewProtocol(params = {}) {
  const blindPack = asObject(params.blindPack || params.blind_pack);
  const assignments = asObject(params.assignments || params.assignmentPack || params.assignment_pack);
  const answerKey = asObject(params.answerKey || params.answer_key);
  const missingPublicArtifacts = [
    ...(Object.keys(blindPack).length ? [] : ['blind_pack']),
    ...(Object.keys(assignments).length ? [] : ['assignments'])
  ];
  const forbiddenPublicFields = [
    ...collectForbiddenPublicKeys(blindPack, 'blind_pack'),
    ...collectForbiddenPublicKeys(assignments, 'assignments')
  ];
  const unexpectedPayloadFields = asArray(blindPack.packets)
    .flatMap((packet, index) => Object.keys(asObject(packet.payload))
      .filter((key) => !REVIEW_VISIBLE_PACKET_KEYS.has(normalizeKey(key)))
      .map((key) => `blind_pack.packets[${index}].payload.${key}`));
  const answerKeyPrivate = answerKey.private === true;
  return {
    complete: missingPublicArtifacts.length === 0
      && forbiddenPublicFields.length === 0
      && unexpectedPayloadFields.length === 0
      && answerKeyPrivate,
    public_artifacts_present: missingPublicArtifacts.length === 0,
    payload_policy: 'proposal_and_evidence_export_only',
    missing_public_artifacts: missingPublicArtifacts,
    forbidden_public_fields: forbiddenPublicFields,
    unexpected_public_payload_fields: unexpectedPayloadFields,
    answer_key_private: answerKeyPrivate
  };
}

export function buildHumanBlindReleaseReadiness(aggregation = {}) {
  const reviewerProtocol = asObject(aggregation.reviewer_protocol);
  const labelCounts = asObject(aggregation.label_counts);
  const reviewFormProtocol = asObject(aggregation.review_form_protocol);
  const assignmentProtocol = asObject(aggregation.assignment_protocol || aggregation.assignmentProtocol);
  const comparisonProtocol = asObject(aggregation.comparison_protocol);
  const blindingProtocol = asObject(aggregation.blinding_protocol || aggregation.blindingProtocol);
  const targetPreferenceRate = Number(aggregation.target_preference_rate);
  const preferenceThreshold = Number(aggregation.preference_threshold);
  const targetPairCount = Number(reviewerProtocol.target_pair_count || 0);
  const validHumanTargetPairCount = Number(labelCounts.valid_human_target_pair || 0);
  const pairsWithoutIndependentReviewers = asArray(reviewerProtocol.pairs)
    .filter((entry) => entry.independent_reviewers !== true)
    .map((entry) => entry.pair_id)
    .filter(Boolean);
  const checks = [
    releaseCheck(
      'aggregation_status_passed',
      aggregation.status === 'passed' ? 'passed' : 'incomplete',
      aggregation.status === 'passed' ? '' : 'human blind aggregation did not pass',
      { aggregation_status: compactText(aggregation.status || 'unknown') }
    ),
    releaseCheck(
      'independent_human_labels_present',
      validHumanTargetPairCount > 0 ? 'passed' : 'incomplete',
      validHumanTargetPairCount > 0 ? '' : 'missing independent human target-pair labels',
      { valid_human_target_pair_count: validHumanTargetPairCount }
    ),
    releaseCheck(
      'reviewer_protocol_satisfied',
      reviewerProtocol.sufficient_reviewers === true ? 'passed' : 'incomplete',
      reviewerProtocol.sufficient_reviewers === true ? '' : 'required reviewer role counts are not satisfied',
      { target_pair_count: targetPairCount }
    ),
    releaseCheck(
      'reviewer_identity_independence_satisfied',
      reviewerProtocol.independent_reviewers === true ? 'passed' : 'incomplete',
      reviewerProtocol.independent_reviewers === true ? '' : 'required reviewer slots are not covered by distinct reviewer identities',
      {
        target_pair_count: targetPairCount,
        pairs_without_independent_reviewers: pairsWithoutIndependentReviewers
      }
    ),
    releaseCheck(
      'assignment_coverage_satisfied',
      assignmentProtocol.complete === true ? 'passed' : 'incomplete',
      assignmentProtocol.complete === true ? '' : 'completed labels must bind to generated assignments for every target-pair reviewer slot',
      {
        target_pair_assignment_count: assignmentProtocol.target_pair_assignment_count || 0,
        required_target_pair_assignment_count: assignmentProtocol.required_target_pair_assignment_count || 0,
        completed_assignment_count: assignmentProtocol.completed_assignment_count || 0,
        missing_assignment_id_label_count: assignmentProtocol.missing_assignment_id_label_count || 0,
        invalid_assignment_label_count: assignmentProtocol.invalid_assignment_label_count || 0,
        missing_required_assignment_count: asArray(assignmentProtocol.missing_required_assignments).length,
        duplicate_assignment_ids: asArray(assignmentProtocol.duplicate_assignment_ids)
      }
    ),
    releaseCheck(
      'review_form_completeness_satisfied',
      reviewFormProtocol.complete === true ? 'passed' : 'incomplete',
      reviewFormProtocol.complete === true ? '' : 'human labels must include complete dimension scores, explicit confidence, and recorded major concerns',
      {
        valid_human_target_pair_label_count: reviewFormProtocol.valid_human_target_pair_label_count || 0,
        complete_dimension_score_label_count: reviewFormProtocol.complete_dimension_score_label_count || 0,
        explicit_confidence_label_count: reviewFormProtocol.explicit_confidence_label_count || 0,
        major_concerns_label_count: reviewFormProtocol.major_concerns_label_count || 0
      }
    ),
    releaseCheck(
      'comparison_coverage_satisfied',
      comparisonProtocol.complete === true ? 'passed' : 'incomplete',
      comparisonProtocol.complete === true ? '' : 'target-system blind pairs must cover baseline, P0, P1, and ablation comparators',
      {
        required_comparison_families: asArray(comparisonProtocol.required_comparison_families),
        covered_comparison_families: asArray(comparisonProtocol.covered_comparison_families),
        missing_comparison_families: asArray(comparisonProtocol.missing_comparison_families)
      }
    ),
    releaseCheck(
      'blinding_protocol_satisfied',
      blindingProtocol.complete === true ? 'passed' : 'incomplete',
      blindingProtocol.complete === true ? '' : 'blind review public artifacts must omit system/model identifiers and keep answer-key private',
      {
        public_artifacts_present: blindingProtocol.public_artifacts_present === true,
        missing_public_artifacts: asArray(blindingProtocol.missing_public_artifacts),
        forbidden_public_fields: asArray(blindingProtocol.forbidden_public_fields),
        answer_key_private: blindingProtocol.answer_key_private === true
      }
    ),
    releaseCheck(
      'target_preference_threshold_met',
      Number.isFinite(targetPreferenceRate) && Number.isFinite(preferenceThreshold) && targetPreferenceRate >= preferenceThreshold ? 'passed' : 'incomplete',
      Number.isFinite(targetPreferenceRate) && Number.isFinite(preferenceThreshold) && targetPreferenceRate >= preferenceThreshold ? '' : 'target preference rate is below threshold',
      {
        target_preference_rate: Number.isFinite(targetPreferenceRate) ? targetPreferenceRate : null,
        preference_threshold: Number.isFinite(preferenceThreshold) ? preferenceThreshold : null
      }
    ),
    releaseCheck(
      'target_pairs_present',
      targetPairCount > 0 ? 'passed' : 'incomplete',
      targetPairCount > 0 ? '' : 'missing target-system blind pairs',
      { target_pair_count: targetPairCount }
    )
  ];
  const status = checks.every((entry) => entry.status === 'passed') ? 'ready_for_release_gate' : 'incomplete';
  return {
    status,
    releaseCandidate: status === 'ready_for_release_gate',
    reason: status === 'ready_for_release_gate'
      ? 'human_blind_protocol_and_preference_gate_passed'
      : checks.find((entry) => entry.status !== 'passed')?.message || 'human blind release readiness incomplete',
    checks
  };
}

function pairMeetsProtocol(pairLabels = [], requiredRoleCounts = {}) {
  const counts = roleCountsForPair(pairLabels);
  const identityCoverage = reviewerIdentityCoverageForPair(pairLabels, requiredRoleCounts);
  const missing = [];
  for (const [role, requiredCount] of Object.entries(requiredRoleCounts)) {
    const count = counts[role] || 0;
    if (count < requiredCount) {
      missing.push({
        reviewer_role: role,
        required: requiredCount,
        actual: count
      });
    }
  }
  return {
    passed: missing.length === 0 && identityCoverage.independent_reviewers,
    role_counts: counts,
    missing,
    ...identityCoverage
  };
}

export function aggregateHumanBlindEvaluationLabels(params = {}) {
  const answerKey = asObject(params.answerKey || params.answer_key);
  const protocol = normalizeProtocol(params, { protocol: answerKey });
  const labels = normalizeLabels(params.labels || params.input || params.reviews);
  const inputs = asArray(params.inputs).filter(Boolean);
  const assignmentRecords = normalizeAssignmentRecords(params.assignments || params.assignmentPack || params.assignment_pack);
  const assignmentById = new Map(assignmentRecords.map((assignment) => [assignment.assignment_id, assignment]));
  const pairById = new Map(asArray(answerKey.pairs).map((pair) => [pair.pair_id, pair]));
  const normalized = labels.map((label, index) => {
    const raw = asObject(label);
    const humanStatus = humanLabelStatus(raw);
    const assignmentAudit = assignmentLinkAudit(raw, assignmentById);
    const selectedSide = normalizeSelectedSide(raw.selected_side || raw.selectedSide || raw.preference || raw.winner);
    const pairId = compactText(raw.pair_id || raw.pairId);
    const pair = pairById.get(pairId);
    const targetSide = pair?.target_side || null;
    const targetPreference = targetSide && selectedSide !== 'unclear'
      ? (selectedSide === 'tie' ? 0.5 : (selectedSide === targetSide ? 1 : 0))
      : null;
    return {
      pair_id: pairId,
      reviewer_id: reviewerKey(raw, index),
      reviewer_role: normalizeRole(raw.reviewer_role || raw.reviewerRole || raw.role),
      assignment_id: assignmentAudit.assignment_id,
      assignment_valid: assignmentAudit.assignment_valid,
      assignment_issue: assignmentAudit.assignment_issue,
      reviewer_slot: assignmentAudit.reviewer_slot,
      selected_side: selectedSide,
      confidence: clamp01(raw.confidence ?? raw.confidence_score ?? raw.confidenceScore, 1),
      explicit_confidence: hasExplicitConfidence(raw),
      major_concerns_recorded: hasRecordedMajorConcerns(raw),
      score_completeness: scoreCompletenessForLabel(raw, pair, protocol.dimensions),
      human: humanStatus.human,
      excluded_reason: humanStatus.human ? null : humanStatus.reason,
      target_preference: targetPreference,
      raw
    };
  });
  const validHumanLabels = normalized.filter((label) => label.human && pairById.has(label.pair_id));
  const validTargetLabels = validHumanLabels.filter((label) => Number.isFinite(label.target_preference));
  const targetPreferenceValues = validTargetLabels.map((label) => label.target_preference);
  const confidenceWeightSum = validTargetLabels.reduce((sum, label) => sum + label.confidence, 0);
  const confidenceWeightedPreference = confidenceWeightSum
    ? validTargetLabels.reduce((sum, label) => sum + (label.target_preference * label.confidence), 0) / confidenceWeightSum
    : null;
  const labelsByPair = new Map();
  const targetLabelsByPair = new Map();

  for (const label of validHumanLabels) {
    if (!labelsByPair.has(label.pair_id)) labelsByPair.set(label.pair_id, []);
    labelsByPair.get(label.pair_id).push(label);
    if (Number.isFinite(label.target_preference)) {
      if (!targetLabelsByPair.has(label.pair_id)) targetLabelsByPair.set(label.pair_id, []);
      targetLabelsByPair.get(label.pair_id).push(label);
    }
  }

  const targetPairs = asArray(answerKey.pairs).filter((pair) => pair.target_side);
  const comparisonProtocol = comparisonCoverage(answerKey, protocol);
  const pairProtocol = targetPairs.map((pair) => ({
    pair_id: pair.pair_id,
    ...pairMeetsProtocol(targetLabelsByPair.get(pair.pair_id) || [], protocol.required_role_counts)
  }));
  const sufficientReviewers = targetPairs.length > 0 && pairProtocol.every((entry) => entry.passed);
  const independentReviewers = targetPairs.length > 0 && pairProtocol.every((entry) => entry.independent_reviewers);
  const preferenceRate = roundMetric(average(targetPreferenceValues, null));
  const weightedPreferenceRate = roundMetric(confidenceWeightedPreference);
  const assignmentProtocol = summarizeAssignmentCoverage(validTargetLabels, targetPairs, assignmentRecords, protocol.required_role_counts);
  const reviewFormProtocol = summarizeReviewFormCompleteness(validTargetLabels, protocol.dimensions);
  const blindingProtocol = auditBlindReviewProtocol({
    blindPack: params.blindPack || params.blind_pack,
    assignments: params.assignments || params.assignmentPack || params.assignment_pack,
    answerKey
  });
  const status = !targetPairs.length || !validTargetLabels.length || !sufficientReviewers
    ? 'incomplete'
    : (preferenceRate >= protocol.preference_threshold ? 'passed' : 'failed');

  const aggregation = {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    status,
    target_system: protocol.target_system,
    preference_threshold: protocol.preference_threshold,
    label_counts: {
      total: normalized.length,
      valid_human: validHumanLabels.length,
      valid_human_target_pair: validTargetLabels.length,
      excluded_non_human: normalized.filter((label) => !label.human).length
    },
    target_preference_rate: preferenceRate,
    confidence_weighted_target_preference_rate: weightedPreferenceRate,
    per_dimension: summarizeDimensionScores(validTargetLabels, pairById, protocol.dimensions),
    assignment_protocol: assignmentProtocol,
    review_form_protocol: reviewFormProtocol,
    comparison_protocol: comparisonProtocol,
    blinding_protocol: blindingProtocol,
    reviewer_protocol: {
      sufficient_reviewers: sufficientReviewers,
      independent_reviewers: independentReviewers,
      required_role_counts: protocol.required_role_counts,
      target_pair_count: targetPairs.length,
      pairs: pairProtocol
    },
    inter_reviewer_agreement: agreementSummary(targetLabelsByPair),
    ...(inputs.length ? { inputs } : {}),
    excluded_labels: normalized
      .filter((label) => !label.human)
      .map((label) => ({
        pair_id: label.pair_id,
        reviewer_id: label.reviewer_id,
        reviewer_role: label.reviewer_role,
        reason: label.excluded_reason
      }))
  };
  return {
    ...aggregation,
    releaseReadiness: buildHumanBlindReleaseReadiness(aggregation)
  };
}

function resolvePath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function hashFile(absolutePath = '') {
  if (!absolutePath) return null;
  const data = await fs.readFile(absolutePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileInputRecord(role, filePath = '') {
  const absolutePath = resolvePath(filePath);
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

async function buildInputRecords(params = {}) {
  const records = await Promise.all([
    fileInputRecord('human_blind_cases', params.inputPath || params.input_path),
    fileInputRecord('human_blind_labels', params.labelsPath || params.labels_path)
  ]);
  return records.filter(Boolean);
}

async function readOptionalJson(filePath = '') {
  const absolutePath = resolvePath(filePath);
  return absolutePath ? readJson(absolutePath, {}) : {};
}

export async function prepareHumanBlindEvaluation(params = {}) {
  const input = isObject(params.input)
    ? params.input
    : await readOptionalJson(params.inputPath || params.input_path);
  const labels = isObject(params.labels) || Array.isArray(params.labels)
    ? params.labels
    : await readOptionalJson(params.labelsPath || params.labels_path);
  const outputDir = resolvePath(params.outputDir || params.output_dir);
  const blindPackPath = outputDir ? path.join(outputDir, 'blind-pack.json') : '';
  const assignmentsPath = outputDir ? path.join(outputDir, 'assignments.json') : '';
  const answerKeyPath = outputDir ? path.join(outputDir, 'answer-key.json') : '';
  const reviewFormSchemaPath = outputDir ? path.join(outputDir, 'review-form.schema.json') : '';
  const aggregationPath = outputDir ? path.join(outputDir, 'aggregation.json') : '';
  const pack = buildHumanBlindEvaluationPack({
    ...params,
    input
  });
  const inputs = await buildInputRecords(params);
  const hasLabels = Array.isArray(labels) ? labels.length > 0 : asArray(labels.labels || labels.reviews || labels.records).length > 0;
  const aggregation = hasLabels
    ? aggregateHumanBlindEvaluationLabels({
      labels,
      answerKey: pack.answerKey,
      blindPack: pack.blindPack,
      assignments: pack.assignments,
      protocol: pack.protocol,
      inputs
    })
    : null;
  let aggregationOutput = aggregation;
  let blindReviewArtifacts = [];

  if (outputDir) {
    await ensureDir(outputDir);
    await writeJson(blindPackPath, pack.blindPack);
    await writeJson(assignmentsPath, pack.assignments);
    await writeJson(answerKeyPath, pack.answerKey);
    await writeJson(reviewFormSchemaPath, pack.reviewFormSchema);
    blindReviewArtifacts = (await Promise.all([
      fileInputRecord('human_blind_pack', blindPackPath),
      fileInputRecord('human_blind_assignments', assignmentsPath),
      fileInputRecord('human_blind_answer_key', answerKeyPath),
      fileInputRecord('human_blind_review_form_schema', reviewFormSchemaPath)
    ])).filter(Boolean);
    if (aggregation) {
      aggregationOutput = {
        ...aggregation,
        blind_review_artifacts: blindReviewArtifacts
      };
      await writeJson(aggregationPath, aggregationOutput);
    }
  }

  return {
    contractVersion: HUMAN_BLIND_EVAL_VERSION,
    runId: pack.runId,
    status: aggregationOutput?.status || 'prepared',
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    answerKey: pack.answerKey,
    reviewFormSchema: pack.reviewFormSchema,
    aggregation: aggregationOutput,
    inputs,
    blindReviewArtifacts,
    artifacts: outputDir ? {
      outputDir,
      blindPackPath,
      assignmentsPath,
      answerKeyPath,
      reviewFormSchemaPath,
      aggregationPath: aggregationOutput ? aggregationPath : null
    } : null
  };
}
