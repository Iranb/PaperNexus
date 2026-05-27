import { stableHash, unique } from '../../lib/utils.js';

export const IDEA_CATALYST_REPLAY_ADAPTER_VERSION = 'idea-catalyst-replay-adapter-v1';

export const SUPPORTED_REPLAY_ADAPTER_FORMATS = [
  'custom',
  'masterset',
  'novbench',
  'rinobench',
  'axiomatic_novelty',
  'claim-bench',
  'claimcheck',
  'openreview',
  'peerread',
  'moprd',
  're2'
];

const FORMAT_ALIASES = new Map([
  ['master_set', 'masterset'],
  ['must_cite', 'masterset'],
  ['mustcite', 'masterset'],
  ['nov_bench', 'novbench'],
  ['rino_bench', 'rinobench'],
  ['axiomatic', 'axiomatic_novelty'],
  ['axiomatic_novelty_benchmark', 'axiomatic_novelty'],
  ['claimbench', 'claim-bench'],
  ['claim_bench', 'claim-bench'],
  ['claim_check', 'claimcheck'],
  ['open_review', 'openreview'],
  ['peer_read', 'peerread'],
  ['re_2', 're2'],
  ['re²', 're2']
]);

const NOVELTY_FIELDS = [
  ['novelty', ['novelty', 'novelty_score', 'noveltyScore', 'originality']],
  ['significance', ['significance', 'impact', 'importance', 'usefulness', 'relevance']],
  ['feasibility', ['feasibility', 'correctness', 'validity', 'soundness']],
  ['grounding', ['grounding', 'evidence', 'support', 'coverage', 'claim_grounding']],
  ['must_cite_completeness', ['must_cite_completeness', 'mustCiteCompleteness', 'citation_coverage', 'must_cite_recall']],
  ['temporal_validity', ['temporal_validity', 'temporalValidity', 'time_validity']]
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatKey(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9²]+/g, '_').replace(/^_+|_+$/g, '');
}

function firstDefined(...values) {
  return values.find((value) => {
    if (value === undefined || value === null) return false;
    return !(typeof value === 'string' && !value.trim());
  });
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1 && numeric <= 5) return Number((numeric / 5).toFixed(6));
  if (numeric > 5 && numeric <= 100) return Number((numeric / 100).toFixed(6));
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(6));
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

export function normalizeReplayAdapterFormat(value = 'custom') {
  const key = formatKey(value || 'custom');
  const normalized = FORMAT_ALIASES.get(key) || key.replace(/_/g, '-');
  if (SUPPORTED_REPLAY_ADAPTER_FORMATS.includes(normalized)) return normalized;
  if (normalized === 'axiomatic-novelty') return 'axiomatic_novelty';
  return 'custom';
}

function normalizePacketMap(packetMap = {}) {
  if (Array.isArray(packetMap)) {
    return Object.fromEntries(packetMap
      .map((entry, index) => {
        const raw = asObject(entry);
        const id = compactText(raw.id || raw.case_id || raw.caseId || raw.query_id || raw.submission_id || `packet:${index + 1}`);
        const packet = firstObject(raw.packet, raw.candidate, raw.baseline, raw);
        return id && isNonEmptyObject(packet) ? [id, packet] : null;
      })
      .filter(Boolean));
  }
  return asObject(packetMap);
}

function caseLookupKeys(rawCase = {}, index = 0) {
  return unique([
    rawCase.id,
    rawCase.case_id,
    rawCase.caseId,
    rawCase.query_id,
    rawCase.queryId,
    rawCase.topic_id,
    rawCase.topicId,
    rawCase.submission_id,
    rawCase.submissionId,
    rawCase.paper_id,
    rawCase.paperId,
    rawCase.title,
    rawCase.paper_title,
    rawCase.paperTitle,
    `case:${index + 1}`
  ].map(compactText).filter(Boolean));
}

