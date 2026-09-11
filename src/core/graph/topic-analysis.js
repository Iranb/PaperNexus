import { loadKnowledgeGraph } from './graph.js';
import { searchGraph } from '../search/search.js';
import { extractPublicationDateInfo } from '../paper-date.js';
import { buildMethodEvolutionGapAnalysis } from './research-intelligence.js';
import { adaptationTerms, rankMethodAdaptations, classifyGapObservation } from './method-adaptation.js';
import { unique } from '../../lib/utils.js';

const PROBLEM_TYPES = new Set(['Problem', 'ResearchQuestion', 'Challenge']);
const GAP_TYPES = new Set(['Limitation', 'Assumption', 'Challenge', 'FutureDirection', 'Claim', 'Finding']);
const bound = (value, fallback, max, min = 1) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : fallback;
};
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];

function analysisNodeDomains(graph, node) {
  const papers = unique([...list(node.properties?.paperId), ...list(node.properties?.paperIds)])
    .map((id) => graph.getNode(id)).filter(Boolean);
  return unique([node, ...papers].flatMap((entry) =>
    [entry.properties?.fieldOfStudy, ...list(entry.properties?.domainTags)]).filter(Boolean).map(String));
}

export function normalizeAnalysisOptions(options = {}) {
  const fromYear = bound(options.fromYear, null, 3000, 1000);
  const toYear = bound(options.toYear, null, 3000, 1000);
  if (fromYear && toYear && fromYear > toYear) throw new Error('fromYear must not exceed toYear.');
  return {
    query: String(options.query || '').trim().slice(0, 2000),
    targetDomain: String(options.targetDomain || '').trim().slice(0, 300),
    constraints: options.constraints || {},
    seedNodeIds: unique(list(options.seedNodeIds).map(String)).slice(0, 200),
    maxDepth: bound(options.maxDepth, 2, 4, 0),
    maxNodes: bound(options.maxNodes, 180, 500),
    maxEdges: bound(options.maxEdges, 350, 1000),
    fromYear, toYear
  };
}

