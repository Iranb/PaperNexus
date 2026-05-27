import {
  asArray,
  compactText,
  collectSourceSpans,
  collectSupportingPapers,
  normalizeScore,
  resolveLimit,
  stableHash,
  uniqueBy
} from './innovation-artifact-utils.js';
import { buildContributionClaims } from './claim-linking.js';

export const COUNTERFACTUAL_SEARCH_CONTRACT_VERSION = 'papernexus-counterfactual-search-v1';

const DEFAULT_SELECTED_BUDGET = 2;
const MAX_SELECTED_BUDGET = 10;
const MAX_SEARCH_BUDGET = 50;

const TYPE_DEFAULTS = {
  baseline_swap: {
    baseScore: 0.72,
    requiredEvidence: ['baseline_comparison', 'ablation', 'negative_case']
  },
  assumption_stress: {
    baseScore: 0.68,
    requiredEvidence: ['assumption_audit', 'boundary_condition', 'negative_case']
  },
  dataset_shift: {
    baseScore: 0.62,
    requiredEvidence: ['cross_dataset_evaluation', 'domain_shift_slice', 'negative_case']
  },
  metric_shift: {
    baseScore: 0.58,
    requiredEvidence: ['metric_sensitivity', 'secondary_metric', 'ablation']
  },
  temporal_cutoff: {
    baseScore: 0.7,
    requiredEvidence: ['time_cutoff_replay', 'prior_art_before_cutoff', 'future_leakage_check']
  }
};

