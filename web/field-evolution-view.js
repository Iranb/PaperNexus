import { mountFieldResearch } from './field-research-view.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const colors = ['#68d5cb', '#a6a0ff', '#ffbc75', '#7bb8f9', '#ed9bd1', '#a7cf78'];
const label = value => String(value || '').replaceAll('_', ' ');
const short = (value, length = 23) => value.length > length ? value.slice(0, length - 1) + '…' : value;

export function layoutFieldTimeline(result, { mode = 'papers', familyId = '', timelineWidth } = {}) {
  const allNodes = mode === 'methods' ? result.methods : result.papers;
  const nodes = allNodes.filter(n => !familyId || n.familyIds.includes(familyId));
  const ids = new Set(nodes.map(n => n.id));
  const edges = (mode === 'methods' ? result.relations : result.paperRelations)
    .filter(r => ids.has(r.sourceId) && ids.has(r.targetId));
  const familyMap = new Map(result.families.map((f, i) => [f.id, { ...f, color: colors[i % colors.length] }]));
  const groups = new Map();
  for (const node of nodes) {
    const id = familyId || node.familyIds[0] || 'unassigned-papers';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(node);
  }
  const years = [...new Set(nodes.map(n => n.year).filter(Boolean))].sort((a, b) => a - b);
  const startYear = years[0] || 0;
  const span = (years.at(-1) || 0) - startYear;
  const hasUndated = nodes.some(n => !n.year);
  const fittedWidth = timelineWidth ? Math.max(860, timelineWidth) : null;
  const unit = fittedWidth ? (fittedWidth - 290 - (hasUndated && years.length ? 200 : 0)) / Math.max(1, span)
    : Math.min(190, 8000 / Math.max(1, span));
  const yearX = year => year ? 130 + (year - startYear) * unit : 130 + (years.length ? span * unit + 200 : 0);
  const width = fittedWidth || Math.max(860, yearX(hasUndated ? null : years.at(-1)) + 160);
  const positions = new Map();
  const lanes = [];
  let top = 92;
  for (const [id, entries] of groups) {
    const family = familyMap.get(id);
    const rowEnds = [];
    for (const node of entries.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id.localeCompare(b.id))) {
      const x = yearX(node.year);
      let row = rowEnds.findIndex(end => end + 20 < x - 76);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = x + 76;
      positions.set(node.id, { x, y: top + 72 + row * 100, color: family?.color || '#8297a9', laneId: id });
    }
    const height = 72 + Math.max(1, rowEnds.length) * 100;
    lanes.push({ id, name: family?.name || 'Papers without a method link', color: family?.color || '#8297a9', top,
      height, nodeCount: entries.length, hasCycle: family?.hasCycle || false });
    top += height + 18;
  }
  return { nodes, edges, positions, lanes, width, height: Math.max(360, top + 25),
    ticks: [...years, ...(nodes.some(n => !n.year) ? [null] : [])].map(year => ({ year, x: yearX(year) })) };
}

function highlightedElements(result, mode, selection) {
  const nodes = new Set();
  const edges = new Set();
  const relations = mode === 'methods' ? result.relations : result.paperRelations;
  if (selection?.kind === 'node') nodes.add(selection.id);
  if (selection?.kind === 'edge') edges.add(selection.id);
  if (selection?.kind === 'turning') {
    const point = result.turningPoints.find(p => p.id === selection.id);
    if (point) {
      if (mode === 'methods') { nodes.add(point.methodId); point.relationIds.forEach(id => edges.add(id)); }
      else {
        result.methods.find(n => n.id === point.methodId)?.paperIds.forEach(id => nodes.add(id));
        relations.filter(r => r.methodRelationIds.some(id => point.relationIds.includes(id))).forEach(r => edges.add(r.id));
      }
    }
  }
  const anchors = new Set(nodes);
  for (const edge of relations) if (edges.has(edge.id) || anchors.has(edge.sourceId) || anchors.has(edge.targetId)) {
    edges.add(edge.id); nodes.add(edge.sourceId); nodes.add(edge.targetId);
  }
  return { nodes, edges };
}

