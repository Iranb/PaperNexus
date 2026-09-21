import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaperMarkdown } from '../src/core/ingestion/markdown.js';
import { assessLimitationRecord } from '../src/core/ingestion/source-quality.js';
import { createPaperIdentity, mergePaperIdentity, paperIdentifiersConflict, paperStrongIdentityOverlap } from '../src/lib/paper-identifiers.js';
import { buildResearchQualityView } from '../src/core/graph/research-quality.js';

const paper = (id, arxivId, extra = {}) => ({ id, type: 'Paper', name: `Paper ${id}`, properties: { identifiers: { arxivId }, ...extra } });
const relation = (id, sourceId, targetId, type, properties = {}) => ({ id, sourceId, targetId, type, properties });

test('versioned arXiv identities overlap but retain version aliases and conflicting papers stay separate', () => {
  const v1 = createPaperIdentity({ arxivId: 'https://arxiv.org/abs/2507.04725v1', title: 'First title' });
  const v3 = createPaperIdentity({ arxivId: '2507.04725v3', title: 'Revised title' });
  assert.equal(v1.canonicalId, 'arxiv:2507.04725');
  assert.equal(v3.canonicalId, v1.canonicalId);
  assert.equal(paperIdentifiersConflict(v1, v3), false);
  assert.equal(paperStrongIdentityOverlap(v1, v3), true);
  const merged = mergePaperIdentity(v1, v3);
  assert.ok(merged.identityAliases.includes('arxiv:2507.04725v1'));
  assert.ok(merged.identityAliases.includes('arxiv:2507.04725v3'));
  assert.equal(paperIdentifiersConflict(v1, { arxivId: '2507.04726' }), true);
  assert.equal(paperIdentifiersConflict({ doi: '10.1000/a' }, { doi: '10.1000/b' }), true);
});

test('HTML/error documents fail ingestion, while embedded HTML in real markdown is allowed', () => {
  for (const text of ['<!DOCTYPE html><html><title>Login</title></html>', '\uFEFF <!-- cached -->\n<html>paper</html>', '# 403 Forbidden\nPlease log in']) {
    assert.throws(() => parsePaperMarkdown(text, 'paper.md'), { code: 'PAPERNEXUS_INVALID_PAPER_SOURCE' });
  }
  const valid = parsePaperMarkdown('# A Real Research Paper\n\n## Abstract\nAn HTML parser studies `<html>` as input.\n\n<table><tr><td>1</td></tr></table>', 'paper.md');
  assert.equal(valid.title, 'A Real Research Paper');
});

test('limitation admission separates results, boundaries, and uncertain captions', () => {
  assert.equal(assessLimitationRecord({ text: 'However, our method improves accuracy by 5 points with only one pass.' }).decision, 'finding');
  assert.equal(assessLimitationRecord({ text: 'Our method improves accuracy but cannot handle classes outside the dictionary.' }).decision, 'keep');
  assert.equal(assessLimitationRecord({ text: 'Table 2 shows the absolute gain/drop of each component.' }).decision, 'review');
  assert.equal(assessLimitationRecord({ text: 'Several limitations point to productive future directions.' }).decision, 'review');
  assert.equal(assessLimitationRecord({ text: 'The classifier is sensitive to class imbalance.' }).decision, 'keep');
});

