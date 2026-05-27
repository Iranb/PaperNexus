import {
  asArray,
  compactText,
  stableHash,
  unique,
  uniqueBy
} from './innovation-artifact-utils.js';
import { buildContributionClaims } from './claim-linking.js';
import {
  attachModelAssistedStoryline,
  buildModelAssistedInnovationContext
} from './model-assisted-innovation.js';
import { buildReviewPacket } from './reviewer-simulation.js';

const DEFAULT_STORY_BEATS = [
  'problem',
  'gap',
  'bridge_principle',
  'hypothesis',
  'validation_plan',
  'risk',
  'why_now'
];

function firstNonEmpty(...values) {
  return values.map(compactText).find(Boolean) || '';
}

function traceRef(kind, id, text = '', source = '') {
  const normalizedKind = compactText(kind);
  const normalizedText = compactText(text);
  const rawId = compactText(id || normalizedText);
  if (!normalizedKind || !rawId) return null;
  return {
    kind: normalizedKind,
    id: rawId.includes(':') ? rawId : `${normalizedKind}:${stableHash(rawId, 12)}`,
    text: normalizedText || rawId,
    source: compactText(source)
  };
}

function collectStorylineChallengeRefs(targetAnalysis = {}) {
  return asArray(targetAnalysis.remaining_challenges || targetAnalysis.remainingChallenges)
    .map((challenge, index) => traceRef(
      'challenge',
      challenge.challenge_id || challenge.challengeId || challenge.id || challenge.name || `challenge:${index + 1}`,
      firstNonEmpty(
        challenge.domain_agnostic_challenge,
        challenge.domainAgnosticChallenge,
        challenge.domain_agnostic_challenge_question,
        challenge.domainAgnosticChallengeQuestion,
        challenge.domain_specific_challenge,
        challenge.domainSpecificChallenge,
        challenge.domain_specific_challenge_question,
        challenge.domainSpecificChallengeQuestion,
        challenge.target_challenge,
        challenge.targetChallenge,
        challenge.name
      ),
      'target_domain_analysis'
    ))
    .filter(Boolean);
}

function collectStorylineTakeawayRefs(payload = {}) {
  const sourceAnalyses = asArray(payload.source_domain_analyses || payload.sourceDomainAnalyses);
  const fromAnalyses = sourceAnalyses.flatMap((analysis) => (
    asArray(analysis.takeaways).map((takeaway, index) => traceRef(
      'takeaway',
      takeaway.takeaway_id || takeaway.takeawayId || takeaway.id || takeaway.concept || takeaway.source_domain_formulation || `takeaway:${analysis.source_domain || analysis.sourceDomain || index}`,
      firstNonEmpty(takeaway.concept, takeaway.source_domain_formulation, takeaway.sourceDomainFormulation, takeaway.source_logic, takeaway.sourceLogic),
      analysis.source_domain || analysis.sourceDomain || 'source_domain_analysis'
    ))
  ));
  const fromFragments = asArray(payload.idea_fragments || payload.ideaFragments).flatMap((fragment) => [
    ...asArray(fragment.source_takeaway_ids || fragment.sourceTakeawayIds)
      .map((takeawayId) => traceRef('takeaway', takeawayId, takeawayId, fragment.source_domain || fragment.sourceDomain || 'idea_fragment')),
    ...asArray(fragment.source_takeaways || fragment.sourceTakeaways)
      .map((takeaway) => (typeof takeaway === 'string'
        ? traceRef('takeaway', takeaway, takeaway, fragment.source_domain || fragment.sourceDomain || 'idea_fragment')
        : traceRef(
          'takeaway',
          takeaway.id || takeaway.takeaway_id || takeaway.takeawayId || takeaway.concept || takeaway.name,
          firstNonEmpty(takeaway.concept, takeaway.name, takeaway.mechanism, takeaway.source_logic, takeaway.sourceLogic),
          fragment.source_domain || fragment.sourceDomain || 'idea_fragment'
        )))
  ]);
  return uniqueBy([...fromAnalyses, ...fromFragments].filter(Boolean), (entry) => entry.id);
}

function collectStorylineClaimRefs(claims = []) {
  return asArray(claims)
    .map((claim) => traceRef('claim', claim.claim_id || claim.claimId, claim.claim_text || claim.claimText, 'contribution_claims'))
    .filter(Boolean);
}

function collectStorylineReviewRefs(reviewPacket = {}) {
  return asArray(reviewPacket.major_concerns || reviewPacket.majorConcerns)
    .map((concern) => traceRef('review_concern', concern.concern_id || concern.concernId, concern.concern, 'review_packet'))
    .filter(Boolean);
}

