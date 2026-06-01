import { stableHash } from '../../lib/utils.js';
import { createProvenanceEnvelope } from '../../storage/provenance-store.js';
import { buildIdeaCatalystInnovationArtifacts } from './innovation-contracts.js';
import {
  publicationDateFromRecord,
  publicationYearFromRecord,
  sortPaperRecordsByPublicationDateDesc
} from '../paper-date.js';

export const IDEA_CATALYST_EVIDENCE_EXPORT_VERSION = 'papernexus-idea-catalyst-evidence-v1';

function nowIso() {
  return new Date().toISOString();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueBy(values = [], keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function resolveLicenseScope(...values) {
  return values.map(compactText).find(Boolean) || 'derived_snippet_research_use';
}

function sourceSpanAuditFields(span = {}, defaults = {}) {
  const licenseScope = resolveLicenseScope(span.license_scope, span.licenseScope, defaults.license_scope, defaults.licenseScope);
  const evidenceHash = compactText(span.evidence_hash || span.evidenceHash || span.sha256 || span.source_hash || span.sourceHash)
    || stableHash(JSON.stringify({
      paper_key: span.paper_key || span.paperKey || '',
      span_id: span.span_id || span.spanId || span.snippet_id || span.snippetId || '',
      text: span.text || span.evidence_text || span.evidenceText || ''
    }), 24);
  const anchor = compactText(span.source_anchor || span.sourceAnchor || span.anchor)
    || compactText([span.paper_key || span.paperKey, span.span_id || span.spanId || span.snippet_id || span.snippetId].filter(Boolean).join('#'));
  return {
    license_scope: licenseScope,
    evidence_hash: evidenceHash,
    source_anchor: anchor || null
  };
}

function supportingPaperAuditFields(paper = {}, defaults = {}) {
  const licenseScope = resolveLicenseScope(paper.license_scope, paper.licenseScope, defaults.license_scope, defaults.licenseScope);
  const evidenceHash = compactText(paper.evidence_hash || paper.evidenceHash || paper.sha256 || paper.source_hash || paper.sourceHash)
    || stableHash(JSON.stringify({
      paper_key: paper.paper_key || paper.paperKey || paper.paper_id || paper.paperId || '',
      title: paper.title || paper.paper_title || paper.paperTitle || '',
      source_domain: paper.source_domain || paper.sourceDomain || defaults.source_domain || defaults.sourceDomain || ''
    }), 24);
  const anchor = compactText(paper.source_anchor || paper.sourceAnchor || paper.anchor)
    || compactText(paper.paper_key || paper.paperKey || paper.paper_id || paper.paperId || paper.title || paper.paper_title || paper.paperTitle);
  return {
    license_scope: licenseScope,
    evidence_hash: evidenceHash,
    source_anchor: anchor || null
  };
}

function publicationFieldsForSupportingPaper(paper = {}) {
  const publicationDate = publicationDateFromRecord(paper);
  return {
    year: publicationYearFromRecord(paper),
    publicationDate,
    publication_date: publicationDate
  };
}

function compareSupportingPaperFallback(left = {}, right = {}) {
  return Number(right.snippet_count || 0) - Number(left.snippet_count || 0)
    || String(left.title || '').localeCompare(String(right.title || ''))
    || String(left.paper_key || '').localeCompare(String(right.paper_key || ''));
}

function normalizeMode(mode, live, graphPayload) {
  const raw = compactText(mode).toLowerCase();
  if (raw === 'live' || raw === 'live_discovery') return 'live_discovery';
  if (raw === 'hybrid') return 'hybrid';
  if (raw === 'graph') return 'graph';
  if (live && graphPayload) return 'hybrid';
  if (live) return 'live_discovery';
  return 'graph';
}

function collectTargetQuestions(live = {}, graphPayload = {}) {
  const liveQuestions = asArray(live.decomposition?.research_questions || live.decomposition?.questions);
  const graphQuestions = asArray(
    graphPayload.packetBundle?.target_questions
      || graphPayload.packet_bundle?.target_questions
      || graphPayload.target_questions
  );
  return uniqueBy([...liveQuestions, ...graphQuestions]
    .map((entry, index) => ({
      id: compactText(entry.id || entry.question_id || `q${index + 1}`),
      domain_specific_question: compactText(entry.domain_specific_question || entry.domainSpecificQuestion || entry.question),
      domain_agnostic_question: compactText(entry.domain_agnostic_question || entry.domainAgnosticQuestion || entry.abstract_question)
    }))
    .filter((entry) => entry.domain_specific_question || entry.domain_agnostic_question), (entry) => entry.id);
}

function collectTargetChallenges(live = {}, graphPayload = {}) {
  const liveChallenges = asArray(live.target_domain_analysis)
    .flatMap((entry) => asArray(entry.remaining_challenges));
  const graphChallenges = asArray(
    graphPayload.packetBundle?.target_challenges
      || graphPayload.packet_bundle?.target_challenges
      || graphPayload.target_challenges
  );
  return uniqueBy([...liveChallenges, ...graphChallenges]
    .map((entry, index) => ({
      id: compactText(entry.id || entry.challenge_id || `challenge:${index + 1}`),
      target_challenge: compactText(entry.domain_specific_challenge || entry.target_challenge || entry.challenge),
      domain_agnostic_challenge: compactText(entry.domain_agnostic_challenge || entry.abstract_challenge || entry.target_challenge || entry.challenge),
      rationale: compactText(entry.rationale || entry.reason)
    }))
    .filter((entry) => entry.target_challenge || entry.domain_agnostic_challenge), (entry) => entry.id);
}

function collectSourceDomains(live = {}, graphPayload = {}) {
  const liveDomains = asArray(live.source_domain_analyses).map((entry) => ({
    source_domain: compactText(entry.source_domain),
    accepted: entry.accepted === true,
    target_challenge_id: entry.target_challenge_id || null,
    relevance_ratio: entry.relevance_ratio ?? null,
    relevant_paper_count: entry.relevant_paper_count ?? null,
    retrieved_paper_count: entry.retrieved_paper_count ?? null
  }));
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphDomains = asArray(bundle.source_domains || bundle.candidate_source_domains || graphPayload.candidate_source_domains)
    .map((entry) => typeof entry === 'string'
      ? { source_domain: compactText(entry), accepted: true }
      : {
          source_domain: compactText(entry.source_domain || entry.domain || entry.name),
          accepted: entry.accepted !== false,
          score: entry.score ?? entry.relevance_score ?? null
        });
  return uniqueBy([...liveDomains, ...graphDomains].filter((entry) => entry.source_domain), (entry) => entry.source_domain);
}

function collectSourceTakeaways(live = {}, graphPayload = {}) {
  const liveTakeaways = asArray(live.source_domain_analyses).flatMap((analysis) => (
    asArray(analysis.takeaways).map((entry) => ({
      ...entry,
      source_domain: analysis.source_domain,
      target_challenge_id: analysis.target_challenge_id
    }))
  ));
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphTakeaways = asArray(bundle.source_takeaways || bundle.takeaways);
  return uniqueBy([...liveTakeaways, ...graphTakeaways]
    .map((entry, index) => ({
      id: compactText(entry.id || `takeaway:${stableHash(`${entry.source_domain || ''}:${entry.concept || entry.mechanism || index}`, 10)}`),
      source_domain: compactText(entry.source_domain || entry.domain),
      concept: compactText(entry.concept || entry.title || entry.name),
      mechanism: compactText(entry.mechanism || entry.principle),
      source_logic: compactText(entry.source_logic || entry.sourceLogic || entry.rationale),
      paper_keys: asArray(entry.paper_keys || entry.paperKeys || entry.supporting_paper_keys).map(compactText).filter(Boolean),
      target_challenge_id: entry.target_challenge_id || entry.targetChallengeId || null
    }))
    .filter((entry) => entry.concept || entry.mechanism), (entry) => entry.id);
}

function collectSourceSpans(live = {}, graphPayload = {}, defaults = {}) {
  const liveSpans = asArray(live.source_domain_analyses).flatMap((analysis) => (
    asArray(analysis.supporting_papers).flatMap((paper) => (
      asArray(paper.snippets).map((snippet, index) => ({
        source_domain: analysis.source_domain,
        paper_key: paper.paper_key,
        paper_title: paper.title || '',
        span_id: compactText(snippet.snippet_id || snippet.snippetId || `snippet:${stableHash(`${paper.paper_key}:${index}`, 10)}`),
        section: compactText(snippet.section),
        text: compactText(snippet.text),
        ...sourceSpanAuditFields({
          ...snippet,
          paper_key: paper.paper_key,
          paper_title: paper.title || '',
          span_id: compactText(snippet.snippet_id || snippet.snippetId || `snippet:${stableHash(`${paper.paper_key}:${index}`, 10)}`),
          text: compactText(snippet.text)
        }, {
          ...defaults,
          ...analysis,
          ...paper,
          source_domain: analysis.source_domain,
          license_scope: snippet.license_scope || snippet.licenseScope || paper.license_scope || paper.licenseScope || analysis.license_scope || analysis.licenseScope || defaults.license_scope
        }),
        source_type: compactText(snippet.source_type || snippet.sourceType || 'semantic_scholar_snippet')
      }))
    ))
  ));
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphSpans = asArray(bundle.source_spans || graphPayload.source_spans);
  return uniqueBy([...liveSpans, ...graphSpans]
    .map((entry, index) => ({
      source_domain: compactText(entry.source_domain || entry.domain),
      paper_key: compactText(entry.paper_key || entry.paperId || entry.paper_id || entry.source_key || entry.sourceKey),
      paper_title: compactText(entry.paper_title || entry.title),
      span_id: compactText(entry.span_id || entry.snippet_id || entry.id || `span:${index + 1}`),
      section: compactText(entry.section || entry.section_role || entry.sectionRole),
      text: compactText(entry.text || entry.evidence_text || entry.evidenceText),
      ...sourceSpanAuditFields(entry, defaults),
      source_type: compactText(entry.source_type || entry.sourceType || 'source_span')
    }))
    .filter((entry) => entry.paper_key || entry.text), (entry) => `${entry.paper_key}:${entry.span_id}:${entry.text.slice(0, 80)}`);
}

function collectSupportingPapers(live = {}, graphPayload = {}, fragments = [], defaults = {}) {
  const livePapers = asArray(live.source_domain_analyses).flatMap((analysis) => (
    asArray(analysis.supporting_papers).map((paper) => ({
      paper_key: compactText(paper.paper_key),
      title: compactText(paper.title),
      source_domain: compactText(analysis.source_domain),
      snippet_count: asArray(paper.snippets).length,
      ...publicationFieldsForSupportingPaper(paper),
      ...supportingPaperAuditFields(paper, {
        ...defaults,
        ...analysis,
        source_domain: analysis.source_domain,
        license_scope: paper.license_scope || paper.licenseScope || analysis.license_scope || analysis.licenseScope || defaults.license_scope
      })
    }))
  ));
  const fragmentPapers = fragments.flatMap((fragment) => asArray(fragment.supporting_papers).map((paper) => ({
    paper_key: compactText(paper.paper_key || paper.paperId || paper.paper_id),
    title: compactText(paper.title || paper.paperTitle || paper.paper_title),
    source_domain: compactText(fragment.source_domain),
    ...publicationFieldsForSupportingPaper(paper),
    ...supportingPaperAuditFields(paper, {
      ...defaults,
      source_domain: fragment.source_domain,
      license_scope: paper.license_scope || paper.licenseScope || fragment.license_scope || fragment.licenseScope || defaults.license_scope
    })
  })));
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphPapers = asArray(bundle.supporting_papers || graphPayload.supporting_papers);
  return sortPaperRecordsByPublicationDateDesc(uniqueBy([...livePapers, ...fragmentPapers, ...graphPapers]
    .map((entry) => ({
      paper_key: compactText(entry.paper_key || entry.paperId || entry.paper_id || entry.sourceKey || entry.source_key),
      title: compactText(entry.title || entry.paper_title || entry.paperTitle),
      source_domain: compactText(entry.source_domain || entry.domain),
      snippet_count: Number(entry.snippet_count || entry.snippetCount || 0),
      ...publicationFieldsForSupportingPaper(entry),
      ...supportingPaperAuditFields(entry, defaults)
    }))
    .filter((entry) => entry.paper_key || entry.title), (entry) => entry.paper_key || entry.title), {
    fallbackCompare: compareSupportingPaperFallback
  });
}

function collectIdeaFragments(live = {}, graphPayload = {}) {
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphFragments = asArray(bundle.idea_fragments || graphPayload.idea_fragments);
  return uniqueBy([...asArray(live.idea_fragments), ...graphFragments]
    .map((fragment, index) => ({
      ...fragment,
      id: compactText(fragment.id || fragment.fragment_id || `fragment:${index + 1}`),
      title: compactText(fragment.title),
      target_challenge_id: compactText(fragment.target_challenge_id || fragment.targetChallengeId),
      target_challenge: compactText(fragment.target_challenge || fragment.targetChallenge),
      source_domain: compactText(fragment.source_domain || fragment.sourceDomain),
      source_takeaway_ids: asArray(fragment.source_takeaway_ids || fragment.sourceTakeawayIds).map(compactText).filter(Boolean),
      source_takeaways: asArray(fragment.source_takeaways || fragment.sourceTakeaways),
      supporting_paper_keys: asArray(fragment.supporting_paper_keys || fragment.supportingPaperKeys).map(compactText).filter(Boolean),
      supporting_papers: asArray(fragment.supporting_papers || fragment.supportingPapers)
    }))
    .filter((fragment) => fragment.title || fragment.id), (fragment) => fragment.id);
}

function collectSupportingKgNodes(graphPayload = {}, fragments = []) {
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  return uniqueBy([
    ...asArray(bundle.supporting_kg_nodes || graphPayload.supporting_kg_nodes),
    ...fragments.flatMap((fragment) => asArray(fragment.supporting_kg_nodes || fragment.supportingKgNodes))
  ].map((entry) => typeof entry === 'string'
    ? { node_id: compactText(entry) }
    : {
        node_id: compactText(entry.node_id || entry.nodeId || entry.id),
        name: compactText(entry.name || entry.title),
        node_type: compactText(entry.node_type || entry.type)
      }).filter((entry) => entry.node_id || entry.name), (entry) => entry.node_id || entry.name);
}

function createFragmentProvenance(fragment, payload = {}) {
  return createProvenanceEnvelope({
    generated_by_activity: 'idea_catalyst_evidence_export',
    responsible_agent: 'papernexus-idea-catalyst',
    trace_id: payload.traceId,
    run_id: payload.runId,
    output_hash: stableHash(JSON.stringify(fragment), 24),
    used_entities: [
      ...asArray(fragment.supporting_paper_keys).map((paperKey) => ({ type: 'paper', id: paperKey })),
      ...asArray(fragment.source_takeaway_ids).map((takeawayId) => ({ type: 'source_takeaway', id: takeawayId }))
    ],
    source_spans: asArray(fragment.supporting_papers).flatMap((paper) => (
      asArray(paper.snippets).map((snippet) => ({
        paper_key: paper.paper_key,
        span_id: snippet.snippet_id || snippet.snippetId,
        text: snippet.text || ''
      }))
    )),
    evidence_status: payload.evidenceStatus
  });
}

function sourceSpanId(span = {}) {
  return compactText(span.span_id || span.spanId || span.snippet_id || span.snippetId || span.id);
}

function claimId(claim = {}) {
  return compactText(claim.claim_id || claim.claimId || claim.id);
}

function reviewConcernId(concern = {}) {
  return compactText(concern.concern_id || concern.concernId || concern.id);
}

function storyBeatId(beat = {}) {
  return compactText(beat.beat_id || beat.beatId || beat.id);
}

function createClaimProvenance(claim, payload = {}) {
  const sourceSpanIds = asArray(claim.source_span_ids || claim.sourceSpanIds).map(compactText).filter(Boolean);
  const citationContextIds = asArray(claim.citation_context_ids || claim.citationContextIds).map(compactText).filter(Boolean);
  const supportingPaperKeys = asArray(claim.supporting_paper_keys || claim.supportingPaperKeys).map(compactText).filter(Boolean);
  const sourceSpanIdSet = new Set(sourceSpanIds);
  const matchingSourceSpans = asArray(payload.sourceSpans).filter((span) => sourceSpanIdSet.has(sourceSpanId(span)));
  return createProvenanceEnvelope({
    generated_by_activity: 'idea_catalyst_claim_evidence_export',
    responsible_agent: 'papernexus-idea-catalyst',
    trace_id: payload.traceId,
    run_id: payload.runId,
    output_hash: stableHash(JSON.stringify(claim), 24),
    used_entities: [
      ...supportingPaperKeys.map((paperKey) => ({ type: 'paper', id: paperKey })),
      ...sourceSpanIds.map((spanId) => ({ type: 'source_span', id: spanId })),
      ...citationContextIds.map((contextId) => ({ type: 'citation_context', id: contextId })),
      ...(claim.fragment_id || claim.fragmentId ? [{ type: 'idea_fragment', id: claim.fragment_id || claim.fragmentId }] : [])
    ],
    source_spans: matchingSourceSpans.map((span) => ({
      paper_key: span.paper_key || span.paperKey,
      span_id: sourceSpanId(span),
      text: span.text || ''
    })),
    evidence_status: payload.evidenceStatus
  });
}

function createReviewConcernProvenance(concern, payload = {}) {
  const affectedClaimIds = asArray(concern.affected_claim_ids || concern.affectedClaimIds).map(compactText).filter(Boolean);
  const sourceSpanIds = asArray(concern.source_span_ids || concern.sourceSpanIds).map(compactText).filter(Boolean);
  const sourceSpanIdSet = new Set(sourceSpanIds);
  const matchingSourceSpans = asArray(payload.sourceSpans).filter((span) => sourceSpanIdSet.has(sourceSpanId(span)));
  return createProvenanceEnvelope({
    generated_by_activity: 'idea_catalyst_review_evidence_export',
    responsible_agent: 'papernexus-idea-catalyst',
    trace_id: payload.traceId,
    run_id: payload.runId,
    output_hash: stableHash(JSON.stringify(concern), 24),
    used_entities: [
      ...affectedClaimIds.map((claimRef) => ({ type: 'contribution_claim', id: claimRef })),
      ...sourceSpanIds.map((spanId) => ({ type: 'source_span', id: spanId })),
      ...(concern.reviewer_id || concern.reviewerId ? [{ type: 'reviewer', id: concern.reviewer_id || concern.reviewerId }] : []),
      ...(concern.reviewer_role || concern.reviewerRole ? [{ type: 'reviewer_role', id: concern.reviewer_role || concern.reviewerRole }] : [])
    ],
    source_spans: matchingSourceSpans.map((span) => ({
      paper_key: span.paper_key || span.paperKey,
      span_id: sourceSpanId(span),
      text: span.text || ''
    })),
    evidence_status: payload.evidenceStatus
  });
}

function storyBeatTraceEntities(beat = {}) {
  const typedTraceRefs = asArray(beat.trace_refs || beat.traceRefs).map((ref) => {
    if (typeof ref === 'string') {
      const [type, ...rest] = ref.split(':');
      return { type: type || 'trace_ref', id: rest.length ? ref : compactText(ref) };
    }
    return {
      type: ref?.kind || ref?.type || ref?.ref_type || ref?.refType || 'trace_ref',
      id: ref?.id || ref?.ref_id || ref?.refId || ref?.claim_id || ref?.claimId || ref?.concern_id || ref?.concernId
    };
  });
  return [
    ...typedTraceRefs,
    ...asArray(beat.claim_ids || beat.claimIds).map((id) => ({ type: 'contribution_claim', id })),
    ...asArray(beat.challenge_ids || beat.challengeIds).map((id) => ({ type: 'challenge', id })),
    ...asArray(beat.takeaway_ids || beat.takeawayIds).map((id) => ({ type: 'source_takeaway', id })),
    ...asArray(beat.review_concern_ids || beat.reviewConcernIds).map((id) => ({ type: 'review_concern', id }))
  ].map((entry) => ({
    type: compactText(entry.type),
    id: compactText(entry.id)
  })).filter((entry) => entry.type && entry.id);
}

function createStoryBeatProvenance(beat, payload = {}) {
  return createProvenanceEnvelope({
    generated_by_activity: 'idea_catalyst_storybeat_evidence_export',
    responsible_agent: 'papernexus-idea-catalyst',
    trace_id: payload.traceId,
    run_id: payload.runId,
    output_hash: stableHash(JSON.stringify(beat), 24),
    used_entities: storyBeatTraceEntities(beat),
    source_spans: [],
    evidence_status: payload.evidenceStatus
  });
}

function addReviewConcernProvenance(reviewPacket, provenanceRefs = []) {
  if (!reviewPacket || typeof reviewPacket !== 'object') return reviewPacket;
  const concernsKey = Array.isArray(reviewPacket.major_concerns) || !Array.isArray(reviewPacket.majorConcerns)
    ? 'major_concerns'
    : 'majorConcerns';
  const concerns = asArray(reviewPacket[concernsKey]);
  if (!concerns.length) return reviewPacket;
  return {
    ...reviewPacket,
    [concernsKey]: concerns.map((concern, index) => ({
      ...concern,
      provenance_ref: provenanceRefs[index]?.provenance_id || null
    }))
  };
}

function addStoryBeatProvenance(storylineDag, provenanceRefs = []) {
  if (!storylineDag || typeof storylineDag !== 'object') return storylineDag;
  const beats = asArray(storylineDag.beats);
  if (!beats.length) return storylineDag;
  return {
    ...storylineDag,
    beats: beats.map((beat, index) => ({
      ...beat,
      provenance_ref: provenanceRefs[index]?.provenance_id || null
    }))
  };
}

function claimHasSourceSpan(claim = {}) {
  return asArray(claim.source_span_ids || claim.sourceSpanIds).length > 0;
}

function claimReferenceIds(claim = {}) {
  return [
    claim.claim_id,
    claim.claimId,
    claim.id,
    claim._writebackId
  ].map(compactText).filter(Boolean);
}

function collectFalsificationPlans(innovationArtifacts = {}) {
  return [
    ...asArray(innovationArtifacts.falsification_plans || innovationArtifacts.falsificationPlans),
    ...asArray(innovationArtifacts.counterfactuals || innovationArtifacts.counterfactualPlans)
  ];
}

function falsificationPlanClaimRef(plan = {}) {
  return compactText(plan.claim_id || plan.claimId);
}

function falsificationPlanRequiredEvidence(plan = {}) {
  return asArray(plan.required_evidence || plan.requiredEvidence).map(compactText).filter(Boolean);
}

function falsificationPlansAreClaimGrounded(innovationArtifacts = {}) {
  const plans = collectFalsificationPlans(innovationArtifacts);
  if (!plans.length) return true;
  const claimRefs = new Set(asArray(innovationArtifacts.contribution_claims || innovationArtifacts.contributionClaims)
    .flatMap(claimReferenceIds));
  if (!claimRefs.size) return false;
  return plans.every((plan) => {
    const claimRef = falsificationPlanClaimRef(plan);
    return claimRef
      && claimRefs.has(claimRef)
      && compactText(plan.question)
      && falsificationPlanRequiredEvidence(plan).length > 0;
  });
}

function deriveEvidenceStatus(fragments = [], sourceSpans = [], supportingPapers = [], sourceDomains = [], innovationArtifacts = {}) {
  const claims = asArray(innovationArtifacts.contribution_claims || innovationArtifacts.contributionClaims);
  const certificate = innovationArtifacts.novelty_certificate || innovationArtifacts.noveltyCertificate || {};
  const reviewPacket = innovationArtifacts.review_packet || innovationArtifacts.reviewPacket || {};
  const sourceSpanConcern = asArray(reviewPacket.major_concerns || reviewPacket.majorConcerns)
    .some((concern) => (
      String(concern.severity || '').toLowerCase() === 'major'
      && String(concern.evidence_gap || concern.evidenceGap || '').toLowerCase() === 'source_span_ids'
    ));
  const unsupportedClaimCount = Number(certificate.unsupported_claim_count ?? certificate.unsupportedClaimCount ?? 0);
  if (
    fragments.length
    && claims.length
    && claims.every(claimHasSourceSpan)
    && !unsupportedClaimCount
    && !sourceSpanConcern
    && falsificationPlansAreClaimGrounded(innovationArtifacts)
  ) {
    return 'source_backed';
  }
  if (fragments.length) return 'weak_evidence';
  if (sourceDomains.length && sourceDomains.every((entry) => entry.accepted === false)) return 'needs_more_literature';
  return 'failed';
}

export function buildIdeaCatalystEvidenceExport(payload = {}) {
  const live = payload.live || {};
  const graphPayload = payload.graphPayload || payload.graph_payload || {};
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const mode = normalizeMode(payload.mode, payload.live, payload.graphPayload || payload.graph_payload);
  const problem = compactText(payload.problem || live.problem || live.query || graphPayload.problem || graphPayload.query);
  const targetDomain = compactText(payload.targetDomain || payload.target_domain || live.targetDomain || live.target_domain || graphPayload.targetDomain || graphPayload.target_domain);
  const evidenceDefaults = {
    license_scope: payload.license_scope || payload.licenseScope || live.license_scope || live.licenseScope || graphPayload.license_scope || graphPayload.licenseScope || bundle.license_scope || bundle.licenseScope
  };
  const fragments = collectIdeaFragments(live, graphPayload);
  const sourceDomains = collectSourceDomains(live, graphPayload);
  const sourceSpans = collectSourceSpans(live, graphPayload, evidenceDefaults);
  const supportingPapers = collectSupportingPapers(live, graphPayload, fragments, evidenceDefaults);
  const generatedInnovationArtifacts = buildIdeaCatalystInnovationArtifacts({
    problem,
    targetDomain,
    target_domain: targetDomain,
    target_domain_analysis: live.target_domain_analysis || bundle.target_domain_analysis,
    source_domain_analyses: live.source_domain_analyses || bundle.source_domain_analyses,
    idea_fragments: fragments,
    source_spans: sourceSpans,
    supporting_papers: supportingPapers,
    timeCutoff: payload.timeCutoff || payload.time_cutoff || live.timeCutoff || live.time_cutoff,
    mustCiteK: payload.mustCiteK || payload.must_cite_k || live.mustCiteK || live.must_cite_k,
    reviewerPanel: payload.reviewerPanel || payload.reviewer_panel || live.reviewerPanel || live.reviewer_panel,
    storylineMode: payload.storylineMode || payload.storyline_mode || live.storylineMode || live.storyline_mode,
    counterfactualBudget: payload.counterfactualBudget || payload.counterfactual_budget || live.counterfactualBudget || live.counterfactual_budget
  }, {
    timeCutoff: payload.timeCutoff || payload.time_cutoff || live.timeCutoff || live.time_cutoff,
    mustCiteK: payload.mustCiteK || payload.must_cite_k || live.mustCiteK || live.must_cite_k,
    reviewerPanel: payload.reviewerPanel || payload.reviewer_panel || live.reviewerPanel || live.reviewer_panel,
    storylineMode: payload.storylineMode || payload.storyline_mode || live.storylineMode || live.storyline_mode,
    counterfactualBudget: payload.counterfactualBudget || payload.counterfactual_budget || live.counterfactualBudget || live.counterfactual_budget,
    writeBack: payload.writeBack || payload.write_back || live.writeBack || live.write_back
  });
  const innovationArtifacts = {
    ...generatedInnovationArtifacts,
    innovation_contract_version: live.innovation_contract_version
      || bundle.innovation_contract_version
      || generatedInnovationArtifacts.innovation_contract_version,
    contribution_claims: asArray(live.contribution_claims || bundle.contribution_claims || generatedInnovationArtifacts.contribution_claims),
    must_cite_set: asArray(live.must_cite_set || bundle.must_cite_set || generatedInnovationArtifacts.must_cite_set),
    novelty_certificate: live.novelty_certificate || bundle.novelty_certificate || generatedInnovationArtifacts.novelty_certificate,
    review_packet: live.review_packet || bundle.review_packet || generatedInnovationArtifacts.review_packet,
    storyline_dag: live.storyline_dag || bundle.storyline_dag || generatedInnovationArtifacts.storyline_dag,
    counterfactuals: asArray(live.counterfactuals || bundle.counterfactuals || generatedInnovationArtifacts.counterfactuals),
    falsification_plans: asArray(live.falsification_plans || bundle.falsification_plans || generatedInnovationArtifacts.falsification_plans)
  };
  const evidenceStatus = payload.evidence_status || payload.evidenceStatus
    || deriveEvidenceStatus(fragments, sourceSpans, supportingPapers, sourceDomains, innovationArtifacts);
  const fragmentProvenance = fragments.map((fragment) => createFragmentProvenance(fragment, {
    traceId: payload.traceId || payload.trace_id || live.trace_id,
    runId: payload.runId || payload.run_id || live.run_id,
    evidenceStatus
  }));
  const claimProvenance = innovationArtifacts.contribution_claims.map((claim) => createClaimProvenance(claim, {
    traceId: payload.traceId || payload.trace_id || live.trace_id,
    runId: payload.runId || payload.run_id || live.run_id,
    evidenceStatus,
    sourceSpans
  }));
  const reviewConcerns = asArray(innovationArtifacts.review_packet?.major_concerns || innovationArtifacts.review_packet?.majorConcerns);
  const reviewConcernProvenance = reviewConcerns.map((concern) => createReviewConcernProvenance(concern, {
    traceId: payload.traceId || payload.trace_id || live.trace_id,
    runId: payload.runId || payload.run_id || live.run_id,
    evidenceStatus,
    sourceSpans
  }));
  const storyBeats = asArray(innovationArtifacts.storyline_dag?.beats);
  const storyBeatProvenance = storyBeats.map((beat) => createStoryBeatProvenance(beat, {
    traceId: payload.traceId || payload.trace_id || live.trace_id,
    runId: payload.runId || payload.run_id || live.run_id,
    evidenceStatus
  }));
  const fragmentProvenanceRefs = fragmentProvenance.map((entry) => ({
    provenance_id: entry.provenance_id,
    generated_by_activity: entry.generated_by_activity,
    output_hash: entry.output_hash
  }));
  const claimProvenanceRefs = claimProvenance.map((entry, index) => ({
    provenance_id: entry.provenance_id,
    generated_by_activity: entry.generated_by_activity,
    output_hash: entry.output_hash,
    claim_id: claimId(innovationArtifacts.contribution_claims[index])
  }));
  const reviewConcernProvenanceRefs = reviewConcernProvenance.map((entry, index) => ({
    provenance_id: entry.provenance_id,
    generated_by_activity: entry.generated_by_activity,
    output_hash: entry.output_hash,
    concern_id: reviewConcernId(reviewConcerns[index])
  }));
  const storyBeatProvenanceRefs = storyBeatProvenance.map((entry, index) => ({
    provenance_id: entry.provenance_id,
    generated_by_activity: entry.generated_by_activity,
    output_hash: entry.output_hash,
    beat_id: storyBeatId(storyBeats[index])
  }));
  const contributionClaims = innovationArtifacts.contribution_claims.map((claim, index) => ({
    ...claim,
    provenance_ref: claimProvenanceRefs[index]?.provenance_id || null
  }));
  const reviewPacket = addReviewConcernProvenance(innovationArtifacts.review_packet, reviewConcernProvenanceRefs);
  const storylineDag = addStoryBeatProvenance(innovationArtifacts.storyline_dag, storyBeatProvenanceRefs);
  const provenanceRefs = [
    ...asArray(payload.provenance_refs || payload.provenanceRefs),
    ...fragmentProvenanceRefs,
    ...claimProvenanceRefs,
    ...reviewConcernProvenanceRefs,
    ...storyBeatProvenanceRefs
  ];

  return {
    export_version: IDEA_CATALYST_EVIDENCE_EXPORT_VERSION,
    run_id: payload.runId || payload.run_id || live.run_id || null,
    trace_id: payload.traceId || payload.trace_id || live.trace_id || null,
    mode,
    research_problem: problem,
    target_domain: targetDomain,
    target_questions: collectTargetQuestions(live, graphPayload),
    target_challenges: collectTargetChallenges(live, graphPayload),
    domain_agnostic_challenges: collectTargetChallenges(live, graphPayload)
      .map((entry) => entry.domain_agnostic_challenge)
      .filter(Boolean),
    source_domains: sourceDomains,
    source_takeaways: collectSourceTakeaways(live, graphPayload),
    idea_fragments: fragments.map((fragment, index) => ({
      ...fragment,
      rank: fragment.rank || index + 1,
      provenance_ref: fragmentProvenanceRefs[index]?.provenance_id || null,
      evidence_risk: evidenceStatus === 'source_backed' ? null : evidenceStatus
    })),
    interdisciplinary_ranking: live.interdisciplinary_ranking
      || graphPayload.interdisciplinary_ranking
      || graphPayload.packetBundle?.interdisciplinary_ranking
      || graphPayload.packet_bundle?.interdisciplinary_ranking
      || {},
    supporting_papers: supportingPapers,
    supporting_kg_nodes: collectSupportingKgNodes(graphPayload, fragments),
    source_spans: sourceSpans,
    ...innovationArtifacts,
    contribution_claims: contributionClaims,
    review_packet: reviewPacket,
    storyline_dag: storylineDag,
    provenance_refs: provenanceRefs,
    llm_ledger_refs: asArray(payload.llm_ledger_refs || payload.llmLedgerRefs || live.llm_ledger_refs),
    evidence_status: evidenceStatus,
    generated_at: payload.generatedAt || payload.generated_at || live.generatedAt || nowIso()
  };
}
