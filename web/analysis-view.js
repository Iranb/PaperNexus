const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const label = (value) => String(value || '').replaceAll('_', ' ');
const nodeButton = (id, name) => id
  ? '<button class="analysis-node" data-analysis-node="' + escape(id) + '">' + escape(name || id) + '</button>'
  : escape(name || '');

function evidenceHtml(refs = []) {
  if (!refs.length) return '<p class="analysis-muted">Source passages needed.</p>';
  return '<details class="analysis-evidence"><summary>Evidence · ' + refs.length + '</summary>'
    + refs.map((ref) => '<div>' + nodeButton(ref.nodeId, ref.nodeId ? 'Locate source node' : '')
      + (ref.paperIds || []).map((id) => nodeButton(id, id)).join(' ')
      + '<p>' + escape(ref.quote || 'Graph reference; the source passage is not present in this projection.') + '</p>'
      + (ref.edgeId ? '<small>' + escape(ref.edgeId) + '</small>' : '') + '</div>').join('') + '</details>';
}

function analysisCard(title, body, status = '') {
  return '<article class="analysis-card"><h3>' + title + '</h3>'
    + (status ? '<div class="analysis-status">' + escape(label(status)) + '</div>' : '') + body + '</article>';
}

export function renderAnalysisHtml(result, view = 'objects') {
  if (!result || result.status === 'overview') return '<p class="analysis-muted">Enter a topic to inspect its problems, transfers, gaps and evolution.</p>';
  if (result.status === 'no_matches') return '<p class="analysis-muted">No matching evidence in the committed corpus. Broaden the topic or import relevant papers, then analyze again.</p>';
  let cards = [];
  if (view === 'objects') {
    cards = (result.objects || []).map((item) => analysisCard(nodeButton(item.nodeId, item.name),
      '<p>' + escape((item.domains || []).join(', ')) + '</p>' + evidenceHtml(item.evidence), item.type));
  } else if (view === 'adaptations') {
    for (const entry of result.adaptations || []) {
      const candidates = [...(entry.candidates || []), ...(entry.excluded || [])];
      if (!candidates.length) cards.push(analysisCard(nodeButton(entry.problemId, entry.problem),
        '<p>No compatible mechanism with task evidence was found.</p>', 'needs_evidence'));
      for (const item of candidates) cards.push(analysisCard(nodeButton(item.methodId, item.methodName),
        '<p>Target: ' + nodeButton(entry.problemId, entry.problem) + '</p>'
        + '<p>' + escape(item.sourceDomain || 'Unknown source domain') + ' → ' + escape(item.targetDomain || 'Target task') + '</p>'
        + '<p>Match: ' + escape([...(item.matchBasis?.matchedTerms || []), ...(item.matchBasis?.sharedMechanisms || [])].join(', ')) + '</p>'
        + (item.conditions?.conflicts?.length ? '<p class="analysis-conflict">Condition conflicts: '
          + escape(item.conditions.conflicts.map((c) => c.key + ': source ' + c.method + ', target ' + c.target).join('; ')) + '</p>' : '')
        + (item.missingEvidence?.length ? '<p>Needs evidence: ' + escape(item.missingEvidence.join('; ')) + '</p>' : '')
        + '<ol>' + (item.proposedChanges || []).map((change) => '<li>' + escape(change) + '</li>').join('') + '</ol>'
        + '<p>Falsifier: ' + escape(item.falsifier) + '</p>' + evidenceHtml(item.evidence), item.status));
    }
  } else if (view === 'gaps') {
    cards = (result.gaps || []).map((item) => analysisCard(nodeButton(item.nodeId, item.statement),
      '<p>' + escape(item.verification) + '</p>' + evidenceHtml(item.evidence), item.category + ' · ' + item.status));
  } else if (view === 'evolution') {
    cards = (result.problemEvolution?.observations || []).map((item) => analysisCard(
      escape(item.date || 'Undated') + ' · ' + nodeButton(item.nodeId, item.problem),
      '<p>' + nodeButton(item.paperId, item.paperTitle || 'Source paper needed') + '</p>'
      + '<p>Methods: ' + (item.methods || []).map((m) => nodeButton(m.nodeId, m.name)).join(', ') + '</p>'
      + evidenceHtml(item.evidence), 'paper_reported_observation'));
    for (const lineage of result.methodEvolution || []) {
      for (const chain of lineage.lineages || []) {
        cards.push(analysisCard('Method lineage',
          (chain.steps || []).map((step) => nodeButton(step.method?.methodId || step.methodId, step.method?.name || step.methodName || step.name)
            + (step.edgeToNext ? '<p>' + escape(step.edgeToNext.edgeType) + '</p>'
              + evidenceHtml([{ nodeId: step.edgeToNext.sourceMethod?.methodId, edgeId: step.edgeToNext.edgeId,
                quote: step.edgeToNext.evidence?.quote, paperIds: step.edgeToNext.evidence?.paperId ? [step.edgeToNext.evidence.paperId] : [] }]) : '')).join(''),
          'validated_source_relation'));
      }
    }
  }
  const boundary = view === 'evolution'
    ? 'Dates order observations; they do not establish causality or solved problems.'
    : view === 'adaptations' ? 'Transfer candidates require source review and experiments. Benefits and novelty are unverified.'
      : 'These results cover the returned subgraph. Check source passages before drawing conclusions.';
  return '<p class="analysis-muted">' + escape(boundary) + '</p>' + (cards.join('') || '<p class="analysis-muted">No evidence of this type in the current projection.</p>');
}

// Deterministic force layout for the bounded projection, without a browser dependency.
export function layoutAnalysisGraph(graph) {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const count = nodes.length;
  const positions = new Map(nodes.map((node, index) => {
    const angle = index * Math.PI * 2 / Math.max(count, 1);
    const radius = 100 + Math.sqrt(count) * 35;
    return [node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }];
  }));
  for (let iteration = 0; iteration < 65; iteration++) {
    const forces = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < count; i++) {
      const a = positions.get(nodes[i].id);
      for (let j = i + 1; j < count; j++) {
        const b = positions.get(nodes[j].id);
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = 18000 / distance;
        const ax = dx / distance * force;
        const ay = dy / distance * force;
        forces.get(nodes[i].id).x += ax;
        forces.get(nodes[i].id).y += ay;
        forces.get(nodes[j].id).x -= ax;
        forces.get(nodes[j].id).y -= ay;
      }
    }
    for (const edge of graph.relationships) {
      const a = positions.get(edge.sourceId);
      const b = positions.get(edge.targetId);
      if (!a || !b || edge.sourceId === edge.targetId) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 150) * 0.5;
      forces.get(edge.sourceId).x += dx / distance * force;
      forces.get(edge.sourceId).y += dy / distance * force;
      forces.get(edge.targetId).x -= dx / distance * force;
      forces.get(edge.targetId).y -= dy / distance * force;
    }
    const temperature = 25 * (1 - iteration / 65);
    for (const node of nodes) {
      const point = positions.get(node.id);
      const force = forces.get(node.id);
      force.x -= point.x * 0.03;
      force.y -= point.y * 0.03;
      const magnitude = Math.max(1, Math.hypot(force.x, force.y));
      point.x += force.x / magnitude * Math.min(magnitude, temperature);
      point.y += force.y / magnitude * Math.min(magnitude, temperature);
    }
  }
  return positions;
}
