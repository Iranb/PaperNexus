import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import {
  ALLOWED_NODE_TYPES,
  ALLOWED_RELATION_TYPES,
  normalizeNodeTypeName,
  normalizeRelationTypeName,
  resolveCompatibleRelationType
} from '../graph/rules.js';
import {
  buildDefaultLlmKeychainAccount,
  getDefaultLlmKeychainService,
  getKeychainSecret
} from '../../lib/keychain.js';
import { normalizeText, stableHash, truncate } from '../../lib/utils.js';

const require = createRequire(import.meta.url);
let jsonrepair = null;
try {
  ({ jsonrepair } = require('jsonrepair'));
} catch {}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_MAX_TOKENS = 2048;
const ANTHROPIC_VERSION = '2023-06-01';

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function isEnabledFlag(value) {
  return value === true || value === '1' || value === 'true';
}

function cleanText(value, maxLength = 320) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();

  // 过滤图表/坐标轴噪声（例如：0.50 0.45 0.40 [SSR] [CLIP]）
  if (/^[\d\s\.\-\[\]]+$/.test(text) || /^[\[\]A-Z'\s]+\?/.test(text)) {
    return '';
  }

  // 过滤纯数字序列、坐标轴刻度
  if (/^[\d\.\-\s]+$/.test(text)) {
    return '';
  }

  // 过滤乱码/OCR 噪声（连续的特殊字符）
  if (/[^A-Za-z0-9\u4e00-\u9fff\s]{5,}/.test(text)) {
    text = text.replace(/[^A-Za-z0-9\u4e00-\u9fff\s]+/g, ' ');
  }

  return truncate(text, maxLength);
}

function sanitizeEntityRecord(record, fallbackType) {
  const name = cleanText(record?.name || record?.text || '', 180);
  const type = normalizeNodeTypeName(record?.type || fallbackType);
  if (!name || !type) return null;

  return {
    name,
    text: name,
    type,
    normalized: normalizeText(name),
    evidenceText: cleanText(record?.evidenceText || record?.evidence || name, 280),
    sectionHeading: cleanText(record?.sectionHeading || record?.section || '', 80),
    sectionRole: cleanText(record?.sectionRole || record?.role || '', 32),
    confidence: Number.isFinite(Number(record?.confidence)) ? Number(record.confidence) : 0.62,
    explicitOrInferred: String(record?.explicitOrInferred || 'inferred').toLowerCase() === 'explicit'
      ? 'explicit'
      : 'inferred'
  };
}

function sanitizeRelationRecord(record) {
  const sourceType = normalizeNodeTypeName(record?.sourceType);
  const targetType = normalizeNodeTypeName(record?.targetType);
  const proposedType = normalizeRelationTypeName(record?.type);
  const sourceName = cleanText(record?.sourceName || '', 180);
  const targetName = cleanText(record?.targetName || '', 180);
  const type = sourceType && targetType ? resolveCompatibleRelationType(sourceType, targetType, proposedType) : null;

  if (!sourceType || !targetType || !type || !sourceName || !targetName) {
    return null;
  }

  return {
    sourceType,
    sourceName,
    targetType,
    targetName,
    type,
    confidence: Number.isFinite(Number(record?.confidence)) ? Number(record.confidence) : 0.64,
    evidenceText: cleanText(record?.evidenceText || record?.evidence || '', 280),
    rationale: cleanText(record?.rationale || '', 220),
    explicitOrInferred: String(record?.explicitOrInferred || 'inferred').toLowerCase() === 'explicit'
      ? 'explicit'
      : 'inferred'
  };
}

function collectEntitySnapshot(semanticPaper) {
  const groups = [
    ['problems', NODE_TYPES.PROBLEM],
    ['methods', NODE_TYPES.METHOD],
    ['claims', NODE_TYPES.CLAIM],
    ['findings', NODE_TYPES.FINDING],
    ['researchGoals', NODE_TYPES.RESEARCH_GOAL],
    ['limitations', NODE_TYPES.LIMITATION],
    ['assumptions', NODE_TYPES.ASSUMPTION],
    ['datasets', NODE_TYPES.DATASET],
    ['benchmarks', NODE_TYPES.BENCHMARK],
    ['metrics', NODE_TYPES.METRIC],
    ['futureDirections', NODE_TYPES.FUTURE_DIRECTION]
  ];

  return groups.flatMap(([key, type]) => {
    return (semanticPaper[key] || []).map((entry) => ({
      type,
      name: cleanText(entry.name || entry.text || '', 160),
      evidenceText: cleanText(entry.evidenceText || entry.text || entry.name || '', 220),
      confidence: entry.confidence ?? 0.6
    })).filter((entry) => entry.name);
  });
}

function buildPrompt(parsedPaper, semanticPaper) {
  const sections = (parsedPaper.sections || [])
    .slice(0, 6)
    .map((section) => `${section.heading || section.role || 'Section'}: ${cleanText(section.text, 420)}`)
    .join('\n\n');
  const entities = collectEntitySnapshot(semanticPaper)
    .map((entity) => `- ${entity.type}: ${entity.name} | evidence: ${entity.evidenceText}`)
    .join('\n');

  return [
    'You are building a multi-layer research knowledge graph from a paper.',
    'Return strict JSON only.',
    'Do not invent entities that are unsupported by the paper.',
    'Focus on relations that help research topic selection, assumption tracking, method transfer, and innovation composition.',
    '',
    `Paper title: ${parsedPaper.title}`,
    `Abstract: ${cleanText(semanticPaper.abstract || parsedPaper.abstract || '', 800)}`,
    '',
    'Candidate entities:',
    entities || '- none',
    '',
    'Relevant paper excerpts:',
    sections || 'No sections available.',
    '',
    'Allowed node types:',
    [...ALLOWED_NODE_TYPES].join(', '),
    '',
    'Allowed relation types:',
    [...ALLOWED_RELATION_TYPES].join(', '),
    '',
    'Return this JSON shape:',
    '{',
    '  "benchmarks": [{"name": "...", "type": "Benchmark", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '  "findings": [{"name": "...", "type": "Finding", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '  "researchGoals": [{"name": "...", "type": "ResearchGoal", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '  "relations": [{"sourceType": "Method", "sourceName": "...", "targetType": "Problem", "targetName": "...", "type": "APPLIES_TO", "confidence": 0.0, "evidenceText": "...", "rationale": "...", "explicitOrInferred": "explicit"}]',
    '}',
    '',
    'Key relations to capture:',
    '- LEADS_TO: Method/Finding/Claim → ResearchGoal/Problem (what leads to what goal)',
    '- BLOCKED_BY: ResearchGoal/Problem/Method → Limitation/Assumption/Problem (what blocks progress)',
    '- SOLVES: Paper → Problem, USES: Paper → Method, CLAIMS: Paper → Claim',
    '',
    'Only emit relations that are strongly grounded in the paper text. Use explicitOrInferred="inferred" for transfer/composition hypotheses.'
  ].join('\n');
}

export function normalizeSemanticExtractionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'llm-assisted') return 'llm-assisted';
  if (normalized === 'llm-primary') return 'llm-primary';
  return 'heuristic-only';
}

