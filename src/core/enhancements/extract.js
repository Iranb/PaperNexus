import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import { jaccardSimilarity, normalizeText, stableHash, truncate, unique } from '../../lib/utils.js';

const THEORY_VERSION = 'heuristic-overlay-v2';
const STORYLINE_ORDER = ['problem', 'gap', 'idea', 'method', 'evidence', 'contribution', 'limitation'];
const REFLECTION_VERDICTS = ['success', 'failure', 'mixed', 'inconclusive'];

const GAP_PATTERNS = [
  /\bhowever\b/i,
  /\bexisting methods?\b/i,
  /\bprior work\b/i,
  /\bdoes not\b/i,
  /\bdo not\b/i,
  /\blimited\b/i,
  /\black\b/i,
  /\bchallenge\b/i,
  /\bgap\b/i,
  /\bfails?\s+to\b/i,
  /\bfragmented\b/i
];

const IDEA_PATTERNS = [
  /\bwe (?:propose|present|introduce|construct|connect)\b/i,
  /\bour (?:approach|idea|system|method)\b/i,
  /\bwe therefore\b/i,
  /\bkey idea\b/i
];

const METHOD_PATTERNS = [
  /\bthe system uses\b/i,
  /\bour approach builds\b/i,
  /\bbuilds? a\b/i,
  /\blinks?\b/i,
  /\buses?\b/i,
  /\bencode\b/i
];

const CONTRIBUTION_PATTERNS = [
  /\bwe present\b/i,
  /\bwe show\b/i,
  /\bthis paper studies\b/i,
  /\bcontribution\b/i,
  /\bthis made\b/i,
  /\bsupport\b/i
];

const EVIDENCE_PATTERNS = [
  /\bresults?\b/i,
  /\bgains?\b/i,
  /\beasier\b/i,
  /\btransparent\b/i,
  /\bexposed\b/i,
  /\bdiscover\b/i,
  /\btrace\b/i
];

const MECHANISM_PATTERNS = [
  /\bby [a-z]+ing\b/i,
  /\ballows?\b/i,
  /\benables?\b/i,
  /\bsupports?\b/i,
  /\bso researchers can\b/i,
  /\btherefore\b/i,
  /\bkeeps?\b/i,
  /\baligned\b/i
];

const PROOF_PATTERNS = [
  /\bproof\b/i,
  /\bprove\b/i,
  /\bderive\b/i,
  /\bwe show that\b/i,
  /\bguarantee\b/i,
  /\bbound\b/i
];

const THEOREM_PATTERNS = [
  /\btheorem\b/i,
  /\blemma\b/i,
  /\bproposition\b/i,
  /\bcorollary\b/i
];

const FAILURE_PATTERNS = [
  /\bfail(?:s|ure)?\b/i,
  /\blimitation\b/i,
  /\blimited\b/i,
  /\bsensitive\b/i,
  /\bdegrade\b/i,
  /\bdrop\b/i,
  /\bfragmented\b/i,
  /\bwithout\b/i
];

const INNOVATION_PATTERNS = [
  /\bwe (?:propose|present|introduce|design|develop|construct)\b/i,
  /\bour (?:innovation|method|approach|framework|system)\b/i,
  /\bnovel\b/i,
  /\bkey contribution\b/i,
  /\bmain contribution\b/i,
  /\bfirst\b/i
];

const EXPERIMENT_PATTERNS = [
  /\bexperiment\b/i,
  /\bevaluate\b/i,
  /\bevaluation\b/i,
  /\bbenchmark\b/i,
  /\bbaseline\b/i,
  /\bcompare\b/i,
  /\bcomparison\b/i,
  /\bablation\b/i,
  /\brobust(?:ness)?\b/i,
  /\bstress test\b/i
];

const POSITIVE_OUTCOME_PATTERNS = [
  /\boutperform\b/i,
  /\bimprov(?:e|es|ed)\b/i,
  /\bgain\b/i,
  /\bsuccess(?:ful)?\b/i,
  /\bbetter\b/i,
  /\benable\b/i,
  /\bstrong\b/i
];

const NEGATIVE_OUTCOME_PATTERNS = [
  /\bfail(?:s|ed|ure)?\b/i,
  /\bdegrad(?:e|ed|es)\b/i,
  /\bdrop\b/i,
  /\bworse\b/i,
  /\bnegative result\b/i,
  /\blimited\b/i,
  /\bsensitive\b/i
];

const MIXED_OUTCOME_PATTERNS = [
  /\bmixed\b/i,
  /\btrade[- ]off\b/i,
  /\bwhile\b/i,
  /\bonly when\b/i,
  /\bbut\b/i
];

