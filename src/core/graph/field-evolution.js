import { extractPublicationDateInfo } from '../paper-date.js';
import { normalizeText, STOPWORDS, unique } from '../../lib/utils.js';
import { buildMethodEvidenceRecord } from './research-intelligence.js';

const array = value => Array.isArray(value) ? value : value ? [value] : [];
const EVOLUTION_TYPES = new Set(['EXTENDS_METHOD', 'IMPROVES_METHOD', 'REPLACES_METHOD',
  'ADAPTS_METHOD', 'USES_COMPONENT_METHOD', 'VARIANT_OF', 'SPECIALIZES', 'COMPONENT_OF']);
const PAPER_LINKS = new Set(['CONTAINS', 'USES', 'PROPOSES', 'INTRODUCES', 'DESCRIBES', 'PRESENTS']);
const SEARCH_TYPES = new Set(['Method', 'Problem', 'ResearchQuestion', 'Challenge', 'Concept']);
const ordered = (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id);
const domains = node => unique([node.properties?.fieldOfStudy, ...array(node.properties?.domainTags)]
  .filter(Boolean).map(String));
const textOf = node => normalizeText([node.name, node.properties?.abstract, node.properties?.description,
  node.properties?.text, ...array(node.properties?.keywords), ...array(node.properties?.aliases),
  ...array(node.properties?.methodAliases), node.properties?.canonicalName].filter(Boolean).join(' '));

function normalizeFieldOptions(raw) {
  const integer = (key, fallback, min, max) => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') return fallback;
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const query = String(raw.query || '').trim();
  const targetDomain = String(raw.targetDomain || '').trim();
  const seedNodeIds = unique(array(raw.seedNodeIds).map(String).filter(Boolean));
  if (!query && !targetDomain && !seedNodeIds.length) throw new Error('A query, targetDomain or nonempty seedNodeIds is required.');
  if (query.length > 8000 || targetDomain.length > 8000 || seedNodeIds.length > 500) throw new Error('Field selector exceeds its supported size.');
  const fromYear = integer('fromYear', null, 1000, 9999);
  const toYear = integer('toYear', null, 1000, 9999);
  if (fromYear && toYear && fromYear > toYear) throw new Error('fromYear must not exceed toYear.');
  return { query, targetDomain, seedNodeIds, fromYear, toYear,
    maxDepth: integer('maxDepth', 2, 1, 4), maxNodes: integer('maxNodes', 180, 1, 500),
    maxEdges: integer('maxEdges', 350, 1, 1000) };
}

function fieldInventory(graph) {
  const papers = new Map(graph.nodes.filter(n => n.type === 'Paper').map(n => [n.id, n]));
  const owners = new Map();
  const addOwner = (id, paperId) => {
    if (!papers.has(paperId) || id === paperId) return;
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(paperId);
  };
  for (const node of graph.nodes) {
    const p = node.properties || {};
    for (const id of [p.paperId, p.sourcePaperId, ...array(p.paperIds), ...array(p.sourcePaperIds)]) addOwner(node.id, id);
  }
  for (const edge of graph.relationships) {
    if (!PAPER_LINKS.has(edge.type)) continue;
    if (papers.has(edge.sourceId)) addOwner(edge.targetId, edge.sourceId);
    if (papers.has(edge.targetId)) addOwner(edge.sourceId, edge.targetId);
  }
  const paperText = new Map([...papers].map(([id, node]) => [id, [textOf(node)]]));
  const paperDomains = new Map([...papers].map(([id, node]) => [id, domains(node)]));
  const methods = new Map();
  for (const node of graph.nodes) {
    const paperIds = [...(owners.get(node.id) || [])].sort();
    if (SEARCH_TYPES.has(node.type)) for (const id of paperIds) {
      paperText.get(id).push(textOf(node));
      paperDomains.get(id).push(...domains(node));
    }
    if (node.type !== 'Method') continue;
    const date = extractPublicationDateInfo(node)
      || extractPublicationDateInfo({ year: node.properties?.introducedYear })
      || (paperIds.length === 1 ? extractPublicationDateInfo(papers.get(paperIds[0])) : null);
    methods.set(node.id, { id: node.id, name: node.name, type: 'Method',
      year: date?.year || null, date: date?.normalizedDate || null, datePrecision: date?.precision || 'none',
      paperIds, domains: unique([...domains(node), ...paperIds.flatMap(id => domains(papers.get(id)))]) });
  }
  const paperSummaries = new Map([...papers].map(([id, node]) => {
    const date = extractPublicationDateInfo(node);
    const p = node.properties || {};
    return [id, { id, name: node.name, type: 'Paper', year: date?.year || null,
      date: date?.normalizedDate || null, datePrecision: date?.precision || 'none',
      domains: domains(node), identifiers: p.identifiers || {},
      doi: p.doi || p.identifiers?.doi || null, arxivId: p.arxivId || p.identifiers?.arxivId || null,
      url: p.url || p.sourceUrl || p.landingUrl || null, abstract: p.abstract || '',
      authors: array(p.authors).map(author => typeof author === 'string' ? author : author.name || '').filter(Boolean) }];
  }));
  return { papers, methods, owners, paperSummaries,
    paperText: new Map([...paperText].map(([id, texts]) => [id, texts.join(' ')])), paperDomains };
}

