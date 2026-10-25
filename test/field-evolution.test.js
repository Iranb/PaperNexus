import test from 'node:test';
import assert from 'node:assert/strict';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { buildFieldEvolution } from '../src/core/graph/field-evolution.js';

test('field landscape retains long histories, distinct families and exact relation evidence without mutating the graph', () => {
  const graph = createFieldEvolutionFixture();
  const before = JSON.stringify(graph.toJSON());
  const result = buildFieldEvolution(graph, { targetDomain: 'Education' });
  assert.equal(result.status, 'ok');
  assert.equal(result.methods.length, 17);
  assert.equal(result.papers.length, 18);
  assert.equal(result.methods.find(m => m.id === 'external').scopeRole, 'boundary');
  assert.equal(result.families.length, 2);
  assert.ok(result.families[0].mainline.nodeIds.length > 8);
  assert.deepEqual(result.families[0].mainline.nodeIds.slice(0, 4), ['external', 'm0', 'm1', 'm2']);
  assert.ok(result.turningPoints.some(p => p.type === 'branch' && p.methodId === 'm2'));
  assert.ok(result.turningPoints.some(p => p.type === 'convergence' && p.methodId === 'merge'));
  assert.ok(result.turningPoints.some(p => p.type === 'replacement' && p.methodId === 'replace'));
  assert.ok(result.relations.every(r => r.evidence.evidence.quote && r.evidence.evidence.sourceSpanId));
  assert.ok(!result.relations.some(r => r.id === 'candidate-edge' || r.id === 'ordinary-citation'));
  assert.equal(result.relations.filter(r => r.sourceId === 'branch' && r.targetId === 'merge').length, 1);
  assert.deepEqual(result.relations.find(r => r.id === 'merge-branch').graphEdgeIds, ['component-projection', 'merge-branch']);
  assert.ok(result.paperRelations.some(r => r.sourceId === 'p-branch' && r.targetId === 'p-merge'));
  assert.ok(result.diagnostics.rejectedRelations.some(r => r.edgeId === 'candidate-edge'));
  assert.deepEqual(result.diagnostics.isolatedPapers, ['p-isolated']);
  assert.equal(result.periods.at(-1).label, 'Undated');
  assert.equal(JSON.stringify(graph.toJSON()), before);
});

test('field and time filters are explicit, budgets never leave dangling relations, and empty matches stay empty', () => {
  const graph = createFieldEvolutionFixture();
  const result = buildFieldEvolution(graph, { query: 'feedback calibration', targetDomain: 'Education', fromYear: 2015, toYear: 2022 });
  assert.ok([...result.methods, ...result.papers].every(n => !n.year || (n.year >= 2015 && n.year <= 2022)));
  assert.ok(result.methods.some(m => m.id === 'unknown'));
  const tiny = buildFieldEvolution(graph, { targetDomain: 'Education', maxNodes: 4, maxEdges: 1 });
  assert.equal(tiny.status, 'partial');
  assert.equal(tiny.methods.length, 4);
  assert.equal(tiny.papers.length, 4);
  const ids = new Set(tiny.methods.map(m => m.id));
  const paperIds = new Set(tiny.papers.map(p => p.id));
  assert.ok(tiny.relations.every(r => ids.has(r.sourceId) && ids.has(r.targetId)));
  assert.ok(tiny.paperRelations.every(r => paperIds.has(r.sourceId) && paperIds.has(r.targetId)));
  assert.ok(tiny.scope.truncationReasons.includes('methodNodeBudget'));
  assert.equal(buildFieldEvolution(graph, { query: 'nonexistentquantumterm' }).status, 'no_matches');
  assert.throws(() => buildFieldEvolution(graph, {}), /required/);
  assert.throws(() => buildFieldEvolution(graph, { seedNodeIds: [] }), /required/);
  assert.throws(() => buildFieldEvolution(graph, { query: 'feedback', fromYear: 2025, toYear: 2020 }), /fromYear/);
  assert.throws(() => buildFieldEvolution(graph, { query: 'feedback', maxNodes: 501 }), /maxNodes/);
});

