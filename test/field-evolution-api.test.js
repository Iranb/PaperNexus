import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { fieldEvolutionPayload } from '../src/server/api.js';
import { executeTool } from '../src/mcp/core.js';
import { resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { serveCommand } from '../src/server/http.js';

test('landscape HTTP/MCP share admitted evidence, retain source quality and never change the corpus', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-field-api-'));
  const paths = getCorpusPaths(root);
  const graph = createFieldEvolutionFixture();
  graph.addNode({ id: 'excluded', type: 'Paper', name: 'Feedback calibration test document',
    properties: { sourcePurpose: 'benchmark-fixture', fieldOfStudy: 'Education', year: 2024 } });
  graph.addNode({ id: 'excluded-method', type: 'Method', name: 'Invalid calibration', properties: { paperId: 'excluded', year: 2024 } });
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'field-fixture', rootPath: root, paperCount: 20 }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  const before = await fs.readFile(paths.liteGraphPath, 'utf8');
  const request = { targetDomain: 'Education', fromYear: 2000, maxNodes: 100 };
  let handle;
  try {
    const direct = await fieldEvolutionPayload(root, request);
    assert.ok(!direct.result.papers.some(p => p.id === 'excluded'));
    assert.ok(!direct.result.methods.some(p => p.id === 'excluded-method'));
    assert.ok(direct.sourceQuality.quarantinedPapers.some(p => p.id === 'excluded'));
    const legacy = await executeTool('research_lookup', { operation: 'field_evolution', corpus: root, ...request });
    assert.deepEqual(legacy.result, direct.result);
    const envelope = await executeTool('lineage_analysis', { operation: 'landscape', corpus: root, ...request, responseMode: 'full' });
    assert.deepEqual(envelope.result.result, direct.result);
    const summary = await executeTool('lineage_analysis', { operation: 'landscape', corpus: root, ...request, responseMode: 'summary' });
    assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) <= 32768);
    assert.equal(summary.presentation.read_more.arguments.operation, 'landscape');
    assert.equal(summary.presentation.read_more.arguments.responseMode, 'full');
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    handle = await serveCommand({ host: '127.0.0.1', port, rootPaths: [root], apiToken: 'field-fixture-token',
      config: { serve: { mcp: { enabled: true } } }, enableEnhancements: false, enableImports: false,
      enableAuthoritativeSync: false, enableLiteratureDiscoveryRecovery: false,
      enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
    const response = await fetch(`http://127.0.0.1:${handle.port}/api/field-evolution`, {
      method: 'POST', headers: { authorization: 'Bearer field-fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: root, ...request })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, direct.result);
    const mcp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer field-fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'lineage_analysis', arguments: { operation: 'landscape', corpus: root, ...request, responseMode: 'full' }
      } })
    });
    assert.deepEqual(JSON.parse((await mcp.json()).result.content[0].text).result.result, direct.result);
    assert.equal(await fs.readFile(paths.liteGraphPath, 'utf8'), before);
  } finally { await handle?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

test('landscape advertises only its read parameters and requires a selector', () => {
  assert.throws(() => resolveResearchWorkflowCall('lineage_analysis', { operation: 'landscape' }), /requires/);
  assert.throws(() => resolveResearchWorkflowCall('lineage_analysis', { operation: 'landscape', query: 'feedback', writeBack: true }), /does not accept/);
  assert.throws(() => resolveResearchWorkflowCall('lineage_analysis', { operation: 'landscape', query: 'feedback', maxNodes: 501 }), /Invalid/);
  const resolved = resolveResearchWorkflowCall('lineage_analysis', { operation: 'landscape', targetDomain: 'Education', fromYear: 2010, maxNodes: 120 });
  assert.equal(resolved.args.operation, 'field_evolution');
  assert.equal(resolved.args.fromYear, 2010);
  assert.equal(resolved.args.maxNodes, 120);
});
