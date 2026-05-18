import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ensureDir, fileExists, readJson, writeJson, writeText } from '../../lib/fs.js';
import { resolveOpenAlexApiKey } from '../../lib/api-keys.js';
import { createPaperIdentity, normalizePaperIdentifiers, paperIdentifiersOverlap } from '../../lib/paper-identifiers.js';
import {
  STOPWORDS,
  jaccardSimilarity,
  normalizeText,
  slugify,
  stableHash,
  toNumber,
  tokenizeWithoutStopwords,
  truncate,
  unique
} from '../../lib/utils.js';
import { runLiteratureDiscovery } from '../discovery/workflow.js';
import { readDiscoveryRequestSchedulerState } from '../discovery/request-scheduler.js';
import { getDefaultLlmApiKeyEnv, loadLlmApiKey, resolveLlmConfig } from '../llm/ollama.js';
import {
  aggregateTaskEvaluationMetrics,
  evaluateBenchmarkTaskCase,
  normalizeRelations
} from './task-evaluation.js';

const DEFAULT_CUTOFFS = [1, 5, 10, 20];
const DEFAULT_TITLE_MATCH_THRESHOLD = 0.96;
const DEFAULT_FIXED_CORPUS_LIMIT = 1000;
const DEFAULT_FIXED_CORPUS_SCAN_LIMIT = 50000;
const FIXED_CORPUS_INDEX_CACHE_VERSION = 'fixed-corpus-index-cache-v5';

const BENCHMARK_FORMAT_ALIASES = {
  beir: 'beir',
  scifact: 'beir',
  scidocs: 'beir',
  'trec-covid': 'beir',
  treccovid: 'beir',
  nfcorpus: 'beir',
  litsearch: 'litsearch',
  bioasq: 'bioasq',
  trec: 'trec',
  'trec-biomed': 'trec',
  'trec-cds': 'trec',
  'trec-pm': 'trec',
  sage: 'sage',
  scholarqa: 'scholarqa',
  scholarqabench: 'scholarqa',
  openscholar: 'scholarqa',
  paperask: 'paperask',
  sparbench: 'sparbench',
  spar: 'sparbench',
  scholargym: 'scholargym',
  scholargymbench: 'scholargym',
  'scholargym-bench': 'scholargym',
  scinetbench: 'scinetbench',
  csfcube: 'csfcube',
  custom: 'custom',
  json: 'custom',
  jsonl: 'custom'
};

const BENCHMARK_PROFILES = {
  beir: {
    taskType: 'document_retrieval',
    evaluationStyle: 'fixed_corpus_ir',
    nativeMetrics: ['NDCG@k', 'MAP@k', 'Recall@k', 'Precision@k']
  },
  litsearch: {
    taskType: 'paper_retrieval',
    evaluationStyle: 'scientific_literature_search',
    nativeMetrics: ['Recall@k', 'Precision@k', 'MRR@k', 'NDCG@k']
  },
  bioasq: {
    taskType: 'biomedical_qa_retrieval',
    evaluationStyle: 'document_and_snippet_retrieval',
    nativeMetrics: ['MAP', 'GMAP', 'Recall', 'F1']
  },
  trec: {
    taskType: 'biomedical_literature_retrieval',
    evaluationStyle: 'trec_qrels',
    nativeMetrics: ['trec_eval qrels metrics']
  },
  sage: {
    taskType: 'agentic_literature_retrieval',
    evaluationStyle: 'fixed_corpus_agentic_retrieval',
    nativeMetrics: ['ExactMatch@k', 'WeightedRecall@k']
  },
  scholarqa: {
    taskType: 'citation_grounded_qa_retrieval',
    evaluationStyle: 'qa_citation_grounding',
    nativeMetrics: ['accuracy', 'rouge-l', 'rubrics', 'prometheus', 'citations', 'citations_short']
  },
  paperask: {
    taskType: 'scholarly_assistant_reliability',
    evaluationStyle: 'paper_search_reading_claim_verification',
    nativeMetrics: ['citation_retrieval_success', 'content_extraction_field_accuracy', 'paper_discovery_recall', 'claim_verification_success']
  },
  sparbench: {
    taskType: 'agentic_paper_retrieval',
    evaluationStyle: 'expert_annotated_academic_search',
    nativeMetrics: ['F1', 'Recall', 'Precision']
  },
  scholargym: {
    taskType: 'academic_literature_retrieval',
    evaluationStyle: 'fixed_corpus_academic_search',
    nativeMetrics: ['Recall@k', 'Hit@k', 'MRR@k', 'NDCG@k']
  },
  scinetbench: {
    taskType: 'relation_aware_retrieval',
    evaluationStyle: 'scientific_network_retrieval',
    nativeMetrics: ['novelty/disruption rank', 'novelty/disruption recall', 'novelty/disruption SoS', 'cite accuracy', 'citation sentiment accuracy', 'co-mention accuracy', 'path connectivity', 'path rationality']
  },
  csfcube: {
    taskType: 'faceted_query_by_example',
    evaluationStyle: 'graded_facet_retrieval',
    nativeMetrics: ['NDCG@k', 'MAP@k']
  },
  custom: {
    taskType: 'paper_retrieval',
    evaluationStyle: 'custom_relevance_set',
    nativeMetrics: ['Hit@k', 'Recall@k', 'Precision@k', 'MRR@k', 'MAP@k', 'NDCG@k']
  }
};

function canonicalBenchmarkFormat(value = 'auto') {
  const normalized = String(value || 'auto').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized || normalized === 'auto') return 'auto';
  return BENCHMARK_FORMAT_ALIASES[normalized] || normalized;
}

function benchmarkProfile(format = 'custom') {
  return BENCHMARK_PROFILES[canonicalBenchmarkFormat(format)] || BENCHMARK_PROFILES.custom;
}

function toTokenCounts(tokens = []) {
  const counts = new Map();
  for (const token of tokens || []) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function countTokenInField(tokens = [], target = '') {
  let count = 0;
  for (const token of tokens || []) {
    if (token === target) count += 1;
  }
  return count;
}

function bm25FieldScore(queryTokens = [], docTokens = [], documentFrequency = new Map(), totalDocuments = 0, averageLength = 0, tokenCounts = null, docLength = null) {
  const length = docLength ?? docTokens.length;
  if (!queryTokens.length || !length || !totalDocuments) return 0;
  const uniqueQueryTokens = new Set(queryTokens);
  const k1 = 1.2;
  const b = 0.75;
  const lengthNorm = averageLength > 0 ? (1 - b) + (b * (length / averageLength)) : 1;
  let score = 0;

  for (const token of uniqueQueryTokens) {
    const tf = tokenCounts ? (tokenCounts.get(token) || 0) : countTokenInField(docTokens, token);
    if (!tf) continue;
    const df = documentFrequency.get(token) || 0;
    if (!df) continue;
    const idf = Math.log(1 + ((totalDocuments - df + 0.5) / (df + 0.5)));
    score += idf * ((tf * (k1 + 1)) / (tf + (k1 * lengthNorm)));
  }

  return score;
}

function resolveOptionalNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function summarizeQueryTokenMatches(value = '', queryTokenSet = new Set(), fieldStats = {}) {
  const counts = new Map();
  const matched = new Set();
  const knownLength = resolveOptionalNumber(fieldStats.length);
  const knownUniqueCount = resolveOptionalNumber(fieldStats.uniqueCount);
  const needsUniqueTokens = knownUniqueCount === null;
  const uniqueTokens = needsUniqueTokens ? new Set() : null;
  let length = 0;
  for (const token of normalizeText(value).split(' ')) {
    const normalized = token.trim();
    if (!normalized || normalized.length <= 2 || STOPWORDS.has(normalized)) continue;
    length += 1;
    if (needsUniqueTokens) uniqueTokens.add(normalized);
    if (queryTokenSet.has(normalized)) {
      matched.add(normalized);
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return {
    counts,
    matched,
    uniqueTokens,
    length: knownLength ?? length,
    uniqueCount: knownUniqueCount ?? uniqueTokens.size
  };
}

function scoreMatchedTokenOverlap(queryTokens = [], matchedTokens = new Set()) {
  if (!queryTokens.length || !matchedTokens.size) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (matchedTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.length;
}

function scorePreparedTitleSimilarity(queryTokenSet = new Set(), titleMatch = {}) {
  if (!queryTokenSet.size || !titleMatch.uniqueCount) return 0;
  let intersection = 0;
  for (const token of queryTokenSet) {
    if (titleMatch.matched.has(token)) intersection += 1;
  }
  return intersection / (queryTokenSet.size + titleMatch.uniqueCount - intersection);
}

function combineQueryTokenMatches(left = {}, right = {}, fieldStats = {}) {
  const matched = new Set([
    ...(left.matched ? [...left.matched] : []),
    ...(right.matched ? [...right.matched] : [])
  ]);
  const knownLength = resolveOptionalNumber(fieldStats.length);
  const knownUniqueCount = resolveOptionalNumber(fieldStats.uniqueCount);
  const needsUniqueTokens = knownUniqueCount === null || knownLength === null;
  const uniqueTokens = needsUniqueTokens
    ? new Set([
      ...(left.uniqueTokens ? [...left.uniqueTokens] : []),
      ...(right.uniqueTokens ? [...right.uniqueTokens] : [])
    ])
    : null;
  const derivedUniqueCount = uniqueTokens?.size || matched.size;
  return {
    counts: new Map([...matched].map((token) => [token, 1])),
    matched,
    uniqueTokens,
    length: knownLength ?? derivedUniqueCount,
    uniqueCount: knownUniqueCount ?? derivedUniqueCount
  };
}

function scoreFacetAwareBoost(facet = '', paper = {}) {
  const normalizedFacet = compactText(facet).toLowerCase();
  if (!normalizedFacet) return 0;

  const text = compactText([paper.title, paper.abstract].filter(Boolean).join(' ')).toLowerCase();
  const facetTerms = {
    background: ['problem', 'task', 'domain', 'motivation', 'challenge', 'survey'],
    method: ['method', 'model', 'algorithm', 'architecture', 'approach', 'framework'],
    result: ['result', 'dataset', 'benchmark', 'metric', 'evaluation', 'performance', 'finding']
  }[normalizedFacet] || [normalizedFacet];

  const hits = facetTerms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0);
  return hits ? Math.min(2, hits / Math.max(1, facetTerms.length)) : 0;
}

function normalizeFixedCorpusQueryAnalysisMode(options = {}) {
  const raw = pickFirst(
    options.fixedCorpusQueryAnalysis,
    options.fixed_corpus_query_analysis,
    options.queryAnalysis,
    options.query_analysis,
    'off'
  );
  if (raw === true) return 'heuristic';
  const normalized = String(raw || 'off').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['1', 'true', 'yes', 'on', 'heuristic', 'rules'].includes(normalized)) return 'heuristic';
  if (['llm', 'internal-llm', 'llm-assisted'].includes(normalized)) return 'llm';
  return 'off';
}

function fixedCorpusQueryAnalysisTermsForQuery(query = '') {
  const normalized = ` ${normalizeText(query)} `;
  const groups = [];
  const maybeAdd = (patterns, category, terms) => {
    if (patterns.some((pattern) => pattern.test(normalized))) {
      groups.push({ category, terms });
    }
  };

  maybeAdd([
    /\bchallenge(s)?\b/,
    /\blimitation(s)?\b/,
    /\bfailure mode(s)?\b/,
    /\bopen problem(s)?\b/,
    /\bissue(s)?\b/,
    /\bbarrier(s)?\b/
  ], 'challenge', [
    'challenge', 'limitation', 'limitations', 'failure', 'failure modes',
    'open problems', 'problem', 'robustness', 'risk', 'bottleneck'
  ]);
  maybeAdd([
    /\bextension(s)?\b/,
    /\bextend(s|ed|ing)?\b/,
    /\bimprovement(s)?\b/,
    /\benhancement(s)?\b/,
    /\bvariant(s)?\b/
  ], 'extension', [
    'extension', 'improvement', 'enhancement', 'variant', 'adaptation',
    'generalization', 'transfer', 'scaling', 'scalable'
  ]);
  maybeAdd([
    /\bapplication(s)?\b/,
    /\bapplied\b/,
    /\bdeployment(s)?\b/,
    /\bcase stud(y|ies)\b/,
    /\breal world\b/
  ], 'application', [
    'application', 'applied', 'deployment', 'domain', 'case study',
    'real-world', 'practical', 'use case'
  ]);
  maybeAdd([
    /\bbenchmark(s)?\b/,
    /\bevaluation(s)?\b/,
    /\bmetric(s)?\b/,
    /\bdataset(s)?\b/
  ], 'evaluation', [
    'benchmark', 'evaluation', 'metric', 'dataset', 'comparison',
    'empirical', 'performance'
  ]);
  maybeAdd([
    /\bsurvey(s)?\b/,
    /\breview(s)?\b/,
    /\btaxonom(y|ies)\b/,
    /\boverview(s)?\b/
  ], 'survey', [
    'survey', 'review', 'taxonomy', 'overview', 'systematic',
    'comparative'
  ]);
  maybeAdd([
    /\bdomain shift\b/,
    /\bdistribution shift\b/,
    /\bout-of-distribution\b/,
    /\bood\b/
  ], 'domain_shift', [
    'domain shift', 'distribution shift', 'out-of-distribution',
    'ood', 'generalization', 'adaptation', 'transfer', 'robustness'
  ]);
  maybeAdd([
    /\blarge language model(s)?\b/,
    /\bllm(s)?\b/,
    /\bfoundation model(s)?\b/
  ], 'llm', [
    'large language model', 'llm', 'foundation model', 'generative',
    'instruction tuning', 'reasoning', 'agent'
  ]);
  maybeAdd([
    /\bretrieval augmented\b/,
    /\brag\b/,
    /\binformation retrieval\b/
  ], 'retrieval', [
    'retrieval', 'search', 'indexing', 'ranking', 'reranking',
    'query expansion', 'evidence'
  ]);

  return groups;
}

function normalizeQueryAnalysisTermList(values = []) {
  return unique(asArray(values)
    .flatMap((value) => {
      if (typeof value === 'string') return [value];
      const entry = asObject(value);
      return [
        entry.term,
        entry.text,
        entry.phrase,
        entry.label,
        entry.value
      ];
    })
    .map(compactText)
    .filter(Boolean));
}

function tokensForQueryAnalysisTerms(values = []) {
  return unique(normalizeQueryAnalysisTermList(values).flatMap((value) => tokenizeWithoutStopwords(value)));
}

function normalizeFixedCorpusQueryAnalysisPayload(payload = {}, queryCase = {}, mode = 'heuristic', source = 'heuristic', error = null) {
  const originalTokens = tokenizeWithoutStopwords(queryCase.query);
  const negativeTerms = normalizeQueryAnalysisTermList(payload.negativeTerms || payload.negative_terms);
  const negativeTokenSet = new Set(tokensForQueryAnalysisTerms(negativeTerms));
  const coreConcepts = normalizeQueryAnalysisTermList(payload.coreConcepts || payload.core_concepts);
  const facetTerms = normalizeQueryAnalysisTermList(payload.facetTerms || payload.facet_terms);
  const synonyms = normalizeQueryAnalysisTermList(payload.synonyms);
  const relatedTerms = normalizeQueryAnalysisTermList(payload.relatedTerms || payload.related_terms);
  const expansionTokens = tokensForQueryAnalysisTerms([
    ...coreConcepts,
    ...facetTerms,
    ...synonyms,
    ...relatedTerms
  ]).filter((token) => !negativeTokenSet.has(token));
  const originalTokenSet = new Set(originalTokens);
  const expandedTokens = unique([...originalTokens, ...expansionTokens]);
  const addedTokens = expandedTokens.filter((token) => !originalTokenSet.has(token));

  return {
    enabled: true,
    mode,
    source,
    coreConcepts,
    facetTerms,
    synonyms,
    relatedTerms,
    negativeTerms,
    originalTokenCount: originalTokens.length,
    expandedTokenCount: expandedTokens.length,
    addedTokenCount: addedTokens.length,
    addedTokens: addedTokens.slice(0, 50),
    queryTokens: expandedTokens,
    error: error ? truncate(error, 300) : null
  };
}

function buildHeuristicFixedCorpusQueryAnalysis(queryCase = {}) {
  const groups = fixedCorpusQueryAnalysisTermsForQuery(queryCase.query);
  const facetTerms = groups.flatMap((group) => group.terms);
  return normalizeFixedCorpusQueryAnalysisPayload({
    coreConcepts: tokenizeWithoutStopwords(queryCase.query).slice(0, 12),
    facetTerms,
    relatedTerms: groups.map((group) => group.category),
    negativeTerms: ['paper', 'papers', 'study', 'studies', 'studying', 'research', 'researching']
  }, queryCase, 'heuristic', 'heuristic');
}

function parseJsonText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`Expected JSON object, received: ${truncate(raw, 180)}`);
  }
}

function extractOpenAiText(payload = {}) {
  const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? '';
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return String(content || '');
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
      throw new Error(`Query-analysis LLM request failed (${response.status}): ${truncate(text, 300)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildFixedCorpusQueryAnalysisPrompt(queryCase = {}) {
  return [
    'You are helping an academic literature retrieval system analyze a natural-language query before lexical fixed-corpus search.',
    'Return strict JSON with this shape:',
    '{"coreConcepts":["..."],"facetTerms":["..."],"synonyms":["..."],"relatedTerms":["..."],"negativeTerms":["..."]}',
    'Use short scientific search phrases. Expand intent words such as challenges, limitations, extensions, applications, benchmarks, and surveys into title/abstract terms that relevant papers may use.',
    'Do not include paper, papers, study, studies, research, or researching unless they are part of a specific concept.',
    '',
    `Query: ${queryCase.query || ''}`,
    `Task type: ${queryCase.metadata?.taskType || queryCase.metadata?.benchmarkFormat || 'academic_literature_retrieval'}`
  ].join('\n');
}

async function callFixedCorpusQueryAnalysisLlm(queryCase = {}, options = {}) {
  const prompt = buildFixedCorpusQueryAnalysisPrompt(queryCase);
  if (typeof options.fixedCorpusQueryAnalyzer === 'function') {
    return options.fixedCorpusQueryAnalyzer({ queryCase, prompt, options });
  }
  if (typeof options.fixed_corpus_query_analyzer === 'function') {
    return options.fixed_corpus_query_analyzer({ queryCase, prompt, options });
  }
  if (typeof options.llmJson === 'function') {
    return options.llmJson(prompt, {
      ...options,
      task: 'fixed_corpus_query_analysis',
      queryCase
    });
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    throw new Error('Fixed-corpus query analysis requires an LLM model or a fixedCorpusQueryAnalyzer hook.');
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for fixed-corpus query analysis. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/chat/completions`, {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: config.maxTokens || 800
    }, {
      authorization: `Bearer ${apiKey}`
    }, config.timeoutMs);
    return parseJsonText(extractOpenAiText(payload));
  }

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for fixed-corpus query analysis. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/messages`, {
      model: config.model,
      max_tokens: config.maxTokens || 800,
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

async function buildFixedCorpusQueryAnalysis(queryCase = {}, options = {}) {
  const mode = normalizeFixedCorpusQueryAnalysisMode(options);
  if (mode === 'off') {
    const queryTokens = tokenizeWithoutStopwords(queryCase.query);
    return {
      enabled: false,
      mode: 'off',
      source: 'off',
      originalTokenCount: queryTokens.length,
      expandedTokenCount: queryTokens.length,
      addedTokenCount: 0,
      addedTokens: [],
      queryTokens,
      error: null
    };
  }

  if (mode === 'heuristic') {
    return buildHeuristicFixedCorpusQueryAnalysis(queryCase);
  }

  try {
    const payload = await callFixedCorpusQueryAnalysisLlm(queryCase, options);
    return normalizeFixedCorpusQueryAnalysisPayload(payload, queryCase, 'llm', 'llm');
  } catch (error) {
    const fallback = buildHeuristicFixedCorpusQueryAnalysis(queryCase);
    return {
      ...fallback,
      mode: 'llm',
      source: 'heuristic-fallback',
      error: error?.message || String(error)
    };
  }
}

function scoreFixedCorpusQueryAnalysisBoost(queryAnalysis = {}, titleMatch = {}, abstractMatch = {}) {
  if (!queryAnalysis?.enabled || !queryAnalysis.addedTokens?.length) return 0;
  let titleHits = 0;
  let abstractHits = 0;
  for (const token of queryAnalysis.addedTokens) {
    if (titleMatch.matched?.has(token)) titleHits += 1;
    if (abstractMatch.matched?.has(token)) abstractHits += 1;
  }
  return Math.min(3, (titleHits * 0.75) + (abstractHits * 0.3));
}

function inferTaskType(format = 'custom', entry = {}, fallback = '') {
  const explicit = compactText(pickFirst(
    fallback,
    entry.taskType,
    entry.task_type,
    entry.task,
    entry.subtask
  ));
  if (explicit) return explicit;

  const normalizedFormat = canonicalBenchmarkFormat(format);
  const queryText = compactText(pickFirst(entry.query, entry.question, entry.input, entry.prompt, entry.claim)).toLowerCase();
  const sourceHint = compactText(pickFirst(entry.__sourceFile, entry.sourceFile, entry.source_file, entry.filePath, entry.file_path)).toLowerCase();
  const taskHint = `${queryText} ${sourceHint}`;
  if (normalizedFormat === 'sage') {
    const groundTruth = asObject(entry.groundTruth || entry.ground_truth);
    if (entry.complete_query || entry.completeQuery || sourceHint.includes('sage_short_form_questions')) return 'short_form_paper_finding';
    if (groundTruth.most_relevant || groundTruth.mostRelevant || sourceHint.includes('sage_open_ended_questions')) return 'open_ended_paper_recommendation';
  }
  if (normalizedFormat === 'paperask') {
    if (Array.isArray(entry.fields_tested) || (entry.ground_truth && typeof entry.ground_truth === 'object') || taskHint.includes('content_extraction')) return 'content_extraction';
    if (Array.isArray(entry.papers) || taskHint.includes('citation_retrieval') || queryText.includes('bibtex')) return 'citation_retrieval';
    if (entry.paper_url || entry.paperUrl || taskHint.includes('open_book_cf') || queryText.includes('fact-check') || queryText.includes('verify the claims')) return 'claim_verification';
    if (Array.isArray(entry.ground_truth_papers) || taskHint.includes('open_domain_qa') || queryText.includes('published paper')) return 'paper_discovery';
  }
  if (normalizedFormat === 'scinetbench') {
    if (taskHint.includes('task3') || queryText.includes('citation path') || queryText.includes('evolutionary') || queryText.includes('lineage')) return 'path-wise evolutionary analysis';
    if (taskHint.includes('cooccur') || queryText.includes('co-occur') || queryText.includes('co-mention')) return 'pair-wise co-mention retrieval';
    if (taskHint.includes('pncites') || taskHint.includes('sentiment') || queryText.includes('positively cite') || queryText.includes('negatively cite') || queryText.includes('cite the paper')) return 'pair-wise citation sentiment';
    if (taskHint.includes('task1') || taskHint.includes('novel') || taskHint.includes('disruptive') || queryText.includes('most novel') || queryText.includes('most disruptive')) return 'ego-centric relation retrieval';
  }
  return benchmarkProfile(format).taskType;
}

function normalizeEvaluationMode(value = '') {
  const normalized = String(value || 'live').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'fixed' || normalized === 'fixed-corpus' || normalized === 'corpus') return 'fixed-corpus';
  if (normalized === 'live' || normalized === 'discovery' || normalized === 'providers') return 'live';
  return normalized || 'live';
}

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

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function normalizeIdentifierAliases(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized.includes(':')) return {};
  const [kind, ...rest] = normalized.split(':');
  const id = rest.join(':').trim();
  const key = kind.trim().toLowerCase();
  if (key === 'arxiv') return { arxivId: id };
  if (key === 'doi') return { doi: id };
  if (key === 'pmid' || key === 'pubmed') return { pmid: id };
  if (key === 'pmcid') return { pmcid: id };
  return {};
}

function extractIdentifiersFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return {};
  const identifiers = {};
  const doiMatch = text.match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  const arxivMatch = text.match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)([a-z.-]+\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  const pmidMatch = text.match(/(?:pubmed\/|pmid[:/\s]+)(\d+)/i);
  const pmcidMatch = text.match(/(?:pmc\/articles\/|pmcid[:/\s]+|\/)(PMC\d+)/i);
  if (doiMatch) identifiers.doi = doiMatch[0].replace(/[),.;]+$/, '');
  if (arxivMatch) identifiers.arxivId = arxivMatch[1];
  if (pmidMatch) identifiers.pmid = pmidMatch[1];
  if (pmcidMatch) identifiers.pmcid = pmcidMatch[1];
  if (/^\d{6,9}$/.test(text)) identifiers.pmid = text;
  if (/^PMC\d+$/i.test(text)) identifiers.pmcid = text;
  return identifiers;
}

function normalizePaperRecord(value, fallbackId = '') {
  const raw = typeof value === 'string' ? { id: value, title: value } : asObject(value);
  const stringUrl = typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
  const sourceId = compactText(pickFirst(
    raw.id,
    raw._id,
    raw.docId,
    raw.doc_id,
    raw.documentId,
    raw.document_id,
    raw.corpusid,
    raw.corpusId,
    raw.paperId,
    raw.paperID,
    raw.paperid,
    raw.paper_id,
    raw.s2PaperId,
    raw.s2_paper_id,
    raw.semanticScholarId,
    raw.semantic_scholar_id,
    raw.arxivId,
    raw.arxiv_id,
    raw.doi,
    raw.pmid,
    raw.pubmedId,
    raw.url,
    raw.uri,
    fallbackId
  ));
  const canonicalIdInput = compactText(pickFirst(raw.canonicalId, raw.canonical_id));
  const title = compactText(pickFirst(
    raw.title,
    raw.paperTitle,
    raw.paper_title,
    raw.name,
    raw.display_name
  ));
  const identifiers = normalizePaperIdentifiers({
    ...normalizeIdentifierAliases(canonicalIdInput),
    ...extractIdentifiersFromText(sourceId),
    ...extractIdentifiersFromText(canonicalIdInput),
    ...extractIdentifiersFromText(raw.url || raw.uri || raw.sourceUrl || raw.source_url),
    ...asObject(raw.identifiers),
    ...raw
  });
  const identity = createPaperIdentity({
    identifiers,
    title,
    normalizedTitle: raw.normalizedTitle || raw.normalized_title
  });

  return {
    id: sourceId || identity.canonicalId || identity.titleSignature || stableHash(title || JSON.stringify(raw), 16),
    title,
    abstract: compactText(pickFirst(raw.abstract, raw.text, raw.summary)),
    relevance: toNumber(pickFirst(raw.relevance, raw.score, raw.grade), 1),
    identifiers,
    sourceUrl: compactText(pickFirst(raw.url, raw.uri, raw.sourceUrl, raw.source_url, stringUrl)),
    ...identity
  };
}

async function readJsonl(filePath) {
  const entries = [];
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  let lineNumber = 0;

  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${lineNumber}: ${error.message}`);
    }
  }

  return entries;
}

