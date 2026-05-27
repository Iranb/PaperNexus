import { scoreTokenOverlap, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { deriveDomainTaxonomyFromGraph, normalizeDomainTags, normalizeFieldOfStudy } from './domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from './interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from './takeaway-extraction.js';
import { NODE_TYPES } from './schema.js';
import {
  IDEA_CATALYST_PACKET_V2_VERSION,
  buildIdeaCatalystInnovationArtifacts
} from './innovation-contracts.js';

export const IDEA_CATALYST_PACKET_BUNDLE_VERSION = 'idea-catalyst-packet-bundle-v1';
const IDEA_CATALYST_EVIDENCE_CONTRACT_VERSION = 'idea-catalyst-evidence-chain-v1';
const DOMAIN_DISTANCE_POLICY_VERSION = 'idea-catalyst-domain-distance-v1';

function normalizeLabel(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node.properties?.fieldOfStudy,
    ...(node.properties?.fieldCandidates || []),
    ...(node.properties?.domainTags || []),
    ...(node.properties?.sourceDomains || []),
    node.properties?.targetDomain
  ]);
}

function nodeMatchesDomain(node, targetDomain) {
  const normalized = normalizeFieldOfStudy(targetDomain);
  return normalized ? collectNodeDomains(node).includes(normalized) : false;
}

function scoreAffinity(query, text) {
  const queryTokens = tokenizeWithoutStopwords(String(query || '').toLowerCase());
  const textTokens = tokenizeWithoutStopwords(String(text || '').toLowerCase());
  if (!queryTokens.length || !textTokens.length) return 0;
  return scoreTokenOverlap(queryTokens, textTokens);
}

function compareByAffinity(query, left, right) {
  const leftText = [
    left.name,
    left.properties?.domainSpecificText,
    left.properties?.domainAgnosticText,
    left.properties?.text
  ].filter(Boolean).join(' ');
  const rightText = [
    right.name,
    right.properties?.domainSpecificText,
    right.properties?.domainAgnosticText,
    right.properties?.text
  ].filter(Boolean).join(' ');
  return scoreAffinity(query, rightText) - scoreAffinity(query, leftText)
    || left.name.localeCompare(right.name);
}

function collectResearchQuestions(graph, targetDomain, abstractChallenge, fineGrainedDomain, coarseGrainedDomain, mechanisms = [], limit = 5) {
  const questions = graph.getNodesByType(NODE_TYPES.RESEARCH_QUESTION)
    .filter((node) => nodeMatchesDomain(node, targetDomain))
    .sort((left, right) => compareByAffinity(abstractChallenge, left, right))
    .slice(0, limit)
    .map((node, index) => ({
      question_id: node.id || `rq-${index + 1}`,
      domain_specific_question: normalizeLabel(node.properties?.domainSpecificText, node.name),
      domain_agnostic_question: normalizeLabel(node.properties?.domainAgnosticText, node.name),
      rationale: normalizeLabel(
        node.properties?.rationale,
        `${node.name} keeps the target-domain decomposition grounded in the current graph evidence.`
      ),
      target_domain_queries: unique([
        normalizeLabel(node.properties?.domainSpecificText),
        normalizeLabel(node.properties?.domainAgnosticText),
        normalizeLabel(`${fineGrainedDomain} ${abstractChallenge}`),
        normalizeLabel(`${coarseGrainedDomain} ${abstractChallenge}`),
        ...mechanisms.map((mechanism) => normalizeLabel(`${abstractChallenge} ${mechanism}`))
      ].filter(Boolean)).slice(0, 5)
    }));

  if (questions.length) {
    return questions;
  }

  return [
    {
      question_id: 'rq-fallback-1',
      domain_specific_question: abstractChallenge,
      domain_agnostic_question: abstractChallenge,
      rationale: `No explicit ResearchQuestion node matched ${targetDomain}, so the abstract challenge is used as the decomposition anchor.`,
      target_domain_queries: unique([
        normalizeLabel(`${fineGrainedDomain} ${abstractChallenge}`),
        normalizeLabel(`${coarseGrainedDomain} ${abstractChallenge}`),
        abstractChallenge,
        ...mechanisms.map((mechanism) => normalizeLabel(`${abstractChallenge} ${mechanism}`))
      ].filter(Boolean)).slice(0, 5)
    }
  ];
}

function collectChallengeSummaries(graph, targetDomain, abstractChallenge, limit = 5) {
  return graph.getNodesByType(NODE_TYPES.CHALLENGE)
    .filter((node) => nodeMatchesDomain(node, targetDomain))
    .sort((left, right) => compareByAffinity(abstractChallenge, left, right))
    .slice(0, limit)
    .map((node, index) => ({
      challenge_id: node.id || `challenge-${index + 1}`,
      name: node.name,
      domain_specific_challenge_question: normalizeLabel(node.properties?.domainSpecificText, node.name),
      domain_agnostic_challenge_question: normalizeLabel(node.properties?.domainAgnosticText, node.name),
      why_unaddressed: normalizeLabel(
        node.properties?.whyUnaddressed,
        `The graph still marks ${node.name} as an open challenge in ${targetDomain}.`
      ),
      importance: normalizeLabel(
        node.properties?.importance,
        scoreAffinity(abstractChallenge, `${node.properties?.domainSpecificText || ''} ${node.properties?.domainAgnosticText || ''}`) > 0.2
          ? 'high'
          : 'medium'
      )
    }));
}

