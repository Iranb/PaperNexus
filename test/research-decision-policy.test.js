import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFixture, EXPECTATIONS } from './fixtures/research-decision/scenarios.js';

test('A03/A11 prioritize a discriminating control, then change the action after negative evidence', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const first = (await f.call('recommend_next')).result;
  assert.equal(first.decision.action_id, EXPECTATIONS.first_action);
  assert.ok(first.blocked_actions.find(a => a.action_id === 'E0').reason_codes.includes('does_not_distinguish_explanations'));
  assert.equal(first.budget.dimensions['gpu_hours:fixture-gpu'].spent, 0);
  await f.call('record_run', { run: f.run('negative', { recommendation_ref: first.recommendation_ref }) });
  assert.equal((await f.call('recommend_next')).result.decision.kind, 'assess_results');
  await f.assess();
  assert.equal((await f.call('recommend_next')).result.decision.action_id, EXPECTATIONS.negative_next_action);
});

test('A11 a wide result asks for a precision follow-up, not an explanation winner', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run('wide') }); await f.assess();
  assert.equal((await f.call('recommend_next')).result.decision.action_id, EXPECTATIONS.inconclusive_next_action);
  assert.equal((await f.call('recommend_next', { action_ids: ['E4'] })).result.decision.action_id, EXPECTATIONS.inconclusive_next_action);
});

test('A15 retrieval case uses its own measurements and produces the same logical discrimination', async t => {
  const f = await createDecisionFixture(t, { retrieval: true }); await f.seed();
  assert.equal((await f.call('recommend_next')).result.decision.action_id, 'E1');
  await f.call('record_run', { run: f.run() });
  const result = (await f.assess()).result;
  assert.deepEqual(Object.fromEntries(result.assessment.hypotheses.map(h => [h.hypothesis_id, h.status])), EXPECTATIONS.negative_statuses);
  assert.ok(result.assessment.rows.every(r => r.quantity.startsWith('recall_at_10')));
});

test('A09 outstanding attempts route to wait or reconciliation instead of repeated execution', async t => {
  for (const [status, expected] of [['running', 'await_run'], ['queued', 'await_run'], ['unknown_after_timeout', 'reconcile_run']]) {
    const f = await createDecisionFixture(t); await f.seed();
    await f.call('record_run', { run: f.run('negative', { status, cost_final: false }) });
    assert.equal((await f.call('recommend_next')).result.decision.kind, expected);
  }
});
