import {
  asArray,
  compactText,
  collectSourceSpans,
  evidenceTierScore,
  fragmentText,
  spanIdsForFragment,
  stableHash
} from './innovation-artifact-utils.js';

export function buildContributionClaims(payload = {}, options = {}) {
  const sourceSpans = collectSourceSpans(payload);
  const fragments = asArray(payload.idea_fragments || payload.ideaFragments);
  return fragments.map((fragment, index) => {
    const claimText = fragmentText(fragment) || `Idea fragment ${index + 1}`;
    const sourceSpanIds = spanIdsForFragment(fragment, sourceSpans);
    const evidenceTier = fragment.evidence_tier || fragment.evidenceTier || (sourceSpanIds.length ? 'moderate' : 'weak');
    return {
      claim_id: fragment.claim_id || fragment.claimId || `claim:${stableHash(`${fragment.id || fragment.title || index}:${claimText}`, 12)}`,
      fragment_id: fragment.id || fragment.fragment_id || `fragment:${index + 1}`,
      claim_type: 'contribution',
      claim_text: claimText,
      source_domain: compactText(fragment.source_domain || fragment.sourceDomain),
      target_challenge_id: compactText(fragment.target_challenge_id || fragment.targetChallengeId),
      source_span_ids: sourceSpanIds,
      citation_context_ids: asArray(fragment.citation_context_ids || fragment.citationContextIds),
      supporting_paper_keys: asArray(fragment.supporting_paper_keys || fragment.supportingPaperKeys).map(compactText).filter(Boolean),
      evidence_tier: evidenceTier,
      confidence: Number((sourceSpanIds.length ? evidenceTierScore(evidenceTier) : Math.min(0.4, evidenceTierScore(evidenceTier))).toFixed(4)),
      writeback_policy: options.writeBack || options.write_back ? 'optional_graph_writeback' : 'artifact_only'
    };
  });
}
