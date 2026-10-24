import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecisionRequest, validateHypothesisSet, validateActionPlan } from '../src/core/research/decision-contracts.js';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('A02 concrete competing hypotheses become testable; a module slogan remains draft', async t => {
  const f = await createDecisionFixture(t);
  await f.seed();
  const { result } = await f.call('register_hypotheses', { hypotheses: [{ hypothesis_id: 'slogan', version: 1, statement: 'Add a module to improve performance.' }] });
  assert.equal(result.hypotheses[0].design_status, 'draft');
  assert.ok(result.hypotheses[0].missing_fields.includes('predictions'));
  const status = (await f.call('status')).result;
  assert.equal(status.hypotheses[0].design_status, 'testable');
  assert.equal(status.predictions.length, 4);
  await assert.rejects(f.call('register_hypotheses', { hypotheses: f.input.hypotheses }), /invalid_version/);
});

test('operation schemas reject unknown side effects, malformed costs and bad cross references', async t => {
  for (const args of [
    { operation: 'status', project: 'p', payload: { backend: 'train' } },
    { operation: 'recommend_next', project: 'p', outputDir: '/tmp/out' },
    { operation: 'init', project: 'p', requestId: 'i', payload: { objective: 'x', goal_phase: 'mechanism_validation', budget: {}, backend: 'train' } },
    { operation: 'register_actions', project: 'p', requestId: 'i', payload: { actions: [] } }
  ]) assert.throws(() => validateDecisionRequest(args), /invalid_input/);
  const f = await createDecisionFixture(t);
  await f.seed();
  const h = structuredClone(f.input.hypotheses[0]); h.hypothesis_id = 'bad'; h.alternative_hypothesis_ids = ['missing'];
  await assert.rejects(f.call('register_hypotheses', { hypotheses: [h] }), /invalid_reference/);
  const a = structuredClone(f.input.actions[1]); a.action_id = 'bad-cost'; a.estimated_cost.upper.gpu_hours[0].amount = -1;
  await assert.rejects(f.call('register_actions', { actions: [a] }), /minimum 0/);
});

test('resource identities are unique and estimated lower bounds cannot exceed their upper bounds', async t => {
  const f = await createDecisionFixture(t);
  const budget = structuredClone(f.input.init);
  budget.budget.gpu_hours.push({ resource: 'fixture-gpu', limit: 100 });
  await assert.rejects(f.call('init', budget), /duplicate resource/);
  await f.seed();
  const a = structuredClone(f.input.actions[1]); a.action_id = 'reversed-cost';
  a.estimated_cost.lower = { gpu_hours: [{ resource: 'fixture-gpu', amount: 2 }] };
  await assert.rejects(f.call('register_actions', { actions: [a] }), /lower exceeds upper/);
  const run = f.run(); run.actual_cost.gpu_hours.push({ resource: 'fixture-gpu', amount: 0 });
  await assert.rejects(f.call('record_run', { run }), /duplicate resource/);
});

test('equivalent structured protocol fields do not depend on JSON property order', async t => {
  const f = await createDecisionFixture(t);
  for (const h of f.input.hypotheses) h.scope.preprocessing = { resize: 224, crop: 200 };
  const a = structuredClone(f.input.actions[1]); a.protocol.preprocessing = { crop: 200, resize: 224 };
  assert.equal(validateActionPlan(a, validateHypothesisSet(f.input.hypotheses)).design_status, 'testable');
});
