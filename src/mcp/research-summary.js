import { createHash } from 'node:crypto';

// This is a display budget, never a new authority for scientific or queue state.
export const RESEARCH_SUMMARY_MAX_BYTES = 32768;
const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2));
const important = /^(status|final_status|input_status|paper|paper_id|id|title|name|operation|runId|run_id|jobId|taskId|source_admission|evidence_sufficiency|reason_codes|next_action|novelty_claim_allowed|experiment_planning_allowed|semantic_equivalence_checked)$/;

export function summarizeResearchEnvelope(envelope, args = {}) {
  const submitted = ['discovery_submit', 'import_submit'].includes(envelope.evidenceBoundary?.basis);
  const reconcile = (envelope.nextActions || []).find(action =>
    action.tool === 'literature_review' && ['discovery_status', 'discovery_report', 'import_status'].includes(action.arguments?.operation));
  const readMore = submitted
    ? reconcile ? { ...reconcile, arguments: { ...reconcile.arguments, responseMode: 'full' } }
      : { instruction: 'Inspect the existing discovery/import job records before any retry. Do not repeat the submission to expand this summary.' }
    : { tool: envelope.tool, arguments: { ...args, responseMode: 'full' } };
  const serialized = JSON.stringify(envelope.result);
  const omitted = [];
  let budget = 12000;
  const project = (value, pointer = 'result', depth = 0) => {
    if (budget <= 0 || depth > 7) { if (omitted.length < 40) omitted.push(pointer); return null; }
    if (typeof value === 'string') {
      const text = value.length > 320 ? value.slice(0, 320) + '…' : value;
      if (text !== value && omitted.length < 40) omitted.push(pointer);
      budget -= Buffer.byteLength(text);
      return text;
    }
    if (!value || typeof value !== 'object') { budget -= 16; return value; }
    if (Array.isArray(value)) {
      if (value.length > 3 && omitted.length < 40) omitted.push(`${pointer}[3:] (${value.length} total)`);
      return value.slice(0,3).map((v,i) => project(v,`${pointer}[${i}]`,depth+1));
    }
    const entries = Object.entries(value).sort(([a],[b]) => Number(important.test(b))-Number(important.test(a)));
    const output = {};
    for (const [key, item] of entries) {
      if (budget <= 0) { if (omitted.length < 40) omitted.push(`${pointer}.${key}`); break; }
      budget -= Buffer.byteLength(key) + 8;
      output[key] = project(item, `${pointer}.${key}`, depth+1);
    }
    return output;
  };
  const result = project(envelope.result);
  // Keep root evidence gates exact when small; never infer permission from omitted fields.
  const gates = {};
  for (const key of ['evidence_sufficiency', 'source_admission']) {
    const value = envelope.result?.[key] ?? envelope.result?.paper?.[key];
    if (value && bytes(value) <= 4000) gates[key] = value;
  }
  const summary = {
    mode: 'summary', max_bytes: RESEARCH_SUMMARY_MAX_BYTES,
    full_result_bytes: Buffer.byteLength(serialized),
    full_result_sha256: createHash('sha256').update(serialized).digest('hex'),
    complete: omitted.length === 0, omitted_paths: omitted,
    decision_authority: 'Original backend gates only. Omitted, null or shortened evidence is unknown, never permission to advance or claim novelty.',
    evidence_gates: gates,
    read_more: readMore
  };
  const output = { ...envelope, result, presentation: summary };
  // Large caller constraints/queries and next actions also count toward the wire budget.
  if (bytes(output) > RESEARCH_SUMMARY_MAX_BYTES - 1024) {
    output.result = { omitted: true, reason: 'Result exceeds summary presentation budget; read the full response.' };
    output.nextActions = [];
    summary.complete = false;
    summary.omitted_paths = ['result'];
    summary.read_more = submitted
      ? { instruction: 'Inspect the existing discovery/import job records before any retry. Do not repeat the submission to expand this summary.' }
      : { tool: envelope.tool, operation: envelope.operation, responseMode: 'full', instruction: 'Repeat the original request with responseMode=full.' };
  }
  return output;
}