function buildCrossDomainQueries(candidateDomains, params = {}, potentialReport = null) {
  const fineGrainedDomain = normalizeLabel(params.fineGrainedDomain, params.targetDomain || '');
  const coarseGrainedDomain = normalizeLabel(params.coarseGrainedDomain, params.targetDomain || '');
  const abstractChallenge = normalizeLabel(params.abstractChallenge);
  const mechanisms = Array.isArray(params.mechanisms) ? params.mechanisms : [];

  return candidateDomains.map((entry) => {
    const potential = potentialReport?.rankedSourceDomains?.find((candidate) => candidate.domain === entry.domain) || null;
    const queries = unique([
      ...((entry.matchedChallenges || []).map((challenge) => normalizeLabel(`${entry.domain} ${challenge}`))),
      normalizeLabel(`${entry.domain} ${abstractChallenge}`),
      normalizeLabel(`${entry.domain} ${fineGrainedDomain} ${abstractChallenge}`),
      normalizeLabel(`${entry.domain} ${coarseGrainedDomain} ${abstractChallenge}`),
      ...mechanisms.map((mechanism) => normalizeLabel(`${entry.domain} ${mechanism} ${abstractChallenge}`))
    ].filter(Boolean)).slice(0, 5);

    return {
      domain: entry.domain,
      domain_rationale: potential?.selectionRationale
        || `Search ${entry.domain} because it ranks highly as a cross-domain bridge for ${params.targetDomain}.`,
      queries,
      shared_mechanisms: unique([
        ...(entry.bridgeEvidence || []).map((item) => item.mechanism),
        ...(potential?.sharedMechanisms || [])
      ]).slice(0, 8),
      supporting_papers: Array.isArray(potential?.supportingPapers) ? potential.supportingPapers : []
    };
  });
}

function mergeEvidenceBearingBridgeDomains(crossDomainQueries, evidenceContext = {}, params = {}, maxDomains = crossDomainQueries.length) {
  const seenDomains = new Set(crossDomainQueries.map((entry) => entry.domain).filter(Boolean));
  const supplementalQueries = [];

  for (const [domain, paths] of evidenceContext.pathsByDomain?.entries?.() || []) {
    if (!domain || seenDomains.has(domain) || !asArray(paths).length) continue;
    seenDomains.add(domain);
    const sharedMechanisms = unique(
      asArray(paths).flatMap((path) => asArray(path.matched_mechanisms || path.matchedMechanisms))
    ).slice(0, 8);
    const supportingPapers = unique(
      asArray(paths)
        .flatMap((path) => asArray(path.source_spans || path.sourceSpans))
        .map((span) => span.paper_title || span.paperTitle)
        .filter(Boolean)
    ).slice(0, 8);
    supplementalQueries.push({
      domain,
      domain_rationale: `Include ${domain} because bridge retrieval found ${paths.length} source-backed path(s) for ${params.targetDomain}.`,
      queries: unique([
        normalizeLabel(`${domain} ${params.abstractChallenge}`),
        normalizeLabel(`${domain} ${params.fineGrainedDomain} ${params.abstractChallenge}`),
        normalizeLabel(`${domain} ${params.coarseGrainedDomain} ${params.abstractChallenge}`),
        ...sharedMechanisms.map((mechanism) => normalizeLabel(`${domain} ${mechanism} ${params.abstractChallenge}`))
      ].filter(Boolean)).slice(0, 5),
      shared_mechanisms: sharedMechanisms,
      supporting_papers: supportingPapers
    });
  }

  if (!supplementalQueries.length) return crossDomainQueries.slice(0, maxDomains);

  const baseAllowance = Math.max(0, maxDomains - supplementalQueries.length);
  return [
    ...crossDomainQueries.slice(0, baseAllowance),
    ...supplementalQueries
  ].slice(0, maxDomains);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const uniqueItems = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(item);
  }
  return uniqueItems;
}

function buildDomainDistancePolicy(domainDistanceMatrix = null) {
  return {
    version: domainDistanceMatrix?.version || DOMAIN_DISTANCE_POLICY_VERSION,
    scoring_basis: 'graph-connectivity-and-mechanism-coverage',
    provenance: domainDistanceMatrix ? 'derived-domain-taxonomy' : 'policy-only',
    caveat: 'Domain distance is a graph heuristic and must not be treated as source-span-grade proof.'
  };
}

function normalizePathTrace(path = []) {
  return asArray(path).map((step, index) => ({
    step_index: index + 1,
    role: step.role || '',
    node_id: step.nodeId || step.node_id || null,
    node_type: step.nodeType || step.node_type || null,
    node_name: step.nodeName || step.node_name || ''
  }));
}

function buildEvidenceRef(ref = {}) {
  const nodeId = ref.node_id || ref.nodeId || null;
  const refType = ref.ref_type || ref.refType || ref.role || 'graph-node';
  return {
    ref_id: ref.ref_id || (nodeId ? `${refType}:${nodeId}` : null),
    ref_type: refType,
    node_id: nodeId,
    node_type: ref.node_type || ref.nodeType || null,
    node_name: ref.node_name || ref.nodeName || '',
    role: ref.role || refType,
    source: ref.source || 'paper_nexus_graph',
    evidence_text: ref.evidence_text || ref.evidenceText || ''
  };
}

function buildEvidenceRefsFromPath(candidate = {}) {
  const pathRefs = normalizePathTrace(candidate.path)
    .filter((step) => step.node_id)
    .map((step) => buildEvidenceRef({
      ref_type: step.role || 'graph-node',
      node_id: step.node_id,
      node_type: step.node_type,
      node_name: step.node_name,
      role: step.role,
      source: candidate.pathId || candidate.path_id || 'bridge-path'
    }));

  const snippetRefs = asArray(candidate.snippets)
    .map((snippet) => buildEvidenceRef({
      ref_type: snippet.nodeType === 'RelationshipEvidence' || snippet.node_type === 'RelationshipEvidence'
        ? 'relationship-evidence'
        : 'evidence-snippet',
      node_id: snippet.nodeId || snippet.node_id,
      node_type: snippet.nodeType || snippet.node_type || null,
      node_name: snippet.nodeName || snippet.node_name,
      role: 'evidence-snippet',
      source: snippet.relationshipId || snippet.relationship_id || candidate.pathId || candidate.path_id || 'bridge-path',
      evidence_text: snippet.evidenceText
        || snippet.evidence_text
        || snippet.sourceSpan?.evidence_text
        || snippet.sourceSpan?.evidenceText
        || snippet.source_span?.evidence_text
        || snippet.source_span?.evidenceText
        || ''
    }))
    .filter((entry) => entry.node_id);

  return uniqueBy([...pathRefs, ...snippetRefs], (entry) => entry.ref_id);
}

