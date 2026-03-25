import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createKnowledgeGraph } from '../graph/graph.js';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from '../graph/schema.js';
import {
  adjudicateCrossPaperCandidates,
  inferPaperResearchSemantics,
  inferPaperSemanticObjects,
  normalizeSemanticExtractionMode,
  resolveSemanticExtractionPlan,
  resolveOllamaConfig
} from '../llm/ollama.js';
import { collectFiles, fileExists, readText, withFileLock } from '../../lib/fs.js';
import { jaccardSimilarity, normalizeText, slugify, stableHash, titleCase, tokenizeWithoutStopwords, truncate, unique } from '../../lib/utils.js';
import { createWatchTmpLogger } from '../../lib/watch-log.js';
import {
  getCorpusLockPath,
  getCorpusPaths,
  getSemanticPaperSnapshotPath,
  hasCorpusGraphStore,
  loadCorpus,
  loadSourceManifest,
  loadSemanticPaperSnapshot,
  resolveGraphStorageMode,
  removeSemanticPaperSnapshot,
  saveCorpus,
  saveSemanticPaperSnapshot,
  saveSourceManifest
} from '../../storage/corpus-store.js';
import { enqueuePaperEnhancements, pruneEnhancementsForManifest } from '../../storage/enhancement-store.js';
import { registerCorpus } from '../../storage/registry.js';
import { convertPdfToMarkdown, normalizePdfParser } from './marker.js';
import { extractConceptCandidates, parsePaperMarkdown } from './markdown.js';
import { precomputePaperGraphFragments } from './graph-precompute.js';
import { precomputeGraphPostprocess } from './graph-postprocess.js';

const GENERIC_TERMS = new Set([
  'paper', 'study', 'approach', 'method', 'methods', 'framework', 'system', 'model', 'models',
  'analysis', 'results', 'result', 'discussion', 'conclusion', 'background', 'abstract',
  'introduction', 'problem', 'problems', 'task', 'tasks', 'research', 'evaluation',
  'experiment', 'experiments', 'dataset', 'datasets', 'metric', 'metrics', 'benchmark',
  'benchmarks', 'workflow', 'performance', 'future work', 'future direction', 'finding', 'findings'
]);

const LOW_SIGNAL_SINGLE_TOKENS = new Set([
  'energy', 'knowledge', 'learning', 'monitoring', 'pressure', 'process', 'processes',
  'product', 'products', 'scale', 'speech', 'system', 'systems', 'task', 'tasks',
  'view', 'views', 'world'
]);

const TITLE_FRAGMENT_SUFFIXES = new Set([
  'view', 'views', 'framework', 'frameworks', 'approach', 'approaches', 'system', 'systems',
  'model', 'models', 'study', 'studies', 'analysis'
]);

const BRAINSTORM_ELIGIBLE_TYPES = new Set([
  NODE_TYPES.PROBLEM,
  NODE_TYPES.METHOD,
  NODE_TYPES.CLAIM,
  NODE_TYPES.FINDING,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION,
  NODE_TYPES.FUTURE_DIRECTION,
  NODE_TYPES.RESEARCH_GOAL,
  NODE_TYPES.DATASET,
  NODE_TYPES.BENCHMARK
]);

const BRAINSTORM_SCORE_THRESHOLDS = {
  [NODE_TYPES.PROBLEM]: 0.68,
  [NODE_TYPES.METHOD]: 0.68,
  [NODE_TYPES.CLAIM]: 0.76,
  [NODE_TYPES.FINDING]: 0.74,
  [NODE_TYPES.LIMITATION]: 0.64,
  [NODE_TYPES.ASSUMPTION]: 0.64,
  [NODE_TYPES.FUTURE_DIRECTION]: 0.66,
  [NODE_TYPES.RESEARCH_GOAL]: 0.66,
  [NODE_TYPES.DATASET]: 0.8,
  [NODE_TYPES.BENCHMARK]: 0.8
};

const PROBLEM_SENTENCE_PATTERNS = [
  /\b(?:we|this paper|this work)\s+(?:study|address(?:es)?|tackle(?:s|d)?|focus(?:es)? on|investigate(?:s|d)?)\s+(.+?)(?:\.|,|;| while | by | with )/i,
  /\b(?:challenge|problem|task)\s+(?:of|in)\s+(.+?)(?:\.|,|;)/i,
  /\bexisting methods?\s+(?:fail|struggle)\s+to\s+(.+?)(?:\.|,|;)/i
];

const METHOD_SENTENCE_PATTERNS = [
  /\b(?:we|this paper|this work)\s+(?:propose|present|introduce|develop)\s+(.+?)(?:\.|,|;| that | which )/i,
  /\bour\s+(?:approach|method|framework|system)\s+(?:builds|uses|combines|relies on|consists of|links)\s+(.+?)(?:\.|,|;| to | for )/i,
  /\bthe key idea is\s+(.+?)(?:\.|,|;)/i
];

const CLAIM_PATTERNS = /\b(show|demonstrate|find|improve|outperform|enable|reveal|indicate|suggest|achieve|support|reduce|increase|expose|trace)\b/i;
const LIMITATION_PATTERNS = /\b(limit(?:ation)?s?|however|but|fails?|failure|challenge|costly|expensive|sensitive|degrad(?:e|es|ed)|drop|cannot|unable|lack|missing|only|not evaluate|future work)\b/i;
const ASSUMPTION_PATTERNS = /\b(assume|assumption|given access to|under the setting|requires?|relies on|depends on|available knowledge|high[- ]quality labels?)\b/i;
const FUTURE_PATTERNS = /\b(future work|future research|we plan to|could be extended|can be extended|explore|investigate|extend to|remains to)\b/i;
const EVIDENCE_PATTERNS = /\b(result|results|benchmark|baseline|ablation|outperform|improve|improved|gain|gains|degrade|drop|score|accuracy|f1|bleu|auc|latency|throughput)\b/i;
const FINDING_PATTERNS = /\b(we find|we found|our findings|finding|observ(?:e|ed)|reveal|shows? that|results show|analysis shows)\b/i;
const RESEARCH_GOAL_PATTERNS = /\b(our goal|aim to|goal is to|objective|we aim|this paper aims|our mission|we seek to|we strive to|our purpose|intends to|designed to)\b/i;

const BENCHMARK_PATTERNS = [
  /\bon\s+the\s+([A-Z][A-Za-z0-9-]+(?:[- ][A-Z0-9][A-Za-z0-9-]+){0,5}\s+benchmark)\b/g,
  /\b([A-Z][A-Za-z0-9-]+(?:[- ][A-Z0-9][A-Za-z0-9-]+){0,5}\s+benchmark)\b/g,
  /\bbenchmark(?:s)?\s+(?:such as|including)\s+([A-Z][A-Za-z0-9-]+(?:,\s*[A-Z][A-Za-z0-9-]+)*)\b/g
];

const METHOD_HINT_TERMS = [
  'framework', 'system', 'model', 'pipeline', 'architecture', 'network', 'generation',
  'retrieval', 'learning', 'attention', 'adapter', 'augmentation', 'reasoning',
  'distillation', 'workflow'
];

const PROBLEM_HINT_TERMS = [
  'planning', 'prediction', 'detection', 'classification', 'discovery', 'alignment',
  'reasoning', 'mapping', 'retrieval', 'generalization', 'synthesis', 'ranking',
  'generation', 'qa', 'question answering', 'monitoring', 'localization', 'forecasting'
];

const POSITIVE_CLAIM_TERMS = /\b(improve|improved|outperform|better|gain|achieve|support|enable|transparent|easier)\b/i;
const NEGATIVE_CLAIM_TERMS = /\b(degrade|degraded|worse|fail|fails|drop|limited|sensitive|cannot|unable)\b/i;

const METRIC_PATTERNS = [
  { label: 'Accuracy', regex: /\baccuracy\b/i, higherIsBetter: true },
  { label: 'Precision', regex: /\bprecision\b/i, higherIsBetter: true },
  { label: 'Recall', regex: /\brecall\b/i, higherIsBetter: true },
  { label: 'F1 Score', regex: /\bf1(?:[-\s]?score)?\b/i, higherIsBetter: true },
  { label: 'AUC', regex: /\b(?:roc[-\s]?auc|auc)\b/i, higherIsBetter: true },
  { label: 'BLEU', regex: /\bbleu\b/i, higherIsBetter: true },
  { label: 'ROUGE', regex: /\brouge\b/i, higherIsBetter: true },
  { label: 'Perplexity', regex: /\bperplexity\b/i, higherIsBetter: false },
  { label: 'Loss', regex: /\bloss\b/i, higherIsBetter: false },
  { label: 'MAE', regex: /\bmae\b/i, higherIsBetter: false },
  { label: 'RMSE', regex: /\brmse\b/i, higherIsBetter: false },
  { label: 'MRR', regex: /\bmrr\b/i, higherIsBetter: true },
  { label: 'NDCG', regex: /\bndcg\b/i, higherIsBetter: true },
  { label: 'Latency', regex: /\blatency\b/i, higherIsBetter: false },
  { label: 'Throughput', regex: /\bthroughput\b/i, higherIsBetter: true }
];

const LIMITATION_THEMES = [
  { name: 'label-efficiency', regex: /\b(label|labels|annotation|annotated|supervised|manual)\b/i },
  { name: 'efficiency', regex: /\b(cost|costly|expensive|latency|slow|memory|compute|throughput)\b/i },
  { name: 'robustness', regex: /\b(noise|noisy|robust|sensitive|corruption|shift)\b/i },
  { name: 'generalization', regex: /\b(domain|cross-domain|generaliz|transfer|out-of-domain)\b/i },
  { name: 'evidence', regex: /\b(audit|evidence|trace|provenance|interpret)\b/i },
  { name: 'structure', regex: /\b(structure|graph|context|long context|section|hierarchy)\b/i }
];

const METHOD_THEMES = [
  { name: 'label-efficiency', regex: /\b(few-shot|low-resource|semi-supervised|self-supervised|weak supervision|synthetic|active learning)\b/i },
  { name: 'efficiency', regex: /\b(efficient|adapter|lora|distill|sparse|compression|cache)\b/i },
  { name: 'robustness', regex: /\b(robust|augmentation|regularization|contrastive|noise)\b/i },
  { name: 'generalization', regex: /\b(transfer|domain adaptation|multi-domain|cross-domain|meta-learning)\b/i },
  { name: 'evidence', regex: /\b(retrieval|evidence|citation|audit|trace)\b/i },
  { name: 'structure', regex: /\b(graph|hierarchy|planning|structure|long context)\b/i }
];

const MANIFEST_VERSION = 4;
const WATCHABLE_EXTENSIONS = new Set(['.pdf', '.md', '.markdown']);

