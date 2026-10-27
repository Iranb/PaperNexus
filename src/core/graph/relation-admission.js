const ADOPTION_RELATIONS = new Set([
  'USES', 'USES_COMPONENT_METHOD', 'COMPONENT_OF', 'EXTENDS_METHOD', 'IMPROVES_METHOD',
  'REPLACES_METHOD', 'ADAPTS_METHOD', 'VARIANT_OF', 'SPECIALIZES'
]);
const NON_METHOD_CONTEXTS = new Set(['ablation', 'comparison', 'hypothesis', 'background']);
const NON_FACTUAL_STATUSES = new Set(['refuted', 'hypothesis', 'uncertain']);

export function assessResearchRelation(relation = {}) {
  if (!ADOPTION_RELATIONS.has(relation.type)) return { admitted: true };
  if (NON_METHOD_CONTEXTS.has(relation.relationContext)) {
    return { admitted: false, reason: `relation-context-${relation.relationContext}` };
  }
  if (NON_FACTUAL_STATUSES.has(relation.epistemicStatus)) {
    return { admitted: false, reason: `epistemic-status-${relation.epistemicStatus}` };
  }
  return { admitted: true };
}

export function qualifyPaperRelation(type, record = {}) {
  if (!['ASSUMES', 'USES', 'HAS_LIMITATION'].includes(type)) return { type };
  const role = record.attribution?.role;
  const reason = ['baseline', 'prior-work', 'experiment'].includes(role)
    ? `attribution-${role}`
    : NON_FACTUAL_STATUSES.has(record.epistemicStatus)
      ? `epistemic-status-${record.epistemicStatus}`
      : NON_METHOD_CONTEXTS.has(record.relationContext) ? `relation-context-${record.relationContext}` : null;
  return reason ? { type: 'CONTAINS', originalType: type, reason } : { type };
}
