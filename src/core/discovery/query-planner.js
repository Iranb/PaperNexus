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
    ...buildExpansionQueries(topic, discipline, { depth })
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
