import { stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { inferVenuePacksFromTopic } from './venue-registry.js';

const DEPTH_QUERY_LIMITS = {
  quick: 6,
  default: 18,
  deep: 64
};

const SEMANTIC_SCHOLAR_PROVIDER = 'semantic_scholar';
const DEFAULT_CS_VENUE_BIAS = 'IEEE';
const TITLE_SCOPE_PROVIDERS = ['openalex', 'crossref', 'arxiv', 'dblp'];
const ABSTRACT_SCOPE_PROVIDERS = ['openalex', 'crossref', 'arxiv'];

const TERMINOLOGY_VARIANT_PAIRS = [
  ['category', 'class'],
  ['categories', 'classes'],
  ['class', 'category'],
  ['classes', 'categories']
];

const VENUE_HINTS = new Set([
  'aaai',
  'acl',
  'chi',
  'cikm',
  'coling',
  'corr',
  'cvpr',
  'eccv',
  'emnlp',
  'iccv',
  'icde',
  'iclr',
  'icml',
  'ijcai',
  'jair',
  'jmlr',
  'kdd',
  'naacl',
  'nature',
  'neurips',
  'nips',
  'pnas',
  'science',
  'sigir',
  'sigmod',
  'uist',
  'vldb',
  'www'
]);

function normalizeDepth(value = 'default') {
  const normalized = String(value || '').trim().toLowerCase();
  return DEPTH_QUERY_LIMITS[normalized] ? normalized : 'default';
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function quotePhrase(value = '') {
  const compact = compactText(value).replace(/"/g, '');
  return compact ? `"${compact}"` : '';
}

function isDisabledFlag(value) {
  return ['0', 'false', 'off', 'no'].includes(String(value || '').trim().toLowerCase());
}

function isEnabledFlag(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function inferDiscipline(topic = '') {
  const text = topic.toLowerCase();
  if (/\b(clinical|patient|disease|drug|trial|therapy|cancer|biomarker|genome|protein|pubmed|mesh)\b/.test(text)) {
    return 'biomedicine';
  }
  if (/\b(llm|language model|neural|learning|computer vision|vision-language|nlp|database|software|algorithm|benchmark|dataset|classification|segmentation|recognition|detection|clustering|embedding|transformer|self-supervised|contrastive|prompt|open[-\s]set|open[-\s]world|category discovery|class discovery)\b/.test(text)) {
    return 'computer-science';
  }
  if (/\b(quantum|astrophysics|cosmology|particle|hep|theorem|topology|algebra|geometry)\b/.test(text)) {
    return 'physics-math';
  }
  if (/\b(policy|economics|market|labor|education|survey|causal|regression|panel data)\b/.test(text)) {
    return 'economics-social-science';
  }
  if (/\b(catalyst|polymer|material|reaction|synthesis|molecule|compound|battery|electrolyte)\b/.test(text)) {
    return 'chemistry-materials';
  }
  if (/[\u4e00-\u9fff]/u.test(topic)) {
    return 'chinese-scholarship';
  }
  return 'general';
}

function replaceWholeTerm(value = '', source = '', target = '') {
  const pattern = new RegExp(`\\b${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return compactText(value.replace(pattern, (match) => (
    /^[A-Z]/.test(match)
      ? `${target[0].toUpperCase()}${target.slice(1)}`
      : target
  )));
}

function buildTerminologyVariantQueries(baseQuery = '') {
  const variants = [];
  const seen = new Set([baseQuery.toLowerCase()]);
  for (const [source, target] of TERMINOLOGY_VARIANT_PAIRS) {
    const next = replaceWholeTerm(baseQuery, source, target);
    const key = next.toLowerCase();
    if (!next || key === baseQuery.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    variants.push({
      query: next,
      family: 'terminology_variant',
      rationale: 'Search safe terminology variants for the same research concept.'
    });
  }
  return variants;
}

function buildOrthogonalStrategyQueries(topic = '', discipline = '') {
  if (discipline !== 'computer-science') return [];
  return [
    {
      query: topic,
      family: 'venue_bias',
      rationale: 'Search Semantic Scholar with an IEEE venue bias for computer-science literature.',
      providerAllowList: [SEMANTIC_SCHOLAR_PROVIDER],
      venue: DEFAULT_CS_VENUE_BIAS
    },
    {
      query: topic,
      family: 'discipline_bias',
      rationale: 'Search Semantic Scholar with a Computer Science field-of-study bias.',
      providerAllowList: [SEMANTIC_SCHOLAR_PROVIDER],
      semanticScholarFieldsOfStudy: ['Computer Science'],
      discipline: 'computer-science'
    },
  ];
}

function buildFieldScopedRetrievalQueries(topic = '', discipline = '') {
  if (discipline !== 'computer-science') return [];
  const queries = [
    {
      query: topic,
      family: 'title_scope',
      fieldScope: 'title',
      providerAllowList: TITLE_SCOPE_PROVIDERS,
      rationale: 'Search source-native title indexes for exact topical coverage.'
    },
    {
      query: topic,
      family: 'abstract_scope',
      fieldScope: 'abstract',
      providerAllowList: ABSTRACT_SCOPE_PROVIDERS,
      rationale: 'Search source-native abstract or bibliographic indexes for recall.'
    }
  ];

  return queries;
}

function buildAcronymQuery(topic = '', keywordQuery = '') {
  const tokens = unique(tokenizeWithoutStopwords(topic));
  if (tokens.length < 3 || tokens.length > 8) return null;
  const acronym = tokens.map((token) => token[0]).join('').toUpperCase();
  if (acronym.length < 3 || acronym.length > 10 || /\d/.test(acronym)) return null;
  return {
    query: `"${acronym}" ${keywordQuery || tokens.join(' ')}`,
    family: 'acronym_expansion',
    rationale: 'Search common acronym usage alongside the expanded topic terms.'
  };
}

function topicLooksLikeDiscoveryArea(topic = '') {
  const normalized = compactText(topic).toLowerCase().replace(/[-_/]+/g, ' ');
  return (
    /\b(category|categories|class|classes)\s+discovery\b/.test(normalized)
    || /\bnovel\s+(category|class)\b/.test(normalized)
    || /\bopen\s+(set|world)\s+recognition\b/.test(normalized)
  );
}

function buildDiscoveryNeighborhoodQueries(topic = '', keywordQuery = '', depth = 'default') {
  if (depth !== 'deep' || !topicLooksLikeDiscoveryArea(topic)) return [];
  const baseQuery = keywordQuery || compactText(topic);
  const topicalModifiers = [
    'catastrophic forgetting',
    'active learning',
    'continual learning',
    'prompt learning',
    'medical image',
    'semantic segmentation',
    'image text pairs',
    'domain adaptation',
    'distribution guidance'
  ];
  const adjacentQueries = [
    'novel class discovery',
    'open set recognition survey',
    'open world recognition',
    'open long tailed recognition',
    'few shot open set recognition',
    'visual category discovery benchmarks',
    'self-supervised visual representation learning',
    'contrastive self-supervised representation learning',
    'supervised contrastive learning',
    'semi supervised learning survey',
    'fine grained image analysis survey',
    'vision language prompt learning'
  ];

  return [
    ...topicalModifiers.map((modifier) => `${baseQuery} ${modifier}`),
    ...adjacentQueries
  ].map((query) => ({
    query,
    family: 'related_work_expansion',
    rationale: 'Search adjacent task, setting, and representation-learning neighborhoods for discovery literature.'
  }));
}

function collectQuotedPhrases(topic = '') {
  return unique([...String(topic || '').matchAll(/"([^"]{3,120})"|'([^']{3,120})'/g)]
    .map((match) => compactText(match[1] || match[2]))
    .filter(Boolean));
}

function collectYearHints(topic = '') {
  return unique([...String(topic || '').matchAll(/\b(?:19|20)\d{2}\b/g)]
    .map((match) => match[0]));
}

function collectVenueHints(topic = '') {
  const text = String(topic || '');
  const explicit = [...text.matchAll(/\b(?:at|in|from|venue|conference|journal|published\s+(?:at|in)|appeared\s+(?:at|in))\s+([A-Za-z][A-Za-z0-9&.-]{1,24})\b/gi)]
    .map((match) => match[1]);
  const uppercase = [...text.matchAll(/\b[A-Z][A-Z0-9&-]{2,12}\b/g)]
    .map((match) => match[0]);
  return unique([...explicit, ...uppercase]
    .map((entry) => compactText(entry).replace(/[.,;:]+$/g, ''))
    .filter((entry) => VENUE_HINTS.has(entry.toLowerCase()))
    .slice(0, 4));
}

function topicLooksLikeClueStyleQuery(topic = '') {
  const compact = compactText(topic);
  if (!compact) return false;
  const words = compact.split(/\s+/).length;
  if (words < 12 && !collectQuotedPhrases(compact).length) return false;
  return (
    /\b(find|identify|which|paper|article|work|published|appeared|venue|conference|journal|author|citation|cited|reference|benchmark|dataset|method|uses|using|with|task)\b/i.test(compact)
    || collectYearHints(compact).length > 0
    || collectVenueHints(compact).length > 0
  );
}

function extractMethodTaskTerms(topic = '') {
  const compact = compactText(topic);
  const fragments = [];
  for (const pattern of [
    /\b(?:using|uses|with|based on|method called)\s+([^.;,]{3,90})/gi,
    /\b(?:for|on|task of|benchmark(?:ed)? on|dataset)\s+([^.;,]{3,90})/gi
  ]) {
    for (const match of compact.matchAll(pattern)) {
      fragments.push(compactText(match[1]).split(/\s+/).slice(0, 8).join(' '));
    }
  }
  return unique(fragments.filter(Boolean)).slice(0, 3);
}

function buildClueStyleDecompositionQueries(topic = '', discipline = '', options = {}) {
  const explicit = options.queryDecomposition ?? options.query_decomposition;
  const enabled = explicit === undefined || explicit === null || explicit === ''
    ? topicLooksLikeClueStyleQuery(topic)
    : isEnabledFlag(explicit) || !isDisabledFlag(explicit);
  if (!enabled) return [];

  const tokens = unique(tokenizeWithoutStopwords(topic)).filter((token) => token.length > 2);
  const coreQuery = tokens.slice(0, 8).join(' ');
  const quotedPhrases = collectQuotedPhrases(topic);
  const years = collectYearHints(topic);
  const venues = collectVenueHints(topic);
  const methodTaskTerms = extractMethodTaskTerms(topic);
  const queries = [];

  if (quotedPhrases[0] || coreQuery) {
    const query = quotedPhrases[0] ? quotePhrase(quotedPhrases[0]) : coreQuery;
    queries.push({
      query,
      family: 'clue_entity',
      rationale: 'Search the highest-confidence entity or quoted phrase from a clue-style benchmark query.',
      providerAllowList: ['openalex', 'semantic_scholar', 'crossref', 'arxiv', 'dblp'],
      decomposition: {
        kind: 'entity',
        quotedPhrase: quotedPhrases[0] || null
      }
    });
  }

  if ((years.length || venues.length) && coreQuery) {
    queries.push({
      query: compactText([coreQuery.split(/\s+/).slice(0, 6).join(' '), ...venues, ...years].join(' ')),
      family: 'clue_venue_year',
      rationale: 'Search with venue and year clues separated from the original long query.',
      providerAllowList: ['openalex', 'semantic_scholar', 'crossref', 'dblp'],
      decomposition: {
        kind: 'venue_year',
        venues,
        years
      }
    });
  }

  for (const term of methodTaskTerms) {
    queries.push({
      query: compactText([term, discipline === 'computer-science' ? 'benchmark method' : 'research method'].join(' ')),
      family: 'clue_method_task',
      rationale: 'Search method, task, dataset, or benchmark clues as a separate retrieval route.',
      providerAllowList: ['openalex', 'semantic_scholar', 'crossref', 'arxiv'],
      decomposition: {
        kind: 'method_task',
        clue: term
      }
    });
  }

  if (/\b(cite|cites|cited|citation|reference|related work|survey)\b/i.test(topic) && coreQuery) {
    queries.push({
      query: `${coreQuery.split(/\s+/).slice(0, 6).join(' ')} citation related work`,
      family: 'clue_citation',
      rationale: 'Search citation and related-work clues separately from lexical topic terms.',
      providerAllowList: ['openalex', 'semantic_scholar'],
      decomposition: {
        kind: 'citation'
      }
    });
  }

  const seen = new Set();
  return queries.filter((entry) => {
    const key = `${entry.family}:${String(entry.query || '').toLowerCase()}`;
    if (!entry.query || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function buildExpansionQueries(topic, discipline, options = {}) {
  const tokens = unique(tokenizeWithoutStopwords(topic)).slice(0, 8);
  const compact = compactText(topic);
  const keywordQuery = tokens.length >= 2 ? tokens.join(' ') : compact;
  const expansions = [];

  if (keywordQuery && keywordQuery !== compact) {
    expansions.push({
      query: keywordQuery,
      family: 'keyword_core',
      rationale: 'Search normalized high-signal keywords from the topic.'
    });
  }

  if (compact.length <= 120) {
    expansions.push({
      query: quotePhrase(compact),
      family: 'exact_phrase',
      rationale: 'Search the exact topic phrase for precise matches.'
    });
  }

  expansions.push(...buildClueStyleDecompositionQueries(compact, discipline, options));

  expansions.push(...buildTerminologyVariantQueries(compact));
  const acronymQuery = buildAcronymQuery(compact, keywordQuery);
  if (acronymQuery) expansions.push(acronymQuery);

  if (discipline === 'computer-science') {
    expansions.push({
      query: `${keywordQuery || compact} benchmark dataset code`,
      family: 'artifact_expansion',
      rationale: 'Find papers tied to benchmarks, datasets, and code artifacts.'
    });
  } else if (discipline === 'biomedicine') {
    expansions.push({
      query: `${keywordQuery || compact} systematic review clinical trial`,
      family: 'evidence_type_expansion',
      rationale: 'Find review and clinical-study variants for biomedical topics.'
    });
  } else if (discipline === 'economics-social-science') {
    expansions.push({
      query: `${keywordQuery || compact} working paper causal evidence`,
      family: 'working_paper_expansion',
      rationale: 'Find working-paper and causal-evidence variants.'
    });
  }

  if (discipline !== 'biomedicine') {
    expansions.push({
      query: `${keywordQuery || compact} survey review`,
      family: 'review_expansion',
      rationale: 'Find reviews and surveys that expose terminology and baselines.'
    });
  }

  if (discipline === 'computer-science') {
    expansions.push(...buildDiscoveryNeighborhoodQueries(compact, keywordQuery, options.depth));
  }

  return expansions.filter((entry) => compactText(entry.query));
}

export function buildLiteratureDiscoveryPlan(params = {}) {
  const topic = compactText(params.topic);
  if (!topic) {
    throw new Error('topic is required for literature discovery.');
  }

  const depth = normalizeDepth(params.depth);
  const discipline = String(params.discipline || '').trim().toLowerCase() || inferDiscipline(topic);
  const preferredVenuePacks = inferVenuePacksFromTopic(topic);
  const maxQueries = Math.max(
    1,
    Math.floor(Number(params.maxQueries || DEPTH_QUERY_LIMITS[depth]) || DEPTH_QUERY_LIMITS[depth])
  );
  const candidates = [
    {
      query: topic,
      family: 'direct',
      rationale: 'Search the original user topic.'
    },
    ...buildOrthogonalStrategyQueries(topic, discipline),
    ...buildFieldScopedRetrievalQueries(topic, discipline),
    ...buildExpansionQueries(topic, discipline, {
      depth,
      queryDecomposition: params.queryDecomposition ?? params.query_decomposition
    })
  ];
  const seen = new Set();
  const queries = [];

  for (const candidate of candidates) {
    const query = compactText(candidate.query);
    const key = `${candidate.family}:${query.toLowerCase()}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    const plannedQuery = {
      id: `q${queries.length + 1}-${stableHash(key, 8)}`,
      query,
      family: candidate.family,
      rationale: candidate.rationale,
      discipline: candidate.discipline || discipline,
      preferredVenuePacks
    };
    if (Array.isArray(candidate.providerAllowList) && candidate.providerAllowList.length) {
      plannedQuery.providerAllowList = candidate.providerAllowList;
    }
    if (candidate.venue) plannedQuery.venue = compactText(candidate.venue);
    if (candidate.fieldScope) plannedQuery.fieldScope = compactText(candidate.fieldScope).toLowerCase();
    if (Array.isArray(candidate.semanticScholarFieldsOfStudy) && candidate.semanticScholarFieldsOfStudy.length) {
      plannedQuery.semanticScholarFieldsOfStudy = candidate.semanticScholarFieldsOfStudy;
    }
    if (candidate.decomposition) plannedQuery.decomposition = candidate.decomposition;
    queries.push(plannedQuery);
    if (queries.length >= maxQueries) break;
  }

  return {
    topic,
    normalizedTopic: topic.toLowerCase(),
    depth,
    discipline,
    preferredVenuePacks,
    queries
  };
}
