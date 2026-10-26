const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const componentTypes = new Set(['USES_COMPONENT_METHOD', 'COMPONENT_OF']);
const relationLabels = { EXTENDS_METHOD: '扩展', IMPROVES_METHOD: '改进', ADAPTS_METHOD: '适配',
  REPLACES_METHOD: '替代', VARIANT_OF: '变体', SPECIALIZES: '专门化', USES_COMPONENT_METHOD: '采用组件', COMPONENT_OF: '组件关联' };
const palette = ['#73d6ca', '#b5acff', '#ffbf82', '#83baff', '#edadd4', '#b2d989'];
const order = (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name);
const clip = (text, length) => String(text || '').length > length ? String(text).slice(0, length - 1) + '…' : String(text || '');
export const lineageRelationLabel = type => relationLabels[type] || type.replaceAll('_', ' ');

export function buildLineageAtlas(result, study) {
  const methods = new Map(result.methods.map(node => [node.id, node]));
  const relations = result.relations.filter(edge => methods.has(edge.sourceId) && methods.has(edge.targetId));
  const components = relations.filter(edge => componentTypes.has(edge.type));
  const inheritance = relations.filter(edge => !componentTypes.has(edge.type));
  const neighbors = new Map(result.methods.map(node => [node.id, new Set()]));
  for (const edge of inheritance) {
    neighbors.get(edge.sourceId).add(edge.targetId);
    neighbors.get(edge.targetId).add(edge.sourceId);
  }
  const visited = new Set();
  const routes = [];
  const unlinked = [];
  for (const node of [...result.methods].sort(order)) {
    if (visited.has(node.id)) continue;
    if (!neighbors.get(node.id).size) { unlinked.push(node); visited.add(node.id); continue; }
    const ids = new Set([node.id]);
    const queue = [node.id];
    for (let i = 0; i < queue.length; i++) for (const next of neighbors.get(queue[i])) {
      if (!ids.has(next)) { ids.add(next); queue.push(next); }
    }
    ids.forEach(id => visited.add(id));
    const nodes = [...ids].map(id => methods.get(id)).sort(order);
    const edges = inheritance.filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))
      .sort((a, b) => order(methods.get(a.targetId), methods.get(b.targetId)) || order(methods.get(a.sourceId), methods.get(b.sourceId)));
    const roots = nodes.filter(item => !edges.some(edge => edge.targetId === item.id));
    const branches = (study?.branches || []).filter(branch => study.papers.some(paper =>
      paper.role !== 'excluded' && paper.branchIds.includes(branch.id) && paper.methodIds.some(id => ids.has(id))));
    const years = nodes.map(item => item.year).filter(Boolean);
    routes.push({ id: nodes.map(item => item.id).sort()[0], nodes, edges, roots,
      title: (roots.length ? roots : [nodes[0]]).map(item => item.name).join(' / '),
      branches, start: years.length ? Math.min(...years) : null, end: years.length ? Math.max(...years) : null,
      components: components.filter(edge => ids.has(edge.sourceId) || ids.has(edge.targetId)) });
  }
  const branchOrder = route => route.branches.length ? study.branches.findIndex(branch => branch.id === route.branches[0].id) : Infinity;
  routes.sort((a, b) => branchOrder(a) - branchOrder(b) || b.nodes.length - a.nodes.length || (b.end || 0) - (a.end || 0) || a.title.localeCompare(b.title));
  routes.forEach((route, index) => { route.color = palette[index % palette.length]; });
  return { routes, unlinked, inheritance, components, methods };
}