function createProgressBar(total, options = {}) {
  const { quiet = false, prefix = 'Progress' } = options;
  let current = 0;
  let startTime = Date.now();
  let lastDrawTime = 0;
  const minDrawInterval = 100;

  const formatTime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m${secs}s`;
  };

  const draw = () => {
    if (quiet || !process.stdout.isTTY) return;

    const now = Date.now();
    if (now - lastDrawTime < minDrawInterval && current < total) return;
    lastDrawTime = now;

    const percent = Math.floor((current / total) * 100);
    const width = 30;
    const filled = Math.floor((percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

    const elapsed = now - startTime;
    const rate = current > 0 ? elapsed / current : 0;
    const remaining = (total - current) * rate;
    const eta = current >= total ? '0s' : formatTime(remaining);

    const elapsedStr = formatTime(elapsed);

    process.stdout.write(`\r${prefix}: [${bar}] ${current}/${total} (${percent}%) - ETA: ${eta} - Elapsed: ${elapsedStr}   `);
  };

  return {
    tick(label = '') {
      current += 1;
      draw();
    },
    update(completed, label = '') {
      current = completed;
      draw();
    },
    done() {
      current = total;
      draw();
      if (quiet || !process.stdout.isTTY) return;
      const elapsed = formatTime(Date.now() - startTime);
      process.stdout.write(`\r${prefix}: [${'█'.repeat(30)}] ${total}/${total} (100%) - Done in ${elapsed}   \n`);
    },
    stop() {
      if (!quiet && process.stdout.isTTY) {
        process.stdout.write('\n');
      }
    }
  };
}

function createQuietProgress() {
  return {
    tick() {},
    update() {},
    done() {},
    stop() {}
  };
}

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
}

function summarizeText(text, maxSentences = 2) {
  return splitSentences(text).slice(0, maxSentences).join(' ') || String(text || '').trim();
}

function cleanSemanticName(text, fallback, maxLength = 140) {
  let normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9\u4e00-\u9fff]+/, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .trim();

  // 过滤图表/坐标轴噪声
  if (/^[\d\s\.\-\[\]]+$/.test(normalized) || /^[\[\]A-Z'\s]+\?/.test(normalized)) {
    return fallback;
  }

  // 过滤纯数字序列
  if (/^[\d\.\-\s]+$/.test(normalized)) {
    return fallback;
  }

  // 过滤乱码/OCR 噪声
  if (/[^A-Za-z0-9\u4e00-\u9fff\s]{5,}/.test(normalized)) {
    normalized = normalized.replace(/[^A-Za-z0-9\u4e00-\u9fff\s]+/g, ' ').trim();
  }

  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function buildEvidenceProperties(record, paper, overrides = {}) {
  return {
    sourcePaperId: paper.paperId,
    sourcePaperTitle: paper.paperTitle,
    evidenceText: record.evidenceText || record.text || record.name || '',
    section: record.sectionHeading || record.section || '',
    sectionRole: record.sectionRole || record.role || '',
    confidence: record.confidence ?? 0.65,
    explicitOrInferred: record.explicitOrInferred || 'explicit',
    ...overrides
  };
}

function isGenericCandidate(text) {
  const normalized = normalizeText(text);
  return !normalized || GENERIC_TERMS.has(normalized) || normalized.length < 4;
}

function looksLikeDataset(text) {
  return /\b(dataset|corpus|benchmark|benchmarks)\b/i.test(text);
}

function looksLikeMetric(text) {
  return METRIC_PATTERNS.some((metric) => metric.regex.test(text));
}

function isMethodLike(text) {
  const normalized = normalizeText(text);
  const tokenCount = normalized.split(' ').filter(Boolean).length;
  const hasMethodCue = METHOD_HINT_TERMS.some((term) => normalized.includes(term));
  return hasMethodCue && (tokenCount >= 2 || normalized.includes('-'));
}

function isProblemLike(text) {
  const normalized = normalizeText(text);
  return PROBLEM_HINT_TERMS.some((term) => normalized.includes(term));
}

function createSlot(name, options = {}) {
  const cleaned = cleanSemanticName(name, options.fallback || name);
  return {
    name: cleaned,
    normalized: normalizeText(cleaned),
    text: options.text || cleaned,
    evidenceText: options.evidenceText || options.text || cleaned,
    sectionHeading: options.sectionHeading || '',
    sectionRole: options.sectionRole || '',
    confidence: options.confidence ?? 0.6,
    explicitOrInferred: options.explicitOrInferred || 'explicit',
    ...options.extra
  };
}

function countMeaningfulTokens(text) {
  return tokenizeWithoutStopwords(text).length;
}

function looksLikeCitationFragment(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\b(19|20)\d{2}\b/.test(normalized)
    || /^[a-z]+(?:\s+[a-z]+){0,2}\s+\d{4}(?:\s+[a-z]+)?$/.test(normalized);
}

function isLowSignalSingleToken(text) {
  const normalized = normalizeText(text);
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length === 1 && (GENERIC_TERMS.has(normalized) || LOW_SIGNAL_SINGLE_TOKENS.has(normalized));
}

function looksLikeTitleFragment(text) {
  const normalized = normalizeText(text);
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  return TITLE_FRAGMENT_SUFFIXES.has(tokens[tokens.length - 1]);
}

function isSentenceLikeRecord(type) {
  return type === NODE_TYPES.CLAIM
    || type === NODE_TYPES.FINDING
    || type === NODE_TYPES.LIMITATION
    || type === NODE_TYPES.ASSUMPTION
    || type === NODE_TYPES.EVIDENCE
    || type === NODE_TYPES.FUTURE_DIRECTION
    || type === NODE_TYPES.RESEARCH_GOAL;
}

function baseAdmissionThreshold(type) {
  return BRAINSTORM_SCORE_THRESHOLDS[type] || 0.72;
}

function scoreSemanticAdmission(type, record) {
  const name = record?.name || record?.text || '';
  const normalized = normalizeText(name);
  const tokenCount = countMeaningfulTokens(name);
  const textLength = String(record?.text || name || '').trim().length;
  const sectionRole = String(record?.sectionRole || '').trim().toLowerCase();
  let score = Number(record?.confidence || 0.55);

  if (record?.explicitOrInferred === 'explicit') score += 0.04;
  if (sectionRole === 'title') score += 0.08;
  if (sectionRole === 'abstract') score += 0.06;
  if (sectionRole === 'results' || sectionRole === 'analysis' || sectionRole === 'discussion') score += 0.04;
  if (sectionRole === 'inferred') score -= 0.08;
  if (tokenCount >= 3) score += 0.08;
  else if (tokenCount === 2) score += 0.03;
  if (textLength >= 48 && isSentenceLikeRecord(type)) score += 0.06;
  if (record?.linkedDatasets?.length || record?.linkedBenchmarks?.length || record?.linkedMetrics?.length) score += 0.04;
  if (type === NODE_TYPES.PROBLEM && isProblemLike(normalized)) score += 0.08;
  if (type === NODE_TYPES.METHOD && isMethodLike(normalized)) score += 0.08;
  if (looksLikeTitleFragment(name)) score -= 0.12;
  if (looksLikeCitationFragment(name)) score -= 0.35;
  if (isLowSignalSingleToken(name)) score -= 0.3;

  return Number(Math.max(0, Math.min(0.99, score)).toFixed(3));
}

function addAdmissionMetadata(record, type) {
  const score = scoreSemanticAdmission(type, record);
  const eligible = BRAINSTORM_ELIGIBLE_TYPES.has(type) && score >= baseAdmissionThreshold(type);
  const tier = score >= 0.86 ? 'high' : score >= 0.72 ? 'medium' : 'low';
  return {
    ...record,
    brainstormEligible: eligible,
    brainstormScore: score,
    brainstormTier: tier,
    admissionSource: 'semantic-admission-v1',
    admissionReason: eligible ? 'accepted' : 'kept-but-not-brainstorm-core'
  };
}

function shouldRejectSemanticRecord(record, type) {
  const name = cleanSemanticName(record?.name || record?.text || '', '');
  const normalized = normalizeText(name);
  const tokenCount = countMeaningfulTokens(name);
  const sectionRole = String(record?.sectionRole || '').trim().toLowerCase();

  if (!name || !normalized) return true;
  if (looksLikeCitationFragment(name)) return true;
  if (isLowSignalSingleToken(name)) return true;

  if (type === NODE_TYPES.METRIC) {
    return false;
  }

  if (type === NODE_TYPES.DATASET || type === NODE_TYPES.BENCHMARK) {
    if (tokenCount < 1) return true;
    if (sectionRole === 'inferred' && tokenCount < 2) return true;
    return false;
  }

  if (!isSentenceLikeRecord(type)) {
    if (tokenCount < 2) return true;
    if (sectionRole === 'inferred' && tokenCount < 3) return true;
    if (looksLikeTitleFragment(name) && Number(record?.confidence || 0) < 0.9) return true;
    if (type === NODE_TYPES.PROBLEM && sectionRole === 'inferred' && !isProblemLike(name)) return true;
    if (type === NODE_TYPES.METHOD && sectionRole === 'inferred' && !isMethodLike(name)) return true;
  } else {
    if (String(record?.text || name).trim().length < 32) return true;
  }

  return false;
}

function admitSemanticRecords(items, type, limit) {
  const admitted = [];
  for (const item of items || []) {
    if (shouldRejectSemanticRecord(item, type)) continue;
    admitted.push(addAdmissionMetadata(item, type));
  }
  return dedupeSlots(admitted, limit);
}

export function applySemanticAdmissionPolicy(semanticPaper) {
  semanticPaper.problems = admitSemanticRecords(semanticPaper.problems, NODE_TYPES.PROBLEM, 4);
  semanticPaper.methods = admitSemanticRecords(semanticPaper.methods, NODE_TYPES.METHOD, 3);
  semanticPaper.datasets = admitSemanticRecords(semanticPaper.datasets, NODE_TYPES.DATASET, 6);
  semanticPaper.benchmarks = admitSemanticRecords(semanticPaper.benchmarks, NODE_TYPES.BENCHMARK, 6);
  semanticPaper.metrics = admitSemanticRecords(semanticPaper.metrics, NODE_TYPES.METRIC, 6)
    .map((metric) => ({
      ...metric,
      brainstormEligible: false,
      brainstormTier: 'low',
      admissionReason: 'kept-as-evaluation-signal'
    }));
  semanticPaper.claims = admitSemanticRecords(semanticPaper.claims, NODE_TYPES.CLAIM, 5);
  semanticPaper.findings = admitSemanticRecords(semanticPaper.findings, NODE_TYPES.FINDING, 6);
  semanticPaper.researchGoals = admitSemanticRecords(semanticPaper.researchGoals, NODE_TYPES.RESEARCH_GOAL, 4);
  semanticPaper.limitations = admitSemanticRecords(semanticPaper.limitations, NODE_TYPES.LIMITATION, 5);
  semanticPaper.assumptions = admitSemanticRecords(semanticPaper.assumptions, NODE_TYPES.ASSUMPTION, 5);
  semanticPaper.evidences = admitSemanticRecords(semanticPaper.evidences, NODE_TYPES.EVIDENCE, 8)
    .map((evidence) => ({
      ...evidence,
      brainstormEligible: false,
      brainstormTier: evidence.brainstormTier || 'low',
      admissionReason: 'kept-as-supporting-evidence'
    }));
  semanticPaper.futureDirections = admitSemanticRecords(semanticPaper.futureDirections, NODE_TYPES.FUTURE_DIRECTION, 4);
  return semanticPaper;
}

function dedupeSlots(items, limit = 6) {
  const seen = new Set();
  const deduped = [];

  for (const item of [...items].sort((left, right) => {
    return (right.confidence || 0) - (left.confidence || 0)
      || (right.name || right.text || '').length - (left.name || left.text || '').length;
  })) {
    const key = normalizeText(item.normalized || item.name || item.text);
    if (!key || seen.has(key) || isGenericCandidate(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

function sectionHeading(section) {
  return section?.heading || titleCase(section?.role || 'Section');
}

function getSectionsByRole(paper, roles) {
  return paper.sections.filter((section) => roles.includes(section.role));
}

function getAbstractSection(paper) {
  return paper.sections.find((section) => section.role === 'abstract') || paper.sections[0] || null;
}

function deriveTitleHints(title) {
  const hints = [];
  const cleaned = title.replace(/\s+/g, ' ').trim();

  const colonParts = cleaned.split(':').map((part) => part.trim()).filter(Boolean);
  if (colonParts.length > 1) {
    hints.push({ kind: 'method', text: colonParts[0] });
    hints.push({ kind: 'problem', text: colonParts.slice(1).join(': ') });
  }

  const forMatch = cleaned.match(/^(.+?)\s+for\s+(.+)$/i);
  if (forMatch) {
    hints.push({ kind: 'method', text: forMatch[1] });
    hints.push({ kind: 'problem', text: forMatch[2] });
  }

  const towardMatch = cleaned.match(/^(.+?)\s+towards?\s+(.+)$/i);
  if (towardMatch) {
    hints.push({ kind: 'method', text: towardMatch[1] });
    hints.push({ kind: 'problem', text: towardMatch[2] });
  }

  const withMatch = cleaned.match(/^(.+?)\s+with\s+(.+)$/i);
  if (withMatch) {
    hints.push({ kind: 'method', text: withMatch[1] });
  }

  return hints;
}

function normalizeSpan(text) {
  return cleanSemanticName(
    String(text || '')
      .replace(/^(?:present|propose|introduce|develop|build|built|use|uses|using)\s+/i, '')
      .replace(/\b(?:using|with|through|via|by)\b.*$/i, '')
      .replace(/\b(?:that|which)\b.*$/i, '')
      .replace(/^(?:the problem of|the task of|a|an|the)\s+/i, '')
      .trim(),
    String(text || '')
  );
}

function extractProblemCandidates(paper) {
  const items = [];
  const abstract = getAbstractSection(paper);
  const introSections = getSectionsByRole(paper, ['introduction']).slice(0, 1);
  const sections = [abstract, ...introSections].filter(Boolean);

  for (const hint of deriveTitleHints(paper.title).filter((item) => item.kind === 'problem')) {
    items.push(createSlot(hint.text, {
      text: hint.text,
      evidenceText: paper.title,
      sectionHeading: 'Title',
      sectionRole: 'title',
      confidence: 0.95
    }));
  }

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      for (const pattern of PROBLEM_SENTENCE_PATTERNS) {
        const match = sentence.match(pattern);
        if (!match?.[1]) continue;
        const span = normalizeSpan(match[1]);
        items.push(createSlot(span, {
          text: span,
          evidenceText: sentence,
          sectionHeading: sectionHeading(section),
          sectionRole: section.role,
          confidence: 0.78
        }));
      }
    }
  }

  const conceptCandidates = extractConceptCandidates([
    paper.title,
    ...sections.map((section) => section.text)
  ]);

  for (const candidate of conceptCandidates.slice(0, 12)) {
    if (looksLikeDataset(candidate.phrase) || looksLikeMetric(candidate.phrase)) continue;
    if (isMethodLike(candidate.phrase) && !isProblemLike(candidate.phrase) && !paper.title.toLowerCase().includes(candidate.phrase)) {
      continue;
    }

    let confidence = 0.45 + Math.min(candidate.score / 8, 0.28);
    if (paper.title.toLowerCase().includes(candidate.phrase)) confidence += 0.12;
    if (isProblemLike(candidate.phrase)) confidence += 0.08;

    items.push(createSlot(candidate.phrase, {
      text: candidate.phrase,
      evidenceText: candidate.phrase,
      sectionHeading: 'Concept candidates',
      sectionRole: 'inferred',
      confidence
    }));
  }

  return dedupeSlots(items, 4);
}

function extractMethodPhrase(sentence) {
  for (const pattern of METHOD_SENTENCE_PATTERNS) {
    const match = sentence.match(pattern);
    if (match?.[1]) return normalizeSpan(match[1]);
  }

  return '';
}

function extractMethods(paper) {
  const items = [];
  const abstract = getAbstractSection(paper);
  const methodSections = getSectionsByRole(paper, ['method', 'preliminaries', 'body']).slice(0, 3);
  const sections = [abstract, ...methodSections].filter(Boolean);
  const titleMethodHints = deriveTitleHints(paper.title).filter((item) => item.kind === 'method');
  const titleMethodKeys = new Set(titleMethodHints.map((item) => normalizeText(item.text)));

  for (const hint of titleMethodHints) {
    items.push(createSlot(hint.text, {
      text: hint.text,
      evidenceText: paper.title,
      sectionHeading: 'Title',
      sectionRole: 'title',
      confidence: 0.94
    }));
  }

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      const phrase = extractMethodPhrase(sentence);
      if (!phrase) continue;
      items.push(createSlot(phrase, {
        text: phrase,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: 0.78
      }));
    }
  }

  if (dedupeSlots(items, 3).length < 2) {
    const conceptCandidates = extractConceptCandidates([
      ...sections.map((section) => section.text),
      paper.title
    ]);

    for (const candidate of conceptCandidates.slice(0, 14)) {
      if (looksLikeDataset(candidate.phrase) || looksLikeMetric(candidate.phrase)) continue;
      if (normalizeText(candidate.phrase).split(' ').filter(Boolean).length < 2) continue;
      if (!isMethodLike(candidate.phrase) && !titleMethodKeys.has(normalizeText(candidate.phrase))) continue;
      if (/^(?:present|propose|introduce|develop|build|built|use|uses|using)\b/i.test(candidate.phrase)) continue;

      let confidence = 0.44 + Math.min(candidate.score / 8, 0.26);
      if (titleMethodKeys.has(normalizeText(candidate.phrase))) confidence += 0.18;
      if (isMethodLike(candidate.phrase)) confidence += 0.1;

      items.push(createSlot(candidate.phrase, {
        text: candidate.phrase,
        evidenceText: candidate.phrase,
        sectionHeading: 'Method concepts',
        sectionRole: 'inferred',
        confidence
      }));
    }
  }

  return dedupeSlots(items, 3);
}

function extractDatasets(paper) {
  const matches = new Map();
  const text = [
    paper.title,
    ...paper.sections.map((section) => `${section.heading}\n${section.text}`)
  ].join('\n\n');

  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9-]+(?:[- ][A-Z0-9][A-Za-z0-9-]+){0,4})\s+(dataset|corpus|benchmark|benchmarks)\b/g)) {
    const label = `${match[1]} ${match[2]}`.replace(/\s+/g, ' ').trim();
    const key = normalizeText(label);
    matches.set(key, createSlot(label, {
      text: label,
      evidenceText: label,
      sectionHeading: 'Dataset mention',
      sectionRole: 'evidence',
      confidence: 0.8
    }));
  }

  return [...matches.values()].slice(0, 6);
}

function extractMetrics(paper) {
  const metrics = [];
  const text = [
    paper.title,
    ...paper.sections.map((section) => section.text)
  ].join('\n\n');

  for (const metric of METRIC_PATTERNS) {
    if (!metric.regex.test(text)) continue;
    metrics.push(createSlot(metric.label, {
      text: metric.label,
      evidenceText: metric.label,
      sectionHeading: 'Metric mention',
      sectionRole: 'evidence',
      confidence: 0.88,
      extra: {
        higherIsBetter: metric.higherIsBetter
      }
    }));
  }

  return metrics;
}

function extractBenchmarks(paper) {
  const matches = new Map();
  const text = [
    paper.title,
    ...paper.sections.map((section) => `${section.heading}\n${section.text}`)
  ].join('\n\n');

  for (const pattern of BENCHMARK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const rawLabel = (match[1] || match[0] || '').replace(/\s+/g, ' ').trim();
      if (!rawLabel || rawLabel.length < 5) continue;

      const values = rawLabel.includes(',') ? rawLabel.split(',') : [rawLabel];
      for (const value of values) {
        const label = cleanSemanticName(value, value);
        const key = normalizeText(label);
        if (!key || matches.has(key)) continue;
        matches.set(key, createSlot(label, {
          text: label,
          evidenceText: label,
          sectionHeading: 'Benchmark mention',
          sectionRole: 'evidence',
          confidence: 0.78
        }));
      }
    }
  }

  return [...matches.values()].slice(0, 6);
}

function detectLinkedNames(text, items) {
  const normalized = normalizeText(text);
  return items.filter((item) => normalized.includes(item.normalized)).map((item) => item.name);
}

function classifyClaimType(text) {
  if (/\b(outperform|improve|gain|achieve)\b/i.test(text)) return 'performance';
  if (/\b(enable|support|allows?|helps?)\b/i.test(text)) return 'capability';
  if (NEGATIVE_CLAIM_TERMS.test(text)) return 'boundary';
  return 'finding';
}

function classifyFindingType(text) {
  if (/\b(ablation|component|module)\b/i.test(text)) return 'ablation';
  if (/\b(compare|baseline|outperform|gain|improve)\b/i.test(text)) return 'comparison';
  if (/\b(fail|failure|degrade|drop|sensitive)\b/i.test(text)) return 'failure-mode';
  return 'finding';
}

function extractClaims(paper, datasets, metrics) {
  const sections = getSectionsByRole(paper, ['abstract', 'results', 'analysis', 'discussion', 'conclusion']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      if (!CLAIM_PATTERNS.test(sentence)) continue;
      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: 0.82,
        extra: {
          normalizedForm: normalizeText(sentence),
          claimType: classifyClaimType(sentence),
          linkedDatasets: detectLinkedNames(sentence, datasets),
          linkedMetrics: detectLinkedNames(sentence, metrics)
        }
      }));
    }
  }

  if (!items.length) {
    const abstract = getAbstractSection(paper);
    if (abstract) {
      const summary = summarizeText(abstract.text, 1);
      if (summary) {
        items.push(createSlot(summary, {
          text: summary,
          evidenceText: summary,
          sectionHeading: sectionHeading(abstract),
          sectionRole: abstract.role,
          confidence: 0.62,
          extra: {
            normalizedForm: normalizeText(summary),
            claimType: classifyClaimType(summary),
            linkedDatasets: detectLinkedNames(summary, datasets),
            linkedMetrics: detectLinkedNames(summary, metrics)
          }
        }));
      }
    }
  }

  return dedupeSlots(items, 5);
}

function extractFindings(paper, datasets, benchmarks, metrics) {
  const sections = getSectionsByRole(paper, ['abstract', 'results', 'analysis', 'discussion', 'conclusion']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      const linkedDatasets = detectLinkedNames(sentence, datasets);
      const linkedBenchmarks = detectLinkedNames(sentence, benchmarks);
      const linkedMetrics = detectLinkedNames(sentence, metrics);
      if (!FINDING_PATTERNS.test(sentence) && !linkedMetrics.length && !/\d/.test(sentence)) continue;

      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: section.role === 'results' || section.role === 'analysis' ? 0.84 : 0.7,
        extra: {
          normalizedForm: normalizeText(sentence),
          findingType: classifyFindingType(sentence),
          linkedDatasets,
          linkedBenchmarks,
          linkedMetrics
        }
      }));
    }
  }

  return dedupeSlots(items, 6);
}

function classifyLimitationType(text) {
  if (/\b(label|annotation|supervised|manual)\b/i.test(text)) return 'supervision';
  if (/\b(cost|expensive|latency|memory|compute|throughput)\b/i.test(text)) return 'efficiency';
  if (/\b(noise|robust|sensitive|corruption)\b/i.test(text)) return 'robustness';
  if (/\b(domain|generaliz|cross-domain|transfer)\b/i.test(text)) return 'generalization';
  if (/\b(evidence|benchmark|evaluate|compare|baseline)\b/i.test(text)) return 'evaluation';
  return 'limitation';
}

function extractLimitations(paper) {
  const sections = getSectionsByRole(paper, ['discussion', 'analysis', 'conclusion', 'results', 'method']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      if (!LIMITATION_PATTERNS.test(sentence)) continue;
      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: section.role === 'discussion' || section.role === 'conclusion' ? 0.8 : 0.66,
        extra: {
          normalizedForm: normalizeText(sentence),
          type: classifyLimitationType(sentence)
        }
      }));
    }
  }

  return dedupeSlots(items, 5);
}

function classifyAssumptionType(text) {
  if (/\b(label|annotation|supervised)\b/i.test(text)) return 'supervision';
  if (/\b(access|retrieval|external knowledge|knowledge base)\b/i.test(text)) return 'external-access';
  if (/\b(distribution|domain|iid|in-domain)\b/i.test(text)) return 'distribution';
  if (/\b(graph|structure|schema)\b/i.test(text)) return 'structure';
  return 'assumption';
}

function extractAssumptions(paper) {
  const sections = getSectionsByRole(paper, ['method', 'preliminaries', 'experiments', 'body', 'introduction']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      if (!ASSUMPTION_PATTERNS.test(sentence)) continue;
      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: /\bassume|assumption|given access to|under the setting\b/i.test(sentence) ? 0.84 : 0.68,
        extra: {
          normalizedForm: normalizeText(sentence),
          type: classifyAssumptionType(sentence)
        }
      }));
    }
  }

  return dedupeSlots(items, 5);
}

function extractFutureDirections(paper) {
  const sections = getSectionsByRole(paper, ['discussion', 'conclusion']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      if (!FUTURE_PATTERNS.test(sentence)) continue;
      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: 0.82,
        extra: {
          normalizedForm: normalizeText(sentence)
        }
      }));
    }
  }

  return dedupeSlots(items, 4);
}

function extractResearchGoals(paper) {
  const sections = getSectionsByRole(paper, ['introduction', 'abstract', 'conclusion']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      if (!RESEARCH_GOAL_PATTERNS.test(sentence)) continue;
      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: section.role === 'introduction' ? 0.85 : 0.72,
        extra: {
          normalizedForm: normalizeText(sentence)
        }
      }));
    }
  }

  return dedupeSlots(items, 4);
}

function extractEvidence(paper, datasets, metrics) {
  const sections = getSectionsByRole(paper, ['results', 'analysis', 'discussion', 'abstract']);
  const items = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text)) {
      const linkedDatasets = detectLinkedNames(sentence, datasets);
      const linkedMetrics = detectLinkedNames(sentence, metrics);
      if (!EVIDENCE_PATTERNS.test(sentence) && !linkedDatasets.length && !linkedMetrics.length) continue;

      items.push(createSlot(sentence, {
        text: sentence,
        evidenceText: sentence,
        sectionHeading: sectionHeading(section),
        sectionRole: section.role,
        confidence: section.role === 'results' || section.role === 'analysis' ? 0.86 : 0.7,
        extra: {
          normalizedForm: normalizeText(sentence),
          linkedDatasets,
          linkedMetrics,
          section: sectionHeading(section)
        }
      }));
    }
  }

  return dedupeSlots(items, 8);
}

function buildSemanticPaperView(paper) {
  const abstract = getAbstractSection(paper);
  const datasets = extractDatasets(paper);
  const benchmarks = extractBenchmarks(paper);
  const metrics = extractMetrics(paper);
  const claims = extractClaims(paper, datasets, metrics);
  const findings = extractFindings(paper, datasets, benchmarks, metrics);
  const limitations = extractLimitations(paper);
  const assumptions = extractAssumptions(paper);
  const futureDirections = extractFutureDirections(paper);
  const researchGoals = extractResearchGoals(paper);

  return {
    paperId: paper.paperId,
    paperTitle: paper.title,
    authors: paper.authors || [],
    abstract: abstract?.text || '',
    sourcePath: paper.sourcePath,
    sourceMarkdownPath: paper.sourceMarkdownPath,
    sourcePdfPath: paper.sourcePdfPath,
    sourceKind: paper.sourceKind,
    sourceFingerprint: paper.sourceFingerprint,
    sourceKey: paper.sourceKey,
    references: paper.references || [],
    problems: extractProblemCandidates(paper),
    methods: extractMethods(paper),
    datasets,
    benchmarks,
    metrics,
    claims,
    findings,
    researchGoals,
    limitations,
    assumptions,
    evidences: extractEvidence(paper, datasets, metrics),
    futureDirections,
    llm: {
      provider: 'disabled',
      error: null,
      relationCount: 0,
      semanticExtractionMode: 'heuristic-only',
      semanticExtractionModeEffective: 'heuristic-only',
      semanticExtractionAttempted: false,
      semanticExtractionParticipated: false,
      semanticExtractionParticipationReason: 'mode-disabled',
      semanticObjectCount: 0
    },
    llmSemanticObjects: {
      provider: 'disabled',
      mode: 'heuristic-only',
      requestedMode: 'heuristic-only',
      effectiveMode: 'heuristic-only',
      attempted: false,
      participated: false,
      reason: 'mode-disabled',
      error: null,
      problems: [],
      methods: [],
      claims: [],
      findings: [],
      researchGoals: [],
      limitations: [],
      assumptions: [],
      evidences: [],
      futureDirections: [],
      benchmarks: [],
      datasets: [],
      metrics: []
    },
    llmRelations: []
  };
}

function mergeSemanticSlots(primary, secondary, limit = 8) {
  return dedupeSlots([...(primary || []), ...(secondary || [])], limit);
}

function mergeSemanticSlotsByMode(primary, secondary, limit = 8, mode = 'heuristic-only') {
  if (!Array.isArray(primary) || !primary.length) {
    return dedupeSlots(secondary || [], limit);
  }

  if (!Array.isArray(secondary) || !secondary.length) {
    return dedupeSlots(primary || [], limit);
  }

  if (mode === 'llm-primary') {
    return dedupeSlots(secondary, limit);
  }

  if (mode === 'llm-assisted') {
    return dedupeSlots([...(secondary || []), ...(primary || [])], limit);
  }

  return dedupeSlots(primary || [], limit);
}

function countSemanticObjectEntries(payload = {}) {
  return [
    payload.problems,
    payload.methods,
    payload.claims,
    payload.findings,
    payload.researchGoals,
    payload.limitations,
    payload.assumptions,
    payload.evidences,
    payload.futureDirections,
    payload.benchmarks,
    payload.datasets,
    payload.metrics
  ].reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0);
}

function summarizePaperSemanticExtraction(paper, fallbackRequestedMode = 'heuristic-only') {
  const llm = paper?.llm || {};
  const semanticObjects = paper?.llmSemanticObjects || {};
  const requestedMode = normalizeSemanticExtractionMode(
    llm.semanticExtractionMode
    || semanticObjects.requestedMode
    || fallbackRequestedMode
  );
  const objectCount = Number.isFinite(Number(llm.semanticObjectCount))
    ? Number(llm.semanticObjectCount)
    : countSemanticObjectEntries(semanticObjects);
  const provider = semanticObjects.provider && semanticObjects.provider !== 'disabled'
    ? semanticObjects.provider
    : (llm.provider && llm.provider !== 'disabled' ? llm.provider : 'disabled');
  const explicitAttempted = typeof semanticObjects.attempted === 'boolean'
    ? semanticObjects.attempted
    : (typeof llm.semanticExtractionAttempted === 'boolean' ? llm.semanticExtractionAttempted : null);
  const attempted = explicitAttempted ?? Boolean((provider && provider !== 'disabled') || llm.error || semanticObjects.error);
  const explicitParticipated = typeof semanticObjects.participated === 'boolean'
    ? semanticObjects.participated
    : (typeof llm.semanticExtractionParticipated === 'boolean' ? llm.semanticExtractionParticipated : null);
  const participated = explicitParticipated ?? Boolean((provider && provider !== 'disabled') || objectCount > 0);
  const effectiveMode = normalizeSemanticExtractionMode(
    llm.semanticExtractionModeEffective
    || semanticObjects.effectiveMode
    || semanticObjects.mode
    || (participated ? (requestedMode === 'auto' ? 'llm-assisted' : requestedMode) : 'heuristic-only')
  );
  const reason = llm.semanticExtractionParticipationReason
    || semanticObjects.reason
    || (participated ? null : requestedMode === 'heuristic-only' ? 'mode-disabled' : attempted ? 'request-failed' : 'llm-unconfigured');

  return {
    paperId: paper?.paperId || '',
    paperTitle: paper?.paperTitle || '',
    sourcePath: paper?.sourcePath || '',
    provider,
    requestedMode,
    effectiveMode,
    attempted,
    participated,
    reason,
    error: llm.error || semanticObjects.error || null,
    semanticObjectCount: objectCount
  };
}

function isEnabledFlag(value) {
  return value === true || value === '1' || value === 'true';
}

function canAttemptLlmRelations(options = {}) {
  const relationsRequested = isEnabledFlag(options.llmRelations) || isEnabledFlag(options.ollamaRelations);
  if (!relationsRequested) return false;
  const config = resolveOllamaConfig(options);
  return Boolean(config.enabled && config.model);
}

function shouldRetryFailedLlmSnapshot(snapshot, options = {}, maxRetries = 3) {
  if (!snapshot) return false;

  // 检查重试次数，超过限制不再重试
  const retryCount = snapshot.llm?.retryCount || 0;
  if (retryCount >= maxRetries) return false;

  const semanticPlan = resolveSemanticExtractionPlan(options);
  const semanticSummary = summarizePaperSemanticExtraction(snapshot, semanticPlan.requestedMode);
  const semanticRetryableFailure = semanticPlan.shouldAttempt
    && semanticPlan.requestedMode !== 'heuristic-only'
    && !semanticSummary.participated
    && ['request-failed', 'llm-unconfigured'].includes(semanticSummary.reason);

  const relationRetryableFailure = canAttemptLlmRelations(options)
    && Boolean(snapshot.llm?.error)
    && Number(snapshot.llm?.relationCount || 0) === 0;

  return semanticRetryableFailure || relationRetryableFailure;
}

async function enrichSemanticPaperWithOllama(parsedPaper, semanticPaper, options) {
  const semanticExtractionPlan = resolveSemanticExtractionPlan(options);
  const semanticObjects = await inferPaperSemanticObjects(parsedPaper, semanticPaper, options);
  const semanticExtractionMode = semanticObjects.effectiveMode || semanticExtractionPlan.effectiveMode;
  const semanticObjectCount = countSemanticObjectEntries(semanticObjects);

  if (semanticExtractionMode !== 'heuristic-only') {
    semanticPaper.problems = mergeSemanticSlotsByMode(semanticPaper.problems, semanticObjects.problems, 4, semanticExtractionMode);
    semanticPaper.methods = mergeSemanticSlotsByMode(semanticPaper.methods, semanticObjects.methods, 3, semanticExtractionMode);
    semanticPaper.claims = mergeSemanticSlotsByMode(semanticPaper.claims, semanticObjects.claims, 5, semanticExtractionMode);
    semanticPaper.findings = mergeSemanticSlotsByMode(semanticPaper.findings, semanticObjects.findings, 6, semanticExtractionMode);
    semanticPaper.researchGoals = mergeSemanticSlotsByMode(semanticPaper.researchGoals, semanticObjects.researchGoals, 4, semanticExtractionMode);
    semanticPaper.limitations = mergeSemanticSlotsByMode(semanticPaper.limitations, semanticObjects.limitations, 5, semanticExtractionMode);
    semanticPaper.assumptions = mergeSemanticSlotsByMode(semanticPaper.assumptions, semanticObjects.assumptions, 5, semanticExtractionMode);
    semanticPaper.evidences = mergeSemanticSlotsByMode(semanticPaper.evidences, semanticObjects.evidences, 8, semanticExtractionMode);
    semanticPaper.futureDirections = mergeSemanticSlotsByMode(semanticPaper.futureDirections, semanticObjects.futureDirections, 4, semanticExtractionMode);
    semanticPaper.benchmarks = mergeSemanticSlotsByMode(semanticPaper.benchmarks, semanticObjects.benchmarks, 8, semanticExtractionMode);
    semanticPaper.datasets = mergeSemanticSlotsByMode(semanticPaper.datasets, semanticObjects.datasets, 6, semanticExtractionMode);
    semanticPaper.metrics = mergeSemanticSlotsByMode(semanticPaper.metrics, semanticObjects.metrics, 6, semanticExtractionMode);
  }

  const inference = await inferPaperResearchSemantics(parsedPaper, semanticPaper, options);
  if (inference.relations.length || inference.findings.length || inference.benchmarks.length || inference.researchGoals.length) {
    semanticPaper.benchmarks = mergeSemanticSlots(semanticPaper.benchmarks, inference.benchmarks, 8);
    semanticPaper.findings = mergeSemanticSlots(semanticPaper.findings, inference.findings, 8);
    semanticPaper.researchGoals = mergeSemanticSlots(semanticPaper.researchGoals, inference.researchGoals, 4);
  }

  semanticPaper.llm = {
    provider: inference.provider !== 'disabled' ? inference.provider : semanticObjects.provider,
    error: inference.error || semanticObjects.error,
    relationCount: inference.relations.length,
    semanticExtractionMode: semanticExtractionPlan.requestedMode,
    semanticExtractionModeEffective: semanticExtractionMode,
    semanticExtractionAttempted: semanticObjects.attempted,
    semanticExtractionParticipated: semanticObjects.participated,
    semanticExtractionParticipationReason: semanticObjects.reason,
    semanticObjectCount
  };
  semanticPaper.llmSemanticObjects = {
    provider: semanticObjects.provider,
    mode: semanticExtractionMode,
    requestedMode: semanticExtractionPlan.requestedMode,
    effectiveMode: semanticExtractionMode,
    attempted: semanticObjects.attempted,
    participated: semanticObjects.participated,
    reason: semanticObjects.reason,
    error: semanticObjects.error,
    problems: semanticObjects.problems,
    methods: semanticObjects.methods,
    claims: semanticObjects.claims,
    findings: semanticObjects.findings,
    researchGoals: semanticObjects.researchGoals,
    limitations: semanticObjects.limitations,
    assumptions: semanticObjects.assumptions,
    evidences: semanticObjects.evidences,
    futureDirections: semanticObjects.futureDirections,
    benchmarks: semanticObjects.benchmarks,
    datasets: semanticObjects.datasets,
    metrics: semanticObjects.metrics
  };
  semanticPaper.llmRelations = inference.relations;
  return semanticPaper;
}

function mergeArray(target, key, values) {
  if (!Array.isArray(values) || !values.length) return;
  target[key] = unique([...(target[key] || []), ...values]);
}

function makePaperScopedNode(type, paper, seed, name, properties = {}) {
  return {
    id: `${type.toLowerCase()}:${stableHash(`${paper.paperId}:${seed}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      ...properties
    }
  };
}

function upsertGlobalNode(graph, cache, nodesByType, type, name, properties = {}) {
  const normalizedName = normalizeText(name);
  const key = `${type}:${normalizedName}`;
  if (cache.has(key)) {
    const existing = cache.get(key);
    mergeArray(existing.properties, 'paperTitles', properties.paperTitle ? [properties.paperTitle] : []);
    mergeArray(existing.properties, 'aliases', properties.aliases || []);
    if (properties.type && !existing.properties.type) existing.properties.type = properties.type;
    if (properties.category && !existing.properties.category) existing.properties.category = properties.category;
    if (typeof properties.higherIsBetter === 'boolean' && typeof existing.properties.higherIsBetter !== 'boolean') {
      existing.properties.higherIsBetter = properties.higherIsBetter;
    }
    existing.properties.mentionCount = (existing.properties.mentionCount || 1) + 1;
    existing.properties.confidence = Math.max(existing.properties.confidence || 0, properties.confidence || 0);
    return existing;
  }

  const node = {
    id: `${type.toLowerCase()}:${slugify(name)}:${stableHash(`${type}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      normalized: normalizedName,
      paperTitles: properties.paperTitle ? [properties.paperTitle] : [],
      aliases: unique([...(properties.aliases || []), name]),
      mentionCount: 1,
      confidence: properties.confidence || 0.6
    }
  };

  if (properties.type) node.properties.type = properties.type;
  if (properties.category) node.properties.category = properties.category;
  if (typeof properties.higherIsBetter === 'boolean') node.properties.higherIsBetter = properties.higherIsBetter;
  if (properties.description) node.properties.description = properties.description;

  graph.addNode(node);
  cache.set(key, node);

  if (!nodesByType.has(type)) nodesByType.set(type, []);
  nodesByType.get(type).push(node);

  return node;
}

function aggregateGlobalContributions(fragments = []) {
  const groups = new Map();

  for (const fragment of fragments) {
    for (const contribution of fragment.globalContributions || []) {
      const node = contribution?.node;
      if (!node?.type || !node?.name) continue;

      const key = `${node.type}:${normalizeText(node.name)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          node,
          aliases: new Set(),
          paperTitles: new Set(node.properties?.paperTitles || []),
          paperRelationships: [],
          confidence: Number(node.properties?.confidence || 0),
          mentionCount: 0,
          nodeType: node.properties?.type,
          category: node.properties?.category,
          higherIsBetter: node.properties?.higherIsBetter,
          description: node.properties?.description
        });
      }

      const group = groups.get(key);
      for (const alias of contribution.aliases || []) {
        if (alias) group.aliases.add(alias);
      }
      for (const alias of node.properties?.aliases || []) {
        if (alias) group.aliases.add(alias);
      }
      for (const title of node.properties?.paperTitles || []) {
        if (title) group.paperTitles.add(title);
      }

      if (contribution.paperRelationship) {
        group.paperRelationships.push(contribution.paperRelationship);
        if (contribution.paperRelationship.properties?.sourcePaperTitle) {
          group.paperTitles.add(contribution.paperRelationship.properties.sourcePaperTitle);
        }
      }

      group.confidence = Math.max(group.confidence, Number(node.properties?.confidence || 0));
      group.mentionCount += 1;
      if (!group.nodeType && node.properties?.type) group.nodeType = node.properties.type;
      if (!group.category && node.properties?.category) group.category = node.properties.category;
      if (typeof group.higherIsBetter !== 'boolean' && typeof node.properties?.higherIsBetter === 'boolean') {
        group.higherIsBetter = node.properties.higherIsBetter;
      }
      if (!group.description && node.properties?.description) group.description = node.properties.description;
    }
  }

  return [...groups.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => ({
      key: group.key,
      node: {
        ...group.node,
        properties: {
          ...group.node.properties,
          paperTitles: [...group.paperTitles].sort(),
          aliases: unique([group.node.name, ...group.aliases]),
          mentionCount: Math.max(1, group.mentionCount),
          confidence: group.confidence,
          ...(group.nodeType ? { type: group.nodeType } : {}),
          ...(group.category ? { category: group.category } : {}),
          ...(typeof group.higherIsBetter === 'boolean' ? { higherIsBetter: group.higherIsBetter } : {}),
          ...(group.description ? { description: group.description } : {})
        }
      },
      paperRelationships: group.paperRelationships
    }));
}

