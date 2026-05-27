import { normalizeText, scoreTokenOverlap, stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { buildCatalystQuery } from './catalyst-adapter.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from './domain-taxonomy.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';
import { buildIdeaCatalystInnovationArtifacts } from './innovation-contracts.js';

export const CROSS_DOMAIN_MECHANISM_EVIDENCE_CONTRACT_VERSION = 'papernexus-cross-domain-mechanism-evidence-v1';
export const METHOD_EVOLUTION_LINEAGE_CONTRACT_VERSION = 'papernexus-method-evolution-lineage-v1';
export const METHOD_EVOLUTION_EVIDENCE_CONTRACT_VERSION = 'papernexus-method-evidence-v1';
export const RESEARCH_INTELLIGENCE_CONTRACT_VERSION = 'papernexus-research-intelligence-v1';

const METHOD_EVOLUTION_EDGE_TYPES = new Set([
  EDGE_TYPES.EXTENDS_METHOD,
  EDGE_TYPES.IMPROVES_METHOD,
  EDGE_TYPES.REPLACES_METHOD,
  EDGE_TYPES.ADAPTS_METHOD,
  EDGE_TYPES.USES_COMPONENT_METHOD
]);

const METHOD_DAG_EDGE_TYPES = new Set([
  EDGE_TYPES.VARIANT_OF,
  EDGE_TYPES.SPECIALIZES,
  EDGE_TYPES.COMPONENT_OF
]);

const ACCEPTED_EDGE_STATUSES = new Set(['accepted', 'validated', 'authoritative']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeLabel(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function normalizeMechanisms(value) {
  if (Array.isArray(value)) return normalizeAbstractMechanismNames(value);
  if (typeof value === 'string') return normalizeAbstractMechanismNames(value.split(','));
  return [];
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node?.properties?.fieldOfStudy,
    ...(node?.properties?.fieldCandidates || []),
    ...(node?.properties?.domainTags || []),
    ...(node?.properties?.sourceDomains || []),
    node?.properties?.targetDomain
  ]);
}

function summarizeSourceSpan(span = {}) {
  return {
    spanId: span.span_id || span.spanId || null,
    sourceType: span.source_type || span.sourceType || 'source_span',
    snippetNodeId: span.snippet_node_id || span.snippetNodeId || null,
    paperId: span.paper_id || span.paperId || null,
    paperTitle: span.paper_title || span.paperTitle || null,
    sectionHeading: span.section_heading || span.sectionHeading || '',
    sectionRole: span.section_role || span.sectionRole || '',
    quote: span.evidence_text || span.evidenceText || span.quote || span.text || '',
    sourceSpanAvailable: span.source_span_available !== false,
    confidence: normalizeScore(span.confidence)
  };
}

function summarizeEvidenceRef(ref = {}) {
  return {
    refId: ref.ref_id || ref.refId || ref.node_id || ref.nodeId || null,
    refType: ref.ref_type || ref.refType || ref.role || 'graph-node',
    nodeId: ref.node_id || ref.nodeId || null,
    nodeType: ref.node_type || ref.nodeType || null,
    nodeName: ref.node_name || ref.nodeName || '',
    role: ref.role || ref.ref_type || ref.refType || 'graph-node',
    source: ref.source || 'paper_nexus_graph',
    evidenceText: ref.evidence_text || ref.evidenceText || ''
  };
}

function summarizeBridgePathForCertificate(path = {}) {
  const evidenceRefs = asArray(path.evidence_chain_refs || path.evidenceChainRefs)
    .map((ref) => summarizeEvidenceRef(ref))
    .filter((ref) => ref.refId || ref.nodeId);
  const sourceSpans = asArray(path.source_spans || path.sourceSpans)
    .map((span) => summarizeSourceSpan(span))
    .filter((span) => span.spanId || span.snippetNodeId || span.quote);

  return {
    pathId: path.path_id || path.pathId || null,
    sourceDomain: path.source_domain || path.sourceDomain || '',
    targetDomain: path.target_domain || path.targetDomain || '',
    matchedMechanisms: asArray(path.matched_mechanisms || path.matchedMechanisms),
    matchedChallenges: asArray(path.matched_challenges || path.matchedChallenges),
    evidenceRefIds: unique(evidenceRefs.map((ref) => ref.refId).filter(Boolean)),
    sourceSpanIds: unique(sourceSpans.map((span) => span.spanId || span.snippetNodeId).filter(Boolean)),
    evidenceDensity: normalizeScore(path.evidence_density ?? path.evidenceDensity),
    pathCompleteness: normalizeScore(path.path_completeness ?? path.pathCompleteness),
    retrievalBackend: path.retrieval_backend || path.retrievalBackend || null
  };
}

function buildCertificateValidation({ bridgePaths = [], evidenceRefs = [], sourceSpans = [], missingEvidence = [], strongestEvidenceTier = 'weak' } = {}) {
  const gates = [
    {
      name: 'bridge_path',
      passed: bridgePaths.length > 0,
      count: bridgePaths.length
    },
    {
      name: 'evidence_ref',
      passed: evidenceRefs.length > 0,
      count: evidenceRefs.length
    },
    {
      name: 'source_span_or_snippet',
      passed: sourceSpans.length > 0,
      count: sourceSpans.length
    },
    {
      name: 'evidence_tier',
      passed: strongestEvidenceTier === 'strong' || strongestEvidenceTier === 'moderate',
      strongestEvidenceTier
    },
    {
      name: 'missing_evidence',
      passed: missingEvidence.length === 0,
      missing: missingEvidence
    }
  ];
  const hardEvidencePresent = gates.find((gate) => gate.name === 'evidence_ref')?.passed
    && gates.find((gate) => gate.name === 'source_span_or_snippet')?.passed;
  const status = hardEvidencePresent && missingEvidence.length === 0
    ? 'supported'
    : (hardEvidencePresent ? 'partial' : 'data_starved');

  return {
    status,
    gates,
    noLlmQueryInvariant: true
  };
}

function buildEvidenceCertificate({ paths = [], sourceSpans = [], analyses = [], requisitionReport = null } = {}) {
  const bridgePathIds = unique(paths.map((path) => path.path_id || path.pathId).filter(Boolean));
  const evidenceRefs = uniqueBy(
    [
      ...paths.flatMap((path) => asArray(path.evidence_chain_refs || path.evidenceChainRefs)),
      ...analyses.flatMap((analysis) => asArray(analysis.evidence_chain_refs || analysis.evidenceChainRefs))
    ].map((ref) => summarizeEvidenceRef(ref)).filter((ref) => ref.refId || ref.nodeId),
    (ref) => ref.refId || ref.nodeId
  );
  const supportingBridgePaths = paths.map((path) => summarizeBridgePathForCertificate(path));
  const spans = uniqueBy(
    [
      ...sourceSpans,
      ...paths.flatMap((path) => asArray(path.source_spans || path.sourceSpans)),
      ...analyses.flatMap((analysis) => asArray(analysis.source_spans || analysis.sourceSpans))
    ].map((span) => summarizeSourceSpan(span)).filter((span) => span.spanId || span.snippetNodeId || span.quote),
    (span) => span.spanId || `${span.snippetNodeId}:${span.quote}`
  );
  const tiers = analyses.map((analysis) => analysis.evidence_tier || analysis.evidenceTier).filter(Boolean);
  const missingEvidence = asArray(requisitionReport?.missing_evidence_types || requisitionReport?.missingEvidenceTypes);
  const strongestEvidenceTier = tiers.includes('strong') ? 'strong' : (tiers.includes('moderate') ? 'moderate' : 'weak');

  return {
    bridgePathIds,
    evidenceRefCount: evidenceRefs.length,
    sourceSpanCount: spans.length,
    strongestEvidenceTier,
    missingEvidence,
    supportingBridgePaths,
    supportingEvidenceRefs: evidenceRefs,
    supportingSourceSpans: spans,
    validation: buildCertificateValidation({
      bridgePaths: supportingBridgePaths,
      evidenceRefs,
      sourceSpans: spans,
      missingEvidence,
      strongestEvidenceTier
    })
  };
}

function mergeMechanismBundle(existing, next) {
  const merged = existing || {
    mechanism: next.mechanism,
    mechanismNodeId: next.mechanismNodeId || null,
    sourceDomains: [],
    targetDomain: next.targetDomain || '',
    targetRelevance: 0,
    domainNovelty: 0,
    evidenceDensity: 0,
    mechanismSupportDensity: 0,
    supportingPapers: [],
    supportingSnippets: [],
    relatedChallenges: [],
    takeaways: [],
    risks: [],
    bridgePathIds: [],
    evidenceTier: 'weak'
  };

  merged.mechanismNodeId = merged.mechanismNodeId || next.mechanismNodeId || null;
  merged.sourceDomains = unique([...merged.sourceDomains, ...asArray(next.sourceDomains || next.sourceDomain).filter(Boolean)]);
  merged.targetRelevance = normalizeScore(Math.max(merged.targetRelevance, Number(next.targetRelevance || 0)));
  merged.domainNovelty = normalizeScore(Math.max(merged.domainNovelty, Number(next.domainNovelty || 0)));
  merged.evidenceDensity = normalizeScore(Math.max(merged.evidenceDensity, Number(next.evidenceDensity || 0)));
  merged.mechanismSupportDensity = normalizeScore(Math.max(merged.mechanismSupportDensity, Number(next.mechanismSupportDensity || 0)));
  merged.supportingPapers = uniqueBy([...merged.supportingPapers, ...asArray(next.supportingPapers)], (paper) => paper.paperId || paper.paperTitle);
  merged.supportingSnippets = uniqueBy([...merged.supportingSnippets, ...asArray(next.supportingSnippets)], (snippet) => snippet.nodeId || snippet.spanId || snippet.quote);
  merged.relatedChallenges = unique([...merged.relatedChallenges, ...asArray(next.relatedChallenges)]);
  merged.takeaways = unique([...merged.takeaways, ...asArray(next.takeaways)]);
  merged.risks = unique([...merged.risks, ...asArray(next.risks)]);
  merged.bridgePathIds = unique([...merged.bridgePathIds, ...asArray(next.bridgePathIds)]);
  if (next.evidenceTier === 'strong' || (next.evidenceTier === 'moderate' && merged.evidenceTier === 'weak')) {
    merged.evidenceTier = next.evidenceTier;
  }
  return merged;
}

function buildMechanismBundles(packetBundle = {}, catalystResult = {}) {
  const paths = asArray(packetBundle.bridge_retrieval?.candidate_bridge_paths || packetBundle.bridgeRetrieval?.candidateBridgePaths);
  const analyses = asArray(packetBundle.source_domain_analyses || packetBundle.sourceDomainAnalyses);
  const mechanismMatches = new Map(asArray(catalystResult.mechanismMatches).map((entry) => [entry.mechanism, entry]));
  const bundles = new Map();

  for (const path of paths) {
    const mechanisms = normalizeMechanisms(path.matched_mechanisms || path.matchedMechanisms);
    for (const mechanism of mechanisms) {
      const sourceDomain = path.source_domain || path.sourceDomain || '';
      const matchingAnalyses = analyses.filter((analysis) => (
        analysis.source_domain === sourceDomain
        && (!asArray(analysis.shared_mechanisms).length || asArray(analysis.shared_mechanisms).includes(mechanism))
      ));
      const sourceSpans = uniqueBy([
        ...asArray(path.source_spans || path.sourceSpans),
        ...matchingAnalyses.flatMap((analysis) => asArray(analysis.source_spans || analysis.sourceSpans))
      ].map((span) => summarizeSourceSpan(span)), (span) => span.spanId || `${span.snippetNodeId}:${span.quote}`);
      const supportingPapers = uniqueBy([
        ...sourceSpans.map((span) => ({
          paperId: span.paperId,
          paperTitle: span.paperTitle
        })),
        ...matchingAnalyses.flatMap((analysis) => asArray(analysis.supporting_papers).map((paperTitle) => ({
          paperId: null,
          paperTitle
        }))),
        ...asArray(mechanismMatches.get(mechanism)?.supportingPaperTitles).map((paperTitle) => ({
          paperId: null,
          paperTitle
        }))
      ].filter((paper) => paper.paperId || paper.paperTitle), (paper) => paper.paperId || paper.paperTitle);

      const risks = [];
      if (!sourceSpans.length) risks.push('missing evidence snippet or source span');
      if (Number(path.evidence_density ?? path.evidenceDensity ?? 0) <= 0) risks.push('low evidence density');
      if (!sourceDomain) risks.push('unresolved source domain');

      const nextBundle = {
        mechanism,
        mechanismNodeId: mechanismMatches.get(mechanism)?.mechanismNodeId || null,
        sourceDomains: sourceDomain ? [sourceDomain] : [],
        targetDomain: path.target_domain || path.targetDomain || '',
        targetRelevance: path.combined_score ?? path.combinedScore ?? 0,
        domainNovelty: path.domain_novelty ?? path.domainNovelty ?? 0,
        evidenceDensity: path.evidence_density ?? path.evidenceDensity ?? 0,
        mechanismSupportDensity: path.mechanism_support_density ?? path.mechanismSupportDensity ?? 0,
        supportingPapers,
        supportingSnippets: sourceSpans.map((span) => ({
          nodeId: span.snippetNodeId,
          spanId: span.spanId,
          quote: span.quote,
          paperId: span.paperId,
          paperTitle: span.paperTitle,
          sectionHeading: span.sectionHeading
        })),
        relatedChallenges: asArray(path.matched_challenges || path.matchedChallenges),
        takeaways: matchingAnalyses.flatMap((analysis) => asArray(analysis.takeaways).map((takeaway) => takeaway.concept)).filter(Boolean),
        risks,
        bridgePathIds: [path.path_id || path.pathId].filter(Boolean),
        evidenceTier: matchingAnalyses.some((analysis) => analysis.evidence_tier === 'strong') ? 'strong' : (matchingAnalyses.some((analysis) => analysis.evidence_tier === 'moderate') ? 'moderate' : 'weak')
      };

      bundles.set(mechanism, mergeMechanismBundle(bundles.get(mechanism), nextBundle));
    }
  }

  return [...bundles.values()]
    .sort((left, right) => (
      right.targetRelevance - left.targetRelevance
      || right.evidenceDensity - left.evidenceDensity
      || right.mechanismSupportDensity - left.mechanismSupportDensity
      || left.mechanism.localeCompare(right.mechanism)
    ));
}

function resolveCrossDomainDataStarvation(packetBundle = {}, mechanismBundles = []) {
  const requisitionReport = packetBundle.requisition_report || packetBundle.requisitionReport || null;
  if (requisitionReport) {
    return {
      status: mechanismBundles.length ? 'partial' : 'starved',
      missing: asArray(requisitionReport.missing_evidence_types || requisitionReport.missingEvidenceTypes),
      report: requisitionReport
    };
  }

  const missing = [];
  if (!mechanismBundles.length) missing.push('no mechanism evidence bundle');
  if (!mechanismBundles.some((bundle) => bundle.supportingSnippets.length > 0)) {
    missing.push('no evidence snippets or source spans');
  }

  return {
    status: missing.length ? 'partial' : 'ok',
    missing
  };
}

export function buildCrossDomainMechanismEvidence(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain || params.target_domain || params.domain);
  const query = normalizeLabel(params.query || params.problem || params.abstractChallenge || params.challenge);
  const limit = Math.max(1, Number(params.limit || 8));
  const mechanisms = normalizeMechanisms(params.mechanisms || params.mechanism);

  if (!targetDomain || !query) {
    return {
      contractVersion: CROSS_DOMAIN_MECHANISM_EVIDENCE_CONTRACT_VERSION,
      path: 'cross_domain_mechanism_evidence',
      query,
      targetDomain,
      mechanismBundles: [],
      dataStarvation: {
        status: 'starved',
        missing: [
          ...(!query ? ['query'] : []),
          ...(!targetDomain ? ['targetDomain'] : [])
        ]
      },
      diagnostics: {
        queryTimeLlmCalls: 0,
        source: 'graph-only'
      }
    };
  }

  const catalystResult = buildCatalystQuery(graph, {
    targetDomain,
    fineGrainedDomain: params.fineGrainedDomain || params.fine_grained_domain,
    coarseGrainedDomain: params.coarseGrainedDomain || params.coarse_grained_domain,
    abstractChallenge: query,
    mechanisms,
    limit,
    numSourceDomains: params.numSourceDomains || params.num_source_domains,
    relevanceThreshold: params.relevanceThreshold || params.relevance_threshold
  });
  const packetBundle = catalystResult.packetBundle || {};
  const mechanismBundles = buildMechanismBundles(packetBundle, catalystResult).slice(0, limit);
  const sourceDomainAnalyses = asArray(packetBundle.source_domain_analyses || packetBundle.sourceDomainAnalyses);
  const candidatePaths = asArray(packetBundle.bridge_retrieval?.candidate_bridge_paths || packetBundle.bridgeRetrieval?.candidateBridgePaths);
  const sourceSpans = sourceDomainAnalyses.flatMap((analysis) => asArray(analysis.source_spans || analysis.sourceSpans));
  const innovationArtifacts = buildIdeaCatalystInnovationArtifacts({
    problem: query,
    targetDomain,
    target_domain: targetDomain,
    target_domain_analysis: packetBundle.target_domain_analysis,
    source_domain_analyses: sourceDomainAnalyses,
    idea_fragments: packetBundle.idea_fragments,
    source_spans: sourceSpans,
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
    contractVersion: CROSS_DOMAIN_MECHANISM_EVIDENCE_CONTRACT_VERSION,
    path: 'cross_domain_mechanism_evidence',
    query,
    groundedProblem: {
      nodeId: packetBundle.decomposition?.research_questions?.[0]?.question_id || null,
      name: query,
      confidence: packetBundle.decomposition?.research_questions?.length ? 0.75 : 0.35
    },
    targetDomain,
    targetMechanisms: mechanisms,
    mechanismBundles,
    innovationArtifacts,
    evidenceCertificate: buildEvidenceCertificate({
      paths: candidatePaths,
      sourceSpans,
      analyses: sourceDomainAnalyses,
      requisitionReport: packetBundle.requisition_report
    }),
    dataStarvation: resolveCrossDomainDataStarvation(packetBundle, mechanismBundles),
    ...(params.includePacketBundle ? { packetBundle } : {}),
    must_cite_set: innovationArtifacts.must_cite_set,
    novelty_certificate: innovationArtifacts.novelty_certificate,
    review_packet: innovationArtifacts.review_packet,
    storyline_dag: innovationArtifacts.storyline_dag,
    counterfactuals: innovationArtifacts.counterfactuals,
    falsification_plans: innovationArtifacts.falsification_plans,
    diagnostics: {
      queryTimeLlmCalls: 0,
      source: 'graph-only',
      bridgePathCount: candidatePaths.length,
      sourceDomainAnalysisCount: sourceDomainAnalyses.length,
      mechanismBundleCount: mechanismBundles.length
    }
  };
}

function methodAliases(node) {
  return unique([
    node.name,
    node.properties?.canonicalName,
    node.properties?.displayName,
    ...(node.properties?.aliases || []),
    ...(node.properties?.methodAliases || []),
    ...(node.properties?.nameAliases || [])
  ].map((entry) => normalizeLabel(entry)).filter(Boolean));
}

function methodYear(node) {
  const raw = firstDefined(
    node?.properties?.year,
    node?.properties?.publicationYear,
    node?.properties?.paperYear,
    node?.properties?.publishedYear,
    node?.properties?.introducedYear
  );
  const match = String(raw || '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function methodSummary(node) {
  return {
    methodId: node?.id || null,
    methodName: node?.name || '',
    canonicalName: node?.properties?.canonicalName || node?.name || '',
    aliases: methodAliases(node),
    year: methodYear(node),
    paperId: node?.properties?.paperId || node?.properties?.sourcePaperId || null,
    paperTitle: node?.properties?.paperTitle || node?.properties?.sourcePaperTitle || null,
    domains: collectNodeDomains(node)
  };
}

function scoreMethodCandidate(node, query) {
  const normalizedQuery = normalizeText(query);
  const aliases = methodAliases(node);
  const normalizedAliases = aliases.map((alias) => normalizeText(alias));
  if (node.id === query) return 1.2;
  if (normalizedAliases.includes(normalizedQuery)) return 1;
  if (normalizedAliases.some((alias) => alias.includes(normalizedQuery) || normalizedQuery.includes(alias))) return 0.82;

  const queryTokens = tokenizeWithoutStopwords(normalizedQuery);
  const methodTokens = tokenizeWithoutStopwords([
    aliases.join(' '),
    node.properties?.description,
    node.properties?.text
  ].filter(Boolean).join(' '));
  return Number(scoreTokenOverlap(queryTokens, methodTokens).toFixed(4));
}

export function resolveMethodCandidates(graph, query, options = {}) {
  const normalizedQuery = normalizeLabel(query);
  const limit = Math.max(1, Number(options.limit || 5));
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      ambiguity: 'missing',
      candidates: []
    };
  }

  const exactNode = graph.getNode(normalizedQuery);
  if (exactNode?.type === NODE_TYPES.METHOD) {
    return {
      query: normalizedQuery,
      ambiguity: 'resolved',
      candidates: [{ ...methodSummary(exactNode), matchScore: 1.2, matchReason: 'id' }]
    };
  }

  const candidates = graph.getNodesByType(NODE_TYPES.METHOD)
    .map((node) => {
      const matchScore = scoreMethodCandidate(node, normalizedQuery);
      return {
        ...methodSummary(node),
        matchScore,
        matchReason: matchScore >= 1 ? 'exact-or-alias' : (matchScore >= 0.8 ? 'alias-overlap' : 'token-overlap')
      };
    })
    .filter((entry) => entry.matchScore >= 0.25)
    .sort((left, right) => (
      right.matchScore - left.matchScore
      || (left.year || 9999) - (right.year || 9999)
      || left.methodName.localeCompare(right.methodName)
    ))
    .slice(0, limit);

  const topScore = candidates[0]?.matchScore || 0;
  const ambiguity = candidates.length === 0
    ? 'unmatched'
    : (candidates.filter((candidate) => Math.abs(candidate.matchScore - topScore) < 0.05).length > 1 ? 'ambiguous' : 'resolved');

  return {
    query: normalizedQuery,
    ambiguity,
    candidates
  };
}