export function buildAnalysisSubgraph(graph, rawOptions = {}) {
  const options = normalizeAnalysisOptions(rawOptions);
  const groups = options.query ? searchGraph(graph, options.query, { limit: 50 }).groups : [];
  let requestedSeeds = options.seedNodeIds.length ? options.seedNodeIds
    : options.query ? unique(groups.flatMap((group) => group.matches.map((match) => match.nodeId)))
      : graph.nodes.filter((node) => node.type !== 'Corpus').slice()
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 30).map((node) => node.id);
  if (options.query && options.targetDomain && !options.seedNodeIds.length) {
    requestedSeeds = requestedSeeds.filter((id) => {
      const domains = analysisNodeDomains(graph, graph.getNode(id));
      return !domains.length || domains.some((domain) => domain.toLowerCase() === options.targetDomain.toLowerCase());
    });
  }
  const included = new Set();
  const queue = [];
  const reasons = new Set();
  const missingSeeds = requestedSeeds.filter((id) => !graph.getNode(id));
  const eligible = (node) => {
    if (!node || node.type === 'Corpus') return false;
    const paper = graph.getNode(node.properties?.paperId);
    const date = extractPublicationDateInfo(node) || (paper && extractPublicationDateInfo(paper));
    return !date || ((!options.fromYear || date.year >= options.fromYear)
      && (!options.toYear || date.year <= options.toYear));
  };
  const add = (id, depth) => {
    if (included.has(id) || !eligible(graph.getNode(id))) return;
    if (included.size >= options.maxNodes) { reasons.add('maxNodes'); return; }
    included.add(id);
    queue.push({ id, depth });
  };
  for (const id of requestedSeeds) add(id, 0);
  for (let index = 0; index < queue.length; index++) {
    const { id, depth } = queue[index];
    const sourceNode = graph.getNode(id);
    for (const paperId of unique([...list(sourceNode.properties?.paperId), ...list(sourceNode.properties?.paperIds)])) {
      if (included.has(paperId) || !eligible(graph.getNode(paperId))) continue;
      if (depth >= options.maxDepth) reasons.add('maxDepth');
      else add(paperId, depth + 1);
    }
    const adjacent = [...graph.getOutgoing(id), ...graph.getIncoming(id)]
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of adjacent) {
      const nextId = edge.sourceId === id ? edge.targetId : edge.sourceId;
      if (!eligible(graph.getNode(nextId)) || included.has(nextId)) continue;
      if (depth >= options.maxDepth) reasons.add('maxDepth');
      else add(nextId, depth + 1);
    }
  }
  const nodes = queue.map(({ id }) => graph.getNode(id));
  const allEdges = graph.relationships.filter((edge) => included.has(edge.sourceId) && included.has(edge.targetId))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (allEdges.length > options.maxEdges) reasons.add('maxEdges');
  if (groups.length === 50) reasons.add('searchResultLimit');
  return {
    graph: { nodes, relationships: allEdges.slice(0, options.maxEdges) },
    query: options.query, groups,
    scope: {
      mode: options.query ? 'topic' : options.seedNodeIds.length ? 'seeds' : 'overview',
      budgets: { maxNodes: options.maxNodes, maxEdges: options.maxEdges, maxDepth: options.maxDepth },
      seedNodeIds: requestedSeeds.filter((id) => included.has(id)), missingSeeds,
      targetDomain: options.targetDomain || null,
      unknownDomainSeeds: requestedSeeds.filter((id) => graph.getNode(id) && !analysisNodeDomains(graph, graph.getNode(id)).length),
      neighborhoodLayers: [...new Set(queue.map((entry) => entry.depth))].map((depth) => ({
        depth, nodeIds: queue.filter((entry) => entry.depth === depth).map((entry) => entry.id)
      })),
      truncated: reasons.size > 0, truncationReasons: [...reasons].sort(),
      corpusNodeCount: graph.nodeCount, corpusRelationshipCount: graph.relationshipCount,
      timeWindow: { fromYear: options.fromYear, toYear: options.toYear, undated: 'included_and_marked' },
      boundary: 'A bounded projection of committed corpus data; missing links do not establish a global research gap.'
    }
  };
}

function analysisEvidence(graph, node) {
  const refs = [];
  const props = node.properties || {};
  const paperIds = unique([...(node.type === 'Paper' ? [node.id] : []),
    ...list(props.paperId), ...list(props.paperIds)]);
  const quote = props.evidenceText || props.quote || props.text || '';
  if (paperIds.length || quote || props.sourceSpanId) refs.push({
    nodeId: node.id, paperIds, quote: String(quote).slice(0, 2400),
    sourceSpanId: props.sourceSpanId || null, sourceKey: props.sourceKey || null,
    status: quote ? 'source_text' : 'graph_reference'
  });
  for (const edge of [...graph.getOutgoing(node.id), ...graph.getIncoming(node.id)]) {
    const edgeQuote = edge.properties?.exactQuote || edge.properties?.quote || edge.properties?.evidenceText || edge.properties?.evidenceQuote;
    if (edgeQuote) refs.push({ nodeId: node.id, edgeId: edge.id, quote: String(edgeQuote).slice(0, 2400),
      paperIds: list(edge.properties?.paperId), sourceSpanId: edge.properties?.sourceSpanId || null,
      status: 'source_text' });
  }
  return refs.slice(0, 10);
}

function analysisNeighbors(graph, id) {
  return unique([...graph.getOutgoing(id).map((edge) => edge.targetId),
    ...graph.getIncoming(id).map((edge) => edge.sourceId)]).map((nextId) => graph.getNode(nextId)).filter(Boolean);
}

