const PASSED = 'passed';
const FAILED = 'failed';

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasLocalArtifact(value) {
  if (Array.isArray(value)) return value.some(hasLocalArtifact);
  if (value && typeof value === 'object') {
    return hasValue(value.path || value.artifact_path || value.artifactPath);
  }
  return hasValue(value);
}

function check(name, ok, message, fields = {}) {
  return {
    name,
    status: ok ? PASSED : FAILED,
    ok: Boolean(ok),
    message: ok ? '' : message,
    ...fields
  };
}

function collectViolations(checks = []) {
  return checks.filter((entry) => !entry.ok);
}

export function validatePaperCompletionInvariant(paper = {}) {
  const completed = normalizeStatus(paper.status || paper.paper_status || paper.stage) === 'completed'
    || paper.completed === true
    || paper.paper_completed === true;
  if (!completed) {
    return check('paper_completed_requires_parse_or_skip', true, '', { skipped: true });
  }
  const parseArtifact = paper.parse_artifact_path || paper.parseArtifactPath
    || paper.markdown_path || paper.markdownPath
    || paper.semantic_snapshot_path || paper.semanticSnapshotPath
    || paper.artifact_paths || paper.artifactPaths;
  const skipReason = paper.skip_reason || paper.skipReason || paper.explicit_skip_reason || paper.explicitSkipReason;
  return check(
    'paper_completed_requires_parse_or_skip',
    hasLocalArtifact(parseArtifact) || hasValue(skipReason),
    'paper_completed requires a parse artifact or an explicit skip reason'
  );
}

export function validateLlmEnhancedInvariant(snapshot = {}) {
  const enhanced = snapshot.llm_enhanced === true
    || snapshot.llmEnhanced === true
    || normalizeStatus(snapshot.llm_status || snapshot.llmStatus) === 'enhanced'
    || normalizeStatus(snapshot.llm_status || snapshot.llmStatus) === 'completed';
  if (!enhanced) {
    return check('llm_enhanced_requires_ledger', true, '', { skipped: true });
  }
  const refs = snapshot.llm_ledger_refs || snapshot.llmLedgerRefs || snapshot.ledger_refs || snapshot.ledgerRefs;
  return check(
    'llm_enhanced_requires_ledger',
    Array.isArray(refs) && refs.length > 0,
    'llm_enhanced cannot be true without LLM ledger refs'
  );
}

export function validateGraphReadyInvariant(snapshot = {}) {
  const graphReady = snapshot.graph_ready === true
    || snapshot.graphReady === true
    || normalizeStatus(snapshot.graph_status || snapshot.graphStatus) === 'ready';
  if (!graphReady) {
    return check('graph_ready_requires_verified_kuzu_receipt', true, '', { skipped: true });
  }
  const receipt = snapshot.kuzu_commit_receipt || snapshot.kuzuCommitReceipt || snapshot.receipt || {};
  const queries = Array.isArray(receipt.verification_queries || receipt.verificationQueries)
    ? (receipt.verification_queries || receipt.verificationQueries)
    : [];
  const passed = normalizeStatus(receipt.status) === 'committed'
    && queries.length > 0
    && queries.filter((query) => normalizeStatus(query.status) !== 'skipped')
      .every((query) => normalizeStatus(query.status) === 'passed');
  return check(
    'graph_ready_requires_verified_kuzu_receipt',
    passed,
    'graph_ready requires a committed Kuzu receipt with passed verification queries',
    { receipt_status: receipt.status || null }
  );
}

export function validateProjectionReadyInvariant(snapshot = {}) {
  const projectionReady = snapshot.projection_ready === true
    || snapshot.projectionReady === true
    || normalizeStatus(snapshot.projection_status || snapshot.projectionStatus) === 'ready';
  if (!projectionReady) {
    return check('projection_ready_requires_current_graph_generation', true, '', { skipped: true });
  }
  const receipt = snapshot.kuzu_commit_receipt || snapshot.kuzuCommitReceipt || {};
  const receiptGeneration = Number(receipt.graph_generation ?? receipt.graphGeneration);
  const projectionGeneration = Number(
    snapshot.projection_graph_generation
      ?? snapshot.projectionGraphGeneration
      ?? snapshot.graph_generation
      ?? snapshot.graphGeneration
  );
  return check(
    'projection_ready_requires_current_graph_generation',
    Number.isFinite(receiptGeneration)
      && Number.isFinite(projectionGeneration)
      && projectionGeneration >= receiptGeneration,
    'projection_ready cannot refer to an older or missing graph generation',
    {
      receipt_graph_generation: Number.isFinite(receiptGeneration) ? receiptGeneration : null,
      projection_graph_generation: Number.isFinite(projectionGeneration) ? projectionGeneration : null
    }
  );
}

