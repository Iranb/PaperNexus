import { readText, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES } from './schema.js';

export const INNOVATION_WRITEBACK_CONTRACT_VERSION = 'papernexus-innovation-writeback-v1';
const REQUIRED_REVIEW_ROLES = new Set(['novelty', 'methods', 'reproducibility', 'outsider']);
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
  ['novelty', 'novelty'],
  ['significance', 'significance'],
  ['feasibility', 'feasibility'],
  ['grounding', 'grounding'],
  ['must_cite_completeness', 'mustCiteCompleteness'],
  ['temporal_validity', 'temporalValidity']
];
const NOVELTY_CERTIFICATE_SCORE_AXES = NOVELTY_CERTIFICATE_SCORE_FIELDS.map(([snakeKey]) => snakeKey);
const STORYLINE_ALLOWED_TRACE_TYPES = new Set(['claim', 'challenge', 'takeaway', 'review_concern']);

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeAxisKey(value = '') {
  const expanded = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const key = normalizeKey(expanded);
  if (['must_cite', 'must_cite_coverage'].includes(key)) return 'must_cite_completeness';
  if (['temporal', 'time_cutoff', 'temporal_cutoff'].includes(key)) return 'temporal_validity';
  return key;
}

function stableNodeId(prefix, ...parts) {
  const explicit = compactText(parts.find((part) => typeof part === 'string' && part.includes(':')), 240);
  if (explicit && explicit.startsWith(`${prefix}:`)) return explicit;
  return `${prefix}:${stableHash(parts.map((part) => compactText(part, 1000)).join(':'), 16)}`;
}

function hasInnovationFields(value = {}) {
  const object = asObject(value);
  return Boolean(
    object.contribution_claims
    || object.contributionClaims
    || object.must_cite_set
    || object.mustCiteSet
    || object.review_packet
    || object.reviewPacket
    || object.storyline_dag
    || object.storylineDag
    || object.counterfactuals
    || object.falsification_plans
    || object.falsificationPlans
  );
}

function unwrapInnovationArtifact(input = {}) {
  const object = asObject(input);
  if (hasInnovationFields(object)) return object;
  for (const key of [
    'evidence_export',
    'evidenceExport',
    'innovation_artifacts',
    'innovationArtifacts',
    'packet_bundle',
    'packetBundle',
    'result',
    'export'
  ]) {
    const child = asObject(object[key]);
    if (Object.keys(child).length) {
      const unwrapped = unwrapInnovationArtifact(child);
      if (hasInnovationFields(unwrapped)) return unwrapped;
    }
  }
  return object;
}

function nodeOperation(id, type, name, properties = {}) {
  return {
    action: 'create_node',
    id,
    type,
    name: compactText(name || id, 240),
    properties
  };
}

function edgeOperation(sourceId, targetId, type, properties = {}) {
  return {
    action: 'create_edge',
    sourceId,
    targetId,
    edgeType: type,
    properties
  };
}