function evolutionRelations(graph, methods) {
  const grouped = new Map();
  const rejected = [];
  for (const edge of graph.relationships) {
    if (!EVOLUTION_TYPES.has(edge.type) && edge.properties?.methodEvolutionProjection !== true) continue;
    const record = buildMethodEvidenceRecord(graph, edge);
    if (!record.validation.accepted) {
      rejected.push({ edgeId: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, reasons: record.validation.reasons });
      continue;
    }
    const sourceId = edge.type === 'COMPONENT_OF' ? edge.sourceId : edge.targetId;
    const targetId = edge.type === 'COMPONENT_OF' ? edge.targetId : edge.sourceId;
    const sourceYear = methods.get(sourceId)?.year;
    const targetYear = methods.get(targetId)?.year;
    if (sourceYear && targetYear && sourceYear > targetYear) {
      rejected.push({ edgeId: edge.id, sourceId, targetId, reasons: ['reverse_temporal_direction'] });
      continue;
    }
    const key = record.candidateId || record.citationRelationshipId || record.edgeId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ record, sourceId, targetId });
  }
  const relations = [...grouped.values()].map(group => {
    group.sort((a, b) => Number(a.record.relationshipRole === 'method-dag') - Number(b.record.relationshipRole === 'method-dag')
      || a.record.edgeId.localeCompare(b.record.edgeId));
    const { record, sourceId, targetId } = group[0];
    return { id: record.edgeId, sourceId, targetId,
      type: record.paperEdgeType || record.methodCitationType || record.edgeType,
      graphEdgeIds: group.map(item => item.record.edgeId).sort(),
      evidence: record, basis: 'validated_source_relation' };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { relations, rejected };
}

function buildFamilies(methods, relations) {
  const byId = new Map(methods.map(n => [n.id, n]));
  const neighbors = new Map(methods.map(n => [n.id, new Set()]));
  for (const r of relations) { neighbors.get(r.sourceId).add(r.targetId); neighbors.get(r.targetId).add(r.sourceId); }
  const seen = new Set();
  const families = [];
  const unlinked = [];
  for (const node of [...methods].sort(ordered)) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const members = [node.id];
    for (let i = 0; i < members.length; i++) for (const next of neighbors.get(members[i])) {
      if (!seen.has(next)) { seen.add(next); members.push(next); }
    }
    if (members.length === 1 && !neighbors.get(node.id).size) { unlinked.push(node.id); continue; }
    const ids = new Set(members);
    const edges = relations.filter(r => ids.has(r.sourceId));
    const incoming = new Map(members.map(id => [id, new Set()]));
    const outgoing = new Map(members.map(id => [id, []]));
    for (const r of edges) { incoming.get(r.targetId).add(r.sourceId); outgoing.get(r.sourceId).push(r); }
    const indegree = new Map([...incoming].map(([id, parents]) => [id, parents.size]));
    const queue = members.filter(id => !indegree.get(id)).sort();
    const paths = new Map(members.map(id => [id, { nodeIds: [id], relationIds: [] }]));
    const better = (a, b) => a.nodeIds.length > b.nodeIds.length
      || (a.nodeIds.length === b.nodeIds.length && JSON.stringify(a.nodeIds).localeCompare(JSON.stringify(b.nodeIds)) < 0);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited++;
      const targets = new Set();
      for (const r of outgoing.get(id)) {
        const path = paths.get(id);
        const candidate = { nodeIds: [...path.nodeIds, r.targetId], relationIds: [...path.relationIds, r.id] };
        if (better(candidate, paths.get(r.targetId))) paths.set(r.targetId, candidate);
        targets.add(r.targetId);
      }
      for (const target of targets) {
        indegree.set(target, indegree.get(target) - 1);
        if (!indegree.get(target)) { queue.push(target); queue.sort(); }
      }
    }
    const hasCycle = visited !== members.length;
    const mainline = hasCycle ? { nodeIds: [], relationIds: [] }
      : [...paths.values()].reduce((best, p) => better(p, best) ? p : best, { nodeIds: [], relationIds: [] });
    members.sort((a, b) => ordered(byId.get(a), byId.get(b)));
    families.push({ id: `family:${[...members].sort()[0]}`, name: byId.get(members[0]).name,
      kind: 'connected_methods', methodIds: members, relationIds: edges.map(r => r.id),
      paperIds: unique(members.flatMap(id => byId.get(id).paperIds)).sort(), hasCycle, mainline,
      mainlineBasis: hasCycle ? 'unavailable_cycle' : 'longest_validated_path_stable_id_tiebreak',
      basis: 'connected_component_in_displayed_evidence' });
  }
  families.sort((a, b) => b.methodIds.length - a.methodIds.length || a.id.localeCompare(b.id));
  if (unlinked.length) families.push({ id: 'unlinked', name: 'Unlinked methods', kind: 'unlinked',
    methodIds: unlinked, paperIds: unique(unlinked.flatMap(id => byId.get(id).paperIds)).sort(), relationIds: [],
    hasCycle: false, mainline: { nodeIds: [], relationIds: [] }, mainlineBasis: 'no_validated_path',
    basis: 'No displayed validated relation; this is not a shared school.' });
  return families;
}