async function tryReadJsonl(filePath) {
  if (!filePath || !(await fileExists(filePath))) return [];
  return readJsonl(filePath);
}

async function appendJsonl(filePath, entry = {}) {
  if (!filePath) return;
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function benchmarkQueryKey(queryCase = {}, index = 0) {
  return compactText(pickFirst(
    queryCase.id,
    queryCase.queryId,
    queryCase.query_id,
    queryCase.query,
    `query-${index + 1}`
  ));
}

function resolveBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function resolveBenchmarkRunId(params = {}, benchmark = {}) {
  const explicit = compactText(pickFirst(
    params.runId,
    params.run_id,
    params.benchmarkRunId,
    params.benchmark_run_id
  ));
  if (explicit) return slugify(explicit);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${slugify(benchmark.name || benchmark.format || 'retrieval-benchmark')}`;
}

function summarizeBenchmarkMachine() {
  return {
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pid: process.pid
  };
}

function createRetrievalBenchmarkArtifactPaths(outputDir, runId) {
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const runDir = path.join(absoluteOutputDir, runId);
  return {
    runDir,
    runId,
    manifestPath: path.join(runDir, 'run-manifest.json'),
    queriesPath: path.join(runDir, 'queries.jsonl'),
    perQueryResultsPath: path.join(runDir, 'per-query-results.jsonl'),
    failuresPath: path.join(runDir, 'failures.jsonl'),
    checkpointPath: path.join(runDir, 'checkpoint.json'),
    timePath: path.join(runDir, 'time.txt'),
    jsonPath: path.join(runDir, 'report.json'),
    markdownPath: path.join(runDir, 'report.md')
  };
}

async function resetRetrievalBenchmarkRunArtifacts(artifacts = {}) {
  for (const filePath of [
    artifacts.perQueryResultsPath,
    artifacts.failuresPath,
    artifacts.checkpointPath,
    artifacts.timePath,
    artifacts.jsonPath,
    artifacts.markdownPath
  ]) {
    if (filePath) await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

async function prepareRetrievalBenchmarkArtifacts(params = {}, benchmark = {}, selectedQueries = [], startedAt = new Date().toISOString()) {
  if (!params.outputDir) return null;
  const runId = resolveBenchmarkRunId(params, benchmark);
  const artifacts = createRetrievalBenchmarkArtifactPaths(params.outputDir, runId);
  const resume = resolveBooleanOption(pickFirst(params.resume, params.continue, params.benchmarkResume, params.benchmark_resume), false);
  await ensureDir(artifacts.runDir);
  if (!resume) await resetRetrievalBenchmarkRunArtifacts(artifacts);

  const manifest = {
    contractVersion: 'retrieval-benchmark-run-v1',
    runId,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    datasetPath: params.datasetPath ? path.resolve(process.cwd(), params.datasetPath) : null,
    benchmark: {
      name: benchmark.name || null,
      format: benchmark.format || null,
      queryCount: selectedQueries.length,
      corpusSize: benchmark.corpusSize || asArray(benchmark.corpus).length || 0
    },
    config: {
      evaluationMode: normalizeEvaluationMode(params.evaluationMode || params.evaluation_mode || params.mode),
      cutoffs: normalizeCutoffs(params.cutoffs || params.k),
      benchmarkConcurrency: params.benchmarkConcurrency || params.concurrency || 1,
      fixedCorpusScanLimit: params.fixedCorpusScanLimit || params.fixed_corpus_scan_limit || null
    },
    machine: summarizeBenchmarkMachine()
  };

  await writeJson(artifacts.manifestPath, manifest);
  await writeText(
    artifacts.queriesPath,
    `${selectedQueries.map((queryCase, index) => JSON.stringify({
      queryKey: benchmarkQueryKey(queryCase, index),
      id: queryCase.id || null,
      query: queryCase.query || '',
      relevantCount: asArray(queryCase.relevant).length,
      metadata: queryCase.metadata || {}
    })).join('\n')}\n`
  );

  return {
    runId,
    resume,
    artifacts,
    manifest
  };
}

async function readCompletedRetrievalBenchmarkResults(artifactRun = null) {
  if (!artifactRun?.resume) return new Map();
  const rows = await tryReadJsonl(artifactRun.artifacts.perQueryResultsPath);
  const completed = new Map();
  for (const row of rows) {
    const status = String(row.status || 'completed').toLowerCase();
    const key = compactText(row.queryKey || row.id);
    if (!key || status !== 'completed') continue;
    completed.set(key, row);
  }
  return completed;
}

async function writeRetrievalBenchmarkCheckpoint(artifactRun = null, checkpoint = {}) {
  if (!artifactRun?.artifacts?.checkpointPath) return null;
  const payload = {
    contractVersion: 'retrieval-benchmark-checkpoint-v1',
    runId: artifactRun.runId,
    updatedAt: new Date().toISOString(),
    ...checkpoint
  };
  await writeJson(artifactRun.artifacts.checkpointPath, payload);
  return payload;
}

async function finalizeRetrievalBenchmarkArtifacts(artifactRun = null, report = {}) {
  if (!artifactRun?.artifacts) return null;
  const endedAt = report.generatedAt || new Date().toISOString();
  await writeJson(artifactRun.artifacts.manifestPath, {
    ...(artifactRun.manifest || {}),
    status: report.status || 'completed',
    updatedAt: endedAt,
    completedAt: endedAt,
    reportPath: artifactRun.artifacts.jsonPath
  });
  await writeText(artifactRun.artifacts.timePath, [
    `startedAt=${report.startedAt || ''}`,
    `endedAt=${endedAt}`,
    `durationMs=${report.durationMs || 0}`,
    `status=${report.status || 'completed'}`,
    `completedQueries=${report.diagnostics?.evaluatedQueries || 0}`,
    `failedQueries=${report.diagnostics?.failedQueries || 0}`
  ].join('\n') + '\n');
  return writeRetrievalBenchmarkCheckpoint(artifactRun, {
    status: report.status || 'completed',
    completedQueries: report.diagnostics?.evaluatedQueries || 0,
    failedQueries: report.diagnostics?.failedQueries || 0,
    totalQueries: report.benchmark?.evaluatedQueries || 0,
    reportPath: artifactRun.artifacts.jsonPath
  });
}

async function readJsonOrJsonl(filePath) {
  if (filePath.endsWith('.jsonl') || filePath.endsWith('.ndjson')) {
    return readJsonl(filePath);
  }
  const parsed = await readJson(filePath, null);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.queries)) return parsed.queries;
  if (Array.isArray(parsed?.questions)) return parsed.questions;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;
  const mappedEntries = expandObjectMapEntries(parsed);
  if (mappedEntries) return mappedEntries;
  return parsed ? [parsed] : [];
}

async function findFirstExisting(baseDir, names = []) {
  for (const name of names) {
    const candidate = path.join(baseDir, name);
    if (await fileExists(candidate)) return candidate;
  }
  return '';
}

function looksLikePaperReference(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    const identifiers = extractIdentifiersFromText(value);
    return Boolean(identifiers.doi || identifiers.arxivId || identifiers.pmid || identifiers.pmcid);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(pickFirst(
    value.title,
    value.paperTitle,
    value.paper_title,
    value.doi,
    value.arxivId,
    value.arxiv,
    value.pmid,
    value.pubmedId,
    value.pmcid,
    value.corpusid,
    value.corpusId,
    value.paperId,
    value.paperID,
    value.paperid,
    value.paper_id,
    value.s2PaperId,
    value.s2_paper_id,
    value.semanticScholarId,
    value.semantic_scholar_id,
    value.docId,
    value.doc_id,
    value.url
  ));
}

function paperLikeAnswers(values = []) {
  return values.filter((entry) => looksLikePaperReference(entry));
}

function extractGradedPaperSet(values = [], relevance = 1) {
  return asArray(values)
    .filter((paper) => looksLikePaperReference(paper))
    .map((paper) => ({
      ...(typeof paper === 'object' && !Array.isArray(paper) ? paper : { id: paper, title: paper }),
      relevance: pickFirst(paper?.relevance, paper?.score, paper?.grade, relevance)
    }));
}

function extractSageGroundTruthPapers(entry = {}) {
  const groundTruth = asObject(entry.groundTruth || entry.ground_truth);
  if (!groundTruth.most_relevant && !groundTruth.mostRelevant && !groundTruth.relevant) return [];
  return [
    ...extractGradedPaperSet(groundTruth.most_relevant || groundTruth.mostRelevant, 2),
    ...extractGradedPaperSet(groundTruth.relevant, 1)
  ];
}

function resolveGoldContexts(entry = {}) {
  const ctxs = asArray(entry.ctxs || entry.contexts);
  const byId = new Map(ctxs.map((ctx) => [compactText(ctx?.id), ctx]).filter(([id]) => id));
  return [
    ...asArray(entry.gold_ctx),
    ...asArray(entry.goldCtx),
    ...asArray(entry.gold_context),
    ...asArray(entry.goldContext),
    ...asArray(entry.gold_contexts),
    ...asArray(entry.goldContexts),
    ...asArray(entry.gold_ctxs),
    ...asArray(entry.goldCtxs)
  ].map((ctx) => {
    if (typeof ctx === 'number' && Number.isInteger(ctx)) return ctxs[ctx] || ctxs[ctx - 1] || null;
    if (typeof ctx === 'string' && byId.has(ctx)) return byId.get(ctx);
    return ctx;
  }).filter(Boolean);
}

function hasGoldContextRefs(entry = {}) {
  return [
    entry.gold_ctx,
    entry.goldCtx,
    entry.gold_context,
    entry.goldContext,
    entry.gold_contexts,
    entry.goldContexts,
    entry.gold_ctxs,
    entry.goldCtxs
  ].some((value) => asArray(value).length);
}

function isReferenceOutputEntry(entry = {}) {
  return Boolean(
    entry.output
    && (entry.annotator || entry.subject)
    && !entry.systemAnswer
    && !entry.system_answer
    && !entry.generatedAnswer
    && !entry.generated_answer
    && !entry.predictedAnswer
    && !entry.predicted_answer
    && !entry.prediction
  );
}

function resolveReferenceContexts(entry = {}) {
  if (!isReferenceOutputEntry(entry) || hasGoldContextRefs(entry)) return [];
  return asArray(entry.ctxs || entry.contexts);
}

function extractRelevantInputs(entry = {}) {
  return [
    ...resolveGoldContexts(entry),
    ...resolveReferenceContexts(entry),
    ...asArray(entry.paper),
    ...asArray(entry.papers),
    ...asArray(entry.url),
    ...asArray(entry.sourceUrl),
    ...asArray(entry.source_url),
    ...asArray(entry.paperUrl),
    ...asArray(entry.paper_url),
    ...asArray(entry.paperUrls),
    ...asArray(entry.paper_urls),
    ...asArray(entry.urls),
    ...asArray(entry.relevant),
    ...asArray(entry.relevantPapers),
    ...asArray(entry.relevant_papers),
    ...asArray(entry.relevantDocs),
    ...asArray(entry.relevant_docs),
    ...asArray(entry.relevantDocuments),
    ...asArray(entry.relevant_documents),
    ...asArray(entry.gold),
    ...asArray(entry.goldPapers),
    ...asArray(entry.gold_papers),
    ...asArray(entry.groundTruthPapers),
    ...asArray(entry.ground_truth_papers),
    ...asArray(entry.goldDocs),
    ...asArray(entry.gold_docs),
    ...asArray(entry.goldDocuments),
    ...asArray(entry.gold_documents),
    ...asArray(entry.positivePapers),
    ...asArray(entry.positive_papers),
    ...asArray(entry.positiveDocs),
    ...asArray(entry.positive_docs),
    ...asArray(entry.citations),
    ...asArray(entry.references),
    ...asArray(entry.documents),
    ...asArray(entry.docs),
    ...asArray(entry.evidence),
    ...asArray(entry.evidencePapers),
    ...asArray(entry.evidence_papers),
    ...asArray(entry.supportingPapers),
    ...asArray(entry.supporting_papers),
    ...asArray(entry.supportDocs),
    ...asArray(entry.support_docs),
    ...asArray(entry.targetPapers),
    ...asArray(entry.target_papers),
    ...asArray(entry.pathPapers),
    ...asArray(entry.path_papers),
    ...asArray(entry.inspiringPaper),
    ...asArray(entry.inspiring_paper),
    ...extractSageGroundTruthPapers(entry),
    ...paperLikeAnswers(asArray(entry.answers)),
    ...paperLikeAnswers(asArray(entry.expected)),
    ...paperLikeAnswers(asArray(entry.groundTruth)),
    ...paperLikeAnswers(asArray(entry.ground_truth))
  ];
}

function extractGoldIds(entry = {}) {
  return [
    ...asArray(entry.goldIds),
    ...asArray(entry.gold_ids),
    ...asArray(entry.goldPaperIds),
    ...asArray(entry.gold_paper_ids),
    ...asArray(entry.relevantIds),
    ...asArray(entry.relevant_ids),
    ...asArray(entry.corpusids),
    ...asArray(entry.corpusIds),
    ...asArray(entry.corpus_ids),
    ...asArray(entry.paperIds),
    ...asArray(entry.paper_ids),
    ...asArray(entry.docIds),
    ...asArray(entry.doc_ids),
    ...asArray(entry.documentIds),
    ...asArray(entry.document_ids),
    ...asArray(entry.positiveDocIds),
    ...asArray(entry.positive_doc_ids),
    ...asArray(entry.evidenceIds),
    ...asArray(entry.evidence_ids),
    ...asArray(entry.referenceIds),
    ...asArray(entry.reference_ids),
    ...asArray(entry.citationIds),
    ...asArray(entry.citation_ids)
  ].map((value) => compactText(value)).filter(Boolean);
}

function extractReferenceAnswers(entry = {}) {
  const values = [
    ...asArray(entry.groundTruth).filter((answer) => !looksLikePaperReference(answer)),
    ...asArray(entry.ground_truth).filter((answer) => !looksLikePaperReference(answer)),
    ...asArray(entry.referenceAnswer),
    ...asArray(entry.reference_answer),
    ...asArray(entry.referenceAnswers),
    ...asArray(entry.reference_answers),
    ...asArray(entry.idealAnswer),
    ...asArray(entry.ideal_answer),
    ...asArray(entry.idealAnswers),
    ...asArray(entry.ideal_answers),
    ...asArray(entry.expectedAnswer),
    ...asArray(entry.expected_answer),
    ...asArray(entry.expectedAnswers),
    ...asArray(entry.expected_answers),
    ...asArray(entry.expectedOutput),
    ...asArray(entry.expected_output),
    ...asArray(isReferenceOutputEntry(entry) ? entry.output : []),
    ...asArray(entry.answer),
    ...asArray(entry.answer_txt),
    ...asArray(entry.answers).filter((answer) => !looksLikePaperReference(answer))
  ];
  return values
    .map((value) => (typeof value === 'string' ? value : pickFirst(value?.text, value?.answer, value?.value)))
    .map(compactText)
    .filter(Boolean);
}

function extractReferenceRubrics(entry = {}) {
  const metricConfig = asObject(entry.metric_config?.config || entry.metricConfig?.config || entry.metricConfig || entry.metric_config);
  const ingredients = asObject(entry.ingredients);
  const rubricItems = [
    ...asArray(entry.rubric),
    ...asArray(entry.rubrics),
    ...asArray(entry.criteria),
    ...asArray(entry.referenceRubric),
    ...asArray(entry.reference_rubric),
    ...asArray(metricConfig.other_properties),
    ...asArray(metricConfig.rubric),
    ...asArray(metricConfig.rubrics),
    ...asArray(ingredients.most_important),
    ...asArray(ingredients.nice_to_have)
  ];
  return rubricItems
    .map((item, index) => {
      if (typeof item === 'string') return { name: `rubric_${index + 1}`, criterion: compactText(item), weight: 1, evidence: [] };
      const raw = asObject(item);
      const criterion = compactText(pickFirst(raw.criterion, raw.text, raw.description, raw.name));
      if (!criterion) return null;
      return {
        name: compactText(pickFirst(raw.name, `rubric_${index + 1}`)),
        criterion,
        weight: toNumber(raw.weight, 1),
        evidence: asArray(raw.evidence || raw.snippets || raw.references).map(compactText).filter(Boolean)
      };
    })
    .filter(Boolean);
}

function extractExpectedLabel(entry = {}) {
  const label = compactText(pickFirst(
    entry.expectedLabel,
    entry.expected_label,
    entry.label,
    entry.verdict,
    entry.claimLabel,
    entry.claim_label,
    entry.goldLabel,
    entry.gold_label,
    entry.classification,
    entry.expectedVerdict,
    entry.expected_verdict
  ));
  if (label) return label;
  const groundTruth = [entry.groundTruth, entry.ground_truth]
    .find((value) => typeof value === 'string' && /^(true|false|yes|no|supported|refuted|insufficient|maybe|unknown|not enough information|nei)$/i.test(value.trim()));
  if (groundTruth) return groundTruth;
  const answer = compactText(entry.answer);
  return /^(true|false|yes|no|supported|refuted|insufficient|maybe|unknown|not enough information|nei)$/i.test(answer)
    ? answer
    : '';
}

function isGradedPaperGroundTruth(value = {}) {
  const raw = asObject(value);
  return Boolean(raw.most_relevant || raw.mostRelevant || raw.relevant);
}

function extractExpectedStructuredAnswer(entry = {}) {
  const candidates = [entry.expectedStructuredAnswer, entry.expected_structured_answer, entry.groundTruth, entry.ground_truth]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value) && !isGradedPaperGroundTruth(value));
  return candidates.find((value) => Array.isArray(entry.fields_tested) || !looksLikePaperReference(value)) || null;
}

function extractExpectedLabels(entry = {}) {
  return [
    ...asArray(entry.expectedLabels),
    ...asArray(entry.expected_labels),
    ...asArray(entry.labels),
    ...asArray(entry.verdicts),
    ...asArray(entry.claimLabels),
    ...asArray(entry.claim_labels),
    ...asArray(entry.goldLabels),
    ...asArray(entry.gold_labels),
    ...asArray(entry.expectedVerdicts),
    ...asArray(entry.expected_verdicts)
  ].map(compactText).filter(Boolean);
}

function extractGoldRelations(entry = {}) {
  const directRelations = [
    ...asArray(entry.goldRelations),
    ...asArray(entry.gold_relations),
    ...asArray(entry.expectedRelations),
    ...asArray(entry.expected_relations),
    ...asArray(entry.relations),
    ...asArray(entry.paths),
    ...asArray(entry.paperPath),
    ...asArray(entry.paper_path),
    ...asArray(entry.evolutionPath),
    ...asArray(entry.evolution_path),
    ...asArray(entry.trajectory),
    ...asArray(entry.trajectories),
    ...asArray(entry.goldPaths),
    ...asArray(entry.gold_paths),
    ...asArray(entry.evidencePaths),
    ...asArray(entry.evidence_paths)
  ];
  const pairRelation = pickFirst(
    entry.citationSentiment,
    entry.citation_sentiment,
    entry.citeSentiment,
    entry.cite_sentiment,
    entry.coMention,
    entry.co_mention,
    entry.coMentionLabel,
    entry.co_mention_label,
    entry.relationLabel,
    entry.relation_label
  );
  if (pairRelation) {
    directRelations.push({
      source: pickFirst(entry.sourcePaper, entry.source_paper, entry.sourcePaperId, entry.source_paper_id, entry.source),
      target: pickFirst(entry.targetPaper, entry.target_paper, entry.targetPaperId, entry.target_paper_id, entry.target),
      type: pairRelation,
      evidence: pickFirst(entry.citationContext, entry.citation_context, entry.context, entry.paragraph)
    });
  }
  return normalizeRelations(directRelations);
}

function extractSystemAnswer(entry = {}) {
  const output = isReferenceOutputEntry(entry) ? undefined : entry.output;
  const explicit = pickFirst(
    entry.systemAnswer,
    entry.system_answer,
    entry.generatedAnswer,
    entry.generated_answer,
    entry.predictedAnswer,
    entry.predicted_answer,
    entry.prediction,
    output
  );
  if (explicit && typeof explicit === 'object') return explicit;
  const answer = compactText(explicit);
  const predictedRelations = normalizeRelations([
    ...asArray(entry.predictedRelations),
    ...asArray(entry.predicted_relations),
    ...asArray(entry.predictedPaths),
    ...asArray(entry.predicted_paths)
  ]);
  const predictedLabel = compactText(pickFirst(
    entry.predictedLabel,
    entry.predicted_label,
    entry.predictedVerdict,
    entry.predicted_verdict,
    entry.outputLabel,
    entry.output_label
  ));
  if (!answer && !predictedRelations.length && !predictedLabel) return null;
  return {
    answer,
    verdict: predictedLabel,
    labels: [
      ...asArray(entry.predictedLabels),
      ...asArray(entry.predicted_labels),
      ...asArray(entry.outputLabels),
      ...asArray(entry.output_labels)
    ].map(compactText).filter(Boolean),
    relations: predictedRelations,
    citations: [
      ...asArray(entry.predictedCitations),
      ...asArray(entry.predicted_citations),
      ...asArray(entry.citedPapers),
      ...asArray(entry.cited_papers),
      ...asArray(entry.ctxs),
      ...asArray(entry.contexts)
    ]
  };
}

function hasBenchmarkEntryShape(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Boolean(pickFirst(
    parsed.query,
    parsed.question,
    parsed.input,
    parsed.body,
    parsed.topic,
    parsed.text,
    parsed.claim,
    parsed.prompt,
    parsed.initial_prompt,
    parsed.complete_query,
    parsed.completeQuery,
    parsed.metric_config?.config?.question,
    parsed.metricConfig?.config?.question,
    parsed.problem,
    parsed.userQuery,
    parsed.user_query,
    parsed.searchQuery,
    parsed.search_query
  ));
}

function expandObjectMapEntries(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || hasBenchmarkEntryShape(parsed)) return null;
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  return entries.map(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        ...value,
        id: pickFirst(value.id, value._id, value.qid, value.queryId, value.query_id, value.test_case, value.case_id, key),
        query: pickFirst(value.query, value.question, value.input, value.prompt, value.text, value.title, key)
      };
    }
    return {
      id: key,
      query: compactText(value)
    };
  });
}

function normalizeBenchmarkQuery(entry = {}, index = 0, corpusById = new Map(), options = {}) {
  const id = compactText(pickFirst(
    entry.id,
    entry._id,
    entry.qid,
    entry.queryId,
    entry.query_id,
    entry.test_case,
    entry.case_id,
    entry.caseId,
    entry.paperId,
    entry.paperID,
    entry.paperid,
    entry.paper_id,
    index + 1
  ));
  const query = compactText(pickFirst(
    entry.query,
    entry.question,
    entry.input,
    entry.body,
    entry.topic,
    entry.text,
    entry.claim,
    entry.prompt,
    entry.initial_prompt,
    entry.initialPrompt,
    entry.complete_query,
    entry.completeQuery,
    entry.metric_config?.config?.question,
    entry.metricConfig?.config?.question,
    entry.problem,
    entry.userQuery,
    entry.user_query,
    entry.searchQuery,
    entry.search_query
  ));
  if (!query) return null;

  const directRelevant = extractRelevantInputs(entry).map((paper, relevantIndex) => (
    normalizePaperRecord(paper, `${id}:rel:${relevantIndex}`)
  ));
  const idRelevant = extractGoldIds(entry)
    .map((goldId) => corpusById.get(goldId) || normalizePaperRecord({ id: goldId, title: goldId }))
    .filter(Boolean);
  const relevant = dedupePapers([...directRelevant, ...idRelevant]);
  const format = canonicalBenchmarkFormat(options.format || entry.format || 'custom');
  const taskType = inferTaskType(format, entry, options.taskType);
  const referenceAnswers = extractReferenceAnswers(entry);
  const referenceRubrics = extractReferenceRubrics(entry);
  const expectedLabel = extractExpectedLabel(entry);
  const expectedLabels = extractExpectedLabels(entry);
  const expectedStructuredAnswer = extractExpectedStructuredAnswer(entry);
  const goldRelations = extractGoldRelations(entry);
  const systemAnswer = extractSystemAnswer(entry);

  return {
    id,
    query,
    referenceAnswers,
    referenceRubrics,
    expectedLabel,
    expectedLabels,
    expectedStructuredAnswer,
    goldRelations,
    systemAnswer,
    metadata: {
      benchmarkFormat: format,
      taskType,
      hasTaskEvaluationTarget: Boolean(referenceAnswers.length || referenceRubrics.length || expectedLabel || expectedLabels.length || expectedStructuredAnswer || goldRelations.length || systemAnswer),
      queryType: compactText(pickFirst(entry.queryType, entry.query_type, entry.type, options.queryType)),
      facet: compactText(pickFirst(entry.facet, entry.aspect, entry.section, entry.category)),
      sourcePaperId: compactText(pickFirst(entry.sourcePaperId, entry.source_paper_id, entry.queryPaperId, entry.query_paper_id)),
      relationType: compactText(pickFirst(entry.relationType, entry.relation_type, entry.relation)),
      sourceFile: compactText(entry.__sourceFile || entry.sourceFile || entry.source_file),
      specificity: entry.specificity ?? null,
      quality: entry.quality ?? null,
      source: entry.source ?? entry.sourceType ?? entry.source_type ?? null,
      native: asObject(entry.metadata)
    },
    relevant
  };
}

function shouldKeepLoadedQuery(queryCase = null, format = 'custom') {
  if (!queryCase) return false;
  if (queryCase.relevant.length || queryCase.metadata?.hasTaskEvaluationTarget) return true;
  return canonicalBenchmarkFormat(format) === 'scinetbench' && Boolean(queryCase.query);
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

function normalizeCutoffs(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const cutoffs = rawValues
    .map((entry) => Math.floor(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return unique(cutoffs.length ? cutoffs : DEFAULT_CUTOFFS).sort((left, right) => left - right);
}

async function loadCustomBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const parsed = absolutePath.endsWith('.jsonl') || absolutePath.endsWith('.ndjson')
    ? await readJsonl(absolutePath)
    : await readJson(absolutePath, null);
  const corpus = Array.isArray(parsed?.corpus)
    ? parsed.corpus.map((entry, index) => normalizePaperRecord(entry, `corpus:${index}`))
    : [];
  const corpusById = new Map(corpus.flatMap((paper) => (
    [paper.id, paper.canonicalId, paper.normalizedTitle].filter(Boolean).map((id) => [id, paper])
  )));
  const entries = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.queries) ? parsed.queries : await readJsonOrJsonl(absolutePath));
  const queries = entries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format: options.formatName || options.format || 'custom',
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, options.formatName || options.format || 'custom'));
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'custom');

  return {
    name: options.name || parsed?.name || path.basename(absolutePath).replace(/\.(jsonl|ndjson|json)$/i, '') || 'custom-retrieval',
    format,
    profile: benchmarkProfile(format),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function loadBeirCorpus(corpusPath) {
  const entries = await readJsonl(corpusPath);
  const byId = new Map();
  for (const entry of entries) {
    const id = compactText(pickFirst(entry._id, entry.id, entry.docId, entry.doc_id));
    if (!id) continue;
    byId.set(id, normalizePaperRecord({
      ...entry,
      id,
      title: entry.title,
      abstract: entry.text
    }));
  }
  return byId;
}

async function loadBeirQueries(queriesPath) {
  const entries = await readJsonl(queriesPath);
  const byId = new Map();
  for (const entry of entries) {
    const id = compactText(pickFirst(entry._id, entry.id, entry.qid, entry.queryId, entry.query_id));
    const query = compactText(pickFirst(entry.text, entry.query, entry.question));
    if (id && query) byId.set(id, query);
  }
  return byId;
}

function parseQrelsLine(line = '', lineNumber = 0) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes('\t') ? /\t+/ : /\s+/;
  const parts = trimmed.split(separator).map((part) => part.trim()).filter(Boolean);
  if (lineNumber === 0 && /query|qid/i.test(parts[0] || '') && /corpus|doc/i.test(parts[1] || '')) {
    return null;
  }
  if (parts.length >= 4 && parts[1] === '0') {
    return {
      queryId: parts[0],
      documentId: parts[2],
      relevance: Number(parts[3])
    };
  }
  if (parts.length >= 3) {
    return {
      queryId: parts[0],
      documentId: parts[1],
      relevance: Number(parts[2])
    };
  }
  return null;
}

async function loadQrels(qrelsPath) {
  const content = await fs.readFile(qrelsPath, 'utf8');
  const byQuery = new Map();
  content.split(/\r?\n/).forEach((line, lineNumber) => {
    const entry = parseQrelsLine(line, lineNumber);
    if (!entry || !entry.queryId || !entry.documentId || !(entry.relevance > 0)) return;
    if (!byQuery.has(entry.queryId)) byQuery.set(entry.queryId, []);
    byQuery.get(entry.queryId).push(entry);
  });
  return byQuery;
}

async function loadBeirBenchmark(datasetPath, options = {}) {
  const baseDir = path.resolve(options.cwd || process.cwd(), datasetPath);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstExisting(baseDir, ['corpus.jsonl']);
  const queriesPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : await findFirstExisting(baseDir, ['queries.jsonl']);
  const qrelsPath = options.qrelsPath
    ? path.resolve(options.cwd || process.cwd(), options.qrelsPath)
    : await findFirstExisting(baseDir, [
      path.join('qrels', 'test.tsv'),
      path.join('qrels', 'dev.tsv'),
      path.join('qrels', 'train.tsv'),
      'qrels.tsv',
      'test.tsv'
    ]);

  if (!corpusPath || !queriesPath || !qrelsPath) {
    throw new Error('BEIR format requires corpus.jsonl, queries.jsonl, and qrels/*.tsv.');
  }

  const [corpusById, queryById, qrelsByQuery] = await Promise.all([
    loadBeirCorpus(corpusPath),
    loadBeirQueries(queriesPath),
    loadQrels(qrelsPath)
  ]);
  const queries = [...qrelsByQuery.entries()]
    .map(([queryId, qrels]) => {
      const query = queryById.get(queryId);
      if (!query) return null;
      return normalizeBenchmarkQuery({
        id: queryId,
        query,
        relevant: qrels.map((entry) => ({
          ...(corpusById.get(entry.documentId) || {}),
          id: entry.documentId,
          relevance: entry.relevance
        }))
      }, 0, corpusById, {
        format: options.formatName || options.format || 'beir',
        taskType: options.taskType
      });
    })
    .filter(Boolean);
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'beir');
  const corpus = [...corpusById.values()];

  return {
    name: options.name || path.basename(baseDir) || 'beir-retrieval',
    format,
    profile: benchmarkProfile(format),
    sourcePath: baseDir,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function loadLitSearchBenchmark(datasetPath, options = {}) {
  const baseDir = path.resolve(options.cwd || process.cwd(), datasetPath);
  const queryPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : await findFirstExisting(baseDir, ['query.jsonl', 'queries.jsonl', 'query.json', 'queries.json']);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstExisting(baseDir, ['corpus_clean.jsonl', 'corpus.jsonl', 'corpus_clean.json', 'corpus.json']);

  if (!queryPath || !corpusPath) {
    throw new Error('LitSearch format requires exported query and corpus_clean files as JSON/JSONL.');
  }

  const corpusEntries = await readJsonOrJsonl(corpusPath);
  const corpusById = new Map();
  for (const entry of corpusEntries) {
    const id = compactText(pickFirst(entry.corpusid, entry.corpusId, entry.corpus_id, entry._id, entry.id));
    if (id) corpusById.set(id, normalizePaperRecord({ ...entry, id }));
  }

  const queryEntries = await readJsonOrJsonl(queryPath);
  const queries = queryEntries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format: options.formatName || options.format || 'litsearch',
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, options.formatName || options.format || 'litsearch'));
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'litsearch');
  const corpus = [...corpusById.values()];

  return {
    name: options.name || 'LitSearch',
    format,
    profile: benchmarkProfile(format),
    sourcePath: baseDir,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

function scholarGymCorpusLookupKeys(paper = {}) {
  const arxivId = compactText(paper.identifiers?.arxivId || paper.arxivId || paper.arxiv_id);
  return unique([
    paper.id,
    paper.canonicalId,
    paper.normalizedTitle,
    arxivId,
    arxivId.replace(/v\d+$/i, '')
  ].map(compactText).filter(Boolean));
}

function normalizeScholarGymPaperRecord(entry = {}, fallbackId = '') {
  const raw = asObject(entry);
  const arxivId = compactText(pickFirst(raw.arxiv_id, raw.arxivId, raw.arxiv, fallbackId));
  return normalizePaperRecord({
    ...raw,
    id: pickFirst(raw.id, raw._id, arxivId, fallbackId),
    arxivId,
    arxiv_id: arxivId,
    abstract: pickFirst(raw.abstract, raw.summary),
    metadata: {
      ...(asObject(raw.metadata)),
      date: raw.date,
      authors: raw.authors,
      category: raw.category
    }
  }, fallbackId);
}

async function* streamTopLevelJsonObjectEntries(filePath) {
  let state = 'start';
  let keyRaw = '';
  let key = '';
  let valueRaw = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let done = false;

  for await (const chunk of createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
    for (const char of chunk) {
      if (done) {
        if (!/\s/.test(char)) throw new Error(`Unexpected trailing content in ${filePath}`);
        continue;
      }

      if (state === 'start') {
        if (/\s/.test(char)) continue;
        if (char !== '{') throw new Error(`Expected top-level JSON object in ${filePath}`);
        state = 'key-or-end';
        continue;
      }

      if (state === 'key-or-end') {
        if (/\s/.test(char) || char === ',') continue;
        if (char === '}') {
          done = true;
          continue;
        }
        if (char !== '"') throw new Error(`Expected object key in ${filePath}`);
        keyRaw = '"';
        state = 'key';
        escaped = false;
        continue;
      }

      if (state === 'key') {
        keyRaw += char;
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          key = JSON.parse(keyRaw);
          state = 'colon';
        }
        continue;
      }

      if (state === 'colon') {
        if (/\s/.test(char)) continue;
        if (char !== ':') throw new Error(`Expected ':' after object key in ${filePath}`);
        valueRaw = '';
        depth = 0;
        inString = false;
        escaped = false;
        state = 'value-start';
        continue;
      }

      if (state === 'value-start') {
        if (/\s/.test(char)) continue;
        state = 'value';
      }

      if (state === 'value') {
        valueRaw += char;
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
        } else if (char === '{' || char === '[') {
          depth += 1;
        } else if (char === '}' || char === ']') {
          depth -= 1;
          if (depth === 0) {
            yield [key, JSON.parse(valueRaw)];
            key = '';
            valueRaw = '';
            state = 'after-value';
          }
        }
        continue;
      }

      if (state === 'after-value') {
        if (/\s/.test(char)) continue;
        if (char === ',') {
          state = 'key-or-end';
          continue;
        }
        if (char === '}') {
          done = true;
          continue;
        }
        throw new Error(`Expected ',' or '}' after object value in ${filePath}`);
      }
    }
  }

  if (!done) throw new Error(`Unexpected end of JSON object in ${filePath}`);
}

async function loadScholarGymCorpus(corpusPath) {
  const stat = await fs.stat(corpusPath);
  const largeJsonThreshold = 256 * 1024 * 1024;
  if (stat.size <= largeJsonThreshold) {
    const paperDb = await readJson(corpusPath, null);
    const entries = Array.isArray(paperDb)
      ? paperDb.map((paper, index) => [paper?.arxiv_id || paper?.arxivId || paper?.id || index, paper])
      : Object.entries(asObject(paperDb));
    return entries
      .map(([paperId, paper]) => normalizeScholarGymPaperRecord(paper, paperId))
      .filter((paper) => paper.title || paper.abstract || paper.identifiers?.arxivId);
  }

  const corpus = [];
  for await (const [paperId, paper] of streamTopLevelJsonObjectEntries(corpusPath)) {
    const normalized = normalizeScholarGymPaperRecord(paper, paperId);
    if (normalized.title || normalized.abstract || normalized.identifiers?.arxivId) {
      corpus.push(normalized);
    }
  }
  return corpus;
}

function buildScholarGymCorpusById(corpus = []) {
  const corpusById = new Map();
  for (const paper of corpus) {
    for (const key of scholarGymCorpusLookupKeys(paper)) {
      if (!corpusById.has(key)) corpusById.set(key, paper);
    }
  }
  return corpusById;
}

function extractScholarGymRelevantPapers(entry = {}, corpusById = new Map()) {
  const papers = asArray(entry.cited_paper || entry.citedPaper || entry.citedPapers || entry.cited_papers);
  const labels = asArray(entry.gt_label || entry.gtLabel || entry.labels);
  const relevant = [];
  papers.forEach((paper, index) => {
    const label = Number(labels[index] ?? 0);
    if (!(label > 0)) return;
    const raw = asObject(paper);
    const identifiers = normalizePaperIdentifiers(raw);
    const arxivId = compactText(pickFirst(identifiers.arxivId, raw.arxiv_id, raw.arxivId, raw.arxiv));
    const match = arxivId ? corpusById.get(arxivId) || corpusById.get(arxivId.replace(/v\d+$/i, '')) : null;
    relevant.push({
      ...(match || normalizeScholarGymPaperRecord(raw, arxivId || `${entry.qid || 'query'}:rel:${index}`)),
      relevance: label
    });
  });
  return dedupePapers(relevant);
}

async function loadScholarGymBenchmark(datasetPath, options = {}) {
  const baseDir = path.resolve(options.cwd || process.cwd(), datasetPath);
  const queryPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : await findFirstExisting(baseDir, ['scholargym_bench.jsonl', 'scholargym_bench.json', 'bench.jsonl', 'benchmark.jsonl']);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstExisting(baseDir, ['scholargym_paper_db.json', 'paper_db.json', 'corpus.json']);

  if (!queryPath || !corpusPath) {
    throw new Error('ScholarGym format requires scholargym_bench.jsonl and scholargym_paper_db.json.');
  }

  const corpus = await loadScholarGymCorpus(corpusPath);
  const corpusById = buildScholarGymCorpusById(corpus);
  const queryEntries = await readJsonOrJsonl(queryPath);
  const requestedFormat = canonicalBenchmarkFormat(options.formatName || options.format || 'scholargym');
  const format = requestedFormat === 'auto' ? 'scholargym' : requestedFormat;
  const queries = queryEntries
    .filter((entry) => entry?.valid !== false)
    .map((entry, index) => normalizeBenchmarkQuery({
      id: pickFirst(entry.qid, entry.id, index + 1),
      query: entry.query,
      relevant: extractScholarGymRelevantPapers(entry, corpusById),
      source: entry.source,
      date: entry.date,
      metadata: {
        date: entry.date,
        source: entry.source,
        native: {
          qid: entry.qid,
          valid: entry.valid
        }
      }
    }, index, corpusById, {
      format,
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, format));

  return {
    name: options.name || 'ScholarGym',
    format,
    profile: benchmarkProfile(format),
    sourcePath: baseDir,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function listDirectoryFiles(baseDir) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function pathKey(filePath = '') {
  return String(filePath || '').split(path.sep).join('/');
}

async function findFirstMatchingFile(baseDir, matchers = []) {
  const files = await listDirectoryFiles(baseDir);
  for (const matcher of matchers) {
    const found = files.find((file) => (
      typeof matcher === 'string'
        ? file.toLowerCase() === matcher.toLowerCase()
        : matcher.test(file)
    ));
    if (found) return path.join(baseDir, found);
  }
  return '';
}

async function findMatchingFiles(baseDir, matchers = []) {
  const files = await listDirectoryFiles(baseDir);
  return files
    .filter((file) => matchers.some((matcher) => (
      typeof matcher === 'string'
        ? file.toLowerCase() === matcher.toLowerCase()
        : matcher.test(file)
    )))
    .map((file) => path.join(baseDir, file))
    .sort();
}

async function listFilesRecursive(baseDir, options = {}) {
  const maxDepth = Math.max(0, Number(options.maxDepth ?? 4));
  const skipDirs = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
  const files = [];

  async function visit(currentDir, depth) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await visit(path.join(currentDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.push(path.join(currentDir, entry.name));
      }
    }
  }

  await visit(baseDir, 0);
  return files.sort();
}

function isJsonDataFile(filePath = '') {
  return /\.(jsonl|ndjson|json)$/i.test(filePath);
}

function isFlexibleQueryPath(filePath = '', baseDir = '', format = 'custom') {
  if (!isJsonDataFile(filePath)) return false;
  const relative = pathKey(path.relative(baseDir, filePath)).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (format === 'paperask') {
    return relative.includes('test_cases/')
      || ['citation_retrieval', 'content_extraction', 'open_domain_qa', 'open_book_cf'].some((part) => relative.includes(part));
  }

  if (format === 'scholarqa') {
    if (relative.includes('/src_answers/') || relative.startsWith('src_answers/')) return false;
    return basename === 'test_configs_snippets.json'
      || basename === 'human_answers.json'
      || /(?:scifact|pubmed|qasa)_test\.jsonl$/i.test(basename)
      || /^scholarqabench_(?:bio|neuro)\.jsonl$/i.test(basename);
  }

  if (format === 'sage') {
    return relative.includes('sage_short_form_questions/')
      || relative.includes('sage_open_ended_questions/')
      || ['queries.jsonl', 'queries.json', 'questions.jsonl', 'questions.json', 'query.jsonl', 'query.json'].includes(basename)
      || /(?:sage|questions?).*\.(jsonl|ndjson|json)$/i.test(basename);
  }

  if (format === 'scinetbench') {
    return relative.includes('queries/')
      || /^queries(?:_|-)/i.test(basename)
      || /^queries_task/i.test(basename);
  }

  return [
    'queries.jsonl',
    'queries.json',
    'questions.jsonl',
    'questions.json',
    'query.jsonl',
    'query.json',
    'data.jsonl',
    'data.json',
    'benchmark.jsonl',
    'benchmark.json'
  ].includes(basename) || /(?:queries|questions|benchmark).*\.(jsonl|json)$/i.test(basename);
}

async function findFlexibleQueryPaths(queryInputPath, baseDir, format = 'custom') {
  const stat = await fs.stat(queryInputPath);
  if (!stat.isDirectory()) return [queryInputPath];
  const files = await listFilesRecursive(queryInputPath, { maxDepth: 5 });
  return files.filter((filePath) => isFlexibleQueryPath(filePath, baseDir, format));
}

async function hasBeirQrels(baseDir) {
  return Boolean(await findFirstExisting(baseDir, [
    path.join('qrels', 'test.tsv'),
    path.join('qrels', 'dev.tsv'),
    path.join('qrels', 'train.tsv'),
    'qrels.tsv',
    'test.tsv'
  ]));
}

async function loadCorpusFromPath(corpusPath = '') {
  if (!corpusPath) return { corpus: [], corpusById: new Map() };
  const entries = await readJsonOrJsonl(corpusPath);
  const corpus = entries.map((entry, index) => normalizePaperRecord(entry, `corpus:${index}`));
  const corpusById = new Map();
  for (const paper of corpus) {
    for (const id of unique([paper.id, paper.canonicalId, paper.normalizedTitle, ...collectMatchAliases(paper)].filter(Boolean))) {
      corpusById.set(id, paper);
    }
  }
  return { corpus, corpusById };
}

async function loadFlexibleSchemaBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'custom');
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : (stat.isDirectory() ? await findFirstMatchingFile(baseDir, [
      'corpus.jsonl',
      'corpus.json',
      'papers.jsonl',
      'papers.json',
      'documents.jsonl',
      'documents.json',
      /metadata.*\.jsonl$/i,
      /corpus.*\.jsonl$/i
    ]) : '');
  const queryInputPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : absolutePath;
  const queryPaths = stat.isDirectory()
    ? await findFlexibleQueryPaths(queryInputPath, baseDir, format)
    : [absolutePath];

  if (!queryPaths.length) {
    throw new Error(`${format} format requires a query/question JSON or JSONL file.`);
  }

  const { corpus, corpusById } = await loadCorpusFromPath(corpusPath);
  const entries = (await Promise.all(queryPaths.map(async (queryPath) => {
    const sourceFile = pathKey(path.relative(baseDir, queryPath));
    const loaded = await readJsonOrJsonl(queryPath);
    return loaded.map((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...entry, __sourceFile: sourceFile }
        : { query: entry, __sourceFile: sourceFile }
    ));
  }))).flat();
  const queries = entries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format,
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, format));

  return {
    name: options.name || format,
    format,
    profile: benchmarkProfile(format),
    sourcePath: absolutePath,
    queryPaths,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

function bioasqDocumentToPaper(document = '') {
  const text = compactText(document);
  const identifiers = extractIdentifiersFromText(text);
  const pmid = identifiers.pmid || text.match(/\/(\d{6,9})(?:$|[?#])/i)?.[1] || '';
  return normalizePaperRecord({
    id: text || pmid,
    title: text || pmid,
    url: text,
    pmid
  });
}

async function loadBioAsqBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const dataPath = stat.isDirectory()
    ? await findFirstMatchingFile(absolutePath, [
      'bioasq.json',
      'training.json',
      'train.json',
      'test.json',
      'questions.json',
      /bioasq.*\.json$/i,
      /.*questions.*\.json$/i
    ])
    : absolutePath;
  if (!dataPath) throw new Error('BioASQ format requires a JSON file with a questions array.');

  const parsed = await readJson(dataPath, null);
  const entries = Array.isArray(parsed) ? parsed : asArray(parsed?.questions || parsed?.data || parsed?.items);
  const queries = entries.map((entry, index) => {
    const documents = [
      ...asArray(entry.documents),
      ...asArray(entry.ideal_answer_documents),
      ...asArray(entry.exact_answer_documents),
      ...asArray(entry.snippets).map((snippet) => snippet?.document).filter(Boolean)
    ];
    return normalizeBenchmarkQuery({
      ...entry,
      id: pickFirst(entry.id, entry._id, entry.qid, index + 1),
      query: pickFirst(entry.body, entry.question, entry.query),
      relevant: documents.map(bioasqDocumentToPaper),
      taskType: 'biomedical_qa_retrieval',
      queryType: entry.type
    }, index, new Map(), {
      format: 'bioasq',
      taskType: 'biomedical_qa_retrieval'
    });
  }).filter((entry) => entry && entry.relevant.length);

  return {
    name: options.name || parsed?.name || 'BioASQ',
    format: 'bioasq',
    profile: benchmarkProfile('bioasq'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: 0,
    corpus: [],
    queries
  };
}

function stripXmlTags(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlField(block = '', field = '') {
  const pattern = new RegExp(`<${field}[^>]*>([\\s\\S]*?)<\\/${field}>`, 'i');
  return stripXmlTags(block.match(pattern)?.[1] || '');
}

async function parseTrecTopics(topicsPath) {
  if (topicsPath.endsWith('.json') || topicsPath.endsWith('.jsonl') || topicsPath.endsWith('.ndjson')) {
    const entries = await readJsonOrJsonl(topicsPath);
    return new Map(entries.map((entry, index) => [
      compactText(pickFirst(entry.id, entry._id, entry.number, entry.qid, index + 1)),
      compactText(pickFirst(entry.query, entry.title, entry.summary, entry.description, entry.question, entry.text))
    ]).filter(([id, query]) => id && query));
  }

  const content = await fs.readFile(topicsPath, 'utf8');
  const topics = new Map();
  const topicBlocks = [...content.matchAll(/<topic\b[^>]*>[\s\S]*?<\/topic>/gi)];
  for (const match of topicBlocks) {
    const block = match[0];
    const id = compactText(
      block.match(/<topic\b[^>]*(?:number|id)=["']?([^"'\s>]+)["']?/i)?.[1]
      || extractXmlField(block, 'number')
      || extractXmlField(block, 'num').replace(/^Number:\s*/i, '')
    );
    const fields = [
      extractXmlField(block, 'title'),
      extractXmlField(block, 'summary'),
      extractXmlField(block, 'description'),
      extractXmlField(block, 'desc'),
      extractXmlField(block, 'narrative'),
      extractXmlField(block, 'disease'),
      extractXmlField(block, 'gene'),
      extractXmlField(block, 'demographic'),
      extractXmlField(block, 'other')
    ].filter(Boolean);
    if (id && fields.length) topics.set(id, compactText(fields.join(' ')));
  }
  return topics;
}

async function loadTrecBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);

  if (stat.isDirectory() && await fileExists(path.join(baseDir, 'corpus.jsonl')) && await fileExists(path.join(baseDir, 'queries.jsonl'))) {
    return loadBeirBenchmark(baseDir, { ...options, formatName: 'trec' });
  }

  const topicsPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : (stat.isDirectory() ? await findFirstMatchingFile(baseDir, [
      'topics.xml',
      'queries.xml',
      'topics.json',
      'topics.jsonl',
      'queries.json',
      'queries.jsonl',
      /topics.*\.(xml|json|jsonl)$/i
    ]) : absolutePath);
  const qrelsPath = options.qrelsPath
    ? path.resolve(options.cwd || process.cwd(), options.qrelsPath)
    : await findFirstExisting(baseDir, ['qrels/test.tsv', 'qrels.tsv', 'qrels.txt', 'qrels']);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstMatchingFile(baseDir, ['corpus.jsonl', 'corpus.json', 'papers.jsonl', 'documents.jsonl']);

  if (!topicsPath || !qrelsPath) {
    throw new Error('TREC format requires topics plus qrels, or a BEIR-style directory.');
  }

  const [queryById, qrelsByQuery, { corpus, corpusById }] = await Promise.all([
    parseTrecTopics(topicsPath),
    loadQrels(qrelsPath),
    loadCorpusFromPath(corpusPath)
  ]);
  const queries = [...qrelsByQuery.entries()].map(([queryId, qrels], index) => {
    const query = queryById.get(queryId);
    if (!query) return null;
    return normalizeBenchmarkQuery({
      id: queryId,
      query,
      relevant: qrels.map((entry) => ({
        ...(corpusById.get(entry.documentId) || {}),
        id: entry.documentId,
        title: entry.documentId,
        relevance: entry.relevance
      }))
    }, index, corpusById, {
      format: 'trec',
      taskType: 'biomedical_literature_retrieval'
    });
  }).filter(Boolean);

  return {
    name: options.name || path.basename(baseDir) || 'TREC',
    format: 'trec',
    profile: benchmarkProfile('trec'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

function isCsfcubeCandidateAnnotationSet(value = {}) {
  const entry = asObject(value);
  return Array.isArray(entry.cands) || Array.isArray(entry.candidates);
}

function pickCsfcubeRelevanceArray(value = {}) {
  const entry = asObject(value);
  const preferredKeys = ['relevance_adju', 'relevance', 'relevance_max', 'score', 'scores', 'grade', 'grades', 'label', 'labels'];
  for (const key of preferredKeys) {
    if (Array.isArray(entry[key])) return entry[key];
  }
  const fallbackKey = Object.keys(entry).find((key) => /^relevance_/i.test(key) && Array.isArray(entry[key]));
  return fallbackKey ? entry[fallbackKey] : [];
}

function normalizeCsfcubePaperReference(entry, relevance = 1, index = 0, corpusById = new Map()) {
  const raw = typeof entry === 'object' && entry !== null ? entry : { id: entry };
  const paperId = compactText(pickFirst(
    raw.id,
    raw.paperId,
    raw.paper_id,
    raw.pid,
    raw.corpusid,
    raw.corpusId,
    entry
  ));
  const corpusPaper = corpusById.get(paperId);
  return normalizePaperRecord({
    ...(corpusPaper || {}),
    ...raw,
    id: paperId || corpusPaper?.id,
    title: pickFirst(raw.title, raw.paperTitle, raw.paper_title, corpusPaper?.title, paperId),
    abstract: pickFirst(raw.abstract, raw.text, raw.summary, corpusPaper?.abstract),
    relevance
  }, `csfcube:${index}`);
}

function normalizeCsfcubeAnnotationSet(value, corpusById = new Map()) {
  if (!value) return [];
  if (isCsfcubeCandidateAnnotationSet(value)) {
    const candidates = asArray(value.cands || value.candidates);
    const relevanceValues = pickCsfcubeRelevanceArray(value);
    const hasExplicitRelevance = relevanceValues.length > 0;
    return candidates
      .map((entry, index) => {
        const relevance = hasExplicitRelevance ? toNumber(relevanceValues[index], 0) : 1;
        if (relevance <= 0) return null;
        return normalizeCsfcubePaperReference(entry, relevance, index, corpusById);
      })
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => {
        const relevance = toNumber(pickFirst(entry?.relevance, entry?.score, entry?.grade, entry?.label, 1), 1);
        if (relevance <= 0) return null;
        return normalizeCsfcubePaperReference(entry, relevance, index, corpusById);
      })
      .filter(Boolean);
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, relevance]) => Number(relevance) > 0)
      .map(([paperId, relevance], index) => normalizeCsfcubePaperReference({ id: paperId }, relevance, index, corpusById));
  }
  return [];
}

function inferCsfcubeFacetFromPath(filePath = '') {
  const basename = path.basename(filePath).toLowerCase();
  for (const facet of ['background', 'method', 'result']) {
    if (basename.includes(`-${facet}`) || basename.includes(`_${facet}`) || basename.includes(facet)) return facet;
  }
  return '';
}

async function loadCsfcubeBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const annotationPaths = stat.isDirectory()
    ? await findMatchingFiles(baseDir, [
      'test-pid2anns-csfcube.json',
      'pid2anns.json',
      'annotations.json',
      /.*pid2anns.*\.json$/i,
      /.*annotations.*\.json$/i
    ])
    : [absolutePath];
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstMatchingFile(baseDir, [
      'corpus.jsonl',
      'corpus.json',
      'papers.jsonl',
      'abstracts.jsonl',
      /abstract.*\.jsonl$/i,
      /metadata.*\.jsonl$/i
    ]);

  if (!annotationPaths.length) return loadFlexibleSchemaBenchmark(absolutePath, { ...options, formatName: 'csfcube' });

  const { corpus, corpusById } = await loadCorpusFromPath(corpusPath);
  const queries = [];
  for (const annotationPath of annotationPaths) {
    const annotations = await readJson(annotationPath, null);
    const fileFacet = inferCsfcubeFacetFromPath(annotationPath);
    Object.entries(asObject(annotations)).forEach(([queryPaperId, facetMap]) => {
      const queryPaper = corpusById.get(queryPaperId) || normalizePaperRecord({ id: queryPaperId, title: queryPaperId });
      if (Array.isArray(facetMap) || isCsfcubeCandidateAnnotationSet(facetMap) || Number.isFinite(Number(Object.values(asObject(facetMap))[0]))) {
        const relevant = normalizeCsfcubeAnnotationSet(facetMap, corpusById);
        if (relevant.length) {
          const facet = fileFacet || 'all';
          queries.push(normalizeBenchmarkQuery({
            id: `${queryPaperId}:${facet}`,
            query: compactText([queryPaper.title, facet, queryPaper.abstract].filter(Boolean).join(' ')),
            queryPaperId,
            facet,
            relevant,
            taskType: 'faceted_query_by_example'
          }, queries.length, corpusById, { format: 'csfcube', taskType: 'faceted_query_by_example' }));
        }
        return;
      }
      Object.entries(asObject(facetMap)).forEach(([facet, annotationSet]) => {
        const relevant = normalizeCsfcubeAnnotationSet(annotationSet, corpusById);
        if (!relevant.length) return;
        queries.push(normalizeBenchmarkQuery({
          id: `${queryPaperId}:${facet}`,
          query: compactText([queryPaper.title, facet, queryPaper.abstract].filter(Boolean).join(' ')),
          queryPaperId,
          facet,
          relevant,
          taskType: 'faceted_query_by_example'
        }, queries.length, corpusById, { format: 'csfcube', taskType: 'faceted_query_by_example' }));
      });
    });
  }

  return {
    name: options.name || 'CSFCube',
    format: 'csfcube',
    profile: benchmarkProfile('csfcube'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

export async function loadRetrievalBenchmark(datasetPath, options = {}) {
  if (!datasetPath) throw new Error('datasetPath is required.');
  const format = canonicalBenchmarkFormat(options.format || 'auto');
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);

  if (format === 'beir') return loadBeirBenchmark(absolutePath, options);
  if (format === 'litsearch') return loadLitSearchBenchmark(absolutePath, options);
  if (format === 'scholargym') return loadScholarGymBenchmark(absolutePath, options);
  if (format === 'bioasq') return loadBioAsqBenchmark(absolutePath, options);
  if (format === 'trec') return loadTrecBenchmark(absolutePath, options);
  if (format === 'csfcube') return loadCsfcubeBenchmark(absolutePath, options);
  if (['sage', 'scholarqa', 'paperask', 'sparbench', 'scinetbench'].includes(format)) {
    if (
      stat.isDirectory()
      && await fileExists(path.join(absolutePath, 'corpus.jsonl'))
      && await fileExists(path.join(absolutePath, 'queries.jsonl'))
      && await hasBeirQrels(absolutePath)
    ) {
      return loadBeirBenchmark(absolutePath, { ...options, formatName: format });
    }
    return loadFlexibleSchemaBenchmark(absolutePath, { ...options, formatName: format });
  }
  if (format === 'custom' || format === 'json' || format === 'jsonl') return loadCustomBenchmark(absolutePath, options);

  if (stat.isDirectory()) {
    if (await fileExists(path.join(absolutePath, 'corpus.jsonl')) && await fileExists(path.join(absolutePath, 'queries.jsonl'))) {
      return loadBeirBenchmark(absolutePath, options);
    }
    if (
      (await findFirstExisting(absolutePath, ['query.jsonl', 'queries.jsonl', 'query.json', 'queries.json']))
      && (await findFirstExisting(absolutePath, ['corpus_clean.jsonl', 'corpus.jsonl', 'corpus_clean.json', 'corpus.json']))
    ) {
      return loadLitSearchBenchmark(absolutePath, options);
    }
    if (
      (await findFirstExisting(absolutePath, ['scholargym_bench.jsonl', 'scholargym_bench.json']))
      && (await findFirstExisting(absolutePath, ['scholargym_paper_db.json', 'paper_db.json']))
    ) {
      return loadScholarGymBenchmark(absolutePath, options);
    }
    if (await findFirstMatchingFile(absolutePath, [/bioasq.*\.json$/i, /.*questions.*\.json$/i])) {
      const parsed = await readJson(await findFirstMatchingFile(absolutePath, [/bioasq.*\.json$/i, /.*questions.*\.json$/i]), null);
      if (Array.isArray(parsed?.questions) && parsed.questions.some((entry) => Array.isArray(entry.documents))) {
        return loadBioAsqBenchmark(absolutePath, options);
      }
    }
    if (await findFirstMatchingFile(absolutePath, [/.*pid2anns.*\.json$/i])) {
      return loadCsfcubeBenchmark(absolutePath, options);
    }
  }

  return loadCustomBenchmark(absolutePath, options);
}

function collectMatchAliases(paper = {}) {
  const identity = createPaperIdentity({
    identifiers: normalizePaperIdentifiers({
      ...asObject(paper.identifiers),
      ...paper
    }),
    title: paper.title,
    normalizedTitle: paper.normalizedTitle
  });
  return unique([
    paper.canonicalId,
    paper.id,
    identity.canonicalId,
    ...(Array.isArray(paper.identityAliases) ? paper.identityAliases : []),
    ...identity.identityAliases
  ].map((entry) => compactText(entry)).filter(Boolean));
}

function collectIdentifierMatchKeys(paper = {}) {
  const identifiers = normalizePaperIdentifiers({
    ...asObject(paper.identifiers),
    ...paper
  });
  return Object.entries(identifiers)
    .filter(([, value]) => compactText(value))
    .map(([field, value]) => `${field}:${compactText(value).toLowerCase()}`);
}

function buildRelevantMatchIndex(relevant = []) {
  const aliasToIndex = new Map();
  const identifierToIndex = new Map();
  relevant.forEach((paper, index) => {
    for (const alias of collectMatchAliases(paper)) {
      const key = alias.toLowerCase();
      if (!aliasToIndex.has(key)) aliasToIndex.set(key, index);
    }
    for (const key of collectIdentifierMatchKeys(paper)) {
      if (!identifierToIndex.has(key)) identifierToIndex.set(key, index);
    }
  });
  return {
    aliasToIndex,
    identifierToIndex
  };
}

function titleSimilarity(left = {}, right = {}) {
  const leftTitle = compactText(left.normalizedTitle || left.title);
  const rightTitle = compactText(right.normalizedTitle || right.title);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle.toLowerCase() === rightTitle.toLowerCase()) return 1;
  return jaccardSimilarity(leftTitle, rightTitle);
}

function findRelevantMatch(candidate = {}, relevant = [], options = {}) {
  const titleThreshold = Number(options.titleMatchThreshold || DEFAULT_TITLE_MATCH_THRESHOLD);
  const relevantMatchIndex = options.relevantMatchIndex || buildRelevantMatchIndex(relevant);
  for (const key of collectIdentifierMatchKeys(candidate)) {
    const index = relevantMatchIndex.identifierToIndex.get(key);
    if (index !== undefined) {
      return {
        index,
        reason: 'identifier'
      };
    }
  }

  const candidateAliases = collectMatchAliases(candidate);
  for (const alias of candidateAliases) {
    const index = relevantMatchIndex.aliasToIndex.get(alias.toLowerCase());
    if (index !== undefined) {
      return {
        index,
        reason: 'alias'
      };
    }
  }

  for (let index = 0; index < relevant.length; index += 1) {
    const gold = relevant[index];
    if (paperIdentifiersOverlap(candidate, gold)) {
      return {
        index,
        reason: 'identifier'
      };
    }

    const similarity = titleSimilarity(candidate, gold);
    if (similarity >= titleThreshold) {
      return {
        index,
        reason: similarity === 1 ? 'title_exact' : 'title_similarity',
        similarity
      };
    }
  }

  return null;
}

function buildRankEvents(candidates = [], relevant = [], options = {}) {
  const matchedRelevant = new Set();
  const relevantMatchIndex = buildRelevantMatchIndex(relevant);
  return candidates.map((candidate, index) => {
    const match = findRelevantMatch(candidate, relevant, {
      ...options,
      relevantMatchIndex
    });
    const duplicate = match ? matchedRelevant.has(match.index) : false;
    if (match && !duplicate) matchedRelevant.add(match.index);
    const relevanceScore = match && !duplicate
      ? Math.max(0, Number(relevant[match.index]?.relevance || 1))
      : 0;
    return {
      rank: index + 1,
      candidate,
      match,
      isRelevant: Boolean(match && !duplicate),
      relevanceScore,
      duplicateRelevantMatch: duplicate
    };
  });
}

function summarizeBestGoldCandidate(gold = {}, candidates = [], options = {}) {
  if (!candidates.length) return null;
  const titleThreshold = Number(options.titleMatchThreshold || DEFAULT_TITLE_MATCH_THRESHOLD);
  let best = null;

  candidates.forEach((candidate, index) => {
    const similarity = titleSimilarity(candidate, gold);
    const hasIdentifierOverlap = paperIdentifiersOverlap(candidate, gold);
    const hasAliasOverlap = collectMatchAliases(gold).some((alias) => (
      new Set(collectMatchAliases(candidate)).has(alias)
    ));
    const score = (hasIdentifierOverlap ? 2 : 0) + (hasAliasOverlap ? 1.5 : 0) + similarity;
    if (!best || score > best.score) {
      best = {
        score,
        rank: index + 1,
        title: candidate.title || '',
        canonicalId: candidate.canonicalId || candidate.id || '',
        titleSimilarity: similarity,
        hasIdentifierOverlap,
        hasAliasOverlap,
        titleMatchThreshold: titleThreshold
      };
    }
  });

  if (!best) return null;
  delete best.score;
  return best;
}

function classifyGoldMiss(bestCandidate = null) {
  if (!bestCandidate) return 'no_candidates';
  if (bestCandidate.hasIdentifierOverlap || bestCandidate.hasAliasOverlap) return 'identity_match_not_ranked';
  if (bestCandidate.titleSimilarity >= bestCandidate.titleMatchThreshold) return 'title_match_not_ranked';
  if (bestCandidate.titleSimilarity >= Math.max(0.5, bestCandidate.titleMatchThreshold - 0.15)) {
    return 'near_title_match_below_threshold';
  }
  if (bestCandidate.titleSimilarity > 0) return 'weak_title_overlap';
  return 'not_in_candidate_pool';
}

function summarizeUnmatchedRelevant(relevant = [], candidates = [], events = [], options = {}) {
  const matched = new Set(events.filter((event) => event.isRelevant).map((event) => event.match.index));
  return relevant
    .map((gold, index) => ({ gold, index }))
    .filter((entry) => !matched.has(entry.index))
    .slice(0, 20)
    .map(({ gold, index }) => {
      const bestCandidate = summarizeBestGoldCandidate(gold, candidates, options);
      return {
        index,
        title: gold.title || '',
        canonicalId: gold.canonicalId || gold.id || '',
        relevance: Math.max(0, Number(gold.relevance || 1)),
        reason: classifyGoldMiss(bestCandidate),
        bestCandidate
      };
    });
}

function dcgAt(events = [], cutoff = 10) {
  return events.slice(0, cutoff).reduce((sum, event, index) => (
    sum + (event.relevanceScore > 0 ? event.relevanceScore / Math.log2(index + 2) : 0)
  ), 0);
}

function idcgAt(relevant = [], cutoff = 10) {
  return relevant
    .map((paper) => Math.max(0, Number(paper.relevance || 1)))
    .sort((left, right) => right - left)
    .slice(0, cutoff)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
}

function averagePrecisionAt(events = [], relevantCount = 0, cutoff = 10) {
  if (!relevantCount) return 0;
  let hits = 0;
  let precisionSum = 0;
  for (const event of events.slice(0, cutoff)) {
    if (!event.isRelevant) continue;
    hits += 1;
    precisionSum += hits / event.rank;
  }
  return precisionSum / Math.min(relevantCount, cutoff);
}

function weightedRecallAt(events = [], relevant = [], cutoff = 10) {
  const totalWeight = relevant.reduce((sum, paper) => sum + Math.max(0, Number(paper.relevance || 1)), 0);
  if (!totalWeight) return 0;
  const matchedWeight = events
    .slice(0, cutoff)
    .reduce((sum, event) => sum + Math.max(0, Number(event.relevanceScore || 0)), 0);
  return matchedWeight / totalWeight;
}

export function evaluateRetrievalResults(queryCase = {}, candidates = [], options = {}) {
  const cutoffs = normalizeCutoffs(options.cutoffs);
  const relevant = dedupePapers((queryCase.relevant || []).map((paper, index) => (
    normalizePaperRecord(paper, `${queryCase.id || 'query'}:rel:${index}`)
  )));
  const events = buildRankEvents(candidates, relevant, options);
  const metrics = {};
  let firstRelevantRank = 0;
  for (const event of events) {
    if (event.isRelevant) {
      firstRelevantRank = event.rank;
      break;
    }
  }
  const matchedRelevantIndexes = new Set(events.filter((event) => event.isRelevant).map((event) => event.match.index));
  const unmatchedRelevant = summarizeUnmatchedRelevant(relevant, candidates, events, options);

  for (const cutoff of cutoffs) {
    const hits = events.slice(0, cutoff).filter((event) => event.isRelevant).length;
    const ideal = idcgAt(relevant, cutoff);
    const precision = hits / cutoff;
    const recall = relevant.length ? hits / relevant.length : 0;
    metrics[`hit@${cutoff}`] = hits > 0 ? 1 : 0;
    metrics[`exact_match@${cutoff}`] = hits > 0 ? 1 : 0;
    metrics[`precision@${cutoff}`] = precision;
    metrics[`recall@${cutoff}`] = recall;
    metrics[`f1@${cutoff}`] = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    metrics[`weighted_recall@${cutoff}`] = weightedRecallAt(events, relevant, cutoff);
    metrics[`mrr@${cutoff}`] = firstRelevantRank && firstRelevantRank <= cutoff ? 1 / firstRelevantRank : 0;
    metrics[`map@${cutoff}`] = averagePrecisionAt(events, relevant.length, cutoff);
    metrics[`ndcg@${cutoff}`] = ideal ? dcgAt(events, cutoff) / ideal : 0;
  }

  return {
    id: queryCase.id,
    query: queryCase.query,
    relevantCount: relevant.length,
    relevantWeight: relevant.reduce((sum, paper) => sum + Math.max(0, Number(paper.relevance || 1)), 0),
    retrievedCount: candidates.length,
    matchedCount: matchedRelevantIndexes.size,
    unmatchedRelevantCount: Math.max(0, relevant.length - matchedRelevantIndexes.size),
    firstRelevantRank,
    metrics,
    unmatchedRelevant,
    topMatches: events
      .filter((event) => event.match)
      .slice(0, 10)
      .map((event) => ({
        rank: event.rank,
        reason: event.match.reason,
        title: event.candidate.title || '',
        canonicalId: event.candidate.canonicalId || '',
        relevance: event.relevanceScore,
        duplicateRelevantMatch: event.duplicateRelevantMatch
      }))
  };
}

function aggregateMetrics(results = []) {
  const metricKeys = unique(results.flatMap((result) => Object.keys(result.metrics || {}))).sort();
  const aggregates = {};
  for (const key of metricKeys) {
    const values = results.map((result) => Number(result.metrics?.[key] || 0));
    aggregates[key] = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  }
  return aggregates;
}

function classifyProviderFailure(reason = '', entry = {}) {
  const text = compactText([
    reason,
    entry.reason,
    entry.error,
    entry.status,
    entry.statusText
  ].filter(Boolean).join(' ')).toLowerCase();
  const status = Number(entry.status || entry.statusCode || entry.status_code || 0);
  if ([401, 403].includes(status) || /\b(401|403|unauthori[sz]ed|forbidden|api key|apikey|credential|auth)\b/.test(text)) return 'auth';
  if (status === 429 || /\b(429|rate.?limit|too many requests|quota|cooldown)\b/.test(text)) return 'rate_limit';
  if (status === 400 || /\b(400|bad request|invalid query|parse|syntax|malformed)\b/.test(text)) return 'bad_query';
  if (status === 404 || /\b(404|not found|no result|missing)\b/.test(text)) return 'not_found';
  if (/\b(schema|json|parse error|invalid response|unexpected token)\b/.test(text)) return 'schema';
  if (status >= 500 || /\b(timeout|timed out|econn|network|fetch|socket|reset|dns|503|502|500)\b/.test(text)) return 'network';
  return 'unknown';
}

function summarizeDiscoveryFailures(queryResults = []) {
  return asArray(queryResults)
    .filter((entry) => entry && entry.ok === false)
    .map((entry) => ({
      provider: entry.provider || 'unknown',
      queryId: entry.queryId || entry.id || '',
      query: truncate(entry.query || '', 160),
      reason: entry.reason || entry.error || 'provider-failed',
      category: classifyProviderFailure(entry.reason || entry.error || 'provider-failed', entry)
    }));
}

function aggregateProviderFailures(results = []) {
  const grouped = new Map();
  for (const failure of results.flatMap((result) => result.discovery?.providerFailures || [])) {
    const provider = failure.provider || 'unknown';
    const reason = failure.reason || 'provider-failed';
    const category = failure.category || classifyProviderFailure(reason, failure);
    const key = `${provider}\t${category}\t${reason}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        provider,
        category,
        reason,
        count: 0
      });
    }
    grouped.get(key).count += 1;
  }
  return [...grouped.values()].sort((left, right) => (
    right.count - left.count
    || left.provider.localeCompare(right.provider)
    || left.reason.localeCompare(right.reason)
  ));
}