function detectThemes(text, definitions) {
  const themes = [];
  for (const definition of definitions) {
    if (definition.regex.test(text)) themes.push(definition.name);
  }
  return themes;
}

function buildCandidatePairs(nodes) {
  const tokenIndex = new Map();
  const pairs = new Map();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const tokens = unique(tokenizeWithoutStopwords(node.name).filter((token) => token.length >= 4)).slice(0, 8);
    for (const token of tokens) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(index);
    }
  }

  for (const indices of tokenIndex.values()) {
    if (indices.length < 2 || indices.length > 48) continue;
    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const a = indices[left];
        const b = indices[right];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        pairs.set(key, [nodes[Math.min(a, b)], nodes[Math.max(a, b)]]);
      }
    }
  }

  if (pairs.size) {
    return [...pairs.values()];
  }

  if (nodes.length <= 40) {
    return nodes.flatMap((left, leftIndex) => {
      return nodes.slice(leftIndex + 1).map((right) => [left, right]);
    });
  }

  return [];
}

function claimPolarity(text) {
  if (POSITIVE_CLAIM_TERMS.test(text) && !NEGATIVE_CLAIM_TERMS.test(text)) return 'positive';
  if (NEGATIVE_CLAIM_TERMS.test(text) && !POSITIVE_CLAIM_TERMS.test(text)) return 'negative';
  return 'mixed';
}