function isMethodEvolutionRelationship(relationship) {
  return METHOD_EVOLUTION_EDGE_TYPES.has(relationship.type)
    || METHOD_DAG_EDGE_TYPES.has(relationship.type)
    || relationship.properties?.methodEvolution === true
    || Boolean(relationship.properties?.methodEvolutionType)
    || Boolean(relationship.properties?.dagEdgeType);
}

function relationshipStatus(relationship) {
  return normalizeText(firstDefined(
    relationship.properties?.validationStatus,
    relationship.properties?.status,
    relationship.properties?.evidenceStatus,
    relationship.properties?.lineageStatus,
    relationship.properties?.layerStatus
  ) || '');
}

function relationshipQuote(relationship) {
  return normalizeLabel(firstDefined(
    relationship.properties?.exactQuote,
    relationship.properties?.evidenceQuote,
    relationship.properties?.quote,
    relationship.properties?.sourceQuote,
    relationship.properties?.evidenceText
  ));
}

function validateMethodEvolutionEdge(graph, relationship, options = {}) {
  const source = graph.getNode(relationship.sourceId);
  const target = graph.getNode(relationship.targetId);
  const reasons = [];
  if (source?.type !== NODE_TYPES.METHOD || target?.type !== NODE_TYPES.METHOD) reasons.push('non_method_endpoint');
  if (!isMethodEvolutionRelationship(relationship)) reasons.push('not_method_evolution_edge');

  const status = relationshipStatus(relationship);
  const includeCandidate = options.includeCandidate === true || options.includeCandidates === true;
  if (!ACCEPTED_EDGE_STATUSES.has(status) && !includeCandidate) {
    reasons.push('not_accepted_or_validated');
  }

  const quote = relationshipQuote(relationship);
  if (!quote && !includeCandidate) {
    reasons.push('missing_exact_quote');
  }
  if (relationship.properties?.exactMatch === false && !includeCandidate) {
    reasons.push('quote_not_exact_match');
  }

  const sourceYear = methodYear(source);
  const targetYear = methodYear(target);
  if (
    METHOD_EVOLUTION_EDGE_TYPES.has(relationship.type)
    && sourceYear
    && targetYear
    && sourceYear < targetYear
  ) {
    reasons.push('reverse_temporal_direction');
  }

  return {
    accepted: reasons.length === 0,
    status: ACCEPTED_EDGE_STATUSES.has(status) ? status : (status || 'candidate'),
    reasons,
    source,
    target,
    quote
  };
}

