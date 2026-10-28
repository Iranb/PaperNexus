import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { executeLineageRefinementOperation, launchLineageRefinement } from '../src/core/research/lineage-refinement.js';
import { executeLineagePublication } from '../src/core/research/lineage-publication.js';
import { lineagePublicationPath } from '../src/storage/lineage-publications.js';
import { loadCorpus, loadCorpusLite, saveCorpus, applyCorpusMutations } from '../src/storage/corpus-store.js';
import { loadKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildFieldEvolution } from '../src/core/graph/field-evolution.js';
import { loadCorpusLiteForApi, corpusPayload } from '../src/server/api.js';
import { refinementFixture } from './helpers/lineage-refinement-fixture.js';
process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

async function reviewed(f) {
  await executeLineageRefinementOperation(f.root, 'start', { papers: [{ paperId: 'child' }], idempotencyKey: 'publish' }, f.options);
  await launchLineageRefinement(f.root, 'refine-publish', f.options);
  return { runId: 'refine-publish', requestId: 'publish' };
}

test('preview is read-only; applied lineage survives rebuild, lite reads and idempotent publication', async () => {
  const f = await refinementFixture();
  try {
    const request = await reviewed(f);
    const before = await fs.readFile(f.paths.graphPath, 'utf8');
    const preview = await executeLineagePublication(f.root, request);
    assert.equal(preview.status, 'preview'); assert.equal(preview.items.length, 1);
    assert.equal(await fs.readFile(f.paths.graphPath, 'utf8'), before);
    await assert.rejects(fs.stat(lineagePublicationPath(f.root)), { code: 'ENOENT' });
    const applied = await executeLineagePublication(f.root, { ...request, apply: true });
    assert.equal(applied.status, 'published'); assert.equal(applied.items.length, 1);
    assert.equal(applied.readback[0].relationship.properties.exactQuote, f.quote);
    assert.equal(applied.projection[0].status, 'active');
    const full = await loadCorpus(f.root), lite = await loadCorpusLite(f.root);
    assert.equal(full.graph.relationships.length, 1); assert.equal(lite.graph.relationships.length, 1);
    assert.equal(full.publications[0].status, 'active'); assert.equal(lite.publications[0].status, 'active');
    const map = buildFieldEvolution(lite.graph, { seedNodeIds: ['child', 'parent'] });
    assert.equal(map.relations.length, 1);
    assert.equal(lite.graph.getNode(map.relations[0].sourceId).name, f.names[1]);
    assert.equal(map.relations[0].evidence.evidence.reviewStatus, 'model_reviewed');
    assert.equal(map.relations[0].evidence.evidence.scientificValidation, false);
    assert.equal(map.relations[0].evidence.evidence.explanations.bottleneck, null);
    await executeLineagePublication(f.root, { ...request, apply: true });
    const duplicate = await executeLineagePublication(f.root, { ...request, requestId: 'duplicate', apply: true });
    assert.equal(duplicate.duplicates.length, 1); assert.equal((await loadCorpus(f.root)).graph.relationships.length, 1);
    await saveCorpus(f.root, loadKnowledgeGraph(f.graph), full.meta, { liteViewMode: 'rebuild' });
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 1);
    assert.equal((await loadCorpusLite(f.root)).graph.relationships.length, 1);
    const cache = { corpusByRoot: new Map(), corpusLiteByRoot: new Map() };
    assert.equal((await loadCorpusLiteForApi(f.root, { cache })).graph.relationships.length, 1);
    assert.equal((await corpusPayload(f.root, { cache })).graph.relationships.length, 1);
    await fs.appendFile(f.source, '\nRevised source.');
    const stale = await loadCorpus(f.root);
    assert.equal(stale.graph.relationships.length, 0); assert.equal(stale.publications[0].status, 'stale');
    assert.equal((await loadCorpusLiteForApi(f.root, { cache })).graph.relationships.length, 0);
    assert.equal((await corpusPayload(f.root, { cache })).graph.relationships.length, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('source changes before publish are excluded and component edges retain their direction', async () => {
  const f = await refinementFixture();
  try {
    f.card.lineageCandidates[0].relationType = 'COMPONENT_OF'; f.review.relations[0].context = 'component_adoption';
    const request = await reviewed(f);
    const applied = await executeLineagePublication(f.root, { ...request, apply: true });
    const { graph } = await loadCorpus(f.root);
    assert.equal(graph.getNode(graph.relationships[0].sourceId).name, f.names[1]);
    assert.equal(graph.getNode(graph.relationships[0].targetId).name, f.names[0]);
    assert.equal(applied.items.length, 1);
    await fs.appendFile(f.parentSource, '\nNew version.');
    const stale = await executeLineagePublication(f.root, { ...request, requestId: 'stale' });
    assert.equal(stale.items.length, 0); assert.equal(stale.excluded[0].reason, 'source_requires_review');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('revocation restores only owned changes and cannot be undone by replaying the old request', async () => {
  const f = await refinementFixture();
  try {
    const request = await reviewed(f);
    await executeLineagePublication(f.root, { ...request, apply: true });
    const preview = await executeLineagePublication(f.root, { ...request, revoke: true });
    assert.equal(preview.projection[0].status, 'revoked');
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 1);
    await executeLineagePublication(f.root, { ...request, revoke: true, apply: true });
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
    assert.equal((await loadCorpus(f.root)).graph.nodes.length, 2);
    const replay = await executeLineagePublication(f.root, { ...request, apply: true });
    assert.equal(replay.status, 'revoked'); assert.equal(replay.applied, false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('publication projection preserves later human edits and reports a conflict', async () => {
  const f = await refinementFixture();
  try {
    const request = await reviewed(f);
    const applied = await executeLineagePublication(f.root, { ...request, apply: true });
    const edge = (await loadCorpus(f.root)).graph.getRelationship(applied.items[0].edgeId);
    await applyCorpusMutations(f.root, [{ action: 'upsert_relationship', relationship: { ...edge,
      properties: { note: 'Human annotation', lineagePublicationId: null } } }]);
    const loaded = await loadCorpus(f.root);
    assert.equal(loaded.publications[0].status, 'conflict');
    assert.equal(loaded.graph.relationships[0].properties.note, 'Human annotation');
    await executeLineagePublication(f.root, { ...request, revoke: true, apply: true });
    const revoked = await loadCorpus(f.root);
    assert.equal(revoked.graph.relationships[0].properties.note, 'Human annotation');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('source identity and admission changes invalidate previously reviewed relations', async () => {
  for (const change of ['identity', 'inactive', 'deleted']) {
    const f = await refinementFixture();
    try {
      const request = await reviewed(f);
      await executeLineagePublication(f.root, { ...request, apply: true });
      if (change === 'identity') {
        const loaded = await loadCorpus(f.root);
        loaded.graph.updateNode({ ...loaded.graph.getNode('parent'), name: 'Different paper identity' });
        await saveCorpus(f.root, loaded.graph, loaded.meta);
      } else if (change === 'inactive') {
        f.sources[1].activeInGraph = false;
        await fs.writeFile(f.paths.manifestPath, JSON.stringify({ sources: f.sources }));
      } else await fs.unlink(f.parentSource);
      const loaded = await loadCorpus(f.root);
      assert.equal(loaded.graph.relationships.length, 0, change);
      assert.equal(loaded.publications[0].status, 'stale', change);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  }
});

test('source-matched existing edges restore on revocation but cannot reappear as current after source drift', async () => {
  const f = await refinementFixture();
  try {
    const request = await reviewed(f);
    const oldGraph = structuredClone(f.graph);
    oldGraph.nodes.push(...f.names.map((name, index) => ({ id: index ? 'base-method' : 'child-method', type: 'Method', name,
      properties: { paperId: index ? 'parent' : 'child', year: index ? 2020 : 2024 } })));
    const oldEdge = { id: 'old-edge', sourceId: 'child-method', targetId: 'base-method', type: 'EXTENDS_METHOD', properties: {
      sourcePaperId: 'child', targetPaperId: 'parent', sourceKey: f.source, exactQuote: f.quote, validationStatus: 'accepted', priorNote: 'Original extraction' } };
    oldGraph.relationships.push(oldEdge);
    await saveCorpus(f.root, loadKnowledgeGraph(oldGraph), { name: 'fixture', rootPath: f.root });
    const published = await executeLineagePublication(f.root, { ...request, apply: true });
    assert.equal(published.items[0].edgeId, 'old-edge');
    await executeLineagePublication(f.root, { ...request, revoke: true, apply: true });
    assert.deepEqual((await loadCorpus(f.root)).graph.getRelationship('old-edge'), oldEdge);
    await executeLineagePublication(f.root, { ...request, requestId: 'new-publication', apply: true });
    await fs.appendFile(f.source, '\nChanged relation evidence.');
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
    await saveCorpus(f.root, loadKnowledgeGraph(oldGraph), { name: 'fixture', rootPath: f.root });
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
    assert.equal((await loadCorpusLite(f.root)).graph.relationships.length, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('a partially processed run publishes only its successfully reviewed subset', async () => {
  const f = await refinementFixture();
  try {
    await executeLineageRefinementOperation(f.root, 'start', { papers: [{ paperId: 'child' }, { paperId: 'absent' }], idempotencyKey: 'partial' }, f.options);
    await launchLineageRefinement(f.root, 'refine-partial', f.options);
    const result = await executeLineagePublication(f.root, { runId: 'refine-partial', requestId: 'partial', apply: true });
    assert.equal(result.sourceRunStatus, 'partial'); assert.equal(result.items.length, 1);
    assert.equal(result.excluded.length, 1); assert.equal(result.excluded[0].paperId, 'absent');
    assert.equal((await loadCorpus(f.root)).graph.relationships.length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('publication reuses methods owned through paper links and plural source identities', async () => {
  const f = await refinementFixture();
  try {
    const request = await reviewed(f);
    const graph = loadKnowledgeGraph(f.graph);
    graph.addNode({ id: 'linked-child', type: 'Method', name: f.names[0], properties: {} });
    graph.addNode({ id: 'multi-parent', type: 'Method', name: f.names[1], properties: { sourcePaperIds: ['parent'] } });
    graph.addRelationship({ id: 'paper-proposes', type: 'PROPOSES', sourceId: 'child', targetId: 'linked-child', properties: {} });
    await saveCorpus(f.root, graph, { name: 'fixture', rootPath: f.root });
    const result = await executeLineagePublication(f.root, { ...request, apply: true });
    assert.equal(result.items.length, 1);
    assert.equal(result.readback[0].relationship.sourceId, 'linked-child');
    assert.equal(result.readback[0].relationship.targetId, 'multi-parent');
    assert.equal((await loadCorpus(f.root)).graph.nodes.filter(node => node.type === 'Method').length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
