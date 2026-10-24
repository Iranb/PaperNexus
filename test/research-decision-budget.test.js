import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFixture, EXPECTATIONS } from './fixtures/research-decision/scenarios.js';

test('A08/A09 cumulative updates and replays charge each attempt once, including failed work', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const running = f.run('negative', { status: 'running', cost_final: false, actual_cost: { gpu_hours: [{ resource: 'fixture-gpu', amount: 0.4 }], provider_calls: 0 } });
  await f.call('record_run', { run: running });
  let balance = (await f.call('status')).result.budget.dimensions['gpu_hours:fixture-gpu'];
  assert.equal(balance.spent, 0.4); assert.equal(balance.committed, 1.1);
  const finished = { ...running, record_id: 'record-2', source_revision: 2, supersedes_record_id: 'record-1', status: 'failed', cost_final: true,
    actual_cost: { gpu_hours: [{ resource: 'fixture-gpu', amount: EXPECTATIONS.spent }], provider_calls: 0 } };
  await f.call('record_run', { run: finished });
  await f.call('record_run', { run: finished });
  await f.call('record_run', { run: running });
  balance = (await f.call('status')).result.budget.dimensions['gpu_hours:fixture-gpu'];
  assert.equal(balance.spent, EXPECTATIONS.spent); assert.equal(balance.remaining, EXPECTATIONS.remaining); assert.equal(balance.committed, 0);
});

test('A09 missing monetary cost remains unknown and actual overspend is preserved', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('update_opportunities', { changes: [{ op: 'set_budget', reason: 'Add explicit monetary cap', budget: { ...f.input.init.budget, money: [{ currency: 'USD', limit: 10 }] } }] });
  await f.call('record_run', { run: f.run('negative', { actual_cost: { gpu_hours: [{ resource: 'fixture-gpu', amount: 8 }], provider_calls: 0 } }) });
  const ledger = (await f.call('status')).result.budget;
  assert.equal(ledger.dimensions['money:USD'].remaining, null);
  assert.equal(ledger.dimensions['gpu_hours:fixture-gpu'].remaining, -2);
  assert.equal(ledger.over_budget, true);
  await f.assess();
  assert.notEqual((await f.call('recommend_next')).result.decision.kind, 'execute_action');
});

test('A09 recommendation reads do not reserve budget and unknown cost requests profiling', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const revision = f.revision();
  for (let i = 0; i < 3; i++) await f.call('recommend_next');
  assert.equal(f.revision(), revision);
  assert.equal((await f.call('status')).result.budget.attempts, 0);
  const action = structuredClone(f.input.actions[1]); action.action_id = 'unknown'; delete action.estimated_cost;
  await f.call('register_actions', { actions: [action] });
  const recommendation = (await f.call('recommend_next', { action_ids: ['unknown'] })).result;
  assert.equal(recommendation.decision.kind, 'needs_input');
  assert.match(recommendation.decision.next_step, /profile_cost/);
});
