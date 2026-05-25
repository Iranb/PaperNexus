import { stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';

const EVIDENCE_TIERS = ['missing', 'weak', 'moderate', 'strong'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeLabel(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 5 : numeric));
}

function textTokens(value) {
  return tokenizeWithoutStopwords(String(value || '').toLowerCase());
}

function normalizeMechanisms(entry = {}) {
  return unique([
    entry.integration_mechanism,
    entry.integrationMechanism,
    entry.mechanism,
    entry.idea_fragment?.integration_mechanism,
    ...asArray(entry.mechanisms),
    ...asArray(entry.shared_mechanisms),
    ...asArray(entry.ranking_signals?.shared_mechanisms)
  ].flatMap((value) => (
    typeof value === 'string'
      ? value.split(/[;,]/)
      : [value]
  )).map((value) => normalizeLabel(value)).filter(Boolean));
}

function normalizeSourceDomains(entry = {}) {
  return unique([
    entry.source_domain,
    entry.sourceDomain,
    entry.domain,
    entry.ranking_signals?.source_domain,
    ...asArray(entry.source_domains),
    ...asArray(entry.sourceDomains)
  ].map((value) => normalizeLabel(value)).filter(Boolean));
}

function normalizeSourceSpanIds(entry = {}) {
  return unique([
    ...asArray(entry.source_span_ids),
    ...asArray(entry.sourceSpanIds),
    ...asArray(entry.source_spans).map((span) => span.span_id || span.spanId || span.id),
    ...asArray(entry.idea_fragment?.source_spans).map((span) => span.span_id || span.spanId || span.id)
  ].map((value) => normalizeLabel(value)).filter(Boolean));
}

function normalizeBridgePathIds(entry = {}) {
  return unique([
    ...asArray(entry.bridge_path_ids),
    ...asArray(entry.bridgePathIds),
    ...asArray(entry.supporting_bridge_paths),
    ...asArray(entry.supportingBridgePaths),
    entry.path_id,
    entry.pathId
  ].map((value) => normalizeLabel(value)).filter(Boolean));
}

function inferEvidenceTier(entry = {}) {
  const explicit = normalizeLabel(entry.evidence_tier || entry.evidenceTier || entry.idea_fragment?.evidence_tier).toLowerCase();
  if (EVIDENCE_TIERS.includes(explicit)) return explicit;

  const bridgePathIds = normalizeBridgePathIds(entry);
  const sourceSpanIds = normalizeSourceSpanIds(entry);
  const evidenceChainRefs = asArray(entry.evidence_chain_refs || entry.evidenceChainRefs);
  const supportingPapers = asArray(entry.supporting_papers || entry.supportingPapers || entry.supporting_paper_keys);
  const supportingNodes = asArray(entry.supporting_kg_nodes || entry.supportingKgNodes);

  if (bridgePathIds.length && (sourceSpanIds.length || evidenceChainRefs.length)) return 'strong';
  if (bridgePathIds.length || sourceSpanIds.length || evidenceChainRefs.length || supportingPapers.length) return 'moderate';
  if (supportingNodes.length || asArray(entry.source_takeaways).length) return 'weak';
  return 'missing';
}

function normalizeTargetAspects(entry = {}) {
  return unique([
    entry.target_aspect,
    entry.targetAspect,
    entry.target_challenge_id,
    entry.targetChallengeId,
    entry.abstract_challenge,
    entry.abstractChallenge,
    ...asArray(entry.target_aspects),
    ...asArray(entry.targetAspects)
  ].map((value) => normalizeLabel(value)).filter(Boolean));
}

function utilityScore(entry = {}) {
  const rankingSignals = entry.ranking_signals || {};
  const graphPotential = normalizeScore(rankingSignals.interdisciplinary_potential, 0);
  const novelty = normalizeScore(entry.novelty_score ?? entry.noveltyScore, 0);
  const usefulness = normalizeScore(entry.usefulness_score ?? entry.usefulnessScore, 0);
  const completeness = normalizeScore(entry.path_completeness ?? entry.idea_fragment?.path_completeness, 0);
  const density = normalizeScore(entry.evidence_density ?? entry.idea_fragment?.evidence_density, 0);
  const evidenceBoost = {
    strong: 1,
    moderate: 0.75,
    weak: 0.35,
    missing: 0
  }[inferEvidenceTier(entry)] || 0;
  const score = (
    (0.3 * graphPotential)
    + (0.25 * usefulness)
    + (0.15 * novelty)
    + (0.15 * evidenceBoost)
    + (0.1 * completeness)
    + (0.05 * density)
  );
  return Number(Math.max(0, Math.min(1, score || evidenceBoost * 0.4)).toFixed(4));
}

export function evidenceTierRank(tier) {
  const index = EVIDENCE_TIERS.indexOf(String(tier || '').toLowerCase());
  return index === -1 ? 0 : index;
}

export function normalizeIdeaCandidate(entry = {}, index = 0, context = {}) {
  const candidateId = normalizeLabel(
    entry.candidateId
      || entry.candidate_id
      || entry.id
      || entry.path_id
      || `idea:${stableHash(JSON.stringify(entry).slice(0, 2000), 14)}`
  );
  const sourceDomains = normalizeSourceDomains(entry);
  const mechanisms = normalizeMechanisms(entry);
  const bridgePathIds = normalizeBridgePathIds(entry);
  const sourceSpanIds = normalizeSourceSpanIds(entry);
  const evidenceTier = inferEvidenceTier(entry);
  const targetChallenge = normalizeLabel(
    entry.target_challenge
      || entry.targetChallenge
      || entry.abstract_challenge
      || entry.problem
      || context.problem
  );
  const title = normalizeLabel(entry.title || entry.idea_fragment?.title || entry.name, candidateId);
  const targetAspects = normalizeTargetAspects(entry);
  const riskFlags = [];
  if (evidenceTier === 'missing') riskFlags.push('missing_evidence');
  if (!bridgePathIds.length) riskFlags.push('missing_bridge_path');
  if (!sourceSpanIds.length && evidenceTier !== 'strong') riskFlags.push('missing_source_span');
  if (!mechanisms.length) riskFlags.push('missing_mechanism');

  return {
    candidateId,
    candidate_id: candidateId,
    rank: Number(entry.rank || index + 1),
    title,
    targetChallenge,
    target_challenge: targetChallenge,
    sourceDomains,
    source_domains: sourceDomains,
    mechanisms,
    targetAspects,
    target_aspects: targetAspects,
    bridgePathIds,
    bridge_path_ids: bridgePathIds,
    sourceSpanIds,
    source_span_ids: sourceSpanIds,
    evidenceTier,
    evidence_tier: evidenceTier,
    utility: utilityScore(entry),
    riskFlags,
    risk_flags: riskFlags,
    similarity_text: unique([
      title,
      targetChallenge,
      ...sourceDomains,
      ...mechanisms,
      ...targetAspects,
      ...bridgePathIds
    ].filter(Boolean)).join(' '),
    token_count: textTokens([
      title,
      targetChallenge,
      ...sourceDomains,
      ...mechanisms
    ].join(' ')).length,
    raw: entry
  };
}

export function normalizeIdeaCandidates(entries = [], context = {}) {
  return asArray(entries).map((entry, index) => normalizeIdeaCandidate(entry, index, context));
}