function normalizeAxis(value, fallbackDimension = 'unspecified') {
  if (!value) {
    return {
      dimension: fallbackDimension,
      description: ''
    };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      dimension: normalizeLabel(value.dimension || value.axis || value.name, fallbackDimension),
      description: normalizeLabel(value.description || value.text || value.rationale || value.name)
    };
  }
  return {
    dimension: fallbackDimension,
    description: normalizeLabel(value)
  };
}

function buildEdgeEvidence(relationship, quote) {
  return {
    quote,
    paperId: relationship.properties?.paperId || relationship.properties?.sourcePaperId || null,
    paperTitle: relationship.properties?.paperTitle || relationship.properties?.sourcePaperTitle || null,
    sectionHeading: relationship.properties?.sectionHeading || relationship.properties?.section || '',
    sourceSpanId: relationship.properties?.sourceSpanId || relationship.properties?.spanId || null
  };
}

function buildMethodEdgeRecord(graph, relationship, direction) {
  const validation = validateMethodEvolutionEdge(graph, relationship, { includeCandidate: true });
  const props = relationship.properties || {};
  const bottleneck = normalizeAxis(firstDefined(props.bottleneck, props.bottleneckDescription, props.challenge, props.problem), props.bottleneckDimension || props.challengeDimension || 'bottleneck');
  const mechanism = normalizeAxis(firstDefined(props.mechanism, props.mechanismDescription, props.abstractMechanism), props.mechanismType || props.mechanismDimension || 'mechanism');
  const tradeoff = normalizeAxis(firstDefined(props.tradeoff, props.tradeoffDescription, props.cost, props.limitation), props.tradeoffDimension || props.sacrificeDimension || 'tradeoff');

  return {
    edgeId: relationship.id,
    edgeType: relationship.type,
    paperEdgeType: props.paperEdgeType || (METHOD_EVOLUTION_EDGE_TYPES.has(relationship.type) ? relationship.type : null),
    dagEdgeType: props.dagEdgeType || (METHOD_DAG_EDGE_TYPES.has(relationship.type) ? relationship.type : null),
    direction,
    confidence: normalizeScore(props.confidence ?? (validation.accepted ? 0.8 : 0.45)),
    validationStatus: validation.status,
    bottleneck,
    mechanism,
    tradeoff,
    evidence: buildEdgeEvidence(relationship, validation.quote),
    sourceMethod: methodSummary(validation.source),
    targetMethod: methodSummary(validation.target)
  };
}