function normalizeExplicitSourceSpan(span, fallback = {}) {
  const nodeId = fallback.snippet_node_id || fallback.node_id || span?.nodeId || span?.node_id || null;
  const spanId = span?.span_id || span?.spanId || span?.id || (nodeId ? `span:${nodeId}` : null);
  const sourceSpanAvailable = span?.source_span_available ?? span?.sourceSpanAvailable ?? fallback.source_span_available;
  return {
    span_id: spanId,
    source_type: span?.source_type || span?.sourceType || 'source_span',
    snippet_node_id: span?.snippet_node_id || span?.snippetNodeId || fallback.snippet_node_id || null,
    paper_id: span?.paper_id || span?.paperId || fallback.paper_id || null,
    paper_title: span?.paper_title || span?.paperTitle || fallback.paper_title || null,
    section_heading: span?.section_heading || span?.sectionHeading || fallback.section_heading || '',
    section_role: span?.section_role || span?.sectionRole || fallback.section_role || '',
    evidence_text: span?.evidence_text || span?.evidenceText || span?.text || fallback.evidence_text || '',
    source_span_available: sourceSpanAvailable === undefined ? true : Boolean(sourceSpanAvailable),
    explicit_or_inferred: span?.explicit_or_inferred || span?.explicitOrInferred || fallback.explicit_or_inferred || 'explicit',
    confidence: Number(span?.confidence ?? fallback.confidence ?? 0)
  };
}

function buildSnippetSourceSpans(snippetNode) {
  if (!snippetNode) return [];
  const properties = snippetNode.properties || {};
  const fallback = {
    snippet_node_id: snippetNode.id,
    paper_id: properties.paperId || properties.sourcePaperId || null,
    paper_title: properties.paperTitle || properties.sourcePaperTitle || null,
    section_heading: properties.sectionHeading || properties.section || '',
    section_role: properties.sectionRole || '',
    evidence_text: properties.evidenceText || properties.text || snippetNode.name || '',
    explicit_or_inferred: properties.explicitOrInferred || 'explicit',
    confidence: Number(properties.confidence || 0)
  };
  const explicitSpans = [
    ...asArray(properties.sourceSpans),
    ...asArray(properties.source_spans)
  ];

  if (explicitSpans.length) {
    return explicitSpans.map((span) => normalizeExplicitSourceSpan(span, fallback));
  }
  if (!fallback.evidence_text && !fallback.paper_title) return [];

  return [
    {
      span_id: `snippet:${snippetNode.id}`,
      source_type: 'evidence_snippet',
      snippet_node_id: snippetNode.id,
      paper_id: fallback.paper_id,
      paper_title: fallback.paper_title,
      section_heading: fallback.section_heading,
      section_role: fallback.section_role,
      evidence_text: fallback.evidence_text,
      source_span_available: false,
      explicit_or_inferred: fallback.explicit_or_inferred,
      confidence: fallback.confidence
    }
  ];
}

function buildInlineSnippetSourceSpans(snippet = {}) {
  const fallback = {
    snippet_node_id: snippet.nodeId || snippet.node_id || null,
    paper_id: snippet.paperId || snippet.paper_id || null,
    paper_title: snippet.paperTitle || snippet.paper_title || null,
    section_heading: snippet.sectionHeading || snippet.section_heading || '',
    section_role: snippet.sectionRole || snippet.section_role || '',
    evidence_text: snippet.evidenceText || snippet.evidence_text || snippet.nodeName || snippet.node_name || '',
    explicit_or_inferred: snippet.explicitOrInferred || snippet.explicit_or_inferred || 'explicit',
    source_span_available: false,
    confidence: Number(snippet.confidence || 0)
  };
  const explicitSpans = [
    snippet.sourceSpan,
    snippet.source_span,
    ...asArray(snippet.sourceSpans),
    ...asArray(snippet.source_spans)
  ].filter(Boolean);

  if (explicitSpans.length) {
    return explicitSpans.map((span) => normalizeExplicitSourceSpan(span, fallback));
  }
  if (!fallback.evidence_text && !fallback.paper_title) return [];

  return [
    {
      span_id: fallback.snippet_node_id ? `snippet:${fallback.snippet_node_id}` : null,
      source_type: snippet.sourceType || snippet.source_type || 'inline_snippet',
      snippet_node_id: fallback.snippet_node_id,
      paper_id: fallback.paper_id,
      paper_title: fallback.paper_title,
      section_heading: fallback.section_heading,
      section_role: fallback.section_role,
      evidence_text: fallback.evidence_text,
      source_span_available: false,
      explicit_or_inferred: fallback.explicit_or_inferred,
      confidence: fallback.confidence
    }
  ].filter((span) => span.span_id || span.evidence_text || span.paper_title);
}

function collectSourceSpansFromPath(graph, candidate = {}) {
  const snippetNodeIds = unique([
    ...normalizePathTrace(candidate.path)
      .filter((step) => step.role === 'evidence-snippet' && step.node_id)
      .map((step) => step.node_id),
    ...asArray(candidate.snippets)
      .map((snippet) => snippet.nodeId || snippet.node_id)
      .filter(Boolean)
  ]);
  const inlineSnippetSpans = asArray(candidate.snippets)
    .flatMap((snippet) => buildInlineSnippetSourceSpans(snippet));

  return uniqueBy(
    [
      ...snippetNodeIds.flatMap((nodeId) => buildSnippetSourceSpans(graph.getNode(nodeId))),
      ...inlineSnippetSpans
    ],
    (span) => span.span_id || `${span.snippet_node_id}:${span.evidence_text}`
  );
}

function buildTakeawayEvidenceRefs(takeaway = {}) {
  const evidence = takeaway.kg_evidence || {};
  const refs = [];
  if (evidence.node_id) {
    refs.push(buildEvidenceRef({
      ref_type: evidence.node_type || 'kg-node',
      node_id: evidence.node_id,
      node_type: evidence.node_type || null,
      node_name: takeaway.concept || '',
      role: 'source-takeaway',
      source: takeaway.takeaway_id || 'source-domain-takeaway',
      evidence_text: evidence.evidence_text || ''
    }));
  }
  for (const nodeId of asArray(evidence.snippet_node_ids)) {
    refs.push(buildEvidenceRef({
      ref_type: 'evidence-snippet',
      node_id: nodeId,
      role: 'evidence-snippet',
      source: takeaway.takeaway_id || 'source-domain-takeaway'
    }));
  }
  return uniqueBy(refs, (entry) => entry.ref_id);
}

