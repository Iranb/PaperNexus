import { readJson, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { EDGE_TYPES } from '../graph/schema.js';

export const CITATION_INTENTS_CONTRACT_VERSION = 'papernexus-citation-intents-v1';

export const CITATION_INTENT_LABELS = [
  'method-use',
  'baseline-comparison',
  'result-comparison',
  'limitation-contrast',
  'motivation-gap',
  'supporting-evidence',
  'dataset',
  'evaluation-metric',
  'extension',
  'background',
  'uncertain'
];

const LABEL_ALIASES = new Map([
  ['method', 'method-use'],
  ['method_use', 'method-use'],
  ['uses-method', 'method-use'],
  ['uses_method', 'method-use'],
  ['method-use', 'method-use'],
  ['baseline', 'baseline-comparison'],
  ['baseline_comparison', 'baseline-comparison'],
  ['baseline-comparison', 'baseline-comparison'],
  ['comparison-baseline', 'baseline-comparison'],
  ['result', 'result-comparison'],
  ['result_comparison', 'result-comparison'],
  ['result-comparison', 'result-comparison'],
  ['comparison-result', 'result-comparison'],
  ['contrast', 'limitation-contrast'],
  ['limitation', 'limitation-contrast'],
  ['limitation_contrast', 'limitation-contrast'],
  ['limitation-contrast', 'limitation-contrast'],
  ['negative', 'limitation-contrast'],
  ['motivation', 'motivation-gap'],
  ['gap', 'motivation-gap'],
  ['motivation_gap', 'motivation-gap'],
  ['motivation-gap', 'motivation-gap'],
  ['support', 'supporting-evidence'],
  ['supporting', 'supporting-evidence'],
  ['supporting_evidence', 'supporting-evidence'],
  ['supporting-evidence', 'supporting-evidence'],
  ['evidence', 'supporting-evidence'],
  ['dataset', 'dataset'],
  ['data', 'dataset'],
  ['metric', 'evaluation-metric'],
  ['metrics', 'evaluation-metric'],
  ['evaluation_metric', 'evaluation-metric'],
  ['evaluation-metric', 'evaluation-metric'],
  ['extension', 'extension'],
  ['extends', 'extension'],
  ['background', 'background'],
  ['background-context', 'background'],
  ['related-work', 'background'],
  ['scicite-background', 'background'],
  ['scicite-method', 'method-use'],
  ['scicite-result', 'supporting-evidence'],
  ['uncertain', 'uncertain'],
  ['unknown', 'uncertain'],
  ['other', 'uncertain']
]);

const INTENT_DEFINITIONS = [
  {
    label: 'baseline-comparison',
    graphEdgeType: EDGE_TYPES.CITES_FOR_BASELINE,
    patterns: [
      ['baseline', /\bbaselines?\b/i, 3],
      ['compare-against', /\b(compared?\s+(against|with|to)|comparison\s+(against|with|to))\b/i, 3],
      ['versus', /\b(vs\.?|versus)\b/i, 2],
      ['sota', /\b(state[-\s]?of[-\s]?the[-\s]?art|sota)\b/i, 2],
      ['outperform', /\b(outperform|underperform|beat|surpass|exceed|stronger than|weaker than)\b/i, 2],
      ['benchmark-against', /\b(evaluate|evaluated|test|tested)\b.{0,80}\b(against|baseline|compared)\b/i, 2]
    ],
    sectionWeights: { evaluation: 1.2, experiment: 1.2, result: 1.0 }
  },
  {
    label: 'method-use',
    graphEdgeType: EDGE_TYPES.CITES_FOR_METHOD,
    patterns: [
      ['use', /\b(use|uses|using|used|employ|employs|adopt|adopts|apply|applies|implement|implements)\b/i, 2],
      ['build-on', /\b(builds?\s+on|based\s+on|derived\s+from|following|follows)\b/i, 2.5],
      ['architecture', /\b(method|model|algorithm|architecture|framework|module|component|encoder|decoder|reranker|retriever)\b/i, 1.2],
      ['initialize', /\b(initiali[sz]e|pretrain|fine[-\s]?tune|reuse|transfer)\b/i, 1.5],
      ['extends-method', /\b(extend|extends|extension of|generalize|adapts?)\b/i, 1.5]
    ],
    sectionWeights: { method: 1.6, approach: 1.4 }
  },
  {
    label: 'limitation-contrast',
    graphEdgeType: EDGE_TYPES.CITES_FOR_CONTRAST,
    patterns: [
      ['unlike', /\b(unlike|whereas|in contrast|contrary to|rather than|instead of)\b/i, 3],
      ['negative-limitation', /\b(fail|fails|failed|cannot|unable|limited|limitation|drawback|weakness|suffer|degrade)\b/i, 2.5],
      ['not-address', /\b(does not|do not|did not)\b.{0,80}\b(address|solve|handle|consider|support)\b/i, 2.5],
      ['however-gap', /\b(however|but|yet|nevertheless)\b.{0,120}\b(limited|fails?|lack|cannot|does not)\b/i, 2]
    ],
    sectionWeights: { discussion: 0.8, limitation: 1.2 }
  },
  {
    label: 'motivation-gap',
    graphEdgeType: EDGE_TYPES.QUALIFIES_CLAIM,
    patterns: [
      ['gap', /\b(gap|open problem|unresolved|underexplored|under-studied|understudied)\b/i, 3],
      ['motivate', /\b(motivate|motivates|motivation|therefore|thus|need for|calls for)\b/i, 2],
      ['remain', /\b(remain|remains|still)\b.{0,80}\b(challenge|difficult|unsolved|open|limited)\b/i, 2.5],
      ['lack', /\b(lack|lacks|missing|scarce|insufficient)\b/i, 2]
    ],
    sectionWeights: { introduction: 0.8, discussion: 0.8 }
  },
  {
    label: 'result-comparison',
    graphEdgeType: EDGE_TYPES.CITES_FOR_CONTRAST,
    patterns: [
      ['result-compare', /\b(result|results|performance|accuracy|f1|recall|precision|ndcg|auc|bleu|rouge)\b.{0,80}\b(compare|compared|higher|lower|improve|drop|gain)\b/i, 2.5],
      ['metric-gain', /\b(gain|improvement|drop|increase|decrease|higher|lower)\b.{0,60}\b(%|point|score|accuracy|f1|recall|precision)\b/i, 2],
      ['reported-result', /\b(reported|achieved|obtained)\b.{0,80}\b(result|performance|score|accuracy|f1|recall|precision)\b/i, 2]
    ],
    sectionWeights: { evaluation: 1.3, result: 1.5 }
  },
  {
    label: 'supporting-evidence',
    graphEdgeType: EDGE_TYPES.SUPPORTS_CLAIM,
    patterns: [
      ['show', /\b(show|shows|showed|demonstrate|demonstrates|demonstrated|prove|proves|confirm|confirms)\b/i, 2.5],
      ['evidence', /\b(evidence|observed|found|reported|indicate|indicates|suggest|suggests|support|supports)\b/i, 2],
      ['empirical', /\b(empirical|experiment|study|analysis)\b.{0,80}\b(show|find|support|evidence)\b/i, 2]
    ],
    sectionWeights: { discussion: 0.6, evaluation: 0.8, result: 0.8 }
  },
  {
    label: 'dataset',
    graphEdgeType: EDGE_TYPES.OBSERVED_ON,
    patterns: [
      ['dataset', /\b(dataset|data set|corpus|benchmark suite|collection|test set|training set|validation set)\b/i, 3],
      ['named-dataset', /\b(ImageNet|GLUE|SuperGLUE|COCO|SQuAD|MMLU|BEIR|MS MARCO|TREC|PubMed|arXiv)\b/i, 2.5]
    ],
    sectionWeights: { evaluation: 1.0, experiment: 1.0 }
  },
  {
    label: 'evaluation-metric',
    graphEdgeType: EDGE_TYPES.MEASURED_BY,
    patterns: [
      ['metric', /\b(metric|measure|score|accuracy|f1|auc|bleu|rouge|recall|precision|ndcg|map|mrr|perplexity)\b/i, 3],
      ['evaluate-with', /\b(evaluate|evaluated|measured|measure)\b.{0,80}\b(metric|score|accuracy|f1|recall|precision)\b/i, 2]
    ],
    sectionWeights: { evaluation: 1.0, experiment: 0.8 }
  },
  {
    label: 'extension',
    graphEdgeType: EDGE_TYPES.DERIVED_FROM_VERSION,
    patterns: [
      ['extend', /\b(extend|extends|extended|extension|generalize|generalizes|adapt|adapts|adapted)\b/i, 2.5],
      ['build-upon', /\b(builds?\s+upon|follow[-\s]?up|variant of|derived from)\b/i, 2],
      ['new-setting', /\b(to|for)\b.{0,50}\b(setting|domain|task|language|modality)\b/i, 1.2]
    ],
    sectionWeights: { method: 0.8, introduction: 0.5 }
  },
  {
    label: 'background',
    graphEdgeType: EDGE_TYPES.HAS_CITATION_INTENT,
    patterns: [
      ['prior-work', /\b(prior work|previous work|related work|literature|survey|line of work)\b/i, 2.5],
      ['introduced', /\b(introduced|proposed|studied|investigated|explored|presented)\b/i, 1.5],
      ['seminal', /\b(seminal|classic|early|widely used|well[-\s]?known)\b/i, 1.5]
    ],
    sectionWeights: { introduction: 1.0, related: 1.5, background: 1.5 }
  }
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeCitationIntentLabel(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return LABEL_ALIASES.get(normalized)
    || LABEL_ALIASES.get(normalized.replace(/-/g, '_'))
    || (CITATION_INTENT_LABELS.includes(normalized) ? normalized : '');
}

function contextText(context = {}) {
  return compactText([
    context.exactQuote,
    context.citationContext,
    context.context,
    context.quote
  ].filter(Boolean).join(' '), 2600);
}

function referenceText(context = {}) {
  return compactText([
    context.referenceTitleGuess,
    context.referenceTitle,
    context.referenceRaw
  ].filter(Boolean).join(' '), 1200);
}

function sectionRole(context = {}) {
  return String(context.sectionRole || context.section_role || '').trim().toLowerCase();
}

function scoreDefinition(definition, context = {}) {
  const quote = contextText(context);
  const reference = referenceText(context);
  const searchable = compactText(`${quote} ${reference}`, 3200);
  const matchedPatterns = [];
  let score = 0;

  for (const [name, pattern, weight] of definition.patterns) {
    if (pattern.test(searchable)) {
      score += weight;
      matchedPatterns.push(name);
    }
  }

  const role = sectionRole(context);
  const sectionWeight = definition.sectionWeights?.[role] || 0;
  if (sectionWeight) {
    score += sectionWeight;
    matchedPatterns.push(`section:${role}`);
  }

  return { label: definition.label, graphEdgeType: definition.graphEdgeType, score, matchedPatterns };
}

function rankIntentCandidates(context = {}) {
  const candidates = INTENT_DEFINITIONS
    .map((definition) => scoreDefinition(definition, context))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || INTENT_DEFINITIONS.findIndex((definition) => definition.label === left.label) - INTENT_DEFINITIONS.findIndex((definition) => definition.label === right.label));

  if (!candidates.length) {
    const role = sectionRole(context);
    if (['introduction', 'related', 'background'].includes(role)) {
      return [{
        label: 'background',
        graphEdgeType: EDGE_TYPES.HAS_CITATION_INTENT,
        score: 1,
        matchedPatterns: [`section:${role}`]
      }];
    }
    return [{
      label: 'uncertain',
      graphEdgeType: EDGE_TYPES.HAS_CITATION_INTENT,
      score: 0,
      matchedPatterns: []
    }];
  }

  return candidates;
}

export function classifyCitationIntent(context = {}, options = {}) {
  const ranked = rankIntentCandidates(context);
  const primary = ranked[0] || {
    label: 'uncertain',
    graphEdgeType: EDGE_TYPES.HAS_CITATION_INTENT,
    score: 0,
    matchedPatterns: []
  };
  const quote = contextText(context);
  const confidence = primary.label === 'uncertain'
    ? 0.2
    : clamp(0.32 + (primary.score / 8), 0.36, 0.95);
  const lowConfidenceThreshold = Number.isFinite(Number(options.lowConfidenceThreshold))
    ? Number(options.lowConfidenceThreshold)
    : 0.55;
  const citationContextId = context.id || context.citationContextId || context.citation_context_id || null;
  const idSeed = [
    citationContextId,
    context.paperId || context.paper_id || '',
    context.referenceId || context.reference_id || '',
    context.citationRaw || context.citation_raw || '',
    quote,
    primary.label
  ].join(':');

  return {
    contractVersion: CITATION_INTENTS_CONTRACT_VERSION,
    id: `citation-intent:${stableHash(idSeed)}`,
    citationContextId,
    paperId: context.paperId || context.paper_id || null,
    paperTitle: context.paperTitle || context.paper_title || '',
    sourceKey: context.sourceKey || context.source_key || null,
    sourceProvider: context.sourceProvider || context.source_provider || '',
    sectionId: context.sectionId || context.section_id || null,
    sectionHeading: context.sectionHeading || context.section_heading || '',
    sectionRole: sectionRole(context),
    chunkId: context.chunkId || context.chunk_id || null,
    referenceId: context.referenceId || context.reference_id || null,
    referenceTitleGuess: context.referenceTitleGuess || context.reference_title_guess || '',
    referenceYear: context.referenceYear ?? context.reference_year ?? null,
    referenceIdentifiers: context.referenceIdentifiers || context.reference_identifiers || {},
    citationRaw: context.citationRaw || context.citation_raw || '',
    exactQuote: quote,
    intent: primary.label,
    confidence,
    graphEdgeType: primary.graphEdgeType,
    candidateIntents: ranked.slice(0, 5).map((entry) => ({
      intent: entry.label,
      score: Number(entry.score.toFixed(3)),
      graphEdgeType: entry.graphEdgeType,
      matchedPatterns: entry.matchedPatterns
    })),
    matchedPatterns: unique(primary.matchedPatterns),
    requiresHumanReview: confidence < lowConfidenceThreshold || primary.label === 'uncertain',
    extractionStatus: context.extractionStatus || context.extraction_status || ''
  };
}

function collectInputContexts(input = {}) {
  if (Array.isArray(input)) return input;
  return [
    ...asArray(input.contexts),
    ...asArray(input.citationContexts),
    ...asArray(input.citation_contexts)
  ];
}

function countByIntent(intents = []) {
  const counts = {};
  for (const label of CITATION_INTENT_LABELS) counts[label] = 0;
  for (const entry of intents) {
    const label = normalizeCitationIntentLabel(entry.intent) || 'uncertain';
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function goldEntries(gold = {}) {
  if (Array.isArray(gold)) return gold;
  if (Array.isArray(gold.items)) return gold.items;
  if (Array.isArray(gold.cases)) return gold.cases;
  if (Array.isArray(gold.labels)) return gold.labels;
  if (gold && typeof gold === 'object') {
    return Object.entries(gold).map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { id: key, citationContextId: key, ...value };
      }
      return { id: key, citationContextId: key, intent: value };
    });
  }
  return [];
}