function relationshipLineagePriority(relationship) {
  return METHOD_DAG_EDGE_TYPES.has(relationship.type) || relationship.properties?.methodEvolutionProjection === true
    ? 1
    : 0;
}

function lineageNextNodeId(relationship, currentMethodId, direction) {
  if (!relationship || !currentMethodId) return null;
  if (relationship.type === EDGE_TYPES.COMPONENT_OF) {
    if (direction === 'backward' && relationship.targetId === currentMethodId) return relationship.sourceId;
    if (direction === 'forward' && relationship.sourceId === currentMethodId) return relationship.targetId;
    return null;
  }
  if (direction === 'forward' && relationship.targetId === currentMethodId) return relationship.sourceId;
  if (direction === 'backward' && relationship.sourceId === currentMethodId) return relationship.targetId;
  return null;
}

function sortLineageEdges(graph, relationships, direction, options = {}) {
  const currentMethodId = options.currentMethodId || null;
  const seenLineageKeys = new Set();
  return relationships
    .map((relationship) => ({
      relationship,
      validation: validateMethodEvolutionEdge(graph, relationship),
      nextNode: currentMethodId
        ? graph.getNode(lineageNextNodeId(relationship, currentMethodId, direction))
        : null
    }))
    .filter((entry) => entry.validation.accepted)
    .sort((left, right) => {
      const leftNext = left.nextNode || (direction === 'backward' ? left.validation.target : left.validation.source);
      const rightNext = right.nextNode || (direction === 'backward' ? right.validation.target : right.validation.source);
      return relationshipLineagePriority(right.relationship) - relationshipLineagePriority(left.relationship)
        || Number(right.relationship.properties?.confidence || 0) - Number(left.relationship.properties?.confidence || 0)
        || (methodYear(leftNext) || 9999) - (methodYear(rightNext) || 9999)
        || leftNext.name.localeCompare(rightNext.name);
    })
    .filter((entry) => {
      const key = entry.relationship.properties?.candidateId || entry.relationship.id;
      if (seenLineageKeys.has(key)) return false;
      seenLineageKeys.add(key);
      return true;
    })
    .map((entry) => entry.relationship);
}

