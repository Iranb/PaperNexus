import { readJson, writeJson } from '../../lib/fs.js';
import { jaccardSimilarity, normalizeText, stableHash, tokenizeWithoutStopwords, truncate, unique } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';

export const CLAIM_EXTRACTION_CONTRACT_VERSION = 'papernexus-claim-extraction-v1';

const CLAIM_SECTION_ROLES = new Set([
  'abstract',
  'introduction',
  'method',
  'approach',
  'evaluation',
  'experiment',
  'results',
  'analysis',
  'discussion',
  'conclusion',
  'body'
]);

const CLAIM_TYPE_ALIASES = new Map([
  ['contribution', 'contribution'],
  ['novelty', 'contribution'],
  ['performance', 'performance'],
  ['comparison', 'performance'],
  ['capability', 'capability'],
  ['method', 'method'],
  ['finding', 'finding'],
  ['result', 'finding'],
  ['boundary', 'boundary'],
  ['limitation', 'boundary'],
  ['negative', 'boundary'],
  ['dataset', 'dataset'],
  ['resource', 'dataset'],
  ['uncertain', 'uncertain']
]);

const CLAIM_PATTERNS = [
  ['contribution', /\b(we|this paper|this work|our)\b.{0,80}\b(propose|present|introduce|develop|design|contribute|provide)\b/i, 3],
  ['contribution', /\b(novel|new|first|original)\b.{0,80}\b(method|approach|framework|dataset|benchmark|system|model)\b/i, 2.5],
  ['performance', /\b(outperform|outperforms|outperformed|improve|improves|improved|gain|achieve|achieves|achieved|surpass|surpasses|exceed|exceeds|reduce|reduces|increase|increases)\b/i, 2.5],
  ['performance', /\b(\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?(point|pts?))\b.{0,80}\b(improvement|gain|higher|lower|better|reduction)\b/i, 2],
  ['capability', /\b(enable|enables|support|supports|allow|allows|facilitate|facilitates|make it possible)\b/i, 2],
  ['method', /\b(method|model|algorithm|framework|pipeline|architecture)\b.{0,80}\b(use|uses|combine|combines|learn|learns|estimate|estimates|align|aligns)\b/i, 1.8],
  ['finding', /\b(show|shows|showed|demonstrate|demonstrates|find|finds|found|reveal|reveals|indicate|indicates|suggest|suggests)\b/i, 2],
  ['boundary', /\b(fail|fails|failed|cannot|unable|limited|limitation|drawback|weakness|sensitive|degrade|degrades|drop|drops)\b/i, 2.5],
  ['dataset', /\b(release|provide|construct|curate|introduce)\b.{0,80}\b(dataset|benchmark|corpus|test set|collection)\b/i, 2.2]
];

const EVIDENCE_PATTERNS = [
  /\b(experiment|evaluation|ablation|analysis|result|results|benchmark|study|table|figure)\b/i,
  /\b(show|shows|demonstrate|demonstrates|find|finds|reported|observed|achieve|achieves)\b/i,
  /\b(accuracy|f1|recall|precision|ndcg|auc|bleu|rouge|score|performance)\b/i,
  /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(point|pts?)\b/i
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function splitSentencesWithOffsets(text = '') {
  const source = String(text || '')
    .replace(/\bet al\./gi, (match) => `${match.slice(0, -1)}∯`)
    .replace(/\be\.g\./gi, (match) => match.replace(/\./g, '∯'))
    .replace(/\bi\.e\./gi, (match) => match.replace(/\./g, '∯'));
  const sentences = [];
  const pattern = /[^.!?\n]+(?:[.!?]+|$)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0];
    const leading = raw.match(/^\s*/)?.[0]?.length || 0;
    const trimmed = raw.trim().replace(/∯/g, '.');
    if (!trimmed) continue;
    const start = match.index + leading;
    sentences.push({
      text: compactText(trimmed, 1200),
      start,
      end: start + trimmed.length
    });
  }
  return sentences;
}

