import { EDGE_TYPES } from '../graph/schema.js';
import { unique } from '../../lib/utils.js';

export const MIN_SEMANTIC_CONFIDENCE = 0.55;
export const AUTHORITATIVE_SEMANTIC_CONFIDENCE = 0.78;

export const STRONG_METHOD_EVOLUTION_EDGE_TYPES = new Set([
  EDGE_TYPES.EXTENDS_METHOD,
  EDGE_TYPES.IMPROVES_METHOD,
  EDGE_TYPES.REPLACES_METHOD,
  EDGE_TYPES.ADAPTS_METHOD,
  EDGE_TYPES.USES_COMPONENT_METHOD
]);

export const CONTEXT_METHOD_CITATION_EDGE_TYPES = new Set([
  EDGE_TYPES.COMPARES_METHOD,
  EDGE_TYPES.BACKGROUND_METHOD
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasText(value) {
  return String(value || '').trim().length > 0;
}

function evidenceReason(field) {
  return `missing_evidence_${field.replace(/\./g, '_')}`;
}

export function isStrongMethodEvolutionType(edgeType) {
  return STRONG_METHOD_EVOLUTION_EDGE_TYPES.has(edgeType);
}

export function isContextMethodCitationType(edgeType) {
  return CONTEXT_METHOD_CITATION_EDGE_TYPES.has(edgeType);
}

export function assessMethodEvolutionEvidenceCompleteness(candidate = {}) {
  if (!isStrongMethodEvolutionType(candidate.edgeType)) {
    return {
      status: 'not_required',
      missingFields: []
    };
  }

  const missingFields = [];
  if (!hasText(candidate.bottleneck?.dimension)) missingFields.push('bottleneck.dimension');
  if (!hasText(candidate.bottleneck?.description)) missingFields.push('bottleneck.description');
  if (!hasText(candidate.mechanism?.dimension || candidate.mechanism?.type)) missingFields.push('mechanism.type');
  if (!hasText(candidate.mechanism?.description)) missingFields.push('mechanism.description');
  if (!hasText(candidate.tradeoff?.dimension)) missingFields.push('tradeoff.dimension');
  if (!Number.isFinite(Number(candidate.confidence))) missingFields.push('confidence');

  return {
    status: missingFields.length ? 'incomplete' : 'complete',
    missingFields
  };
}

export function validateMethodEvolutionCandidate(candidate = {}) {
  const reasons = [];
  const isStrongEdge = isStrongMethodEvolutionType(candidate.edgeType);
  if (!candidate.sourceMethodId) reasons.push('missing_source_method');
  if (!candidate.targetMethodId) reasons.push('missing_target_method');
  if (candidate.targetStubId) reasons.push('target_method_stub');
  if (!candidate.edgeType) reasons.push('missing_method_evolution_type');
  if (isStrongEdge && !candidate.exactQuote) reasons.push('missing_exact_quote');
  if (!candidate.citationContext) reasons.push('missing_citation_context');
  const quoteValidationContext = candidate.quoteValidationContext || candidate.citationContext;
  if (candidate.exactQuote && quoteValidationContext && !quoteValidationContext.includes(candidate.exactQuote)) {
    reasons.push('quote_not_exact_match');
  }
  if (Number(candidate.semanticConfidence || 0) < MIN_SEMANTIC_CONFIDENCE) {
    reasons.push('low_semantic_confidence');
  }
  if (isStrongEdge && candidate.temporalDirection === 'unknown') reasons.push('missing_temporal_year');
  if (isStrongEdge && candidate.temporalDirection === 'reverse') reasons.push('reverse_temporal_direction');

  const evidenceCompleteness = assessMethodEvolutionEvidenceCompleteness(candidate);
  if (isStrongEdge && evidenceCompleteness.status === 'incomplete') {
    reasons.push(...evidenceCompleteness.missingFields.map(evidenceReason));
  }

  if (reasons.length) {
    return {
      validationStatus: 'candidate',
      validationReasons: unique(reasons),
      validatorStatus: 'blocked',
      validatorReasons: unique(reasons),
      evidenceCompleteness
    };
  }

  const authoritative = isStrongEdge
    && candidate.resolutionStatus === 'resolved-paper-method'
    && Number(candidate.semanticConfidence || 0) >= AUTHORITATIVE_SEMANTIC_CONFIDENCE;
  return {
    validationStatus: authoritative ? 'authoritative' : 'validated',
    validationReasons: [],
    validatorStatus: 'passed',
    validatorReasons: [],
    evidenceCompleteness
  };
}

export function addCandidateValidationReason(candidate = {}, reason = '') {
  if (!reason) return candidate;
  const validationReasons = unique([
    ...asArray(candidate.validationReasons),
    reason
  ]);
  return {
    ...candidate,
    validationStatus: 'candidate',
    validationReasons,
    validatorStatus: 'blocked',
    validatorReasons: unique([
      ...asArray(candidate.validatorReasons),
      reason
    ])
  };
}

function strongMethodPairKey(candidate = {}) {
  if (!isStrongMethodEvolutionType(candidate.edgeType)) return null;
  if (!candidate.sourceMethodId || !candidate.targetMethodId) return null;
  return `${candidate.sourceMethodId}->${candidate.targetMethodId}`;
}

function reverseStrongMethodPairKey(candidate = {}) {
  if (!isStrongMethodEvolutionType(candidate.edgeType)) return null;
  if (!candidate.sourceMethodId || !candidate.targetMethodId) return null;
  return `${candidate.targetMethodId}->${candidate.sourceMethodId}`;
}

export function applyStrongEdgeConflictValidation(records = []) {
  const byDirection = new Map();
  for (const candidate of asArray(records)) {
    const key = strongMethodPairKey(candidate);
    if (!key) continue;
    if (!byDirection.has(key)) byDirection.set(key, []);
    byDirection.get(key).push(candidate.id);
  }

  const conflictedIds = new Set();
  for (const candidate of asArray(records)) {
    const reverseKey = reverseStrongMethodPairKey(candidate);
    if (!reverseKey || !byDirection.has(reverseKey)) continue;
    conflictedIds.add(candidate.id);
    for (const candidateId of byDirection.get(reverseKey)) {
      conflictedIds.add(candidateId);
    }
  }

  if (!conflictedIds.size) return records;
  return records.map((candidate) => (
    conflictedIds.has(candidate.id)
      ? addCandidateValidationReason(candidate, 'conflicting_strong_method_direction')
      : candidate
  ));
}