test('research view isolates test sources, merges versions, preserves provenance, repairs limitations and does not mutate raw graph', () => {
  const raw = { nodes: [paper('p1', '2507.04725v1'), paper('p3', '2507.04725v3'),
    paper('test', '', { identifiers: { doi: '10.48550/papernexus.live-burst.01' } }),
    { id: 'html', type: 'Paper', name: '<!DOCTYPE html>', properties: {} },
    { id: 'shared', type: 'Method', name: 'Shared mechanism', properties: {} },
    { id: 'fake', type: 'Method', name: 'Synthetic test mechanism', properties: { paperId: 'test' } },
    { id: 'l1', type: 'Limitation', name: 'However our method improves clustering accuracy.', properties: { paperId: 'p1' } },
    { id: 'l2', type: 'Limitation', name: 'Table 1 describes the components and settings.', properties: { paperId: 'p3' } },
    { id: 'l3', type: 'Limitation', name: 'The method cannot handle a missing concept dictionary.', properties: { paperId: 'p3' } }
  ], relationships: [relation('a', 'p1', 'shared', 'USES'), relation('b', 'test', 'shared', 'USES'), relation('c', 'test', 'fake', 'USES'),
    relation('d', 'p1', 'l1', 'HAS_LIMITATION', { sourcePaperId: 'p1' }), relation('e', 'p3', 'l2', 'HAS_LIMITATION'), relation('f', 'p3', 'l3', 'HAS_LIMITATION'),
    relation('g', 'l1', 'shared', 'CONSTRAINS') ] };
  const before = JSON.stringify(raw);
  const { graph, report } = buildResearchQualityView(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(report.paperCount, 1);
  assert.equal(report.quarantinedPapers.length, 2);
  assert.equal(graph.getNode('p3').properties.paperVersions.length, 2);
  assert.equal(graph.getNode('fake'), undefined);
  assert.ok(graph.getNode('shared'));
  assert.equal(graph.getNode('l1').type, 'Finding');
  assert.equal(graph.getNode('l1').properties.paperId, 'p3');
  assert.equal(graph.getNode('l1').properties.qualityOriginalPaperId, 'p1');
  assert.equal(graph.getNode('l2'), undefined);
  assert.equal(graph.getNode('l3').type, 'Limitation');
  assert.equal(graph.relationships.find(e => e.id === 'd').type, 'REPORTS_FINDING');
  assert.ok(!graph.relationships.some(e => e.id === 'g'));
  for (const e of graph.relationships) { assert.ok(graph.getNode(e.sourceId)); assert.ok(graph.getNode(e.targetId)); }
});

test('same title with different identifiers is not merged; internal DOI plus real arXiv is not blanket-quarantined', () => {
  const a = paper('a', '2501.12345', { identifiers: { arxivId: '2501.12345', doi: '10.48550/papernexus.import.1' } });
  const b = paper('b', '2501.12346'); a.name = b.name = 'Same title';
  const { report } = buildResearchQualityView({ nodes: [a, b], relationships: [] });
  assert.equal(report.paperCount, 2); assert.equal(report.mergedPapers.length, 0);
});

test('mixed positive and negative outcomes remain a limitation and versioned arXiv DOIs do not conflict', () => {
  assert.equal(assessLimitationRecord({ text: 'There is a sharp drop in Old class performance, while New class accuracy improves.' }).decision, 'keep');
  assert.equal(paperIdentifiersConflict({ doi: '10.48550/arXiv.2507.04725v1' }, { doi: '10.48550/arXiv.2507.04725v3' }), false);
});

test('web graph, metadata and API search share the same research view', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { corpusPayload, corpusMetaPayload, queryGraphPayload, createApiCache } = await import('../src/server/api.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-quality-api-'));
  try {
    await fs.mkdir(path.join(root, '.papernexus'));
    const nodes = [paper('good', '2507.04725'), paper('test', '', { identifiers: { doi: '10.48550/papernexus.test.1' } })];
    nodes[0].name = 'GCD quality research'; nodes[1].name = 'GCD synthetic test';
    await fs.writeFile(path.join(root, '.papernexus/graph.lite.json'), JSON.stringify({ nodes, relationships: [] }));
    await fs.writeFile(path.join(root, '.papernexus/meta.json'), JSON.stringify({ name: 'quality', paperCount: 9, indexedAt: new Date().toISOString() }));
    const options = { cache: createApiCache() };
    const payload = await corpusPayload(root, options);
    assert.equal(payload.meta.paperCount, 1);
    assert.equal(payload.meta.rawPaperCount, 9);
    assert.equal(payload.quality.quarantinedPapers.length, 1);
    assert.equal((await corpusMetaPayload(root, options)).meta.paperCount, 1);
    const query = await queryGraphPayload(root, { query: 'GCD' }, options);
    assert.deepEqual(query.result.groups.map(g => g.id), ['good']);
    const raw = JSON.parse(await fs.readFile(path.join(root, '.papernexus/graph.lite.json')));
    assert.equal(raw.nodes.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