function lookupPacket(rawCase = {}, index = 0, packetMap = {}, fallbackPacket = {}) {
  const normalizedMap = normalizePacketMap(packetMap);
  for (const key of caseLookupKeys(rawCase, index)) {
    const packet = firstObject(normalizedMap[key]?.packet, normalizedMap[key]?.candidate, normalizedMap[key]?.baseline, normalizedMap[key]);
    if (isNonEmptyObject(packet)) return packet;
  }
  return isNonEmptyObject(fallbackPacket) ? fallbackPacket : {};
}

function normalizePaperRecord(value = {}, fallbackId = '') {
  if (typeof value === 'string') {
    const title = compactText(value);
    return title ? { id: fallbackId || title, title } : null;
  }
  const raw = asObject(value);
  const title = compactText(raw.title || raw.paperTitle || raw.paper_title || raw.name || raw.display_name);
  const id = compactText(raw.id || raw.paper_id || raw.paperId || raw.paper_key || raw.paperKey || raw.openalex || raw.doi || fallbackId || title);
  if (!id && !title) return null;
  return {
    id: id || title,
    paper_key: compactText(raw.paper_key || raw.paperKey || raw.key || id),
    title,
    doi: compactText(raw.doi || raw.DOI),
    arxivId: compactText(raw.arxivId || raw.arxiv_id || raw.arxiv),
    openalex: compactText(raw.openalex || raw.openalex_id || raw.openAlexId),
    s2: compactText(raw.s2 || raw.s2_id || raw.semantic_scholar_id || raw.paperId),
    year: firstDefined(raw.year, raw.publication_year, raw.publicationYear),
    identifiers: asObject(raw.identifiers || raw.ids)
  };
}

function normalizePaperList(...values) {
  return firstArray(...values)
    .map((entry, index) => normalizePaperRecord(entry, `paper:${index + 1}`))
    .filter(Boolean);
}

function normalizeClaimRecord(value = {}, fallbackId = '') {
  const raw = typeof value === 'string' ? { claim_text: value } : asObject(value);
  const text = compactText(raw.claim_text || raw.claimText || raw.text || raw.statement || raw.claim || raw.title);
  const id = compactText(raw.claim_id || raw.claimId || raw.id || fallbackId || (text ? `claim:${stableHash(text, 12)}` : ''));
  if (!id && !text) return null;
  const sourceSpans = [
    ...asArray(raw.source_span_ids || raw.sourceSpanIds || raw.source_spans || raw.sourceSpans),
    ...asArray(raw.evidence_spans || raw.evidenceSpans).map((entry, index) => (
      typeof entry === 'string' ? entry : (entry?.span_id || entry?.id || `evidence:${index + 1}`)
    ))
  ].map(compactText).filter(Boolean);
  return {
    claim_id: id,
    claim_text: text || id,
    label: compactText(raw.label || raw.verdict || raw.expectedLabel || raw.expected_label),
    supported: raw.supported ?? raw.is_supported ?? raw.source_backed ?? raw.sourceBacked,
    source_span_ids: unique(sourceSpans)
  };
}

function collectClaims(rawCase = {}, existingGold = {}) {
  const directClaims = firstArray(
    existingGold.claims,
    existingGold.contribution_claims,
    existingGold.contributionClaims,
    rawCase.claims,
    rawCase.claim_labels,
    rawCase.claimLabels,
    rawCase.contribution_claims,
    rawCase.contributionClaims
  );
  if (directClaims.length) {
    return directClaims.map((claim, index) => normalizeClaimRecord(claim, `claim:${index + 1}`)).filter(Boolean);
  }
  const singleClaim = firstDefined(rawCase.claim, rawCase.claim_text, rawCase.claimText, rawCase.statement, rawCase.text);
  const normalized = singleClaim ? normalizeClaimRecord(rawCase, 'claim:1') : null;
  return normalized ? [normalized] : [];
}