function connectBidirectional(graph, leftNode, rightNode, type, properties = {}) {
  graph.addRelationship(createRelationship(leftNode.id, rightNode.id, type, properties));
  graph.addRelationship(createRelationship(rightNode.id, leftNode.id, type, properties));
}

function addSimilarityLinks(graph, nodes, type, threshold) {
  for (const [left, right] of buildCandidatePairs(nodes)) {
    const similarity = jaccardSimilarity(left.name, right.name);
    if (similarity < threshold) continue;
    connectBidirectional(graph, left, right, type, {
      score: Number(similarity.toFixed(3))
    });
  }
}

function addClaimContradictions(graph, claimNodes) {
  for (const [left, right] of buildCandidatePairs(claimNodes)) {
    if ((left.properties.paperId || null) === (right.properties.paperId || null)) continue;

    const similarity = jaccardSimilarity(left.properties.text || left.name, right.properties.text || right.name);
    if (similarity < 0.32) continue;

    const leftPolarity = claimPolarity(left.properties.text || left.name);
    const rightPolarity = claimPolarity(right.properties.text || right.name);
    if (leftPolarity === 'mixed' || rightPolarity === 'mixed' || leftPolarity === rightPolarity) continue;

    connectBidirectional(graph, left, right, EDGE_TYPES.CONTRADICTS, {
      score: Number(similarity.toFixed(3))
    });
  }
}