function classifyOfficialBenchmarkSlice(benchmark = {}, queryCase = {}) {
  const format = canonicalBenchmarkFormat(benchmark.format || queryCase.metadata?.benchmarkFormat || 'custom');
  if (format !== 'litsearch') return null;
  const metadata = queryCase.metadata || {};
  const native = asObject(metadata.native);
  const hint = compactText(pickFirst(
    metadata.queryType,
    metadata.specificity,
    native.queryType,
    native.query_type,
    native.type,
    native.specificity,
    native.category
  )).toLowerCase();
  if (/\bbroad\b|general|explor/.test(hint)) return 'broad';
  if (/\bspecific\b|focused|targeted|narrow/.test(hint)) return 'specific';
  return 'uncategorized';
}

function aggregateOfficialBenchmarkMetrics(results = [], benchmark = {}) {
  const format = canonicalBenchmarkFormat(benchmark.format || 'custom');
  if (format !== 'litsearch') return null;
  const broad = results.filter((result) => result.officialSlice === 'broad');
  const specific = results.filter((result) => result.officialSlice === 'specific');
  const uncategorized = results.filter((result) => !['broad', 'specific'].includes(result.officialSlice));
  const metricAverage = (items, key) => average(items.map((result) => result.metrics?.[key] || 0));
  return {
    format: 'litsearch',
    protocol: 'LitSearch official slice metrics',
    metrics: {
      'broad_recall@20': broad.length ? metricAverage(broad, 'recall@20') : null,
      'specific_recall@5': specific.length ? metricAverage(specific, 'recall@5') : null,
      'specific_recall@20': specific.length ? metricAverage(specific, 'recall@20') : null
    },
    queryCounts: {
      broad: broad.length,
      specific: specific.length,
      uncategorized: uncategorized.length
    },
    note: uncategorized.length
      ? 'Some LitSearch queries did not expose broad/specific metadata; those queries are excluded from slice metrics.'
      : ''
  };
}

