import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createKnowledgeGraph } from '../graph/graph.js';
import { applyNodeCheckDecisions, mergeSimilarGraphNodes } from '../graph/merge-similar.js';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from '../graph/schema.js';
import { applyGraphDeltaPayload, buildGraphDeltaPayload } from '../graph/delta-commit.js';
import {
  adjudicateCrossPaperCandidates,
  inferGraphNodeChecksBatch,
  inferPaperResearchSemanticsBatch,
  inferPaperSemanticObjectsBatch,
  normalizeSemanticExtractionMode,
  resolveSemanticExtractionPlan,
  resolveOllamaConfig
} from '../llm/ollama.js';
import { collectFiles, fileExists, readJson, readText, withFileLock } from '../../lib/fs.js';
import { jaccardSimilarity, normalizeText, slugify, stableHash, titleCase, tokenizeWithoutStopwords, truncate, unique } from '../../lib/utils.js';
import { createWatchTmpLogger } from '../../lib/watch-log.js';
import {
  backupExistingCorpusRoot,
  getCorpusLockPath,
  getCorpusPaths,
  loadCrossPaperJudgmentCache,
  getSemanticPaperSnapshotPath,
  hasCorpusGraphStore,
  loadCorpus,
  loadCorpusMeta,
  loadCorpusLite,
  loadStagedCorpusBuild,
  loadSourceManifest,
  loadStage2JobState,
  loadSemanticPaperSnapshot,
  removeStagedCorpusBuild,
  removeStage2JobState,
  resolveGraphStorageMode,
  removeSemanticPaperSnapshot,
  saveCorpus,
  saveCorpusFastLocalDelta,
  saveCrossPaperJudgmentCache,
  saveSemanticPaperSnapshot,
  saveSourceManifest,
  saveStage2JobState,
  saveStagedCorpusBuild
} from '../../storage/corpus-store.js';
import { enqueuePaperEnhancements, pruneEnhancementsForManifest } from '../../storage/enhancement-store.js';
import { listActiveImportSourceDirs } from '../../storage/import-store.js';
import { registerCorpus } from '../../storage/registry.js';
import {
  cacheMarkdownSource,
  convertPdfToMarkdown,
  getMarkdownSourceCachePath,
  getPdfMarkdownCachePath,
  normalizePdfParser
} from './marker.js';
import { extractConceptCandidates, parsePaperMarkdown } from './markdown.js';
import { precomputePaperGraphFragments } from './graph-precompute.js';
import { countGraphPostprocessTasks, precomputeGraphPostprocess } from './graph-postprocess.js';

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