export function layoutLineageRoute(route, { vertical = false, width = 900 } = {}) {
  const incoming = new Map(route.nodes.map(node => [node.id, 0]));
  const ranks = new Map(route.nodes.map(node => [node.id, 0]));
  for (const edge of route.edges) incoming.set(edge.targetId, incoming.get(edge.targetId) + 1);
  const queue = route.nodes.filter(node => !incoming.get(node.id)).map(node => node.id);
  for (let i = 0; i < queue.length; i++) for (const edge of route.edges.filter(item => item.sourceId === queue[i])) {
    ranks.set(edge.targetId, Math.max(ranks.get(edge.targetId), ranks.get(edge.sourceId) + 1));
    incoming.set(edge.targetId, incoming.get(edge.targetId) - 1);
    if (!incoming.get(edge.targetId)) queue.push(edge.targetId);
  }
  if (queue.length !== route.nodes.length) return { hasCycle: true, positions: new Map(), width, height: 0 };
  const levels = [];
  for (const node of route.nodes) (levels[ranks.get(node.id)] ||= []).push(node);
  const maxBreadth = Math.max(...levels.map(level => level.length));
  const skipped = route.edges.filter(edge => ranks.get(edge.targetId) - ranks.get(edge.sourceId) > 1);
  const reserved = skipped.length ? 36 + skipped.length * 26 : 0;
  const nodeWidth = vertical ? 172 : 190;
  const nodeHeight = 82;
  const breadthStep = vertical ? 192 : 130;
  const depthStep = vertical ? 152 : 292;
  const diagramWidth = vertical ? Math.max(width, maxBreadth * breadthStep + 24 + reserved) : Math.max(width, levels.length * depthStep - 60);
  const diagramHeight = vertical ? (levels.length - 1) * depthStep + 120 : Math.max(190, maxBreadth * breadthStep + 32) + reserved;
  const positions = new Map();
  levels.forEach((nodes, depth) => nodes.forEach((node, index) => {
    const breadth = ((vertical ? diagramWidth : diagramHeight) - reserved - (nodes.length - 1) * breadthStep) / 2 + index * breadthStep;
    positions.set(node.id, vertical ? { x: breadth, y: 60 + depth * depthStep } : { x: 116 + depth * depthStep, y: breadth + reserved });
  }));
  const bypasses = new Map();
  skipped.forEach((edge, index) => {
    const a = positions.get(edge.sourceId), b = positions.get(edge.targetId);
    const rail = vertical ? diagramWidth - reserved + 26 + index * 26 : 20 + index * 26;
    const points = vertical
      ? [[a.x, a.y + nodeHeight / 2], [a.x, a.y + nodeHeight / 2 + 18], [rail, a.y + nodeHeight / 2 + 18], [rail, b.y - nodeHeight / 2 - 18], [b.x, b.y - nodeHeight / 2 - 18], [b.x, b.y - nodeHeight / 2 - 3]]
      : [[a.x + nodeWidth / 2, a.y], [a.x + nodeWidth / 2 + 18, a.y], [a.x + nodeWidth / 2 + 18, rail], [b.x - nodeWidth / 2 - 18, rail], [b.x - nodeWidth / 2 - 18, b.y], [b.x - nodeWidth / 2 - 3, b.y]];
    bypasses.set(edge.id, { points, x: vertical ? rail : (a.x + b.x) / 2, y: vertical ? (a.y + b.y) / 2 : rail });
  });
  return { hasCycle: false, positions, bypasses, width: diagramWidth, height: diagramHeight, nodeWidth, nodeHeight, vertical };
}