function buildQueryDiagnosticTrace(queryCase = {}, evaluation = {}, discoveryRun = {}, candidates = []) {
  const providerFailures = summarizeDiscoveryFailures(discoveryRun.queryResults || []);
  const zeroMatch = Number(evaluation.relevantCount || 0) > 0 && !evaluation.firstRelevantRank;
  return {
    queryId: queryCase.id || null,
    zeroMatch,
    providerFailureCategories: unique(providerFailures.map((failure) => failure.category || 'unknown')).sort(),
    providerFailureCount: providerFailures.length,
    rawCandidateCount: discoveryRun.rawCandidateCount || candidates.length,
    mergedPaperCount: candidates.length,
    unmatchedRelevantReasons: unique(asArray(evaluation.unmatchedRelevant).map((miss) => miss.reason || 'unknown')).sort()
  };
}

function createBenchmarkFailureResult(queryCase = {}, error, options = {}) {
  const evaluation = evaluateRetrievalResults(queryCase, [], {
    cutoffs: options.cutoffs,
    titleMatchThreshold: options.titleMatchThreshold || options.title_match_threshold
  });
  const reason = error?.reason || error?.code || error?.message || 'query-failed';
  const failure = {
    provider: 'benchmark',
    queryId: queryCase.id || '',
    query: truncate(queryCase.query || '', 160),
    reason,
    category: classifyProviderFailure(reason, error || {})
  };
  return {
    ...evaluation,
    status: 'failed',
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error || 'query failed'),
      reason
    },
    durationMs: options.durationMs || 0,
    evaluationMode: options.evaluationMode || null,
    taskType: queryCase.metadata?.taskType || options.taskType || null,
    queryType: queryCase.metadata?.queryType || null,
    querySpecificity: queryCase.metadata?.specificity ?? null,
    officialSlice: options.officialSlice || null,
    taskEvaluation: null,
    discovery: {
      runId: null,
      providerCount: 0,
      plannedQueryCount: 0,
      providerQueryCount: 0,
      rawCandidateCount: 0,
      mergedPaperCount: 0,
      providerFailures: [failure],
      citationExpansion: null,
      coverage: null,
      artifacts: null,
      diagnosticTrace: {
        queryId: queryCase.id || null,
        zeroMatch: true,
        providerFailureCategories: [failure.category],
        providerFailureCount: 1,
        rawCandidateCount: 0,
        mergedPaperCount: 0,
        unmatchedRelevantReasons: unique(asArray(evaluation.unmatchedRelevant).map((miss) => miss.reason || 'unknown')).sort()
      }
    }
  };
}

