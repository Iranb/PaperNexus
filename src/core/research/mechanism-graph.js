const structuralRelations = new Set(['CONTAINS', 'BELONGS_TO', 'MEMBER_OF', 'BELONGS_TO_DOMAIN', 'CITES', 'AUTHORED_BY', 'PUBLISHED_IN']);
const contextualTypes = new Set(['Corpus', 'Domain', 'Author', 'Venue']);

export function buildPaperMechanismContext(graph, paper, selectedSource = {}, readable = [], { maxDepth = 3, maxRelations = 48 } = {}) {
  const sourceId = selectedSource.paper_id || paper?.id;
  const relations = [], paths = [], nodes = new Map(), seen = new Set();
  const queue = paper ? [{ id: paper.id, depth: 0, path: [] }] : [];
  const expanded = new Set();
  let truncated = false;
  while (queue.length) {
    const current = queue.shift();
    if (expanded.has(current.id)) continue;
    expanded.add(current.id);
    const adjacent = [...graph.getOutgoing(current.id), ...graph.getIncoming(current.id)].sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of adjacent) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      const from = graph.getNode(edge.sourceId), to = graph.getNode(edge.targetId);
      if (!from || !to || [from, to].some(n => contextualTypes.has(n.type)) || structuralRelations.has(edge.type)) continue;
      if (current.depth >= maxDepth || relations.length >= maxRelations) { truncated = true; continue; }
      const properties = edge.properties || {}, original = properties.qualityOriginalEndpoints || edge;
      const span = graph.getNode(properties.sourceSpanId || properties.spanId);
      const owners = [properties.paperId, properties.sourcePaperId, span?.properties?.paperId].filter(Boolean);
      const incident = original.sourceId === sourceId || original.targetId === sourceId;
      const belongs = owners.length ? owners.every(id => id === sourceId) : incident;
      const quotes = [properties.exactQuote, properties.evidenceText, properties.evidence_text, properties.quote, properties.citationContext, span?.properties?.text]
        .filter(value => typeof value === 'string' && value.trim());
      const quote = quotes.find(value => readable.some(source => source.text.includes(value)));
      const source = quote && readable.find(item => item.text.includes(quote));
      const reasons = [!belongs && 'source_identity_mismatch', !quote && 'source_span_unverified',
        ['candidate', 'rejected', 'invalid'].includes(properties.validationStatus) && 'relation_not_accepted',
        properties.explicitOrInferred === 'inferred' && 'inferred_relation'].filter(Boolean);
      const relation = { relationship_id: edge.id, relationship_type: edge.type, from: edge.sourceId, to: edge.targetId,
        original_endpoints: { sourceId: original.sourceId, targetId: original.targetId }, source_paper_id: sourceId,
        source_keys: [...(selectedSource.source_keys || [])].sort(), source_span_id: span?.id || properties.sourceSpanId || null,
        quote: quote || null, source_path: source?.path || null, status: reasons.length ? 'unverified' : 'source_anchored', reason_codes: reasons };
      relations.push(relation);
      for (const node of [from, to]) nodes.set(node.id, { id: node.id, type: node.type, name: node.name });
      const path = [...current.path, edge.id];
      paths.push({ relationship_ids: path, status: path.every(id => relations.find(r => r.relationship_id === id)?.status === 'source_anchored') ? 'source_anchored' : 'partially_anchored' });
      const next = edge.sourceId === current.id ? to : from;
      if (belongs && (next.type !== 'Paper' || next.id === paper.id)) queue.push({ id: next.id, depth: current.depth + 1, path });
    }
  }
  return { status: relations.some(r => r.status === 'source_anchored') ? 'available' : 'needs_evidence',
    source_paper_id: sourceId || null, nodes: [...nodes.values()], relations, paths,
    coverage: { max_depth: maxDepth, max_relations: maxRelations, returned_relations: relations.length, truncated },
    boundary: 'Source anchors establish where a relation was reported, not its causal validity or applicability to a new experiment.' };
}