function buildTurningPoints(methods, relations) {
  const points = [];
  for (const node of methods) {
    const incoming = relations.filter(r => r.targetId === node.id);
    const outgoing = relations.filter(r => r.sourceId === node.id);
    for (const [type, edges, endpoint] of [['branch', outgoing, 'targetId'], ['convergence', incoming, 'sourceId']]) {
      const count = new Set(edges.map(r => r[endpoint])).size;
      if (count >= 2) points.push({ id: `${type}:${node.id}`, type, methodId: node.id, name: node.name,
        year: node.year, relationIds: edges.map(r => r.id),
        basis: `${count} distinct ${type === 'branch' ? 'successors' : 'predecessors'} in the displayed validated graph.`,
        status: 'structural_candidate' });
    }
  }
  for (const r of relations) if (['REPLACES_METHOD', 'ADAPTS_METHOD'].includes(r.type)) {
    const node = methods.find(n => n.id === r.targetId);
    points.push({ id: `${r.type}:${r.id}`, type: r.type === 'REPLACES_METHOD' ? 'replacement' : 'adaptation',
      methodId: node.id, name: node.name, year: node.year, relationIds: [r.id],
      basis: `The source reports ${r.type.toLowerCase().replaceAll('_', ' ')}.`, status: 'source_reported_candidate' });
  }
  return points.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id));
}

