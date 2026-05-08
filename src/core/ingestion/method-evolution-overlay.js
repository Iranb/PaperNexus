import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import {
  normalizeText,
  slugify,
  stableHash,
  tokenizeWithoutStopwords,
  truncate,
  unique
} from '../../lib/utils.js';

export const CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-citation-contexts-v1';
export const METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION = 'papernexus-method-evolution-overlay-v1';

const METHOD_EVOLUTION_RELATION_SOURCE = 'citation-context-method-evolution-overlay-v1';
const MIN_SEMANTIC_CONFIDENCE = 0.55;
const AUTHORITATIVE_SEMANTIC_CONFIDENCE = 0.78;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function cleanText(value, max = 720) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function parseYear(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function inferArxivYear(value) {
  const match = String(value || '').match(/\b(?:arxiv[:/ ]*)?(\d{2})(\d{2})\.\d{4,5}\b/i);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year)) return null;
  return year >= 91 ? 1900 + year : 2000 + year;
}

export function inferPaperYear(paper = {}) {
  return firstDefined(
    parseYear(paper.year),
    parseYear(paper.publicationYear),
    parseYear(paper.publishedYear),
    parseYear(paper.paperYear),
    parseYear(paper.introducedYear),
    parseYear(paper.identifiers?.publicationYear),
    parseYear(paper.identifiers?.publishedYear),
    inferArxivYear(paper.identifiers?.arxivId),
    inferArxivYear(paper.sourceId),
    inferArxivYear(paper.canonicalId),
    inferArxivYear(paper.sourcePath),
    parseYear(paper.sourcePath),
    parseYear(paper.paperTitle)
  ) || null;
}

function referenceYear(reference = {}) {
  return parseYear(reference.year) || parseYear(reference.raw) || null;
}

function methodNodeId(name) {
  return `${NODE_TYPES.METHOD.toLowerCase()}:${slugify(name)}:${stableHash(`${NODE_TYPES.METHOD}:${name}`)}`;
}

