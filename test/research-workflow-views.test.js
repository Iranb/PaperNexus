import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderAnalysisHtml, layoutAnalysisGraph } from '../web/analysis-view.js';
import { buildTopicAnalysis } from '../src/core/graph/topic-analysis.js';
import { buildMethodEvolutionGapAnalysis } from '../src/core/graph/research-intelligence.js';
import { createTopicFixture } from './fixtures/topic-analysis-fixture.js';

test('analysis views escape corpus text and expose clickable source evidence', () => {
  const graph = createTopicFixture();
  graph.addNode({ id: 'xss', type: 'Problem', name: '<img src=x onerror=alert(1)> feedback',
    properties: { evidenceText: '<script>bad()</script>' } });
  const result = buildTopicAnalysis(graph, { query: 'feedback', maxDepth: 4 });
  const html = renderAnalysisHtml(result);
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('data-analysis-node="xss"'));
  const positions = layoutAnalysisGraph(result.graph);
  assert.equal(positions.size, result.graph.nodes.length);
  assert.ok([...positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.deepEqual(positions, layoutAnalysisGraph(result.graph));
});

test('lineage opportunities pair bottlenecks with tradeoffs from common source edges', () => {
  const graph = createTopicFixture();
  graph.updateRelationship({ ...graph.getRelationship('evolution'), properties: {
    ...graph.getRelationship('evolution').properties, bottleneckDimension: 'a-bottleneck', tradeoffDimension: 'z-cost'
  } });
  graph.addNode({ id: 'm3', type: 'Method', name: 'Next controller', properties: { year: 2025 } });
  graph.addRelationship({ id: 'second', type: 'IMPROVES_METHOD', sourceId: 'm3', targetId: 'm2',
    properties: { ...graph.getRelationship('evolution').properties, bottleneckDimension: 'z-bottleneck', tradeoffDimension: 'a-cost' } });
  const lineage = buildMethodEvolutionGapAnalysis(graph, { method: 'm3', maxDepth: 3 });
  const pairs = lineage.nextGapCandidates.map((entry) => [entry.bottleneckDimension, entry.tradeoffDimension]);
  assert.deepEqual(pairs, [['a-bottleneck', 'z-cost'], ['z-bottleneck', 'a-cost']]);
});

test('Python graph wrapper exposes bounded analysis and explicit query sorting', () => {
  const source = [
    'import sys, json',
    "sys.path.insert(0, 'SKILL/PaperNexus/scripts')",
    'import pn_graph_query as q',
    "sys.argv = ['q', 'topic_analysis', 'feedback', '--max-nodes', '12', '--target-domain', 'Education', '--seed-node-ids', 'm1', 'q1']",
    'args=q.parse_args()',
    'print(json.dumps(q.build_options(args)))'
  ].join('\n');
  const options = JSON.parse(execFileSync('python3', ['-c', source], { encoding: 'utf8' }));
  assert.deepEqual(options, { maxNodes: 12, targetDomain: 'Education', seedNodeIds: ['m1', 'q1'] });
  const help = execFileSync('python3', ['SKILL/PaperNexus/scripts/pn_graph_query.py', 'query', '--help'], { encoding: 'utf8' });
  assert.match(help, /sort-by.*relevance,date/);
});
