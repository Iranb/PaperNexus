import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';
import { executeTool } from '../src/mcp/core.js';
import { RESEARCH_TOOLS, resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';

test('F08 registered mechanism diagnosis can be ready while novelty remains unestablished', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const args = { operation: 'evaluate', purpose: 'mechanism_diagnosis', project: 'quality-vs-count', corpus: f.root, actionId: 'E1' };
  const response = await executeTool('idea_generation', args);
  assert.equal(response.result.task_gate.status, 'ready_for_design');
  assert.equal(response.result.action_version, 1);
  assert.equal(response.result.novelty_claim_allowed, false);
  assert.equal(response.result.experiment_planning_allowed, undefined);
  assert.equal(response.nextActions[0].arguments.operation, 'recommend_next');
  const summary = await executeTool('idea_generation', { ...args, responseMode: 'summary' });
  assert.deepEqual(summary.result.task_gate, response.result.task_gate);
  const performance = await executeTool('idea_generation', { ...args, purpose: 'performance_validation' });
  assert.equal(performance.result.task_gate.status, 'needs_input');
  assert.ok(performance.result.task_gate.reason_codes.includes('original_baseline_missing'));
  const missing = await executeTool('idea_generation', { ...args, actionId: 'missing' });
  assert.equal(missing.result.task_gate.status, 'needs_input');
  assert.equal((await f.call('status')).revision, 3);
});

test('F08/F16 schemas and resolver require action identity and keep default novelty requirements', () => {
  for (const args of [
    { operation: 'evaluate', purpose: 'mechanism_diagnosis' },
    { operation: 'evaluate', purpose: 'performance_validation', project: 'p' },
    { operation: 'evaluate', purpose: 'mechanism_diagnosis', project: 'p', actionId: 'a', candidateMechanism: 'override' },
    { operation: 'evaluate', query: 'q' }
  ]) assert.throws(() => resolveResearchWorkflowCall('idea_generation', args), /requires|require|override/);
  assert.equal(resolveResearchWorkflowCall('idea_generation', { operation: 'evaluate', query: 'q', candidateMechanism: 'm' }).backend, 'agent_materials');
  const branch = RESEARCH_TOOLS.find(t => t.name === 'idea_generation').inputSchema.allOf.find(s => s.if.properties.operation.const === 'evaluate');
  assert.deepEqual(branch.then.allOf[0].then.required, ['project', 'actionId']);
});