function buildSemanticExtractionPrompt(parsedPaper, semanticPaper) {
  const importantRoles = new Set([
    'abstract',
    'introduction',
    'method',
    'experiments',
    'results',
    'analysis',
    'discussion',
    'conclusion'
  ]);
  const sections = (parsedPaper.sections || [])
    .filter((section) => importantRoles.has(section.role))
    .slice(0, 8)
    .map((section) => {
      return [
        `Section heading: ${section.heading || section.role || 'Section'}`,
        `Section role: ${section.role || 'body'}`,
        `Excerpt: ${cleanText(section.text, 700)}`
      ].join('\n');
    })
    .join('\n\n');
  const heuristicSnapshot = collectEntitySnapshot(semanticPaper)
    .map((entity) => `- ${entity.type}: ${entity.name} | evidence: ${entity.evidenceText}`)
    .join('\n');

  return [
    'You are extracting structured research objects from a paper for a knowledge graph.',
    'Return strict JSON only.',
    'Do not invent unsupported entities.',
    'Prefer short canonical names for Problem and Method nodes.',
    'Keep Claim, Limitation, Assumption, Evidence, and FutureDirection entries tightly grounded in the paper text.',
    'Merge synonymous surface forms into one canonical object when possible.',
    '',
    `Paper title: ${parsedPaper.title}`,
    `Abstract: ${cleanText(semanticPaper.abstract || '', 900)}`,
    '',
    'Heuristic candidates from the existing pipeline:',
    heuristicSnapshot || '- none',
    '',
    'Paper excerpts:',
    sections || 'No sections available.',
    '',
    'Return this JSON shape:',
    '{',
    '  "problems": [{"name":"...", "type":"Problem", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "methods": [{"name":"...", "type":"Method", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "claims": [{"name":"...", "type":"Claim", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "findings": [{"name":"...", "type":"Finding", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "researchGoals": [{"name":"...", "type":"ResearchGoal", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "limitations": [{"name":"...", "type":"Limitation", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "assumptions": [{"name":"...", "type":"Assumption", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "evidences": [{"name":"...", "type":"Evidence", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "futureDirections": [{"name":"...", "type":"FutureDirection", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "benchmarks": [{"name":"...", "type":"Benchmark", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "datasets": [{"name":"...", "type":"Dataset", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "metrics": [{"name":"...", "type":"Metric", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}]',
    '}',
    '',
    'Guidelines:',
    '- Problems: name the research challenge, not a sentence fragment.',
    '- Methods: use the canonical method or framework name.',
    '- Claims: capture the main asserted result or contribution.',
    '- Findings: capture concrete empirical observations.',
    '- ResearchGoals: capture the overarching goal or vision driving the research (often found in introduction/conclusion).',
    '- Limitations and assumptions: keep them specific and falsifiable.',
    '- Evidence: extract compact evidence units, not the entire paragraph.',
    '- If a category is unsupported, return an empty list.'
  ].join('\n');
}

function buildSemanticExtractionBatchPrompt(entries) {
  const importantRoles = new Set([
    'abstract',
    'introduction',
    'method',
    'experiments',
    'results',
    'analysis',
    'discussion',
    'conclusion'
  ]);
  const papers = entries.map((entry, index) => {
    const parsedPaper = entry.parsedPaper || {};
    const semanticPaper = entry.semanticPaper || {};
    return {
      id: String(entry.id || parsedPaper.paperId || semanticPaper.paperId || `paper-${index + 1}`),
      title: cleanText(parsedPaper.title || semanticPaper.paperTitle || '', 240),
      abstract: cleanText(semanticPaper.abstract || parsedPaper.abstract || '', 900),
      heuristicCandidates: collectEntitySnapshot(semanticPaper).slice(0, 20),
      sections: (parsedPaper.sections || [])
        .filter((section) => importantRoles.has(section.role))
        .slice(0, 8)
        .map((section) => ({
          heading: cleanText(section.heading || section.role || 'Section', 120),
          role: cleanText(section.role || 'body', 32),
          excerpt: cleanText(section.text, 700)
        }))
    };
  });

  return [
    'You are extracting structured research objects from multiple papers for a knowledge graph.',
    'Return strict JSON only.',
    'Do not invent unsupported entities.',
    'Prefer short canonical names for Problem and Method nodes.',
    'Keep Claim, Limitation, Assumption, Evidence, and FutureDirection entries tightly grounded in the paper text.',
    'Merge synonymous surface forms into one canonical object when possible.',
    '',
    'Return this JSON shape:',
    '{',
    '  "papers": [',
    '    {',
    '      "id": "...",',
    '      "problems": [{"name":"...", "type":"Problem", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "methods": [{"name":"...", "type":"Method", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "claims": [{"name":"...", "type":"Claim", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "findings": [{"name":"...", "type":"Finding", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "researchGoals": [{"name":"...", "type":"ResearchGoal", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "limitations": [{"name":"...", "type":"Limitation", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "assumptions": [{"name":"...", "type":"Assumption", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "evidences": [{"name":"...", "type":"Evidence", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "futureDirections": [{"name":"...", "type":"FutureDirection", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "benchmarks": [{"name":"...", "type":"Benchmark", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "datasets": [{"name":"...", "type":"Dataset", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "metrics": [{"name":"...", "type":"Metric", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}]',
    '    }',
    '  ]',
    '}',
    '',
    'Guidelines:',
    '- Problems: name the research challenge, not a sentence fragment.',
    '- Methods: use the canonical method or framework name.',
    '- Claims: capture the main asserted result or contribution.',
    '- Findings: capture concrete empirical observations.',
    '- ResearchGoals: capture the overarching goal or vision driving the research.',
    '- Limitations and assumptions: keep them specific and falsifiable.',
    '- Evidence: extract compact evidence units, not the entire paragraph.',
    '- If a category is unsupported, return an empty list.',
    '',
    'Papers:',
    JSON.stringify(papers, null, 2)
  ].join('\n');
}

