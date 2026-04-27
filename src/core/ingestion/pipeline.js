import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createKnowledgeGraph } from '../graph/graph.js';
import { applyNodeCheckDecisions, mergeSimilarGraphNodes } from '../graph/merge-similar.js';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from '../graph/schema.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from '../graph/domain-taxonomy.js';
import {
  normalizeAbstractMechanismNames,
  normalizeAbstractMechanismRecords
} from '../graph/abstract-mechanisms.js';
import {
  buildResearchQuestionNode,
  normalizeResearchQuestionRecords
} from '../graph/research-questions.js';
import {
  buildChallengeNode,
  buildChallengeVariantRecords
} from '../graph/challenges.js';
import {
  buildIdeaFragmentNode,
  buildTakeawayNode,
  normalizeEvidenceSnippetRecord,
  normalizeIdeaFragmentRecord,
  normalizeTakeawayRecord
} from '../graph/takeaways.js';
import { summarizeCorpusGraph } from '../graph/summary.js';
import { applyGraphDeltaPayload, buildGraphDeltaPayload, buildGraphDiffPayload } from '../graph/delta-commit.js';
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
import {
  createContentSha256,
  createPaperIdentifierKeys,
  createPaperIdentity,
  createSourceIdentity,
  flattenPaperIdentifiers,
  mergePaperIdentity,
  mergePaperIdentifiers,
  normalizeExactPaperTitle,
  normalizePaperIdentifierQuery,
  normalizePaperIdentifiers,
  normalizeResolutionStatus,
  paperIdentifiersConflict,
  paperStrongIdentityOverlap
} from '../../lib/paper-identifiers.js';
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
  resolveCorpus,
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
import {
  getImportPaths,
  listActiveImportSourceDirs,
  loadImportTaskFileMetadata
} from '../../storage/import-store.js';
import { registerCorpus } from '../../storage/registry.js';
import { buildLiteStateSnapshot, GLOBAL_SOURCE_KEY } from '../../storage/lite-view.js';
import {
  cacheMarkdownSource,
  convertPdfToMarkdown,
  getPdfParserProfile,
  getMarkdownSourceCachePath,
  getPdfMarkdownCachePath,
  normalizePdfParser
} from './pdf-parser.js';
import {
  assessPaperTitleCandidate,
  extractConceptCandidates,
  isPaperTitleDegenerate,
  parsePaperMarkdown
} from './markdown.js';
import { postIngestionRefinement, precomputePaperGraphFragments } from './graph-precompute.js';
import { countGraphPostprocessTasks, precomputeGraphPostprocess } from './graph-postprocess.js';
import { isServerPathReference, resolveServerPathReference } from '../../lib/server-paths.js';

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
const SEMANTIC_LLM_SIGNATURE_VERSION = 2;
const RELATION_LLM_SIGNATURE_VERSION = 1;
const STAGE2_JOB_STATE_VERSION = 1;
const CATALYST_METADATA_CONTRACT_VERSION = 1;

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

function emitPipelineProgress(options = {}, event = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (!onProgress) return;
  onProgress({
    timestamp: new Date().toISOString(),
    ...event
  });
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
  const paperIdentity = createPaperIdentity({
    title: paper.title,
    paperTitle: paper.title,
    identifiers: paper.identifiers || {},
    identityAliases: paper.identityAliases || paper.canonicalAliases || []
  });

  return {
    paperId: paper.paperId,
    paperTitle: paper.title,
    titleValidation: paper.titleValidation || assessPaperTitleCandidate(paper.title, paper.sourcePath),
    authors: paper.authors || [],
    abstract: abstract?.text || '',
    identifiers: paperIdentity.identifiers,
    normalizedTitle: paperIdentity.normalizedTitle,
    titleSignature: paperIdentity.titleSignature,
    canonicalId: paperIdentity.canonicalId,
    canonicalIdSource: paperIdentity.canonicalIdSource,
    identityConfidence: paperIdentity.identityConfidence,
    identityAliases: paperIdentity.identityAliases,
    sourcePath: paper.sourcePath,
    sourceMarkdownPath: paper.sourceMarkdownPath,
    sourcePdfPath: paper.sourcePdfPath,
    sourceKind: paper.sourceKind,
    sourceProvider: paper.sourceProvider || 'filesystem',
    sourceFingerprint: paper.sourceFingerprint,
    contentSha256: paper.contentSha256 || '',
    normalizedTextSha256: paper.normalizedTextSha256 || '',
    sourceId: paper.sourceId || '',
    resolutionStatus: paper.resolutionStatus || '',
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
    researchQuestions: [],
    openChallenges: [],
    takeaways: [],
    ideaFragments: [],
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
      metrics: [],
      abstractMechanisms: [],
      abstractMechanismObjects: [],
      researchQuestions: [],
      openChallenges: [],
      takeaways: [],
      ideaFragments: []
    },
    llmRelations: []
  };
}

function normalizePaperMetadataPayload(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  const sourceProvider = String(input?.sourceProvider || input?.provider || input?.paperMetadata?.sourceProvider || '').trim();
  if (!Object.keys(identifiers).length && !sourceProvider) {
    return null;
  }
  return {
    ...(Object.keys(identifiers).length ? { identifiers } : {}),
    ...(sourceProvider ? { sourceProvider } : {})
  };
}

function mergeSemanticPaperIdentity(semanticPaper, ...inputs) {
  if (!semanticPaper || typeof semanticPaper !== 'object') {
    return semanticPaper;
  }

  const mergedIdentity = mergePaperIdentity(
    semanticPaper,
    ...inputs
  );
  semanticPaper.identifiers = mergedIdentity.identifiers;
  semanticPaper.normalizedTitle = mergedIdentity.normalizedTitle;
  semanticPaper.titleSignature = mergedIdentity.titleSignature;
  semanticPaper.canonicalId = mergedIdentity.canonicalId;
  semanticPaper.canonicalIdSource = mergedIdentity.canonicalIdSource;
  semanticPaper.identityConfidence = mergedIdentity.identityConfidence;
  semanticPaper.identityAliases = mergedIdentity.identityAliases;
  return semanticPaper;
}

function buildPaperIdentityProperties(input = {}) {
  const identity = createPaperIdentity(input);
  return {
    ...(Object.keys(identity.identifiers).length ? { identifiers: identity.identifiers } : {}),
    ...(identity.identityAliases.length ? { identityAliases: identity.identityAliases } : {}),
    ...(identity.normalizedTitle ? { normalizedTitle: identity.normalizedTitle } : {}),
    ...(identity.titleSignature ? { titleSignature: identity.titleSignature } : {}),
    ...(identity.canonicalId ? { canonicalId: identity.canonicalId } : {}),
    ...(identity.canonicalIdSource ? { canonicalIdSource: identity.canonicalIdSource } : {}),
    ...(identity.identityConfidence ? { identityConfidence: identity.identityConfidence } : {}),
    ...(Object.keys(identity.identifiers).length ? { identifierKeys: createPaperIdentifierKeys(identity.identifiers) } : {}),
    ...flattenPaperIdentifiers(identity.identifiers)
  };
}

function applySourceIdentityEnvelope(target, sourceInput = {}, paperInput = {}) {
  if (!target || typeof target !== 'object') return target;
  const sourceIdentity = createSourceIdentity({
    ...paperInput,
    ...sourceInput
  });
  if (sourceIdentity.sourceProvider) target.sourceProvider = sourceIdentity.sourceProvider;
  if (sourceIdentity.contentSha256) target.contentSha256 = sourceIdentity.contentSha256;
  if (sourceIdentity.normalizedTextSha256) target.normalizedTextSha256 = sourceIdentity.normalizedTextSha256;
  if (sourceIdentity.sourceId) target.sourceId = sourceIdentity.sourceId;
  target.resolutionStatus = normalizeResolutionStatus(
    sourceIdentity.resolutionStatus,
    target.resolutionStatus || 'metadata_only'
  );
  return target;
}

function applyPaperIdentityEnvelope(target, ...inputs) {
  if (!target || typeof target !== 'object') return target;
  const mergedIdentity = mergePaperIdentity(target, ...inputs);
  target.identifiers = mergedIdentity.identifiers;
  target.normalizedTitle = mergedIdentity.normalizedTitle;
  target.titleSignature = mergedIdentity.titleSignature;
  target.canonicalId = mergedIdentity.canonicalId;
  target.canonicalIdSource = mergedIdentity.canonicalIdSource;
  target.identityConfidence = mergedIdentity.identityConfidence;
  target.identityAliases = mergedIdentity.identityAliases;
  Object.assign(target, flattenPaperIdentifiers(mergedIdentity.identifiers));
  return target;
}

function upgradeSemanticPaperIdentityRecord(record = {}, options = {}) {
  const nextRecord = { ...record };
  applyPaperIdentityEnvelope(nextRecord, options.paperMetadata || {});
  applySourceIdentityEnvelope(nextRecord, {
    sourceKind: nextRecord.sourceKind,
    sourceProvider: nextRecord.sourceProvider || options.sourceProvider || options.paperMetadata?.sourceProvider,
    contentSha256: nextRecord.contentSha256 || options.contentSha256,
    normalizedTextSha256: nextRecord.normalizedTextSha256 || options.normalizedTextSha256,
    resolutionStatus: nextRecord.resolutionStatus || options.resolutionStatus
  }, nextRecord);
  return nextRecord;
}

function upgradeManifestEntryIdentityRecord(entry = {}, options = {}) {
  const nextEntry = { ...entry };
  applyPaperIdentityEnvelope(nextEntry, options.paperMetadata || {}, entry.paperMetadata || {});
  applySourceIdentityEnvelope(nextEntry, {
    sourceKind: nextEntry.kind || nextEntry.sourceKind,
    sourceProvider: nextEntry.sourceProvider || options.sourceProvider || entry.paperMetadata?.sourceProvider,
    contentSha256: nextEntry.contentSha256 || options.contentSha256,
    normalizedTextSha256: nextEntry.normalizedTextSha256 || options.normalizedTextSha256,
    resolutionStatus: nextEntry.resolutionStatus || options.resolutionStatus
  }, nextEntry);
  return nextEntry;
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
    payload.researchQuestions,
    payload.openChallenges,
    payload.takeaways,
    payload.ideaFragments,
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
    rateLimitCooldownUntil: llm.rateLimitCooldownUntil || semanticObjects.rateLimitCooldownUntil || null,
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
    return `semantic:${SEMANTIC_LLM_SIGNATURE_VERSION}:disabled:${plan.requestedMode}:catalyst:${CATALYST_METADATA_CONTRACT_VERSION}`;
  }

  return JSON.stringify({
    kind: 'semantic',
    version: SEMANTIC_LLM_SIGNATURE_VERSION,
    catalystMetadataContractVersion: CATALYST_METADATA_CONTRACT_VERSION,
    requestedMode: plan.requestedMode,
    effectiveMode: plan.effectiveMode,
    provider: plan.config?.provider || 'disabled',
    model: plan.config?.model || '',
    baseUrl: plan.config?.baseUrl || ''
  });
}

function hasCatalystMetadataContract(snapshot = null) {
  const semanticObjects = snapshot?.llmSemanticObjects;
  if (!semanticObjects || typeof semanticObjects !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(semanticObjects, 'fieldOfStudy')
    && Object.prototype.hasOwnProperty.call(semanticObjects, 'fieldCandidates')
    && Object.prototype.hasOwnProperty.call(semanticObjects, 'domainTags')
    && Object.prototype.hasOwnProperty.call(semanticObjects, 'abstractMechanisms')
  );
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

function serializeSnapshotQuestionEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      domainSpecificText: String(entry?.domainSpecificText || '').trim(),
      domainAgnosticText: String(entry?.domainAgnosticText || '').trim(),
      relatedProblems: Array.isArray(entry?.relatedProblems) ? [...entry.relatedProblems].sort() : [],
      relatedMechanisms: Array.isArray(entry?.relatedMechanisms) ? [...entry.relatedMechanisms].sort() : []
    }))
    .filter((entry) => entry.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function serializeSnapshotChallengeEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      domainSpecificText: String(entry?.domainSpecificText || '').trim(),
      domainAgnosticText: String(entry?.domainAgnosticText || '').trim(),
      challengeType: String(entry?.challengeType || '').trim(),
      relatedMechanisms: Array.isArray(entry?.relatedMechanisms) ? [...entry.relatedMechanisms].sort() : []
    }))
    .filter((entry) => entry.name)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function serializeSnapshotSnippetEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      text: String(entry?.text || entry?.evidenceText || '').trim(),
      sectionHeading: String(entry?.sectionHeading || '').trim(),
      sectionRole: String(entry?.sectionRole || '').trim(),
      confidence: Number.isFinite(Number(entry?.confidence)) ? Number(entry.confidence) : null
    }))
    .filter((entry) => entry.text)
    .sort((left, right) => `${left.sectionHeading}:${left.text}`.localeCompare(`${right.sectionHeading}:${right.text}`));
}

function serializeSnapshotTakeawayEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      text: String(entry?.text || '').trim(),
      sourceDomains: Array.isArray(entry?.sourceDomains) ? [...entry.sourceDomains].sort() : [],
      relatedMechanisms: Array.isArray(entry?.relatedMechanisms) ? [...entry.relatedMechanisms].sort() : [],
      relatedChallenges: Array.isArray(entry?.relatedChallenges) ? [...entry.relatedChallenges].sort() : [],
      supportingSnippets: serializeSnapshotSnippetEntries(entry?.supportingSnippets || [])
    }))
    .filter((entry) => entry.name || entry.text)
    .sort((left, right) => `${left.name}:${left.text}`.localeCompare(`${right.name}:${right.text}`));
}