const REFLECTION_PATTERNS = [
  /\bthis suggests\b/i,
  /\bthis indicates\b/i,
  /\bwe learn\b/i,
  /\bour takeaway\b/i,
  /\blesson\b/i,
  /\binsight\b/i,
  /\bworks best\b/i,
  /\bworks when\b/i,
  /\bfails when\b/i,
  /\bapplicable\b/i,
  /\bdesign implication\b/i
];

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
}

function getSectionsByRole(parsedPaper, roles) {
  return (parsedPaper?.sections || []).filter((section) => roles.includes(section.role));
}

function selectBestSentence(sections, patterns, fallback = []) {
  const candidates = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text || '')) {
      const matchCount = patterns.reduce((count, regex) => count + (regex.test(sentence) ? 1 : 0), 0);
      if (!matchCount) continue;
      candidates.push({
        text: sentence,
        sectionHeading: section.heading || '',
        sectionRole: section.role || '',
        score: matchCount + Math.min(sentence.length / 220, 1)
      });
    }
  }

  return [...candidates, ...fallback]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({
      text: entry.text,
      sectionHeading: entry.sectionHeading || '',
      sectionRole: entry.sectionRole || ''
    }))[0] || null;
}

function dedupeByNormalized(items, limit = 12) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = normalizeText(item.text || item.name || item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

function buildPaperAnchorIndex(graph, paperId) {
  const anchors = new Map();
  if (!graph || typeof graph.getOutgoing !== 'function') {
    return anchors;
  }

  for (const relationship of graph.getOutgoing(paperId) || []) {
    const node = graph.getNode(relationship.targetId);
    if (!node) continue;
    if (!anchors.has(node.type)) anchors.set(node.type, []);
    anchors.get(node.type).push(node);
  }

  return anchors;
}

function resolveAnchors(anchorIndex, type, candidates = [], fallback = []) {
  const nodes = anchorIndex.get(type) || [];
  if (!nodes.length) return [];

  const texts = [...candidates, ...fallback].map((item) => String(item || '').trim()).filter(Boolean);
  if (!texts.length) return nodes.slice(0, 2).map((node) => node.id);

  const scored = nodes.map((node) => {
    const score = texts.reduce((best, text) => {
      return Math.max(best, jaccardSimilarity(node.name, text), jaccardSimilarity(node.properties?.text || '', text));
    }, 0);
    return { node, score };
  });

  return scored
    .filter((entry) => entry.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.node.id);
}

function makeCard(kind, text, options = {}) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalizedText) return null;

  return {
    id: `${kind}:${stableHash(`${kind}:${normalizedText}:${options.paperId || ''}:${options.sectionHeading || ''}`, 14)}`,
    kind,
    title: truncate(options.title || normalizedText, 96),
    text: truncate(normalizedText, 420),
    evidenceText: truncate(options.evidenceText || normalizedText, 420),
    sectionHeading: options.sectionHeading || '',
    sectionRole: options.sectionRole || '',
    confidence: Number(Number(options.confidence || 0.6).toFixed(2)),
    explicitOrInferred: options.explicitOrInferred || 'explicit',
    anchors: Array.isArray(options.anchors) ? unique(options.anchors) : []
  };
}

function collectSlotCards(kind, records, anchorIndex, anchorType, paperId, options = {}) {
  return dedupeByNormalized((records || []).map((record) => {
    const text = record.text || record.name || '';
    return makeCard(kind, text, {
      paperId,
      title: record.name || text,
      evidenceText: record.evidenceText || text,
      sectionHeading: record.sectionHeading || '',
      sectionRole: record.sectionRole || '',
      confidence: record.confidence ?? options.confidence ?? 0.62,
      explicitOrInferred: record.explicitOrInferred || 'explicit',
      anchors: resolveAnchors(anchorIndex, anchorType, [record.name, record.text, record.evidenceText], [text])
    });
  }).filter(Boolean), options.limit || 6);
}

function collectSentenceCards(kind, sections, patterns, anchorIndex, anchorType, paperId, options = {}) {
  const cards = [];

  for (const section of sections) {
    for (const sentence of splitSentences(section.text || '')) {
      const matchCount = patterns.reduce((count, regex) => count + (regex.test(sentence) ? 1 : 0), 0);
      if (!matchCount) continue;

      cards.push(makeCard(kind, sentence, {
        paperId,
        sectionHeading: section.heading || '',
        sectionRole: section.role || '',
        confidence: (options.baseConfidence || 0.62) + Math.min(matchCount * 0.05, 0.18),
        anchors: resolveAnchors(anchorIndex, anchorType, [sentence])
      }));
    }
  }

  return dedupeByNormalized(cards.filter(Boolean), options.limit || 6);
}

function averageConfidence(items = []) {
  if (!items.length) return 0;
  const total = items.reduce((sum, item) => sum + Number(item.confidence || 0), 0);
  return Number((total / items.length).toFixed(2));
}