function buildResearchSemanticsBatchPrompt(entries) {
  const papers = entries.map((entry, index) => {
    const parsedPaper = entry.parsedPaper || {};
    const semanticPaper = entry.semanticPaper || {};
    return {
      id: String(entry.id || parsedPaper.paperId || semanticPaper.paperId || `paper-${index + 1}`),
      title: cleanText(parsedPaper.title || semanticPaper.paperTitle || '', 240),
      abstract: cleanText(semanticPaper.abstract || parsedPaper.abstract || '', 800),
      candidateEntities: collectEntitySnapshot(semanticPaper).slice(0, 20),
      excerpts: (parsedPaper.sections || [])
        .slice(0, 6)
        .map((section) => ({
          heading: cleanText(section.heading || section.role || 'Section', 120),
          role: cleanText(section.role || 'body', 32),
          excerpt: cleanText(section.text, 420)
        }))
    };
  });

  return [
    'You are building a multi-layer research knowledge graph from multiple papers.',
    'Return strict JSON only.',
    'Do not invent entities or relations that are unsupported by the paper text.',
    'Focus on relations that help research topic selection, assumption tracking, method transfer, and innovation composition.',
    '',
    'Allowed node types:',
    [...ALLOWED_NODE_TYPES].join(', '),
    '',
    'Allowed relation types:',
    [...ALLOWED_RELATION_TYPES].join(', '),
    '',
    'Return this JSON shape:',
    '{',
    '  "papers": [',
    '    {',
    '      "id": "...",',
    '      "benchmarks": [{"name": "...", "type": "Benchmark", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '      "findings": [{"name": "...", "type": "Finding", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '      "researchGoals": [{"name": "...", "type": "ResearchGoal", "evidenceText": "...", "sectionHeading": "...", "confidence": 0.0, "explicitOrInferred": "explicit"}],',
    '      "relations": [{"sourceType": "Method", "sourceName": "...", "targetType": "Problem", "targetName": "...", "type": "APPLIES_TO", "confidence": 0.0, "evidenceText": "...", "rationale": "...", "explicitOrInferred": "explicit"}]',
    '    }',
    '  ]',
    '}',
    '',
    'Key relations to capture:',
    '- LEADS_TO: Method/Finding/Claim → ResearchGoal/Problem',
    '- BLOCKED_BY: ResearchGoal/Problem/Method → Limitation/Assumption/Problem',
    '- SOLVES: Paper → Problem, USES: Paper → Method, CLAIMS: Paper → Claim',
    '',
    'Only emit relations that are strongly grounded in the paper text. Use explicitOrInferred="inferred" for transfer/composition hypotheses.',
    '',
    'Papers:',
    JSON.stringify(papers, null, 2)
  ].join('\n');
}

function buildNodeCheckBatchPrompt(entries) {
  const nodes = entries.map((entry, index) => ({
    id: String(entry.id || `node-${index + 1}`),
    type: cleanText(entry.type || '', 48),
    name: cleanText(entry.name || '', 180),
    aliases: (entry.aliases || []).slice(0, 8).map((alias) => cleanText(alias, 120)).filter(Boolean),
    paperTitles: (entry.paperTitles || []).slice(0, 6).map((title) => cleanText(title, 180)).filter(Boolean),
    mentionCount: Number(entry.mentionCount || 0),
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.6,
    relationTypes: (entry.relationTypes || []).slice(0, 8).map((type) => cleanText(type, 48)).filter(Boolean),
    evidenceTexts: (entry.evidenceTexts || []).slice(0, 4).map((text) => cleanText(text, 220)).filter(Boolean)
  }));

  return [
    'You are validating staged graph nodes for a paper knowledge graph.',
    'Return strict JSON only.',
    'Decide whether each node should be kept, dropped, or renamed.',
    'Focus on evaluation-layer nodes such as datasets and benchmarks.',
    '',
    'Return this JSON shape:',
    '{',
    '  "nodes": [',
    '    {"id":"...", "verdict":"keep|drop|rename", "canonicalName":"...", "confidence":0.0, "reason":"..."}',
    '  ],',
    '  "errors": [{"id":"...", "error":"..."}]',
    '}',
    '',
    'Guidelines:',
    '- Keep specific reusable resources such as Office-Home, CIFAR-10, DomainNet, Oxford-IIIT Pet, ImageNet.',
    '- Drop generic placeholders such as "training dataset", "test dataset", "source domain data", "target domain benchmark", or any node that is not a specific named resource.',
    '- Rename only when the node is valid but the name should be normalized into a specific canonical form.',
    '- If uncertain, prefer keep over drop.',
    '',
    'Nodes:',
    JSON.stringify(nodes, null, 2)
  ].join('\n');
}

function normalizeProviderName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'anthropic') return 'anthropic';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'ollama') return 'ollama';
  return normalized;
}

export function getDefaultLlmBaseUrl(provider) {
  const normalized = normalizeProviderName(provider);
  if (normalized === 'openai') return DEFAULT_OPENAI_BASE_URL;
  if (normalized === 'anthropic') return DEFAULT_ANTHROPIC_BASE_URL;
  return DEFAULT_OLLAMA_BASE_URL;
}

export function getDefaultLlmApiKeyEnv(provider) {
  const normalized = normalizeProviderName(provider);
  if (normalized === 'openai') return 'OPENAI_API_KEY';
  if (normalized === 'anthropic') return 'ANTHROPIC_API_KEY';
  return '';
}