function collectNextLineageEdges(graph, methodNode, direction, options = {}) {
  const raw = [
    ...graph.getIncoming(methodNode.id),
    ...graph.getOutgoing(methodNode.id)
  ];
  return sortLineageEdges(
    graph,
    raw.filter((relationship) => (
      isMethodEvolutionRelationship(relationship)
      && lineageNextNodeId(relationship, methodNode.id, direction)
    )),
    direction,
    { currentMethodId: methodNode.id }
  ).slice(0, Math.max(1, Number(options.branchLimit || 3)));
}

function collectRejectedEdgeDiagnostics(graph, methodNode, direction) {
  const raw = [
    ...graph.getIncoming(methodNode.id),
    ...graph.getOutgoing(methodNode.id)
  ];
  const rejected = raw
    .filter((relationship) => (
      isMethodEvolutionRelationship(relationship)
      && lineageNextNodeId(relationship, methodNode.id, direction)
    ))
    .map((relationship) => ({
      relationship,
      validation: validateMethodEvolutionEdge(graph, relationship)
    }))
    .filter((entry) => !entry.validation.accepted);

  return rejected.map((entry) => ({
    edgeId: entry.relationship.id,
    edgeType: entry.relationship.type,
    sourceId: entry.relationship.sourceId,
    targetId: entry.relationship.targetId,
    reasons: entry.validation.reasons
  }));
}

function traverseLineages(graph, rootMethod, direction, options = {}) {
  const maxDepth = Math.max(1, Number(options.maxDepth || options.depth || 3));
  const maxLineages = Math.max(1, Number(options.limit || 5));
  const lineages = [];

  function visit(methodNode, depth, visited, steps) {
    if (depth >= maxDepth) {
      if (steps.some((step) => step.edgeToNext)) lineages.push(steps);
      return;
    }

    const nextEdges = collectNextLineageEdges(graph, methodNode, direction, options)
      .filter((relationship) => {
        const nextNode = graph.getNode(lineageNextNodeId(relationship, methodNode.id, direction));
        return nextNode && !visited.has(nextNode.id);
      });

    if (!nextEdges.length) {
      if (steps.some((step) => step.edgeToNext)) lineages.push(steps);
      return;
    }

    for (const relationship of nextEdges) {
      const nextNode = graph.getNode(lineageNextNodeId(relationship, methodNode.id, direction));
      const nextSteps = steps.map((step) => ({ ...step }));
      nextSteps[nextSteps.length - 1] = {
        ...nextSteps[nextSteps.length - 1],
        edgeToNext: buildMethodEdgeRecord(graph, relationship, direction)
      };
      nextSteps.push(methodSummary(nextNode));
      visit(nextNode, depth + 1, new Set([...visited, nextNode.id]), nextSteps);
    }
  }

  visit(rootMethod, 0, new Set([rootMethod.id]), [methodSummary(rootMethod)]);

  return lineages
    .map((steps) => {
      const edges = steps.map((step) => step.edgeToNext).filter(Boolean);
      const score = edges.length
        ? Number((edges.reduce((total, edge) => total + edge.confidence, 0) / edges.length).toFixed(4))
        : 0;
      return { direction, score, steps };
    })
    .sort((left, right) => right.score - left.score || right.steps.length - left.steps.length)
    .slice(0, maxLineages);
}

function collectLineageEdges(lineages = []) {
  return lineages.flatMap((lineage) => lineage.steps.map((step) => step.edgeToNext).filter(Boolean));
}