function aggregateGoldMissReasons(results = []) {
  const grouped = new Map();
  for (const result of results) {
    for (const miss of result.unmatchedRelevant || []) {
      const reason = miss.reason || 'unknown';
      if (!grouped.has(reason)) {
        grouped.set(reason, {
          reason,
          count: 0,
          examples: []
        });
      }
      const entry = grouped.get(reason);
      entry.count += 1;
      if (entry.examples.length < 3) {
        entry.examples.push({
          query: truncate(result.query || '', 100),
          title: truncate(miss.title || '', 100),
          bestCandidateTitle: truncate(miss.bestCandidate?.title || '', 100),
          bestCandidateRank: miss.bestCandidate?.rank || null,
          titleSimilarity: miss.bestCandidate?.titleSimilarity || 0
        });
      }
    }
  }
  return [...grouped.values()].sort((left, right) => (
    right.count - left.count || left.reason.localeCompare(right.reason)
  ));
}

function average(values = []) {
  const numeric = values.map((value) => Number(value || 0)).filter(Number.isFinite);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : 0;
}

const DISCOVERY_REQUEST_STAT_FIELDS = [
  'total',
  'cacheDisabled',
  'cacheMisses',
  'cacheHits',
  'cacheMemoryHits',
  'cacheDiskHits',
  'networkRequests',
  'networkErrors',
  'cacheWrites',
  'inFlightHits',
  'circuitBreakerHits'
];

function numericRequestCounter(stats = {}, field = '') {
  const value = Number(stats?.[field] || 0);
  return Number.isFinite(value) ? value : 0;
}

function diffRequestCounters(after = {}, before = {}) {
  const diff = {};
  for (const field of DISCOVERY_REQUEST_STAT_FIELDS) {
    diff[field] = Math.max(0, numericRequestCounter(after, field) - numericRequestCounter(before, field));
  }
  return diff;
}

function providerRequestStatsMap(entries = []) {
  const map = new Map();
  for (const entry of asArray(entries)) {
    const provider = compactText(entry?.provider || 'unknown') || 'unknown';
    map.set(provider, entry);
  }
  return map;
}

function diffDiscoveryRequestStats(afterState = {}, beforeState = {}) {
  const beforeStats = beforeState.requestStats || {};
  const afterStats = afterState.requestStats || {};
  const beforeProviders = providerRequestStatsMap(beforeStats.byProvider || []);
  const afterProviders = providerRequestStatsMap(afterStats.byProvider || []);
  const providers = unique([...beforeProviders.keys(), ...afterProviders.keys()]).sort();
  const byProvider = providers
    .map((provider) => ({
      provider,
      ...diffRequestCounters(afterProviders.get(provider), beforeProviders.get(provider))
    }))
    .filter((entry) => entry.total || entry.cacheHits || entry.networkRequests || entry.cacheMisses);

  return {
    ...diffRequestCounters(afterStats, beforeStats),
    byProvider
  };
}

function resolveDiscoveryCacheEnabled(params = {}, ttlMs = 0) {
  if (params.discoveryRequestCache === false || params.discovery_request_cache === false) return false;
  if (params.discoveryRequestCache === true || params.discovery_request_cache === true) return true;
  return Number(ttlMs || 0) > 0;
}

function inferDiscoveryCacheMode(cacheStats = {}, enabled = false) {
  const total = Number(cacheStats.total || 0);
  if (!enabled) return 'disabled';
  if (!total) return 'enabled-no-live-requests';
  if (Number(cacheStats.cacheHits || 0) > 0 && Number(cacheStats.networkRequests || 0) === 0) return 'warm-cache';
  if (Number(cacheStats.cacheHits || 0) > 0 && Number(cacheStats.networkRequests || 0) > 0) return 'mixed-cache';
  if (Number(cacheStats.cacheMisses || 0) > 0 && Number(cacheStats.networkRequests || 0) > 0) return 'cold-cache';
  return 'enabled';
}

function pickParamWithName(params = {}, names = []) {
  for (const name of names) {
    const value = params[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return {
        value: String(value).trim(),
        source: `param:${name}`
      };
    }
  }
  return null;
}

function pickEnvWithName(env = process.env, names = []) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return {
        value: String(value).trim(),
        source: `env:${name}`
      };
    }
  }
  return null;
}

function credentialStatus(provider, resolved, extra = {}) {
  const value = String(resolved?.value || '').trim();
  return {
    provider,
    configured: Boolean(value),
    source: value ? resolved.source : '',
    hashPrefix: value ? stableHash(value, 8) : '',
    implemented: extra.implemented !== false,
    optional: extra.optional !== false
  };
}

function resolveOpenAlexCredential(params = {}) {
  const direct = pickParamWithName(params, [
    'openAlexApiKey',
    'openalexApiKey',
    'openalex_api_key',
    'apiKey'
  ]);
  if (direct) return direct;
  const fromEnv = pickEnvWithName(process.env, ['OPENALEX_API_KEY']);
  if (fromEnv) return fromEnv;
  try {
    const value = resolveOpenAlexApiKey(params);
    if (value) return { value, source: 'file:openalex_api_key' };
  } catch {
    return null;
  }
  return null;
}

function summarizeProviderCredentials(params = {}) {
  return [
    credentialStatus('openalex', resolveOpenAlexCredential(params)),
    credentialStatus('semantic_scholar', (
      pickParamWithName(params, ['semanticScholarApiKey', 'semantic_scholar_api_key', 's2ApiKey', 's2_api_key'])
      || pickEnvWithName(process.env, ['SEMANTIC_SCHOLAR_API_KEY', 'S2_API_KEY'])
    )),
    credentialStatus('core', (
      pickParamWithName(params, ['coreApiKey', 'core_api_key'])
      || pickEnvWithName(process.env, ['CORE_API_KEY'])
    )),
    credentialStatus('ieee_xplore', (
      pickParamWithName(params, ['ieeeApiKey', 'ieee_api_key', 'ieeeXploreApiKey', 'ieee_xplore_api_key'])
      || pickEnvWithName(process.env, ['IEEE_XPLORE_API_KEY', 'IEEE_API_KEY', 'IEEE_XPLORE_TOKEN'])
    ), { implemented: false })
  ];
}

function summarizeBenchmarkDiagnostics(results = []) {
  const evaluatedQueries = results.length;
  const zeroMatchQueries = results.filter((result) => result.relevantCount > 0 && !result.firstRelevantRank).length;
  const matchedQueries = results.filter((result) => result.firstRelevantRank > 0).length;
  const resultsWithGold = results.filter((result) => result.relevantCount > 0);
  const candidatePoolRecallValues = resultsWithGold.map((result) => (
    Math.min(1, Number(result.matchedCount || 0) / result.relevantCount)
  ));
  const citationExpansion = results.reduce((summary, result) => {
    const entry = result.discovery?.citationExpansion || {};
    summary.seeds += Number(entry.seeds || 0);
    summary.addedCandidates += Number(entry.addedCandidates || 0);
    summary.failedSeeds += Number(entry.failedSeeds || 0);
    return summary;
  }, { seeds: 0, addedCandidates: 0, failedSeeds: 0 });
  const queryAnalyses = results.map((result) => result.discovery?.queryAnalysis).filter(Boolean);
  const queryAnalysis = {
    enabledQueries: queryAnalyses.filter((entry) => entry.enabled).length,
    modes: unique(queryAnalyses.map((entry) => entry.mode).filter(Boolean)).sort(),
    sources: unique(queryAnalyses.map((entry) => entry.source).filter(Boolean)).sort(),
    averageAddedTokenCount: average(queryAnalyses.map((entry) => entry.addedTokenCount || 0)),
    errors: queryAnalyses.filter((entry) => entry.error).length
  };
  const providerFailures = aggregateProviderFailures(results);
  const goldMissReasons = aggregateGoldMissReasons(results);

  return {
    evaluatedQueries,
    queriesWithGold: resultsWithGold.length,
    matchedQueries,
    zeroMatchQueries,
    zeroMatchRate: evaluatedQueries ? zeroMatchQueries / evaluatedQueries : 0,
    candidatePoolRecall: average(candidatePoolRecallValues),
    averageQueryDurationMs: average(results.map((result) => result.durationMs || 0)),
    averageRetrievedCount: average(results.map((result) => result.retrievedCount)),
    averageRawCandidateCount: average(results.map((result) => result.discovery?.rawCandidateCount || 0)),
    averageMergedPaperCount: average(results.map((result) => result.discovery?.mergedPaperCount || 0)),
    averageDiscoveryQueryCount: average(results.map((result) => result.discovery?.plannedQueryCount || 0)),
    averageProviderCallCount: average(results.map((result) => result.discovery?.providerQueryCount || 0)),
    dedupMergeRate: average(results.map((result) => {
      const raw = Number(result.discovery?.rawCandidateCount || 0);
      const merged = Number(result.discovery?.mergedPaperCount || 0);
      return raw > 0 ? Math.max(0, raw - merged) / raw : 0;
    })),
    missedRelevantTotal: results.reduce((sum, result) => (
      sum + Number(result.unmatchedRelevantCount ?? (result.unmatchedRelevant || []).length)
    ), 0),
    goldMissReasons,
    providerFailuresTotal: providerFailures.reduce((sum, entry) => sum + entry.count, 0),
    providerFailures,
    citationExpansion,
    queryAnalysis
  };
}

function selectQueries(benchmark = {}, options = {}) {
  const limit = Math.max(0, Math.floor(Number(pickFirst(
    options.limit,
    options.benchmarkLimit,
    options.maxQueries,
    options.max_queries,
    0
  ))));
  const offset = Math.max(0, Math.floor(Number(options.offset || 0)));
  const queries = benchmark.queries || [];
  return (limit ? queries.slice(offset, offset + limit) : queries.slice(offset));
}

async function runWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.floor(Number(concurrency || 1))), Math.max(1, items.length)) },
    () => runWorker()
  ));
  return results;
}

function buildDiscoveryParams(queryCase = {}, options = {}) {
  return {
    rootPath: options.rootPath || process.cwd(),
    topic: queryCase.query,
    depth: options.depth || 'quick',
    discipline: options.discipline,
    queryDecomposition: options.queryDecomposition ?? options.query_decomposition,
    providers: options.providers,
    maxQueries: options.maxDiscoveryQueries || options.max_queries || options.discoveryQueries,
    maxResultsPerQuery: options.maxResultsPerQuery || options.max_results_per_query || 10,
    maxCandidates: options.maxCandidates || options.max_candidates || 50,
    providerConcurrency: options.providerConcurrency || options.provider_concurrency,
    timeoutMs: options.timeoutMs || options.timeout_ms,
    retryCount: options.retryCount ?? options.retry_count,
    retryBackoffMs: options.retryBackoffMs || options.retry_backoff_ms,
    mailto: options.mailto,
    coreApiKey: options.coreApiKey || options.core_api_key,
    resolveSources: options.resolveSources === true,
    allowDownloads: options.allowDownloads === true,
    citationExpansion: options.citationExpansion === true,
    persist: options.persistDiscoveryRuns === true
  };
}

function resolveFixedCorpusLimit(options = {}) {
  const limit = Math.floor(Number(pickFirst(
    options.fixedCorpusLimit,
    options.maxFixedCorpusResults,
    options.max_fixed_corpus_results,
    options.maxCandidates,
    DEFAULT_FIXED_CORPUS_LIMIT
  )));
  return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_FIXED_CORPUS_LIMIT;
}

function resolveFixedCorpusScanLimit(options = {}, resultLimit = DEFAULT_FIXED_CORPUS_LIMIT) {
  const fallback = Math.max(DEFAULT_FIXED_CORPUS_SCAN_LIMIT, resultLimit * 50);
  const limit = Math.floor(Number(pickFirst(
    options.fixedCorpusScanLimit,
    options.fixed_corpus_scan_limit,
    process.env.PAPERNEXUS_FIXED_CORPUS_SCAN_LIMIT,
    fallback
  )));
  return Number.isFinite(limit) && limit > 0 ? limit : fallback;
}