function inferSectionRole(value = '') {
  const role = compactText(value, 120).toLowerCase();
  if (!role) return 'body';
  if (/abstract/.test(role)) return 'abstract';
  if (/intro/.test(role)) return 'introduction';
  if (/related|background/.test(role)) return 'background';
  if (/method|approach|model|architecture/.test(role)) return 'method';
  if (/experiment|evaluation|result/.test(role)) return 'evaluation';
  if (/analysis|discussion/.test(role)) return 'discussion';
  if (/conclusion/.test(role)) return 'conclusion';
  return role.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'body';
}

function sectionsFromMarkdown(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let current = {
    id: 'section:body',
    heading: '',
    role: 'body',
    text: ''
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (current.text.trim()) sections.push(current);
      const title = compactText(heading[2], 240);
      current = {
        id: `section:${stableHash(title)}`,
        heading: title,
        role: inferSectionRole(title),
        text: ''
      };
    } else {
      current.text = `${current.text}\n${line}`;
    }
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

function normalizeSection(section = {}, index = 0) {
  const heading = compactText(section.heading || section.sectionHeading || section.title || section.name || '', 240);
  const role = inferSectionRole(section.role || section.sectionRole || heading || 'body');
  const base = {
    id: section.id || section.sectionId || `section:${index + 1}`,
    heading,
    role,
    sourcePath: section.sourcePath || section.source_path || ''
  };
  const chunks = asArray(section.chunks).filter((chunk) => compactText(chunk?.text || chunk?.content || chunk?.markdown));
  if (chunks.length) {
    return chunks.map((chunk, chunkIndex) => ({
      ...base,
      chunkId: chunk.id || chunk.chunkId || `chunk:${index + 1}:${chunkIndex + 1}`,
      text: compactText(chunk.text || chunk.content || chunk.markdown, 10000)
    }));
  }
  return [{
    ...base,
    chunkId: section.chunkId || null,
    text: compactText(section.text || section.content || section.markdown || '', 10000)
  }];
}

function collectSections(input = {}) {
  if (Array.isArray(input)) {
    return input.flatMap((section, index) => normalizeSection(section, index));
  }
  const paper = input.paper && typeof input.paper === 'object' ? input.paper : input;
  const sectionCandidates = [
    ...asArray(input.sections),
    ...asArray(input.parsedSections),
    ...asArray(input.parsed_sections),
    ...asArray(paper.sections)
  ];
  if (sectionCandidates.length) {
    return sectionCandidates.flatMap((section, index) => normalizeSection(section, index));
  }
  const text = input.markdown || input.text || input.content || paper.markdown || paper.text || paper.content || '';
  return sectionsFromMarkdown(text).flatMap((section, index) => normalizeSection(section, index));
}

function normalizePaper(input = {}) {
  const paper = input.paper && typeof input.paper === 'object' ? input.paper : input;
  return {
    paperId: paper.paperId || paper.paper_id || paper.id || input.paperId || input.paper_id || null,
    paperTitle: paper.paperTitle || paper.paper_title || paper.title || input.paperTitle || input.paper_title || '',
    sourceKey: paper.sourceKey || paper.source_key || input.sourceKey || input.source_key || null,
    sourcePath: paper.sourcePath || paper.source_path || input.sourcePath || input.source_path || '',
    sourceMarkdownPath: paper.sourceMarkdownPath || paper.source_markdown_path || input.sourceMarkdownPath || input.source_markdown_path || '',
    sourcePdfPath: paper.sourcePdfPath || paper.source_pdf_path || input.sourcePdfPath || input.source_pdf_path || ''
  };
}

function claimPatternMatches(sentence = '') {
  const matches = [];
  for (const [type, pattern, weight] of CLAIM_PATTERNS) {
    if (pattern.test(sentence)) matches.push({ type, weight });
  }
  return matches;
}

function normalizeClaimType(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
  return CLAIM_TYPE_ALIASES.get(normalized) || CLAIM_TYPE_ALIASES.get(normalized.replace(/-/g, '_')) || '';
}

function classifyClaim(sentence = '', sectionRole = '') {
  const matches = claimPatternMatches(sentence);
  if (!matches.length) return null;
  const scores = new Map();
  for (const match of matches) {
    scores.set(match.type, (scores.get(match.type) || 0) + match.weight);
  }
  if (sectionRole === 'method') scores.set('method', (scores.get('method') || 0) + 0.7);
  if (sectionRole === 'evaluation') scores.set('performance', (scores.get('performance') || 0) + 0.6);
  if (sectionRole === 'abstract' || sectionRole === 'introduction') scores.set('contribution', (scores.get('contribution') || 0) + 0.3);
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [claimType, score] = ranked[0] || ['uncertain', 0];
  return {
    claimType,
    score,
    matchedTypes: unique(matches.map((match) => match.type))
  };
}

function isClaimCandidate(sentence = '', sectionRole = '') {
  const text = compactText(sentence, 1200);
  if (text.length < 35) return false;
  if (tokenizeWithoutStopwords(text).length < 5) return false;
  if (/\b(figure|table|appendix)\s+\d+\s*(shows|reports)?\s*$/i.test(text)) return false;
  if (sectionRole === 'background' && !/\b(gap|limited|fails?|however|we|our|this work)\b/i.test(text)) return false;
  return Boolean(classifyClaim(text, sectionRole));
}

function evidenceScore(sentence = '') {
  return EVIDENCE_PATTERNS.reduce((score, pattern) => score + (pattern.test(sentence) ? 1 : 0), 0);
}

function findEvidenceSentence(sectionSentences = [], claimIndex = 0) {
  const candidates = [];
  for (let offset = -2; offset <= 2; offset += 1) {
    const index = claimIndex + offset;
    if (index < 0 || index >= sectionSentences.length) continue;
    const sentence = sectionSentences[index];
    const score = evidenceScore(sentence.text) + (offset === 0 ? 1 : 0) - Math.abs(offset) * 0.25;
    if (score > 0) candidates.push({ ...sentence, score, sentenceIndex: index });
  }
  return candidates.sort((left, right) => right.score - left.score)[0] || {
    ...sectionSentences[claimIndex],
    score: 0.5,
    sentenceIndex: claimIndex
  };
}

function collectCitationContexts(input = {}, extra = {}) {
  const contexts = [
    ...asArray(input.contexts),
    ...asArray(input.citationContexts),
    ...asArray(input.citation_contexts),
    ...asArray(extra.contexts),
    ...asArray(extra.citationContexts),
    ...asArray(extra.citation_contexts)
  ];
  return contexts.filter((entry) => entry && typeof entry === 'object');
}

function collectCitationIntents(input = {}, extra = {}) {
  const intents = [
    ...asArray(input.intents),
    ...asArray(input.citationIntents),
    ...asArray(input.citation_intents),
    ...asArray(extra.intents),
    ...asArray(extra.citationIntents),
    ...asArray(extra.citation_intents)
  ];
  return intents.filter((entry) => entry && typeof entry === 'object');
}

function citationContextId(context = {}) {
  return context.id || context.citationContextId || context.citation_context_id || null;
}

function linkCitationContexts(sentence = '', section = {}, contexts = []) {
  const normalizedSentence = normalizeText(sentence);
  return contexts.filter((context) => {
    const raw = compactText(context.citationRaw || context.citation_raw, 120);
    const quote = compactText(context.exactQuote || context.citationContext || context.citation_context, 900);
    const sameChunk = context.chunkId && section.chunkId && context.chunkId === section.chunkId;
    const sameSection = context.sectionId && section.id && context.sectionId === section.id;
    if (raw && sentence.includes(raw)) return true;
    if (quote && (normalizeText(quote).includes(normalizedSentence) || normalizedSentence.includes(normalizeText(quote)))) return true;
    if ((sameChunk || sameSection) && quote && jaccardSimilarity(sentence, quote) >= 0.5) return true;
    return false;
  });
}

function linkCitationIntents(contextIds = [], intents = []) {
  const ids = new Set(contextIds);
  return intents.filter((intent) => ids.has(intent.citationContextId || intent.citation_context_id));
}

function buildSourceSpan({ paper, section, sentence, sentenceIndex, role = 'claim' }) {
  const id = `span:${stableHash([
    paper.paperId || paper.paperTitle,
    section.id,
    section.chunkId || '',
    sentence.start,
    sentence.end,
    role,
    sentence.text
  ].join(':'))}`;
  return {
    id,
    span_id: id,
    role,
    paperId: paper.paperId,
    paperTitle: paper.paperTitle,
    sourceKey: paper.sourceKey,
    sourcePath: section.sourcePath || paper.sourcePath,
    sourceMarkdownPath: paper.sourceMarkdownPath,
    sourcePdfPath: paper.sourcePdfPath,
    sectionId: section.id,
    sectionHeading: section.heading,
    sectionRole: section.role,
    chunkId: section.chunkId,
    sentenceIndex,
    start: sentence.start,
    end: sentence.end,
    text: sentence.text
  };
}

function graphNode(id, type, name, properties = {}) {
  return {
    id,
    type,
    name: compactText(name, 180),
    properties
  };
}

function graphEdge(sourceId, targetId, type, properties = {}) {
  return {
    id: `edge:${stableHash(`${sourceId}:${type}:${targetId}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function buildGraphProjection(paper = {}, claims = [], sourceSpans = []) {
  const nodes = [];
  const edges = [];
  if (paper.paperId) {
    nodes.push(graphNode(paper.paperId, NODE_TYPES.PAPER, paper.paperTitle || paper.paperId, {
      sourceKey: paper.sourceKey,
      sourcePath: paper.sourcePath
    }));
  }
  const spansById = new Map(sourceSpans.map((span) => [span.span_id || span.id, span]));
  for (const claim of claims) {
    nodes.push(graphNode(claim.id, NODE_TYPES.CLAIM, claim.claim_text, {
      claimType: claim.claim_type,
      confidence: claim.confidence,
      normalizedText: claim.normalized_text,
      sectionRole: claim.sectionRole,
      sourceSpanIds: claim.source_span_ids,
      citationContextIds: claim.citation_context_ids,
      citationIntentIds: claim.citation_intent_ids
    }));
    if (paper.paperId) edges.push(graphEdge(paper.paperId, claim.id, EDGE_TYPES.CLAIMS));
    for (const spanId of claim.source_span_ids) {
      const span = spansById.get(spanId);
      if (!span) continue;
      nodes.push(graphNode(spanId, NODE_TYPES.EVIDENCE_SNIPPET, span.text, {
        role: span.role,
        paperId: span.paperId,
        sectionId: span.sectionId,
        sectionRole: span.sectionRole,
        start: span.start,
        end: span.end
      }));
      edges.push(graphEdge(claim.id, spanId, EDGE_TYPES.SUPPORTED_BY, { role: span.role }));
      edges.push(graphEdge(spanId, claim.id, EDGE_TYPES.SUPPORTS_CLAIM, { role: span.role }));
    }
    for (const contextId of claim.citation_context_ids) {
      edges.push(graphEdge(claim.id, contextId, EDGE_TYPES.SUPPORTED_BY, { role: 'citation_context' }));
    }
  }
  return {
    nodes: [...new Map(nodes.map((node) => [node.id, node])).values()],
    edges: [...new Map(edges.map((edge) => [edge.id, edge])).values()]
  };
}

function dedupeClaims(claims = []) {
  const byText = new Map();
  for (const claim of claims) {
    const key = normalizeText(claim.claim_text);
    const previous = byText.get(key);
    if (!previous || claim.confidence > previous.confidence) byText.set(key, claim);
  }
  return [...byText.values()].sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

export function extractClaimsFromPaper(input = {}, options = {}) {
  const paper = normalizePaper(input);
  const sections = collectSections(input).filter((section) => section.text && CLAIM_SECTION_ROLES.has(section.role));
  const citationContexts = collectCitationContexts(input, options.citationContextsArtifact || {});
  const citationIntents = collectCitationIntents(input, options.citationIntentsArtifact || {});
  const maxClaims = Number.isFinite(Number(options.maxClaims)) ? Math.max(1, Number(options.maxClaims)) : 25;
  const claims = [];
  const sourceSpans = [];
  const diagnostics = {
    contractVersion: CLAIM_EXTRACTION_CONTRACT_VERSION,
    sectionCount: sections.length,
    sentenceCount: 0,
    candidateSentenceCount: 0,
    claimCount: 0,
    sourceSpanCount: 0,
    citationContextLinkCount: 0,
    warnings: []
  };

  for (const section of sections) {
    const sentences = splitSentencesWithOffsets(section.text);
    diagnostics.sentenceCount += sentences.length;
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex];
      if (!isClaimCandidate(sentence.text, section.role)) continue;
      diagnostics.candidateSentenceCount += 1;
      const classification = classifyClaim(sentence.text, section.role);
      if (!classification) continue;
      const evidenceSentence = findEvidenceSentence(sentences, sentenceIndex);
      const claimSpan = buildSourceSpan({ paper, section, sentence, sentenceIndex, role: 'claim' });
      const evidenceSpan = buildSourceSpan({ paper, section, sentence: evidenceSentence, sentenceIndex: evidenceSentence.sentenceIndex ?? sentenceIndex, role: 'evidence' });
      const linkedContexts = linkCitationContexts(sentence.text, section, citationContexts);
      const linkedContextIds = unique(linkedContexts.map(citationContextId).filter(Boolean));
      const linkedIntents = linkCitationIntents(linkedContextIds, citationIntents);
      const linkedIntentIds = unique(linkedIntents.map((intent) => intent.id).filter(Boolean));
      const confidence = clamp(0.48 + classification.score / 8 + (linkedContextIds.length ? 0.08 : 0) + (evidenceScore(evidenceSentence.text) ? 0.08 : 0), 0.45, 0.94);
      const claimId = `claim:${stableHash([
        paper.paperId || paper.paperTitle,
        section.id,
        sentence.start,
        sentence.text
      ].join(':'))}`;
      sourceSpans.push(claimSpan);
      if (evidenceSpan.id !== claimSpan.id) sourceSpans.push(evidenceSpan);
      claims.push({
        contractVersion: CLAIM_EXTRACTION_CONTRACT_VERSION,
        id: claimId,
        claim_id: claimId,
        paperId: paper.paperId,
        paperTitle: paper.paperTitle,
        sourceKey: paper.sourceKey,
        claim_text: sentence.text,
        normalized_text: normalizeText(sentence.text),
        claim_type: classification.claimType,
        confidence,
        sectionId: section.id,
        sectionHeading: section.heading,
        sectionRole: section.role,
        chunkId: section.chunkId,
        source_span_ids: unique([claimSpan.span_id, evidenceSpan.span_id]),
        evidence_span_ids: unique([evidenceSpan.span_id]),
        citation_context_ids: linkedContextIds,
        citation_intent_ids: linkedIntentIds,
        citation_intents: linkedIntents.map((intent) => ({
          id: intent.id,
          intent: intent.intent,
          confidence: intent.confidence,
          graphEdgeType: intent.graphEdgeType
        })),
        matched_claim_types: classification.matchedTypes,
        extractionStatus: 'source-span-grounded'
      });
    }
  }

  const dedupedClaims = dedupeClaims(claims).slice(0, maxClaims);
  const usedSpanIds = new Set(dedupedClaims.flatMap((claim) => claim.source_span_ids));
  const dedupedSpans = [...new Map(sourceSpans.filter((span) => usedSpanIds.has(span.span_id)).map((span) => [span.span_id, span])).values()];
  diagnostics.claimCount = dedupedClaims.length;
  diagnostics.sourceSpanCount = dedupedSpans.length;
  diagnostics.citationContextLinkCount = dedupedClaims.reduce((sum, claim) => sum + claim.citation_context_ids.length, 0);
  if (!sections.length) diagnostics.warnings.push({ code: 'no_claim_sections', message: 'No eligible paper sections were available for claim extraction.' });
  if (!dedupedClaims.length) diagnostics.warnings.push({ code: 'no_claims_extracted', message: 'No claim-like source spans were extracted.' });
  if (dedupedClaims.some((claim) => !claim.citation_context_ids.length)) diagnostics.warnings.push({ code: 'claims_without_citation_contexts', count: dedupedClaims.filter((claim) => !claim.citation_context_ids.length).length });

  const graph = buildGraphProjection(paper, dedupedClaims, dedupedSpans);
  return {
    contractVersion: CLAIM_EXTRACTION_CONTRACT_VERSION,
    paper,
    claims: dedupedClaims,
    source_spans: dedupedSpans,
    graph,
    diagnostics
  };
}

function goldEntries(gold = {}) {
  if (Array.isArray(gold)) return gold;
  if (Array.isArray(gold.claims)) return gold.claims;
  if (Array.isArray(gold.items)) return gold.items;
  if (Array.isArray(gold.cases)) return gold.cases;
  if (gold && typeof gold === 'object') {
    return Object.entries(gold).map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return { id: key, ...value };
      return { id: key, claim_text: value };
    });
  }
  return [];
}