function aggregateAxis(edges, key) {
  const counts = new Map();
  for (const edge of edges) {
    const axis = edge[key] || {};
    const dimension = normalizeLabel(axis.dimension, key);
    const description = normalizeLabel(axis.description);
    const existing = counts.get(dimension) || {
      dimension,
      count: 0,
      descriptions: [],
      groundingEdges: [],
      evidenceQuotes: []
    };
    existing.count += 1;
    if (description) existing.descriptions.push(description);
    existing.groundingEdges.push(edge.edgeId);
    if (edge.evidence?.quote) existing.evidenceQuotes.push(edge.evidence.quote);
    counts.set(dimension, existing);
  }

  return [...counts.values()]
    .map((entry) => ({
      ...entry,
      descriptions: unique(entry.descriptions).slice(0, 5),
      groundingEdges: unique(entry.groundingEdges),
      evidenceQuotes: unique(entry.evidenceQuotes).slice(0, 5)
    }))
    .sort((left, right) => right.count - left.count || left.dimension.localeCompare(right.dimension));
}

function buildGapCandidates(lineages = [], limit = 5) {
  const edges = collectLineageEdges(lineages);
  const bottlenecks = aggregateAxis(edges, 'bottleneck');
  const tradeoffs = aggregateAxis(edges, 'tradeoff');
  const output = [];

  for (const bottleneck of bottlenecks.slice(0, limit)) {
    const tradeoff = tradeoffs[output.length % Math.max(1, tradeoffs.length)] || null;
    const groundingEdges = unique([
      ...bottleneck.groundingEdges,
      ...(tradeoff?.groundingEdges || [])
    ]);
    const evidenceQuotes = unique([
      ...bottleneck.evidenceQuotes,
      ...(tradeoff?.evidenceQuotes || [])
    ]).slice(0, 3);
    output.push({
      gap: tradeoff
        ? `reduce ${bottleneck.dimension} bottlenecks without increasing ${tradeoff.dimension} costs`
        : `find the next method step that addresses ${bottleneck.dimension} bottlenecks`,
      bottleneckDimension: bottleneck.dimension,
      tradeoffDimension: tradeoff?.dimension || null,
      groundingEdges,
      evidenceQuotes,
      confidence: normalizeScore(Math.min(1, groundingEdges.length / 3))
    });
  }

  return output;
}

function buildMethodDataStarvation({ resolution, lineages, rejectedEdges }) {
  const missing = [];
  if (resolution.ambiguity === 'missing') missing.push('method query');
  if (resolution.ambiguity === 'unmatched') missing.push('matched Method node');
  if (resolution.ambiguity === 'ambiguous') missing.push('unambiguous Method alias');
  if (!lineages.length) missing.push('validated method evolution edge');
  if (!lineages.some((lineage) => collectLineageEdges([lineage]).some((edge) => edge.evidence?.quote))) {
    missing.push('exact-match edge quote');
  }

  return {
    status: missing.length ? (lineages.length ? 'partial' : 'starved') : 'ok',
    missing: unique(missing),
    rejectedEdgeCount: rejectedEdges.length
  };
}

export function buildMethodEvolutionGapAnalysis(graph, params = {}) {
  const query = normalizeLabel(params.method || params.methodName || params.query);
  const direction = ['backward', 'forward', 'both'].includes(String(params.direction || '').trim())
    ? String(params.direction).trim()
    : 'backward';
  const maxDepth = Math.max(1, Number(params.maxDepth || params.depth || 3));
  const limit = Math.max(1, Number(params.limit || 5));
  const resolution = resolveMethodCandidates(graph, query, { limit: Math.max(3, limit) });

  if (resolution.ambiguity !== 'resolved') {
    return {
      contractVersion: METHOD_EVOLUTION_LINEAGE_CONTRACT_VERSION,
      path: 'method_evolution_bottleneck_gap',
      query,
      matchedMethod: null,
      candidates: resolution.candidates,
      lineages: [],
      bottleneckTrajectory: [],
      tradeoffTrajectory: [],
      nextGapCandidates: [],
      dataStarvation: buildMethodDataStarvation({ resolution, lineages: [], rejectedEdges: [] }),
      diagnostics: {
        queryTimeLlmCalls: 0,
        source: 'graph-only',
        ambiguity: resolution.ambiguity
      }
    };
  }

  const matchedNode = graph.getNode(resolution.candidates[0].methodId);
  const directions = direction === 'both' ? ['backward', 'forward'] : [direction];
  const lineages = directions.flatMap((entryDirection) => traverseLineages(graph, matchedNode, entryDirection, {
    maxDepth,
    limit,
    branchLimit: params.branchLimit || params.branch_limit
  }));
  const rejectedEdges = directions.flatMap((entryDirection) => collectRejectedEdgeDiagnostics(graph, matchedNode, entryDirection));
  const lineageEdges = collectLineageEdges(lineages);

  return {
    contractVersion: METHOD_EVOLUTION_LINEAGE_CONTRACT_VERSION,
    path: 'method_evolution_bottleneck_gap',
    query,
    matchedMethod: {
      ...resolution.candidates[0],
      ambiguity: resolution.ambiguity
    },
    candidates: resolution.candidates,
    direction,
    maxDepth,
    lineages,
    bottleneckTrajectory: aggregateAxis(lineageEdges, 'bottleneck'),
    tradeoffTrajectory: aggregateAxis(lineageEdges, 'tradeoff'),
    nextGapCandidates: buildGapCandidates(lineages, limit),
    dataStarvation: buildMethodDataStarvation({ resolution, lineages, rejectedEdges }),
    diagnostics: {
      queryTimeLlmCalls: 0,
      source: 'graph-only',
      acceptedEdgeCount: lineageEdges.length,
      rejectedEdges,
      lineageCacheKey: `method-lineage:${stableHash(`${matchedNode.id}:${direction}:${maxDepth}:${graph.relationshipCount}`)}`
    }
  };
}

function normalizeMethodPair(params = {}) {
  const pair = asArray(params.methodPair || params.methods);
  const sourceMethod = normalizeLabel(firstDefined(
    params.sourceMethod,
    params.fromMethod,
    params.source,
    params.from,
    params.methodA,
    pair[0],
    params.targetMethod || params.toMethod || params.target || params.to || params.methodB || pair[1]
      ? params.method
      : undefined
  ));
  const targetMethod = normalizeLabel(firstDefined(
    params.targetMethod,
    params.toMethod,
    params.target,
    params.to,
    params.methodB,
    pair[1]
  ));
  const singleMethod = normalizeLabel(firstDefined(
    params.method,
    params.methodName,
    params.query,
    sourceMethod
  ));

  return {
    sourceMethod: sourceMethod || (targetMethod ? singleMethod : ''),
    targetMethod,
    singleMethod: targetMethod ? '' : singleMethod
  };
}

