import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';
import { actionDiscrimination } from '../src/core/research/action-policy.js';
import { summarizeResearchEnvelope, RESEARCH_SUMMARY_MAX_BYTES } from '../src/mcp/research-summary.js';

test('F12 uncertain full controls choose a registered precision diagnostic, otherwise request evidence', async t => {
  const f = await createDecisionFixture(t);
  const control = f.input.actions[1]; control.precision = { max_interval_width: 3 };
  f.input.actions = [control]; await f.seed();
  const blocked = (await f.call('recommend_next')).result;
  assert.equal(blocked.decision.kind, 'needs_input');
  assert.match(blocked.decision.next_step, /precision diagnostic/);
  const pair = actionDiscrimination(control, f.input.hypotheses, []).potentially_discriminating[0];
  assert.equal(pair.required_interval_width, 0.5);
  assert.equal(pair.planned_max_interval_width, 3);
  assert.equal(pair.achievability_status, 'unknown');
  const diagnostic = { ...structuredClone(control), action_id: 'precision-diagnostic', type: 'diagnostic', estimated_cost: { upper: { gpu_hours: [{ resource: 'fixture-gpu', amount: 0.1 }], provider_calls: 0 } } };
  await f.call('register_actions', { actions: [diagnostic] });
  assert.equal((await f.call('recommend_next')).result.decision.action_id, 'precision-diagnostic');
});

test('F12 bounded exploration remains available with an explicit precision limitation', async t => {
  const f = await createDecisionFixture(t);
  const action = f.input.actions[1]; action.precision = { max_interval_width: 3 }; action.exploration = true;
  action.estimated_cost.upper.gpu_hours[0].amount = 0.5; f.input.actions = [action];
  await f.seed();
  const result = (await f.call('recommend_next')).result;
  assert.equal(result.decision.kind, 'execute_action');
  assert.match(result.decision.reason, /does not establish sufficient precision/);
});

test('F15 oversized project summaries preserve gates and expand with a read-only evidence_view', () => {
  const result = { task_gate: { status: 'needs_input', reason_codes: ['uncertainty_not_established'] }, comparison_summary: Array.from({ length: 200 }, () => ({ status: 'inconclusive', text: 'x'.repeat(1000) })),
    budget: { attempts: 1 }, outstanding_runs: [{ record_id: 'pending', status: 'running' }] };
  const summary = summarizeResearchEnvelope({ tool: 'research_decision', operation: 'evidence_view', result, nextActions: [] }, { operation: 'evidence_view', project: 'p' });
  assert.equal(summary.presentation.read_more.arguments.operation, 'evidence_view');
  assert.equal(summary.presentation.evidence_gates.task_gate.status, 'needs_input');
  assert.equal(summary.presentation.evidence_gates.comparison_summary.status, 'read_full_required');
  assert.deepEqual(summary.presentation.evidence_gates.outstanding_runs, result.outstanding_runs);
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) <= RESEARCH_SUMMARY_MAX_BYTES);
});