export function buildProblemEvolution(graph, options = {}) {
  const problems = graph.nodes.filter((node) => PROBLEM_TYPES.has(node.type));
  const observations = [];
  for (const node of problems) {
    const neighbors = analysisNeighbors(graph, node.id);
    const sourceIds = unique([...list(node.properties?.paperId), ...list(node.properties?.paperIds),
      ...neighbors.filter((next) => next.type === 'Paper').map((next) => next.id),
      ...[...graph.getOutgoing(node.id), ...graph.getIncoming(node.id)]
        .flatMap((edge) => list(edge.properties?.paperId))]);
    const papers = sourceIds.map((id) => graph.getNode(id)).filter((paper) => paper?.type === 'Paper');
    for (const paper of papers.length ? papers : [null]) {
      const date = extractPublicationDateInfo(paper || node);
      if (date && ((options.fromYear && date.year < options.fromYear) || (options.toYear && date.year > options.toYear))) continue;
      observations.push({
        nodeId: node.id, problem: node.name, paperId: paper?.id || null, paperTitle: paper?.name || null,
        date: date?.normalizedDate || null, datePrecision: date?.precision || 'none',
        kind: 'paper_reported_observation',
        methods: neighbors.filter((next) => next.type === 'Method').map((next) => ({ nodeId: next.id, name: next.name })),
        constraints: neighbors.filter((next) => ['Assumption', 'Limitation', 'Challenge'].includes(next.type))
          .map((next) => ({ nodeId: next.id, name: next.name })),
        evidence: analysisEvidence(graph, node)
      });
    }
  }
  observations.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')
    || a.nodeId.localeCompare(b.nodeId) || String(a.paperId).localeCompare(String(b.paperId)));
  const explicitRelations = graph.relationships.filter((edge) => PROBLEM_TYPES.has(graph.getNode(edge.sourceId)?.type)
    && PROBLEM_TYPES.has(graph.getNode(edge.targetId)?.type)
    && (edge.properties?.quote || edge.properties?.evidenceText)).map((edge) => ({
    edgeId: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type,
    quote: edge.properties.quote || edge.properties.evidenceText, status: 'source_reported_relation'
  }));
  return {
    observations, explicitRelations,
    diagnostics: { undated: observations.filter((entry) => !entry.date).length,
      missingSourcePaper: observations.filter((entry) => !entry.paperId).length },
    boundary: 'Dates order source observations only. Chronology does not imply causality, novelty, or that a problem was solved.'
  };
}