const NODE_LLM_CHECK_ENABLED = false;
const SNAPSHOT_STATE_SIGNATURE_VERSION = 1;
const SEMANTIC_LLM_SIGNATURE_VERSION = 1;
const RELATION_LLM_SIGNATURE_VERSION = 1;
const STAGE2_JOB_STATE_VERSION = 1;

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
  let redrawTimer = null;
  let lastLabel = '';

  const formatTime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m${secs}s`;
  };

  const draw = (force = false) => {
    if (quiet || !process.stdout.isTTY) return;

    const now = Date.now();
    if (!force && now - lastDrawTime < minDrawInterval && current < total) return;
    lastDrawTime = now;

    const safeTotal = Math.max(1, total);
    const displayCurrent = Math.min(current, safeTotal);
    const percent = Math.floor((displayCurrent / safeTotal) * 100);
    const width = 30;
    const filled = Math.floor((percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

    const elapsed = now - startTime;
    const rate = displayCurrent > 0 ? elapsed / displayCurrent : 0;
    const remaining = Math.max(0, safeTotal - displayCurrent) * rate;
    const eta = displayCurrent >= safeTotal ? '0s' : formatTime(remaining);

    const elapsedStr = formatTime(elapsed);

    const labelSuffix = lastLabel ? ` - ${lastLabel}` : '';
    process.stdout.write(`\r${prefix}: [${bar}] ${displayCurrent}/${safeTotal} (${percent}%) - ETA: ${eta} - Elapsed: ${elapsedStr}${labelSuffix}   `);
  };

  return {
    start() {
      if (!quiet && process.stdout.isTTY && !redrawTimer) {
        redrawTimer = setInterval(() => {
          draw();
        }, 1000);
      }
      draw(true);
    },
    tick(label = '') {
      current += 1;
      if (label) {
        lastLabel = String(label);
      }
      draw();
    },
    update(completed, label = '') {
      current = completed;
      if (label !== undefined) {
        lastLabel = String(label || '');
      }
      draw(true);
    },
    setLabel(label = '') {
      lastLabel = String(label || '');
      draw(true);
    },
    setTotal(nextTotal, label) {
      total = Math.max(1, Number(nextTotal || total));
      if (label !== undefined) {
        lastLabel = String(label || '');
      }
      draw(true);
    },
    getCurrent() {
      return current;
    },
    done() {
      current = total;
      lastLabel = '';
      draw(true);
      if (redrawTimer) {
        clearInterval(redrawTimer);
        redrawTimer = null;
      }
      if (quiet || !process.stdout.isTTY) return;
      const elapsed = formatTime(Date.now() - startTime);
      process.stdout.write(`\r${prefix}: [${'█'.repeat(30)}] ${total}/${total} (100%) - Done in ${elapsed}   \n`);
    },
    stop() {
      if (redrawTimer) {
        clearInterval(redrawTimer);
        redrawTimer = null;
      }
      if (!quiet && process.stdout.isTTY) {
        process.stdout.write('\n');
      }
    }
  };
}

function createQuietProgress() {
  return {
    start() {},
    tick() {},
    update() {},
    setLabel() {},
    setTotal() {},
    getCurrent() { return 0; },
    done() {},
    stop() {}
  };
}

function announceStage(options = {}, step, total, title, detail = '') {
  const quiet = Boolean(options.quiet);
  if (quiet) return;
  const suffix = detail ? ` - ${detail}` : '';
  if (process.stdout.isTTY) {
    process.stdout.write(`\nStage ${step}/${total}: ${title}${suffix}\n`);
    return;
  }
  console.log(`Stage ${step}/${total}: ${title}${suffix}`);
}

function logPipelineEvent(options = {}, message) {
  if (options.quiet) return;
  console.log(message);
}

function createLockProgressHandlers(options = {}, configure = {}) {
  const resolveText = (value, info = {}) => {
    if (typeof value === 'function') return value(info);
    return typeof value === 'string' ? value : '';
  };

  return {
    onWait(info = {}) {
      const label = resolveText(configure.onWaitLabel, info);
      if (label && typeof configure.setLabel === 'function') {
        configure.setLabel(label);
      }
      const message = resolveText(configure.onWaitLog, info);
      if (message) {
        logPipelineEvent(options, message);
      }
    },
    onAcquired(info = {}) {
      const label = resolveText(configure.onAcquiredLabel, info);
      if (label && typeof configure.setLabel === 'function') {
        configure.setLabel(label);
      }
      const message = resolveText(configure.onAcquiredLog, info);
      if (message) {
        logPipelineEvent(options, message);
      }
    }
  };
}

function mergeLockOptions(lockOptions = {}, extraHandlers = {}) {
  const merged = {
    ...(lockOptions || {})
  };

  for (const key of ['onWait', 'onAcquired']) {
    const original = lockOptions?.[key];
    const extra = extraHandlers?.[key];
    if (original && extra) {
      merged[key] = (info = {}) => {
        original(info);
        extra(info);
      };
    } else if (extra) {
      merged[key] = extra;
    }
  }

  return merged;
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

function createSemanticConfigSignature(options = {}) {
  const plan = resolveSemanticExtractionPlan(options);
  if (!plan.shouldAttempt || plan.requestedMode === 'heuristic-only') {
    return `semantic:${SEMANTIC_LLM_SIGNATURE_VERSION}:disabled:${plan.requestedMode}`;
  }

  return JSON.stringify({
    kind: 'semantic',
    version: SEMANTIC_LLM_SIGNATURE_VERSION,
    requestedMode: plan.requestedMode,
    effectiveMode: plan.effectiveMode,
    provider: plan.config?.provider || 'disabled',
    model: plan.config?.model || '',
    baseUrl: plan.config?.baseUrl || ''
  });
}

function createRelationConfigSignature(options = {}) {
  if (!canAttemptLlmRelations(options)) {
    return `relations:${RELATION_LLM_SIGNATURE_VERSION}:disabled`;
  }

  const config = resolveOllamaConfig(options);
  return JSON.stringify({
    kind: 'relations',
    version: RELATION_LLM_SIGNATURE_VERSION,
    provider: config.provider || 'disabled',
    model: config.model || '',
    baseUrl: config.baseUrl || ''
  });
}

function serializeSnapshotSlotEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      name: String(entry?.name || entry?.text || '').trim(),
      evidenceText: String(entry?.evidenceText || entry?.text || '').trim(),
      sectionHeading: String(entry?.sectionHeading || '').trim(),
      sectionRole: String(entry?.sectionRole || '').trim(),
      confidence: Number.isFinite(Number(entry?.confidence)) ? Number(entry.confidence) : null
    }))
    .filter((entry) => entry.name || entry.evidenceText)
    .sort((left, right) => `${left.name}:${left.evidenceText}`.localeCompare(`${right.name}:${right.evidenceText}`));
}

function serializeSnapshotRelations(relations = []) {
  return (relations || [])
    .map((relation) => ({
      type: String(relation?.type || '').trim(),
      sourceType: String(relation?.sourceType || '').trim(),
      sourceName: String(relation?.sourceName || '').trim(),
      targetType: String(relation?.targetType || '').trim(),
      targetName: String(relation?.targetName || '').trim(),
      evidenceText: String(relation?.evidenceText || '').trim()
    }))
    .filter((relation) => relation.type && relation.sourceName && relation.targetName)
    .sort((left, right) => (
      `${left.type}:${left.sourceType}:${left.sourceName}:${left.targetType}:${left.targetName}`
    ).localeCompare(
      `${right.type}:${right.sourceType}:${right.sourceName}:${right.targetType}:${right.targetName}`
    ));
}

function createSemanticPaperSnapshotStateSignature(semanticPaper = {}) {
  return stableHash(JSON.stringify({
    version: SNAPSHOT_STATE_SIGNATURE_VERSION,
    paperId: semanticPaper.paperId || '',
    sourceFingerprint: semanticPaper.sourceFingerprint || '',
    semanticConfigSignature: semanticPaper.llmSemanticObjects?.configSignature || semanticPaper.llm?.semanticConfigSignature || null,
    relationConfigSignature: semanticPaper.llm?.relationConfigSignature || null,
    semanticObjects: {
      problems: serializeSnapshotSlotEntries(semanticPaper.problems),
      methods: serializeSnapshotSlotEntries(semanticPaper.methods),
      claims: serializeSnapshotSlotEntries(semanticPaper.claims),
      findings: serializeSnapshotSlotEntries(semanticPaper.findings),
      researchGoals: serializeSnapshotSlotEntries(semanticPaper.researchGoals),
      limitations: serializeSnapshotSlotEntries(semanticPaper.limitations),
      assumptions: serializeSnapshotSlotEntries(semanticPaper.assumptions),
      evidences: serializeSnapshotSlotEntries(semanticPaper.evidences),
      futureDirections: serializeSnapshotSlotEntries(semanticPaper.futureDirections),
      benchmarks: serializeSnapshotSlotEntries(semanticPaper.benchmarks),
      datasets: serializeSnapshotSlotEntries(semanticPaper.datasets),
      metrics: serializeSnapshotSlotEntries(semanticPaper.metrics)
    },
    relations: serializeSnapshotRelations(semanticPaper.llmRelations),
    llm: {
      provider: semanticPaper.llm?.provider || 'disabled',
      relationCount: Number(semanticPaper.llm?.relationCount || 0),
      semanticExtractionMode: semanticPaper.llm?.semanticExtractionMode || 'heuristic-only',
      semanticExtractionModeEffective: semanticPaper.llm?.semanticExtractionModeEffective || 'heuristic-only',
      semanticExtractionAttempted: Boolean(semanticPaper.llm?.semanticExtractionAttempted),
      semanticExtractionParticipated: Boolean(semanticPaper.llm?.semanticExtractionParticipated),
      semanticExtractionParticipationReason: semanticPaper.llm?.semanticExtractionParticipationReason || null,
      semanticObjectCount: Number(semanticPaper.llm?.semanticObjectCount || 0),
      error: semanticPaper.llm?.error || null
    }
  }), 20);
}

function summarizeLlmRefreshState(snapshot, options = {}, maxRetries = 3) {
  if (!snapshot) {
    return {
      semanticRequired: false,
      relationRequired: false,
      anyRequired: false
    };
  }

  const semanticRetryCount = snapshot.llm?.semanticRetryCount ?? snapshot.llm?.retryCount ?? 0;
  const relationRetryCount = snapshot.llm?.relationRetryCount ?? snapshot.llm?.retryCount ?? 0;
  const semanticPlan = resolveSemanticExtractionPlan(options);
  const semanticSummary = summarizePaperSemanticExtraction(snapshot, semanticPlan.requestedMode);
  const currentSemanticSignature = createSemanticConfigSignature(options);
  const snapshotSemanticSignature = snapshot.llmSemanticObjects?.configSignature
    || snapshot.llm?.semanticConfigSignature
    || null;
  const semanticConfiguredNow = semanticPlan.shouldAttempt && semanticPlan.requestedMode !== 'heuristic-only';
  const semanticMissingForCurrentConfig = semanticConfiguredNow
    && snapshotSemanticSignature !== currentSemanticSignature;
  const semanticRetryableFailure = semanticConfiguredNow
    && semanticRetryCount < maxRetries
    && !semanticSummary.participated
    && ['request-failed', 'llm-unconfigured'].includes(semanticSummary.reason);

  const relationConfiguredNow = canAttemptLlmRelations(options);
  const currentRelationSignature = createRelationConfigSignature(options);
  const snapshotRelationSignature = snapshot.llm?.relationConfigSignature || null;
  const relationPreviouslyAttemptedForCurrentConfig = relationConfiguredNow
    && snapshotRelationSignature === currentRelationSignature;
  const relationMissingForCurrentConfig = relationConfiguredNow && !relationPreviouslyAttemptedForCurrentConfig;
  const relationRetryableFailure = relationConfiguredNow
    && relationRetryCount < maxRetries
    && relationPreviouslyAttemptedForCurrentConfig
    && Boolean(snapshot.llm?.error)
    && Number(snapshot.llm?.relationCount || 0) === 0;

  const semanticRequired = semanticMissingForCurrentConfig || semanticRetryableFailure;
  const relationRequired = relationMissingForCurrentConfig || relationRetryableFailure;

  return {
    semanticRequired,
    relationRequired,
    anyRequired: semanticRequired || relationRequired
  };
}

function snapshotNeedsLlmRefresh(snapshot, options = {}, maxRetries = 3) {
  return summarizeLlmRefreshState(snapshot, options, maxRetries).anyRequired;
}

function applySemanticObjectInference(semanticPaper, semanticObjects, semanticExtractionPlan) {
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

  return {
    semanticExtractionMode,
    semanticObjectCount
  };
}

function finalizeSemanticPaperLlmMetadata(semanticPaper, semanticObjects, inference, semanticExtractionPlan, semanticExtractionMode, semanticObjectCount, options = {}) {
  if (inference.relations.length || inference.findings.length || inference.benchmarks.length || inference.researchGoals.length) {
    semanticPaper.benchmarks = mergeSemanticSlots(semanticPaper.benchmarks, inference.benchmarks, 8);
    semanticPaper.findings = mergeSemanticSlots(semanticPaper.findings, inference.findings, 8);
    semanticPaper.researchGoals = mergeSemanticSlots(semanticPaper.researchGoals, inference.researchGoals, 4);
  }

  semanticPaper.llm = {
    provider: inference.provider !== 'disabled' ? inference.provider : semanticObjects.provider,
    error: inference.error || semanticObjects.error,
    relationCount: inference.relations.length,
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
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
    configSignature: createSemanticConfigSignature(options),
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
  applySemanticAdmissionPolicy(semanticPaper);
  return semanticPaper;
}

async function enrichMaterializedSourcesWithOllama(rootPath, materializedSources, options = {}) {
  const records = materializedSources.filter((record) => record.semanticPaper);
  const semanticPending = records.filter((record) => record.parsedPaper && record.sourceState.llmRefreshState?.semanticRequired);
  const relationPending = records.filter((record) => record.parsedPaper && record.sourceState.llmRefreshState?.relationRequired);
  if (!semanticPending.length && !relationPending.length) {
    for (const record of records) {
      applySemanticAdmissionPolicy(record.semanticPaper);
      await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
    }
    return;
  }

  const quiet = Boolean(options.quiet);
  announceStage(
    options,
    options.llmStageStep || 2,
    options.llmStageTotal || 4,
    options.llmStageTitle || 'Batch LLM optimization',
    options.llmStageDetail || 'semantic objects and relation extraction'
  );
  const semanticExtractionPlan = resolveSemanticExtractionPlan(options);
  const formatBatchLabel = (event = {}, total) => {
    const batchNumber = Math.max(1, Number(event.batchNumber || 0));
    const totalBatches = Math.max(1, Number(event.totalBatches || 0));
    const completed = Math.min(Number(event.completed || 0), total);
    return `batch ${batchNumber}/${totalBatches}, ${completed}/${total} papers completed`;
  };
  const semanticConfigSignature = createSemanticConfigSignature(options);
  const relationConfigSignature = createRelationConfigSignature(options);

  if (semanticPending.length) {
    const semanticProgress = quiet ? createQuietProgress() : createProgressBar(semanticPending.length, { prefix: 'Semantic extraction' });
    semanticProgress.start();
    const semanticBatchResults = await inferPaperSemanticObjectsBatch(
      semanticPending.map((record) => ({
        id: record.sourceState.sourceKey,
        parsedPaper: record.parsedPaper,
        semanticPaper: record.semanticPaper
      })),
      {
        ...options,
        onBatchComplete(event = {}) {
          semanticProgress.update(
            Math.min(Number(event.completed || 0), semanticPending.length),
            formatBatchLabel(event, semanticPending.length)
          );
        }
      }
    );

    for (let index = 0; index < semanticPending.length; index += 1) {
      const record = semanticPending[index];
      const semanticObjects = semanticBatchResults[index];
      const { semanticExtractionMode, semanticObjectCount } = applySemanticObjectInference(
        record.semanticPaper,
        semanticObjects,
        semanticExtractionPlan
      );
      const previousLlm = record.semanticPaper.llm || {};
      const semanticFailed = Boolean(semanticObjects.error) && !semanticObjects.participated;
      record.semanticPaper.llm = {
        ...previousLlm,
        provider: previousLlm.provider && previousLlm.provider !== 'disabled'
          ? previousLlm.provider
          : semanticObjects.provider,
        semanticConfigSignature,
        semanticExtractionMode: semanticExtractionPlan.requestedMode,
        semanticExtractionModeEffective: semanticExtractionMode,
        semanticExtractionAttempted: semanticObjects.attempted,
        semanticExtractionParticipated: semanticObjects.participated,
        semanticExtractionParticipationReason: semanticObjects.reason,
        semanticObjectCount,
        semanticRetryCount: semanticFailed ? Number(previousLlm.semanticRetryCount || 0) + 1 : 0
      };
      record.semanticPaper.llmSemanticObjects = {
        ...semanticObjects,
        configSignature: semanticConfigSignature
      };
    }
    semanticProgress.done();
  }

  if (relationPending.length) {
    const relationProgress = quiet ? createQuietProgress() : createProgressBar(relationPending.length, { prefix: 'Relation extraction' });
    relationProgress.start();
    const relationBatchResults = await inferPaperResearchSemanticsBatch(
      relationPending.map((record) => ({
        id: record.sourceState.sourceKey,
        parsedPaper: record.parsedPaper,
        semanticPaper: record.semanticPaper
      })),
      {
        ...options,
        onBatchComplete(event = {}) {
          relationProgress.update(
            Math.min(Number(event.completed || 0), relationPending.length),
            formatBatchLabel(event, relationPending.length)
          );
        }
      }
    );

    for (let index = 0; index < relationPending.length; index += 1) {
      const record = relationPending[index];
      const inference = relationBatchResults[index];
      if (inference.relations.length || inference.findings.length || inference.benchmarks.length || inference.researchGoals.length) {
        record.semanticPaper.benchmarks = mergeSemanticSlots(record.semanticPaper.benchmarks, inference.benchmarks, 8);
        record.semanticPaper.findings = mergeSemanticSlots(record.semanticPaper.findings, inference.findings, 8);
        record.semanticPaper.researchGoals = mergeSemanticSlots(record.semanticPaper.researchGoals, inference.researchGoals, 4);
      }
      const previousLlm = record.semanticPaper.llm || {};
      const relationFailed = Boolean(inference.error) && Number(inference.relations.length || 0) === 0;
      record.semanticPaper.llm = {
        ...previousLlm,
        provider: inference.provider !== 'disabled' ? inference.provider : previousLlm.provider,
        error: inference.error || null,
        relationCount: inference.relations.length,
        relationConfigSignature,
        relationRetryCount: relationFailed ? Number(previousLlm.relationRetryCount || 0) + 1 : 0
      };
      record.semanticPaper.llmRelations = inference.relations;
    }
    relationProgress.done();
  }

  for (const record of records) {
    applySemanticAdmissionPolicy(record.semanticPaper);
    await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
  }
}

async function ensureParsedPaperForLlmRecord(record) {
  if (record.parsedPaper) return record.parsedPaper;
  record.parsedPaper = await loadParsedPaperFromMarkdownCache(record.sourceState, record.semanticPaper);
  if (!record.parsedPaper) {
    throw new Error(`Markdown cache missing for ${record.sourceState.sourceKey}. Run Stage 1 before Stage 2.`);
  }
  return record.parsedPaper;
}

function applySemanticBatchResultToRecord(record, semanticObjects, semanticExtractionPlan, options = {}) {
  const { semanticExtractionMode, semanticObjectCount } = applySemanticObjectInference(
    record.semanticPaper,
    semanticObjects,
    semanticExtractionPlan
  );
  const previousLlm = record.semanticPaper.llm || {};
  const semanticFailed = Boolean(semanticObjects.error) && !semanticObjects.participated;
  record.semanticPaper.llm = {
    ...previousLlm,
    provider: previousLlm.provider && previousLlm.provider !== 'disabled'
      ? previousLlm.provider
      : semanticObjects.provider,
    semanticConfigSignature: createSemanticConfigSignature(options),
    semanticExtractionMode: semanticExtractionPlan.requestedMode,
    semanticExtractionModeEffective: semanticExtractionMode,
    semanticExtractionAttempted: semanticObjects.attempted,
    semanticExtractionParticipated: semanticObjects.participated,
    semanticExtractionParticipationReason: semanticObjects.reason,
    semanticObjectCount,
    semanticRetryCount: semanticFailed ? Number(previousLlm.semanticRetryCount || 0) + 1 : 0
  };
  record.semanticPaper.llmSemanticObjects = {
    ...semanticObjects,
    configSignature: createSemanticConfigSignature(options)
  };
  applySemanticAdmissionPolicy(record.semanticPaper);
  return {
    status: semanticFailed ? 'failed' : 'completed',
    error: semanticObjects.error || null
  };
}

function applyRelationBatchResultToRecord(record, inference, options = {}) {
  if (inference.relations.length || inference.findings.length || inference.benchmarks.length || inference.researchGoals.length) {
    record.semanticPaper.benchmarks = mergeSemanticSlots(record.semanticPaper.benchmarks, inference.benchmarks, 8);
    record.semanticPaper.findings = mergeSemanticSlots(record.semanticPaper.findings, inference.findings, 8);
    record.semanticPaper.researchGoals = mergeSemanticSlots(record.semanticPaper.researchGoals, inference.researchGoals, 4);
  }
  const previousLlm = record.semanticPaper.llm || {};
  const relationFailed = Boolean(inference.error) && Number(inference.relations.length || 0) === 0;
  record.semanticPaper.llm = {
    ...previousLlm,
    provider: inference.provider !== 'disabled' ? inference.provider : previousLlm.provider,
    error: inference.error || null,
    relationCount: inference.relations.length,
    relationConfigSignature: createRelationConfigSignature(options),
    relationRetryCount: relationFailed ? Number(previousLlm.relationRetryCount || 0) + 1 : 0
  };
  record.semanticPaper.llmRelations = inference.relations;
  applySemanticAdmissionPolicy(record.semanticPaper);
  return {
    status: relationFailed ? 'failed' : 'completed',
    error: inference.error || null
  };
}

function seedStage2JobStateFromRecords(jobState, records) {
  for (const record of records) {
    const paperStatus = getOrCreateStage2PaperStatus(jobState, record.sourceState.sourceKey);
    paperStatus.semantic = {
      status: record.sourceState.llmRefreshState.semanticRequired ? 'pending' : 'completed',
      updatedAt: paperStatus.semantic?.updatedAt || null,
      error: paperStatus.semantic?.error || null
    };
    paperStatus.relation = {
      status: record.sourceState.llmRefreshState.relationRequired ? 'pending' : 'completed',
      updatedAt: paperStatus.relation?.updatedAt || null,
      error: paperStatus.relation?.error || null
    };
  }
  refreshStage2PhaseStatus(jobState, records, 'semantic');
  refreshStage2PhaseStatus(jobState, records, 'relation');
}

function createStage2ManifestFromRecords(rootPath, manifest, records, options = {}) {
  const nextManifest = createEmptyManifest({
    corpusName: manifest.corpusName || options.name || path.basename(rootPath),
    rootPath,
    inputPath: manifest.inputPath,
    inputPaths: manifest.inputPaths,
    sourceMode: manifest.sourceMode || 'markdown',
    pdfParser: manifest.pdfParser || null,
    pdfCommand: manifest.pdfCommand || manifest.markerCommand || manifest.mineruCommand || null,
    semanticExtractionMode: normalizeSemanticExtractionMode(
      firstDefinedValue(options.semanticExtraction, manifest.semanticExtractionMode, 'auto')
    ),
    sources: records.map((record) => buildManifestEntry(rootPath, record.sourceState, record.semanticPaper, record.manifestEntry.markerCommand || null, {
      dedupedBy: record.manifestEntry.dedupedBy || null
    })),
    indexedAt: new Date().toISOString(),
    changes: manifest.lastChangeSummary || null
  });
  if (options.completed !== false) {
    nextManifest.llmOptimization = buildLlmOptimizationState(nextManifest, options);
  }
  nextManifest.sources.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return nextManifest;
}

async function runStage2LlmOptimization(rootPath, manifest, records, options = {}, existingJobState = null) {
  const quiet = Boolean(options.quiet);
  const semanticExtractionPlan = resolveSemanticExtractionPlan(options);
  const normalizedSemanticExtractionMode = normalizeSemanticExtractionMode(
    firstDefinedValue(options.semanticExtraction, manifest.semanticExtractionMode, 'auto')
  );
  const jobState = existingJobState && existingJobState.token === createStage2JobToken(manifest, options)
    ? existingJobState
    : createStage2JobState(manifest, options);

  seedStage2JobStateFromRecords(jobState, records);
  await saveStage2JobState(rootPath, jobState);

  const initialSemanticPending = records.filter((record) => record.sourceState.llmRefreshState.semanticRequired);
  const semanticPending = [];
  for (const record of initialSemanticPending) {
    await ensureParsedPaperForLlmRecord(record);
    semanticPending.push(record);
  }

  const batchSize = Math.max(1, Number(firstDefinedValue(options.llmBatchSize, options.batchSize, 8)));
  announceStage(
    options,
    options.llmStageStep || 1,
    options.llmStageTotal || 1,
    options.llmStageTitle || 'Batch LLM optimization',
    options.llmStageDetail || 'semantic objects and relation extraction'
  );

  const formatBatchLabel = (batchNumber, totalBatches, completed, total) =>
    `batch ${batchNumber}/${Math.max(1, totalBatches)}, ${Math.min(completed, total)}/${total} papers completed`;

  if (semanticPending.length) {
    const semanticProgress = quiet ? createQuietProgress() : createProgressBar(semanticPending.length, { prefix: 'Semantic extraction' });
    semanticProgress.start();
    jobState.phases.semantic = {
      ...jobState.phases.semantic,
      status: 'running',
      total: semanticPending.length,
      completed: 0,
      batchCount: Math.ceil(semanticPending.length / batchSize),
      lastBatchNumber: 0
    };
    await saveStage2JobState(rootPath, jobState);

    const totalBatches = Math.max(1, Math.ceil(semanticPending.length / batchSize));
    for (let start = 0; start < semanticPending.length; start += batchSize) {
      const batchRecords = semanticPending.slice(start, start + batchSize);
      const semanticBatchResults = await inferPaperSemanticObjectsBatch(
        batchRecords.map((record) => ({
          id: record.sourceState.sourceKey,
          parsedPaper: record.parsedPaper,
          semanticPaper: record.semanticPaper
        })),
        {
          ...options,
          llmBatchSize: batchSize
        }
      );

      for (let index = 0; index < batchRecords.length; index += 1) {
        const record = batchRecords[index];
        const summary = applySemanticBatchResultToRecord(record, semanticBatchResults[index], semanticExtractionPlan, options);
        await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
        updateStage2PaperPhase(jobState, record.sourceState.sourceKey, 'semantic', summary.status, summary.error);
      }

      jobState.phases.semantic.lastBatchNumber = Math.floor(start / batchSize) + 1;
      refreshStage2PhaseStatus(jobState, semanticPending, 'semantic');
      await saveStage2JobState(rootPath, jobState);
      semanticProgress.update(
        Math.min(start + batchRecords.length, semanticPending.length),
        formatBatchLabel(jobState.phases.semantic.lastBatchNumber, totalBatches, start + batchRecords.length, semanticPending.length)
      );
    }
    semanticProgress.done();
  }

  const relationPending = [];
  for (const record of records) {
    record.sourceState.llmRefreshState = summarizeLlmRefreshState(record.semanticPaper, options);
    if (record.sourceState.llmRefreshState.relationRequired) {
      await ensureParsedPaperForLlmRecord(record);
      relationPending.push(record);
    }
  }

  if (relationPending.length) {
    const relationProgress = quiet ? createQuietProgress() : createProgressBar(relationPending.length, { prefix: 'Relation extraction' });
    relationProgress.start();
    jobState.phases.relation = {
      ...jobState.phases.relation,
      status: 'running',
      total: relationPending.length,
      completed: 0,
      batchCount: Math.ceil(relationPending.length / batchSize),
      lastBatchNumber: 0
    };
    await saveStage2JobState(rootPath, jobState);

    const totalBatches = Math.max(1, Math.ceil(relationPending.length / batchSize));
    for (let start = 0; start < relationPending.length; start += batchSize) {
      const batchRecords = relationPending.slice(start, start + batchSize);
      const relationBatchResults = await inferPaperResearchSemanticsBatch(
        batchRecords.map((record) => ({
          id: record.sourceState.sourceKey,
          parsedPaper: record.parsedPaper,
          semanticPaper: record.semanticPaper
        })),
        {
          ...options,
          llmBatchSize: batchSize
        }
      );

      for (let index = 0; index < batchRecords.length; index += 1) {
        const record = batchRecords[index];
        const summary = applyRelationBatchResultToRecord(record, relationBatchResults[index], options);
        await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
        updateStage2PaperPhase(jobState, record.sourceState.sourceKey, 'relation', summary.status, summary.error);
      }

      jobState.phases.relation.lastBatchNumber = Math.floor(start / batchSize) + 1;
      refreshStage2PhaseStatus(jobState, relationPending, 'relation');
      await saveStage2JobState(rootPath, jobState);
      relationProgress.update(
        Math.min(start + batchRecords.length, relationPending.length),
        formatBatchLabel(jobState.phases.relation.lastBatchNumber, totalBatches, start + batchRecords.length, relationPending.length)
      );
    }
    relationProgress.done();
  }

  for (const record of records) {
    record.sourceState.llmRefreshState = summarizeLlmRefreshState(record.semanticPaper, options);
    const paperStatus = getOrCreateStage2PaperStatus(jobState, record.sourceState.sourceKey);
    if (!record.sourceState.llmRefreshState.semanticRequired && paperStatus.semantic.status === 'pending') {
      updateStage2PaperPhase(jobState, record.sourceState.sourceKey, 'semantic', 'completed', null);
    }
    if (!record.sourceState.llmRefreshState.relationRequired && paperStatus.relation.status === 'pending') {
      updateStage2PaperPhase(jobState, record.sourceState.sourceKey, 'relation', 'completed', null);
    }
  }

  refreshStage2PhaseStatus(jobState, records, 'semantic');
  refreshStage2PhaseStatus(jobState, records, 'relation');
  const completed = records.every((record) => !summarizeLlmRefreshState(record.semanticPaper, options).anyRequired);
  jobState.status = completed ? 'completed' : 'partial';
  jobState.completedAt = completed ? new Date().toISOString() : null;
  jobState.updatedAt = new Date().toISOString();
  await saveStage2JobState(rootPath, jobState);

  const nextManifest = createStage2ManifestFromRecords(rootPath, manifest, records, {
    ...options,
    semanticExtraction: normalizedSemanticExtractionMode,
    completed
  });
  if (completed) {
    jobState.token = createStage2JobToken(nextManifest, options);
    jobState.manifestToken = createManifestCommitToken(nextManifest);
  }

  return {
    nextManifest,
    jobState,
    completed
  };
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
  const rootPath = options.rootPath ? path.resolve(options.rootPath) : null;

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
  const crossPaperJudgmentCache = rootPath
    ? await loadCrossPaperJudgmentCache(rootPath)
    : new Map();
  const cacheSizeBefore = crossPaperJudgmentCache.size;
  const judgments = await adjudicateCrossPaperCandidates(candidates, {
    ...options,
    crossPaperJudgmentCache
  });
  if (rootPath && crossPaperJudgmentCache.size !== cacheSizeBefore) {
    await saveCrossPaperJudgmentCache(rootPath, crossPaperJudgmentCache);
  }
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
  const postprocessInput = {
    problems: [],
    methods: [],
    limitations: [],
    futureDirections: [],
    benchmarks: [],
    claims: [],
    appliesPairs: [],
    papers: semanticPapers.map((paper) => ({
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      references: paper.references || []
    }))
  };
  const buildProgressTotal = (semanticPapers.length * 2) + 1;
  const progress = quiet ? createQuietProgress() : createProgressBar(buildProgressTotal, { prefix: 'Building graph' });
  progress.start();
  progress.setLabel('precomputing paper graph fragments');
  const precomputedFragments = await precomputePaperGraphFragments(semanticPapers, {
    graphPrecomputeConcurrency: firstDefinedValue(options.graphPrecomputeConcurrency, options.analyzeConcurrency, options.concurrency),
    analyzeConcurrency: options.analyzeConcurrency,
    concurrency: options.concurrency,
    onProgress() {
      progress.tick();
    }
  });
  const aggregatedGlobalContributions = aggregateGlobalContributions(precomputedFragments);
  const globalNodeById = new Map();

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

  progress.setLabel('merging paper fragments into the graph');
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
    progress.tick();
  }

  postprocessInput.problems = nodesByType.get(NODE_TYPES.PROBLEM) || [];
  postprocessInput.methods = nodesByType.get(NODE_TYPES.METHOD) || [];
  postprocessInput.limitations = nodesByType.get(NODE_TYPES.LIMITATION) || [];
  postprocessInput.futureDirections = nodesByType.get(NODE_TYPES.FUTURE_DIRECTION) || [];
  postprocessInput.benchmarks = nodesByType.get(NODE_TYPES.BENCHMARK) || [];
  postprocessInput.claims = paperClaims;
  postprocessInput.appliesPairs = graph.relationships
    .filter((relationship) => relationship.type === EDGE_TYPES.APPLIES_TO)
    .map((relationship) => `${relationship.sourceId}:${relationship.targetId}`);
  const postprocessTaskCount = countGraphPostprocessTasks(postprocessInput);
  progress.setTotal((semanticPapers.length * 2) + postprocessTaskCount + 1, 'running graph postprocess heuristics');

  const postprocessRelationships = await precomputeGraphPostprocess(postprocessInput, {
    graphPostprocessConcurrency: firstDefinedValue(options.graphPostprocessConcurrency, options.analyzeConcurrency, options.concurrency),
    analyzeConcurrency: options.analyzeConcurrency,
    concurrency: options.concurrency,
    onProgress() {
      progress.tick();
    }
  });

  for (const relationship of postprocessRelationships) {
    graph.addRelationship(relationship);
  }

  progress.setLabel('running cross-paper judgments');
  const acceptedCrossPaperJudgments = await applyCrossPaperOllamaJudgments(
    graph,
    nodesByType.get(NODE_TYPES.METHOD) || [],
    nodesByType.get(NODE_TYPES.PROBLEM) || [],
    semanticPapers,
    options
  );
  progress.tick('cross-paper judgments complete');

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

function refreshMetaFromGraph(previousMeta, graph, mergeSummary = null, nodeLlmCheckSummary = null) {
  const layerCounts = {};
  const layerPathCounts = {};
  const brainstormNodeCounts = {};
  const problemNodes = graph.nodes
    .filter((node) => node.type === NODE_TYPES.PROBLEM)
    .sort((left, right) => (right.properties?.paperTitles?.length || 0) - (left.properties?.paperTitles?.length || 0));

  for (const node of graph.nodes) {
    const layer = node.properties?.layer || getNodeLayer(node.type);
    layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    if (node.properties?.brainstormEligible) {
      brainstormNodeCounts[node.type] = (brainstormNodeCounts[node.type] || 0) + 1;
    }
  }

  for (const relationship of graph.relationships) {
    const pathKey = relationship.properties?.layerPath || 'unknown';
    layerPathCounts[pathKey] = (layerPathCounts[pathKey] || 0) + 1;
  }

  return {
    ...previousMeta,
    indexedAt: new Date().toISOString(),
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    topProblems: problemNodes.slice(0, 12).map((problem) => problem.name),
    topDomains: problemNodes.slice(0, 12).map((problem) => problem.name),
    layers: layerCounts,
    layerPaths: layerPathCounts,
    brainstormView: {
      eligibleNodeCount: Object.values(brainstormNodeCounts).reduce((total, count) => total + count, 0),
      nodeTypes: brainstormNodeCounts
    },
    nodeLlmCheck: nodeLlmCheckSummary || previousMeta.nodeLlmCheck || {
      requested: false,
      checkedNodeCount: 0,
      keptNodeCount: 0,
      droppedNodeCount: 0,
      renamedNodeCount: 0,
      errorCount: 0,
      provider: 'disabled',
      attempted: false,
      participated: false
    },
    similarNodeMerge: mergeSummary || previousMeta.similarNodeMerge || {
      mergedGroupCount: 0,
      mergedNodeCount: 0,
      mergedRelationshipCount: 0,
      groups: []
    }
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

function createEmptyManifest({ corpusName, rootPath, inputPath, inputPaths, sourceMode, pdfParser, pdfCommand, semanticExtractionMode, sources, indexedAt, changes = null }) {
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
    lastChangeSummary: changes,
    sources,
    llmOptimization: null
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

function createUnchangedManifestSummary(manifest) {
  return {
    added: 0,
    updated: 0,
    removed: 0,
    reused: manifest?.sources?.length || 0
  };
}

function hasInputSourceChanges(sourceStates = [], removedSources = []) {
  if (removedSources.length) return true;

  return sourceStates.some((sourceState) => {
    if (!sourceState.previous) return true;
    if (sourceState.previous.fingerprint !== sourceState.fingerprint) return true;
    if (sourceState.previous.kind !== sourceState.kind) return true;
    if (sourceState.markdownCacheNeedsRefresh) return true;
    return false;
  });
}

function createManifestCommitToken(manifest) {
  if (!manifest) return null;
  const sources = (manifest.sources || [])
    .map((entry) => ({
      sourceKey: entry.sourceKey || '',
      fingerprint: entry.fingerprint || entry.sourceFingerprint || '',
      paperId: entry.paperId || null,
      activeInGraph: entry.activeInGraph !== false,
      canonicalSourceKey: entry.canonicalSourceKey || null,
      duplicateOfSourceKey: entry.duplicateOfSourceKey || null,
      snapshotStateSignature: entry.snapshotStateSignature || null
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return JSON.stringify({
    version: manifest.version || null,
    inputPaths: normalizeInputPaths(resolveManifestInputPath(manifest)),
    sourceMode: manifest.sourceMode || null,
    pdfParser: manifest.pdfParser || null,
    semanticExtractionMode: manifest.semanticExtractionMode || null,
    sourceCount: sources.length,
    sources
  });
}

function createLlmOptimizationToken(manifest, options = {}) {
  return stableHash(JSON.stringify({
    version: 1,
    manifestToken: createManifestCommitToken(manifest),
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options)
  }), 20);
}

function buildLlmOptimizationState(manifest, options = {}) {
  return {
    version: 1,
    completedAt: new Date().toISOString(),
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
    token: createLlmOptimizationToken(manifest, options)
  };
}

function manifestHasReusableLlmOptimization(manifest, options = {}) {
  if (!manifest?.llmOptimization?.token) return false;
  return manifest.llmOptimization.token === createLlmOptimizationToken(manifest, options);
}

function createStage2JobToken(manifest, options = {}) {
  return createLlmOptimizationToken(manifest, options);
}

function createEmptyStage2PaperStatus() {
  return {
    semantic: {
      status: 'pending',
      updatedAt: null,
      error: null
    },
    relation: {
      status: 'pending',
      updatedAt: null,
      error: null
    }
  };
}

function createStage2JobState(manifest, options = {}) {
  const token = createStage2JobToken(manifest, options);
  return {
    version: STAGE2_JOB_STATE_VERSION,
    token,
    manifestToken: createManifestCommitToken(manifest),
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    phases: {
      semantic: {
        status: 'pending',
        completed: 0,
        total: 0,
        batchCount: 0,
        lastBatchNumber: 0
      },
      relation: {
        status: 'pending',
        completed: 0,
        total: 0,
        batchCount: 0,
        lastBatchNumber: 0
      }
    },
    papers: {}
  };
}

function isReusableStage2JobState(jobState, manifest, options = {}) {
  if (!jobState || jobState.version !== STAGE2_JOB_STATE_VERSION) return false;
  if (jobState.status !== 'completed') return false;
  return (
    jobState.token === createStage2JobToken(manifest, options)
    && jobState.manifestToken === createManifestCommitToken(manifest)
  );
}

function getOrCreateStage2PaperStatus(jobState, sourceKey) {
  if (!jobState.papers[sourceKey]) {
    jobState.papers[sourceKey] = createEmptyStage2PaperStatus();
  }
  return jobState.papers[sourceKey];
}

function updateStage2PaperPhase(jobState, sourceKey, phase, status, error = null) {
  const paperStatus = getOrCreateStage2PaperStatus(jobState, sourceKey);
  paperStatus[phase] = {
    status,
    updatedAt: new Date().toISOString(),
    error: error || null
  };
  jobState.updatedAt = new Date().toISOString();
}

function refreshStage2PhaseStatus(jobState, records, phase) {
  const total = records.length;
  let completed = 0;
  let hasRunning = false;
  let hasFailed = false;

  for (const record of records) {
    const paperStatus = getOrCreateStage2PaperStatus(jobState, record.sourceState.sourceKey);
    const phaseStatus = paperStatus[phase]?.status || 'pending';
    if (phaseStatus === 'completed' || phaseStatus === 'skipped') {
      completed += 1;
    } else if (phaseStatus === 'failed') {
      hasFailed = true;
    } else if (phaseStatus === 'running') {
      hasRunning = true;
    }
  }

  jobState.phases[phase] = {
    ...jobState.phases[phase],
    total,
    completed,
    status: completed >= total
      ? 'completed'
      : hasRunning
        ? 'running'
        : hasFailed
          ? 'partial'
          : 'pending'
  };
  jobState.updatedAt = new Date().toISOString();
}

function createSourceFingerprintMap(sourceStates = []) {
  return new Map(
    sourceStates.map((sourceState) => [sourceState.sourceKey, sourceState.fingerprint])
  );
}

async function collectCurrentSourceFingerprintMap(inputPath, rootPath, metadataConcurrency) {
  const discovery = await discoverCorpusSources(inputPath, { rootPath });
  const currentSources = await mapWithConcurrency(
    discovery.sources,
    metadataConcurrency,
    async (source) => {
      const stats = await fs.stat(source.inputPath);
      return [source.sourceKey, createSourceFingerprint(stats)];
    }
  );

  return new Map(currentSources);
}

function sourceFingerprintMapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [sourceKey, fingerprint] of left.entries()) {
    if (right.get(sourceKey) !== fingerprint) return false;
  }
  return true;
}

async function assertAnalyzeCommitStillFresh(inputPath, rootPath, sourceStates, previousManifest, metadataConcurrency) {
  const latestManifest = await loadSourceManifest(rootPath);
  const baseToken = createManifestCommitToken(previousManifest);
  const latestToken = createManifestCommitToken(latestManifest);
  if (baseToken !== latestToken) {
    throw new Error('Another PaperNexus run committed newer corpus state while this run was processing. Re-run the command to continue from the latest snapshots.');
  }

  const expectedSources = createSourceFingerprintMap(sourceStates);
  const currentSources = await collectCurrentSourceFingerprintMap(inputPath, rootPath, metadataConcurrency);
  if (!sourceFingerprintMapsEqual(expectedSources, currentSources)) {
    throw new Error('Source inputs changed while PaperNexus was processing. Re-run the command so the final graph is built from the latest files.');
  }
}

function createSerializableSourceFingerprints(sourceStates = []) {
  return sourceStates
    .map((sourceState) => ({
      sourceKey: sourceState.sourceKey,
      fingerprint: sourceState.fingerprint
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function createSourceFingerprintMapFromEntries(entries = []) {
  return new Map(
    entries
      .filter((entry) => entry?.sourceKey && entry?.fingerprint)
      .map((entry) => [entry.sourceKey, entry.fingerprint])
  );
}

function resolveManifestInputPath(manifest) {
  if (Array.isArray(manifest?.inputPaths) && manifest.inputPaths.length) {
    return manifest.inputPaths;
  }
  return manifest?.inputPath;
}

function canReuseCommittedCorpusForWatch(manifest, options = {}, stage2JobState = null) {
  const normalizedSemanticExtractionMode = normalizeSemanticExtractionMode(
    firstDefinedValue(options.semanticExtraction, manifest?.semanticExtractionMode, 'auto')
  );
  if ((manifest?.semanticExtractionMode || 'auto') !== normalizedSemanticExtractionMode) {
    return false;
  }

  const analysisOptions = {
    ...options,
    semanticExtraction: normalizedSemanticExtractionMode
  };
  const requiresLlm = resolveSemanticExtractionPlan(analysisOptions).shouldAttempt
    || canAttemptLlmRelations(analysisOptions);

  if (!requiresLlm) {
    return true;
  }

  return manifestHasReusableLlmOptimization(manifest, analysisOptions)
    || isReusableStage2JobState(stage2JobState, manifest, analysisOptions);
}

async function assertStagedBuildStillFresh(rootPath, stagedState, metadataConcurrency, extraManifestTokens = []) {
  const latestManifest = await loadSourceManifest(rootPath);
  const latestToken = createManifestCommitToken(latestManifest);
  const acceptableTokens = new Set([
    stagedState.baseManifestToken,
    stagedState.stagedManifestToken,
    ...extraManifestTokens
  ].filter(Boolean));
  if (!acceptableTokens.has(latestToken)) {
    throw new Error('The staged graph no longer matches the latest source manifest. Re-run Stage 3 before committing Stage 4.');
  }
}

function createEmptyNodeLlmCheckSummary(requested = false, overrides = {}) {
  return {
    requested,
    checkedNodeCount: 0,
    keptNodeCount: 0,
    droppedNodeCount: 0,
    renamedNodeCount: 0,
    errorCount: 0,
    provider: 'disabled',
    attempted: false,
    participated: false,
    errors: [],
    ...overrides
  };
}

function combineMergeSummaries(left = null, right = null) {
  const base = left || {
    mergedGroupCount: 0,
    mergedNodeCount: 0,
    mergedRelationshipCount: 0,
    groups: []
  };
  const extra = right || {
    mergedGroupCount: 0,
    mergedNodeCount: 0,
    mergedRelationshipCount: 0,
    groups: []
  };

  return {
    mergedGroupCount: Number(base.mergedGroupCount || 0) + Number(extra.mergedGroupCount || 0),
    mergedNodeCount: Number(base.mergedNodeCount || 0) + Number(extra.mergedNodeCount || 0),
    mergedRelationshipCount: Number(base.mergedRelationshipCount || 0) + Number(extra.mergedRelationshipCount || 0),
    groups: [...(base.groups || []), ...(extra.groups || [])].slice(0, 48)
  };
}

function collectNodeLlmCheckCandidates(graph) {
  return graph.nodes
    .filter((node) => node.type === NODE_TYPES.DATASET || node.type === NODE_TYPES.BENCHMARK)
    .map((node) => {
      const relationships = [...graph.getIncoming(node.id), ...graph.getOutgoing(node.id)];
      const evidenceTexts = unique(
        relationships
          .map((relationship) => relationship.properties?.evidenceText)
          .filter(Boolean)
      ).slice(0, 4);
      const relationTypes = unique(relationships.map((relationship) => relationship.type)).slice(0, 8);

      return {
        id: node.id,
        type: node.type,
        name: node.name,
        aliases: node.properties?.aliases || [],
        paperTitles: node.properties?.paperTitles || [],
        mentionCount: node.properties?.mentionCount || 1,
        confidence: node.properties?.confidence || 0.6,
        evidenceTexts,
        relationTypes
      };
    });
}

async function runOptionalNodeLlmCheck(graph, options = {}) {
  if (!NODE_LLM_CHECK_ENABLED || !options.nodeLlmCheck) {
    return {
      graph,
      summary: createEmptyNodeLlmCheckSummary(false),
      changed: false,
      decisions: []
    };
  }

  const candidates = collectNodeLlmCheckCandidates(graph);
  if (!candidates.length) {
    return {
      graph,
      summary: createEmptyNodeLlmCheckSummary(true),
      changed: false,
      decisions: []
    };
  }

  const progress = options.quiet ? createQuietProgress() : createProgressBar(candidates.length, { prefix: 'Node LLM check' });
  progress.start();
  const decisions = await inferGraphNodeChecksBatch(candidates, {
    ...options,
    onBatchComplete(event = {}) {
      progress.update(
        Math.min(Number(event.completed || 0), candidates.length),
        `batch ${Math.max(1, Number(event.batchNumber || 0))}/${Math.max(1, Number(event.totalBatches || 0))}, ${Math.min(Number(event.completed || 0), candidates.length)}/${candidates.length} nodes checked`
      );
    }
  });
  progress.done();

  const applied = applyNodeCheckDecisions(graph, decisions);
  let nextGraph = applied.graph;
  let postCheckMergeSummary = null;
  if (applied.summary.renamedNodeCount > 0) {
    const renamedMerge = mergeSimilarGraphNodes(nextGraph, options);
    nextGraph = renamedMerge.graph;
    postCheckMergeSummary = renamedMerge.summary;
  }

  const providers = unique(decisions.map((decision) => decision.provider).filter((provider) => provider && provider !== 'disabled'));
  const errors = decisions
    .filter((decision) => decision.error)
    .map((decision) => ({ id: decision.id, error: decision.error }))
    .slice(0, 12);
  const summary = createEmptyNodeLlmCheckSummary(true, {
    checkedNodeCount: candidates.length,
    keptNodeCount: applied.summary.keptNodeCount,
    droppedNodeCount: applied.summary.droppedNodeCount,
    renamedNodeCount: applied.summary.renamedNodeCount,
    errorCount: errors.length,
    provider: providers[0] || 'disabled',
    attempted: decisions.some((decision) => decision.attempted),
    participated: decisions.some((decision) => decision.participated),
    errors
  });

  return {
    graph: nextGraph,
    summary,
    changed: applied.changed,
    decisions,
    postCheckMergeSummary
  };
}

async function mergePreparedGraphBuild(rootPath, stagedBuild, options = {}) {
  const mergeResult = mergeSimilarGraphNodes(stagedBuild.graph, options);
  const nodeCheckResult = await runOptionalNodeLlmCheck(mergeResult.graph, options);
  const effectiveMergeSummary = combineMergeSummaries(mergeResult.summary, nodeCheckResult.postCheckMergeSummary);
  const nextMeta = refreshMetaFromGraph(
    stagedBuild.meta,
    nodeCheckResult.graph,
    effectiveMergeSummary,
    nodeCheckResult.summary
  );
  const nextManifest = {
    ...stagedBuild.manifest,
    indexedAt: nextMeta.indexedAt
  };
  const nextState = {
    ...stagedBuild.state,
    version: stagedBuild.state?.version || 1,
    stage: 'graph-merged',
    mergedAt: nextMeta.indexedAt,
    mergeSummary: effectiveMergeSummary,
    nodeLlmCheckRequested: Boolean(NODE_LLM_CHECK_ENABLED && options.nodeLlmCheck),
    nodeLlmCheckSummary: nodeCheckResult.summary,
    stagedManifestToken: createManifestCommitToken(nextManifest)
  };

  await saveStagedCorpusBuild(rootPath, nodeCheckResult.graph, nextMeta, nextManifest, nextState);

  return {
    graph: nodeCheckResult.graph,
    meta: nextMeta,
    manifest: nextManifest,
    state: nextState,
    summary: effectiveMergeSummary,
    nodeCheckSummary: nodeCheckResult.summary,
    changed: mergeResult.changed || nodeCheckResult.changed
  };
}

async function loadSemanticPapersFromManifest(rootPath, manifest, metadataConcurrency) {
  const manifestSources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const snapshots = await mapWithConcurrency(
    manifestSources,
    metadataConcurrency,
    async (entry) => ({
      entry,
      snapshot: await loadSemanticPaperSnapshot(rootPath, entry.sourceKey)
    })
  );

  const semanticPapers = [];
  const failedSources = [];
  for (const record of snapshots) {
    if (!record.snapshot) {
      failedSources.push({
        sourceKey: record.entry.sourceKey,
        inputPath: record.entry.inputPath,
        message: 'Missing semantic snapshot for staged build.'
      });
      continue;
    }

    if (record.snapshot.activeInGraph !== false) {
      semanticPapers.push(record.snapshot);
    }
  }

  semanticPapers.sort((left, right) => left.paperTitle.localeCompare(right.paperTitle));
  return {
    semanticPapers,
    failedSources
  };
}

async function commitPreparedCorpusIndex({
  rootPath,
  graph,
  meta,
  manifest,
  sourceStateByKey,
  analysisOptions,
  validation = null,
  cleanupStagedBuild = false
}) {
  const activeManifestSources = (manifest.sources || []).filter((entry) => entry.activeInGraph !== false);
  const shouldBackupBeforeCommit = analysisOptions.backupBeforeCommit === true;
  const writeTaskCount = analysisOptions.enqueueEnhancements !== false
    ? (shouldBackupBeforeCommit ? 5 : 4)
    : (shouldBackupBeforeCommit ? 4 : 3);
  const writeProgress = analysisOptions.quiet ? createQuietProgress() : createProgressBar(writeTaskCount, { prefix: 'Writing index' });
  let writeCompleted = 0;
  const setWriteLabel = (label) => {
    writeProgress.update(writeCompleted, label);
  };
  const advanceWrite = (label) => {
    writeCompleted += 1;
    writeProgress.update(writeCompleted, label);
  };

  writeProgress.start();
  setWriteLabel('acquiring corpus commit lock');
  let writeSucceeded = false;
  try {
    const lockHandlers = createLockProgressHandlers(analysisOptions, {
      setLabel: setWriteLabel,
      onWaitLabel: 'waiting for corpus commit lock',
      onAcquiredLabel: 'corpus commit lock acquired',
      onWaitLog: '[lock] waiting for corpus commit lock during Stage 4 write-index',
      onAcquiredLog: '[lock] corpus commit lock acquired for Stage 4 write-index'
    });
    await withFileLock(getCorpusLockPath(rootPath), async () => {
      if (typeof validation === 'function') {
        await validation();
      }

      if (shouldBackupBeforeCommit) {
        setWriteLabel('backing up current corpus index');
        await backupExistingCorpusRoot(rootPath, {
          backupDir: analysisOptions.backupDir
        });
        advanceWrite('backup ready');
      }

      setWriteLabel('writing authoritative graph store');
      await saveCorpus(rootPath, graph, meta, {
        liteViewMode: 'incremental',
        liteViewSources: activeManifestSources,
        onProgress(event = {}) {
          setWriteLabel(event.label || 'writing graph and lite index files');
        }
      });
      advanceWrite('authoritative graph and lite view saved');

      setWriteLabel('writing source manifest');
      await saveSourceManifest(rootPath, manifest);
      advanceWrite('source manifest saved');

      setWriteLabel('registering corpus');
      await registerCorpus({
        name: meta.name,
        rootPath,
        indexedAt: meta.indexedAt,
        paperCount: meta.paperCount
        });
      advanceWrite('corpus registry updated');
    }, mergeLockOptions(analysisOptions.lockOptions, lockHandlers));

    let enhancement = null;
    if (analysisOptions.enqueueEnhancements !== false) {
      try {
        setWriteLabel('preparing enhancement queue');
        await pruneEnhancementsForManifest(rootPath, activeManifestSources);
        const changedEntries = activeManifestSources.filter((entry) => {
          const state = sourceStateByKey?.get(entry.sourceKey);
          return !state || state.changeType !== 'unchanged';
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
      } finally {
        advanceWrite('enhancement queue updated');
      }
    }
    writeProgress.done();
    writeSucceeded = true;

    if (cleanupStagedBuild) {
      await removeStagedCorpusBuild(rootPath);
    }

    return enhancement;
  } finally {
    if (!writeSucceeded) {
      writeProgress.stop();
    }
  }
}

function normalizeInputPaths(inputPath) {
  if (!inputPath) {
    return [];
  }

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

function inputScopesEqual(leftInputPaths, rightInputPaths) {
  const left = normalizeInputPaths(leftInputPaths).slice().sort();
  const right = normalizeInputPaths(rightInputPaths).slice().sort();
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
}

function createSingleGraphScopeError(rootPath, expectedInputPaths, requestedInputPaths) {
  return new Error(
    `PaperNexus is running in single-graph mode for ${rootPath}. ` +
    `Keep using ${describeInputPaths(normalizeInputPaths(expectedInputPaths))}. ` +
    `Refusing to switch this graph to ${describeInputPaths(normalizeInputPaths(requestedInputPaths))}.`
  );
}

async function assertSingleGraphInputScope(rootPath, requestedInputPaths, persistedInputPaths) {
  if (!persistedInputPaths) {
    return;
  }

  if (!inputScopesEqual(requestedInputPaths, persistedInputPaths)) {
    throw createSingleGraphScopeError(rootPath, persistedInputPaths, requestedInputPaths);
  }
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
  const rootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : (absoluteInputs.length === 1
        ? absoluteInputs[0]
        : process.cwd());

  const baseInputEntries = await mapWithConcurrency(
    absoluteInputs,
    Math.min(Math.max(1, absoluteInputs.length), 4),
    (absoluteInput) => collectSourcesFromInput(absoluteInput)
  );
  const importInputDirs = await listActiveImportSourceDirs(rootPath);
  const importInputEntries = await mapWithConcurrency(
    importInputDirs,
    Math.min(Math.max(1, importInputDirs.length), 4),
    async (absoluteInput) => {
      try {
        return await collectSourcesFromInput(absoluteInput);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    }
  );
  const inputEntries = [
    ...baseInputEntries,
    ...importInputEntries.filter(Boolean)
  ];

  for (const entry of inputEntries) {
    for (const source of entry.sources) {
      dedupedSources.set(source.sourceKey, source);
    }
  }

  const kinds = new Set([...dedupedSources.values()].map((source) => source.kind));
  const inferredRootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : (absoluteInputs.length === 1
        ? (baseInputEntries[0].inputStats.isDirectory() ? baseInputEntries[0].inputPath : path.dirname(baseInputEntries[0].inputPath))
        : process.cwd());

  return {
    absoluteInput: absoluteInputs[0],
    absoluteInputs,
    inputStats: baseInputEntries[0]?.inputStats || null,
    inputEntries,
    rootPath: inferredRootPath,
    sourceMode: kinds.size > 1 ? 'mixed' : (kinds.has('pdf') ? 'pdf' : 'markdown'),
    sources: [...dedupedSources.values()].sort((left, right) => left.inputPath.localeCompare(right.inputPath))
  };
}

async function resolveCorpusInputContext(inputPath, options = {}) {
  const absoluteInputs = normalizeInputPaths(inputPath);
  const absoluteInput = absoluteInputs[0];
  let inputStats = null;

  if (absoluteInput) {
    try {
      inputStats = await fs.stat(absoluteInput);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const rootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : (absoluteInputs.length === 1
        ? (inputStats?.isDirectory?.() ? absoluteInput : path.dirname(absoluteInput))
        : process.cwd());

  return {
    absoluteInput,
    absoluteInputs,
    inputStats,
    rootPath
  };
}

function buildManifestEntry(rootPath, sourceState, semanticPaper, markerCommand, extra = {}) {
  return {
    sourceKey: sourceState.sourceKey,
    inputPath: sourceState.inputPath,
    kind: sourceState.kind,
    fingerprint: sourceState.fingerprint,
    sourceFingerprint: sourceState.fingerprint,
    sourceMtimeMs: Number(sourceState.sourceMtimeMs || 0),
    sourceSizeBytes: Number(sourceState.sourceSizeBytes || 0),
    paperId: semanticPaper.paperId,
    paperTitle: semanticPaper.paperTitle,
    sourcePath: semanticPaper.sourcePath,
    sourceMarkdownPath: semanticPaper.sourceMarkdownPath,
    sourcePdfPath: semanticPaper.sourcePdfPath,
    markdownCachePath: semanticPaper.sourceMarkdownPath,
    markdownCacheFingerprint: sourceState.markdownCacheFingerprint || sourceState.fingerprint,
    markdownCacheExists: true,
    markdownCacheStatus: sourceState.markdownCacheNeedsRefresh ? 'refreshed' : 'reused',
    materializedFrom: sourceState.markdownCacheNeedsRefresh ? 'source-refresh' : 'markdown-cache',
    markerCommand: markerCommand || null,
    snapshotPath: path.relative(rootPath, getSemanticPaperSnapshotPath(rootPath, sourceState.sourceKey)),
    snapshotStateSignature: createSemanticPaperSnapshotStateSignature(semanticPaper),
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

function createSourceStateFromManifestEntry(entry) {
  return {
    sourceKey: entry.sourceKey,
    inputPath: entry.inputPath,
    kind: entry.kind,
    fingerprint: entry.fingerprint || entry.sourceFingerprint,
    sourceMtimeMs: Number(entry.sourceMtimeMs || 0),
    sourceSizeBytes: Number(entry.sourceSizeBytes || 0),
    previous: entry,
    markdownCachePath: entry.markdownCachePath || entry.sourceMarkdownPath || null,
    markdownCacheFingerprint: entry.markdownCacheFingerprint || entry.fingerprint || entry.sourceFingerprint || null,
    markdownCacheExists: true,
    markdownCacheNeedsRefresh: false,
    cachedPaper: null,
    llmRefreshState: {
      semanticRequired: false,
      relationRequired: false,
      anyRequired: false
    },
    reuseCachedMaterialization: true
  };
}

async function buildStage2RecordsFromManifest(rootPath, manifest, options = {}) {
  const metadataConcurrency = resolveMetadataConcurrency(options);
  const records = await mapWithConcurrency(manifest.sources || [], metadataConcurrency, async (entry) => {
    const sourceState = createSourceStateFromManifestEntry(entry);
    let semanticPaper = await loadSemanticPaperSnapshot(rootPath, entry.sourceKey);
    let parsedPaper = null;

    if (!semanticPaper) {
      parsedPaper = await loadParsedPaperFromMarkdownCache(sourceState);
      if (!parsedPaper) {
        throw new Error(`No semantic snapshot or markdown cache was available for ${entry.sourceKey}. Run Stage 1 before Stage 2.`);
      }
      semanticPaper = buildSemanticPaperView(parsedPaper);
      await saveSemanticPaperSnapshot(rootPath, entry.sourceKey, semanticPaper);
    }

    sourceState.cachedPaper = semanticPaper;
    sourceState.llmRefreshState = summarizeLlmRefreshState(semanticPaper, options);

    return {
      manifestEntry: entry,
      sourceState,
      semanticPaper,
      parsedPaper
    };
  });

  return records;
}

function resolveExpectedMarkdownCachePath(rootPath, sourceState, options = {}) {
  const { markdownDir, markerDir } = getCorpusPaths(rootPath);

  if (sourceState.kind === 'pdf') {
    return getPdfMarkdownCachePath(sourceState.inputPath, {
      pdfParser: options.pdfParser,
      markerDir,
      markdownDir
    });
  }

  return getMarkdownSourceCachePath(sourceState.inputPath, {
    markdownDir
  });
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
      force: Boolean(sourceState.markdownCacheNeedsRefresh),
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
  } else if (sourceState.kind === 'markdown') {
    const cached = await cacheMarkdownSource(sourceState.inputPath, {
      markdownDir,
      force: Boolean(sourceState.markdownCacheNeedsRefresh)
    });
    markdownPath = cached.markdownPath;
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

  return {
    parsedPaper: parsed,
    semanticPaper,
    markerCommand: pdfCommand
  };
}

async function loadParsedPaperFromMarkdownCache(sourceState, cachedPaper = null) {
  const markdownPath = sourceState.markdownCachePath
    || cachedPaper?.sourceMarkdownPath
    || sourceState.previous?.markdownCachePath
    || sourceState.previous?.sourceMarkdownPath
    || null;

  if (!markdownPath || !await fileExists(markdownPath)) {
    return null;
  }

  const markdown = await readText(markdownPath);
  const parsed = parsePaperMarkdown(markdown, markdownPath);
  parsed.paperId = cachedPaper?.paperId || `paper:${stableHash(sourceState.sourceKey)}`;
  parsed.paperTitle = parsed.title;
  parsed.sourceKey = sourceState.sourceKey;
  parsed.sourcePath = sourceState.inputPath;
  parsed.sourceMarkdownPath = markdownPath;
  parsed.sourcePdfPath = sourceState.kind === 'pdf' ? sourceState.inputPath : null;
  parsed.sourceKind = sourceState.kind;
  parsed.sourceFingerprint = sourceState.fingerprint;
  return parsed;
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
    concurrency = available;
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
  const activeStates = new Map();
  const totalWorkers = Math.min(analyzeConcurrency, Math.max(sourceStates.length, 1));

  // 创建进度条
  const progress = quiet ? createQuietProgress() : createProgressBar(sourceStates.length, { prefix: 'Processing papers' });
  progress.start();

  const formatSourceActivity = (sourceState, status = '') => {
    const basename = path.basename(sourceState.inputPath, path.extname(sourceState.inputPath)) || sourceState.sourceKey;
    const parser = sourceState.kind === 'pdf'
      ? normalizePdfParser(options.pdfParser)
      : 'markdown';
    return `${basename} [${parser}] ${status}`.trim();
  };

  const refreshProgressLabel = () => {
    const activeEntries = [...activeStates.values()];
    if (!activeEntries.length) {
      progress.setLabel(`workers 0/${totalWorkers} | starting`);
      return;
    }

    const visible = activeEntries.slice(0, 2);
    const overflow = activeEntries.length - visible.length;
    const suffix = overflow > 0 ? ` | +${overflow} more` : '';
    progress.setLabel(`workers ${activeEntries.length}/${totalWorkers} | ${visible.join(' | ')}${suffix}`);
  };

  const setSourceStatus = (sourceState, status) => {
    activeStates.set(sourceState.sourceKey, formatSourceActivity(sourceState, status));
    refreshProgressLabel();
  };

  const clearSourceStatus = (sourceState) => {
    activeStates.delete(sourceState.sourceKey);
    refreshProgressLabel();
  };

  async function processSourceState(sourceState) {
    setSourceStatus(
      sourceState,
      sourceState.changeType === 'unchanged' || sourceState.reuseCachedMaterialization
        ? 'cache hit'
        : (sourceState.kind === 'pdf' ? 'parsing pdf' : 'reading markdown')
    );

    if (sourceState.changeType === 'unchanged' || sourceState.reuseCachedMaterialization) {
        const cachedPaper = sourceState.cachedPaper || await loadSemanticPaperSnapshot(rootPath, sourceState.sourceKey);
        if (cachedPaper) {
          const shouldPrepareParsedPaper = Boolean(
          options.enableLlmEnrichment !== false
          && sourceState.reuseCachedMaterialization
          && sourceState.llmRefreshState?.anyRequired
        );
        const parsedPaper = shouldPrepareParsedPaper
          ? await loadParsedPaperFromMarkdownCache(sourceState, cachedPaper)
          : null;

        if (!shouldPrepareParsedPaper || parsedPaper) {
          materializedSources.push({
            sourceState,
            parsedPaper,
            semanticPaper: cachedPaper,
            markerCommand: sourceState.previous?.markerCommand || null
          });
          return;
        }
      }
    }

    try {
      setSourceStatus(sourceState, sourceState.kind === 'pdf' ? 'parsing pdf' : 'reading markdown');
      const { parsedPaper, semanticPaper, markerCommand } = await materializeSemanticPaper(rootPath, sourceState, { ...options, quiet });
      setSourceStatus(sourceState, 'writing snapshot');
      await saveSemanticPaperSnapshot(rootPath, sourceState.sourceKey, semanticPaper);
      materializedSources.push({
        sourceState,
        parsedPaper,
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
          // 增量重试次数，以便 snapshotNeedsLlmRefresh 在未来不再无限重试
          if (cachedPaper.llm) {
            cachedPaper.llm.retryCount = (cachedPaper.llm.retryCount || 0) + 1;
          } else {
            cachedPaper.llm = { retryCount: 1 };
          }
          await saveSemanticPaperSnapshot(rootPath, sourceState.sourceKey, cachedPaper);
          materializedSources.push({
            sourceState,
            semanticPaper: cachedPaper,
            markerCommand: sourceState.previous?.markerCommand || null
          });
        }
      }
    } finally {
      clearSourceStatus(sourceState);
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
  if (options.enableLlmEnrichment === false) {
    for (const record of materializedSources) {
      applySemanticAdmissionPolicy(record.semanticPaper);
      await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
    }
  } else {
    await enrichMaterializedSourcesWithOllama(rootPath, materializedSources, options);
  }

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
    const materializeOnly = Boolean(options.materializeOnly);
    const llmOnly = Boolean(options.llmOnly);
    const optimizeOnly = Boolean(options.optimizeOnly);
    const analysisOptions = {
      ...options,
      semanticExtraction: normalizedSemanticExtractionMode
    };
    const forceMaterialization = Boolean(options.force && !optimizeOnly && !llmOnly);
    const forceLlmRefresh = Boolean(options.force && (optimizeOnly || llmOnly));
    const materializeOptions = materializeOnly
      ? {
          ...analysisOptions,
          semanticExtraction: 'heuristic-only',
          llmRelations: false,
          ollamaRelations: false,
          enableLlmEnrichment: false,
          enqueueEnhancements: false
        }
      : {
          ...analysisOptions,
          enableLlmEnrichment: true,
          llmStageStep: llmOnly ? 1 : 2,
          llmStageTotal: llmOnly ? 1 : 5,
          llmStageTitle: 'Batch LLM optimization',
          llmStageDetail: 'semantic objects and relation extraction'
        };
    const previousByKey = new Map((previousManifest?.sources || []).map((entry) => [entry.sourceKey, entry]));
    const currentKeys = new Set(discovery.sources.map((source) => source.sourceKey));
    const { metaPath } = getCorpusPaths(rootPath);
    const previousIndexExists = await fileExists(metaPath) && await hasCorpusGraphStore(rootPath);
    const inputLabel = describeInputPaths(absoluteInputs);

    await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(previousManifest));

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

      if (snapshotExists) {
        cachedPaper = await loadSemanticPaperSnapshot(rootPath, source.sourceKey);
        if (cachedPaper?.sourceFingerprint !== fingerprint) {
          cachedPaper = null;
        }
      }
      let llmRefreshState = cachedPaper
        ? summarizeLlmRefreshState(cachedPaper, analysisOptions)
        : {
            semanticRequired: false,
            relationRequired: false,
            anyRequired: false
          };

      const markdownCachePath = resolveExpectedMarkdownCachePath(rootPath, {
        ...source,
        fingerprint
      }, analysisOptions);
      const markdownCacheExists = await fileExists(markdownCachePath);
      const previousMarkdownCachePath = firstDefinedValue(
        previous?.markdownCachePath,
        previous?.sourceMarkdownPath,
        cachedPaper?.sourceMarkdownPath,
        ''
      );
      const previousMarkdownCacheFingerprint = firstDefinedValue(
        previous?.markdownCacheFingerprint,
        previous?.fingerprint,
        cachedPaper?.sourceFingerprint,
        ''
      );
      const forcedMarkdownRefresh = Boolean(analysisOptions.rebuildPdfMarkdown && source.kind === 'pdf');
      const markdownCacheNeedsRefresh = forcedMarkdownRefresh
        || !markdownCacheExists
        || (previousMarkdownCachePath && previousMarkdownCachePath !== markdownCachePath)
        || (previousMarkdownCacheFingerprint && previousMarkdownCacheFingerprint !== fingerprint);
      let reuseCachedMaterialization = false;

      let changeType = 'unchanged';
      if (forceLlmRefresh) {
        llmRefreshState = {
          semanticRequired: resolveSemanticExtractionPlan(analysisOptions).shouldAttempt,
          relationRequired: canAttemptLlmRelations(analysisOptions),
          anyRequired: resolveSemanticExtractionPlan(analysisOptions).shouldAttempt || canAttemptLlmRelations(analysisOptions)
        };
        changeType = cachedPaper ? 'updated' : (previous ? 'updated' : 'added');
        reuseCachedMaterialization = Boolean(cachedPaper && !markdownCacheNeedsRefresh);
      } else if (forceMaterialization || manifestVersionMismatch || !previous || !snapshotExists) {
        changeType = previous ? 'updated' : 'added';
        if (!forceMaterialization && cachedPaper && !markdownCacheNeedsRefresh && !llmRefreshState.anyRequired) {
          reuseCachedMaterialization = true;
        }
      } else if (previous.fingerprint !== fingerprint || previous.kind !== source.kind || markdownCacheNeedsRefresh) {
        changeType = 'updated';
        if (cachedPaper && !markdownCacheNeedsRefresh && !llmRefreshState.anyRequired) {
          reuseCachedMaterialization = true;
        }
      } else {
        if (!cachedPaper || llmRefreshState.anyRequired) {
          changeType = 'updated';
          if (cachedPaper && !markdownCacheNeedsRefresh) {
            reuseCachedMaterialization = true;
          }
        }
      }

      return {
        ...source,
        fingerprint,
        sourceMtimeMs: Number(stats.mtimeMs || 0),
        sourceSizeBytes: Number(stats.size || 0),
        previous,
        changeType,
        markdownCachePath,
        markdownCacheFingerprint: fingerprint,
        markdownCacheExists,
        markdownCacheNeedsRefresh,
        cachedPaper,
        llmRefreshState,
        reuseCachedMaterialization
      };
    });
    const sourceStateByKey = new Map(sourceStates.map((source) => [source.sourceKey, source]));

    const removedSources = (previousManifest?.sources || []).filter((entry) => !currentKeys.has(entry.sourceKey));
    const changes = summarizeSourceChanges(sourceStates, removedSources);
    const inputSourcesChanged = hasInputSourceChanges(sourceStates, removedSources);

    if (
      !options.force
      && llmOnly
      && (
        (!hasSourceChanges(changes) && sourceStates.every((sourceState) => !sourceState.llmRefreshState?.anyRequired))
        || (!inputSourcesChanged && manifestHasReusableLlmOptimization(previousManifest, analysisOptions))
      )
    ) {
      const paperCount = (previousManifest?.sources || []).filter((entry) => entry.activeInGraph !== false).length
        || (previousManifest?.sources || []).length;
      return {
        graph: null,
        meta: {
          name: corpusName,
          indexedAt: previousManifest?.indexedAt || new Date().toISOString(),
          paperCount,
          relationshipCount: 0,
          sourceCount: previousManifest?.sources?.length || sourceStates.length,
          stage: 'llm-optimized',
          semanticExtractionMode: normalizedSemanticExtractionMode,
          lastChangeSummary: changes
        },
        rootPath,
        changes,
        reused: true,
        stage: 'llm-optimized'
      };
    }

    if (!options.force && !llmOnly && !hasSourceChanges(changes) && previousIndexExists) {
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

    announceStage(
      materializeOptions,
      1,
      materializeOnly ? 2 : (llmOnly ? 1 : 5),
      materializeOnly ? 'Preparing paper snapshots' : (optimizeOnly || llmOnly ? 'Reusing paper snapshots' : 'Preparing paper snapshots'),
      materializeOnly
        ? 'markdown cache and heuristic semantic snapshots'
        : (optimizeOnly || llmOnly ? 'cache-first snapshot reuse before optimization' : 'cache-first materialization and snapshot reuse')
    );
    const { semanticPapers, manifestSources, failedSources } = await materializeSourceStates(rootPath, sourceStates, materializeOptions);

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

    if (materializeOnly) {
      announceStage(materializeOptions, 2, 2, 'Writing source manifest', 'persisting reusable snapshot metadata');
      const indexedAt = new Date().toISOString();
      const shouldBackupBeforePersist = analysisOptions.backupBeforeCommit === true;
      const lockHandlers = createLockProgressHandlers(materializeOptions, {
        onWaitLog: '[lock] waiting for corpus lock while writing the Stage 1 source manifest',
        onAcquiredLog: '[lock] corpus lock acquired for Stage 1 source manifest write'
      });
      const nextManifest = createEmptyManifest({
        corpusName,
        rootPath,
        inputPath: absoluteInput,
        inputPaths: absoluteInputs,
        sourceMode,
        pdfParser,
        pdfCommand,
        semanticExtractionMode: normalizedSemanticExtractionMode,
        sources: manifestSources,
        indexedAt,
        changes
      });
      await withFileLock(getCorpusLockPath(rootPath), async () => {
        await assertAnalyzeCommitStillFresh(inputPath, rootPath, sourceStates, previousManifest, metadataConcurrency);
        if (shouldBackupBeforePersist) {
          await backupExistingCorpusRoot(rootPath, {
            backupDir: analysisOptions.backupDir
          });
        }
        await saveSourceManifest(rootPath, nextManifest);
      }, mergeLockOptions(options.lockOptions, lockHandlers));

      return {
        graph: null,
        meta: {
          name: corpusName,
          indexedAt,
          paperCount: semanticPapers.length,
          relationshipCount: 0,
          sourceCount: manifestSources.length,
          stage: 'materialized',
          semanticExtractionMode: normalizedSemanticExtractionMode,
          lastChangeSummary: changes
        },
        rootPath,
        changes,
        reused: false,
        stage: 'materialized'
      };
    }

    if (llmOnly) {
      announceStage(materializeOptions, 1, 1, 'Writing optimized snapshots', 'persisting LLM-enriched snapshot metadata');
      const indexedAt = new Date().toISOString();
      const shouldBackupBeforePersist = analysisOptions.backupBeforeCommit === true;
      const lockHandlers = createLockProgressHandlers(materializeOptions, {
        onWaitLog: '[lock] waiting for corpus lock while persisting Stage 2 optimized snapshots',
        onAcquiredLog: '[lock] corpus lock acquired for Stage 2 optimized snapshot write'
      });
      const nextManifest = createEmptyManifest({
        corpusName,
        rootPath,
        inputPath: absoluteInput,
        inputPaths: absoluteInputs,
        sourceMode,
        pdfParser,
        pdfCommand,
        semanticExtractionMode: normalizedSemanticExtractionMode,
        sources: manifestSources,
        indexedAt,
        changes
      });
      nextManifest.llmOptimization = buildLlmOptimizationState(nextManifest, analysisOptions);
      await withFileLock(getCorpusLockPath(rootPath), async () => {
        await assertAnalyzeCommitStillFresh(inputPath, rootPath, sourceStates, previousManifest, metadataConcurrency);
        if (shouldBackupBeforePersist) {
          await backupExistingCorpusRoot(rootPath, {
            backupDir: analysisOptions.backupDir
          });
        }
        await saveSourceManifest(rootPath, nextManifest);
      }, mergeLockOptions(options.lockOptions, lockHandlers));

      return {
        graph: null,
        meta: {
          name: corpusName,
          indexedAt,
          paperCount: semanticPapers.length,
          relationshipCount: 0,
          sourceCount: manifestSources.length,
          stage: 'llm-optimized',
          semanticExtractionMode: normalizedSemanticExtractionMode,
          lastChangeSummary: changes
        },
        rootPath,
        changes,
        reused: false,
        stage: 'llm-optimized'
      };
    }

    announceStage(
      analysisOptions,
      3,
      5,
      'Building graph structure',
      optimizeOnly ? 'merging optimized paper semantics into the graph' : 'projecting paper semantics into the graph'
    );
    const { graph, problemNodes, acceptedCrossPaperJudgments } = await buildGraphFromSemanticPapers({
      corpusName,
      rootPath,
      semanticPapers,
      options: analysisOptions
    });

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

    announceStage(
      analysisOptions,
      4,
      5,
      'Merging similar evaluation nodes',
      'canonicalizing near-duplicate datasets and benchmarks before commit'
    );
    const mergedGraphResult = mergeSimilarGraphNodes(graph);
    const mergedMeta = refreshMetaFromGraph(meta, mergedGraphResult.graph, mergedGraphResult.summary);

    announceStage(
      analysisOptions,
      5,
      5,
      'Writing graph and index files',
      'graph store, lite view, manifest, and enhancement queue'
    );
    const nextManifest = createEmptyManifest({
      corpusName,
      rootPath,
      inputPath: absoluteInput,
      inputPaths: absoluteInputs,
      sourceMode,
      pdfParser,
      pdfCommand,
      semanticExtractionMode: normalizedSemanticExtractionMode,
      sources: manifestSources,
      indexedAt: mergedMeta.indexedAt,
      changes
    });
    nextManifest.llmOptimization = buildLlmOptimizationState(nextManifest, analysisOptions);
    const enhancement = await commitPreparedCorpusIndex({
      rootPath,
      graph: mergedGraphResult.graph,
      meta: mergedMeta,
      manifest: nextManifest,
      sourceStateByKey,
      analysisOptions,
      validation() {
        return assertAnalyzeCommitStillFresh(inputPath, rootPath, sourceStates, previousManifest, metadataConcurrency);
      }
    });

    return {
      graph: mergedGraphResult.graph,
      meta: mergedMeta,
      rootPath,
      changes,
      reused: false,
      enhancement
    };
}

export async function llmOptimizeCorpus(inputPath, options = {}) {
  const {
    absoluteInput,
    absoluteInputs,
    rootPath
  } = await resolveCorpusInputContext(inputPath, {
    rootPath: options.rootPath
  });
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest) {
    throw new Error('No source manifest found. Run Stage 1 before running Stage 2.');
  }

  await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(manifest));

  const normalizedSemanticExtractionMode = normalizeSemanticExtractionMode(
    firstDefinedValue(options.semanticExtraction, manifest.semanticExtractionMode, 'auto')
  );
  const analysisOptions = {
    ...options,
    semanticExtraction: normalizedSemanticExtractionMode,
    enableLlmEnrichment: true,
    llmStageStep: 1,
    llmStageTotal: 1,
    llmStageTitle: 'Batch LLM optimization',
    llmStageDetail: 'semantic objects and relation extraction'
  };
  const previousJobState = !options.force ? await loadStage2JobState(rootPath) : null;

  if (
    !options.force
    && manifestHasReusableLlmOptimization(manifest, analysisOptions)
    && isReusableStage2JobState(previousJobState, manifest, analysisOptions)
  ) {
    const paperCount = (manifest.sources || []).filter((entry) => entry.activeInGraph !== false).length
      || (manifest.sources || []).length;
    return {
      graph: null,
      meta: {
        name: manifest.corpusName || options.name || path.basename(rootPath),
        indexedAt: manifest.indexedAt || new Date().toISOString(),
        paperCount,
        relationshipCount: 0,
        sourceCount: manifest.sources?.length || 0,
        stage: 'llm-optimized',
        semanticExtractionMode: normalizedSemanticExtractionMode,
        lastChangeSummary: manifest.lastChangeSummary || null
      },
      rootPath,
      changes: manifest.lastChangeSummary || null,
      reused: true,
      stage: 'llm-optimized'
    };
  }

  const records = await buildStage2RecordsFromManifest(rootPath, manifest, analysisOptions);
  const hasPendingWork = records.some((record) => {
    const refresh = summarizeLlmRefreshState(record.semanticPaper, analysisOptions);
    record.sourceState.llmRefreshState = refresh;
    return refresh.anyRequired;
  });

  if (!hasPendingWork && !options.force) {
    const jobState = previousJobState && previousJobState.token === createStage2JobToken(manifest, analysisOptions)
      ? previousJobState
      : createStage2JobState(manifest, analysisOptions);
    seedStage2JobStateFromRecords(jobState, records);
    jobState.status = 'completed';
    jobState.completedAt = new Date().toISOString();
    jobState.updatedAt = new Date().toISOString();
    await saveStage2JobState(rootPath, jobState);

    const paperCount = (manifest.sources || []).filter((entry) => entry.activeInGraph !== false).length
      || (manifest.sources || []).length;
    return {
      graph: null,
      meta: {
        name: manifest.corpusName || options.name || path.basename(rootPath),
        indexedAt: manifest.indexedAt || new Date().toISOString(),
        paperCount,
        relationshipCount: 0,
        sourceCount: manifest.sources?.length || 0,
        stage: 'llm-optimized',
        semanticExtractionMode: normalizedSemanticExtractionMode,
        lastChangeSummary: manifest.lastChangeSummary || null
      },
      rootPath,
      changes: manifest.lastChangeSummary || null,
      reused: true,
      stage: 'llm-optimized'
    };
  }

  const { nextManifest, jobState } = await runStage2LlmOptimization(
    rootPath,
    manifest,
    records,
    analysisOptions,
    previousJobState
  );

  announceStage(analysisOptions, 1, 1, 'Writing optimized snapshots', 'persisting LLM-enriched snapshot metadata');
  const shouldBackupBeforePersist = analysisOptions.backupBeforeCommit === true;
  const lockHandlers = createLockProgressHandlers(analysisOptions, {
    onWaitLog: '[lock] waiting for corpus lock while persisting Stage 2 optimized snapshots',
    onAcquiredLog: '[lock] corpus lock acquired for Stage 2 optimized snapshot write'
  });
  await withFileLock(getCorpusLockPath(rootPath), async () => {
    if (shouldBackupBeforePersist) {
      await backupExistingCorpusRoot(rootPath, {
        backupDir: analysisOptions.backupDir
      });
    }
    await saveSourceManifest(rootPath, nextManifest);
    await saveStage2JobState(rootPath, jobState);
  }, mergeLockOptions(options.lockOptions, lockHandlers));

  const paperCount = (nextManifest.sources || []).filter((entry) => entry.activeInGraph !== false).length
    || (nextManifest.sources || []).length;
  return {
    graph: null,
    meta: {
      name: nextManifest.corpusName || options.name || path.basename(rootPath),
      indexedAt: nextManifest.indexedAt || new Date().toISOString(),
      paperCount,
      relationshipCount: 0,
      sourceCount: nextManifest.sources?.length || 0,
      stage: 'llm-optimized',
      semanticExtractionMode: normalizedSemanticExtractionMode,
      lastChangeSummary: nextManifest.lastChangeSummary || null
    },
    rootPath,
    changes: nextManifest.lastChangeSummary || null,
    reused: false,
    stage: 'llm-optimized',
    inputPath: absoluteInput
  };
}

export async function buildGraphCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { rootPath, absoluteInputs } = discovery;
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest) {
    throw new Error('No source manifest found. Run Stage 1 or Stage 2 before building Stage 3.');
  }

  await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(manifest));

  const metadataConcurrency = resolveMetadataConcurrency(options);
  const stagedBuild = !options.force ? await loadStagedCorpusBuild(rootPath) : null;
  if (stagedBuild?.state?.stage === 'graph-built' && stagedBuild.state.baseManifestToken === createManifestCommitToken(manifest)) {
    try {
      await assertStagedBuildStillFresh(rootPath, stagedBuild.state, metadataConcurrency);
      return {
        graph: stagedBuild.graph,
        meta: stagedBuild.meta,
        rootPath,
        changes: stagedBuild.manifest.lastChangeSummary || null,
        reused: true,
        stage: 'graph-built'
      };
    } catch {}
  }

  announceStage(
    options,
    1,
    1,
    'Building graph structure',
    'loading semantic snapshots and persisting a staged graph build'
  );

  const { semanticPapers, failedSources } = await loadSemanticPapersFromManifest(rootPath, manifest, metadataConcurrency);
  if (!semanticPapers.length) {
    const firstFailure = failedSources[0];
    throw new Error(firstFailure?.message || 'No active semantic snapshots were available for Stage 3.');
  }

  const changes = manifest.lastChangeSummary || {
    added: 0,
    updated: 0,
    removed: 0,
    reused: manifest.sources?.length || 0
  };
  const { graph, problemNodes, acceptedCrossPaperJudgments } = await buildGraphFromSemanticPapers({
    corpusName: options.name || manifest.corpusName || path.basename(rootPath),
    rootPath,
    semanticPapers,
    options
  });
  const meta = await createMeta({
    name: options.name || manifest.corpusName || path.basename(rootPath),
    rootPath,
    graph,
    sourceMode: manifest.sourceMode || 'markdown',
    problems: problemNodes,
    semanticPapers,
    pdfParser: manifest.pdfParser || null,
    pdfCommand: manifest.pdfCommand || manifest.markerCommand || manifest.mineruCommand || null,
    semanticExtractionMode: manifest.semanticExtractionMode || normalizeSemanticExtractionMode(options.semanticExtraction || 'auto'),
    changes,
    acceptedCrossPaperJudgments,
    failedSources,
    sourceCount: manifest.sources?.length || semanticPapers.length
  });

  const stagedManifest = createEmptyManifest({
    corpusName: meta.name,
    rootPath,
    inputPath: manifest.inputPath,
    inputPaths: manifest.inputPaths,
    sourceMode: manifest.sourceMode || 'markdown',
    pdfParser: manifest.pdfParser || null,
    pdfCommand: manifest.pdfCommand || manifest.markerCommand || manifest.mineruCommand || null,
    semanticExtractionMode: manifest.semanticExtractionMode || normalizeSemanticExtractionMode(options.semanticExtraction || 'auto'),
    sources: manifest.sources || [],
    indexedAt: meta.indexedAt,
    changes
  });
  stagedManifest.llmOptimization = manifest.llmOptimization || null;
  const stagedState = {
    version: 1,
    stage: 'graph-built',
    createdAt: new Date().toISOString(),
    baseManifestToken: createManifestCommitToken(manifest),
    stagedManifestToken: createManifestCommitToken(stagedManifest),
    inputPath: manifest.inputPath,
    inputPaths: manifest.inputPaths,
    expectedSources: createSerializableSourceFingerprints(manifest.sources || [])
  };
  await saveStagedCorpusBuild(rootPath, graph, meta, stagedManifest, stagedState);

  return {
    graph,
    meta,
    rootPath,
    changes,
    reused: false,
    stage: 'graph-built'
  };
}

export async function mergeGraphCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { rootPath, absoluteInputs } = discovery;
  const stagedBuild = !options.force ? await loadStagedCorpusBuild(rootPath) : await loadStagedCorpusBuild(rootPath);
  if (!stagedBuild) {
    throw new Error('No staged graph build found. Run Stage 3 before running the merge stage.');
  }

  await assertSingleGraphInputScope(rootPath, absoluteInputs, stagedBuild.state?.inputPaths || stagedBuild.manifest?.inputPaths || stagedBuild.state?.inputPath || stagedBuild.manifest?.inputPath);

  const metadataConcurrency = resolveMetadataConcurrency(options);
  const wantsNodeLlmCheck = Boolean(NODE_LLM_CHECK_ENABLED && options.nodeLlmCheck);
  if (!options.force && stagedBuild.state?.stage === 'graph-merged' && (!wantsNodeLlmCheck || stagedBuild.state?.nodeLlmCheckRequested)) {
    try {
      await assertStagedBuildStillFresh(rootPath, stagedBuild.state, metadataConcurrency);
      return {
        graph: stagedBuild.graph,
        meta: stagedBuild.meta,
        rootPath,
        changes: stagedBuild.manifest.lastChangeSummary || null,
        reused: true,
        stage: 'graph-merged',
        mergeSummary: stagedBuild.state.mergeSummary || stagedBuild.meta.similarNodeMerge || null,
        nodeCheckSummary: stagedBuild.state.nodeLlmCheckSummary || stagedBuild.meta.nodeLlmCheck || null
      };
    } catch {}
  }

  if (!['graph-built', 'graph-merged'].includes(stagedBuild.state?.stage)) {
    throw new Error('The staged graph is missing the build output required for merging. Run Stage 3 before running the merge stage.');
  }

  announceStage(
    options,
    1,
    1,
    'Merging similar evaluation nodes',
    'canonicalizing near-duplicate datasets and benchmarks inside the staged graph'
  );

  const merged = await mergePreparedGraphBuild(rootPath, stagedBuild, options);
  return {
    graph: merged.graph,
    meta: merged.meta,
    rootPath,
    changes: merged.manifest.lastChangeSummary || null,
    reused: false,
    stage: 'graph-merged',
    mergeSummary: merged.summary,
    nodeCheckSummary: merged.nodeCheckSummary
  };
}

export async function fastCommitCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { rootPath, absoluteInputs } = discovery;
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest) {
    throw new Error('No source manifest found. Run Stage 1 or Stage 2 before fast-committing changes.');
  }

  await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(manifest));

  const paths = getCorpusPaths(rootPath);
  if (!(await fileExists(paths.liteGraphPath)) || !(await fileExists(paths.liteStatePath))) {
    await buildGraphCorpus(inputPath, options);
    await mergeGraphCorpus(inputPath, options);
    return writeIndexCorpus(inputPath, options);
  }

  const changedSourceKeys = unique((Array.isArray(options.changedSourceKeys) ? options.changedSourceKeys : []).filter(Boolean)).sort();
  if (!changedSourceKeys.length) {
    return {
      graph: null,
      meta: await loadCorpusMeta(rootPath),
      manifest,
      rootPath,
      changes: manifest.lastChangeSummary || null,
      reused: true,
      stage: 'fast-committed',
      syncJob: null
    };
  }

  announceStage(
    options,
    1,
    1,
    'Fast local graph update',
    'applying changed papers to the lite graph and queueing authoritative sync'
  );

  const [currentCorpus, liteState] = await Promise.all([
    loadCorpusLite(rootPath),
    readJson(paths.liteStatePath, null)
  ]);
  const manifestEntriesByKey = new Map((manifest.sources || []).map((entry) => [entry.sourceKey, entry]));
  const changedSemanticPapers = [];

  for (const sourceKey of changedSourceKeys) {
    const manifestEntry = manifestEntriesByKey.get(sourceKey);
    if (!manifestEntry || manifestEntry.activeInGraph === false) continue;
    const snapshot = await loadSemanticPaperSnapshot(rootPath, sourceKey);
    if (!snapshot) {
      throw new Error(`No semantic snapshot was available for ${sourceKey}. Run Stage 1 before fast-committing.`);
    }
    if (snapshot.activeInGraph !== false) {
      changedSemanticPapers.push(snapshot);
    }
  }

  const deltaPayload = await buildGraphDeltaPayload({
    corpusName: manifest.corpusName || options.name || currentCorpus.meta.name || path.basename(rootPath),
    rootPath,
    committedGraph: currentCorpus.graph,
    semanticPapers: changedSemanticPapers,
    liteState,
    changedSourceKeys,
    options
  });
  const nextGraph = applyGraphDeltaPayload(currentCorpus.graph, deltaPayload);
  const activeManifestSources = (manifest.sources || []).filter((entry) => entry.activeInGraph !== false);
  const nextMeta = {
    ...refreshMetaFromGraph(currentCorpus.meta, nextGraph, currentCorpus.meta.similarNodeMerge, currentCorpus.meta.nodeLlmCheck),
    name: currentCorpus.meta.name || manifest.corpusName || options.name || path.basename(rootPath),
    paperCount: activeManifestSources.length,
    sourceCount: manifest.sources?.length || 0,
    sourceMode: manifest.sourceMode || currentCorpus.meta.sourceMode || 'markdown',
    pdfParser: manifest.pdfParser || currentCorpus.meta.pdfParser || null,
    semanticExtractionMode: manifest.semanticExtractionMode || currentCorpus.meta.semanticExtractionMode || 'heuristic-only',
    lastChangeSummary: manifest.lastChangeSummary || currentCorpus.meta.lastChangeSummary || null
  };
  const nextManifest = {
    ...manifest,
    indexedAt: nextMeta.indexedAt
  };
  const targetManifestToken = createManifestCommitToken(nextManifest);
  const fastCommitted = await saveCorpusFastLocalDelta(rootPath, deltaPayload, nextMeta, nextManifest, {
    baseManifestToken: options.baseManifestToken || null,
    targetManifestToken,
    mode: options.mode || 'delta'
  });

  return {
    graph: nextGraph,
    meta: fastCommitted.meta,
    manifest: nextManifest,
    rootPath,
    changes: nextManifest.lastChangeSummary || null,
    reused: Boolean(fastCommitted.reused),
    stage: 'fast-committed',
    syncJob: fastCommitted.syncJob,
    deltaPayload
  };
}

export async function writeIndexCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { rootPath, absoluteInputs } = discovery;
  let stagedBuild = await loadStagedCorpusBuild(rootPath);
  if (!stagedBuild) {
    throw new Error('No staged graph build found. Run Stage 3 before running Stage 4.');
  }

  await assertSingleGraphInputScope(rootPath, absoluteInputs, stagedBuild.state?.inputPaths || stagedBuild.manifest?.inputPaths || stagedBuild.state?.inputPath || stagedBuild.manifest?.inputPath);
  const wantsNodeLlmCheck = Boolean(NODE_LLM_CHECK_ENABLED && options.nodeLlmCheck);

  if (stagedBuild.state?.stage === 'graph-built' || (wantsNodeLlmCheck && !stagedBuild.state?.nodeLlmCheckRequested)) {
    const merged = await mergePreparedGraphBuild(rootPath, stagedBuild, {
      ...options,
      quiet: true
    });
    stagedBuild = {
      rootPath,
      graph: merged.graph,
      meta: merged.meta,
      manifest: merged.manifest,
      state: merged.state
    };
  }

  announceStage(
    options,
    1,
    1,
    'Writing graph and index files',
    'committing the staged graph build into the corpus index'
  );

  const metadataConcurrency = resolveMetadataConcurrency(options);
  const commitIndexedAt = options.force ? new Date().toISOString() : stagedBuild.meta.indexedAt;
  const nextMeta = {
    ...stagedBuild.meta,
    indexedAt: commitIndexedAt
  };
  const nextManifest = {
    ...stagedBuild.manifest,
    indexedAt: commitIndexedAt
  };
  const nextManifestToken = createManifestCommitToken(nextManifest);
  const enhancement = await commitPreparedCorpusIndex({
    rootPath,
    graph: stagedBuild.graph,
    meta: nextMeta,
    manifest: nextManifest,
    sourceStateByKey: null,
    analysisOptions: options,
    validation() {
      return assertStagedBuildStillFresh(rootPath, stagedBuild.state, metadataConcurrency, [nextManifestToken]);
    },
    cleanupStagedBuild: true
  });

  return {
    graph: stagedBuild.graph,
    meta: nextMeta,
    rootPath,
    changes: nextManifest.lastChangeSummary || null,
    reused: false,
    enhancement,
    stage: 'index-written'
  };
}

async function refreshWatchedCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath
  });
  const { rootPath, absoluteInputs } = discovery;
  const manifest = await loadSourceManifest(rootPath);
  const { metaPath } = getCorpusPaths(rootPath);
  const hasCommittedIndex = await fileExists(metaPath) && await hasCorpusGraphStore(rootPath);

  if (manifest) {
    await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(manifest));

    const metadataConcurrency = resolveMetadataConcurrency(options);
    const expectedSources = createSourceFingerprintMapFromEntries(manifest.sources || []);
    const currentSources = await collectCurrentSourceFingerprintMap(inputPath, rootPath, metadataConcurrency);
    const inputSourcesChanged = !sourceFingerprintMapsEqual(expectedSources, currentSources);
    const stage2JobState = !options.force ? await loadStage2JobState(rootPath) : null;

    if (!options.force && !inputSourcesChanged && hasCommittedIndex && canReuseCommittedCorpusForWatch(manifest, options, stage2JobState)) {
      const existing = await loadCorpus(rootPath);
      const changes = createUnchangedManifestSummary(manifest);
      await registerCorpus({
        name: existing.meta.name || manifest.corpusName || path.basename(rootPath),
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

    if (!inputSourcesChanged) {
      await llmOptimizeCorpus(inputPath, options);
      await buildGraphCorpus(inputPath, options);
      await mergeGraphCorpus(inputPath, options);
      return writeIndexCorpus(inputPath, options);
    }
  }

  await materializeCorpus(inputPath, options);
  await llmOptimizeCorpus(inputPath, options);
  await buildGraphCorpus(inputPath, options);
  await mergeGraphCorpus(inputPath, options);
  return writeIndexCorpus(inputPath, options);
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
  const initialResult = await refreshWatchedCorpus(inputPath, options);
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
      const result = await refreshWatchedCorpus(inputPath, {
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

export async function materializeCorpus(inputPath, options = {}) {
  return analyzeCorpus(inputPath, {
    ...options,
    materializeOnly: true
  });
}

export async function optimizeCorpus(inputPath, options = {}) {
  await llmOptimizeCorpus(inputPath, options);
  await buildGraphCorpus(inputPath, options);
  await mergeGraphCorpus(inputPath, options);
  return writeIndexCorpus(inputPath, options);
}

export const __pipelineTestables = {
  resolveAnalyzeConcurrency,
  resolveMarkerConcurrency,
  refreshWatchedCorpus
};
