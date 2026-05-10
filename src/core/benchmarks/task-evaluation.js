import { createPaperIdentity, normalizePaperIdentifiers, paperIdentifiersOverlap } from '../../lib/paper-identifiers.js';
import { jaccardSimilarity, stableHash, tokenizeWithoutStopwords, truncate, unique } from '../../lib/utils.js';
import { getDefaultLlmApiKeyEnv, loadLlmApiKey, resolveLlmConfig } from '../llm/ollama.js';

const DEFAULT_TASK_CONTEXT_LIMIT = 8;
const TASK_SCORE_KEYS = [
  'answer_correctness',
  'answer_exact_match',
  'answer_groundedness',
  'citation_recall',
  'citation_precision',
  'citation_f1',
  'citation_success',
  'citation_faithfulness',
  'claim_accuracy',
  'content_extraction_accuracy',
  'relation_recall',
  'relation_precision',
  'relation_f1',
  'relation_reasoning',
  'scinet_ego_success',
  'scinet_pair_cite_acc',
  'scinet_pair_cite_sentiment',
  'scinet_pair_comention_acc',
  'scinet_path_consistency',
  'scinet_path_connectivity',
  'scinet_path_rationality',
  'paperask_success_rate',
  'task_success',
  'task_score'
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

function clamp01(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeLabel(value = '') {
  const normalized = compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['yes', 'true', 'supported', 'support', 'entails', 'entailed', 'correct', 'accept'].includes(normalized)) return 'supported';
  if (['no', 'false', 'refuted', 'refute', 'contradicted', 'incorrect', 'reject'].includes(normalized)) return 'refuted';
  if (['maybe', 'unknown', 'insufficient', 'not_enough_info', 'nei', 'unverifiable'].includes(normalized)) return 'insufficient';
  if (['positive', 'praise', 'praises', 'confirms', 'builds_upon', 'uses', 'extends'].includes(normalized)) return 'positive';
  if (['negative', 'criticizes', 'contradicts', 'limitation', 'limitations'].includes(normalized)) return 'negative';
  if (['neutral', 'mentions', 'background'].includes(normalized)) return 'neutral';
  if (['novelty', 'novel', 'disruption', 'disruptiveness', 'disruptive'].includes(normalized)) return normalized;
  return normalized;
}

function normalizePaper(value = {}, fallbackId = '') {
  const raw = typeof value === 'string' ? { id: value, title: value } : asObject(value);
  const textIdentifiers = extractIdentifiersFromText([
    raw.id,
    raw.paperID,
    raw.paperId,
    raw.paper_id,
    raw.s2PaperId,
    raw.s2_paper_id,
    raw.semanticScholarId,
    raw.semantic_scholar_id,
    raw.title,
    raw.url,
    raw.uri,
    raw.text,
    raw.abstract
  ].filter(Boolean).join(' '));
  const title = compactText(pickFirst(raw.title, raw.paperTitle, raw.paper_title, raw.name, raw.display_name));
  const identifiers = normalizePaperIdentifiers({
    ...textIdentifiers,
    ...asObject(raw.identifiers),
    ...raw
  });
  const identity = createPaperIdentity({
    identifiers,
    title,
    normalizedTitle: raw.normalizedTitle || raw.normalized_title
  });
  return {
    ...raw,
    id: compactText(pickFirst(
      raw.id,
      raw._id,
      raw.paperId,
      raw.paperID,
      raw.paperid,
      raw.paper_id,
      raw.s2PaperId,
      raw.s2_paper_id,
      raw.semanticScholarId,
      raw.semantic_scholar_id,
      raw.docId,
      raw.doc_id,
      raw.corpusid,
      raw.corpusId,
      fallbackId,
      identity.canonicalId
    )),
    title,
    abstract: compactText(pickFirst(raw.abstract, raw.text, raw.summary)),
    sourceUrl: compactText(pickFirst(raw.url, raw.uri, raw.sourceUrl, raw.source_url)),
    identifiers,
    ...identity
  };
}

function extractIdentifiersFromText(value = '') {
  const text = String(value || '');
  const identifiers = {};
  const doiMatch = text.match(/10\.\d{4,9}\/[^\s"'<>}]+/i);
  const arxivMatch = text.match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)([a-z.-]+\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  const pmidMatch = text.match(/(?:pubmed\/|pmid[:/\s]+)(\d+)/i);
  const pmcidMatch = text.match(/(?:pmc\/articles\/|pmcid[:/\s]+|\/)(PMC\d+)/i);
  if (doiMatch) identifiers.doi = doiMatch[0].replace(/[),.;]+$/, '');
  if (arxivMatch) identifiers.arxivId = arxivMatch[1];
  if (pmidMatch) identifiers.pmid = pmidMatch[1];
  if (pmcidMatch) identifiers.pmcid = pmcidMatch[1];
  return identifiers;
}

function collectAliases(paper = {}) {
  const normalized = normalizePaper(paper);
  return unique([
    normalized.id,
    normalized.canonicalId,
    normalized.normalizedTitle,
    ...(Array.isArray(normalized.identityAliases) ? normalized.identityAliases : [])
  ].map(compactText).filter(Boolean));
}

function papersOverlap(left = {}, right = {}) {
  if (paperIdentifiersOverlap(left, right)) return true;
  const leftAliases = new Set(collectAliases(left));
  if (collectAliases(right).some((alias) => leftAliases.has(alias))) return true;
  const leftTitle = compactText(left.normalizedTitle || left.title);
  const rightTitle = compactText(right.normalizedTitle || right.title);
  return Boolean(leftTitle && rightTitle && jaccardSimilarity(leftTitle, rightTitle) >= 0.96);
}

function citationMatches(citation = {}, goldPapers = []) {
  const normalized = normalizePaper(citation);
  return goldPapers.findIndex((gold) => papersOverlap(normalized, gold));
}

function f1(precision = 0, recall = 0) {
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function normalizeTaskEvaluationMode(value = 'rules') {
  const normalized = String(value || 'rules').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['0', 'false', 'no', 'none', 'off', 'disabled'].includes(normalized)) return 'off';
  if (['llm', 'judge', 'task', 'full'].includes(normalized)) return 'llm';
  if (['auto'].includes(normalized)) return 'auto';
  return 'rules';
}

function getReferenceAnswers(queryCase = {}) {
  return asArray(queryCase.referenceAnswers || queryCase.reference_answers)
    .map((entry) => (typeof entry === 'string' ? entry : pickFirst(entry.answer, entry.text, entry.value)))
    .map(compactText)
    .filter(Boolean);
}

function getReferenceRubrics(queryCase = {}) {
  return asArray(queryCase.referenceRubrics || queryCase.reference_rubrics)
    .map((entry, index) => {
      if (typeof entry === 'string') return { name: `rubric_${index + 1}`, criterion: compactText(entry), evidence: [] };
      const raw = asObject(entry);
      const criterion = compactText(pickFirst(raw.criterion, raw.text, raw.description, raw.name));
      if (!criterion) return null;
      return {
        name: compactText(pickFirst(raw.name, `rubric_${index + 1}`)),
        criterion,
        weight: Number.isFinite(Number(raw.weight)) ? Number(raw.weight) : 1,
        evidence: asArray(raw.evidence || raw.snippets || raw.references).map(compactText).filter(Boolean)
      };
    })
    .filter(Boolean);
}

function getExpectedStructuredAnswer(queryCase = {}) {
  const raw = queryCase.expectedStructuredAnswer || queryCase.expected_structured_answer;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function getSystemAnswer(queryCase = {}) {
  const raw = pickFirst(
    queryCase.systemAnswer,
    queryCase.system_answer,
    queryCase.generatedAnswer,
    queryCase.generated_answer,
    queryCase.predictedAnswer,
    queryCase.predicted_answer
  );
  if (!raw) return null;
  if (typeof raw === 'string') return { answer: raw, citations: [], relations: [] };
  return {
    answer: compactText(pickFirst(raw.answer, raw.text, raw.response, raw.finalAnswer, raw.final_answer)),
    verdict: compactText(pickFirst(raw.verdict, raw.label, raw.claimLabel, raw.claim_label)),
    labels: asArray(raw.labels || raw.verdicts || raw.claimLabels || raw.claim_labels).map(compactText).filter(Boolean),
    citations: asArray(raw.citations || raw.references || raw.sources || raw.ctxs || raw.contexts).map((entry, index) => normalizePaper(entry, `answer:citation:${index}`)),
    relations: normalizeRelations(raw.relations || raw.paths || raw.edges),
    raw
  };
}

function getExpectedLabel(queryCase = {}) {
  return normalizeLabel(pickFirst(
    queryCase.expectedLabel,
    queryCase.expected_label,
    queryCase.label,
    queryCase.verdict,
    queryCase.claimLabel,
    queryCase.claim_label,
    queryCase.metadata?.expectedLabel,
    queryCase.metadata?.expected_label
  ));
}

function getExpectedLabels(queryCase = {}) {
  return asArray(queryCase.expectedLabels || queryCase.expected_labels)
    .map(normalizeLabel)
    .filter(Boolean);
}

function normalizeRelation(value = {}, fallbackIndex = 0) {
  if (typeof value === 'string') {
    return {
      source: '',
      target: '',
      type: normalizeLabel(value),
      evidence: '',
      path: [],
      key: normalizeLabel(value)
    };
  }
  if (Array.isArray(value)) {
    const path = value.map((entry) => (
      typeof entry === 'string'
        ? compactText(entry)
        : compactText(pickFirst(entry?.title, entry?.id, entry?.paperId, entry?.paper_id, entry?.name))
    )).filter(Boolean);
    const source = path[0] || '';
    const target = path[path.length - 1] || '';
    const key = path.length
      ? path.map((part) => normalizeLabel(part)).join('->')
      : stableHash(JSON.stringify(value || fallbackIndex), 12);
    return {
      source,
      target,
      type: 'path',
      evidence: '',
      path,
      key
    };
  }
  const raw = asObject(value);
  const path = asArray(raw.path || raw.nodes || raw.paperPath || raw.paper_path).map(compactText).filter(Boolean);
  const source = compactText(pickFirst(raw.source, raw.sourceName, raw.source_name, raw.from, path[0]));
  const target = compactText(pickFirst(raw.target, raw.targetName, raw.target_name, raw.to, path[path.length - 1]));
  const type = normalizeLabel(pickFirst(raw.type, raw.relation, raw.relationType, raw.relation_type, raw.label, 'related'));
  const key = [source, type, target].map((part) => normalizeLabel(part)).filter(Boolean).join('|')
    || stableHash(JSON.stringify(raw || fallbackIndex), 12);
  return {
    source,
    target,
    type,
    evidence: compactText(pickFirst(raw.evidence, raw.evidenceText, raw.evidence_text, raw.rationale)),
    paperId: compactText(pickFirst(raw.paperId, raw.paper_id, raw.docId, raw.doc_id)),
    path,
    key
  };
}

export function normalizeRelations(values = []) {
  return asArray(values).map((entry, index) => normalizeRelation(entry, index)).filter((entry) => entry.key);
}

function relationSimilarity(left = {}, right = {}) {
  if (left.key && right.key && left.key === right.key) return 1;
  const source = left.source && right.source ? jaccardSimilarity(left.source, right.source) : 0;
  const target = left.target && right.target ? jaccardSimilarity(left.target, right.target) : 0;
  const type = left.type && right.type ? (left.type === right.type ? 1 : jaccardSimilarity(left.type, right.type)) : 0;
  const pathOverlap = left.path?.length && right.path?.length
    ? jaccardSimilarity(left.path.join(' '), right.path.join(' '))
    : 0;
  return Math.max((source + target + type) / 3, pathOverlap);
}

function computeRelationMetrics(predicted = [], gold = []) {
  if (!gold.length && !predicted.length) return {};
  const matchedGold = new Set();
  let matches = 0;
  for (const relation of predicted) {
    const index = gold.findIndex((target, candidateIndex) => (
      !matchedGold.has(candidateIndex) && relationSimilarity(relation, target) >= 0.72
    ));
    if (index !== -1) {
      matchedGold.add(index);
      matches += 1;
    }
  }
  const precision = predicted.length ? matches / predicted.length : 0;
  const recall = gold.length ? matches / gold.length : 0;
  return {
    relation_precision: precision,
    relation_recall: recall,
    relation_f1: f1(precision, recall)
  };
}

function normalizeCandidateContext(candidates = [], limit = DEFAULT_TASK_CONTEXT_LIMIT) {
  return candidates.slice(0, limit).map((candidate, index) => {
    const paper = normalizePaper(candidate, `candidate:${index + 1}`);
    return {
      rank: index + 1,
      id: paper.id || paper.canonicalId || '',
      canonicalId: paper.canonicalId || '',
      title: paper.title || '',
      abstract: truncate(paper.abstract || '', 900),
      provider: paper.sourceProvider || paper.provider || ''
    };
  });
}

function extractBibtexPapersFromText(text = '') {
  const rawText = String(text || '');
  if (!rawText.trim()) return [];
  const papers = [];
  const titles = [...rawText.matchAll(/title\s*=\s*[{"]([^{}"]+)/gi)].map((match) => compactText(match[1]));
  const dois = [...rawText.matchAll(/doi\s*=\s*[{"]?([^{}"',\s]+)/gi)].map((match) => compactText(match[1]).replace(/[),.;]+$/, ''));
  const urls = [...rawText.matchAll(/url\s*=\s*[{"]([^{}"]+)/gi)].map((match) => compactText(match[1]));
  const arxivIds = [...rawText.matchAll(/(?:eprint|arxiv)\s*=\s*[{"]([^{}"]+)/gi)].map((match) => compactText(match[1]));
  const looseDois = [...rawText.matchAll(/10\.\d{4,9}\/[^\s"'<>}]+/gi)].map((match) => match[0].replace(/[),.;]+$/, ''));
  const count = Math.max(titles.length, dois.length, urls.length, arxivIds.length, looseDois.length);
  for (let index = 0; index < count; index += 1) {
    papers.push(normalizePaper({
      id: `bibtex:${index}`,
      title: titles[index] || '',
      doi: dois[index] || looseDois[index] || '',
      url: urls[index] || '',
      arxivId: arxivIds[index] || ''
    }, `bibtex:${index}`));
  }
  return dedupePapers(papers);
}

function dedupePapers(papers = []) {
  const seen = new Set();
  const deduped = [];
  for (const paper of papers) {
    const key = paper.canonicalId || paper.normalizedTitle || paper.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }
  return deduped;
}

function extractAnswerCitationPapers(systemAnswer = {}, candidates = []) {
  const cited = asArray(systemAnswer.citations).map((entry, index) => normalizePaper(entry, `citation:${index}`));
  const citedByRank = asArray(systemAnswer.citationRanks || systemAnswer.citedRanks || systemAnswer.cited_ranks)
    .map((rank) => Number(rank))
    .filter((rank) => Number.isFinite(rank) && rank > 0)
    .map((rank) => candidates[rank - 1])
    .filter(Boolean)
    .map((entry, index) => normalizePaper(entry, `citation-rank:${index}`));
  const citedFromText = extractBibtexPapersFromText(systemAnswer.answer || '');
  return dedupePapers([...cited, ...citedByRank, ...citedFromText]);
}

function computeCitationMetrics(systemAnswer = {}, candidates = [], goldPapers = []) {
  const cited = extractAnswerCitationPapers(systemAnswer, candidates);
  if (!goldPapers.length && !cited.length) return {};
  const matchedGold = new Set();
  let matches = 0;
  for (const citation of cited) {
    const index = citationMatches(citation, goldPapers);
    if (index !== -1 && !matchedGold.has(index)) {
      matchedGold.add(index);
      matches += 1;
    }
  }
  const precision = cited.length ? matches / cited.length : 0;
  const recall = goldPapers.length ? matches / goldPapers.length : 0;
  return {
    citation_precision: precision,
    citation_recall: recall,
    citation_f1: f1(precision, recall),
    citation_success: precision === 1 && recall === 1 ? 1 : 0
  };
}

function computeCandidatePaperRecall(candidates = [], goldPapers = []) {
  if (!goldPapers.length) return null;
  const matchedGold = new Set();
  for (const candidate of candidates) {
    const index = citationMatches(candidate, goldPapers);
    if (index !== -1) matchedGold.add(index);
  }
  return matchedGold.size / goldPapers.length;
}

function relationPathEndpoints(relation = {}) {
  const path = asArray(relation.path).map(compactText).filter(Boolean);
  if (path.length >= 2) return { source: path[0], target: path[path.length - 1], length: path.length };
  return {
    source: compactText(relation.source),
    target: compactText(relation.target),
    length: relation.source && relation.target ? 2 : 0
  };
}

function computePathConnectivity(predicted = [], gold = []) {
  const goldPaths = gold.map(relationPathEndpoints).filter((entry) => entry.source && entry.target);
  if (!goldPaths.length) return null;
  const connected = predicted.some((relation) => {
    const endpoint = relationPathEndpoints(relation);
    if (!endpoint.source || !endpoint.target || endpoint.length < 2) return false;
    return goldPaths.some((goldPath) => (
      jaccardSimilarity(endpoint.source, goldPath.source) >= 0.72
      && jaccardSimilarity(endpoint.target, goldPath.target) >= 0.72
    ));
  });
  return connected ? 1 : 0;
}

function tokenCoverage(answer = '', referenceAnswers = []) {
  const answerTokens = new Set(tokenizeWithoutStopwords(answer));
  const referenceTokens = unique(referenceAnswers.flatMap((entry) => tokenizeWithoutStopwords(entry)));
  if (!referenceTokens.length || !answerTokens.size) return 0;
  const covered = referenceTokens.filter((token) => answerTokens.has(token)).length;
  return covered / referenceTokens.length;
}

function normalizeComparableText(value = '') {
  return compactText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[`*_{}\[\]()<>"'“”‘’,.;:!?\\/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function answerExactMatch(answer = '', referenceAnswers = []) {
  const normalizedAnswer = normalizeComparableText(answer);
  const references = referenceAnswers.map(normalizeComparableText).filter(Boolean);
  if (!normalizedAnswer || !references.length) return null;
  if (references.some((reference) => normalizedAnswer === reference)) return 1;
  if (references.every((reference) => normalizedAnswer.includes(reference))) return 1;
  return 0;
}

function parseStructuredObjectFromText(text = '') {
  const rawText = String(text || '').trim();
  if (!rawText) return null;
  const candidates = [rawText];
  const fence = rawText.match(/```(?:json|python)?\s*([\s\S]+?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(rawText.slice(firstBrace, lastBrace + 1));
  for (const candidate of unique(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch {}
    try {
      return JSON.parse(
        candidate
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/'/g, '"')
      );
    } catch {}
  }
  return null;
}

function extractStructuredAnswer(systemAnswer = {}) {
  const raw = asObject(systemAnswer.raw);
  for (const value of [raw.answers, raw.answer, raw.output, raw.result, systemAnswer.answers]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  const parsed = parseStructuredObjectFromText(systemAnswer.answer || '');
  if (parsed?.answers && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)) return parsed.answers;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function structuredValuesMatch(left, right) {
  const leftText = compactText(left);
  const rightText = compactText(right);
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  return normalizeComparableText(leftText) === normalizeComparableText(rightText);
}

function computeStructuredAnswerAccuracy(systemAnswer = {}, expected = null) {
  const expectedEntries = Object.entries(asObject(expected));
  if (!expectedEntries.length) return null;
  const predicted = extractStructuredAnswer(systemAnswer);
  if (!predicted) return 0;
  const correct = expectedEntries.filter(([key, value]) => structuredValuesMatch(predicted[key], value)).length;
  return correct / expectedEntries.length;
}

function taskHintText(queryCase = {}) {
  return [
    queryCase.metadata?.benchmarkFormat,
    queryCase.metadata?.taskType,
    queryCase.metadata?.queryType,
    queryCase.metadata?.relationType,
    queryCase.query
  ].map((entry) => String(entry || '').toLowerCase()).join(' ');
}

function isPaperAskCase(queryCase = {}) {
  return taskHintText(queryCase).includes('paperask');
}

function isSciNetCase(queryCase = {}) {
  return taskHintText(queryCase).includes('scinet');
}

function isContentExtractionCase(queryCase = {}) {
  const hint = taskHintText(queryCase);
  return hint.includes('content') || hint.includes('extract') || hint.includes('section') || hint.includes('sentence') || hint.includes('caption');
}

function isSciNetEgoCase(queryCase = {}) {
  const hint = taskHintText(queryCase);
  return isSciNetCase(queryCase) && (hint.includes('ego') || hint.includes('novel') || hint.includes('disrupt'));
}

function isSciNetPairCase(queryCase = {}) {
  const hint = taskHintText(queryCase);
  return isSciNetCase(queryCase) && (hint.includes('pair') || hint.includes('citation_sentiment') || hint.includes('cite') || hint.includes('co_mention') || hint.includes('comention'));
}

function isSciNetPathCase(queryCase = {}) {
  const hint = taskHintText(queryCase);
  return isSciNetCase(queryCase) && (hint.includes('path') || hint.includes('trajectory') || hint.includes('evolution'));
}

function computeClaimAccuracy(expectedLabels = [], predictedLabels = []) {
  if (!expectedLabels.length || !predictedLabels.length) return null;
  const count = Math.min(expectedLabels.length, predictedLabels.length);
  if (!count) return null;
  let correct = 0;
  for (let index = 0; index < count; index += 1) {
    if (expectedLabels[index] && predictedLabels[index] && expectedLabels[index] === predictedLabels[index]) correct += 1;
  }
  return correct / expectedLabels.length;
}

function deriveSuccessRate(metrics = {}, queryCase = {}) {
  const successKeys = [
    'task_success',
    'answer_exact_match',
    'claim_accuracy',
    'citation_success',
    'content_extraction_accuracy',
    'relation_f1',
    'scinet_ego_success',
    'scinet_path_consistency',
    'scinet_pair_cite_acc',
    'scinet_pair_cite_sentiment'
  ];
  const values = successKeys
    .map((key) => metrics[key])
    .filter((value) => Number.isFinite(Number(value)));
  if (!values.length) return null;
  if (isPaperAskCase(queryCase)) {
    return values.every((value) => Number(value) >= 0.999) ? 1 : 0;
  }
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function parseJsonText(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of unique(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error('Benchmark LLM response was not valid JSON.');
}

function extractOpenAiText(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return '';
}

function extractAnthropicText(payload = {}) {
  return asArray(payload.content).map((part) => (part?.type === 'text' ? part.text || '' : '')).join('');
}

async function postJson(url, body, headers = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Benchmark LLM request failed (${response.status}): ${truncate(text, 300)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function callBenchmarkLlmJson(prompt, options = {}) {
  if (typeof options.llmJson === 'function') return options.llmJson(prompt, options);
  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    throw new Error('Task evaluation requires an LLM model. Set llm.model in config or pass --llm-model.');
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for benchmark task evaluation. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/chat/completions`, {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: config.maxTokens || 2048
    }, {
      authorization: `Bearer ${apiKey}`
    }, config.timeoutMs);
    return parseJsonText(extractOpenAiText(payload));
  }

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for benchmark task evaluation. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/messages`, {
      model: config.model,
      max_tokens: config.maxTokens || 2048,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    }, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, config.timeoutMs);
    return parseJsonText(extractAnthropicText(payload));
  }

  const payload = await postJson(`${config.baseUrl}/api/generate`, {
    model: config.model,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 }
  }, {}, config.timeoutMs);
  return parseJsonText(payload.response || '');
}

function buildAnswerGenerationPrompt(queryCase = {}, candidates = [], options = {}) {
  return [
    'You are evaluating a scholarly QA/search system. Generate a concise answer using only the provided paper contexts.',
    'Return strict JSON with this shape:',
    '{"answer":"...","citations":[{"rank":1,"id":"...","title":"...","claim":"..."}],"verdict":"supported|refuted|insufficient","relations":[{"source":"...","target":"...","type":"...","evidence":"...","paperId":"..."}]}',
    '',
    `Task type: ${queryCase.metadata?.taskType || 'scholarly_task'}`,
    `Question or claim: ${queryCase.query}`,
    `Expected output hint: ${options.expectedOutputHint || 'answer the user query and cite supporting papers'}`,
    `Rubric hints: ${JSON.stringify(getReferenceRubrics(queryCase).map((item) => item.criterion).slice(0, 12))}`,
    '',
    'Paper contexts:',
    JSON.stringify(normalizeCandidateContext(candidates, options.maxTaskContext || DEFAULT_TASK_CONTEXT_LIMIT), null, 2)
  ].join('\n');
}

function buildJudgePrompt(queryCase = {}, systemAnswer = {}, candidates = [], options = {}) {
  return [
    'You are a strict benchmark judge for scholarly QA, citation grounding, claim verification, and relation reasoning.',
    'Return strict JSON only with numeric scores in [0,1]:',
    '{"answerCorrectness":0,"answerGroundedness":0,"citationFaithfulness":0,"claimLabel":"supported|refuted|insufficient","claimLabels":[],"relationReasoning":0,"scinetPathRationality":0,"taskSuccess":0,"rationale":"..."}',
    '',
    `Question or claim: ${queryCase.query}`,
    `Task type: ${queryCase.metadata?.taskType || 'scholarly_task'}`,
    `Reference answers: ${JSON.stringify(getReferenceAnswers(queryCase))}`,
    `Reference rubrics and evidence: ${JSON.stringify(getReferenceRubrics(queryCase))}`,
    `Expected claim label: ${getExpectedLabel(queryCase) || ''}`,
    `Expected claim labels: ${JSON.stringify(getExpectedLabels(queryCase))}`,
    `Gold relations: ${JSON.stringify(asArray(queryCase.goldRelations))}`,
    '',
    `System answer: ${JSON.stringify(systemAnswer)}`,
    '',
    'Retrieved paper contexts:',
    JSON.stringify(normalizeCandidateContext(candidates, options.maxTaskContext || DEFAULT_TASK_CONTEXT_LIMIT), null, 2)
  ].join('\n');
}

async function maybeGenerateAnswer(queryCase = {}, candidates = [], options = {}) {
  const existing = getSystemAnswer(queryCase);
  if (existing?.answer || existing?.verdict || existing?.relations?.length) return existing;
  if (typeof options.answerGenerator === 'function') return options.answerGenerator(queryCase, candidates, options);
  if (options.generateTaskAnswers !== true && options.generate_task_answers !== true) return null;
  const raw = await callBenchmarkLlmJson(buildAnswerGenerationPrompt(queryCase, candidates, options), options);
  return {
    answer: compactText(raw.answer),
    verdict: compactText(raw.verdict),
    citations: asArray(raw.citations).map((entry, index) => normalizePaper({
      ...entry,
      ...(entry.rank ? candidates[Number(entry.rank) - 1] || {} : {})
    }, `generated:citation:${index}`)),
    citationRanks: asArray(raw.citations).map((entry) => entry.rank).filter(Boolean),
    relations: normalizeRelations(raw.relations),
    raw
  };
}

function hasTaskTargets(queryCase = {}) {
  return Boolean(
    getReferenceAnswers(queryCase).length
    || getReferenceRubrics(queryCase).length
    || getExpectedStructuredAnswer(queryCase)
    || getExpectedLabel(queryCase)
    || getExpectedLabels(queryCase).length
    || asArray(queryCase.goldRelations).length
    || (isSciNetEgoCase(queryCase) && asArray(queryCase.relevant).length)
    || getSystemAnswer(queryCase)
  );
}

function availableScoreAverage(metrics = {}) {
  const values = TASK_SCORE_KEYS
    .filter((key) => key !== 'task_score')
    .map((key) => metrics[key])
    .filter((value) => Number.isFinite(Number(value)));
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null;
}

export async function evaluateBenchmarkTaskCase(queryCase = {}, candidates = [], options = {}) {
  const mode = normalizeTaskEvaluationMode(options.taskEvaluation || options.task_evaluation);
  if (mode === 'off' || !hasTaskTargets(queryCase)) return null;

  const goldPapers = asArray(queryCase.goldCitationPapers || queryCase.relevant).map((entry, index) => normalizePaper(entry, `gold:${index}`));
  const systemAnswer = await maybeGenerateAnswer(queryCase, candidates, options);
  const referenceAnswers = getReferenceAnswers(queryCase);
  const expectedStructuredAnswer = getExpectedStructuredAnswer(queryCase);
  const goldRelations = normalizeRelations(queryCase.goldRelations);
  const metrics = {};
  const diagnostics = {
    mode,
    llmCalls: 0,
    generatedAnswer: Boolean(systemAnswer && !getSystemAnswer(queryCase)),
    referenceRubricCount: getReferenceRubrics(queryCase).length
  };

  if (isSciNetEgoCase(queryCase)) {
    const egoRecall = computeCandidatePaperRecall(candidates, goldPapers);
    if (egoRecall !== null) metrics.scinet_ego_success = egoRecall;
  }

  if (systemAnswer) {
    Object.assign(metrics, computeCitationMetrics(systemAnswer, candidates, goldPapers));
    const predictedRelations = normalizeRelations(systemAnswer.relations);
    Object.assign(metrics, computeRelationMetrics(predictedRelations, goldRelations));
    const coverage = tokenCoverage(systemAnswer.answer || '', referenceAnswers);
    if (referenceAnswers.length) metrics.answer_correctness = coverage;
    const exactMatch = answerExactMatch(systemAnswer.answer || '', referenceAnswers);
    if (exactMatch !== null) {
      metrics.answer_exact_match = exactMatch;
      if (isContentExtractionCase(queryCase)) metrics.content_extraction_accuracy = exactMatch;
    }
    const structuredAccuracy = computeStructuredAnswerAccuracy(systemAnswer, expectedStructuredAnswer);
    if (structuredAccuracy !== null) metrics.content_extraction_accuracy = structuredAccuracy;
    const expectedLabel = getExpectedLabel(queryCase);
    const predictedLabel = normalizeLabel(systemAnswer.verdict || systemAnswer.label || systemAnswer.claimLabel);
    if (expectedLabel && predictedLabel) metrics.claim_accuracy = expectedLabel === predictedLabel ? 1 : 0;
    const multiClaimAccuracy = computeClaimAccuracy(
      getExpectedLabels(queryCase),
      asArray(systemAnswer.labels).map(normalizeLabel).filter(Boolean)
    );
    if (multiClaimAccuracy !== null) metrics.claim_accuracy = multiClaimAccuracy;
    if (isSciNetPairCase(queryCase) && Number.isFinite(Number(metrics.relation_f1))) {
      metrics.scinet_pair_cite_acc = metrics.relation_f1;
      metrics.scinet_pair_cite_sentiment = metrics.relation_f1;
      if (taskHintText(queryCase).includes('comention') || taskHintText(queryCase).includes('co_mention')) {
        metrics.scinet_pair_comention_acc = metrics.relation_f1;
      }
    }
    if (isSciNetPathCase(queryCase) && Number.isFinite(Number(metrics.relation_f1))) {
      metrics.scinet_path_consistency = metrics.relation_f1;
      const connectivity = computePathConnectivity(predictedRelations, goldRelations);
      if (connectivity !== null) metrics.scinet_path_connectivity = connectivity;
    }
  }

  if (mode === 'llm') {
    const answerForJudge = systemAnswer || { answer: '', citations: [], relations: [] };
    const rawJudge = typeof options.taskJudge === 'function'
      ? await options.taskJudge(queryCase, answerForJudge, candidates, options)
      : await callBenchmarkLlmJson(buildJudgePrompt(queryCase, answerForJudge, candidates, options), options);
    diagnostics.llmCalls += typeof options.taskJudge === 'function' ? 0 : 1;
    metrics.answer_correctness = clamp01(rawJudge.answerCorrectness ?? rawJudge.answer_correctness, metrics.answer_correctness ?? 0);
    metrics.answer_groundedness = clamp01(rawJudge.answerGroundedness ?? rawJudge.answer_groundedness, metrics.answer_groundedness ?? 0);
    metrics.citation_faithfulness = clamp01(rawJudge.citationFaithfulness ?? rawJudge.citation_faithfulness, metrics.citation_faithfulness ?? 0);
    metrics.relation_reasoning = clamp01(rawJudge.relationReasoning ?? rawJudge.relation_reasoning, metrics.relation_reasoning ?? 0);
    metrics.task_success = clamp01(rawJudge.taskSuccess ?? rawJudge.task_success, metrics.task_success ?? 0);
    if (isSciNetPathCase(queryCase)) {
      metrics.scinet_path_rationality = clamp01(
        rawJudge.scinetPathRationality
          ?? rawJudge.scinet_path_rationality
          ?? rawJudge.rationality
          ?? rawJudge.rationality_llm,
        metrics.relation_reasoning ?? 0
      );
    }
    const expectedLabel = getExpectedLabel(queryCase);
    const judgedLabel = normalizeLabel(rawJudge.claimLabel || rawJudge.claim_label);
    if (expectedLabel && judgedLabel) metrics.claim_accuracy = expectedLabel === judgedLabel ? 1 : 0;
    const judgedMultiClaimAccuracy = computeClaimAccuracy(
      getExpectedLabels(queryCase),
      asArray(rawJudge.claimLabels || rawJudge.claim_labels).map(normalizeLabel).filter(Boolean)
    );
    if (judgedMultiClaimAccuracy !== null) metrics.claim_accuracy = judgedMultiClaimAccuracy;
    diagnostics.judge = {
      rationale: compactText(rawJudge.rationale || rawJudge.reason || ''),
      claimLabel: judgedLabel || null
    };
  }

  const successRate = deriveSuccessRate(metrics, queryCase);
  if (successRate !== null && metrics.task_success === undefined) metrics.task_success = successRate;
  if (isPaperAskCase(queryCase) && successRate !== null) {
    metrics.paperask_success_rate = successRate;
    metrics.paperask_failure_rate = 1 - successRate;
  }

  const average = availableScoreAverage(metrics);
  if (average !== null) metrics.task_score = average;

  return {
    queryId: queryCase.id,
    taskType: queryCase.metadata?.taskType || null,
    metrics,
    systemAnswer: systemAnswer ? {
      answer: truncate(systemAnswer.answer || '', 800),
      verdict: systemAnswer.verdict || '',
      citations: extractAnswerCitationPapers(systemAnswer, candidates).map((paper) => ({
        id: paper.id || '',
        canonicalId: paper.canonicalId || '',
        title: paper.title || ''
      })),
      relations: normalizeRelations(systemAnswer.relations)
    } : null,
    diagnostics
  };
}

export function aggregateTaskEvaluationMetrics(results = []) {
  const evaluations = results.map((result) => result.taskEvaluation).filter(Boolean);
  const keys = unique(evaluations.flatMap((evaluation) => Object.keys(evaluation.metrics || {}))).sort();
  const metrics = {};
  for (const key of keys) {
    const values = evaluations
      .map((evaluation) => Number(evaluation.metrics?.[key]))
      .filter((value) => Number.isFinite(value));
    metrics[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }
  return {
    evaluatedQueries: evaluations.length,
    metrics
  };
}

export function hasBenchmarkTaskTargets(queryCase = {}) {
  return hasTaskTargets(queryCase);
}
