import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineageAtlas, layoutLineageRoute, renderLineageAtlas, renderLineageRoute, renderFieldProgression } from '../web/field-lineage-atlas.js';

const node = (id, year = 2024) => ({ id, name: id, year, paperIds: ['paper-' + id] });
const edge = (sourceId, targetId, type = 'EXTENDS_METHOD') => ({ id: `${sourceId}-${targetId}`, sourceId, targetId, type,
  evidence: { mechanism: { description: '保留旧知识并扩展输出空间' } } });

test('component reuse connects evidence without merging method inheritance routes', () => {
  const result = { methods: ['A', 'B', 'C', 'D', 'Loss', 'Isolated'].map(id => node(id)),
    relations: [edge('A', 'B'), edge('C', 'D'), edge('Loss', 'B', 'USES_COMPONENT_METHOD'), edge('B', 'D', 'COMPONENT_OF')] };
  const model = buildLineageAtlas(result);
  assert.equal(model.routes.length, 2);
  assert.equal(model.inheritance.length, 2);
  assert.equal(model.components.length, 2);
  assert.deepEqual(new Set(model.unlinked.map(item => item.id)), new Set(['Loss', 'Isolated']));
  assert.ok(model.routes.every(route => route.nodes.length === 2));
  const allMethods = [...model.routes.flatMap(route => route.nodes), ...model.unlinked].map(item => item.id);
  assert.deepEqual(new Set(allMethods), new Set(result.methods.map(item => item.id)));
  const html = renderLineageAtlas(result).html;
  assert.ok(html.includes('组件采用与跨路线关联'));
  assert.ok(html.includes('尚未连接到继承谱系的方法'));
});

test('forks, convergence and same-year variants have forward arrows and nonoverlapping nodes in both orientations', () => {
  const result = { methods: ['A', 'B', 'C', 'D', 'D+'].map(id => node(id)), relations:
    [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D'), edge('D', 'D+', 'VARIANT_OF')] };
  const route = buildLineageAtlas(result).routes[0];
  for (const vertical of [false, true]) {
    const layout = layoutLineageRoute(route, { vertical, width: 420 });
    assert.equal(layout.hasCycle, false);
    for (const relation of route.edges) {
      const a = layout.positions.get(relation.sourceId), b = layout.positions.get(relation.targetId);
      assert.ok(vertical ? b.y > a.y : b.x > a.x);
    }
    for (const [id, a] of layout.positions) for (const [other, b] of layout.positions) {
      if (id !== other) assert.ok(Math.abs(a.x - b.x) >= layout.nodeWidth || Math.abs(a.y - b.y) >= layout.nodeHeight);
    }
    const { svg } = renderLineageRoute(route, { vertical, width: 420 });
    assert.ok(svg.includes('data-atlas-edge="D-D+"'));
    assert.ok(svg.includes('变体'));
  }
});

test('cyclic evidence remains inspectable without claiming a genealogy order', () => {
  const result = { methods: ['A', 'B'].map(id => node(id)), relations: [edge('A', 'B'), edge('B', 'A')] };
  const route = buildLineageAtlas(result).routes[0];
  const rendered = renderLineageAtlas(result, { routeId: route.id });
  assert.equal(rendered.drawing.layout.hasCycle, true);
  assert.equal(rendered.drawing.svg, '');
  assert.ok(rendered.html.includes('存在环'));
  assert.ok(rendered.html.includes('data-atlas-edge="A-B"'));
  assert.ok(rendered.html.includes('data-atlas-edge="B-A"'));
});

test('route content retains exact changes, escapes source text and filters by method without losing route context', () => {
  const result = { methods: [node('<old>'), node('New')], relations: [edge('<old>', 'New')] };
  const model = buildLineageAtlas(result);
  const html = renderLineageAtlas(result, { routeId: model.routes[0].id }).html;
  assert.ok(html.includes('&lt;old&gt;'));
  assert.ok(!html.includes('<old>'));
  assert.ok(html.includes('保留旧知识并扩展输出空间'));
  assert.ok(renderLineageAtlas(result, { search: 'new' }).html.includes('&lt;old&gt;'));
  assert.ok(renderLineageAtlas(result, { search: 'missing' }).html.includes('当前筛选下没有'));
});

test('research progression includes unlinked methods by branch and preserves a multi-branch method', () => {
  const result = { methods: [node('A', 2020), node('B', 2022), node('C', 2024)], relations: [edge('A', 'B')] };
  const study = { branches: [{ id: 'core', label: '核心问题', description: '保持旧知识' }, { id: 'online', label: '在线学习', description: '持续到达的数据' }],
    papers: [{ role: 'method', branchIds: ['core'], methodIds: ['A'] }, { role: 'method', branchIds: ['core', 'online'], methodIds: ['B'] },
      { role: 'method', branchIds: ['online'], methodIds: ['C'] }, { role: 'excluded', branchIds: ['core'], methodIds: ['C'] }] };
  const html = renderFieldProgression(result, { study }).html;
  assert.ok(html.includes('保持旧知识'));
  assert.equal((html.match(/data-atlas-node="B"/g) || []).length, 2);
  assert.equal((html.match(/data-atlas-node="C"/g) || []).length, 1);
  assert.ok(html.indexOf('>2020</span>') < html.indexOf('>2022</span>'));
  assert.ok(html.includes('data-atlas-branch-route="online"'));
  const focused = renderLineageAtlas(result, { study, branchFocus: 'online' }).html;
  assert.ok(focused.includes('研究分支：在线学习'));
  assert.ok(focused.includes('data-atlas-node="C"'));
});

test('study branch order puts the research focus before larger background lineages', () => {
  const result = { methods: ['A', 'B', 'X', 'Y', 'Z'].map(id => node(id)), relations: [edge('A', 'B'), edge('X', 'Y'), edge('Y', 'Z')] };
  const study = { branches: [{ id: 'core', label: '研究问题' }, { id: 'background', label: '基础方法' }], papers:
    [{ role: 'method', branchIds: ['core'], methodIds: ['A', 'B'] }, { role: 'context', branchIds: ['background'], methodIds: ['X', 'Y', 'Z'] }] };
  assert.equal(buildLineageAtlas(result, study).routes[0].title, 'A');
});

test('relations that skip a generation bypass intervening nodes in both orientations', () => {
  const result = { methods: ['A', 'X', 'B', 'C'].map(id => node(id)), relations: [edge('A', 'B'), edge('X', 'B'), edge('B', 'C'), edge('A', 'C')] };
  const route = buildLineageAtlas(result).routes[0];
  for (const vertical of [true, false]) {
    const layout = layoutLineageRoute(route, { vertical, width: 480 });
    const points = layout.bypasses.get('A-C').points;
    for (const id of ['X', 'B']) {
      const p = layout.positions.get(id), w = layout.nodeWidth / 2, h = layout.nodeHeight / 2;
      for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1], points[i]];
        const crosses = a[0] === b[0]
          ? a[0] > p.x - w && a[0] < p.x + w && Math.max(a[1], b[1]) > p.y - h && Math.min(a[1], b[1]) < p.y + h
          : a[1] > p.y - h && a[1] < p.y + h && Math.max(a[0], b[0]) > p.x - w && Math.min(a[0], b[0]) < p.x + w;
        assert.equal(crosses, false, `Bypass crosses ${id}`);
      }
    }
    assert.ok(points.every(([x,y]) => x >= 0 && x <= layout.width && y >= 0 && y <= layout.height));
  }
});