function inferOutcomeVerdict(text) {
  const normalized = String(text || '');
  const positive = POSITIVE_OUTCOME_PATTERNS.reduce((count, regex) => count + (regex.test(normalized) ? 1 : 0), 0);
  const negative = NEGATIVE_OUTCOME_PATTERNS.reduce((count, regex) => count + (regex.test(normalized) ? 1 : 0), 0);
  const mixed = MIXED_OUTCOME_PATTERNS.reduce((count, regex) => count + (regex.test(normalized) ? 1 : 0), 0);

  if (mixed && positive && negative) return 'mixed';
  if (positive && negative) return 'mixed';
  if (negative > positive) return 'failure';
  if (positive > negative) return 'success';
  return 'inconclusive';
}

function inferExperimentType(text = '', sectionHeading = '') {
  const combined = `${sectionHeading} ${text}`.toLowerCase();
  if (combined.includes('ablation')) return 'ablation';
  if (combined.includes('robust')) return 'robustness';
  if (combined.includes('baseline') || combined.includes('compare')) return 'comparison';
  if (combined.includes('fail') || combined.includes('error analysis') || combined.includes('negative')) return 'failure-attempt';
  return 'main';
}

function makeReflectionCard(kind, text, options = {}) {
  const card = makeCard(kind, text, options);
  if (!card) return null;

  if (kind === 'experiment') {
    card.experimentType = options.experimentType || 'main';
  }
  if (kind === 'outcome') {
    card.verdict = REFLECTION_VERDICTS.includes(options.verdict) ? options.verdict : 'inconclusive';
  }
  if (kind === 'reflection') {
    card.scope = options.scope || 'paper';
  }

  return card;
}

function collectInnovationCards({ semanticPaper, parsedPaper, anchorIndex }) {
  const paperId = semanticPaper.paperId;
  const introSections = getSectionsByRole(parsedPaper, ['abstract', 'introduction', 'method', 'body']);

  const fromClaims = dedupeByNormalized((semanticPaper.claims || []).map((claim) => makeReflectionCard('innovation', claim.text || claim.name || '', {
    paperId,
    title: claim.name || claim.text || 'innovation',
    evidenceText: claim.evidenceText || claim.text || '',
    sectionHeading: claim.sectionHeading || '',
    sectionRole: claim.sectionRole || '',
    confidence: claim.confidence ?? 0.72,
    anchors: resolveAnchors(anchorIndex, NODE_TYPES.CLAIM, [claim.name, claim.text])
  })).filter(Boolean), 3);

  const fromMethods = collectSlotCards('innovation', semanticPaper.methods, anchorIndex, NODE_TYPES.METHOD, paperId, {
    confidence: 0.7,
    limit: 3
  }).map((card) => ({
    ...card,
    kind: 'innovation'
  }));

  const fromSentences = collectSentenceCards('innovation', introSections, INNOVATION_PATTERNS, anchorIndex, NODE_TYPES.METHOD, paperId, {
    baseConfidence: 0.66,
    limit: 4
  }).map((card) => ({
    ...card,
    kind: 'innovation'
  }));

  return dedupeByNormalized([
    ...fromClaims,
    ...fromMethods,
    ...fromSentences
  ], 6);
}

function collectExperimentCards({ semanticPaper, parsedPaper, anchorIndex }) {
  const paperId = semanticPaper.paperId;
  const resultSections = getSectionsByRole(parsedPaper, ['results', 'analysis', 'discussion', 'body']);
  const cards = [];

  for (const benchmark of semanticPaper.benchmarks || []) {
    cards.push(makeReflectionCard('experiment', benchmark.text || benchmark.name || '', {
      paperId,
      title: benchmark.name || benchmark.text || 'benchmark experiment',
      evidenceText: benchmark.evidenceText || benchmark.text || benchmark.name || '',
      sectionHeading: benchmark.sectionHeading || '',
      sectionRole: benchmark.sectionRole || '',
      confidence: benchmark.confidence ?? 0.69,
      experimentType: inferExperimentType(benchmark.text || benchmark.name || '', benchmark.sectionHeading || ''),
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.BENCHMARK, [benchmark.name, benchmark.text])
    }));
  }

  for (const dataset of semanticPaper.datasets || []) {
    cards.push(makeReflectionCard('experiment', dataset.text || dataset.name || '', {
      paperId,
      title: dataset.name || dataset.text || 'dataset experiment',
      evidenceText: dataset.evidenceText || dataset.text || dataset.name || '',
      sectionHeading: dataset.sectionHeading || '',
      sectionRole: dataset.sectionRole || '',
      confidence: dataset.confidence ?? 0.66,
      experimentType: inferExperimentType(dataset.text || dataset.name || '', dataset.sectionHeading || ''),
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.DATASET, [dataset.name, dataset.text])
    }));
  }

  for (const section of resultSections) {
    for (const sentence of splitSentences(section.text || '')) {
      const matchCount = EXPERIMENT_PATTERNS.reduce((count, regex) => count + (regex.test(sentence) ? 1 : 0), 0);
      if (!matchCount) continue;
      cards.push(makeReflectionCard('experiment', sentence, {
        paperId,
        sectionHeading: section.heading || '',
        sectionRole: section.role || '',
        confidence: 0.62 + Math.min(matchCount * 0.04, 0.14),
        experimentType: inferExperimentType(sentence, section.heading || ''),
        anchors: [
          ...resolveAnchors(anchorIndex, NODE_TYPES.BENCHMARK, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.DATASET, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.EVIDENCE, [sentence])
        ]
      }));
    }
  }

  return dedupeByNormalized(cards.filter(Boolean), 8);
}

