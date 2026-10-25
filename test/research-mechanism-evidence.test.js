import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';
import { buildPaperMaterialView, paperGraphReadiness } from '../src/core/materials/agent-materials.js';
import { saveSourceManifest } from '../src/storage/corpus-store.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';

test('F09/F10/F17 code observations and compound changes retain evidence status and become stale on change', async t => {
  const f = await createDecisionFixture(t);
  const observation = { repository: 'fixture/FSGCD', code_revision: 'fixture-v1', file_path: 'loss.py', observation: 'Mask changes anchor and negative populations.' };
  const artifact = path.join(f.root, 'code-observation.json'); await fs.writeFile(artifact, JSON.stringify(observation));
  const ref = { evidence_origin: 'code_inspected', source_id: 'mask', source_version: 'fixture-v1', locator: 'loss.py:10', artifact_path: artifact, ...observation };
  f.input.hypotheses[0].mechanism_evidence = { components: [
    { id: 'mask', kind: 'code_component', statement: 'Pseudo-label exclusion mask', evidence_refs: [ref] },
    { id: 'anchors', kind: 'sample_population', statement: 'Triplet anchors', evidence_refs: [ref] },
    { id: 'negatives', kind: 'sample_population', statement: 'Triplet negatives', evidence_refs: [ref] }
  ], links: [
    { from: 'mask', to: 'anchors', relation: 'changes_population', status: 'code_observed', evidence_refs: [ref] },
    { from: 'anchors', to: 'Pq', relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [] }
  ] };
  f.input.actions[1].intervention_components = ['anchors', 'negatives'].map(component_id => ({ component_id, hypothesis_id: 'Hq', hypothesis_version: 1, held_constant: ['candidate pool'] }));
  await f.seed();
  const view = (await f.call('evidence_view')).result;
  assert.equal(view.compound_interventions[0].status, 'compound_intervention');
  assert.equal(view.mechanism_paths[0].links[0].status, 'code_observed');
  assert.equal(view.mechanism_paths[0].links[1].status, 'hypothesized');
  assert.ok(!JSON.stringify(view).includes('causal_proven'));
  await fs.writeFile(artifact, JSON.stringify({ ...observation, code_revision: 'fixture-v2' }));
  const stale = (await f.call('evidence_view')).result;
  assert.equal(stale.mechanism_paths[0].status, 'stale');
  assert.equal(stale.evidence_freshness.status, 'stale');
});

test('F11 a readable source without a semantic node yields a concrete read-only import handoff', async t => {
  const f = await createDecisionFixture(t);
  const sourcePath = path.join(f.root, 'paper.md'); await fs.writeFile(sourcePath, '# Reliable representation learning\nMethod evidence with measurable outcomes.');
  await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(createKnowledgeGraph().toJSON()));
  await saveSourceManifest(f.root, { sources: [{ sourceKey: 'paper-source', paperId: 'paper:source', paperTitle: 'Reliable representation learning',
    identifiers: { arxivId: '2401.01234' }, sourcePath, kind: 'markdown' }] });
  const before = await fs.readFile(f.paths.liteGraphPath, 'utf8');
  const view = await buildPaperMaterialView({ corpus: f.root, sourceKey: 'paper-source' });
  assert.equal(view.paper.graph_readiness.status, 'source_only');
  assert.equal(view.paper.graph_readiness.next_step.arguments.serverFilePath, sourcePath);
  assert.equal(await fs.readFile(f.paths.liteGraphPath, 'utf8'), before);
});

test('F09/F11 Corpus membership and unverified spans do not count as anchored semantic relations', () => {
  const graph = createKnowledgeGraph();
  const paper = graph.addNode({ id: 'paper:1', type: 'Paper', name: 'Paper' });
  graph.addNode({ id: 'corpus:1', type: 'Corpus', name: 'Corpus' });
  graph.addNode({ id: 'method:1', type: 'Method', name: 'Method' });
  graph.addRelationship({ id: 'membership', sourceId: 'paper:1', targetId: 'corpus:1', type: 'BELONGS_TO', properties: { quote: 'evidence' } });
  graph.addRelationship({ id: 'method-edge', sourceId: 'paper:1', targetId: 'method:1', type: 'PROPOSES', properties: { quote: 'invented' } });
  const args = [graph, graph.getNode('paper:1'), { paper_id: 'paper:1' }, [{ path: '/fixture/paper.md', text: 'evidence' }], [{}]];
  assert.equal(paperGraphReadiness(...args).status, 'node_only');
  graph.addRelationship({ id: 'anchored', sourceId: 'paper:1', targetId: 'method:1', type: 'PROPOSES', properties: { quote: 'evidence' } });
  assert.equal(paperGraphReadiness(...args).source_anchored_relation_count, 1);
});

test('F17 mechanism links can cite saved measurements and invalidate on supersession', async t => {
  const f = await createDecisionFixture(t); await f.seed(); await f.call('record_run', { run: f.run() });
  const measurement = `measurement:record-1/${f.input.quantity}/percentage_points`;
  const hypothesis = { ...structuredClone(f.input.hypotheses[0]), version: 2,
    mechanism_evidence: { components: [{ id: 'quality', kind: 'observable', statement: 'Observed quality contrast', evidence_refs: [f.refs[0]] }],
      links: [{ from: 'quality', to: measurement, relation: 'observed_with', status: 'measured_association', evidence_refs: [f.refs[0]] }] } };
  await f.call('register_hypotheses', { hypotheses: [hypothesis] });
  let view = (await f.call('evidence_view')).result;
  assert.ok(view.nodes.some(n => n.id === measurement && n.type === 'measurement'));
  assert.equal(view.mechanism_paths[0].links[0].to, measurement);
  await f.call('record_run', { run: f.run('negative', { record_id: 'record-2', source_revision: 2, supersedes_record_id: 'record-1' }) });
  view = (await f.call('evidence_view')).result;
  assert.equal(view.mechanism_paths[0].status, 'stale');
});