export function renderLineageRoute(route, options = {}) {
  const layout = layoutLineageRoute(route, options);
  if (layout.hasCycle) return { layout, svg: '', html: '<p class="atlas-note">这组关系存在环，请逐条查看证据；当前不排列继承层级。</p>' };
  const { nodeWidth: w, nodeHeight: h, positions, vertical } = layout;
  const selected = options.selection;
  const query = String(options.search || '').trim().toLowerCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="group" aria-label="${escape(route.title)} 方法谱系" font-family="Arial, sans-serif">
    <title>${escape(route.title)}：方法继承与分叉</title><desc>箭头从前驱指向后继；节点标注首次公开年份。层级表示已核验的方法关系。</desc>
    <defs><marker id="atlas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${route.color}"/></marker></defs>
    <rect width="100%" height="100%" fill="#0b1822"/>
    ${route.edges.map(edge => {
      const a = positions.get(edge.sourceId), b = positions.get(edge.targetId);
      const bypass = layout.bypasses.get(edge.id);
      const path = bypass ? bypass.points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ') : vertical ? `M${a.x} ${a.y + h / 2} C${a.x} ${(a.y + b.y) / 2},${b.x} ${(a.y + b.y) / 2},${b.x} ${b.y - h / 2 - 3}`
        : `M${a.x + w / 2} ${a.y} C${(a.x + b.x) / 2} ${a.y},${(a.x + b.x) / 2} ${b.y},${b.x - w / 2 - 3} ${b.y}`;
      const x = bypass?.x ?? (a.x + b.x) / 2, y = bypass?.y ?? (a.y + b.y) / 2;
      const names = [edge.sourceId, edge.targetId].map(id => route.nodes.find(node => node.id === id).name);
      return `<g data-atlas-edge="${escape(edge.id)}">
        <path d="${path}" fill="none" stroke="transparent" stroke-width="20"/><path d="${path}" fill="none" stroke="${route.color}" stroke-width="${selected?.id === edge.id ? 4 : 2}" marker-end="url(#atlas-arrow)"/>
        <g tabindex="0" role="button" data-atlas-edge="${escape(edge.id)}" aria-label="${escape(names.join(' → ') + ' · ' + lineageRelationLabel(edge.type))}"><rect x="${x - 28}" y="${y - 12}" width="56" height="24" rx="12" fill="#19313d"/><text x="${x}" y="${y + 4}" text-anchor="middle" fill="#e3efef" font-size="11">${escape(lineageRelationLabel(edge.type))}</text></g></g>`;
    }).join('')}
    ${route.nodes.map(node => {
      const p = positions.get(node.id);
      const matched = query && node.name.toLowerCase().includes(query);
      const incoming = route.edges.find(edge => edge.targetId === node.id);
      const mechanism = incoming?.evidence.mechanism.description;
      return `<g tabindex="0" role="button" data-atlas-node="${escape(node.id)}" opacity="${query && !matched ? '.4' : '1'}" aria-label="${escape(node.name + ' · ' + (node.year || '年份未知'))}"><title>${escape(node.name)}${mechanism ? '：' + escape(mechanism) : ''}</title>
        <rect x="${p.x - w / 2}" y="${p.y - h / 2}" width="${w}" height="${h}" rx="12" fill="${selected?.id === node.id || matched ? '#29444f' : '#122a36'}" stroke="${matched ? '#fff0a4' : route.color}" stroke-width="${selected?.id === node.id || matched ? 3 : 1.2}"/>
        <text x="${p.x - w / 2 + 14}" y="${p.y - 20}" fill="${route.color}" font-size="11">${node.year || '年份未知'}${incoming ? '' : ' · 路线起点'}</text>
        <text x="${p.x - w / 2 + 14}" y="${p.y + 1}" fill="#f1f5f7" font-weight="bold" font-size="13">${escape(clip(node.name, vertical ? 20 : 24))}</text>
        <text x="${p.x - w / 2 + 14}" y="${p.y + 23}" fill="#adc2cf" font-size="10">${escape(clip(mechanism || `${node.paperIds.length} 篇来源论文`, vertical ? 13 : 15))}</text></g>`;
    }).join('')}</svg>`;
  return { layout, svg, html: `<div class="atlas-diagram" tabindex="0" aria-label="方法继承与分叉图">${svg}</div>` };
}

function relationRow(edge, methods, selected) {
  const source = methods.get(edge.sourceId), target = methods.get(edge.targetId);
  return `<button class="atlas-change ${selected?.id === edge.id ? 'is-selected' : ''}" data-atlas-edge="${escape(edge.id)}">
    <span class="atlas-change-year">${target.year || '—'}</span><span><strong>${escape(source.name)} <i>→</i> ${escape(target.name)}</strong>
    <span class="atlas-relation-label">${escape(lineageRelationLabel(edge.type))}</span>
    <span class="atlas-change-mechanism">${escape(edge.evidence.mechanism.description || '查看关系原文')}</span></span><span class="atlas-read">证据 ↗</span></button>`;
}

export function renderLineageAtlas(result, { study, routeId = '', branchFocus = '', search = '', width = 900, selection } = {}) {
  const model = buildLineageAtlas(result, study);
  const query = search.trim().toLowerCase();
  const focus = study?.branches.find(branch => branch.id === branchFocus);
  const focusedIds = new Set(study?.papers.filter(paper => paper.role !== 'excluded' && paper.branchIds.includes(branchFocus)).flatMap(paper => paper.methodIds));
  const matches = node => (!focus || focusedIds.has(node.id)) && (!query || node.name.toLowerCase().includes(query));
  const route = model.routes.find(item => item.id === routeId);
  const routes = model.routes.filter(item => (!focus || item.branches.some(branch => branch.id === focus.id))
    && (item.nodes.some(matches) || (query && item.branches.some(branch => branch.label.toLowerCase().includes(query)))));
  const components = model.components.filter(edge => matches(model.methods.get(edge.sourceId)) || matches(model.methods.get(edge.targetId)));
  const title = `<div class="atlas-heading"><div><span class="field-kicker">METHOD LINEAGE</span><h3>${route ? escape(route.title) + ' 路线' : '方法怎样演变'}</h3></div>
    ${route ? '<button class="atlas-back" data-atlas-route="">← 全部路线</button>' : `<span class="atlas-counts">${routes.length} 条谱系 · ${routes.reduce((sum, item) => sum + item.edges.length, 0)} 条演化关系 · ${components.length} 条组件关联</span>`}</div>`;
  if (route) {
    const drawing = renderLineageRoute(route, { vertical: width < 680, width: Math.max(300, width - 40), selection, search });
    return { model, route, drawing, html: title + `<p class="atlas-intro">${route.start || '—'}–${route.end || '—'} · ${route.nodes.length} 个方法 · ${route.edges.length} 条演化关系。沿箭头查看继承、分叉和汇合，点击关系查看原文。</p>`
      + drawing.html + `<h4 class="atlas-section-title">每一步改变了什么</h4><div class="atlas-changes">${route.edges.map(edge => relationRow(edge, model.methods, selection)).join('')}</div>`
      + (route.components.length ? `<h4 class="atlas-section-title">这条路线采用或提供的组件</h4><p class="atlas-note">组件关联单独列出，不用于连接上方的继承谱系。</p>${route.components.map(edge => relationRow(edge, model.methods, selection)).join('')}` : '') };
  }
  const unlinked = model.unlinked.filter(matches);
  return { model, route: null, drawing: null, html: title
    + '<p class="atlas-intro">先选一条研究路线，再看方法如何继承、分叉和汇合。箭头只连接已有原文证据的方法。</p>'
    + (focus ? `<p class="atlas-focus-label">研究分支：${escape(focus.label)} <button data-atlas-branch-route="">显示全部谱系 ×</button></p>` : '')
    + `<div class="atlas-route-grid">${routes.map((item, index) => `<article class="atlas-route-card" style="--route-color:${item.color}">
      <button class="atlas-route-open" data-atlas-route="${escape(item.id)}"><span class="atlas-route-meta">路线 ${String(index + 1).padStart(2, '0')} <span>${item.start || '—'}–${item.end || '—'}</span></span>
      <strong>${escape(item.title)}</strong><span class="atlas-branch-label">${escape(item.branches.slice(0, 2).map(branch => branch.label).join(' · ') || '已核验的方法演化')}</span>
      <span class="atlas-mini-edges">${item.edges.slice(0, 4).map(edge => `<span>${escape(model.methods.get(edge.sourceId).name)} <i>→</i> ${escape(model.methods.get(edge.targetId).name)}</span>`).join('')}</span>
      <span class="atlas-route-footer">${item.nodes.length} 个方法 · ${item.edges.length} 条关系 <b>展开谱系 →</b></span></button></article>`).join('') || '<p class="atlas-note">当前筛选下没有已连接的演化路线。</p>'}</div>`
    + (components.length ? `<details class="atlas-secondary"><summary>组件采用与跨路线关联 <span>${components.length}</span></summary>${components.map(edge => relationRow(edge, model.methods, selection)).join('')}</details>` : '')
    + `<details class="atlas-secondary" ${query ? 'open' : ''}><summary>尚未连接到继承谱系的方法 <span>${unlinked.length}</span></summary><p class="atlas-note">这些方法仍在研究范围内；当前证据未建立继承关系。可点击查看来源。</p><div class="atlas-unlinked">${unlinked.map(node => `<button data-atlas-node="${escape(node.id)}"><strong>${escape(node.name)}</strong><span>${node.year || '年份未知'}</span></button>`).join('')}</div></details>` };
}

export function renderFieldProgression(result, { study, search = '' } = {}) {
  const query = search.trim().toLowerCase();
  const model = buildLineageAtlas(result, study);
  const branches = study?.branches || result.families.map(family => ({ id: family.id, label: family.name, description: '', methodIds: family.methodIds }));
  const rows = branches.map(branch => {
    const ids = new Set(branch.methodIds || study.papers.filter(paper => paper.role !== 'excluded' && paper.branchIds.includes(branch.id)).flatMap(paper => paper.methodIds));
    const nodes = result.methods.filter(node => ids.has(node.id)).sort(order);
    return { branch, nodes, routes: model.routes.filter(route => route.nodes.some(node => ids.has(node.id))) };
  }).filter(row => row.nodes.length && (!query || row.branch.label.toLowerCase().includes(query) || row.nodes.some(node => node.name.toLowerCase().includes(query))));
  return { model, route: null, drawing: null, html: `<div class="atlas-heading"><div><span class="field-kicker">RESEARCH DIRECTIONS</span><h3>按问题看研究推进</h3></div><span class="atlas-counts">${rows.length} 个研究分支<br/>${result.methods.length} 个方法与变体</span></div>
    <p class="atlas-intro">每条分支按首次公开年份展开。点击方法看来源，进入方法谱系看继承关系。一个方法可以属于多个分支。</p>
    <div class="atlas-progression">${rows.map(({ branch, nodes, routes }, index) => {
      const years = [...new Set(nodes.map(node => node.year))].sort((a, b) => (a || 9999) - (b || 9999));
      const datedYears = years.filter(Boolean);
      return `<details class="atlas-direction" ${index === 0 || query ? 'open' : ''} style="--route-color:${palette[index % palette.length]}"><summary>
        <span class="atlas-direction-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${escape(branch.label)}</strong><span class="atlas-direction-meta">${datedYears[0] || '—'}–${datedYears.at(-1) || '—'} · ${nodes.length} 个方法 · ${routes.length} 条相关谱系</span></span><span class="atlas-expand">展开</span></summary>
        ${branch.description ? `<p class="atlas-direction-description">${escape(branch.description)}</p>` : ''}
        <div class="atlas-years">${years.map(year => `<div class="atlas-year-row"><span class="atlas-year">${year || '待定'}</span><div>${nodes.filter(node => node.year === year).map(node => `<button class="atlas-method-chip ${query && node.name.toLowerCase().includes(query) ? 'is-match' : ''}" data-atlas-node="${escape(node.id)}">${escape(node.name)}</button>`).join('')}</div></div>`).join('')}</div>
        ${study ? `<button class="atlas-direction-link" data-atlas-branch-route="${escape(branch.id)}">查看这个分支的方法谱系 →</button>` : ''}</details>`;
    }).join('') || '<p class="atlas-note">当前筛选下没有研究分支。</p>'}</div>` };
}