function projectPaperRelations(relations, methods, papers, maxEdges) {
  const methodMap = new Map(methods.map(n => [n.id, n]));
  const paperIds = new Set(papers.map(p => p.id));
  const grouped = new Map();
  const omitted = [];
  for (const r of relations) {
    const record = r.evidence;
    const explicitSource = record.targetPaper.paperId;
    const explicitTarget = record.sourcePaper.paperId;
    // Source/target paper fields retain citing/cited roles, including COMPONENT_OF projections.
    const uniqueOwner = id => methodMap.get(id)?.paperIds.length === 1 ? methodMap.get(id).paperIds[0] : null;
    const sourceId = explicitSource || uniqueOwner(r.sourceId);
    const targetId = explicitTarget || uniqueOwner(r.targetId);
    if (!sourceId || !targetId) { omitted.push({ relationId: r.id, reason: 'ambiguous_or_missing_paper_owner' }); continue; }
    if (sourceId === targetId) { omitted.push({ relationId: r.id, reason: 'within_paper' }); continue; }
    if (!paperIds.has(sourceId) || !paperIds.has(targetId)) { omitted.push({ relationId: r.id, reason: 'paper_outside_display' }); continue; }
    const id = `paper-relation:${JSON.stringify([sourceId, targetId, r.type])}`;
    if (!grouped.has(id)) grouped.set(id, { id, sourceId, targetId, type: r.type,
      methodRelationIds: [], basis: 'method_evolution_projection' });
    grouped.get(id).methodRelationIds.push(r.id);
  }
  const all = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { paperRelations: all.slice(0, maxEdges), availableCount: all.length, omitted };
}

