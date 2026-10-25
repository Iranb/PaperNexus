import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { serveCommand } from '../src/server/http.js';
import { executeTool } from '../src/mcp/core.js';
import { saveDiscoveryRun } from '../src/core/discovery/store.js';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';

const idleWorker = () => ({ stop() {}, pollNow() {} });

test('HTTP and MCP share durable field research, authentication, dry runs, replay and ready evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-field-http-'));
  const paths = getCorpusPaths(root);
  let server;
  let discoveries = 0;
  const dependencies = { async discover(args, options) {
    discoveries++;
    const selection = options.selectDiscoveryCandidates([{ id: 'known', title: 'Known feedback paper', year: 2010,
      identifiers: { doi: '10.1234/existing' } }], { phase: 'source_resolution' });
    const run = { runId: args.runId, topic: args.query, candidates: selection.candidates,
      candidateSelection: selection.selection, coverage: {}, queryResults: [], plan: { queries: [] } };
    await saveDiscoveryRun(root, run);
    return run;
  } };
  try {
    const graph = createFieldEvolutionFixture();
    const paper = graph.getNode('p-m0');
    graph.updateNode({ ...paper, properties: { ...paper.properties, doi: '10.1234/existing' } });
    await fs.mkdir(paths.corpusDir, { recursive: true });
    await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'research-api', rootPath: root }));
    await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    server = await serveCommand({ host: '127.0.0.1', port, rootPaths: [root], apiToken: 'field-api-token',
      config: { serve: { mcp: { enabled: true } } }, fieldResearchDependencies: dependencies,
      enableEnhancements: false, startImportWorker: idleWorker, startAuthoritativeSyncWorker: idleWorker,
      enableFastMdImportLane: false, enableMineruWarmup: false, enableDoclingWarmup: false,
      enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
    const url = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: 'Bearer field-api-token', 'content-type': 'application/json' };
    const endpoint = '/api/field-research?name=' + encodeURIComponent(root);
    assert.equal((await fetch(url + endpoint)).status, 401);
    const post = body => fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const preview = await post({ query: 'feedback', dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).readiness.ready, true);
    assert.equal(discoveries, 0);
    const toolPreview = await executeTool('literature_review', { operation: 'field_research', corpus: root, targetDomain: 'Education', dryRun: true }, { workerRootPaths: [root] });
    assert.equal(toolPreview.result.dryRun, true);
    assert.equal(toolPreview.evidenceBoundary.basis, 'dry_run');
    assert.equal((await post({ query: 'feedback' })).status, 400);
    const request = { query: 'feedback', targetDomain: 'Education', idempotencyKey: 'shared-request' };
    const started = await post(request);
    assert.equal(started.status, 202);
    const receipt = await started.json();
    const replay = await post(request);
    assert.equal((await replay.json()).replayed, true);
    assert.equal((await post({ ...request, maxPapers: 3 })).status, 409);
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await (await fetch(url + endpoint + '&runId=' + receipt.runId, { headers })).json();
      if (status.terminal) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.status, 'completed');
    assert.equal(status.analysis.result.scope.research.runId, receipt.runId);
    assert.equal(status.survey.candidateSelection.counts.already_indexed, 1);
    assert.equal(discoveries, 1);
    const mcp = await fetch(url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name: 'literature_review', arguments: { operation: 'field_research_status', corpus: root, runId: receipt.runId } } }) });
    const envelope = JSON.parse((await mcp.json()).result.content[0].text);
    assert.equal(envelope.result.status, status.status);
    assert.deepEqual(envelope.result.analysis.result, status.analysis.result);
    assert.equal(envelope.nextActions.length, 0);
  } finally { await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
