const PASSED = 'passed';
const FAILED = 'failed';
const STORYLINE_ALLOWED_TRACE_TYPES = new Set([
  'claim',
  'contribution_claim',
  'novelty_claim',
  'challenge',
  'takeaway',
  'review_concern'
]);
const REVIEW_PACKET_REQUIRED_ROLES = new Set([
  'novelty',
  'methods',
  'reproducibility',
  'outsider'
]);
const REVIEW_PACKET_MAJOR_BLOCKING_RECOMMENDATIONS = new Set([
  'major_revision',
  'major_revisions',
  'requires_major_revision',
  'reject',
  'rejected',
  'block',
  'blocked',
  'not_ready',
  'ask_human'
]);
const NOVELTY_CERTIFICATE_SCORE_FIELDS = [
  'novelty',
  'significance',
  'feasibility',
  'grounding',
  'must_cite_completeness',
  'temporal_validity'
];

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeAxisKey(value) {
  const expanded = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const key = normalizeKey(expanded);
  if (['must_cite', 'must_cite_coverage'].includes(key)) return 'must_cite_completeness';
  if (['temporal', 'time_cutoff', 'temporal_cutoff'].includes(key)) return 'temporal_validity';
  return key;
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasLocalArtifact(value) {
  if (Array.isArray(value)) return value.some(hasLocalArtifact);
  if (value && typeof value === 'object') {
    return hasValue(value.path || value.artifact_path || value.artifactPath);
  }
  return hasValue(value);
}

function hasEvidenceRef(value) {
  if (Array.isArray(value)) return value.some(hasEvidenceRef);
  if (value && typeof value === 'object') {
    return hasValue(
      value.id
      || value.span_id
      || value.spanId
      || value.context_id
      || value.contextId
      || value.text
      || value.path
    );
  }
  return hasValue(value);
}

function hasAuditHash(value = {}) {
  return hasValue(
    value.evidence_hash
    || value.evidenceHash
    || value.sha256
    || value.source_hash
    || value.sourceHash
    || value.output_hash
    || value.outputHash
    || value.provenance_id
    || value.provenanceId
  );
}

function hasLicenseScope(value = {}) {
  return hasValue(value.license_scope || value.licenseScope);
}

function invalidSourceEvidenceAudit(records = []) {
  return asArray(records).filter((entry) => (
    !hasLicenseScope(entry)
    || !hasAuditHash(entry)
  ));
}

function hasMustCiteEvidenceRef(entry = {}) {
  return [
    entry.evidence_span_ids,
    entry.evidenceSpanIds,
    entry.source_span_ids,
    entry.sourceSpanIds,
    entry.citation_context_ids,
    entry.citationContextIds,
    entry.citation_context_id,
    entry.citationContextId,
    entry.evidence_spans,
    entry.evidenceSpans,
    entry.source_spans,
    entry.sourceSpans,
    entry.citation_context,
    entry.citationContext
  ].some(hasEvidenceRef);
}

function evidenceRecordIds(entry = {}) {
  if (!entry || typeof entry !== 'object') return [];
  return [
    entry.id,
    entry.span_id,
    entry.spanId,
    entry.source_span_id,
    entry.sourceSpanId,
    entry.snippet_id,
    entry.snippetId,
    entry.context_id,
    entry.contextId,
    entry.citation_context_id,
    entry.citationContextId
  ].filter(hasValue).map(String);
}

function evidenceRefIds(value) {
  if (Array.isArray(value)) return value.flatMap(evidenceRefIds);
  if (value && typeof value === 'object') return evidenceRecordIds(value);
  return hasValue(value) ? [String(value)] : [];
}

function collectEmbeddedEvidenceIds(entry = {}) {
  return new Set([
    ...evidenceRefIds(entry.evidence_spans || entry.evidenceSpans),
    ...evidenceRefIds(entry.source_spans || entry.sourceSpans),
    ...evidenceRefIds(entry.citation_context || entry.citationContext),
    ...evidenceRefIds(entry.citation_contexts || entry.citationContexts)
  ]);
}

function collectSourceEvidenceIds(payload = {}) {
  const ids = new Set();
  const addRecord = (entry) => {
    for (const id of evidenceRecordIds(entry)) ids.add(id);
  };
  const addRecords = (records) => {
    for (const entry of asArray(records)) addRecord(entry);
  };
  addRecords(payload.source_spans || payload.sourceSpans);
  addRecords(payload.evidence_spans || payload.evidenceSpans);
  addRecords(payload.citation_contexts || payload.citationContexts);
  for (const paper of asArray(payload.supporting_papers || payload.supportingPapers)) {
    addRecords(paper.source_spans || paper.sourceSpans);
    addRecords(paper.evidence_spans || paper.evidenceSpans);
    addRecords(paper.snippets);
  }
  for (const fragment of asArray(payload.idea_fragments || payload.ideaFragments)) {
    addRecords(fragment.source_spans || fragment.sourceSpans);
    addRecords(fragment.evidence_spans || fragment.evidenceSpans);
    for (const paper of asArray(fragment.supporting_papers || fragment.supportingPapers)) {
      addRecords(paper.source_spans || paper.sourceSpans);
      addRecords(paper.evidence_spans || paper.evidenceSpans);
      addRecords(paper.snippets);
    }
  }
  return ids;
}

function collectMustCiteEvidenceRefIds(entry = {}) {
  return [
    ...evidenceRefIds(entry.evidence_span_ids || entry.evidenceSpanIds),
    ...evidenceRefIds(entry.evidence_span_id || entry.evidenceSpanId),
    ...evidenceRefIds(entry.source_span_ids || entry.sourceSpanIds),
    ...evidenceRefIds(entry.source_span_id || entry.sourceSpanId),
    ...evidenceRefIds(entry.citation_context_ids || entry.citationContextIds),
    ...evidenceRefIds(entry.citation_context_id || entry.citationContextId)
  ];
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

function storylineTraceRefType(ref) {
  if (typeof ref === 'string') {
    const [prefix] = ref.split(':');
    return normalizeKey(prefix);
  }
  if (ref && typeof ref === 'object') {
    return normalizeKey(ref.kind || ref.type || ref.ref_type || ref.refType || ref.role || ref.category);
  }
  return '';
}

function canonicalStorylineTraceType(value = '') {
  const key = normalizeKey(value);
  if (['contribution_claim', 'novelty_claim'].includes(key)) return 'claim';
  return key;
}

function storylineTraceRefIsAllowed(ref) {
  return STORYLINE_ALLOWED_TRACE_TYPES.has(storylineTraceRefType(ref));
}

function storylineTraceRefId(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') {
    return String(ref.id || ref.ref_id || ref.refId || ref.claim_id || ref.claimId || ref.challenge_id || ref.challengeId || ref.takeaway_id || ref.takeawayId || ref.concern_id || ref.concernId || '').trim();
  }
  return '';
}

function storylineTraceRefText(ref) {
  if (ref && typeof ref === 'object') {
    return compactText(ref.text || ref.label || ref.summary || ref.concern || ref.claim_text || ref.claimText);
  }
  return '';
}

function newStorylineTraceIndex() {
  return {
    claim: { ids: new Set(), texts: new Set() },
    challenge: { ids: new Set(), texts: new Set() },
    takeaway: { ids: new Set(), texts: new Set() },
    review_concern: { ids: new Set(), texts: new Set() }
  };
}

function addStorylineTraceRecord(index, kind = '', id = '', text = '') {
  const canonicalKind = canonicalStorylineTraceType(kind);
  if (!index[canonicalKind]) return;
  if (hasValue(id)) index[canonicalKind].ids.add(String(id));
  if (hasValue(text)) index[canonicalKind].texts.add(compactText(text).toLowerCase());
}

function collectStorylineTraceIndex(payload = {}) {
  const index = newStorylineTraceIndex();
  for (const claim of asArray(payload.contribution_claims || payload.contributionClaims)) {
    addStorylineTraceRecord(index, 'claim', claim.claim_id || claim.claimId || claim.id, claim.claim_text || claim.claimText || claim.text);
  }
  const certificate = payload.novelty_certificate || payload.noveltyCertificate || {};
  for (const claim of asArray(certificate.novelty_claims || certificate.noveltyClaims || certificate.claims)) {
    addStorylineTraceRecord(index, 'claim', claim.claim_id || claim.claimId || claim.id, claim.claim_text || claim.claimText || claim.text);
  }
  for (const challenge of asArray(payload.target_challenges || payload.targetChallenges)) {
    addStorylineTraceRecord(index, 'challenge', challenge.id || challenge.challenge_id || challenge.challengeId, challenge.target_challenge || challenge.targetChallenge || challenge.domain_agnostic_challenge || challenge.domainAgnosticChallenge || challenge.domain_specific_challenge || challenge.domainSpecificChallenge || challenge.challenge || challenge.name);
  }
  for (const analysis of asArray(payload.target_domain_analysis || payload.targetDomainAnalysis)) {
    asArray(analysis.remaining_challenges || analysis.remainingChallenges).forEach((challenge, indexWithinAnalysis) => {
      addStorylineTraceRecord(index, 'challenge', challenge.challenge_id || challenge.challengeId || challenge.id || challenge.name || `challenge:${indexWithinAnalysis + 1}`, challenge.domain_agnostic_challenge || challenge.domainAgnosticChallenge || challenge.domain_specific_challenge || challenge.domainSpecificChallenge || challenge.target_challenge || challenge.targetChallenge || challenge.name);
    });
  }
  for (const takeaway of asArray(payload.source_takeaways || payload.sourceTakeaways || payload.takeaways)) {
    if (typeof takeaway === 'string') {
      addStorylineTraceRecord(index, 'takeaway', takeaway, takeaway);
    } else {
      addStorylineTraceRecord(index, 'takeaway', takeaway.id || takeaway.takeaway_id || takeaway.takeawayId || takeaway.concept || takeaway.name, takeaway.concept || takeaway.name || takeaway.source_domain_formulation || takeaway.sourceDomainFormulation || takeaway.source_logic || takeaway.sourceLogic);
    }
  }
  for (const analysis of asArray(payload.source_domain_analyses || payload.sourceDomainAnalyses)) {
    asArray(analysis.takeaways).forEach((takeaway, indexWithinAnalysis) => {
      addStorylineTraceRecord(index, 'takeaway', takeaway.takeaway_id || takeaway.takeawayId || takeaway.id || takeaway.concept || takeaway.source_domain_formulation || `takeaway:${analysis.source_domain || analysis.sourceDomain || indexWithinAnalysis}`, takeaway.concept || takeaway.source_domain_formulation || takeaway.sourceDomainFormulation || takeaway.source_logic || takeaway.sourceLogic);
    });
  }
  for (const fragment of asArray(payload.idea_fragments || payload.ideaFragments)) {
    for (const takeawayId of asArray(fragment.source_takeaway_ids || fragment.sourceTakeawayIds)) {
      addStorylineTraceRecord(index, 'takeaway', takeawayId, takeawayId);
    }
    for (const takeaway of asArray(fragment.source_takeaways || fragment.sourceTakeaways)) {
      if (typeof takeaway === 'string') {
        addStorylineTraceRecord(index, 'takeaway', takeaway, takeaway);
      } else {
        addStorylineTraceRecord(index, 'takeaway', takeaway.id || takeaway.takeaway_id || takeaway.takeawayId || takeaway.concept || takeaway.name, takeaway.concept || takeaway.name || takeaway.text);
      }
    }
  }
  const packet = payload.review_packet || payload.reviewPacket || {};
  for (const concern of asArray(packet.major_concerns || packet.majorConcerns)) {
    addStorylineTraceRecord(index, 'review_concern', concern.concern_id || concern.concernId || concern.id, concern.concern || concern.summary || concern.text);
  }
  return index;
}

function collectContributionClaimIds(payload = {}) {
  return new Set(asArray(payload.contribution_claims || payload.contributionClaims)
    .map((claim) => claim.claim_id || claim.claimId || claim.id)
    .filter(hasValue)
    .map(String));
}

function provenanceRefId(value = {}) {
  if (value && typeof value === 'object') {
    return compactText(value.provenance_id || value.provenanceId || value.id);
  }
  return compactText(value);
}

function collectProvenanceRefIds(payload = {}) {
  return new Set(asArray(payload.provenance_refs || payload.provenanceRefs)
    .map(provenanceRefId)
    .filter(Boolean));
}

function collectProvenanceRefsById(payload = {}) {
  const entries = new Map();
  for (const entry of asArray(payload.provenance_refs || payload.provenanceRefs)) {
    const id = provenanceRefId(entry);
    if (id) entries.set(id, entry);
  }
  return entries;
}

function collectUngroundedContributionClaimIds(payload = {}) {
  return asArray(payload.contribution_claims || payload.contributionClaims)
    .filter((claim) => !asArray(claim.source_span_ids || claim.sourceSpanIds).length)
    .map((claim) => claim.claim_id || claim.claimId || claim.id)
    .filter(hasValue)
    .map(String);
}

function storylineTraceResolved(index, kind = '', id = '', text = '') {
  const canonicalKind = canonicalStorylineTraceType(kind);
  const records = index[canonicalKind];
  if (!records) return false;
  if (hasValue(id) && records.ids.has(String(id))) return true;
  if (hasValue(text) && records.texts.has(compactText(text).toLowerCase())) return true;
  return false;
}

function normalizeReviewerRole(value = '') {
  const key = normalizeKey(value);
  if (['method', 'methodology', 'methodology_reviewer', 'methods_reviewer'].includes(key)) return 'methods';
  if (['repro', 'reproducibility_reviewer', 'replication'].includes(key)) return 'reproducibility';
  if (['external', 'outside', 'cross_domain', 'non_specialist'].includes(key)) return 'outsider';
  return key;
}

function metaReviewBlocksMajorConcerns(metaReview = {}) {
  const key = normalizeKey(metaReview.recommendation || metaReview.decision);
  return REVIEW_PACKET_MAJOR_BLOCKING_RECOMMENDATIONS.has(key)
    || key.includes('major_revision')
    || key.includes('reject')
    || key.includes('block')
    || key.includes('not_ready');
}

function reviewConcernId(concern = {}) {
  return concern.concern_id || concern.concernId || concern.id || '';
}

function noveltyReasonText(reason) {
  if (typeof reason === 'string') return compactText(reason);
  if (reason && typeof reason === 'object') {
    return compactText(reason.reason || reason.summary || reason.text || reason.explanation);
  }
  return '';
}

function noveltyReasonAxis(reason) {
  if (!reason || typeof reason !== 'object') return '';
  return normalizeAxisKey(
    reason.axis
    || reason.dimension
    || reason.field
    || reason.score_axis
    || reason.scoreAxis
    || reason.metric
  );
}

function missingNoveltyReasonAxes(reasons = []) {
  const covered = new Set();
  const combinedStringReasons = [];
  for (const reason of reasons) {
    const text = noveltyReasonText(reason);
    if (typeof reason === 'string') {
      combinedStringReasons.push(text);
      continue;
    }
    const axis = noveltyReasonAxis(reason);
    if (NOVELTY_CERTIFICATE_SCORE_FIELDS.includes(axis) && hasValue(text)) covered.add(axis);
  }
  if (combinedStringReasons.length) {
    const normalizedText = normalizeAxisKey(combinedStringReasons.join(' '));
    for (const axis of NOVELTY_CERTIFICATE_SCORE_FIELDS) {
      if (normalizedText.includes(axis)) covered.add(axis);
    }
  }
  return NOVELTY_CERTIFICATE_SCORE_FIELDS.filter((axis) => !covered.has(axis));
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
  const sourceSpans = asArray(exportPayload.source_spans || exportPayload.sourceSpans);
  const supportingPapers = asArray(exportPayload.supporting_papers || exportPayload.supportingPapers);
  const sourceBacked = status === 'source_backed';
  const weak = status === 'weak_evidence';
  const needsMore = status === 'needs_more_literature';
  const failed = status === 'failed';
  const validStatus = sourceBacked || weak || needsMore || failed;
  const sourceEvidence = sourceSpans.length > 0 || supportingPapers.length > 0;
  const invalidSourceSpans = sourceBacked ? invalidSourceEvidenceAudit(sourceSpans) : [];
  const invalidSupportingPapers = sourceBacked ? invalidSourceEvidenceAudit(supportingPapers) : [];
  return check(
    'idea_catalyst_export_ready_requires_explicit_evidence_status',
    validStatus
      && (!sourceBacked || (sourceEvidence && invalidSourceSpans.length === 0 && invalidSupportingPapers.length === 0))
      && (!failed || fragments.length === 0),
    'idea_catalyst export must use an explicit evidence status; source_backed evidence must include source evidence with license_scope and audit hash',
    {
      evidence_status: status || null,
      invalid_source_span_audit_count: invalidSourceSpans.length,
      invalid_supporting_paper_audit_count: invalidSupportingPapers.length
    }
  );
}

export function validateContributionClaimGroundingInvariant(payload = {}) {
  const claims = asArray(payload.contribution_claims || payload.contributionClaims);
  if (!claims.length) {
    return check('source_backed_claims_require_source_spans', true, '', { skipped: true });
  }
  const status = normalizeStatus(payload.evidence_status || payload.evidenceStatus);
  if (status !== 'source_backed') {
    return check('source_backed_claims_require_source_spans', true, '', { skipped: true });
  }
  const resolvableSourceEvidenceIds = collectSourceEvidenceIds(payload);
  const unsupported = claims.filter((claim) => !asArray(claim.source_span_ids || claim.sourceSpanIds).length);
  const unresolved = claims.flatMap((claim) => {
    const claimId = claim.claim_id || claim.claimId || '';
    return asArray(claim.source_span_ids || claim.sourceSpanIds)
      .map(String)
      .filter((spanId) => !resolvableSourceEvidenceIds.has(spanId))
      .map((spanId) => ({ claim_id: claimId, source_span_id: spanId }));
  });
  return check(
    'source_backed_claims_require_source_spans',
    unsupported.length === 0 && unresolved.length === 0,
    'source_backed contribution claims require source_span_ids that resolve to source evidence records',
    {
      unsupported_claim_ids: unsupported.map((claim) => claim.claim_id || claim.claimId).filter(Boolean),
      unresolved_source_span_refs: unresolved
    }
  );
}

export function validateContributionClaimProvenanceInvariant(payload = {}) {
  const claims = asArray(payload.contribution_claims || payload.contributionClaims);
  if (!claims.length) {
    return check('source_backed_claims_require_provenance_refs', true, '', { skipped: true });
  }
  const status = normalizeStatus(payload.evidence_status || payload.evidenceStatus);
  if (status !== 'source_backed') {
    return check('source_backed_claims_require_provenance_refs', true, '', { skipped: true });
  }
  const provenanceRefIds = collectProvenanceRefIds(payload);
  const missing = [];
  const unresolved = [];
  for (const claim of claims) {
    const claimId = claim.claim_id || claim.claimId || claim.id || '';
    const provenanceRef = compactText(claim.provenance_ref || claim.provenanceRef);
    if (!provenanceRef) {
      missing.push(claimId);
    } else if (!provenanceRefIds.has(provenanceRef)) {
      unresolved.push({ claim_id: claimId, provenance_ref: provenanceRef });
    }
  }
  return check(
    'source_backed_claims_require_provenance_refs',
    missing.length === 0 && unresolved.length === 0,
    'source_backed contribution claims require provenance_ref entries resolvable to provenance_refs',
    {
      missing_claim_provenance_refs: missing.filter(hasValue),
      unresolved_claim_provenance_refs: unresolved
    }
  );
}

export function validateReviewConcernProvenanceInvariant(payload = {}) {
  const packet = payload.review_packet || payload.reviewPacket;
  if (!packet) {
    return check('source_backed_review_concerns_require_provenance_refs', true, '', { skipped: true });
  }
  const status = normalizeStatus(payload.evidence_status || payload.evidenceStatus);
  if (status !== 'source_backed') {
    return check('source_backed_review_concerns_require_provenance_refs', true, '', { skipped: true });
  }
  const concerns = asArray(packet.major_concerns || packet.majorConcerns);
  if (!concerns.length) {
    return check('source_backed_review_concerns_require_provenance_refs', true, '', { skipped: true });
  }
  const provenanceRefsById = collectProvenanceRefsById(payload);
  const missing = [];
  const unresolved = [];
  const stale = [];
  for (const concern of concerns) {
    const concernId = reviewConcernId(concern);
    const provenanceRef = compactText(concern.provenance_ref || concern.provenanceRef);
    if (!provenanceRef) {
      missing.push(concernId);
      continue;
    }
    const provenanceEntry = provenanceRefsById.get(provenanceRef);
    if (!provenanceEntry) {
      unresolved.push({ concern_id: concernId, provenance_ref: provenanceRef });
      continue;
    }
    const provenanceConcernId = compactText(provenanceEntry.concern_id || provenanceEntry.concernId);
    if (
      provenanceEntry.generated_by_activity !== 'idea_catalyst_review_evidence_export'
      || provenanceConcernId !== concernId
    ) {
      stale.push({
        concern_id: concernId,
        provenance_ref: provenanceRef,
        generated_by_activity: provenanceEntry.generated_by_activity || null,
        provenance_concern_id: provenanceConcernId || null
      });
    }
  }
  return check(
    'source_backed_review_concerns_require_provenance_refs',
    missing.length === 0 && unresolved.length === 0 && stale.length === 0,
    'source_backed review concerns require provenance_ref entries generated for the same review concern',
    {
      missing_review_concern_provenance_refs: missing.filter(hasValue),
      unresolved_review_concern_provenance_refs: unresolved,
      stale_review_concern_provenance_refs: stale
    }
  );
}

export function validateStoryBeatProvenanceInvariant(payload = {}) {
  const storyline = payload.storyline_dag || payload.storylineDAG || payload.storylineDag;
  if (!storyline) {
    return check('source_backed_story_beats_require_provenance_refs', true, '', { skipped: true });
  }
  const status = normalizeStatus(payload.evidence_status || payload.evidenceStatus);
  if (status !== 'source_backed') {
    return check('source_backed_story_beats_require_provenance_refs', true, '', { skipped: true });
  }
  const beats = asArray(storyline.beats);
  if (!beats.length) {
    return check('source_backed_story_beats_require_provenance_refs', true, '', { skipped: true });
  }
  const provenanceRefsById = collectProvenanceRefsById(payload);
  const missing = [];
  const unresolved = [];
  const stale = [];
  for (const beat of beats) {
    const beatId = beat.beat_id || beat.beatId || beat.id || '';
    const provenanceRef = compactText(beat.provenance_ref || beat.provenanceRef);
    if (!provenanceRef) {
      missing.push(beatId);
      continue;
    }
    const provenanceEntry = provenanceRefsById.get(provenanceRef);
    if (!provenanceEntry) {
      unresolved.push({ beat_id: beatId, provenance_ref: provenanceRef });
      continue;
    }
    const provenanceBeatId = compactText(provenanceEntry.beat_id || provenanceEntry.beatId);
    if (
      provenanceEntry.generated_by_activity !== 'idea_catalyst_storybeat_evidence_export'
      || provenanceBeatId !== String(beatId)
    ) {
      stale.push({
        beat_id: beatId,
        provenance_ref: provenanceRef,
        generated_by_activity: provenanceEntry.generated_by_activity || null,
        provenance_beat_id: provenanceBeatId || null
      });
    }
  }
  return check(
    'source_backed_story_beats_require_provenance_refs',
    missing.length === 0 && unresolved.length === 0 && stale.length === 0,
    'source_backed storyline beats require provenance_ref entries generated for the same story beat',
    {
      missing_story_beat_provenance_refs: missing.filter(hasValue),
      unresolved_story_beat_provenance_refs: unresolved,
      stale_story_beat_provenance_refs: stale
    }
  );
}

export function validateMustCiteInvariant(payload = {}) {
  const mustCiteSet = asArray(payload.must_cite_set || payload.mustCiteSet);
  if (!mustCiteSet.length) {
    return check('must_cite_set_entries_are_identifiable', true, '', { skipped: true });
  }
  const sourceBacked = normalizeStatus(payload.evidence_status || payload.evidenceStatus) === 'source_backed';
  const resolvableSourceEvidenceIds = collectSourceEvidenceIds(payload);
  const invalid = mustCiteSet.filter((entry) => (
    !hasValue(entry.citation_id || entry.citationId)
    || !hasValue(entry.title || entry.paper_key || entry.paperKey)
  ));
  const ungrounded = sourceBacked
    ? mustCiteSet.filter((entry) => !hasMustCiteEvidenceRef(entry))
    : [];
  const unresolved = sourceBacked
    ? mustCiteSet.flatMap((entry) => {
        const localIds = collectEmbeddedEvidenceIds(entry);
        return collectMustCiteEvidenceRefIds(entry)
          .filter((refId) => !resolvableSourceEvidenceIds.has(refId) && !localIds.has(refId))
          .map((refId) => ({
            citation_id: entry.citation_id || entry.citationId || '',
            evidence_ref_id: refId
          }));
      })
    : [];
  return check(
    'must_cite_set_entries_are_identifiable',
    invalid.length === 0 && ungrounded.length === 0 && unresolved.length === 0,
    'must_cite_set entries require citation_id plus title or paper_key; source_backed evidence refs must resolve to source spans or citation contexts',
    {
      invalid_count: invalid.length,
      ungrounded_count: ungrounded.length,
      ungrounded_citation_ids: ungrounded.map((entry) => entry.citation_id || entry.citationId).filter(Boolean),
      unresolved_evidence_refs: unresolved
    }
  );
}

export function validateNoveltyCertificateInvariant(payload = {}) {
  const certificate = payload.novelty_certificate || payload.noveltyCertificate;
  if (!certificate) {
    return check('novelty_certificate_scores_are_bounded', true, '', { skipped: true });
  }
  const invalidFields = NOVELTY_CERTIFICATE_SCORE_FIELDS.filter((field) => {
    const value = Number(certificate[field]);
    return !Number.isFinite(value) || value < 0 || value > 1;
  });
  const reasons = asArray(certificate.reasons);
  const invalidReasons = reasons.filter((reason) => !hasValue(noveltyReasonText(reason)));
  const missingReasonAxes = missingNoveltyReasonAxes(reasons);
  const futureLeakageCount = Number(certificate.future_leakage_count ?? certificate.futureLeakageCount ?? 0);
  const temporalValidity = Number(certificate.temporal_validity ?? certificate.temporalValidity ?? 1);
  return check(
    'novelty_certificate_scores_are_bounded',
    invalidFields.length === 0
      && reasons.length > 0
      && invalidReasons.length === 0
      && missingReasonAxes.length === 0
      && Number.isFinite(futureLeakageCount)
      && futureLeakageCount <= 0
      && temporalValidity > 0,
    'novelty_certificate requires bounded 0..1 scores, textual reasons for every score axis, and no future leakage',
    {
      invalid_fields: invalidFields,
      invalid_reason_count: invalidReasons.length,
      missing_reason_axes: missingReasonAxes,
      future_leakage_count: Number.isFinite(futureLeakageCount) ? futureLeakageCount : null,
      temporal_validity: Number.isFinite(temporalValidity) ? temporalValidity : null
    }
  );
}

export function validateReviewPacketInvariant(payload = {}) {
  const packet = payload.review_packet || payload.reviewPacket;
  if (!packet) {
    return check('review_packet_has_panel_and_concern_ids', true, '', { skipped: true });
  }
  const reviewers = asArray(packet.reviewers || packet.reviewer_panel || packet.reviewerPanel);
  const reviewerRoles = new Set(reviewers
    .map((reviewer) => normalizeReviewerRole(reviewer.role || reviewer.reviewer_role || reviewer.reviewerRole))
    .filter(Boolean));
  const concerns = asArray(packet.major_concerns || packet.majorConcerns);
  const missingRoles = [...REVIEW_PACKET_REQUIRED_ROLES].filter((role) => !reviewerRoles.has(role));
  const invalidConcerns = concerns.filter((concern) => (
    !hasValue(reviewConcernId(concern))
    || !hasValue(concern.reviewer_role || concern.reviewerRole)
    || !hasValue(concern.severity)
    || !hasValue(concern.concern || concern.summary || concern.text)
    || typeof concern.addressed !== 'boolean'
  ));
  const concernIds = new Set(concerns
    .map(reviewConcernId)
    .filter(hasValue)
    .map(String));
  const invalidConcernReviewerRoles = concerns
    .filter((concern) => !reviewerRoles.has(normalizeReviewerRole(concern.reviewer_role || concern.reviewerRole)))
    .map((concern) => ({
      concern_id: reviewConcernId(concern) || null,
      reviewer_role: concern.reviewer_role || concern.reviewerRole || null
    }));
  const unresolvedReviewerConcernRefs = reviewers.flatMap((reviewer) => (
    asArray(reviewer.concerns || reviewer.major_concerns || reviewer.majorConcerns)
      .map(String)
      .filter((concernId) => !concernIds.has(concernId))
      .map((concernId) => ({
        reviewer_id: reviewer.reviewer_id || reviewer.reviewerId || null,
        concern_id: concernId
      }))
  ));
  const claimIds = collectContributionClaimIds(payload);
  const unresolvedAffectedClaimRefs = concerns.flatMap((concern) => (
    asArray(concern.affected_claim_ids || concern.affectedClaimIds)
      .filter((claimId) => !claimIds.has(String(claimId)))
      .map((claimId) => ({
        concern_id: reviewConcernId(concern) || null,
        claim_id: claimId
      }))
  ));
  const activeConcernClaimIds = new Set(concerns
    .filter((concern) => concern.addressed === false)
    .flatMap((concern) => asArray(concern.affected_claim_ids || concern.affectedClaimIds))
    .map(String));
  const uncoveredUnsupportedClaimIds = collectUngroundedContributionClaimIds(payload)
    .filter((claimId) => !activeConcernClaimIds.has(claimId));
  const metaReview = packet.meta_review || packet.metaReview;
  const activeMajorConcernIds = concerns
    .filter((concern) => normalizeKey(concern.severity) === 'major' && concern.addressed === false)
    .map(reviewConcernId)
    .filter(hasValue);
  const invalidMetaReviewMajorConcernIds = activeMajorConcernIds.length && !metaReviewBlocksMajorConcerns(metaReview)
    ? activeMajorConcernIds
    : [];
  return check(
    'review_packet_has_panel_and_concern_ids',
    missingRoles.length === 0
      && Boolean(metaReview)
      && hasValue(metaReview.recommendation || metaReview.decision)
      && Array.isArray(packet.major_concerns || packet.majorConcerns)
      && invalidConcerns.length === 0
      && invalidConcernReviewerRoles.length === 0
      && unresolvedReviewerConcernRefs.length === 0
      && unresolvedAffectedClaimRefs.length === 0
      && uncoveredUnsupportedClaimIds.length === 0
      && invalidMetaReviewMajorConcernIds.length === 0,
    'review_packet requires novelty/methods/reproducibility/outsider reviewers, meta_review recommendation, structured major_concerns tied to reviewer roles, resolvable reviewer/affected-claim refs, explicit active concerns for ungrounded claims, and blocking meta-review when major concerns are unresolved',
    {
      reviewer_count: reviewers.length,
      reviewer_roles: [...reviewerRoles].sort(),
      missing_reviewer_roles: missingRoles,
      invalid_concern_count: invalidConcerns.length,
      invalid_concern_reviewer_roles: invalidConcernReviewerRoles,
      unresolved_reviewer_concern_refs: unresolvedReviewerConcernRefs,
      unresolved_affected_claim_refs: unresolvedAffectedClaimRefs,
      uncovered_unsupported_claim_ids: uncoveredUnsupportedClaimIds,
      invalid_meta_review_major_concern_ids: invalidMetaReviewMajorConcernIds
    }
  );
}

export function validateStorylineCoverageInvariant(payload = {}) {
  const storyline = payload.storyline_dag || payload.storylineDAG || payload.storylineDag;
  if (!storyline) {
    return check('storyline_dag_beats_are_traceable', true, '', { skipped: true });
  }
  const traceIndex = collectStorylineTraceIndex(payload);
  const beats = asArray(storyline.beats);
  const beatIds = new Set(beats.map((beat) => beat.beat_id || beat.beatId).filter(Boolean));
  const unsupported = beats
    .filter((beat) => beat.supported === false)
    .map((beat) => beat.beat_id || beat.beatId)
    .filter(Boolean);
  const declaredUnsupported = asArray(storyline.unsupported_beats || storyline.unsupportedBeats);
  const undeclaredUnsupported = unsupported.filter((beatId) => !declaredUnsupported.includes(beatId));
  const invalidEdges = asArray(storyline.edges).filter((edge) => (
    !beatIds.has(edge.source_beat_id || edge.sourceBeatId)
    || !beatIds.has(edge.target_beat_id || edge.targetBeatId)
  ));
  const untraceable = beats.filter((beat) => {
    const traceRefs = asArray(beat.trace_refs || beat.traceRefs);
    const allowedTraceRefs = traceRefs.filter(storylineTraceRefIsAllowed);
    return !allowedTraceRefs.length
      && !asArray(beat.claim_ids || beat.claimIds).length
      && !asArray(beat.challenge_ids || beat.challengeIds).length
      && !asArray(beat.takeaway_ids || beat.takeawayIds).length
      && !asArray(beat.review_concern_ids || beat.reviewConcernIds).length;
  });
  const unsupportedTraceRefs = beats.flatMap((beat) => (
    asArray(beat.trace_refs || beat.traceRefs)
      .filter((ref) => !storylineTraceRefIsAllowed(ref))
      .map((ref) => ({
        beat_id: beat.beat_id || beat.beatId || null,
        trace_type: storylineTraceRefType(ref) || 'unknown'
      }))
  ));
  const unresolvedTraceRefs = beats.flatMap((beat) => {
    const beatId = beat.beat_id || beat.beatId || null;
    const refs = [
      ...asArray(beat.trace_refs || beat.traceRefs)
        .filter(storylineTraceRefIsAllowed)
        .map((ref) => ({
          beat_id: beatId,
          trace_type: canonicalStorylineTraceType(storylineTraceRefType(ref)),
          trace_id: storylineTraceRefId(ref),
          trace_text: storylineTraceRefText(ref)
        })),
      ...asArray(beat.claim_ids || beat.claimIds).map((id) => ({ beat_id: beatId, trace_type: 'claim', trace_id: id, trace_text: '' })),
      ...asArray(beat.challenge_ids || beat.challengeIds).map((id) => ({ beat_id: beatId, trace_type: 'challenge', trace_id: id, trace_text: '' })),
      ...asArray(beat.takeaway_ids || beat.takeawayIds).map((id) => ({ beat_id: beatId, trace_type: 'takeaway', trace_id: id, trace_text: '' })),
      ...asArray(beat.review_concern_ids || beat.reviewConcernIds).map((id) => ({ beat_id: beatId, trace_type: 'review_concern', trace_id: id, trace_text: '' }))
    ];
    return refs
      .filter((ref) => !storylineTraceResolved(traceIndex, ref.trace_type, ref.trace_id, ref.trace_text))
      .map((ref) => ({
        beat_id: ref.beat_id,
        trace_type: ref.trace_type,
        trace_id: ref.trace_id || null
      }));
  });
  const supportedWithoutTrace = untraceable
    .filter((beat) => beat.supported !== false)
    .map((beat) => beat.beat_id || beat.beatId)
    .filter(Boolean);
  return check(
    'storyline_dag_beats_are_traceable',
    beats.length > 0
      && undeclaredUnsupported.length === 0
      && invalidEdges.length === 0
      && untraceable.length === 0
      && unsupportedTraceRefs.length === 0
      && unresolvedTraceRefs.length === 0
      && supportedWithoutTrace.length === 0,
    'storyline_dag requires beats, valid edges, and every beat traceable to resolvable claim, challenge, takeaway, or review concern records',
    {
      undeclared_unsupported_beats: undeclaredUnsupported,
      invalid_edge_count: invalidEdges.length,
      untraceable_beat_ids: untraceable.map((beat) => beat.beat_id || beat.beatId).filter(Boolean),
      unsupported_trace_refs: unsupportedTraceRefs,
      unresolved_trace_refs: unresolvedTraceRefs,
      supported_without_trace_beat_ids: supportedWithoutTrace
    }
  );
}

function collectFalsificationPlans(payload = {}) {
  return [
    ...asArray(payload.counterfactuals),
    ...asArray(payload.falsification_plans || payload.falsificationPlans)
  ];
}

function falsificationPlanId(plan = {}) {
  return plan.falsification_plan_id || plan.falsificationPlanId || plan.id || null;
}

export function validateFalsificationPlanInvariant(payload = {}) {
  const plans = collectFalsificationPlans(payload);
  if (!plans.length) {
    return check('falsification_plans_are_claim_grounded', true, '', { skipped: true });
  }
  const claimIds = collectContributionClaimIds(payload);
  const invalidPlans = plans
    .filter((plan) => (
      !hasValue(plan.claim_id || plan.claimId)
      || !hasValue(plan.question)
      || !asArray(plan.required_evidence || plan.requiredEvidence).length
    ))
    .map((plan) => ({
      falsification_plan_id: falsificationPlanId(plan),
      missing_claim_ref: !hasValue(plan.claim_id || plan.claimId),
      missing_question: !hasValue(plan.question),
      missing_required_evidence: !asArray(plan.required_evidence || plan.requiredEvidence).length
    }));
  const unresolvedClaimRefs = plans
    .filter((plan) => hasValue(plan.claim_id || plan.claimId))
    .filter((plan) => !claimIds.has(String(plan.claim_id || plan.claimId)))
    .map((plan) => ({
      falsification_plan_id: falsificationPlanId(plan),
      claim_id: String(plan.claim_id || plan.claimId)
    }));
  return check(
    'falsification_plans_are_claim_grounded',
    invalidPlans.length === 0 && unresolvedClaimRefs.length === 0,
    'falsification plans require claim_id, question, required_evidence, and claim refs resolvable to contribution_claims',
    {
      invalid_plans: invalidPlans,
      unresolved_claim_refs: unresolvedClaimRefs
    }
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
    const exportPayload = snapshot.idea_catalyst_export || snapshot.ideaCatalystExport;
    checks.push(validateIdeaCatalystEvidenceExportInvariant(exportPayload));
    checks.push(validateContributionClaimGroundingInvariant(exportPayload));
    checks.push(validateContributionClaimProvenanceInvariant(exportPayload));
    checks.push(validateReviewConcernProvenanceInvariant(exportPayload));
    checks.push(validateStoryBeatProvenanceInvariant(exportPayload));
    checks.push(validateMustCiteInvariant(exportPayload));
    checks.push(validateNoveltyCertificateInvariant(exportPayload));
    checks.push(validateReviewPacketInvariant(exportPayload));
    checks.push(validateStorylineCoverageInvariant(exportPayload));
    checks.push(validateFalsificationPlanInvariant(exportPayload));
  } else if (
    snapshot.contribution_claims
    || snapshot.must_cite_set
    || snapshot.novelty_certificate
    || snapshot.review_packet
    || snapshot.storyline_dag
    || snapshot.counterfactuals
    || snapshot.falsification_plans
    || snapshot.falsificationPlans
  ) {
    checks.push(validateContributionClaimGroundingInvariant(snapshot));
    checks.push(validateMustCiteInvariant(snapshot));
    checks.push(validateNoveltyCertificateInvariant(snapshot));
    checks.push(validateReviewPacketInvariant(snapshot));
    checks.push(validateStorylineCoverageInvariant(snapshot));
    checks.push(validateFalsificationPlanInvariant(snapshot));
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
