import test from 'node:test';
import assert from 'node:assert/strict';
import { createMechanismFixture } from './fixtures/research-decision/mechanisms.js';
import { readDecisionState } from '../src/core/research/decision-store.js';
import { buildMechanismAnalysis, assessMechanismTest, predictionBasis } from '../src/core/research/mechanism-analysis.js';
import { validateActionPlan, validateHypothesisSet } from '../src/core/research/decision-contracts.js';
import { evidenceKey } from '../src/core/research/decision-evidence.js';

test('G02/G03 semantic references preserve source status and enforce directed endpoint identity', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  const state = await readDecisionState(f.root, 'quality-vs-count');
  const h = state.hypotheses[0];
  const ref = { evidence_origin: 'paper_reported', source_id: 'paper:1', source_version: '1', locator: 'methods' };
  const components = h.mechanism_evidence.components;
  components[0].graph_node_id = 'method:1'; components[0].evidence_refs = [ref];
  components.push({ id: 'observable', kind: 'observable', statement: 'Measured effect', evidence_refs: [], graph_node_id: 'outcome:1' });
  components[2].evidence_refs = [ref];
  h.mechanism_evidence.links = [
    { from: 'selection', to: 'observable', relation: 'proposes_effect', status: 'source_supported', evidence_refs: [ref], graph_relation_ids: ['edge:1'], required_controls: ['count'] },
    { from: 'observable', to: 'Pq', relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [] }
  ];
  state.evidence_snapshots.push({ key: evidenceKey(ref), ref, admitted: true, mechanism_context: { status: 'available',
    nodes: [{ id: 'method:1' }, { id: 'outcome:1' }], relations: [{ relationship_id: 'edge:1', from: 'method:1', to: 'outcome:1', status: 'source_anchored' }],
    paths: [], coverage: { truncated: false } } });
  let analysis = buildMechanismAnalysis(state);
  assert.equal(analysis.source_context[0].status, 'current');
  assert.equal(analysis.hypotheses[0].links[0].evidence_status, 'current');
  assert.equal(analysis.hypotheses[0].links[0].status, 'source_supported');
  assert.equal(analysis.hypotheses[0].paths[0].status, 'source_backed_hypothesis');
  state.evidence_snapshots.at(-1).mechanism_context.relations[0].to = 'different-outcome';
  analysis = buildMechanismAnalysis(state);
  assert.ok(analysis.hypotheses[0].links[0].reason_codes.includes('graph_endpoints_not_connected'));
  assert.equal(assessMechanismTest(state.actions[1], analysis).status, 'needs_input');
  assert.equal(analysis.hypotheses[0].paths[0].status, 'unverified');
  state.evidence_snapshots.at(-1).mechanism_context.relations = [];
  assert.ok(buildMechanismAnalysis(state).hypotheses[0].links[0].reason_codes.includes('graph_relation_unverified'));
});

test('G03/G11 observed measurements appear on paths and superseded dependencies invalidate them', async t => {
  const f = await createMechanismFixture(t); await f.seed(); await f.call('record_run', { run: f.run() });
  const id = `measurement:record-1/${f.input.quantity}/percentage_points`;
  const hypothesis = { ...structuredClone(f.input.hypotheses[0]), version: 2 };
  hypothesis.mechanism_evidence.links = [
    { from: 'selection', to: id, relation: 'observed_with', status: 'measured_association', evidence_refs: [f.refs[0]] },
    { from: id, to: 'Pq', relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [], required_controls: ['count'] }
  ];
  await f.call('register_hypotheses', { hypotheses: [hypothesis] });
  let analysis = (await f.call('evidence_view')).result.mechanism_analysis;
  assert.deepEqual(analysis.hypotheses.find(h => h.hypothesis_id === 'Hq').paths[0].measurement_ids, [id]);
  await f.call('record_run', { run: f.run('negative', { record_id: 'updated', source_revision: 2, supersedes_record_id: 'record-1' }) });
  analysis = (await f.call('evidence_view')).result.mechanism_analysis;
  assert.equal(analysis.hypotheses.find(h => h.hypothesis_id === 'Hq').paths[0].status, 'unverified');
});