function collectOutcomeCards({ semanticPaper, parsedPaper, anchorIndex }) {
  const paperId = semanticPaper.paperId;
  const resultSections = getSectionsByRole(parsedPaper, ['results', 'analysis', 'discussion', 'conclusion', 'body']);
  const cards = [];

  for (const finding of semanticPaper.findings || []) {
    const text = finding.text || finding.name || '';
    cards.push(makeReflectionCard('outcome', text, {
      paperId,
      title: finding.name || text,
      evidenceText: finding.evidenceText || text,
      sectionHeading: finding.sectionHeading || '',
      sectionRole: finding.sectionRole || '',
      confidence: finding.confidence ?? 0.72,
      verdict: inferOutcomeVerdict(text),
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.FINDING, [finding.name, finding.text, finding.evidenceText])
    }));
  }

  for (const limitation of semanticPaper.limitations || []) {
    const text = limitation.text || limitation.name || '';
    cards.push(makeReflectionCard('outcome', text, {
      paperId,
      title: limitation.name || text,
      evidenceText: limitation.evidenceText || text,
      sectionHeading: limitation.sectionHeading || '',
      sectionRole: limitation.sectionRole || '',
      confidence: limitation.confidence ?? 0.68,
      verdict: inferOutcomeVerdict(text),
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.LIMITATION, [limitation.name, limitation.text, limitation.evidenceText])
    }));
  }

  for (const section of resultSections) {
    for (const sentence of splitSentences(section.text || '')) {
      const verdict = inferOutcomeVerdict(sentence);
      const signalCount = [
        ...POSITIVE_OUTCOME_PATTERNS,
        ...NEGATIVE_OUTCOME_PATTERNS,
        ...MIXED_OUTCOME_PATTERNS
      ].reduce((count, regex) => count + (regex.test(sentence) ? 1 : 0), 0);
      if (!signalCount) continue;

      cards.push(makeReflectionCard('outcome', sentence, {
        paperId,
        sectionHeading: section.heading || '',
        sectionRole: section.role || '',
        confidence: 0.6 + Math.min(signalCount * 0.04, 0.16),
        verdict,
        anchors: [
          ...resolveAnchors(anchorIndex, NODE_TYPES.FINDING, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.EVIDENCE, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.LIMITATION, [sentence])
        ]
      }));
    }
  }

  return dedupeByNormalized(cards.filter(Boolean), 8);
}

function collectReflectionCards({ semanticPaper, parsedPaper, anchorIndex }) {
  const paperId = semanticPaper.paperId;
  const sections = getSectionsByRole(parsedPaper, ['discussion', 'conclusion', 'analysis', 'future-work', 'body']);
  const cards = [];

  for (const limitation of semanticPaper.limitations || []) {
    const text = limitation.text || limitation.name || '';
    cards.push(makeReflectionCard('reflection', text, {
      paperId,
      title: limitation.name || text,
      evidenceText: text,
      sectionHeading: limitation.sectionHeading || '',
      sectionRole: limitation.sectionRole || '',
      confidence: limitation.confidence ?? 0.66,
      scope: 'boundary',
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.LIMITATION, [limitation.name, limitation.text])
    }));
  }

  for (const futureDirection of semanticPaper.futureDirections || []) {
    const text = futureDirection.text || futureDirection.name || '';
    cards.push(makeReflectionCard('reflection', text, {
      paperId,
      title: futureDirection.name || text,
      evidenceText: text,
      sectionHeading: futureDirection.sectionHeading || '',
      sectionRole: futureDirection.sectionRole || '',
      confidence: futureDirection.confidence ?? 0.64,
      scope: 'future',
      anchors: resolveAnchors(anchorIndex, NODE_TYPES.FUTURE_DIRECTION, [futureDirection.name, futureDirection.text])
    }));
  }

  for (const section of sections) {
    for (const sentence of splitSentences(section.text || '')) {
      const matchCount = REFLECTION_PATTERNS.reduce((count, regex) => count + (regex.test(sentence) ? 1 : 0), 0);
      if (!matchCount) continue;

      cards.push(makeReflectionCard('reflection', sentence, {
        paperId,
        sectionHeading: section.heading || '',
        sectionRole: section.role || '',
        confidence: 0.6 + Math.min(matchCount * 0.05, 0.18),
        scope: section.role === 'future-work' ? 'future' : 'paper',
        anchors: [
          ...resolveAnchors(anchorIndex, NODE_TYPES.LIMITATION, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.CLAIM, [sentence]),
          ...resolveAnchors(anchorIndex, NODE_TYPES.FINDING, [sentence])
        ]
      }));
    }
  }

  return dedupeByNormalized(cards.filter(Boolean), 8);
}