function idsForKind(refs = [], kind = '') {
  return refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
}

export function buildStorylineDAG(payload = {}, options = {}) {
  const claims = options.contributionClaims || buildContributionClaims(payload, options);
  const reviewPacket = options.reviewPacket || buildReviewPacket(payload, { ...options, contributionClaims: claims });
  const targetAnalysis = asArray(payload.target_domain_analysis || payload.targetDomainAnalysis)[0] || {};
  const challenges = asArray(targetAnalysis.remaining_challenges || targetAnalysis.remainingChallenges);
  const firstClaim = claims[0] || {};
  const sourceDomains = unique(claims.map((claim) => claim.source_domain).filter(Boolean));
  const claimRefs = collectStorylineClaimRefs(claims);
  const challengeRefs = collectStorylineChallengeRefs(targetAnalysis);
  const takeawayRefs = collectStorylineTakeawayRefs(payload);
  const reviewRefs = collectStorylineReviewRefs(reviewPacket);
  const problem = compactText(payload.problem || payload.research_problem || payload.query || targetAnalysis.target_domain || payload.targetDomain || payload.target_domain);
  const beatTexts = {
    problem: problem || 'Research problem was not specified.',
    gap: compactText(challenges[0]?.domain_agnostic_challenge || challenges[0]?.domain_specific_challenge || challenges[0]?.target_challenge || firstClaim.target_challenge_id || 'Target-domain gap needs explicit evidence.'),
    bridge_principle: sourceDomains.length
      ? `Transfer the strongest mechanism from ${sourceDomains.join(', ')} into the target domain.`
      : 'No source-domain bridge is available yet.',
    hypothesis: firstClaim.claim_text || 'No contribution claim is available yet.',
    validation_plan: 'Validate the proposal against baseline, ablation, and claim-grounding checks before treating it as submission-ready.',
    risk: reviewPacket.major_concerns?.[0]?.concern || 'No major structured review concern was generated.',
    why_now: 'The current packet combines graph evidence, must-cite obligations, review concerns, and storyline structure in one auditable artifact.'
  };
  const beats = DEFAULT_STORY_BEATS.map((beatType, index) => {
    const traceRefs = {
      problem: challengeRefs.length ? challengeRefs : claimRefs.slice(0, 1),
      gap: challengeRefs.length ? challengeRefs : [...reviewRefs, ...claimRefs].slice(0, 4),
      bridge_principle: takeawayRefs.length ? takeawayRefs : claimRefs.slice(0, 4),
      hypothesis: claimRefs,
      validation_plan: [...reviewRefs, ...claimRefs].slice(0, 8),
      risk: [...reviewRefs, ...claimRefs].slice(0, 8),
      why_now: [...claimRefs, ...takeawayRefs, ...challengeRefs, ...reviewRefs].slice(0, 8)
    }[beatType] || [];
    const sourceSpanIds = beatType === 'problem' || beatType === 'gap'
      ? []
      : unique(claims.flatMap((claim) => asArray(claim.source_span_ids))).slice(0, 8);
    const reviewConcernIds = idsForKind(traceRefs, 'review_concern').slice(0, 8);
    const supported = traceRefs.length > 0;
    return {
      beat_id: `beat:${index + 1}:${beatType}`,
      beat_type: beatType,
      text: beatTexts[beatType],
      claim_ids: idsForKind(traceRefs, 'claim').slice(0, 8),
      challenge_ids: idsForKind(traceRefs, 'challenge').slice(0, 8),
      takeaway_ids: idsForKind(traceRefs, 'takeaway').slice(0, 8),
      source_span_ids: sourceSpanIds,
      review_concern_ids: reviewConcernIds,
      trace_refs: traceRefs,
      supported
    };
  });
  const storyline = {
    dag_version: 'storyline-dag-v1',
    mode: options.storylineMode || options.storyline_mode || payload.storylineMode || payload.storyline_mode || 'claim_review_storyline',
    beats,
    edges: beats.slice(1).map((beat, index) => ({
      source_beat_id: beats[index].beat_id,
      target_beat_id: beat.beat_id,
      relation: 'precedes'
    })),
    unsupported_beats: beats.filter((beat) => !beat.supported).map((beat) => beat.beat_id)
  };
  const modelAssisted = options.modelAssistedContext || buildModelAssistedInnovationContext(payload, options);
  return attachModelAssistedStoryline(storyline, modelAssisted);
}
