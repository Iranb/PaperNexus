import { createRequire } from 'node:module';
import { getDefaultLlmApiKeyEnv, loadLlmApiKey, resolveLlmConfig } from '../llm/ollama.js';
import { stableHash, truncate } from '../../lib/utils.js';
import { buildLiteratureDiscoveryPlan } from './query-planner.js';

const require = createRequire(import.meta.url);
let jsonrepair = null;
try {
  ({ jsonrepair } = require('jsonrepair'));
} catch {}

const DEFAULT_LLM_QUERY_LIMIT = 4;
const DEPTH_LLM_QUERY_LIMITS = {
  quick: 3,
  default: 4,
  deep: 8
};
const SEARCH_LLM_QUERY_LIMITS = {
  quick: 2,
  balanced: 2,
  deep: 4
};
const SEARCH_LLM_TIMEOUT_LIMITS_MS = {
  quick: 8000,
  balanced: 12000,
  deep: 18000
};
const KNOWN_DISCIPLINES = new Set([
  'general',
  'computer-science',
  'biomedicine',
  'physics-math',
  'economics-social-science',
  'chemistry-materials',
  'humanities-law',
  'chinese-scholarship'
]);

const FAMILY_ALIASES = new Map([
  ['direct', 'llm_direct'],
  ['core', 'llm_direct'],
  ['main', 'llm_direct'],
  ['synonym', 'llm_synonym'],
  ['synonyms', 'llm_synonym'],
  ['terminology', 'llm_synonym'],
  ['variant', 'llm_synonym'],
  ['adjacent', 'llm_adjacent'],
  ['related', 'llm_adjacent'],
  ['context', 'llm_context'],
  ['discipline', 'llm_context'],
  ['venue', 'llm_context'],
  ['artifact', 'llm_artifact'],
  ['benchmark', 'llm_artifact'],
  ['dataset', 'llm_artifact'],
  ['code', 'llm_artifact'],
  ['review', 'llm_review'],
  ['survey', 'llm_review'],
  ['author', 'llm_author']
]);

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDisabledFlag(value) {
  return ['0', 'false', 'off', 'no'].includes(String(value || '').trim().toLowerCase());
}