function scoreCardLink(left, right) {
  const sharedAnchors = (left.anchors || []).filter((anchor) => (right.anchors || []).includes(anchor)).length;
  const similarity = jaccardSimilarity(left.text || left.title || '', right.text || right.title || '');
  return sharedAnchors ? 0.45 + sharedAnchors * 0.1 + similarity * 0.25 : similarity;
}

function buildReflectionLinks(innovations, experiments, outcomes, reflections) {
  const links = [];

  if (innovations.length && experiments.length) {
    const leadInnovation = innovations[0];
    for (const experiment of experiments.slice(0, 6)) {
      links.push({
        id: `reflink:${stableHash(`${leadInnovation.id}:TESTED_BY:${experiment.id}`, 16)}`,
        sourceId: leadInnovation.id,
        targetId: experiment.id,
        type: 'TESTED_BY',
        confidence: Number(((Number(leadInnovation.confidence || 0.6) + Number(experiment.confidence || 0.6)) / 2).toFixed(2))
      });
    }
  }

  for (const experiment of experiments) {
    const bestOutcome = outcomes
      .map((outcome) => ({ outcome, score: scoreCardLink(experiment, outcome) }))
      .filter((entry) => entry.score >= 0.14)
      .sort((left, right) => right.score - left.score)[0];
    if (!bestOutcome) continue;

    links.push({
      id: `reflink:${stableHash(`${experiment.id}:PRODUCED:${bestOutcome.outcome.id}`, 16)}`,
      sourceId: experiment.id,
      targetId: bestOutcome.outcome.id,
      type: 'PRODUCED',
      confidence: Number(Math.min(0.92, 0.58 + bestOutcome.score).toFixed(2))
    });
  }

  for (const outcome of outcomes) {
    const bestReflection = reflections
      .map((reflection) => ({ reflection, score: scoreCardLink(outcome, reflection) }))
      .filter((entry) => entry.score >= 0.12)
      .sort((left, right) => right.score - left.score)[0];
    if (!bestReflection) continue;

    links.push({
      id: `reflink:${stableHash(`${outcome.id}:SUMMARIZED_AS:${bestReflection.reflection.id}`, 16)}`,
      sourceId: outcome.id,
      targetId: bestReflection.reflection.id,
      type: 'SUMMARIZED_AS',
      confidence: Number(Math.min(0.9, 0.56 + bestReflection.score).toFixed(2))
    });
  }

  return links.slice(0, 18);
}

function buildReflectionOverlay({ semanticPaper, parsedPaper, graph }) {
  const paperId = semanticPaper.paperId;
  const anchorIndex = buildPaperAnchorIndex(graph, paperId);
  const innovations = collectInnovationCards({ semanticPaper, parsedPaper, anchorIndex });
  const experiments = collectExperimentCards({ semanticPaper, parsedPaper, anchorIndex });
  const outcomes = collectOutcomeCards({ semanticPaper, parsedPaper, anchorIndex });
  const reflections = collectReflectionCards({ semanticPaper, parsedPaper, anchorIndex });

  if (!reflections.length) {
    const sourceOutcome = outcomes[0];
    const fallbackReflection = sourceOutcome
      ? makeReflectionCard('reflection', sourceOutcome.verdict === 'failure'
        ? `This suggests the proposed approach breaks under at least one tested setting and needs tighter boundary assumptions.`
        : sourceOutcome.verdict === 'mixed'
          ? `This suggests the paper's main idea works with trade-offs and should be reused with attention to context-specific limits.`
          : `This suggests the paper's main idea is supported in the reported setting, but its transfer conditions should still be checked.`, {
        paperId,
        sectionHeading: sourceOutcome.sectionHeading || '',
        sectionRole: sourceOutcome.sectionRole || '',
        confidence: 0.48,
        explicitOrInferred: 'inferred',
        scope: 'paper',
        anchors: sourceOutcome.anchors || []
      })
      : null;

    if (fallbackReflection) {
      reflections.push(fallbackReflection);
    }
  }
  const cards = dedupeByNormalized([
    ...innovations,
    ...experiments,
    ...outcomes,
    ...reflections
  ], 28);
  const links = buildReflectionLinks(innovations, experiments, outcomes, reflections);
  const verdictCounts = outcomes.reduce((counts, outcome) => {
    const verdict = outcome.verdict || 'inconclusive';
    counts[verdict] = (counts[verdict] || 0) + 1;
    return counts;
  }, {});
  const risks = [];

  if (innovations.length && !experiments.length) {
    risks.push('Innovation candidates were extracted, but no clear experiment units were surfaced.');
  }
  if (experiments.length && !outcomes.length) {
    risks.push('Experiments were identified, but outcomes remain underspecified.');
  }
  if (outcomes.length && !reflections.length) {
    risks.push('Outcomes exist, but lessons or transferable reflections remain thin.');
  }

  return {
    overlayKind: 'reflection',
    version: THEORY_VERSION,
    confidence: averageConfidence(cards),
    summary: truncate([
      innovations[0] ? `Innovation: ${innovations[0].text}` : '',
      experiments[0] ? `Experiment: ${experiments[0].text}` : '',
      outcomes[0] ? `Outcome: ${outcomes[0].verdict} - ${outcomes[0].text}` : '',
      reflections[0] ? `Reflection: ${reflections[0].text}` : ''
    ].filter(Boolean).join(' '), 280),
    cards,
    slots: {
      innovations: innovations.map((card) => card.id),
      experiments: experiments.map((card) => card.id),
      outcomes: outcomes.map((card) => card.id),
      reflections: reflections.map((card) => card.id)
    },
    links,
    verdictCounts,
    risks
  };
}