function resolvedMethodNode(graph, resolution) {
  if (resolution?.ambiguity !== 'resolved') return null;
  return graph.getNode(resolution.candidates[0]?.methodId);
}

function relationshipMethodEndpointIds(relationship) {
  const props = relationship.properties || {};
  return unique([
    relationship.sourceId,
    relationship.targetId,
    props.sourceMethodId,
    props.targetMethodId,
    props.dagSourceMethodId,
    props.dagTargetMethodId
  ].filter(Boolean));
}

function relationshipMatchesMethodPair(relationship, sourceMethodId, targetMethodId, strictDirection = false) {
  const props = relationship.properties || {};
  const pairs = [
    [relationship.sourceId, relationship.targetId],
    [props.sourceMethodId, props.targetMethodId],
    [props.dagSourceMethodId, props.dagTargetMethodId]
  ].filter(([sourceId, targetId]) => sourceId && targetId);

  return pairs.some(([sourceId, targetId]) => {
    if (sourceId === sourceMethodId && targetId === targetMethodId) return true;
    return !strictDirection && sourceId === targetMethodId && targetId === sourceMethodId;
  });
}

function relationshipMatchesEvidenceId(relationship, edgeId) {
  const props = relationship.properties || {};
  return relationship.id === edgeId
    || props.citationRelationshipId === edgeId
    || props.candidateId === edgeId
    || props.citationContextId === edgeId
    || props.referenceId === edgeId;
}

function collectMethodEvidenceRelationships(graph, { edgeId, sourceNode, targetNode, singleNode, strictDirection = false } = {}) {
  if (edgeId) {
    const exact = graph.getRelationship(edgeId);
    if (exact) return isMethodEvolutionRelationship(exact) ? [exact] : [];
  }

  const relationships = [];
  graph.forEachRelationship((relationship) => {
    if (!isMethodEvolutionRelationship(relationship)) return;
    if (edgeId) {
      if (relationshipMatchesEvidenceId(relationship, edgeId)) relationships.push(relationship);
      return;
    }
    if (sourceNode && targetNode) {
      if (relationshipMatchesMethodPair(relationship, sourceNode.id, targetNode.id, strictDirection)) {
        relationships.push(relationship);
      }
      return;
    }
    if (singleNode && relationshipMethodEndpointIds(relationship).includes(singleNode.id)) {
      relationships.push(relationship);
    }
  });
  return relationships;
}

function inferEvidenceCompleteness(relationship, record) {
  const props = relationship.properties || {};
  const status = normalizeLabel(props.evidenceCompletenessStatus);
  const missingFields = Array.isArray(props.evidenceMissingFields) ? props.evidenceMissingFields : [];
  if (status) {
    return {
      status,
      missingFields
    };
  }

  const inferredMissing = [];
  if (!record.evidence?.quote) inferredMissing.push('exactQuote');
  if (!record.bottleneck?.description) inferredMissing.push('bottleneck.description');
  if (!record.mechanism?.description) inferredMissing.push('mechanism.description');
  return {
    status: inferredMissing.length ? 'incomplete' : 'complete',
    missingFields: inferredMissing
  };
}

function evidenceCompletenessRank(completeness = {}) {
  if (completeness.status === 'complete') return 1;
  if (completeness.status === 'not_required') return 0.6;
  return completeness.missingFields?.length ? 0.25 : 0;
}

function temporalProximityRank(record) {
  const sourceYear = Number(record.sourceMethod?.year);
  const targetYear = Number(record.targetMethod?.year);
  if (!Number.isFinite(sourceYear) || !Number.isFinite(targetYear)) return 0;
  const gap = Math.abs(sourceYear - targetYear);
  return Number(Math.max(0, 1 - Math.min(gap, 50) / 50).toFixed(4));
}

function methodEvidenceRank(record) {
  return {
    accepted: record.validation.accepted ? 1 : 0,
    confidence: Number(record.confidence || 0),
    temporalProximity: temporalProximityRank(record),
    evidenceCompleteness: evidenceCompletenessRank(record.evidenceCompleteness),
    dagPriority: record.relationshipRole === 'method-dag' ? 1 : 0
  };
}

function sortMethodEvidenceRecords(left, right) {
  const leftRank = methodEvidenceRank(left);
  const rightRank = methodEvidenceRank(right);
  return rightRank.accepted - leftRank.accepted
    || rightRank.confidence - leftRank.confidence
    || rightRank.temporalProximity - leftRank.temporalProximity
    || rightRank.evidenceCompleteness - leftRank.evidenceCompleteness
    || rightRank.dagPriority - leftRank.dagPriority
    || left.edgeId.localeCompare(right.edgeId);
}

function methodEvidenceDedupKey(record) {
  return record.candidateId || record.citationRelationshipId || record.edgeId;
}

function buildMethodEvidenceRecord(graph, relationship) {
  const validation = validateMethodEvolutionEdge(graph, relationship);
  const includeCandidateValidation = validateMethodEvolutionEdge(graph, relationship, { includeCandidate: true });
  const base = buildMethodEdgeRecord(graph, relationship, relationship.properties?.dagDirection || 'evidence');
  const props = relationship.properties || {};
  const completeness = inferEvidenceCompleteness(relationship, base);
  const sourceYear = base.sourceMethod?.year || props.sourceYear || null;
  const targetYear = base.targetMethod?.year || props.targetYear || null;
  const yearGap = sourceYear && targetYear ? Math.abs(sourceYear - targetYear) : null;

  return {
    edgeId: relationship.id,
    edgeType: relationship.type,
    paperEdgeType: base.paperEdgeType,
    dagEdgeType: base.dagEdgeType,
    methodCitationType: props.methodCitationType || props.methodEvolutionType || base.paperEdgeType || relationship.type,
    relationshipRole: props.relationshipRole || (props.methodEvolutionProjection === true ? 'method-dag' : 'paper-citation'),
    citationRelationshipId: props.citationRelationshipId || null,
    candidateId: props.candidateId || null,
    confidence: base.confidence,
    validationStatus: includeCandidateValidation.status,
    validation: {
      accepted: validation.accepted,
      reasons: validation.reasons
    },
    evidenceCompleteness: completeness,
    temporal: {
      direction: props.temporalDirection || '',
      sourceYear,
      targetYear,
      yearGap
    },
    sourceMethod: base.sourceMethod,
    targetMethod: base.targetMethod,
    bottleneck: base.bottleneck,
    mechanism: base.mechanism,
    tradeoff: base.tradeoff,
    evidence: {
      ...base.evidence,
      exactQuote: base.evidence.quote,
      citationContext: props.citationContext || '',
      exactMatch: props.exactMatch !== false
    },
    sourcePaper: {
      paperId: props.sourcePaperId || props.paperId || null,
      paperTitle: props.sourcePaperTitle || props.paperTitle || null
    },
    targetPaper: {
      paperId: props.targetPaperId || null,
      paperTitle: props.targetPaperTitle || null
    },
    reference: {
      referenceId: props.referenceId || null,
      referenceTitleGuess: props.referenceTitleGuess || '',
      referenceYear: props.referenceYear || null
    },
    section: {
      heading: props.sectionHeading || '',
      role: props.sectionRole || ''
    },
    graphRelationship: {
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      type: relationship.type
    }
  };
}

