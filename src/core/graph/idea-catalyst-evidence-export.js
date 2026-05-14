import { stableHash } from '../../lib/utils.js';
import { createProvenanceEnvelope } from '../../storage/provenance-store.js';

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

function collectSourceSpans(live = {}, graphPayload = {}) {
  const liveSpans = asArray(live.source_domain_analyses).flatMap((analysis) => (
    asArray(analysis.supporting_papers).flatMap((paper) => (
      asArray(paper.snippets).map((snippet, index) => ({
        source_domain: analysis.source_domain,
        paper_key: paper.paper_key,
        paper_title: paper.title || '',
        span_id: compactText(snippet.snippet_id || snippet.snippetId || `snippet:${stableHash(`${paper.paper_key}:${index}`, 10)}`),
        section: compactText(snippet.section),
        text: compactText(snippet.text)
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
      text: compactText(entry.text || entry.evidence_text || entry.evidenceText)
    }))
    .filter((entry) => entry.paper_key || entry.text), (entry) => `${entry.paper_key}:${entry.span_id}:${entry.text.slice(0, 80)}`);
}

function collectSupportingPapers(live = {}, graphPayload = {}, fragments = []) {
  const livePapers = asArray(live.source_domain_analyses).flatMap((analysis) => (
    asArray(analysis.supporting_papers).map((paper) => ({
      paper_key: compactText(paper.paper_key),
      title: compactText(paper.title),
      source_domain: compactText(analysis.source_domain),
      snippet_count: asArray(paper.snippets).length
    }))
  ));
  const fragmentPapers = fragments.flatMap((fragment) => asArray(fragment.supporting_papers).map((paper) => ({
    paper_key: compactText(paper.paper_key || paper.paperId || paper.paper_id),
    title: compactText(paper.title || paper.paperTitle || paper.paper_title),
    source_domain: compactText(fragment.source_domain)
  })));
  const bundle = graphPayload.packetBundle || graphPayload.packet_bundle || {};
  const graphPapers = asArray(bundle.supporting_papers || graphPayload.supporting_papers);
  return uniqueBy([...livePapers, ...fragmentPapers, ...graphPapers]
    .map((entry) => ({
      paper_key: compactText(entry.paper_key || entry.paperId || entry.paper_id || entry.sourceKey || entry.source_key),
      title: compactText(entry.title || entry.paper_title || entry.paperTitle),
      source_domain: compactText(entry.source_domain || entry.domain),
      snippet_count: Number(entry.snippet_count || entry.snippetCount || 0)
    }))
    .filter((entry) => entry.paper_key || entry.title), (entry) => entry.paper_key || entry.title);
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

function deriveEvidenceStatus(fragments = [], sourceSpans = [], supportingPapers = [], sourceDomains = []) {
  if (fragments.length && (sourceSpans.length || supportingPapers.length)) return 'source_backed';
  if (fragments.length) return 'weak_evidence';
  if (sourceDomains.length && sourceDomains.every((entry) => entry.accepted === false)) return 'needs_more_literature';
  return 'failed';
}

export function buildIdeaCatalystEvidenceExport(payload = {}) {
  const live = payload.live || {};
  const graphPayload = payload.graphPayload || payload.graph_payload || {};
  const mode = normalizeMode(payload.mode, payload.live, payload.graphPayload || payload.graph_payload);
  const problem = compactText(payload.problem || live.problem || live.query || graphPayload.problem || graphPayload.query);
  const targetDomain = compactText(payload.targetDomain || payload.target_domain || live.targetDomain || live.target_domain || graphPayload.targetDomain || graphPayload.target_domain);
  const fragments = collectIdeaFragments(live, graphPayload);
  const sourceDomains = collectSourceDomains(live, graphPayload);
  const sourceSpans = collectSourceSpans(live, graphPayload);
  const supportingPapers = collectSupportingPapers(live, graphPayload, fragments);
  const evidenceStatus = payload.evidence_status || payload.evidenceStatus
    || deriveEvidenceStatus(fragments, sourceSpans, supportingPapers, sourceDomains);
  const fragmentProvenance = fragments.map((fragment) => createFragmentProvenance(fragment, {
    traceId: payload.traceId || payload.trace_id || live.trace_id,
    runId: payload.runId || payload.run_id || live.run_id,
    evidenceStatus
  }));
  const provenanceRefs = [
    ...asArray(payload.provenance_refs || payload.provenanceRefs),
    ...fragmentProvenance.map((entry) => ({
      provenance_id: entry.provenance_id,
      generated_by_activity: entry.generated_by_activity,
      output_hash: entry.output_hash
    }))
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
      provenance_ref: provenanceRefs[index]?.provenance_id || null,
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
    provenance_refs: provenanceRefs,
    llm_ledger_refs: asArray(payload.llm_ledger_refs || payload.llmLedgerRefs || live.llm_ledger_refs),
    evidence_status: evidenceStatus,
    generated_at: payload.generatedAt || payload.generated_at || live.generatedAt || nowIso()
  };
}