function normalizeTakeawaySourceSpans(takeaway = {}) {
  const evidence = takeaway.kg_evidence || {};
  return [
    ...asArray(takeaway.source_spans),
    ...asArray(evidence.source_spans)
  ].map((span) => normalizeExplicitSourceSpan(span, {
    paper_title: asArray(evidence.paper_titles)[0] || asArray(takeaway.supporting_papers)[0] || null,
    evidence_text: evidence.evidence_text || ''
  }));
}

function normalizeCandidateBridgePath(graph, candidate = {}) {
  const sourceSpans = collectSourceSpansFromPath(graph, candidate);
  const evidenceRefs = buildEvidenceRefsFromPath(candidate);
  return {
    ...candidate,
    path_id: candidate.pathId || candidate.path_id || null,
    source_domain: candidate.sourceDomain || candidate.source_domain || '',
    source_domains: asArray(candidate.sourceDomains || candidate.source_domains),
    target_domain: candidate.targetDomain || candidate.target_domain || '',
    candidate_node_id: candidate.candidateNodeId || candidate.candidate_node_id || null,
    candidate_node_type: candidate.candidateNodeType || candidate.candidate_node_type || null,
    candidate_node_name: candidate.candidateNodeName || candidate.candidate_node_name || '',
    retrieval_backend: candidate.retrievalBackend || candidate.retrieval_backend || null,
    retrieval_score: normalizeScore(candidate.retrievalScore ?? candidate.retrieval_score),
    graph_score: normalizeScore(candidate.graphScore ?? candidate.graph_score),
    combined_score: normalizeScore(candidate.combinedScore ?? candidate.combined_score),
    domain_novelty: normalizeScore(candidate.domainNovelty ?? candidate.domain_novelty),
    challenge_coverage_score: normalizeScore(candidate.challengeCoverageScore ?? candidate.challenge_coverage_score),
    mechanism_coverage_score: normalizeScore(candidate.mechanismCoverageScore ?? candidate.mechanism_coverage_score),
    mechanism_support_density: normalizeScore(candidate.mechanismSupportDensity ?? candidate.mechanism_support_density),
    evidence_density: normalizeScore(candidate.evidenceDensity ?? candidate.evidence_density),
    path_completeness: normalizeScore(candidate.pathCompleteness ?? candidate.path_completeness),
    matched_mechanisms: asArray(candidate.matchedMechanisms || candidate.matched_mechanisms),
    matched_challenges: asArray(candidate.matchedChallenges || candidate.matched_challenges),
    evidence_snippet_count: Number(candidate.evidenceSnippetCount || candidate.evidence_snippet_count || sourceSpans.length || 0),
    snippets: asArray(candidate.snippets).map((snippet) => ({
      ...snippet,
      node_id: snippet.nodeId || snippet.node_id || null,
      node_name: snippet.nodeName || snippet.node_name || '',
      node_type: snippet.nodeType || snippet.node_type || null,
      relationship_id: snippet.relationshipId || snippet.relationship_id || null,
      source_span: snippet.sourceSpan || snippet.source_span || null
    })),
    path_trace: normalizePathTrace(candidate.path),
    evidence_chain_refs: evidenceRefs,
    source_spans: sourceSpans
  };
}

function normalizeBridgeRetrieval(graph, bridgeRetrieval = {}) {
  const candidateBridgePaths = asArray(bridgeRetrieval.candidateBridgePaths || bridgeRetrieval.candidate_bridge_paths)
    .map((candidate) => normalizeCandidateBridgePath(graph, candidate));
  return {
    contractVersion: bridgeRetrieval.contractVersion || null,
    contract_version: bridgeRetrieval.contractVersion || bridgeRetrieval.contract_version || null,
    retrievalBackend: bridgeRetrieval.retrievalBackend || bridgeRetrieval.retrieval_backend || null,
    retrieval_backend: bridgeRetrieval.retrievalBackend || bridgeRetrieval.retrieval_backend || null,
    targetDomain: bridgeRetrieval.targetDomain || bridgeRetrieval.target_domain || '',
    target_domain: bridgeRetrieval.targetDomain || bridgeRetrieval.target_domain || '',
    abstractChallenge: bridgeRetrieval.abstractChallenge || bridgeRetrieval.abstract_challenge || '',
    abstract_challenge: bridgeRetrieval.abstractChallenge || bridgeRetrieval.abstract_challenge || '',
    targetMechanisms: asArray(bridgeRetrieval.targetMechanisms || bridgeRetrieval.target_mechanisms),
    target_mechanisms: asArray(bridgeRetrieval.targetMechanisms || bridgeRetrieval.target_mechanisms),
    retrievedNodeTypes: asArray(bridgeRetrieval.retrievedNodeTypes || bridgeRetrieval.retrieved_node_types),
    retrieved_node_types: asArray(bridgeRetrieval.retrievedNodeTypes || bridgeRetrieval.retrieved_node_types),
    candidateBridgePaths,
    candidate_bridge_paths: candidateBridgePaths,
    prunedNodes: asArray(bridgeRetrieval.prunedNodes || bridgeRetrieval.pruned_nodes),
    pruned_nodes: asArray(bridgeRetrieval.prunedNodes || bridgeRetrieval.pruned_nodes)
  };
}

function normalizeStructuralAnalogy(structuralAnalogy = {}) {
  const alignments = asArray(structuralAnalogy.alignments).map((alignment) => ({
    ...alignment,
    bridge_path_id: alignment.bridgePathId || alignment.bridge_path_id || null,
    candidate_node_id: alignment.candidateNodeId || alignment.candidate_node_id || null,
    candidate_node_type: alignment.candidateNodeType || alignment.candidate_node_type || null,
    candidate_node_name: alignment.candidateNodeName || alignment.candidate_node_name || '',
    source_domain: alignment.sourceDomain || alignment.source_domain || '',
    target_domain: alignment.targetDomain || alignment.target_domain || '',
    analogy_score: normalizeScore(alignment.analogyScore ?? alignment.analogy_score),
    matched_motifs: asArray(alignment.matchedMotifs || alignment.matched_motifs),
    transferable_mechanisms: asArray(alignment.transferableMechanisms || alignment.transferable_mechanisms),
    supporting_evidence_node_ids: asArray(alignment.supportingEvidenceNodeIds || alignment.supporting_evidence_node_ids),
    alignment_rationale: alignment.alignmentRationale || alignment.alignment_rationale || '',
    challenge_alignment: normalizeScore(alignment.challengeAlignment ?? alignment.challenge_alignment),
    mechanism_alignment: normalizeScore(alignment.mechanismAlignment ?? alignment.mechanism_alignment),
    motif_completeness: normalizeScore(alignment.motifCompleteness ?? alignment.motif_completeness)
  }));
  return {
    contractVersion: structuralAnalogy.contractVersion || null,
    contract_version: structuralAnalogy.contractVersion || structuralAnalogy.contract_version || null,
    targetDomain: structuralAnalogy.targetDomain || structuralAnalogy.target_domain || '',
    target_domain: structuralAnalogy.targetDomain || structuralAnalogy.target_domain || '',
    abstractChallenge: structuralAnalogy.abstractChallenge || structuralAnalogy.abstract_challenge || '',
    abstract_challenge: structuralAnalogy.abstractChallenge || structuralAnalogy.abstract_challenge || '',
    targetMechanisms: asArray(structuralAnalogy.targetMechanisms || structuralAnalogy.target_mechanisms),
    target_mechanisms: asArray(structuralAnalogy.targetMechanisms || structuralAnalogy.target_mechanisms),
    alignments
  };
}