function deduplicateMethodEvidenceRecords(records = []) {
  const seen = new Set();
  const output = [];
  for (const record of records.sort(sortMethodEvidenceRecords)) {
    const key = methodEvidenceDedupKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

function buildMethodEvidenceStarvation({ edgeId, sourceResolution, targetResolution, singleResolution, allRecords, returnedRecords }) {
  const missing = [];
  if (!edgeId && !sourceResolution && !singleResolution) missing.push('edge id or method selector');
  if (sourceResolution && sourceResolution.ambiguity !== 'resolved') missing.push('resolved source method');
  if (targetResolution && targetResolution.ambiguity !== 'resolved') missing.push('resolved target method');
  if (singleResolution && singleResolution.ambiguity !== 'resolved') missing.push('resolved method');
  if (!allRecords.length) missing.push('method evolution evidence edge');
  if (allRecords.length && !returnedRecords.length) missing.push('accepted method evolution evidence edge');

  return {
    status: missing.length ? (allRecords.length ? 'partial' : 'starved') : 'ok',
    missing: unique(missing)
  };
}

export function buildMethodEvolutionEvidenceLookup(graph, params = {}) {
  const edgeId = normalizeLabel(params.edgeId || params.relationshipId || params.citationRelationshipId || params.candidateId);
  const limit = Math.max(1, Number(params.limit || 10));
  const includeCandidates = params.includeCandidates === true || params.includeCandidate === true || Boolean(edgeId);
  const strictDirection = params.strictDirection === true || params.ordered === true;
  const pair = normalizeMethodPair(params);
  const sourceResolution = !edgeId && pair.sourceMethod
    ? resolveMethodCandidates(graph, pair.sourceMethod, { limit: 5 })
    : null;
  const targetResolution = !edgeId && pair.targetMethod
    ? resolveMethodCandidates(graph, pair.targetMethod, { limit: 5 })
    : null;
  const singleResolution = !edgeId && !targetResolution && pair.singleMethod
    ? resolveMethodCandidates(graph, pair.singleMethod, { limit: 5 })
    : null;
  const sourceNode = resolvedMethodNode(graph, sourceResolution);
  const targetNode = resolvedMethodNode(graph, targetResolution);
  const singleNode = resolvedMethodNode(graph, singleResolution);
  const unresolved = [sourceResolution, targetResolution, singleResolution]
    .filter(Boolean)
    .some((resolution) => resolution.ambiguity !== 'resolved');

  const candidateRelationships = unresolved
    ? []
    : collectMethodEvidenceRelationships(graph, {
      edgeId,
      sourceNode,
      targetNode,
      singleNode,
      strictDirection
    });
  const allRecords = candidateRelationships.map((relationship) => buildMethodEvidenceRecord(graph, relationship));
  const returnedRecords = deduplicateMethodEvidenceRecords(
    allRecords.filter((record) => includeCandidates || record.validation.accepted)
  ).slice(0, limit);

  return {
    contractVersion: METHOD_EVOLUTION_EVIDENCE_CONTRACT_VERSION,
    path: 'method_evidence',
    query: {
      edgeId: edgeId || null,
      sourceMethod: pair.sourceMethod || null,
      targetMethod: pair.targetMethod || null,
      method: pair.singleMethod || null,
      strictDirection
    },
    matchedMethods: {
      source: sourceResolution ? (sourceNode ? methodSummary(sourceNode) : null) : null,
      target: targetResolution ? (targetNode ? methodSummary(targetNode) : null) : null,
      method: singleResolution ? (singleNode ? methodSummary(singleNode) : null) : null
    },
    candidates: {
      source: sourceResolution?.candidates || [],
      target: targetResolution?.candidates || [],
      method: singleResolution?.candidates || []
    },
    matches: returnedRecords,
    dataStarvation: buildMethodEvidenceStarvation({
      edgeId,
      sourceResolution,
      targetResolution,
      singleResolution,
      allRecords,
      returnedRecords
    }),
    diagnostics: {
      queryTimeLlmCalls: 0,
      source: 'graph-only',
      includeCandidates,
      candidateEdgeCount: candidateRelationships.length,
      returnedEdgeCount: returnedRecords.length,
      deduplicatedEdgeCount: Math.max(0, allRecords.length - deduplicateMethodEvidenceRecords(allRecords).length)
    }
  };
}

function inferAnswerMode(params = {}) {
  const explicit = String(params.mode || params.path || params.answerType || params.answer_type || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['cross_domain', 'cross_domain_evidence', 'mechanism', 'mechanism_evidence'].includes(explicit)) {
    return 'cross_domain_evidence';
  }
  if (['method', 'method_lineage', 'lineage', 'method_evolution'].includes(explicit)) {
    return 'method_lineage';
  }
  if (explicit === 'both' || explicit === 'dual') return 'both';
  if (params.method || params.methodName) return 'method_lineage';
  if (params.targetDomain || params.target_domain || params.domain) return 'cross_domain_evidence';
  return 'both';
}

export function buildResearchIntelligenceAnswer(graph, params = {}) {
  const mode = inferAnswerMode(params);
  const outputs = {};
  if (mode === 'cross_domain_evidence' || mode === 'both') {
    outputs.crossDomainMechanismEvidence = buildCrossDomainMechanismEvidence(graph, params);
    outputs.innovationArtifacts = outputs.crossDomainMechanismEvidence.innovationArtifacts;
  }
  if (mode === 'method_lineage' || mode === 'both') {
    outputs.methodEvolutionGap = buildMethodEvolutionGapAnalysis(graph, params);
  }

  return {
    contractVersion: RESEARCH_INTELLIGENCE_CONTRACT_VERSION,
    mode,
    query: normalizeLabel(params.query || params.problem || params.method || params.methodName),
    ...outputs,
    diagnostics: {
      queryTimeLlmCalls: 0,
      source: 'graph-only',
      noLlmQueryInvariant: true
    }
  };
}