function getNestedScore(source = {}, aliases = []) {
  for (const alias of aliases) {
    const value = source[alias];
    const normalized = normalizeScore(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function normalizeNoveltyCertificate(rawCase = {}, existingGold = {}) {
  const nested = firstObject(
    existingGold.novelty_certificate,
    existingGold.noveltyCertificate,
    existingGold.novelty,
    rawCase.novelty_certificate,
    rawCase.noveltyCertificate,
    rawCase.novelty,
    rawCase.scores,
    rawCase.review_scores,
    rawCase.reviewScores,
    rawCase.labels?.novelty
  );
  const source = {
    ...nested,
    novelty_score: firstDefined(nested.novelty_score, rawCase.novelty_score, rawCase.noveltyScore),
    originality: firstDefined(nested.originality, rawCase.originality),
    relevance: firstDefined(nested.relevance, rawCase.relevance),
    correctness: firstDefined(nested.correctness, rawCase.correctness),
    coverage: firstDefined(nested.coverage, rawCase.coverage)
  };
  const certificate = {};
  for (const [field, aliases] of NOVELTY_FIELDS) {
    const score = getNestedScore(source, aliases);
    if (score !== null) certificate[field] = score;
  }
  const futureLeakageCount = Number(firstDefined(
    source.future_leakage_count,
    source.futureLeakageCount,
    rawCase.future_leakage_count,
    rawCase.futureLeakageCount
  ));
  if (Number.isFinite(futureLeakageCount)) {
    certificate.future_leakage_count = Math.max(0, Math.floor(futureLeakageCount));
  }
  const reasons = firstArray(source.reasons, rawCase.reasons, rawCase.rationales, rawCase.explanations).map(compactText).filter(Boolean);
  if (reasons.length) certificate.reasons = reasons;
  return certificate;
}

function collectMustCiteSet(rawCase = {}, existingGold = {}) {
  return normalizePaperList(
    existingGold.must_cite_set,
    existingGold.mustCiteSet,
    existingGold.must_cite,
    existingGold.mustCite,
    existingGold.relevant,
    existingGold.papers,
    rawCase.must_cite_set,
    rawCase.mustCiteSet,
    rawCase.must_cite,
    rawCase.mustCite,
    rawCase.relevant,
    rawCase.relevant_papers,
    rawCase.relevantPapers,
    rawCase.gold_papers,
    rawCase.goldPapers,
    rawCase.required_citations,
    rawCase.requiredCitations,
    rawCase.references,
    rawCase.citations,
    rawCase.bibliography,
    rawCase.ancestor_papers,
    rawCase.baseline_papers
  );
}

function inferTimeCutoff(rawCase = {}, options = {}) {
  const explicit = firstDefined(
    rawCase.timeCutoff,
    rawCase.time_cutoff,
    rawCase.cutoffYear,
    rawCase.cutoff_year,
    options.timeCutoff,
    options.time_cutoff
  );
  const explicitYear = Number(explicit);
  if (Number.isFinite(explicitYear)) return explicitYear;
  const eventYear = Number(firstDefined(
    rawCase.submission_year,
    rawCase.submissionYear,
    rawCase.venue_year,
    rawCase.venueYear,
    rawCase.year,
    rawCase.publication_year,
    rawCase.publicationYear
  ));
  return Number.isFinite(eventYear) ? eventYear - 1 : null;
}

function buildGold(rawCase = {}) {
  const existingGold = asObject(rawCase.gold || rawCase.expected || rawCase.labels);
  const mustCiteSet = collectMustCiteSet(rawCase, existingGold);
  const claims = collectClaims(rawCase, existingGold);
  const noveltyCertificate = normalizeNoveltyCertificate(rawCase, existingGold);
  return {
    ...existingGold,
    ...(mustCiteSet.length ? { must_cite_set: mustCiteSet } : {}),
    ...(claims.length ? { claims } : {}),
    ...(Object.keys(noveltyCertificate).length ? { novelty_certificate: noveltyCertificate } : {})
  };
}

function collectRawItems(input = {}, format = 'custom') {
  if (Array.isArray(input)) return input;
  const raw = asObject(input);
  const items = firstArray(
    raw.cases,
    raw.replays,
    raw.queries,
    raw.items,
    raw.records,
    raw.submissions,
    raw.papers,
    raw.claims
  );
  if (items.length) return items;
  if (format === 'claimcheck' || format === 'claim-bench') {
    return firstArray(raw.examples, raw.labels);
  }
  return [];
}

function sourceMetadata(rawCase = {}) {
  return {
    source_id: compactText(rawCase.source_id || rawCase.sourceId || rawCase.id || rawCase.case_id || rawCase.submission_id),
    title: compactText(rawCase.title || rawCase.paper_title || rawCase.paperTitle),
    venue: compactText(rawCase.venue || rawCase.conference || rawCase.journal),
    year: firstDefined(rawCase.year, rawCase.publication_year, rawCase.submission_year, rawCase.venue_year),
    decision: compactText(rawCase.decision || rawCase.acceptance || rawCase.label),
    license_scope: compactText(rawCase.license_scope || rawCase.license || rawCase.dataset_license)
  };
}

function normalizeCase(rawCase = {}, index = 0, context = {}) {
  const id = caseLookupKeys(rawCase, index)[0] || `case:${index + 1}`;
  const gold = buildGold(rawCase);
  const candidate = firstObject(
    rawCase.candidate,
    rawCase.candidatePacket,
    rawCase.candidate_packet,
    rawCase.system,
    rawCase.packet,
    lookupPacket(rawCase, index, context.candidatePackets, context.candidatePacket)
  );
  const baseline = firstObject(
    rawCase.baseline,
    rawCase.baselinePacket,
    rawCase.baseline_packet,
    rawCase.liveDiscoveryBaseline,
    rawCase.live_discovery_baseline,
    lookupPacket(rawCase, index, context.baselinePackets, context.baselinePacket)
  );
  const timeCutoff = inferTimeCutoff(rawCase, context);
  return {
    ...rawCase,
    id,
    dataset: compactText(rawCase.dataset || rawCase.benchmark || rawCase.source || context.format),
    source_format: context.format,
    ...(timeCutoff !== null ? { timeCutoff } : {}),
    candidate,
    baseline,
    gold,
    source_metadata: {
      ...sourceMetadata(rawCase),
      adapter_case_index: index
    }
  };
}

export function adaptIdeaCatalystReplayBenchmark(input = {}, options = {}) {
  const raw = asObject(input);
  const format = normalizeReplayAdapterFormat(options.format || raw.format || raw.dataset_format || raw.datasetFormat || raw.dataset || 'custom');
  const candidatePacket = firstObject(options.candidatePacket, raw.candidatePacket, raw.candidate_packet, raw.candidate);
  const baselinePacket = firstObject(options.baselinePacket, raw.baselinePacket, raw.baseline_packet, raw.baseline);
  const context = {
    format,
    timeCutoff: options.timeCutoff ?? options.time_cutoff ?? raw.timeCutoff ?? raw.time_cutoff,
    candidatePacket,
    baselinePacket,
    candidatePackets: options.candidatePackets || raw.candidatePackets || raw.candidate_packets,
    baselinePackets: options.baselinePackets || raw.baselinePackets || raw.baseline_packets
  };
  const cases = collectRawItems(input, format).map((entry, index) => normalizeCase(entry, index, context));
  const diagnostics = {
    case_count: cases.length,
    missing_candidate_packet_count: cases.filter((entry) => !isNonEmptyObject(entry.candidate)).length,
    missing_baseline_packet_count: cases.filter((entry) => !isNonEmptyObject(entry.baseline)).length,
    missing_gold_must_cite_count: cases.filter((entry) => !asArray(entry.gold?.must_cite_set).length).length,
    missing_gold_claim_count: cases.filter((entry) => !asArray(entry.gold?.claims).length).length,
    missing_gold_novelty_count: cases.filter((entry) => !isNonEmptyObject(entry.gold?.novelty_certificate)).length
  };
  return {
    name: compactText(options.name || raw.name || raw.dataset || `${format}-idea-catalyst-replay`),
    format,
    adapter_contract_version: IDEA_CATALYST_REPLAY_ADAPTER_VERSION,
    source_format: format,
    cases,
    adapter_diagnostics: diagnostics
  };
}
