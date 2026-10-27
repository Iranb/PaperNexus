import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeTool } from '../src/mcp/core.js';
import { handleMcpHttpRequest } from '../src/mcp/http.js';
import { RESEARCH_DECISION_TOOL } from '../src/mcp/tool-research-decision.js';
import { RESEARCH_SUMMARY_MAX_BYTES } from '../src/mcp/research-summary.js';
import { createMechanismFixture as createDecisionFixture } from './fixtures/research-decision/mechanisms.js';

const execFileAsync = promisify(execFile);

test('A13 decision schema snapshot and capabilities advertise every implemented operation', async () => {
  const snapshotPath = new URL('./fixtures/research-decision/tool.snapshot.json', import.meta.url);
  const snapshot = JSON.stringify(RESEARCH_DECISION_TOOL, null, 2) + '\n';
  if (process.env.UPDATE_PAPERNEXUS_DECISION_SCHEMA === '1') await fs.writeFile(snapshotPath, snapshot);
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), snapshot);
  const capabilities = await executeTool('literature_review', { operation: 'capabilities' });
  assert.deepEqual(capabilities.result.workflows.research_decision, RESEARCH_DECISION_TOOL.inputSchema.properties.operation.enum);
});

test('A13 summary writes recover by status and retain gates within the wire budget', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const envelope = await executeTool('research_decision', { operation: 'register_hypotheses', corpus: f.root, project: 'quality-vs-count',
    requestId: 'large-hypotheses', expectedRevision: f.revision(), responseMode: 'summary',
    payload: { hypotheses: Array.from({ length: 50 }, (_, i) => ({ hypothesis_id: `draft-${i}`, version: 1, statement: 'Long draft '.repeat(700) })) } });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope, null, 2)) <= RESEARCH_SUMMARY_MAX_BYTES);
  assert.equal(envelope.presentation.read_more.arguments.operation, 'status');
  assert.equal(envelope.presentation.read_more.arguments.requestId, 'large-hypotheses');
  const full = await executeTool(envelope.presentation.read_more.tool, envelope.presentation.read_more.arguments);
  assert.equal(full.result.receipt.response.result.hypotheses.length, 50);
  assert.equal(full.revision, envelope.revision);
  const recommendation = await executeTool('research_decision', { operation: 'recommend_next', corpus: f.root, project: 'quality-vs-count', responseMode: 'summary' });
  assert.deepEqual(recommendation.result.budget_gate, recommendation.presentation.evidence_gates.budget_gate);
  assert.match(recommendation.presentation.evidence_gates.execution_authority, /does not launch/);
});

async function exerciseLoop(rpc, f, project) {
  let revision = 0, request = 0;
  const call = async (operation, payload, mutation = false, extra = {}) => {
    const response = await rpc('tools/call', { name: 'research_decision', arguments: { operation, corpus: f.root, project,
      ...(payload === undefined ? {} : { payload }), ...(mutation ? { requestId: `${project}-${++request}`, ...(operation === 'init' ? {} : { expectedRevision: revision }) } : {}), ...extra } });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const result = JSON.parse(response.result.content[0].text);
    revision = result.revision;
    return result;
  };
  assert.equal((await rpc('tools/list', {})).result.tools.length, 4);
  await call('init', f.input.init, true);
  await call('register_hypotheses', { hypotheses: f.input.hypotheses }, true);
  await call('register_actions', { actions: f.input.actions }, true);
  const first = await call('recommend_next');
  assert.equal(first.result.decision.action_id, 'E1');
  assert.equal(first.result.decision.mechanism_test.status, 'ready');
  assert.equal(first.result.decision.mechanism_test.control_requirements.length, 2);
  const run = f.run('negative', { registration_receipt: `${project}-3`, recommendation_ref: first.result.recommendation_ref });
  await call('record_run', { run }, true);
  const assessed = await call('assess_results', { run_record_ids: ['record-1'], hypothesis_versions: [{ hypothesis_id: 'Hq', version: 1 }, { hypothesis_id: 'Hn', version: 1 }] }, true);
  assert.equal(assessed.result.assessment.rows[0].status, 'excluded_in_scope');
  assert.equal((await call('recommend_next')).result.decision.action_id, 'E3');
  const evidence = await call('evidence_view');
  assert.equal(evidence.result.observations[0].record_id, 'record-1');
  assert.equal(evidence.result.coverage.returned, 1);
  assert.equal(evidence.result.mechanism_analysis.hypotheses[0].paths[0].status, 'source_backed_hypothesis');
  assert.match((await call('export')).result.markdown, /excluded_in_scope/);
  return call;
}

async function httpFixture(t) {
  const server = http.createServer((request, response) => {
    void handleMcpHttpRequest(request, response, { toolProfile: 'research' }).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let id = 0;
  const rpc = async (method, params) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10000) })).json();
  return { url, rpc };
}

test('A13 real HTTP MCP completes a loop and the canonical Python client uses the same state', { timeout: 30000 }, async t => {
  const f = await createDecisionFixture(t);
  const { url, rpc } = await httpFixture(t);
  await exerciseLoop(rpc, f, 'http-project');
  const requestFile = path.join(f.root, 'request.json');
  await fs.writeFile(requestFile, JSON.stringify({ operation: 'evidence_view', corpus: f.root, project: 'http-project' }));
  const { stdout } = await execFileAsync('python3', ['SKILL/PaperNexus/scripts/pn_research_decision.py', '--request-file', requestFile, '--mcp-url', url, '--json'], {
    env: { ...process.env, PAPERNEXUS_ALLOW_LOCAL_MCP: '1', PAPERNEXUS_API_TOKEN: 'fixture-token' }
  });
  assert.equal(JSON.parse(stdout).result.budget.dimensions['gpu_hours:fixture-gpu'].spent, 1.2);
  assert.equal(JSON.parse(stdout).result.observations[0].record_id, 'record-1');
  assert.equal(JSON.parse(stdout).result.mechanism_analysis.hypotheses[0].predictions[0].basis.status, 'documented');
});

test('A13 real stdio MCP completes the same loop', { timeout: 30000 }, async t => {
  const f = await createDecisionFixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import {startMcpServer} from './src/mcp/stdio.js'; startMcpServer();"], {
    env: { ...process.env, PAPERNEXUS_MCP_TOOL_PROFILE: 'research' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(async () => { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; });
  let buffer = Buffer.alloc(0), id = 0;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const split = buffer.indexOf('\r\n\r\n'); if (split < 0) break;
      const size = Number(buffer.subarray(0, split).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (buffer.length < split + 4 + size) break;
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + size).toString());
      buffer = buffer.subarray(split + 4 + size);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const messageId = ++id;
    pending.set(messageId, resolve);
    const body = JSON.stringify({ jsonrpc: '2.0', id: messageId, method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  await exerciseLoop(rpc, f, 'stdio-project');
});