function entryKey(entry = {}) {
  return String(entry.citationContextId || entry.citation_context_id || entry.contextId || entry.context_id || entry.id || '').trim();
}

function entryIntent(entry = {}) {
  return normalizeCitationIntentLabel(entry.intent || entry.label || entry.goldIntent || entry.gold_intent || entry.expectedIntent || entry.expected_intent || entry.citationIntent || entry.citation_intent);
}

function precisionRecallF1(tp, fp, fn) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

export function evaluateCitationIntentPredictions(predictions = [], gold = {}, options = {}) {
  const goldMap = new Map();
  for (const entry of goldEntries(gold)) {
    const key = entryKey(entry);
    const intent = entryIntent(entry);
    if (key && intent) goldMap.set(key, intent);
  }

  const predictionMap = new Map();
  for (const prediction of asArray(predictions)) {
    const key = entryKey(prediction);
    const intent = entryIntent(prediction);
    if (key && intent) predictionMap.set(key, intent);
  }

  const labels = unique([...goldMap.values(), ...predictionMap.values()]).filter(Boolean).sort();
  let correct = 0;
  let evaluated = 0;
  const confusion = {};
  const missingPredictionIds = [];

  for (const [key, expected] of goldMap.entries()) {
    const predicted = predictionMap.get(key);
    if (!predicted) {
      missingPredictionIds.push(key);
      continue;
    }
    evaluated += 1;
    if (expected === predicted) correct += 1;
    confusion[expected] ||= {};
    confusion[expected][predicted] = (confusion[expected][predicted] || 0) + 1;
  }

  const perLabel = {};
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [key, expected] of goldMap.entries()) {
      const predicted = predictionMap.get(key);
      if (expected === label && predicted === label) tp += 1;
      if (expected !== label && predicted === label) fp += 1;
      if (expected === label && predicted !== label) fn += 1;
    }
    perLabel[label] = precisionRecallF1(tp, fp, fn);
  }

  const accuracy = evaluated > 0 ? correct / evaluated : 0;
  const macroF1 = labels.length
    ? labels.reduce((sum, label) => sum + (perLabel[label]?.f1 || 0), 0) / labels.length
    : 0;
  const minAccuracy = Number.isFinite(Number(options.minAccuracy)) ? Number(options.minAccuracy) : null;
  const minMacroF1 = Number.isFinite(Number(options.minMacroF1)) ? Number(options.minMacroF1) : null;
  const thresholdFailures = [];
  if (minAccuracy !== null && accuracy < minAccuracy) thresholdFailures.push(`accuracy ${accuracy.toFixed(3)} < ${minAccuracy}`);
  if (minMacroF1 !== null && macroF1 < minMacroF1) thresholdFailures.push(`macro_f1 ${macroF1.toFixed(3)} < ${minMacroF1}`);

  return {
    contractVersion: `${CITATION_INTENTS_CONTRACT_VERSION}-benchmark-gate`,
    status: goldMap.size === 0 || evaluated === 0 ? 'incomplete' : (thresholdFailures.length ? 'failed' : 'passed'),
    evaluated_count: evaluated,
    gold_count: goldMap.size,
    prediction_count: predictionMap.size,
    correct_count: correct,
    accuracy,
    macro_f1: macroF1,
    labels,
    per_label: perLabel,
    confusion,
    missing_prediction_ids: missingPredictionIds,
    threshold_failures: thresholdFailures
  };
}

