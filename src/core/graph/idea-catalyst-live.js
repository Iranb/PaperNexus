import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  getDefaultLlmApiKeyEnv,
  loadLlmApiKey,
  resolveLlmConfig
} from '../llm/ollama.js';
import {
  S2_FIELDS_OF_STUDY,
  normalizeS2FieldOfStudy,
  normalizeS2FieldsOfStudy,
  searchSemanticScholarSnippets
} from '../discovery/semantic-scholar-snippets.js';
import {
  scoreTokenOverlap,
  stableHash,
  tokenizeWithoutStopwords,
  truncate,
  unique
} from '../../lib/utils.js';
import {
  publicationDateFromRecord,
  publicationYearFromRecord,
  sortPaperRecordsByPublicationDateDesc
} from '../paper-date.js';
import { buildIdeaCatalystEvidenceExport } from './idea-catalyst-evidence-export.js';
import {
  LIVE_IDEA_CATALYST_PACKET_V2_VERSION,
  LIVE_IDEA_CATALYST_V2_CONTRACT_VERSION,
  buildIdeaCatalystInnovationArtifacts
} from './innovation-contracts.js';

const require = createRequire(import.meta.url);
let jsonrepair = null;
try {
  ({ jsonrepair } = require('jsonrepair'));
} catch {}

export const LIVE_IDEA_CATALYST_CONTRACT_VERSION = 'idea-catalyst-live-discovery-v1';
export const LIVE_IDEA_CATALYST_PACKET_CONTRACT_VERSION = 'idea-catalyst-live-packet-bundle-v1';

const DEFAULT_NUM_QUESTIONS = 4;
const DEFAULT_NUM_SOURCE_DOMAINS = 3;
const DEFAULT_MAX_PAPERS_PER_QUERY = 20;
const DEFAULT_SOURCE_RELEVANCE_THRESHOLD = 0.5;
const DEFAULT_IDEA_FRAGMENT_LIMIT = 8;
const MAX_PROMPT_SNIPPETS = 10;
const MAX_PROMPT_PAPERS = 20;

const SOURCE_DOMAIN_FALLBACK_ORDER = [
  'Psychology',
  'Sociology',
  'Economics',
  'Education',
  'Political Science',
  'Business',
  'Philosophy',
  'Engineering',
  'Medicine',
  'Biology',
  'Mathematics',
  'Physics',
  'Linguistics'
];

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? '';
}

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clampScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function toThreshold(value, fallback = DEFAULT_SOURCE_RELEVANCE_THRESHOLD) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeProgress(value = '') {
  const normalized = compactText(value).toLowerCase().replace(/[-_]+/g, ' ');
  if (normalized === 'largely resolved') return 'largely resolved';
  if (normalized === 'largely unexplored') return 'largely unexplored';
  if (normalized === 'partially addressed') return 'partially addressed';
  if (normalized.includes('partial') || normalized.includes('partly') || normalized.includes('somewhat')) return 'partially addressed';
  if (
    normalized.includes('unexplored')
    || normalized.includes('unaddressed')
    || normalized.includes('unresolved')
    || normalized.includes('unsolved')
    || normalized.includes('not resolved')
  ) return 'largely unexplored';
  if (normalized.includes('resolved') || normalized.includes('addressed')) return 'largely resolved';
  return 'partially addressed';
}

function normalizeDomain(value = '') {
  return normalizeS2FieldOfStudy(value);
}

function collectAllowedSourceDomains(targetField = '') {
  const normalizedTarget = normalizeDomain(targetField);
  return S2_FIELDS_OF_STUDY.filter((domain) => domain !== normalizedTarget);
}

function selectedDomainFallback(targetField, limit) {
  const allowed = new Set(collectAllowedSourceDomains(targetField));
  return SOURCE_DOMAIN_FALLBACK_ORDER
    .filter((domain) => allowed.has(domain))
    .slice(0, limit)
    .map((domain) => ({
      domain,
      rationale: `${domain} is a distant coarse field that can provide transferable conceptual mechanisms.`,
      source_search_queries: []
    }));
}