function firstConfigured(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function normalizeDiscoveryOperation(value = '') {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function resolveSearchMode(params = {}) {
  const explicit = compactText(params.searchMode || params.search_mode).toLowerCase();
  if (explicit === 'quick') return 'quick';
  if (explicit === 'balanced' || explicit === 'default') return 'balanced';
  if (explicit === 'deep' || explicit === 'full') return 'deep';
  const depth = compactText(params.depth).toLowerCase();
  if (depth === 'quick') return 'quick';
  if (depth === 'deep') return 'deep';
  return 'balanced';
}

function resolvePlanningMode(params = {}) {
  return compactText(params.planningMode || params.planning_mode).toLowerCase().replace(/-/g, '_');
}

function explicitLlmPlannerPreference(params = {}) {
  return params.llmQueryPlanner !== undefined
    || params.llm_query_planner !== undefined
    || Boolean(resolvePlanningMode(params));
}

function searchDisablesLlmPlannerByDefault(params = {}) {
  const operation = normalizeDiscoveryOperation(params.discoveryOperation || params.discovery_operation || params.operation);
  if (operation !== 'search') return false;
  if (resolveSearchMode(params) === 'deep') return false;
  if (explicitLlmPlannerPreference(params)) return false;
  return true;
}

function plannerModeDisablesLlm(params = {}) {
  const mode = resolvePlanningMode(params);
  return ['rules', 'rule_based', 'rulebased', 'off', 'disabled', 'false'].includes(mode);
}

function plannerModeEnablesLlm(params = {}) {
  const mode = resolvePlanningMode(params);
  return ['llm', 'llm_augmented', 'llm_query_planner', 'augmented'].includes(mode);
}

function isLlmQueryPlannerEnabled(params = {}) {
  if (plannerModeDisablesLlm(params)) return false;
  if (plannerModeEnablesLlm(params)) return true;
  if (params.llmQueryPlanner !== undefined) return !isDisabledFlag(params.llmQueryPlanner);
  if (params.llm_query_planner !== undefined) return !isDisabledFlag(params.llm_query_planner);
  if (process.env.PAPERNEXUS_DISCOVERY_LLM_QUERY_PLANNER !== undefined) {
    return !isDisabledFlag(process.env.PAPERNEXUS_DISCOVERY_LLM_QUERY_PLANNER);
  }
  return true;
}

function normalizeDiscipline(value = '', fallback = '') {
  const normalized = compactText(value).toLowerCase();
  if (KNOWN_DISCIPLINES.has(normalized)) return normalized;
  return KNOWN_DISCIPLINES.has(fallback) ? fallback : '';
}

function normalizeFamily(value = '', index = 0) {
  const normalized = compactText(value)
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (FAMILY_ALIASES.has(normalized)) return FAMILY_ALIASES.get(normalized);
  if (normalized.startsWith('llm_')) return normalized || `llm_query_${index + 1}`;
  return normalized ? `llm_${normalized}` : `llm_query_${index + 1}`;
}

function resolveMaxLlmQueries(params = {}) {
  const depth = compactText(params.depth || 'default').toLowerCase();
  const fallback = DEPTH_LLM_QUERY_LIMITS[depth] || DEFAULT_LLM_QUERY_LIMIT;
  const parsed = Number(params.maxLlmQueries || params.max_llm_queries || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function withSearchPlannerDefaults(params = {}) {
  const operation = normalizeDiscoveryOperation(params.discoveryOperation || params.discovery_operation || params.operation);
  if (operation !== 'search') return params;
  const searchMode = resolveSearchMode(params);
  return {
    ...params,
    maxLlmQueries: firstConfigured(
      params.maxLlmQueries,
      params.max_llm_queries,
      SEARCH_LLM_QUERY_LIMITS[searchMode] || SEARCH_LLM_QUERY_LIMITS.balanced
    )
  };
}

function withSearchPlannerTimeout(params = {}, config = {}) {
  const operation = normalizeDiscoveryOperation(params.discoveryOperation || params.discovery_operation || params.operation);
  if (operation !== 'search') return config;
  const searchMode = resolveSearchMode(params);
  const cap = SEARCH_LLM_TIMEOUT_LIMITS_MS[searchMode] || SEARCH_LLM_TIMEOUT_LIMITS_MS.balanced;
  const requested = Number(firstConfigured(params.llmTimeoutMs, params.llm_timeout_ms, config.timeoutMs, 45000));
  const timeoutMs = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 45000, cap));
  return {
    ...config,
    timeoutMs
  };
}

function buildPrompt(params = {}, maxQueries = DEFAULT_LLM_QUERY_LIMIT) {
  const topic = compactText(params.topic);
  const discipline = compactText(params.discipline);
  const depth = compactText(params.depth || 'default');
  return [
    'You are a scholarly literature search query planner.',
    'Split the user topic into orthogonal source-search queries for APIs such as OpenAlex, Semantic Scholar, Crossref, arXiv, DBLP, PubMed, and Europe PMC.',
    '',
    'Return strict JSON only:',
    '{',
    '  "discipline": "general|computer-science|biomedicine|physics-math|economics-social-science|chemistry-materials|humanities-law|chinese-scholarship",',
    '  "queries": [',
    '    {"query": "...", "family": "direct|synonym|context|artifact|review|author", "rationale": "..."}',
    '  ]',
    '}',
    '',
    'Guidelines:',
    `- Produce ${Math.min(3, maxQueries)}-${maxQueries} short keyword queries, not paragraphs.`,
    '- Make the queries genuinely different retrieval routes: direct topic, synonyms/neighboring terminology, field or venue context, and survey/benchmark/dataset/code/author entry points.',
    '- For deep searches, include established adjacent terminology and background areas that related-work sections would cite.',
    '- Do not fabricate exact paper titles, authors, venues, datasets, or acronyms; only use names you can infer confidently from the topic.',
    '- Avoid boolean operators unless they are common in scholarly search APIs.',
    '- Keep each query under 14 words.',
    '',
    `Topic: ${topic}`,
    `Depth: ${depth}`,
    discipline ? `Discipline hint: ${discipline}` : 'Discipline hint: auto'
  ].join('\n');
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

  return [...new Set(candidates.filter(Boolean))];
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
      throw new Error(`LLM query planner request failed (${response.status}): ${truncate(text, 240)}`);
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

async function callPlannerLlm(prompt, config = {}) {
  if (config.provider === 'openai') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for LLM query planner. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/chat/completions`, {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: Math.min(1200, Math.max(256, Number(config.maxTokens || 1200)))
    }, {
      authorization: `Bearer ${apiKey}`
    }, config.timeoutMs);
    return parseJsonText(extractOpenAiText(payload));
  }

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for LLM query planner. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')} or run papernexus auth llm set.`);
    }
    const payload = await postJson(`${config.baseUrl}/messages`, {
      model: config.model,
      max_tokens: Math.min(1200, Math.max(256, Number(config.maxTokens || 1200))),
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

function sanitizeLlmQueries(raw = {}, topic = '', maxQueries = DEFAULT_LLM_QUERY_LIMIT) {
  const records = Array.isArray(raw?.queries)
    ? raw.queries
    : Array.isArray(raw?.searchQueries)
      ? raw.searchQueries
      : [];
  const seen = new Set();
  const queries = [];

  for (const [index, record] of records.entries()) {
    const query = compactText(typeof record === 'string' ? record : record?.query);
    const normalized = query.toLowerCase();
    if (!query || normalized === compactText(topic).toLowerCase() || seen.has(normalized)) continue;
    seen.add(normalized);
    queries.push({
      query: truncate(query.replace(/^"+|"+$/g, ''), 180),
      family: normalizeFamily(record?.family || record?.type || record?.strategy, index),
      rationale: truncate(record?.rationale || record?.reason || 'LLM-planned orthogonal literature search route.', 220)
    });
    if (queries.length >= maxQueries) break;
  }

  return queries;
}

function makePlannedQuery(candidate = {}, rulePlan = {}, index = 0) {
  const key = `${candidate.family}:${candidate.query.toLowerCase()}`;
  return {
    id: `q${index + 1}-${stableHash(key, 8)}`,
    query: candidate.query,
    family: candidate.family,
    rationale: candidate.rationale,
    discipline: candidate.discipline || rulePlan.discipline,
    preferredVenuePacks: rulePlan.preferredVenuePacks || []
  };
}

function reindexQueries(queries = [], rulePlan = {}) {
  return queries.map((query, index) => ({
    ...query,
    id: `q${index + 1}-${stableHash(`${query.family}:${String(query.query || '').toLowerCase()}`, 8)}`,
    discipline: query.discipline || rulePlan.discipline,
    preferredVenuePacks: query.preferredVenuePacks || rulePlan.preferredVenuePacks || []
  }));
}

function mergeLlmQueries(rulePlan = {}, llmQueries = [], maxQueries = 1) {
  const ruleQueries = rulePlan.queries || [];
  const directRule = ruleQueries[0] ? [ruleQueries[0]] : [];
  const ruleQuerySet = new Set(ruleQueries.map((entry) => compactText(entry.query).toLowerCase()).filter(Boolean));
  const llmPlanned = llmQueries
    .filter((entry) => !ruleQuerySet.has(compactText(entry.query).toLowerCase()))
    .map((entry, index) => makePlannedQuery(entry, rulePlan, directRule.length + index));
  const combined = [
    ...directRule,
    ...llmPlanned,
    ...ruleQueries.slice(1)
  ].slice(0, maxQueries);
  return reindexQueries(combined, rulePlan);
}

function withRulesMetadata(plan = {}, metadata = {}) {
  return {
    ...plan,
    queryPlanner: {
      mode: 'rules',
      attempted: false,
      ...metadata
    }
  };
}

export async function buildLlmAugmentedLiteratureDiscoveryPlan(params = {}) {
  if (searchDisablesLlmPlannerByDefault(params)) {
    return withRulesMetadata(buildLiteratureDiscoveryPlan(params), {
      enabled: false,
      reason: 'search-default-rule-based'
    });
  }

  if (!isLlmQueryPlannerEnabled(params)) {
    return withRulesMetadata(buildLiteratureDiscoveryPlan(params), {
      enabled: false,
      reason: 'disabled'
    });
  }

  const plannerParams = withSearchPlannerDefaults(params);
  const config = withSearchPlannerTimeout(plannerParams, resolveLlmConfig(plannerParams));
  if (!config.enabled || !config.model) {
    return withRulesMetadata(buildLiteratureDiscoveryPlan(plannerParams), {
      enabled: true,
      reason: 'llm-unconfigured'
    });
  }

  const maxLlmQueries = resolveMaxLlmQueries(plannerParams);
  let rawPlan;
  try {
    rawPlan = typeof plannerParams.llmQueryPlannerJson === 'function'
      ? await plannerParams.llmQueryPlannerJson(buildPrompt(plannerParams, maxLlmQueries), { config, params: plannerParams })
      : await callPlannerLlm(buildPrompt(plannerParams, maxLlmQueries), config);
    if (typeof rawPlan === 'string') rawPlan = parseJsonText(rawPlan);
  } catch (error) {
    return withRulesMetadata(buildLiteratureDiscoveryPlan(plannerParams), {
      attempted: true,
      enabled: true,
      provider: config.provider,
      model: config.model,
      reason: `llm-failed: ${truncate(error?.message || error, 220)}`
    });
  }

  const rulePlan = buildLiteratureDiscoveryPlan({
    ...plannerParams,
    discipline: plannerParams.discipline || normalizeDiscipline(rawPlan?.discipline)
  });
  const llmQueries = sanitizeLlmQueries(rawPlan, rulePlan.topic, maxLlmQueries);
  if (!llmQueries.length) {
    return withRulesMetadata(rulePlan, {
      attempted: true,
      enabled: true,
      provider: config.provider,
      model: config.model,
      reason: 'llm-returned-no-usable-queries'
    });
  }

  const defaultMaxQueries = rulePlan.queries.length + llmQueries.length;
  const maxQueries = Math.max(
    1,
    Math.floor(Number(plannerParams.maxQueries || plannerParams.max_queries || defaultMaxQueries) || defaultMaxQueries)
  );
  return {
    ...rulePlan,
    queries: mergeLlmQueries(rulePlan, llmQueries, maxQueries),
    queryPlanner: {
      mode: 'llm',
      attempted: true,
      enabled: true,
      provider: config.provider,
      model: config.model,
      llmQueryCount: llmQueries.length,
      fallback: 'rules'
    }
  };
}
