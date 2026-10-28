import { isDeepStrictEqual } from 'node:util';
import { readJson, writeJson, withFileLock } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import { getCorpusLockPath, loadCorpus, loadSourceManifest, saveCorpus } from '../../storage/corpus-store.js';
import { lineagePublicationPath, checkLineageBindings, projectLineagePublications } from '../../storage/lineage-publications.js';
import { applyGraphMutations } from '../graph/mutations.js';
import { loadKnowledgeGraph } from '../graph/graph.js';
import { summarizeCorpusGraph } from '../graph/summary.js';
import { resolveCorpusForApi } from '../../server/api.js';
import { readLineageRefinement } from './lineage-refinement.js';
import { lineageText } from './lineage-review.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const key = value => lineageText(value).toLowerCase();

function publicationMethod(graph, paperId, name, quote, publicationId) {
  const paper = graph.getNode(paperId);
  if (!paper || paper.type !== 'Paper') throw fail('Publication paper is absent.');
  const paperLinks = new Set(['CONTAINS', 'USES', 'PROPOSES', 'INTRODUCES', 'DESCRIBES', 'PRESENTS']);
  const linkedMethods = new Set([...graph.getOutgoing(paperId), ...graph.getIncoming(paperId)]
    .filter(edge => paperLinks.has(edge.type)).map(edge => edge.sourceId === paperId ? edge.targetId : edge.sourceId));
  const matches = graph.nodes.filter(node => node.type === 'Method'
    && [node.name, ...(node.properties?.aliases || [])].some(alias => key(alias) === key(name))
    && (node.properties?.sourcePaperId === paperId || node.properties?.paperId === paperId
      || [node.properties?.paperIds, node.properties?.sourcePaperIds].some(ids => Array.isArray(ids) && ids.includes(paperId))
      || linkedMethods.has(node.id)));
  if (matches.length > 1) throw fail(`Ambiguous method identity: ${name}.`);
  if (matches.length === 1) return { before: structuredClone(matches[0]), node: structuredClone(matches[0]) };
  const id = 'method:lineage:' + stableHash(`${paperId}:${key(name)}`, 20);
  if (graph.getNode(id)) throw fail(`Method identity conflicts with ${id}.`);
  return { before: null, node: { id, type: 'Method', name, properties: { sourcePaperId: paperId, paperId,
    sourcePaperTitle: paper.name, year: paper.properties?.year || null, exactQuote: quote,
    lineageManaged: true, lineagePublicationId: publicationId, provenance: 'model_reviewed_source', manual: false } } };
}