test('explicit seed traversal reports bounded coverage and missing anchors', () => {
  const graph = createFieldEvolutionFixture();
  const result = buildFieldEvolution(graph, { seedNodeIds: ['m5', 'missing'], maxDepth: 1 });
  assert.deepEqual(result.methods.map(m => m.id), ['m5', 'm4', 'm6']);
  assert.deepEqual(result.scope.missingSeeds, ['missing']);
  assert.ok(result.scope.truncationReasons.includes('maxDepth'));
});

test('same-year cycles remain visible and cannot be presented as an acyclic mainline', () => {
  const graph = createFieldEvolutionFixture();
  for (const id of ['spectral', 'spectral2']) graph.updateNode({ ...graph.getNode(id), properties: { ...graph.getNode(id).properties, year: 2022 } });
  const edge = graph.getRelationship('spectral2-spectral');
  graph.addRelationship({ ...edge, id: 'cycle', sourceId: 'spectral', targetId: 'spectral2' });
  const result = buildFieldEvolution(graph, { seedNodeIds: ['spectral'] });
  assert.equal(result.families[0].hasCycle, true);
  assert.deepEqual(result.families[0].mainline.nodeIds, []);
  assert.equal(result.relations.length, 2);
  assert.equal(result.diagnostics.cyclicFamilyIds.length, 1);
});

test('paper projection does not invent edges between ambiguous method owners', () => {
  const graph = createFieldEvolutionFixture();
  graph.updateNode({ ...graph.getNode('m0'), properties: { ...graph.getNode('m0').properties, paperIds: ['p-m0', 'p-m1'] } });
  const edge = graph.getRelationship('m1-m0');
  const { sourcePaperId, targetPaperId, paperId, ...properties } = edge.properties;
  graph.updateRelationship({ ...edge, properties });
  const result = buildFieldEvolution(graph, { targetDomain: 'Education' });
  assert.ok(result.relations.some(r => r.id === 'm1-m0'));
  assert.ok(!result.paperRelations.some(r => r.methodRelationIds.includes('m1-m0')));
  assert.ok(result.diagnostics.paperProjectionOmissions.some(r => r.relationId === 'm1-m0' && r.reason === 'ambiguous_or_missing_paper_owner'));
});

test('field selection scans beyond the ordinary search result cap', () => {
  const graph = createFieldEvolutionFixture();
  for (let i = 0; i < 70; i++) graph.addNode({ id: `extra-${i}`, type: 'Paper', name: `Calibration history volume ${i}`, properties: { year: 2020, fieldOfStudy: 'Education' } });
  const result = buildFieldEvolution(graph, { query: 'calibration', targetDomain: 'Education' });
  assert.ok(result.scope.counts.matchedPapers > 70);
  assert.ok(result.papers.some(p => p.id === 'extra-69'));
});

test('component-only projections retain component direction and reject reversed dated projections', () => {
  const graph = createFieldEvolutionFixture();
  graph.removeRelationship('merge-branch');
  const component = buildFieldEvolution(graph, { seedNodeIds: ['merge'] }).relations.find(r => r.id === 'component-projection');
  assert.equal(component.sourceId, 'branch');
  assert.equal(component.targetId, 'merge');
  graph.updateNode({ ...graph.getNode('branch'), properties: { ...graph.getNode('branch').properties, year: 2026 } });
  const reversed = buildFieldEvolution(graph, { targetDomain: 'Education' });
  assert.ok(!reversed.relations.some(r => r.id === 'component-projection'));
  assert.ok(reversed.diagnostics.rejectedRelations.some(r => r.edgeId === 'component-projection' && r.reasons.includes('reverse_temporal_direction')));
});

test('short query terms match words and cannot leak through unrelated substrings', () => {
  const graph = createFieldEvolutionFixture();
  graph.addNode({ id: 'ml', type: 'Paper', name: 'ML calibration models', properties: { year: 2020 } });
  graph.addNode({ id: 'html', type: 'Paper', name: 'HTML rendering', properties: { year: 2021 } });
  assert.deepEqual(buildFieldEvolution(graph, { query: 'ML' }).papers.map(p => p.id), ['ml']);
});