export function buildCitationIntentArtifact(input = {}, options = {}) {
  const contexts = collectInputContexts(input);
  const intents = contexts.map((context) => classifyCitationIntent(context, options));
  const diagnostics = {
    contractVersion: CITATION_INTENTS_CONTRACT_VERSION,
    sourceContractVersion: input?.contractVersion || input?.adapterContractVersion || '',
    contextCount: contexts.length,
    intentCount: intents.length,
    unresolvedReferenceCount: contexts.filter((entry) => String(entry.extractionStatus || entry.extraction_status || '').includes('missing') || String(entry.extractionStatus || entry.extraction_status || '').includes('unresolved')).length,
    lowConfidenceCount: intents.filter((entry) => entry.requiresHumanReview).length,
    intentCounts: countByIntent(intents),
    warnings: []
  };
  if (!contexts.length) diagnostics.warnings.push({ code: 'no_citation_contexts', message: 'No citation contexts were provided for citation-intent classification.' });
  if (diagnostics.lowConfidenceCount > 0) diagnostics.warnings.push({ code: 'low_confidence_intents', count: diagnostics.lowConfidenceCount });

  const artifact = {
    contractVersion: CITATION_INTENTS_CONTRACT_VERSION,
    sourceContractVersion: diagnostics.sourceContractVersion,
    paper: input?.paper || null,
    intents,
    diagnostics
  };

  if (options.gold) {
    artifact.evaluation = evaluateCitationIntentPredictions(intents, options.gold, {
      minAccuracy: options.minAccuracy,
      minMacroF1: options.minMacroF1
    });
  }

  return artifact;
}

export async function readCitationIntentArtifact(contextsPath, options = {}) {
  const input = await readJson(contextsPath);
  const gold = options.goldPath ? await readJson(options.goldPath) : options.gold;
  return buildCitationIntentArtifact(input, {
    ...options,
    gold
  });
}

export async function writeCitationIntentArtifact(outputPath, contextsPath, options = {}) {
  const artifact = await readCitationIntentArtifact(contextsPath, options);
  await writeJson(outputPath, artifact);
  return artifact;
}