export function buildFieldEvolution(graph, rawOptions = {}) {
  const options = normalizeFieldOptions(rawOptions);
  const inventory = fieldInventory(graph);
  const { methods, papers, owners, paperSummaries } = inventory;
  const inYears = node => !node.year || ((!options.fromYear || node.year >= options.fromYear)
    && (!options.toYear || node.year <= options.toYear));
  const terms = normalizeText(options.query).split(/[\s-]+/).filter(term => term && !STOPWORDS.has(term));
  const matchesText = text => {
    if (!options.query) return true;
    const words = new Set(text.split(/[\s-]+/));
    return terms.length ? terms.every(term => /\p{Script=Han}/u.test(term) ? text.includes(term) : words.has(term))
      : text.includes(normalizeText(options.query));
  };
  const matchesDomain = values => !options.targetDomain || values.some(value => value.toLowerCase() === options.targetDomain.toLowerCase());
  const corePapers = new Set();
  const coreMethods = new Set();
  const missingSeeds = [];
  if (options.seedNodeIds.length) {
    for (const id of options.seedNodeIds) {
      if (!graph.getNode(id)) { missingSeeds.push(id); continue; }
      if (papers.has(id) && inYears(paperSummaries.get(id))) corePapers.add(id);
      if (methods.has(id) && inYears(methods.get(id))) coreMethods.add(id);
      for (const paperId of owners.get(id) || []) if (inYears(paperSummaries.get(paperId))) corePapers.add(paperId);
    }
  } else {
    for (const [id, paper] of paperSummaries) if (inYears(paper)
      && (options.query === id || matchesText(inventory.paperText.get(id)))
      && matchesDomain(inventory.paperDomains.get(id))) corePapers.add(id);
    for (const [id, method] of methods) if (inYears(method)
      && (options.query === id || matchesText(textOf(graph.getNode(id)))) && matchesDomain(method.domains)) coreMethods.add(id);
  }
  for (const [id, method] of methods) if (inYears(method) && method.paperIds.some(p => corePapers.has(p))) coreMethods.add(id);
  const { relations: allRelations, rejected } = evolutionRelations(graph, methods);
  const adjacency = new Map();
  for (const r of allRelations) for (const [a, b] of [[r.sourceId, r.targetId], [r.targetId, r.sourceId]]) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  }
  const depths = new Map([...coreMethods].map(id => [id, 0]));
  const queue = [...coreMethods].sort();
  let depthLimited = false;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of [...(adjacency.get(id) || [])].sort()) {
      if (depths.has(next) || !methods.has(next) || !inYears(methods.get(next))) continue;
      if (depths.get(id) >= options.maxDepth) { depthLimited = true; continue; }
      depths.set(next, depths.get(id) + 1); queue.push(next);
    }
  }
  const candidateMethods = queue.map(id => ({ ...methods.get(id), scopeRole: coreMethods.has(id) ? 'core' : 'boundary', depth: depths.get(id) }))
    .sort((a, b) => a.depth - b.depth || ordered(a, b));
  const selectedMethods = candidateMethods.slice(0, options.maxNodes);
  const selectedIds = new Set(selectedMethods.map(n => n.id));
  const availableRelations = allRelations.filter(r => selectedIds.has(r.sourceId) && selectedIds.has(r.targetId));
  const relations = availableRelations.slice(0, options.maxEdges);
  const associatedPapers = new Set([...corePapers, ...selectedMethods.flatMap(n => n.paperIds),
    ...relations.flatMap(r => [r.evidence.sourcePaper.paperId, r.evidence.targetPaper.paperId])]);
  const candidatePapers = [...associatedPapers].map(id => paperSummaries.get(id)).filter(n => n && inYears(n))
    .map(p => ({ ...p, scopeRole: corePapers.has(p.id) ? 'core' : 'boundary' }))
    .sort((a, b) => Number(b.scopeRole === 'core') - Number(a.scopeRole === 'core') || ordered(a, b));
  const selectedPapers = candidatePapers.slice(0, options.maxNodes);
  const families = buildFamilies(selectedMethods, relations);
  for (const n of selectedMethods) n.familyIds = families.filter(f => f.methodIds.includes(n.id)).map(f => f.id);
  for (const p of selectedPapers) {
    p.methodIds = selectedMethods.filter(n => n.paperIds.includes(p.id)).map(n => n.id);
    p.familyIds = families.filter(f => f.paperIds.includes(p.id)).map(f => f.id);
  }
  const projected = projectPaperRelations(relations, selectedMethods, selectedPapers, options.maxEdges);
  const truncationReasons = [];
  if (depthLimited) truncationReasons.push('maxDepth');
  if (candidateMethods.length > selectedMethods.length) truncationReasons.push('methodNodeBudget');
  if (candidatePapers.length > selectedPapers.length) truncationReasons.push('paperNodeBudget');
  if (availableRelations.length > relations.length) truncationReasons.push('methodEdgeBudget');
  if (projected.availableCount > projected.paperRelations.length) truncationReasons.push('paperEdgeBudget');
  const years = unique([...selectedMethods, ...selectedPapers].map(n => n.year)).sort((a, b) => (a ?? 9999) - (b ?? 9999));
  const scopedRejected = rejected.filter(r => depths.has(r.sourceId) || depths.has(r.targetId));
  return {
    contractVersion: 'papernexus-field-evolution-v1',
    status: !selectedMethods.length && !selectedPapers.length ? 'no_matches' : truncationReasons.length ? 'partial' : 'ok',
    scope: { ...options, selection: options.seedNodeIds.length ? 'explicit_seeds' : 'all_query_terms_and_domain',
      missingSeeds, truncated: truncationReasons.length > 0, truncationReasons,
      counts: { corpusPapers: papers.size, corpusMethods: methods.size, matchedPapers: corePapers.size,
        matchedMethods: coreMethods.size, availableMethods: candidateMethods.length, returnedMethods: selectedMethods.length,
        availablePapers: candidatePapers.length, returnedPapers: selectedPapers.length,
        availableRelations: availableRelations.length, returnedRelations: relations.length,
        availablePaperRelations: projected.availableCount, returnedPaperRelations: projected.paperRelations.length },
      boundary: 'A bounded view of this corpus, not a complete field history. Families and mainlines describe graph structure, not academic influence or causal proof.' },
    methods: selectedMethods, papers: selectedPapers, relations, paperRelations: projected.paperRelations,
    families, turningPoints: buildTurningPoints(selectedMethods, relations),
    periods: years.map(year => ({ year, label: year ? String(year) : 'Undated',
      methodIds: selectedMethods.filter(n => n.year === year).map(n => n.id),
      paperIds: selectedPapers.filter(n => n.year === year).map(n => n.id), basis: 'publication_year_observations' })),
    diagnostics: { source: 'committed_graph', graphMutated: false, queryTimeLlmCalls: 0,
      rejectedRelations: scopedRejected, paperProjectionOmissions: projected.omitted,
      undatedMethods: selectedMethods.filter(n => !n.year).length, undatedPapers: selectedPapers.filter(p => !p.year).length,
      cyclicFamilyIds: families.filter(f => f.hasCycle).map(f => f.id),
      isolatedPapers: selectedPapers.filter(p => !p.methodIds.length).map(p => p.id),
      deduplicatedEdges: relations.reduce((sum, r) => sum + r.graphEdgeIds.length - 1, 0) }
  };
}