function inferLegacyOllamaUsage(options = {}) {
  return Boolean(
    options.ollamaModel
    || options.ollamaUrl
    || options.ollamaRelations
    || options.ollamaTimeoutMs
    || options.ollamaBatchSize
    || options.ollamaSshHost
    || process.env.PAPERNEXUS_OLLAMA_MODEL
    || process.env.PAPERNEXUS_OLLAMA_URL
    || process.env.PAPERNEXUS_OLLAMA_RELATIONS
    || process.env.PAPERNEXUS_OLLAMA_SSH_HOST
  );
}

function resolveDirectApiKey(provider, options = {}) {
  const configuredEnv = pickDefined(options.llmApiKeyEnv, process.env.PAPERNEXUS_LLM_API_KEY_ENV);
  const configuredKey = pickDefined(options.llmApiKey, process.env.PAPERNEXUS_LLM_API_KEY);
  if (configuredKey) return configuredKey;
  if (configuredEnv && process.env[configuredEnv]) return process.env[configuredEnv];
  const defaultEnv = getDefaultLlmApiKeyEnv(provider);
  if (defaultEnv && process.env[defaultEnv]) return process.env[defaultEnv];
  return '';
}

export function resolveLlmConfig(options = {}) {
  const provider = normalizeProviderName(
    pickDefined(
      options.llmProvider,
      process.env.PAPERNEXUS_LLM_PROVIDER,
      inferLegacyOllamaUsage(options) ? 'ollama' : ''
    )
  ) || 'ollama';
  const model = pickDefined(
    options.llmModel,
    process.env.PAPERNEXUS_LLM_MODEL,
    options.ollamaModel,
    process.env.PAPERNEXUS_OLLAMA_MODEL,
    ''
  );
  const relationsFlag = pickDefined(
    options.llmRelations,
    process.env.PAPERNEXUS_LLM_RELATIONS,
    options.ollamaRelations,
    process.env.PAPERNEXUS_OLLAMA_RELATIONS
  );
  const enabled = Boolean(relationsFlag === true || relationsFlag === '1' || relationsFlag === 'true' || model);
  const defaultBaseUrl = provider === 'openai'
    ? DEFAULT_OPENAI_BASE_URL
    : provider === 'anthropic'
      ? DEFAULT_ANTHROPIC_BASE_URL
      : DEFAULT_OLLAMA_BASE_URL;
  const apiKeySource = String(pickDefined(
    options.llmApiKeySource,
    process.env.PAPERNEXUS_LLM_API_KEY_SOURCE,
    ''
  ) || '').trim().toLowerCase();
  const baseUrl = String(pickDefined(
    options.llmBaseUrl,
    options.llmUrl,
    process.env.PAPERNEXUS_LLM_BASE_URL,
    options.ollamaUrl,
    process.env.PAPERNEXUS_OLLAMA_URL,
    defaultBaseUrl
  ) || defaultBaseUrl).replace(/\/+$/, '');
  const apiKeyService = String(pickDefined(
    options.llmApiKeyService,
    process.env.PAPERNEXUS_LLM_API_KEY_SERVICE,
    apiKeySource === 'keychain' ? getDefaultLlmKeychainService() : ''
  ) || '').trim();
  const apiKeyAccount = String(pickDefined(
    options.llmApiKeyAccount,
    process.env.PAPERNEXUS_LLM_API_KEY_ACCOUNT,
    apiKeySource === 'keychain'
      ? buildDefaultLlmKeychainAccount({ provider, baseUrl })
      : ''
  ) || '').trim();

  return {
    enabled,
    provider,
    model,
    baseUrl,
    timeoutMs: Number(pickDefined(
      options.llmTimeoutMs,
      process.env.PAPERNEXUS_LLM_TIMEOUT_MS,
      options.ollamaTimeoutMs,
      process.env.PAPERNEXUS_OLLAMA_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    )),
    batchSize: Number(pickDefined(
      options.llmBatchSize,
      process.env.PAPERNEXUS_LLM_BATCH_SIZE,
      options.ollamaBatchSize,
      process.env.PAPERNEXUS_OLLAMA_BATCH_SIZE,
      DEFAULT_BATCH_SIZE
    )),
    maxTokens: Number(pickDefined(
      options.llmMaxTokens,
      process.env.PAPERNEXUS_LLM_MAX_TOKENS,
      DEFAULT_MAX_TOKENS
    )),
    sshHost: pickDefined(
      options.llmSshHost,
      process.env.PAPERNEXUS_LLM_SSH_HOST,
      options.ollamaSshHost,
      process.env.PAPERNEXUS_OLLAMA_SSH_HOST,
      ''
    ),
    apiKeyEnv: pickDefined(
      options.llmApiKeyEnv,
      process.env.PAPERNEXUS_LLM_API_KEY_ENV,
      getDefaultLlmApiKeyEnv(provider)
    ),
    apiKeySource,
    apiKeyService,
    apiKeyAccount,
    apiKey: resolveDirectApiKey(provider, options)
  };
}

export const resolveOllamaConfig = resolveLlmConfig;

function llmRelationsEnabled(options = {}) {
  return isEnabledFlag(
    pickDefined(
      options.llmRelations,
      process.env.PAPERNEXUS_LLM_RELATIONS,
      options.ollamaRelations,
      process.env.PAPERNEXUS_OLLAMA_RELATIONS
    )
  );
}

function createCrossPaperJudgmentConfigSignature(options = {}) {
  const config = resolveLlmConfig(options);
  return stableHash(JSON.stringify({
    provider: config.provider || '',
    model: config.model || '',
    baseUrl: config.baseUrl || '',
    batchSize: Number(config.batchSize || 0),
    timeoutMs: Number(config.timeoutMs || 0),
    maxTokens: Number(config.maxTokens || 0),
    relationsEnabled: llmRelationsEnabled(options)
  }), 20);
}