export function buildTopicAnalysis(graph, rawOptions = {}) {
  const options = normalizeAnalysisOptions(rawOptions);
  const subgraph = buildAnalysisSubgraph(graph, options);
  const local = loadKnowledgeGraph(subgraph.graph);
  const objects = local.nodes.filter((node) => PROBLEM_TYPES.has(node.type)
    || ['Method', 'AbstractMechanism'].includes(node.type)).map((node) => ({
      nodeId: node.id, type: node.type, name: node.name, domains: analysisNodeDomains(local, node),
      evidence: analysisEvidence(local, node)
  }));
  const profiles = local.nodes.filter((node) => node.type === 'Method').map((node) => {
    const neighbors = analysisNeighbors(local, node.id);
    return {
      id: node.id, name: node.name, domain: node.properties?.fieldOfStudy,
      problems: [...list(node.properties?.problems), ...neighbors.filter((next) => PROBLEM_TYPES.has(next.type)).map((next) => next.name)],
      mechanisms: [...list(node.properties?.abstractMechanisms), ...neighbors.filter((next) => next.type === 'AbstractMechanism').map((next) => next.name)],
      assumptions: [...list(node.properties?.assumptions), ...neighbors.filter((next) => ['Assumption', 'Limitation'].includes(next.type)).map((next) => next.name)],
      requirements: node.properties?.requirements || {},
      evidence: analysisEvidence(local, node)
    };
  });
  const problems = objects.filter((node) => PROBLEM_TYPES.has(node.type)
    && (!options.targetDomain || !node.domains.length
      || node.domains.some((domain) => domain.toLowerCase() === options.targetDomain.toLowerCase())));
  const adaptations = (problems.length ? problems : options.query ? [{ nodeId: 'query', name: options.query }] : [])
    .slice(0, 20).map((problem) => ({
      problemId: problem.nodeId, problem: problem.name,
      ...rankMethodAdaptations({ id: problem.nodeId, statement: problem.name,
        mechanisms: [...list(local.getNode(problem.nodeId)?.properties?.abstractMechanisms),
          ...analysisNeighbors(local, problem.nodeId).filter((node) => node.type === 'AbstractMechanism').map((node) => node.name)] },
      profiles, options)
    }));
  const gaps = local.nodes.filter((node) => GAP_TYPES.has(node.type)).map((node) => {
    const evidence = analysisEvidence(local, node);
    return { nodeId: node.id, statement: node.name, sourceType: node.type, evidence,
      ...classifyGapObservation({ type: node.type, statement: node.name, evidence }) };
  });
  if (subgraph.scope.truncated) gaps.push({ nodeId: null, statement: 'Analysis budget limited coverage.', evidence: [],
    ...classifyGapObservation({ truncated: true }) });
  if (!local.nodeCount) gaps.push({ nodeId: null, statement: 'No matching committed corpus evidence.', evidence: [],
    ...classifyGapObservation({}) });
  if (local.nodeCount && !problems.length) gaps.push({ nodeId: null,
    statement: 'No explicit problem object in this projection.', evidence: [],
    ...classifyGapObservation({ statement: 'Missing extracted problem' }) });
  const methodEvolution = profiles.slice(0, 8).map((profile) => buildMethodEvolutionGapAnalysis(local,
    { method: profile.id, direction: 'both', maxDepth: Math.max(1, options.maxDepth), limit: 3, branchLimit: 2 }));
  const seenLineageGaps = new Set();
  for (const lineage of methodEvolution) {
    for (const candidate of lineage.nextGapCandidates || []) {
      const key = [candidate.gap, ...candidate.groundingEdges].join('|');
      if (seenLineageGaps.has(key)) continue;
      seenLineageGaps.add(key);
      gaps.push({
        nodeId: lineage.matchedMethod?.methodId || null, statement: candidate.gap,
        sourceType: 'MethodLineage', category: 'research_opportunity', status: 'source_reported_candidate',
        evidence: candidate.groundingEdges.map((id) => {
          const edge = local.getRelationship(id);
          return { edgeId: id, nodeId: edge?.sourceId, paperIds: list(edge?.properties?.paperId),
            quote: edge?.properties?.exactQuote || edge?.properties?.quote || edge?.properties?.evidenceText || '' };
        }),
        verification: candidate.boundary
      });
    }
  }
  for (const problem of problems) {
    const linkedMethods = analysisNeighbors(local, problem.nodeId).filter((node) => node.type === 'Method');
    if (!linkedMethods.length) gaps.push({
      nodeId: problem.nodeId, statement: 'No method link in this projection for: ' + problem.name, evidence: problem.evidence,
      ...classifyGapObservation({ statement: problem.name, truncated: subgraph.scope.truncated })
    });
  }
  return {
    contractVersion: 'papernexus-topic-analysis-v1',
    status: !options.query && !options.seedNodeIds.length ? 'overview'
      : !local.nodeCount ? 'no_matches' : subgraph.scope.truncated ? 'partial' : 'ok',
    ...subgraph, targetDomain: options.targetDomain, constraints: options.constraints,
    keywords: adaptationTerms(options.query),
    objectKeywords: {
      problems: adaptationTerms(objects.filter((node) => PROBLEM_TYPES.has(node.type)).map((node) => node.name).join(' ')).slice(0, 40),
      methods: adaptationTerms(profiles.map((profile) => [profile.name, ...profile.mechanisms].join(' ')).join(' ')).slice(0, 40)
    },
    objects, adaptations, gaps,
    problemEvolution: buildProblemEvolution(local, options), methodEvolution,
    nextActions: local.nodeCount
      ? ['Inspect source passages and missing conditions before testing transfers.', 'Expand topic terms or the traversal budget for coverage.']
      : ['Use literature_discovery for external search, then import and sync papers before repeating graph lookup.'],
    diagnostics: { source: 'committed-graph', queryTimeLlmCalls: 0, graphMutated: false,
      methodEvolutionScope: 'validated edges within the returned projection' }
  };
}