function normalizeInterdisciplinaryPotentialRanking(ranking = {}) {
  const rankedCandidates = asArray(ranking.rankedCandidates || ranking.ranked_candidates).map((candidate, index) => ({
    ...candidate,
    rank: Number(candidate.rank || index + 1),
    bridge_path_id: candidate.bridgePathId || candidate.bridge_path_id || null,
    candidate_node_id: candidate.candidateNodeId || candidate.candidate_node_id || null,
    candidate_node_type: candidate.candidateNodeType || candidate.candidate_node_type || null,
    candidate_node_name: candidate.candidateNodeName || candidate.candidate_node_name || '',
    source_domain: candidate.sourceDomain || candidate.source_domain || '',
    target_domain: candidate.targetDomain || candidate.target_domain || '',
    retrieval_backend: candidate.retrievalBackend || candidate.retrieval_backend || null,
    interdisciplinary_potential: normalizeScore(candidate.interdisciplinaryPotential ?? candidate.interdisciplinary_potential),
    novelty_proxy: normalizeScore(candidate.noveltyProxy ?? candidate.novelty_proxy),
    grounding_score: normalizeScore(candidate.groundingScore ?? candidate.grounding_score),
    challenge_coverage_score: normalizeScore(candidate.challengeCoverageScore ?? candidate.challenge_coverage_score),
    story_completeness: normalizeScore(candidate.storyCompleteness ?? candidate.story_completeness),
    analogy_score: normalizeScore(candidate.analogyScore ?? candidate.analogy_score),
    graph_score: normalizeScore(candidate.graphScore ?? candidate.graph_score),
    retrieval_score: normalizeScore(candidate.retrievalScore ?? candidate.retrieval_score),
    mechanism_coverage_score: normalizeScore(candidate.mechanismCoverageScore ?? candidate.mechanism_coverage_score),
    evidence_density: normalizeScore(candidate.evidenceDensity ?? candidate.evidence_density),
    mechanism_support_density: normalizeScore(candidate.mechanismSupportDensity ?? candidate.mechanism_support_density),
    matched_mechanisms: asArray(candidate.matchedMechanisms || candidate.matched_mechanisms),
    matched_challenges: asArray(candidate.matchedChallenges || candidate.matched_challenges),
    matched_motifs: asArray(candidate.matchedMotifs || candidate.matched_motifs),
    transferable_mechanisms: asArray(candidate.transferableMechanisms || candidate.transferable_mechanisms),
    evidence_snippet_count: Number(candidate.evidenceSnippetCount || candidate.evidence_snippet_count || 0),
    path_trace: normalizePathTrace(candidate.path)
  }));
  return {
    contractVersion: ranking.contractVersion || null,
    contract_version: ranking.contractVersion || ranking.contract_version || null,
    targetDomain: ranking.targetDomain || ranking.target_domain || '',
    target_domain: ranking.targetDomain || ranking.target_domain || '',
    abstractChallenge: ranking.abstractChallenge || ranking.abstract_challenge || '',
    abstract_challenge: ranking.abstractChallenge || ranking.abstract_challenge || '',
    targetMechanisms: asArray(ranking.targetMechanisms || ranking.target_mechanisms),
    target_mechanisms: asArray(ranking.targetMechanisms || ranking.target_mechanisms),
    rankingBackend: ranking.rankingBackend || ranking.ranking_backend || null,
    ranking_backend: ranking.rankingBackend || ranking.ranking_backend || null,
    rankedCandidates,
    ranked_candidates: rankedCandidates
  };
}

function buildEvidenceContext(graph, catalystResult = {}) {
  const bridgeRetrieval = normalizeBridgeRetrieval(graph, catalystResult.bridgeRetrieval || catalystResult.bridge_retrieval || {});
  const structuralAnalogy = normalizeStructuralAnalogy(catalystResult.structuralAnalogy || catalystResult.structural_analogy || {});
  const interdisciplinaryPotentialRanking = normalizeInterdisciplinaryPotentialRanking(
    catalystResult.interdisciplinaryPotentialRanking || catalystResult.interdisciplinary_potential_ranking || {}
  );
  const pathsByDomain = new Map();
  for (const path of bridgeRetrieval.candidate_bridge_paths) {
    const domain = path.source_domain;
    if (!domain) continue;
    if (!pathsByDomain.has(domain)) pathsByDomain.set(domain, []);
    pathsByDomain.get(domain).push(path);
  }

  const rankingsByDomain = new Map();
  for (const candidate of interdisciplinaryPotentialRanking.ranked_candidates) {
    const domain = candidate.source_domain;
    if (!domain) continue;
    if (!rankingsByDomain.has(domain)) rankingsByDomain.set(domain, []);
    rankingsByDomain.get(domain).push(candidate);
  }

  return {
    bridge_retrieval: bridgeRetrieval,
    structural_analogy: structuralAnalogy,
    interdisciplinary_potential_ranking: interdisciplinaryPotentialRanking,
    pathsByDomain,
    rankingsByDomain
  };
}