function goldText(entry = {}) {
  return compactText(entry.claim_text || entry.claimText || entry.text || entry.claim || entry.statement || '', 1200);
}

function goldType(entry = {}) {
  return normalizeClaimType(entry.claim_type || entry.claimType || entry.type || entry.label || '');
}

function matchGoldClaim(gold = {}, predictions = [], threshold = 0.55) {
  const text = goldText(gold);
  if (!text) return null;
  const directId = gold.claim_id || gold.claimId || gold.id;
  const direct = directId ? predictions.find((claim) => claim.id === directId || claim.claim_id === directId) : null;
  if (direct) return { claim: direct, score: 1 };
  const scored = predictions
    .map((claim) => ({ claim, score: jaccardSimilarity(text, claim.claim_text) }))
    .sort((left, right) => right.score - left.score);
  return scored[0]?.score >= threshold ? scored[0] : null;
}

export function evaluateClaimExtraction(predictions = [], gold = {}, options = {}) {
  const goldClaims = goldEntries(gold).filter((entry) => goldText(entry));
  const matchThreshold = Number.isFinite(Number(options.matchThreshold)) ? Number(options.matchThreshold) : 0.55;
  const matchedPredictionIds = new Set();
  const matches = [];
  const missing_gold_claims = [];
  let typeCorrect = 0;
  let typeEvaluated = 0;

  for (const entry of goldClaims) {
    const match = matchGoldClaim(
      entry,
      predictions.filter((claim) => !matchedPredictionIds.has(claim.id || claim.claim_id)),
      matchThreshold
    );
    if (!match) {
      missing_gold_claims.push(goldText(entry));
      continue;
    }
    const prediction = match.claim;
    matchedPredictionIds.add(prediction.id || prediction.claim_id);
    const expectedType = goldType(entry);
    if (expectedType) {
      typeEvaluated += 1;
      if (expectedType === normalizeClaimType(prediction.claim_type)) typeCorrect += 1;
    }
    matches.push({
      gold: goldText(entry),
      prediction_id: prediction.id || prediction.claim_id,
      score: match.score
    });
  }

  const claimRecall = goldClaims.length ? matches.length / goldClaims.length : 0;
  const claimPrecision = predictions.length ? matchedPredictionIds.size / predictions.length : 0;
  const sourceSpanCompleteness = predictions.length
    ? predictions.filter((claim) => asArray(claim.source_span_ids || claim.sourceSpanIds).length > 0).length / predictions.length
    : 0;
  const typeAccuracy = typeEvaluated ? typeCorrect / typeEvaluated : null;
  const minClaimRecall = Number.isFinite(Number(options.minClaimRecall)) ? Number(options.minClaimRecall) : null;
  const minSourceSpanCompleteness = Number.isFinite(Number(options.minSourceSpanCompleteness)) ? Number(options.minSourceSpanCompleteness) : null;
  const minTypeAccuracy = Number.isFinite(Number(options.minTypeAccuracy)) ? Number(options.minTypeAccuracy) : null;
  const thresholdFailures = [];
  if (minClaimRecall !== null && claimRecall < minClaimRecall) thresholdFailures.push(`claim_recall ${claimRecall.toFixed(3)} < ${minClaimRecall}`);
  if (minSourceSpanCompleteness !== null && sourceSpanCompleteness < minSourceSpanCompleteness) thresholdFailures.push(`source_span_completeness ${sourceSpanCompleteness.toFixed(3)} < ${minSourceSpanCompleteness}`);
  if (minTypeAccuracy !== null && typeAccuracy !== null && typeAccuracy < minTypeAccuracy) thresholdFailures.push(`type_accuracy ${typeAccuracy.toFixed(3)} < ${minTypeAccuracy}`);

  return {
    contractVersion: `${CLAIM_EXTRACTION_CONTRACT_VERSION}-benchmark-gate`,
    status: goldClaims.length === 0 || predictions.length === 0 ? 'incomplete' : (thresholdFailures.length ? 'failed' : 'passed'),
    gold_count: goldClaims.length,
    prediction_count: predictions.length,
    matched_count: matches.length,
    claim_recall: claimRecall,
    claim_precision: claimPrecision,
    source_span_completeness: sourceSpanCompleteness,
    type_accuracy: typeAccuracy,
    matches,
    missing_gold_claims,
    threshold_failures: thresholdFailures
  };
}

