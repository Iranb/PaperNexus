import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { executeFieldStudyOperation, normalizeFieldStudy } from '../src/core/research/field-studies.js';
import { renderFieldStudySummary } from '../web/field-studies-view.js';

export function studyFixture() {
  return { title: 'Feedback history', query: 'feedback', scope: 'Fictional control methods for interface acceptance.',
    branches: [{ id: 'control', label: 'Control', description: 'Feedback controller evolution.', reviewStatus: 'reviewed', reviewSummary: 'Both generations and their variant were checked.', gaps: [] },
      { id: 'adaptation', label: 'Adaptation', description: 'Adaptive methods.', reviewStatus: 'reviewed', reviewSummary: 'Adaptive variants were checked.', gaps: [] }],
    searches: [{ id: 'search-1', query: 'feedback adaptation', branchIds: ['control', 'adaptation'], source: 'Fictional fixture',
      reference: 'https://example.org/fixture', retrievedAt: '2026-10-26', candidateCount: 4 }],
    papers: [
      { paperId: 'p-m0', role: 'method', branchIds: ['control'], methodIds: ['m0'], reason: 'Original controller.', evidenceRefs: ['https://example.org/m0'] },
      { paperId: 'p-m1', role: 'method', branchIds: ['control', 'adaptation'], methodIds: ['m1', 'm1-fast'], reason: 'Adaptive method and distinct fast variant.', evidenceRefs: ['https://example.org/m1'] },
      { paperId: 'p-unrelated', role: 'excluded', branchIds: ['control'], methodIds: [], reason: 'Outside control research.', evidenceRefs: [] }
    ], coverage: { status: 'reviewed', summary: 'The declared fictional scope was checked.', gaps: [], nextActions: [] } };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-field-study-'));
  const paths = getCorpusPaths(root);
  const graph = createFieldEvolutionFixture();
  graph.addNode({ id: 'm1-fast', type: 'Method', name: 'Fast adaptive feedback', properties: { paperId: 'p-m1', year: 2011 } });
  graph.addRelationship({ id: 'owns-fast', type: 'INTRODUCES', sourceId: 'p-m1', targetId: 'm1-fast' });
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'field-studies', rootPath: root }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  return { root, paths, graph };
}

test('saved studies retain multiple methods per paper, exclusions and independent named scopes', async () => {
  const f = await fixture();
  try {
    const input = { studyId: 'control-history', expectedRevision: 0, study: studyFixture() };
    const receipt = await executeFieldStudyOperation(f.root, 'save', input);
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.paperCount, 2);
    assert.equal(receipt.methodCount, 3);
    await executeFieldStudyOperation(f.root, 'save', { ...input, studyId: 'second-history' });
    assert.equal((await executeFieldStudyOperation(f.root, 'list')).studies.length, 2);
    const response = await executeFieldStudyOperation(f.root, 'read', { studyId: input.studyId });
    assert.deepEqual(new Set(response.analysis.result.methods.map(method => method.id)), new Set(['m0', 'm1', 'm1-fast']));
    assert.deepEqual(new Set(response.analysis.result.papers.map(paper => paper.id)), new Set(['p-m0', 'p-m1']));
    assert.equal(response.analysis.result.relations.length, 1);
    assert.equal(response.coverageAssessment.status, 'reviewed');
    const branch = await executeFieldStudyOperation(f.root, 'read', { studyId: input.studyId, branchId: 'adaptation' });
    assert.equal(branch.analysis.result.papers.length, 1);
    assert.equal(branch.analysis.result.methods.length, 2);
    assert.equal(branch.analysis.result.scope.study.includedPaperCount, 2);
    assert.match(renderFieldStudySummary(branch, 'adaptation'), /1 selected papers · 2 selected methods/);
    assert.match(renderFieldStudySummary(response), /Outside control research/);
    await assert.rejects(executeFieldStudyOperation(f.root, 'read', { studyId: input.studyId, branchId: 'missing' }), /Unknown study branch/);
    await assert.rejects(executeFieldStudyOperation(f.root, 'save', input), /revision changed/);
    assert.equal((await executeFieldStudyOperation(f.root, 'save', { ...input, expectedRevision: 1 })).revision, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('coverage review requires branch research and cannot silently hide missing graph evidence', async () => {
  const pending = studyFixture(); pending.branches[0].reviewStatus = 'pending';
  assert.throws(() => normalizeFieldStudy(pending), /needs coverage review/);
  const noSearch = studyFixture(); noSearch.searches = [];
  assert.throws(() => normalizeFieldStudy(noSearch), /no recorded search/);
  const limited = studyFixture(); limited.branches[0].reviewStatus = 'limited';
  assert.throws(() => normalizeFieldStudy(limited), /remaining gaps/);
  const noMethods = studyFixture(); noMethods.papers[0].methodIds = [];
  assert.throws(() => normalizeFieldStudy(noMethods), /identified methodIds/);
  const f = await fixture();
  try {
    const study = studyFixture(); study.papers[0].methodIds.push('not-in-graph');
    study.papers.push({ paperId: 'missing-paper', role: 'context', branchIds: ['control'], methodIds: [], reason: 'Awaiting source admission.', evidenceRefs: ['https://example.org/missing'] });
    await executeFieldStudyOperation(f.root, 'save', { studyId: 'missing-evidence', expectedRevision: 0, study });
    const result = await executeFieldStudyOperation(f.root, 'read', { studyId: 'missing-evidence' });
    assert.equal(result.study.coverage.status, 'reviewed');
    assert.equal(result.coverageAssessment.status, 'needs_attention');
    assert.deepEqual(result.coverageAssessment.missingMethods, ['not-in-graph']);
    assert.deepEqual(result.coverageAssessment.missingPapers, ['missing-paper']);
    assert.equal(result.analysis.result.papers.length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('study reads expose mismatched method ownership and bounded display selection', async () => {
  const f = await fixture();
  try {
    const study = studyFixture();
    study.papers[0].methodIds.push('m1');
    for (let index = 0; index < 500; index++) {
      const paperId = `context-${index}`;
      f.graph.addNode({ id: paperId, type: 'Paper', name: `Context ${index}`, properties: { year: 2010 } });
      study.papers.push({ paperId, role: 'context', branchIds: ['control'], methodIds: [], reason: 'Survey context.', evidenceRefs: ['https://example.org/context'] });
    }
    await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(f.graph.toJSON()));
    await executeFieldStudyOperation(f.root, 'save', { studyId: 'bounded-study', expectedRevision: 0, study });
    const result = await executeFieldStudyOperation(f.root, 'read', { studyId: 'bounded-study' });
    assert.equal(result.coverageAssessment.status, 'needs_attention');
    assert.deepEqual(result.coverageAssessment.mismatchedMethods, [{ paperId: 'p-m0', methodId: 'm1' }]);
    assert.equal(result.analysis.result.status, 'partial');
    assert.equal(result.analysis.result.scope.truncated, true);
    assert.ok(result.analysis.result.scope.truncationReasons.includes('studySeedBudget'));
    assert.equal(result.analysis.result.scope.study.selectedPaperCount, 502);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