function resolveEvidenceTier({ bridgePathIds = [], sourceSpans = [], evidenceChainRefs = [], pathCompleteness = 0, evidenceDensity = 0 }) {
  const hasBridgePath = bridgePathIds.length > 0;
  const hasSnippetOrSpanEvidence = sourceSpans.length > 0;
  if (hasBridgePath && sourceSpans.length > 0 && pathCompleteness >= 0.75 && evidenceDensity > 0) {
    return 'strong';
  }
  if (hasBridgePath && hasSnippetOrSpanEvidence && pathCompleteness >= 0.5) {
    return 'moderate';
  }
  return 'weak';
}

function buildSourceDomainAnalyses(crossDomainQueries, takeaways, potentialReport, evidenceContext = {}) {
  const rankedSourceDomains = asArray(potentialReport?.rankedSourceDomains);
  return crossDomainQueries.map((entry) => {
    const ranking = rankedSourceDomains.find((candidate) => candidate.domain === entry.domain) || null;
    const domainTakeaways = takeaways
      .filter((takeaway) => takeaway.source_domain === entry.domain)
      .map((takeaway) => ({
        ...takeaway,
        supporting_papers: asArray(takeaway.supporting_papers),
        source_spans: normalizeTakeawaySourceSpans(takeaway),
        evidence_chain_refs: buildTakeawayEvidenceRefs(takeaway)
      }))
      .sort((left, right) => (
        (right.supporting_papers.length - left.supporting_papers.length)
        || left.concept.localeCompare(right.concept)
      ))
      .slice(0, 5);
    const bridgePaths = asArray(evidenceContext.pathsByDomain?.get(entry.domain)).slice(0, 5);
    const rankedCandidates = asArray(evidenceContext.rankingsByDomain?.get(entry.domain)).slice(0, 5);
    const bridgePathIds = unique(bridgePaths.map((path) => path.path_id || path.pathId).filter(Boolean));
    const pathTrace = bridgePaths[0]?.path_trace || rankedCandidates[0]?.path_trace || [];
    const evidenceChainRefs = uniqueBy([
      ...bridgePaths.flatMap((path) => path.evidence_chain_refs || []),
      ...domainTakeaways.flatMap((takeaway) => takeaway.evidence_chain_refs || [])
    ], (ref) => ref.ref_id);
    const sourceSpans = uniqueBy([
      ...bridgePaths.flatMap((path) => path.source_spans || []),
      ...domainTakeaways.flatMap((takeaway) => takeaway.source_spans || [])
    ], (span) => span.span_id || `${span.snippet_node_id}:${span.evidence_text}`);
    const pathCompleteness = normalizeScore(Math.max(
      ...bridgePaths.map((path) => Number(path.path_completeness ?? path.pathCompleteness ?? 0)),
      ...rankedCandidates.map((candidate) => Number(candidate.story_completeness ?? candidate.storyCompleteness ?? 0)),
      0
    ));
    const evidenceDensity = normalizeScore(Math.max(
      ...bridgePaths.map((path) => Number(path.evidence_density ?? path.evidenceDensity ?? 0)),
      ...rankedCandidates.map((candidate) => Number(candidate.evidence_density ?? candidate.evidenceDensity ?? 0)),
      0
    ));
    const rankingBackend = evidenceContext.interdisciplinary_potential_ranking?.ranking_backend
      || bridgePaths[0]?.retrieval_backend
      || null;
    const evidenceTier = resolveEvidenceTier({
      bridgePathIds,
      sourceSpans,
      evidenceChainRefs,
      pathCompleteness,
      evidenceDensity
    });

    return {
      source_domain: entry.domain,
      domain_rationale: entry.domain_rationale,
      shared_mechanisms: entry.shared_mechanisms,
      supporting_papers: unique([
        ...domainTakeaways.flatMap((takeaway) => takeaway.supporting_papers || []),
        ...sourceSpans.map((span) => span.paper_title).filter(Boolean)
      ]).slice(0, 8),
      takeaways: domainTakeaways,
      domain_distance: Number(ranking?.domainDistance || 0),
      interdisciplinary_potential: Number(ranking?.interdisciplinaryPotentialScore || 0),
      selection_rationale: ranking?.selectionRationale || entry.domain_rationale,
      bridge_path_ids: bridgePathIds,
      path_trace: pathTrace,
      evidence_chain_refs: evidenceChainRefs,
      source_spans: sourceSpans,
      path_completeness: pathCompleteness,
      evidence_density: evidenceDensity,
      ranking_backend: rankingBackend,
      evidence_tier: evidenceTier
    };
  });
}

