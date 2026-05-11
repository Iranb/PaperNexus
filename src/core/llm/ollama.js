import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_BATCH_SIZE = 8;
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

  const defaultBaseUrl = getDefaultLlmBaseUrl(provider);
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
    batchSize: Number(pickDefined(
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
  const apiKey = config.apiKey || await loadLlmApiKey(config);
  if (apiKey && !config.apiKey) {
    config.apiKey = apiKey;
  }

  if (!apiKey) {
    throw new Error(
      `Missing API key for the OpenAI-compatible provider. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')}, llm.apiKey, or run \`papernexus auth llm set\`.`
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
    max_completion_tokens: config.maxTokens,
    temperature: 0.1
  };

  if (shouldDisableThinkingForJsonMode(config)) {
    requestBody.enable_thinking = false;
  }

  const response = await fetchLlmJsonWithRetry(
    'OpenAI',
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

  return {
    text: extractOpenAiText(response)
  };
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
  if (config.provider === 'openai') {
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
    let completedAfterBatch = Math.min(start + batchSize, entries.length);
    let stopAfterCurrentBatch = false;
    const batch = entries.slice(start, start + batchSize).map((entry, index) => ({
      ...entry,
      id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${start + index + 1}`)
    }));

    try {
      const payload = await requestLlmGenerate(plan.config, buildSemanticExtractionBatchPrompt(batch));
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || plan.config.provider;
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
            provider: resultProvider,
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
            provider: resultProvider,
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
          provider: resultProvider,
          requestedMode: plan.requestedMode,
          effectiveMode: plan.effectiveMode,
          attempted: true,
          participated: true,
          reason: null,
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
    } catch (error) {
      const failedProvider = error.fallbackFromRateLimit && plan.config.fallback?.provider
        ? plan.config.fallback.provider
        : plan.config.provider;
      for (let offset = 0; offset < batch.length; offset += 1) {
        results[start + offset] = createSemanticObjectInferenceResult({
          provider: failedProvider,
          requestedMode: plan.requestedMode,
          effectiveMode: 'heuristic-only',
          attempted: true,
          participated: false,
          reason: 'request-failed',
          error: error.message
        });
      }

      if (isLlmRateLimitError(error)) {
        for (let offset = 0; offset < batch.length; offset += 1) {
          results[start + offset] = createRateLimitedSemanticObjectInferenceResult({
            provider: failedProvider,
            requestedMode: plan.requestedMode,
            error
          });
        }

        for (let index = start + batch.length; index < entries.length; index += 1) {
          results[index] = createRateLimitedSemanticObjectInferenceResult({
            provider: failedProvider,
            requestedMode: plan.requestedMode,
            error
          });
        }
        completedAfterBatch = entries.length;
        stopAfterCurrentBatch = true;
      }
    } finally {
      options.onBatchComplete?.({
        phase: 'semantic-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length
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

  const batchSize = Math.max(1, Number(plan.config?.batchSize || DEFAULT_BATCH_SIZE));
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, Math.ceil(entries.length / batchSize));

  for (let start = 0; start < entries.length; start += batchSize) {
    let completedAfterBatch = Math.min(start + batchSize, entries.length);
    let stopAfterCurrentBatch = false;
    const batch = entries.slice(start, start + batchSize).map((entry, index) => normalizeChunkBatchEntry(entry, start + index));

    try {
      const payload = await requestLlmGenerate(plan.config, buildChunkSemanticExtractionBatchPrompt(batch));
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
          results[start + offset] = createChunkSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'request-failed',
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
          results[start + offset] = createChunkSemanticObjectInferenceResult({
            provider: resultProvider,
            requestedMode: plan.requestedMode,
            effectiveMode: 'heuristic-only',
            attempted: true,
            participated: false,
            reason: 'request-failed',
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

        results[start + offset] = sanitizeChunkSemanticRaw(rawPaper, batchEntry, resultProvider, plan);
      }
    } catch (error) {
      const failedProvider = error.fallbackFromRateLimit && plan.config.fallback?.provider
        ? plan.config.fallback.provider
        : plan.config.provider;
      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        results[start + offset] = createChunkSemanticObjectInferenceResult({
          provider: failedProvider,
          requestedMode: plan.requestedMode,
          effectiveMode: 'heuristic-only',
          attempted: true,
          participated: false,
          reason: 'request-failed',
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
          results[start + offset] = createChunkSemanticObjectInferenceResult({
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

        for (let index = start + batch.length; index < entries.length; index += 1) {
          const batchEntry = normalizeChunkBatchEntry(entries[index], index);
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
    } finally {
      options.onBatchComplete?.({
        phase: 'chunk-semantic-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length
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

  const batchSize = Math.max(1, Number(config.batchSize || DEFAULT_BATCH_SIZE));
  const results = new Array(entries.length);
  const totalBatches = Math.max(1, Math.ceil(entries.length / batchSize));

  for (let start = 0; start < entries.length; start += batchSize) {
    let completedAfterBatch = Math.min(start + batchSize, entries.length);
    let stopAfterCurrentBatch = false;
    const batch = entries.slice(start, start + batchSize).map((entry, index) => normalizeChunkBatchEntry(entry, start + index));

    try {
      const payload = await requestLlmGenerate(config, buildChunkResearchSemanticsBatchPrompt(batch));
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
          results[start + offset] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
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
          results[start + offset] = {
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
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

        results[start + offset] = sanitizeChunkRelationRaw(rawPaper, batchEntry, resultProvider, {
          signature: createCrossPaperJudgmentConfigSignature(options)
        });
      }
    } catch (error) {
      const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
      for (let offset = 0; offset < batch.length; offset += 1) {
        const batchEntry = batch[offset];
        results[start + offset] = {
          provider: failedProvider,
          benchmarks: [],
          findings: [],
          researchGoals: [],
          relations: [],
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
          results[start + offset] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
          results[start + offset].chunkId = batchEntry.chunkId;
          results[start + offset].paperId = batchEntry.paperId;
          results[start + offset].sourceKey = batchEntry.sourceKey;
          results[start + offset].sectionHeading = batchEntry.sectionHeading;
          results[start + offset].sectionRole = batchEntry.sectionRole;
          results[start + offset].chunkOrder = batchEntry.chunkOrder;
          results[start + offset].textHash = batchEntry.textHash;
        }

        for (let index = start + batch.length; index < entries.length; index += 1) {
          const batchEntry = normalizeChunkBatchEntry(entries[index], index);
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
    } finally {
      options.onBatchComplete?.({
        phase: 'chunk-relation-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length
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
    let completedAfterBatch = Math.min(start + batchSize, entries.length);
    let stopAfterCurrentBatch = false;
    const batch = entries.slice(start, start + batchSize).map((entry, index) => ({
      ...entry,
      id: String(entry?.id || entry?.parsedPaper?.paperId || entry?.semanticPaper?.paperId || `paper-${start + index + 1}`)
    }));

    try {
      const payload = await requestLlmGenerate(config, buildResearchSemanticsBatchPrompt(batch));
      const raw = parseJsonText(payload.text);
      const resultProvider = payload.provider || config.provider;
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
            provider: resultProvider,
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
            provider: resultProvider,
            benchmarks: [],
            findings: [],
            researchGoals: [],
            relations: [],
            error: `Missing batch relation result for ${batchEntry.id}`
          };
          continue;
        }

        results[start + offset] = {
          provider: resultProvider,
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
      const failedProvider = error.fallbackFromRateLimit && config.fallback?.provider ? config.fallback.provider : config.provider;
      for (let offset = 0; offset < batch.length; offset += 1) {
        results[start + offset] = {
          provider: failedProvider,
          benchmarks: [],
          findings: [],
          researchGoals: [],
          relations: [],
          error: error.message
        };
      }

      if (isLlmRateLimitError(error)) {
        for (let offset = 0; offset < batch.length; offset += 1) {
          results[start + offset] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
        }

        for (let index = start + batch.length; index < entries.length; index += 1) {
          results[index] = createRateLimitedResearchSemanticsResult({ ...config, provider: failedProvider }, error);
        }
        completedAfterBatch = entries.length;
        stopAfterCurrentBatch = true;
      }
    } finally {
      options.onBatchComplete?.({
        phase: 'relation-extraction',
        batchNumber: Math.floor(start / batchSize) + 1,
        totalBatches,
        completed: completedAfterBatch,
        total: entries.length,
        batchSize: batch.length
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
          results[start + offset] = {
            id: batchEntry.id,
            verdict: 'keep',
            canonicalName: batchEntry.name,
            confidence: 0,
            reason: 'request-failed',
            provider: resultProvider,
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
            provider: resultProvider,
            attempted: true,
            participated: false,
            error: `Missing node check result for ${batchEntry.id}`
          };
          continue;
        }

        results[start + offset] = {
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
        results[start + offset] = {
          id: batchEntry.id,
          verdict: 'keep',
          canonicalName: batchEntry.name,
          confidence: 0,
          reason: rateLimited ? 'rate-limited' : 'request-failed',
          provider: failedProvider,
          attempted: true,
          participated: false,
          rateLimitCooldownUntil: rateLimited ? getRateLimitCooldownUntil(error) : null,
          error: rateLimited ? null : error.message
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
