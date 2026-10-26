import test from 'node:test';
import assert from 'node:assert/strict';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { buildFieldEvolution } from '../src/core/graph/field-evolution.js';
import { layoutFieldTimeline, renderFieldTimeline, renderFieldDetails } from '../web/field-evolution-view.js';

test('timeline places dated methods proportionally, separates unknown dates and keeps every visible edge endpoint', () => {
  const result = buildFieldEvolution(createFieldEvolutionFixture(), { targetDomain: 'Education' });
  const layout = layoutFieldTimeline(result, { mode: 'methods' });
  assert.equal(layout.nodes.length, result.methods.length);
  assert.ok(layout.positions.get('m0').x < layout.positions.get('m9').x);
  assert.ok(layout.positions.get('unknown').x > layout.positions.get('replace').x);
  const distance = (a, b) => layout.positions.get(b).x - layout.positions.get(a).x;
  assert.equal(distance('m0', 'm2'), distance('m0', 'm1') * 2);
  assert.ok(layout.edges.every(e => layout.positions.has(e.sourceId) && layout.positions.has(e.targetId)));
  for (const [id, a] of layout.positions) for (const [other, b] of layout.positions) {
    if (id === other) continue;
    assert.ok(Math.abs(a.x - b.x) >= 152 || Math.abs(a.y - b.y) >= 62, `${id} overlaps ${other}`);
  }
  const family = result.families.find(f => f.methodIds.includes('spectral'));
  const filtered = layoutFieldTimeline(result, { mode: 'papers', familyId: family.id });
  assert.equal(filtered.nodes.length, 2);
  assert.equal(filtered.edges.length, 1);
  const fitted = layoutFieldTimeline(result, { mode: 'methods', timelineWidth: 1000 });
  assert.equal(fitted.width, 1000);
  assert.ok(fitted.positions.get('m0').x < fitted.positions.get('m9').x);
  for (const [id, a] of fitted.positions) for (const [other, b] of fitted.positions) {
    if (id !== other) assert.ok(Math.abs(a.x - b.x) >= 152 || Math.abs(a.y - b.y) >= 62);
  }
});

test('SVG is standalone, keyboard accessible and preserves source text as text rather than markup', () => {
  const graph = createFieldEvolutionFixture();
  graph.updateNode({ ...graph.getNode('m0'), name: '<script>alert(1)</script> feedback' });
  const result = buildFieldEvolution(graph, { targetDomain: 'Education' });
  const { svg } = renderFieldTimeline(result, { mode: 'methods' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('tabindex="0" data-field-node="m0"'));
  assert.ok(svg.includes('data-field-edge="m1-m0"'));
  assert.ok(svg.includes('id="field-main-arrow"'));
  assert.ok(svg.includes('Undated'));
  assert.ok(svg.includes('stroke-dasharray="5 3"'));
});

test('relation and turning-point details expose exact quotes, source location and interpretation limits', () => {
  const result = buildFieldEvolution(createFieldEvolutionFixture(), { targetDomain: 'Education' });
  const html = renderFieldDetails(result, { mode: 'methods', selection: { kind: 'edge', id: 'merge-branch' } });
  assert.ok(html.includes('merge extends branch by calibrating sparse feedback.'));
  assert.ok(html.includes('span-merge-branch'));
  assert.ok(html.includes('Additional calibration cost'));
  const point = result.turningPoints.find(p => p.type === 'convergence');
  const details = renderFieldDetails(result, { selection: { kind: 'turning', id: point.id } });
  assert.ok(details.includes('2 distinct predecessors'));
  assert.ok(details.includes('historical turning point'));
  assert.ok(details.includes('merge extends m9'));
  assert.ok(details.includes('merge extends branch'));
});

test('unsafe source URLs are not links and papers outside a family remain absent', () => {
  const result = buildFieldEvolution(createFieldEvolutionFixture(), { targetDomain: 'Education' });
  result.papers[0].url = 'javascript:alert(1)';
  const html = renderFieldDetails(result, { selection: { kind: 'node', id: result.papers[0].id } });
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('undefined'));
  const family = result.families.find(f => f.methodIds.includes('spectral'));
  const { svg } = renderFieldTimeline(result, { mode: 'methods', familyId: family.id });
  assert.ok(svg.includes('data-field-node="spectral"'));
  assert.ok(!svg.includes('data-field-node="m0"'));
});

test('timeline relation labels follow arrow direction regardless of node order', () => {
  const result = buildFieldEvolution(createFieldEvolutionFixture(), { targetDomain: 'Education' });
  result.methods.reverse();
  const edge = result.relations[0];
  const source = result.methods.find(node => node.id === edge.sourceId).name;
  const target = result.methods.find(node => node.id === edge.targetId).name;
  const { svg } = renderFieldTimeline(result, { mode: 'methods' });
  assert.ok(svg.includes(`aria-label="${edge.type.replaceAll('_', ' ')}: ${source} → ${target}"`));
});