function buildIdeaFragments(sourceDomainAnalyses, ranking, params = {}) {
  const targetDomain = normalizeLabel(params.targetDomain);
  const abstractChallenge = normalizeLabel(params.abstractChallenge);
  const rankedByDomain = sourceDomainAnalyses
    .map((analysis) => {
      const ranked = asArray(ranking.ranked_candidates).find((entry) => entry.source_domain === analysis.source_domain) || null;
      return {
        analysis,
        ranked
      };
    })
    .sort((left, right) => (
      Number(right.ranked?.interdisciplinary_potential || 0) - Number(left.ranked?.interdisciplinary_potential || 0)
      || left.analysis.source_domain.localeCompare(right.analysis.source_domain)
    ));

  return rankedByDomain
    .filter(({ analysis }) => (
      analysis.takeaways.length > 0
      || (asArray(analysis.bridge_path_ids).length > 0 && asArray(analysis.source_spans).length > 0)
    ))
    .slice(0, 3)
    .map(({ analysis, ranked }, index) => {
      const topTakeaway = analysis.takeaways[0];
      const mechanism = topTakeaway?.mechanism || analysis.shared_mechanisms[0] || 'transferable mechanism';
      const bridgePathIds = asArray(analysis.bridge_path_ids);
      const pathTrace = asArray(analysis.path_trace);
      const evidenceChainRefs = asArray(analysis.evidence_chain_refs);
      const sourceSpans = asArray(analysis.source_spans);
      const evidenceTier = analysis.evidence_tier || resolveEvidenceTier({
        bridgePathIds,
        sourceSpans,
        evidenceChainRefs,
        pathCompleteness: Number(analysis.path_completeness || 0),
        evidenceDensity: Number(analysis.evidence_density || 0)
      });
      const ideaEvidence = {
        bridge_path_ids: bridgePathIds,
        path_trace: pathTrace,
        evidence_chain_refs: evidenceChainRefs,
        source_spans: sourceSpans,
        evidence_tier: evidenceTier,
        path_completeness: Number(analysis.path_completeness || 0),
        evidence_density: Number(analysis.evidence_density || 0),
        ranking_backend: analysis.ranking_backend || ranked?.ranking_backend || null
      };
      return {
        rank: index + 1,
        title: `${analysis.source_domain} bridge for ${targetDomain}`.slice(0, 120),
        source_domain: analysis.source_domain,
        target_challenge: abstractChallenge,
        core_insight: topTakeaway?.source_domain_formulation || `${analysis.source_domain} contributes graph-grounded evidence for ${abstractChallenge}.`,
        integration_mechanism: mechanism,
        challenge_resolution: `Use ${mechanism} to address ${abstractChallenge} inside ${targetDomain}.`,
        concrete_realization: topTakeaway?.concept
          ? `Operationalize ${topTakeaway.concept} as a ${targetDomain} intervention.`
          : `Translate the strongest ${analysis.source_domain} takeaway into a ${targetDomain} prototype.`,
        source_takeaways: analysis.takeaways.map((takeaway) => takeaway.concept).slice(0, 5),
        supporting_papers: analysis.supporting_papers,
        supporting_kg_nodes: analysis.takeaways.map((takeaway) => takeaway.kg_evidence?.node_id).filter(Boolean),
        ranking_signals: ranked || null,
        supporting_bridge_paths: bridgePathIds,
        ...ideaEvidence,
        idea_fragment: {
          title: `${analysis.source_domain} bridge for ${targetDomain}`.slice(0, 120),
          core_insight: topTakeaway?.source_domain_formulation || `${analysis.source_domain} contributes graph-grounded evidence for ${abstractChallenge}.`,
          integration_mechanism: mechanism,
          challenge_resolution: `Use ${mechanism} to address ${abstractChallenge} inside ${targetDomain}.`,
          concrete_realization: topTakeaway?.concept
            ? `Operationalize ${topTakeaway.concept} as a ${targetDomain} intervention.`
            : `Translate the strongest ${analysis.source_domain} takeaway into a ${targetDomain} prototype.`,
          ...ideaEvidence
        }
      };
    });
}

function buildInterdisciplinaryRanking(report) {
  return {
    contractVersion: report.contractVersion,
    ranking_criteria: [
      'DEPTH OF INTEGRATION',
      'MULTI-STAGE DISCIPLINARY ENGAGEMENT',
      'INNOVATION PAYOFF',
      'NOVELTY + FEASIBILITY'
    ],
    ranked_candidates: (report.rankedSourceDomains || []).map((entry, index) => ({
      rank: index + 1,
      source_domain: entry.domain,
      interdisciplinary_potential: entry.interdisciplinaryPotentialScore,
      depth_of_integration: entry.depthOfIntegration,
      multi_stage_disciplinary_engagement: entry.multiStageDisciplinaryEngagement,
      innovation_payoff: entry.innovationPayoff,
      novelty_plus_feasibility: entry.noveltyPlusFeasibility,
      supporting_papers: entry.supportingPapers || [],
      shared_mechanisms: entry.sharedMechanisms || [],
      rationale: entry.selectionRationale || ''
    }))
  };
}

function buildRequisitionReport(crossDomainQueries, sourceDomainAnalyses, params = {}, ideaFragments = []) {
  const missingDomains = crossDomainQueries
    .filter((entry) => !sourceDomainAnalyses.some((analysis) => (
      analysis.source_domain === entry.domain
      && (
        analysis.takeaways.length > 0
        || asArray(analysis.bridge_path_ids).length > 0
        || asArray(analysis.source_spans).length > 0
      )
    )))
    .map((entry) => entry.domain);
  const missingEvidenceTypes = new Set();

  if (missingDomains.length) missingEvidenceTypes.add('domain_coverage');
  if (!sourceDomainAnalyses.some((analysis) => asArray(analysis.bridge_path_ids).length > 0)) {
    missingEvidenceTypes.add('bridge_path');
  }
  if (!sourceDomainAnalyses.some((analysis) => asArray(analysis.evidence_chain_refs).length > 0)) {
    missingEvidenceTypes.add('evidence_chain');
  }
  if (!sourceDomainAnalyses.some((analysis) => asArray(analysis.source_spans).length > 0)) {
    missingEvidenceTypes.add('source_span_or_evidence_snippet');
  }
  if (!sourceDomainAnalyses.some((analysis) => Number(analysis.path_completeness || 0) >= 0.5)) {
    missingEvidenceTypes.add('path_completeness');
  }
  if (!sourceDomainAnalyses.some((analysis) => Number(analysis.evidence_density || 0) > 0)) {
    missingEvidenceTypes.add('evidence_density');
  }
  if (!ideaFragments.some((fragment) => fragment.evidence_tier === 'strong' || fragment.evidence_tier === 'moderate')) {
    missingEvidenceTypes.add('usable_idea_fragment');
  }

  return {
    status: 'DATA_STARVATION',
    target_challenge: normalizeLabel(params.abstractChallenge),
    missing_domains: missingDomains,
    missing_evidence_types: [...missingEvidenceTypes].sort(),
    evidence_contract_version: IDEA_CATALYST_EVIDENCE_CONTRACT_VERSION,
    required_topics: crossDomainQueries
      .filter((entry) => missingDomains.includes(entry.domain))
      .map((entry) => ({
        topic: entry.domain,
        search_keywords: entry.queries.slice(0, 3),
        reason: `Need stronger ${entry.domain} evidence to support ${params.abstractChallenge}.`
      })),
    evidence_requirements: [
      'At least one auditable bridge path per usable fragment.',
      'At least one evidence snippet or source span per usable fragment.',
      'Path trace should connect target challenge, source mechanism/takeaway, candidate, and evidence where available.'
    ]
  };
}

