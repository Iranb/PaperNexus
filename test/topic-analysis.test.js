import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createTopicFixture } from './fixtures/topic-analysis-fixture.js';
import { buildTopicAnalysis, buildAnalysisSubgraph } from '../src/core/graph/topic-analysis.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { topicAnalysisPayload } from '../src/server/api.js';
import { executeResearchLookupTool } from '../src/mcp/tool-research-lookup.js';
import { serveCommand } from '../src/server/http.js';

test('topic analysis preserves evidence, dates, bounds and committed graph state', () => {
  const graph = createTopicFixture();
  const before = JSON.stringify(graph.toJSON());
  const result = buildTopicAnalysis(graph, { query: 'feedback calibration', targetDomain: 'Education', maxDepth: 4 });
  assert.ok(result.objects.some((node) => node.nodeId === 'q1'));
  assert.ok(result.adaptations.some((entry) => entry.candidates.some((c) => c.methodId === 'm2')));
  assert.ok(result.gaps.some((gap) => gap.category === 'evidence_gap'));
  assert.ok(result.gaps.some((gap) => gap.category === 'research_opportunity'));
  assert.ok(result.problemEvolution.observations.some((entry) => entry.date === '2020' && entry.paperId === 'p1'));
  assert.ok(result.problemEvolution.diagnostics.undated > 0);
  assert.ok(result.methodEvolution.some((entry) => entry.diagnostics.acceptedEdgeCount > 0));
  assert.ok(result.methodEvolution.some((entry) => entry.diagnostics.rejectedEdges?.some((edge) => edge.edgeId === 'invalid-evolution')));
  assert.equal(JSON.stringify(graph.toJSON()), before);
  assert.deepEqual(buildTopicAnalysis(graph, { query: 'zzzznohit' }).graph.nodes, []);
  assert.equal(buildTopicAnalysis(graph, { query: 'zzzznohit' }).status, 'no_matches');
  const tiny = buildAnalysisSubgraph(graph, { seedNodeIds: ['q1', 'missing'], maxDepth: 1, maxNodes: 3, maxEdges: 1 });
  assert.ok(tiny.graph.nodes.length <= 3 && tiny.graph.relationships.length <= 1);
  assert.ok(tiny.scope.truncated);
  assert.deepEqual(tiny.scope.missingSeeds, ['missing']);
  const ids = new Set(tiny.graph.nodes.map((node) => node.id));
  assert.ok(tiny.graph.relationships.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)));
  assert.equal(buildAnalysisSubgraph(graph, { maxNodes: 9999 }).scope.budgets.maxNodes, 500);
  assert.throws(() => buildTopicAnalysis(graph, { fromYear: 2025, toYear: 2020 }), /fromYear/);
});

test('HTTP and MCP share the read-only analysis contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-topic-api-'));
  const paths = getCorpusPaths(root);
  const graph = createTopicFixture();
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'topic-fixture', rootPath: root,
    nodeCount: graph.nodeCount, relationshipCount: graph.relationshipCount }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  const before = await fs.readFile(paths.liteGraphPath, 'utf8');
  const request = { query: 'feedback calibration', maxNodes: 12, maxEdges: 20 };
  let handle;
  try {
    const direct = await topicAnalysisPayload(root, request);
    for (const operation of ['topic_analysis', 'problem_evolution', 'analysis_subgraph']) {
      const mcp = await executeResearchLookupTool({ operation, corpus: root, ...request });
      assert.deepEqual(mcp.result, direct.result);
    }
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    handle = await serveCommand({
      host: '127.0.0.1', port, apiToken: 'topic-fixture-token', rootPaths: [root],
      config: { serve: { mcp: { enabled: true } } },
      enableEnhancements: false, enableImports: false, enableAuthoritativeSync: false,
      enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false
    });
    for (const route of ['topic-analysis', 'problem-evolution', 'analysis-subgraph']) {
      const response = await fetch('http://127.0.0.1:' + handle.port + '/api/' + route, {
        method: 'POST', headers: { authorization: 'Bearer topic-fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: root, ...request })
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).result, direct.result);
      const mcpResponse = await fetch('http://127.0.0.1:' + handle.port + '/mcp', {
        method: 'POST', headers: { authorization: 'Bearer topic-fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: route, method: 'tools/call', params: {
          name: 'research_lookup', arguments: { operation: route.replaceAll('-', '_'), corpus: root, ...request }
        } })
      });
      const mcpPayload = await mcpResponse.json();
      assert.deepEqual(JSON.parse(mcpPayload.result.content[0].text).result, direct.result);
    }
    assert.equal(await fs.readFile(paths.liteGraphPath, 'utf8'), before);
  } finally {
    await handle?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