function addLimitationRemedyLinks(graph, limitations, methods) {
  for (const limitation of limitations) {
    const limitationThemes = detectThemes(limitation.name, LIMITATION_THEMES);
    if (!limitationThemes.length) continue;

    for (const method of methods) {
      const methodThemes = detectThemes(method.name, METHOD_THEMES);
      const overlappingThemes = limitationThemes.filter((theme) => methodThemes.includes(theme));
      if (!overlappingThemes.length) continue;

      const score = Number((0.55 + overlappingThemes.length * 0.15).toFixed(2));
      graph.addRelationship(createRelationship(limitation.id, method.id, EDGE_TYPES.MAY_BE_ADDRESSED_BY, {
        themes: overlappingThemes,
        score
      }));
    }
  }
}

function addMethodTransferLinks(graph, methods, problems) {
  const outgoingPairs = new Set(
    graph.relationships
      .filter((relationship) => relationship.type === EDGE_TYPES.APPLIES_TO)
      .map((relationship) => `${relationship.sourceId}:${relationship.targetId}`)
  );

  for (const method of methods) {
    const methodThemes = detectThemes(method.name, METHOD_THEMES);
    for (const problem of problems) {
      if (outgoingPairs.has(`${method.id}:${problem.id}`)) continue;

      const similarity = jaccardSimilarity(method.name, problem.name);
      const problemTokens = tokenizeWithoutStopwords(problem.name);
      const themeBoost = methodThemes.some((theme) => problemTokens.includes(theme.split('-')[0])) ? 0.14 : 0;
      const score = similarity + themeBoost;
      if (score < 0.22) continue;

      graph.addRelationship(createRelationship(method.id, problem.id, EDGE_TYPES.TRANSFERABLE_TO, {
        relationSource: 'heuristic',
        score: Number(score.toFixed(3))
      }));
    }
  }
}

function createNodeRegistry() {
  return new Map();
}

function registerNodeReference(registry, node, aliases = []) {
  const candidates = [node.name, ...(aliases || [])]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    const key = `${node.type}:${candidate}`;
    if (!registry.has(key)) registry.set(key, []);
    registry.get(key).push(node);
  }
}

function resolveNodeReference(registry, type, name) {
  const normalized = normalizeText(name);
  if (!normalized) return null;

  const exact = registry.get(`${type}:${normalized}`) || [];
  if (exact.length) return exact[0];

  let best = null;
  let bestScore = 0;
  for (const [key, nodes] of registry.entries()) {
    if (!key.startsWith(`${type}:`)) continue;
    const score = jaccardSimilarity(normalized, key.slice(type.length + 1));
    if (score > bestScore) {
      bestScore = score;
      best = nodes[0];
    }
  }

  return bestScore >= 0.34 ? best : null;
}

function resolveNodeReferenceWithFallback(registries, type, name) {
  for (const registry of registries) {
    const resolved = resolveNodeReference(registry, type, name);
    if (resolved) return resolved;
  }
  return null;
}

function addOllamaRelations(graph, registries, paper, relations) {
  const relationProvider = paper.llm?.provider || 'llm';
  for (const relation of relations || []) {
    const sourceNode = resolveNodeReferenceWithFallback(registries, relation.sourceType, relation.sourceName);
    const targetNode = resolveNodeReferenceWithFallback(registries, relation.targetType, relation.targetName);
    if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) continue;

    const properties = {
      sourcePaperId: paper.paperId,
      sourcePaperTitle: paper.paperTitle,
      confidence: relation.confidence,
      evidenceText: relation.evidenceText || '',
      rationale: relation.rationale || '',
      explicitOrInferred: relation.explicitOrInferred || 'inferred',
      relationSource: relationProvider
    };

    if (relation.type === EDGE_TYPES.COMBINES_WITH || relation.type === EDGE_TYPES.COMPATIBLE_WITH || relation.type === EDGE_TYPES.RELATED_TO || relation.type === EDGE_TYPES.SIMILAR_TO || relation.type === EDGE_TYPES.CONTRADICTS) {
      connectBidirectional(graph, sourceNode, targetNode, relation.type, properties);
      continue;
    }

    graph.addRelationship(createRelationship(sourceNode.id, targetNode.id, relation.type, properties));
  }
}

function annotateGraphLayers(graph) {
  for (const relationship of graph.relationships) {
    const sourceNode = graph.getNode(relationship.sourceId);
    const targetNode = graph.getNode(relationship.targetId);
    if (!sourceNode || !targetNode) continue;

    const sourceLayer = sourceNode.properties?.layer || getNodeLayer(sourceNode.type);
    const targetLayer = targetNode.properties?.layer || getNodeLayer(targetNode.type);
    relationship.properties = {
      ...relationship.properties,
      sourceLayer,
      targetLayer,
      layerScope: sourceLayer === targetLayer ? 'intra-layer' : 'cross-layer',
      layerPath: `${sourceLayer}->${targetLayer}`
    };
  }
}

function findRelationship(graph, sourceId, targetId, type) {
  return graph.getOutgoing(sourceId).find((relationship) => {
    return relationship.targetId === targetId && relationship.type === type;
  }) || null;
}

function summarizePaperSupport(node, paperAbstractsByTitle) {
  return (node.properties?.paperTitles || [])
    .slice(0, 3)
    .map((title) => ({
      title,
      abstract: truncate(paperAbstractsByTitle.get(title) || '', 260)
    }));
}

function collectCrossPaperCandidates(graph, methods, problems, paperAbstractsByTitle) {
  const candidates = [];

  for (const method of methods) {
    for (const relationship of graph.getOutgoing(method.id)) {
      if (relationship.type !== EDGE_TYPES.TRANSFERABLE_TO) continue;
      const problem = graph.getNode(relationship.targetId);
      if (!problem || problem.type !== NODE_TYPES.PROBLEM) continue;
      if (findRelationship(graph, method.id, problem.id, EDGE_TYPES.APPLIES_TO)) continue;

      candidates.push({
        id: `transfer:${method.id}:${problem.id}`,
        kind: 'transfer',
        relationType: EDGE_TYPES.TRANSFERABLE_TO,
        heuristicScore: relationship.properties?.score || 0,
        source: {
          id: method.id,
          type: method.type,
          name: method.name,
          papers: summarizePaperSupport(method, paperAbstractsByTitle)
        },
        target: {
          id: problem.id,
          type: problem.type,
          name: problem.name,
          papers: summarizePaperSupport(problem, paperAbstractsByTitle)
        }
      });
    }
  }

  const seenPairs = new Set();
  for (const method of methods) {
    const sourcePapers = new Set(method.properties?.paperTitles || []);
    for (const relationship of graph.getOutgoing(method.id)) {
      if (relationship.type !== EDGE_TYPES.SIMILAR_TO && relationship.type !== EDGE_TYPES.COMPATIBLE_WITH) continue;
      const peer = graph.getNode(relationship.targetId);
      if (!peer || peer.type !== NODE_TYPES.METHOD || peer.id === method.id) continue;

      const targetPapers = new Set(peer.properties?.paperTitles || []);
      const sharedPaper = [...sourcePapers].some((title) => targetPapers.has(title));
      if (sharedPaper) continue;

      const pairKey = [method.id, peer.id].sort().join(':');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      candidates.push({
        id: `combine:${method.id}:${peer.id}`,
        kind: 'combination',
        relationType: EDGE_TYPES.COMBINES_WITH,
        heuristicScore: relationship.properties?.score || 0,
        source: {
          id: method.id,
          type: method.type,
          name: method.name,
          papers: summarizePaperSupport(method, paperAbstractsByTitle)
        },
        target: {
          id: peer.id,
          type: peer.type,
          name: peer.name,
          papers: summarizePaperSupport(peer, paperAbstractsByTitle)
        }
      });
    }
  }

  return candidates
    .sort((left, right) => (right.heuristicScore || 0) - (left.heuristicScore || 0))
    .slice(0, 24);
}

async function applyCrossPaperOllamaJudgments(graph, methods, problems, semanticPapers, options) {
  const config = resolveOllamaConfig(options);
  if (!config.enabled || !config.model) return 0;
  const relationSource = `${config.provider || 'llm'}-cross-paper`;

  const paperAbstractsByTitle = new Map(
    semanticPapers.map((paper) => [paper.paperTitle, paper.abstract || ''])
  );
  const candidates = collectCrossPaperCandidates(
    graph,
    methods,
    problems,
    paperAbstractsByTitle
  );

  if (!candidates.length) return 0;

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const judgments = await adjudicateCrossPaperCandidates(candidates, options);
  let accepted = 0;

  for (const judgment of judgments) {
    if (!judgment.accepted) continue;
    const candidate = candidateById.get(judgment.id);
    if (!candidate) continue;
    const sourceNode = graph.getNode(candidate.source.id);
    const targetNode = graph.getNode(candidate.target.id);
    if (!sourceNode || !targetNode) continue;

    if (judgment.relationType === EDGE_TYPES.TRANSFERABLE_TO) {
      const existing = findRelationship(graph, sourceNode.id, targetNode.id, EDGE_TYPES.TRANSFERABLE_TO);
      if (existing) {
        existing.properties = {
          ...existing.properties,
          llmValidated: true,
          llmConfidence: judgment.confidence,
          llmRationale: judgment.rationale,
          evidenceText: judgment.evidenceText || existing.properties?.evidenceText || '',
          relationSource
        };
      } else {
        graph.addRelationship(createRelationship(sourceNode.id, targetNode.id, EDGE_TYPES.TRANSFERABLE_TO, {
          relationSource,
          llmValidated: true,
          llmConfidence: judgment.confidence,
          llmRationale: judgment.rationale,
          evidenceText: judgment.evidenceText || ''
        }));
      }
      accepted += 1;
      continue;
    }

    if (!findRelationship(graph, sourceNode.id, targetNode.id, EDGE_TYPES.COMBINES_WITH)) {
      connectBidirectional(graph, sourceNode, targetNode, EDGE_TYPES.COMBINES_WITH, {
        relationSource,
        llmValidated: true,
        llmConfidence: judgment.confidence,
        llmRationale: judgment.rationale,
        evidenceText: judgment.evidenceText || ''
      });
      accepted += 1;
    }
  }

  return accepted;
}

