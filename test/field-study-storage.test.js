import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { createLiteGraphPayload } from '../src/core/graph/lite.js';
import { executeFieldStudyOperation } from '../src/core/research/field-studies.js';

test('stored studies retain dates, exact relation evidence and selected source identities through the lite graph', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-study-storage-'));
  const paths = getCorpusPaths(root);
  try {
    const graph = createKnowledgeGraph();
    for (const [id, year] of [['old', 2020], ['new', 2022]]) {
      graph.addNode({ id: `paper:${id}`, type: 'Paper', name: `${id} feedback controller`, properties: {
        publicationDate: `${year}-03-01`, authors: ['Example Author'], identifiers: { arxivId: id === 'old' ? '2003.00001' : '2203.00001' },
        sourceUrl: `https://example.org/${id}`, metadataTitleTrusted: true } });
      graph.addNode({ id: `method:${id}`, type: 'Method', name: `${id} controller`, properties: {
        paperIds: [`paper:${id}`], introducedYear: year } });
    }
    graph.addNode({ id: 'paper:outside-copy', type: 'Paper', name: 'old feedback controller', properties: {
      identifiers: { arxivId: '2003.00001' }, sourceKind: 'pdf', abstract: 'An out-of-study copy with richer metadata.' } });
    const quote = 'The new controller extends the old controller. '.repeat(12).trim();
    graph.addRelationship({ id: 'relation:extension', type: 'EXTENDS_METHOD', sourceId: 'method:new', targetId: 'method:old',
      properties: { validationStatus: 'validated', exactQuote: quote, exactMatch: true,
        sourcePaperId: 'paper:new', targetPaperId: 'paper:old', sectionHeading: '3 Method',
        bottleneck: 'Sparse feedback', mechanism: 'Calibrated updates', tradeoff: 'Additional calibration' } });
    await fs.mkdir(paths.corpusDir, { recursive: true });
    await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'stored-study', domainDistanceMatrix: { unrelated: 'large global payload' } }));
    await fs.writeFile(paths.liteGraphPath, JSON.stringify(createLiteGraphPayload(graph)));
    const study = { title: 'Stored control history', query: 'controller', scope: 'Two reviewed sources.',
      branches: [{ id: 'control', label: 'Control', description: 'Controller history.', reviewStatus: 'reviewed', reviewSummary: 'Both sources reviewed.', gaps: [] }],
      searches: [{ id: 'search', query: 'controller', branchIds: ['control'], source: 'Fixture', reference: 'https://example.org', retrievedAt: '2026-10-26', candidateCount: 2 }],
      papers: ['old', 'new'].map(id => ({ paperId: `paper:${id}`, role: 'method', branchIds: ['control'], methodIds: [`method:${id}`],
        reason: 'Reviewed source.', evidenceRefs: [`https://example.org/${id}`] })),
      coverage: { status: 'reviewed', summary: 'Both sources reviewed.', gaps: [], nextActions: [] } };
    await executeFieldStudyOperation(root, 'save', { studyId: 'stored', expectedRevision: 0, study });
    const response = await executeFieldStudyOperation(root, 'read', { studyId: 'stored' });
    const result = response.analysis.result;
    assert.equal(response.coverageAssessment.status, 'reviewed');
    assert.deepEqual(result.papers.map(paper => paper.year).sort(), [2020, 2022]);
    assert.deepEqual(result.methods.map(method => method.year).sort(), [2020, 2022]);
    assert.deepEqual(new Set(result.papers.map(paper => paper.id)), new Set(['paper:old', 'paper:new']));
    assert.equal(result.relations.length, 1);
    assert.equal(result.relations[0].evidence.evidence.exactQuote, quote);
    assert.equal(result.relations[0].evidence.section.heading, '3 Method');
    assert.equal(result.relations[0].evidence.mechanism.description, 'Calibrated updates');
    assert.equal(response.analysis.meta.domainDistanceMatrix, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