function serializeSnapshotIdeaFragmentEntries(entries = []) {
  return (entries || [])
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      text: String(entry?.text || '').trim(),
      targetDomain: String(entry?.targetDomain || '').trim(),
      sourceDomains: Array.isArray(entry?.sourceDomains) ? [...entry.sourceDomains].sort() : [],
      relatedMechanisms: Array.isArray(entry?.relatedMechanisms) ? [...entry.relatedMechanisms].sort() : [],
      sourceTakeaways: Array.isArray(entry?.sourceTakeaways) ? [...entry.sourceTakeaways].sort() : [],
      addressesChallenges: Array.isArray(entry?.addressesChallenges) ? [...entry.addressesChallenges].sort() : [],
      supportingSnippets: serializeSnapshotSnippetEntries(entry?.supportingSnippets || [])
    }))
    .filter((entry) => entry.name || entry.text)
    .sort((left, right) => `${left.name}:${left.text}`.localeCompare(`${right.name}:${right.text}`));
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
    canonicalId: semanticPaper.canonicalId || '',
    sourceId: semanticPaper.sourceId || '',
    identityAliases: semanticPaper.identityAliases || [],
    identifiers: normalizePaperIdentifiers(semanticPaper.identifiers || {}),
    normalizedTitle: semanticPaper.normalizedTitle || '',
    titleSignature: semanticPaper.titleSignature || '',
    sourceProvider: semanticPaper.sourceProvider || '',
    contentSha256: semanticPaper.contentSha256 || '',
    normalizedTextSha256: semanticPaper.normalizedTextSha256 || '',
    resolutionStatus: semanticPaper.resolutionStatus || 'metadata_only',
    semanticConfigSignature: semanticPaper.llmSemanticObjects?.configSignature || semanticPaper.llm?.semanticConfigSignature || null,
    relationConfigSignature: semanticPaper.llm?.relationConfigSignature || null,
    semanticObjects: {
      problems: serializeSnapshotSlotEntries(semanticPaper.problems),
      methods: serializeSnapshotSlotEntries(semanticPaper.methods),
      claims: serializeSnapshotSlotEntries(semanticPaper.claims),
      findings: serializeSnapshotSlotEntries(semanticPaper.findings),
      researchGoals: serializeSnapshotSlotEntries(semanticPaper.researchGoals),
      researchQuestions: serializeSnapshotQuestionEntries(semanticPaper.researchQuestions),
      openChallenges: serializeSnapshotChallengeEntries(semanticPaper.openChallenges),
      takeaways: serializeSnapshotTakeawayEntries(semanticPaper.takeaways),
      ideaFragments: serializeSnapshotIdeaFragmentEntries(semanticPaper.ideaFragments),
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

function getFutureIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function summarizeLlmRefreshState(snapshot, options = {}, maxRetries = 3) {
  if (!snapshot) {
    return {
      semanticRequired: false,
      relationRequired: false,
      anyRequired: false
    };
  }

  const rateLimitCooldownUntil = getFutureIsoTimestamp(
    snapshot.llm?.rateLimitCooldownUntil
    || snapshot.llmSemanticObjects?.rateLimitCooldownUntil
  );
  const rateLimitCooldownActive = Boolean(rateLimitCooldownUntil);
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
  const semanticMissingCatalystMetadata = semanticConfiguredNow
    && !hasCatalystMetadataContract(snapshot);
  const semanticRetryableFailure = semanticConfiguredNow
    && semanticRetryCount < maxRetries
    && !semanticSummary.participated
    && ['request-failed', 'llm-unconfigured'].includes(semanticSummary.reason);
  const semanticRateLimitExpired = semanticConfiguredNow
    && !rateLimitCooldownActive
    && !semanticSummary.participated
    && semanticSummary.reason === 'rate-limited';

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
  const relationRateLimitExpired = relationConfiguredNow
    && !rateLimitCooldownActive
    && relationPreviouslyAttemptedForCurrentConfig
    && snapshot.llm?.relationParticipationReason === 'rate-limited';

  const semanticRequired = !rateLimitCooldownActive
    && (semanticMissingForCurrentConfig || semanticMissingCatalystMetadata || semanticRetryableFailure || semanticRateLimitExpired);
  const relationRequired = !rateLimitCooldownActive
    && (relationMissingForCurrentConfig || relationRetryableFailure || relationRateLimitExpired);

  return {
    semanticRequired,
    relationRequired,
    anyRequired: semanticRequired || relationRequired,
    rateLimitCooldownActive,
    rateLimitCooldownUntil
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
    semanticPaper.researchQuestions = mergeSemanticSlotsByMode(semanticPaper.researchQuestions, semanticObjects.researchQuestions, 4, semanticExtractionMode);
    semanticPaper.openChallenges = mergeSemanticSlotsByMode(semanticPaper.openChallenges, semanticObjects.openChallenges, 5, semanticExtractionMode);
    semanticPaper.takeaways = mergeSemanticSlotsByMode(semanticPaper.takeaways, semanticObjects.takeaways, 6, semanticExtractionMode);
    semanticPaper.ideaFragments = mergeSemanticSlotsByMode(semanticPaper.ideaFragments, semanticObjects.ideaFragments, 6, semanticExtractionMode);
    semanticPaper.limitations = mergeSemanticSlotsByMode(semanticPaper.limitations, semanticObjects.limitations, 5, semanticExtractionMode);
    semanticPaper.assumptions = mergeSemanticSlotsByMode(semanticPaper.assumptions, semanticObjects.assumptions, 5, semanticExtractionMode);
    semanticPaper.evidences = mergeSemanticSlotsByMode(semanticPaper.evidences, semanticObjects.evidences, 8, semanticExtractionMode);
    semanticPaper.futureDirections = mergeSemanticSlotsByMode(semanticPaper.futureDirections, semanticObjects.futureDirections, 4, semanticExtractionMode);
    semanticPaper.benchmarks = mergeSemanticSlotsByMode(semanticPaper.benchmarks, semanticObjects.benchmarks, 8, semanticExtractionMode);
    semanticPaper.datasets = mergeSemanticSlotsByMode(semanticPaper.datasets, semanticObjects.datasets, 6, semanticExtractionMode);
    semanticPaper.metrics = mergeSemanticSlotsByMode(semanticPaper.metrics, semanticObjects.metrics, 6, semanticExtractionMode);
    if (semanticObjects.fieldOfStudy) {
      semanticPaper.fieldOfStudy = semanticObjects.fieldOfStudy;
    }
    if (Array.isArray(semanticObjects.fieldCandidates) && semanticObjects.fieldCandidates.length) {
      semanticPaper.fieldCandidates = semanticObjects.fieldCandidates;
    }
    if (Array.isArray(semanticObjects.domainTags) && semanticObjects.domainTags.length) {
      semanticPaper.domainTags = semanticObjects.domainTags;
    }
    if (Array.isArray(semanticObjects.abstractMechanisms) && semanticObjects.abstractMechanisms.length) {
      semanticPaper.abstractMechanisms = semanticObjects.abstractMechanisms;
    }
    if (Array.isArray(semanticObjects.abstractMechanismObjects) && semanticObjects.abstractMechanismObjects.length) {
      semanticPaper.abstractMechanismObjects = semanticObjects.abstractMechanismObjects;
    }
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

  const rateLimitCooldownUntil = semanticObjects.rateLimitCooldownUntil || inference.rateLimitCooldownUntil || null;
  semanticPaper.llm = {
    provider: inference.provider !== 'disabled' ? inference.provider : semanticObjects.provider,
    error: inference.error || semanticObjects.error,
    relationCount: inference.relations.length,
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
    rateLimitCooldownUntil,
    semanticExtractionMode: semanticExtractionPlan.requestedMode,
    semanticExtractionModeEffective: semanticExtractionMode,
    semanticExtractionAttempted: semanticObjects.attempted,
    semanticExtractionParticipated: semanticObjects.participated,
    semanticExtractionParticipationReason: semanticObjects.reason,
    relationParticipationReason: inference.reason || null,
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
    rateLimitCooldownUntil: semanticObjects.rateLimitCooldownUntil || null,
    error: semanticObjects.error,
    problems: semanticObjects.problems,
    methods: semanticObjects.methods,
    claims: semanticObjects.claims,
    findings: semanticObjects.findings,
    researchGoals: semanticObjects.researchGoals,
    researchQuestions: semanticObjects.researchQuestions,
    openChallenges: semanticObjects.openChallenges,
    takeaways: semanticObjects.takeaways,
    ideaFragments: semanticObjects.ideaFragments,
    limitations: semanticObjects.limitations,
    assumptions: semanticObjects.assumptions,
    evidences: semanticObjects.evidences,
    futureDirections: semanticObjects.futureDirections,
    benchmarks: semanticObjects.benchmarks,
    datasets: semanticObjects.datasets,
    metrics: semanticObjects.metrics,
    fieldOfStudy: semanticObjects.fieldOfStudy || null,
    fieldCandidates: Array.isArray(semanticObjects.fieldCandidates) ? semanticObjects.fieldCandidates : [],
    domainTags: Array.isArray(semanticObjects.domainTags) ? semanticObjects.domainTags : [],
    abstractMechanisms: Array.isArray(semanticObjects.abstractMechanisms) ? semanticObjects.abstractMechanisms : [],
    abstractMechanismObjects: Array.isArray(semanticObjects.abstractMechanismObjects)
      ? semanticObjects.abstractMechanismObjects
      : []
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
        error: semanticObjects.error || null,
        rateLimitCooldownUntil: semanticObjects.rateLimitCooldownUntil || null,
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
        rateLimitCooldownUntil: inference.rateLimitCooldownUntil || null,
        relationCount: inference.relations.length,
        relationConfigSignature,
        relationParticipationReason: inference.reason || null,
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
    error: semanticObjects.error || null,
    rateLimitCooldownUntil: semanticObjects.rateLimitCooldownUntil || null,
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
    rateLimitCooldownUntil: inference.rateLimitCooldownUntil || null,
    relationCount: inference.relations.length,
    relationConfigSignature: createRelationConfigSignature(options),
    relationParticipationReason: inference.reason || null,
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
  } else {
    const rateLimitCooldownUntil = getLlmRateLimitCooldownUntilFromPapers(records);
    if (rateLimitCooldownUntil) {
      nextManifest.llmOptimization = buildLlmOptimizationCooldownState(nextManifest, options, rateLimitCooldownUntil);
    }
  }
  nextManifest.sources.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  return nextManifest;
}

async function runStage2LlmOptimization(rootPath, manifest, records, options = {}, existingJobState = null) {
  const quiet = Boolean(options.quiet);
  const scopedToChangedSources = normalizeChangedSourceKeySet(options.changedSourceKeys).size > 0;
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
  let llmCompletedUnits = 0;
  announceStage(
    options,
    options.llmStageStep || 1,
    options.llmStageTotal || 1,
    options.llmStageTitle || 'Batch LLM optimization',
    options.llmStageDetail || 'semantic objects and relation extraction'
  );

  const formatBatchLabel = (batchNumber, totalBatches, completed, total) =>
    `batch ${batchNumber}/${Math.max(1, totalBatches)}, ${Math.min(completed, total)}/${total} papers completed`;

  const relationPendingCount = records.filter((record) => record.sourceState.llmRefreshState.relationRequired).length;
  const totalLlmUnits = semanticPending.length + relationPendingCount;
  emitPipelineProgress(options, {
    stage: 'llm-optimize',
    currentStep: semanticPending.length ? 'semantic extraction' : 'relation extraction',
    processedUnits: 0,
    totalUnits: totalLlmUnits,
    stagePercent: totalLlmUnits ? 0 : 100,
    message: 'Starting batch LLM optimization'
  });

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
      llmCompletedUnits = Math.min(start + batchRecords.length, semanticPending.length);
      emitPipelineProgress(options, {
        stage: 'llm-optimize',
        currentStep: 'semantic extraction',
        processedUnits: llmCompletedUnits,
        totalUnits: totalLlmUnits,
        stagePercent: totalLlmUnits ? ((llmCompletedUnits / totalLlmUnits) * 100) : 100,
        message: formatBatchLabel(jobState.phases.semantic.lastBatchNumber, totalBatches, start + batchRecords.length, semanticPending.length)
      });
      semanticProgress.update(
        Math.min(start + batchRecords.length, semanticPending.length),
        formatBatchLabel(jobState.phases.semantic.lastBatchNumber, totalBatches, start + batchRecords.length, semanticPending.length)
      );
    }
    semanticProgress.done();
  }

  const relationPending = [];
  for (const record of records) {
    if (record.sourceState.llmRefreshState?.scopedOut) {
      continue;
    }
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
      llmCompletedUnits = semanticPending.length + Math.min(start + batchRecords.length, relationPending.length);
      emitPipelineProgress(options, {
        stage: 'llm-optimize',
        currentStep: 'relation extraction',
        processedUnits: llmCompletedUnits,
        totalUnits: totalLlmUnits,
        stagePercent: totalLlmUnits ? ((llmCompletedUnits / totalLlmUnits) * 100) : 100,
        message: formatBatchLabel(jobState.phases.relation.lastBatchNumber, totalBatches, start + batchRecords.length, relationPending.length)
      });
      relationProgress.update(
        Math.min(start + batchRecords.length, relationPending.length),
        formatBatchLabel(jobState.phases.relation.lastBatchNumber, totalBatches, start + batchRecords.length, relationPending.length)
      );
    }
    relationProgress.done();
  }

  for (const record of records) {
    if (record.sourceState.llmRefreshState?.scopedOut) {
      continue;
    }
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
  const scopedWorkCompleted = records.every((record) => {
    if (record.sourceState.llmRefreshState?.scopedOut) {
      return true;
    }
    const refresh = summarizeLlmRefreshState(record.semanticPaper, options);
    return !refresh.anyRequired && !refresh.rateLimitCooldownActive;
  });
  const manifestOptimizationCompleted = scopedWorkCompleted && !scopedToChangedSources;
  jobState.status = manifestOptimizationCompleted ? 'completed' : 'partial';
  jobState.completedAt = manifestOptimizationCompleted ? new Date().toISOString() : null;
  jobState.updatedAt = new Date().toISOString();
  await saveStage2JobState(rootPath, jobState);
  emitPipelineProgress(options, {
    stage: 'llm-optimize',
    currentStep: scopedWorkCompleted ? 'llm optimization complete' : 'llm optimization partial',
    processedUnits: totalLlmUnits,
    totalUnits: totalLlmUnits,
    stagePercent: scopedWorkCompleted ? 100 : (totalLlmUnits ? ((llmCompletedUnits / totalLlmUnits) * 100) : 100),
    message: scopedWorkCompleted
      ? (scopedToChangedSources ? 'Completed scoped batch LLM optimization' : 'Completed batch LLM optimization')
      : 'LLM optimization finished with pending work'
  });

  const nextManifest = createStage2ManifestFromRecords(rootPath, manifest, records, {
    ...options,
    semanticExtraction: normalizedSemanticExtractionMode,
    completed: manifestOptimizationCompleted
  });
  if (manifestOptimizationCompleted) {
    jobState.token = createStage2JobToken(nextManifest, options);
    jobState.manifestToken = createManifestCommitToken(nextManifest);
  }

  return {
    nextManifest,
    jobState,
    completed: scopedWorkCompleted
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
  const mergeStringSet = (target, values = []) => {
    for (const value of values || []) {
      if (value) target.add(value);
    }
  };

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
          description: node.properties?.description,
          text: node.properties?.text || '',
          canonicalId: node.properties?.canonicalId || '',
          normalizedName: node.properties?.normalizedName || '',
          challengeType: node.properties?.challengeType || '',
          abstractionLevel: node.properties?.abstractionLevel || '',
          domainSpecificText: node.properties?.domainSpecificText || '',
          domainAgnosticText: node.properties?.domainAgnosticText || '',
          retrievalText: node.properties?.retrievalText || '',
          analogyText: node.properties?.analogyText || '',
          bridgeRetrievalText: node.properties?.bridgeRetrievalText || '',
          targetDomain: node.properties?.targetDomain || '',
          fieldOfStudy: node.properties?.fieldOfStudy || '',
          fieldCandidates: new Set(node.properties?.fieldCandidates || []),
          domainTags: new Set(node.properties?.domainTags || []),
          abstractMechanisms: new Set(node.properties?.abstractMechanisms || []),
          relatedProblems: new Set(node.properties?.relatedProblems || []),
          sourceDomains: new Set(node.properties?.sourceDomains || []),
          relatedChallenges: new Set(node.properties?.relatedChallenges || []),
          sourceTakeaways: new Set(node.properties?.sourceTakeaways || []),
          addressesChallenges: new Set(node.properties?.addressesChallenges || [])
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
      if (!group.text && node.properties?.text) group.text = node.properties.text;
      if (!group.canonicalId && node.properties?.canonicalId) group.canonicalId = node.properties.canonicalId;
      if (!group.normalizedName && node.properties?.normalizedName) group.normalizedName = node.properties.normalizedName;
      if (!group.challengeType && node.properties?.challengeType) group.challengeType = node.properties.challengeType;
      if (!group.abstractionLevel && node.properties?.abstractionLevel) group.abstractionLevel = node.properties.abstractionLevel;
      if (!group.domainSpecificText && node.properties?.domainSpecificText) group.domainSpecificText = node.properties.domainSpecificText;
      if (!group.domainAgnosticText && node.properties?.domainAgnosticText) group.domainAgnosticText = node.properties.domainAgnosticText;
      if (!group.retrievalText && node.properties?.retrievalText) group.retrievalText = node.properties.retrievalText;
      if (!group.analogyText && node.properties?.analogyText) group.analogyText = node.properties.analogyText;
      if (!group.bridgeRetrievalText && node.properties?.bridgeRetrievalText) group.bridgeRetrievalText = node.properties.bridgeRetrievalText;
      if (!group.targetDomain && node.properties?.targetDomain) group.targetDomain = node.properties.targetDomain;
      if (!group.fieldOfStudy && node.properties?.fieldOfStudy) group.fieldOfStudy = node.properties.fieldOfStudy;
      mergeStringSet(group.fieldCandidates, node.properties?.fieldCandidates);
      mergeStringSet(group.domainTags, node.properties?.domainTags);
      mergeStringSet(group.abstractMechanisms, node.properties?.abstractMechanisms);
      mergeStringSet(group.relatedProblems, node.properties?.relatedProblems);
      mergeStringSet(group.sourceDomains, node.properties?.sourceDomains);
      mergeStringSet(group.relatedChallenges, node.properties?.relatedChallenges);
      mergeStringSet(group.sourceTakeaways, node.properties?.sourceTakeaways);
      mergeStringSet(group.addressesChallenges, node.properties?.addressesChallenges);
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
          ...(group.description ? { description: group.description } : {}),
          ...(group.text ? { text: group.text } : {}),
          ...(group.canonicalId ? { canonicalId: group.canonicalId } : {}),
          ...(group.normalizedName ? { normalizedName: group.normalizedName } : {}),
          ...(group.challengeType ? { challengeType: group.challengeType } : {}),
          ...(group.abstractionLevel ? { abstractionLevel: group.abstractionLevel } : {}),
          ...(group.domainSpecificText ? { domainSpecificText: group.domainSpecificText } : {}),
          ...(group.domainAgnosticText ? { domainAgnosticText: group.domainAgnosticText } : {}),
          ...(group.retrievalText ? { retrievalText: group.retrievalText } : {}),
          ...(group.analogyText ? { analogyText: group.analogyText } : {}),
          ...(group.bridgeRetrievalText ? { bridgeRetrievalText: group.bridgeRetrievalText } : {}),
          ...(group.targetDomain ? { targetDomain: group.targetDomain } : {}),
          ...(group.fieldOfStudy ? { fieldOfStudy: group.fieldOfStudy } : {}),
          ...(group.fieldCandidates.size ? { fieldCandidates: [...group.fieldCandidates].sort() } : {}),
          ...(group.domainTags.size ? { domainTags: [...group.domainTags].sort() } : {}),
          ...(group.abstractMechanisms.size ? { abstractMechanisms: [...group.abstractMechanisms].sort() } : {}),
          ...(group.relatedProblems.size ? { relatedProblems: [...group.relatedProblems].sort() } : {}),
          ...(group.sourceDomains.size ? { sourceDomains: [...group.sourceDomains].sort() } : {}),
          ...(group.relatedChallenges.size ? { relatedChallenges: [...group.relatedChallenges].sort() } : {}),
          ...(group.sourceTakeaways.size ? { sourceTakeaways: [...group.sourceTakeaways].sort() } : {}),
          ...(group.addressesChallenges.size ? { addressesChallenges: [...group.addressesChallenges].sort() } : {})
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
  const domainTags = normalizeDomainTags(paper.domainTags || []);
  const fieldCandidates = normalizeDomainTags(paper.fieldCandidates || []);
  const fieldOfStudy = normalizeFieldOfStudy(paper.fieldOfStudy, [
    ...domainTags,
    ...fieldCandidates
  ]);
  const abstractMechanismObjects = normalizeAbstractMechanismRecords(
    paper.abstractMechanismObjects || paper.abstractMechanisms || paper.mechanismHints || []
  );
  const abstractMechanisms = normalizeAbstractMechanismNames(abstractMechanismObjects);
  const identityProperties = buildPaperIdentityProperties(paper);
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
      sourceProvider: paper.sourceProvider,
      sourceFingerprint: paper.sourceFingerprint,
      sourceId: paper.sourceId,
      resolutionStatus: paper.resolutionStatus || 'metadata_only',
      contentSha256: paper.contentSha256,
      normalizedTextSha256: paper.normalizedTextSha256,
      sourceIds: Array.isArray(paper.sourceIds) ? paper.sourceIds : undefined,
      availableSourceKinds: Array.isArray(paper.availableSourceKinds) ? paper.availableSourceKinds : undefined,
      sourceVariants: Array.isArray(paper.sourceVariants) ? paper.sourceVariants : undefined,
      ...identityProperties,
      fieldOfStudy,
      fieldCandidates,
      domainTags,
      abstractMechanisms,
      abstractMechanismObjects
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

  postIngestionRefinement(graph);

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
  const graphSummary = summarizeCorpusGraph(graph);

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
    ...graphSummary,
    topProblems,
    pdfParser: pdfParser || null,
    pdfCommand: pdfCommand || null,
    semanticExtractionMode,
    markerCommand: pdfParser === 'marker' ? (pdfCommand || null) : null,
    mineruCommand: pdfParser === 'mineru' ? (pdfCommand || null) : null,
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
  const graphSummary = summarizeCorpusGraph(graph);

  return {
    ...previousMeta,
    indexedAt: new Date().toISOString(),
    ...graphSummary,
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

async function computeSourceContentSha256(inputPath, previousEntry = null, currentFingerprint = '') {
  const previousFingerprint = String(previousEntry?.fingerprint || previousEntry?.sourceFingerprint || '').trim();
  const previousContentSha256 = String(previousEntry?.contentSha256 || '').trim();
  if (previousContentSha256 && previousFingerprint && currentFingerprint && previousFingerprint === currentFingerprint) {
    return previousContentSha256;
  }

  return createContentSha256(await fs.readFile(inputPath));
}

function computeNormalizedTextSha256(value = '') {
  const normalized = normalizeText(String(value || '')).replace(/\s+/g, ' ').trim();
  return normalized ? createContentSha256(normalized) : '';
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

function inferSourceModeFromManifestSources(sources = [], fallback = 'markdown') {
  const kinds = new Set(
    (sources || [])
      .map((entry) => String(entry?.kind || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (kinds.size > 1) return 'mixed';
  if (kinds.has('pdf')) return 'pdf';
  if (kinds.has('markdown')) return 'markdown';
  return fallback || 'markdown';
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
      canonicalId: entry.canonicalId || null,
      sourceId: entry.sourceId || null,
      sourceProvider: entry.sourceProvider || null,
      contentSha256: entry.contentSha256 || null,
      identifierKeys: createPaperIdentifierKeys(entry.identifiers || entry.paperMetadata || {}),
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
    catalystMetadataContractVersion: CATALYST_METADATA_CONTRACT_VERSION,
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
    token: createLlmOptimizationToken(manifest, options)
  };
}

function getLlmRateLimitCooldownUntilFromPapers(items = []) {
  let latest = 0;
  for (const item of items || []) {
    const paper = item?.semanticPaper || item;
    const timestamp = Date.parse(String(
      paper?.llm?.rateLimitCooldownUntil
      || paper?.llmSemanticObjects?.rateLimitCooldownUntil
      || ''
    ));
    if (Number.isFinite(timestamp) && timestamp > Date.now() && timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function buildLlmOptimizationCooldownState(manifest, options = {}, rateLimitCooldownUntil = null) {
  return {
    version: 1,
    completedAt: null,
    catalystMetadataContractVersion: CATALYST_METADATA_CONTRACT_VERSION,
    semanticConfigSignature: createSemanticConfigSignature(options),
    relationConfigSignature: createRelationConfigSignature(options),
    token: null,
    rateLimitCooldownUntil
  };
}

function manifestHasReusableLlmOptimization(manifest, options = {}) {
  if (!manifest?.llmOptimization?.token) return false;
  if (manifest.llmOptimization.catalystMetadataContractVersion !== CATALYST_METADATA_CONTRACT_VERSION) {
    return false;
  }
  return manifest.llmOptimization.token === createLlmOptimizationToken(manifest, options);
}

function manifestNeedsCatalystMetadataBackfill(manifest) {
  if (!manifest?.sources?.length) return false;
  if (getFutureIsoTimestamp(manifest.llmOptimization?.rateLimitCooldownUntil)) return false;
  if (!manifest.llmOptimization?.token) return true;
  return manifest.llmOptimization.catalystMetadataContractVersion !== CATALYST_METADATA_CONTRACT_VERSION;
}

function backfillSemanticExtractionMode(options = {}) {
  return normalizeSemanticExtractionMode(
    firstDefinedValue(options.semanticExtraction, options.llmSemanticExtraction, 'llm-assisted')
  );
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

async function collectCurrentSourceFingerprintMap(inputPath, rootPath, metadataConcurrency, discoveryOptions = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath,
    ...discoveryOptions
  });
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

async function assertAnalyzeCommitStillFresh(inputPath, rootPath, sourceStates, previousManifest, metadataConcurrency, discoveryOptions = {}) {
  const latestManifest = await loadSourceManifest(rootPath);
  const baseToken = createManifestCommitToken(previousManifest);
  const latestToken = createManifestCommitToken(latestManifest);
  if (baseToken !== latestToken) {
    throw new Error('Another PaperNexus run committed newer corpus state while this run was processing. Re-run the command to continue from the latest snapshots.');
  }

  const expectedSources = createSourceFingerprintMap(sourceStates);
  const currentSources = await collectCurrentSourceFingerprintMap(inputPath, rootPath, metadataConcurrency, discoveryOptions);
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
      entry: upgradeManifestEntryIdentityRecord(entry),
      snapshot: upgradeSemanticPaperIdentityRecord(
        await loadSemanticPaperSnapshot(rootPath, entry.sourceKey)
      )
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
        sources: [{ kind: 'pdf', inputPath: absoluteInput, sourceKey: absoluteInput, sourceProvider: 'filesystem' }]
      };
    }

    if (extension === '.md' || extension === '.markdown') {
      return {
        inputPath: absoluteInput,
        inputStats,
        sources: [{ kind: 'markdown', inputPath: absoluteInput, sourceKey: absoluteInput, sourceProvider: 'filesystem' }]
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
      sourceKey: filePath,
      sourceProvider: 'filesystem'
    })),
    ...markdownFiles.map((filePath) => ({
      kind: 'markdown',
      inputPath: filePath,
      sourceKey: filePath,
      sourceProvider: 'filesystem'
    }))
  ];

  return {
    inputPath: absoluteInput,
    inputStats,
    sources: files
  };
}

function isTaskImportSourcePath(rootPath, inputPath) {
  const normalizedPath = path.resolve(String(inputPath || ''));
  if (!normalizedPath) return false;
  const { tasksDir } = getImportPaths(rootPath);
  return normalizedPath.startsWith(`${tasksDir}${path.sep}`);
}

async function collectPersistentImportManifestSources(rootPath, manifest, existingSourceKeys = new Set()) {
  const manifestSources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const persistentSources = [];

  for (const entry of manifestSources) {
    if (!entry?.sourceKey || existingSourceKeys.has(entry.sourceKey)) {
      continue;
    }

    const inputPath = path.resolve(String(entry.inputPath || entry.sourcePath || ''));
    if (!inputPath || !isTaskImportSourcePath(rootPath, inputPath)) {
      continue;
    }
    if (!await fileExists(inputPath)) {
      continue;
    }

    const extension = path.extname(inputPath).toLowerCase();
    const kind = entry.kind || (extension === '.pdf' ? 'pdf' : 'markdown');
    if (kind !== 'pdf' && kind !== 'markdown') {
      continue;
    }

    persistentSources.push({
      kind,
      inputPath,
      sourceKey: entry.sourceKey,
      sourceProvider: entry.sourceProvider || 'filesystem'
    });
  }

  return persistentSources.sort((left, right) => left.inputPath.localeCompare(right.inputPath));
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
  const importInputDirs = options.includeActiveImportSources === false
    ? []
    : await listActiveImportSourceDirs(rootPath);
  const importInputEntries = importInputDirs.length
    ? await mapWithConcurrency(
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
    )
    : [];
  const inputEntries = [
    ...baseInputEntries,
    ...importInputEntries.filter(Boolean)
  ];

  for (const entry of inputEntries) {
    for (const source of entry.sources) {
      dedupedSources.set(source.sourceKey, source);
    }
  }

  const manifest = await loadSourceManifest(rootPath);
  if (options.includePersistentImportSources !== false) {
    const persistentImportSources = await collectPersistentImportManifestSources(
      rootPath,
      manifest,
      new Set(dedupedSources.keys())
    );
    for (const source of persistentImportSources) {
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
  const paperMetadata = normalizePaperMetadataPayload(
    sourceState.paperMetadata || semanticPaper.identifiers || semanticPaper || {}
  );
  return upgradeManifestEntryIdentityRecord({
    sourceKey: sourceState.sourceKey,
    inputPath: sourceState.inputPath,
    kind: sourceState.kind,
    sourceKind: sourceState.kind,
    sourceProvider: semanticPaper.sourceProvider || sourceState.sourceProvider || 'filesystem',
    fingerprint: sourceState.fingerprint,
    sourceFingerprint: sourceState.fingerprint,
    sourceMtimeMs: Number(sourceState.sourceMtimeMs || 0),
    sourceSizeBytes: Number(sourceState.sourceSizeBytes || 0),
    paperId: semanticPaper.paperId,
    paperTitle: semanticPaper.paperTitle,
    identifiers: semanticPaper.identifiers || {},
    sourcePath: semanticPaper.sourcePath,
    sourceMarkdownPath: semanticPaper.sourceMarkdownPath,
    sourcePdfPath: semanticPaper.sourcePdfPath,
    canonicalId: semanticPaper.canonicalId || '',
    canonicalIdSource: semanticPaper.canonicalIdSource || '',
    identityConfidence: semanticPaper.identityConfidence || 'provisional',
    identityAliases: semanticPaper.identityAliases || [],
    normalizedTitle: semanticPaper.normalizedTitle || '',
    titleSignature: semanticPaper.titleSignature || '',
    contentSha256: semanticPaper.contentSha256 || sourceState.contentSha256 || '',
    normalizedTextSha256: semanticPaper.normalizedTextSha256 || '',
    sourceId: semanticPaper.sourceId || '',
    resolutionStatus: semanticPaper.resolutionStatus || '',
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
    sourceIds: Array.isArray(semanticPaper.sourceIds) ? semanticPaper.sourceIds : (semanticPaper.sourceId ? [semanticPaper.sourceId] : []),
    paperMetadata,
    ...extra
  }, {
    paperMetadata,
    contentSha256: semanticPaper.contentSha256 || sourceState.contentSha256 || '',
    normalizedTextSha256: semanticPaper.normalizedTextSha256 || ''
  });
}

function createSourceStateFromManifestEntry(entry) {
  const normalizedEntry = upgradeManifestEntryIdentityRecord(entry);
  return {
    sourceKey: normalizedEntry.sourceKey,
    inputPath: normalizedEntry.inputPath,
    kind: normalizedEntry.kind,
    sourceKind: normalizedEntry.kind,
    sourceProvider: normalizedEntry.sourceProvider || 'filesystem',
    sourceId: normalizedEntry.sourceId || '',
    contentSha256: normalizedEntry.contentSha256 || '',
    resolutionStatus: normalizedEntry.resolutionStatus || 'metadata_only',
    fingerprint: normalizedEntry.fingerprint || normalizedEntry.sourceFingerprint,
    sourceMtimeMs: Number(normalizedEntry.sourceMtimeMs || 0),
    sourceSizeBytes: Number(normalizedEntry.sourceSizeBytes || 0),
    previous: normalizedEntry,
    markdownCachePath: normalizedEntry.markdownCachePath || normalizedEntry.sourceMarkdownPath || null,
    markdownCacheFingerprint: normalizedEntry.markdownCacheFingerprint || normalizedEntry.fingerprint || normalizedEntry.sourceFingerprint || null,
    markdownCacheExists: true,
    markdownCacheNeedsRefresh: false,
    cachedPaper: null,
    paperMetadata: normalizePaperMetadataPayload(normalizedEntry.paperMetadata || normalizedEntry),
    llmRefreshState: {
      semanticRequired: false,
      relationRequired: false,
      anyRequired: false
    },
    reuseCachedMaterialization: true
  };
}

function createEmptyMaterializeTimings() {
  return {
    totalMs: 0,
    pdfToMarkdownMs: 0,
    markdownReadMs: 0,
    markdownParseMs: 0,
    semanticSnapshotMs: 0,
    parser: {
      probeHttpMs: 0,
      pdfReadMs: 0,
      mineruRequestMs: 0,
      markdownWriteMs: 0
    }
  };
}

function mergeMaterializeTimings(target = createEmptyMaterializeTimings(), source = {}) {
  for (const key of ['totalMs', 'pdfToMarkdownMs', 'markdownReadMs', 'markdownParseMs', 'semanticSnapshotMs']) {
    const value = Number(source?.[key] || 0);
    if (Number.isFinite(value) && value > 0) {
      target[key] = Number(target[key] || 0) + value;
    }
  }

  for (const key of ['probeHttpMs', 'pdfReadMs', 'mineruRequestMs', 'markdownWriteMs']) {
    const value = Number(source?.parser?.[key] || 0);
    if (Number.isFinite(value) && value > 0) {
      target.parser[key] = Number(target.parser[key] || 0) + value;
    }
  }

  return target;
}

async function buildStage2RecordsFromManifest(rootPath, manifest, options = {}) {
  const metadataConcurrency = resolveMetadataConcurrency(options);
  const records = await mapWithConcurrency(manifest.sources || [], metadataConcurrency, async (entry) => {
    const sourceState = createSourceStateFromManifestEntry(entry);
    let semanticPaper = upgradeSemanticPaperIdentityRecord(
      await loadSemanticPaperSnapshot(rootPath, entry.sourceKey)
    );
    let parsedPaper = null;

    if (!semanticPaper) {
      parsedPaper = await loadParsedPaperFromMarkdownCache(sourceState);
      if (!parsedPaper) {
        throw new Error(`No semantic snapshot or markdown cache was available for ${entry.sourceKey}. Run Stage 1 before Stage 2.`);
      }
      semanticPaper = buildSemanticPaperView(parsedPaper);
      mergeSemanticPaperIdentity(semanticPaper, sourceState.paperMetadata || {});
      applySourceIdentityEnvelope(semanticPaper, {
        sourceKind: sourceState.kind,
        sourceProvider: sourceState.sourceProvider,
        contentSha256: sourceState.contentSha256,
        normalizedTextSha256: parsedPaper.normalizedTextSha256
      }, semanticPaper);
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

function normalizeChangedSourceKeySet(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
}

function disableLlmRefreshForScopedOutRecord(record) {
  record.sourceState.llmRefreshState = {
    semanticRequired: false,
    relationRequired: false,
    anyRequired: false,
    scopedOut: true
  };
}

function scopeStage2RecordsToChangedSources(records = [], changedSourceKeys = []) {
  const changedSourceKeySet = normalizeChangedSourceKeySet(changedSourceKeys);
  if (!changedSourceKeySet.size) {
    return {
      scoped: false,
      records
    };
  }

  for (const record of records) {
    if (!changedSourceKeySet.has(record.sourceState.sourceKey)) {
      disableLlmRefreshForScopedOutRecord(record);
    }
  }

  return {
    scoped: true,
    records
  };
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

function countParsedPaperBodyCharacters(parsed = {}) {
  return (parsed.sections || [])
    .filter((section) => section.role !== 'references')
    .reduce((total, section) => total + String(section.text || '').trim().length, 0);
}

function parsedPaperHasUsableBody(parsed = {}) {
  const bodyCharacters = countParsedPaperBodyCharacters(parsed);
  const nonReferenceSections = (parsed.sections || []).filter((section) => section.role !== 'references');
  const chunkCount = nonReferenceSections.reduce((total, section) => total + (section.chunks?.length || 0), 0);
  return bodyCharacters >= 1200 || chunkCount >= 3;
}

function shouldFallbackToDoclingForDegenerateTitle(parsed = {}, options = {}) {
  const rawMode = firstDefinedValue(
    options.doclingFallbackOnDegenerateTitle,
    options.pdfFallbackOnDegenerateTitle,
    'content-poor'
  );
  const mode = String(rawMode).trim().toLowerCase();
  if (['1', 'true', 'yes', 'always'].includes(mode)) return true;
  if (['0', 'false', 'no', 'never', 'off'].includes(mode)) return false;
  return !parsedPaperHasUsableBody(parsed);
}

function repairDegenerateParsedTitle(parsed = {}, sourcePath = '') {
  const titleValidation = parsed.titleValidation || assessPaperTitleCandidate(parsed.title, sourcePath);
  const fallbackTitle = titleValidation.fallbackTitle || path.basename(sourcePath || 'paper', path.extname(sourcePath || '')) || 'paper';
  parsed.title = fallbackTitle;
  parsed.paperTitle = fallbackTitle;
  parsed.titleValidation = {
    ...titleValidation,
    displayTitle: fallbackTitle,
    fallbackTitle,
    isValid: true,
    usedFallbackTitle: true,
    needsReparse: false,
    repairedFromDegenerateTitle: true,
    originalReason: titleValidation.reason || null,
    reason: 'fallback-title-repair'
  };
  return parsed;
}

async function materializeSemanticPaper(rootPath, sourceState, options = {}) {
  const { markdownDir, markerDir } = getCorpusPaths(rootPath);
  let markdownPath = sourceState.inputPath;
  let sourcePdfPath = null;
  let pdfCommand = null;
  let parserUsed = sourceState.kind;
  const timings = createEmptyMaterializeTimings();
  const materializeStartedAt = Date.now();

  async function readAndParseMarkdown(targetMarkdownPath, targetSourcePdfPath) {
    const markdownReadStartedAt = Date.now();
    const markdown = await readText(targetMarkdownPath);
    timings.markdownReadMs += Date.now() - markdownReadStartedAt;
    const markdownParseStartedAt = Date.now();
    const parsed = parsePaperMarkdown(markdown, sourceState.inputPath || targetMarkdownPath);
    timings.markdownParseMs += Date.now() - markdownParseStartedAt;
    parsed.paperId = `paper:${stableHash(sourceState.sourceKey)}`;
    parsed.paperTitle = parsed.title;
    parsed.sourceKey = sourceState.sourceKey;
    parsed.sourcePath = sourceState.inputPath;
    parsed.sourceMarkdownPath = targetMarkdownPath;
    parsed.sourcePdfPath = targetSourcePdfPath;
    parsed.sourceKind = sourceState.kind;
    parsed.sourceProvider = sourceState.sourceProvider || 'filesystem';
    parsed.sourceFingerprint = sourceState.fingerprint;
    parsed.identifiers = mergePaperIdentifiers(
      sourceState.paperMetadata || {},
      parsed.identifiers || {}
    ).identifiers;
    parsed.contentSha256 = sourceState.contentSha256 || '';
    parsed.normalizedTextSha256 = computeNormalizedTextSha256(markdown);
    return parsed;
  }

  if (sourceState.kind === 'pdf') {
    const convertStartedAt = Date.now();
    let converted = await convertPdfToMarkdown(sourceState.inputPath, {
      rootPath,
      sourceKey: sourceState.sourceKey,
      importTaskId: options.importTaskId,
      importStage: options.importTaskId ? 'materialize' : null,
      pdfParser: options.pdfParser,
      pdfCommand: options.pdfCommand,
      pythonCommand: options.pythonCommand,
      force: Boolean(sourceState.markdownCacheNeedsRefresh),
      markitdownPython: options.markitdownPython,
      markitdownUseLlm: options.markitdownUseLlm,
      markitdownEnablePlugins: options.markitdownEnablePlugins,
      markitdownLlmPrompt: options.markitdownLlmPrompt,
      markpdfdownPython: options.markpdfdownPython,
      opendataloaderPdfPython: options.opendataloaderPdfPython,
      doclingPython: options.doclingPython,
      doclingCommand: options.doclingCommand,
      doclingUseVlm: options.doclingUseVlm,
      doclingVlmPreset: options.doclingVlmPreset,
      doclingOcrEngine: options.doclingOcrEngine,
      doclingSshHost: options.doclingSshHost,
      doclingPdfBackend: options.doclingPdfBackend,
      doclingDevice: options.doclingDevice,
      doclingCudaVisibleDevices: options.doclingCudaVisibleDevices,
      doclingAutoGpu: options.doclingAutoGpu,
      doclingGpuLockRoot: options.doclingGpuLockRoot,
      doclingGpuMinFreeMb: options.doclingGpuMinFreeMb,
      doclingGpuWaitTimeoutMs: options.doclingGpuWaitTimeoutMs,
      doclingGpuPollIntervalMs: options.doclingGpuPollIntervalMs,
      doclingGpuLockStaleMs: options.doclingGpuLockStaleMs,
      doclingCpuThreads: options.doclingCpuThreads,
      doclingArtifactsPath: options.doclingArtifactsPath,
      doclingImageExportMode: options.doclingImageExportMode,
      doclingEnrichPictureClasses: options.doclingEnrichPictureClasses,
      doclingEnrichPictureDescription: options.doclingEnrichPictureDescription,
      doclingPreload: options.doclingPreload,
      doclingPreloadTimeoutMs: options.doclingPreloadTimeoutMs,
      pdfParserSshHost: options.pdfParserSshHost,
      markerCommand: options.markerCommand,
      markerSshHost: options.markerSshHost,
      markerBlockBlacklist: options.markerBlockBlacklist,
      mineruCommand: options.mineruCommand,
      mineruHttpUrl: options.mineruHttpUrl,
      paddleocrVlPython: options.paddleocrVlPython,
      paddleocrVlServerUrl: options.paddleocrVlServerUrl,
      paddleocrVlLayoutModel: options.paddleocrVlLayoutModel,
      pageRange: options.pageRange,
      pdfSshHost: options.pdfSshHost,
      llmProvider: options.llmProvider,
      llmModel: options.llmModel,
      llmBaseUrl: options.llmBaseUrl,
      llmApiKey: options.llmApiKey,
      llmApiKeyEnv: options.llmApiKeyEnv,
      llmApiKeySource: options.llmApiKeySource,
      llmApiKeyService: options.llmApiKeyService,
      llmApiKeyAccount: options.llmApiKeyAccount,
      llmMaxTokens: options.llmMaxTokens,
      markerDir,
      markdownDir
    });
    timings.pdfToMarkdownMs += Date.now() - convertStartedAt;
    mergeMaterializeTimings(timings, {
      parser: converted.timings || null
    });
    markdownPath = converted.markdownPath;
    sourcePdfPath = converted.sourcePdfPath;
    pdfCommand = converted.parserCommand || converted.markerCommand || null;
    parserUsed = converted.parser || normalizePdfParser(options.pdfParser);

    let parsed = await readAndParseMarkdown(markdownPath, sourcePdfPath);
    if (parsed.titleValidation?.needsReparse && parserUsed !== 'docling') {
      const rawTitle = parsed.titleValidation.rawTitle || parsed.title;
      if (shouldFallbackToDoclingForDegenerateTitle(parsed, options)) {
        process.stderr.write(
          `[materialize:${path.basename(sourceState.inputPath)}] Detected degenerate title "${rawTitle}" with weak markdown body; reparsing with docling\n`
        );
        const doclingStartedAt = Date.now();
        converted = await convertPdfToMarkdown(sourceState.inputPath, {
          ...options,
          rootPath,
          sourceKey: sourceState.sourceKey,
          importTaskId: options.importTaskId,
          importStage: options.importTaskId ? 'materialize' : null,
          pdfParser: 'docling',
          pdfCommand: options.doclingCommand || options.pdfCommand,
          force: true,
          markerDir,
          markdownDir
        });
        timings.pdfToMarkdownMs += Date.now() - doclingStartedAt;
        mergeMaterializeTimings(timings, {
          parser: converted.timings || null
        });
        markdownPath = converted.markdownPath;
        sourcePdfPath = converted.sourcePdfPath;
        pdfCommand = converted.parserCommand || converted.markerCommand || null;
        parsed = await readAndParseMarkdown(markdownPath, sourcePdfPath);
      } else {
        process.stderr.write(
          `[materialize:${path.basename(sourceState.inputPath)}] Detected degenerate title "${rawTitle}"; using fallback title "${parsed.titleValidation.fallbackTitle || parsed.title}" because markdown body is usable\n`
        );
        parsed = repairDegenerateParsedTitle(parsed, sourceState.inputPath);
      }
    }

    const semanticSnapshotStartedAt = Date.now();
    const semanticPaper = buildSemanticPaperView(parsed);
    mergeSemanticPaperIdentity(semanticPaper, sourceState.paperMetadata || {});
    applySourceIdentityEnvelope(semanticPaper, {
      sourceKind: sourceState.kind,
      sourceProvider: sourceState.sourceProvider,
      contentSha256: sourceState.contentSha256,
      normalizedTextSha256: parsed.normalizedTextSha256
    }, semanticPaper);
    timings.semanticSnapshotMs += Date.now() - semanticSnapshotStartedAt;
    timings.totalMs = Date.now() - materializeStartedAt;

    return {
      parsedPaper: parsed,
      semanticPaper,
      markerCommand: pdfCommand,
      timings
    };
  } else if (sourceState.kind === 'markdown') {
    const cached = await cacheMarkdownSource(sourceState.inputPath, {
      markdownDir,
      force: Boolean(sourceState.markdownCacheNeedsRefresh)
    });
    markdownPath = cached.markdownPath;
  }

  const parsed = await readAndParseMarkdown(markdownPath, sourcePdfPath);

  const semanticSnapshotStartedAt = Date.now();
  const semanticPaper = buildSemanticPaperView(parsed);
  mergeSemanticPaperIdentity(semanticPaper, sourceState.paperMetadata || {});
  applySourceIdentityEnvelope(semanticPaper, {
    sourceKind: sourceState.kind,
    sourceProvider: sourceState.sourceProvider,
    contentSha256: sourceState.contentSha256,
    normalizedTextSha256: parsed.normalizedTextSha256
  }, semanticPaper);
  timings.semanticSnapshotMs += Date.now() - semanticSnapshotStartedAt;
  timings.totalMs = Date.now() - materializeStartedAt;

  return {
    parsedPaper: parsed,
    semanticPaper,
    markerCommand: pdfCommand,
    timings
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
  const parsed = parsePaperMarkdown(markdown, sourceState.inputPath || markdownPath);
  parsed.paperId = cachedPaper?.paperId || `paper:${stableHash(sourceState.sourceKey)}`;
  parsed.paperTitle = parsed.title;
  parsed.sourceKey = sourceState.sourceKey;
  parsed.sourcePath = sourceState.inputPath;
  parsed.sourceMarkdownPath = markdownPath;
  parsed.sourcePdfPath = sourceState.kind === 'pdf' ? sourceState.inputPath : null;
  parsed.sourceKind = sourceState.kind;
  parsed.sourceProvider = sourceState.sourceProvider || cachedPaper?.sourceProvider || 'filesystem';
  parsed.sourceFingerprint = sourceState.fingerprint;
  parsed.identifiers = mergePaperIdentifiers(
    cachedPaper?.identifiers || {},
    sourceState.paperMetadata || {},
    parsed.identifiers || {}
  ).identifiers;
  parsed.contentSha256 = sourceState.contentSha256 || cachedPaper?.contentSha256 || '';
  parsed.normalizedTextSha256 = computeNormalizedTextSha256(markdown);
  return parsed;
}

function paperHasDegenerateTitle(paper, sourcePath = '') {
  if (!paper) return false;
  if (paper.titleValidation?.isValid === false) return true;
  return isPaperTitleDegenerate(
    paper.paperTitle || paper.title || '',
    sourcePath || paper.sourcePath || paper.sourceKey || ''
  );
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
  const profile = getPdfParserProfile(parser, options);
  if (parser === 'marker') {
    return resolveMarkerConcurrency(options);
  }

  const available = resolveAvailableParallelism(options);
  const semanticPlan = resolveSemanticExtractionPlan(options);
  const llmEnabled = semanticPlan.requestedMode !== 'heuristic-only' || canAttemptLlmRelations(options);
  let concurrency = Math.min(available, profile.recommendedConcurrency);

  if (llmEnabled && profile.allowLlmConcurrencyBoost !== false) {
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
  const titleValidation = paper?.titleValidation || assessPaperTitleCandidate(
    paper?.paperTitle || paper?.title || '',
    paper?.sourcePath || paper?.sourceKey || ''
  );
  if (titleValidation?.isValid === false) return '';

  const title = normalizeExactPaperTitle(paper?.normalizedTitle || paper?.paperTitle || paper?.title || '');
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
  if (paperIdentifiersConflict(leftPaper?.identifiers || {}, rightPaper?.identifiers || {})) {
    return false;
  }

  const leftCanonicalId = String(leftPaper?.canonicalId || '').trim();
  const rightCanonicalId = String(rightPaper?.canonicalId || '').trim();
  if (leftCanonicalId && rightCanonicalId && leftCanonicalId === rightCanonicalId) {
    return true;
  }

  if (paperStrongIdentityOverlap(leftPaper || {}, rightPaper || {})) {
    return true;
  }

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

  const mergedIdentity = mergePaperIdentity(
    ...group.map((record) => record.semanticPaper || {}),
    ...group.map((record) => record.sourceState?.previous || {}),
    ...group.map((record) => record.sourceState?.paperMetadata || {})
  );
  const identitySeed = mergedIdentity.canonicalId
    || createPaperTitleKey(canonicalRecord?.semanticPaper)
    || canonicalRecord?.sourceState?.sourceKey
    || '';
  return `paper:${stableHash(`canonical:${identitySeed}`)}`;
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
    const mergedIdentity = mergePaperIdentity(
      ...group.map((record) => record.semanticPaper || {}),
      ...group.map((record) => record.sourceState?.previous || {}),
      ...group.map((record) => record.sourceState?.paperMetadata || {})
    );
    const sourceProviders = unique(group.map((record) => record.semanticPaper.sourceProvider || record.sourceState.sourceProvider || 'filesystem').filter(Boolean));
    const sourceIds = unique(group.map((record) => record.semanticPaper.sourceId || '').filter(Boolean));

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
        sourceVariants: sourceKeys,
        sourceProviders,
        sourceIds,
        sourceProvider: record.semanticPaper.sourceProvider || record.sourceState.sourceProvider || sourceProviders[0] || 'filesystem',
        identifiers: mergedIdentity.identifiers,
        normalizedTitle: mergedIdentity.normalizedTitle,
        titleSignature: mergedIdentity.titleSignature,
        canonicalId: mergedIdentity.canonicalId,
        canonicalIdSource: mergedIdentity.canonicalIdSource,
        identityConfidence: mergedIdentity.identityConfidence,
        identityAliases: mergedIdentity.identityAliases
      };
      applySourceIdentityEnvelope(normalizedPaper, {
        sourceKind: normalizedPaper.sourceKind || record.sourceState.kind,
        sourceProvider: normalizedPaper.sourceProvider,
        contentSha256: normalizedPaper.contentSha256,
        normalizedTextSha256: normalizedPaper.normalizedTextSha256
      }, normalizedPaper);
      if (Array.isArray(normalizedPaper.sourceIds) && normalizedPaper.sourceId) {
        normalizedPaper.sourceIds = unique([...normalizedPaper.sourceIds, normalizedPaper.sourceId]).sort();
      }

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

function createDegenerateScrubChangeSummary(remainingCount, removedCount) {
  return {
    added: 0,
    updated: 0,
    removed: removedCount,
    reused: remainingCount
  };
}

function buildScrubRecoveryOptions(manifest = {}, options = {}) {
  const parser = normalizePdfParser(firstDefinedValue(options.pdfParser, manifest.pdfParser));
  const manifestPdfCommand = firstDefinedValue(manifest.pdfCommand, manifest.markerCommand, manifest.mineruCommand);
  return {
    ...options,
    quiet: true,
    pdfParser: parser,
    pdfCommand: firstDefinedValue(options.pdfCommand, manifestPdfCommand),
    markitdownPython: firstDefinedValue(
      options.markitdownPython,
      parser === 'markitdown' ? manifestPdfCommand : undefined
    ),
    markitdownUseLlm: firstDefinedValue(options.markitdownUseLlm, manifest.markitdownUseLlm),
    markitdownEnablePlugins: firstDefinedValue(options.markitdownEnablePlugins, manifest.markitdownEnablePlugins),
    markitdownLlmPrompt: firstDefinedValue(options.markitdownLlmPrompt, manifest.markitdownLlmPrompt),
    markpdfdownPython: firstDefinedValue(
      options.markpdfdownPython,
      parser === 'markpdfdown' ? manifestPdfCommand : undefined
    ),
    opendataloaderPdfPython: firstDefinedValue(
      options.opendataloaderPdfPython,
      parser === 'opendataloader' ? manifestPdfCommand : undefined
    ),
    markerCommand: firstDefinedValue(
      options.markerCommand,
      parser === 'marker' ? manifestPdfCommand : undefined
    ),
    mineruCommand: firstDefinedValue(
      options.mineruCommand,
      parser === 'mineru' ? manifestPdfCommand : undefined
    ),
    doclingCommand: firstDefinedValue(
      options.doclingCommand,
      parser === 'docling' ? manifestPdfCommand : undefined
    )
  };
}

async function recoverMissingSemanticSnapshot(rootPath, entry, manifest = {}, options = {}) {
  const sourceState = createSourceStateFromManifestEntry(entry);
  const cachedPaper = {
    paperId: entry.paperId || `paper:${stableHash(sourceState.sourceKey)}`,
    sourceMarkdownPath: entry.sourceMarkdownPath || entry.markdownCachePath || null,
    sourceFingerprint: entry.sourceFingerprint || entry.fingerprint || null,
    identifiers: normalizePaperIdentifiers(entry.identifiers || entry.paperMetadata || {})
  };

  const parsedFromCache = await loadParsedPaperFromMarkdownCache(sourceState, cachedPaper);
  if (parsedFromCache) {
    const semanticPaper = buildSemanticPaperView(parsedFromCache);
    await saveSemanticPaperSnapshot(rootPath, entry.sourceKey, semanticPaper);
    return {
      semanticPaper,
      recoveredFrom: 'markdown-cache'
    };
  }

  if (!sourceState.inputPath || !await fileExists(sourceState.inputPath)) {
    return {
      semanticPaper: null,
      recoveredFrom: null
    };
  }

  const materialized = await materializeSemanticPaper(
    rootPath,
    sourceState,
    buildScrubRecoveryOptions(manifest, options)
  );
  await saveSemanticPaperSnapshot(rootPath, entry.sourceKey, materialized.semanticPaper);
  return {
    semanticPaper: materialized.semanticPaper,
    recoveredFrom: 'source-rematerialized'
  };
}

async function recanonicalizeManifestEntries(rootPath, manifestEntries = [], manifest = {}, options = {}) {
  if (!manifestEntries.length) {
    return {
      sources: [],
      removedEntries: []
    };
  }

  const materializedSources = [];
  const removedEntries = [];
  for (const entry of manifestEntries) {
    let snapshot = upgradeSemanticPaperIdentityRecord(
      await loadSemanticPaperSnapshot(rootPath, entry.sourceKey)
    );
    if (!snapshot) {
      const recovered = await recoverMissingSemanticSnapshot(rootPath, entry, manifest, options);
      snapshot = recovered.semanticPaper;
      if (!snapshot) {
        removedEntries.push({
          sourceKey: entry.sourceKey,
          inputPath: entry.inputPath,
          paperId: entry.paperId || null,
          paperTitle: entry.paperTitle || null,
          sourceMissing: true,
          recoveryFailed: true
        });
        continue;
      }
    }

    materializedSources.push({
      sourceState: createSourceStateFromManifestEntry(entry),
      semanticPaper: snapshot,
      markerCommand: entry.markerCommand || null
    });
  }

  if (!materializedSources.length) {
    return {
      sources: [],
      removedEntries
    };
  }

  const { normalizedRecords } = canonicalizeMaterializedSources(materializedSources);
  await mapWithConcurrency(normalizedRecords, resolveMetadataConcurrency(options), async (record) => {
    await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
    return record.sourceState.sourceKey;
  });
  return {
    sources: normalizedRecords
      .map((record) => {
        const previousEntry = record.sourceState.previous || {};
        return {
          ...previousEntry,
          ...buildManifestEntry(
            rootPath,
            createSourceStateFromManifestEntry(previousEntry),
            record.semanticPaper,
            previousEntry.markerCommand || null
          ),
          excludedReason: null,
          excludedAt: null
        };
      })
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
    removedEntries
  };
}

function normalizePaperRefreshTitle(value = '') {
  return normalizeText(String(value || '')).replace(/\s+/g, ' ').trim();
}

function normalizePaperRefreshPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isServerPathReference(raw)) {
    return path.resolve(resolveServerPathReference(raw));
  }
  return path.resolve(raw);
}

function inferPaperRefreshSourceKind(candidatePath = '', fallbackKind = '') {
  const extension = path.extname(String(candidatePath || '')).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  return fallbackKind || 'markdown';
}

function resolvePaperRefreshInputSpec(entry, reference = {}) {
  const requestedSource = String(reference.source || '').trim();
  const requestedPath = normalizePaperRefreshPath(requestedSource);
  const candidateSpecs = unique([
    entry.inputPath,
    entry.sourcePath,
    entry.sourcePdfPath,
    entry.sourceMarkdownPath,
    entry.markdownCachePath
  ].filter(Boolean).map((candidatePath) => normalizePaperRefreshPath(candidatePath))).map((candidatePath) => ({
    inputPath: candidatePath,
    kind: inferPaperRefreshSourceKind(candidatePath, entry.kind)
  }));

  if (requestedPath) {
    const matched = candidateSpecs.find((candidate) => candidate.inputPath === requestedPath);
    if (matched) {
      return {
        inputPath: matched.inputPath,
        kind: matched.kind,
        selectedBy: 'requested-source'
      };
    }
  }

  const fallbackInputPath = normalizePaperRefreshPath(entry.inputPath || entry.sourcePath || '');
  return {
    inputPath: fallbackInputPath,
    kind: inferPaperRefreshSourceKind(fallbackInputPath, entry.kind),
    selectedBy: 'manifest-input'
  };
}

function manifestEntryMatchesPaperRefresh(entry, reference = {}) {
  const paperId = String(reference.paperId || '').trim();
  const sourceKey = String(reference.sourceKey || '').trim();
  const source = String(reference.source || '').trim();
  const paperTitle = normalizePaperRefreshTitle(reference.paperTitle || reference.title || '');

  if (!paperId && !sourceKey && !source && !paperTitle) {
    throw new Error('Missing paper refresh selector. Pass paperId, sourceKey, source, or paperTitle.');
  }

  if (paperId && String(entry.paperId || '').trim() !== paperId) {
    return false;
  }

  if (sourceKey && String(entry.sourceKey || '').trim() !== sourceKey) {
    return false;
  }

  if (paperTitle) {
    const candidateTitle = normalizePaperRefreshTitle(entry.paperTitle || '');
    if (!candidateTitle || candidateTitle !== paperTitle) {
      return false;
    }
  }

  if (source) {
    const requestedPath = normalizePaperRefreshPath(source);
    const candidatePaths = unique([
      entry.inputPath,
      entry.sourcePath,
      entry.sourceMarkdownPath,
      entry.sourcePdfPath,
      entry.markdownCachePath
    ].filter(Boolean).map((candidate) => normalizePaperRefreshPath(candidate)));
    if (!candidatePaths.includes(requestedPath)) {
      return false;
    }
  }

  return true;
}

function getManifestEntryPaperGroupKey(entry) {
  return String(
    entry.canonicalSourceKey
    || entry.duplicateOfSourceKey
    || entry.paperId
    || entry.sourceKey
    || ''
  ).trim();
}

function formatPaperRefreshEntry(entry) {
  return {
    sourceKey: entry.sourceKey,
    paperId: entry.paperId || null,
    paperTitle: entry.paperTitle || null,
    canonicalId: entry.canonicalId || null,
    sourceId: entry.sourceId || null,
    inputPath: entry.inputPath || entry.sourcePath || null,
    activeInGraph: entry.activeInGraph !== false,
    canonicalSourceKey: entry.canonicalSourceKey || entry.sourceKey,
    duplicateOfSourceKey: entry.duplicateOfSourceKey || null
  };
}

function summarizePaperRefreshChanges(totalSourceCount, refreshedCount, removedCount) {
  return {
    added: 0,
    updated: Number(refreshedCount || 0),
    removed: Number(removedCount || 0),
    reused: Math.max(0, Number(totalSourceCount || 0) - Number(refreshedCount || 0) - Number(removedCount || 0))
  };
}

function normalizeBackfillSourcePaths(sourcePaths = []) {
  return new Set(
    (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => path.resolve(value))
  );
}

function manifestEntryMatchesBackfillSelectors(entry, sourcePathSet = new Set(), sourceKeySet = new Set()) {
  if (sourceKeySet.has(String(entry.sourceKey || '').trim())) {
    return true;
  }

  if (!sourcePathSet.size) {
    return false;
  }

  const candidatePaths = unique([
    entry.inputPath,
    entry.sourcePath,
    entry.sourceMarkdownPath,
    entry.sourcePdfPath,
    entry.markdownCachePath
  ].filter(Boolean).map((value) => path.resolve(String(value))));

  return candidatePaths.some((candidatePath) => sourcePathSet.has(candidatePath));
}

export async function backfillPaperIdentifiers(rootPath, options = {}) {
  const identifiers = normalizePaperIdentifierQuery(options.identifiers || options);
  if (!Object.keys(identifiers).length) {
    return {
      updated: false,
      matchedSources: [],
      updatedSources: [],
      updatedPaperIds: []
    };
  }

  const sourcePathSet = normalizeBackfillSourcePaths(options.sourcePaths || []);
  const sourceKeySet = new Set(
    (Array.isArray(options.sourceKeys) ? options.sourceKeys : [options.sourceKeys])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  return withFileLock(getCorpusLockPath(rootPath), async () => {
    const manifest = await loadSourceManifest(rootPath);
    if (!manifest?.sources?.length) {
      return {
        updated: false,
        matchedSources: [],
        updatedSources: [],
        updatedPaperIds: []
      };
    }

    const normalizedManifestSources = (manifest.sources || []).map((entry) => upgradeManifestEntryIdentityRecord(entry));
    const matchedEntries = normalizedManifestSources.filter((entry) => (
      manifestEntryMatchesBackfillSelectors(entry, sourcePathSet, sourceKeySet)
    ));
    if (!matchedEntries.length) {
      return {
        updated: false,
        matchedSources: [],
        updatedSources: [],
        updatedPaperIds: []
      };
    }

    const targetPaperIds = new Set(matchedEntries.map((entry) => String(entry.paperId || '').trim()).filter(Boolean));
    const targetSourceKeys = new Set(
      normalizedManifestSources
        .filter((entry) => targetPaperIds.size
          ? targetPaperIds.has(String(entry.paperId || '').trim())
          : matchedEntries.includes(entry))
        .map((entry) => String(entry.sourceKey || '').trim())
        .filter(Boolean)
    );

    let updatedSources = [];
    const nextSources = normalizedManifestSources.map((entry) => {
      if (!targetSourceKeys.has(String(entry.sourceKey || '').trim())) {
        return entry;
      }

      const nextEntry = upgradeManifestEntryIdentityRecord({
        ...entry,
        paperMetadata: normalizePaperMetadataPayload({
          ...(entry.paperMetadata || {}),
          identifiers: mergePaperIdentifiers(entry, identifiers).identifiers
        })
      }, {
        paperMetadata: { identifiers }
      });
      if (JSON.stringify(entry) === JSON.stringify(nextEntry)) {
        return entry;
      }

      updatedSources.push(entry.sourceKey);
      return nextEntry;
    });

    if (!updatedSources.length) {
      return {
        updated: false,
        matchedSources: matchedEntries.map((entry) => entry.sourceKey),
        updatedSources: [],
        updatedPaperIds: [...targetPaperIds].sort()
      };
    }

    const activeSources = nextSources.filter((entry) => entry.activeInGraph !== false);
    const updatedSourceKeySet = new Set(updatedSources);
    await mapWithConcurrency(updatedSources, Math.min(resolveMetadataConcurrency(options), Math.max(updatedSources.length, 1)), async (sourceKey) => {
      const snapshot = upgradeSemanticPaperIdentityRecord(
        await loadSemanticPaperSnapshot(rootPath, sourceKey)
      );
      if (!snapshot) return;
      const nextSnapshot = upgradeSemanticPaperIdentityRecord(snapshot, {
        paperMetadata: { identifiers }
      });
      if (JSON.stringify(snapshot) === JSON.stringify(nextSnapshot)) {
        return;
      }
      await saveSemanticPaperSnapshot(rootPath, sourceKey, nextSnapshot);
    });

    const { graph, meta } = await loadCorpus(rootPath);
    const updatedPaperIds = new Set();
    for (const entry of nextSources) {
      const paperId = String(entry.paperId || '').trim();
      if (!paperId || !updatedSourceKeySet.has(String(entry.sourceKey || '').trim())) continue;
      const node = graph.getNode(paperId);
      if (!node) continue;
      const nextProperties = {
        ...node.properties,
        ...buildPaperIdentityProperties(entry)
      };
      if (JSON.stringify(node.properties || {}) !== JSON.stringify(nextProperties)) {
        node.properties = nextProperties;
      }
      updatedPaperIds.add(paperId);
    }

    const nextManifest = {
      ...manifest,
      indexedAt: new Date().toISOString(),
      sources: nextSources
    };
    const nextMeta = {
      ...meta,
      indexedAt: nextManifest.indexedAt
    };

    await saveCorpus(rootPath, graph, nextMeta, {
      liteViewMode: 'incremental',
      liteViewSources: activeSources
    });
    await saveSourceManifest(rootPath, nextManifest);

    return {
      updated: true,
      matchedSources: matchedEntries.map((entry) => entry.sourceKey),
      updatedSources: updatedSources.sort(),
      updatedPaperIds: [...updatedPaperIds].sort()
    };
  }, options.lockOptions);
}

async function createPaperRefreshSourceState(rootPath, entry, analysisOptions = {}) {
  const inputSpec = resolvePaperRefreshInputSpec(entry, analysisOptions);
  const inputPath = String(inputSpec.inputPath || '').trim();
  if (!inputPath) {
    throw new Error(`Cannot refresh ${entry.sourceKey} because it does not have an inputPath.`);
  }

  if (!await fileExists(inputPath)) {
    throw new Error(
      `Cannot refresh ${entry.sourceKey} because its source file is missing at ${inputPath}. `
      + 'Re-upload the paper or use `papernexus scrub-degenerate-papers` if it should be removed.'
    );
  }

  const stats = await fs.stat(inputPath);
  const fingerprint = createSourceFingerprint(stats);
  const contentSha256 = await computeSourceContentSha256(inputPath, entry, fingerprint);
  const expectedMarkdownCachePath = resolveExpectedMarkdownCachePath(rootPath, {
    sourceKey: entry.sourceKey,
    inputPath,
    kind: entry.kind,
    fingerprint
  }, analysisOptions);
  const llmSemanticRequired = resolveSemanticExtractionPlan(analysisOptions).shouldAttempt;
  const llmRelationRequired = canAttemptLlmRelations(analysisOptions);

  return {
    sourceKey: entry.sourceKey,
    inputPath,
    kind: inputSpec.kind,
    sourceProvider: entry.sourceProvider || 'filesystem',
    contentSha256,
    fingerprint,
    sourceMtimeMs: Number(stats.mtimeMs || 0),
    sourceSizeBytes: Number(stats.size || 0),
    previous: entry,
    markdownCachePath: expectedMarkdownCachePath,
    markdownCacheFingerprint: fingerprint,
    markdownCacheExists: await fileExists(expectedMarkdownCachePath),
    markdownCacheNeedsRefresh: inputSpec.kind === 'markdown'
      ? true
      : Boolean(analysisOptions.rebuildPdfMarkdown !== false && inputSpec.kind === 'pdf'),
    cachedPaper: null,
    llmRefreshState: {
      semanticRequired: llmSemanticRequired,
      relationRequired: llmRelationRequired,
      anyRequired: llmSemanticRequired || llmRelationRequired
    },
    reuseCachedMaterialization: false,
    changeType: 'updated'
  };
}

function resolvePaperRefreshSelection(manifest, reference = {}, options = {}) {
  const manifestSources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const matchedEntries = manifestSources.filter((entry) => manifestEntryMatchesPaperRefresh(entry, reference));
  if (!matchedEntries.length) {
    throw new Error('No manifest source matched the requested paper refresh selector.');
  }

  const groupKeys = unique(matchedEntries.map((entry) => getManifestEntryPaperGroupKey(entry)).filter(Boolean));
  if (groupKeys.length > 1) {
    const matches = matchedEntries
      .map((entry) => `${entry.sourceKey} (${entry.paperTitle || entry.paperId || 'untitled'})`)
      .join(', ');
    throw new Error(
      `The paper refresh selector matched multiple distinct paper groups. Narrow the request with sourceKey or source. Matches: ${matches}`
    );
  }

  const includeDuplicateGroup = options.includeDuplicateGroup !== false;
  const groupKey = groupKeys[0];
  const affectedEntries = includeDuplicateGroup
    ? manifestSources.filter((entry) => getManifestEntryPaperGroupKey(entry) === groupKey)
    : matchedEntries;

  return {
    matchedEntries,
    affectedEntries,
    groupKey,
    includeDuplicateGroup
  };
}

export async function refreshPaperGraphContent(target, options = {}) {
  const rootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : await resolveCorpus(target);
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest) {
    throw new Error(`No source manifest found in ${rootPath}. Run \`papernexus analyze\` first.`);
  }

  const analysisOptions = {
    ...options,
    force: true,
    enableLlmEnrichment: true,
    semanticExtraction: normalizeSemanticExtractionMode(
      firstDefinedValue(options.semanticExtraction, manifest.semanticExtractionMode, 'auto')
    )
  };

  const refreshResult = await withFileLock(getCorpusLockPath(rootPath), async () => {
    const latestManifest = await loadSourceManifest(rootPath);
    if (!latestManifest) {
      throw new Error(`No source manifest found in ${rootPath}. Run \`papernexus analyze\` first.`);
    }

    const selection = resolvePaperRefreshSelection(latestManifest, options, analysisOptions);
    const refreshedSourceStates = await mapWithConcurrency(
      selection.matchedEntries,
      Math.min(resolveMetadataConcurrency(analysisOptions), Math.max(selection.matchedEntries.length, 1)),
      (entry) => createPaperRefreshSourceState(rootPath, entry, analysisOptions)
    );
    const { failedSources } = await materializeSourceStates(rootPath, refreshedSourceStates, {
      ...analysisOptions,
      quiet: analysisOptions.quiet ?? true
    });
    if (failedSources.length) {
      throw new Error(failedSources[0].message || `Failed to refresh ${failedSources[0].sourceKey}.`);
    }

    const {
      sources: recanonicalizedSources,
      removedEntries
    } = await recanonicalizeManifestEntries(rootPath, selection.affectedEntries, latestManifest, analysisOptions);
    if (!recanonicalizedSources.length) {
      throw new Error('The requested paper refresh removed every source in its canonical group. Re-upload the paper before retrying.');
    }

    const excludedSourceKeys = new Set(selection.affectedEntries.map((entry) => entry.sourceKey));
    const untouchedSources = (latestManifest.sources || []).filter((entry) => !excludedSourceKeys.has(entry.sourceKey));
    const nextManifest = {
      ...latestManifest,
      indexedAt: new Date().toISOString(),
      lastChangeSummary: summarizePaperRefreshChanges(
        untouchedSources.length + recanonicalizedSources.length,
        recanonicalizedSources.length,
        removedEntries.length
      ),
      sources: [...untouchedSources, ...recanonicalizedSources].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
    };

    if (removedEntries.length) {
      await Promise.all(
        removedEntries.map((entry) => removeSemanticPaperSnapshot(rootPath, entry.sourceKey))
      );
    }
    await saveSourceManifest(rootPath, nextManifest);

    return {
      manifest: nextManifest,
      matchedEntries: selection.matchedEntries,
      affectedEntries: selection.affectedEntries,
      refreshedSourceStates,
      removedEntries
    };
  }, options.lockOptions);

  const affectedSourceKeys = unique([
    ...refreshResult.affectedEntries.map((entry) => entry.sourceKey),
    ...refreshResult.removedEntries.map((entry) => entry.sourceKey)
  ]).sort();
  const commitResult = await fastCommitCorpus(resolveManifestInputPath(refreshResult.manifest), {
    ...analysisOptions,
    rootPath,
    changedSourceKeys: affectedSourceKeys
  });

  return {
    contractVersion: 'paper-graph-refresh-v1',
    rootPath,
    requested: {
      paperId: options.paperId || '',
      sourceKey: options.sourceKey || '',
      source: options.source || '',
      paperTitle: options.paperTitle || options.title || '',
      includeDuplicateGroup: options.includeDuplicateGroup !== false,
      rebuildPdfMarkdown: options.rebuildPdfMarkdown !== false,
      semanticExtraction: analysisOptions.semanticExtraction
    },
    matchedEntries: refreshResult.matchedEntries.map(formatPaperRefreshEntry),
    affectedEntries: refreshResult.affectedEntries.map(formatPaperRefreshEntry),
    refreshedSourceKeys: refreshResult.refreshedSourceStates.map((entry) => entry.sourceKey).sort(),
    affectedSourceKeys,
    removedEntries: refreshResult.removedEntries.map(formatPaperRefreshEntry),
    manifestIndexedAt: refreshResult.manifest.indexedAt,
    changes: refreshResult.manifest.lastChangeSummary || null,
    fastCommit: {
      stage: commitResult.stage,
      reused: Boolean(commitResult.reused),
      syncJob: commitResult.syncJob || null
    },
    meta: commitResult.meta
  };
}

async function materializeSourceStates(rootPath, sourceStates, options = {}) {
  const materializedSources = [];
  const failedSources = [];
  const analyzeConcurrency = resolveAnalyzeConcurrency(options);
  const metadataConcurrency = resolveMetadataConcurrency(options);
  const quiet = Boolean(options.quiet);
  let nextIndex = 0;
  let completedSources = 0;
  const activeStates = new Map();
  const totalWorkers = Math.min(analyzeConcurrency, Math.max(sourceStates.length, 1));

  // 创建进度条
  const progress = quiet ? createQuietProgress() : createProgressBar(sourceStates.length, { prefix: 'Processing papers' });
  progress.start();
  emitPipelineProgress(options, {
    stage: 'materialize',
    currentStep: 'starting',
    processedUnits: 0,
    totalUnits: sourceStates.length,
    stagePercent: sourceStates.length ? 0 : 100,
    message: 'Preparing paper snapshots'
  });

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
        const cachedPaper = sourceState.cachedPaper || upgradeSemanticPaperIdentityRecord(
          await loadSemanticPaperSnapshot(rootPath, sourceState.sourceKey)
        );
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
      const { parsedPaper, semanticPaper, markerCommand, timings } = await materializeSemanticPaper(rootPath, sourceState, { ...options, quiet });
      setSourceStatus(sourceState, 'writing snapshot');
      await saveSemanticPaperSnapshot(rootPath, sourceState.sourceKey, semanticPaper);
      materializedSources.push({
        sourceState,
        parsedPaper,
        semanticPaper,
        markerCommand,
        timings
      });
    } catch (error) {
      failedSources.push({
        sourceKey: sourceState.sourceKey,
        inputPath: sourceState.inputPath,
        message: error.message
      });

      if (sourceState.previous) {
        const cachedPaper = sourceState.cachedPaper || upgradeSemanticPaperIdentityRecord(
          await loadSemanticPaperSnapshot(rootPath, sourceState.sourceKey)
        );
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
      completedSources += 1;
      progress.tick();
      emitPipelineProgress(options, {
        stage: 'materialize',
        currentStep: failedSources.some((entry) => entry.sourceKey === sourceState.sourceKey) ? 'source failed' : 'source completed',
        processedUnits: completedSources,
        totalUnits: sourceStates.length,
        stagePercent: sourceStates.length ? ((completedSources / sourceStates.length) * 100) : 100,
        message: formatSourceActivity(
          sourceState,
          failedSources.some((entry) => entry.sourceKey === sourceState.sourceKey) ? 'failed' : 'completed'
        )
      });
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
  emitPipelineProgress(options, {
    stage: 'materialize',
    currentStep: 'source materialization complete',
    processedUnits: sourceStates.length,
    totalUnits: sourceStates.length,
    stagePercent: 100,
    message: 'Prepared paper snapshots'
  });
  if (options.enableLlmEnrichment === false) {
    for (const record of materializedSources) {
      applySemanticAdmissionPolicy(record.semanticPaper);
      await saveSemanticPaperSnapshot(rootPath, record.sourceState.sourceKey, record.semanticPaper);
    }
  } else {
    await enrichMaterializedSourcesWithOllama(rootPath, materializedSources, options);
  }

  const { normalizedRecords, activeSemanticPapers } = canonicalizeMaterializedSources(materializedSources);
  const timings = materializedSources.reduce((summary, record) => mergeMaterializeTimings(summary, record.timings), createEmptyMaterializeTimings());
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
    failedSources,
    timings
  };
}

export async function analyzeCorpus(inputPath, options = {}) {
  const discovery = await discoverCorpusSources(inputPath, {
    rootPath: options.rootPath,
    includeActiveImportSources: options.includeActiveImportSources,
    includePersistentImportSources: options.includePersistentImportSources
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
    const mergeWithExistingManifestSources = Boolean(options.mergeWithExistingManifestSources && previousManifest);
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
    const freshSourceLlmRefreshState = materializeOnly
      ? {
          semanticRequired: false,
          relationRequired: false,
          anyRequired: false
        }
      : {
          semanticRequired: resolveSemanticExtractionPlan(analysisOptions).shouldAttempt,
          relationRequired: canAttemptLlmRelations(analysisOptions),
          anyRequired: resolveSemanticExtractionPlan(analysisOptions).shouldAttempt || canAttemptLlmRelations(analysisOptions)
        };

    if (!mergeWithExistingManifestSources) {
      await assertSingleGraphInputScope(rootPath, absoluteInputs, resolveManifestInputPath(previousManifest));
    }

    if (!discovery.sources.length && !previousIndexExists) {
      throw new Error(`No PDF or Markdown files found in ${inputLabel}.`);
    }

    const metadataConcurrency = resolveMetadataConcurrency(analysisOptions);
    const sourceStates = await mapWithConcurrency(discovery.sources, metadataConcurrency, async (source) => {
      const stats = await fs.stat(source.inputPath);
      const fingerprint = createSourceFingerprint(stats);
      const previous = previousByKey.get(source.sourceKey)
        ? upgradeManifestEntryIdentityRecord(previousByKey.get(source.sourceKey))
        : null;
      const importTaskFileMetadata = await loadImportTaskFileMetadata(rootPath, source.inputPath);
      const snapshotPath = getSemanticPaperSnapshotPath(rootPath, source.sourceKey);
      const snapshotExists = await fileExists(snapshotPath);
      let cachedPaper = null;

      if (snapshotExists) {
        cachedPaper = upgradeSemanticPaperIdentityRecord(
          await loadSemanticPaperSnapshot(rootPath, source.sourceKey)
        );
        if (cachedPaper?.sourceFingerprint !== fingerprint) {
          cachedPaper = null;
        }
      }
      let llmRefreshState = cachedPaper
        ? summarizeLlmRefreshState(cachedPaper, analysisOptions)
        : freshSourceLlmRefreshState;

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
      const cachedPaperHasDegenerateTitle = source.kind === 'pdf' && paperHasDegenerateTitle(cachedPaper, source.inputPath);
      const previousPaperHasDegenerateTitle = source.kind === 'pdf' && paperHasDegenerateTitle(previous, source.inputPath);
      if (cachedPaperHasDegenerateTitle) {
        cachedPaper = null;
        llmRefreshState = freshSourceLlmRefreshState;
      }
      const forcedMarkdownRefresh = Boolean(analysisOptions.rebuildPdfMarkdown && source.kind === 'pdf');
      const markdownCacheNeedsRefresh = forcedMarkdownRefresh
        || !markdownCacheExists
        || (previousMarkdownCachePath && previousMarkdownCachePath !== markdownCachePath)
        || (previousMarkdownCacheFingerprint && previousMarkdownCacheFingerprint !== fingerprint)
        || cachedPaperHasDegenerateTitle
        || previousPaperHasDegenerateTitle;
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

      const sourceProvider = importTaskFileMetadata?.file?.paperMetadata?.sourceProvider
        || source.sourceProvider
        || previous?.sourceProvider
        || cachedPaper?.sourceProvider
        || 'filesystem';
      const contentSha256 = String(importTaskFileMetadata?.file?.contentSha256 || '').trim()
        || await computeSourceContentSha256(source.inputPath, previous, fingerprint);
      const paperMetadata = normalizePaperMetadataPayload(
        source.paperMetadata
        || importTaskFileMetadata?.file?.paperMetadata
        || previous?.paperMetadata
        || previous
        || cachedPaper
        || {}
      );

      return {
        ...source,
        fingerprint,
        sourceMtimeMs: Number(stats.mtimeMs || 0),
        sourceSizeBytes: Number(stats.size || 0),
        sourceProvider,
        contentSha256,
        previous,
        changeType,
        markdownCachePath,
        markdownCacheFingerprint: fingerprint,
        markdownCacheExists,
        markdownCacheNeedsRefresh,
        cachedPaper,
        paperMetadata,
        llmRefreshState,
        reuseCachedMaterialization
      };
    });
    const sourceStateByKey = new Map(sourceStates.map((source) => [source.sourceKey, source]));

    const removedSources = mergeWithExistingManifestSources
      ? []
      : (previousManifest?.sources || []).filter((entry) => !currentKeys.has(entry.sourceKey));
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
    const materialized = await materializeSourceStates(rootPath, sourceStates, materializeOptions);
    let {
      semanticPapers,
      manifestSources: materializedManifestSources,
      failedSources,
      timings: materializeTimings
    } = materialized;
    let manifestSources = materializedManifestSources;
    if (mergeWithExistingManifestSources) {
      const materializedSourceKeys = new Set(materializedManifestSources.map((entry) => entry.sourceKey));
      const mergedManifestSources = [
        ...(previousManifest?.sources || []).filter((entry) => !materializedSourceKeys.has(entry.sourceKey)),
        ...materializedManifestSources
      ];
      const recanonicalized = await recanonicalizeManifestEntries(
        rootPath,
        mergedManifestSources,
        previousManifest || {},
        analysisOptions
      );
      manifestSources = recanonicalized.sources;
      if (recanonicalized.removedEntries.length) {
        failedSources = [
          ...failedSources,
          ...recanonicalized.removedEntries.map((entry) => ({
            sourceKey: entry.sourceKey,
            inputPath: entry.inputPath,
            message: 'Source was removed during manifest recanonicalization.'
          }))
        ];
      }
      const reloaded = await loadSemanticPapersFromManifest(rootPath, {
        ...previousManifest,
        sources: manifestSources
      }, metadataConcurrency);
      semanticPapers = reloaded.semanticPapers;
      failedSources = [
        ...failedSources,
        ...reloaded.failedSources.filter((entry) => !failedSources.some((existing) => existing.sourceKey === entry.sourceKey))
      ];
    }

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

    const sourceMode = mergeWithExistingManifestSources
      ? inferSourceModeFromManifestSources(manifestSources, previousManifest?.sourceMode || discovery.sourceMode || 'markdown')
      : (discovery.sources.length
          ? discovery.sourceMode
          : (previousManifest?.sourceMode || 'markdown'));
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
          : pdfParser === 'markpdfdown'
            ? firstDefinedValue(
              options.pdfCommand,
              options.markpdfdownPython,
              options.pythonCommand,
              previousManifest?.pdfCommand,
              process.env.PAPERNEXUS_MARKPDFDOWN_PYTHON,
              process.env.PAPERNEXUS_PYTHON_COMMAND,
              'python3'
            )
            : pdfParser === 'markitdown'
              ? firstDefinedValue(
                options.pdfCommand,
                options.markitdownPython,
                options.pythonCommand,
                previousManifest?.pdfCommand,
                process.env.PAPERNEXUS_MARKITDOWN_PYTHON,
                process.env.PAPERNEXUS_PYTHON_COMMAND,
                'python3'
              )
            : pdfParser === 'opendataloader'
              ? firstDefinedValue(
                options.pdfCommand,
                options.opendataloaderPdfPython,
                options.pythonCommand,
                previousManifest?.pdfCommand,
                process.env.PAPERNEXUS_OPENDATALOADER_PDF_PYTHON,
                process.env.PAPERNEXUS_PYTHON_COMMAND,
                'python3'
              )
              : pdfParser === 'paddleocr-vl'
                ? firstDefinedValue(
                  options.pdfCommand,
                  options.paddleocrVlPython,
                  options.pythonCommand,
                  previousManifest?.pdfCommand,
                  process.env.PAPERNEXUS_PADDLEOCR_VL_PYTHON,
                  process.env.PAPERNEXUS_PYTHON_COMMAND,
                  'python3'
                )
            : firstDefinedValue(
              options.pdfCommand,
              options.doclingCommand,
              previousManifest?.pdfCommand,
              process.env.PAPERNEXUS_DOCLING_CMD,
              'docling'
            ))
      : (previousManifest?.pdfCommand || previousManifest?.markerCommand || null);
    const manifestInputPath = mergeWithExistingManifestSources
      ? (previousManifest.inputPath || absoluteInput)
      : absoluteInput;
    const manifestInputPaths = mergeWithExistingManifestSources
      ? (Array.isArray(previousManifest.inputPaths) && previousManifest.inputPaths.length
          ? previousManifest.inputPaths
          : normalizeInputPaths(previousManifest.inputPath || absoluteInput))
      : absoluteInputs;

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
        inputPath: manifestInputPath,
        inputPaths: manifestInputPaths,
        sourceMode,
        pdfParser,
        pdfCommand,
        semanticExtractionMode: normalizedSemanticExtractionMode,
        sources: manifestSources,
        indexedAt,
        changes
      });
      await withFileLock(getCorpusLockPath(rootPath), async () => {
        await assertAnalyzeCommitStillFresh(
          inputPath,
          rootPath,
          sourceStates,
          previousManifest,
          metadataConcurrency,
          mergeWithExistingManifestSources
            ? {
                includeActiveImportSources: false,
                includePersistentImportSources: false
              }
            : {}
        );
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
        stage: 'materialized',
        timings: materializeTimings
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
        inputPath: manifestInputPath,
        inputPaths: manifestInputPaths,
        sourceMode,
        pdfParser,
        pdfCommand,
        semanticExtractionMode: normalizedSemanticExtractionMode,
        sources: manifestSources,
        indexedAt,
        changes
      });
      const rateLimitCooldownUntil = getLlmRateLimitCooldownUntilFromPapers(semanticPapers);
      nextManifest.llmOptimization = rateLimitCooldownUntil
        ? buildLlmOptimizationCooldownState(nextManifest, analysisOptions, rateLimitCooldownUntil)
        : buildLlmOptimizationState(nextManifest, analysisOptions);
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
      inputPath: manifestInputPath,
      inputPaths: manifestInputPaths,
      sourceMode,
      pdfParser,
      pdfCommand,
      semanticExtractionMode: normalizedSemanticExtractionMode,
      sources: manifestSources,
      indexedAt: mergedMeta.indexedAt,
      changes
    });
    const rateLimitCooldownUntil = getLlmRateLimitCooldownUntilFromPapers(semanticPapers);
    nextManifest.llmOptimization = rateLimitCooldownUntil
      ? buildLlmOptimizationCooldownState(nextManifest, analysisOptions, rateLimitCooldownUntil)
      : buildLlmOptimizationState(nextManifest, analysisOptions);
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

  const changedSourceKeySet = normalizeChangedSourceKeySet(options.changedSourceKeys);
  const records = await buildStage2RecordsFromManifest(rootPath, manifest, analysisOptions);
  if (changedSourceKeySet.size) {
    scopeStage2RecordsToChangedSources(records, [...changedSourceKeySet]);
  }
  const hasPendingWork = records.some((record) => {
    if (record.sourceState.llmRefreshState?.scopedOut) {
      return false;
    }
    const refresh = summarizeLlmRefreshState(record.semanticPaper, analysisOptions);
    record.sourceState.llmRefreshState = refresh;
    return refresh.anyRequired;
  });

  if (!hasPendingWork && !options.force) {
    const jobState = previousJobState && previousJobState.token === createStage2JobToken(manifest, analysisOptions)
      ? previousJobState
      : createStage2JobState(manifest, analysisOptions);
    seedStage2JobStateFromRecords(jobState, records);
    jobState.status = changedSourceKeySet.size ? 'partial' : 'completed';
    jobState.completedAt = changedSourceKeySet.size ? null : new Date().toISOString();
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
  emitPipelineProgress(options, {
    stage: 'fast-commit',
    currentStep: 'loading lite graph',
    processedUnits: 0,
    totalUnits: 6,
    stagePercent: 0,
    message: 'Preparing fast local graph update'
  });

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
  emitPipelineProgress(options, {
    stage: 'fast-commit',
    currentStep: 'collecting changed snapshots',
    processedUnits: 1,
    totalUnits: 6,
    stagePercent: 16.67,
    message: 'Collected changed semantic snapshots'
  });

  const paperDeltaPayload = await buildGraphDeltaPayload({
    corpusName: manifest.corpusName || options.name || currentCorpus.meta.name || path.basename(rootPath),
    rootPath,
    committedGraph: currentCorpus.graph,
    semanticPapers: changedSemanticPapers,
    liteState,
    changedSourceKeys,
    options
  });
  emitPipelineProgress(options, {
    stage: 'fast-commit',
    currentStep: 'building graph delta',
    processedUnits: 2,
    totalUnits: 6,
    stagePercent: 33.33,
    message: 'Built graph delta payload'
  });
  const nextGraph = applyGraphDeltaPayload(currentCorpus.graph, paperDeltaPayload);
  postIngestionRefinement(nextGraph);
  const activeManifestSources = (manifest.sources || []).filter((entry) => entry.activeInGraph !== false);
  const nextLiteState = buildLiteStateSnapshot(nextGraph, activeManifestSources);
  const liteSourceKeys = unique([
    ...Object.keys(liteState?.sources || {}),
    ...Object.keys(nextLiteState?.sources || {})
  ]);
  const affectedLiteSourceKeys = liteSourceKeys.filter((sourceKey) => (
    JSON.stringify(liteState?.sources?.[sourceKey] || null) !== JSON.stringify(nextLiteState?.sources?.[sourceKey] || null)
  ));
  const deltaPayload = buildGraphDiffPayload(currentCorpus.graph, nextGraph, {
    changedSourceKeys,
    liteChangedSourceKeys: affectedLiteSourceKeys.length ? affectedLiteSourceKeys : [GLOBAL_SOURCE_KEY],
    sourceEntries: (affectedLiteSourceKeys.length ? affectedLiteSourceKeys : [GLOBAL_SOURCE_KEY])
      .map((sourceKey) => nextLiteState.sources?.[sourceKey])
      .filter(Boolean),
    removalState: paperDeltaPayload.removalState
  });
  emitPipelineProgress(options, {
    stage: 'fast-commit',
    currentStep: 'applying refinement',
    processedUnits: 3,
    totalUnits: 6,
    stagePercent: 50,
    message: 'Applied graph refinement and computed lite diff'
  });
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
    mode: options.mode || 'delta',
    onProgress(event = {}) {
      const phase = String(event.phase || '').trim();
      const phaseProgress = phase === 'lite-delta'
        ? { processedUnits: 4, stagePercent: 66.67 }
        : phase === 'manifest'
          ? { processedUnits: 5, stagePercent: 83.33 }
          : phase === 'meta'
            ? { processedUnits: 5.5, stagePercent: 95 }
            : { processedUnits: 3, stagePercent: 50 };
      emitPipelineProgress(options, {
        stage: 'fast-commit',
        currentStep: phase || 'writing fast local delta',
        processedUnits: phaseProgress.processedUnits,
        totalUnits: 6,
        stagePercent: phaseProgress.stagePercent,
        message: event.label || 'Writing fast local delta files'
      });
    }
  });
  emitPipelineProgress(options, {
    stage: 'fast-commit',
    currentStep: 'fast commit complete',
    processedUnits: 6,
    totalUnits: 6,
    stagePercent: 100,
    message: 'Applied graph update and queued authoritative sync'
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

export async function scrubDegeneratePapers(target, options = {}) {
  const rootPath = options.rootPath
    ? path.resolve(options.rootPath)
    : await resolveCorpus(target);
  const manifest = await loadSourceManifest(rootPath);
  if (!manifest) {
    throw new Error(`No source manifest found in ${rootPath}. Run \`papernexus analyze\` first.`);
  }

  const removedSources = [];
  const nextManifest = await withFileLock(getCorpusLockPath(rootPath), async () => {
    const latestManifest = await loadSourceManifest(rootPath);
    if (!latestManifest) {
      throw new Error(`No source manifest found in ${rootPath}. Run \`papernexus analyze\` first.`);
    }

    const keptEntries = [];
    const degenerateEntries = [];
    for (const entry of latestManifest.sources || []) {
      const snapshot = await loadSemanticPaperSnapshot(rootPath, entry.sourceKey);
      const degenerate = paperHasDegenerateTitle(snapshot || entry, entry.inputPath || entry.sourcePath || '');
      if (!degenerate) {
        keptEntries.push(entry);
        continue;
      }

      const sourceMissing = !(await fileExists(entry.inputPath || ''));
      const removedRecord = {
        sourceKey: entry.sourceKey,
        inputPath: entry.inputPath,
        paperId: entry.paperId || snapshot?.paperId || null,
        paperTitle: snapshot?.paperTitle || entry.paperTitle || null,
        sourceMissing
      };
      removedSources.push(removedRecord);
      degenerateEntries.push(removedRecord);
    }

    if (!removedSources.length) {
      return latestManifest;
    }

    const {
      sources: recanonicalizedSources,
      removedEntries: unrecoverableEntries
    } = await recanonicalizeManifestEntries(rootPath, keptEntries, latestManifest, options);
    removedSources.push(...unrecoverableEntries);
    const scrubbedManifest = {
      ...latestManifest,
      indexedAt: new Date().toISOString(),
      lastChangeSummary: createDegenerateScrubChangeSummary(recanonicalizedSources.length, removedSources.length),
      sources: recanonicalizedSources
    };
    await Promise.all(
      [...degenerateEntries, ...unrecoverableEntries]
        .map((entry) => removeSemanticPaperSnapshot(rootPath, entry.sourceKey))
    );
    await saveSourceManifest(rootPath, scrubbedManifest);
    await removeStagedCorpusBuild(rootPath);
    return scrubbedManifest;
  }, options.lockOptions);

  if (!removedSources.length) {
    return {
      rootPath,
      meta: await loadCorpusMeta(rootPath),
      manifest: nextManifest,
      removedSources,
      removedSourceCount: 0,
      purgedMissingSourceCount: 0,
      reused: true,
      stage: 'degenerate-scrubbed'
    };
  }

  const manifestInput = resolveManifestInputPath(nextManifest);
  if (nextManifest.sources?.length) {
    await buildGraphCorpus(manifestInput, {
      ...options,
      rootPath
    });
    await mergeGraphCorpus(manifestInput, {
      ...options,
      rootPath
    });
    const result = await writeIndexCorpus(manifestInput, {
      ...options,
      rootPath
    });
    return {
      ...result,
      manifest: nextManifest,
      removedSources,
      removedSourceCount: removedSources.length,
      purgedMissingSourceCount: removedSources.filter((entry) => entry.sourceMissing).length,
      stage: 'degenerate-scrubbed'
    };
  }

  const emptyGraph = createKnowledgeGraph();
  const emptyMeta = await createMeta({
    name: nextManifest.corpusName || path.basename(rootPath),
    rootPath,
    graph: emptyGraph,
    sourceMode: nextManifest.sourceMode || 'markdown',
    problems: [],
    semanticPapers: [],
    pdfParser: nextManifest.pdfParser || null,
    pdfCommand: nextManifest.pdfCommand || nextManifest.markerCommand || nextManifest.mineruCommand || null,
    semanticExtractionMode: nextManifest.semanticExtractionMode || 'heuristic-only',
    changes: nextManifest.lastChangeSummary || null,
    acceptedCrossPaperJudgments: 0,
    failedSources: [],
    sourceCount: 0
  });
  const committedManifest = {
    ...nextManifest,
    indexedAt: emptyMeta.indexedAt
  };
  await commitPreparedCorpusIndex({
    rootPath,
    graph: emptyGraph,
    meta: emptyMeta,
    manifest: committedManifest,
    sourceStateByKey: null,
    analysisOptions: options,
    cleanupStagedBuild: true
  });

  return {
    rootPath,
    graph: emptyGraph,
    meta: emptyMeta,
    manifest: committedManifest,
    removedSources,
    removedSourceCount: removedSources.length,
    purgedMissingSourceCount: removedSources.filter((entry) => entry.sourceMissing).length,
    reused: false,
    stage: 'degenerate-scrubbed'
  };
}

export async function backfillCatalystMetadataCorpus(inputPath, options = {}) {
  const semanticExtraction = backfillSemanticExtractionMode(options);
  const analysisOptions = {
    ...options,
    semanticExtraction
  };
  const semanticPlan = resolveSemanticExtractionPlan(analysisOptions);
  if (!semanticPlan.shouldAttempt) {
    throw new Error(
      'Catalyst metadata backfill requires an LLM-enabled semantic extraction mode. '
      + 'Configure an LLM provider/model or pass `--semantic-extraction heuristic-only` only when you do not expect catalyst metadata backfill.'
    );
  }

  await llmOptimizeCorpus(inputPath, analysisOptions);
  await buildGraphCorpus(inputPath, analysisOptions);
  await mergeGraphCorpus(inputPath, analysisOptions);
  return writeIndexCorpus(inputPath, analysisOptions);
}

export async function corpusNeedsCatalystMetadataBackfill(rootPath) {
  return manifestNeedsCatalystMetadataBackfill(await loadSourceManifest(rootPath));
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
  refreshWatchedCorpus,
  resolvePaperRefreshInputSpec
};
