import { normalizeText, scoreTokenOverlap, stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { buildCatalystQuery } from './catalyst-adapter.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from './domain-taxonomy.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const CROSS_DOMAIN_MECHANISM_EVIDENCE_CONTRACT_VERSION = 'papernexus-cross-domain-mechanism-evidence-v1';
export const METHOD_EVOLUTION_LINEAGE_CONTRACT_VERSION = 'papernexus-method-evolution-lineage-v1';
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

function buildEvidenceCertificate({ paths = [], sourceSpans = [], analyses = [], requisitionReport = null } = {}) {
  const bridgePathIds = unique(paths.map((path) => path.path_id || path.pathId).filter(Boolean));
  const evidenceRefs = uniqueBy(
    paths.flatMap((path) => asArray(path.evidence_chain_refs || path.evidenceChainRefs)),
    (ref) => ref.ref_id || ref.refId || ref.node_id || ref.nodeId
  );
  const spans = uniqueBy(sourceSpans.map((span) => summarizeSourceSpan(span)), (span) => span.spanId || `${span.snippetNodeId}:${span.quote}`);
  const tiers = analyses.map((analysis) => analysis.evidence_tier || analysis.evidenceTier).filter(Boolean);
  const missingEvidence = asArray(requisitionReport?.missing_evidence_types || requisitionReport?.missingEvidenceTypes);

  return {
    bridgePathIds,
    evidenceRefCount: evidenceRefs.length,
    sourceSpanCount: spans.length,
    strongestEvidenceTier: tiers.includes('strong') ? 'strong' : (tiers.includes('moderate') ? 'moderate' : 'weak'),
    missingEvidence
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
    evidenceCertificate: buildEvidenceCertificate({
      paths: candidatePaths,
      sourceSpans,
      analyses: sourceDomainAnalyses,
      requisitionReport: packetBundle.requisition_report
    }),
    dataStarvation: resolveCrossDomainDataStarvation(packetBundle, mechanismBundles),
    ...(params.includePacketBundle ? { packetBundle } : {}),
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

function sortLineageEdges(graph, relationships, direction) {
  return relationships
    .map((relationship) => ({
      relationship,
      validation: validateMethodEvolutionEdge(graph, relationship)
    }))
    .filter((entry) => entry.validation.accepted)
    .sort((left, right) => {
      const leftNext = direction === 'backward' ? left.validation.target : left.validation.source;
      const rightNext = direction === 'backward' ? right.validation.target : right.validation.source;
      return Number(right.relationship.properties?.confidence || 0) - Number(left.relationship.properties?.confidence || 0)
        || (methodYear(leftNext) || 9999) - (methodYear(rightNext) || 9999)
        || leftNext.name.localeCompare(rightNext.name);
    })
    .map((entry) => entry.relationship);
}

function collectNextLineageEdges(graph, methodNode, direction, options = {}) {
  const raw = direction === 'forward'
    ? graph.getIncoming(methodNode.id)
    : graph.getOutgoing(methodNode.id);
  return sortLineageEdges(
    graph,
    raw.filter((relationship) => isMethodEvolutionRelationship(relationship)),
    direction
  ).slice(0, Math.max(1, Number(options.branchLimit || 3)));
}

function collectRejectedEdgeDiagnostics(graph, methodNode, direction) {
  const raw = direction === 'forward'
    ? graph.getIncoming(methodNode.id)
    : graph.getOutgoing(methodNode.id);
  const rejected = raw
    .filter((relationship) => isMethodEvolutionRelationship(relationship))
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
        const nextNode = direction === 'forward'
          ? graph.getNode(relationship.sourceId)
          : graph.getNode(relationship.targetId);
        return nextNode && !visited.has(nextNode.id);
      });

    if (!nextEdges.length) {
      if (steps.some((step) => step.edgeToNext)) lineages.push(steps);
      return;
    }

    for (const relationship of nextEdges) {
      const nextNode = direction === 'forward'
        ? graph.getNode(relationship.sourceId)
        : graph.getNode(relationship.targetId);
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