export function renderFieldTimeline(result, options = {}) {
  const { mode = 'papers', selection, search = '', mainline = true } = options;
  const layout = layoutFieldTimeline(result, options);
  const emphasis = highlightedElements(result, mode, selection);
  const mainIds = new Set(result.families.flatMap(f => f.mainline.relationIds));
  const turningIds = new Set(result.turningPoints.map(p => p.methodId));
  const query = search.trim().toLowerCase();
  const matched = new Set(layout.nodes.filter(n => !query || n.name.toLowerCase().includes(query)).map(n => n.id));
  const path = edge => {
    const a = layout.positions.get(edge.sourceId);
    const b = layout.positions.get(edge.targetId);
    if (b.x - a.x < 160) return `M ${a.x + 76} ${a.y} C ${Math.max(a.x, b.x) + 135} ${a.y}, ${Math.max(a.x, b.x) + 135} ${b.y}, ${b.x + 76} ${b.y}`;
    const mid = (a.x + b.x) / 2;
    const bend = a.y === b.y ? -12 : 0;
    return `M ${a.x + 76} ${a.y} C ${mid} ${a.y + bend}, ${mid} ${b.y + bend}, ${b.x - 76} ${b.y}`;
  };
  let previousLabelX = -Infinity;
  const ticks = layout.ticks.map(tick => {
    const showLabel = tick.x - previousLabelX > 55;
    if (showLabel) previousLabelX = tick.x;
    return { ...tick, showLabel };
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="group" aria-label="${mode === 'papers' ? 'Paper' : 'Method'} evolution timeline" font-family="Arial, sans-serif">
    <title>${escape(result.scope.query || result.scope.targetDomain || 'Selected evidence')} — ${mode} evolution</title>
    <desc>Arrows run from predecessor to successor. Orange paths are structural mainlines. Select a node or relation for evidence. Dates do not establish causality.</desc>
    <defs><marker id="field-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7896ac"/></marker>
    <marker id="field-main-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ffb369"/></marker></defs>
    <rect width="100%" height="100%" fill="#09141e"/>
    <text x="30" y="28" fill="#e7edf3" font-size="16" font-weight="bold">${escape(mode === 'papers' ? 'Papers through time' : 'Methods through time')}</text>
    <text x="30" y="49" fill="#9fb1c1" font-size="11">${escape(layout.nodes.length)} ${mode} · ${escape(layout.edges.length)} evidence relations · ${escape(result.scope.truncated ? 'Coverage limited' : 'Within selected corpus scope')}</text>
    ${layout.lanes.map(lane => `<rect x="14" y="${lane.top}" width="${layout.width - 28}" height="${lane.height}" rx="12" fill="#10212d" stroke="#22384a"/>
      <rect x="14" y="${lane.top + 16}" width="3" height="21" fill="${lane.color}"/>
      <text x="30" y="${lane.top + 30}" fill="${lane.color}" font-size="13" font-weight="bold">${escape(short(lane.name, 56))} · ${lane.nodeCount}${lane.hasCycle ? ' · cycle: no mainline' : ''}</text>`).join('')}
    ${ticks.map(tick => `<line x1="${tick.x}" y1="84" x2="${tick.x}" y2="${layout.height - 20}" stroke="#22384a" stroke-dasharray="3 8"/>
      ${tick.showLabel ? `<text x="${tick.x}" y="75" text-anchor="middle" fill="#b3c6d4" font-size="12">${tick.year || 'Undated'}</text>` : ''}`).join('')}
    ${layout.edges.map(edge => {
      const active = emphasis.edges.has(edge.id);
      const isMain = mainline && (mode === 'methods' ? mainIds.has(edge.id) : edge.methodRelationIds.some(id => mainIds.has(id)));
      const dimmed = (selection && !active) || (query && !matched.has(edge.sourceId) && !matched.has(edge.targetId));
      const names = layout.nodes.filter(n => n.id === edge.sourceId || n.id === edge.targetId).map(n => n.name);
      return `<g role="button" tabindex="0" data-field-edge="${escape(edge.id)}" aria-label="${escape(label(edge.type) + ': ' + names.join(' → '))}" opacity="${dimmed ? '.18' : '1'}" style="cursor:pointer">
        <title>${escape(label(edge.type))} — select to read source evidence</title>
        <path d="${path(edge)}" fill="none" stroke="transparent" stroke-width="16"/>
        <path d="${path(edge)}" fill="none" stroke="${active ? '#72e0d6' : isMain ? '#ffb369' : '#7896ac'}" stroke-width="${active ? 3.4 : isMain ? 2.8 : 1.6}" marker-end="url(#${isMain ? 'field-main-arrow' : 'field-arrow'})" pointer-events="none"/>
      </g>`;
    }).join('')}
    ${layout.nodes.map(node => {
      const p = layout.positions.get(node.id);
      const active = emphasis.nodes.has(node.id);
      const chosen = selection?.kind === 'node' && selection.id === node.id;
      const dimmed = (selection && !active) || (query && !matched.has(node.id));
      const isTurning = mode === 'methods' ? turningIds.has(node.id) : node.methodIds.some(id => turningIds.has(id));
      const title = node.name.length > 23 ? [node.name.slice(0, 23), short(node.name.slice(23), 23)] : [node.name, ''];
      return `<g role="button" tabindex="0" data-field-node="${escape(node.id)}" aria-label="${escape(node.name + ', ' + (node.year || 'Undated'))}" opacity="${dimmed ? '.28' : '1'}" style="cursor:pointer">
        <title>${escape(node.name)} (${node.date || 'Undated'})${node.scopeRole === 'boundary' ? ' — boundary context' : ''}</title>
        <rect x="${p.x - 76}" y="${p.y - 31}" width="152" height="62" rx="9" fill="${chosen ? '#234454' : '#142b3a'}" stroke="${query && matched.has(node.id) ? '#fff1b2' : p.color}" stroke-width="${chosen ? 3 : 1.4}" ${node.scopeRole === 'boundary' ? 'stroke-dasharray="5 3"' : ''}/>
        <text x="${p.x - 64}" y="${p.y - 8}" fill="#eef5fa" font-size="11">${escape(title[0])}</text>
        <text x="${p.x - 64}" y="${p.y + 7}" fill="#eef5fa" font-size="11">${escape(title[1])}</text>
        <text x="${p.x - 64}" y="${p.y + 22}" fill="#9fb1c1" font-size="9">${escape((node.year || 'Undated') + ' · ' + (node.scopeRole === 'boundary' ? 'Boundary context' : mode === 'papers' ? `${node.methodIds.length} linked methods` : `${node.paperIds.length} associated papers`))}</text>
        ${isTurning ? `<circle cx="${p.x + 70}" cy="${p.y - 28}" r="5" fill="#ffb369" stroke="#09141e" stroke-width="2"/>` : ''}
      </g>`;
    }).join('')}
    <text x="30" y="${layout.height - 8}" fill="#9fb1c1" font-size="10">Corpus evidence · Graph structure does not establish scientific influence or causality.</text>
  </svg>`;
  return { svg, layout };
}

function paperLink(paper) {
  let url = paper.url;
  if (!url && paper.doi) url = 'https://doi.org/' + encodeURIComponent(paper.doi);
  if (!url && paper.arxivId) url = 'https://arxiv.org/abs/' + encodeURIComponent(paper.arxivId);
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return ''; } catch { return ''; }
  return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open paper ↗</a>`;
}

function evidenceDetails(relation, result) {
  const e = relation.evidence;
  const paper = result.papers.find(p => p.id === e.evidence.paperId);
  return `<article class="field-evidence"><span class="field-kicker">${escape(label(relation.type))}</span>
    <blockquote>${escape(e.evidence.quote)}</blockquote>
    <p>${escape(paper?.name || e.evidence.paperTitle || e.evidence.paperId || 'Source paper not resolved')}${paper ? ' · ' + (paper.year || 'Undated') : ''}</p>
    ${paper ? paperLink(paper) : ''}
    <dl>${[['Bottleneck', e.bottleneck.description], ['Mechanism', e.mechanism.description], ['Tradeoff', e.tradeoff.description]]
      .map(([key, value]) => `<dt>${key}</dt><dd>${escape(value || 'Not recorded in this evidence')}</dd>`).join('')}</dl>
    <details><summary>Source location</summary><p>${escape(e.evidence.sectionHeading || 'Section unavailable')}</p>
    <p class="field-id">${escape(e.evidence.sourceSpanId || 'Source span unavailable')}</p>
    <p class="field-id">${escape(relation.graphEdgeIds.join(' · '))}</p></details></article>`;
}

export function renderFieldDetails(result, { mode = 'papers', selection, familyId = '' } = {}) {
  const families = result.families.filter(f => !familyId || f.id === familyId);
  if (!selection) return `<span class="field-kicker">Explore the evidence</span><h3>Follow a research line</h3>
    <p>Select a paper, method or arrow. Orange paths mark the longest validated path in each acyclic family; they are not influence rankings.</p>
    ${families.map(f => `<button class="field-family-card" data-field-family="${escape(f.id)}"><strong>${escape(f.name)}</strong>
      <span>${f.methodIds.length} methods · ${f.relationIds.length} relations${f.hasCycle ? ' · cycle detected' : ''}</span></button>`).join('')}
    <h4>Turning-point candidates</h4><p>Structural branches and source-reported changes within this view.</p>
    ${result.turningPoints.filter(p => !familyId || families.some(f => f.methodIds.includes(p.methodId))).map(p =>
      `<button class="field-turning" data-field-turning="${escape(p.id)}"><span>${escape(p.year || 'Undated')} · ${escape(label(p.type))}</span><strong>${escape(p.name)}</strong></button>`).join('') || '<p>No turning-point evidence in this view.</p>'}`;
  if (selection.kind === 'turning') {
    const point = result.turningPoints.find(p => p.id === selection.id);
    if (!point) return '';
    return `<span class="field-kicker">${escape(label(point.type))} candidate</span><h3>${escape(point.name)}</h3><p>${escape(point.basis)}</p>
      <p>Inspect the source before interpreting this as a historical turning point.</p>
      ${result.relations.filter(r => point.relationIds.includes(r.id)).map(r => evidenceDetails(r, result)).join('')}`;
  }
  if (selection.kind === 'edge') {
    const records = mode === 'methods' ? result.relations.filter(r => r.id === selection.id)
      : result.relations.filter(r => result.paperRelations.find(p => p.id === selection.id)?.methodRelationIds.includes(r.id));
    return `<span class="field-kicker">Relation evidence</span><h3>What changed?</h3>
      ${mode === 'papers' ? '<p>This paper connection is projected from the method relations below.</p>' : ''}
      ${records.map(r => evidenceDetails(r, result)).join('')}`;
  }
  const node = (mode === 'methods' ? result.methods : result.papers).find(n => n.id === selection.id);
  if (!node) return '';
  const papers = mode === 'papers' ? [node] : result.papers.filter(p => node.paperIds.includes(p.id));
  const related = mode === 'methods' ? result.relations.filter(r => r.sourceId === node.id || r.targetId === node.id)
    : result.relations.filter(r => result.paperRelations.some(p => (p.sourceId === node.id || p.targetId === node.id) && p.methodRelationIds.includes(r.id)));
  return `<span class="field-kicker">${mode === 'papers' ? 'Paper' : 'Method'} · ${escape(node.scopeRole)}</span><h3>${escape(node.name)}</h3>
    <p>${escape(node.date || 'Publication date unavailable')} · ${escape(node.domains.join(', ') || 'Domain unrecorded')}</p>
    ${mode === 'papers' && node.abstract ? `<p>${escape(node.abstract)}</p>` : ''}
    ${papers.map(p => `<article class="field-source"><strong>${escape(p.name)}</strong><p>${escape(p.authors.join(', '))}</p>${paperLink(p)}</article>`).join('')}
    ${mode === 'methods' && !papers.length ? '<p>Associated papers are absent from this displayed scope.</p>' : ''}
    <h4>${related.length} connected evidence relations</h4>
    ${related.map(r => evidenceDetails(r, result)).join('') || '<p>No validated connection in this view. This does not establish that the paper or method has no predecessors.</p>'}`;
}

export function mountFieldEvolution({ host, getCorpus, getJson, postJson, onClose = () => {} }) {
  const workspace = host.closest('.workspace');
  host.innerHTML = `<header class="field-header"><div><span class="field-kicker">Research lineage</span><h2>Evolution map</h2></div>
    <button type="button" class="action-button" data-field-action="close">Back to graph</button></header>
    <p class="field-scope" role="status" aria-live="polite"></p>
    <section class="field-research-summary" aria-label="Field research progress" aria-live="polite" hidden></section>
    <div class="field-toolbar" hidden><div class="field-modes" role="group" aria-label="Timeline view">
      <button type="button" data-field-mode="papers" aria-pressed="true">Papers</button><button type="button" data-field-mode="methods" aria-pressed="false">Methods</button></div>
      <label>Family<select class="field-family" aria-label="Method family"></select></label>
      <label>Find<input class="field-find" placeholder="Highlight a title…" aria-label="Find in evolution map"/></label>
      <label class="field-mainline"><input type="checkbox" checked/> Mainline</label>
      <div class="field-zoom" role="group" aria-label="Timeline zoom"><button data-field-action="zoom-out" aria-label="Zoom out timeline">−</button><button data-field-action="fit">Fit</button><button data-field-action="zoom-in" aria-label="Zoom in timeline">+</button></div>
      <button data-field-action="svg">SVG ↓</button><button data-field-action="json">JSON ↓</button></div>
    <div class="field-body"><div class="field-map-column"><div class="field-legend" hidden><span><i class="field-line-swatch"></i> Structural mainline</span><span>● Turning-point candidate</span><span>Dashed node: boundary context</span><button data-field-action="clear">Clear selection</button></div>
      <div class="field-map" tabindex="0" aria-label="Scrollable evolution map"></div>
      <p class="field-map-hint">Scroll to explore years. Select an arrow to read its source evidence.</p></div>
      <aside class="field-details" aria-label="Evolution evidence" aria-live="polite"></aside></div>
    <details class="field-coverage"><summary>Coverage and evidence limits</summary><div></div></details>`;
  const map = host.querySelector('.field-map');
  const details = host.querySelector('.field-details');
  const status = host.querySelector('.field-scope');
  const toolbar = host.querySelector('.field-toolbar');
  const legend = host.querySelector('.field-legend');
  const familySelect = host.querySelector('.field-family');
  const search = host.querySelector('.field-find');
  let sequence = 0;
  let payload = null;
  let view = { mode: 'papers', familyId: '', search: '', mainline: true, selection: null };
  let scale = 1;
  let drawing = null;
  let corpus = '';
  let research;

  const resizeSvg = () => {
    const svg = map.querySelector('svg');
    if (svg && drawing) { svg.style.width = drawing.layout.width * scale + 'px'; svg.style.height = drawing.layout.height * scale + 'px'; }
  };
  const update = () => {
    if (!payload) return;
    drawing = renderFieldTimeline(payload.result, view);
    map.innerHTML = drawing.layout.nodes.length ? drawing.svg : '<div class="field-empty"><h3>No matching evidence</h3><p>Broaden the topic or year range, or choose a corpus containing the relevant papers.</p></div>';
    details.innerHTML = renderFieldDetails(payload.result, view);
    familySelect.value = view.familyId;
    host.querySelectorAll('[data-field-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fieldMode === view.mode)));
    resizeSvg();
  };
  const reset = () => {
    research?.pause();
    sequence++; payload = null; drawing = null; corpus = '';
    host.hidden = true; workspace.classList.remove('field-mode');
    map.innerHTML = ''; details.innerHTML = ''; toolbar.hidden = true; legend.hidden = true;
  };
  const showAnalysis = (response, selectedCorpus, topic) => {
    payload = response; corpus = selectedCorpus;
    view = { mode: 'papers', familyId: '', search: '', mainline: true, selection: null, timelineWidth: map.clientWidth };
    search.value = ''; host.querySelector('.field-mainline input').checked = true;
    const result = response.result;
    status.textContent = `${selectedCorpus} · ${topic} · ${result.papers.length} papers · ${result.methods.length} methods · ${result.relations.length} evidence relations${result.scope.truncated ? ' · Coverage limited' : ''}`;
    familySelect.innerHTML = '<option value="">All families</option>' + result.families.map(f => `<option value="${escape(f.id)}">${escape(f.name)} (${f.methodIds.length})</option>`).join('');
    toolbar.hidden = false; legend.hidden = false;
    const counts = result.scope.counts;
    host.querySelector('.field-coverage div').innerHTML = `<p>${escape(result.scope.boundary)}</p>
      <p>${counts.matchedPapers} matched papers / ${counts.corpusPapers} eligible corpus papers. Showing ${counts.returnedPapers}/${counts.availablePapers} scoped papers and ${counts.returnedMethods}/${counts.availableMethods} scoped methods.</p>
      <p>Years: ${result.scope.fromYear || 'any'}–${result.scope.toYear || 'any'}; undated: ${result.diagnostics.undatedPapers} papers, ${result.diagnostics.undatedMethods} methods. ${result.scope.truncated ? 'Limits reached: ' + escape(result.scope.truncationReasons.join(', ')) : 'No display budget was reached.'}</p>
      <p>${result.diagnostics.rejectedRelations.length} relations did not pass lineage validation; ${result.diagnostics.paperProjectionOmissions.length} method relations have no displayed paper projection; ${result.diagnostics.cyclicFamilyIds.length} cyclic families have no mainline.</p>
      <p>Source quality: ${response.sourceQuality?.quarantinedPapers?.length || 0} papers excluded. Snapshot: ${escape(response.generatedAt || '')}.</p>`;
    update();
    scale = 1;
    resizeSvg(); map.scrollLeft = 0; map.scrollTop = 0;
  };
  const readRequest = () => {
    const selectedCorpus = getCorpus();
    const query = document.getElementById('topic-query').value.trim();
    const targetDomain = document.getElementById('topic-domain').value.trim();
    if (!selectedCorpus || (!query && !targetDomain)) {
      document.getElementById('topic-status').textContent = !selectedCorpus ? 'Load a corpus first.' : 'Enter a topic or target domain for the evolution map.';
      return null;
    }
    const request = { ...(query ? { query } : {}), ...(targetDomain ? { targetDomain } : {}),
      maxDepth: Number(document.getElementById('topic-depth').value), maxNodes: Number(document.getElementById('topic-budget').value) };
    for (const [key, id] of [['fromYear', 'field-from-year'], ['toYear', 'field-to-year']]) {
      const value = document.getElementById(id).value;
      if (value) request[key] = Number(value);
    }
    return request;
  };
  const run = async () => {
    const selectedCorpus = getCorpus();
    const request = readRequest();
    if (!request) return;
    const { query, targetDomain } = request;
    research?.pause(true);
    host.querySelector(".field-research-summary").hidden = true;
    const current = ++sequence;
    payload = null; drawing = null; corpus = selectedCorpus;
    host.hidden = false; workspace.classList.add('field-mode');
    toolbar.hidden = true; legend.hidden = true; details.innerHTML = '';
    host.querySelector('.field-coverage div').textContent = '';
    status.textContent = `Building an evidence map from ${selectedCorpus}…`;
    map.innerHTML = '<div class="field-empty"><h3>Reading the corpus</h3><p>Connecting papers through validated method relations…</p></div>';
    try {
      const response = await postJson('/api/field-evolution?name=' + encodeURIComponent(selectedCorpus), request);
      if (current !== sequence || getCorpus() !== selectedCorpus) return;
      showAnalysis(response, selectedCorpus, query || targetDomain);
    } catch (error) {
      if (current !== sequence) return;
      status.textContent = 'The evolution map could not be built.';
      map.innerHTML = `<div class="field-empty"><h3>Analysis failed</h3><p>${escape(error.message)}</p><button data-field-action="retry">Try again</button></div>`;
    }
  };
  const download = (text, type, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const select = target => {
    if (target.dataset.fieldNode) view.selection = { kind: 'node', id: target.dataset.fieldNode };
    else if (target.dataset.fieldEdge) view.selection = { kind: 'edge', id: target.dataset.fieldEdge };
    else if (target.dataset.fieldTurning) view.selection = { kind: 'turning', id: target.dataset.fieldTurning };
    else if (target.dataset.fieldFamily) { view.familyId = target.dataset.fieldFamily; view.selection = null; }
    else return false;
    update(); details.scrollTop = 0; return true;
  };
  host.addEventListener('click', event => {
    const target = event.target.closest('[data-field-node],[data-field-edge],[data-field-turning],[data-field-family],[data-field-mode],[data-field-action]');
    if (!target) return;
    if (select(target)) return;
    if (target.dataset.fieldMode) { view.mode = target.dataset.fieldMode; view.selection = null; update(); return; }
    const action = target.dataset.fieldAction;
    if (action === 'close') { research?.pause(true); reset(); onClose(); return; }
    if (action === 'retry') { run(); return; }
    if (!payload) return;
    if (action === 'clear') { view.selection = null; update(); }
    if (action === 'fit') { view.timelineWidth = map.clientWidth; scale = 1; update(); map.scrollLeft = 0; }
    if (action === 'zoom-in' || action === 'zoom-out') { scale = Math.max(.15, Math.min(2.5, scale * (action === 'zoom-in' ? 1.25 : .8))); resizeSvg(); }
    if (action === 'svg') download(drawing.svg, 'image/svg+xml', `papernexus-evolution-${view.mode}.svg`);
    if (action === 'json') download(JSON.stringify({ corpus, generatedAt: payload.generatedAt, view, result: payload.result, sourceQuality: payload.sourceQuality, research: payload.research }, null, 2), 'application/json', 'papernexus-evolution.json');
  });
  host.addEventListener('keydown', event => {
    const target = event.target.closest('g[data-field-node],g[data-field-edge]');
    if (!target || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const key = target.dataset.fieldNode ? 'fieldNode' : 'fieldEdge';
    const id = target.dataset[key];
    select(target);
    [...map.querySelectorAll('g[tabindex]')].find(n => n.dataset[key] === id)?.focus();
  });
  familySelect.addEventListener('change', () => { view.familyId = familySelect.value; view.selection = null; update(); map.scrollTop = 0; });
  search.addEventListener('input', () => { view.search = search.value; update(); });
  host.querySelector('.field-mainline input').addEventListener('change', event => { view.mainline = event.target.checked; update(); });
  document.getElementById('field-build').addEventListener('click', run);
  research = mountFieldResearch({ host, getCorpus, getJson, postJson, readRequest, showAnalysis,
    open: selectedCorpus => {
      sequence++; payload = null; drawing = null; corpus = selectedCorpus;
      host.hidden = false; workspace.classList.add('field-mode');
      toolbar.hidden = true; legend.hidden = true; details.innerHTML = '';
      host.querySelector('.field-coverage div').textContent = '';
      status.textContent = `${selectedCorpus} · Researching the field…`;
      map.innerHTML = '<div class="field-empty"><h3>Building the evidence base</h3><p>The map will appear after imports, extraction and graph synchronization finish.</p></div>';
    }
  });
  return { reset, run, restoreResearch: research.restore, isOpen: () => !host.hidden };
}