function collectJsonCandidates(value = '') {
  const candidates = [];
  const trimmed = String(value || '').trim();
  if (!trimmed) return candidates;
  candidates.push(trimmed);

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function tryJsonRepair(candidate) {
  const text = String(candidate || '');
  if (!text) return text;
  if (typeof jsonrepair === 'function') {
    try {
      return jsonrepair(text);
    } catch {}
  }
  return text
    .replace(/^\uFEFF/, '')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseJsonText(text = '') {
  for (const candidate of collectJsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {}
    try {
      return JSON.parse(tryJsonRepair(candidate));
    } catch {}
  }
  throw new Error('Model response was not valid JSON.');
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
      throw new Error(`LLM request failed (${response.status}): ${truncate(text, 240)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAiText(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function extractAnthropicText(payload = {}) {
  return (payload?.content || []).map((part) => (part?.type === 'text' ? part.text || '' : '')).join('');
}

function shouldDisableThinkingForJsonMode(config = {}) {
  return config.provider === 'openai'
    && String(config.baseUrl || '').toLowerCase().includes('dashscope.aliyuncs.com')
    && /^qwen3/i.test(String(config.model || '').trim());
}

function resolveLiveLlmConfig(params = {}, options = {}) {
  const config = normalizeObject(options.config);
  const llmConfig = normalizeObject(config.llm);
  const ollamaConfig = normalizeObject(config.ollama);
  const fallbackConfig = normalizeObject(llmConfig.fallback);
  const fallbackOllamaConfig = normalizeObject(fallbackConfig.ollamaBootstrap || fallbackConfig.ollama);
  return resolveLlmConfig({
    llmProvider: firstDefined(params.llmProvider, params.llm_provider, llmConfig.provider),
    llmModel: firstDefined(params.llmModel, params.llm_model, params.ollamaModel, params.ollama_model, llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(params.llmBaseUrl, params.llm_base_url, params.ollamaUrl, params.ollama_url, llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(params.llmApiKey, params.llm_api_key, llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(params.llmApiKeyEnv, params.llm_api_key_env, llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(params.llmApiKeySource, params.llm_api_key_source, llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(params.llmApiKeyService, params.llm_api_key_service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(params.llmApiKeyAccount, params.llm_api_key_account, llmConfig.apiKeyAccount),
    llmTimeoutMs: firstDefined(params.llmTimeoutMs, params.llm_timeout_ms, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmMaxTokens: firstDefined(params.llmMaxTokens, params.llm_max_tokens, llmConfig.maxTokens),
    llmFallbackProvider: firstDefined(params.llmFallbackProvider, params.llm_fallback_provider, fallbackConfig.provider),
    llmFallbackModel: firstDefined(params.llmFallbackModel, params.llm_fallback_model, fallbackConfig.model),
    llmFallbackBaseUrl: firstDefined(params.llmFallbackBaseUrl, params.llm_fallback_base_url, fallbackConfig.baseUrl, fallbackConfig.url),
    llmFallbackApiKey: firstDefined(params.llmFallbackApiKey, params.llm_fallback_api_key, fallbackConfig.apiKey),
    llmFallbackApiKeyEnv: firstDefined(params.llmFallbackApiKeyEnv, params.llm_fallback_api_key_env, fallbackConfig.apiKeyEnv),
    llmFallbackApiKeySource: firstDefined(params.llmFallbackApiKeySource, params.llm_fallback_api_key_source, fallbackConfig.apiKeySource),
    llmFallbackApiKeyService: firstDefined(params.llmFallbackApiKeyService, params.llm_fallback_api_key_service, fallbackConfig.apiKeyService),
    llmFallbackApiKeyAccount: firstDefined(params.llmFallbackApiKeyAccount, params.llm_fallback_api_key_account, fallbackConfig.apiKeyAccount),
    llmFallbackTimeoutMs: firstDefined(params.llmFallbackTimeoutMs, params.llm_fallback_timeout_ms, fallbackConfig.timeoutMs),
    llmFallbackMaxTokens: firstDefined(params.llmFallbackMaxTokens, params.llm_fallback_max_tokens, fallbackConfig.maxTokens),
    llmFallbackAutoStart: firstDefined(params.llmFallbackAutoStart, params.llm_fallback_auto_start, fallbackConfig.autoStart),
    llmFallbackAutoPull: firstDefined(params.llmFallbackAutoPull, params.llm_fallback_auto_pull, fallbackConfig.autoPull),
    llmFallbackOllamaBootstrap: firstDefined(params.llmFallbackOllamaBootstrap, params.llm_fallback_ollama_bootstrap, fallbackOllamaConfig.mode)
  });
}

async function callConfiguredLlmJson(prompt, config = {}) {
  if (!config.enabled || !config.model) {
    throw new Error('LLM is not configured.');
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for live Idea Catalyst. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')} or configure PaperNexus LLM auth.`);
    }
    const body = {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: Math.min(4000, Math.max(512, Number(config.maxTokens || 2000)))
    };
    if (shouldDisableThinkingForJsonMode(config)) body.enable_thinking = false;
    const payload = await postJson(`${config.baseUrl}/chat/completions`, body, {
      authorization: `Bearer ${apiKey}`
    }, config.timeoutMs);
    return parseJsonText(extractOpenAiText(payload));
  }

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for live Idea Catalyst. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')} or configure PaperNexus LLM auth.`);
    }
    const payload = await postJson(`${config.baseUrl}/messages`, {
      model: config.model,
      max_tokens: Math.min(4000, Math.max(512, Number(config.maxTokens || 2000))),
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

function resolveIdeaCatalystLlmLedger(params = {}, options = {}, task = 'idea-catalyst') {
  const dir = firstDefined(
    params.llmBatchLedgerDir,
    params.llm_batch_ledger_dir,
    params.batchLedgerDir,
    params.batch_ledger_dir,
    options.llmBatchLedgerDir,
    options.llm_batch_ledger_dir,
    options.batchLedgerDir,
    options.batch_ledger_dir
  );
  if (!dir) return null;
  return {
    dir: path.resolve(process.cwd(), String(dir)),
    phase: `idea-catalyst:${task}`,
    task,
    runId: String(firstDefined(
      params.llmBatchRunId,
      params.llm_batch_run_id,
      params.runId,
      params.run_id,
      options.runId,
      options.run_id,
      'idea-catalyst-run'
    )),
    traceId: firstDefined(params.traceId, params.trace_id, options.traceId, options.trace_id),
    resume: enabledFlag(firstDefined(
      params.llmBatchResume,
      params.llm_batch_resume,
      params.batchResume,
      params.batch_resume,
      options.llmBatchResume,
      options.llm_batch_resume,
      false
    ))
  };
}

function createIdeaCatalystLlmBatchId(ledger = null, task = '', prompt = '') {
  return `idea:${stableHash(JSON.stringify({
    phase: ledger?.phase || `idea-catalyst:${task}`,
    task,
    promptHash: stableHash(prompt, 24)
  }), 20)}`;
}

async function appendIdeaCatalystLlmLedger(ledger = null, fileName = '', event = {}) {
  if (!ledger?.dir || !fileName) return;
  await fs.mkdir(ledger.dir, { recursive: true });
  await fs.appendFile(path.join(ledger.dir, fileName), `${JSON.stringify({
    contractVersion: 'papernexus-llm-batch-ledger-v1',
    ledger_schema: 'papernexus-llm-ledger-v1',
    runId: ledger.runId,
    run_id: ledger.runId,
    trace_id: ledger.traceId || null,
    phase: ledger.phase,
    task: ledger.task,
    updatedAt: new Date().toISOString(),
    ...event
  })}\n`, 'utf8');
}

async function readIdeaCatalystLlmJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadCompletedIdeaCatalystLlmResult(ledger = null, batchId = '') {
  if (!ledger?.resume || !batchId) return null;
  const rows = await readIdeaCatalystLlmJsonl(path.join(ledger.dir, 'llm-results.jsonl'));
  return rows.find((row) => (
    row.phase === ledger.phase
    && row.status === 'completed'
    && (row.batchId === batchId || row.batch_id === batchId)
  )) || null;
}

function buildIdeaCatalystLlmLedgerRefs(params = {}, options = {}) {
  const dir = firstDefined(
    params.llmBatchLedgerDir,
    params.llm_batch_ledger_dir,
    params.batchLedgerDir,
    params.batch_ledger_dir,
    options.llmBatchLedgerDir,
    options.llm_batch_ledger_dir,
    options.batchLedgerDir,
    options.batch_ledger_dir
  );
  if (!dir) return [];
  return [{
    ledger_version: 'papernexus-llm-ledger-v1',
    contractVersion: 'papernexus-llm-batch-ledger-v1',
    run_id: String(firstDefined(
      params.llmBatchRunId,
      params.llm_batch_run_id,
      params.runId,
      params.run_id,
      options.runId,
      options.run_id,
      'idea-catalyst-run'
    )),
    trace_id: firstDefined(params.traceId, params.trace_id, options.traceId, options.trace_id) || null,
    ledger_dir: path.resolve(process.cwd(), String(dir)),
    tasks: [
      'decompose',
      'target_assessment',
      'source_domains',
      'source_relevance',
      'source_takeaways',
      'idea_fragments',
      'pairwise_ranking'
    ]
  }];
}

async function callWorkflowLlmJson(task, prompt, params = {}, options = {}) {
  const ledger = resolveIdeaCatalystLlmLedger(params, options, task);
  const batchId = createIdeaCatalystLlmBatchId(ledger, task, prompt);
  const cached = await loadCompletedIdeaCatalystLlmResult(ledger, batchId);
  if (cached) {
    return normalizeObject(cached.result || cached.output || cached.payload);
  }

  await appendIdeaCatalystLlmLedger(ledger, 'llm-batches.jsonl', {
    status: 'running',
    task,
    batchId,
    batch_id: batchId,
    input_hash: stableHash(prompt, 24),
    prompt_chars: String(prompt || '').length,
    model: firstDefined(params.llmModel, params.llm_model, options.config?.llm?.model, options.config?.ollama?.model),
    trace_id: ledger?.traceId || null
  });

  try {
    let result;
    let provider = null;
  if (typeof params.llmJson === 'function') {
    const payload = await params.llmJson({ task, prompt, params, options });
      result = typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload);
      provider = 'custom-llm-json';
    } else {
      if (params.disableLlm === true || params.disable_llm === true) {
        throw new Error('LLM disabled for live Idea Catalyst.');
      }
      const config = resolveLiveLlmConfig(params, options);
      result = await callConfiguredLlmJson(prompt, config);
      provider = config.provider;
    }
    await appendIdeaCatalystLlmLedger(ledger, 'llm-results.jsonl', {
      status: 'completed',
      task,
      batchId,
      batch_id: batchId,
      input_hash: stableHash(prompt, 24),
      output_hash: stableHash(JSON.stringify(result), 24),
      provider,
      model: firstDefined(params.llmModel, params.llm_model, options.config?.llm?.model, options.config?.ollama?.model),
      result,
      trace_id: ledger?.traceId || null
    });
    return result;
  } catch (error) {
    await appendIdeaCatalystLlmLedger(ledger, 'llm-failures.jsonl', {
      status: 'failed',
      task,
      batchId,
      batch_id: batchId,
      input_hash: stableHash(prompt, 24),
      error_class: error?.name || 'Error',
      error: error?.message || String(error),
      trace_id: ledger?.traceId || null
    });
    throw error;
  }
}

function buildDecompositionPrompt(problem, targetDomain, targetField, numQuestions) {
  return [
    'You are implementing an interdisciplinary scientific ideation pipeline.',
    'Decompose the target-domain research problem into research questions.',
    'Return strict JSON only with this shape:',
    '{"research_questions":[{"id":"q1","domain_specific_question":"...","domain_agnostic_question":"...","target_search_queries":["..."]}]}',
    '',
    'Requirements:',
    `- Produce 1-${numQuestions} questions.`,
    '- Each question must have a target-domain formulation and a domain-agnostic conceptual formulation.',
    '- target_search_queries must be short Semantic Scholar snippet-search queries in the target-domain vocabulary.',
    '- Do not invent paper titles.',
    '',
    `Problem: ${problem}`,
    `Target domain: ${targetDomain}`,
    `Semantic Scholar field: ${targetField}`
  ].join('\n');
}

function fallbackDecomposition(problem, targetDomain) {
  return [{
    id: 'q1',
    domain_specific_question: `How can ${targetDomain} address ${problem}?`,
    domain_agnostic_question: problem,
    target_search_queries: [problem]
  }];
}

function sanitizeResearchQuestions(raw = {}, problem = '', targetDomain = '', limit = DEFAULT_NUM_QUESTIONS) {
  const records = Array.isArray(raw.research_questions)
    ? raw.research_questions
    : Array.isArray(raw.researchQuestions)
      ? raw.researchQuestions
      : [];
  const questions = [];
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const specific = compactText(record.domain_specific_question || record.domainSpecificQuestion || record.question || record.query);
    const agnostic = compactText(record.domain_agnostic_question || record.domainAgnosticQuestion || record.abstract_question || specific);
    if (!specific && !agnostic) continue;
    const key = `${specific}:${agnostic}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const queries = asArray(record.target_search_queries || record.targetSearchQueries || record.queries || specific || problem)
      .map(compactText)
      .filter(Boolean)
      .slice(0, 3);
    questions.push({
      id: compactText(record.id || `q${index + 1}`),
      domain_specific_question: specific || `How can ${targetDomain} address ${problem}?`,
      domain_agnostic_question: agnostic || problem,
      target_search_queries: queries.length ? queries : [specific || problem]
    });
    if (questions.length >= limit) break;
  }
  return questions.length ? questions : fallbackDecomposition(problem, targetDomain);
}

async function decomposeProblem(problem, targetDomain, targetField, params, options) {
  const numQuestions = toPositiveInteger(params.numQuestions || params.num_questions, DEFAULT_NUM_QUESTIONS, 8);
  try {
    const raw = await callWorkflowLlmJson(
      'decompose',
      buildDecompositionPrompt(problem, targetDomain, targetField, numQuestions),
      params,
      options
    );
    return sanitizeResearchQuestions(raw, problem, targetDomain, numQuestions);
  } catch (error) {
    return fallbackDecomposition(problem, targetDomain).map((entry) => ({
      ...entry,
      fallback_reason: truncate(error?.message || error, 180)
    }));
  }
}

function snippetSummary(snippet, index) {
  return {
    evidence_id: snippet.snippetId || `snippet-${index + 1}`,
    paper_key: paperKey(snippet.paper),
    paper_title: snippet.paper?.title || '',
    section: snippet.section || snippet.snippetKind || '',
    text: truncate(snippet.text || snippet.evidenceText || '', 900)
  };
}

function buildTargetAssessmentPrompt(question, snippets = []) {
  return [
    'Assess target-domain progress for one research question using only retrieved snippets.',
    'Return strict JSON only:',
    '{"progress":"largely resolved|partially addressed|largely unexplored","rationale":"...","remaining_challenges":[{"domain_specific_challenge":"...","domain_agnostic_challenge":"...","rationale":"...","target_evidence_ids":["..."]}]}',
    '',
    'Rules:',
    '- Surface non-incremental unresolved conceptual challenges, not generic future work.',
    '- If evidence is thin or only tangential, mark largely unexplored.',
    '- Cite evidence only by evidence_id from the provided snippets.',
    '',
    `Domain-specific question: ${question.domain_specific_question}`,
    `Domain-agnostic question: ${question.domain_agnostic_question}`,
    '',
    `Snippets JSON: ${JSON.stringify(snippets.slice(0, MAX_PROMPT_SNIPPETS).map(snippetSummary))}`
  ].join('\n');
}

function fallbackTargetAssessment(question, snippets = []) {
  const progress = snippets.length >= 6
    ? 'partially addressed'
    : snippets.length >= 2
      ? 'partially addressed'
      : 'largely unexplored';
  return {
    question_id: question.id,
    domain_specific_question: question.domain_specific_question,
    domain_agnostic_question: question.domain_agnostic_question,
    progress,
    rationale: snippets.length
      ? 'Fallback assessment based on retrieved snippet volume; LLM target-progress assessment was unavailable.'
      : 'No target-domain snippets were retrieved.',
    retrieved_snippet_count: snippets.length,
    remaining_challenges: [{
      id: `challenge:${stableHash(`${question.id}:${question.domain_agnostic_question}`, 10)}`,
      domain_specific_challenge: question.domain_specific_question,
      domain_agnostic_challenge: question.domain_agnostic_question,
      rationale: 'Fallback unresolved challenge derived from the domain-agnostic question.',
      target_evidence_ids: snippets.slice(0, 3).map((snippet) => snippet.snippetId)
    }]
  };
}

function sanitizeRemainingChallenges(raw = {}, question, snippets = []) {
  const records = Array.isArray(raw.remaining_challenges)
    ? raw.remaining_challenges
    : Array.isArray(raw.remainingChallenges)
      ? raw.remainingChallenges
      : [];
  const challenges = records.map((record, index) => {
    const specific = compactText(record.domain_specific_challenge || record.domainSpecificChallenge || record.challenge || record.question);
    const agnostic = compactText(record.domain_agnostic_challenge || record.domainAgnosticChallenge || record.abstract_challenge || specific);
    if (!specific && !agnostic) return null;
    return {
      id: compactText(record.id || `challenge:${stableHash(`${question.id}:${specific}:${agnostic}:${index}`, 10)}`),
      parent_question_id: question.id,
      domain_specific_challenge: specific || question.domain_specific_question,
      domain_agnostic_challenge: agnostic || question.domain_agnostic_question,
      rationale: compactText(record.rationale || record.reason || ''),
      target_evidence_ids: asArray(record.target_evidence_ids || record.targetEvidenceIds || record.evidence_ids)
        .map(compactText)
        .filter(Boolean)
    };
  }).filter(Boolean);
  if (challenges.length) return challenges.slice(0, 3);
  return fallbackTargetAssessment(question, snippets).remaining_challenges;
}

async function assessTargetQuestion(question, snippets, params, options) {
  try {
    const raw = await callWorkflowLlmJson(
      'target_assessment',
      buildTargetAssessmentPrompt(question, snippets),
      params,
      options
    );
    return {
      question_id: question.id,
      domain_specific_question: question.domain_specific_question,
      domain_agnostic_question: question.domain_agnostic_question,
      progress: normalizeProgress(raw.progress || raw.status || raw.assessment),
      rationale: compactText(raw.rationale || raw.reason || ''),
      retrieved_snippet_count: snippets.length,
      remaining_challenges: sanitizeRemainingChallenges(raw, question, snippets)
    };
  } catch (error) {
    return {
      ...fallbackTargetAssessment(question, snippets),
      fallback_reason: truncate(error?.message || error, 180)
    };
  }
}

async function retrieveTargetEvidence(question, targetField, params = {}) {
  const maxPapersPerQuery = toPositiveInteger(
    params.maxPapersPerQuery || params.max_papers_per_query,
    DEFAULT_MAX_PAPERS_PER_QUERY,
    1000
  );
  const retrievals = [];
  for (const query of question.target_search_queries) {
    const result = await searchSemanticScholarSnippets({
      ...params,
      query,
      fieldsOfStudy: [targetField],
      limit: maxPapersPerQuery
    });
    retrievals.push(result);
  }
  const snippets = uniqueBy(retrievals.flatMap((entry) => entry.results || []), (entry) => entry.snippetId);
  return { retrievals, snippets };
}

function buildSourceDomainPrompt(challenge, targetDomain, targetField, limit) {
  return [
    'Select external source domains for cross-domain scientific inspiration.',
    'Return strict JSON only:',
    '{"source_domains":[{"domain":"Psychology","rationale":"...","source_search_queries":["..."]}]}',
    '',
    'Rules:',
    '- Choose domains from the allowed Semantic Scholar fields list.',
    '- Exclude the target field and overly proximal subfields.',
    '- Prefer domains that are conceptually relevant but distant.',
    '- Queries must use source-domain vocabulary, not target-domain jargon.',
    `- Produce 1-${limit} domains.`,
    '',
    `Allowed domains: ${collectAllowedSourceDomains(targetField).join(', ')}`,
    `Target domain: ${targetDomain}`,
    `Target field: ${targetField}`,
    `Domain-agnostic unresolved challenge: ${challenge.domain_agnostic_challenge}`,
    `Domain-specific challenge: ${challenge.domain_specific_challenge}`
  ].join('\n');
}

function sanitizeSourceDomains(raw = {}, challenge, targetField, limit) {
  const allowed = new Set(collectAllowedSourceDomains(targetField));
  const records = Array.isArray(raw.source_domains)
    ? raw.source_domains
    : Array.isArray(raw.sourceDomains)
      ? raw.sourceDomains
      : [];
  const sourceDomains = [];
  const seen = new Set();
  for (const record of records) {
    const domain = normalizeDomain(record.domain || record.source_domain || record.name);
    if (!domain || !allowed.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    const queries = asArray(record.source_search_queries || record.sourceSearchQueries || record.queries)
      .map(compactText)
      .filter(Boolean)
      .slice(0, 3);
    sourceDomains.push({
      domain,
      rationale: compactText(record.rationale || record.reason || ''),
      source_search_queries: queries.length
        ? queries
        : [challenge.domain_agnostic_challenge, `${domain} ${challenge.domain_agnostic_challenge}`]
    });
    if (sourceDomains.length >= limit) break;
  }
  if (sourceDomains.length) return sourceDomains;
  return selectedDomainFallback(targetField, limit).map((entry) => ({
    ...entry,
    source_search_queries: [
      `${entry.domain} ${challenge.domain_agnostic_challenge}`,
      challenge.domain_agnostic_challenge
    ]
  }));
}

async function selectSourceDomains(challenge, targetDomain, targetField, params, options) {
  const limit = toPositiveInteger(params.numSourceDomains || params.num_source_domains, DEFAULT_NUM_SOURCE_DOMAINS, 8);
  try {
    const raw = await callWorkflowLlmJson(
      'source_domains',
      buildSourceDomainPrompt(challenge, targetDomain, targetField, limit),
      params,
      options
    );
    return sanitizeSourceDomains(raw, challenge, targetField, limit);
  } catch (error) {
    return sanitizeSourceDomains({}, challenge, targetField, limit).map((entry) => ({
      ...entry,
      fallback_reason: truncate(error?.message || error, 180)
    }));
  }
}

function paperKey(paper = {}) {
  return compactText(paper.corpusId || paper.paperId || paper.title || stableHash(JSON.stringify(paper), 10));
}

function uniqueBy(records = [], keyFn) {
  const seen = new Set();
  const output = [];
  for (const record of records) {
    const key = keyFn(record);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

function groupSnippetsByPaper(snippets = []) {
  const grouped = new Map();
  for (const snippet of snippets) {
    const key = paperKey(snippet.paper);
    if (!grouped.has(key)) {
      grouped.set(key, {
        paper_key: key,
        paper: snippet.paper || {},
        snippets: []
      });
    }
    grouped.get(key).snippets.push(snippet);
  }
  return [...grouped.values()];
}

function compareGroupedPaperFallback(left = {}, right = {}) {
  return Number(right.snippets?.length || 0) - Number(left.snippets?.length || 0)
    || String(left.paper?.title || '').localeCompare(String(right.paper?.title || ''));
}

function publicationFieldsForLivePaper(entry = {}) {
  const publicationDate = publicationDateFromRecord(entry);
  return {
    year: publicationYearFromRecord(entry),
    publicationDate,
    publication_date: publicationDate
  };
}

async function retrieveSourceEvidence(sourceDomain, challenge, params = {}) {
  const maxPapersPerQuery = toPositiveInteger(
    params.maxPapersPerQuery || params.max_papers_per_query,
    DEFAULT_MAX_PAPERS_PER_QUERY,
    1000
  );
  const retrievals = [];
  for (const query of sourceDomain.source_search_queries) {
    const result = await searchSemanticScholarSnippets({
      ...params,
      query,
      fieldsOfStudy: [sourceDomain.domain],
      limit: maxPapersPerQuery
    });
    retrievals.push(result);
  }
  const snippets = uniqueBy(retrievals.flatMap((entry) => entry.results || []), (entry) => entry.snippetId);
  return {
    retrievals,
    snippets,
    papers: sortPaperRecordsByPublicationDateDesc(groupSnippetsByPaper(snippets), {
      fallbackCompare: compareGroupedPaperFallback
    }),
    challenge
  };
}

function buildRelevancePrompt(sourceDomain, challenge, papers = []) {
  const paperPayload = papers.slice(0, MAX_PROMPT_PAPERS).map((entry) => ({
    paper_key: entry.paper_key,
    title: entry.paper.title || '',
    snippets: entry.snippets.slice(0, 3).map((snippet) => truncate(snippet.text || '', 650))
  }));
  return [
    'Judge whether each retrieved source-domain paper is conceptually relevant to the unresolved challenge.',
    'Return strict JSON only:',
    '{"papers":[{"paper_key":"...","relevant":true,"reason":"..."}]}',
    '',
    'Rules:',
    '- Judge paper-level conceptual relevance, not snippet-level keyword overlap.',
    '- A relevant paper should provide a transferable mechanism, principle, or conceptual model.',
    '- Do not mark papers relevant solely because of generic shared words.',
    '',
    `Source domain: ${sourceDomain.domain}`,
    `Challenge: ${challenge.domain_agnostic_challenge}`,
    `Papers JSON: ${JSON.stringify(paperPayload)}`
  ].join('\n');
}

function heuristicPaperRelevance(paperEntry, challenge, sourceDomain) {
  const queryTokens = tokenizeWithoutStopwords([
    challenge.domain_agnostic_challenge,
    challenge.domain_specific_challenge,
    sourceDomain.domain
  ].join(' '));
  const textTokens = tokenizeWithoutStopwords([
    paperEntry.paper.title,
    ...paperEntry.snippets.map((snippet) => snippet.text || '')
  ].join(' '));
  const overlap = scoreTokenOverlap(queryTokens, textTokens);
  return {
    paper_key: paperEntry.paper_key,
    relevant: overlap >= 0.12,
    relevance_score: clampScore(overlap),
    reason: 'Fallback lexical relevance over paper title and snippets.'
  };
}

function sanitizeRelevance(raw = {}, papers = [], challenge, sourceDomain) {
  const records = Array.isArray(raw.papers)
    ? raw.papers
    : Array.isArray(raw.relevance)
      ? raw.relevance
      : [];
  const byKey = new Map(records.map((record) => [compactText(record.paper_key || record.paperKey || record.id), record]));
  return papers.map((paper) => {
    const record = byKey.get(paper.paper_key);
    if (!record) return heuristicPaperRelevance(paper, challenge, sourceDomain);
    const relevant = record.relevant === true || String(record.relevant).toLowerCase() === 'true';
    const relevanceScore = record.relevance_score ?? record.relevanceScore ?? record.score;
    return {
      paper_key: paper.paper_key,
      relevant,
      relevance_score: clampScore(relevanceScore, relevant ? 0.75 : 0.25),
      reason: compactText(record.reason || record.rationale || '')
    };
  });
}

async function assessSourceRelevance(sourceDomain, challenge, papers, params, options) {
  try {
    const raw = await callWorkflowLlmJson(
      'source_relevance',
      buildRelevancePrompt(sourceDomain, challenge, papers),
      params,
      options
    );
    return sanitizeRelevance(raw, papers, challenge, sourceDomain);
  } catch {
    return papers.map((paper) => heuristicPaperRelevance(paper, challenge, sourceDomain));
  }
}

function buildTakeawayPrompt(sourceDomain, challenge, relevantPapers = []) {
  const paperPayload = relevantPapers.slice(0, MAX_PROMPT_PAPERS).map((entry) => ({
    paper_key: entry.paper_key,
    title: entry.paper.title || '',
    snippets: entry.snippets.slice(0, 3).map((snippet) => truncate(snippet.text || '', 650))
  }));
  return [
    'Extract source-domain conceptual takeaways grounded in the provided relevant papers.',
    'Return strict JSON only:',
    '{"takeaways":[{"concept":"...","mechanism":"...","source_logic":"...","paper_keys":["..."]}]}',
    '',
    'Rules:',
    '- Each takeaway must be a source-domain concept, mechanism, or perspective.',
    '- Ground every takeaway in one or more paper_keys.',
    '- Do not propose target-domain solutions here.',
    '',
    `Source domain: ${sourceDomain.domain}`,
    `Challenge: ${challenge.domain_agnostic_challenge}`,
    `Relevant papers JSON: ${JSON.stringify(paperPayload)}`
  ].join('\n');
}

function fallbackTakeaways(sourceDomain, challenge, relevantPapers) {
  return relevantPapers.slice(0, 3).map((entry, index) => ({
    id: `takeaway:${stableHash(`${sourceDomain.domain}:${entry.paper_key}:${index}`, 10)}`,
    concept: entry.paper.title || `${sourceDomain.domain} mechanism ${index + 1}`,
    mechanism: truncate(entry.snippets[0]?.text || challenge.domain_agnostic_challenge, 220),
    source_logic: 'Fallback takeaway derived from the highest-ranked relevant snippet.',
    paper_keys: [entry.paper_key]
  }));
}

function sanitizeTakeaways(raw = {}, sourceDomain, challenge, relevantPapers) {
  const records = Array.isArray(raw.takeaways) ? raw.takeaways : [];
  const output = records.map((record, index) => {
    const concept = compactText(record.concept || record.name || record.title);
    const mechanism = compactText(record.mechanism || record.principle || record.how_it_works || record.howDoesItWork);
    if (!concept && !mechanism) return null;
    return {
      id: compactText(record.id || `takeaway:${stableHash(`${sourceDomain.domain}:${concept}:${index}`, 10)}`),
      concept: concept || mechanism,
      mechanism,
      source_logic: compactText(record.source_logic || record.sourceLogic || record.logic || record.rationale),
      paper_keys: asArray(record.paper_keys || record.paperKeys || record.evidence)
        .map(compactText)
        .filter(Boolean)
    };
  }).filter(Boolean);
  return output.length ? output.slice(0, 5) : fallbackTakeaways(sourceDomain, challenge, relevantPapers);
}

async function extractSourceTakeaways(sourceDomain, challenge, relevantPapers, params, options) {
  try {
    const raw = await callWorkflowLlmJson(
      'source_takeaways',
      buildTakeawayPrompt(sourceDomain, challenge, relevantPapers),
      params,
      options
    );
    return sanitizeTakeaways(raw, sourceDomain, challenge, relevantPapers);
  } catch {
    return fallbackTakeaways(sourceDomain, challenge, relevantPapers);
  }
}

async function analyzeSourceDomain(sourceDomain, challenge, params, options) {
  const threshold = toThreshold(params.sourceRelevanceThreshold ?? params.source_relevance_threshold);
  const retrieved = await retrieveSourceEvidence(sourceDomain, challenge, params);
  const papers = retrieved.papers;
  const relevance = await assessSourceRelevance(sourceDomain, challenge, papers, params, options);
  const relevantKeys = new Set(relevance.filter((entry) => entry.relevant).map((entry) => entry.paper_key));
  const relevantPapers = papers.filter((entry) => relevantKeys.has(entry.paper_key));
  const ratio = papers.length ? Number((relevantPapers.length / papers.length).toFixed(4)) : 0;
  const accepted = papers.length > 0 && ratio >= threshold;
  const takeaways = accepted
    ? await extractSourceTakeaways(sourceDomain, challenge, relevantPapers, params, options)
    : [];

  return {
    source_domain: sourceDomain.domain,
    target_challenge_id: challenge.id,
    target_challenge: challenge.domain_agnostic_challenge,
    source_search_queries: sourceDomain.source_search_queries,
    rationale: sourceDomain.rationale || '',
    retrieved_paper_count: papers.length,
    retrieved_snippet_count: retrieved.snippets.length,
    relevant_paper_count: relevantPapers.length,
    relevance_ratio: ratio,
    relevance_threshold: threshold,
    accepted,
    pruning_decision: accepted ? 'accepted_majority_relevant' : 'pruned_below_majority_relevance',
    relevance,
    supporting_papers: relevantPapers.map((entry) => ({
      paper_key: entry.paper_key,
      title: entry.paper.title || '',
      authors: entry.paper.authors || [],
      ...publicationFieldsForLivePaper(entry),
      snippets: entry.snippets.slice(0, 3).map((snippet) => ({
        snippet_id: snippet.snippetId,
        text: snippet.text,
        section: snippet.section || snippet.snippetKind || ''
      }))
    })),
    takeaways,
    retrievals: retrieved.retrievals.map((entry) => ({
      query: entry.query,
      fieldsOfStudy: entry.fieldsOfStudy,
      resultCount: entry.resultCount,
      paperCount: entry.paperCount,
      abstractFallbackCount: entry.abstractFallbackCount
    }))
  };
}

function buildIdeaFragmentsPrompt(problem, targetDomain, sourceAnalyses = []) {
  const payload = sourceAnalyses.filter((entry) => entry.accepted).map((analysis) => ({
    source_domain: analysis.source_domain,
    target_challenge_id: analysis.target_challenge_id,
    target_challenge: analysis.target_challenge,
    takeaways: analysis.takeaways,
    supporting_papers: analysis.supporting_papers.map((paper) => ({
      paper_key: paper.paper_key,
      title: paper.title
    }))
  }));
  return [
    'Generate interdisciplinary idea fragments by recontextualizing source-domain takeaways back into the target domain.',
    'Return strict JSON only:',
    '{"idea_fragments":[{"title":"...","target_challenge_id":"...","target_challenge":"...","source_domain":"...","source_takeaway_ids":["..."],"integration_rationale":"...","novelty_score":0.0,"usefulness_score":0.0,"supporting_paper_keys":["..."]}]}',
    '',
    'Rules:',
    '- Fragments are incomplete idea directions, not full proposals.',
    '- Explain how source concepts complement target-domain assumptions or limitations.',
    '- Ground each fragment in source_takeaway_ids and supporting_paper_keys.',
    '- Scores are optional proxies; final ranking will use pairwise comparison.',
    '',
    `Problem: ${problem}`,
    `Target domain: ${targetDomain}`,
    `Accepted source analyses JSON: ${JSON.stringify(payload)}`
  ].join('\n');
}

function fallbackIdeaFragments(problem, targetDomain, sourceAnalyses = []) {
  return sourceAnalyses
    .filter((entry) => entry.accepted)
    .map((analysis, index) => {
      const takeaway = analysis.takeaways[0] || {};
      return {
        id: `fragment:${stableHash(`${analysis.source_domain}:${analysis.target_challenge}:${index}`, 10)}`,
        title: truncate(`${analysis.source_domain} perspective for ${targetDomain}`, 120),
        target_challenge_id: analysis.target_challenge_id,
        target_challenge: analysis.target_challenge,
        source_domain: analysis.source_domain,
        source_takeaway_ids: analysis.takeaways.map((entry) => entry.id).filter(Boolean),
        source_takeaways: analysis.takeaways,
        integration_rationale: `Adapt ${takeaway.concept || analysis.source_domain} to address ${analysis.target_challenge} in ${targetDomain}.`,
        novelty_score: clampScore(0.55 + Math.min(0.35, analysis.relevance_ratio / 3)),
        usefulness_score: clampScore(0.45 + Math.min(0.45, analysis.relevant_paper_count / 10)),
        supporting_paper_keys: analysis.supporting_papers.map((paper) => paper.paper_key),
        supporting_papers: analysis.supporting_papers,
        problem
      };
    });
}

function sanitizeIdeaFragments(raw = {}, problem, targetDomain, sourceAnalyses = [], limit = DEFAULT_IDEA_FRAGMENT_LIMIT) {
  const analysesByDomain = new Map(sourceAnalyses.map((entry) => [entry.source_domain, entry]));
  const records = Array.isArray(raw.idea_fragments)
    ? raw.idea_fragments
    : Array.isArray(raw.ideaFragments)
      ? raw.ideaFragments
      : [];
  const fragments = records.map((record, index) => {
    const sourceDomain = normalizeDomain(record.source_domain || record.sourceDomain);
    const analysis = analysesByDomain.get(sourceDomain);
    if (!sourceDomain || !analysis) return null;
    const title = compactText(record.title || `${sourceDomain} perspective for ${targetDomain}`);
    return {
      id: compactText(record.id || `fragment:${stableHash(`${sourceDomain}:${title}:${index}`, 10)}`),
      title: truncate(title, 160),
      target_challenge_id: compactText(record.target_challenge_id || record.targetChallengeId || analysis.target_challenge_id),
      target_challenge: compactText(record.target_challenge || record.targetChallenge || analysis.target_challenge),
      source_domain: sourceDomain,
      source_takeaway_ids: asArray(record.source_takeaway_ids || record.sourceTakeawayIds)
        .map(compactText)
        .filter(Boolean),
      source_takeaways: analysis.takeaways,
      integration_rationale: compactText(record.integration_rationale || record.integrationRationale || record.rationale),
      novelty_score: clampScore(record.novelty_score ?? record.noveltyScore, 0.5),
      usefulness_score: clampScore(record.usefulness_score ?? record.usefulnessScore, 0.5),
      supporting_paper_keys: asArray(record.supporting_paper_keys || record.supportingPaperKeys)
        .map(compactText)
        .filter(Boolean),
      supporting_papers: analysis.supporting_papers,
      problem
    };
  }).filter(Boolean);
  const output = fragments.length ? fragments : fallbackIdeaFragments(problem, targetDomain, sourceAnalyses);
  return output.slice(0, limit);
}

async function generateIdeaFragments(problem, targetDomain, sourceAnalyses, params, options) {
  const limit = toPositiveInteger(params.ideaFragmentLimit || params.idea_fragment_limit || params.limit, DEFAULT_IDEA_FRAGMENT_LIMIT, 24);
  try {
    const raw = await callWorkflowLlmJson(
      'idea_fragments',
      buildIdeaFragmentsPrompt(problem, targetDomain, sourceAnalyses),
      params,
      options
    );
    return sanitizeIdeaFragments(raw, problem, targetDomain, sourceAnalyses, limit);
  } catch {
    return fallbackIdeaFragments(problem, targetDomain, sourceAnalyses).slice(0, limit);
  }
}

function buildPairwisePrompt(fragments = []) {
  const pairs = [];
  for (let left = 0; left < fragments.length; left += 1) {
    for (let right = left + 1; right < fragments.length; right += 1) {
      pairs.push({
        pair_id: `p${left + 1}_${right + 1}`,
        left_id: fragments[left].id,
        right_id: fragments[right].id
      });
    }
  }
  return {
    pairs,
    prompt: [
      'Rank interdisciplinary idea fragments through pairwise comparison.',
      'Return strict JSON only:',
      '{"comparisons":[{"pair_id":"p1_2","winner_id":"fragment:...","reason":"..."}]}',
      '',
      'Judge stronger interdisciplinary potential by:',
      '- depth of target-source integration',
      '- non-trivial novelty from a distant source domain',
      '- grounding in source evidence',
      '- ability to address unresolved target-domain challenges',
      '- plausible usefulness without collapsing into obvious adjacent work',
      '',
      `Fragments JSON: ${JSON.stringify(fragments.map((fragment) => ({
        id: fragment.id,
        title: fragment.title,
        target_challenge: fragment.target_challenge,
        source_domain: fragment.source_domain,
        source_takeaways: fragment.source_takeaways.map((entry) => ({
          id: entry.id,
          concept: entry.concept,
          mechanism: entry.mechanism
        })),
        integration_rationale: fragment.integration_rationale
      })))}`,
      `Pairs JSON: ${JSON.stringify(pairs)}`
    ].join('\n')
  };
}

function heuristicPairwiseRanking(fragments = [], reason = '') {
  const ranked = [...fragments].sort((left, right) => {
    const leftScore = (Number(left.novelty_score || 0) * 0.45)
      + (Number(left.usefulness_score || 0) * 0.35)
      + (Number(left.supporting_paper_keys?.length || 0) * 0.02);
    const rightScore = (Number(right.novelty_score || 0) * 0.45)
      + (Number(right.usefulness_score || 0) * 0.35)
      + (Number(right.supporting_paper_keys?.length || 0) * 0.02);
    return rightScore - leftScore || left.title.localeCompare(right.title);
  });
  return {
    ranking_backend: 'heuristic-pairwise-fallback-v1',
    fallback_reason: reason,
    pairwise_comparisons: [],
    ranked_fragments: ranked.map((fragment, index) => ({
      rank: index + 1,
      fragment_id: fragment.id,
      title: fragment.title,
      source_domain: fragment.source_domain,
      wins: ranked.length - index - 1,
      losses: index,
      fragment
    }))
  };
}

function aggregatePairwiseComparisons(fragments = [], raw = {}, pairs = []) {
  const pairById = new Map(pairs.map((pair) => [pair.pair_id, pair]));
  const seenPairs = new Set();
  const comparisons = asArray(raw.comparisons || raw.pairwise_comparisons || raw.pairwiseComparisons)
    .map((record) => {
      const pairId = compactText(record.pair_id || record.pairId || record.id);
      const pair = pairById.get(pairId);
      const winnerId = compactText(record.winner_id || record.winnerId || record.winner);
      if (!pair || seenPairs.has(pairId) || (winnerId !== pair.left_id && winnerId !== pair.right_id)) return null;
      seenPairs.add(pairId);
      const loserId = winnerId === pair.left_id ? pair.right_id : pair.left_id;
      return {
        pair_id: pairId,
        left_id: pair.left_id,
        right_id: pair.right_id,
        winner_id: winnerId,
        loser_id: loserId,
        reason: compactText(record.reason || record.rationale || '')
      };
    })
    .filter(Boolean);

  const stats = new Map(fragments.map((fragment) => [fragment.id, {
    fragment,
    wins: 0,
    losses: 0
  }]));
  for (const comparison of comparisons) {
    stats.get(comparison.winner_id).wins += 1;
    stats.get(comparison.loser_id).losses += 1;
  }

  const ranked = [...stats.values()].sort((left, right) => (
    right.wins - left.wins
    || left.losses - right.losses
    || right.fragment.novelty_score - left.fragment.novelty_score
    || right.fragment.usefulness_score - left.fragment.usefulness_score
    || left.fragment.title.localeCompare(right.fragment.title)
  ));

  return {
    ranking_backend: 'llm-pairwise-v1',
    expected_pair_count: pairs.length,
    valid_pair_count: comparisons.length,
    complete_pairwise_comparison: comparisons.length === pairs.length,
    pairwise_comparisons: comparisons,
    ranked_fragments: ranked.map((entry, index) => ({
      rank: index + 1,
      fragment_id: entry.fragment.id,
      title: entry.fragment.title,
      source_domain: entry.fragment.source_domain,
      wins: entry.wins,
      losses: entry.losses,
      fragment: entry.fragment
    }))
  };
}

async function rankIdeaFragmentsPairwise(fragments = [], params, options) {
  if (fragments.length <= 1) {
    return {
      ranking_backend: 'single-fragment-v1',
      pairwise_comparisons: [],
      ranked_fragments: fragments.map((fragment, index) => ({
        rank: index + 1,
        fragment_id: fragment.id,
        title: fragment.title,
        source_domain: fragment.source_domain,
        wins: 0,
        losses: 0,
        fragment
      }))
    };
  }

  const { prompt, pairs } = buildPairwisePrompt(fragments);
  try {
    const raw = await callWorkflowLlmJson('pairwise_ranking', prompt, params, options);
    const ranked = aggregatePairwiseComparisons(fragments, raw, pairs);
    if (ranked.complete_pairwise_comparison) return ranked;
    return heuristicPairwiseRanking(
      fragments,
      `LLM returned incomplete pairwise comparisons (${ranked.valid_pair_count}/${ranked.expected_pair_count}).`
    );
  } catch (error) {
    return heuristicPairwiseRanking(fragments, truncate(error?.message || error, 180));
  }
}

function buildCrossDomainQueries(sourcePlansByChallenge = []) {
  return sourcePlansByChallenge.flatMap((entry) => entry.source_domains.map((source) => ({
    target_challenge_id: entry.challenge.id,
    target_challenge: entry.challenge.domain_agnostic_challenge,
    source_domain: source.domain,
    rationale: source.rationale,
    queries: source.source_search_queries
  })));
}

function buildPacketBundle(result = {}) {
  return {
    contractVersion: LIVE_IDEA_CATALYST_PACKET_CONTRACT_VERSION,
    packet_version: LIVE_IDEA_CATALYST_PACKET_V2_VERSION,
    mode: 'live_discovery',
    decomposition: result.decomposition,
    target_domain_analysis: result.target_domain_analysis,
    cross_domain_queries: result.cross_domain_queries,
    cross_domain_searches: result.cross_domain_queries,
    source_domain_analyses: result.source_domain_analyses,
    cross_domain_analysis: result.source_domain_analyses,
    idea_fragments: result.idea_fragments,
    interdisciplinary_ranking: result.interdisciplinary_ranking,
    innovation_contract_version: result.innovation_contract_version,
    contribution_claims: result.contribution_claims || [],
    must_cite_set: result.must_cite_set || [],
    novelty_certificate: result.novelty_certificate || null,
    review_packet: result.review_packet || null,
    storyline_dag: result.storyline_dag || null,
    counterfactuals: result.counterfactuals || [],
    falsification_plans: result.falsification_plans || result.counterfactuals || [],
    live_retrieval: result.live_retrieval,
    faithfulness_report: result.faithfulness_report
  };
}

function normalizeTargetField(targetDomain, params = {}) {
  const explicit = normalizeS2FieldsOfStudy(params.targetFieldOfStudy || params.target_field_of_study || params.fieldsOfStudy || params.fields_of_study);
  return explicit[0] || normalizeDomain(targetDomain);
}

export async function runLiveIdeaCatalyst(params = {}, options = {}) {
  const problem = compactText(params.problem || params.query || params.abstractChallenge || params.abstract_challenge);
  const targetDomain = compactText(params.targetDomain || params.target_domain);
  if (!problem) throw new Error('problem is required.');
  if (!targetDomain) throw new Error('targetDomain is required.');

  const targetField = normalizeTargetField(targetDomain, params);
  const maxPapersPerQuery = toPositiveInteger(
    params.maxPapersPerQuery || params.max_papers_per_query,
    DEFAULT_MAX_PAPERS_PER_QUERY,
    1000
  );
  const sourceRelevanceThreshold = toThreshold(params.sourceRelevanceThreshold ?? params.source_relevance_threshold);
  const generatedAt = new Date().toISOString();

  const researchQuestions = await decomposeProblem(problem, targetDomain, targetField, params, options);
  const targetQuestionAnalyses = [];
  const targetRetrievals = [];
  for (const question of researchQuestions) {
    const targetEvidence = await retrieveTargetEvidence(question, targetField, {
      ...params,
      maxPapersPerQuery
    });
    targetRetrievals.push(...targetEvidence.retrievals.map((retrieval) => ({
      question_id: question.id,
      query: retrieval.query,
      fieldsOfStudy: retrieval.fieldsOfStudy,
      resultCount: retrieval.resultCount,
      paperCount: retrieval.paperCount,
      abstractFallbackCount: retrieval.abstractFallbackCount
    })));
    targetQuestionAnalyses.push(await assessTargetQuestion(question, targetEvidence.snippets, params, options));
  }

  const remainingChallenges = targetQuestionAnalyses.flatMap((entry) => entry.remaining_challenges || []);
  const sourcePlansByChallenge = [];
  for (const challenge of remainingChallenges) {
    sourcePlansByChallenge.push({
      challenge,
      source_domains: await selectSourceDomains(challenge, targetDomain, targetField, params, options)
    });
  }

  const sourceDomainAnalyses = [];
  for (const plan of sourcePlansByChallenge) {
    for (const sourceDomain of plan.source_domains) {
      sourceDomainAnalyses.push(await analyzeSourceDomain(sourceDomain, plan.challenge, {
        ...params,
        maxPapersPerQuery,
        sourceRelevanceThreshold
      }, options));
    }
  }

  const fragments = await generateIdeaFragments(problem, targetDomain, sourceDomainAnalyses, params, options);
  const ranking = await rankIdeaFragmentsPairwise(fragments, params, options);
  const rankedFragments = ranking.ranked_fragments.map((entry) => ({
    rank: entry.rank,
    ...entry.fragment
  }));

  const result = {
    contractVersion: LIVE_IDEA_CATALYST_CONTRACT_VERSION,
    contractVersionV2: LIVE_IDEA_CATALYST_V2_CONTRACT_VERSION,
    contract_version_v2: LIVE_IDEA_CATALYST_V2_CONTRACT_VERSION,
    mode: 'live_discovery',
    run_id: params.runId || params.run_id || null,
    trace_id: params.traceId || params.trace_id || null,
    problem,
    targetDomain,
    target_domain: targetDomain,
    targetFieldOfStudy: targetField,
    target_field_of_study: targetField,
    generatedAt,
    decomposition: {
      coarse_grained_domain: targetField,
      fine_grained_domain: targetDomain,
      core_challenge: problem,
      research_questions: researchQuestions,
      questions: researchQuestions
    },
    target_domain_analysis: [{
      target_domain: targetDomain,
      target_field_of_study: targetField,
      question_analyses: targetQuestionAnalyses,
      remaining_challenges: remainingChallenges,
      overall_assessment: remainingChallenges.length
        ? (targetQuestionAnalyses.some((entry) => entry.progress === 'largely unexplored') ? 'largely unexplored' : 'partially addressed')
        : 'largely resolved'
    }],
    cross_domain_queries: buildCrossDomainQueries(sourcePlansByChallenge),
    source_domain_analyses: sourceDomainAnalyses,
    idea_fragments: rankedFragments,
    interdisciplinary_ranking: ranking,
    live_retrieval: {
      retrieval_backend: 'semantic-scholar-snippets',
      semantic_scholar_endpoint: 'GET /graph/v1/snippet/search',
      max_papers_per_query: maxPapersPerQuery,
      source_relevance_threshold: sourceRelevanceThreshold,
      target_retrievals: targetRetrievals,
      accepted_source_domain_count: sourceDomainAnalyses.filter((entry) => entry.accepted).length,
      pruned_source_domain_count: sourceDomainAnalyses.filter((entry) => !entry.accepted).length
    },
    faithfulness_report: {
      semantic_scholar_snippets_adapter: true,
      live_target_source_retrieval_loop: true,
      source_domain_majority_relevance_pruning: true,
      pairwise_llm_interdisciplinary_ranking: ranking.ranking_backend === 'llm-pairwise-v1',
      pairwise_ranking_backend: ranking.ranking_backend
    },
    llm_ledger_refs: buildIdeaCatalystLlmLedgerRefs(params, options)
  };
  const innovationArtifacts = buildIdeaCatalystInnovationArtifacts({
    ...result,
    problem,
    targetDomain,
    target_domain: targetDomain,
    target_domain_analysis: result.target_domain_analysis,
    source_domain_analyses: result.source_domain_analyses,
    idea_fragments: result.idea_fragments,
    timeCutoff: params.timeCutoff || params.time_cutoff,
    mustCiteK: params.mustCiteK || params.must_cite_k,
    reviewerPanel: params.reviewerPanel || params.reviewer_panel,
    storylineMode: params.storylineMode || params.storyline_mode,
    counterfactualBudget: params.counterfactualBudget || params.counterfactual_budget
  }, {
    timeCutoff: params.timeCutoff || params.time_cutoff,
    mustCiteK: params.mustCiteK || params.must_cite_k,
    reviewerPanel: params.reviewerPanel || params.reviewer_panel,
    storylineMode: params.storylineMode || params.storyline_mode,
    counterfactualBudget: params.counterfactualBudget || params.counterfactual_budget,
    writeBack: params.writeBack || params.write_back
  });
  Object.assign(result, {
    ...innovationArtifacts,
    packet_version: LIVE_IDEA_CATALYST_PACKET_V2_VERSION
  });
  result.packetBundle = buildPacketBundle(result);
  result.packet_bundle = result.packetBundle;
  result.evidence_export = buildIdeaCatalystEvidenceExport({
    mode: 'live_discovery',
    problem,
    targetDomain,
    live: result,
    runId: result.run_id,
    traceId: result.trace_id,
    llm_ledger_refs: result.llm_ledger_refs
  });
  return result;
}