function createCrossPaperJudgmentCandidateKey(candidate, options = {}) {
  const candidateDigest = stableHash(JSON.stringify({
    id: String(candidate?.id || ''),
    kind: String(candidate?.kind || ''),
    relationType: String(candidate?.relationType || ''),
    heuristicScore: Number(candidate?.heuristicScore || 0),
    source: {
      id: String(candidate?.source?.id || ''),
      type: String(candidate?.source?.type || ''),
      name: String(candidate?.source?.name || ''),
      papers: Array.isArray(candidate?.source?.papers) ? candidate.source.papers : []
    },
    target: {
      id: String(candidate?.target?.id || ''),
      type: String(candidate?.target?.type || ''),
      name: String(candidate?.target?.name || ''),
      papers: Array.isArray(candidate?.target?.papers) ? candidate.target.papers : []
    }
  }), 20);

  return stableHash(JSON.stringify({
    sourceId: String(candidate?.source?.id || ''),
    targetId: String(candidate?.target?.id || ''),
    relationType: String(candidate?.relationType || ''),
    candidateDigest,
    configSignature: createCrossPaperJudgmentConfigSignature(options)
  }), 24);
}

function llmConfigSupportsSemanticExtraction(config = {}) {
  return Boolean(config.enabled && config.model);
}

export function resolveSemanticExtractionPlan(options = {}) {
  const requestedMode = normalizeSemanticExtractionMode(options.semanticExtraction || options.llmSemanticExtraction);

  if (requestedMode === 'heuristic-only') {
    return {
      requestedMode,
      effectiveMode: 'heuristic-only',
      shouldAttempt: false,
      participated: false,
      reason: 'mode-disabled',
      config: null
    };
  }

  const config = resolveLlmConfig(options);
  if (!llmConfigSupportsSemanticExtraction(config)) {
    return {
      requestedMode,
      effectiveMode: 'heuristic-only',
      shouldAttempt: false,
      participated: false,
      reason: 'llm-unconfigured',
      config
    };
  }

  return {
    requestedMode,
    effectiveMode: requestedMode === 'auto' ? 'llm-assisted' : requestedMode,
    shouldAttempt: true,
    participated: false,
    reason: null,
    config
  };
}

function createSemanticObjectInferenceResult({
  provider = 'disabled',
  requestedMode = 'heuristic-only',
  effectiveMode = 'heuristic-only',
  attempted = false,
  participated = false,
  reason = null,
  error = null,
  problems = [],
  methods = [],
  claims = [],
  findings = [],
  researchGoals = [],
  limitations = [],
  assumptions = [],
  evidences = [],
  futureDirections = [],
  benchmarks = [],
  datasets = [],
  metrics = []
} = {}) {
  return {
    provider,
    mode: effectiveMode,
    requestedMode,
    effectiveMode,
    attempted,
    participated,
    reason,
    problems,
    methods,
    claims,
    findings,
    limitations,
    assumptions,
    evidences,
    futureDirections,
    benchmarks,
    datasets,
    metrics,
    error
  };
}

export async function loadLlmApiKey(config = {}, deps = {}) {
  const directKey = String(config.apiKey || '').trim();
  if (directKey) {
    return directKey;
  }

  if (String(config.apiKeySource || '').trim().toLowerCase() === 'keychain') {
    const service = String(config.apiKeyService || getDefaultLlmKeychainService()).trim();
    const account = String(
      config.apiKeyAccount
      || buildDefaultLlmKeychainAccount({ provider: config.provider, baseUrl: config.baseUrl })
    ).trim();
    const keychainSecret = await getKeychainSecret({ service, account }, deps);
    if (keychainSecret) {
      return keychainSecret;
    }
  }

  const configuredEnv = String(config.apiKeyEnv || '').trim();
  if (configuredEnv && process.env[configuredEnv]) {
    return process.env[configuredEnv];
  }

  const defaultEnv = getDefaultLlmApiKeyEnv(config.provider);
  if (defaultEnv && defaultEnv !== configuredEnv && process.env[defaultEnv]) {
    return process.env[defaultEnv];
  }

  return '';
}

function runSshCommand(host, remoteArgs, stdinText, timeoutMs, providerLabel = 'LLM') {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [host, ...remoteArgs], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`SSH ${providerLabel} request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `SSH command exited with ${code}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(stdinText);
  });
}