function buildOverlayLinks(claimCards, theoryCards) {
  const links = [];

  for (const claim of claimCards.slice(0, 4)) {
    for (const entry of theoryCards.slice(0, 6)) {
      let type = 'EXPLAINED_BY';
      if (entry.kind === 'assumption') type = 'DEPENDS_ON';
      else if (entry.kind === 'failure-mode' || entry.kind === 'limitation') type = 'FAILS_UNDER';
      else if (entry.kind === 'theorem-like' || entry.kind === 'proof-idea') type = 'SUPPORTED_BY_REASONING';

      links.push({
        id: `olink:${stableHash(`${claim.id}:${type}:${entry.id}`, 16)}`,
        sourceId: claim.id,
        targetId: entry.id,
        type,
        confidence: Number(((Number(claim.confidence || 0.6) + Number(entry.confidence || 0.6)) / 2).toFixed(2))
      });
    }
  }

  return links.slice(0, 18);
}

function buildTheoryOverlay({ semanticPaper, parsedPaper, graph }) {
  const paperId = semanticPaper.paperId;
  const anchorIndex = buildPaperAnchorIndex(graph, paperId);
  const explanationSections = getSectionsByRole(parsedPaper, ['abstract', 'introduction', 'method', 'body', 'analysis', 'discussion', 'conclusion']);
  const reasoningSections = getSectionsByRole(parsedPaper, ['method', 'analysis', 'discussion', 'conclusion', 'body', 'preliminaries']);

  const claimCards = collectSlotCards('claim-support', semanticPaper.claims, anchorIndex, NODE_TYPES.CLAIM, paperId, {
    confidence: 0.7,
    limit: 4
  });
  const assumptionCards = collectSlotCards('assumption', semanticPaper.assumptions, anchorIndex, NODE_TYPES.ASSUMPTION, paperId, {
    limit: 4
  });
  const limitationCards = collectSlotCards('limitation', semanticPaper.limitations, anchorIndex, NODE_TYPES.LIMITATION, paperId, {
    limit: 4
  });
  const mechanismCards = collectSentenceCards('mechanism', explanationSections, MECHANISM_PATTERNS, anchorIndex, NODE_TYPES.METHOD, paperId, {
    baseConfidence: 0.64,
    limit: 4
  });
  const theoremCards = collectSentenceCards('theorem-like', reasoningSections, THEOREM_PATTERNS, anchorIndex, NODE_TYPES.CLAIM, paperId, {
    baseConfidence: 0.66,
    limit: 3
  });
  const proofCards = collectSentenceCards('proof-idea', reasoningSections, PROOF_PATTERNS, anchorIndex, NODE_TYPES.CLAIM, paperId, {
    baseConfidence: 0.63,
    limit: 3
  });
  const failureCards = collectSentenceCards('failure-mode', reasoningSections, FAILURE_PATTERNS, anchorIndex, NODE_TYPES.LIMITATION, paperId, {
    baseConfidence: 0.65,
    limit: 4
  });

  const cards = dedupeByNormalized([
    ...claimCards,
    ...assumptionCards,
    ...mechanismCards,
    ...theoremCards,
    ...proofCards,
    ...limitationCards,
    ...failureCards
  ], 24);

  const links = buildOverlayLinks(claimCards, [
    ...assumptionCards,
    ...mechanismCards,
    ...theoremCards,
    ...proofCards,
    ...limitationCards,
    ...failureCards
  ]);

  const risks = [];
  if (claimCards.length && !mechanismCards.length) {
    risks.push('Claims are present, but no strong mechanism sentence was extracted.');
  }
  if (claimCards.length && !assumptionCards.length) {
    risks.push('Claims are present, but explicit assumptions were not surfaced.');
  }
  if (!failureCards.length && !limitationCards.length) {
    risks.push('Failure modes and limitations remain underspecified.');
  }

  const summarySentence = mechanismCards[0]?.text
    || theoremCards[0]?.text
    || proofCards[0]?.text
    || semanticPaper.abstract
    || '';
  const supportNote = [
    claimCards[0] ? `Main claim: ${claimCards[0].text}` : '',
    summarySentence ? `Why it might work: ${summarySentence}` : '',
    assumptionCards[0] ? `Assumption: ${assumptionCards[0].text}` : '',
    failureCards[0] ? `Failure mode: ${failureCards[0].text}` : limitationCards[0] ? `Limitation: ${limitationCards[0].text}` : ''
  ].filter(Boolean);

  return {
    overlayKind: 'theory',
    version: THEORY_VERSION,
    confidence: averageConfidence([
      ...mechanismCards,
      ...assumptionCards,
      ...proofCards,
      ...theoremCards,
      ...failureCards,
      ...limitationCards
    ]),
    summary: truncate(summarySentence || semanticPaper.abstract || semanticPaper.paperTitle, 220),
    supportNote,
    cards,
    slots: {
      claims: claimCards.map((card) => card.id),
      assumptions: assumptionCards.map((card) => card.id),
      mechanisms: mechanismCards.map((card) => card.id),
      theoremLike: theoremCards.map((card) => card.id),
      proofIdeas: proofCards.map((card) => card.id),
      limitations: limitationCards.map((card) => card.id),
      failureModes: failureCards.map((card) => card.id)
    },
    links,
    risks
  };
}