function resolveFixedCorpusQueryAnalysisExtraLimit(options = {}, scanLimit = DEFAULT_FIXED_CORPUS_SCAN_LIMIT, resultLimit = DEFAULT_FIXED_CORPUS_LIMIT) {
  const explicitRaw = [
    options.fixedCorpusQueryAnalysisExtraLimit,
    options.fixed_corpus_query_analysis_extra_limit
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  if (explicitRaw !== undefined) {
    const explicit = Math.floor(Number(explicitRaw));
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  const fallback = Math.max(resultLimit, Math.min(2000, Math.ceil(Number(scanLimit || 0) * 0.05)));
  return Number.isFinite(fallback) && fallback > 0 ? fallback : resultLimit;
}

function normalizeFixedCorpusRetrievalMode(options = {}) {
  const raw = pickFirst(
    options.fixedCorpusRetrievalMode,
    options.fixed_corpus_retrieval_mode,
    options.retrievalMode,
    options.retrieval_mode,
    'lexical'
  );
  const normalized = String(raw || 'lexical').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['dense', 'embedding', 'embeddings', 'dense-artifact'].includes(normalized)) return 'dense';
  if (['hybrid', 'rrf', 'hybrid-rrf', 'lexical-dense', 'dense-lexical'].includes(normalized)) return 'hybrid';
  if (['rerank', 'reranker', 'rerank-artifact', 'cross-encoder'].includes(normalized)) return 'rerank';
  if (['hybrid-rerank', 'rerank-hybrid', 'rrf-rerank', 'hybrid-rrf-rerank'].includes(normalized)) return 'hybrid-rerank';
  return 'lexical';
}

function resolveFixedCorpusRrfK(options = {}) {
  const value = Number(pickFirst(
    options.fixedCorpusRrfK,
    options.fixed_corpus_rrf_k,
    options.rrfK,
    options.rrf_k,
    60
  ));
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function fixedCorpusScorerName(options = {}) {
  const mode = normalizeFixedCorpusRetrievalMode(options);
  if (mode === 'dense') return 'dense-artifact-v1';
  if (mode === 'hybrid') return 'hybrid-rrf-v1';
  if (mode === 'rerank') return 'rerank-artifact-v1';
  if (mode === 'hybrid-rerank') return 'hybrid-rerank-v1';
  return 'hybrid-bm25-v1';
}

function resolveFixedCorpusDenseScoresPath(options = {}) {
  return compactText(pickFirst(
    options.fixedCorpusDenseScoresPath,
    options.fixed_corpus_dense_scores_path,
    options.fixedCorpusDenseScoresFile,
    options.fixed_corpus_dense_scores_file,
    options.fixedCorpusDenseScores,
    options.fixed_corpus_dense_scores
  ));
}

function resolveFixedCorpusRerankScoresPath(options = {}) {
  return compactText(pickFirst(
    options.fixedCorpusRerankScoresPath,
    options.fixed_corpus_rerank_scores_path,
    options.fixedCorpusRerankScoresFile,
    options.fixed_corpus_rerank_scores_file,
    options.fixedCorpusRerankScores,
    options.fixed_corpus_rerank_scores
  ));
}

function looksLikeNormalizedPaperRecord(paper = {}) {
  const record = asObject(paper);
  return Boolean(
    compactText(record.id)
    && record.identifiers
    && typeof record.identifiers === 'object'
    && !Array.isArray(record.identifiers)
    && (record.canonicalId || record.normalizedTitle || Array.isArray(record.identityAliases))
  );
}

function normalizeFixedCorpusRecord(paper = {}, index = 0) {
  return looksLikeNormalizedPaperRecord(paper)
    ? paper
    : normalizePaperRecord(paper, `fixed:${index}`);
}

function normalizeFixedCorpusRecords(corpus = []) {
  return asArray(corpus).map((paper, index) => normalizeFixedCorpusRecord(paper, index));
}

function buildFixedCorpusTitleFields(normalizedCorpus = []) {
  const compactTitles = normalizedCorpus.map((paper) => compactText(paper.title));
  return {
    compactTitles,
    compactTitleLowers: compactTitles.map((title) => title.toLowerCase())
  };
}

function summarizeFixedCorpusMemoryProfile(corpus = [], normalizedCorpus = [], fallback = {}) {
  return {
    fieldTokenSetsStored: false,
    combinedTokenSetsStored: false,
    reusedNormalizedRecords: normalizedCorpus.reduce((count, paper, index) => (
      paper === corpus[index] ? count + 1 : count
    ), 0),
    normalizedRecordCount: normalizedCorpus.length,
    ...fallback
  };
}

function buildFixedCorpusTokenIndexStats(normalizedCorpus = []) {
  const titleDf = new Map();
  const abstractDf = new Map();
  const combinedDf = new Map();
  const combinedInvertedIndex = new Map();
  const titleLengths = [];
  const abstractLengths = [];
  const combinedLengths = [];
  const titleUniqueCounts = [];
  const abstractUniqueCounts = [];
  let titleTokenTotal = 0;
  let abstractTokenTotal = 0;
  let combinedTokenTotal = 0;

  for (let index = 0; index < normalizedCorpus.length; index += 1) {
    const paper = normalizedCorpus[index] || {};
    const titleTokens = tokenizeWithoutStopwords(paper.title);
    const abstractTokens = tokenizeWithoutStopwords(paper.abstract);
    const titleTokenSet = new Set(titleTokens);
    const abstractTokenSet = new Set(abstractTokens);
    const combinedTokens = unique([...titleTokens, ...abstractTokens]);
    titleLengths[index] = titleTokens.length;
    abstractLengths[index] = abstractTokens.length;
    combinedLengths[index] = combinedTokens.length;
    titleUniqueCounts[index] = titleTokenSet.size;
    abstractUniqueCounts[index] = abstractTokenSet.size;
    titleTokenTotal += titleTokens.length;
    abstractTokenTotal += abstractTokens.length;
    combinedTokenTotal += combinedTokens.length;
    for (const token of titleTokenSet) {
      titleDf.set(token, (titleDf.get(token) || 0) + 1);
    }
    for (const token of abstractTokenSet) {
      abstractDf.set(token, (abstractDf.get(token) || 0) + 1);
    }
    for (const token of combinedTokens) {
      combinedDf.set(token, (combinedDf.get(token) || 0) + 1);
      const postings = combinedInvertedIndex.get(token);
      if (postings) {
        postings.push(index);
      } else {
        combinedInvertedIndex.set(token, [index]);
      }
    }
  }

  return {
    titleDf,
    abstractDf,
    combinedDf,
    combinedInvertedIndex,
    fieldTokenStats: {
      titleLengths,
      abstractLengths,
      combinedLengths,
      titleUniqueCounts,
      abstractUniqueCounts
    },
    avgTitleLength: titleTokenTotal / Math.max(1, normalizedCorpus.length),
    avgAbstractLength: abstractTokenTotal / Math.max(1, normalizedCorpus.length),
    avgCombinedLength: combinedTokenTotal / Math.max(1, normalizedCorpus.length)
  };
}

function buildFixedCorpusIndex(benchmark = {}, options = {}) {
  const corpus = asArray(options.fixedCorpus || benchmark.corpus);
  if (!corpus.length) {
    throw new Error(`Benchmark ${benchmark.name || benchmark.format || ''} does not include a local corpus. Use live mode or provide a corpus file.`);
  }

  const normalizedCorpus = normalizeFixedCorpusRecords(corpus);
  const {
    titleDf,
    abstractDf,
    combinedDf,
    combinedInvertedIndex,
    fieldTokenStats,
    avgTitleLength,
    avgAbstractLength,
    avgCombinedLength
  } = buildFixedCorpusTokenIndexStats(normalizedCorpus);
  const { compactTitles, compactTitleLowers } = buildFixedCorpusTitleFields(normalizedCorpus);
  const totalDocuments = normalizedCorpus.length;
  const stats = {
    totalDocuments,
    titleDf,
    abstractDf,
    combinedDf,
    avgTitleLength,
    avgAbstractLength,
    avgCombinedLength
  };

  return {
    corpus: normalizedCorpus,
    normalizedCorpus,
    titleTokenSets: null,
    abstractTokenSets: null,
    combinedTokenSets: null,
    combinedInvertedIndex,
    fieldTokenStats,
    compactTitles,
    compactTitleLowers,
    stats,
    memoryProfile: summarizeFixedCorpusMemoryProfile(corpus, normalizedCorpus),
    cache: {
      mode: 'in-memory-per-run',
      hit: false,
      key: null,
      path: null
    }
  };
}

function serializeMap(map = new Map()) {
  return [...map.entries()];
}

function deserializeMap(entries = []) {
  return new Map(Array.isArray(entries) ? entries : []);
}

function serializeFixedCorpusIndex(index = {}) {
  return {
    contractVersion: FIXED_CORPUS_INDEX_CACHE_VERSION,
    combinedInvertedIndex: serializeMap(index.combinedInvertedIndex),
    fieldTokenStats: index.fieldTokenStats || null,
    stats: {
      ...(index.stats || {}),
      titleDf: serializeMap(index.stats?.titleDf),
      abstractDf: serializeMap(index.stats?.abstractDf),
      combinedDf: serializeMap(index.stats?.combinedDf)
    },
    memoryProfile: {
      ...(index.memoryProfile || {}),
      normalizedRecordCount: index.normalizedCorpus?.length || index.memoryProfile?.normalizedRecordCount || null,
      corpusStoredInCache: false,
      compactTitleFieldsStoredInCache: false
    }
  };
}

function deserializeFixedCorpusIndex(payload = {}, cache = {}, benchmark = {}) {
  const sourceCorpus = asArray(benchmark.corpus).length
    ? asArray(benchmark.corpus)
    : asArray(payload.normalizedCorpus || payload.corpus);
  const normalizedCorpus = normalizeFixedCorpusRecords(sourceCorpus);
  const rebuiltStats = (
    !payload.combinedInvertedIndex
    || !payload.stats?.titleDf
    || !payload.stats?.abstractDf
    || !payload.stats?.combinedDf
  )
    ? buildFixedCorpusTokenIndexStats(normalizedCorpus)
    : null;
  const { compactTitles, compactTitleLowers } = buildFixedCorpusTitleFields(normalizedCorpus);
  return {
    corpus: normalizedCorpus,
    normalizedCorpus,
    titleTokenSets: payload.titleTokenSets || null,
    abstractTokenSets: payload.abstractTokenSets || null,
    combinedTokenSets: payload.combinedTokenSets || null,
    combinedInvertedIndex: rebuiltStats?.combinedInvertedIndex || deserializeMap(payload.combinedInvertedIndex),
    fieldTokenStats: payload.fieldTokenStats || rebuiltStats?.fieldTokenStats || null,
    compactTitles,
    compactTitleLowers,
    stats: {
      ...(payload.stats || {}),
      titleDf: rebuiltStats?.titleDf || deserializeMap(payload.stats?.titleDf),
      abstractDf: rebuiltStats?.abstractDf || deserializeMap(payload.stats?.abstractDf),
      combinedDf: rebuiltStats?.combinedDf || deserializeMap(payload.stats?.combinedDf),
      avgTitleLength: payload.stats?.avgTitleLength ?? rebuiltStats?.avgTitleLength ?? 0,
      avgAbstractLength: payload.stats?.avgAbstractLength ?? rebuiltStats?.avgAbstractLength ?? 0,
      avgCombinedLength: payload.stats?.avgCombinedLength ?? rebuiltStats?.avgCombinedLength ?? 0
    },
    memoryProfile: summarizeFixedCorpusMemoryProfile(sourceCorpus, normalizedCorpus, {
      ...(payload.memoryProfile || {}),
      fieldTokenSetsStored: Array.isArray(payload.titleTokenSets) || Array.isArray(payload.abstractTokenSets),
      combinedTokenSetsStored: Array.isArray(payload.combinedTokenSets),
      corpusStoredInCache: Array.isArray(payload.normalizedCorpus) || Array.isArray(payload.corpus),
      compactTitleFieldsStoredInCache: Array.isArray(payload.compactTitles) || Array.isArray(payload.compactTitleLowers)
    }),
    cache
  };
}

async function fixedCorpusSourceFingerprint(benchmark = {}, options = {}) {
  const sourcePath = compactText(pickFirst(options.corpusPath, benchmark.sourcePath));
  if (!sourcePath) return { sourcePath: null, size: null, mtimeMs: null };
  try {
    const stat = await fs.stat(sourcePath);
    return {
      sourcePath: path.resolve(sourcePath),
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs)
    };
  } catch {
    return {
      sourcePath: path.resolve(sourcePath),
      size: null,
      mtimeMs: null
    };
  }
}

async function fixedCorpusCacheKey(benchmark = {}, options = {}) {
  return stableHash(JSON.stringify({
    version: FIXED_CORPUS_INDEX_CACHE_VERSION,
    tokenizer: 'tokenizeWithoutStopwords-v1',
    scorer: 'hybrid-bm25-v1',
    corpusSize: benchmark.corpusSize || asArray(benchmark.corpus).length,
    source: await fixedCorpusSourceFingerprint(benchmark, options)
  }), 32);
}

async function loadOrBuildFixedCorpusIndex(benchmark = {}, options = {}) {
  const cacheDir = compactText(pickFirst(
    options.fixedCorpusCacheDir,
    options.fixed_corpus_cache_dir,
    process.env.PAPERNEXUS_FIXED_CORPUS_CACHE_DIR
  ));
  if (!cacheDir) return buildFixedCorpusIndex(benchmark, options);

  const key = await fixedCorpusCacheKey(benchmark, options);
  const cachePath = path.join(path.resolve(process.cwd(), cacheDir), `${key}.json`);
  let cacheReadError = null;
  let cached = null;
  try {
    cached = await readJson(cachePath, null);
  } catch (error) {
    cacheReadError = error?.message || String(error);
  }
  if (cached?.contractVersion === FIXED_CORPUS_INDEX_CACHE_VERSION) {
    return deserializeFixedCorpusIndex(cached, {
      mode: 'persistent',
      hit: true,
      key,
      path: cachePath
    }, benchmark);
  }

  const built = buildFixedCorpusIndex(benchmark, options);
  built.cache = {
    mode: 'persistent',
    hit: false,
    key,
    path: cachePath
  };
  try {
    await ensureDir(path.dirname(cachePath));
    await writeText(cachePath, `${JSON.stringify(serializeFixedCorpusIndex(built))}\n`);
  } catch (error) {
    built.cache = {
      mode: 'persistent-write-failed',
      hit: false,
      key,
      path: cachePath,
      error: [cacheReadError, error?.message || String(error)].filter(Boolean).join('; ')
    };
  }
  return built;
}

function summarizeFixedCorpusIndex(fixedCorpusIndex = null) {
  if (!fixedCorpusIndex) return null;
  return {
    enabled: true,
    mode: fixedCorpusIndex.cache?.mode || 'in-memory-per-run',
    cacheHit: Boolean(fixedCorpusIndex.cache?.hit),
    cacheKey: fixedCorpusIndex.cache?.key || null,
    cachePath: fixedCorpusIndex.cache?.path || null,
    cacheError: fixedCorpusIndex.cache?.error || null,
    corpusSize: fixedCorpusIndex.normalizedCorpus.length,
    titleDfTerms: fixedCorpusIndex.stats.titleDf.size,
    abstractDfTerms: fixedCorpusIndex.stats.abstractDf.size,
    combinedDfTerms: fixedCorpusIndex.stats.combinedDf.size,
    invertedTerms: fixedCorpusIndex.combinedInvertedIndex.size,
    fieldLengthStatsStored: Boolean(fixedCorpusIndex.fieldTokenStats?.titleLengths?.length),
    fieldTokenSetsStored: Boolean(fixedCorpusIndex.memoryProfile?.fieldTokenSetsStored),
    combinedTokenSetsStored: Boolean(fixedCorpusIndex.memoryProfile?.combinedTokenSetsStored),
    reusedNormalizedRecords: fixedCorpusIndex.memoryProfile?.reusedNormalizedRecords ?? null,
    avgTitleLength: fixedCorpusIndex.stats.avgTitleLength,
    avgAbstractLength: fixedCorpusIndex.stats.avgAbstractLength,
    avgCombinedLength: fixedCorpusIndex.stats.avgCombinedLength
  };
}

function fixedCorpusLookupKey(value = '') {
  return compactText(value).toLowerCase();
}

function fixedCorpusLookupKeyAliases(value = '') {
  const key = fixedCorpusLookupKey(value);
  if (!key) return [];
  const aliases = [key];
  const litsearchMatch = key.match(/^litsearch:(\d+)$/);
  const queryMatch = key.match(/^q(\d+)$/);
  if (litsearchMatch) aliases.push(`q${litsearchMatch[1]}`, litsearchMatch[1]);
  if (queryMatch) aliases.push(`litsearch:${queryMatch[1]}`, queryMatch[1]);
  if (/^d\d+$/.test(key)) aliases.push(key.slice(1));
  if (/^\d+$/.test(key)) aliases.push(`d${key}`);
  return unique(aliases);
}

function expandFixedCorpusLookupKeys(values = []) {
  return unique(values.flatMap((value) => fixedCorpusLookupKeyAliases(value)).filter(Boolean));
}

function fixedCorpusDocumentLookupKeys(paper = {}) {
  const identifiers = normalizePaperIdentifiers({
    ...asObject(paper.identifiers),
    ...paper
  });
  return expandFixedCorpusLookupKeys([
    ...collectMatchAliases(paper),
    ...collectIdentifierMatchKeys(paper),
    paper.normalizedTitle,
    paper.title,
    ...Object.entries(identifiers)
      .filter(([, value]) => compactText(value))
      .map(([field, value]) => `${field}:${compactText(value)}`)
  ].map(fixedCorpusLookupKey).filter(Boolean));
}

function buildFixedCorpusDocumentLookup(fixedCorpusIndex = {}) {
  const lookup = new Map();
  (fixedCorpusIndex.normalizedCorpus || []).forEach((paper, index) => {
    for (const key of fixedCorpusDocumentLookupKeys(paper)) {
      if (!lookup.has(key)) lookup.set(key, index);
    }
  });
  return lookup;
}

function fixedCorpusDenseQueryKeys(queryCase = {}) {
  const native = asObject(queryCase.metadata?.native);
  return expandFixedCorpusLookupKeys([
    queryCase.id,
    queryCase.query,
    queryCase.queryKey,
    native.id,
    native._id,
    native.qid,
    native.queryId,
    native.query_id,
    native.query,
    native.text,
    native.question
  ].map(fixedCorpusLookupKey).filter(Boolean));
}

function denseArtifactQueryKeys(entry = {}, fallbackKey = '') {
  const native = asObject(entry.metadata);
  return expandFixedCorpusLookupKeys([
    fallbackKey,
    entry.queryKey,
    entry.query_key,
    entry.queryId,
    entry.query_id,
    entry.id,
    entry._id,
    entry.qid,
    entry.query,
    entry.text,
    entry.question,
    native.queryKey,
    native.query_key,
    native.queryId,
    native.query_id,
    native.id,
    native.qid
  ].map(fixedCorpusLookupKey).filter(Boolean));
}

function denseArtifactDocumentKeys(entry = {}) {
  const paper = asObject(entry.paper || entry.document || entry.doc || entry.candidate);
  return expandFixedCorpusLookupKeys([
    entry.documentKey,
    entry.document_key,
    entry.documentId,
    entry.document_id,
    entry.docId,
    entry.doc_id,
    entry.corpusId,
    entry.corpus_id,
    entry.paperId,
    entry.paper_id,
    entry.id,
    entry._id,
    entry.title,
    paper.documentKey,
    paper.document_key,
    paper.documentId,
    paper.document_id,
    paper.docId,
    paper.doc_id,
    paper.corpusId,
    paper.corpus_id,
    paper.paperId,
    paper.paper_id,
    paper.id,
    paper._id,
    paper.title
  ].map(fixedCorpusLookupKey).filter(Boolean));
}

function denseArtifactRowsFromPayload(payload = {}) {
  if (Array.isArray(payload)) return payload.map((entry) => ({ entry, fallbackKey: '' }));
  const root = asObject(payload);
  const arrayEntries = [
    root.queries,
    root.results,
    root.items,
    root.data,
    Array.isArray(root.rankings) ? root.rankings : null
  ].find(Array.isArray);
  if (arrayEntries) return arrayEntries.map((entry) => ({ entry, fallbackKey: '' }));

  const rankingMap = asObject(root.rankings);
  if (Object.keys(rankingMap).length) {
    return Object.entries(rankingMap).map(([fallbackKey, rankings]) => ({
      entry: { queryId: fallbackKey, rankings },
      fallbackKey
    }));
  }

  return Object.entries(root)
    .filter(([key]) => !['contractVersion', 'method', 'model', 'createdAt', 'metadata'].includes(key))
    .map(([fallbackKey, value]) => ({
      entry: Array.isArray(value) ? { queryId: fallbackKey, rankings: value } : { queryId: fallbackKey, ...asObject(value) },
      fallbackKey
    }));
}

function denseArtifactRankingsFromEntry(entry = {}) {
  return [
    entry.rankings,
    entry.ranking,
    entry.candidates,
    entry.documents,
    entry.docs,
    entry.hits,
    entry.top,
    entry.results
  ].find(Array.isArray) || null;
}

function denseArtifactScore(entry = {}, fallbackRank = 0) {
  const score = Number(pickFirst(
    entry.score,
    entry.denseScore,
    entry.dense_score,
    entry.similarity,
    entry.cosine,
    entry.value
  ));
  if (Number.isFinite(score)) return score;
  return 1 / Math.max(1, fallbackRank + 1);
}

function denseArtifactRank(entry = {}, fallbackRank = 0) {
  const rank = Number(pickFirst(entry.rank, entry.position, entry.index));
  return Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : fallbackRank + 1;
}

async function readFixedCorpusRankingScorePayload(options = {}, artifactType = 'dense') {
  const isRerank = artifactType === 'rerank';
  const inlinePayload = isRerank
    ? pickFirst(options.fixedCorpusRerankScorePayload, options.fixed_corpus_rerank_score_payload)
    : pickFirst(options.fixedCorpusDenseScorePayload, options.fixed_corpus_dense_score_payload);
  if (inlinePayload && typeof inlinePayload === 'object') {
    return {
      payload: inlinePayload,
      path: null,
      source: 'inline'
    };
  }

  const configuredPath = isRerank
    ? resolveFixedCorpusRerankScoresPath(options)
    : resolveFixedCorpusDenseScoresPath(options);
  if (!configuredPath) return null;
  const absolutePath = path.resolve(process.cwd(), configuredPath);
  const payload = (absolutePath.endsWith('.jsonl') || absolutePath.endsWith('.ndjson'))
    ? await readJsonl(absolutePath)
    : await readJson(absolutePath, null);
  return {
    payload,
    path: absolutePath,
    source: 'file'
  };
}

async function loadFixedCorpusRankingScoreIndex(benchmark = {}, fixedCorpusIndex = {}, options = {}, artifactType = 'dense') {
  const payloadInfo = await readFixedCorpusRankingScorePayload(options, artifactType);
  if (!payloadInfo) {
    const flag = artifactType === 'rerank' ? '--fixed-corpus-rerank-scores <path>' : '--fixed-corpus-dense-scores <path>';
    throw new Error(`Fixed-corpus ${artifactType} retrieval requires ${flag}.`);
  }

  const documentLookup = buildFixedCorpusDocumentLookup(fixedCorpusIndex);
  const rankingsByQueryKey = new Map();
  const queryStats = new Map();
  let sourceRowCount = 0;
  let resolvedScoreCount = 0;
  let unresolvedScoreCount = 0;
  let resolvedQueryCount = 0;

  const addRankingRows = (queryKeys = [], rows = []) => {
    const normalizedQueryKeys = unique(queryKeys.map(fixedCorpusLookupKey).filter(Boolean));
    if (!normalizedQueryKeys.length) return;
    const resolvedRows = [];
    rows.forEach((row, fallbackRank) => {
      sourceRowCount += 1;
      const docKeys = denseArtifactDocumentKeys(row);
      const docIndex = docKeys.map((key) => documentLookup.get(key)).find((index) => index !== undefined);
      if (docIndex === undefined) {
        unresolvedScoreCount += 1;
        return;
      }
      resolvedScoreCount += 1;
      resolvedRows.push({
        index: docIndex,
        score: denseArtifactScore(row, fallbackRank),
        rank: denseArtifactRank(row, fallbackRank)
      });
    });
    if (!resolvedRows.length) return;
    resolvedQueryCount += 1;

    const sortedRows = resolvedRows
      .sort((left, right) => (
        (left.rank - right.rank)
        || (right.score - left.score)
        || (left.index - right.index)
      ));
    for (const key of normalizedQueryKeys) {
      rankingsByQueryKey.set(key, sortedRows);
      queryStats.set(key, {
        sourceRows: rows.length,
        resolvedRows: sortedRows.length
      });
    }
  };

  const flatRowsByQuery = new Map();
  for (const { entry, fallbackKey } of denseArtifactRowsFromPayload(payloadInfo.payload)) {
    const row = asObject(entry);
    const rankings = denseArtifactRankingsFromEntry(row);
    const queryKeys = denseArtifactQueryKeys(row, fallbackKey);
    if (rankings) {
      addRankingRows(queryKeys, rankings);
      continue;
    }
    if (denseArtifactDocumentKeys(row).length) {
      const key = queryKeys[0];
      if (!key) continue;
      if (!flatRowsByQuery.has(key)) flatRowsByQuery.set(key, { queryKeys, rows: [] });
      flatRowsByQuery.get(key).rows.push(row);
    }
  }
  for (const { queryKeys, rows } of flatRowsByQuery.values()) {
    addRankingRows(queryKeys, rows);
  }

  return {
    enabled: true,
    path: payloadInfo.path,
    source: payloadInfo.source,
    contractVersion: asObject(payloadInfo.payload).contractVersion || null,
    method: asObject(payloadInfo.payload).method || null,
    model: asObject(payloadInfo.payload).model || null,
    queryCount: resolvedQueryCount,
    queryKeyCount: rankingsByQueryKey.size,
    sourceRowCount,
    resolvedScoreCount,
    unresolvedScoreCount,
    rankingsByQueryKey,
    queryStats
  };
}

async function loadFixedCorpusDenseScoreIndex(benchmark = {}, fixedCorpusIndex = {}, options = {}) {
  return loadFixedCorpusRankingScoreIndex(benchmark, fixedCorpusIndex, options, 'dense');
}

async function loadFixedCorpusRerankScoreIndex(benchmark = {}, fixedCorpusIndex = {}, options = {}) {
  return loadFixedCorpusRankingScoreIndex(benchmark, fixedCorpusIndex, options, 'rerank');
}

function lookupFixedCorpusRanking(rankingIndex = null, queryCase = {}) {
  if (!rankingIndex?.enabled) return null;
  for (const key of fixedCorpusDenseQueryKeys(queryCase)) {
    const ranking = rankingIndex.rankingsByQueryKey.get(key);
    if (ranking) {
      return {
        key,
        ranking,
        stats: rankingIndex.queryStats.get(key) || null
      };
    }
  }
  return null;
}

function lookupFixedCorpusDenseRanking(denseIndex = null, queryCase = {}) {
  return lookupFixedCorpusRanking(denseIndex, queryCase);
}

function lookupFixedCorpusRerankRanking(rerankIndex = null, queryCase = {}) {
  return lookupFixedCorpusRanking(rerankIndex, queryCase);
}

function summarizeFixedCorpusRankingIndex(rankingIndex = null) {
  if (!rankingIndex) return null;
  return {
    enabled: true,
    source: rankingIndex.source || null,
    path: rankingIndex.path || null,
    contractVersion: rankingIndex.contractVersion || null,
    method: rankingIndex.method || null,
    model: rankingIndex.model || null,
    queryCount: rankingIndex.queryCount || 0,
    queryKeyCount: rankingIndex.queryKeyCount || 0,
    sourceRowCount: rankingIndex.sourceRowCount || 0,
    resolvedScoreCount: rankingIndex.resolvedScoreCount || 0,
    unresolvedScoreCount: rankingIndex.unresolvedScoreCount || 0
  };
}

function summarizeFixedCorpusDenseIndex(denseIndex = null) {
  return summarizeFixedCorpusRankingIndex(denseIndex);
}

function summarizeFixedCorpusRerankIndex(rerankIndex = null) {
  return summarizeFixedCorpusRankingIndex(rerankIndex);
}

function buildFixedCorpusRankingCandidates(fixedCorpusIndex = {}, rankingMatch = null, queryCase = {}, options = {}, artifactType = 'dense') {
  const limit = resolveFixedCorpusLimit(options);
  const sourcePaperId = queryCase.metadata?.sourcePaperId || '';
  const normalizedCorpus = fixedCorpusIndex.normalizedCorpus || [];
  const candidates = [];
  const seen = new Set();
  const scoreField = artifactType === 'rerank' ? 'rerankScore' : 'denseScore';
  const rankField = artifactType === 'rerank' ? 'rerankRank' : 'denseRank';
  const sourceProvider = artifactType === 'rerank' ? 'fixed_corpus_rerank' : 'fixed_corpus_dense';
  for (const entry of rankingMatch?.ranking || []) {
    const paper = normalizedCorpus[entry.index];
    if (!paper) continue;
    if (sourcePaperId && [paper.id, paper.canonicalId].includes(sourcePaperId)) continue;
    const key = paper.canonicalId || paper.id || paper.normalizedTitle || String(entry.index);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...paper,
      score: entry.score,
      [scoreField]: entry.score,
      [rankField]: entry.rank,
      sourceProvider
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function buildDenseFixedCorpusCandidates(fixedCorpusIndex = {}, denseMatch = null, queryCase = {}, options = {}) {
  return buildFixedCorpusRankingCandidates(fixedCorpusIndex, denseMatch, queryCase, options, 'dense');
}

function buildRerankFixedCorpusCandidates(fixedCorpusIndex = {}, rerankMatch = null, queryCase = {}, options = {}) {
  return buildFixedCorpusRankingCandidates(fixedCorpusIndex, rerankMatch, queryCase, options, 'rerank');
}

function fixedCorpusCandidateFusionKey(candidate = {}) {
  return fixedCorpusLookupKey(candidate.canonicalId || candidate.id || candidate.normalizedTitle || candidate.title);
}

function reciprocalRankScore(rank = 0, k = 60) {
  return rank > 0 ? 1 / (k + rank) : 0;
}

function fuseFixedCorpusCandidatesWithRrf(lexicalCandidates = [], denseCandidates = [], options = {}) {
  const limit = resolveFixedCorpusLimit(options);
  const rrfK = resolveFixedCorpusRrfK(options);
  const byKey = new Map();
  const addCandidates = (candidates = [], channel = 'lexical') => {
    candidates.forEach((candidate, index) => {
      const key = fixedCorpusCandidateFusionKey(candidate);
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, {
          candidate,
          lexicalRank: null,
          denseRank: null,
          lexicalScore: null,
          denseScore: null,
          score: 0
        });
      }
      const record = byKey.get(key);
      const rank = index + 1;
      record.score += reciprocalRankScore(rank, rrfK);
      if (channel === 'lexical') {
        record.lexicalRank = rank;
        record.lexicalScore = candidate.score ?? null;
      } else {
        record.denseRank = rank;
        record.denseScore = candidate.denseScore ?? candidate.score ?? null;
      }
    });
  };
  addCandidates(lexicalCandidates, 'lexical');
  addCandidates(denseCandidates, 'dense');

  return [...byKey.values()]
    .sort((left, right) => (
      (right.score - left.score)
      || ((left.denseRank || Number.MAX_SAFE_INTEGER) - (right.denseRank || Number.MAX_SAFE_INTEGER))
      || ((left.lexicalRank || Number.MAX_SAFE_INTEGER) - (right.lexicalRank || Number.MAX_SAFE_INTEGER))
    ))
    .slice(0, limit)
    .map((record) => ({
      ...record.candidate,
      score: record.score,
      sourceProvider: 'fixed_corpus_hybrid_rrf',
      retrievalSignals: {
        lexicalRank: record.lexicalRank,
        denseRank: record.denseRank,
        lexicalScore: record.lexicalScore,
        denseScore: record.denseScore,
        rrfK
      }
    }));
}

function applyFixedCorpusRerankCandidates(baseCandidates = [], rerankCandidates = [], options = {}) {
  const limit = resolveFixedCorpusLimit(options);
  const rerankByKey = new Map();
  rerankCandidates.forEach((candidate, index) => {
    const key = fixedCorpusCandidateFusionKey(candidate);
    if (!key || rerankByKey.has(key)) return;
    rerankByKey.set(key, {
      rank: candidate.rerankRank || index + 1,
      score: candidate.rerankScore ?? candidate.score ?? null
    });
  });

  return baseCandidates
    .map((candidate, index) => {
      const rerank = rerankByKey.get(fixedCorpusCandidateFusionKey(candidate));
      return {
        candidate,
        baseRank: index + 1,
        rerankRank: rerank?.rank || null,
        rerankScore: rerank?.score ?? null
      };
    })
    .sort((left, right) => {
      const leftMatched = left.rerankRank !== null;
      const rightMatched = right.rerankRank !== null;
      if (leftMatched !== rightMatched) return leftMatched ? -1 : 1;
      if (leftMatched && rightMatched) {
        return (
          (left.rerankRank - right.rerankRank)
          || ((right.rerankScore ?? -Infinity) - (left.rerankScore ?? -Infinity))
          || (left.baseRank - right.baseRank)
        );
      }
      return left.baseRank - right.baseRank;
    })
    .slice(0, limit)
    .map((record) => ({
      ...record.candidate,
      score: record.rerankScore ?? record.candidate.score,
      sourceProvider: 'fixed_corpus_hybrid_rerank',
      retrievalSignals: {
        ...(record.candidate.retrievalSignals || {}),
        baseRank: record.baseRank,
        rerankRank: record.rerankRank,
        rerankScore: record.rerankScore
      }
    }));
}

function resolveFixedCorpusCandidateIndexes(fixedCorpusIndex = {}, queryTokens = [], limit = DEFAULT_FIXED_CORPUS_LIMIT, scanLimit = DEFAULT_FIXED_CORPUS_SCAN_LIMIT, options = {}) {
  const normalizedCorpus = fixedCorpusIndex.normalizedCorpus || [];
  const invertedIndex = fixedCorpusIndex.combinedInvertedIndex || new Map();
  const combinedDf = fixedCorpusIndex.stats?.combinedDf || new Map();
  const allowFallback = options.fallback !== false;
  const candidateIndexes = new Set();
  const sortedQueryTokens = [...new Set(queryTokens || [])]
    .sort((left, right) => (combinedDf.get(left) || Number.MAX_SAFE_INTEGER) - (combinedDf.get(right) || Number.MAX_SAFE_INTEGER));
  for (const token of sortedQueryTokens) {
    const postings = invertedIndex.get(token);
    if (!postings) continue;
    for (const index of postings) {
      candidateIndexes.add(index);
      if (scanLimit && candidateIndexes.size >= scanLimit) break;
    }
    if (scanLimit && candidateIndexes.size >= scanLimit) break;
  }

  if (!candidateIndexes.size) {
    if (!allowFallback) return [];
    return normalizedCorpus.map((_, index) => index);
  }

  if (allowFallback && candidateIndexes.size < limit) {
    for (let index = 0; index < normalizedCorpus.length && candidateIndexes.size < limit; index += 1) {
      candidateIndexes.add(index);
    }
  }

  return [...candidateIndexes];
}

function scoreFixedCorpusCandidate(queryCase = {}, paper = {}, stats = {}, prepared = {}) {
  const queryTokens = prepared.queryTokens || tokenizeWithoutStopwords(queryCase.query);
  const queryTokenSet = prepared.queryTokenSet || new Set(queryTokens);
  const titleMatch = prepared.titleMatch || summarizeQueryTokenMatches(paper.title, queryTokenSet, {
    length: prepared.titleLength,
    uniqueCount: prepared.titleUniqueCount
  });
  const abstractMatch = prepared.abstractMatch || summarizeQueryTokenMatches(paper.abstract, queryTokenSet, {
    length: prepared.abstractLength,
    uniqueCount: prepared.abstractUniqueCount
  });
  const combinedMatch = prepared.combinedMatch || combineQueryTokenMatches(titleMatch, abstractMatch, {
    length: prepared.combinedLength,
    uniqueCount: prepared.combinedLength
  });
  const queryIdentifiers = prepared.queryIdentifiers || normalizePaperIdentifiers({
    ...asObject(queryCase.metadata?.identifiers),
    ...asObject(queryCase.metadata?.sourceIdentifiers),
    ...asObject(queryCase.metadata?.native?.identifiers)
  });
  const compactQuery = prepared.compactQuery ?? compactText(queryCase.query);
  const compactTitle = prepared.compactTitle ?? compactText(paper.title);
  const compactQueryLower = prepared.compactQueryLower ?? compactQuery.toLowerCase();
  const compactTitleLower = prepared.compactTitleLower ?? compactTitle.toLowerCase();
  const titleOverlap = scoreMatchedTokenOverlap(queryTokens, titleMatch.matched);
  const abstractOverlap = scoreMatchedTokenOverlap(queryTokens, abstractMatch.matched);
  const combinedOverlap = scoreMatchedTokenOverlap(queryTokens, combinedMatch.matched);
  const titleSimilarityScore = scorePreparedTitleSimilarity(queryTokenSet, titleMatch);
  const bm25Title = bm25FieldScore(queryTokens, [], stats.titleDf, stats.totalDocuments, stats.avgTitleLength, titleMatch.counts, titleMatch.length);
  const bm25Abstract = bm25FieldScore(queryTokens, [], stats.abstractDf, stats.totalDocuments, stats.avgAbstractLength, abstractMatch.counts, abstractMatch.length);
  const bm25Combined = bm25FieldScore(queryTokens, [], stats.combinedDf, stats.totalDocuments, stats.avgCombinedLength, combinedMatch.counts, combinedMatch.length);
  const exactTitleMatch = compactQueryLower === compactTitleLower ? 2.5 : 0;
  const phraseMatch = compactQuery
    && compactTitle
    && compactTitleLower.includes(compactQueryLower)
      ? 1.5
      : 0;
  const facet = queryCase.metadata?.facet || '';
  const facetBoost = facet ? scoreFacetAwareBoost(facet, paper) : 0;
  const identifierBoost = paperIdentifiersOverlap(queryIdentifiers, paper.identifiers) ? 2.5 : 0;
  const queryAnalysisBoost = scoreFixedCorpusQueryAnalysisBoost(prepared.queryAnalysis, titleMatch, abstractMatch);
  return (
    (titleOverlap * 2.5)
    + (abstractOverlap * 1.25)
    + (combinedOverlap * 1.5)
    + titleSimilarityScore
    + (bm25Title * 2.25)
    + (bm25Abstract * 1.5)
    + (bm25Combined * 1)
    + exactTitleMatch
    + phraseMatch
    + facetBoost
    + identifierBoost
    + queryAnalysisBoost
  );
}

function isWorseFixedCorpusTopCandidate(candidate = {}, reference = null) {
  return (
    !reference
    || candidate.score < reference.score
    || (candidate.score === reference.score && candidate.__candidateOrder > reference.__candidateOrder)
  );
}

function findWorstFixedCorpusTopCandidate(candidates = []) {
  let worstIndex = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const worst = worstIndex >= 0 ? candidates[worstIndex] : null;
    if (isWorseFixedCorpusTopCandidate(candidate, worst)) {
      worstIndex = index;
    }
  }
  return worstIndex;
}