test('G02 graph paths stay bounded on branching feedback and disclose truncation', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  const state = await readDecisionState(f.root, 'quality-vs-count');
  const h = state.hypotheses[0];
  h.mechanism_evidence.components = Array.from({ length: 35 }, (_, i) => ({ id: `c${i}`, kind: 'observable', statement: `state ${i}`, evidence_refs: h.evidence_refs }));
  h.mechanism_evidence.links = h.mechanism_evidence.components.flatMap(c => [
    ...h.mechanism_evidence.components.filter(d => c !== d).map(d => ({ from: c.id, to: d.id, relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [] })),
    { from: c.id, to: 'Pq', relation: 'proposes_effect', status: 'hypothesized', evidence_refs: [] }
  ]);
  const analysis = buildMechanismAnalysis(state);
  assert.ok(analysis.coverage.truncated);
  assert.ok(analysis.hypotheses[0].paths.filter(p => p.prediction_id === 'Pq').length <= 24);
  assert.ok(analysis.hypotheses[0].paths.every(p => p.link_ids.length <= 6));
});

test('G14 supported declarations reject ambiguous component identities and contradictory controls', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  const h = structuredClone(f.input.hypotheses[0]); h.mechanism_evidence.components[0].id = 'Pq';
  assert.throws(() => validateHypothesisSet([h], f.input.hypotheses), /overlaps/);
  const action = structuredClone(f.input.actions[1]); action.controlled_components[0].component_id = 'selection';
  assert.throws(() => validateActionPlan(action, f.input.hypotheses), /both changed and held constant/);
  action.controlled_components[0].component_id = 'count'; action.controlled_components[0].check = 'unregistered';
  assert.throws(() => validateActionPlan(action, f.input.hypotheses), /control check/);
  const p = f.input.hypotheses[0].predictions[0];
  assert.equal(predictionBasis(p).status, 'missing');
  const state = await readDecisionState(f.root, 'quality-vs-count');
  assert.equal(predictionBasis(p, state.evidence_snapshots).status, 'documented');
  assert.equal(predictionBasis(p, state.evidence_snapshots, [evidenceKey(f.refs[0])]).status, 'stale');
  const analysis = buildMechanismAnalysis(state);
  assert.equal(assessMechanismTest(state.actions[1], analysis).status, 'ready');
});

for (const dimension of ['comparison_id', 'unit', 'protocol']) test(`G08 cost dominance keeps different ${dimension} separate`, async t => {
  const f = await createMechanismFixture(t);
  const action = { ...structuredClone(f.input.actions[1]), action_id: 'Z-more-expensive' };
  action.estimated_cost.upper.gpu_hours[0].amount = 2;
  if (dimension === 'protocol') action.protocol.steps++;
  else {
    for (const h of f.input.hypotheses) {
      const p = { ...structuredClone(h.predictions[0]), prediction_id: `${h.predictions[0].prediction_id}-other`, [dimension]: 'other' };
      h.predictions.push(p);
      h.mechanism_evidence.links.push({ ...structuredClone(h.mechanism_evidence.links[0]), to: p.prediction_id });
    }
    action.prediction_ids = ['Pq-other', 'Pn-other'];
  }
  f.input.actions.push(action); await f.seed();
  const result = (await f.call('recommend_next', { action_ids: ['E1', 'Z-more-expensive'] })).result;
  assert.equal(result.decision.action_id, 'E1');
  assert.deepEqual(result.alternatives[0].dominated_by, []);
});


test('G05 bounded path enumeration never hides a declared upstream control', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  const state = await readDecisionState(f.root, 'quality-vs-count');
  const h = state.hypotheses[0];
  const initial = h.mechanism_evidence.links[0];
  h.mechanism_evidence.links = Array.from({ length: 30 }, (_, i) => ({ ...initial, required_controls: i === 29 ? ['count'] : [] }));
  const action = state.actions[1]; action.controlled_components = [];
  const analysis = buildMechanismAnalysis(state);
  assert.ok(analysis.hypotheses[0].coverage.truncated);
  assert.ok(assessMechanismTest(action, analysis).control_requirements.some(c => c.hypothesis_id === h.hypothesis_id && c.status === 'missing'));
});