async function requestOllamaGenerate(config, prompt) {
  const payload = {
    model: config.model,
    stream: false,
    format: 'json',
    options: {
      temperature: 0.1
    },
    prompt
  };

  if (config.sshHost) {
    const output = await runSshCommand(
      config.sshHost,
      [
        'curl',
        '-sS',
        `${config.baseUrl}/api/generate`,
        '--header',
        'content-type:application/json',
        '--data-binary',
        '@-'
      ],
      JSON.stringify(payload),
      config.timeoutMs,
      'Ollama'
    );
    return JSON.parse(output);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status}`);
    }

    return {
      text: (await response.json()).response || ''
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function extractOpenAiText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('');
  }
  return '';
}

function shouldDisableThinkingForJsonMode(config = {}) {
  if (config.provider !== 'openai') {
    return false;
  }

  const baseUrl = String(config.baseUrl || '').toLowerCase();
  if (!baseUrl.includes('dashscope.aliyuncs.com')) {
    return false;
  }

  return /^qwen3/i.test(String(config.model || '').trim());
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

async function requestOpenAiGenerate(config, prompt) {
  const apiKey = config.apiKey || await loadLlmApiKey(config);
  if (apiKey && !config.apiKey) {
    config.apiKey = apiKey;
  }

  if (!apiKey) {
    throw new Error(
      `Missing API key for the OpenAI-compatible provider. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')}, llm.apiKey, or run \`papernexus auth llm set\`.`
    );
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

  const requestBody = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    response_format: {
      type: 'json_object'
    },
    max_completion_tokens: config.maxTokens,
    temperature: 0.1
  };

  if (shouldDisableThinkingForJsonMode(config)) {
    requestBody.enable_thinking = false;
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with ${response.status}`);
    }

    return {
      text: extractOpenAiText(await response.json())
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function extractAnthropicText(payload) {
  return (payload?.content || [])
    .map((part) => (part?.type === 'text' ? part.text || '' : ''))
    .join('');
}

async function requestAnthropicGenerate(config, prompt) {
  const apiKey = config.apiKey || await loadLlmApiKey(config);
  if (apiKey && !config.apiKey) {
    config.apiKey = apiKey;
  }

  if (!apiKey) {
    throw new Error(
      `Missing API key for the Anthropic-compatible provider. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')}, llm.apiKey, or run \`papernexus auth llm set\`.`
    );
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed with ${response.status}`);
    }

    return {
      text: extractAnthropicText(await response.json())
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function requestLlmGenerate(config, prompt) {
  if (config.provider === 'openai') {
    return requestOpenAiGenerate(config, prompt);
  }

  if (config.provider === 'anthropic') {
    return requestAnthropicGenerate(config, prompt);
  }

  return requestOllamaGenerate(config, prompt);
}

function parseJsonText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return {};
  }

  const collectJsonCandidates = (value) => {
    const candidates = [];
    const trimmed = String(value || '').trim();
    if (!trimmed) return candidates;

    candidates.push(trimmed);

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
    if (fenceMatch?.[1]) {
      candidates.push(fenceMatch[1].trim());
    }

    const extractBalancedCandidate = (source) => {
      const start = source.search(/[{\[]/);
      if (start === -1) return '';

      const stack = [];
      let inString = false;
      let escaping = false;

      for (let index = start; index < source.length; index += 1) {
        const character = source[index];

        if (inString) {
          if (escaping) {
            escaping = false;
            continue;
          }
          if (character === '\\') {
            escaping = true;
            continue;
          }
          if (character === '"') {
            inString = false;
          }
          continue;
        }

        if (character === '"') {
          inString = true;
          continue;
        }

        if (character === '{' || character === '[') {
          stack.push(character);
          continue;
        }

        if (character === '}' || character === ']') {
          const expected = character === '}' ? '{' : '[';
          if (stack[stack.length - 1] === expected) {
            stack.pop();
          }
          if (!stack.length) {
            return source.slice(start, index + 1).trim();
          }
        }
      }

      return '';
    };

    const balancedCandidate = extractBalancedCandidate(trimmed);
    if (balancedCandidate) {
      candidates.push(balancedCandidate);
    }

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
  };

  for (const candidate of collectJsonCandidates(normalized)) {
    try {
      return JSON.parse(candidate);
    } catch {}

    try {
      return JSON.parse(tryJsonRepair(candidate));
    } catch {}
  }

  throw new Error('Model response was not valid JSON.');
}

function sanitizeEntityGroup(raw, key, fallbackType) {
  return (raw?.[key] || [])
    .map((record) => sanitizeEntityRecord(record, fallbackType))
    .filter(Boolean);
}

function sanitizeNodeCheckRecord(record, fallbackId = '', fallbackName = '') {
  const id = String(record?.id || fallbackId || '').trim();
  if (!id) return null;

  const normalizedVerdict = String(record?.verdict || 'keep').trim().toLowerCase();
  const verdict = normalizedVerdict === 'drop'
    ? 'drop'
    : normalizedVerdict === 'rename'
      ? 'rename'
      : 'keep';
  const canonicalName = verdict === 'drop'
    ? ''
    : cleanText(record?.canonicalName || record?.name || fallbackName, 180) || fallbackName;

  return {
    id,
    verdict,
    canonicalName,
    confidence: Number.isFinite(Number(record?.confidence)) ? Number(record.confidence) : 0.72,
    reason: cleanText(record?.reason || record?.rationale || '', 220)
  };
}

export async function inferPaperSemanticObjects(parsedPaper, semanticPaper, options = {}) {
  const plan = resolveSemanticExtractionPlan(options);
  if (!plan.shouldAttempt) {
    return createSemanticObjectInferenceResult({
      requestedMode: plan.requestedMode,
      effectiveMode: plan.effectiveMode,
      attempted: false,
      participated: false,
      reason: plan.reason
    });
  }

  try {
    const payload = await requestLlmGenerate(plan.config, buildSemanticExtractionPrompt(parsedPaper, semanticPaper));
    const raw = parseJsonText(payload.text);

    return createSemanticObjectInferenceResult({
      provider: plan.config.provider,
      requestedMode: plan.requestedMode,
      effectiveMode: plan.effectiveMode,
      attempted: true,
      participated: true,
      reason: null,
      problems: sanitizeEntityGroup(raw, 'problems', NODE_TYPES.PROBLEM),
      methods: sanitizeEntityGroup(raw, 'methods', NODE_TYPES.METHOD),
      claims: sanitizeEntityGroup(raw, 'claims', NODE_TYPES.CLAIM),
      findings: sanitizeEntityGroup(raw, 'findings', NODE_TYPES.FINDING),
      researchGoals: sanitizeEntityGroup(raw, 'researchGoals', NODE_TYPES.RESEARCH_GOAL),
      limitations: sanitizeEntityGroup(raw, 'limitations', NODE_TYPES.LIMITATION),
      assumptions: sanitizeEntityGroup(raw, 'assumptions', NODE_TYPES.ASSUMPTION),
      evidences: sanitizeEntityGroup(raw, 'evidences', NODE_TYPES.EVIDENCE),
      futureDirections: sanitizeEntityGroup(raw, 'futureDirections', NODE_TYPES.FUTURE_DIRECTION),
      benchmarks: sanitizeEntityGroup(raw, 'benchmarks', NODE_TYPES.BENCHMARK),
      datasets: sanitizeEntityGroup(raw, 'datasets', NODE_TYPES.DATASET),
      metrics: sanitizeEntityGroup(raw, 'metrics', NODE_TYPES.METRIC),
      error: null
    });
  } catch (error) {
    return createSemanticObjectInferenceResult({
      provider: plan.config.provider,
      requestedMode: plan.requestedMode,
      effectiveMode: 'heuristic-only',
      attempted: true,
      participated: false,
      reason: 'request-failed',
      error: error.message
    });
  }
}

export async function inferPaperSemanticObjectsBatch(entries, options = {}) {
  const plan = resolveSemanticExtractionPlan(options);
  if (!entries?.length) return [];

  if (!plan.shouldAttempt) {
    return entries.map(() => createSemanticObjectInferenceResult({
      requestedMode: plan.requestedMode,
      effectiveMode: plan.effectiveMode,
      attempted: false,
      participated: false,
      reason: plan.reason
    }));
  }

  const batchSize = Math.max(1, Number(plan.config?.batchSize || DEFAULT_BATCH_SIZE));
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, Math.ceil(entries.length / batchSize));

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize).map((entry, index) => ({
      ...entry,
      id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${start + index + 1}`)
    }));

    try {
      const payload = await requestLlmGenerate(plan.config, buildSemanticExtractionBatchPrompt(batch));
      const raw = parseJsonText(payload.text);
      const paperErrors = new Map(
        (raw?.errors || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const paperResults = new Map(
        (raw?.papers || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = paperResults.get(batchEntry.id);
        const rawError = paperErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[start + offset] = createSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'request-failed',
            error: rawError
          });
          continue;
        }

        if (!rawPaper) {
          results[start + offset] = createSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'request-failed',
            error: `Missing batch semantic result for ${batchEntry.id}`
          });
          continue;
        }

        results[start + offset] = createSemanticObjectInferenceResult({
          provider: plan.config.provider,
          requestedMode: plan.requestedMode,
          effectiveMode: plan.effectiveMode,
          attempted: true,
          participated: true,
          reason: null,
          problems: sanitizeEntityGroup(rawPaper, 'problems', NODE_TYPES.PROBLEM),
          methods: sanitizeEntityGroup(rawPaper, 'methods', NODE_TYPES.METHOD),
          claims: sanitizeEntityGroup(rawPaper, 'claims', NODE_TYPES.CLAIM),
          findings: sanitizeEntityGroup(rawPaper, 'findings', NODE_TYPES.FINDING),
          researchGoals: sanitizeEntityGroup(rawPaper, 'researchGoals', NODE_TYPES.RESEARCH_GOAL),
          limitations: sanitizeEntityGroup(rawPaper, 'limitations', NODE_TYPES.LIMITATION),
          assumptions: sanitizeEntityGroup(rawPaper, 'assumptions', NODE_TYPES.ASSUMPTION),
          evidences: sanitizeEntityGroup(rawPaper, 'evidences', NODE_TYPES.EVIDENCE),
          futureDirections: sanitizeEntityGroup(rawPaper, 'futureDirections', NODE_TYPES.FUTURE_DIRECTION),
          benchmarks: sanitizeEntityGroup(rawPaper, 'benchmarks', NODE_TYPES.BENCHMARK),
          datasets: sanitizeEntityGroup(rawPaper, 'datasets', NODE_TYPES.DATASET),
          metrics: sanitizeEntityGroup(rawPaper, 'metrics', NODE_TYPES.METRIC),
          error: null
        });
      }
    } catch (error) {
      for (let offset = 0; offset < batch.length; offset += 1) {
        results[start + offset] = createSemanticObjectInferenceResult({
          provider: plan.config.provider,
          requestedMode: plan.requestedMode,
          effectiveMode: 'heuristic-only',
          attempted: true,
          participated: false,
          reason: 'request-failed',
          error: error.message
        });
      }
    } finally {
      options.onBatchComplete?.({
        phase: 'semantic-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: Math.min(start + batch.length, entries.length),
        total: entries.length,
        batchSize: batch.length
      });
    }
  }

  return results;
}

