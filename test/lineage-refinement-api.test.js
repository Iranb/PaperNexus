import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import { serveCommand } from '../src/server/http.js';
import { executeTool } from '../src/mcp/core.js';
import { resolveResearchWorkflowCall, researchCapabilities } from '../src/mcp/research-workflows.js';
import { refinementFixture } from './helpers/lineage-refinement-fixture.js';
process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
const idleWorker = () => ({ stop() {}, pollNow() {} });

test('HTTP and MCP expose one authenticated refinement and preview/publication flow', async () => {
  const f = await refinementFixture(); let server;
  try {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    server = await serveCommand({ ...f.options, host: '127.0.0.1', port, rootPaths: [f.root], apiToken: 'fixture-api-token',
      config: { llm: { provider: 'deepseek', model: 'fixture', apiKey: 'fixture' }, serve: { mcp: { enabled: true } } },
      enableEnhancements: false, startImportWorker: idleWorker, startAuthoritativeSyncWorker: idleWorker,
      enableFastMdImportLane: false, enableMineruWarmup: false, enableDoclingWarmup: false,
      enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
    const url = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: 'Bearer fixture-api-token', 'content-type': 'application/json' };
    const endpoint = '/api/lineage-refinement?name=' + encodeURIComponent(f.root);
    const post = (route, body) => fetch(url + route, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await fetch(url + endpoint)).status, 401);
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'api' };
    assert.equal((await post(endpoint, { ...args, dryRun: true })).status, 200); assert.equal(f.calls.length, 0);
    assert.equal((await post(endpoint, { ...args, apply: true })).status, 400);
    const started = await post(endpoint, args); assert.equal(started.status, 202);
    const receipt = await started.json(); let result;
    for (let i = 0; i < 100; i++) {
      result = await (await fetch(url + endpoint + '&runId=' + receipt.runId, { headers })).json();
      if (result.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.counts.publishable, 1);
    const mcp = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'literature_review',
      arguments: { operation: 'lineage_refine_status', corpus: f.root, runId: receipt.runId, responseMode: 'full' } } });
    const status = JSON.parse((await mcp.json()).result.content[0].text);
    assert.equal(status.result.status, result.status); assert.equal(status.nextActions[0].arguments.apply, false);
    const publish = '/api/lineage-publication?name=' + encodeURIComponent(f.root);
    const publication = { runId: receipt.runId, requestId: 'api-publish' };
    assert.equal((await (await post(publish, publication)).json()).status, 'preview');
    const applied = await executeTool('literature_review', { operation: 'lineage_publish', corpus: f.root, ...publication, apply: true }, f.options);
    assert.equal(applied.result.status, 'published');
    assert.equal(applied.presentation.read_more.arguments.apply, false);
    const graph = await (await post('/api/field-evolution?name=' + encodeURIComponent(f.root), { seedNodeIds: ['child', 'parent'] })).json();
    assert.equal(graph.result.relations.length, 1);
    const replay = await post(endpoint, args); assert.equal((await replay.json()).replayed, true);
    assert.equal(f.calls.length, 2);
  } finally { await server?.stop(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('capabilities and public schema expose bounded refinement without arbitrary graph operations', () => {
  const capabilities = researchCapabilities();
  assert.equal(capabilities.lineageRefinement.statusReadOnly, true);
  assert.equal(capabilities.lineageRefinement.scientificValidation, false);
  assert.ok(capabilities.workflows.literature_review.includes('lineage_publish'));
  assert.equal(resolveResearchWorkflowCall('literature_review', { operation: 'lineage_refine', papers: [{ paperId: 'p' }],
    idempotencyKey: 'valid', maxQueries: 0, maxNewPapers: 0 }).backend, 'lineage_refinement');
  assert.throws(() => resolveResearchWorkflowCall('literature_review', { operation: 'lineage_publish', runId: 'r', requestId: 'x', operations: [] }), /does not accept|Unknown|Unexpected/);
  assert.throws(() => resolveResearchWorkflowCall('literature_review', { operation: 'lineage_refine', papers: [{ paperId: 'p' }],
    idempotencyKey: 'invalid', maxQueries: 9 }), /Invalid/);
});