export async function buildLineagePublication(rootPath, run, graph, publicationId) {
  const sources = (await loadSourceManifest(rootPath))?.sources || [], cache = new Map();
  const items = [], excluded = [], duplicates = [];
  let working = loadKnowledgeGraph(graph.toJSON());
  for (const entry of run.entries) {
    if (entry.status !== 'reviewed' || !entry.review) { excluded.push({ paperId: entry.selection.paperId, reason: entry.error || 'not_reviewed' }); continue; }
    for (const relation of entry.review.relations) {
      const base = { paperId: entry.selection.paperId, candidateIndex: relation.candidateIndex };
      if (!relation.publishable) { excluded.push({ ...base, reason: relation.reason, blockers: relation.blockers }); continue; }
      const parentId = relation.parentIdentity.paperId;
      const bindings = entry.review.bindings.filter(binding => [entry.selection.paperId, parentId].includes(binding.paperId));
      const issues = await checkLineageBindings(rootPath, bindings, working, sources, cache);
      if (issues.length) { excluded.push({ ...base, reason: 'source_requires_review', issues }); continue; }
      try {
        const child = publicationMethod(working, entry.selection.paperId, relation.candidate.childMethod, relation.exactQuote, publicationId);
        const parent = publicationMethod(working, parentId, relation.candidate.parentMethod, relation.parentMethodQuote, publicationId);
        const reverse = relation.candidate.relationType === 'COMPONENT_OF';
        const sourceId = reverse ? parent.node.id : child.node.id, targetId = reverse ? child.node.id : parent.node.id;
        const type = relation.candidate.relationType;
        const matches = working.relationships.filter(edge => edge.sourceId === sourceId && edge.targetId === targetId && edge.type === type);
        if (matches.length > 1) throw fail('Multiple relationships share these endpoints.');
        const existing = matches[0] || null;
        if (existing?.properties?.lineagePublicationId) {
          if (isDeepStrictEqual(existing.properties.lineageSourceBindings, bindings)
            && existing.properties.exactQuote === relation.exactQuote) { duplicates.push({ ...base, edgeId: existing.id }); continue; }
          throw fail('An existing publication for this relationship requires review or revocation.');
        }
        if (existing && (existing.properties?.sourcePaperId !== entry.selection.paperId
          || existing.properties?.targetPaperId !== parentId || existing.properties?.sourceKey !== bindings.find(binding => binding.paperId === entry.selection.paperId)?.sourceKey)) {
          throw fail('Existing relationship has different or missing source provenance.');
        }
        const childYear = Number(child.node.properties?.year), parentYear = Number(parent.node.properties?.year);
        if (childYear && parentYear && childYear < parentYear) throw fail('Predecessor publication date follows the child method.');
        const edgeId = existing?.id || 'rel:lineage:' + stableHash(`${sourceId}:${type}:${targetId}`, 20);
        const properties = { ...(existing?.properties || {}), sourcePaperId: entry.selection.paperId, targetPaperId: parentId,
          sourcePaperTitle: working.getNode(entry.selection.paperId).name, targetPaperTitle: working.getNode(parentId).name,
          sourceKey: bindings.find(binding => binding.paperId === entry.selection.paperId)?.sourceKey,
          exactQuote: relation.exactQuote, exactMatch: true, sectionHeading: relation.candidate.section || '',
          referenceId: relation.candidate.referenceId, validationStatus: 'accepted', provenance: 'model_reviewed_source',
          reviewStatus: 'model_reviewed', scientificValidation: false, lineagePublicationId: publicationId,
          lineageReviewId: entry.review.reviewId, lineageSourceBindings: bindings,
          attribution: relation.attribution, epistemicStatus: relation.epistemicStatus, relationContext: relation.context,
          bottleneck: relation.bottleneck, mechanism: relation.mechanismEvidence, tradeoff: relation.tradeoff,
          evidenceCompletenessStatus: relation.explanationIssues.length ? 'incomplete' : 'complete',
          evidenceMissingFields: relation.explanationIssues, manual: false };
        const operations = [child, parent].filter(endpoint => !endpoint.before).map(endpoint => ({ action: 'upsert_node', node: endpoint.node }));
        operations.push({ action: 'upsert_relationship', relationship: { id: edgeId, sourceId, targetId, type, properties } });
        const mutation = applyGraphMutations(working, operations, { actor: 'lineage-review' });
        const next = mutation.graph;
        // Graph mutation audit describes the service action; evidence ownership remains model review.
        for (const endpoint of [child, parent]) if (!endpoint.before) {
          const node = next.getNode(endpoint.node.id);
          next.updateNode({ ...node, properties: { ...node.properties, manual: false, editSource: 'lineage-review' } });
        }
        const edge = next.getRelationship(edgeId);
        next.updateRelationship({ ...edge, properties: { ...edge.properties, manual: false, editSource: 'lineage-review' } });
        const effects = [child, parent].map(endpoint => ({ entity: 'node', before: endpoint.before, after: structuredClone(next.getNode(endpoint.node.id)) }));
        effects.push({ entity: 'relationship', before: existing && structuredClone(existing), after: structuredClone(next.getRelationship(edgeId)) });
        items.push({ ...base, reviewId: entry.review.reviewId, bindings, effects, edgeId }); working = next;
      } catch (error) { excluded.push({ ...base, reason: error.message }); }
    }
  }
  return { items, excluded, duplicates, graph: working };
}