function firstConfigured(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeTextList(values = []) {
  return asArray(values).map(compactText).filter(Boolean);
}

function collectChallenges(payload = {}) {
  return uniqueBy(asArray(payload.target_domain_analysis || payload.targetDomainAnalysis)
    .flatMap((analysis) => asArray(analysis.remaining_challenges || analysis.remainingChallenges)
      .map((challenge, index) => ({
        challenge_id: compactText(challenge.challenge_id || challenge.challengeId || challenge.id || `challenge:${stableHash(`${challenge.domain_agnostic_challenge || challenge.challenge || index}`, 10)}`),
        text: compactText(challenge.domain_agnostic_challenge || challenge.challenge || challenge.text || challenge.name),
        target_domain: compactText(analysis.target_domain || analysis.targetDomain || payload.target_domain || payload.targetDomain)
      })))
    .filter((challenge) => challenge.challenge_id || challenge.text), (challenge) => challenge.challenge_id || challenge.text);
}

function collectTakeaways(payload = {}) {
  return uniqueBy(asArray(payload.source_domain_analyses || payload.sourceDomainAnalyses)
    .flatMap((analysis) => asArray(analysis.takeaways || analysis.takeaway_cards || analysis.takeawayCards)
      .map((takeaway, index) => ({
        takeaway_id: compactText(takeaway.takeaway_id || takeaway.takeawayId || takeaway.id || `takeaway:${stableHash(`${takeaway.concept || takeaway.text || index}`, 10)}`),
        text: compactText(takeaway.concept || takeaway.takeaway || takeaway.text || takeaway.summary),
        source_domain: compactText(analysis.source_domain || analysis.sourceDomain)
      })))
    .filter((takeaway) => takeaway.takeaway_id || takeaway.text), (takeaway) => takeaway.takeaway_id || takeaway.text);
}

function collectMustCiteSet(payload = {}, options = {}, supportingPapers = []) {
  return uniqueBy([
    ...asArray(options.mustCiteSet || options.must_cite_set || payload.must_cite_set || payload.mustCiteSet),
    ...supportingPapers.map((paper) => ({
      paper_key: paper.paper_key,
      title: paper.title,
      source_domain: paper.source_domain,
      year: paper.year,
      coverage_status: 'covered',
      temporal_status: 'within_cutoff'
    }))
  ].map((paper, index) => ({
    paper_key: compactText(paper.paper_key || paper.paperKey || paper.id || paper.paper_id || paper.paperId),
    title: compactText(paper.title || paper.paper_title || paper.paperTitle || paper.name),
    source_domain: compactText(paper.source_domain || paper.sourceDomain),
    year: paper.year || paper.publication_year || paper.publicationYear || null,
    coverage_status: compactText(paper.coverage_status || paper.coverageStatus),
    temporal_status: compactText(paper.temporal_status || paper.temporalStatus),
    rank: Number.isFinite(Number(paper.rank)) ? Number(paper.rank) : index + 1
  })).filter((paper) => paper.paper_key || paper.title), (paper) => paper.paper_key || paper.title);
}

function collectReviewConcerns(payload = {}, options = {}) {
  const reviewPacket = options.reviewPacket || options.review_packet || payload.review_packet || payload.reviewPacket || {};
  return uniqueBy([
    ...asArray(reviewPacket.major_concerns || reviewPacket.majorConcerns),
    ...asArray(reviewPacket.reviewers).flatMap((reviewer) => asArray(reviewer.concerns || reviewer.major_concerns || reviewer.majorConcerns))
  ].map((concern, index) => {
    if (typeof concern === 'string') {
      return {
        concern_id: `concern:${stableHash(concern, 10)}`,
        text: compactText(concern),
        severity: 'major',
        evidence_gap: ''
      };
    }
    return {
      concern_id: compactText(concern.concern_id || concern.concernId || concern.id || `concern:${stableHash(`${concern.summary || concern.text || index}`, 10)}`),
      text: compactText(concern.summary || concern.text || concern.concern || concern.message),
      severity: compactText(concern.severity || concern.level || 'major'),
      evidence_gap: compactText(concern.evidence_gap || concern.evidenceGap || concern.gap)
    };
  }).filter((concern) => concern.concern_id || concern.text), (concern) => concern.concern_id || concern.text);
}

function claimEvidenceSignals(claim = {}, reviewConcerns = []) {
  const spanCount = asArray(claim.source_span_ids || claim.sourceSpanIds).length;
  const citationCount = asArray(claim.citation_context_ids || claim.citationContextIds).length;
  const supportCount = asArray(claim.supporting_paper_keys || claim.supportingPaperKeys).length;
  const relevantConcerns = reviewConcerns.filter((concern) => {
    const text = `${concern.text} ${concern.evidence_gap}`.toLowerCase();
    return !text || text.includes('source') || text.includes('ground') || text.includes('baseline') || text.includes('temporal') || text.includes('metric');
  });
  return {
    spanCount,
    citationCount,
    supportCount,
    relevantConcerns,
    groundingPenalty: spanCount ? 0 : 0.12,
    citationBonus: Math.min(0.05, citationCount * 0.02),
    supportBonus: Math.min(0.08, supportCount * 0.025),
    concernBonus: Math.min(0.18, relevantConcerns.length * 0.06)
  };
}

function candidateId(claim = {}, perturbationType = '', anchor = {}) {
  return `candidate:${stableHash([
    claim.claim_id || claim.claimId,
    perturbationType,
    anchor.id,
    anchor.text
  ].filter(Boolean).join(':'), 12)}`;
}

function makeCandidate(claim, perturbationType, anchor, options = {}) {
  const defaults = TYPE_DEFAULTS[perturbationType] || TYPE_DEFAULTS.assumption_stress;
  const signals = options.signals || claimEvidenceSignals(claim, []);
  const score = normalizeScore(
    defaults.baseScore
    + signals.citationBonus
    + signals.supportBonus
    + signals.concernBonus
    + (options.priorityBoost || 0)
    - signals.groundingPenalty,
    defaults.baseScore
  );
  const id = candidateId(claim, perturbationType, anchor);
  return {
    candidate_id: id,
    claim_id: claim.claim_id || claim.claimId,
    claim_text: compactText(claim.claim_text || claim.claimText),
    perturbation_type: perturbationType,
    anchor,
    score: Number(score.toFixed(4)),
    required_evidence: defaults.requiredEvidence,
    generation_reason: options.generationReason || `generated_${perturbationType}_candidate`
  };
}

function baselineCandidates(claim, context, signals) {
  const claimPaperKeys = new Set(normalizeTextList(claim.supporting_paper_keys || claim.supportingPaperKeys));
  const papers = context.mustCiteSet
    .filter((paper) => !claimPaperKeys.size || claimPaperKeys.has(paper.paper_key) || claimPaperKeys.has(paper.title))
    .slice(0, Math.max(1, context.perTypeLimit));
  const fallbackPapers = papers.length ? papers : context.mustCiteSet.slice(0, context.perTypeLimit);
  return fallbackPapers.map((paper, index) => makeCandidate(claim, 'baseline_swap', {
    id: paper.paper_key || paper.title || `baseline:${index + 1}`,
    text: paper.title || paper.paper_key || 'nearest must-cite source',
    kind: 'must_cite',
    coverage_status: paper.coverage_status,
    temporal_status: paper.temporal_status
  }, {
    signals,
    priorityBoost: paper.coverage_status === 'missing' || paper.coverage_status === 'metadata_only' ? 0.08 : 0,
    generationReason: 'must_cite_or_supporting_paper_baseline'
  }));
}

function assumptionCandidates(claim, context, signals) {
  const challenge = context.challenges.find((item) => item.challenge_id === claim.target_challenge_id) || context.challenges[0];
  const takeaway = context.takeaways.find((item) => item.source_domain === claim.source_domain) || context.takeaways[0];
  const concern = context.reviewConcerns[0];
  return [makeCandidate(claim, 'assumption_stress', {
    id: concern?.concern_id || challenge?.challenge_id || takeaway?.takeaway_id || `assumption:${stableHash(claim.claim_id || claim.claim_text, 10)}`,
    text: concern?.text || challenge?.text || takeaway?.text || 'the cross-domain transfer assumption is weakened',
    kind: concern ? 'review_concern' : (challenge ? 'challenge' : 'takeaway')
  }, {
    signals,
    priorityBoost: concern ? 0.1 : 0.03,
    generationReason: concern ? 'review_concern_assumption_stress' : 'challenge_or_takeaway_assumption_stress'
  })];
}

function datasetShiftCandidates(claim, context, signals) {
  const target = compactText(context.targetDomain || context.challenges[0]?.target_domain || 'target domain');
  return [makeCandidate(claim, 'dataset_shift', {
    id: `dataset:${stableHash(`${claim.claim_id}:${target}`, 10)}`,
    text: target ? `${target} deployment slice` : 'a shifted target-domain dataset',
    kind: 'target_domain'
  }, {
    signals,
    priorityBoost: context.challenges.length ? 0.04 : 0,
    generationReason: 'target_domain_dataset_shift'
  })];
}

function metricShiftCandidates(claim, context, signals) {
  const metricText = compactText(context.metrics[0] || 'a stricter reviewer-facing metric');
  return [makeCandidate(claim, 'metric_shift', {
    id: `metric:${stableHash(`${claim.claim_id}:${metricText}`, 10)}`,
    text: metricText,
    kind: 'metric'
  }, {
    signals,
    priorityBoost: context.reviewConcerns.some((concern) => /metric|evaluation|baseline/i.test(`${concern.text} ${concern.evidence_gap}`)) ? 0.07 : 0,
    generationReason: 'metric_sensitivity_probe'
  })];
}

function temporalCutoffCandidates(claim, context, signals) {
  const cutoff = firstConfigured(context.timeCutoff, 'declared time cutoff');
  const temporalPaper = context.mustCiteSet.find((paper) => paper.temporal_status === 'future_leakage');
  return [makeCandidate(claim, 'temporal_cutoff', {
    id: temporalPaper?.paper_key || temporalPaper?.title || `temporal:${stableHash(`${claim.claim_id}:${cutoff}`, 10)}`,
    text: temporalPaper?.title || temporalPaper?.paper_key || `evidence available before ${cutoff}`,
    kind: temporalPaper ? 'future_leakage' : 'time_cutoff',
    cutoff
  }, {
    signals,
    priorityBoost: temporalPaper ? 0.16 : (context.timeCutoff ? 0.04 : -0.03),
    generationReason: temporalPaper ? 'future_leakage_temporal_probe' : 'time_cutoff_replay_probe'
  })];
}

function buildContext(payload = {}, options = {}) {
  const sourceSpans = collectSourceSpans(payload);
  const supportingPapers = collectSupportingPapers(payload, sourceSpans);
  const targetDomain = compactText(payload.target_domain || payload.targetDomain || options.targetDomain || options.target_domain);
  return {
    sourceSpans,
    supportingPapers,
    mustCiteSet: collectMustCiteSet(payload, options, supportingPapers),
    reviewConcerns: collectReviewConcerns(payload, options),
    challenges: collectChallenges(payload),
    takeaways: collectTakeaways(payload),
    metrics: normalizeTextList(options.metrics || payload.metrics || payload.evaluation_metrics || payload.evaluationMetrics),
    targetDomain,
    timeCutoff: firstConfigured(options.timeCutoff, options.time_cutoff, payload.timeCutoff, payload.time_cutoff),
    perTypeLimit: resolveLimit(options.counterfactualPerTypeLimit ?? options.counterfactual_per_type_limit, 2, 5)
  };
}

function expandCandidates(payload, options, claims, searchBudget) {
  const context = buildContext(payload, options);
  const candidates = [];
  const traces = [];
  for (const claim of claims) {
    const signals = claimEvidenceSignals(claim, context.reviewConcerns);
    const generated = [
      ...baselineCandidates(claim, context, signals),
      ...assumptionCandidates(claim, context, signals),
      ...datasetShiftCandidates(claim, context, signals),
      ...metricShiftCandidates(claim, context, signals),
      ...temporalCutoffCandidates(claim, context, signals)
    ].filter((candidate) => candidate.claim_id && candidate.perturbation_type);
    for (const candidate of generated) {
      traces.push({
        event: 'candidate_generated',
        candidate_id: candidate.candidate_id,
        claim_id: candidate.claim_id,
        perturbation_type: candidate.perturbation_type,
        reason: candidate.generation_reason
      });
      candidates.push(candidate);
      if (candidates.length >= searchBudget) break;
    }
    if (candidates.length >= searchBudget) break;
  }
  return {
    candidates: uniqueBy(candidates, (candidate) => `${candidate.claim_id}:${candidate.perturbation_type}:${candidate.anchor?.id || candidate.anchor?.text}`).slice(0, searchBudget),
    generationTrace: traces.slice(0, searchBudget)
  };
}

function rerankCandidates(candidates = [], selectedBudget = 1) {
  const ranked = [...candidates].sort((left, right) => (
    right.score - left.score
    || String(left.perturbation_type).localeCompare(String(right.perturbation_type))
    || String(left.candidate_id).localeCompare(String(right.candidate_id))
  ));
  const selected = ranked.slice(0, selectedBudget);
  const discarded = ranked.slice(selectedBudget).map((candidate) => ({
    candidate_id: candidate.candidate_id,
    perturbation_type: candidate.perturbation_type,
    score: candidate.score,
    reason: 'below_selected_budget'
  }));
  return { ranked, selected, discarded };
}

function questionForCandidate(candidate = {}) {
  const anchorText = compactText(candidate.anchor?.text);
  if (candidate.perturbation_type === 'baseline_swap') {
    return `Would the proposed contribution still hold if ${anchorText || 'the strongest must-cite baseline'} outperformed the proposed bridge under the target-domain setting?`;
  }
  if (candidate.perturbation_type === 'assumption_stress') {
    return `Would the contribution still hold if the key transfer assumption failed: ${anchorText || 'the source-domain mechanism does not transfer cleanly'}?`;
  }
  if (candidate.perturbation_type === 'dataset_shift') {
    return `Would the claim remain valid on a shifted dataset or deployment slice such as ${anchorText || 'a harder target-domain slice'}?`;
  }
  if (candidate.perturbation_type === 'metric_shift') {
    return `Would the idea still look useful under ${anchorText || 'a stricter secondary metric'} rather than the easiest headline metric?`;
  }
  if (candidate.perturbation_type === 'temporal_cutoff') {
    return `Would the novelty and grounding still hold using only ${anchorText || 'evidence available before the declared time cutoff'}?`;
  }
  return 'Would the proposed contribution still hold if the strongest baseline or cited source failed under the target-domain setting?';
}

function selectedPlan(candidate, index, searchContext) {
  return {
    falsification_plan_id: `falsification:${stableHash(`${candidate.candidate_id}:${index}`, 12)}`,
    search_contract_version: COUNTERFACTUAL_SEARCH_CONTRACT_VERSION,
    search_mode: 'bounded_offline',
    candidate_id: candidate.candidate_id,
    claim_id: candidate.claim_id,
    perturbation_type: candidate.perturbation_type,
    rank: index + 1,
    score: candidate.score,
    question: questionForCandidate(candidate),
    required_evidence: candidate.required_evidence,
    status: 'planned',
    anchor: candidate.anchor,
    discard_reasons: [],
    search_trace: {
      generated_candidates: searchContext.generatedCount,
      evaluated_candidates: searchContext.evaluatedCount,
      selected_rank: index + 1,
      generation_reason: candidate.generation_reason,
      selected_reason: 'highest_scoring_candidate_within_budget',
      discarded_candidates: searchContext.discarded.slice(0, 5)
    }
  };
}

export function buildCounterfactuals(payload = {}, options = {}) {
  const budget = resolveLimit(options.counterfactualBudget ?? options.counterfactual_budget ?? payload.counterfactualBudget ?? payload.counterfactual_budget, DEFAULT_SELECTED_BUDGET, MAX_SELECTED_BUDGET);
  const searchBudget = resolveLimit(
    options.counterfactualSearchBudget
    ?? options.counterfactual_search_budget
    ?? payload.counterfactualSearchBudget
    ?? payload.counterfactual_search_budget,
    Math.min(MAX_SEARCH_BUDGET, Math.max(budget * 5, budget)),
    MAX_SEARCH_BUDGET
  );
  const claims = options.contributionClaims || buildContributionClaims(payload, options);
  const searchMode = compactText(options.counterfactualSearchMode || options.counterfactual_search_mode || payload.counterfactualSearchMode || payload.counterfactual_search_mode || 'bounded_offline');
  if (!claims.length || searchMode === 'off') return [];
  const { candidates, generationTrace } = expandCandidates(payload, options, claims, searchBudget);
  const { selected, discarded } = rerankCandidates(candidates, budget);
  const searchContext = {
    generatedCount: generationTrace.length,
    evaluatedCount: candidates.length,
    discarded
  };
  return selected.map((candidate, index) => selectedPlan(candidate, index, searchContext));
}