export function buildClaimExtractionArtifact(input = {}, options = {}) {
  const artifact = extractClaimsFromPaper(input, options);
  if (options.gold) {
    artifact.evaluation = evaluateClaimExtraction(artifact.claims, options.gold, {
      matchThreshold: options.matchThreshold,
      minClaimRecall: options.minClaimRecall,
      minSourceSpanCompleteness: options.minSourceSpanCompleteness,
      minTypeAccuracy: options.minTypeAccuracy
    });
  }
  return artifact;
}

export async function readClaimExtractionArtifact(inputPath, options = {}) {
  const input = await readJson(inputPath);
  const citationContextsArtifact = options.citationContextsPath ? await readJson(options.citationContextsPath) : options.citationContextsArtifact;
  const citationIntentsArtifact = options.citationIntentsPath ? await readJson(options.citationIntentsPath) : options.citationIntentsArtifact;
  const gold = options.goldPath ? await readJson(options.goldPath) : options.gold;
  return buildClaimExtractionArtifact(input, {
    ...options,
    citationContextsArtifact,
    citationIntentsArtifact,
    gold
  });
}

export async function writeClaimExtractionArtifact(outputPath, inputPath, options = {}) {
  const artifact = await readClaimExtractionArtifact(inputPath, options);
  await writeJson(outputPath, artifact);
  return artifact;
}