function buildPaperNode(paper) {
  return {
    id: paper.paperId,
    type: NODE_TYPES.PAPER,
    name: paper.paperTitle,
    properties: {
      layer: getNodeLayer(NODE_TYPES.PAPER),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      authors: paper.authors || [],
      abstract: paper.abstract || '',
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      sourceFingerprint: paper.sourceFingerprint
    }
  };
}

async function buildGraphFromSemanticPapers({ corpusName, rootPath, semanticPapers, options = {} }) {
  const graph = createKnowledgeGraph();
  const corpusId = `corpus:${slugify(corpusName)}:${stableHash(rootPath)}`;
  const nodesByType = new Map();
  const nodeRegistry = createNodeRegistry();
  const paperNodes = new Map();
  const paperClaims = [];
  const quiet = Boolean(options.quiet);
  const precomputedFragments = await precomputePaperGraphFragments(semanticPapers, {
    graphPrecomputeConcurrency: firstDefinedValue(options.graphPrecomputeConcurrency, options.analyzeConcurrency, options.concurrency),
    analyzeConcurrency: options.analyzeConcurrency,
    concurrency: options.concurrency
  });
  const aggregatedGlobalContributions = aggregateGlobalContributions(precomputedFragments);
  const globalNodeById = new Map();
  const progress = quiet ? createQuietProgress() : createProgressBar(precomputedFragments.length, { prefix: 'Building graph' });

  graph.addNode({
    id: corpusId,
    type: NODE_TYPES.CORPUS,
    name: corpusName,
    properties: {
      layer: getNodeLayer(NODE_TYPES.CORPUS),
      rootPath
    }
  });

  for (const contributionGroup of aggregatedGlobalContributions) {
    const node = graph.addNode(contributionGroup.node);
    globalNodeById.set(node.id, node);

    if (!nodesByType.has(node.type)) nodesByType.set(node.type, []);
    nodesByType.get(node.type).push(node);
    graph.addRelationship(createRelationship(corpusId, node.id, EDGE_TYPES.CONTAINS));
  }

  for (let index = 0; index < semanticPapers.length; index += 1) {
    const paper = semanticPapers[index];
    const fragment = precomputedFragments[index];
    const localNodeRegistry = createNodeRegistry();
    const registerPaperNode = (node, aliases = []) => {
      registerNodeReference(nodeRegistry, node, aliases);
      registerNodeReference(localNodeRegistry, node, aliases);
    };
    const paperNode = graph.addNode(fragment.paperNode || buildPaperNode(paper));
    paperNodes.set(paper.paperId, paperNode);
    registerPaperNode(paperNode, [paper.paperTitle]);
    graph.addRelationship(createRelationship(corpusId, paperNode.id, EDGE_TYPES.CONTAINS));
    for (const contribution of fragment.globalContributions || []) {
      const node = globalNodeById.get(contribution.node.id) || graph.getNode(contribution.node.id);
      if (!node) continue;
      registerPaperNode(node, contribution.aliases || node.properties?.aliases || []);
      if (contribution.paperRelationship) {
        graph.addRelationship(contribution.paperRelationship);
      }
    }

    for (const contribution of fragment.paperScopedContributions || []) {
      const node = graph.addNode(contribution.node);
      registerPaperNode(node, contribution.aliases || []);
      graph.addRelationship(createRelationship(corpusId, node.id, EDGE_TYPES.CONTAINS));
      if (contribution.paperRelationship) {
        graph.addRelationship(contribution.paperRelationship);
      }
      for (const relationship of contribution.extraRelationships || []) {
        graph.addRelationship(relationship);
      }
      if (node.type === NODE_TYPES.CLAIM) {
        paperClaims.push(node);
      }
    }

    for (const relationship of fragment.localRelationships || []) {
      graph.addRelationship(relationship);
    }

    addOllamaRelations(graph, [localNodeRegistry, nodeRegistry], paper, paper.llmRelations);
  }

  const postprocessRelationships = await precomputeGraphPostprocess({
    problems: nodesByType.get(NODE_TYPES.PROBLEM) || [],
    methods: nodesByType.get(NODE_TYPES.METHOD) || [],
    limitations: nodesByType.get(NODE_TYPES.LIMITATION) || [],
    futureDirections: nodesByType.get(NODE_TYPES.FUTURE_DIRECTION) || [],
    benchmarks: nodesByType.get(NODE_TYPES.BENCHMARK) || [],
    claims: paperClaims,
    appliesPairs: graph.relationships
      .filter((relationship) => relationship.type === EDGE_TYPES.APPLIES_TO)
      .map((relationship) => `${relationship.sourceId}:${relationship.targetId}`),
    papers: semanticPapers.map((paper) => ({
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      references: paper.references || []
    }))
  }, {
    graphPostprocessConcurrency: firstDefinedValue(options.graphPostprocessConcurrency, options.analyzeConcurrency, options.concurrency),
    analyzeConcurrency: options.analyzeConcurrency,
    concurrency: options.concurrency
  });

  for (const relationship of postprocessRelationships) {
    graph.addRelationship(relationship);
  }

  const acceptedCrossPaperJudgments = await applyCrossPaperOllamaJudgments(
    graph,
    nodesByType.get(NODE_TYPES.METHOD) || [],
    nodesByType.get(NODE_TYPES.PROBLEM) || [],
    semanticPapers,
    options
  );

  for (let index = 0; index < semanticPapers.length; index += 1) {
    progress.tick();
  }

  progress.done();
  annotateGraphLayers(graph);

  const problemNodes = (nodesByType.get(NODE_TYPES.PROBLEM) || [])
    .sort((left, right) => (right.properties?.paperTitles?.length || 0) - (left.properties?.paperTitles?.length || 0));

  return {
    graph,
    problemNodes,
    acceptedCrossPaperJudgments
  };
}

async function createMeta({ name, rootPath, graph, sourceMode, problems, semanticPapers, pdfParser, pdfCommand, semanticExtractionMode = 'heuristic-only', changes, acceptedCrossPaperJudgments = 0, failedSources = [], sourceCount = semanticPapers.length }) {
  const topProblems = problems.slice(0, 12).map((problem) => problem.name);
  const llmRelations = semanticPapers.reduce((total, paper) => total + (paper.llmRelations?.length || 0), 0);
  const llmEnabled = semanticPapers.some((paper) => paper.llm?.provider && paper.llm.provider !== 'disabled');
  const llmProviders = unique(
    semanticPapers
      .map((paper) => paper.llm?.provider)
      .filter((provider) => provider && provider !== 'disabled')
  );
  const semanticExtractionPapers = semanticPapers.map((paper) => summarizePaperSemanticExtraction(paper, semanticExtractionMode));
  const semanticExtractionCounts = semanticExtractionPapers.reduce((totals, paper) => {
    totals[paper.effectiveMode] = (totals[paper.effectiveMode] || 0) + 1;
    return totals;
  }, {});
  const semanticExtractionParticipated = semanticExtractionPapers.filter((paper) => paper.participated);
  const semanticExtractionSkipped = semanticExtractionPapers.filter((paper) => !paper.participated);
  const layerCounts = {};
  const layerPathCounts = {};
  const brainstormNodeCounts = {};

  for (const node of graph.nodes) {
    const layer = node.properties?.layer || getNodeLayer(node.type);
    layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    if (node.properties?.brainstormEligible) {
      brainstormNodeCounts[node.type] = (brainstormNodeCounts[node.type] || 0) + 1;
    }
  }

  for (const relationship of graph.relationships) {
    const path = relationship.properties?.layerPath || 'unknown';
    layerPathCounts[path] = (layerPathCounts[path] || 0) + 1;
  }

  return {
    name,
    rootPath,
    indexedAt: new Date().toISOString(),
    sourceMode,
    buildMode: 'dynamic-incremental-research-graph',
    schemaMode: 'research-opportunity',
    graphMode: 'explicit-multilayer',
    storageMode: await resolveGraphStorageMode(),
    paperCount: semanticPapers.length,
    sourceCount,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    topProblems,
    topDomains: topProblems,
    pdfParser: pdfParser || null,
    pdfCommand: pdfCommand || null,
    semanticExtractionMode,
    markerCommand: pdfParser === 'marker' ? (pdfCommand || null) : null,
    mineruCommand: pdfParser === 'mineru' ? (pdfCommand || null) : null,
    layers: layerCounts,
    layerPaths: layerPathCounts,
    brainstormView: {
      eligibleNodeCount: Object.values(brainstormNodeCounts).reduce((total, count) => total + count, 0),
      nodeTypes: brainstormNodeCounts
    },
    llm: {
      enabled: llmEnabled,
      providers: llmProviders,
      relationCount: llmRelations,
      crossPaperAccepted: acceptedCrossPaperJudgments,
      semanticExtraction: {
        requestedMode: semanticExtractionMode,
        effectiveModes: semanticExtractionCounts,
        participatedPaperCount: semanticExtractionParticipated.length,
        skippedPaperCount: semanticExtractionSkipped.length,
        participatedPapers: semanticExtractionParticipated,
        skippedPapers: semanticExtractionSkipped
      }
    },
    failedSourceCount: failedSources.length,
    failedSources: failedSources.slice(0, 24),
    lastChangeSummary: changes
  };
}

