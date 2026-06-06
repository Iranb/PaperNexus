import { execFile as nodeExecFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import {
  normalizeAbstractMechanismNames,
  normalizeAbstractMechanismRecords
} from '../graph/abstract-mechanisms.js';
import { normalizeResearchQuestionRecords } from '../graph/research-questions.js';
import { normalizeChallengeRecord } from '../graph/challenges.js';
import { normalizeIdeaFragmentRecord, normalizeTakeawayRecord } from '../graph/takeaways.js';
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
import {
  clearLlmRateLimitCooldownStore,
  loadLlmRateLimitCooldowns,
  saveLlmRateLimitCooldown
} from '../../storage/llm-rate-limit-store.js';

const require = createRequire(import.meta.url);
let jsonrepair = null;
try {
  ({ jsonrepair } = require('jsonrepair'));
} catch {}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_LLM_PROVIDER = 'deepseek';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BATCH_PROMPT_MAX_CHARS = 24000;
const DEFAULT_BATCH_FAILURE_SPLIT_RETRY_COUNT = 3;
const LONG_CONTEXT_SPLIT_RETRY_MIN_WINDOW_TOKENS = 1_000_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_RATE_LIMIT_RETRY_COUNT = 3;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1000;
const DEFAULT_RATE_LIMIT_RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_OLLAMA_STARTUP_WAIT_MS = 30000;
const DEFAULT_OLLAMA_DOCKER_CONTAINER = 'papernexus-ollama';
const DEFAULT_OLLAMA_DOCKER_IMAGE = 'ollama/ollama:latest';
const ANTHROPIC_VERSION = '2023-06-01';
const TRANSIENT_LLM_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const llmRateLimitCooldowns = new Map();
const execFileAsync = promisify(nodeExecFile);
export const CHUNK_SEMANTIC_OBJECTS_PROMPT_VERSION = 'chunk-semantic-objects-v1';
export const CHUNK_RESEARCH_RELATIONS_PROMPT_VERSION = 'chunk-research-relations-v1';

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function isEnabledFlag(value) {
  return value === true || value === '1' || value === 'true';
}

function isExplicitlyDisabledFlag(value) {
  return value === false || value === '0' || value === 'false' || value === 'no';
}

function resolveBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (isEnabledFlag(value)) return true;
  if (isExplicitlyDisabledFlag(value)) return false;
  return fallback;
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

function sanitizeStringList(values, maxLength = 80) {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .map((value) => cleanText(value, maxLength))
      .filter(Boolean)
  )];
}

function sanitizeSemanticMetadata(raw) {
  const abstractMechanismObjects = normalizeAbstractMechanismRecords(
    raw?.abstractMechanisms
    || raw?.abstractMechanismObjects
    || raw?.mechanismHints
    || raw?.mechanisms
    || []
  );

  return {
    fieldOfStudy: cleanText(raw?.fieldOfStudy || raw?.field || raw?.domain || '', 96) || null,
    fieldCandidates: sanitizeStringList(raw?.fieldCandidates || raw?.fields || [], 96),
    domainTags: sanitizeStringList(raw?.domainTags || raw?.domains || [], 96),
    abstractMechanisms: normalizeAbstractMechanismNames(abstractMechanismObjects),
    abstractMechanismObjects
  };
}

function sanitizeResearchQuestionRecord(record) {
  const normalized = normalizeResearchQuestionRecords([record])[0];
  if (!normalized) return null;
  return {
    name: normalized.name,
    domainSpecificText: normalized.domainSpecificText,
    domainAgnosticText: normalized.domainAgnosticText,
    relatedProblems: normalized.relatedProblems,
    relatedMechanisms: normalized.relatedMechanisms
  };
}

function sanitizeChallengeRecord(record) {
  const normalized = normalizeChallengeRecord(record);
  if (!normalized) return null;
  return {
    name: normalized.name,
    domainSpecificText: normalized.domainSpecificText,
    domainAgnosticText: normalized.domainAgnosticText,
    challengeType: normalized.challengeType,
    relatedMechanisms: normalized.relatedMechanisms
  };
}

function sanitizeTakeawayRecord(record) {
  const normalized = normalizeTakeawayRecord(record);
  if (!normalized) return null;
  return {
    name: normalized.name,
    text: normalized.text,
    sourceDomains: normalized.sourceDomains,
    relatedMechanisms: normalized.relatedMechanisms,
    relatedChallenges: normalized.relatedChallenges,
    supportingSnippets: normalized.supportingSnippets
  };
}