function fixedCorpusTopCandidateReplacementIndex(topCandidates = [], score = 0, limit = DEFAULT_FIXED_CORPUS_LIMIT, worstIndex = -1) {
  if (topCandidates.length < limit) return topCandidates.length;
  const resolvedWorstIndex = worstIndex >= 0 && worstIndex < topCandidates.length
    ? worstIndex
    : findWorstFixedCorpusTopCandidate(topCandidates);
  const worst = topCandidates[resolvedWorstIndex];
  return !worst || score > worst.score ? resolvedWorstIndex : -1;
}

function rankFixedCorpusTopCandidates(candidates = []) {
  return candidates
    .sort((left, right) => (
      (right.score - left.score)
      || ((left.__candidateOrder || 0) - (right.__candidateOrder || 0))
    ))
    .map(({ __candidateOrder, ...candidate }) => candidate);
}

async function buildFixedCorpusCandidates(benchmark = {}, queryCase = {}, options = {}) {
  const fixedCorpusIndex = options.fixedCorpusIndex || buildFixedCorpusIndex(benchmark, options);
  const sourcePaperId = queryCase.metadata?.sourcePaperId || '';
  const limit = resolveFixedCorpusLimit(options);
  const scanLimit = resolveFixedCorpusScanLimit(options, limit);
  const retrievalMode = normalizeFixedCorpusRetrievalMode(options);
  const queryAnalysis = await buildFixedCorpusQueryAnalysis(queryCase, options);
  const queryTokens = tokenizeWithoutStopwords(queryCase.query);
  const queryIdentifiers = normalizePaperIdentifiers({
    ...asObject(queryCase.metadata?.identifiers),
    ...asObject(queryCase.metadata?.sourceIdentifiers),
    ...asObject(queryCase.metadata?.native?.identifiers)
  });
  const compactQuery = compactText(queryCase.query);
  const compactQueryLower = compactQuery.toLowerCase();
  const {
    normalizedCorpus,
    compactTitles,
    compactTitleLowers,
    fieldTokenStats,
    stats
  } = fixedCorpusIndex;
  const denseMatch = lookupFixedCorpusDenseRanking(options.fixedCorpusDenseIndex, queryCase);
  const rerankMatch = lookupFixedCorpusRerankRanking(options.fixedCorpusRerankIndex, queryCase);
  if (retrievalMode === 'dense') {
    const denseRanked = buildDenseFixedCorpusCandidates(fixedCorpusIndex, denseMatch, queryCase, options);
    denseRanked.queryAnalysis = {
      enabled: queryAnalysis.enabled,
      mode: queryAnalysis.mode,
      source: queryAnalysis.source,
      originalTokenCount: queryAnalysis.originalTokenCount,
      expandedTokenCount: queryAnalysis.expandedTokenCount,
      addedTokenCount: queryAnalysis.addedTokenCount,
      addedTokens: queryAnalysis.addedTokens,
      error: queryAnalysis.error
    };
    denseRanked.retrieval = {
      mode: retrievalMode,
      scorer: fixedCorpusScorerName(options),
      lexicalCandidateCount: 0,
      denseCandidateCount: denseRanked.length,
      denseQueryMatched: Boolean(denseMatch),
      denseQueryKey: denseMatch?.key || null,
      denseSourceRows: denseMatch?.stats?.sourceRows ?? null,
      denseResolvedRows: denseMatch?.stats?.resolvedRows ?? null,
      rerankCandidateCount: 0,
      rerankQueryMatched: null,
      rerankQueryKey: null,
      rerankSourceRows: null,
      rerankResolvedRows: null,
      rrfK: null
    };
    return denseRanked;
  }
  if (retrievalMode === 'rerank') {
    const rerankRanked = buildRerankFixedCorpusCandidates(fixedCorpusIndex, rerankMatch, queryCase, options);
    rerankRanked.queryAnalysis = {
      enabled: queryAnalysis.enabled,
      mode: queryAnalysis.mode,
      source: queryAnalysis.source,
      originalTokenCount: queryAnalysis.originalTokenCount,
      expandedTokenCount: queryAnalysis.expandedTokenCount,
      addedTokenCount: queryAnalysis.addedTokenCount,
      addedTokens: queryAnalysis.addedTokens,
      error: queryAnalysis.error
    };
    rerankRanked.retrieval = {
      mode: retrievalMode,
      scorer: fixedCorpusScorerName(options),
      lexicalCandidateCount: 0,
      denseCandidateCount: 0,
      denseQueryMatched: null,
      denseQueryKey: null,
      denseSourceRows: null,
      denseResolvedRows: null,
      rerankCandidateCount: rerankRanked.length,
      rerankQueryMatched: Boolean(rerankMatch),
      rerankQueryKey: rerankMatch?.key || null,
      rerankSourceRows: rerankMatch?.stats?.sourceRows ?? null,
      rerankResolvedRows: rerankMatch?.stats?.resolvedRows ?? null,
      rrfK: null
    };
    return rerankRanked;
  }
  const baseCandidateIndexes = resolveFixedCorpusCandidateIndexes(fixedCorpusIndex, queryTokens, limit, scanLimit);
  const candidateIndexes = new Set(baseCandidateIndexes);
  if (queryAnalysis.enabled && queryAnalysis.addedTokens?.length) {
    const extraLimit = resolveFixedCorpusQueryAnalysisExtraLimit(options, scanLimit, limit);
    const expansionCandidateIndexes = resolveFixedCorpusCandidateIndexes(
      fixedCorpusIndex,
      queryAnalysis.addedTokens,
      limit,
      extraLimit,
      { fallback: false }
    );
    for (const index of expansionCandidateIndexes) {
      candidateIndexes.add(index);
    }
  }
  const queryTokenSet = new Set(queryTokens);
  const topCandidates = [];
  let worstTopCandidateIndex = -1;
  [...candidateIndexes].forEach((index, candidateOrder) => {
    const paper = normalizedCorpus[index];
    if (sourcePaperId && [paper.id, paper.canonicalId].includes(sourcePaperId)) return;
    const score = scoreFixedCorpusCandidate(queryCase, paper, stats, {
      queryTokens,
      queryTokenSet,
      queryIdentifiers,
      compactQuery,
      compactQueryLower,
      compactTitle: compactTitles[index],
      compactTitleLower: compactTitleLowers[index],
      titleLength: fieldTokenStats?.titleLengths?.[index],
      abstractLength: fieldTokenStats?.abstractLengths?.[index],
      combinedLength: fieldTokenStats?.combinedLengths?.[index],
      titleUniqueCount: fieldTokenStats?.titleUniqueCounts?.[index],
      abstractUniqueCount: fieldTokenStats?.abstractUniqueCounts?.[index],
      queryAnalysis
    });
    const wasFull = topCandidates.length >= limit;
    const replacementIndex = fixedCorpusTopCandidateReplacementIndex(topCandidates, score, limit, worstTopCandidateIndex);
    if (replacementIndex < 0) return;
    const candidate = {
      ...paper,
      __candidateOrder: candidateOrder,
      score,
      sourceProvider: 'fixed_corpus'
    };
    topCandidates[replacementIndex] = candidate;
    if (!wasFull && topCandidates.length < limit) {
      const worst = worstTopCandidateIndex >= 0 ? topCandidates[worstTopCandidateIndex] : null;
      if (isWorseFixedCorpusTopCandidate(candidate, worst)) {
        worstTopCandidateIndex = replacementIndex;
      }
    } else {
      worstTopCandidateIndex = findWorstFixedCorpusTopCandidate(topCandidates);
    }
  });

  const lexicalRanked = rankFixedCorpusTopCandidates(topCandidates);
  const denseRanked = ['hybrid', 'hybrid-rerank'].includes(retrievalMode)
    ? buildDenseFixedCorpusCandidates(fixedCorpusIndex, denseMatch, queryCase, options)
    : [];
  const hybridRanked = ['hybrid', 'hybrid-rerank'].includes(retrievalMode)
    ? fuseFixedCorpusCandidatesWithRrf(lexicalRanked, denseRanked, options)
    : lexicalRanked;
  const rerankRanked = retrievalMode === 'hybrid-rerank'
    ? buildRerankFixedCorpusCandidates(fixedCorpusIndex, rerankMatch, queryCase, options)
    : [];
  const ranked = retrievalMode === 'hybrid-rerank'
    ? applyFixedCorpusRerankCandidates(hybridRanked, rerankRanked, options)
    : hybridRanked;
  ranked.queryAnalysis = {
    enabled: queryAnalysis.enabled,
    mode: queryAnalysis.mode,
    source: queryAnalysis.source,
    originalTokenCount: queryAnalysis.originalTokenCount,
    expandedTokenCount: queryAnalysis.expandedTokenCount,
    addedTokenCount: queryAnalysis.addedTokenCount,
    addedTokens: queryAnalysis.addedTokens,
    error: queryAnalysis.error
  };
  ranked.retrieval = {
    mode: retrievalMode,
    scorer: fixedCorpusScorerName(options),
    lexicalCandidateCount: lexicalRanked.length,
    denseCandidateCount: denseRanked.length,
    denseQueryMatched: ['hybrid', 'hybrid-rerank'].includes(retrievalMode) ? Boolean(denseMatch) : null,
    denseQueryKey: denseMatch?.key || null,
    denseSourceRows: denseMatch?.stats?.sourceRows ?? null,
    denseResolvedRows: denseMatch?.stats?.resolvedRows ?? null,
    rerankCandidateCount: rerankRanked.length,
    rerankQueryMatched: retrievalMode === 'hybrid-rerank' ? Boolean(rerankMatch) : null,
    rerankQueryKey: rerankMatch?.key || null,
    rerankSourceRows: rerankMatch?.stats?.sourceRows ?? null,
    rerankResolvedRows: rerankMatch?.stats?.resolvedRows ?? null,
    rrfK: ['hybrid', 'hybrid-rerank'].includes(retrievalMode) ? resolveFixedCorpusRrfK(options) : null
  };
  return ranked;
}

function benchmarkAlignment(benchmark = {}, config = {}) {
  const format = canonicalBenchmarkFormat(benchmark.format || 'custom');
  const profile = benchmark.profile || benchmarkProfile(format);
  const evaluationMode = normalizeEvaluationMode(config.evaluationMode);
  const taskEvaluationMode = String(config.taskEvaluationMode || 'rules').trim().toLowerCase();
  const hasFixedCorpus = Number(benchmark.corpusSize || 0) > 0 || asArray(benchmark.corpus).length > 0;
  const hasGoldTargets = asArray(benchmark.queries).some((query) => (
    query?.relevant?.length
    || query?.metadata?.hasTaskEvaluationTarget
    || query?.goldRelations?.length
  ));
  const officialStyle = profile.evaluationStyle || 'custom_relevance_set';
  const limitations = [];
  if (evaluationMode === 'live') {
    limitations.push('Uses live provider discovery, so scores measure PaperNexus real-world discovery rather than closed-corpus leaderboard ranking.');
  }
  if (['scholarqa', 'paperask'].includes(format) && taskEvaluationMode !== 'llm') {
    limitations.push('Uses rule-based task metrics only. Use --task-evaluation llm --generate-task-answers true to score answer correctness, grounding, and citation faithfulness.');
  }
  if (format === 'scinetbench' && taskEvaluationMode !== 'llm') {
    limitations.push('Uses structured relation/path overlap only. Use --task-evaluation llm to judge relation reasoning quality from retrieved evidence.');
  }
  if (format === 'scinetbench' && !hasGoldTargets) {
    limitations.push('Loaded query-only SciNetBench prompts. Official SciNetBench accuracy requires its evaluation scripts plus relation/citation ground truth or OpenAlex database artifacts.');
  }
  if (format === 'scholarqa') {
    limitations.push('Official ScholarQABench comparability requires its citation_correctness_eval.py, rubric_eval.py, and Prometheus evaluators. PaperNexus reports internal rule/LLM approximations unless those scripts are run externally.');
  }
  if (format === 'paperask') {
    limitations.push('PaperAsk currently publishes benchmark cases and sample outputs, while official evaluation scripts and reliability classifier are still marked coming soon upstream. PaperNexus reports schema-aligned diagnostic metrics.');
  }
  if (format === 'scinetbench') {
    limitations.push('Official SciNetBench metrics require the upstream Evaluation/*.py scripts and OpenAlex/relation database artifacts. PaperNexus relation metrics are approximate unless those artifacts are integrated externally.');
  }
  if (format === 'csfcube' && !hasFixedCorpus) {
    limitations.push('CSFCube is strongest in fixed-corpus faceted mode; provide the corpus metadata for official-style ranking.');
  }
  const usesExternalOfficialEvaluator = ['scholarqa', 'paperask', 'scinetbench'].includes(format);
  return {
    format,
    taskType: profile.taskType,
    evaluationStyle: officialStyle,
    evaluationMode,
    hasFixedCorpus,
    nativeMetrics: profile.nativeMetrics,
    officialComparable: evaluationMode === 'fixed-corpus' && hasFixedCorpus && !usesExternalOfficialEvaluator,
    taskEvaluationMode,
    limitations
  };
}

function summarizeBenchmark(benchmark = {}, selectedQueries = []) {
  const relevantCounts = selectedQueries.map((query) => query.relevant.length);
  const taskTypes = unique(selectedQueries.map((query) => query.metadata?.taskType).filter(Boolean));
  return {
    name: benchmark.name,
    format: benchmark.format,
    profile: benchmark.profile || benchmarkProfile(benchmark.format || 'custom'),
    sourcePath: benchmark.sourcePath,
    loadedQueries: benchmark.queryCount,
    evaluatedQueries: selectedQueries.length,
    relevantPapers: relevantCounts.reduce((sum, count) => sum + count, 0),
    corpusSize: benchmark.corpusSize || asArray(benchmark.corpus).length,
    taskTypes,
    minRelevantPerQuery: relevantCounts.length ? Math.min(...relevantCounts) : 0,
    maxRelevantPerQuery: relevantCounts.length ? Math.max(...relevantCounts) : 0
  };
}