export async function inferPaperResearchSemantics(parsedPaper, semanticPaper, options = {}) {
  if (!llmRelationsEnabled(options)) {
    return {
      provider: 'disabled',
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      error: null
    };
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    return {
      provider: 'disabled',
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      error: null
    };
  }

  try {
    const payload = await requestLlmGenerate(config, buildPrompt(parsedPaper, semanticPaper));
    const raw = parseJsonText(payload.text);
    const benchmarks = (raw.benchmarks || [])
      .map((record) => sanitizeEntityRecord(record, NODE_TYPES.BENCHMARK))
      .filter(Boolean);
    const findings = (raw.findings || [])
      .map((record) => sanitizeEntityRecord(record, NODE_TYPES.FINDING))
      .filter(Boolean);
    const researchGoals = (raw.researchGoals || [])
      .map((record) => sanitizeEntityRecord(record, NODE_TYPES.RESEARCH_GOAL))
      .filter(Boolean);
    const relations = (raw.relations || [])
      .map(sanitizeRelationRecord)
      .filter(Boolean);

    return {
      provider: config.provider,
      benchmarks,
      findings,
      researchGoals,
      relations,
      error: null
    };
  } catch (error) {
    return {
      provider: config.provider,
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      error: error.message
    };
  }
}

export async function inferPaperResearchSemanticsBatch(entries, options = {}) {
  if (!entries?.length) return [];

  if (!llmRelationsEnabled(options)) {
    return entries.map(() => ({
      provider: 'disabled',
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      error: null
    }));
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    return entries.map(() => ({
      provider: 'disabled',
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      error: null
    }));
  }

  const batchSize = Math.max(1, Number(config.batchSize || DEFAULT_BATCH_SIZE));
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, Math.ceil(entries.length / batchSize));

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize).map((entry, index) => ({
      ...entry,
      id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${start + index + 1}`)
    }));

    try {
      const payload = await requestLlmGenerate(config, buildResearchSemanticsBatchPrompt(batch));
      const raw = parseJsonText(payload.text);
      const paperErrors = new Map(
        (raw?.errors || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const paperResults = new Map(
        (raw?.papers || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = paperResults.get(batchEntry.id);
        const rawError = paperErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[start + offset] = {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            error: rawError
          };
          continue;
        }

        if (!rawPaper) {
          results[start + offset] = {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            error: `Missing batch relation result for ${batchEntry.id}`
          };
          continue;
        }

        results[start + offset] = {
          provider: config.provider,
          benchmarks: (rawPaper.benchmarks || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.BENCHMARK))
            .filter(Boolean),
          findings: (rawPaper.findings || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.FINDING))
            .filter(Boolean),
          researchGoals: (rawPaper.researchGoals || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.RESEARCH_GOAL))
            .filter(Boolean),
          relations: (rawPaper.relations || [])
            .map(sanitizeRelationRecord)
            .filter(Boolean),
          error: null
        };
      }
    } catch (error) {
      for (let offset = 0; offset < batch.length; offset += 1) {
        results[start + offset] = {
          provider: config.provider,
          benchmarks: [],
          findings: [],
          researchGoals: [],
          relations: [],
          error: error.message
        };
      }
    } finally {
      options.onBatchComplete?.({
        phase: 'relation-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: Math.min(start + batch.length, entries.length),
        total: entries.length,
        batchSize: batch.length
      });
    }
  }

  return results;
}

export async function inferGraphNodeChecksBatch(entries, options = {}) {
  if (!entries?.length) return [];

  if (!options.nodeLlmCheck) {
    return entries.map((entry) => ({
      id: String(entry?.id || ''),
      verdict: 'keep',
      canonicalName: entry?.name || '',
      confidence: 0,
      reason: 'node-llm-check-disabled',
      provider: 'disabled',
      attempted: false,
      participated: false,
      error: null
    }));
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    return entries.map((entry) => ({
      id: String(entry?.id || ''),
      verdict: 'keep',
      canonicalName: entry?.name || '',
      confidence: 0,
      reason: 'llm-unconfigured',
      provider: 'disabled',
      attempted: false,
      participated: false,
      error: null
    }));
  }

  const batchSize = Math.max(1, Number(config.batchSize || DEFAULT_BATCH_SIZE));
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, Math.ceil(entries.length / batchSize));

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize).map((entry, index) => ({
      ...entry,
      id: String(entry?.id || `node-${start + index + 1}`)
    }));

    try {
      const payload = await requestLlmGenerate(config, buildNodeCheckBatchPrompt(batch));
      const raw = parseJsonText(payload.text);
      const nodeErrors = new Map(
        (raw?.errors || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const nodeResults = new Map(
        (raw?.nodes || [])
          .map((entry) => sanitizeNodeCheckRecord(entry))
          .filter(Boolean)
          .map((entry) => [entry.id, entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawError = nodeErrors.get(batchEntry.id);
        const rawNode = nodeResults.get(batchEntry.id);
        if (rawError) {
          results[start + offset] = {
            id: batchEntry.id,
            verdict: 'keep',
            canonicalName: batchEntry.name,
            confidence: 0,
            reason: 'request-failed',
            provider: config.provider,
            attempted: true,
            participated: false,
            error: rawError
          };
          continue;
        }

        if (!rawNode) {
          results[start + offset] = {
            id: batchEntry.id,
            verdict: 'keep',
            canonicalName: batchEntry.name,
            confidence: 0,
            reason: 'request-failed',
            provider: config.provider,
            attempted: true,
            participated: false,
            error: `Missing node check result for ${batchEntry.id}`
          };
          continue;
        }

        results[start + offset] = {
          ...rawNode,
          provider: config.provider,
          attempted: true,
          participated: true,
          error: null
        };
      }
    } catch (error) {
      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        results[start + offset] = {
          id: batchEntry.id,
          verdict: 'keep',
          canonicalName: batchEntry.name,
          confidence: 0,
          reason: 'request-failed',
          provider: config.provider,
          attempted: true,
          participated: false,
          error: error.message
        };
      }
    } finally {
      options.onBatchComplete?.({
        phase: 'node-check',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: Math.min(start + batch.length, entries.length),
        total: entries.length,
        batchSize: batch.length
      });
    }
  }

  return results;
}

function buildCrossPaperPrompt(batch) {
  return [
    'You are judging cross-paper research graph candidates.',
    'Return strict JSON only.',
    'Accept only candidates that are well grounded and useful for research topic selection or innovation design.',
    '',
    'Allowed relation types: TRANSFERABLE_TO, COMBINES_WITH',
    '',
    'Candidates:',
    JSON.stringify(batch, null, 2),
    '',
    'Return JSON:',
    '{',
    '  "judgments": [{"id":"...", "accepted": true, "relationType":"TRANSFERABLE_TO", "confidence":0.0, "evidenceText":"...", "rationale":"..."}]',
    '}'
  ].join('\n');
}

export async function adjudicateCrossPaperCandidates(candidates, options = {}) {
  if (!llmRelationsEnabled(options)) {
    return [];
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model || !candidates?.length) {
    return [];
  }

  const cache = options.crossPaperJudgmentCache instanceof Map
    ? options.crossPaperJudgmentCache
    : null;
  const judgments = [];
  const batchSize = Math.max(1, Number(config.batchSize || DEFAULT_BATCH_SIZE));
  const pendingCandidates = [];

  for (const candidate of candidates) {
    const cacheKey = createCrossPaperJudgmentCandidateKey(candidate, options);
    const cached = cache?.get(cacheKey);
    if (cached) {
      judgments.push({
        id: String(cached.id || candidate.id || ''),
        accepted: Boolean(cached.accepted),
        relationType: cached.relationType,
        confidence: Number.isFinite(Number(cached.confidence)) ? Number(cached.confidence) : 0.65,
        evidenceText: cleanText(cached.evidenceText || '', 280),
        rationale: cleanText(cached.rationale || '', 220)
      });
      continue;
    }

    pendingCandidates.push({
      ...candidate,
      __cacheKey: cacheKey
    });
  }

  for (let start = 0; start < pendingCandidates.length; start += batchSize) {
    const batch = pendingCandidates.slice(start, start + batchSize);

    try {
      const payload = await requestLlmGenerate(config, buildCrossPaperPrompt(batch));
      const raw = parseJsonText(payload.text);
      for (const entry of raw.judgments || []) {
        const relationType = normalizeRelationTypeName(entry?.relationType);
        if (!relationType || (relationType !== EDGE_TYPES.TRANSFERABLE_TO && relationType !== EDGE_TYPES.COMBINES_WITH)) {
          continue;
        }

        const normalized = {
          id: String(entry.id || ''),
          accepted: Boolean(entry.accepted),
          relationType,
          confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.65,
          evidenceText: cleanText(entry.evidenceText || '', 280),
          rationale: cleanText(entry.rationale || '', 220)
        };

        judgments.push(normalized);
        const matchedCandidate = batch.find((candidate) => candidate.id === normalized.id);
        if (matchedCandidate?.__cacheKey && cache) {
          cache.set(matchedCandidate.__cacheKey, normalized);
        }
      }
    } catch {
      continue;
    }
  }

  return judgments;
}
