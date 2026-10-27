import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createMechanismFixture } from './fixtures/research-decision/mechanisms.js';
import { readDecisionState, decisionPaths } from '../src/core/research/decision-store.js';
import { scientificState } from '../src/core/research/hypothesis-assessment.js';
import { evaluateProjectAction } from '../src/core/research/project-evaluation.js';
import { executeTool } from '../src/mcp/core.js';
import { RESEARCH_SUMMARY_MAX_BYTES } from '../src/mcp/research-summary.js';

for (const kind of ['missing', 'assumption']) test(`G04/G14 ${kind} prediction grounds preserve observations without mechanism exclusion`, async t => {
  const f = await createMechanismFixture(t);
  for (const h of f.input.hypotheses) {
    if (kind === 'missing') delete h.predictions[0].basis;
    else h.predictions[0].basis.kind = kind;
  }
  await f.seed();
  const next = (await f.call('recommend_next', { action_ids: ['E1'] })).result;
  assert.equal(next.decision.kind, 'needs_input');
  assert.ok(next.blocked_actions[0].mechanism_test.evidence_gaps.every(g => g.kind === 'prediction_basis'));
  await f.call('record_run', { run: f.run() });
  const rows = (await f.assess()).result.assessment.rows;
  assert.equal(rows[0].relation, 'inconsistent');
  assert.ok(rows.every(r => r.status === 'inconclusive' && !r.assessment_gate.confirmatory));
  assert.ok((await f.call('status')).result.scientific_state.every(h => h.status === 'inconclusive'));
  assert.doesNotMatch((await f.call('export')).result.markdown, /excluded_in_scope|supported_in_scope/);
});

test('G03/G05/G07 missing controls choose the diagnostic that names the actual gap; revised design passes', async t => {
  const f = await createMechanismFixture(t);
  delete f.input.actions[1].controlled_components;
  const diagnostic = { ...structuredClone(f.input.actions[1]), type: 'diagnostic', action_id: 'Z-control-check',
    information_targets: [{ hypothesis_id: 'Hq', hypothesis_version: 1, kind: 'control', component_id: 'count' }] };
  const unrelated = { ...structuredClone(diagnostic), action_id: 'A-unrelated', information_targets: [
    { hypothesis_id: 'Hq', hypothesis_version: 1, kind: 'prediction_basis', prediction_id: 'Pq' }] };
  f.input.actions.push(unrelated, diagnostic);
  await f.seed();
  const selection = (await f.call('recommend_next')).result;
  assert.equal(selection.decision.action_id, 'Z-control-check');
  assert.equal(selection.decision.selection_basis.matched_information_targets[0].component_id, 'count');
  assert.ok(selection.blocked_actions.find(a => a.action_id === 'E1').reason_codes.some(r => r.startsWith('required_control_missing')));
  const state = await readDecisionState(f.root, 'quality-vs-count');
  const view = (await f.call('evidence_view')).result;
  assert.ok(evaluateProjectAction(state, view, { actionId: 'E1', purpose: 'mechanism_diagnosis' }).task_gate.reason_codes.some(r => r.startsWith('required_control_missing')));
  const fixed = { ...structuredClone(f.input.actions[1]), version: 2, controlled_components: diagnostic.hypothesis_versions.map(h => ({
    hypothesis_id: h.hypothesis_id, hypothesis_version: h.version, component_id: 'count', check: diagnostic.validity_checks[0] })) };
  await f.call('register_actions', { actions: [fixed] });
  const repaired = (await f.call('recommend_next', { action_ids: ['E1'] })).result;
  assert.equal(repaired.decision.kind, 'execute_action');
  assert.equal(repaired.decision.mechanism_test.status, 'ready');
});

test('G06 unplanned or failed controls never yield a mechanism winner', async t => {
  const f = await createMechanismFixture(t); delete f.input.actions[1].controlled_components; await f.seed();
  await f.call('record_run', { run: f.run() });
  let rows = (await f.assess()).result.assessment.rows;
  assert.ok(rows.every(r => r.status === 'inconclusive' && r.assessment_gate.valid && !r.assessment_gate.confirmatory));
  const g = await createMechanismFixture(t); await g.seed();
  await g.call('record_run', { run: g.run('negative', { intervention_checks: [{ check: g.input.actions[1].validity_checks[0], passed: false, reference: 'synthetic/failure' }] }) });
  rows = (await g.assess()).result.assessment.rows;
  assert.ok(rows.every(r => r.status === 'unassessable' && !r.assessment_gate.confirmatory));
  assert.ok(rows[0].assessment_gate.mechanism_test.control_requirements.every(c => c.status === 'not_verified'));
});

test('G09/G10 identical current designs reuse evidence, while replication, new protocols and wide intervals remain separate', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  await f.call('record_run', { run: f.run() }); await f.assess();
  const duplicate = { ...structuredClone(f.input.actions[1]), action_id: 'renamed-control' };
  duplicate.analysis.analysis_set_id = 'new-registration';
  await f.call('register_actions', { actions: [duplicate] });
  let result = (await f.call('recommend_next', { action_ids: ['renamed-control'] })).result;
  assert.equal(result.decision.kind, 'reuse_evidence');
  assert.equal(result.decision.reusable_evidence[0].record_id, 'record-1');
  assert.equal((await f.call('recommend_next', { action_ids: ['E3'] })).result.decision.kind, 'execute_action');
  duplicate.version = 2; duplicate.protocol.steps = 101;
  await f.call('register_actions', { actions: [duplicate] });
  result = (await f.call('recommend_next', { action_ids: ['renamed-control'] })).result;
  assert.notEqual(result.decision.kind, 'reuse_evidence');
  const g = await createMechanismFixture(t); await g.seed();
  await g.call('record_run', { run: g.run('wide') }); await g.assess();
  const uncertain = { ...structuredClone(g.input.actions[1]), action_id: 'still-unresolved' };
  await g.call('register_actions', { actions: [uncertain] });
  assert.equal((await g.call('recommend_next', { action_ids: ['still-unresolved'] })).result.decision.kind, 'execute_action');
});