function buildBeat(kind, text, options = {}) {
  const card = makeCard(kind, text, options);
  if (!card) return null;

  return {
    ...card,
    order: STORYLINE_ORDER.indexOf(kind) + 1
  };
}

function resolveBeatFromSlot(kind, records, paperId, anchorIndex, anchorType, fallbackConfidence = 0.68) {
  const record = (records || [])[0];
  if (!record) return null;

  return buildBeat(kind, record.text || record.name || '', {
    paperId,
    title: record.name || record.text || kind,
    evidenceText: record.evidenceText || record.text || record.name || '',
    sectionHeading: record.sectionHeading || '',
    sectionRole: record.sectionRole || '',
    confidence: record.confidence ?? fallbackConfidence,
    anchors: resolveAnchors(anchorIndex, anchorType, [record.name, record.text, record.evidenceText])
  });
}

function resolveBeatFromSentence(kind, sections, patterns, paperId, anchorIndex, anchorType, fallbackConfidence = 0.62) {
  const candidate = selectBestSentence(sections, patterns);
  if (!candidate) return null;

  return buildBeat(kind, candidate.text, {
    paperId,
    sectionHeading: candidate.sectionHeading,
    sectionRole: candidate.sectionRole,
    confidence: fallbackConfidence,
    anchors: resolveAnchors(anchorIndex, anchorType, [candidate.text])
  });
}