export function buildIdeaCatalystPacketBundle(graph, catalystResult = {}, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain || catalystResult.targetDomain);
  const fineGrainedDomain = normalizeLabel(params.fineGrainedDomain, targetDomain || '');
  const coarseGrainedDomain = normalizeLabel(params.coarseGrainedDomain, targetDomain || '');
  const abstractChallenge = normalizeLabel(params.abstractChallenge || catalystResult.abstractChallenge);
  const mechanisms = Array.isArray(params.mechanisms) && params.mechanisms.length
    ? params.mechanisms
    : (Array.isArray(catalystResult.targetMechanisms) ? catalystResult.targetMechanisms : []);
  const limit = Math.max(1, Number(params.limit || 5));
  const numSourceDomains = Math.max(1, Math.min(12, Number(params.numSourceDomains || 3)));
  const relevanceThreshold = Math.max(1, Number(params.relevanceThreshold || 3));
  const domainDistanceMatrix = catalystResult.domainDistanceMatrix
    || catalystResult.domain_distance_matrix
    || deriveDomainTaxonomyFromGraph(graph);
  const evidenceContext = buildEvidenceContext(graph, catalystResult);

  const researchQuestions = collectResearchQuestions(
    graph,
    targetDomain,
    abstractChallenge,
    fineGrainedDomain,
    coarseGrainedDomain,
    mechanisms,
    limit
  );
  const remainingChallenges = collectChallengeSummaries(graph, targetDomain, abstractChallenge, limit);
  const potentialReport = buildInterdisciplinaryPotentialReport(graph, {
    targetDomain,
    query: abstractChallenge,
    agnosticChallenges: [abstractChallenge],
    limit: Math.max(limit, numSourceDomains)
  });
  const baseCrossDomainQueries = buildCrossDomainQueries(
    (catalystResult.candidateDomains || []).slice(0, Math.max(limit, numSourceDomains)),
    {
      targetDomain,
      fineGrainedDomain,
      coarseGrainedDomain,
      abstractChallenge,
      mechanisms
    },
    potentialReport
  ).slice(0, numSourceDomains);
  const crossDomainQueries = mergeEvidenceBearingBridgeDomains(baseCrossDomainQueries, evidenceContext, {
    targetDomain,
    fineGrainedDomain,
    coarseGrainedDomain,
    abstractChallenge
  }, numSourceDomains);
  const takeawayReport = extractTakeawaysFromBridgeNodes(graph, {
    targetDomain,
    agnosticChallenges: [abstractChallenge],
    bridgeNodes: catalystResult.bridgeNodes || []
  });
  const sourceDomainAnalyses = buildSourceDomainAnalyses(
    crossDomainQueries,
    takeawayReport.takeaways || [],
    potentialReport,
    evidenceContext
  );
  const interdisciplinaryRanking = buildInterdisciplinaryRanking(potentialReport);
  const ideaFragments = buildIdeaFragments(
    sourceDomainAnalyses,
    evidenceContext.interdisciplinary_potential_ranking.ranked_candidates.length
      ? evidenceContext.interdisciplinary_potential_ranking
      : interdisciplinaryRanking,
    {
      targetDomain,
      abstractChallenge
    }
  ).filter((fragment) => fragment.evidence_tier === 'strong' || fragment.evidence_tier === 'moderate');
  const sufficient = sourceDomainAnalyses.some((analysis) => (
    analysis.evidence_tier !== 'weak'
    && (
      analysis.takeaways.length >= relevanceThreshold
      || analysis.supporting_papers.length >= relevanceThreshold
      || analysis.bridge_path_ids.length > 0
    )
  ));
  const requisitionReport = sufficient && ideaFragments.length ? null : buildRequisitionReport(crossDomainQueries, sourceDomainAnalyses, {
    abstractChallenge
  }, ideaFragments);
  const decomposition = {
    coarse_grained_domain: coarseGrainedDomain,
    fine_grained_domain: fineGrainedDomain,
    core_challenge: abstractChallenge,
    research_questions: researchQuestions,
    questions: researchQuestions
  };
  const targetDomainAnalysis = [
    {
      target_domain: targetDomain,
      fine_grained_domain: fineGrainedDomain,
      addressed_aspects: researchQuestions.slice(0, 3).map((question) => ({
        sub_question: question.domain_specific_question,
        evidence: question.rationale
      })),
      remaining_challenges: remainingChallenges,
      overall_assessment: remainingChallenges.length
        ? (researchQuestions.length > remainingChallenges.length ? 'partially addressed' : 'largely unaddressed')
      : 'substantially addressed'
    }
  ];
  const innovationArtifacts = buildIdeaCatalystInnovationArtifacts({
    problem: abstractChallenge,
    targetDomain,
    target_domain: targetDomain,
    target_domain_analysis: targetDomainAnalysis,
    source_domain_analyses: sourceDomainAnalyses,
    idea_fragments: requisitionReport ? [] : ideaFragments,
    timeCutoff: params.timeCutoff || params.time_cutoff,
    mustCiteK: params.mustCiteK || params.must_cite_k,
    reviewerPanel: params.reviewerPanel || params.reviewer_panel,
    storylineMode: params.storylineMode || params.storyline_mode,
    counterfactualBudget: params.counterfactualBudget || params.counterfactual_budget
  }, {
    timeCutoff: params.timeCutoff || params.time_cutoff,
    mustCiteK: params.mustCiteK || params.must_cite_k,
    reviewerPanel: params.reviewerPanel || params.reviewer_panel,
    storylineMode: params.storylineMode || params.storyline_mode,
    counterfactualBudget: params.counterfactualBudget || params.counterfactual_budget,
    writeBack: params.writeBack || params.write_back
  });

  return {
    contractVersion: IDEA_CATALYST_PACKET_BUNDLE_VERSION,
    packet_version: IDEA_CATALYST_PACKET_V2_VERSION,
    decomposition,
    target_domain_analysis: targetDomainAnalysis,
    cross_domain_queries: crossDomainQueries,
    cross_domain_searches: crossDomainQueries,
    source_domain_analyses: sourceDomainAnalyses,
    cross_domain_analysis: sourceDomainAnalyses,
    idea_fragments: requisitionReport ? [] : ideaFragments,
    interdisciplinary_ranking: interdisciplinaryRanking,
    bridge_retrieval: evidenceContext.bridge_retrieval,
    structural_analogy: evidenceContext.structural_analogy,
    interdisciplinary_potential_ranking: evidenceContext.interdisciplinary_potential_ranking,
    domain_distance_policy: buildDomainDistancePolicy(domainDistanceMatrix),
    requisition_report: requisitionReport,
    ...innovationArtifacts
  };
}
