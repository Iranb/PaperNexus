import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildPaperMaterialView } from '../src/core/materials/agent-materials.js';
import { saveSourceManifest } from '../src/storage/corpus-store.js';
import { inspectEvidence, changedEvidence } from '../src/core/research/decision-evidence.js';
import { buildPaperMechanismContext } from '../src/core/research/mechanism-graph.js';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('G01/G02 source-backed paths come from the persisted graph and retain source/version boundaries', async t => {
  const f = await createDecisionFixture(t);
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'paper:selection', type: 'Paper', name: 'Controlled sample selection for representation learning' });
  graph.addNode({ id: 'method:selection', type: 'Method', name: 'Reliability weighting' });
  graph.addNode({ id: 'factor:count', type: 'Assumption', name: 'Matched sample count' });
  graph.addNode({ id: 'corpus:test', type: 'Corpus', name: 'Fixture' });
  const quote1 = 'Reliability weights change which examples contribute to the objective.';
  const quote2 = 'The contrast holds sample count constant to separate selection from count.';
  const file = path.join(f.root, 'selection.md');
  await fs.writeFile(file, `# Controlled sample selection for representation learning\n${quote1}\n${quote2}\n`);
  const add = (id, from, to, quote, owner = 'paper:selection') => graph.addRelationship({ id, type: 'CONSTRAINS', sourceId: from, targetId: to,
    properties: { paperId: owner, evidenceText: quote } });
  add('r-method', 'paper:selection', 'method:selection', quote1);
  add('r-control', 'method:selection', 'factor:count', quote2);
  add('r-other-version', 'method:selection', 'factor:count', quote2, 'paper:selection-v2');
  add('r-invented', 'method:selection', 'factor:count', 'No matched control is necessary.');
  graph.addRelationship({ id: 'membership', type: 'CONTAINS', sourceId: 'corpus:test', targetId: 'paper:selection', properties: { quote: quote1 } });
  await saveSourceManifest(f.root, { sources: [{ sourceKey: 'selection-v1', paperId: 'paper:selection',
    paperTitle: 'Controlled sample selection for representation learning', sourcePath: file, kind: 'markdown' }] });
  await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  const view = await buildPaperMaterialView({ corpus: f.root, sourceKey: 'selection-v1' });
  const context = view.mechanism_context;
  assert.ok(context.paths.some(p => p.status === 'source_anchored' && p.relationship_ids.length === 2));
  assert.deepEqual(context.relations.filter(r => r.status === 'source_anchored').map(r => r.relationship_id).sort(), ['r-control', 'r-method']);
  assert.ok(context.relations.find(r => r.relationship_id === 'r-other-version').reason_codes.includes('source_identity_mismatch'));
  assert.ok(context.relations.find(r => r.relationship_id === 'r-invented').reason_codes.includes('source_span_unverified'));
  assert.ok(!context.relations.some(r => r.relationship_id === 'membership'));
  const ref = { evidence_origin: 'paper_reported', source_id: 'paper:selection', paper_id: 'paper:selection', source_key: 'selection-v1', source_version: 'selection-v1', locator: 'Method' };
  f.input.hypotheses[0].evidence_refs = [ref];
  f.input.hypotheses[0].mechanism_evidence = { components: [
    { id: 'selection', kind: 'source_claim', statement: quote1, evidence_refs: [ref], graph_node_id: 'method:selection' },
    { id: 'count', kind: 'sample_population', statement: quote2, evidence_refs: [ref], graph_node_id: 'factor:count' }
  ], links: [
    { from: 'selection', to: 'count', relation: 'changes_population', status: 'source_supported', evidence_refs: [ref], graph_relation_ids: ['r-control'] },
    { from: 'count', to: 'Pq', relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [], required_controls: ['count'] }
  ] };
  f.input.actions[1].intervention_components = [{ hypothesis_id: 'Hq', hypothesis_version: 1, component_id: 'selection', held_constant: ['count'] }];
  f.input.actions[1].controlled_components = [{ hypothesis_id: 'Hq', hypothesis_version: 1, component_id: 'count', check: f.input.actions[1].validity_checks[0] }];
  await f.seed();
  const projectBefore = (await f.call('evidence_view')).result;
  assert.equal(projectBefore.mechanism_analysis.hypotheses.find(h => h.hypothesis_id === 'Hq').links[0].evidence_status, 'current');
  assert.equal((await f.call('recommend_next', { action_ids: ['E1'] })).result.decision.mechanism_test.status, 'ready');
  const before = await inspectEvidence(f.root, [ref]);
  assert.equal(before[0].admitted, true);
  graph.removeRelationship('r-control');
  await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  const after = await inspectEvidence(f.root, [ref]);
  assert.equal(changedEvidence(before, after).length, 1);
  assert.ok(!after[0].mechanism_context.relations.some(r => r.relationship_id === 'r-control'));
  const projectAfter = (await f.call('evidence_view')).result;
  assert.equal(projectAfter.evidence_freshness.status, 'stale');
  assert.equal(projectAfter.based_on_revision, projectBefore.based_on_revision);
  assert.deepEqual(projectAfter.budget, projectBefore.budget);
  assert.equal((await f.call('recommend_next', { action_ids: ['E1'] })).result.decision.kind, 'needs_input');
});

test('G01 bounded graph reads report coverage limits and terminate on feedback cycles', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'p', type: 'Paper', name: 'P' });
  for (let i = 0; i < 8; i++) graph.addNode({ id: `m${i}`, type: 'Method', name: `M${i}` });
  for (let i = 0; i < 8; i++) graph.addRelationship({ id: `r${i}`, type: 'USES', sourceId: i ? `m${i - 1}` : 'p', targetId: `m${i}`,
    properties: { paperId: 'p', quote: 'Source evidence.' } });
  graph.addRelationship({ id: 'cycle', type: 'USES', sourceId: 'm2', targetId: 'm0', properties: { paperId: 'p', quote: 'Source evidence.' } });
  const result = buildPaperMechanismContext(graph, graph.getNode('p'), { paper_id: 'p' }, [{ path: '/source', text: 'Source evidence.' }], { maxRelations: 2 });
  assert.equal(result.relations.length, 2);
  assert.equal(result.coverage.truncated, true);
  assert.ok(result.relations.every(r => r.status === 'source_anchored'));
});
