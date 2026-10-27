import { createHash } from 'node:crypto';

// This is a display budget, never a new authority for scientific or queue state.
export const RESEARCH_SUMMARY_MAX_BYTES = 12288;
const bytes = value => Buffer.byteLength(JSON.stringify(value, null, 2));
const important = /^(status|terminal|counts|usage|coverageAssessment|evidenceBoundary|reviewStatus|freshness|usableForReview|final_status|input_status|paper|paper_id|id|studyId|revision|title|name|operation|runId|run_id|jobId|taskId|source_admission|evidence_sufficiency|reason_codes|next_action|novelty_claim_allowed|experiment_planning_allowed|semantic_equivalence_checked|purpose|task_gate|decision|mechanism_test|selection_basis|policy_version|comparison_summary|inference_target|evidence_freshness|outstanding_runs|budget|source_readiness|performance_claim_status)$/;

export function summarizeResearchEnvelope(envelope, args = {}) {
  const decisionTool = envelope.tool === 'research_decision';
  const decisionWrite = decisionTool && ['project_state_write', 'dry_run'].includes(envelope.evidenceBoundary?.basis);
  const decisionReadMore = { tool: 'research_decision', arguments: {
    operation: 'status', ...(args.corpus ? { corpus: args.corpus } : {}), project: args.project,
    ...(decisionWrite && !args.dryRun ? { requestId: args.requestId } : {}), responseMode: 'full'
  } };
  const submitted = ['discovery_submit', 'import_submit', 'field_research_submit', 'lineage_extract_submit', 'study_write'].includes(envelope.evidenceBoundary?.basis);
  const reconcile = (envelope.nextActions || []).find(action =>
    action.tool === 'literature_review' && ['discovery_status', 'discovery_report', 'import_status', 'field_research_status', 'lineage_status', 'study'].includes(action.arguments?.operation));
  const readMore = decisionWrite ? decisionReadMore : decisionTool && envelope.operation === 'export'
    ? { tool: 'research_decision', arguments: { operation: 'export', ...(args.corpus ? { corpus: args.corpus } : {}), project: args.project, ...(args.assessmentId ? { assessmentId: args.assessmentId } : {}), responseMode: 'full' } }
    : submitted
    ? reconcile ? { ...reconcile, arguments: { ...reconcile.arguments, responseMode: 'full' } }
      : { instruction: 'Inspect the existing discovery/import job records before any retry. Do not repeat the submission to expand this summary.' }
    : { tool: envelope.tool, arguments: { ...args, responseMode: 'full' } };
  const serialized = JSON.stringify(envelope.result);
  const omitted = [];
  let summarySource = envelope.result;
  if (envelope.tool === 'literature_review' && envelope.operation === 'study' && envelope.result?.analysis?.study) {
    const saved = envelope.result;
    const study = saved.analysis.study;
    const map = saved.analysis.result;
    summarySource = { studyId: saved.studyId, revision: saved.revision, title: study.title,
      counts: { selectedPapers: study.paperCount, selectedMethods: study.methodCount, branches: study.branchCount,
        searches: study.searchCount, visiblePapers: map.papers?.length || 0, visibleMethods: map.methods?.length || 0,
        visibleRelations: map.relations?.length || 0 },
      coverageAssessment: saved.coverageAssessment, query: study.query, scope: saved.study.scope,
      sourceQuality: saved.analysis.sourceQuality };
    omitted.push('result.study.papers (read exact paper/card evidence)', 'result.analysis.result (read full for the map)');
  }
  let budget = 5000;
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
  const result = project(summarySource);
  // Keep root evidence gates exact when small; never infer permission from omitted fields.
  const gates = {};
  let gateBudget = 3500;
  for (const key of ['evidence_sufficiency', 'source_admission', 'assessment_gate', 'budget_gate', 'execution_authority', 'based_on_revision',
    'purpose', 'task_gate', 'performance_claim_status', 'performance_claim', 'blocked_actions', 'mechanism_test', 'policy_version', 'comparison_summary', 'evidence_freshness', 'outstanding_runs', 'budget', 'source_readiness', 'graph_readiness',
    'coverageAssessment', 'evidenceBoundary', 'freshness', 'usableForReview']) {
    const original = envelope.result?.[key] ?? envelope.result?.paper?.[key] ?? envelope.result?.project_evidence?.[key] ?? envelope.result?.decision?.[key];
    const value = key === 'blocked_actions' && Array.isArray(original) ? original.map(({ action_id, reason_codes }) => ({ action_id, reason_codes })) : original;
    if (value !== undefined) {
      gates[key] = bytes(value) <= Math.min(2400, gateBudget) ? value : key === 'coverageAssessment'
        ? { status: value.status, complete: false, read_full_required: true,
            missingPaperCount: value.missingPapers?.length ?? null, missingMethodCount: value.missingMethods?.length ?? null,
            mismatchedMethodCount: value.mismatchedMethods?.length ?? null }
        : { status: 'read_full_required', complete: false };
      gateBudget -= bytes(gates[key]);
    }
  }
  const decision = envelope.result?.decision;
  if (decision) {
    const { kind, action_id, action_version, reason, run_record_ids, next_step } = decision;
    const core = { kind, action_id, action_version, reason, run_record_ids, next_step };
    gates.decision = bytes(core) <= 2400 ? core : { kind, status: 'read_full_required', complete: false };
    if (result?.decision) Object.assign(result.decision, gates.decision);
  }
  if (result && typeof result === 'object') Object.assign(result, Object.fromEntries(Object.entries(gates).filter(([key]) => key !== 'decision')));
  const summary = {
    mode: 'summary', max_bytes: RESEARCH_SUMMARY_MAX_BYTES,
    full_result_bytes: Buffer.byteLength(serialized),
    ...(!decisionTool ? { full_result_sha256: createHash('sha256').update(serialized).digest('hex') } : {}),
    complete: omitted.length === 0, omitted_paths: omitted,
    decision_authority: 'Original backend gates only. Omitted, null or shortened evidence is unknown, never permission to advance or claim novelty.',
    evidence_gates: gates,
    read_more: readMore
  };
  const output = { ...envelope, result, presentation: summary };
  // Large caller constraints/queries and next actions also count toward the wire budget.
  if (bytes(output) > RESEARCH_SUMMARY_MAX_BYTES - 1024) {
    output.result = { ...gates, omitted: true, reason: 'Result exceeds summary presentation budget; read the full response.' };
    output.nextActions = [];
    summary.complete = false;
    summary.omitted_paths = ['result'];
    summary.read_more = decisionWrite ? decisionReadMore : decisionTool ? { tool: envelope.tool, arguments: { ...args, responseMode: 'full' } } : submitted
      ? { instruction: 'Inspect the existing discovery/import job records before any retry. Do not repeat the submission to expand this summary.' }
      : { tool: envelope.tool, operation: envelope.operation, responseMode: 'full', instruction: 'Repeat the original request with responseMode=full.' };
  }
  if (bytes(output) > RESEARCH_SUMMARY_MAX_BYTES) {
    summary.read_more = { tool: envelope.tool, operation: decisionWrite ? 'status' : envelope.operation,
      instruction: decisionWrite ? 'Read status with the original corpus, project and requestId. Do not replay the mutation.' : 'Repeat the original read with responseMode=full.' };
    output.result = { omitted: true, ...(gates.decision ? { decision: gates.decision } : {}),
      reason: 'Read exact evidence gates in presentation.evidence_gates and expand the full response for details.' };
  }
  return output;
}
