const EXPERIMENT_FIELDS = [
  'dataset', 'taskSplit', 'backbone', 'pretraining', 'memoryBudget', 'metric', 'value',
  'unit', 'baseline', 'comparison', 'variant', 'sourceLocation'
];
const ATTRIBUTION_ROLES = new Set(['proposed', 'baseline', 'prior-work', 'experiment']);
const EPISTEMIC_STATUSES = new Set(['asserted', 'observed', 'hypothesis', 'refuted', 'uncertain']);
const RELATION_CONTEXTS = new Set(['method', 'ablation', 'comparison', 'hypothesis', 'background']);

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function normalizeResearchProvenance(record = {}) {
  if (!record || typeof record !== 'object') return {};
  const result = {};
  const evidenceText = text(record.evidenceText || record.evidenceQuote || record.exactQuote || record.evidence);
  if (evidenceText) result.evidenceText = evidenceText;
  for (const field of ['sectionHeading', 'sectionRole']) {
    const value = text(record[field]);
    if (value) result[field] = value;
  }
  if (Array.isArray(record.sourceChunkIds)) {
    const ids = [...new Set(record.sourceChunkIds.map(text).filter(Boolean))].sort();
    if (ids.length) result.sourceChunkIds = ids;
  }
  if (Array.isArray(record.supportingSnippets)) {
    const snippets = record.supportingSnippets.map(snippet => {
      const quote = text(snippet?.text || snippet?.evidenceText);
      if (!quote) return null;
      return { text: quote, ...normalizeResearchProvenance({
        sectionHeading: snippet.sectionHeading, sectionRole: snippet.sectionRole,
        sourceChunkIds: snippet.sourceChunkIds
      }) };
    }).filter(Boolean);
    if (snippets.length) result.supportingSnippets = snippets;
  }
  const role = text(record.attribution?.role).toLowerCase();
  const subject = text(record.attribution?.subject);
  if (subject || ATTRIBUTION_ROLES.has(role)) {
    result.attribution = { ...(subject ? { subject } : {}), ...(ATTRIBUTION_ROLES.has(role) ? { role } : {}) };
  }
  const epistemicStatus = text(record.epistemicStatus).toLowerCase();
  if (EPISTEMIC_STATUSES.has(epistemicStatus)) result.epistemicStatus = epistemicStatus;
  const relationContext = text(record.relationContext).toLowerCase();
  if (RELATION_CONTEXTS.has(relationContext)) result.relationContext = relationContext;
  if (record.experimentContext && typeof record.experimentContext === 'object') {
    const context = {};
    for (const field of EXPERIMENT_FIELDS) {
      const value = record.experimentContext[field];
      if (typeof value === 'number' && Number.isFinite(value)) context[field] = value;
      else if (text(value)) context[field] = text(value);
    }
    if (Object.keys(context).length) result.experimentContext = context;
  }
  return result;
}

export function mergeResearchProvenance(primary = {}, secondary = {}) {
  const left = normalizeResearchProvenance(primary);
  const right = normalizeResearchProvenance(secondary);
  const result = { ...right, ...left };
  const ids = [...new Set([...(left.sourceChunkIds || []), ...(right.sourceChunkIds || [])])].sort();
  if (ids.length) result.sourceChunkIds = ids;
  const snippets = [...(left.supportingSnippets || []), ...(right.supportingSnippets || [])];
  if (left.evidenceText && right.evidenceText && left.evidenceText !== right.evidenceText) {
    for (const record of [left, right]) snippets.push({
      text: record.evidenceText,
      ...(record.sectionHeading ? { sectionHeading: record.sectionHeading } : {}),
      ...(record.sectionRole ? { sectionRole: record.sectionRole } : {}),
      ...(record.sourceChunkIds ? { sourceChunkIds: record.sourceChunkIds } : {})
    });
  }
  if (snippets.length) {
    result.supportingSnippets = [...new Map(snippets.map(snippet => [JSON.stringify(snippet), snippet])).values()];
  }
  return result;
}

export function researchRecordKey(record = {}) {
  const name = text(record.normalized || record.normalizedName || record.name || record.text).toLowerCase();
  const provenance = normalizeResearchProvenance(record);
  return JSON.stringify([name, provenance.attribution || null, provenance.epistemicStatus || null,
    provenance.experimentContext || null, provenance.relationContext || null]);
}

export function dedupeResearchRecords(records = []) {
  const byKey = new Map();
  for (const record of records) {
    const key = researchRecordKey(record);
    const existing = byKey.get(key);
    byKey.set(key, existing ? { ...existing, ...mergeResearchProvenance(existing, record) } : record);
  }
  return [...byKey.values()];
}


export function researchContextsConflict(left = {}, right = {}) {
  const a = normalizeResearchProvenance(left);
  const b = normalizeResearchProvenance(right);
  return ['attribution', 'epistemicStatus', 'experimentContext', 'relationContext'].some(field =>
    a[field] && b[field] && JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}
