import test from 'node:test';
import assert from 'node:assert/strict';
import { executeResearchWorkflow, resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';

test('new workflows validate the operation type and reject inherited operation names', () => {
  for (const operation of [['search'], {}, '__proto__', 'constructor']) {
    assert.throws(() => resolveResearchWorkflowCall('literature_review',{operation,query:'topic'}));
  }
  assert.equal(resolveResearchWorkflowCall('constructor',{}),null);
});

test('source resolution disables LLM planning and automatic import using actual backend fields', () => {
  for (const discoveryMode of ['search','resolve','run']) {
    const route=resolveResearchWorkflowCall('literature_review',{operation:'discover',query:'topic',discoveryMode});
    assert.equal(route.args.planningMode,'rule_based');
    assert.equal(route.args.llmQueryPlanner,false);
    assert.equal(route.args.processImports,false);
    assert.equal(route.args.importResolved,false);
  }
});

test('discovery follow-up waits for completion without looping completed reports or failed jobs', async () => {
  for (const [status,isTerminal,expected] of [
    ['queued',false,'discovery_status'],
    ['running',false,'discovery_status'],
    ['completed',true,'discovery_report'],
    ['failed',true,null],
    ['blocked',true,null]
  ]) {
    const result=await executeResearchWorkflow('literature_review',{operation:'discovery_status',runId:'r'}, {}, async()=>({current:{status,isTerminal}}));
    assert.equal(result.nextActions[0]?.arguments.operation || null,expected);
  }
  const report=await executeResearchWorkflow('literature_review',{operation:'discovery_report',runId:'r'}, {}, async()=>({runId:'r',status:'completed'}));
  assert.deepEqual(report.nextActions,[]);
});
