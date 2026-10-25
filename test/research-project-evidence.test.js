import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';
import { executeTool } from '../src/mcp/core.js';
import { executeResearchWorkflow } from '../src/mcp/research-workflows.js';
import { decisionPaths } from '../src/core/research/decision-store.js';

test('F01/F14/F16 project-only reads retrieve persisted evidence and update explicit candidate groups', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run() }); await f.assess();
  const before = await f.call('status');
  const view = await executeTool('research_decision', { operation: 'evidence_view', corpus: f.root, project: 'quality-vs-count' });
  assert.equal(view.result.observations[0].record_id, 'record-1');
  assert.ok(view.result.observations[0].prediction_refs.includes('Pq'));
  assert.ok(view.result.nodes.some(n => n.type === 'source'));
  assert.equal(view.result.based_on_revision, before.revision);
  const original = { result: { ideas: [{ candidate_id: 'near' }, { candidate_id: 'unrelated', title: 'quality filtering' }] } };
  const output = await executeResearchWorkflow('idea_generation', { operation: 'generate', project: 'quality-vs-count', corpus: f.root, query: 'quality filtering' }, {}, async () => original);
  assert.equal(output.result.result.ideas[0].project_assessment.status, 'tested_in_scope');
  assert.equal(output.result.result.ideas[1].project_assessment.status, 'unlinked');
  assert.ok(output.result.research_focus.some(h => h.run_record_ids.includes('record-1')));
  const legacy = await executeResearchWorkflow('idea_generation', { operation: 'generate', query: 'quality' }, {}, async () => original);
  assert.deepEqual(legacy.result, original);
  assert.equal((await f.call('status')).revision, before.revision);
});

test('F02/F17 live source changes invalidate feedback without a hidden refresh or write', async t => {
  const f = await createDecisionFixture(t); await f.seed(); await f.call('record_run', { run: f.run() }); await f.assess();
  const revision = f.revision();
  await fs.writeFile(f.refs[0].artifact_path, JSON.stringify({ source_id: 'source:quality', source_version: '2', admitted: false }));
  const view = (await f.call('evidence_view')).result;
  assert.equal(view.evidence_freshness.status, 'stale');
  assert.equal(view.observations[0].status, 'stale');
  assert.deepEqual(view.observations[0].conclusions, []);
  assert.ok(view.open_explanations.every(h => !h.rows.length));
  assert.equal(view.based_on_revision, revision);
});

test('F14 read queries do not initialize state and limits never hide outstanding runs or cost', async t => {
  const f = await createDecisionFixture(t);
  assert.equal((await f.call('evidence_view')).result.status, 'not_initialized');
  await assert.rejects(fs.access(decisionPaths(f.root, 'quality-vs-count').statePath), /ENOENT/);
  await f.seed(); await f.call('record_run', { run: f.run('negative', { status: 'running', cost_final: false }) });
  const view = (await f.call('evidence_view', undefined, { query: 'zzzz-unmatched-question', limit: 1 })).result;
  assert.equal(view.coverage.matched, 0);
  assert.equal(view.outstanding_runs.length, 1);
  assert.equal(view.budget.attempts, 1);
  await assert.rejects(f.call('evidence_view', undefined, { limit: 51 }), /maximum/);
});