function createSourceFingerprint(stats) {
  return `${Math.round(Number(stats.mtimeMs || 0))}:${Number(stats.size || 0)}`;
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function createEmptyManifest({ corpusName, rootPath, inputPath, inputPaths, sourceMode, pdfParser, pdfCommand, semanticExtractionMode, sources, indexedAt }) {
  return {
    version: MANIFEST_VERSION,
    corpusName,
    rootPath,
    inputPath,
    inputPaths,
    sourceMode,
    pdfParser: pdfParser || null,
    pdfCommand: pdfCommand || null,
    semanticExtractionMode: semanticExtractionMode || 'heuristic-only',
    markerCommand: pdfParser === 'marker' ? (pdfCommand || null) : null,
    mineruCommand: pdfParser === 'mineru' ? (pdfCommand || null) : null,
    indexedAt,
    sources
  };
}

function summarizeSourceChanges(sourceStates, removedSources) {
  const summary = {
    added: 0,
    updated: 0,
    reused: 0,
    removed: removedSources.length
  };

  for (const source of sourceStates) {
    if (source.changeType === 'added') summary.added += 1;
    else if (source.changeType === 'updated') summary.updated += 1;
    else summary.reused += 1;
  }

  return summary;
}

function hasSourceChanges(summary) {
  return Boolean(summary.added || summary.updated || summary.removed);
}

function normalizeInputPaths(inputPath) {
  if (Array.isArray(inputPath)) {
    return unique(inputPath.map((item) => path.resolve(item)));
  }

  return [path.resolve(inputPath)];
}

function describeInputPaths(inputPaths) {
  if (!inputPaths.length) return 'the configured inputs';
  if (inputPaths.length === 1) return inputPaths[0];
  return inputPaths.join(', ');
}

async function collectSourcesFromInput(absoluteInput) {
  const inputStats = await fs.stat(absoluteInput);

  if (inputStats.isFile()) {
    const extension = path.extname(absoluteInput).toLowerCase();
    if (extension === '.pdf') {
      return {
        inputPath: absoluteInput,
        inputStats,
        sources: [{ kind: 'pdf', inputPath: absoluteInput, sourceKey: absoluteInput }]
      };
    }

    if (extension === '.md' || extension === '.markdown') {
      return {
        inputPath: absoluteInput,
        inputStats,
        sources: [{ kind: 'markdown', inputPath: absoluteInput, sourceKey: absoluteInput }]
      };
    }

    throw new Error(`Unsupported input file "${absoluteInput}". Expected .pdf, .md, or .markdown.`);
  }

  const [pdfFiles, markdownFiles] = await Promise.all([
    collectFiles(absoluteInput, ['.pdf']),
    collectFiles(absoluteInput, ['.md', '.markdown'])
  ]);
  const files = [
    ...pdfFiles.map((filePath) => ({
      kind: 'pdf',
      inputPath: filePath,
      sourceKey: filePath
    })),
    ...markdownFiles.map((filePath) => ({
      kind: 'markdown',
      inputPath: filePath,
      sourceKey: filePath
    }))
  ];

  return {
    inputPath: absoluteInput,
    inputStats,
    sources: files
  };
}

async function discoverCorpusSources(inputPath, options = {}) {
  const absoluteInputs = normalizeInputPaths(inputPath);
  const dedupedSources = new Map();

  const inputEntries = await mapWithConcurrency(
    absoluteInputs,
    Math.min(Math.max(1, absoluteInputs.length), 4),
    (absoluteInput) => collectSourcesFromInput(absoluteInput)
  );

  for (const entry of inputEntries) {
    for (const source of entry.sources) {
      dedupedSources.set(source.sourceKey, source);
    }
  }

  const kinds = new Set([...dedupedSources.values()].map((source) => source.kind));
  const rootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : (absoluteInputs.length === 1
        ? (inputEntries[0].inputStats.isDirectory() ? inputEntries[0].inputPath : path.dirname(inputEntries[0].inputPath))
        : process.cwd());

  return {
    absoluteInput: absoluteInputs[0],
    absoluteInputs,
    inputStats: inputEntries[0]?.inputStats || null,
    inputEntries,
    rootPath,
    sourceMode: kinds.size > 1 ? 'mixed' : (kinds.has('pdf') ? 'pdf' : 'markdown'),
    sources: [...dedupedSources.values()].sort((left, right) => left.inputPath.localeCompare(right.inputPath))
  };
}

function buildManifestEntry(rootPath, sourceState, semanticPaper, markerCommand, extra = {}) {
  return {
    sourceKey: sourceState.sourceKey,
    inputPath: sourceState.inputPath,
    kind: sourceState.kind,
    fingerprint: sourceState.fingerprint,
    paperId: semanticPaper.paperId,
    paperTitle: semanticPaper.paperTitle,
    sourcePath: semanticPaper.sourcePath,
    sourceMarkdownPath: semanticPaper.sourceMarkdownPath,
    sourcePdfPath: semanticPaper.sourcePdfPath,
    markerCommand: markerCommand || null,
    snapshotPath: path.relative(rootPath, getSemanticPaperSnapshotPath(rootPath, sourceState.sourceKey)),
    activeInGraph: semanticPaper.activeInGraph !== false,
    canonicalSourceKey: semanticPaper.canonicalSourceKey || sourceState.sourceKey,
    duplicateOfSourceKey: semanticPaper.duplicateOfSourceKey || null,
    duplicateSourceCount: Number(semanticPaper.duplicateSourceCount || 1),
    availableSourceKinds: Array.isArray(semanticPaper.availableSourceKinds) && semanticPaper.availableSourceKinds.length
      ? semanticPaper.availableSourceKinds
      : [semanticPaper.sourceKind || sourceState.kind],
    ...extra
  };
}

async function materializeSemanticPaper(rootPath, sourceState, options = {}) {
  const { markdownDir, markerDir } = getCorpusPaths(rootPath);
  let markdownPath = sourceState.inputPath;
  let sourcePdfPath = null;
  let pdfCommand = null;

  if (sourceState.kind === 'pdf') {
    const converted = await convertPdfToMarkdown(sourceState.inputPath, {
      pdfParser: options.pdfParser,
      pdfCommand: options.pdfCommand,
      force: Boolean(options.force || sourceState.changeType !== 'unchanged'),
      doclingCommand: options.doclingCommand,
      doclingOcrEngine: options.doclingOcrEngine,
      doclingSshHost: options.doclingSshHost,
      pdfParserSshHost: options.pdfParserSshHost,
      markerCommand: options.markerCommand,
      markerSshHost: options.markerSshHost,
      mineruCommand: options.mineruCommand,
      mineruHttpUrl: options.mineruHttpUrl,
      pageRange: options.pageRange,
      pdfSshHost: options.pdfSshHost,
      markerDir,
      markdownDir
    });
    markdownPath = converted.markdownPath;
    sourcePdfPath = converted.sourcePdfPath;
    pdfCommand = converted.parserCommand || converted.markerCommand || null;
  }

  const markdown = await readText(markdownPath);
  const parsed = parsePaperMarkdown(markdown, markdownPath);
  parsed.paperId = `paper:${stableHash(sourceState.sourceKey)}`;
  parsed.paperTitle = parsed.title;
  parsed.sourceKey = sourceState.sourceKey;
  parsed.sourcePath = sourceState.inputPath;
  parsed.sourceMarkdownPath = markdownPath;
  parsed.sourcePdfPath = sourcePdfPath;
  parsed.sourceKind = sourceState.kind;
  parsed.sourceFingerprint = sourceState.fingerprint;

  const semanticPaper = buildSemanticPaperView(parsed);
  await enrichSemanticPaperWithOllama(parsed, semanticPaper, options);
  applySemanticAdmissionPolicy(semanticPaper);

  return {
    semanticPaper,
    markerCommand: pdfCommand
  };
}

function formatChangeSummary(changes) {
  return `${changes.added} added, ${changes.updated} updated, ${changes.removed} removed, ${changes.reused} reused`;
}

function resolveMarkerConcurrency(options = {}) {
  const raw = Number(options.markerConcurrency);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }

  return options.markerSshHost ? 4 : 1;
}

function resolveAvailableParallelism(options = {}) {
  const explicit = Number(options.availableParallelism);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  if (typeof os.availableParallelism === 'function') {
    return Math.max(1, os.availableParallelism());
  }

  return Math.max(1, os.cpus()?.length || 1);
}