test('G11 stale sources block selection and reuse without changing revision or ledger', async t => {
  const f = await createMechanismFixture(t); await f.seed();
  await f.call('record_run', { run: f.run() }); await f.assess();
  await f.call('register_actions', { actions: [{ ...structuredClone(f.input.actions[1]), action_id: 'duplicate' }] });
  const before = (await f.call('evidence_view')).result;
  await fs.writeFile(f.refs[0].artifact_path, JSON.stringify({ source_id: f.refs[0].source_id, source_version: '2', admitted: true, evidence_origin: 'synthetic_fixture' }));
  const next = (await f.call('recommend_next', { action_ids: ['duplicate'] })).result;
  assert.equal(next.decision.kind, 'needs_input');
  assert.equal(next.based_on_revision, before.based_on_revision);
  assert.deepEqual(next.budget, before.budget);
  assert.ok(next.mechanism_analysis.hypotheses.some(h => h.status === 'stale'));
});

test('G13 summary and full retain the same design gaps and export exposes basis requirements', async t => {
  const f = await createMechanismFixture(t); delete f.input.actions[1].controlled_components; await f.seed();
  const args = { operation: 'recommend_next', corpus: f.root, project: 'quality-vs-count', payload: { action_ids: ['E1'] } };
  const full = await executeTool('research_decision', args);
  const summary = await executeTool('research_decision', { ...args, responseMode: 'summary' });
  assert.equal(summary.result.decision.kind, full.result.decision.kind);
  assert.deepEqual(summary.result.blocked_actions[0].reason_codes, full.result.blocked_actions[0].reason_codes);
  assert.equal(summary.presentation.evidence_gates.decision.kind, 'needs_input');
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) <= RESEARCH_SUMMARY_MAX_BYTES);
  assert.match((await f.call('export')).result.markdown, /discriminating-action-v4/);
});

test('G14 old assessments retain raw records while current scientific state requires mechanism reassessment', async t => {
  const f = await createMechanismFixture(t); await f.seed(); await f.call('record_run', { run: f.run() }); await f.assess();
  const state = await readDecisionState(f.root, 'quality-vs-count');
  for (const row of state.assessments[0].rows) delete row.assessment_gate.mechanism_test;
  const historical = structuredClone(state.assessments);
  assert.ok(scientificState(state).every(h => h.status === 'inconclusive'));
  assert.deepEqual(state.assessments, historical);
  assert.equal(historical[0].rows[0].status, 'excluded_in_scope');
  await fs.writeFile(decisionPaths(f.root, 'quality-vs-count').statePath, JSON.stringify(state));
  const exported = (await f.call('export', undefined, { assessmentId: state.assessments[0].assessment_id })).result;
  assert.equal(exported.json.rows[0].status, 'excluded_in_scope');
  assert.ok(exported.json.current_scientific_state.every(h => h.status === 'inconclusive'));
  assert.doesNotMatch(exported.markdown, /excluded_in_scope|supported_in_scope/);
});

test('G15 retrieval mechanisms use the same controls and source rules', async t => {
  const f = await createMechanismFixture(t, { retrieval: true }); await f.seed();
  const recommendation = (await f.call('recommend_next')).result;
  assert.equal(recommendation.decision.mechanism_test.status, 'ready');
  assert.ok(recommendation.decision.distinguishes[0].quantity.startsWith('recall_at_10'));
  await f.call('record_run', { run: f.run() });
  assert.equal((await f.assess()).result.assessment.rows[0].status, 'excluded_in_scope');
});


test('G14 diagnosis checks the action-bound version after newer hypotheses are registered', async t => {
  const f = await createMechanismFixture(t); delete f.input.actions[1].controlled_components; await f.seed();
  await f.call('register_hypotheses', { hypotheses: f.input.hypotheses.map(h => ({ ...h, version: 2 })) });
  const state = await readDecisionState(f.root, 'quality-vs-count');
  const view = (await f.call('evidence_view')).result;
  const result = evaluateProjectAction(state, view, { actionId: 'E1', actionVersion: 1, purpose: 'mechanism_diagnosis' });
  assert.equal(result.task_gate.status, 'needs_input');
  assert.ok(result.task_gate.reason_codes.some(r => r.startsWith('required_control_missing')));
});

test('G04 assessing one hypothesis does not confer grounds on the unassessed alternative', async t => {
  const f = await createMechanismFixture(t); delete f.input.hypotheses[1].predictions[0].basis; await f.seed();
  await f.call('record_run', { run: f.run() });
  const assessed = (await f.call('assess_results', { run_record_ids: ['record-1'], hypothesis_versions: [{ hypothesis_id: 'Hq', version: 1 }] })).result;
  assert.equal(assessed.assessment.rows[0].status, 'excluded_in_scope');
  assert.ok(!assessed.assessment.hypotheses.some(h => h.hypothesis_id === 'Hn' && h.status === 'supported_in_scope'));
});