function buildStorylineOverlay({ semanticPaper, parsedPaper, graph }) {
  const paperId = semanticPaper.paperId;
  const anchorIndex = buildPaperAnchorIndex(graph, paperId);
  const abstractSections = getSectionsByRole(parsedPaper, ['abstract']);
  const introSections = getSectionsByRole(parsedPaper, ['introduction', 'related-work', 'body']);
  const methodSections = getSectionsByRole(parsedPaper, ['method', 'body']);
  const resultSections = getSectionsByRole(parsedPaper, ['results', 'analysis', 'discussion', 'conclusion', 'body']);

  const problemBeat = resolveBeatFromSlot('problem', semanticPaper.problems, paperId, anchorIndex, NODE_TYPES.PROBLEM, 0.74)
    || resolveBeatFromSentence('problem', [...abstractSections, ...introSections], CONTRIBUTION_PATTERNS, paperId, anchorIndex, NODE_TYPES.PROBLEM, 0.62);
  const gapBeat = resolveBeatFromSentence('gap', [...introSections, ...abstractSections], GAP_PATTERNS, paperId, anchorIndex, NODE_TYPES.PROBLEM, 0.64);
  const ideaBeat = resolveBeatFromSentence('idea', [...abstractSections, ...introSections], IDEA_PATTERNS, paperId, anchorIndex, NODE_TYPES.METHOD, 0.69);
  const methodBeat = resolveBeatFromSlot('method', semanticPaper.methods, paperId, anchorIndex, NODE_TYPES.METHOD, 0.72)
    || resolveBeatFromSentence('method', methodSections, METHOD_PATTERNS, paperId, anchorIndex, NODE_TYPES.METHOD, 0.64);
  const evidenceBeat = resolveBeatFromSlot('evidence', semanticPaper.findings, paperId, anchorIndex, NODE_TYPES.FINDING, 0.72)
    || resolveBeatFromSlot('evidence', semanticPaper.evidences, paperId, anchorIndex, NODE_TYPES.EVIDENCE, 0.68)
    || resolveBeatFromSentence('evidence', resultSections, EVIDENCE_PATTERNS, paperId, anchorIndex, NODE_TYPES.EVIDENCE, 0.64);
  const contributionBeat = resolveBeatFromSentence('contribution', [...abstractSections, ...resultSections], CONTRIBUTION_PATTERNS, paperId, anchorIndex, NODE_TYPES.CLAIM, 0.66)
    || resolveBeatFromSlot('contribution', semanticPaper.claims, paperId, anchorIndex, NODE_TYPES.CLAIM, 0.68);
  const limitationBeat = resolveBeatFromSlot('limitation', semanticPaper.limitations, paperId, anchorIndex, NODE_TYPES.LIMITATION, 0.68)
    || resolveBeatFromSentence('limitation', resultSections, FAILURE_PATTERNS, paperId, anchorIndex, NODE_TYPES.LIMITATION, 0.6);

  const beats = [
    problemBeat,
    gapBeat,
    ideaBeat,
    methodBeat,
    evidenceBeat,
    contributionBeat,
    limitationBeat
  ].filter(Boolean);

  const links = beats.slice(0, -1).map((beat, index) => ({
    id: `slink:${stableHash(`${beat.id}:${beats[index + 1].id}`, 16)}`,
    sourceId: beat.id,
    targetId: beats[index + 1].id,
    type: 'NEXT_BEAT',
    confidence: Number(((Number(beat.confidence || 0.6) + Number(beats[index + 1].confidence || 0.6)) / 2).toFixed(2))
  }));

  const missingBeats = STORYLINE_ORDER.filter((kind) => !beats.some((beat) => beat.kind === kind));
  const risks = [];
  if (!gapBeat && problemBeat) risks.push('The storyline states a problem but does not make the gap explicit.');
  if (!evidenceBeat && (ideaBeat || methodBeat)) risks.push('The storyline introduces an idea/method without a clear evidence beat.');
  if (!limitationBeat && contributionBeat) risks.push('The storyline makes a contribution claim without surfacing a limitation beat.');

  return {
    overlayKind: 'storyline',
    version: THEORY_VERSION,
    confidence: averageConfidence(beats),
    summary: truncate(beats.map((beat) => beat.text).join(' '), 260),
    sketch: beats.map((beat) => `${beat.kind}: ${beat.text}`),
    beats,
    links,
    missingBeats,
    risks
  };
}

export function buildPaperEnhancementOverlay({ semanticPaper, parsedPaper, graph, corpusMeta, job }) {
  const extractedAt = new Date().toISOString();
  const runId = `run:${stableHash(`${semanticPaper.paperId}:${semanticPaper.sourceFingerprint}:${extractedAt}`, 18)}`;
  const theory = buildTheoryOverlay({ semanticPaper, parsedPaper, graph });
  const storyline = buildStorylineOverlay({ semanticPaper, parsedPaper, graph });
  const reflection = buildReflectionOverlay({ semanticPaper, parsedPaper, graph });

  return {
    version: 1,
    runId,
    extractedAt,
    extractorVersion: THEORY_VERSION,
    promptVersion: THEORY_VERSION,
    paperId: semanticPaper.paperId,
    paperTitle: semanticPaper.paperTitle,
    sourceKey: semanticPaper.sourceKey,
    sourceFingerprint: semanticPaper.sourceFingerprint,
    sourceMarkdownPath: semanticPaper.sourceMarkdownPath,
    baseGraphIndexedAt: corpusMeta?.indexedAt || null,
    queueTrigger: job?.trigger || 'unknown',
    overlays: {
      theory,
      storyline,
      reflection
    }
  };
}

export function buildTheorySupportNote(overlay) {
  return overlay?.overlays?.theory?.supportNote || [];
}

export function buildStorylineSketch(overlay) {
  return overlay?.overlays?.storyline?.sketch || [];
}

export function summarizePaperEnhancement(overlay) {
  return {
    paperId: overlay.paperId,
    paperTitle: overlay.paperTitle,
    theoryConfidence: overlay?.overlays?.theory?.confidence ?? null,
    storylineConfidence: overlay?.overlays?.storyline?.confidence ?? null,
    reflectionConfidence: overlay?.overlays?.reflection?.confidence ?? null,
    missingStoryBeats: overlay?.overlays?.storyline?.missingBeats || [],
    theoryRisks: overlay?.overlays?.theory?.risks || [],
    storylineRisks: overlay?.overlays?.storyline?.risks || [],
    reflectionRisks: overlay?.overlays?.reflection?.risks || []
  };
}