export async function executeLineagePublication(candidate, args = {}, options = {}) {
  if (Object.keys(args).some(key => !['runId', 'requestId', 'apply', 'revoke'].includes(key))) throw fail('Unexpected lineage publication argument.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(args.requestId || '')) throw fail('A stable publication requestId is required.');
  for (const name of ['apply', 'revoke']) if (args[name] !== undefined && typeof args[name] !== 'boolean') throw fail(`${name} must be boolean.`);
  const rootPath = await resolveCorpusForApi(candidate, options);
  const run = await readLineageRefinement(rootPath, args.runId);
  if (!run.terminal) throw fail('Publication requires a terminal refinement run.', 409);
  const publicationId = 'publication-' + args.requestId;
  const execute = async () => {
    const ledger = await readJson(lineagePublicationPath(rootPath), { records: [] });
    const previous = ledger.records.find(record => record.publicationId === publicationId);
    if (previous && previous.runId !== args.runId) throw fail('requestId already belongs to another run.', 409);
    if (args.revoke && !previous) throw fail('Publication not found.', 404);
    const loaded = await loadCorpus(rootPath);
    if (previous) {
      if (!args.revoke && previous.status === 'revoked') return { publicationId, runId: args.runId, status: 'revoked', replayed: true, applied: false };
      const proposed = structuredClone(ledger);
      const record = proposed.records.find(record => record.publicationId === publicationId);
      if (args.revoke) record.status = 'revoked';
      const projection = await projectLineagePublications(rootPath, loadKnowledgeGraph(loaded.graph.toJSON()), proposed);
      if (args.apply) {
        await writeJson(lineagePublicationPath(rootPath), proposed);
        await saveCorpus(rootPath, projection.graph, { ...loaded.meta, ...summarizeCorpusGraph(projection.graph), lastMutationAt: new Date().toISOString() }, { liteViewMode: 'rebuild' });
        record.status = args.revoke ? 'revoked' : 'published'; await writeJson(lineagePublicationPath(rootPath), proposed);
      }
      return { publicationId, runId: args.runId, status: args.apply ? record.status : 'preview', revoke: args.revoke === true,
        applied: args.apply === true, replayed: true, items: record.items.map(item => ({ paperId: item.paperId, candidateIndex: item.candidateIndex, edgeId: item.edgeId })),
        ...(args.apply ? { readback: record.items.map(item => ({ edgeId: item.edgeId,
          relationship: projection.graph.getRelationship(item.edgeId) || null })) } : {}),
        projection: projection.publications.filter(item => item.publicationId === publicationId), excluded: record.excluded, duplicates: record.duplicates };
    }
    const prepared = await buildLineagePublication(rootPath, run, loaded.graph, publicationId);
    if (args.apply) {
      const record = { publicationId, runId: args.runId, status: 'pending', createdAt: new Date().toISOString(),
        items: prepared.items, excluded: prepared.excluded, duplicates: prepared.duplicates };
      ledger.records.push(record); await writeJson(lineagePublicationPath(rootPath), ledger);
      await saveCorpus(rootPath, prepared.graph, { ...loaded.meta, ...summarizeCorpusGraph(prepared.graph), lastMutationAt: new Date().toISOString() }, { liteViewMode: 'rebuild' });
      record.status = 'published'; await writeJson(lineagePublicationPath(rootPath), ledger);
    }
    const current = args.apply ? await loadCorpus(rootPath) : null;
    return { publicationId, runId: args.runId, status: args.apply ? 'published' : 'preview', applied: args.apply === true,
      items: prepared.items.map(item => ({ paperId: item.paperId, candidateIndex: item.candidateIndex, edgeId: item.edgeId })),
      excluded: prepared.excluded, duplicates: prepared.duplicates, sourceRunStatus: run.status,
      ...(current ? { projection: current.publications.filter(item => item.publicationId === publicationId),
        readback: prepared.items.map(item => ({ edgeId: item.edgeId, relationship: current.graph.getRelationship(item.edgeId) || null })) } : {}),
      scientificValidation: false, counts: { publishedOrPlanned: prepared.items.length, excluded: prepared.excluded.length, duplicates: prepared.duplicates.length } };
  };
  return args.apply ? withFileLock(getCorpusLockPath(rootPath), execute) : execute();
}
