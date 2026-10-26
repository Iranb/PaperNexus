import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson, withFileLock } from '../../lib/fs.js';
import { getCorpusPaths, loadCorpusLite } from '../../storage/corpus-store.js';
import { resolveCorpusForApi } from '../../server/api.js';
import { loadKnowledgeGraph } from '../graph/graph.js';
import { buildResearchQualityView } from '../graph/research-quality.js';
import { buildFieldEvolution } from '../graph/field-evolution.js';

export const FIELD_STUDY_VERSION = 'papernexus-field-study-v1';
const text = (maxLength = 8000) => ({ type: 'string', minLength: 1, maxLength });
const list = (items, maxItems = 500) => ({ type: 'array', items, maxItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { ...text(100), pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const nodeIds = list(text(1000));
const branchIds = list(id, 40);
const notes = list(text(), 200);
const year = { type: 'integer', minimum: 1000, maximum: 9999 };

export const FIELD_STUDY_SCHEMA = object({
  title: text(300), query: text(), scope: text(20000), fromYear: year, toYear: year,
  branches: list(object({ id, label: text(300), description: text(),
    reviewStatus: { type: 'string', enum: ['pending', 'reviewed', 'limited'] },
    reviewSummary: text(), gaps: notes }), 40),
  searches: list(object({ id, query: text(), branchIds, source: text(300), reference: text(),
    retrievedAt: text(100), candidateCount: { type: 'integer', minimum: 0, maximum: 1000000 },
    notes: text() }, ['id', 'query', 'branchIds', 'source', 'reference', 'retrievedAt', 'candidateCount']), 500),
  papers: list(object({ paperId: text(1000), role: { type: 'string', enum: ['method', 'context', 'excluded'] },
    branchIds, methodIds: nodeIds, reason: text(), evidenceRefs: notes, sourceKey: text() },
  ['paperId', 'role', 'branchIds', 'methodIds', 'reason', 'evidenceRefs']), 2000),
  coverage: object({ status: { type: 'string', enum: ['in_progress', 'reviewed'] },
    summary: text(20000), gaps: notes, nextActions: notes })
}, ['title', 'query', 'scope', 'branches', 'searches', 'papers', 'coverage']);

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertSchema(value, schema, label) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`${label} must be an object.`);
    for (const key of schema.required || []) if (value[key] === undefined) throw failure(`${label}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw failure(`${label} does not accept ${key}.`);
      assertSchema(item, schema.properties[key], `${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw failure(`${label} must be an array with at most ${schema.maxItems} items.`);
    value.forEach((item, index) => assertSchema(item, schema.items, `${label}[${index}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw failure(`${label} is outside the supported integer range.`);
  } else if (typeof value !== 'string' || !value.trim() || value.length > (schema.maxLength || Infinity)) {
    throw failure(`${label} must be nonempty text.`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw failure(`${label} must be one of ${schema.enum.join(', ')}.`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw failure(`${label} is not a valid identifier.`);
}

export function normalizeFieldStudy(input) {
  assertSchema(input, FIELD_STUDY_SCHEMA, 'study');
  const study = structuredClone(input);
  if (study.fromYear && study.toYear && study.fromYear > study.toYear) throw failure('fromYear must not exceed toYear.');
  if (!study.branches.length) throw failure('A study needs at least one explicit research branch.');
  const uniqueIds = (items, key, label) => {
    if (new Set(items.map(item => item[key])).size !== items.length) throw failure(`Duplicate ${label} identifier.`);
  };
  uniqueIds(study.branches, 'id', 'branch');
  uniqueIds(study.searches, 'id', 'search');
  uniqueIds(study.papers, 'paperId', 'paper');
  const branches = new Set(study.branches.map(branch => branch.id));
  for (const entry of [...study.papers, ...study.searches]) {
    if (!entry.branchIds.length || entry.branchIds.some(value => !branches.has(value))) throw failure('Every paper and search must name existing study branches.');
    entry.branchIds = [...new Set(entry.branchIds)];
    if (entry.methodIds) entry.methodIds = [...new Set(entry.methodIds)];
  }
  for (const paper of study.papers) {
    if (paper.role === 'method' && !paper.methodIds.length) throw failure(`Method paper ${paper.paperId} needs its identified methodIds; use context while method evidence is unresolved.`);
    if (paper.role !== 'excluded' && !paper.evidenceRefs.length) throw failure(`Included paper ${paper.paperId} needs source evidence references.`);
  }
  if (study.coverage.status === 'reviewed') {
    for (const branch of study.branches) {
      if (branch.reviewStatus === 'pending') throw failure(`Branch ${branch.id} still needs coverage review.`);
      if (!study.searches.some(search => search.branchIds.includes(branch.id))) throw failure(`Branch ${branch.id} has no recorded search.`);
      if (branch.reviewStatus === 'limited' && !branch.gaps.length) throw failure(`Limited branch ${branch.id} must describe its remaining gaps.`);
    }
  }
  return study;
}

export function fieldStudyPaths(rootPath, studyId) {
  const directory = path.join(getCorpusPaths(rootPath).corpusDir, 'field-research', 'studies');
  if (studyId !== undefined && (typeof studyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(studyId))) throw failure('Invalid studyId.');
  return { directory, record: studyId && path.join(directory, `${studyId}.json`), lock: studyId && path.join(directory, `${studyId}.lock`) };
}

function studySummary(record) {
  const included = record.study.papers.filter(paper => paper.role !== 'excluded');
  return { studyId: record.studyId, revision: record.revision, title: record.study.title,
    query: record.study.query, coverageStatus: record.study.coverage.status,
    paperCount: included.length, methodCount: new Set(included.flatMap(paper => paper.methodIds)).size,
    branchCount: record.study.branches.length, searchCount: record.study.searches.length,
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}

async function saveStudy(rootPath, args) {
  const paths = fieldStudyPaths(rootPath, args.studyId);
  if (!paths.record) throw failure('studyId is required.');
  const study = normalizeFieldStudy(args.study);
  if (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 0) throw failure('expectedRevision is required; use 0 for a new study.');
  return withFileLock(paths.lock, async () => {
    const previous = await readJson(paths.record);
    if ((previous?.revision || 0) !== args.expectedRevision) throw failure('Study revision changed. Read the study before saving an update.', 409);
    const now = new Date().toISOString();
    const record = { contractVersion: FIELD_STUDY_VERSION, studyId: args.studyId,
      revision: args.expectedRevision + 1, createdAt: previous?.createdAt || now, updatedAt: now, study };
    await writeJson(paths.record, record);
    return { ...studySummary(record), saved: true,
      boundary: 'The study records selection and coverage review. Saving does not import papers, verify claims or change graph evidence.' };
  });
}

async function listStudies(rootPath) {
  const { directory } = fieldStudyPaths(rootPath);
  let files;
  try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(files.filter(name => name.endsWith('.json')).map(name => readJson(path.join(directory, name))));
  return records.map(studySummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.studyId.localeCompare(b.studyId));
}

async function readStudy(rootPath, args, options) {
  const paths = fieldStudyPaths(rootPath, args.studyId);
  if (!paths.record) throw failure('studyId is required.');
  const record = await readJson(paths.record);
  if (!record) throw failure('Field study not found.', 404);
  const study = record.study;
  if (args.branchId && !study.branches.some(branch => branch.id === args.branchId)) throw failure('Unknown study branch.');
  const included = study.papers.filter(paper => paper.role !== 'excluded');
  const selected = included.filter(paper => !args.branchId || paper.branchIds.includes(args.branchId));
  const selectedPaperIds = new Set(selected.map(paper => paper.paperId));
  const selectedMethodIds = new Set(selected.flatMap(paper => paper.methodIds));
  const loaded = await loadCorpusLite(rootPath);
  const includedIds = new Set(included.flatMap(paper => [paper.paperId, ...paper.methodIds]));
  const { graph, report: quality } = buildResearchQualityView(loadKnowledgeGraph({
    nodes: loaded.graph.nodes.filter(node => includedIds.has(node.id)),
    relationships: loaded.graph.relationships.filter(edge => includedIds.has(edge.sourceId) && includedIds.has(edge.targetId))
  }));
  const meta = { name: loaded.meta.name, indexedAt: loaded.meta.indexedAt,
    paperCount: quality.paperCount, nodeCount: quality.nodeCount, relationshipCount: quality.relationshipCount,
    researchQualityVersion: quality.version };
  const missingPapers = included.filter(paper => graph.getNode(paper.paperId)?.type !== 'Paper').map(paper => paper.paperId);
  const missingMethods = [...new Set(included.flatMap(paper => paper.methodIds))].filter(id => graph.getNode(id)?.type !== 'Method');
  const paperLinks = new Set(['CONTAINS', 'USES', 'PROPOSES', 'INTRODUCES', 'DESCRIBES', 'PRESENTS']);
  const ownership = new Set();
  for (const edge of graph.relationships) if (paperLinks.has(edge.type)) {
    ownership.add(`${edge.sourceId}\n${edge.targetId}`);
    ownership.add(`${edge.targetId}\n${edge.sourceId}`);
  }
  const mismatchedMethods = included.flatMap(paper => paper.methodIds.filter(methodId => {
    const method = graph.getNode(methodId);
    if (method?.type !== 'Method') return false;
    const p = method.properties || {};
    const owners = [p.paperId, p.sourcePaperId, ...[p.paperIds, p.sourcePaperIds].flatMap(value => Array.isArray(value) ? value : value ? [value] : [])];
    return !owners.includes(paper.paperId) && !ownership.has(`${paper.paperId}\n${methodId}`);
  }).map(methodId => ({ paperId: paper.paperId, methodId })));
  const available = graph.nodes.filter(node => (node.type === 'Paper' && selectedPaperIds.has(node.id))
    || (node.type === 'Method' && selectedMethodIds.has(node.id)));
  const ids = new Set(available.map(node => node.id));
  const scoped = loadKnowledgeGraph({ nodes: available,
    relationships: graph.relationships.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId)) });
  const result = buildFieldEvolution(scoped, { query: study.query,
    seedNodeIds: selected.map(paper => paper.paperId).filter(id => ids.has(id)).slice(0, 500),
    fromYear: study.fromYear, toYear: study.toYear, maxNodes: args.maxNodes ?? 500, maxEdges: args.maxEdges ?? 1000 });
  if (selected.filter(paper => ids.has(paper.paperId)).length > 500) {
    result.scope.truncated = true;
    result.scope.truncationReasons.push('studySeedBudget');
    result.status = 'partial';
  }
  result.scope.study = { studyId: record.studyId, revision: record.revision, branchId: args.branchId || null,
    includedPaperCount: included.length, selectedPaperCount: selected.length, selectedMethodCount: selectedMethodIds.size,
    selectionBasis: 'Reviewed study membership and all selected method variants; no one-method-per-paper restriction.' };
  const gaps = [...study.coverage.gaps, ...study.branches.flatMap(branch => branch.gaps)];
  if (missingPapers.length) gaps.push(`${missingPapers.length} included papers are absent from the current admitted graph.`);
  if (missingMethods.length) gaps.push(`${missingMethods.length} selected methods are absent from the current admitted graph.`);
  if (mismatchedMethods.length) gaps.push(`${mismatchedMethods.length} selected paper-method pairs have no association in the current graph.`);
  const coverageAssessment = { status: missingPapers.length || missingMethods.length || mismatchedMethods.length ? 'needs_attention' : study.coverage.status,
    summary: study.coverage.summary, gaps: [...new Set(gaps)], nextActions: study.coverage.nextActions,
    missingPapers, missingMethods, mismatchedMethods, basis: 'Recorded branch review, search evidence and selection decisions; not inferred from paper counts or batch completion.',
    branches: study.branches.map(branch => ({ ...branch,
      paperCount: included.filter(paper => paper.branchIds.includes(branch.id)).length,
      methodCount: new Set(included.filter(paper => paper.branchIds.includes(branch.id)).flatMap(paper => paper.methodIds)).size,
      searchCount: study.searches.filter(search => search.branchIds.includes(branch.id)).length })) };
  return { ...record, coverageAssessment, analysis: { meta, sourceQuality: quality, result, generatedAt: new Date().toISOString(),
    study: { ...studySummary(record), scope: study.scope, coverageAssessment } } };
}

export async function executeFieldStudyOperation(candidate, operation, args = {}, options = {}) {
  const fields = { save: ['studyId', 'expectedRevision', 'study'], read: ['studyId', 'branchId', 'maxNodes', 'maxEdges'], list: [] }[operation];
  if (!fields) throw failure('Unknown field study operation.');
  if (Object.keys(args).some(key => !fields.includes(key))) throw failure('Unexpected field study argument.');
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (operation === 'save') return saveStudy(rootPath, args);
  if (operation === 'read') return readStudy(rootPath, args, options);
  return { contractVersion: FIELD_STUDY_VERSION, studies: await listStudies(rootPath) };
}