export async function runRetrievalBenchmark(params = {}) {
  const benchmark = params.benchmark || await loadRetrievalBenchmark(params.datasetPath, params);
  const selectedQueries = selectQueries(benchmark, params);
  const cutoffs = normalizeCutoffs(params.cutoffs || params.k);
  const runDiscovery = params.runDiscovery || runLiteratureDiscovery;
  const evaluationMode = normalizeEvaluationMode(params.evaluationMode || params.evaluation_mode || params.mode);
  const taskEvaluationMode = String(params.taskEvaluation || params.task_evaluation || 'rules').trim().toLowerCase();
  const startedAt = new Date().toISOString();
  const onProgress = typeof params.onProgress === 'function' ? params.onProgress : null;
  const artifactRun = await prepareRetrievalBenchmarkArtifacts(params, benchmark, selectedQueries, startedAt);
  const resumedResultsByKey = await readCompletedRetrievalBenchmarkResults(artifactRun);
  const completedBeforeRun = resumedResultsByKey.size;
  const pendingQueries = selectedQueries.filter((queryCase, index) => (
    !resumedResultsByKey.has(benchmarkQueryKey(queryCase, index))
  ));
  const continueOnError = resolveBooleanOption(
    pickFirst(params.continueOnError, params.continue_on_error),
    Boolean(artifactRun)
  );
  const discoveryRequestStateBefore = readDiscoveryRequestSchedulerState();
  const fixedCorpusIndex = evaluationMode === 'fixed-corpus'
    ? await loadOrBuildFixedCorpusIndex(benchmark, params)
    : null;
  const fixedCorpusRetrievalMode = evaluationMode === 'fixed-corpus'
    ? normalizeFixedCorpusRetrievalMode(params)
    : null;
  const fixedCorpusDenseIndex = evaluationMode === 'fixed-corpus' && ['dense', 'hybrid', 'hybrid-rerank'].includes(fixedCorpusRetrievalMode)
    ? await loadFixedCorpusDenseScoreIndex(benchmark, fixedCorpusIndex, params)
    : null;
  const fixedCorpusRerankIndex = evaluationMode === 'fixed-corpus' && ['rerank', 'hybrid-rerank'].includes(fixedCorpusRetrievalMode)
    ? await loadFixedCorpusRerankScoreIndex(benchmark, fixedCorpusIndex, params)
    : null;

  await writeRetrievalBenchmarkCheckpoint(artifactRun, {
    status: 'running',
    totalQueries: selectedQueries.length,
    completedQueries: completedBeforeRun,
    pendingQueries: pendingQueries.length,
    failedQueries: 0,
    resumedFrom: artifactRun?.resume ? artifactRun.runId : null
  });

  const newResults = await runWithConcurrency(
    pendingQueries,
    params.benchmarkConcurrency || params.concurrency || 1,
    async (queryCase, index) => {
      const queryStartedAt = Date.now();
      const selectedIndex = selectedQueries.findIndex((candidate) => candidate === queryCase);
      const queryKey = benchmarkQueryKey(queryCase, selectedIndex >= 0 ? selectedIndex : index);
      const officialSlice = classifyOfficialBenchmarkSlice(benchmark, queryCase);
      onProgress?.({
        completed: completedBeforeRun + index,
        total: selectedQueries.length,
        queryId: queryCase.id,
        query: queryCase.query,
        phase: 'running'
      });
      try {
        const fixedCorpusCandidates = evaluationMode === 'fixed-corpus'
          ? await buildFixedCorpusCandidates(benchmark, queryCase, {
            ...params,
            fixedCorpusIndex,
            fixedCorpusDenseIndex,
            fixedCorpusRerankIndex
          })
          : null;
        const discoveryRun = evaluationMode === 'fixed-corpus'
          ? {
            runId: null,
            providers: ['fixed_corpus'],
            rawCandidateCount: benchmark.corpusSize || asArray(benchmark.corpus).length,
            candidates: fixedCorpusCandidates,
            coverage: null,
            artifacts: null,
            queryResults: [],
            queryAnalysis: fixedCorpusCandidates?.queryAnalysis || null,
            retrieval: fixedCorpusCandidates?.retrieval || null
          }
          : await runDiscovery(buildDiscoveryParams(queryCase, params));
        const candidates = discoveryRun.candidates || [];
        const evaluation = evaluateRetrievalResults(queryCase, candidates, {
          cutoffs,
          titleMatchThreshold: params.titleMatchThreshold || params.title_match_threshold
        });
        const taskEvaluation = await evaluateBenchmarkTaskCase(queryCase, candidates, {
          ...params,
          taskEvaluation: taskEvaluationMode
        });
        const queryDurationMs = Date.now() - queryStartedAt;
        const providerFailures = summarizeDiscoveryFailures(discoveryRun.queryResults || []);
        const result = {
          ...evaluation,
          status: 'completed',
          queryKey,
          durationMs: queryDurationMs,
          evaluationMode,
          taskType: queryCase.metadata?.taskType || benchmark.profile?.taskType || null,
          queryType: queryCase.metadata?.queryType || null,
          querySpecificity: queryCase.metadata?.specificity ?? null,
          officialSlice,
          taskEvaluation,
          discovery: {
            runId: discoveryRun.runId || null,
            providerCount: (discoveryRun.providers || []).length,
            plannedQueryCount: asArray(discoveryRun.plan?.queries).length,
            providerQueryCount: asArray(discoveryRun.queryResults).length,
            rawCandidateCount: discoveryRun.rawCandidateCount || candidates.length,
            mergedPaperCount: candidates.length,
            providerFailures,
            citationExpansion: discoveryRun.citationExpansion || null,
            queryAnalysis: discoveryRun.queryAnalysis || null,
            retrieval: discoveryRun.retrieval || null,
            coverage: discoveryRun.coverage || null,
            artifacts: discoveryRun.artifacts || null,
            diagnosticTrace: buildQueryDiagnosticTrace(queryCase, evaluation, discoveryRun, candidates)
          }
        };
        await appendJsonl(artifactRun?.artifacts?.perQueryResultsPath, result);
        await writeRetrievalBenchmarkCheckpoint(artifactRun, {
          status: 'running',
          totalQueries: selectedQueries.length,
          completedQueries: completedBeforeRun + index + 1,
          pendingQueries: Math.max(0, pendingQueries.length - index - 1),
          failedQueries: 0,
          lastQueryKey: queryKey
        });
        onProgress?.({
          completed: completedBeforeRun + index + 1,
          total: selectedQueries.length,
          queryId: queryCase.id,
          query: queryCase.query,
          phase: 'completed',
          firstRelevantRank: evaluation.firstRelevantRank,
          durationMs: queryDurationMs
        });
        return result;
      } catch (error) {
        if (!continueOnError) throw error;
        const queryDurationMs = Date.now() - queryStartedAt;
        const result = {
          ...createBenchmarkFailureResult(queryCase, error, {
            ...params,
            cutoffs,
            durationMs: queryDurationMs,
            evaluationMode,
            taskType: benchmark.profile?.taskType,
            officialSlice
          }),
          queryKey
        };
        await appendJsonl(artifactRun?.artifacts?.perQueryResultsPath, result);
        await appendJsonl(artifactRun?.artifacts?.failuresPath, {
          runId: artifactRun?.runId || null,
          queryKey,
          queryId: queryCase.id || null,
          query: queryCase.query || '',
          status: 'failed',
          error: result.error,
          category: result.discovery?.providerFailures?.[0]?.category || 'unknown',
          durationMs: queryDurationMs,
          updatedAt: new Date().toISOString()
        });
        onProgress?.({
          completed: completedBeforeRun + index + 1,
          total: selectedQueries.length,
          queryId: queryCase.id,
          query: queryCase.query,
          phase: 'failed',
          durationMs: queryDurationMs,
          error: result.error?.message
        });
        return result;
      }
    }
  );
  const newResultsByKey = new Map(newResults.map((result) => [compactText(result.queryKey || result.id), result]));
  const results = selectedQueries
    .map((queryCase, index) => {
      const key = benchmarkQueryKey(queryCase, index);
      return newResultsByKey.get(key) || resumedResultsByKey.get(key) || null;
    })
    .filter(Boolean);
  const endedAt = new Date().toISOString();
  const discoveryRequestStateAfter = readDiscoveryRequestSchedulerState();
  const discoveryRequestCacheStats = diffDiscoveryRequestStats(discoveryRequestStateAfter, discoveryRequestStateBefore);
  const discoveryCacheTtlMs = toNumber(pickFirst(
    params.discoveryRequestCacheTtlMs,
    params.discovery_request_cache_ttl_ms,
    process.env.PAPERNEXUS_DISCOVERY_CACHE_TTL_MS
  ), 0);
  const discoveryFailureCacheTtlMs = toNumber(pickFirst(
    params.discoveryRequestFailureCacheTtlMs,
    params.discovery_request_failure_cache_ttl_ms,
    process.env.PAPERNEXUS_DISCOVERY_FAILURE_CACHE_TTL_MS
  ), 0);
  const discoveryCacheDir = pickFirst(
    params.discoveryRequestCacheDir,
    params.discovery_request_cache_dir,
    process.env.PAPERNEXUS_DISCOVERY_CACHE_DIR
  ) || null;
  const discoveryCacheEnabled = resolveDiscoveryCacheEnabled(params, discoveryCacheTtlMs);
  const discoveryCacheMode = inferDiscoveryCacheMode(discoveryRequestCacheStats, discoveryCacheEnabled);
  const fixedCorpusIndexSummary = summarizeFixedCorpusIndex(fixedCorpusIndex);
  const fixedCorpusDenseIndexSummary = summarizeFixedCorpusDenseIndex(fixedCorpusDenseIndex);
  const fixedCorpusRerankIndexSummary = summarizeFixedCorpusRerankIndex(fixedCorpusRerankIndex);
  const diagnostics = {
    ...summarizeBenchmarkDiagnostics(results),
    resumedQueries: completedBeforeRun,
    failedQueries: results.filter((result) => String(result.status || '').toLowerCase() === 'failed').length,
    fixedCorpusIndex: fixedCorpusIndexSummary,
    fixedCorpusDenseIndex: fixedCorpusDenseIndexSummary,
    fixedCorpusRerankIndex: fixedCorpusRerankIndexSummary,
    discoveryRequestCache: {
      enabled: discoveryCacheEnabled,
      mode: discoveryCacheMode,
      ...discoveryRequestCacheStats
    }
  };
  const status = diagnostics.failedQueries
    ? (results.length >= selectedQueries.length ? 'completed_with_failures' : 'partial')
    : (results.length >= selectedQueries.length ? 'completed' : 'partial');
  const report = {
    contractVersion: 'retrieval-benchmark-v1',
    status,
    generatedAt: endedAt,
    startedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    benchmark: summarizeBenchmark(benchmark, selectedQueries),
    config: {
      cutoffs,
      providers: params.providers || null,
      depth: params.depth || 'quick',
      maxDiscoveryQueries: params.maxDiscoveryQueries || params.max_queries || params.discoveryQueries || null,
      maxResultsPerQuery: params.maxResultsPerQuery || params.max_results_per_query || 10,
      maxCandidates: params.maxCandidates || params.max_candidates || 50,
      evaluationMode,
      taskEvaluationMode,
      generateTaskAnswers: params.generateTaskAnswers === true || params.generate_task_answers === true,
      maxTaskContext: params.maxTaskContext || params.max_task_context || null,
      fixedCorpusLimit: params.fixedCorpusLimit || params.maxFixedCorpusResults || params.max_fixed_corpus_results || null,
      fixedCorpusScanLimit: evaluationMode === 'fixed-corpus'
        ? resolveFixedCorpusScanLimit(params, resolveFixedCorpusLimit(params))
        : null,
      fixedCorpusRetrievalMode,
      fixedCorpusScorer: evaluationMode === 'fixed-corpus' ? fixedCorpusScorerName(params) : null,
      fixedCorpusIndexCache: fixedCorpusIndexSummary?.mode || null,
      fixedCorpusCacheHit: fixedCorpusIndexSummary?.cacheHit ?? null,
      fixedCorpusCachePath: fixedCorpusIndexSummary?.cachePath || null,
      fixedCorpusDenseScoresPath: fixedCorpusDenseIndexSummary?.path || resolveFixedCorpusDenseScoresPath(params) || null,
      fixedCorpusDenseScoresLoadedQueries: fixedCorpusDenseIndexSummary?.queryCount ?? null,
      fixedCorpusRerankScoresPath: fixedCorpusRerankIndexSummary?.path || resolveFixedCorpusRerankScoresPath(params) || null,
      fixedCorpusRerankScoresLoadedQueries: fixedCorpusRerankIndexSummary?.queryCount ?? null,
      fixedCorpusRrfK: evaluationMode === 'fixed-corpus' && ['hybrid', 'hybrid-rerank'].includes(fixedCorpusRetrievalMode)
        ? resolveFixedCorpusRrfK(params)
        : null,
      fixedCorpusQueryAnalysis: evaluationMode === 'fixed-corpus'
        ? normalizeFixedCorpusQueryAnalysisMode(params)
        : null,
      fixedCorpusQueryAnalysisExtraLimit: evaluationMode === 'fixed-corpus'
        && normalizeFixedCorpusQueryAnalysisMode(params) !== 'off'
        ? resolveFixedCorpusQueryAnalysisExtraLimit(params, resolveFixedCorpusScanLimit(params, resolveFixedCorpusLimit(params)), resolveFixedCorpusLimit(params))
        : null,
      discoveryCacheEnabled,
      discoveryCacheMode,
      discoveryCacheTtlMs,
      discoveryFailureCacheTtlMs,
      discoveryCacheDir,
      discoveryCircuitBreakerFailureThreshold: toNumber(pickFirst(
        params.discoveryCircuitBreakerFailureThreshold,
        params.discovery_circuit_breaker_failure_threshold,
        process.env.PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD
      ), null),
      discoveryCircuitBreakerCooldownMs: toNumber(pickFirst(
        params.discoveryCircuitBreakerCooldownMs,
        params.discovery_circuit_breaker_cooldown_ms,
        process.env.PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS
      ), 0),
      providerCredentials: summarizeProviderCredentials(params),
      resolveSources: params.resolveSources === true,
      persistDiscoveryRuns: params.persistDiscoveryRuns === true,
      titleMatchThreshold: Number(params.titleMatchThreshold || params.title_match_threshold || DEFAULT_TITLE_MATCH_THRESHOLD),
      benchmarkRunId: artifactRun?.runId || null,
      benchmarkResume: artifactRun?.resume || false,
      continueOnError
    },
    alignment: benchmarkAlignment(benchmark, { evaluationMode, taskEvaluationMode }),
    metrics: aggregateMetrics(results),
    officialMetrics: aggregateOfficialBenchmarkMetrics(results, benchmark),
    taskEvaluation: aggregateTaskEvaluationMetrics(results),
    diagnostics,
    results
  };

  if (params.outputDir) {
    report.artifacts = await writeRetrievalBenchmarkArtifacts(params.outputDir, report, {
      artifacts: artifactRun?.artifacts
    });
    await finalizeRetrievalBenchmarkArtifacts(artifactRun, report);
  }

  return report;
}

export async function writeRetrievalBenchmarkArtifacts(outputDir, report = {}, options = {}) {
  const artifacts = options.artifacts || report.artifacts || (() => {
    const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const benchmarkName = slugify(report.benchmark?.name || 'retrieval-benchmark');
    const runDir = path.join(absoluteOutputDir, `${stamp}-${benchmarkName}`);
    return {
      runDir,
      jsonPath: path.join(runDir, 'report.json'),
      markdownPath: path.join(runDir, 'report.md')
    };
  })();
  const reportWithArtifacts = {
    ...report,
    artifacts
  };
  await ensureDir(artifacts.runDir);
  await writeJson(artifacts.jsonPath, reportWithArtifacts);
  await writeText(artifacts.markdownPath, `${renderRetrievalBenchmarkReport(reportWithArtifacts)}\n`);
  return artifacts;
}

function formatMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.0000';
  return numeric.toFixed(4);
}

function metricRows(metrics = {}, cutoffs = DEFAULT_CUTOFFS) {
  const families = ['hit', 'exact_match', 'recall', 'weighted_recall', 'precision', 'f1', 'mrr', 'map', 'ndcg'];
  return families.flatMap((family) => cutoffs.map((cutoff) => {
    const key = `${family}@${cutoff}`;
    return `| ${key} | ${formatMetric(metrics[key])} |`;
  }));
}

export function renderRetrievalBenchmarkReport(report = {}) {
  const benchmark = report.benchmark || {};
  const config = report.config || {};
  const alignment = report.alignment || {};
  const cutoffs = config.cutoffs || DEFAULT_CUTOFFS;
  const lines = [
    `# Retrieval Benchmark: ${benchmark.name || 'unknown'}`,
    '',
    `Generated: ${report.generatedAt || 'unknown'}`,
    `Format: ${benchmark.format || 'unknown'}`,
    `Task type: ${(benchmark.taskTypes || []).join(', ') || alignment.taskType || 'unknown'}`,
    `Queries: ${benchmark.evaluatedQueries || 0}/${benchmark.loadedQueries || 0}`,
    `Relevant papers: ${benchmark.relevantPapers || 0}`,
    `Corpus size: ${benchmark.corpusSize || 0}`,
    `Evaluation mode: ${alignment.evaluationMode || config.evaluationMode || 'live'}`,
    `Discovery depth: ${config.depth || 'quick'}`,
    `Providers: ${Array.isArray(config.providers) ? config.providers.join(', ') : (config.providers || 'default')}`,
    `Fixed-corpus retrieval mode: ${config.fixedCorpusRetrievalMode || 'n/a'}`,
    `Fixed-corpus scorer: ${config.fixedCorpusScorer || 'n/a'}`,
    `Fixed-corpus index cache: ${config.fixedCorpusIndexCache || 'n/a'}`,
    `Fixed-corpus dense scores: ${config.fixedCorpusDenseScoresPath || 'n/a'}`,
    `Fixed-corpus dense-score queries: ${config.fixedCorpusDenseScoresLoadedQueries ?? 'n/a'}`,
    `Fixed-corpus rerank scores: ${config.fixedCorpusRerankScoresPath || 'n/a'}`,
    `Fixed-corpus rerank-score queries: ${config.fixedCorpusRerankScoresLoadedQueries ?? 'n/a'}`,
    `Fixed-corpus RRF k: ${config.fixedCorpusRrfK ?? 'n/a'}`,
    `Fixed-corpus scan limit: ${config.fixedCorpusScanLimit || 'n/a'}`,
    `Fixed-corpus query analysis: ${config.fixedCorpusQueryAnalysis || 'n/a'}`,
    `Fixed-corpus query-analysis extra limit: ${config.fixedCorpusQueryAnalysisExtraLimit ?? 'n/a'}`,
    `Discovery cache mode: ${config.discoveryCacheMode || 'unknown'}`,
    `Discovery cache TTL: ${config.discoveryCacheTtlMs || 0} ms`,
    `Discovery failure cache TTL: ${config.discoveryFailureCacheTtlMs || 0} ms`,
    `Discovery circuit breaker: threshold=${config.discoveryCircuitBreakerFailureThreshold || 'default'}, cooldown=${config.discoveryCircuitBreakerCooldownMs || 0} ms`,
    `Source resolution: ${config.resolveSources ? 'enabled' : 'disabled'}`,
    `Official-style comparable: ${alignment.officialComparable ? 'yes' : 'no'}`,
    '',
    '## Metrics',
    '',
    '| Metric | Macro average |',
    '|---|---:|',
    ...metricRows(report.metrics || {}, cutoffs),
    ''
  ];

  if (Array.isArray(config.providerCredentials) && config.providerCredentials.length) {
    lines.push(
      '## Provider Credentials',
      '',
      '| Provider | Configured | Source | Hash prefix | Provider implemented |',
      '|---|---:|---|---|---:|'
    );
    for (const credential of config.providerCredentials) {
      const provider = String(credential.provider || 'unknown').replace(/\|/g, '\\|');
      const source = String(credential.source || '-').replace(/\|/g, '\\|');
      const hashPrefix = String(credential.hashPrefix || '-').replace(/\|/g, '\\|');
      lines.push(`| ${provider} | ${credential.configured ? 'yes' : 'no'} | ${source} | ${hashPrefix} | ${credential.implemented === false ? 'no' : 'yes'} |`);
    }
    lines.push('');
  }

  if (report.officialMetrics?.metrics) {
    lines.push(
      '## Official Metrics',
      '',
      `Protocol: ${report.officialMetrics.protocol || report.officialMetrics.format || 'benchmark official metrics'}`,
      '',
      '| Metric | Value |',
      '|---|---:|'
    );
    for (const [key, value] of Object.entries(report.officialMetrics.metrics)) {
      lines.push(`| ${key} | ${value === null || value === undefined ? 'n/a' : formatMetric(value)} |`);
    }
    const counts = report.officialMetrics.queryCounts || {};
    if (Object.keys(counts).length) {
      lines.push('', `Query slices: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(', ')}`);
    }
    if (report.officialMetrics.note) {
      lines.push('', report.officialMetrics.note);
    }
    lines.push('');
  }

  if (report.taskEvaluation?.evaluatedQueries) {
    lines.push(
      '## Task Evaluation',
      '',
      `Task-evaluated queries: ${report.taskEvaluation.evaluatedQueries}`,
      '',
      '| Metric | Macro average |',
      '|---|---:|'
    );
    for (const key of Object.keys(report.taskEvaluation.metrics || {}).sort()) {
      lines.push(`| ${key} | ${formatMetric(report.taskEvaluation.metrics[key])} |`);
    }
    lines.push('');
  }

  if (report.diagnostics) {
    const diagnostics = report.diagnostics;
    const cacheSummaryLine = diagnostics.discoveryRequestCache
      ? `Discovery request cache: mode=${diagnostics.discoveryRequestCache.mode || config.discoveryCacheMode || 'unknown'}, total=${diagnostics.discoveryRequestCache.total || 0}, hits=${diagnostics.discoveryRequestCache.cacheHits || 0}, misses=${diagnostics.discoveryRequestCache.cacheMisses || 0}, network=${diagnostics.discoveryRequestCache.networkRequests || 0}, writes=${diagnostics.discoveryRequestCache.cacheWrites || 0}, in-flight=${diagnostics.discoveryRequestCache.inFlightHits || 0}, circuit=${diagnostics.discoveryRequestCache.circuitBreakerHits || 0}`
      : null;
    lines.push(...[
      '## Diagnostics',
      '',
      `Evaluated queries: ${diagnostics.evaluatedQueries || 0}`,
      `Matched queries: ${diagnostics.matchedQueries || 0}`,
      `Zero-match queries: ${diagnostics.zeroMatchQueries || 0} (${formatMetric(diagnostics.zeroMatchRate)})`,
      `Candidate pool recall: ${formatMetric(diagnostics.candidatePoolRecall)} over ${diagnostics.queriesWithGold || 0} gold-labeled queries`,
      `Average query duration: ${formatMetric(diagnostics.averageQueryDurationMs)} ms`,
      `Average retrieved candidates: ${formatMetric(diagnostics.averageRetrievedCount)}`,
      `Average raw candidates: ${formatMetric(diagnostics.averageRawCandidateCount)}`,
      `Average merged papers: ${formatMetric(diagnostics.averageMergedPaperCount)}`,
      `Average discovery queries: ${formatMetric(diagnostics.averageDiscoveryQueryCount)}`,
      `Average provider calls: ${formatMetric(diagnostics.averageProviderCallCount)}`,
      `Dedup merge rate: ${formatMetric(diagnostics.dedupMergeRate)}`,
      `Missed gold papers: ${diagnostics.missedRelevantTotal || 0}`,
      `Provider failures: ${diagnostics.providerFailuresTotal || 0}`,
      cacheSummaryLine,
      `Citation expansion: seeds=${diagnostics.citationExpansion?.seeds || 0}, added=${diagnostics.citationExpansion?.addedCandidates || 0}, failed=${diagnostics.citationExpansion?.failedSeeds || 0}`,
      ''
    ].filter((line) => line !== null));
    if (Array.isArray(diagnostics.discoveryRequestCache?.byProvider) && diagnostics.discoveryRequestCache.byProvider.length) {
      lines.push('| Provider | Requests | Cache hits | Memory hits | Disk hits | Misses | Network | Writes |');
      lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
      for (const providerStats of diagnostics.discoveryRequestCache.byProvider.slice(0, 12)) {
        const provider = String(providerStats.provider || 'unknown').replace(/\|/g, '\\|');
        lines.push(`| ${provider} | ${providerStats.total || 0} | ${providerStats.cacheHits || 0} | ${providerStats.cacheMemoryHits || 0} | ${providerStats.cacheDiskHits || 0} | ${providerStats.cacheMisses || 0} | ${providerStats.networkRequests || 0} | ${providerStats.cacheWrites || 0} |`);
      }
      lines.push('');
    }
    if (Array.isArray(diagnostics.goldMissReasons) && diagnostics.goldMissReasons.length) {
      lines.push('| Gold miss reason | Count | Example gold | Nearest candidate |');
      lines.push('|---|---:|---|---|');
      for (const miss of diagnostics.goldMissReasons.slice(0, 10)) {
        const example = miss.examples?.[0] || {};
        const reason = String(miss.reason || 'unknown').replace(/\|/g, '\\|');
        const gold = String(example.title || '-').replace(/\|/g, '\\|');
        const candidate = String(example.bestCandidateTitle || '-').replace(/\|/g, '\\|');
        lines.push(`| ${reason} | ${miss.count || 0} | ${gold} | ${candidate} |`);
      }
      lines.push('');
    }
    if (Array.isArray(diagnostics.providerFailures) && diagnostics.providerFailures.length) {
      lines.push('| Provider | Category | Reason | Count |', '|---|---|---|---:|');
      for (const failure of diagnostics.providerFailures.slice(0, 10)) {
        const provider = String(failure.provider || 'unknown').replace(/\|/g, '\\|');
        const category = String(failure.category || classifyProviderFailure(failure.reason, failure)).replace(/\|/g, '\\|');
        const reason = truncate(failure.reason || 'provider-failed', 120).replace(/\|/g, '\\|');
        lines.push(`| ${provider} | ${category} | ${reason} | ${failure.count || 0} |`);
      }
      lines.push('');
    }
  }

  lines.push('## Worst Queries By Recall', '');

  const maxCutoff = Math.max(...cutoffs);
  const recallKey = `recall@${maxCutoff}`;
  const worst = [...(report.results || [])]
    .sort((left, right) => (left.metrics?.[recallKey] || 0) - (right.metrics?.[recallKey] || 0))
    .slice(0, 10);

  if (!worst.length) {
    lines.push('No evaluated queries.');
  } else {
    lines.push('| Query | Relevant | Retrieved | First hit | Recall |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const result of worst) {
      lines.push(`| ${truncate(result.query, 90).replace(/\|/g, '\\|')} | ${result.relevantCount} | ${result.retrievedCount} | ${result.firstRelevantRank || '-'} | ${formatMetric(result.metrics?.[recallKey])} |`);
    }
  }

  if (Array.isArray(alignment.limitations) && alignment.limitations.length) {
    lines.push('', '## Alignment Notes', '');
    for (const limitation of alignment.limitations) {
      lines.push(`- ${limitation}`);
    }
  }

  return lines.join('\n');
}