function sanitizeIdeaFragmentRecord(record) {
  const normalized = normalizeIdeaFragmentRecord(record);
  if (!normalized) return null;
  return {
    name: normalized.name,
    text: normalized.text,
    targetDomain: normalized.targetDomain,
    sourceDomains: normalized.sourceDomains,
    relatedMechanisms: normalized.relatedMechanisms,
    sourceTakeaways: normalized.sourceTakeaways,
    addressesChallenges: normalized.addressesChallenges,
    supportingSnippets: normalized.supportingSnippets
  };
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

const SEMANTIC_ENTITY_ARRAY_FIELDS = [
  'problems',
  'methods',
  'claims',
  'findings',
  'researchGoals',
  'limitations',
  'assumptions',
  'evidences',
  'futureDirections',
  'benchmarks',
  'datasets',
  'metrics'
];

const SEMANTIC_STRUCTURED_ARRAY_FIELDS = [
  'researchQuestions',
  'openChallenges',
  'takeaways',
  'ideaFragments'
];

const SEMANTIC_STRING_ARRAY_FIELDS = [
  'fieldCandidates',
  'fields',
  'domainTags',
  'domains'
];

const SEMANTIC_MIXED_ARRAY_FIELDS = [
  'abstractMechanisms',
  'abstractMechanismObjects',
  'mechanismHints',
  'mechanisms'
];

const RELATION_ARRAY_FIELDS = [
  'benchmarks',
  'findings',
  'researchGoals',
  'relations'
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwnValue(raw, key) {
  return Object.hasOwn(raw || {}, key) && raw[key] != null;
}

function copyArrayAliasFields(raw, aliasMap) {
  if (!isPlainObject(raw)) return raw;
  let normalized = raw;
  const ensureCopy = () => {
    if (normalized === raw) normalized = { ...raw };
    return normalized;
  };

  for (const [canonicalKey, aliases] of Object.entries(aliasMap)) {
    if (hasOwnValue(raw, canonicalKey)) continue;
    for (const alias of aliases) {
      if (!Array.isArray(raw[alias])) continue;
      ensureCopy()[canonicalKey] = raw[alias];
      break;
    }
  }

  return normalized;
}

const SEMANTIC_PAPER_ARRAY_FIELD_ALIASES = {
  problems: ['researchProblems', 'research_problems'],
  researchGoals: ['research_goals', 'researchObjectives', 'research_objectives', 'objectives', 'goals'],
  researchQuestions: ['research_questions', 'questions'],
  openChallenges: ['open_challenges', 'challenges'],
  futureDirections: ['future_directions', 'futureWork', 'future_work'],
  evidences: ['evidence', 'evidenceItems', 'evidence_items', 'supportingEvidence', 'supporting_evidence'],
  fieldCandidates: ['field_candidates'],
  domainTags: ['domain_tags'],
  abstractMechanisms: ['abstract_mechanisms'],
  abstractMechanismObjects: ['abstract_mechanism_objects'],
  mechanismHints: ['mechanism_hints'],
  ideaFragments: ['idea_fragments'],
  metrics: ['evaluationMetrics', 'evaluation_metrics']
};

const RELATION_PAPER_ARRAY_FIELD_ALIASES = {
  researchGoals: SEMANTIC_PAPER_ARRAY_FIELD_ALIASES.researchGoals,
  relations: ['relationships', 'semanticRelations', 'semantic_relations', 'edges']
};

const RELATION_RECORD_STRING_ALIASES = {
  sourceName: ['fromName', 'from', 'source', 'source_node', 'sourceNode'],
  targetName: ['toName', 'to', 'target', 'target_node', 'targetNode'],
  sourceType: ['fromType', 'source_type', 'sourceNodeType', 'source_node_type'],
  targetType: ['toType', 'target_type', 'targetNodeType', 'target_node_type'],
  type: ['relationType', 'relation_type', 'relationshipType', 'relationship_type', 'edgeType', 'edge_type'],
  evidenceText: ['evidence_text', 'evidence']
};

function copyStringAliasFields(raw, aliasMap) {
  if (!isPlainObject(raw)) return raw;
  let normalized = raw;
  const ensureCopy = () => {
    if (normalized === raw) normalized = { ...raw };
    return normalized;
  };

  for (const [canonicalKey, aliases] of Object.entries(aliasMap)) {
    if (hasOwnValue(raw, canonicalKey)) continue;
    for (const alias of aliases) {
      if (typeof raw[alias] !== 'string') continue;
      const value = cleanText(raw[alias], 280);
      if (!value) continue;
      ensureCopy()[canonicalKey] = value;
      break;
    }
  }

  return normalized;
}

function normalizeSemanticPaperOutputShape(rawPaper) {
  return copyArrayAliasFields(rawPaper, SEMANTIC_PAPER_ARRAY_FIELD_ALIASES);
}

function normalizeRelationPaperOutputShape(rawPaper) {
  const normalized = copyArrayAliasFields(rawPaper, RELATION_PAPER_ARRAY_FIELD_ALIASES);
  if (!isPlainObject(normalized) || !Array.isArray(normalized.relations)) return normalized;

  let copied = normalized;
  const relations = normalized.relations.map((relation) => copyStringAliasFields(relation, RELATION_RECORD_STRING_ALIASES));
  if (relations.some((relation, index) => relation !== normalized.relations[index])) {
    copied = { ...normalized, relations };
  }
  return copied;
}

function validateOptionalArrayField(raw, key, options = {}) {
  if (!Object.hasOwn(raw || {}, key) || raw[key] == null) return null;
  if (!Array.isArray(raw[key])) return `Expected "${key}" to be an array.`;
  if (options.requireObjectEntries) {
    const invalidIndex = raw[key].findIndex((entry) => !isPlainObject(entry));
    if (invalidIndex !== -1) return `Expected "${key}[${invalidIndex}]" to be an object.`;
  }
  if (options.requireStringEntries) {
    const invalidIndex = raw[key].findIndex((entry) => typeof entry !== 'string');
    if (invalidIndex !== -1) return `Expected "${key}[${invalidIndex}]" to be a string.`;
  }
  return null;
}

function validateSemanticPaperSchema(rawPaper) {
  if (!isPlainObject(rawPaper)) return 'Expected paper semantic result to be an object.';
  for (const key of SEMANTIC_ENTITY_ARRAY_FIELDS) {
    const error = validateOptionalArrayField(rawPaper, key, { requireObjectEntries: true });
    if (error) return error;
    if (Array.isArray(rawPaper[key])) {
      const invalidIndex = rawPaper[key].findIndex((entry) => !cleanText(entry?.name || entry?.text || '', 180));
      if (invalidIndex !== -1) return `Expected "${key}[${invalidIndex}]" to include a name or text.`;
    }
  }
  for (const key of SEMANTIC_STRUCTURED_ARRAY_FIELDS) {
    const error = validateOptionalArrayField(rawPaper, key, { requireObjectEntries: true });
    if (error) return error;
  }
  for (const key of SEMANTIC_STRING_ARRAY_FIELDS) {
    const error = validateOptionalArrayField(rawPaper, key, { requireStringEntries: true });
    if (error) return error;
  }
  for (const key of SEMANTIC_MIXED_ARRAY_FIELDS) {
    const error = validateOptionalArrayField(rawPaper, key);
    if (error) return error;
  }
  return null;
}

function validateRelationPaperSchema(rawPaper) {
  if (!isPlainObject(rawPaper)) return 'Expected paper relation result to be an object.';
  for (const key of RELATION_ARRAY_FIELDS) {
    const error = validateOptionalArrayField(rawPaper, key, { requireObjectEntries: true });
    if (error) return error;
  }
  if (Array.isArray(rawPaper.relations)) {
    const invalidIndex = rawPaper.relations.findIndex((relation) => (
      !cleanText(relation?.sourceName || '', 180)
      || !cleanText(relation?.targetName || '', 180)
      || !normalizeNodeTypeName(relation?.sourceType)
      || !normalizeNodeTypeName(relation?.targetType)
      || !normalizeRelationTypeName(relation?.type)
    ));
    if (invalidIndex !== -1) return `Expected "relations[${invalidIndex}]" to include source, target, and relation type.`;
  }
  return null;
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
    '  "metrics": [{"name":"...", "type":"Metric", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '  "fieldOfStudy": "Computer Science",',
    '  "fieldCandidates": ["Computer Science", "Psychology"],',
    '  "domainTags": ["Computer Science", "Psychology"],',
    '  "abstractMechanisms": [',
    '    "memory preservation",',
    '    {"name":"metacontrol policy", "type":"control-policy", "category":"adaptive-control", "description":"adaptive trade-off between persistence and flexibility", "aliases":["cognitive control trade-off"]}',
    '  ]',
    '  "researchQuestions": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "relatedProblems":["..."], "relatedMechanisms":["..."]}],',
    '  "openChallenges": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "challengeType":"mixed", "relatedMechanisms":["..."]}],',
    '  "takeaways": [{"name":"...", "text":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "relatedChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}],',
    '  "ideaFragments": [{"name":"...", "text":"...", "targetDomain":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "sourceTakeaways":["..."], "addressesChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}]',
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
    '- If a category is unsupported, return an empty list.',
    '- `abstractMechanisms` may mix strings and structured objects.',
    '- Prefer the object form when you can infer mechanism type, category, description, or aliases confidently.',
    '- `researchQuestions` should decompose the paper problem into reusable research questions.',
    '- `openChallenges` should capture unresolved obstacles and provide both domain-specific and domain-agnostic wording when possible.',
    '- `takeaways` should capture reusable insights grounded in the paper text and linked to challenges or mechanisms when possible.',
    '- `ideaFragments` should capture transfer-ready idea atoms grounded in the paper takeaways, not freeform speculation.'
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
    '      "metrics": [{"name":"...", "type":"Metric", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "fieldOfStudy": "Computer Science",',
    '      "fieldCandidates": ["Computer Science", "Psychology"],',
    '      "domainTags": ["Computer Science", "Psychology"],',
    '      "abstractMechanisms": [',
    '        "memory preservation",',
    '        {"name":"metacontrol policy", "type":"control-policy", "category":"adaptive-control", "description":"adaptive trade-off between persistence and flexibility", "aliases":["cognitive control trade-off"]}',
    '      ]',
    '      "researchQuestions": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "relatedProblems":["..."], "relatedMechanisms":["..."]}],',
    '      "openChallenges": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "challengeType":"mixed", "relatedMechanisms":["..."]}],',
    '      "takeaways": [{"name":"...", "text":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "relatedChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}],',
    '      "ideaFragments": [{"name":"...", "text":"...", "targetDomain":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "sourceTakeaways":["..."], "addressesChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}]',
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
    '- `abstractMechanisms` may mix strings and structured objects.',
    '- Prefer the object form when you can infer mechanism type, category, description, or aliases confidently.',
    '- `researchQuestions` should decompose the paper problem into reusable research questions.',
    '- `openChallenges` should capture unresolved obstacles and provide both domain-specific and domain-agnostic wording when possible.',
    '- `takeaways` should capture reusable insights grounded in the paper text and linked to challenges or mechanisms when possible.',
    '- `ideaFragments` should capture transfer-ready idea atoms grounded in the paper takeaways, not freeform speculation.',
    '',
    'Papers:',
    JSON.stringify(papers, null, 2)
  ].join('\n');
}

function buildChunkSemanticExtractionBatchPrompt(entries) {
  const chunks = entries.map((entry, index) => {
    const semanticPaper = entry.semanticPaper || {};
    const chunk = entry.chunk || {};
    return {
      id: String(entry.id || chunk.chunkId || `chunk-${index + 1}`),
      sourceKey: String(entry.sourceKey || semanticPaper.sourceKey || '').trim(),
      paperId: String(entry.paperId || semanticPaper.paperId || '').trim(),
      title: cleanText(entry.paperTitle || semanticPaper.paperTitle || '', 240),
      sectionHeading: cleanText(entry.sectionHeading || chunk.sectionHeading || '', 120),
      sectionRole: cleanText(entry.sectionRole || chunk.sectionRole || '', 32),
      chunkOrder: Number(entry.chunkOrder || chunk.chunkOrder || 0),
      text: cleanText(entry.text || chunk.text || '', 900),
      heuristicCandidates: collectEntitySnapshot(semanticPaper).slice(0, 16)
    };
  });

  return [
    'You are extracting structured research objects from paper chunks for a knowledge graph.',
    'Return strict JSON only.',
    'Do not invent unsupported entities.',
    'Prefer short canonical names for Problem and Method nodes.',
    'Keep Claim, Limitation, Assumption, Evidence, and FutureDirection entries tightly grounded in the chunk text.',
    'Merge synonymous surface forms into one canonical object when possible.',
    '',
    'Return this JSON shape:',
    '{',
    '  "chunks": [',
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
    '      "metrics": [{"name":"...", "type":"Metric", "evidenceText":"...", "sectionHeading":"...", "sectionRole":"...", "confidence":0.0, "explicitOrInferred":"explicit"}],',
    '      "fieldOfStudy": "Computer Science",',
    '      "fieldCandidates": ["Computer Science", "Psychology"],',
    '      "domainTags": ["Computer Science", "Psychology"],',
    '      "abstractMechanisms": ["memory preservation"],',
    '      "researchQuestions": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "relatedProblems":["..."], "relatedMechanisms":["..."]}],',
    '      "openChallenges": [{"name":"...", "domainSpecificText":"...", "domainAgnosticText":"...", "challengeType":"mixed", "relatedMechanisms":["..."]}],',
    '      "takeaways": [{"name":"...", "text":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "relatedChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}],',
    '      "ideaFragments": [{"name":"...", "text":"...", "targetDomain":"...", "sourceDomains":["..."], "relatedMechanisms":["..."], "sourceTakeaways":["..."], "addressesChallenges":["..."], "supportingSnippets":[{"text":"...", "sectionHeading":"...", "sectionRole":"..."}]}]',
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
    '- `abstractMechanisms` may be a list of strings.',
    '- Prefer the object form when you can infer mechanism type, category, description, or aliases confidently.',
    '- `researchQuestions` should decompose the paper problem into reusable research questions.',
    '- `openChallenges` should capture unresolved obstacles and provide both domain-specific and domain-agnostic wording when possible.',
    '- `takeaways` should capture reusable insights grounded in the chunk text and linked to challenges or mechanisms when possible.',
    '- `ideaFragments` should capture transfer-ready idea atoms grounded in the chunk text, not freeform speculation.',
    '',
    'Papers:',
    JSON.stringify(chunks, null, 2)
  ].join('\n');
}

function buildChunkResearchSemanticsBatchPrompt(entries) {
  const chunks = entries.map((entry, index) => {
    const semanticPaper = entry.semanticPaper || {};
    const chunk = entry.chunk || {};
    return {
      id: String(entry.id || chunk.chunkId || `chunk-${index + 1}`),
      sourceKey: String(entry.sourceKey || semanticPaper.sourceKey || '').trim(),
      paperId: String(entry.paperId || semanticPaper.paperId || '').trim(),
      title: cleanText(entry.paperTitle || semanticPaper.paperTitle || '', 240),
      sectionHeading: cleanText(entry.sectionHeading || chunk.sectionHeading || '', 120),
      sectionRole: cleanText(entry.sectionRole || chunk.sectionRole || '', 32),
      chunkOrder: Number(entry.chunkOrder || chunk.chunkOrder || 0),
      text: cleanText(entry.text || chunk.text || '', 900),
      candidateEntities: collectEntitySnapshot(semanticPaper).slice(0, 16)
    };
  });

  return [
    'You are building a multi-layer research knowledge graph from paper chunks.',
    'Return strict JSON only.',
    'Do not invent entities or relations that are unsupported by the chunk text.',
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
    '  "chunks": [',
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
    'Only emit relations that are strongly grounded in the chunk text. Use explicitOrInferred="inferred" for transfer/composition hypotheses.',
    '',
    'Papers:',
    JSON.stringify(chunks, null, 2)
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
    layer: cleanText(entry.layer || '', 64),
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
    'Validate every semantic node as a useful academic-paper graph primitive.',
    'Drop nodes that are PDF/OCR/parser artifacts, page headers, tables, formulas without semantic labels, author/affiliation text, citation debris, placeholder publication metadata, or generic non-reusable phrases.',
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
    '- Keep coherent paper-grounded Problems, Methods, Claims, Findings, ResearchQuestions, Challenges, Assumptions, Limitations, Takeaways, IdeaFragments, FutureDirections, ResearchGoals, Evidence, Datasets, Benchmarks, and Metrics.',
    '- Drop parser noise such as "(cid:80)", "v i X r a", "L C s c", "00 Month 0000", "DOI: xxx", markdown table rows, isolated equations, page numbers, email/affiliation blocks, or strings dominated by punctuation.',
    '- Drop generic placeholders such as "training dataset", "test dataset", "source domain data", "target domain benchmark", "Comprehensive benchmark", "the proposed method", or any node that is not specific enough to retrieve or connect research evidence.',
    '- For Dataset, Benchmark, and Metric nodes, keep only named reusable resources or concrete metric names; drop broad nouns and one-off table labels.',
    '- For Problem and Method nodes, keep concise research problems and named or clearly described technical approaches; drop titles, section headings, formulas, and malformed sentence fragments.',
    '- For Claim, Finding, Evidence, Assumption, Limitation, and FutureDirection nodes, keep complete meaningful statements; drop captions/URLs alone, author metadata, boilerplate, and statements assigned to the wrong type.',
    '- Rename only when the node is valid but noisy, overlong, or needs a concise canonical academic phrase.',
    '- If uncertain and the text is coherent academic content, prefer keep over drop.',
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
  if (normalized === 'deepseek') return 'deepseek';
  if (normalized === 'ollama') return 'ollama';
  return normalized;
}

export function getDefaultLlmBaseUrl(provider) {
  const normalized = normalizeProviderName(provider);
  if (normalized === 'openai') return DEFAULT_OPENAI_BASE_URL;
  if (normalized === 'anthropic') return DEFAULT_ANTHROPIC_BASE_URL;
  if (normalized === 'deepseek') return DEFAULT_DEEPSEEK_BASE_URL;
  return DEFAULT_OLLAMA_BASE_URL;
}

export function getDefaultLlmApiKeyEnv(provider) {
  const normalized = normalizeProviderName(provider);
  if (normalized === 'openai') return 'OPENAI_API_KEY';
  if (normalized === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (normalized === 'deepseek') return 'DEEPSEEK_API_KEY';
  return '';
}

function isOpenAiCompatibleProvider(provider) {
  return provider === 'openai' || provider === 'deepseek';
}

function isDeepSeekProvider(config = {}) {
  if (!config || typeof config !== 'object') return false;
  return normalizeProviderName(config.provider) === 'deepseek';
}

function getOpenAiCompatibleProviderLabel(config = {}) {
  return isDeepSeekProvider(config) ? 'DeepSeek' : 'OpenAI';
}

function resolveProviderDefaultBaseUrl(provider) {
  return getDefaultLlmBaseUrl(provider);
}

function resolveEffectiveLlmBatchSize(config = {}, fallback = DEFAULT_BATCH_SIZE) {
  if (isDeepSeekProvider(config) || isDeepSeekProvider(config.fallback)) {
    return config.providerBatchingEnabled
      ? Math.max(1, Number(config.batchSize || fallback))
      : 1;
  }
  return Math.max(1, Number(config.batchSize || fallback));
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

function resolveDirectFallbackApiKey(provider, options = {}) {
  const configuredEnv = pickDefined(
    options.llmFallbackApiKeyEnv,
    process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY_ENV
  );
  const configuredKey = pickDefined(
    options.llmFallbackApiKey,
    process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY
  );
  if (configuredKey) return configuredKey;
  if (configuredEnv && process.env[configuredEnv]) return process.env[configuredEnv];
  const defaultEnv = getDefaultLlmApiKeyEnv(provider);
  if (defaultEnv && process.env[defaultEnv]) return process.env[defaultEnv];
  return '';
}

function hasConfiguredLlmFallback(options = {}) {
  return Boolean(
    options.llmFallbackProvider
    || options.llmFallbackModel
    || options.llmFallbackBaseUrl
    || options.llmFallbackSshHost
    || options.llmFallbackAutoStart !== undefined
    || options.llmFallbackAutoPull !== undefined
    || process.env.PAPERNEXUS_LLM_FALLBACK_PROVIDER
    || process.env.PAPERNEXUS_LLM_FALLBACK_MODEL
    || process.env.PAPERNEXUS_LLM_FALLBACK_BASE_URL
    || process.env.PAPERNEXUS_LLM_FALLBACK_SSH_HOST
    || process.env.PAPERNEXUS_LLM_FALLBACK_AUTO_START !== undefined
    || process.env.PAPERNEXUS_LLM_FALLBACK_AUTO_PULL !== undefined
  );
}

function resolveOllamaFallbackBootstrapConfig(options = {}) {
  const mode = String(pickDefined(
    options.llmFallbackOllamaBootstrap,
    process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_BOOTSTRAP,
    'native'
  ) || 'native').trim().toLowerCase();
  const containerName = String(pickDefined(
    options.llmFallbackOllamaDockerContainer,
    process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_DOCKER_CONTAINER,
    DEFAULT_OLLAMA_DOCKER_CONTAINER
  ) || DEFAULT_OLLAMA_DOCKER_CONTAINER).trim();

  return {
    mode,
    command: String(pickDefined(
      options.llmFallbackOllamaCommand,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_COMMAND,
      'ollama'
    ) || 'ollama').trim(),
    startCommand: String(pickDefined(
      options.llmFallbackOllamaStartCommand,
      options.llmFallbackStartCommand,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_START_COMMAND,
      process.env.PAPERNEXUS_LLM_FALLBACK_START_COMMAND,
      ''
    ) || '').trim(),
    pullCommand: String(pickDefined(
      options.llmFallbackOllamaPullCommand,
      options.llmFallbackPullCommand,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_PULL_COMMAND,
      process.env.PAPERNEXUS_LLM_FALLBACK_PULL_COMMAND,
      ''
    ) || '').trim(),
    dockerBin: String(pickDefined(
      options.llmFallbackOllamaDockerBin,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_DOCKER_BIN,
      'docker'
    ) || 'docker').trim(),
    dockerContainer: containerName,
    dockerImage: String(pickDefined(
      options.llmFallbackOllamaDockerImage,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_DOCKER_IMAGE,
      DEFAULT_OLLAMA_DOCKER_IMAGE
    ) || DEFAULT_OLLAMA_DOCKER_IMAGE).trim(),
    dockerVolume: String(pickDefined(
      options.llmFallbackOllamaDockerVolume,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_DOCKER_VOLUME,
      `${containerName}:/root/.ollama`
    ) || '').trim(),
    dockerGpus: String(pickDefined(
      options.llmFallbackOllamaDockerGpus,
      process.env.PAPERNEXUS_LLM_FALLBACK_OLLAMA_DOCKER_GPUS,
      ''
    ) || '').trim()
  };
}

function resolveLlmFallbackConfig(options = {}, primaryConfig = {}) {
  if (!hasConfiguredLlmFallback(options)) {
    return null;
  }

  const provider = normalizeProviderName(
    pickDefined(
      options.llmFallbackProvider,
      process.env.PAPERNEXUS_LLM_FALLBACK_PROVIDER,
      'ollama'
    )
  ) || 'ollama';
  const model = String(pickDefined(
    options.llmFallbackModel,
    process.env.PAPERNEXUS_LLM_FALLBACK_MODEL,
    ''
  ) || '').trim();
  if (!model) {
    return null;
  }

  const defaultBaseUrl = resolveProviderDefaultBaseUrl(provider);
  const baseUrl = String(pickDefined(
    options.llmFallbackBaseUrl,
    options.llmFallbackUrl,
    process.env.PAPERNEXUS_LLM_FALLBACK_BASE_URL,
    process.env.PAPERNEXUS_LLM_FALLBACK_URL,
    defaultBaseUrl
  ) || defaultBaseUrl).replace(/\/+$/, '');
  const apiKeySource = String(pickDefined(
    options.llmFallbackApiKeySource,
    process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY_SOURCE,
    ''
  ) || '').trim().toLowerCase();
  const apiKeyService = String(pickDefined(
    options.llmFallbackApiKeyService,
    process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY_SERVICE,
    apiKeySource === 'keychain' ? getDefaultLlmKeychainService() : ''
  ) || '').trim();
  const apiKeyAccount = String(pickDefined(
    options.llmFallbackApiKeyAccount,
    process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY_ACCOUNT,
    apiKeySource === 'keychain'
      ? buildDefaultLlmKeychainAccount({ provider, baseUrl })
      : ''
  ) || '').trim();

  return {
    enabled: true,
    provider,
    model,
    baseUrl,
    timeoutMs: Number(pickDefined(
      options.llmFallbackTimeoutMs,
      process.env.PAPERNEXUS_LLM_FALLBACK_TIMEOUT_MS,
      primaryConfig.timeoutMs,
      DEFAULT_TIMEOUT_MS
    )),
    batchSize: provider === 'deepseek'
      ? 1
      : Number(pickDefined(
          options.llmFallbackBatchSize,
          process.env.PAPERNEXUS_LLM_FALLBACK_BATCH_SIZE,
          primaryConfig.batchSize,
          DEFAULT_BATCH_SIZE
        )),
    maxTokens: Number(pickDefined(
      options.llmFallbackMaxTokens,
      process.env.PAPERNEXUS_LLM_FALLBACK_MAX_TOKENS,
      primaryConfig.maxTokens,
      DEFAULT_MAX_TOKENS
    )),
    rateLimitRetryCount: Number(pickDefined(
      options.llmFallbackRateLimitRetryCount,
      process.env.PAPERNEXUS_LLM_FALLBACK_RATE_LIMIT_RETRY_COUNT,
      primaryConfig.rateLimitRetryCount,
      DEFAULT_RATE_LIMIT_RETRY_COUNT
    )),
    rateLimitRetryDelayMs: Number(pickDefined(
      options.llmFallbackRateLimitRetryDelayMs,
      process.env.PAPERNEXUS_LLM_FALLBACK_RATE_LIMIT_RETRY_DELAY_MS,
      primaryConfig.rateLimitRetryDelayMs,
      DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
    )),
    rateLimitRetryMaxDelayMs: Number(pickDefined(
      options.llmFallbackRateLimitRetryMaxDelayMs,
      process.env.PAPERNEXUS_LLM_FALLBACK_RATE_LIMIT_RETRY_MAX_DELAY_MS,
      primaryConfig.rateLimitRetryMaxDelayMs,
      DEFAULT_RATE_LIMIT_RETRY_MAX_DELAY_MS
    )),
    rateLimitCooldownMs: Number(pickDefined(
      options.llmFallbackRateLimitCooldownMs,
      process.env.PAPERNEXUS_LLM_FALLBACK_RATE_LIMIT_COOLDOWN_MS,
      primaryConfig.rateLimitCooldownMs,
      DEFAULT_RATE_LIMIT_COOLDOWN_MS
    )),
    sshHost: pickDefined(
      options.llmFallbackSshHost,
      process.env.PAPERNEXUS_LLM_FALLBACK_SSH_HOST,
      ''
    ),
    apiKeyEnv: pickDefined(
      options.llmFallbackApiKeyEnv,
      process.env.PAPERNEXUS_LLM_FALLBACK_API_KEY_ENV,
      getDefaultLlmApiKeyEnv(provider)
    ),
    apiKeySource,
    apiKeyService,
    apiKeyAccount,
    apiKey: resolveDirectFallbackApiKey(provider, options),
    fallback: null,
    autoStart: resolveBooleanSetting(pickDefined(
      options.llmFallbackAutoStart,
      process.env.PAPERNEXUS_LLM_FALLBACK_AUTO_START
    ), false),
    autoPull: resolveBooleanSetting(pickDefined(
      options.llmFallbackAutoPull,
      process.env.PAPERNEXUS_LLM_FALLBACK_AUTO_PULL
    ), false),
    startupWaitMs: Number(pickDefined(
      options.llmFallbackStartupWaitMs,
      process.env.PAPERNEXUS_LLM_FALLBACK_STARTUP_WAIT_MS,
      DEFAULT_OLLAMA_STARTUP_WAIT_MS
    )),
    ollamaBootstrap: resolveOllamaFallbackBootstrapConfig(options),
    execFile: options.llmFallbackExecFile || null,
    spawn: options.llmFallbackSpawn || null
  };
}

function resolveProviderBatchingEnabled(provider, options = {}) {
  const normalized = normalizeProviderName(provider);
  const explicit = pickDefined(
    normalized === 'deepseek' ? options.llmDeepSeekBatchingEnabled : undefined,
    normalized === 'deepseek' ? options.deepSeekBatchingEnabled : undefined,
    options.llmProviderBatchingEnabled,
    options.providerBatchingEnabled,
    normalized === 'deepseek' ? process.env.PAPERNEXUS_LLM_DEEPSEEK_BATCHING_ENABLED : undefined,
    process.env.PAPERNEXUS_LLM_PROVIDER_BATCHING_ENABLED
  );
  if (explicit !== undefined) return !isExplicitlyDisabledFlag(explicit);
  if (normalized !== 'deepseek') return true;
  return isLongContextFirstBatchMode(options)
    && resolveLongContextWindowTokensForBatch(options) >= LONG_CONTEXT_SPLIT_RETRY_MIN_WINDOW_TOKENS;
}

export function resolveLlmConfig(options = {}) {
  const provider = normalizeProviderName(
    pickDefined(
      options.llmProvider,
      process.env.PAPERNEXUS_LLM_PROVIDER,
      inferLegacyOllamaUsage(options) ? 'ollama' : DEFAULT_LLM_PROVIDER
    )
  ) || DEFAULT_LLM_PROVIDER;
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
  const defaultBaseUrl = resolveProviderDefaultBaseUrl(provider);
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

  const requestedBatchSize = Number(pickDefined(
    options.llmBatchSize,
    process.env.PAPERNEXUS_LLM_BATCH_SIZE,
    options.ollamaBatchSize,
    process.env.PAPERNEXUS_OLLAMA_BATCH_SIZE,
    DEFAULT_BATCH_SIZE
  ));
  const providerBatchingEnabled = resolveProviderBatchingEnabled(provider, options);

  const config = {
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
    batchSize: provider === 'deepseek' && !providerBatchingEnabled ? 1 : requestedBatchSize,
    providerBatchingEnabled,
    maxTokens: Number(pickDefined(
      options.llmMaxTokens,
      process.env.PAPERNEXUS_LLM_MAX_TOKENS,
      DEFAULT_MAX_TOKENS
    )),
    rateLimitRetryCount: Number(pickDefined(
      options.llmRateLimitRetryCount,
      process.env.PAPERNEXUS_LLM_RATE_LIMIT_RETRY_COUNT,
      options.llmRetryCount,
      process.env.PAPERNEXUS_LLM_RETRY_COUNT,
      DEFAULT_RATE_LIMIT_RETRY_COUNT
    )),
    rateLimitRetryDelayMs: Number(pickDefined(
      options.llmRateLimitRetryDelayMs,
      process.env.PAPERNEXUS_LLM_RATE_LIMIT_RETRY_DELAY_MS,
      options.llmRetryDelayMs,
      process.env.PAPERNEXUS_LLM_RETRY_DELAY_MS,
      DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
    )),
    rateLimitRetryMaxDelayMs: Number(pickDefined(
      options.llmRateLimitRetryMaxDelayMs,
      process.env.PAPERNEXUS_LLM_RATE_LIMIT_RETRY_MAX_DELAY_MS,
      options.llmRetryMaxDelayMs,
      process.env.PAPERNEXUS_LLM_RETRY_MAX_DELAY_MS,
      DEFAULT_RATE_LIMIT_RETRY_MAX_DELAY_MS
    )),
    rateLimitCooldownMs: Number(pickDefined(
      options.llmRateLimitCooldownMs,
      process.env.PAPERNEXUS_LLM_RATE_LIMIT_COOLDOWN_MS,
      DEFAULT_RATE_LIMIT_COOLDOWN_MS
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
  config.fallback = resolveLlmFallbackConfig(options, config);
  return config;
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
    fallback: config.fallback
      ? {
          provider: config.fallback.provider || '',
          model: config.fallback.model || '',
          baseUrl: config.fallback.baseUrl || '',
          sshHost: config.fallback.sshHost || '',
          autoStart: Boolean(config.fallback.autoStart),
          autoPull: Boolean(config.fallback.autoPull),
          ollamaBootstrap: config.fallback.ollamaBootstrap?.mode || ''
        }
      : null,
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
  chunkId = null,
  paperId = null,
  sourceKey = null,
  sectionHeading = null,
  sectionRole = null,
  chunkOrder = null,
  textHash = null,
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
  metrics = [],
  fieldOfStudy = null,
  fieldCandidates = [],
  domainTags = [],
  abstractMechanisms = [],
  abstractMechanismObjects = [],
  researchQuestions = [],
  openChallenges = [],
  takeaways = [],
  ideaFragments = [],
  rateLimitCooldownUntil = null
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
    researchGoals,
    limitations,
    assumptions,
    evidences,
    futureDirections,
    benchmarks,
    datasets,
    metrics,
    fieldOfStudy,
    fieldCandidates,
    domainTags,
    abstractMechanisms,
    abstractMechanismObjects,
    researchQuestions,
    openChallenges,
    takeaways,
    ideaFragments,
    rateLimitCooldownUntil,
    error,
    chunkId,
    paperId,
    sourceKey,
    sectionHeading,
    sectionRole,
    chunkOrder,
    textHash
  };
}

function getRateLimitCooldownUntil(error) {
  return error?.rateLimitCooldownUntil || null;
}

function createRateLimitedSemanticObjectInferenceResult({
  provider,
  requestedMode,
  effectiveMode = 'heuristic-only',
  error
} = {}) {
  return createSemanticObjectInferenceResult({
    provider,
    requestedMode,
    effectiveMode,
    attempted: true,
    participated: false,
    reason: 'rate-limited',
    error: null,
    rateLimitCooldownUntil: getRateLimitCooldownUntil(error)
  });
}

function createRateLimitedResearchSemanticsResult(config = {}, error = {}) {
  return {
    provider: config.provider,
    benchmarks: [],
    findings: [],
    researchGoals: [],
    relations: [],
    reason: 'rate-limited',
    rateLimitCooldownUntil: getRateLimitCooldownUntil(error),
    error: null
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

function getResponseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(String(name).toLowerCase()) || '';
  }
  return headers[name] || headers[String(name).toLowerCase()] || '';
}

function parseRetryAfterMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }

  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return null;
}

async function safeReadResponseText(response) {
  try {
    if (typeof response?.text === 'function') {
      return await response.text();
    }
    if (typeof response?.json === 'function') {
      return JSON.stringify(await response.json());
    }
  } catch {}
  return '';
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function toNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function resolveBatchPromptMaxChars(options = {}) {
  return toNonNegativeInteger(
    pickDefined(
      options.llmBatchPromptMaxChars,
      options.batchPromptMaxChars,
      process.env.PAPERNEXUS_LLM_BATCH_PROMPT_MAX_CHARS,
      DEFAULT_BATCH_PROMPT_MAX_CHARS
    ),
    DEFAULT_BATCH_PROMPT_MAX_CHARS
  );
}

function resolveLongContextWindowTokensForBatch(options = {}) {
  const parsed = Number(pickDefined(
    options.llmContextWindowTokens,
    options.contextWindowTokens,
    options.llmContextTokens,
    process.env.PAPERNEXUS_LLM_CONTEXT_WINDOW_TOKENS
  ));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function isLongContextFirstBatchMode(options = {}) {
  if (options.longContextFallbackActive) return true;
  const strategy = String(pickDefined(
    options.llmExtractionStrategy,
    options.extractionStrategy,
    options.importLlmExtractionStrategy,
    process.env.PAPERNEXUS_LLM_EXTRACTION_STRATEGY,
    'auto'
  ) || 'auto').trim().toLowerCase().replace(/_/g, '-');
  if (['chunk', 'chunks', 'chunk-first', 'chunk-first-map-reduce'].includes(strategy)) return false;
  if (['paper', 'paper-level', 'whole-paper', 'long-context', 'long-context-first'].includes(strategy)) return true;
  return resolveLongContextWindowTokensForBatch(options) >= LONG_CONTEXT_SPLIT_RETRY_MIN_WINDOW_TOKENS;
}

function isLongContextStructuralFallbackEnabledForBatch(options = {}) {
  const explicit = pickDefined(
    options.llmLongContextStructuralFallback,
    options.longContextStructuralFallback,
    options.structuralSemanticFallback,
    process.env.PAPERNEXUS_LLM_LONG_CONTEXT_STRUCTURAL_FALLBACK
  );
  return explicit !== undefined && !isExplicitlyDisabledFlag(explicit);
}

function shouldBoundLongContextSplitRetry(options = {}) {
  const explicit = pickDefined(
    options.llmLongContextSplitRetryEnabled,
    options.longContextSplitRetryEnabled,
    process.env.PAPERNEXUS_LLM_LONG_CONTEXT_SPLIT_RETRY_ENABLED
  );
  if (explicit !== undefined) return isExplicitlyDisabledFlag(explicit);
  return false;
}

function resolveBatchFailureSplitRetryCount(options = {}) {
  const explicit = pickDefined(
    options.llmBatchFailureSplitRetryCount,
    options.batchFailureSplitRetryCount,
    process.env.PAPERNEXUS_LLM_BATCH_FAILURE_SPLIT_RETRY_COUNT
  );
  if (explicit !== undefined) {
    return toNonNegativeInteger(explicit, DEFAULT_BATCH_FAILURE_SPLIT_RETRY_COUNT);
  }
  if (shouldBoundLongContextSplitRetry(options)) return 0;
  return toNonNegativeInteger(
    DEFAULT_BATCH_FAILURE_SPLIT_RETRY_COUNT,
    DEFAULT_BATCH_FAILURE_SPLIT_RETRY_COUNT
  );
}

function partitionEntriesByPromptBudget(entries = [], promptBuilder, options = {}, maxBatchSize = DEFAULT_BATCH_SIZE) {
  const hardBatchSize = Math.max(1, Number(maxBatchSize || DEFAULT_BATCH_SIZE));
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const batches = [];
  let current = [];

  for (const entry of entries) {
    if (current.length >= hardBatchSize) {
      batches.push(current);
      current = [];
    }

    const candidate = [...current, entry];
    const wouldExceedBudget = current.length > 0
      && promptMaxChars > 0
      && String(promptBuilder(candidate)).length > promptMaxChars;

    if (wouldExceedBudget) {
      batches.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

function isBatchOutputParseError(error) {
  if (Number(error?.statusCode || 0)) return false;
  return /(?:valid json|json parse|unexpected token|unexpected end|empty content|empty response)/i.test(String(error?.message || ''));
}

function shouldRetryBatchBySplitting(error, batch = [], retryCount = 0) {
  return Boolean(
    retryCount > 0
    && batch.length > 1
    && !isLlmRateLimitError(error)
    && isBatchOutputParseError(error)
  );
}

function splitBatchForRetry(batch = []) {
  if (!batch.length) return [];
  if (batch.length === 1) return [batch];
  const midpoint = Math.ceil(batch.length / 2);
  return [batch.slice(0, midpoint), batch.slice(midpoint)].filter((subBatch) => subBatch.length);
}

function resolveLlmBatchLedger(options = {}, phase = 'llm-batch') {
  const dir = pickDefined(
    options.llmBatchLedgerDir,
    options.llm_batch_ledger_dir,
    options.batchLedgerDir,
    options.batch_ledger_dir
  );
  if (!dir) return null;
  return {
    dir: path.resolve(process.cwd(), String(dir)),
    phase,
    runId: String(pickDefined(options.llmBatchRunId, options.llm_batch_run_id, options.runId, 'llm-run')),
    resume: isEnabledFlag(pickDefined(options.llmBatchResume, options.llm_batch_resume, options.batchResume, false))
  };
}

function llmBatchId(ledger = {}, batch = [], prompt = '') {
  return stableHash(JSON.stringify({
    phase: ledger?.phase || 'llm-batch',
    ids: batch.map((entry) => entry.id || entry.chunkId || entry.paperId || entry.sourceKey || entry.__batchIndex),
    promptHash: stableHash(String(prompt), 16)
  }), 20);
}

async function appendLlmBatchLedger(ledger = null, fileName = '', event = {}) {
  if (!ledger?.dir || !fileName) return;
  await fs.mkdir(ledger.dir, { recursive: true });
  await fs.appendFile(path.join(ledger.dir, fileName), `${JSON.stringify({
    contractVersion: 'papernexus-llm-batch-ledger-v1',
    runId: ledger.runId,
    phase: ledger.phase,
    updatedAt: new Date().toISOString(),
    ...event
  })}\n`, 'utf8');
}

async function readLlmBatchJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadCompletedLlmBatchResults(ledger = null) {
  if (!ledger?.resume) return new Map();
  const rows = await readLlmBatchJsonl(path.join(ledger.dir, 'llm-results.jsonl'));
  return new Map(rows
    .filter((row) => row.phase === ledger.phase && row.status === 'completed' && row.batchId && Array.isArray(row.results))
    .map((row) => [row.batchId, row]));
}

function copyCachedLlmBatchResults(results = [], batch = [], cached = {}) {
  const cachedResults = cached.results || [];
  if (cachedResults.length !== batch.length) return false;
  for (let offset = 0; offset < batch.length; offset += 1) {
    results[batch[offset].__batchIndex] = cachedResults[offset];
  }
  return true;
}

function collectLlmBatchResults(results = [], batch = []) {
  return batch.map((entry) => results[entry.__batchIndex] || null);
}

function resolveLlmRetryConfig(config = {}) {
  const retryCount = toNonNegativeInteger(config.rateLimitRetryCount, DEFAULT_RATE_LIMIT_RETRY_COUNT);
  const retryDelayMs = toNonNegativeNumber(config.rateLimitRetryDelayMs, DEFAULT_RATE_LIMIT_RETRY_DELAY_MS);
  const retryMaxDelayMs = Math.max(
    retryDelayMs,
    toNonNegativeNumber(config.rateLimitRetryMaxDelayMs, DEFAULT_RATE_LIMIT_RETRY_MAX_DELAY_MS)
  );

  return {
    retryCount,
    retryDelayMs,
    retryMaxDelayMs
  };
}

function isRetryableStatusCode(status) {
  return TRANSIENT_LLM_STATUS_CODES.has(Number(status || 0));
}

function createLlmRateLimitCooldownKey(config = {}, providerLabel = 'LLM') {
  return [
    String(config.provider || providerLabel || '').trim().toLowerCase(),
    String(config.baseUrl || '').trim().replace(/\/+$/, '').toLowerCase()
  ].join('|');
}

async function refreshPersistedLlmRateLimitCooldowns() {
  const entries = await loadLlmRateLimitCooldowns();
  for (const entry of entries) {
    llmRateLimitCooldowns.set(entry.key, entry);
  }

  for (const [key, entry] of llmRateLimitCooldowns) {
    if (Number(entry.untilMs || 0) <= Date.now()) {
      llmRateLimitCooldowns.delete(key);
    }
  }
}

async function getActiveLlmRateLimitCooldown(config = {}, providerLabel = 'LLM') {
  await refreshPersistedLlmRateLimitCooldowns();
  const key = createLlmRateLimitCooldownKey(config, providerLabel);
  const entry = llmRateLimitCooldowns.get(key);
  if (!entry) return null;

  if (Number(entry.untilMs || 0) > Date.now()) {
    return entry;
  }

  llmRateLimitCooldowns.delete(key);
  return null;
}

function createLlmRateLimitCooldownError(providerLabel, config = {}, entry = {}) {
  const untilMs = Number(entry.untilMs || 0);
  const until = untilMs > 0 ? new Date(untilMs).toISOString() : null;
  const error = new Error(
    `${providerLabel} request skipped during rate-limit cooldown${until ? ` until ${until}` : ''}`
  );
  error.provider = providerLabel;
  error.statusCode = 429;
  error.reason = 'rate-limited';
  error.rateLimitCooldownUntil = until;
  error.retryable = false;
  error.cooldownActive = true;
  error.cooldownKey = createLlmRateLimitCooldownKey(config, providerLabel);
  return error;
}

async function recordLlmRateLimitCooldown(config = {}, providerLabel = 'LLM', error = {}) {
  const cooldownMs = toNonNegativeNumber(config.rateLimitCooldownMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  const retryAfterMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
  const untilMs = Date.now() + Math.max(cooldownMs, retryAfterMs);
  const key = createLlmRateLimitCooldownKey(config, providerLabel);
  const entry = {
    key,
    provider: String(config.provider || providerLabel || '').trim().toLowerCase(),
    baseUrl: String(config.baseUrl || '').trim().replace(/\/+$/, ''),
    untilMs,
    until: new Date(untilMs).toISOString(),
    statusCode: 429,
    message: String(error.message || '')
  };

  llmRateLimitCooldowns.set(key, entry);
  try {
    await saveLlmRateLimitCooldown(entry);
    error.rateLimitCooldownPersisted = true;
  } catch (persistError) {
    error.rateLimitCooldownPersisted = false;
    error.rateLimitCooldownPersistError = String(persistError?.message || persistError || '');
  }
  error.rateLimitCooldownUntil = entry.until;
  error.retryable = false;
  return entry;
}

export async function clearLlmRateLimitCooldowns(options = {}) {
  llmRateLimitCooldowns.clear();
  if (options.persisted !== false) {
    await clearLlmRateLimitCooldownStore();
  }
}

export function isLlmRateLimitError(error) {
  return Number(error?.statusCode || 0) === 429
    || /(?:\b429\b|rate limit|too many requests)/i.test(String(error?.message || ''));
}

function isRetryableLlmError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  if (error.retryable === true) return true;
  if (isRetryableStatusCode(error.statusCode)) return true;
  return false;
}

async function createLlmHttpError(providerLabel, response) {
  const statusCode = Number(response?.status || 0);
  const retryAfterMs = parseRetryAfterMs(getResponseHeader(response, 'retry-after'));
  const responseText = String(await safeReadResponseText(response) || '').replace(/\s+/g, ' ').trim();
  const statusText = String(response?.statusText || '').trim();
  const bodySuffix = responseText ? `: ${truncate(responseText, 240)}` : '';
  const retrySuffix = statusCode === 429 && retryAfterMs !== null
    ? ` (rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s)`
    : '';
  const error = new Error(
    `${providerLabel} request failed with ${statusCode}${statusText ? ` ${statusText}` : ''}${bodySuffix}${retrySuffix}`
  );
  error.provider = providerLabel;
  error.statusCode = statusCode;
  error.retryAfterMs = retryAfterMs;
  error.retryable = isRetryableStatusCode(statusCode);
  return error;
}

function getLlmRetryDelayMs(error, retryIndex, retryConfig) {
  if (Number.isFinite(error?.retryAfterMs)) {
    return Math.min(error.retryAfterMs, retryConfig.retryMaxDelayMs);
  }

  if (retryConfig.retryDelayMs <= 0) {
    return 0;
  }

  return Math.min(
    retryConfig.retryMaxDelayMs,
    retryConfig.retryDelayMs * (2 ** Math.max(0, retryIndex))
  );
}

async function waitForLlmRetry(error, retryIndex, retryConfig) {
  const delayMs = getLlmRetryDelayMs(error, retryIndex, retryConfig);
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchLlmJsonWithRetry(providerLabel, url, requestOptions, config = {}) {
  const retryConfig = resolveLlmRetryConfig(config);
  let lastError = null;

  for (let attempt = 0; attempt <= retryConfig.retryCount; attempt += 1) {
    const activeCooldown = await getActiveLlmRateLimitCooldown(config, providerLabel);
    if (activeCooldown) {
      throw createLlmRateLimitCooldownError(providerLabel, config, activeCooldown);
    }

    const controller = new AbortController();
    const timeoutMs = toNonNegativeNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    const timeoutHandle = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal
      });

      if (!response.ok) {
        throw await createLlmHttpError(providerLabel, response);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (isLlmRateLimitError(error)) {
        await recordLlmRateLimitCooldown(config, providerLabel, error);
        throw error;
      }
      if (attempt >= retryConfig.retryCount || !isRetryableLlmError(error)) {
        throw error;
      }
      clearTimeout(timeoutHandle);
      await waitForLlmRetry(error, attempt, retryConfig);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  throw lastError;
}

function quoteShellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function interpolateOllamaBootstrapCommand(template, config = {}) {
  return String(template || '')
    .replaceAll('{model}', quoteShellArg(config.model || ''))
    .replaceAll('{rawModel}', String(config.model || ''))
    .replaceAll('{baseUrl}', quoteShellArg(config.baseUrl || DEFAULT_OLLAMA_BASE_URL))
    .replaceAll('{rawBaseUrl}', String(config.baseUrl || DEFAULT_OLLAMA_BASE_URL));
}

async function runShellCommand(config = {}, command, providerLabel = 'Ollama fallback bootstrap') {
  const timeoutMs = Math.max(1000, toNonNegativeNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS));
  if (config.sshHost) {
    return runSshCommand(
      config.sshHost,
      ['sh', '-lc', command],
      '',
      timeoutMs,
      providerLabel
    );
  }

  const runner = config.execFile || execFileAsync;
  const result = await runner('sh', ['-lc', command], { timeout: timeoutMs });
  return typeof result === 'string' ? result : result?.stdout || '';
}

async function fetchLocalJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchOllamaTags(config = {}) {
  const timeoutMs = Math.max(1000, Math.min(toNonNegativeNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS), 10000));
  const url = `${config.baseUrl || DEFAULT_OLLAMA_BASE_URL}/api/tags`;

  if (config.sshHost) {
    try {
      const output = await runSshCommand(
        config.sshHost,
        ['curl', '-fsS', '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
        '',
        timeoutMs,
        'Ollama tags'
      );
      return JSON.parse(output);
    } catch {
      return null;
    }
  }

  return fetchLocalJson(url, timeoutMs);
}

function normalizeOllamaModelName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.includes(':') ? text : `${text}:latest`;
}

function hasOllamaModel(tagsPayload, model) {
  const requested = String(model || '').trim();
  const normalizedRequested = normalizeOllamaModelName(requested);
  return (tagsPayload?.models || []).some((entry) => {
    const name = String(entry?.name || '').trim();
    return name === requested || normalizeOllamaModelName(name) === normalizedRequested;
  });
}

function buildDockerOllamaStartCommand(bootstrap = {}) {
  const docker = quoteShellArg(bootstrap.dockerBin || 'docker');
  const container = quoteShellArg(bootstrap.dockerContainer || DEFAULT_OLLAMA_DOCKER_CONTAINER);
  const image = quoteShellArg(bootstrap.dockerImage || DEFAULT_OLLAMA_DOCKER_IMAGE);
  const volume = String(bootstrap.dockerVolume || '').trim();
  const gpus = String(bootstrap.dockerGpus || '').trim();
  const dockerRunParts = [
    docker,
    'run',
    '-d',
    '--name',
    container,
    '-p',
    quoteShellArg('127.0.0.1:11434:11434')
  ];
  if (volume) {
    dockerRunParts.push('-v', quoteShellArg(volume));
  }
  if (gpus) {
    dockerRunParts.push('--gpus', quoteShellArg(gpus));
  }
  dockerRunParts.push(image, '>/dev/null');

  return [
    `if ${docker} inspect ${container} >/dev/null 2>&1; then`,
    `${docker} start ${container} >/dev/null;`,
    'else',
    `${dockerRunParts.join(' ')};`,
    'fi'
  ].join(' ');
}

function buildOllamaStartCommand(config = {}) {
  const bootstrap = config.ollamaBootstrap || {};
  if (bootstrap.startCommand) {
    return interpolateOllamaBootstrapCommand(bootstrap.startCommand, config);
  }
  if (bootstrap.mode === 'docker') {
    return buildDockerOllamaStartCommand(bootstrap);
  }
  const command = quoteShellArg(bootstrap.command || 'ollama');
  return `nohup ${command} serve >/tmp/papernexus-ollama.log 2>&1 < /dev/null &`;
}

function buildOllamaPullCommand(config = {}) {
  const bootstrap = config.ollamaBootstrap || {};
  if (bootstrap.pullCommand) {
    return interpolateOllamaBootstrapCommand(bootstrap.pullCommand, config);
  }
  if (bootstrap.mode === 'docker') {
    const docker = quoteShellArg(bootstrap.dockerBin || 'docker');
    const container = quoteShellArg(bootstrap.dockerContainer || DEFAULT_OLLAMA_DOCKER_CONTAINER);
    return `${docker} exec ${container} ollama pull ${quoteShellArg(config.model || '')}`;
  }
  return `${quoteShellArg(bootstrap.command || 'ollama')} pull ${quoteShellArg(config.model || '')}`;
}

async function waitForOllamaReady(config = {}) {
  const deadline = Date.now() + Math.max(1000, toNonNegativeNumber(config.startupWaitMs, DEFAULT_OLLAMA_STARTUP_WAIT_MS));
  while (Date.now() <= deadline) {
    const tags = await fetchOllamaTags(config);
    if (tags) return tags;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function prepareOllamaRuntime(config = {}) {
  if (config.provider !== 'ollama') return;
  if (!config.autoStart && !config.autoPull) return;

  let tags = await fetchOllamaTags(config);
  if (!tags && config.autoStart) {
    await runShellCommand(config, buildOllamaStartCommand(config), 'Ollama fallback start');
    tags = await waitForOllamaReady(config);
    if (!tags) {
      throw new Error(`Ollama fallback service did not become ready at ${config.baseUrl || DEFAULT_OLLAMA_BASE_URL}`);
    }
  }

  if (!config.autoPull) return;
  if (!tags) {
    throw new Error(`Ollama fallback service is not reachable at ${config.baseUrl || DEFAULT_OLLAMA_BASE_URL}; cannot pull ${config.model}`);
  }
  if (hasOllamaModel(tags, config.model)) return;

  await runShellCommand(config, buildOllamaPullCommand(config), 'Ollama fallback pull');
}

async function requestOllamaGenerate(config, prompt) {
  await prepareOllamaRuntime(config);

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
    const response = JSON.parse(output);
    return {
      text: response.response || ''
    };
  }

  const response = await fetchLlmJsonWithRetry(
    'Ollama',
    `${config.baseUrl}/api/generate`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    },
    config
  );

  return {
    text: response.response || ''
  };
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
  const providerLabel = getOpenAiCompatibleProviderLabel(config);
  const apiKey = config.apiKey || await loadLlmApiKey(config);
  if (apiKey && !config.apiKey) {
    config.apiKey = apiKey;
  }

  if (!apiKey) {
    throw new Error(
      `Missing API key for the ${providerLabel}-compatible provider. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv(config.provider)}, llm.apiKey, or run \`papernexus auth llm set\`.`
    );
  }

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
    temperature: 0.1
  };

  if (isDeepSeekProvider(config)) {
    requestBody.max_tokens = config.maxTokens;
  } else {
    requestBody.max_completion_tokens = config.maxTokens;
  }

  if (shouldDisableThinkingForJsonMode(config)) {
    requestBody.enable_thinking = false;
  }

  const response = await fetchLlmJsonWithRetry(
    providerLabel,
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    },
    config
  );

  const text = extractOpenAiText(response);
  if (isDeepSeekProvider(config) && !String(text || '').trim()) {
    throw new Error('DeepSeek JSON mode returned empty content; retry with a shorter prompt or a larger max_tokens value.');
  }

  return { text };
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

  const response = await fetchLlmJsonWithRetry(
    'Anthropic',
    `${config.baseUrl}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
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
    },
    config
  );

  return {
    text: extractAnthropicText(response)
  };
}

async function requestLlmGenerateDirect(config, prompt) {
  if (isOpenAiCompatibleProvider(config.provider)) {
    return requestOpenAiGenerate(config, prompt);
  }

  if (config.provider === 'anthropic') {
    return requestAnthropicGenerate(config, prompt);
  }

  return requestOllamaGenerate(config, prompt);
}

function hasUsableLlmFallback(config = {}) {
  return Boolean(config?.fallback?.enabled && config.fallback.provider && config.fallback.model);
}

function withLlmGenerationMetadata(payload = {}, config = {}, extra = {}) {
  return {
    ...payload,
    provider: config.provider,
    model: config.model,
    ...extra
  };
}

async function requestLlmGenerate(config, prompt) {
  try {
    return withLlmGenerationMetadata(
      await requestLlmGenerateDirect(config, prompt),
      config
    );
  } catch (error) {
    if (!isLlmRateLimitError(error) || !hasUsableLlmFallback(config)) {
      throw error;
    }

    const fallbackConfig = {
      ...config.fallback,
      fallback: null
    };
    try {
      return withLlmGenerationMetadata(
        await requestLlmGenerateDirect(fallbackConfig, prompt),
        fallbackConfig,
        {
          fallback: true,
          fallbackFromProvider: config.provider,
          fallbackFromModel: config.model,
          primaryRateLimitCooldownUntil: error.rateLimitCooldownUntil || null
        }
      );
    } catch (fallbackError) {
      fallbackError.fallbackFromRateLimit = true;
      fallbackError.primaryRateLimitProvider = config.provider;
      fallbackError.primaryRateLimitModel = config.model;
      fallbackError.primaryRateLimitCooldownUntil = error.rateLimitCooldownUntil || null;
      throw fallbackError;
    }
  }
}

function parseJsonText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    throw new Error('LLM response returned empty content.');
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

function sanitizeResearchQuestionGroup(raw, key = 'researchQuestions') {
  return (raw?.[key] || [])
    .map((record) => sanitizeResearchQuestionRecord(record))
    .filter(Boolean);
}

function sanitizeChallengeGroup(raw, key = 'openChallenges') {
  return (raw?.[key] || [])
    .map((record) => sanitizeChallengeRecord(record))
    .filter(Boolean);
}

function sanitizeTakeawayGroup(raw, key = 'takeaways') {
  return (raw?.[key] || [])
    .map((record) => sanitizeTakeawayRecord(record))
    .filter(Boolean);
}

function sanitizeIdeaFragmentGroup(raw, key = 'ideaFragments') {
  return (raw?.[key] || [])
    .map((record) => sanitizeIdeaFragmentRecord(record))
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

function classifyLlmHttpStatusFailureReason(statusCode) {
  const status = Number(statusCode || 0);
  if (!Number.isFinite(status) || status <= 0) return '';
  if (status === 429) return 'rate-limited';
  if (status === 408 || status === 504) return 'provider-timeout';
  if (status === 401 || status === 403) return 'provider-auth-failed';
  if (status >= 500) return 'provider-http-5xx';
  if (status >= 400) return 'provider-http-4xx';
  return '';
}

function classifyLlmRequestErrorReason(error = {}) {
  if (isLlmRateLimitError(error)) return 'rate-limited';
  const explicit = String(error?.reason || '').trim();
  if (explicit) return explicit;
  const httpReason = classifyLlmHttpStatusFailureReason(error?.statusCode || error?.status);
  if (httpReason) return httpReason;
  return classifyLlmInferenceFailureReason({ error: error?.message || error });
}

function classifyLlmInferenceFailureReason(result = {}) {
  const explicit = String(result?.reason || '').trim();
  if (explicit) return explicit;
  const httpReason = classifyLlmHttpStatusFailureReason(result?.statusCode || result?.status);
  if (httpReason) return httpReason;
  const errorText = String(result?.error || '').toLowerCase();
  if (!errorText) return 'request-failed';
  const httpStatusMatch = errorText.match(/(?:request failed with|http)\s+(\d{3})/i);
  if (httpStatusMatch) {
    const reason = classifyLlmHttpStatusFailureReason(Number(httpStatusMatch[1]));
    if (reason) return reason;
  }
  if (/\b429\b|rate limit|too many requests/.test(errorText)) {
    return 'rate-limited';
  }
  if (errorText.includes('missing batch') || errorText.includes('missing split-retry')) {
    return 'missing-result';
  }
  if (errorText.includes('empty content') || errorText.includes('empty response')) {
    return 'empty-response';
  }
  if (errorText.includes('schema') || errorText.includes('expected "') || errorText.includes('expected ')) {
    return 'schema-validation-failed';
  }
  if (errorText.includes('timed out') || errorText.includes('timeout') || errorText.includes('aborterror') || errorText.includes('aborted')) {
    return 'provider-timeout';
  }
  if (errorText.includes('invalid json') || errorText.includes('not valid json') || errorText.includes('json parse') || errorText.includes('unexpected token')) {
    return 'invalid-json';
  }
  if (
    errorText.includes('fetch failed')
    || errorText.includes('econnreset')
    || errorText.includes('econnrefused')
    || errorText.includes('enotfound')
    || errorText.includes('etimedout')
    || errorText.includes('network')
  ) {
    return 'provider-network';
  }
  return 'request-failed';
}

function summarizeLlmInferenceFailureReasons(results = []) {
  const counts = {};
  for (const result of Array.isArray(results) ? results : []) {
    const reason = classifyLlmInferenceFailureReason(result);
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

const SPLIT_RETRYABLE_BATCH_RESULT_REASONS = new Set([
  'empty-response',
  'missing-result',
  'provider-timeout'
]);

function findSplitRetryableBatchResult(results = [], batch = []) {
  return collectLlmBatchResults(results, batch).find((result) => {
    if (!result) return false;
    const reason = classifyLlmInferenceFailureReason(result);
    if (!SPLIT_RETRYABLE_BATCH_RESULT_REASONS.has(reason)) return false;
    return Boolean(result.error || result.reason);
  }) || null;
}

function shouldRetryBatchResultsBySplitting(results = [], batch = [], retryCount = 0) {
  return Boolean(
    retryCount > 0
    && batch.length > 1
    && findSplitRetryableBatchResult(results, batch)
  );
}

function describeRetryableBatchResult(result = {}) {
  const reason = classifyLlmInferenceFailureReason(result);
  const error = String(result?.error || '').trim();
  return error ? `${reason}: ${error}` : reason;
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
      provider: payload.provider || plan.config.provider,
      requestedMode: plan.requestedMode,
      effectiveMode: plan.effectiveMode,
      attempted: true,
      participated: true,
      reason: null,
      ...sanitizeSemanticMetadata(raw),
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
      researchQuestions: sanitizeResearchQuestionGroup(raw),
      openChallenges: sanitizeChallengeGroup(raw),
      takeaways: sanitizeTakeawayGroup(raw),
      ideaFragments: sanitizeIdeaFragmentGroup(raw),
      error: null
    });
  } catch (error) {
    if (isLlmRateLimitError(error)) {
      return createRateLimitedSemanticObjectInferenceResult({
        provider: plan.config.provider,
        requestedMode: plan.requestedMode,
        error
      });
    }

    return createSemanticObjectInferenceResult({
      provider: error.fallbackFromRateLimit && plan.config.fallback?.provider
        ? plan.config.fallback.provider
        : plan.config.provider,
      requestedMode: plan.requestedMode,
      effectiveMode: 'heuristic-only',
      attempted: true,
      participated: false,
      reason: classifyLlmRequestErrorReason(error),
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

  const batchSize = resolveEffectiveLlmBatchSize(plan.config);
  const normalizedEntries = entries.map((entry, index) => ({
    ...entry,
    id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${index + 1}`),
    __batchIndex: index
  }));
  const batches = partitionEntriesByPromptBudget(
    normalizedEntries,
    buildSemanticExtractionBatchPrompt,
    options,
    batchSize
  );
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, batches.length);
  const splitRetryCount = resolveBatchFailureSplitRetryCount(options);
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const ledger = resolveLlmBatchLedger(options, 'semantic-extraction');
  const completedLedgerBatches = await loadCompletedLlmBatchResults(ledger);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let completedAfterBatch = Math.max(...batch.map((entry) => entry.__batchIndex)) + 1;
    let stopAfterCurrentBatch = false;
    const prompt = buildSemanticExtractionBatchPrompt(batch);
    const promptChars = String(prompt).length;
    const batchId = llmBatchId(ledger, batch, prompt);
    const cachedBatch = completedLedgerBatches.get(batchId);

    if (copyCachedLlmBatchResults(results, batch, cachedBatch)) {
      options.onBatchComplete?.({
        phase: 'semantic-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs: 0,
        cached: true,
        skipped: true
      });
      continue;
    }

    const batchStartedAt = Date.now();
    await appendLlmBatchLedger(ledger, 'llm-batches.jsonl', {
      status: 'running',
      batchId,
      batchNumber: batchIndex + 1,
      totalBatches,
      batchSize: batch.length,
      promptChars,
      promptMaxChars,
      entryIds: batch.map((entry) => entry.id)
    });

    try {
      const payload = await requestLlmGenerate(plan.config, prompt);
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || plan.config.provider;
      const topLevelSchemaError = raw?.papers !== undefined && !Array.isArray(raw.papers)
        ? 'Expected "papers" to be an array.'
        : raw?.errors !== undefined && !Array.isArray(raw.errors)
          ? 'Expected "errors" to be an array.'
          : null;
      if (topLevelSchemaError) {
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'schema-validation-failed',
            error: topLevelSchemaError
          });
        }
        continue;
      }
      const paperErrors = new Map(
        (Array.isArray(raw?.errors) ? raw.errors : [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const paperResults = new Map(
        (Array.isArray(raw?.papers) ? raw.papers : [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = paperResults.get(batchEntry.id);
        const rawError = paperErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: classifyLlmInferenceFailureReason({ error: rawError }),
            error: rawError
          });
          continue;
        }

        if (!rawPaper) {
          results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing batch semantic result for ${batchEntry.id}`
          });
          continue;
        }

        const normalizedRawPaper = normalizeSemanticPaperOutputShape(rawPaper);
        const schemaError = validateSemanticPaperSchema(normalizedRawPaper);
        if (schemaError) {
          results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'schema-validation-failed',
            error: schemaError
          });
          continue;
        }

        results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
          provider: resultProvider,
          requestedMode: plan.requestedMode,
          effectiveMode: plan.effectiveMode,
          attempted: true,
          participated: true,
          reason: null,
          ...sanitizeSemanticMetadata(normalizedRawPaper),
          problems: sanitizeEntityGroup(normalizedRawPaper, 'problems', NODE_TYPES.PROBLEM),
          methods: sanitizeEntityGroup(normalizedRawPaper, 'methods', NODE_TYPES.METHOD),
          claims: sanitizeEntityGroup(normalizedRawPaper, 'claims', NODE_TYPES.CLAIM),
          findings: sanitizeEntityGroup(normalizedRawPaper, 'findings', NODE_TYPES.FINDING),
          researchGoals: sanitizeEntityGroup(normalizedRawPaper, 'researchGoals', NODE_TYPES.RESEARCH_GOAL),
          limitations: sanitizeEntityGroup(normalizedRawPaper, 'limitations', NODE_TYPES.LIMITATION),
          assumptions: sanitizeEntityGroup(normalizedRawPaper, 'assumptions', NODE_TYPES.ASSUMPTION),
          evidences: sanitizeEntityGroup(normalizedRawPaper, 'evidences', NODE_TYPES.EVIDENCE),
          futureDirections: sanitizeEntityGroup(normalizedRawPaper, 'futureDirections', NODE_TYPES.FUTURE_DIRECTION),
          benchmarks: sanitizeEntityGroup(normalizedRawPaper, 'benchmarks', NODE_TYPES.BENCHMARK),
          datasets: sanitizeEntityGroup(normalizedRawPaper, 'datasets', NODE_TYPES.DATASET),
          metrics: sanitizeEntityGroup(normalizedRawPaper, 'metrics', NODE_TYPES.METRIC),
          researchQuestions: sanitizeResearchQuestionGroup(normalizedRawPaper),
          openChallenges: sanitizeChallengeGroup(normalizedRawPaper),
          takeaways: sanitizeTakeawayGroup(normalizedRawPaper),
          ideaFragments: sanitizeIdeaFragmentGroup(normalizedRawPaper),
          error: null
        });
      }

      if (shouldRetryBatchResultsBySplitting(results, batch, splitRetryCount)) {
        const retryableResult = findSplitRetryableBatchResult(results, batch);
        options.onBatchRetry?.({
          phase: 'semantic-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: describeRetryableBatchResult(retryableResult)
        });
        const retryResults = await inferPaperSemanticObjectsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || createSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing split-retry semantic result for ${batchEntry.id}`
          });
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = createSemanticObjectInferenceResult({
              provider: rateLimitedResult.provider || plan.config.provider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } catch (error) {
      let recoveredBySplitRetry = false;
      if (shouldRetryBatchBySplitting(error, batch, splitRetryCount)) {
        options.onBatchRetry?.({
          phase: 'semantic-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: error.message
        });
        const retryResults = await inferPaperSemanticObjectsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || createSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing split-retry semantic result for ${batchEntry.id}`
          });
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = createSemanticObjectInferenceResult({
              provider: rateLimitedResult.provider || plan.config.provider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
        recoveredBySplitRetry = true;
      }

      if (!recoveredBySplitRetry) {
        const failedProvider = error.fallbackFromRateLimit && plan.config.fallback?.provider
          ? plan.config.fallback.provider
          : plan.config.provider;
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = createSemanticObjectInferenceResult({
            provider: failedProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: classifyLlmRequestErrorReason(error),
            error: error.message
          });
        }

        if (isLlmRateLimitError(error)) {
          for (let offset = 0; offset < batch.length; offset += 1) {
            const batchEntry = batch[offset];
            results[batchEntry.__batchIndex] = createRateLimitedSemanticObjectInferenceResult({
              provider: failedProvider,
              requestedMode: plan.requestedMode,
              error
            });
          }

          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = createRateLimitedSemanticObjectInferenceResult({
              provider: failedProvider,
              requestedMode: plan.requestedMode,
              error
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } finally {
      const batchResults = collectLlmBatchResults(results, batch);
      const failedResults = batchResults.filter((result) => (
        result?.reason === 'request-failed'
        || result?.reason === 'rate-limited'
        || result?.error
      ));
      const durationMs = Date.now() - batchStartedAt;
      const status = failedResults.length ? 'completed_with_failures' : 'completed';
      const failureReasons = summarizeLlmInferenceFailureReasons(failedResults);
      await appendLlmBatchLedger(ledger, 'llm-results.jsonl', {
        status,
        batchId,
        batchNumber: batchIndex + 1,
        totalBatches,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        entryIds: batch.map((entry) => entry.id),
        results: batchResults
      });
      if (failedResults.length) {
        await appendLlmBatchLedger(ledger, 'llm-failures.jsonl', {
          status: 'failed',
          batchId,
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          promptChars,
          promptMaxChars,
          durationMs,
          entryIds: batch.map((entry) => entry.id),
          failedCount: failedResults.length,
          failureReasons,
          errors: failedResults.map((result) => result?.error || result?.reason || 'request-failed').slice(0, 20)
        });
      }
      options.onBatchComplete?.({
        phase: 'semantic-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        failureCount: failedResults.length,
        failureReasons,
        rateLimitCooldownUntil: batchResults.find((result) => result?.rateLimitCooldownUntil)?.rateLimitCooldownUntil || null
      });
    }

    if (stopAfterCurrentBatch) {
      break;
    }
  }

  return results;
}

export function createChunkSemanticObjectInferenceResult({
  provider = 'disabled',
  requestedMode = 'heuristic-only',
  effectiveMode = 'heuristic-only',
  attempted = false,
  participated = false,
  reason = null,
  error = null,
  chunkId = null,
  paperId = null,
  sourceKey = null,
  sectionHeading = null,
  sectionRole = null,
  chunkOrder = null,
  textHash = null,
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
  metrics = [],
  fieldOfStudy = null,
  fieldCandidates = [],
  domainTags = [],
  abstractMechanisms = [],
  abstractMechanismObjects = [],
  researchQuestions = [],
  openChallenges = [],
  takeaways = [],
  ideaFragments = [],
  rateLimitCooldownUntil = null
} = {}) {
  return createSemanticObjectInferenceResult({
    provider,
    requestedMode,
    effectiveMode,
    attempted,
    participated,
    reason,
    error,
    chunkId,
    paperId,
    sourceKey,
    sectionHeading,
    sectionRole,
    chunkOrder,
    textHash,
    problems,
    methods,
    claims,
    findings,
    researchGoals,
    limitations,
    assumptions,
    evidences,
    futureDirections,
    benchmarks,
    datasets,
    metrics,
    fieldOfStudy,
    fieldCandidates,
    domainTags,
    abstractMechanisms,
    abstractMechanismObjects,
    researchQuestions,
    openChallenges,
    takeaways,
    ideaFragments,
    rateLimitCooldownUntil
  });
}

function normalizeChunkBatchEntry(entry = {}, index = 0) {
  const chunk = entry.chunk || {};
  const semanticPaper = entry.semanticPaper || {};
  const chunkId = String(entry.id || chunk.chunkId || `chunk-${index + 1}`).trim();
  return {
    ...entry,
    id: chunkId,
    chunkId,
    sourceKey: String(entry.sourceKey || semanticPaper.sourceKey || '').trim(),
    paperId: String(entry.paperId || semanticPaper.paperId || '').trim(),
    paperTitle: String(entry.paperTitle || semanticPaper.paperTitle || '').trim(),
    sectionHeading: String(entry.sectionHeading || chunk.sectionHeading || '').trim(),
    sectionRole: String(entry.sectionRole || chunk.sectionRole || '').trim(),
    chunkOrder: Number(entry.chunkOrder || chunk.chunkOrder || 0),
    text: String(entry.text || chunk.text || '').trim(),
    textHash: String(entry.textHash || chunk.textHash || '').trim()
  };
}

function sanitizeChunkSemanticRaw(rawPaper = {}, batchEntry = {}, provider = 'disabled', plan = {}) {
  return createChunkSemanticObjectInferenceResult({
    provider,
    requestedMode: plan.requestedMode,
    effectiveMode: plan.effectiveMode,
    attempted: true,
    participated: true,
    reason: null,
    chunkId: batchEntry.chunkId,
    paperId: batchEntry.paperId,
    sourceKey: batchEntry.sourceKey,
    sectionHeading: batchEntry.sectionHeading,
    sectionRole: batchEntry.sectionRole,
    chunkOrder: batchEntry.chunkOrder,
    textHash: batchEntry.textHash,
    ...sanitizeSemanticMetadata(rawPaper),
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
    researchQuestions: sanitizeResearchQuestionGroup(rawPaper),
    openChallenges: sanitizeChallengeGroup(rawPaper),
    takeaways: sanitizeTakeawayGroup(rawPaper),
    ideaFragments: sanitizeIdeaFragmentGroup(rawPaper),
    error: null
  });
}

export async function inferChunkSemanticObjectsBatch(entries, options = {}) {
  const plan = resolveSemanticExtractionPlan(options);
  if (!entries?.length) return [];

  if (!plan.shouldAttempt) {
    return entries.map((entry, index) => {
      const normalized = normalizeChunkBatchEntry(entry, index);
      return createChunkSemanticObjectInferenceResult({
        requestedMode: plan.requestedMode,
        effectiveMode: plan.effectiveMode,
        attempted: false,
        participated: false,
        reason: plan.reason,
        chunkId: normalized.chunkId,
        paperId: normalized.paperId,
        sourceKey: normalized.sourceKey,
        sectionHeading: normalized.sectionHeading,
        sectionRole: normalized.sectionRole,
        chunkOrder: normalized.chunkOrder,
        textHash: normalized.textHash
      });
    });
  }

  const batchSize = resolveEffectiveLlmBatchSize(plan.config);
  const normalizedEntries = entries.map((entry, index) => ({
    ...normalizeChunkBatchEntry(entry, index),
    __batchIndex: index
  }));
  const batches = partitionEntriesByPromptBudget(
    normalizedEntries,
    buildChunkSemanticExtractionBatchPrompt,
    options,
    batchSize
  );
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, batches.length);
  const splitRetryCount = resolveBatchFailureSplitRetryCount(options);
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const ledger = resolveLlmBatchLedger(options, 'chunk-semantic-extraction');
  const completedLedgerBatches = await loadCompletedLlmBatchResults(ledger);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let completedAfterBatch = Math.max(...batch.map((entry) => entry.__batchIndex)) + 1;
    let stopAfterCurrentBatch = false;
    const prompt = buildChunkSemanticExtractionBatchPrompt(batch);
    const promptChars = String(prompt).length;
    const batchId = llmBatchId(ledger, batch, prompt);
    const cachedBatch = completedLedgerBatches.get(batchId);

    if (copyCachedLlmBatchResults(results, batch, cachedBatch)) {
      options.onBatchComplete?.({
        phase: 'chunk-semantic-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs: 0,
        cached: true,
        skipped: true
      });
      continue;
    }

    const batchStartedAt = Date.now();
    await appendLlmBatchLedger(ledger, 'llm-batches.jsonl', {
      status: 'running',
      batchId,
      batchNumber: batchIndex + 1,
      totalBatches,
      batchSize: batch.length,
      promptChars,
      promptMaxChars,
      entryIds: batch.map((entry) => entry.id)
    });

    try {
      const payload = await requestLlmGenerate(plan.config, prompt);
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || plan.config.provider;
      const chunkErrors = new Map(
        (raw?.errors || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const chunkResults = new Map(
        (raw?.chunks || raw?.papers || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = chunkResults.get(batchEntry.id);
        const rawError = chunkErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[batchEntry.__batchIndex] = createChunkSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: classifyLlmInferenceFailureReason({ error: rawError }),
            error: rawError,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          });
          continue;
        }

        if (!rawPaper) {
          results[batchEntry.__batchIndex] = createChunkSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing batch semantic result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          });
          continue;
        }

        results[batchEntry.__batchIndex] = sanitizeChunkSemanticRaw(rawPaper, batchEntry, resultProvider, plan);
      }

      if (shouldRetryBatchResultsBySplitting(results, batch, splitRetryCount)) {
        const retryableResult = findSplitRetryableBatchResult(results, batch);
        options.onBatchRetry?.({
          phase: 'chunk-semantic-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: describeRetryableBatchResult(retryableResult)
        });
        const retryResults = await inferChunkSemanticObjectsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || createChunkSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing split-retry semantic result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          });
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = createChunkSemanticObjectInferenceResult({
              provider: rateLimitedResult.provider || plan.config.provider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } catch (error) {
      let recoveredBySplitRetry = false;
      if (shouldRetryBatchBySplitting(error, batch, splitRetryCount)) {
        options.onBatchRetry?.({
          phase: 'chunk-semantic-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: error.message
        });
        const retryResults = await inferChunkSemanticObjectsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || createChunkSemanticObjectInferenceResult({
            provider: plan.config.provider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'missing-result',
            error: `Missing split-retry semantic result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          });
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = createChunkSemanticObjectInferenceResult({
              provider: rateLimitedResult.provider || plan.config.provider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
        recoveredBySplitRetry = true;
      }

      if (!recoveredBySplitRetry) {
        const failedProvider = error.fallbackFromRateLimit && plan.config.fallback?.provider
          ? plan.config.fallback.provider
          : plan.config.provider;
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = createChunkSemanticObjectInferenceResult({
            provider: failedProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: classifyLlmRequestErrorReason(error),
            error: error.message,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          });
        }

        if (isLlmRateLimitError(error)) {
          for (let offset = 0; offset < batch.length; offset += 1) {
            const batchEntry = batch[offset];
            results[batchEntry.__batchIndex] = createChunkSemanticObjectInferenceResult({
              provider: failedProvider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: getRateLimitCooldownUntil(error),
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            });
          }

          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = createChunkSemanticObjectInferenceResult({
              provider: failedProvider,
              requestedMode: plan.requestedMode,
              effectiveMode: 'heuristic-only',
              attempted: true,
              participated: false,
              reason: 'rate-limited',
              error: null,
              rateLimitCooldownUntil: getRateLimitCooldownUntil(error),
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            });
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } finally {
      const batchResults = collectLlmBatchResults(results, batch);
      const failedResults = batchResults.filter((result) => (
        result?.reason === 'request-failed'
        || result?.reason === 'rate-limited'
        || result?.error
      ));
      const durationMs = Date.now() - batchStartedAt;
      const status = failedResults.length ? 'completed_with_failures' : 'completed';
      const failureReasons = summarizeLlmInferenceFailureReasons(failedResults);
      await appendLlmBatchLedger(ledger, 'llm-results.jsonl', {
        status,
        batchId,
        batchNumber: batchIndex + 1,
        totalBatches,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        entryIds: batch.map((entry) => entry.id),
        results: batchResults
      });
      if (failedResults.length) {
        await appendLlmBatchLedger(ledger, 'llm-failures.jsonl', {
          status: 'failed',
          batchId,
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          promptChars,
          promptMaxChars,
          durationMs,
          entryIds: batch.map((entry) => entry.id),
          failedCount: failedResults.length,
          failureReasons,
          errors: failedResults.map((result) => result?.error || result?.reason || 'request-failed').slice(0, 20)
        });
      }
      options.onBatchComplete?.({
        phase: 'chunk-semantic-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        failureCount: failedResults.length,
        failureReasons,
        rateLimitCooldownUntil: batchResults.find((result) => result?.rateLimitCooldownUntil)?.rateLimitCooldownUntil || null
      });
    }

    if (stopAfterCurrentBatch) {
      break;
    }
  }

  return results;
}

function sanitizeChunkRelationRaw(rawPaper = {}, batchEntry = {}, provider = 'disabled', config = {}) {
  return {
    provider,
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
    error: null,
    chunkId: batchEntry.chunkId,
    paperId: batchEntry.paperId,
    sourceKey: batchEntry.sourceKey,
    sectionHeading: batchEntry.sectionHeading,
    sectionRole: batchEntry.sectionRole,
    chunkOrder: batchEntry.chunkOrder,
    textHash: batchEntry.textHash,
    chunkConfigSignature: config.signature || null
  };
}

export async function inferChunkResearchSemanticsBatch(entries, options = {}) {
  if (!entries?.length) return [];

  if (!llmRelationsEnabled(options)) {
    return entries.map((entry, index) => {
      const normalized = normalizeChunkBatchEntry(entry, index);
      return {
        provider: 'disabled',
        benchmarks: [],
        findings: [],
        researchGoals: [],
        relations: [],
        error: null,
        chunkId: normalized.chunkId,
        paperId: normalized.paperId,
        sourceKey: normalized.sourceKey,
        sectionHeading: normalized.sectionHeading,
        sectionRole: normalized.sectionRole,
        chunkOrder: normalized.chunkOrder,
        textHash: normalized.textHash
      };
    });
  }

  const config = resolveLlmConfig(options);
  if (!config.enabled || !config.model) {
    return entries.map((entry, index) => {
      const normalized = normalizeChunkBatchEntry(entry, index);
      return {
        provider: 'disabled',
        benchmarks: [],
        findings: [],
        researchGoals: [],
        relations: [],
        error: null,
        chunkId: normalized.chunkId,
        paperId: normalized.paperId,
        sourceKey: normalized.sourceKey,
        sectionHeading: normalized.sectionHeading,
        sectionRole: normalized.sectionRole,
        chunkOrder: normalized.chunkOrder,
        textHash: normalized.textHash
      };
    });
  }

  const batchSize = resolveEffectiveLlmBatchSize(config);
  const normalizedEntries = entries.map((entry, index) => ({
    ...normalizeChunkBatchEntry(entry, index),
    __batchIndex: index
  }));
  const batches = partitionEntriesByPromptBudget(
    normalizedEntries,
    buildChunkResearchSemanticsBatchPrompt,
    options,
    batchSize
  );
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, batches.length);
  const splitRetryCount = resolveBatchFailureSplitRetryCount(options);
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const ledger = resolveLlmBatchLedger(options, 'chunk-relation-extraction');
  const completedLedgerBatches = await loadCompletedLlmBatchResults(ledger);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let completedAfterBatch = Math.max(...batch.map((entry) => entry.__batchIndex)) + 1;
    let stopAfterCurrentBatch = false;
    const prompt = buildChunkResearchSemanticsBatchPrompt(batch);
    const promptChars = String(prompt).length;
    const batchId = llmBatchId(ledger, batch, prompt);
    const cachedBatch = completedLedgerBatches.get(batchId);

    if (copyCachedLlmBatchResults(results, batch, cachedBatch)) {
      options.onBatchComplete?.({
        phase: 'chunk-relation-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs: 0,
        cached: true,
        skipped: true
      });
      continue;
    }

    const batchStartedAt = Date.now();
    await appendLlmBatchLedger(ledger, 'llm-batches.jsonl', {
      status: 'running',
      batchId,
      batchNumber: batchIndex + 1,
      totalBatches,
      batchSize: batch.length,
      promptChars,
      promptMaxChars,
      entryIds: batch.map((entry) => entry.id)
    });

    try {
      const payload = await requestLlmGenerate(config, prompt);
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || config.provider;
      const chunkErrors = new Map(
        (raw?.errors || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const chunkResults = new Map(
        (raw?.chunks || raw?.papers || [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = chunkResults.get(batchEntry.id);
        const rawError = chunkErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: classifyLlmInferenceFailureReason({ error: rawError }),
            error: rawError,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          };
          continue;
        }

        if (!rawPaper) {
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing batch relation result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          };
          continue;
        }

        results[batchEntry.__batchIndex] = sanitizeChunkRelationRaw(rawPaper, batchEntry, resultProvider, {
          signature: createCrossPaperJudgmentConfigSignature(options)
        });
      }

      if (shouldRetryBatchResultsBySplitting(results, batch, splitRetryCount)) {
        const retryableResult = findSplitRetryableBatchResult(results, batch);
        options.onBatchRetry?.({
          phase: 'chunk-relation-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: describeRetryableBatchResult(retryableResult)
        });
        const retryResults = await inferChunkResearchSemanticsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing split-retry relation result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          };
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = {
              provider: rateLimitedResult.provider || config.provider,
              benchmarks: [],
              findings: [],
              researchGoals: [],
              relations: [],
              reason: 'rate-limited',
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              error: null,
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            };
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } catch (error) {
      let recoveredBySplitRetry = false;
      if (shouldRetryBatchBySplitting(error, batch, splitRetryCount)) {
        options.onBatchRetry?.({
          phase: 'chunk-relation-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: error.message
        });
        const retryResults = await inferChunkResearchSemanticsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing split-retry relation result for ${batchEntry.id}`,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          };
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = {
              provider: rateLimitedResult.provider || config.provider,
              benchmarks: [],
              findings: [],
              researchGoals: [],
              relations: [],
              reason: 'rate-limited',
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              error: null,
              chunkId: batchEntry.chunkId,
              paperId: batchEntry.paperId,
              sourceKey: batchEntry.sourceKey,
              sectionHeading: batchEntry.sectionHeading,
              sectionRole: batchEntry.sectionRole,
              chunkOrder: batchEntry.chunkOrder,
              textHash: batchEntry.textHash
            };
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
        recoveredBySplitRetry = true;
      }

      if (!recoveredBySplitRetry) {
        const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = {
            provider: failedProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: classifyLlmRequestErrorReason(error),
            error: error.message,
            chunkId: batchEntry.chunkId,
            paperId: batchEntry.paperId,
            sourceKey: batchEntry.sourceKey,
            sectionHeading: batchEntry.sectionHeading,
            sectionRole: batchEntry.sectionRole,
            chunkOrder: batchEntry.chunkOrder,
            textHash: batchEntry.textHash
          };
        }

        if (isLlmRateLimitError(error)) {
          for (let offset = 0; offset < batch.length; offset += 1) {
            const batchEntry = batch[offset];
            results[batchEntry.__batchIndex] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
            results[batchEntry.__batchIndex].chunkId = batchEntry.chunkId;
            results[batchEntry.__batchIndex].paperId = batchEntry.paperId;
            results[batchEntry.__batchIndex].sourceKey = batchEntry.sourceKey;
            results[batchEntry.__batchIndex].sectionHeading = batchEntry.sectionHeading;
            results[batchEntry.__batchIndex].sectionRole = batchEntry.sectionRole;
            results[batchEntry.__batchIndex].chunkOrder = batchEntry.chunkOrder;
            results[batchEntry.__batchIndex].textHash = batchEntry.textHash;
          }

          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            const batchEntry = normalizedEntries[index];
            results[index] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
            results[index].chunkId = batchEntry.chunkId;
            results[index].paperId = batchEntry.paperId;
            results[index].sourceKey = batchEntry.sourceKey;
            results[index].sectionHeading = batchEntry.sectionHeading;
            results[index].sectionRole = batchEntry.sectionRole;
            results[index].chunkOrder = batchEntry.chunkOrder;
            results[index].textHash = batchEntry.textHash;
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } finally {
      const batchResults = collectLlmBatchResults(results, batch);
      const failedResults = batchResults.filter((result) => (
        result?.reason === 'request-failed'
        || result?.reason === 'rate-limited'
        || result?.error
      ));
      const durationMs = Date.now() - batchStartedAt;
      const status = failedResults.length ? 'completed_with_failures' : 'completed';
      const failureReasons = summarizeLlmInferenceFailureReasons(failedResults);
      await appendLlmBatchLedger(ledger, 'llm-results.jsonl', {
        status,
        batchId,
        batchNumber: batchIndex + 1,
        totalBatches,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        entryIds: batch.map((entry) => entry.id),
        results: batchResults
      });
      if (failedResults.length) {
        await appendLlmBatchLedger(ledger, 'llm-failures.jsonl', {
          status: 'failed',
          batchId,
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          promptChars,
          promptMaxChars,
          durationMs,
          entryIds: batch.map((entry) => entry.id),
          failedCount: failedResults.length,
          failureReasons,
          errors: failedResults.map((result) => result?.error || result?.reason || 'request-failed').slice(0, 20)
        });
      }
      options.onBatchComplete?.({
        phase: 'chunk-relation-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        failureCount: failedResults.length,
        failureReasons,
        rateLimitCooldownUntil: batchResults.find((result) => result?.rateLimitCooldownUntil)?.rateLimitCooldownUntil || null
      });
    }

    if (stopAfterCurrentBatch) {
      break;
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
      provider: payload.provider || config.provider,
      benchmarks,
      findings,
      researchGoals,
      relations,
      error: null
    };
  } catch (error) {
    if (isLlmRateLimitError(error)) {
      const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
      return createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
    }

    return {
      provider: error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider,
      benchmarks: [],
      findings: [],
      researchGoals: [],
      relations: [],
      reason: classifyLlmRequestErrorReason(error),
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

  const batchSize = resolveEffectiveLlmBatchSize(config);
  const normalizedEntries = entries.map((entry, index) => ({
      ...entry,
      id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${index + 1}`),
      __batchIndex: index
    }));
  const batches = partitionEntriesByPromptBudget(
    normalizedEntries,
    buildResearchSemanticsBatchPrompt,
    options,
    batchSize
  );
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, batches.length);
  const splitRetryCount = resolveBatchFailureSplitRetryCount(options);
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const ledger = resolveLlmBatchLedger(options, 'relation-extraction');
  const completedLedgerBatches = await loadCompletedLlmBatchResults(ledger);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let completedAfterBatch = Math.max(...batch.map((entry) => entry.__batchIndex)) + 1;
    let stopAfterCurrentBatch = false;
    const prompt = buildResearchSemanticsBatchPrompt(batch);
    const promptChars = String(prompt).length;
    const batchId = llmBatchId(ledger, batch, prompt);
    const cachedBatch = completedLedgerBatches.get(batchId);

    if (copyCachedLlmBatchResults(results, batch, cachedBatch)) {
      options.onBatchComplete?.({
        phase: 'relation-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs: 0,
        cached: true,
        skipped: true
      });
      continue;
    }

    const batchStartedAt = Date.now();
    await appendLlmBatchLedger(ledger, 'llm-batches.jsonl', {
      status: 'running',
      batchId,
      batchNumber: batchIndex + 1,
      totalBatches,
      batchSize: batch.length,
      promptChars,
      promptMaxChars,
      entryIds: batch.map((entry) => entry.id)
    });

    try {
      const payload = await requestLlmGenerate(config, prompt);
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || config.provider;
      const topLevelSchemaError = raw?.papers !== undefined && !Array.isArray(raw.papers)
        ? 'Expected "papers" to be an array.'
        : raw?.errors !== undefined && !Array.isArray(raw.errors)
          ? 'Expected "errors" to be an array.'
          : null;
      if (topLevelSchemaError) {
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'schema-validation-failed',
            error: topLevelSchemaError
          };
        }
        continue;
      }
      const paperErrors = new Map(
        (Array.isArray(raw?.errors) ? raw.errors : [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), String(entry.error || 'request-failed')])
      );
      const paperResults = new Map(
        (Array.isArray(raw?.papers) ? raw.papers : [])
          .filter((entry) => entry?.id)
          .map((entry) => [String(entry.id), entry])
      );

      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rawPaper = paperResults.get(batchEntry.id);
        const rawError = paperErrors.get(batchEntry.id) || (rawPaper?.error ? String(rawPaper.error) : '');
        if (rawError) {
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: classifyLlmInferenceFailureReason({ error: rawError }),
            error: rawError
          };
          continue;
        }

        if (!rawPaper) {
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing batch relation result for ${batchEntry.id}`
          };
          continue;
        }

        const normalizedRawPaper = normalizeRelationPaperOutputShape(rawPaper);
        const schemaError = validateRelationPaperSchema(normalizedRawPaper);
        if (schemaError) {
          results[batchEntry.__batchIndex] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'schema-validation-failed',
            error: schemaError
          };
          continue;
        }

        results[batchEntry.__batchIndex] = {
          provider: resultProvider,
          benchmarks: (normalizedRawPaper.benchmarks || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.BENCHMARK))
            .filter(Boolean),
          findings: (normalizedRawPaper.findings || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.FINDING))
            .filter(Boolean),
          researchGoals: (normalizedRawPaper.researchGoals || [])
            .map((record) => sanitizeEntityRecord(record, NODE_TYPES.RESEARCH_GOAL))
            .filter(Boolean),
          relations: (normalizedRawPaper.relations || [])
            .map(sanitizeRelationRecord)
            .filter(Boolean),
          error: null
        };
      }

      if (shouldRetryBatchResultsBySplitting(results, batch, splitRetryCount)) {
        const retryableResult = findSplitRetryableBatchResult(results, batch);
        options.onBatchRetry?.({
          phase: 'relation-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: describeRetryableBatchResult(retryableResult)
        });
        const retryResults = await inferPaperResearchSemanticsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing split-retry relation result for ${batchEntry.id}`
          };
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = {
              provider: rateLimitedResult.provider || config.provider,
              benchmarks: [],
              findings: [],
              researchGoals: [],
              relations: [],
              reason: 'rate-limited',
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              error: null
            };
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } catch (error) {
      let recoveredBySplitRetry = false;
      if (shouldRetryBatchBySplitting(error, batch, splitRetryCount)) {
        options.onBatchRetry?.({
          phase: 'relation-extraction',
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          retryBatchCount: splitBatchForRetry(batch).length,
          retryBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          remainingRetries: splitRetryCount,
          promptChars,
          promptMaxChars,
          error: error.message
        });
        const retryResults = await inferPaperResearchSemanticsBatch(batch, {
          ...options,
          llmBatchSize: Math.max(1, Math.ceil(batch.length / 2)),
          llmBatchFailureSplitRetryCount: splitRetryCount - 1,
          onBatchComplete: undefined
        });
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = retryResults[offset] || {
            provider: config.provider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: 'missing-result',
            error: `Missing split-retry relation result for ${batchEntry.id}`
          };
        }

        const rateLimitedResult = retryResults.find((result) => result?.rateLimitCooldownUntil || result?.reason === 'rate-limited');
        if (rateLimitedResult) {
          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = {
              provider: rateLimitedResult.provider || config.provider,
              benchmarks: [],
              findings: [],
              researchGoals: [],
              relations: [],
              reason: 'rate-limited',
              rateLimitCooldownUntil: rateLimitedResult.rateLimitCooldownUntil || null,
              error: null
            };
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
        recoveredBySplitRetry = true;
      }

      if (!recoveredBySplitRetry) {
        const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
        for (let offset = 0; offset < batch.length; offset += 1) {
          const batchEntry = batch[offset];
          results[batchEntry.__batchIndex] = {
            provider: failedProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            reason: classifyLlmRequestErrorReason(error),
            error: error.message
          };
        }

        if (isLlmRateLimitError(error)) {
          for (let offset = 0; offset < batch.length; offset += 1) {
            const batchEntry = batch[offset];
            results[batchEntry.__batchIndex] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
          }

          for (let index = completedAfterBatch; index < entries.length; index += 1) {
            results[index] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
          }
          completedAfterBatch = entries.length;
          stopAfterCurrentBatch = true;
        }
      }
    } finally {
      const batchResults = collectLlmBatchResults(results, batch);
      const failedResults = batchResults.filter((result) => (
        result?.reason === 'request-failed'
        || result?.reason === 'rate-limited'
        || result?.error
      ));
      const durationMs = Date.now() - batchStartedAt;
      const status = failedResults.length ? 'completed_with_failures' : 'completed';
      const failureReasons = summarizeLlmInferenceFailureReasons(failedResults);
      await appendLlmBatchLedger(ledger, 'llm-results.jsonl', {
        status,
        batchId,
        batchNumber: batchIndex + 1,
        totalBatches,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        entryIds: batch.map((entry) => entry.id),
        results: batchResults
      });
      if (failedResults.length) {
        await appendLlmBatchLedger(ledger, 'llm-failures.jsonl', {
          status: 'failed',
          batchId,
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          promptChars,
          promptMaxChars,
          durationMs,
          entryIds: batch.map((entry) => entry.id),
          failedCount: failedResults.length,
          failureReasons,
          errors: failedResults.map((result) => result?.error || result?.reason || 'request-failed').slice(0, 20)
        });
      }
      options.onBatchComplete?.({
        phase: 'relation-extraction',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        durationMs,
        failureCount: failedResults.length,
        failureReasons,
        rateLimitCooldownUntil: batchResults.find((result) => result?.rateLimitCooldownUntil)?.rateLimitCooldownUntil || null
      });
    }

    if (stopAfterCurrentBatch) {
      break;
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

  const batchSize = resolveEffectiveLlmBatchSize(config);
  const normalizedEntries = entries.map((entry, index) => ({
    ...entry,
    id: String(entry?.id || `node-${index + 1}`),
    __batchIndex: index
  }));
  const batches = partitionEntriesByPromptBudget(
    normalizedEntries,
    buildNodeCheckBatchPrompt,
    options,
    batchSize
  );
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, batches.length);
  const promptMaxChars = resolveBatchPromptMaxChars(options);
  const ledger = resolveLlmBatchLedger(options, 'node-check');
  const completedLedgerBatches = await loadCompletedLlmBatchResults(ledger);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let completedAfterBatch = Math.max(...batch.map((entry) => entry.__batchIndex)) + 1;
    let stopAfterCurrentBatch = false;
    const prompt = buildNodeCheckBatchPrompt(batch);
    const promptChars = String(prompt).length;
    const batchId = llmBatchId(ledger, batch, prompt);
    const cachedBatch = completedLedgerBatches.get(batchId);

    if (copyCachedLlmBatchResults(results, batch, cachedBatch)) {
      options.onBatchComplete?.({
        phase: 'node-check',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        skipped: true
      });
      continue;
    }

    await appendLlmBatchLedger(ledger, 'llm-batches.jsonl', {
      status: 'running',
      batchId,
      batchNumber: batchIndex + 1,
      totalBatches,
      batchSize: batch.length,
      promptChars,
      promptMaxChars,
      entryIds: batch.map((entry) => entry.id)
    });

    try {
      const payload = await requestLlmGenerate(config, prompt);
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || config.provider;
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
          results[batchEntry.__batchIndex] = {
            id: batchEntry.id,
            verdict: 'keep',
            canonicalName: batchEntry.name,
            confidence: 0,
            reason: classifyLlmInferenceFailureReason({ error: rawError }),
            provider: resultProvider,
            attempted: true,
            participated: false,
            error: rawError
          };
          continue;
        }

        if (!rawNode) {
          results[batchEntry.__batchIndex] = {
            id: batchEntry.id,
            verdict: 'keep',
            canonicalName: batchEntry.name,
            confidence: 0,
            reason: 'missing-result',
            provider: resultProvider,
            attempted: true,
            participated: false,
            error: `Missing node check result for ${batchEntry.id}`
          };
          continue;
        }

        results[batchEntry.__batchIndex] = {
          ...rawNode,
          provider: resultProvider,
          attempted: true,
          participated: true,
          error: null
        };
      }
    } catch (error) {
      const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        const rateLimited = isLlmRateLimitError(error);
        results[batchEntry.__batchIndex] = {
          id: batchEntry.id,
          verdict: 'keep',
          canonicalName: batchEntry.name,
          confidence: 0,
          reason: rateLimited ? 'rate-limited' : classifyLlmRequestErrorReason(error),
          provider: failedProvider,
          attempted: true,
          participated: false,
          rateLimitCooldownUntil: rateLimited ? getRateLimitCooldownUntil(error) : null,
          error: rateLimited ? null : error.message
        };
      }

      if (isLlmRateLimitError(error)) {
        for (let index = completedAfterBatch; index < entries.length; index += 1) {
          const futureEntry = normalizedEntries[index];
          results[index] = {
            id: futureEntry.id,
            verdict: 'keep',
            canonicalName: futureEntry.name,
            confidence: 0,
            reason: 'rate-limited',
            provider: failedProvider,
            attempted: true,
            participated: false,
            rateLimitCooldownUntil: getRateLimitCooldownUntil(error),
            error: null
          };
        }
        completedAfterBatch = entries.length;
        stopAfterCurrentBatch = true;
      }
    } finally {
      const batchResults = collectLlmBatchResults(results, batch);
      const failedResults = batchResults.filter((result) => (
        result?.reason === 'request-failed'
        || result?.reason === 'rate-limited'
        || result?.error
      ));
      const status = failedResults.length ? 'completed_with_failures' : 'completed';
      await appendLlmBatchLedger(ledger, 'llm-results.jsonl', {
        status,
        batchId,
        batchNumber: batchIndex + 1,
        totalBatches,
        batchSize: batch.length,
        promptChars,
        promptMaxChars,
        entryIds: batch.map((entry) => entry.id),
        results: batchResults
      });
      if (failedResults.length) {
        await appendLlmBatchLedger(ledger, 'llm-failures.jsonl', {
          status: 'failed',
          batchId,
          batchNumber: batchIndex + 1,
          totalBatches,
          batchSize: batch.length,
          promptChars,
          promptMaxChars,
          entryIds: batch.map((entry) => entry.id),
          failedCount: failedResults.length,
          errors: failedResults.map((result) => result?.error || result?.reason || 'request-failed').slice(0, 20)
        });
      }
      options.onBatchComplete?.({
        phase: 'node-check',
        batchNumber: batchIndex + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length,
        promptChars,
        promptMaxChars
      });
    }

    if (stopAfterCurrentBatch) {
      break;
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
  const batchSize = resolveEffectiveLlmBatchSize(config);
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