export function validateMcpResearchLookupReadyInvariant(snapshot = {}) {
  const ready = snapshot.mcp_research_lookup_ready === true
    || snapshot.mcpResearchLookupReady === true;
  if (!ready) {
    return check('mcp_research_lookup_ready_requires_graph_generation', true, '', { skipped: true });
  }
  const graphGeneration = snapshot.graph_generation ?? snapshot.graphGeneration;
  return check(
    'mcp_research_lookup_ready_requires_graph_generation',
    Number.isFinite(Number(graphGeneration)),
    'mcp_research_lookup_ready requires a readable graph generation'
  );
}

export function validateIdeaCatalystEvidenceExportInvariant(exportPayload = {}) {
  const status = normalizeStatus(exportPayload.evidence_status || exportPayload.evidenceStatus);
  const fragments = exportPayload.idea_fragments || exportPayload.ideaFragments || [];
  const sourceBacked = status === 'source_backed';
  const weak = status === 'weak_evidence';
  const needsMore = status === 'needs_more_literature';
  const failed = status === 'failed';
  const validStatus = sourceBacked || weak || needsMore || failed;
  const sourceEvidence = (exportPayload.source_spans || exportPayload.sourceSpans || []).length > 0
    || (exportPayload.supporting_papers || exportPayload.supportingPapers || []).length > 0;
  return check(
    'idea_catalyst_export_ready_requires_explicit_evidence_status',
    validStatus && (!sourceBacked || sourceEvidence) && (!failed || fragments.length === 0),
    'idea_catalyst export must use an explicit evidence status and source_backed must include source evidence',
    { evidence_status: status || null }
  );
}

export function validateQueueCompletedInvariant(queue = {}) {
  const completed = normalizeStatus(queue.status) === 'completed'
    || normalizeStatus(queue.stage) === 'completed'
    || queue.queue_completed === true
    || queue.queueCompleted === true;
  if (!completed) {
    return check('queue_completed_requires_terminal_report', true, '', { skipped: true });
  }
  const failedCount = Number(queue.failed_paper_count ?? queue.failedPaperCount ?? queue.failedCount ?? 0);
  const terminalReport = queue.terminal_report_path || queue.terminalReportPath;
  const repairActions = queue.repair_actions || queue.repairActions || [];
  return check(
    'queue_completed_requires_terminal_report',
    hasValue(terminalReport) && (failedCount <= 0 || (Array.isArray(repairActions) && repairActions.length > 0)),
    'queue_completed requires a terminal report, and failed papers require repair actions',
    { failed_count: Number.isFinite(failedCount) ? failedCount : 0 }
  );
}

export function validatePipelineInvariants(snapshot = {}) {
  const checks = [
    validatePaperCompletionInvariant(snapshot.paper || snapshot),
    validateLlmEnhancedInvariant(snapshot.llm || snapshot),
    validateGraphReadyInvariant(snapshot.graph || snapshot),
    validateProjectionReadyInvariant(snapshot.projection || snapshot),
    validateMcpResearchLookupReadyInvariant(snapshot.mcp || snapshot),
    validateQueueCompletedInvariant(snapshot.queue || snapshot)
  ];

  if (snapshot.idea_catalyst_export || snapshot.ideaCatalystExport) {
    checks.push(validateIdeaCatalystEvidenceExportInvariant(snapshot.idea_catalyst_export || snapshot.ideaCatalystExport));
  }

  const violations = collectViolations(checks);
  return {
    invariant_version: 'papernexus-pipeline-invariants-v1',
    ok: violations.length === 0,
    check_count: checks.length,
    violation_count: violations.length,
    checks,
    violations
  };
}