function normalizedKey(value) {
  return normalizeText(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedIncludesPhrase(text, phrase) {
  const normalizedText = normalizedKey(text);
  const normalizedPhrase = normalizedKey(phrase);
  if (!normalizedText || !normalizedPhrase) return false;
  if (normalizedPhrase.length <= 3) {
    return normalizedText.split(' ').includes(normalizedPhrase);
  }
  return normalizedText.includes(normalizedPhrase);
}

function citationSentenceWindow(text, citationRaw = '') {
  const cleaned = cleanText(text, 1800);
  if (!cleaned) return '';
  const sentences = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return cleanText(cleaned, 620);

  const raw = String(citationRaw || '').trim();
  if (raw) {
    const normalizedRaw = raw.replace(/^\(|\)$/g, '');
    const matchIndex = sentences.findIndex((sentence) => (
      sentence.includes(raw)
      || sentence.includes(normalizedRaw)
      || normalizedIncludesPhrase(sentence, normalizedRaw)
    ));
    if (matchIndex >= 0) {
      const start = Math.max(0, matchIndex - 1);
      const end = Math.min(sentences.length, matchIndex + 2);
      return cleanText(sentences.slice(start, end).join(' '), 720);
    }
  }

  return cleanText(sentences[0], 620);
}

function buildReferenceLookup(references = []) {
  const byId = new Map();
  const byIndex = new Map();
  for (const reference of references) {
    if (reference?.id) byId.set(reference.id, reference);
    if (reference?.index !== undefined && reference?.index !== null) {
      byIndex.set(Number(reference.index), reference);
    }
  }
  return { byId, byIndex };
}

export function extractCitationContextsFromPaper(paper = {}) {
  const diagnostics = {
    contractVersion: CITATION_CONTEXTS_CONTRACT_VERSION,
    errors: [],
    warnings: [],
    sectionCount: 0,
    chunkCount: 0,
    mentionCount: 0,
    contextCount: 0
  };
  const contexts = [];

  try {
    const referenceLookup = buildReferenceLookup(asArray(paper.references));
    const sections = asArray(paper.sections);
    diagnostics.sectionCount = sections.length;

    for (const section of sections) {
      try {
        if (section?.role === 'references') continue;
        const chunks = asArray(section?.chunks);
        diagnostics.chunkCount += chunks.length;
        for (const chunk of chunks) {
          const mentions = asArray(chunk?.citations);
          diagnostics.mentionCount += mentions.length;
          for (const mention of mentions) {
            try {
              if (!mention || typeof mention !== 'object') continue;
              const reference = mention.referenceId
                ? referenceLookup.byId.get(mention.referenceId)
                : null;
              const quote = citationSentenceWindow(chunk?.text, mention.raw);
              if (!quote) continue;
              contexts.push({
                contractVersion: CITATION_CONTEXTS_CONTRACT_VERSION,
                id: `citation-context:${stableHash(`${paper.paperId || paper.paperTitle}:${chunk?.id || ''}:${mention.raw || ''}:${quote}`)}`,
                paperId: paper.paperId || null,
                paperTitle: paper.paperTitle || paper.title || '',
                sourceKey: paper.sourceKey || null,
                sourcePath: paper.sourcePath || '',
                sourceMarkdownPath: paper.sourceMarkdownPath || '',
                sourcePdfPath: paper.sourcePdfPath || '',
                sectionId: section?.id || null,
                sectionHeading: section?.heading || '',
                sectionRole: section?.role || '',
                chunkId: chunk?.id || null,
                citationRaw: String(mention.raw || '').trim(),
                citationStyle: mention.style || '',
                referenceId: mention.referenceId || null,
                referenceRaw: reference?.raw || '',
                referenceTitleGuess: reference?.titleGuess || '',
                referenceYear: referenceYear(reference),
                referenceLeadAuthorLastName: reference?.leadAuthorLastName || '',
                exactQuote: quote,
                citationContext: quote,
                extractionStatus: reference ? 'reference-resolved' : (mention.referenceId ? 'reference-missing' : 'reference-unresolved')
              });
            } catch (error) {
              diagnostics.errors.push({
                stage: 'citation-mention',
                paperId: paper.paperId || null,
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      } catch (error) {
        diagnostics.errors.push({
          stage: 'citation-section',
          paperId: paper.paperId || null,
          sectionHeading: section?.heading || '',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    diagnostics.errors.push({
      stage: 'citation-extraction',
      paperId: paper?.paperId || null,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  diagnostics.contextCount = contexts.length;
  return { contexts, diagnostics };
}

function methodAliases(method = {}) {
  return unique([
    method.name,
    method.text,
    method.normalized,
    method.canonicalName,
    ...(asArray(method.aliases)),
    ...(asArray(method.methodAliases)),
    ...(asArray(method.nameAliases))
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function addAlias(aliasMap, alias, method) {
  const key = normalizedKey(alias);
  if (!key) return;
  if (!aliasMap.has(key)) aliasMap.set(key, []);
  aliasMap.get(key).push(method);
}

function createPaperTitleKeys(paper = {}) {
  return unique([
    paper.paperTitle,
    paper.title,
    paper.normalizedTitle,
    ...(asArray(paper.identityAliases))
  ].map(normalizedKey).filter(Boolean));
}

function createTitleScore(left, right) {
  const leftTokens = tokenizeWithoutStopwords(left);
  const rightTokens = tokenizeWithoutStopwords(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  return overlap / Math.max(leftTokens.length, rightTokens.length);
}

export function buildMethodRegistry(papers = []) {
  const methods = [];
  const aliases = new Map();
  const methodsByPaperId = new Map();
  const methodById = new Map();
  const paperTitleRecords = [];
  const stubById = new Map();

  for (const paper of asArray(papers)) {
    const paperYear = inferPaperYear(paper);
    const paperMethods = [];
    for (const method of asArray(paper?.methods)) {
      const methodName = String(method?.name || method?.text || '').trim();
      if (!methodName) continue;
      const aliasesForMethod = methodAliases(method);
      const record = {
        methodId: methodNodeId(methodName),
        methodName,
        normalizedName: normalizedKey(methodName),
        aliases: aliasesForMethod,
        aliasKeys: aliasesForMethod.map(normalizedKey).filter(Boolean),
        paperId: paper.paperId || null,
        paperTitle: paper.paperTitle || paper.title || '',
        sourceKey: paper.sourceKey || null,
        year: parseYear(method.year) || parseYear(method.publicationYear) || parseYear(method.introducedYear) || paperYear,
        confidence: Number.isFinite(Number(method.confidence)) ? Number(method.confidence) : 0.6,
        evidenceText: method.evidenceText || method.text || methodName
      };
      methods.push(record);
      paperMethods.push(record);
      methodById.set(record.methodId, record);
      for (const alias of aliasesForMethod) addAlias(aliases, alias, record);
    }

    if (paper.paperId) methodsByPaperId.set(paper.paperId, paperMethods);
    for (const key of createPaperTitleKeys(paper)) {
      paperTitleRecords.push({
        key,
        paperId: paper.paperId || null,
        paperTitle: paper.paperTitle || paper.title || '',
        year: paperYear
      });
    }
  }

  const registry = {
    contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
    methods,
    aliases: [...aliases.entries()].map(([alias, entries]) => ({
      alias,
      methodIds: unique(entries.map((entry) => entry.methodId))
    })),
    stubs: []
  };
  Object.defineProperties(registry, {
    aliasMap: { value: aliases, enumerable: false },
    methodsByPaperId: { value: methodsByPaperId, enumerable: false },
    methodById: { value: methodById, enumerable: false },
    paperTitleRecords: { value: paperTitleRecords, enumerable: false },
    stubById: { value: stubById, enumerable: false }
  });
  return registry;
}

function registerStub(registry, context = {}) {
  const name = cleanText(
    context.referenceTitleGuess
    || context.referenceRaw
    || [context.referenceLeadAuthorLastName, context.referenceYear].filter(Boolean).join(' ')
    || context.citationRaw
    || 'Unresolved cited method',
    160
  );
  const stubId = `method-stub:${stableHash(`${context.referenceId || ''}:${context.referenceRaw || ''}:${context.citationRaw || ''}:${name}`)}`;
  if (!registry.stubById.has(stubId)) {
    const stub = {
      stubId,
      methodName: name,
      aliases: unique([name, context.referenceTitleGuess, context.referenceLeadAuthorLastName].filter(Boolean)),
      year: context.referenceYear || null,
      referenceId: context.referenceId || null,
      referenceRaw: context.referenceRaw || '',
      citationRaw: context.citationRaw || '',
      resolutionStatus: 'stub-unresolved'
    };
    registry.stubById.set(stubId, stub);
    registry.stubs.push(stub);
  }
  return registry.stubById.get(stubId);
}

function findMentionedMethods(text, methods = []) {
  const matches = [];
  for (const method of methods) {
    const aliasHit = method.aliasKeys
      .filter((alias) => alias.length >= 3)
      .sort((left, right) => right.length - left.length)
      .find((alias) => normalizedIncludesPhrase(text, alias));
    if (aliasHit) {
      matches.push({
        ...method,
        matchedAlias: aliasHit,
        aliasMatchScore: Math.min(1, aliasHit.length / Math.max(1, normalizedKey(text).length))
      });
    }
  }
  return matches.sort((left, right) => (
    (right.matchedAlias?.length || 0) - (left.matchedAlias?.length || 0)
    || (right.confidence || 0) - (left.confidence || 0)
  ));
}

function resolveCitedPaper(context = {}, registry) {
  const candidates = unique([
    context.referenceTitleGuess,
    context.referenceRaw
  ].map(normalizedKey).filter(Boolean));
  if (!candidates.length) {
    return {
      status: 'reference-title-missing',
      paper: null,
      score: 0
    };
  }

  let best = null;
  for (const candidate of candidates) {
    for (const titleRecord of registry.paperTitleRecords) {
      if (!titleRecord.paperId) continue;
      let score = 0;
      if (candidate === titleRecord.key) {
        score = 1;
      } else if (candidate.includes(titleRecord.key) || titleRecord.key.includes(candidate)) {
        score = 0.9;
      } else {
        score = createTitleScore(candidate, titleRecord.key);
      }
      if (!best || score > best.score) {
        best = {
          status: score >= 0.72 ? 'resolved-paper' : 'low-title-score',
          paper: titleRecord,
          score
        };
      }
    }
  }

  if (!best || best.score < 0.72) {
    return {
      status: best?.status || 'unmatched-reference-title',
      paper: null,
      score: best?.score || 0
    };
  }
  return best;
}

function resolveSourceMethods(paper, context, registry) {
  const methods = registry.methodsByPaperId.get(paper.paperId) || [];
  if (!methods.length) return [];
  const mentioned = findMentionedMethods(context.citationContext || context.exactQuote, methods);
  return (mentioned.length ? mentioned : methods).slice(0, mentioned.length ? 2 : 1);
}

function resolveTargetMethods(paper, context, registry) {
  const citedPaper = resolveCitedPaper(context, registry);
  if (citedPaper.paper?.paperId && citedPaper.paper.paperId !== paper.paperId) {
    const citedMethods = registry.methodsByPaperId.get(citedPaper.paper.paperId) || [];
    if (citedMethods.length) {
      const mentioned = findMentionedMethods(context.citationContext || context.exactQuote, citedMethods);
      return {
        methods: (mentioned.length ? mentioned : citedMethods).slice(0, mentioned.length ? 2 : 1),
        stub: null,
        resolution: {
          status: 'resolved-paper-method',
          citedPaperId: citedPaper.paper.paperId,
          citedPaperTitle: citedPaper.paper.paperTitle,
          titleScore: Number(citedPaper.score.toFixed(3))
        }
      };
    }
  }

  const mentioned = findMentionedMethods(
    context.citationContext || context.exactQuote,
    registry.methods.filter((method) => method.paperId !== paper.paperId)
  ).slice(0, 2);
  if (mentioned.length) {
    return {
      methods: mentioned,
      stub: null,
      resolution: {
        status: 'resolved-alias-method',
        citedPaperId: mentioned[0].paperId || null,
        citedPaperTitle: mentioned[0].paperTitle || '',
        titleScore: Number(citedPaper.score.toFixed(3))
      }
    };
  }

  return {
    methods: [],
    stub: registerStub(registry, context),
    resolution: {
      status: citedPaper.status === 'resolved-paper' ? 'resolved-paper-without-method' : 'stub-unresolved',
      citedPaperId: citedPaper.paper?.paperId || null,
      citedPaperTitle: citedPaper.paper?.paperTitle || '',
      titleScore: Number((citedPaper.score || 0).toFixed(3))
    }
  };
}

const SEMANTIC_RULES = [
  {
    edgeType: EDGE_TYPES.IMPROVES_METHOD,
    label: 'improves',
    confidence: 0.82,
    patterns: [
      /\b(improves?|improved|improving|enhances?|enhanced|outperforms?|addresses?|overcomes?|alleviates?|mitigates?|reduces?|solves?)\b/i
    ]
  },
  {
    edgeType: EDGE_TYPES.REPLACES_METHOD,
    label: 'replaces',
    confidence: 0.78,
    patterns: [
      /\b(replaces?|replaced|substitutes?|instead of|dispenses? with|removes?|eliminates?|without relying on)\b/i
    ]
  },
  {
    edgeType: EDGE_TYPES.ADAPTS_METHOD,
    label: 'adapts',
    confidence: 0.74,
    patterns: [
      /\b(adapts?|adapted|modifies?|modified|transfers?|repurposes?|recontextualizes?|applies?)\b/i
    ]
  },
  {
    edgeType: EDGE_TYPES.USES_COMPONENT_METHOD,
    label: 'uses-component',
    confidence: 0.7,
    patterns: [
      /\b(uses?|using|incorporates?|combines?|integrates?|employs?|component|module|backbone|encoder|decoder|attention mechanism)\b/i
    ]
  },
  {
    edgeType: EDGE_TYPES.EXTENDS_METHOD,
    label: 'extends',
    confidence: 0.68,
    patterns: [
      /\b(extends?|extended|builds? on|based on|derived from|follows?|generalizes?|inherits?|leverages?)\b/i
    ]
  }
];

export function classifyCitationSemantics(text = '') {
  const cleaned = cleanText(text, 1200);
  for (const rule of SEMANTIC_RULES) {
    for (const pattern of rule.patterns) {
      const match = cleaned.match(pattern);
      if (!match) continue;
      return {
        edgeType: rule.edgeType,
        label: rule.label,
        trigger: match[0],
        confidence: rule.confidence,
        reason: 'citation-context-verb'
      };
    }
  }

  return {
    edgeType: null,
    label: 'unclassified',
    trigger: '',
    confidence: 0,
    reason: 'no-method-evolution-semantics'
  };
}

function inferBottleneck(text = '') {
  const normalized = normalizeText(text);
  if (/\b(recurr\w*|sequential|parallel)\b/.test(normalized)) {
    return {
      dimension: 'parallelization',
      description: 'Prior recurrent or sequential formulation limited parallel execution.'
    };
  }
  if (/\b(scale|scaling|large|long context|context length)\b/.test(normalized)) {
    return {
      dimension: 'scalability',
      description: 'Prior method left scaling or long-context pressure unresolved.'
    };
  }
  if (/\b(data|sample|label|annotation)\b/.test(normalized)) {
    return {
      dimension: 'data-efficiency',
      description: 'Prior method depended on scarce data, labels, or samples.'
    };
  }
  if (/\b(cost|compute|memory|latency|efficient)\b/.test(normalized)) {
    return {
      dimension: 'efficiency',
      description: 'Prior method exposed compute, memory, latency, or cost pressure.'
    };
  }
  if (/\b(robust|noise|bias|failure|error)\b/.test(normalized)) {
    return {
      dimension: 'robustness',
      description: 'Prior method left robustness, noise, bias, or failure-mode pressure.'
    };
  }
  return {
    dimension: 'method-bottleneck',
    description: cleanText(text, 220)
  };
}

function inferTradeoff(text = '') {
  const normalized = normalizeText(text);
  if (/\b(memory|context length|quadratic)\b/.test(normalized)) {
    return {
      dimension: 'memory-cost',
      description: 'The evolution may increase memory pressure or context-length cost.'
    };
  }
  if (/\b(compute|expensive|cost|latency|slow)\b/.test(normalized)) {
    return {
      dimension: 'compute-cost',
      description: 'The evolution may trade improved capability for higher compute or latency.'
    };
  }
  if (/\b(complex|complexity|parameter|architecture)\b/.test(normalized)) {
    return {
      dimension: 'implementation-complexity',
      description: 'The evolution may add implementation or architectural complexity.'
    };
  }
  return {
    dimension: 'unspecified-tradeoff',
    description: ''
  };
}

function inferMechanism(classification, text = '') {
  const type = {
    [EDGE_TYPES.IMPROVES_METHOD]: 'bottleneck-mitigation',
    [EDGE_TYPES.REPLACES_METHOD]: 'component-replacement',
    [EDGE_TYPES.ADAPTS_METHOD]: 'domain-adaptation',
    [EDGE_TYPES.USES_COMPONENT_METHOD]: 'component-reuse',
    [EDGE_TYPES.EXTENDS_METHOD]: 'lineage-extension'
  }[classification.edgeType] || 'method-evolution';

  return {
    dimension: type,
    description: cleanText(`Trigger "${classification.trigger}" in: ${text}`, 260)
  };
}

function temporalDirection(sourceYear, targetYear) {
  if (!sourceYear || !targetYear) return 'unknown';
  if (sourceYear < targetYear) return 'reverse';
  if (sourceYear === targetYear) return 'same-year';
  return 'source-after-target';
}

function validateMethodEvolutionCandidate(candidate = {}) {
  const reasons = [];
  if (!candidate.sourceMethodId) reasons.push('missing_source_method');
  if (!candidate.targetMethodId) reasons.push('missing_target_method');
  if (candidate.targetStubId) reasons.push('target_method_stub');
  if (!candidate.edgeType) reasons.push('missing_method_evolution_type');
  if (!candidate.exactQuote) reasons.push('missing_exact_quote');
  if (!candidate.citationContext) reasons.push('missing_citation_context');
  if (candidate.exactQuote && candidate.citationContext && !candidate.citationContext.includes(candidate.exactQuote)) {
    reasons.push('quote_not_exact_match');
  }
  if (Number(candidate.semanticConfidence || 0) < MIN_SEMANTIC_CONFIDENCE) {
    reasons.push('low_semantic_confidence');
  }
  if (candidate.temporalDirection === 'unknown') reasons.push('missing_temporal_year');
  if (candidate.temporalDirection === 'reverse') reasons.push('reverse_temporal_direction');

  if (reasons.length) {
    return {
      validationStatus: 'candidate',
      validationReasons: reasons
    };
  }

  const authoritative = candidate.resolutionStatus === 'resolved-paper-method'
    && Number(candidate.semanticConfidence || 0) >= AUTHORITATIVE_SEMANTIC_CONFIDENCE;
  return {
    validationStatus: authoritative ? 'authoritative' : 'validated',
    validationReasons: []
  };
}

function buildCandidate({ paper, context, sourceMethod, targetMethod, targetStub, classification, resolution }) {
  const quote = cleanText(context.exactQuote || context.citationContext, 720);
  const targetYear = targetMethod?.year || targetStub?.year || context.referenceYear || null;
  const sourceYear = sourceMethod?.year || inferPaperYear(paper);
  const candidate = {
    id: `method-evolution-candidate:${stableHash(`${paper.paperId}:${sourceMethod?.methodId || ''}:${targetMethod?.methodId || targetStub?.stubId || ''}:${classification.edgeType || ''}:${quote}`)}`,
    contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
    edgeType: classification.edgeType,
    methodEvolutionType: classification.edgeType,
    sourceMethodId: sourceMethod?.methodId || null,
    sourceMethodName: sourceMethod?.methodName || '',
    targetMethodId: targetMethod?.methodId || null,
    targetMethodName: targetMethod?.methodName || targetStub?.methodName || '',
    targetStubId: targetStub?.stubId || null,
    sourcePaperId: paper.paperId || null,
    sourcePaperTitle: paper.paperTitle || paper.title || '',
    targetPaperId: targetMethod?.paperId || resolution?.citedPaperId || null,
    targetPaperTitle: targetMethod?.paperTitle || resolution?.citedPaperTitle || '',
    sourceYear,
    targetYear,
    temporalDirection: temporalDirection(sourceYear, targetYear),
    citationContext: quote,
    exactQuote: quote,
    exactMatch: Boolean(quote),
    citationRaw: context.citationRaw || '',
    citationStyle: context.citationStyle || '',
    citationContextId: context.id || null,
    referenceId: context.referenceId || null,
    referenceRaw: context.referenceRaw || '',
    referenceTitleGuess: context.referenceTitleGuess || '',
    referenceYear: context.referenceYear || null,
    referenceLeadAuthorLastName: context.referenceLeadAuthorLastName || '',
    sectionHeading: context.sectionHeading || '',
    sectionRole: context.sectionRole || '',
    sourceSpanId: context.chunkId || context.sourceSpanId || null,
    semantics: {
      label: classification.label,
      trigger: classification.trigger,
      reason: classification.reason
    },
    semanticConfidence: classification.confidence,
    confidence: Number(Math.min(0.99, classification.confidence + (resolution?.status === 'resolved-paper-method' ? 0.08 : 0)).toFixed(3)),
    resolutionStatus: resolution?.status || 'unresolved',
    resolutionScore: resolution?.titleScore || 0,
    bottleneck: inferBottleneck(quote),
    mechanism: inferMechanism(classification, quote),
    tradeoff: inferTradeoff(quote)
  };
  return {
    ...candidate,
    ...validateMethodEvolutionCandidate(candidate)
  };
}

function candidateToRelationship(candidate) {
  return {
    id: `rel:${stableHash(`${candidate.sourceMethodId}:${candidate.edgeType}:${candidate.targetMethodId}:${candidate.id}:${candidate.validationStatus}`)}`,
    sourceId: candidate.sourceMethodId,
    targetId: candidate.targetMethodId,
    type: candidate.edgeType,
    properties: {
      methodEvolution: true,
      methodEvolutionType: candidate.methodEvolutionType,
      validationStatus: candidate.validationStatus,
      overlayLayer: 'method-evolution',
      relationSource: METHOD_EVOLUTION_RELATION_SOURCE,
      candidateId: candidate.id,
      confidence: candidate.confidence,
      semanticConfidence: candidate.semanticConfidence,
      exactQuote: candidate.exactQuote,
      evidenceQuote: candidate.exactQuote,
      exactMatch: candidate.exactMatch,
      citationContext: candidate.citationContext,
      citationRaw: candidate.citationRaw,
      citationStyle: candidate.citationStyle,
      citationContextId: candidate.citationContextId,
      referenceId: candidate.referenceId,
      referenceRaw: candidate.referenceRaw,
      referenceTitleGuess: candidate.referenceTitleGuess,
      referenceYear: candidate.referenceYear,
      sourcePaperId: candidate.sourcePaperId,
      sourcePaperTitle: candidate.sourcePaperTitle,
      paperId: candidate.sourcePaperId,
      paperTitle: candidate.sourcePaperTitle,
      targetPaperId: candidate.targetPaperId,
      targetPaperTitle: candidate.targetPaperTitle,
      sourceMethodName: candidate.sourceMethodName,
      targetMethodName: candidate.targetMethodName,
      sourceYear: candidate.sourceYear,
      targetYear: candidate.targetYear,
      temporalDirection: candidate.temporalDirection,
      citationSemantics: candidate.semantics.label,
      citationTrigger: candidate.semantics.trigger,
      bottleneckDimension: candidate.bottleneck.dimension,
      bottleneckDescription: candidate.bottleneck.description,
      mechanismType: candidate.mechanism.dimension,
      mechanismDescription: candidate.mechanism.description,
      tradeoffDimension: candidate.tradeoff.dimension,
      tradeoffDescription: candidate.tradeoff.description,
      sectionHeading: candidate.sectionHeading,
      sectionRole: candidate.sectionRole,
      sourceSpanId: candidate.sourceSpanId
    }
  };
}

export function buildMethodEvolutionOverlay(papers = [], options = {}) {
  const diagnostics = {
    errors: [],
    warnings: [],
    candidateDiagnostics: [],
    citationFunnel: {
      paperCount: asArray(papers).length,
      methodCount: 0,
      citationContextCount: 0,
      classifiedContextCount: 0,
      candidateCount: 0,
      validatedCount: 0,
      authoritativeCount: 0,
      stubCount: 0
    }
  };

  try {
    const registry = buildMethodRegistry(papers);
    diagnostics.citationFunnel.methodCount = registry.methods.length;
    const candidates = [];
    const validated = [];
    const authoritative = [];

    for (const paper of asArray(papers)) {
      const extracted = Array.isArray(paper?.citationContexts)
        ? { contexts: paper.citationContexts, diagnostics: null }
        : extractCitationContextsFromPaper(paper);
      if (extracted.diagnostics?.errors?.length) {
        diagnostics.errors.push(...extracted.diagnostics.errors.map((entry) => ({
          ...entry,
          paperId: paper?.paperId || entry.paperId || null
        })));
      }

      for (const context of asArray(extracted.contexts)) {
        diagnostics.citationFunnel.citationContextCount += 1;
        try {
          const classification = classifyCitationSemantics(context.citationContext || context.exactQuote);
          if (!classification.edgeType) continue;
          diagnostics.citationFunnel.classifiedContextCount += 1;
          const sourceMethods = resolveSourceMethods(paper, context, registry);
          const targetResolution = resolveTargetMethods(paper, context, registry);
          const targetMethods = targetResolution.methods.length
            ? targetResolution.methods
            : [null];

          for (const sourceMethod of sourceMethods) {
            for (const targetMethod of targetMethods) {
              const candidate = buildCandidate({
                paper,
                context,
                sourceMethod,
                targetMethod,
                targetStub: targetMethod ? null : targetResolution.stub,
                classification,
                resolution: targetResolution.resolution
              });

              diagnostics.citationFunnel.candidateCount += 1;
              if (candidate.validationStatus === 'authoritative') {
                authoritative.push(candidate);
                diagnostics.citationFunnel.authoritativeCount += 1;
              } else if (candidate.validationStatus === 'validated') {
                validated.push(candidate);
                diagnostics.citationFunnel.validatedCount += 1;
              } else {
                candidates.push(candidate);
                diagnostics.candidateDiagnostics.push({
                  candidateId: candidate.id,
                  sourcePaperId: candidate.sourcePaperId,
                  sourceMethodName: candidate.sourceMethodName,
                  targetMethodName: candidate.targetMethodName,
                  targetStubId: candidate.targetStubId,
                  edgeType: candidate.edgeType,
                  validationReasons: candidate.validationReasons
                });
              }
            }
          }
        } catch (error) {
          diagnostics.errors.push({
            stage: 'method-evolution-candidate',
            paperId: paper?.paperId || null,
            contextId: context?.id || null,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    diagnostics.citationFunnel.stubCount = registry.stubs.length;

    return {
      contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
      generatedAt: options.generatedAt || new Date().toISOString(),
      source: METHOD_EVOLUTION_RELATION_SOURCE,
      registry,
      candidates,
      validated,
      authoritative,
      diagnostics
    };
  } catch (error) {
    diagnostics.errors.push({
      stage: 'method-evolution-overlay',
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
      generatedAt: options.generatedAt || new Date().toISOString(),
      source: METHOD_EVOLUTION_RELATION_SOURCE,
      registry: buildMethodRegistry([]),
      candidates: [],
      validated: [],
      authoritative: [],
      diagnostics
    };
  }
}

export function summarizeMethodEvolutionOverlay(overlay = {}, extra = {}) {
  return {
    contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
    source: overlay.source || METHOD_EVOLUTION_RELATION_SOURCE,
    methodCount: overlay.registry?.methods?.length || 0,
    aliasCount: overlay.registry?.aliases?.length || 0,
    stubCount: overlay.registry?.stubs?.length || 0,
    candidateCount: overlay.candidates?.length || 0,
    validatedCount: overlay.validated?.length || 0,
    authoritativeCount: overlay.authoritative?.length || 0,
    diagnosticsErrorCount: overlay.diagnostics?.errors?.length || 0,
    citationFunnel: overlay.diagnostics?.citationFunnel || {},
    ...extra
  };
}

function trimRecords(records = [], limit = 5000) {
  return asArray(records).slice(0, Math.max(0, limit));
}

export function compactMethodEvolutionOverlayForPersistence(overlay = {}, options = {}) {
  const maxMethods = Number.isFinite(Number(options.maxMethods)) ? Number(options.maxMethods) : 5000;
  const maxAliases = Number.isFinite(Number(options.maxAliases)) ? Number(options.maxAliases) : 5000;
  const maxCandidates = Number.isFinite(Number(options.maxCandidates)) ? Number(options.maxCandidates) : 5000;
  const maxValidated = Number.isFinite(Number(options.maxValidated)) ? Number(options.maxValidated) : 5000;
  const maxAuthoritative = Number.isFinite(Number(options.maxAuthoritative)) ? Number(options.maxAuthoritative) : 5000;

  return {
    contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
    generatedAt: overlay.generatedAt || null,
    source: overlay.source || METHOD_EVOLUTION_RELATION_SOURCE,
    summary: summarizeMethodEvolutionOverlay(overlay),
    registry: {
      contractVersion: METHOD_EVOLUTION_OVERLAY_CONTRACT_VERSION,
      methods: trimRecords(overlay.registry?.methods, maxMethods),
      aliases: trimRecords(overlay.registry?.aliases, maxAliases),
      stubs: trimRecords(overlay.registry?.stubs, maxMethods)
    },
    candidates: trimRecords(overlay.candidates, maxCandidates),
    validated: trimRecords(overlay.validated, maxValidated),
    authoritative: trimRecords(overlay.authoritative, maxAuthoritative),
    diagnostics: {
      ...(overlay.diagnostics || {}),
      persistedLimits: {
        maxMethods,
        maxAliases,
        maxCandidates,
        maxValidated,
        maxAuthoritative
      }
    }
  };
}

export function createMethodEvolutionRelationships(overlay = {}) {
  const diagnostics = {
    skipped: []
  };
  const records = [
    ...asArray(overlay.validated),
    ...asArray(overlay.authoritative)
  ];
  const relationships = [];
  const nodeYearUpdates = new Map();

  for (const candidate of records) {
    if (!candidate.sourceMethodId || !candidate.targetMethodId || !candidate.edgeType) {
      diagnostics.skipped.push({
        candidateId: candidate.id,
        reason: 'missing_relationship_endpoint'
      });
      continue;
    }
    relationships.push(candidateToRelationship(candidate));
    for (const [nodeId, year] of [
      [candidate.sourceMethodId, candidate.sourceYear],
      [candidate.targetMethodId, candidate.targetYear]
    ]) {
      if (nodeId && year && !nodeYearUpdates.has(nodeId)) {
        nodeYearUpdates.set(nodeId, year);
      }
    }
  }

  return {
    relationships,
    nodeYearUpdates,
    diagnostics
  };
}

export function applyMethodEvolutionOverlayToGraph(graph, overlay = {}) {
  const projection = createMethodEvolutionRelationships(overlay);
  let relationshipCount = 0;
  let nodeYearUpdateCount = 0;
  const skipped = [...projection.diagnostics.skipped];

  for (const [nodeId, year] of projection.nodeYearUpdates.entries()) {
    const node = graph.getNode(nodeId);
    if (!node) {
      skipped.push({ nodeId, reason: 'year_update_missing_node' });
      continue;
    }
    if (!node.properties?.year && !node.properties?.publicationYear && !node.properties?.introducedYear) {
      graph.updateNode({
        ...node,
        properties: {
          ...(node.properties || {}),
          introducedYear: year,
          publicationYear: year
        }
      });
      nodeYearUpdateCount += 1;
    }
  }

  for (const relationship of projection.relationships) {
    if (!graph.getNode(relationship.sourceId) || !graph.getNode(relationship.targetId)) {
      skipped.push({
        relationshipId: relationship.id,
        candidateId: relationship.properties?.candidateId,
        reason: 'relationship_endpoint_missing'
      });
      continue;
    }
    graph.addRelationship(relationship);
    relationshipCount += 1;
  }

  return {
    relationshipCount,
    nodeYearUpdateCount,
    skipped
  };
}

export const __methodEvolutionOverlayTestables = {
  methodNodeId,
  temporalDirection,
  validateMethodEvolutionCandidate
};