function dedupeOperations(operations = []) {
  const seen = new Set();
  const output = [];
  for (const operation of operations) {
    const key = operation.action === 'create_node'
      ? `node:${operation.id}`
      : `edge:${operation.sourceId}:${operation.edgeType}:${operation.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(operation);
  }
  return output;
}

function collectSourceSpans(artifact = {}) {
  return [
    ...asArray(artifact.source_spans || artifact.sourceSpans),
    ...asArray(artifact.idea_fragments || artifact.ideaFragments).flatMap((fragment) => asArray(fragment.source_spans || fragment.sourceSpans)),
    ...asArray(artifact.source_domain_analyses || artifact.sourceDomainAnalyses).flatMap((analysis) => asArray(analysis.source_spans || analysis.sourceSpans))
  ].map((span, index) => {
    const id = compactText(span.span_id || span.spanId || span.id || `span:${stableHash(`${span.text || span.evidence_text || ''}:${index}`, 12)}`, 240);
    const text = compactText(span.text || span.evidence_text || span.evidenceText || span.snippet || '', 1600);
    const paperKey = compactText(span.paper_key || span.paperKey || span.paper_id || span.paperId, 240);
    const evidenceHash = compactText(span.evidence_hash || span.evidenceHash || span.sha256 || span.source_hash || span.sourceHash, 240)
      || stableHash(JSON.stringify({
        paper_key: paperKey,
        span_id: id,
        text
      }), 24);
    const sourceAnchor = compactText(span.source_anchor || span.sourceAnchor || span.anchor, 360)
      || compactText([paperKey, id].filter(Boolean).join('#'), 360);
    return {
      ...asObject(span),
      id,
      span_id: id,
      text,
      paper_key: paperKey,
      paper_title: compactText(span.paper_title || span.paperTitle || span.title, 360),
      license_scope: compactText(span.license_scope || span.licenseScope, 240) || 'derived_snippet_research_use',
      evidence_hash: evidenceHash,
      source_anchor: sourceAnchor || null
    };
  }).filter((span) => span.id && span.text);
}

function claimIdFor(claim = {}, index = 0) {
  return stableNodeId(
    'claim',
    claim.claim_id || claim.claimId || claim.id,
    claim.claim_text || claim.claimText || `claim-${index}`
  );
}

function paperIdFor(entry = {}) {
  const explicit = compactText(entry.paper_id || entry.paperId || entry.paper_key || entry.paperKey, 240);
  if (explicit.startsWith('paper:')) return explicit;
  const doi = compactText(entry.doi || entry.DOI || entry.identifiers?.doi || entry.referenceIdentifiers?.doi, 240)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
  if (/^10\.\d{4,9}\//.test(doi)) return `paper:doi:${stableHash(doi, 20)}`;
  return stableNodeId('paper', explicit, entry.title || entry.paper_title || entry.paperTitle);
}

function mustCiteEdgeType(entry = {}) {
  const kind = compactText(entry.obligation_type || entry.obligationType || entry.reason, 240).toLowerCase();
  if (/baseline|anchor/.test(kind)) return EDGE_TYPES.CITES_FOR_BASELINE;
  if (/contrast|limitation|negative/.test(kind)) return EDGE_TYPES.CITES_FOR_CONTRAST;
  return EDGE_TYPES.CITES_FOR_METHOD;
}

function mustCiteCitationId(entry = {}) {
  return compactText(entry.citation_id || entry.citationId, 240);
}

function mustCitePaperKey(entry = {}) {
  return compactText(entry.paper_key || entry.paperKey || entry.paper_id || entry.paperId || entry.title, 360);
}

function normalizeReviewerRole(value = '') {
  const key = compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
  return compactText(concern.concern_id || concern.concernId || concern.id, 240);
}

function reviewConcernDisplayId(concern = {}) {
  return reviewConcernId(concern) || concern._writebackId || '';
}

function reviewConcernRefs(reviewer = {}) {
  return asArray(reviewer.concerns || reviewer.major_concerns || reviewer.majorConcerns)
    .map((ref) => compactText(ref, 240))
    .filter(Boolean);
}

function affectedClaimRefs(concern = {}) {
  return asArray(concern.affected_claim_ids || concern.affectedClaimIds)
    .map((ref) => compactText(ref, 240))
    .filter(Boolean);
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
  ].map((ref) => compactText(ref, 240)).filter(Boolean);
}

function evidenceRefIds(value) {
  if (Array.isArray(value)) return value.flatMap(evidenceRefIds);
  if (value && typeof value === 'object') return evidenceRecordIds(value);
  const ref = compactText(value, 240);
  return ref ? [ref] : [];
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

function collectEmbeddedEvidenceIds(entry = {}) {
  return new Set([
    ...evidenceRefIds(entry.evidence_spans || entry.evidenceSpans),
    ...evidenceRefIds(entry.source_spans || entry.sourceSpans),
    ...evidenceRefIds(entry.citation_context || entry.citationContext),
    ...evidenceRefIds(entry.citation_contexts || entry.citationContexts)
  ]);
}

function hasMustCiteEvidenceRef(entry = {}) {
  return Boolean(
    collectMustCiteEvidenceRefIds(entry).length
    || collectEmbeddedEvidenceIds(entry).size
  );
}

function collectArtifactEvidenceIds(artifact = {}, normalized = {}) {
  const ids = new Set();
  const addId = (id) => {
    const ref = compactText(id, 240);
    if (ref) ids.add(ref);
  };
  const addRecord = (entry) => {
    for (const id of evidenceRecordIds(entry)) addId(id);
  };
  const addRecords = (records) => {
    for (const entry of asArray(records)) addRecord(entry);
  };
  addRecords(normalized.sourceSpans);
  addRecords(artifact.source_spans || artifact.sourceSpans);
  addRecords(artifact.evidence_spans || artifact.evidenceSpans);
  addRecords(artifact.citation_contexts || artifact.citationContexts);
  for (const claim of normalized.claims) {
    asArray(claim.source_span_ids || claim.sourceSpanIds).forEach(addId);
    asArray(claim.citation_context_ids || claim.citationContextIds).forEach(addId);
  }
  for (const paper of asArray(artifact.supporting_papers || artifact.supportingPapers)) {
    addRecords(paper.source_spans || paper.sourceSpans);
    addRecords(paper.evidence_spans || paper.evidenceSpans);
    addRecords(paper.snippets);
  }
  for (const fragment of asArray(artifact.idea_fragments || artifact.ideaFragments)) {
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

function claimReferenceIds(claim = {}) {
  return [
    claim._writebackId,
    claim.claim_id,
    claim.claimId,
    claim.id,
    claimIdFor(claim)
  ].map((ref) => compactText(ref, 240)).filter(Boolean);
}

function claimReferenceMap(claims = []) {
  return new Map(claims.flatMap((claim) => (
    claimReferenceIds(claim).map((ref) => [ref, claim._writebackId])
  )));
}

function planClaimRef(plan = {}) {
  return compactText(plan.claim_id || plan.claimId, 240);
}

function planDisplayId(plan = {}) {
  return compactText(plan.falsification_plan_id || plan.falsificationPlanId || plan.id || plan._writebackId, 240);
}

function certificateScore(certificate = {}, snakeKey = '', camelKey = snakeKey) {
  const value = certificate[snakeKey] ?? certificate[camelKey];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function certificateReasonText(reason) {
  if (typeof reason === 'string') return compactText(reason, 600);
  if (reason && typeof reason === 'object') {
    return compactText(reason.reason || reason.summary || reason.text || reason.explanation, 600);
  }
  return '';
}

function certificateReasons(certificate = {}) {
  return asArray(certificate.reasons).map(certificateReasonText).filter(Boolean);
}

function certificateReasonAxis(reason) {
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

function certificateAxisScore(certificate = {}, axis = '') {
  const field = NOVELTY_CERTIFICATE_SCORE_FIELDS.find(([snakeKey]) => snakeKey === axis);
  return field ? certificateScore(certificate, field[0], field[1]) : null;
}

function certificateAxisReasons(certificate = {}) {
  return asArray(certificate.reasons).map((reason) => {
    const axis = certificateReasonAxis(reason);
    const text = certificateReasonText(reason);
    if (!NOVELTY_CERTIFICATE_SCORE_AXES.includes(axis) || !text) return null;
    const explicitScore = reason && typeof reason === 'object' ? Number(reason.score) : NaN;
    return {
      axis,
      reason: text,
      score: Number.isFinite(explicitScore) ? explicitScore : certificateAxisScore(certificate, axis)
    };
  }).filter(Boolean);
}

function coveredCertificateReasonAxes(certificate = {}) {
  const covered = new Set(certificateAxisReasons(certificate).map((entry) => entry.axis));
  const combinedStringReasons = asArray(certificate.reasons)
    .filter((reason) => typeof reason === 'string')
    .map(certificateReasonText)
    .join(' ');
  if (combinedStringReasons) {
    const normalizedText = normalizeAxisKey(combinedStringReasons);
    for (const axis of NOVELTY_CERTIFICATE_SCORE_AXES) {
      if (normalizedText.includes(axis)) covered.add(axis);
    }
  }
  return NOVELTY_CERTIFICATE_SCORE_AXES.filter((axis) => covered.has(axis));
}

function missingCertificateReasonAxes(certificate = {}) {
  const covered = new Set(coveredCertificateReasonAxes(certificate));
  return NOVELTY_CERTIFICATE_SCORE_AXES.filter((axis) => !covered.has(axis));
}

function invalidNoveltyCertificateFields(certificate = {}) {
  return NOVELTY_CERTIFICATE_SCORE_FIELDS
    .filter(([snakeKey, camelKey]) => {
      const value = certificateScore(certificate, snakeKey, camelKey);
      return value === null || value < 0 || value > 1;
    })
    .map(([snakeKey]) => snakeKey);
}

function canonicalStorylineTraceKind(value = '') {
  const key = normalizeKey(value);
  if (['contribution_claim', 'novelty_claim'].includes(key)) return 'claim';
  return key;
}

function storylineTraceRefKind(ref) {
  if (typeof ref === 'string') return canonicalStorylineTraceKind(ref);
  if (ref && typeof ref === 'object') {
    return canonicalStorylineTraceKind(ref.kind || ref.type || ref.ref_type || ref.refType || ref.role || ref.category);
  }
  return '';
}

function storylineTraceRefId(ref) {
  if (typeof ref === 'string') return '';
  if (ref && typeof ref === 'object') {
    return compactText(
      ref.id
      || ref.ref_id
      || ref.refId
      || ref.claim_id
      || ref.claimId
      || ref.challenge_id
      || ref.challengeId
      || ref.takeaway_id
      || ref.takeawayId
      || ref.concern_id
      || ref.concernId,
      240
    );
  }
  return '';
}

function storylineTraceRefText(ref) {
  if (ref && typeof ref === 'object') {
    return compactText(ref.text || ref.label || ref.summary || ref.concern || ref.claim_text || ref.claimText, 1600);
  }
  return '';
}

function normalizeStorylineTraceRef(ref = {}) {
  return {
    ...asObject(ref),
    kind: storylineTraceRefKind(ref),
    id: storylineTraceRefId(ref),
    text: storylineTraceRefText(ref) || compactText(asObject(ref).text, 1600)
  };
}

function collectTraceRefs(beat = {}) {
  return [
    ...asArray(beat.trace_refs || beat.traceRefs),
    ...asArray(beat.claim_ids || beat.claimIds).map((id) => ({ kind: 'claim', id })),
    ...asArray(beat.challenge_ids || beat.challengeIds).map((id) => ({ kind: 'challenge', id })),
    ...asArray(beat.takeaway_ids || beat.takeawayIds).map((id) => ({ kind: 'takeaway', id })),
    ...asArray(beat.review_concern_ids || beat.reviewConcernIds).map((id) => ({ kind: 'review_concern', id }))
  ].map(normalizeStorylineTraceRef).filter((ref) => ref.kind && ref.id);
}

function firstCompactText(...values) {
  return values.map((value) => compactText(value, 1600)).find(Boolean) || '';
}

function newStorylineTraceIndex() {
  return Object.fromEntries([...STORYLINE_ALLOWED_TRACE_TYPES].map((kind) => [kind, {
    ids: new Map(),
    texts: new Map()
  }]));
}

function addStorylineTraceRecord(index, kind = '', id = '', text = '', nodeId = '') {
  const canonicalKind = canonicalStorylineTraceKind(kind);
  const bucket = index[canonicalKind];
  if (!bucket) return;
  const record = {
    kind: canonicalKind,
    id: compactText(id, 240),
    text: compactText(text, 1600),
    nodeId: compactText(nodeId, 240)
  };
  if (record.id) bucket.ids.set(record.id, record);
  if (record.text) bucket.texts.set(record.text.toLowerCase(), record);
}

function addStorylineTraceAliases(index, kind = '', aliases = [], text = '', nodeId = '') {
  const canonicalKind = canonicalStorylineTraceKind(kind);
  const cleanAliases = unique(asArray(aliases).flatMap((alias) => {
    const value = compactText(alias, 240);
    if (!value) return [];
    return value.includes(':') ? [value] : [value, `${canonicalKind}:${stableHash(value, 12)}`];
  }).filter(Boolean));
  if (!cleanAliases.length) {
    addStorylineTraceRecord(index, kind, '', text, nodeId);
    return;
  }
  for (const alias of cleanAliases) {
    addStorylineTraceRecord(index, kind, alias, text, nodeId);
  }
}

function collectStorylineTraceIndex(artifact = {}, normalized = {}) {
  const index = newStorylineTraceIndex();
  for (const claim of normalized.claims) {
    const text = claim.claim_text || claim.claimText || claim.text;
    addStorylineTraceAliases(index, 'claim', [
      claim._writebackId,
      claim.claim_id,
      claim.claimId,
      claim.id
    ], text, claim._writebackId);
  }

  for (const challenge of asArray(artifact.target_challenges || artifact.targetChallenges)) {
    const id = challenge.id || challenge.challenge_id || challenge.challengeId || challenge.name;
    const text = firstCompactText(
      challenge.target_challenge,
      challenge.targetChallenge,
      challenge.domain_agnostic_challenge,
      challenge.domainAgnosticChallenge,
      challenge.domain_specific_challenge,
      challenge.domainSpecificChallenge,
      challenge.challenge,
      challenge.name
    );
    addStorylineTraceAliases(index, 'challenge', [id], text, id ? stableNodeId('challenge', id) : '');
  }

  for (const analysis of asArray(artifact.target_domain_analysis || artifact.targetDomainAnalysis)) {
    asArray(analysis.remaining_challenges || analysis.remainingChallenges).forEach((challenge, indexWithinAnalysis) => {
      const id = challenge.challenge_id || challenge.challengeId || challenge.id || challenge.name || `challenge:${indexWithinAnalysis + 1}`;
      const text = firstCompactText(
        challenge.domain_agnostic_challenge,
        challenge.domainAgnosticChallenge,
        challenge.domain_specific_challenge,
        challenge.domainSpecificChallenge,
        challenge.target_challenge,
        challenge.targetChallenge,
        challenge.name
      );
      addStorylineTraceAliases(index, 'challenge', [id], text, stableNodeId('challenge', id));
    });
  }

  for (const takeaway of asArray(artifact.source_takeaways || artifact.sourceTakeaways || artifact.takeaways)) {
    const id = typeof takeaway === 'string'
      ? takeaway
      : takeaway.id || takeaway.takeaway_id || takeaway.takeawayId || takeaway.concept || takeaway.name;
    const text = typeof takeaway === 'string'
      ? takeaway
      : firstCompactText(
        takeaway.concept,
        takeaway.name,
        takeaway.source_domain_formulation,
        takeaway.sourceDomainFormulation,
        takeaway.source_logic,
        takeaway.sourceLogic
      );
    addStorylineTraceAliases(index, 'takeaway', [id], text, id ? stableNodeId('takeaway', id) : '');
  }

  for (const analysis of asArray(artifact.source_domain_analyses || artifact.sourceDomainAnalyses)) {
    asArray(analysis.takeaways).forEach((takeaway, indexWithinAnalysis) => {
      const id = takeaway.takeaway_id
        || takeaway.takeawayId
        || takeaway.id
        || takeaway.concept
        || takeaway.source_domain_formulation
        || `takeaway:${analysis.source_domain || analysis.sourceDomain || indexWithinAnalysis}`;
      const text = firstCompactText(
        takeaway.concept,
        takeaway.source_domain_formulation,
        takeaway.sourceDomainFormulation,
        takeaway.source_logic,
        takeaway.sourceLogic
      );
      addStorylineTraceAliases(index, 'takeaway', [id], text, stableNodeId('takeaway', id));
    });
  }

  for (const fragment of asArray(artifact.idea_fragments || artifact.ideaFragments)) {
    for (const takeawayId of asArray(fragment.source_takeaway_ids || fragment.sourceTakeawayIds)) {
      addStorylineTraceAliases(index, 'takeaway', [takeawayId], takeawayId, stableNodeId('takeaway', takeawayId));
    }
    for (const takeaway of asArray(fragment.source_takeaways || fragment.sourceTakeaways)) {
      const id = typeof takeaway === 'string'
        ? takeaway
        : takeaway.id || takeaway.takeaway_id || takeaway.takeawayId || takeaway.concept || takeaway.name;
      const text = typeof takeaway === 'string'
        ? takeaway
        : firstCompactText(takeaway.concept, takeaway.name, takeaway.text);
      addStorylineTraceAliases(index, 'takeaway', [id], text, id ? stableNodeId('takeaway', id) : '');
    }
  }

  for (const concern of normalized.reviewConcerns) {
    const text = concern.concern || concern.summary || concern.text;
    addStorylineTraceAliases(index, 'review_concern', [
      concern._writebackId,
      concern.concern_id,
      concern.concernId,
      concern.id
    ], text, concern._writebackId);
  }
  return index;
}

function resolveStorylineTraceRecord(ref = {}, index = {}) {
  const normalizedRef = normalizeStorylineTraceRef(ref);
  const bucket = index[normalizedRef.kind];
  if (!bucket) return null;
  if (normalizedRef.id && bucket.ids.has(normalizedRef.id)) return bucket.ids.get(normalizedRef.id);
  const textKey = normalizedRef.text ? normalizedRef.text.toLowerCase() : '';
  if (textKey && bucket.texts.has(textKey)) return bucket.texts.get(textKey);
  return null;
}

function validateArtifactForWriteback(artifact = {}, normalized = {}, options = {}) {
  const warnings = [];
  const allowWeakEvidence = Boolean(options.allowWeakEvidence || options.allow_weak_evidence);
  if (!normalized.claims.length) {
    warnings.push({ code: 'no_contribution_claims', message: 'No contribution claims are available for writeback.' });
  }
  const ungroundedClaims = normalized.claims.filter((claim) => !asArray(claim.source_span_ids || claim.sourceSpanIds).length);
  if (ungroundedClaims.length && !allowWeakEvidence) {
    warnings.push({
      code: 'ungrounded_claims_block_writeback',
      message: 'Contribution claims without source_span_ids block graph writeback by default.',
      claim_ids: ungroundedClaims.map((claim) => claim._writebackId)
    });
  }
  const availableSpanIds = new Set(normalized.sourceSpans.map((span) => span.id));
  const missingSourceSpanRefs = normalized.claims.flatMap((claim) => (
    asArray(claim.source_span_ids || claim.sourceSpanIds)
      .filter((spanId) => !availableSpanIds.has(spanId))
      .map((spanId) => ({
        claim_id: claim._writebackId,
        source_span_id: spanId
      }))
  ));
  if (missingSourceSpanRefs.length && !allowWeakEvidence) {
    warnings.push({
      code: 'missing_source_span_records_block_writeback',
      message: 'Claim source_span_ids must resolve to source span records before graph writeback.',
      missing_source_span_refs: missingSourceSpanRefs
    });
  }
  const futureLeakageCount = Number(normalized.noveltyCertificate.future_leakage_count ?? normalized.noveltyCertificate.futureLeakageCount ?? 0);
  const futureMustCites = normalized.mustCiteSet.filter((entry) => String(entry.temporal_status || entry.temporalStatus || '').toLowerCase() === 'future_leakage');
  if ((futureLeakageCount || futureMustCites.length) && !allowWeakEvidence) {
    warnings.push({
      code: 'future_leakage_blocks_writeback',
      message: 'Future-leakage citations block graph writeback by default.',
      future_leakage_count: futureLeakageCount || futureMustCites.length
    });
  }
  const sourceBacked = normalizeKey(artifact.evidence_status || artifact.evidenceStatus) === 'source_backed';
  const artifactEvidenceIds = collectArtifactEvidenceIds(artifact, normalized);
  const invalidMustCiteEntries = normalized.mustCiteSet
    .filter((entry) => !mustCiteCitationId(entry) || !mustCitePaperKey(entry))
    .map((entry) => ({
      citation_id: mustCiteCitationId(entry) || null,
      paper_key: mustCitePaperKey(entry) || null
    }));
  const ungroundedMustCiteEntries = sourceBacked
    ? normalized.mustCiteSet
      .filter((entry) => !hasMustCiteEvidenceRef(entry))
      .map((entry) => mustCiteCitationId(entry) || mustCitePaperKey(entry))
      .filter(Boolean)
    : [];
  const unresolvedMustCiteEvidenceRefs = sourceBacked
    ? normalized.mustCiteSet.flatMap((entry) => {
      const localIds = collectEmbeddedEvidenceIds(entry);
      return collectMustCiteEvidenceRefIds(entry)
        .filter((refId) => !artifactEvidenceIds.has(refId) && !localIds.has(refId))
        .map((refId) => ({
          citation_id: mustCiteCitationId(entry) || '',
          evidence_ref_id: refId
        }));
    })
    : [];
  const unlinkedMustCiteEntries = normalized.claims.length
    ? normalized.mustCiteSet
      .filter((entry) => !normalized.claims.some((claim) => claimMatchesMustCite(claim, entry)))
      .map((entry) => ({
        citation_id: mustCiteCitationId(entry) || null,
        paper_key: mustCitePaperKey(entry) || null
      }))
    : [];
  if (
    (
      invalidMustCiteEntries.length
      || ungroundedMustCiteEntries.length
      || unresolvedMustCiteEvidenceRefs.length
      || unlinkedMustCiteEntries.length
    ) && !allowWeakEvidence
  ) {
    warnings.push({
      code: 'incomplete_must_cite_set_block_writeback',
      message: 'Must-cite writeback requires identifiable entries, source-backed evidence refs, and claim-level citation obligation links.',
      invalid_entries: invalidMustCiteEntries,
      ungrounded_citation_ids: ungroundedMustCiteEntries,
      unresolved_evidence_refs: unresolvedMustCiteEvidenceRefs,
      unlinked_entries: unlinkedMustCiteEntries
    });
  }
  const noveltyCertificatePresent = Object.keys(normalized.noveltyCertificate).length > 0;
  if (normalized.claims.length && !noveltyCertificatePresent && !allowWeakEvidence) {
    warnings.push({
      code: 'missing_novelty_certificate_block_writeback',
      message: 'Contribution-claim writeback requires a novelty_certificate by default.'
    });
  }
  if (noveltyCertificatePresent && !allowWeakEvidence) {
    const invalidFields = invalidNoveltyCertificateFields(normalized.noveltyCertificate);
    const reasons = certificateReasons(normalized.noveltyCertificate);
    const missingReasonAxes = missingCertificateReasonAxes(normalized.noveltyCertificate);
    const temporalValidity = certificateScore(normalized.noveltyCertificate, 'temporal_validity', 'temporalValidity');
    if (invalidFields.length || !reasons.length || missingReasonAxes.length || !Number.isFinite(futureLeakageCount) || futureLeakageCount > 0 || !(temporalValidity > 0)) {
      warnings.push({
        code: 'incomplete_novelty_certificate_block_writeback',
        message: 'Novelty certificate writeback requires bounded scores, textual reasons for every score axis, and no future leakage.',
        invalid_fields: invalidFields,
        reason_count: reasons.length,
        missing_reason_axes: missingReasonAxes,
        future_leakage_count: Number.isFinite(futureLeakageCount) ? futureLeakageCount : null,
        temporal_validity: temporalValidity
      });
    }
  }
  const untraceableBeats = normalized.storyBeats.filter((beat) => {
    const supported = beat.supported !== false;
    return supported && !collectTraceRefs(beat).length;
  });
  const storylineTraceIndex = collectStorylineTraceIndex(artifact, normalized);
  const storylineTraceRefs = normalized.storyBeats.flatMap((beat) => collectTraceRefs(beat).map((ref) => ({
    beat_id: beat.beat_id || beat.beatId || beat._writebackId,
    trace_type: ref.kind,
    trace_id: ref.id,
    ref
  })));
  const unsupportedStorylineTraceRefs = storylineTraceRefs
    .filter((entry) => !STORYLINE_ALLOWED_TRACE_TYPES.has(entry.trace_type))
    .map(({ beat_id: beatId, trace_type: traceType, trace_id: traceId }) => ({
      beat_id: beatId,
      trace_type: traceType || 'unknown',
      trace_id: traceId || null
    }));
  const unresolvedStorylineTraceRefs = storylineTraceRefs
    .filter((entry) => STORYLINE_ALLOWED_TRACE_TYPES.has(entry.trace_type))
    .filter((entry) => !resolveStorylineTraceRecord(entry.ref, storylineTraceIndex))
    .map(({ beat_id: beatId, trace_type: traceType, trace_id: traceId }) => ({
      beat_id: beatId,
      trace_type: traceType,
      trace_id: traceId || null
    }));
  const storyBeatIds = new Set(normalized.storyBeats.flatMap((beat) => [
    beat._writebackId,
    beat.beat_id,
    beat.beatId,
    beat.id
  ].map((id) => compactText(id, 240)).filter(Boolean)));
  const invalidStorylineEdges = normalized.storyEdges.filter((edge) => {
    const source = compactText(edge.source_beat_id || edge.sourceBeatId || edge.source || edge.from, 240);
    const target = compactText(edge.target_beat_id || edge.targetBeatId || edge.target || edge.to, 240);
    return !storyBeatIds.has(source) || !storyBeatIds.has(target);
  });
  const declaredUnsupportedBeatIds = new Set(normalized.unsupportedStoryBeatIds);
  const undeclaredUnsupportedBeatIds = normalized.storyBeats
    .filter((beat) => beat.supported === false)
    .map((beat) => beat.beat_id || beat.beatId || beat._writebackId)
    .filter((beatId) => !declaredUnsupportedBeatIds.has(beatId));
  if (untraceableBeats.length && !allowWeakEvidence) {
    warnings.push({
      code: 'untraceable_story_beats_block_writeback',
      message: 'Supported storyline beats must trace to claim, challenge, takeaway, or review concern ids.',
      beat_ids: untraceableBeats.map((beat) => beat._writebackId)
    });
  }
  if (
    (
      unsupportedStorylineTraceRefs.length
      || unresolvedStorylineTraceRefs.length
      || invalidStorylineEdges.length
      || undeclaredUnsupportedBeatIds.length
    ) && !allowWeakEvidence
  ) {
    warnings.push({
      code: 'invalid_storyline_dag_block_writeback',
      message: 'Storyline DAG writeback requires resolvable trace refs, valid beat edges, and declared unsupported beats.',
      unsupported_trace_refs: unsupportedStorylineTraceRefs,
      unresolved_trace_refs: unresolvedStorylineTraceRefs,
      invalid_edge_count: invalidStorylineEdges.length,
      undeclared_unsupported_beat_ids: undeclaredUnsupportedBeatIds
    });
  }
  const claimRefs = claimReferenceMap(normalized.claims);
  const invalidFalsificationPlans = normalized.falsificationPlans
    .filter((plan) => (
      !planClaimRef(plan)
      || !compactText(plan.question, 1200)
      || !asArray(plan.required_evidence || plan.requiredEvidence).length
    ))
    .map((plan) => ({
      falsification_plan_id: planDisplayId(plan) || null,
      missing_claim_ref: !planClaimRef(plan),
      missing_question: !compactText(plan.question, 1200),
      missing_required_evidence: !asArray(plan.required_evidence || plan.requiredEvidence).length
    }));
  const unresolvedFalsificationClaimRefs = normalized.falsificationPlans
    .filter((plan) => planClaimRef(plan) && !claimRefs.has(planClaimRef(plan)))
    .map((plan) => ({
      falsification_plan_id: planDisplayId(plan) || null,
      claim_id: planClaimRef(plan)
    }));
  if ((invalidFalsificationPlans.length || unresolvedFalsificationClaimRefs.length) && !allowWeakEvidence) {
    warnings.push({
      code: 'incomplete_falsification_plans_block_writeback',
      message: 'Falsification plan writeback requires a question, required evidence, and a resolvable contribution claim reference.',
      invalid_plans: invalidFalsificationPlans,
      unresolved_claim_refs: unresolvedFalsificationClaimRefs
    });
  }
  if (normalized.claims.length && !normalized.reviewPacketPresent && !allowWeakEvidence) {
    warnings.push({
      code: 'missing_review_packet_block_writeback',
      message: 'Contribution-claim writeback requires a structured review_packet by default.'
    });
  }
  if (normalized.reviewPacketPresent && !allowWeakEvidence) {
    const reviewerRoles = new Set(normalized.reviewers.map((reviewer) => reviewer._role).filter(Boolean));
    const missingRoles = [...REQUIRED_REVIEW_ROLES].filter((role) => !reviewerRoles.has(role));
    const metaReview = normalized.metaReview;
    const missingMetaReview = !metaReview || !(metaReview.recommendation || metaReview.decision);
    const concernRefIds = new Set(normalized.reviewConcerns.flatMap((concern) => [
      concern._writebackId,
      reviewConcernId(concern)
    ].map((ref) => compactText(ref, 240)).filter(Boolean)));
    const claimRefIds = new Set(normalized.claims.flatMap(claimReferenceIds));
    const invalidConcerns = normalized.reviewConcerns.filter((concern) => (
      !reviewConcernId(concern)
      || !normalizeReviewerRole(concern.reviewer_role || concern.reviewerRole)
      || !compactText(concern.severity)
      || !compactText(concern.concern || concern.summary || concern.text)
      || typeof concern.addressed !== 'boolean'
    ));
    const invalidConcernReviewerRoles = normalized.reviewConcerns
      .map((concern) => ({
        concern_id: reviewConcernDisplayId(concern),
        reviewer_role: normalizeReviewerRole(concern.reviewer_role || concern.reviewerRole)
      }))
      .filter((entry) => entry.reviewer_role && !reviewerRoles.has(entry.reviewer_role));
    const unresolvedReviewerConcernRefs = normalized.reviewers.flatMap((reviewer) => reviewConcernRefs(reviewer)
      .filter((concernId) => !concernRefIds.has(concernId))
      .map((concernId) => ({
        reviewer_id: reviewer.reviewer_id || reviewer.reviewerId || reviewer._writebackId,
        concern_id: concernId
      })));
    const unresolvedAffectedClaimRefs = normalized.reviewConcerns.flatMap((concern) => affectedClaimRefs(concern)
      .filter((claimId) => !claimRefIds.has(claimId))
      .map((claimId) => ({
        concern_id: reviewConcernDisplayId(concern),
        claim_id: claimId
      })));
    const invalidMetaReviewMajorConcernIds = normalized.reviewConcerns
      .filter((concern) => normalizeKey(concern.severity) === 'major' && concern.addressed === false)
      .filter(() => !metaReviewBlocksMajorConcerns(metaReview || {}))
      .map(reviewConcernDisplayId)
      .filter(Boolean);
    if (
      missingRoles.length
      || missingMetaReview
      || invalidConcerns.length
      || invalidConcernReviewerRoles.length
      || unresolvedReviewerConcernRefs.length
      || unresolvedAffectedClaimRefs.length
      || invalidMetaReviewMajorConcernIds.length
    ) {
      warnings.push({
        code: 'incomplete_review_packet_block_writeback',
        message: 'Review packet writeback requires a complete reviewer panel, resolvable concern refs, resolvable affected claims, and blocking meta-review decisions for unresolved major concerns.',
        missing_reviewer_roles: missingRoles,
        missing_meta_review: missingMetaReview,
        invalid_concern_count: invalidConcerns.length,
        invalid_concern_reviewer_roles: invalidConcernReviewerRoles,
        unresolved_reviewer_concern_refs: unresolvedReviewerConcernRefs,
        unresolved_affected_claim_refs: unresolvedAffectedClaimRefs,
        invalid_meta_review_major_concern_ids: invalidMetaReviewMajorConcernIds
      });
    }
  }

  const blocking = warnings.some((warning) => warning.code.endsWith('_block_writeback') || warning.code === 'no_contribution_claims');
  return {
    canWrite: !blocking,
    warnings
  };
}

function normalizeArtifacts(artifact = {}) {
  const claims = asArray(artifact.contribution_claims || artifact.contributionClaims).map((claim, index) => ({
    ...asObject(claim),
    _writebackId: claimIdFor(claim, index)
  }));
  const reviewPacket = asObject(artifact.review_packet || artifact.reviewPacket);
  const reviewers = asArray(reviewPacket.reviewers || reviewPacket.reviewer_panel || reviewPacket.reviewerPanel).map((reviewer, index) => {
    const object = asObject(reviewer);
    const role = normalizeReviewerRole(object.role || object.reviewer_role || object.reviewerRole);
    return {
      ...object,
      _role: role,
      _writebackId: stableNodeId('review-aspect', object.reviewer_id || object.reviewerId || role, `reviewer-${index}`)
    };
  });
  const rawMetaReview = asObject(reviewPacket.meta_review || reviewPacket.metaReview);
  const storylineDag = asObject(artifact.storyline_dag || artifact.storylineDag);
  return {
    claims,
    mustCiteSet: asArray(artifact.must_cite_set || artifact.mustCiteSet),
    noveltyCertificate: asObject(artifact.novelty_certificate || artifact.noveltyCertificate),
    reviewPacketPresent: Object.keys(reviewPacket).length > 0,
    reviewers,
    metaReview: Object.keys(rawMetaReview).length
      ? {
          ...rawMetaReview,
          _writebackId: stableNodeId('review-aspect', 'meta-review', rawMetaReview.recommendation || rawMetaReview.decision || rawMetaReview.summary)
        }
      : null,
    reviewConcerns: asArray(reviewPacket.major_concerns || reviewPacket.majorConcerns).map((concern, index) => ({
      ...asObject(concern),
      _writebackId: stableNodeId('concern', concern.concern_id || concern.concernId || concern.id, concern.concern || `concern-${index}`)
    })),
    storyBeats: asArray(storylineDag.beats).map((beat, index) => ({
      ...asObject(beat),
      _writebackId: stableNodeId('beat', beat.beat_id || beat.beatId || beat.id, beat.text || `beat-${index}`)
    })),
    unsupportedStoryBeatIds: asArray(storylineDag.unsupported_beats || storylineDag.unsupportedBeats)
      .map((beatId) => compactText(beatId, 240))
      .filter(Boolean),
    storyEdges: asArray(storylineDag.edges),
    falsificationPlans: [
      ...asArray(artifact.counterfactuals),
      ...asArray(artifact.falsification_plans || artifact.falsificationPlans)
    ].map((plan, index) => ({
      ...asObject(plan),
      _writebackId: stableNodeId('falsification', plan.falsification_plan_id || plan.falsificationPlanId || plan.id, plan.question || `falsification-${index}`)
    })),
    sourceSpans: collectSourceSpans(artifact)
  };
}

function buildArtifactNodes(artifact = {}, options = {}) {
  const artifactId = stableNodeId(
    'artifact',
    artifact.run_id || artifact.runId,
    artifact.trace_id || artifact.traceId,
    artifact.innovation_contract_version || artifact.contractVersion || artifact.packet_version,
    artifact.research_problem || artifact.problem || options.name || 'innovation-artifact'
  );
  const provenanceId = stableNodeId('provenance', artifactId, artifact.generated_at || artifact.generatedAt || new Date(0).toISOString());
  return {
    artifactId,
    provenanceId,
    nodes: [
      nodeOperation(artifactId, NODE_TYPES.VERSIONED_ARTIFACT, 'Idea-Catalyst innovation artifact', {
        contractVersion: artifact.innovation_contract_version || artifact.contractVersion || artifact.packet_version || null,
        packetVersion: artifact.packet_version || artifact.packetVersion || null,
        runId: artifact.run_id || artifact.runId || null,
        traceId: artifact.trace_id || artifact.traceId || null,
        researchProblem: artifact.research_problem || artifact.problem || null,
        targetDomain: artifact.target_domain || artifact.targetDomain || null,
        writebackPolicy: 'dry_run_first'
      }),
      nodeOperation(provenanceId, NODE_TYPES.PROVENANCE_RECORD, 'Innovation writeback provenance', {
        source: 'idea-catalyst-v2-artifacts',
        generatedAt: artifact.generated_at || artifact.generatedAt || null,
        actor: options.actor || 'agent',
        dryRun: true
      })
    ],
    edges: [
      edgeOperation(artifactId, provenanceId, EDGE_TYPES.DERIVED_FROM_VERSION, {
        relationSource: 'innovation-writeback-dry-run'
      })
    ]
  };
}

function buildClaimOperations(normalized, artifactId, provenanceId) {
  const spanById = new Map(normalized.sourceSpans.map((span) => [span.id, span]));
  const operations = [];
  for (const claim of normalized.claims) {
    operations.push(nodeOperation(claim._writebackId, NODE_TYPES.CONTRIBUTION_CLAIM, claim.claim_text || claim.claimText || claim._writebackId, {
      claimId: claim.claim_id || claim.claimId || claim._writebackId,
      fragmentId: claim.fragment_id || claim.fragmentId || null,
      claimType: claim.claim_type || claim.claimType || 'contribution',
      sourceDomain: claim.source_domain || claim.sourceDomain || null,
      targetChallengeId: claim.target_challenge_id || claim.targetChallengeId || null,
      sourceSpanIds: asArray(claim.source_span_ids || claim.sourceSpanIds),
      citationContextIds: asArray(claim.citation_context_ids || claim.citationContextIds),
      supportingPaperKeys: asArray(claim.supporting_paper_keys || claim.supportingPaperKeys),
      evidenceTier: claim.evidence_tier || claim.evidenceTier || null,
      confidence: claim.confidence ?? null,
      writebackPolicy: claim.writeback_policy || claim.writebackPolicy || 'dry_run_first'
    }));
    operations.push(edgeOperation(claim._writebackId, artifactId, EDGE_TYPES.DERIVED_FROM_VERSION, { role: 'artifact_source' }));
    operations.push(edgeOperation(claim._writebackId, provenanceId, EDGE_TYPES.VALID_DURING, { role: 'writeback_provenance' }));

    for (const spanId of asArray(claim.source_span_ids || claim.sourceSpanIds)) {
      const span = spanById.get(spanId);
      const evidenceId = span?.id || stableNodeId('span', spanId);
      operations.push(nodeOperation(evidenceId, NODE_TYPES.EVIDENCE_SNIPPET, span?.text || spanId, {
        sourceSpanId: spanId,
        paperKey: span?.paper_key || null,
        paperTitle: span?.paper_title || null,
        sourceDomain: span?.source_domain || span?.sourceDomain || null,
        section: span?.section || span?.sectionHeading || null,
        licenseScope: span?.license_scope || null,
        evidenceHash: span?.evidence_hash || null,
        sourceAnchor: span?.source_anchor || null,
        text: span?.text || ''
      }));
      operations.push(edgeOperation(claim._writebackId, evidenceId, EDGE_TYPES.SUPPORTED_BY, { role: 'source_span' }));
      operations.push(edgeOperation(evidenceId, claim._writebackId, EDGE_TYPES.SUPPORTS_CLAIM, { role: 'source_span' }));
    }

    for (const contextId of asArray(claim.citation_context_ids || claim.citationContextIds)) {
      const id = stableNodeId('citation-context', contextId);
      operations.push(nodeOperation(id, NODE_TYPES.CITATION_CONTEXT, contextId, {
        citationContextId: contextId,
        placeholder: true,
        source: 'idea-catalyst-claim-link'
      }));
      operations.push(edgeOperation(claim._writebackId, id, EDGE_TYPES.SUPPORTED_BY, { role: 'citation_context' }));
      operations.push(edgeOperation(id, claim._writebackId, EDGE_TYPES.SUPPORTS_CLAIM, { role: 'citation_context' }));
    }
  }
  return operations;
}

function claimMatchesMustCite(claim = {}, entry = {}) {
  const claimKeys = new Set(asArray(claim.supporting_paper_keys || claim.supportingPaperKeys).map((value) => compactText(value).toLowerCase()).filter(Boolean));
  const entryKeys = [
    entry.paper_key,
    entry.paperKey,
    entry.paper_id,
    entry.paperId,
    entry.title
  ].map((value) => compactText(value).toLowerCase()).filter(Boolean);
  if (entryKeys.some((key) => claimKeys.has(key))) return true;
  const claimSpans = new Set(asArray(claim.source_span_ids || claim.sourceSpanIds));
  if (collectMustCiteEvidenceRefIds(entry).some((spanId) => claimSpans.has(spanId))) return true;
  const claimCitationContexts = new Set(asArray(claim.citation_context_ids || claim.citationContextIds));
  return collectMustCiteEvidenceRefIds(entry).some((contextId) => claimCitationContexts.has(contextId));
}

function buildMustCiteOperations(normalized, warnings) {
  const operations = [];
  for (const entry of normalized.mustCiteSet) {
    const paperId = paperIdFor(entry);
    operations.push(nodeOperation(paperId, NODE_TYPES.PAPER, entry.title || entry.paper_title || entry.paperKey || entry.paper_key || paperId, {
      paperKey: entry.paper_key || entry.paperKey || null,
      citationId: entry.citation_id || entry.citationId || null,
      obligationType: entry.obligation_type || entry.obligationType || null,
      coverageStatus: entry.coverage_status || entry.coverageStatus || null,
      temporalStatus: entry.temporal_status || entry.temporalStatus || null,
      reason: entry.reason || null,
      placeholder: true,
      source: 'must_cite_set'
    }));
    const matchedClaims = normalized.claims.filter((claim) => claimMatchesMustCite(claim, entry));
    if (!matchedClaims.length) {
      warnings.push({
        code: 'unlinked_must_cite_entry',
        message: 'Must-cite entry had no exact claim span or supporting-paper match.',
        citation_id: entry.citation_id || entry.citationId || null,
        paper_id: paperId
      });
    }
    for (const claim of matchedClaims) {
      operations.push(edgeOperation(claim._writebackId, paperId, mustCiteEdgeType(entry), {
        citationId: entry.citation_id || entry.citationId || null,
        obligationType: entry.obligation_type || entry.obligationType || null,
        coverageStatus: entry.coverage_status || entry.coverageStatus || null,
        role: 'must_cite'
      }));
    }
  }
  return operations;
}

function buildNoveltyCertificateOperations(normalized, artifactId, provenanceId) {
  if (!Object.keys(normalized.noveltyCertificate).length) return [];
  const certificate = normalized.noveltyCertificate;
  const nodeId = stableNodeId(
    'novelty',
    certificate.certificate_id || certificate.certificateId || certificate.id,
    artifactId,
    certificate.certificate_version || certificate.certificateVersion || 'novelty-certificate'
  );
  const reasons = certificateReasons(certificate);
  const axisReasons = certificateAxisReasons(certificate);
  const reasonAxes = coveredCertificateReasonAxes(certificate);
  return [
    nodeOperation(nodeId, NODE_TYPES.NOVELTY_CLAIM, 'Novelty certificate', {
      certificateId: certificate.certificate_id || certificate.certificateId || nodeId,
      certificateVersion: certificate.certificate_version || certificate.certificateVersion || null,
      novelty: certificateScore(certificate, 'novelty', 'novelty'),
      significance: certificateScore(certificate, 'significance', 'significance'),
      feasibility: certificateScore(certificate, 'feasibility', 'feasibility'),
      grounding: certificateScore(certificate, 'grounding', 'grounding'),
      mustCiteCompleteness: certificateScore(certificate, 'must_cite_completeness', 'mustCiteCompleteness'),
      temporalValidity: certificateScore(certificate, 'temporal_validity', 'temporalValidity'),
      claimCount: Number(certificate.claim_count ?? certificate.claimCount ?? normalized.claims.length),
      unsupportedClaimCount: Number(certificate.unsupported_claim_count ?? certificate.unsupportedClaimCount ?? 0),
      mustCiteCount: Number(certificate.must_cite_count ?? certificate.mustCiteCount ?? normalized.mustCiteSet.length),
      futureLeakageCount: Number(certificate.future_leakage_count ?? certificate.futureLeakageCount ?? 0),
      reasons,
      reasonCount: reasons.length,
      reasonAxes,
      axisReasons,
      timeCutoff: certificate.time_cutoff || certificate.timeCutoff || null,
      modelAssistedMode: certificate.model_assisted?.mode || certificate.modelAssisted?.mode || null,
      writebackPolicy: 'dry_run_first'
    }),
    edgeOperation(nodeId, artifactId, EDGE_TYPES.DERIVED_FROM_VERSION, { role: 'novelty_certificate' }),
    edgeOperation(nodeId, provenanceId, EDGE_TYPES.VALID_DURING, { role: 'writeback_provenance' })
  ];
}

function buildReviewOperations(normalized, warnings) {
  const operations = [];
  const claimIds = new Set(normalized.claims.map((claim) => claim._writebackId));
  const concernById = new Map(normalized.reviewConcerns.flatMap((concern) => [
    [concern._writebackId, concern],
    [concern.concern_id || concern.concernId, concern]
  ].filter(([key]) => key)));
  for (const reviewer of normalized.reviewers) {
    operations.push(nodeOperation(reviewer._writebackId, NODE_TYPES.REVIEW_ASPECT, `${reviewer._role || 'reviewer'} reviewer`, {
      reviewAspectType: 'reviewer',
      reviewerId: reviewer.reviewer_id || reviewer.reviewerId || reviewer._writebackId,
      reviewerRole: reviewer._role || null,
      score: reviewer.score ?? null,
      summary: reviewer.summary || null,
      concernIds: asArray(reviewer.concerns || reviewer.major_concerns || reviewer.majorConcerns)
    }));
    for (const concernId of asArray(reviewer.concerns || reviewer.major_concerns || reviewer.majorConcerns)) {
      const concern = concernById.get(concernId);
      if (!concern) {
        warnings.push({ code: 'unknown_reviewer_concern_ref', reviewer_id: reviewer._writebackId, concern_id: concernId });
        continue;
      }
      for (const claimId of asArray(concern.affected_claim_ids || concern.affectedClaimIds)) {
        const resolvedClaimId = claimIdFor({ claim_id: claimId });
        if (!claimIds.has(resolvedClaimId)) continue;
        operations.push(edgeOperation(reviewer._writebackId, resolvedClaimId, EDGE_TYPES.RAISES_CONCERN, {
          concernId: concern.concern_id || concern.concernId || concern._writebackId,
          reviewerRole: reviewer._role || null,
          severity: concern.severity || null
        }));
      }
    }
  }
  if (normalized.metaReview) {
    operations.push(nodeOperation(normalized.metaReview._writebackId, NODE_TYPES.REVIEW_ASPECT, 'Meta-review', {
      reviewAspectType: 'meta_review',
      recommendation: normalized.metaReview.recommendation || null,
      decision: normalized.metaReview.decision || null,
      majorConcernCount: normalized.metaReview.major_concern_count ?? normalized.metaReview.majorConcernCount ?? null,
      summary: normalized.metaReview.summary || null
    }));
  }
  for (const concern of normalized.reviewConcerns) {
    operations.push(nodeOperation(concern._writebackId, NODE_TYPES.REVIEW_CONCERN, concern.concern || concern._writebackId, {
      concernId: concern.concern_id || concern.concernId || concern._writebackId,
      reviewerRole: concern.reviewer_role || concern.reviewerRole || null,
      severity: concern.severity || null,
      evidenceGap: concern.evidence_gap || concern.evidenceGap || null,
      addressed: concern.addressed ?? null
    }));
    for (const claimId of asArray(concern.affected_claim_ids || concern.affectedClaimIds)) {
      const resolvedClaimId = claimIdFor({ claim_id: claimId });
      if (!claimIds.has(resolvedClaimId)) {
        warnings.push({ code: 'unknown_review_claim_ref', concern_id: concern._writebackId, claim_id: claimId });
        continue;
      }
      operations.push(edgeOperation(concern._writebackId, resolvedClaimId, EDGE_TYPES.RAISES_CONCERN, {
        severity: concern.severity || null,
        evidenceGap: concern.evidence_gap || concern.evidenceGap || null
      }));
    }
  }
  return operations;
}

function traceNode(ref = {}, nodeId = '') {
  const kind = compactText(ref.kind).toLowerCase();
  const id = compactText(ref.id, 240);
  if (!id) return null;
  if (kind === 'challenge') return nodeOperation(nodeId || stableNodeId('challenge', id), NODE_TYPES.CHALLENGE, ref.text || id, { traceKind: kind, traceId: id, source: ref.source || null });
  if (kind === 'takeaway') return nodeOperation(nodeId || stableNodeId('takeaway', id), NODE_TYPES.TAKEAWAY, ref.text || id, { traceKind: kind, traceId: id, source: ref.source || null });
  return null;
}

function resolveTraceSourceId(ref = {}, indexes = {}) {
  const record = resolveStorylineTraceRecord(ref, indexes);
  return record?.nodeId || '';
}

function buildStorylineOperations(artifact, normalized, warnings) {
  const operations = [];
  const beatIds = new Map(normalized.storyBeats.flatMap((beat) => [
    [beat._writebackId, beat._writebackId],
    [beat.beat_id || beat.beatId, beat._writebackId],
    [beat.id, beat._writebackId]
  ].filter(([key]) => key)));
  const indexes = collectStorylineTraceIndex(artifact, normalized);

  for (const beat of normalized.storyBeats) {
    operations.push(nodeOperation(beat._writebackId, NODE_TYPES.STORY_BEAT, beat.text || beat.beat_type || beat.beatType || beat._writebackId, {
      beatId: beat.beat_id || beat.beatId || beat._writebackId,
      beatType: beat.beat_type || beat.beatType || null,
      supported: beat.supported ?? null,
      sourceSpanIds: asArray(beat.source_span_ids || beat.sourceSpanIds)
    }));
    for (const ref of collectTraceRefs(beat)) {
      const sourceId = resolveTraceSourceId(ref, indexes);
      if (!sourceId) {
        warnings.push({
          code: 'unknown_storyline_trace_ref',
          beat_id: beat.beat_id || beat.beatId || beat._writebackId,
          trace_type: ref.kind,
          trace_id: ref.id
        });
        continue;
      }
      const placeholder = traceNode(ref, sourceId);
      if (placeholder) operations.push(placeholder);
      operations.push(edgeOperation(sourceId, beat._writebackId, EDGE_TYPES.FORMS_BEAT, {
        traceKind: ref.kind,
        traceId: ref.id
      }));
    }
  }

  for (const edge of normalized.storyEdges) {
    const source = beatIds.get(edge.source_beat_id || edge.sourceBeatId || edge.source || edge.from);
    const target = beatIds.get(edge.target_beat_id || edge.targetBeatId || edge.target || edge.to);
    if (!source || !target) {
      warnings.push({ code: 'unknown_storyline_edge_ref', edge });
      continue;
    }
    operations.push(edgeOperation(source, target, EDGE_TYPES.PRECEDES_BEAT, {
      relation: edge.relation || 'precedes'
    }));
  }
  return operations;
}

function buildFalsificationOperations(normalized, warnings) {
  const operations = [];
  const claimRefs = claimReferenceMap(normalized.claims);
  for (const plan of normalized.falsificationPlans) {
    operations.push(nodeOperation(plan._writebackId, NODE_TYPES.FALSIFICATION_PLAN, plan.question || plan._writebackId, {
      falsificationPlanId: plan.falsification_plan_id || plan.falsificationPlanId || plan._writebackId,
      requiredEvidence: asArray(plan.required_evidence || plan.requiredEvidence),
      status: plan.status || 'planned'
    }));
    const claimId = planClaimRef(plan);
    if (!claimId) continue;
    const resolvedClaimId = claimRefs.get(claimId);
    if (!resolvedClaimId) {
      warnings.push({ code: 'unknown_falsification_claim_ref', falsification_plan_id: planDisplayId(plan) || plan._writebackId, claim_id: claimId });
      continue;
    }
    operations.push(edgeOperation(resolvedClaimId, plan._writebackId, EDGE_TYPES.HAS_FALSIFICATION_PLAN, {
      status: plan.status || 'planned'
    }));
  }
  return operations;
}

export function buildInnovationArtifactGraphMutations(input = {}, options = {}) {
  const artifact = unwrapInnovationArtifact(input);
  const normalized = normalizeArtifacts(artifact);
  const validation = validateArtifactForWriteback(artifact, normalized, options);
  const warnings = [...validation.warnings];
  const artifactEnvelope = buildArtifactNodes(artifact, options);

  if (!validation.canWrite) {
    return {
      contractVersion: INNOVATION_WRITEBACK_CONTRACT_VERSION,
      dryRun: true,
      writebackStatus: 'blocked',
      reason: 'artifact_failed_writeback_gate',
      operations: [],
      nodes: [],
      relationships: [],
      provenance: {
        artifactId: artifactEnvelope.artifactId,
        provenanceId: artifactEnvelope.provenanceId,
        policy: 'dry_run_first'
      },
      warnings,
      diagnostics: {
        claimCount: normalized.claims.length,
        mustCiteCount: normalized.mustCiteSet.length,
        reviewConcernCount: normalized.reviewConcerns.length,
        storyBeatCount: normalized.storyBeats.length,
        falsificationPlanCount: normalized.falsificationPlans.length,
        operationCount: 0
      }
    };
  }

  const claimOperations = buildClaimOperations(normalized, artifactEnvelope.artifactId, artifactEnvelope.provenanceId);
  const mustCiteOperations = buildMustCiteOperations(normalized, warnings);
  const noveltyCertificateOperations = buildNoveltyCertificateOperations(normalized, artifactEnvelope.artifactId, artifactEnvelope.provenanceId);
  const reviewOperations = buildReviewOperations(normalized, warnings);
  const storylineOperations = buildStorylineOperations(artifact, normalized, warnings);
  const falsificationOperations = buildFalsificationOperations(normalized, warnings);

  const operations = dedupeOperations([
    ...artifactEnvelope.nodes,
    ...claimOperations.filter((operation) => operation.action === 'create_node'),
    ...mustCiteOperations.filter((operation) => operation.action === 'create_node'),
    ...noveltyCertificateOperations.filter((operation) => operation.action === 'create_node'),
    ...reviewOperations.filter((operation) => operation.action === 'create_node'),
    ...storylineOperations.filter((operation) => operation.action === 'create_node'),
    ...falsificationOperations.filter((operation) => operation.action === 'create_node'),
    ...artifactEnvelope.edges,
    ...claimOperations.filter((operation) => operation.action !== 'create_node'),
    ...mustCiteOperations.filter((operation) => operation.action !== 'create_node'),
    ...noveltyCertificateOperations.filter((operation) => operation.action !== 'create_node'),
    ...reviewOperations.filter((operation) => operation.action !== 'create_node'),
    ...storylineOperations.filter((operation) => operation.action !== 'create_node'),
    ...falsificationOperations.filter((operation) => operation.action !== 'create_node')
  ]);
  const nodes = operations.filter((operation) => operation.action === 'create_node');
  const relationships = operations.filter((operation) => operation.action === 'create_edge');

  return {
    contractVersion: INNOVATION_WRITEBACK_CONTRACT_VERSION,
    dryRun: true,
    writebackStatus: 'ready',
    operations,
    nodes,
    relationships,
    provenance: {
      artifactId: artifactEnvelope.artifactId,
      provenanceId: artifactEnvelope.provenanceId,
      policy: 'dry_run_first'
    },
    warnings,
    diagnostics: {
      claimCount: normalized.claims.length,
      mustCiteCount: normalized.mustCiteSet.length,
      reviewConcernCount: normalized.reviewConcerns.length,
      storyBeatCount: normalized.storyBeats.length,
      falsificationPlanCount: normalized.falsificationPlans.length,
      nodeOperationCount: nodes.length,
      relationshipOperationCount: relationships.length,
      operationCount: operations.length
    }
  };
}

export async function readInnovationArtifactGraphMutations(inputPath, options = {}) {
  const raw = await readText(inputPath);
  return buildInnovationArtifactGraphMutations(JSON.parse(raw), options);
}

export async function writeInnovationArtifactGraphMutations(outputPath, inputPath, options = {}) {
  const payload = await readInnovationArtifactGraphMutations(inputPath, options);
  await writeJson(outputPath, payload);
  return payload;
}