function resolveAnalyzeConcurrency(options = {}) {
  const explicit = Number(firstDefinedValue(
    options.analyzeConcurrency,
    options.concurrency
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  const legacy = Number(options.markerConcurrency);
  if (Number.isFinite(legacy) && legacy > 0) {
    return Math.max(1, Math.floor(legacy));
  }

  const parser = normalizePdfParser(options.pdfParser);
  if (parser === 'marker') {
    return resolveMarkerConcurrency(options);
  }

  const available = resolveAvailableParallelism(options);
  const semanticPlan = resolveSemanticExtractionPlan(options);
  const llmEnabled = semanticPlan.requestedMode !== 'heuristic-only' || canAttemptLlmRelations(options);
  const hasRemotePdfRuntime = Boolean(
    options.doclingSshHost
    || options.markerSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || options.mineruHttpUrl
  );

  let concurrency = hasRemotePdfRuntime ? Math.min(available, 6) : Math.min(available, 4);
  if (parser === 'mineru' && !hasRemotePdfRuntime) {
    concurrency = Math.min(concurrency, 3);
  }

  if (llmEnabled) {
    concurrency = Math.min(concurrency, 2);
  }

  return Math.max(1, concurrency);
}

function resolveMetadataConcurrency(options = {}) {
  const explicit = Number(firstDefinedValue(
    options.metadataConcurrency,
    options.sourceStateConcurrency
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  return Math.max(2, Math.min(resolveAvailableParallelism(options), 8));
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  if (!Array.isArray(items) || !items.length) return [];

  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeAuthorName(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function createPaperTitleKey(paper) {
  const title = normalizeText(paper?.paperTitle || paper?.title || '');
  if (title) return title;
  const sourcePath = paper?.sourcePath || paper?.sourceKey || '';
  return normalizeText(path.basename(sourcePath, path.extname(sourcePath)));
}

function createPaperAuthorSet(paper) {
  return new Set((paper?.authors || []).map(normalizeAuthorName).filter(Boolean));
}

function computePaperContentScore(paper) {
  const sectionTextLength = (paper?.sections || []).reduce((total, section) => total + String(section?.text || '').length, 0);
  const abstractLength = String(paper?.abstract || '').length;
  const referenceCount = Array.isArray(paper?.references) ? paper.references.length : 0;
  const authorCount = Array.isArray(paper?.authors) ? paper.authors.length : 0;

  return sectionTextLength
    + abstractLength * 2
    + referenceCount * 80
    + authorCount * 120;
}

function compareSemanticPaperPreference(leftRecord, rightRecord) {
  const leftPaper = leftRecord.semanticPaper;
  const rightPaper = rightRecord.semanticPaper;
  const leftScore = computePaperContentScore(leftPaper) + (leftPaper.sourceKind === 'markdown' ? 100000 : 0);
  const rightScore = computePaperContentScore(rightPaper) + (rightPaper.sourceKind === 'markdown' ? 100000 : 0);

  if (leftScore !== rightScore) return rightScore - leftScore;
  return leftRecord.sourceState.sourceKey.localeCompare(rightRecord.sourceState.sourceKey);
}

function papersAreDuplicate(leftPaper, rightPaper) {
  const leftTitle = createPaperTitleKey(leftPaper);
  const rightTitle = createPaperTitleKey(rightPaper);
  if (!leftTitle || !rightTitle || leftTitle !== rightTitle) return false;

  const leftAuthors = createPaperAuthorSet(leftPaper);
  const rightAuthors = createPaperAuthorSet(rightPaper);

  if (leftAuthors.size && rightAuthors.size) {
    for (const author of leftAuthors) {
      if (rightAuthors.has(author)) return true;
    }
    return false;
  }

  return true;
}

function chooseCanonicalPaperId(group, canonicalRecord) {
  const preferredPrevious = canonicalRecord?.sourceState?.previous?.paperId;
  if (preferredPrevious) return preferredPrevious;

  const activePrevious = group
    .map((record) => record.sourceState?.previous)
    .find((entry) => entry?.paperId && entry.activeInGraph !== false);
  if (activePrevious?.paperId) return activePrevious.paperId;

  const anyPrevious = group
    .map((record) => record.sourceState?.previous?.paperId)
    .filter(Boolean);
  if (anyPrevious.length) return anyPrevious[0];

  const titleKey = createPaperTitleKey(canonicalRecord?.semanticPaper);
  return `paper:${stableHash(`canonical:${titleKey || canonicalRecord?.sourceState?.sourceKey || ''}`)}`;
}

function canonicalizeMaterializedSources(materializedSources = []) {
  const normalizedRecords = [];
  const activeSemanticPapers = [];
  const consumed = new Set();
  const rankedRecords = [...materializedSources].sort(compareSemanticPaperPreference);

  for (let index = 0; index < rankedRecords.length; index += 1) {
    if (consumed.has(index)) continue;

    const seed = rankedRecords[index];
    const group = [seed];
    consumed.add(index);

    for (let inner = index + 1; inner < rankedRecords.length; inner += 1) {
      if (consumed.has(inner)) continue;
      const candidate = rankedRecords[inner];
      if (!papersAreDuplicate(seed.semanticPaper, candidate.semanticPaper)) continue;
      consumed.add(inner);
      group.push(candidate);
    }

    group.sort(compareSemanticPaperPreference);
    const canonicalRecord = group[0];
    const canonicalPaperId = chooseCanonicalPaperId(group, canonicalRecord);
    const sourceKinds = unique(group.map((record) => record.semanticPaper.sourceKind || record.sourceState.kind).filter(Boolean));
    const sourceKeys = unique(group.map((record) => record.sourceState.sourceKey).filter(Boolean));

    for (const record of group) {
      const activeInGraph = record.sourceState.sourceKey === canonicalRecord.sourceState.sourceKey;
      const normalizedPaper = {
        ...record.semanticPaper,
        paperId: canonicalPaperId,
        canonicalSourceKey: canonicalRecord.sourceState.sourceKey,
        duplicateOfSourceKey: activeInGraph ? null : canonicalRecord.sourceState.sourceKey,
        activeInGraph,
        duplicateSourceCount: group.length,
        availableSourceKinds: sourceKinds,
        sourceVariants: sourceKeys
      };

      normalizedRecords.push({
        ...record,
        semanticPaper: normalizedPaper
      });

      if (activeInGraph) {
        activeSemanticPapers.push(normalizedPaper);
      }
    }
  }

  return {
    normalizedRecords,
    activeSemanticPapers
  };
}

async function materializeSourceStates(rootPath, sourceStates, options = {}) {
  const materializedSources = [];
  const failedSources = [];
  const analyzeConcurrency = resolveAnalyzeConcurrency(options);
  const metadataConcurrency = resolveMetadataConcurrency(options);
  const quiet = Boolean(options.quiet);
  let nextIndex = 0;

  // 创建进度条
  const progress = quiet ? createQuietProgress() : createProgressBar(sourceStates.length, { prefix: 'Processing papers' });

  async function processSourceState(sourceState) {
    if (sourceState.changeType === 'unchanged' || sourceState.reuseCachedMaterialization) {
      const cachedPaper = sourceState.cachedPaper || await loadSemanticPaperSnapshot(rootPath, sourceState.sourceKey);
      if (cachedPaper) {
        materializedSources.push({
          sourceState,
          semanticPaper: cachedPaper,
          markerCommand: sourceState.previous?.markerCommand || null
        });
        progress.tick();
        return;
      }
    }

    try {
      const { semanticPaper, markerCommand } = await materializeSemanticPaper(rootPath, sourceState, { ...options, quiet });
      await saveSemanticPaperSnapshot(rootPath, sourceState.sourceKey, semanticPaper);
      materializedSources.push({
        sourceState,
        semanticPaper,
        markerCommand
      });
    } catch (error) {
      failedSources.push({
        sourceKey: sourceState.sourceKey,
        inputPath: sourceState.inputPath,
        message: error.message
      });

      if (sourceState.previous) {
        const cachedPaper = sourceState.cachedPaper || await loadSemanticPaperSnapshot(rootPath, sourceState.sourceKey);
        if (cachedPaper) {
          // 增量重试次数，以便 shouldRetryFailedLlmSnapshot 在未来不再重试
          if (cachedPaper.llm) {
            cachedPaper.llm.retryCount = (cachedPaper.llm.retryCount || 0) + 1;
          } else {
            cachedPaper.llm = { retryCount: 1 };
          }
          materializedSources.push({
            sourceState,
            semanticPaper: cachedPaper,
            markerCommand: sourceState.previous?.markerCommand || null
          });
        }
      }
    } finally {
      progress.tick();
    }
  }

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= sourceStates.length) {
        return;
      }
      await processSourceState(sourceStates[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(analyzeConcurrency, Math.max(sourceStates.length, 1)) }, () => worker())
  );

  progress.done();

  const { normalizedRecords, activeSemanticPapers } = canonicalizeMaterializedSources(materializedSources);
  const manifestSources = await mapWithConcurrency(normalizedRecords, metadataConcurrency, async (record) => {
    await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
    return buildManifestEntry(
      rootPath,
      record.sourceState,
      record.semanticPaper,
      record.markerCommand,
      {
        dedupedBy: record.semanticPaper.duplicateSourceCount > 1 ? 'paper-identity' : null
      }
    );
  });

  return {
    semanticPapers: activeSemanticPapers,
    manifestSources,
    failedSources
  };
}

export async function analyzeCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { absoluteInput, absoluteInputs, inputStats, rootPath } = discovery;

  return withFileLock(getCorpusLockPath(rootPath), async () => {
    const corpusName = options.name || path.basename(
      absoluteInputs.length === 1 && inputStats
        ? (inputStats.isDirectory() ? absoluteInput : rootPath)
        : rootPath
    );
    const previousManifest = await loadSourceManifest(rootPath);
    const manifestVersionMismatch = previousManifest && previousManifest.version !== MANIFEST_VERSION;
    const normalizedSemanticExtractionMode = normalizeSemanticExtractionMode(
      firstDefinedValue(options.semanticExtraction, previousManifest?.semanticExtractionMode, 'auto')
    );
    const analysisOptions = {
      ...options,
      semanticExtraction: normalizedSemanticExtractionMode
    };
    const previousByKey = new Map((previousManifest?.sources || []).map((entry) => [entry.sourceKey, entry]));
    const currentKeys = new Set(discovery.sources.map((source) => source.sourceKey));
    const { metaPath } = getCorpusPaths(rootPath);
    const previousIndexExists = await fileExists(metaPath) && await hasCorpusGraphStore(rootPath);
    const inputLabel = describeInputPaths(absoluteInputs);

    if (!discovery.sources.length && !previousIndexExists) {
      throw new Error(`No PDF or Markdown files found in ${inputLabel}.`);
    }

    const metadataConcurrency = resolveMetadataConcurrency(analysisOptions);
    const sourceStates = await mapWithConcurrency(discovery.sources, metadataConcurrency, async (source) => {
      const stats = await fs.stat(source.inputPath);
      const fingerprint = createSourceFingerprint(stats);
      const previous = previousByKey.get(source.sourceKey) || null;
      const snapshotPath = getSemanticPaperSnapshotPath(rootPath, source.sourceKey);
      const snapshotExists = await fileExists(snapshotPath);
      let cachedPaper = null;
      let reuseCachedMaterialization = false;

      if (snapshotExists) {
        cachedPaper = await loadSemanticPaperSnapshot(rootPath, source.sourceKey);
        if (cachedPaper?.sourceFingerprint !== fingerprint) {
          cachedPaper = null;
        }
      }

      let changeType = 'unchanged';
      if (options.force || manifestVersionMismatch || !previous || !snapshotExists) {
        changeType = previous ? 'updated' : 'added';
        if (!options.force && cachedPaper && !shouldRetryFailedLlmSnapshot(cachedPaper, analysisOptions)) {
          reuseCachedMaterialization = true;
        }
      } else if (previous.fingerprint !== fingerprint || previous.kind !== source.kind) {
        changeType = 'updated';
        if (cachedPaper && !shouldRetryFailedLlmSnapshot(cachedPaper, analysisOptions)) {
          reuseCachedMaterialization = true;
        }
      } else {
        if (!cachedPaper || shouldRetryFailedLlmSnapshot(cachedPaper, analysisOptions)) {
          changeType = 'updated';
        }
      }

      return {
        ...source,
        fingerprint,
        previous,
        changeType,
        cachedPaper,
        reuseCachedMaterialization
      };
    });
    const sourceStateByKey = new Map(sourceStates.map((source) => [source.sourceKey, source]));

    const removedSources = (previousManifest?.sources || []).filter((entry) => !currentKeys.has(entry.sourceKey));
    const changes = summarizeSourceChanges(sourceStates, removedSources);

    if (!options.force && !hasSourceChanges(changes) && previousIndexExists) {
      const existing = await loadCorpus(rootPath);
      await registerCorpus({
        name: existing.meta.name || corpusName,
        rootPath,
        indexedAt: existing.meta.indexedAt,
        paperCount: existing.meta.paperCount
      });
      return {
        graph: existing.graph,
        meta: {
          ...existing.meta,
          lastChangeSummary: changes
        },
        rootPath,
        changes,
        reused: true
      };
    }

    const { semanticPapers, manifestSources, failedSources } = await materializeSourceStates(rootPath, sourceStates, analysisOptions);
    const activeManifestSources = manifestSources.filter((entry) => entry.activeInGraph !== false);

    await mapWithConcurrency(removedSources, metadataConcurrency, async (removedSource) => {
      await removeSemanticPaperSnapshot(rootPath, removedSource.sourceKey);
      return removedSource.sourceKey;
    });

    semanticPapers.sort((left, right) => left.paperTitle.localeCompare(right.paperTitle));
    manifestSources.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

    if (!semanticPapers.length) {
      const firstFailure = failedSources[0];
      throw new Error(firstFailure?.message || `No papers could be materialized from ${inputLabel}.`);
    }

    const sourceMode = discovery.sources.length
      ? discovery.sourceMode
      : (previousManifest?.sourceMode || 'markdown');
    const hasPdfSources = discovery.sources.some((source) => source.kind === 'pdf');
    const pdfParser = hasPdfSources
      ? normalizePdfParser(firstDefinedValue(options.pdfParser, previousManifest?.pdfParser))
      : (previousManifest?.pdfParser || null);
    const { graph, problemNodes, acceptedCrossPaperJudgments } = await buildGraphFromSemanticPapers({
      corpusName,
      rootPath,
      semanticPapers,
      options: analysisOptions
    });
    const pdfCommand = hasPdfSources
      ? (pdfParser === 'marker'
          ? firstDefinedValue(
            options.pdfCommand,
            options.markerCommand,
            previousManifest?.pdfCommand,
            previousManifest?.markerCommand,
            process.env.PAPERNEXUS_MARKER_CMD,
            'marker_single'
          )
          : pdfParser === 'mineru'
            ? firstDefinedValue(
              options.pdfCommand,
              options.mineruCommand,
              previousManifest?.pdfCommand,
              previousManifest?.mineruCommand,
              process.env.PAPERNEXUS_MINERU_CMD,
              ''
            )
            : firstDefinedValue(
              options.pdfCommand,
              options.doclingCommand,
              previousManifest?.pdfCommand,
              process.env.PAPERNEXUS_DOCLING_CMD,
              'docling'
            ))
      : (previousManifest?.pdfCommand || previousManifest?.markerCommand || null);

    const meta = await createMeta({
      name: corpusName,
      rootPath,
      graph,
      sourceMode,
      problems: problemNodes,
      semanticPapers,
      pdfParser,
      pdfCommand,
      semanticExtractionMode: normalizedSemanticExtractionMode,
      changes,
      acceptedCrossPaperJudgments,
      failedSources,
      sourceCount: manifestSources.length
    });

    await saveCorpus(rootPath, graph, meta, {
      liteViewMode: 'incremental',
      liteViewSources: activeManifestSources
    });
    await saveSourceManifest(rootPath, createEmptyManifest({
      corpusName,
      rootPath,
      inputPath: absoluteInput,
      inputPaths: absoluteInputs,
      sourceMode,
      pdfParser,
      pdfCommand,
      semanticExtractionMode: normalizedSemanticExtractionMode,
      sources: manifestSources,
      indexedAt: meta.indexedAt
    }));
    await registerCorpus({
      name: corpusName,
      rootPath,
      indexedAt: meta.indexedAt,
      paperCount: meta.paperCount
    });

    let enhancement = null;
    if (analysisOptions.enqueueEnhancements !== false) {
      try {
        await pruneEnhancementsForManifest(rootPath, activeManifestSources);
        const changedEntries = activeManifestSources.filter((entry) => {
          const state = sourceStateByKey.get(entry.sourceKey);
          return state && state.changeType !== 'unchanged';
        }).map((entry) => ({
          paperId: entry.paperId,
          paperTitle: entry.paperTitle,
          sourceKey: entry.sourceKey,
          sourceFingerprint: entry.fingerprint,
          sourceMarkdownPath: entry.sourceMarkdownPath,
          trigger: 'ingestion',
          priority: 60
        }));

        enhancement = await enqueuePaperEnhancements(rootPath, changedEntries, {
          trigger: 'ingestion',
          priority: 60
        });
      } catch (error) {
        console.warn(`[enhance] ${error.message}`);
      }
    }

    return {
      graph,
      meta,
      rootPath,
      changes,
      reused: false,
      enhancement
    };
  }, options.lockOptions);
}

function isRelevantWatchPath(filename) {
  if (!filename) return true;

  const normalized = String(filename).replace(/\\/g, '/');
  if (
    normalized.startsWith('.papernexus/')
    || normalized === '.papernexus'
    || normalized.includes('/.papernexus/')
    || normalized.startsWith('.papernexus-home/')
    || normalized.includes('/.papernexus-home/')
    || normalized.startsWith('.git/')
    || normalized.includes('/.git/')
    || normalized.startsWith('node_modules/')
    || normalized.includes('/node_modules/')
  ) {
    return false;
  }

  const extension = path.extname(normalized).toLowerCase();
  return !extension || WATCHABLE_EXTENSIONS.has(extension);
}

export async function watchCorpus(inputPath, options = {}) {
  const initialResult = await analyzeCorpus(inputPath, options);
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const watchTargets = unique(discovery.inputEntries.map((entry) => (
    entry.inputStats.isDirectory() ? entry.inputPath : path.dirname(entry.inputPath)
  )));
  const debounceMs = Math.max(150, Number(options.debounceMs || 700));
  const pollIntervalMs = Math.max(800, Number(options.pollIntervalMs || 3000));
  const logger = createWatchTmpLogger(discovery.rootPath);

  logger.info(`[watch] Automatic graph build log: ${logger.logPath}`);
  logger.info(`[watch] Initial index ready for "${initialResult.meta.name}" (${formatChangeSummary(initialResult.changes)})`);

  let timer = null;
  let running = false;
  let queued = false;
  let closed = false;
  let watchers = [];
  let intervalHandle = null;

  const startPollingFallback = (reason) => {
    if (intervalHandle || closed) return;
    if (watchers.length) {
      for (const watcher of watchers) {
        watcher.close();
      }
      watchers = [];
    }
    logger.warn(`[watch] ${reason}. Falling back to polling every ${pollIntervalMs}ms.`);
    intervalHandle = setInterval(() => {
      runReindex('poll');
    }, pollIntervalMs);
  };

  const runReindex = async (reason) => {
    if (closed) return;
    if (running) {
      queued = true;
      return;
    }

    running = true;
    try {
      const result = await analyzeCorpus(inputPath, {
        ...options,
        force: false
      });

      if (result.reused) {
        if (reason !== 'poll') {
          logger.info(`[watch] No source changes detected (${reason}).`);
        }
      } else {
        logger.info(`[watch] Reindexed "${result.meta.name}" (${formatChangeSummary(result.changes)})`);
      }
    } catch (error) {
      logger.error(`[watch] ${error.message}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        scheduleReindex('queued');
      }
    }
  };

  const scheduleReindex = (reason) => {
    if (closed) return;
    clearTimeout(timer);
    if (reason !== 'poll') {
      logger.info(`[watch] Scheduled reindex (${reason})`);
    }
    timer = setTimeout(() => {
      runReindex(reason);
    }, debounceMs);
  };

  try {
    for (const watchTarget of watchTargets) {
      const watcher = fsSync.watch(watchTarget, { recursive: true }, (eventType, filename) => {
        if (!isRelevantWatchPath(filename)) return;
        scheduleReindex(`${eventType}${filename ? `:${filename}` : ''}`);
      });
      watcher.on('error', (error) => {
        startPollingFallback(`fs.watch failed for ${watchTarget} (${error.message})`);
      });
      watchers.push(watcher);
    }
    logger.info(`[watch] Watching ${watchTargets.join(', ')} for PDF/Markdown changes.`);
  } catch (error) {
    startPollingFallback(`fs.watch unavailable (${error.message})`);
  }

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (intervalHandle) clearInterval(intervalHandle);
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers = [];
    void logger.flush();
  };

  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return {
    ...initialResult,
    stop: cleanup
  };
}

export const __pipelineTestables = {
  resolveAnalyzeConcurrency,
  resolveMarkerConcurrency
};
