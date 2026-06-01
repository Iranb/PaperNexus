import { buildLiteratureDiscoveryPlan } from './query-planner.js';
import { buildLlmAugmentedLiteratureDiscoveryPlan } from './llm-query-planner.js';
import {
  DEFAULT_DISCOVERY_PROVIDERS,
  executeProviderQueries,
  normalizeDiscoveryProviders,
  resolveDiscoveryConfig
} from './providers.js';
import { mergeDiscoveryCandidates } from './merge.js';
import {
  createDiscoverySupplementationInterface,
  resolveDiscoverySources
} from './source-resolution.js';
import { createDiscoveryRunId, saveDiscoveryRun } from './store.js';
import { expandDiscoveryCitations } from './citation-expansion.js';
import { extractResearchEntitiesFromText } from './entities.js';
import { createPaperIdentity, normalizePaperIdentifiers } from '../../lib/paper-identifiers.js';
import { stableHash, unique } from '../../lib/utils.js';
import { sortPaperRecordsByPublicationDateDesc } from '../paper-date.js';

function countStrongIdentity(candidates = []) {
  return candidates.filter((candidate) => candidate.identityConfidence === 'strong').length;
}

function defaultProvidersForPlan(plan = {}, params = {}) {
  const providers = [...DEFAULT_DISCOVERY_PROVIDERS];
  if (plan.discipline === 'computer-science') providers.push('dblp');
  if (plan.discipline === 'biomedicine') providers.push('europe_pmc');
  if (params.coreApiKey || process.env.CORE_API_KEY) providers.push('core');
  return normalizeDiscoveryProviders(providers);
}

function buildCoverage(run = {}) {
  const queryResults = run.queryResults || [];
  const candidates = run.candidates || [];
  const candidateCount = run.rawCandidateCount || 0;
  const mergedPaperCount = candidates.length;
  const strongIdentityCount = countStrongIdentity(candidates);
  const resolvedFullTextCount = candidates.filter((candidate) => candidate.source?.resolutionStatus === 'fulltext_ready').length;
  const metadataOnlyCount = candidates.filter((candidate) => candidate.source?.resolutionStatus !== 'fulltext_ready').length;
  const importedCount = candidates.filter((candidate) => candidate.import?.status === 'submitted' || candidate.import?.status === 'deduped').length;
  const providerFailures = queryResults.filter((entry) => !entry.ok);
  const providerFamilies = new Set(queryResults.filter((entry) => entry.ok && entry.count > 0).map((entry) => entry.provider));
  const expandedQueries = new Set(queryResults.filter((entry) => entry.ok && entry.family !== 'direct').map((entry) => entry.queryId));
  const citationExpansion = run.citationExpansion || {};
  let verdict = 'weak';

  if (providerFamilies.size >= 2 && strongIdentityCount >= Math.ceil(Math.max(1, mergedPaperCount) * 0.5)) {
    verdict = 'usable';
  }
  if (providerFamilies.size >= 3 && expandedQueries.size > 0 && metadataOnlyCount + resolvedFullTextCount === mergedPaperCount) {
    verdict = 'strong';
  }

  return {
    candidateCount,
    mergedPaperCount,
    strongIdentityCount,
    resolvedFullTextCount,
    metadataOnlyCount,
    importedCount,
    providerFailureSummary: providerFailures.map((entry) => ({
      provider: entry.provider,
      queryId: entry.queryId,
      reason: entry.reason
    })),
    providerAgreementDistribution: candidates.reduce((acc, candidate) => {
      const key = String(candidate.providerAgreementCount || 0);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    queryCoverage: queryResults.map((entry) => ({
      provider: entry.provider,
      queryId: entry.queryId,
      family: entry.family,
      ok: entry.ok,
      count: entry.count || 0,
      reason: entry.reason || ''
    })),
    citationExpansionCoverage: {
      seeds: citationExpansion.seeds || 0,
      addedCandidates: citationExpansion.addedCandidates || 0,
      failedSeeds: citationExpansion.failedSeeds || 0
    },
    verdict
  };
}

function shouldExpandCitations(params = {}, plan = {}) {
  if (params.citationExpansion !== undefined) return Boolean(params.citationExpansion);
  if (params.citation_expansion !== undefined) return Boolean(params.citation_expansion);
  return plan.depth === 'deep';
}

function resolveMaxCandidates(params = {}, plan = {}) {
  const requested = params.maxCandidates || params.max_candidates;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    return requested;
  }
  if (plan.depth === 'deep') return 3000;
  if (plan.depth === 'quick') return 80;
  return 240;
}

const SEARCH_EXECUTION_PROFILES = {
  quick: {
    budgetMs: 25000,
    maxQueries: 4,
    maxQueriesPerProvider: 2,
    timeoutMs: 5000,
    retryCount: 0
  },
  balanced: {
    budgetMs: 45000,
    maxQueries: 6,
    maxQueriesPerProvider: 3,
    timeoutMs: 6000,
    retryCount: 0
  },
  deep: {
    budgetMs: 10 * 60 * 1000,
    maxQueries: 10,
    maxQueriesPerProvider: 3,
    timeoutMs: 8000,
    retryCount: 0
  }
};

function normalizeDiscoveryOperation(value = '') {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function firstConfigured(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

function resolveDiscoveryOperation(params = {}) {
  return normalizeDiscoveryOperation(params.discoveryOperation || params.discovery_operation || params.operation);
}

function resolveDiscoverySearchMode(params = {}, operation = '') {
  if (operation !== 'search') return '';
  const explicit = String(params.searchMode || params.search_mode || '').trim().toLowerCase();
  if (explicit === 'quick') return 'quick';
  if (explicit === 'balanced' || explicit === 'default') return 'balanced';
  if (explicit === 'deep' || explicit === 'full') return 'deep';
  const depth = String(params.depth || '').trim().toLowerCase();
  if (depth === 'quick') return 'quick';
  if (depth === 'deep') return 'deep';
  return 'balanced';
}

function searchProfile(searchMode = '') {
  return SEARCH_EXECUTION_PROFILES[searchMode] || null;
}

function applySearchPlanningDefaults(params = {}, operation = '', searchMode = '') {
  const profile = searchProfile(searchMode);
  if (operation !== 'search' || !profile) return params;
  return {
    ...params,
    operation,
    discoveryOperation: operation,
    searchMode
  };
}

function capPlanQueriesForSearch(plan = {}, params = {}, operation = '', searchMode = '') {
  const profile = searchProfile(searchMode);
  if (operation !== 'search' || !profile) {
    return {
      plan,
      diagnostics: {
        applied: false
      }
    };
  }
  const limit = toPositiveIntegerOrNull(firstConfigured(
    params.maxQueries,
    params.max_queries,
    profile.maxQueries
  )) || profile.maxQueries;
  const queries = Array.isArray(plan.queries) ? plan.queries : [];
  if (queries.length <= limit) {
    return {
      plan,
      diagnostics: {
        applied: true,
        maxQueries: limit,
        originalQueryCount: queries.length,
        finalQueryCount: queries.length,
        truncated: false
      }
    };
  }
  return {
    plan: {
      ...plan,
      queries: queries.slice(0, limit),
      queryLimit: {
        mode: searchMode,
        maxQueries: limit,
        originalQueryCount: queries.length,
        truncated: true
      }
    },
    diagnostics: {
      applied: true,
      maxQueries: limit,
      originalQueryCount: queries.length,
      finalQueryCount: limit,
      truncated: true,
      skippedQueries: queries.slice(limit).map((query) => ({
        queryId: query.id,
        family: query.family,
        reason: 'search_query_limit'
      }))
    }
  };
}

function createDiscoveryBudget(params = {}, operation = '', searchMode = '') {
  const profile = searchProfile(searchMode);
  const explicitBudget = firstConfigured(
    params.searchBudgetMs,
    params.search_budget_ms,
    params.discoveryBudgetMs,
    params.discovery_budget_ms,
    params.budgetMs,
    params.budget_ms
  );
  const budgetMs = toPositiveIntegerOrNull(explicitBudget)
    || (operation === 'search' && profile ? profile.budgetMs : null);
  if (!budgetMs) return null;
  const startedAt = Date.now();
  return {
    startedAt,
    deadlineAt: startedAt + budgetMs,
    budgetMs,
    operation: operation || 'run',
    searchMode: searchMode || '',
    returnPartial: true
  };
}

function applySearchExecutionDefaults(params = {}, operation = '', searchMode = '', budget = null) {
  const profile = searchProfile(searchMode);
  if (operation !== 'search' || !profile) {
    return budget ? {
      ...params,
      budget,
      returnPartial: params.returnPartial ?? params.return_partial ?? true
    } : params;
  }
  return {
    ...params,
    operation,
    discoveryOperation: operation,
    searchMode,
    budget,
    timeoutMs: firstConfigured(params.timeoutMs, params.timeout_ms, profile.timeoutMs),
    retryCount: firstConfigured(params.retryCount, params.retry_count, profile.retryCount),
    maxQueriesPerProvider: firstConfigured(
      params.maxQueriesPerProvider,
      params.max_queries_per_provider,
      profile.maxQueriesPerProvider
    ),
    minProviderQueryBudgetMs: firstConfigured(
      params.minProviderQueryBudgetMs,
      params.min_provider_query_budget_ms,
      Math.min(profile.timeoutMs, 1000)
    ),
    returnPartial: params.returnPartial ?? params.return_partial ?? true,
    skipRemainingProviderQueriesOnRateLimit: params.skipRemainingProviderQueriesOnRateLimit
      ?? params.skip_remaining_provider_queries_on_rate_limit
      ?? true,
    discoveryRequestCache: params.discoveryRequestCache ?? params.discovery_request_cache ?? true,
    discoveryRequestCacheTtlMs: firstConfigured(
      params.discoveryRequestCacheTtlMs,
      params.discovery_request_cache_ttl_ms,
      15 * 60 * 1000
    ),
    discoveryCircuitBreakerFailureThreshold: firstConfigured(
      params.discoveryCircuitBreakerFailureThreshold,
      params.discovery_circuit_breaker_failure_threshold,
      1
    ),
    discoveryCircuitBreakerCooldownMs: firstConfigured(
      params.discoveryCircuitBreakerCooldownMs,
      params.discovery_circuit_breaker_cooldown_ms,
      5 * 60 * 1000
    )
  };
}

function buildDiscoveryDiagnostics({
  plan = {},
  planLimitDiagnostics = {},
  providerResult = {},
  budget = null,
  operation = '',
  searchMode = ''
} = {}) {
  const providerDiagnostics = providerResult.diagnostics?.providers || [];
  const warnings = [];
  if (planLimitDiagnostics.truncated) warnings.push('search-query-limit-applied');
  if (providerResult.partial) warnings.push('provider-results-partial');
  if (providerResult.budget?.budgetExhausted) warnings.push('search-budget-exhausted');
  if (plan.queryPlanner?.reason) warnings.push(`query-planner:${plan.queryPlanner.reason}`);
  return {
    operation: operation || 'run',
    searchMode: searchMode || '',
    planning: {
      ...(plan.queryPlanner || {}),
      queryLimit: planLimitDiagnostics
    },
    providers: providerDiagnostics,
    budget: providerResult.budget || (budget ? {
      ...budget,
      elapsedMs: Date.now() - budget.startedAt,
      remainingMs: Math.max(0, budget.deadlineAt - Date.now()),
      budgetExhausted: false
    } : null),
    skipped: [
      ...(planLimitDiagnostics.skippedQueries || []),
      ...providerDiagnostics.flatMap((entry) => (
        entry.skippedQueries > 0
          ? [{
              provider: entry.provider,
              skippedQueries: entry.skippedQueries,
              reason: entry.truncationReason || 'skipped'
            }]
          : []
      ))
    ],
    warnings
  };
}

async function emitDiscoveryProgress(params = {}, update = {}) {
  if (typeof params.onProgress !== 'function') return;
  try {
    await params.onProgress({
      runId: params.runId,
      topic: params.topic || params.query || '',
      operation: resolveDiscoveryOperation(params) || 'run',
      searchMode: params.searchMode || params.search_mode || '',
      status: 'running',
      updatedAt: new Date().toISOString(),
      ...update
    });
  } catch {
    // Progress reporting must not fail the discovery run itself.
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function collectSourceIndexSeedPapers(sourceIndex = null) {
  const sourceIndexRecord = asObject(sourceIndex);
  const candidateKeys = ['papers', 'entries', 'items', 'sources', 'canonical_papers', 'canonicalPapers'];
  for (const key of candidateKeys) {
    if (Array.isArray(sourceIndexRecord[key])) return sourceIndexRecord[key];
  }
  return [];
}

function collectSeedPaperInputs(params = {}) {
  return [
    ...asArray(params.seedPapers),
    ...asArray(params.seed_papers),
    ...asArray(params.knownPapers),
    ...asArray(params.known_papers),
    ...collectSourceIndexSeedPapers(params.sourceIndex || params.source_index)
  ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function collectSourceIndexSeedEntities(sourceIndex = null) {
  const sourceIndexRecord = asObject(sourceIndex);
  const candidateKeys = [
    'entities',
    'datasets',
    'benchmarks',
    'metrics',
    'tasks',
    'datasetMentions',
    'benchmarkMentions'
  ];
  return candidateKeys.flatMap((key) => asArray(sourceIndexRecord[key]));
}

function collectSourceIndexSeedTexts(sourceIndex = null) {
  const sourceIndexRecord = asObject(sourceIndex);
  return [
    ...asArray(sourceIndexRecord.texts),
    ...asArray(sourceIndexRecord.markdown),
    ...asArray(sourceIndexRecord.fullText),
    ...asArray(sourceIndexRecord.full_text),
    ...asArray(sourceIndexRecord.documents)
  ];
}

function normalizeSeedTextInput(seed = {}) {
  if (typeof seed === 'string') {
    return {
      text: seed,
      sourceTitle: ''
    };
  }
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return null;
  const text = compactText(pickFirst(seed.text, seed.content, seed.markdown, seed.abstract, seed.summary));
  if (!text) return null;
  return {
    text,
    sourceTitle: compactText(pickFirst(seed.sourceTitle, seed.source_title, seed.title, seed.paperTitle, seed.paper_title))
  };
}

function collectSeedTextInputs(params = {}) {
  return [
    ...asArray(params.seedTexts),
    ...asArray(params.seed_texts),
    ...asArray(params.sourceTexts),
    ...asArray(params.source_texts),
    ...collectSourceIndexSeedTexts(params.sourceIndex || params.source_index)
  ].map(normalizeSeedTextInput).filter(Boolean);
}

function collectTextSeedEntities(params = {}) {
  return collectSeedTextInputs(params).flatMap((entry) => extractResearchEntitiesFromText(entry.text, {
    sourceTitle: entry.sourceTitle,
    limit: params.maxExtractedEntities || params.max_extracted_entities || 80
  }));
}

function collectSeedEntityInputs(params = {}) {
  return [
    ...asArray(params.entitySeeds),
    ...asArray(params.entity_seeds),
    ...asArray(params.datasetSeeds),
    ...asArray(params.dataset_seeds),
    ...asArray(params.benchmarkSeeds),
    ...asArray(params.benchmark_seeds),
    ...collectSourceIndexSeedEntities(params.sourceIndex || params.source_index),
    ...collectTextSeedEntities(params)
  ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function identifiersFromCanonicalId(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized.includes(':')) return {};
  const [kind, ...rest] = normalized.split(':');
  const id = rest.join(':').trim();
  const key = kind.trim().toLowerCase();
  if (key === 'arxiv') return { arxivId: id };
  if (key === 'doi') return { doi: id };
  if (key === 'pmid') return { pmid: id };
  if (key === 'pmcid') return { pmcid: id };
  return {};
}

function normalizeSeedPaper(seed = {}, index = 0) {
  const identifiers = normalizePaperIdentifiers({
    ...identifiersFromCanonicalId(seed.canonicalId || seed.canonical_id || seed.id),
    ...asObject(seed.identifiers),
    ...seed
  });
  const title = compactText(pickFirst(seed.title, seed.paperTitle, seed.paper_title, seed.name));
  const identity = createPaperIdentity({
    identifiers,
    title
  });
  if (!identity.canonicalId && !title) return null;
  const sourceHints = unique([
    seed.markdownUrl,
    seed.markdown_url,
    seed.bestMarkdownUrl,
    seed.best_markdown_url,
    ...asArray(seed.markdownUrls),
    ...asArray(seed.markdown_urls),
    seed.pdfUrl,
    seed.pdf_url,
    seed.bestOaUrl,
    seed.best_oa_url,
    seed.landingPageUrl,
    seed.landing_page_url,
    ...asArray(seed.sourceHints),
    ...asArray(seed.source_hints),
    ...asArray(seed.fullTextUrls),
    ...asArray(seed.full_text_urls)
  ].map((entry) => String(entry || '').trim()).filter(Boolean));
  return {
    id: `client_seed:${stableHash(`${identity.canonicalId || title}:${index}`, 16)}`,
    provider: 'client_seed',
    title,
    authors: asArray(seed.authors).map((entry) => String(entry || '').trim()).filter(Boolean),
    year: Number.isFinite(Number(seed.year || seed.publication_year || seed.publicationYear))
      ? Number(seed.year || seed.publication_year || seed.publicationYear)
      : null,
    publicationDate: seed.publicationDate || seed.publication_date || null,
    venue: compactText(pickFirst(seed.venue, seed.conference, seed.journal, seed.container_title, seed.containerTitle)),
    venueFamily: compactText(pickFirst(seed.venueFamily, seed.venue_family)),
    venueType: compactText(pickFirst(seed.venueType, seed.venue_type)),
    venuePackHits: asArray(seed.venuePackHits || seed.venue_pack_hits).map((entry) => String(entry || '').trim()).filter(Boolean),
    venueAliasesMatched: asArray(seed.venueAliasesMatched || seed.venue_aliases_matched).map((entry) => String(entry || '').trim()).filter(Boolean),
    publicationType: compactText(pickFirst(seed.publicationType, seed.publication_type)),
    abstract: compactText(pickFirst(seed.abstract, seed.summary)),
    citationCount: Number.isFinite(Number(seed.citationCount || seed.citation_count))
      ? Number(seed.citationCount || seed.citation_count)
      : null,
    openAccessStatus: compactText(pickFirst(seed.openAccessStatus, seed.open_access_status)),
    license: compactText(seed.license),
    markdownUrl: compactText(pickFirst(seed.markdownUrl, seed.markdown_url, seed.bestMarkdownUrl, seed.best_markdown_url)),
    markdownUrls: unique([
      ...asArray(seed.markdownUrls),
      ...asArray(seed.markdown_urls)
    ].map((entry) => String(entry || '').trim()).filter(Boolean)),
    pdfUrl: compactText(pickFirst(seed.pdfUrl, seed.pdf_url)),
    bestOaUrl: compactText(pickFirst(seed.bestOaUrl, seed.best_oa_url)),
    landingPageUrl: compactText(pickFirst(seed.landingPageUrl, seed.landing_page_url)),
    fullTextUrls: sourceHints,
    sourceHints,
    retrievalEvidence: [{
      provider: 'client_seed',
      queryId: 'client-seed-input',
      query: title || identity.canonicalId,
      family: 'client_seed',
      providerId: identity.canonicalId || title
    }],
    rawSummary: 'Client-supplied seed paper.',
    ...identity
  };
}

function normalizeSeedEntity(seed = {}, index = 0) {
  const name = compactText(pickFirst(seed.name, seed.title, seed.label, seed.dataset, seed.benchmark, seed.metric, seed.task));
  if (!name) return null;
  const kind = compactText(pickFirst(seed.kind, seed.type, seed.entityType, seed.entity_type, 'entity')).toLowerCase();
  const context = compactText(pickFirst(seed.context, seed.evidenceText, seed.evidence_text, seed.description, seed.abstract));
  const sourceTitle = compactText(pickFirst(seed.sourceTitle, seed.source_title, seed.paperTitle, seed.paper_title));
  return {
    id: `entity_seed:${stableHash(`${kind}:${name}:${index}`, 16)}`,
    name,
    kind,
    context,
    sourceTitle
  };
}

function buildSeedEntityCandidates(params = {}) {
  const seen = new Set();
  const limit = Math.max(0, Math.floor(Number(params.maxSeedEntities || params.max_seed_entities || 80)));
  const entities = [];
  for (const seed of collectSeedEntityInputs(params)) {
    const entity = normalizeSeedEntity(seed, entities.length);
    if (!entity) continue;
    const key = `${entity.kind}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
    if (limit && entities.length >= limit) break;
  }
  return entities;
}

function buildSeedPaperCandidates(params = {}) {
  const seen = new Set();
  const limit = Math.max(0, Math.floor(Number(params.maxSeedPapers || params.max_seed_papers || 100)));
  const candidates = [];
  for (const seed of collectSeedPaperInputs(params)) {
    const candidate = normalizeSeedPaper(seed, candidates.length);
    if (!candidate) continue;
    const key = candidate.canonicalId || candidate.normalizedTitle || candidate.id;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (limit && candidates.length >= limit) break;
  }
  return candidates;
}

function buildSeedQuery(seed = {}) {
  return compactText(seed.title || seed.identifiers?.doi || seed.identifiers?.arxivId || seed.canonicalId || '');
}

function buildEntityQuery(entity = {}, plan = {}) {
  const topicTokens = compactText((plan.normalizedTopic || plan.topic || '').split(/\s+/).slice(0, 6).join(' '));
  const kind = /dataset|benchmark|metric|task/.test(entity.kind) ? entity.kind : 'research entity';
  return compactText([
    `"${entity.name}"`,
    kind,
    topicTokens
  ].filter(Boolean).join(' '));
}

function attachSeedQueries(plan = {}, seedCandidates = [], params = {}) {
  const maxSeedQueries = Math.max(0, Math.floor(Number(params.maxSeedQueries || params.max_seed_queries || 40)));
  if (!seedCandidates.length || maxSeedQueries === 0) return plan;
  const queries = [...(plan.queries || [])];
  const seen = new Set(queries.map((entry) => `${entry.family}:${String(entry.query || '').toLowerCase()}`));
  for (const seed of seedCandidates.slice(0, maxSeedQueries)) {
    const query = buildSeedQuery(seed);
    const key = `client_seed:${query.toLowerCase()}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push({
      id: `seed-${queries.length + 1}-${stableHash(key, 8)}`,
      query,
      family: 'client_seed',
      rationale: 'Resolve a client-supplied seed paper on the PaperNexus server.',
      discipline: plan.discipline,
      preferredVenuePacks: plan.preferredVenuePacks
    });
  }
  return {
    ...plan,
    queries
  };
}

function attachEntityQueries(plan = {}, seedEntities = [], params = {}) {
  const maxEntityQueries = Math.max(0, Math.floor(Number(params.maxEntityQueries || params.max_entity_queries || 40)));
  if (!seedEntities.length || maxEntityQueries === 0) return plan;
  const queries = [...(plan.queries || [])];
  const seen = new Set(queries.map((entry) => `${entry.family}:${String(entry.query || '').toLowerCase()}`));
  for (const entity of seedEntities.slice(0, maxEntityQueries)) {
    const query = buildEntityQuery(entity, plan);
    const key = `entity_seed:${query.toLowerCase()}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push({
      id: `entity-${queries.length + 1}-${stableHash(key, 8)}`,
      query,
      family: 'entity_seed',
      rationale: 'Resolve a dataset, benchmark, metric, task, or other extracted research entity.',
      discipline: plan.discipline,
      preferredVenuePacks: plan.preferredVenuePacks,
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        sourceTitle: entity.sourceTitle
      }
    });
  }
  return {
    ...plan,
    queries
  };
}

function compareDiscoveryCandidateFallback(left = {}, right = {}) {
  return Number(right.selectionScore || 0) - Number(left.selectionScore || 0)
    || Number(right.providerAgreementCount || 0) - Number(left.providerAgreementCount || 0)
    || Number(right.citationCount || 0) - Number(left.citationCount || 0)
    || String(left.title || '').localeCompare(String(right.title || ''));
}

function selectCandidateWindow(candidates = [], seedCandidates = [], maxCandidates = 120) {
  const limit = Math.max(1, Math.floor(Number(maxCandidates || 120)));
  const orderedCandidates = sortPaperRecordsByPublicationDateDesc(candidates, {
    fallbackCompare: compareDiscoveryCandidateFallback
  });
  const seedKeys = new Set(seedCandidates.flatMap((seed) => [
    seed.canonicalId,
    seed.normalizedTitle,
    seed.title,
    ...(seed.identityAliases || [])
  ]).filter(Boolean));
  const selected = [];
  const selectedKeys = new Set();

  for (const candidate of orderedCandidates) {
    const candidateKeys = [
      candidate.canonicalId,
      candidate.normalizedTitle,
      candidate.title,
      ...(candidate.identityAliases || [])
    ].filter(Boolean);
    const key = candidateKeys[0] || candidate.id;
    if (!candidateKeys.some((candidateKey) => seedKeys.has(candidateKey)) || selectedKeys.has(key)) continue;
    selected.push(candidate);
    selectedKeys.add(key);
    if (selected.length >= limit) return sortPaperRecordsByPublicationDateDesc(selected, {
      fallbackCompare: compareDiscoveryCandidateFallback
    });
  }
  for (const candidate of orderedCandidates) {
    const key = candidate.canonicalId || candidate.normalizedTitle || candidate.title || candidate.id;
    if (selectedKeys.has(key)) continue;
    selected.push(candidate);
    selectedKeys.add(key);
    if (selected.length >= limit) break;
  }
  return sortPaperRecordsByPublicationDateDesc(selected, {
    fallbackCompare: compareDiscoveryCandidateFallback
  });
}

function buildDiscoveryMetadataGraph(candidates = []) {
  const nodes = [];
  const relationships = [];
  const seenNodes = new Set();
  const seenRelationships = new Set();

  function addNode(node) {
    if (!node?.id || seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  }

  function addRelationship(relationship) {
    if (!relationship?.source || !relationship?.target || !relationship?.type) return;
    const key = `${relationship.source}|${relationship.type}|${relationship.target}`;
    if (seenRelationships.has(key)) return;
    seenRelationships.add(key);
    relationships.push(relationship);
  }

  for (const candidate of candidates) {
    const paperId = candidate.canonicalId || candidate.id || candidate.normalizedTitle || stableHash(candidate.title || JSON.stringify(candidate), 16);
    const source = candidate.source || {};
    const partial = source.resolutionStatus !== 'fulltext_ready';
    addNode({
      id: paperId,
      type: 'Paper',
      name: candidate.title || paperId,
      properties: {
        partial,
        resolutionStatus: source.resolutionStatus || 'metadata_only',
        sourceKind: source.sourceKind || 'metadata_only',
        fullTextStatus: source.fullTextStatus || 'unknown',
        title: candidate.title || '',
        authors: candidate.authors || [],
        year: candidate.year || null,
        venue: candidate.venue || '',
        abstract: candidate.abstract || '',
        identifiers: candidate.identifiers || {},
        canonicalId: candidate.canonicalId || '',
        supplementation: partial ? source.supplementation || null : null
      }
    });

    for (const provider of candidate.providers || [candidate.provider].filter(Boolean)) {
      const providerId = `provider:${provider}`;
      addNode({
        id: providerId,
        type: 'DiscoveryProvider',
        name: provider,
        properties: {
          provider
        }
      });
      addRelationship({
        source: providerId,
        target: paperId,
        type: 'DISCOVERED',
        properties: {
          evidenceCount: (candidate.retrievalEvidence || []).filter((entry) => entry.provider === provider).length || 1
        }
      });
    }
  }

  return {
    contractVersion: 'literature-discovery-metadata-graph-v1',
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
    partialPaperCount: nodes.filter((node) => node.type === 'Paper' && node.properties?.partial).length,
    nodes,
    relationships
  };
}

export async function runLiteratureDiscovery(params = {}) {
  const rootPath = params.rootPath;
  if (!rootPath) throw new Error('rootPath is required for literature discovery.');
  const generatedAt = new Date().toISOString();
  const runId = params.runId || createDiscoveryRunId(new Date(generatedAt));
  const operation = resolveDiscoveryOperation(params);
  const searchMode = resolveDiscoverySearchMode(params, operation);
  await emitDiscoveryProgress(params, {
    runId,
    stage: 'planning',
    status: 'running',
    startedAt: generatedAt,
    operation: operation || 'run',
    searchMode
  });
  const planningParams = applySearchPlanningDefaults(params, operation, searchMode);
  const seedCandidates = buildSeedPaperCandidates(params);
  const seedEntities = buildSeedEntityCandidates(params);
  const attachedPlan = attachEntityQueries(
    attachSeedQueries(await buildLiteratureDiscoveryRunPlan(planningParams), seedCandidates, planningParams),
    seedEntities,
    planningParams
  );
  const { plan, diagnostics: planLimitDiagnostics } = capPlanQueriesForSearch(
    attachedPlan,
    planningParams,
    operation,
    searchMode
  );
  const selectedProviders = params.providers
    ? normalizeDiscoveryProviders(params.providers)
    : defaultProvidersForPlan(plan, params);
  const budget = createDiscoveryBudget(params, operation, searchMode);
  await emitDiscoveryProgress(params, {
    runId,
    topic: plan.topic,
    stage: 'provider_search',
    status: 'running',
    operation: operation || 'run',
    searchMode,
    queryCount: (plan.queries || []).length,
    providers: selectedProviders,
    budget: budget ? {
      budgetMs: budget.budgetMs,
      deadlineAt: budget.deadlineAt,
      remainingMs: Math.max(0, budget.deadlineAt - Date.now())
    } : null
  });
  const executionParams = applySearchExecutionDefaults({
    ...params,
    providers: selectedProviders
  }, operation, searchMode, budget);
  const config = resolveDiscoveryConfig({
    ...executionParams,
    providers: selectedProviders
  });
  const providerResult = await executeProviderQueries({
    ...executionParams,
    ...config,
    budget,
    plan,
    onProgress: (progress) => emitDiscoveryProgress(params, {
      runId,
      topic: plan.topic,
      stage: 'provider_search',
      status: 'running',
      operation: operation || 'run',
      searchMode,
      ...progress
    })
  });
  await emitDiscoveryProgress(params, {
    runId,
    topic: plan.topic,
    stage: 'provider_search',
    status: 'running',
    event: 'provider_search_completed',
    rawCandidateCount: seedCandidates.length + providerResult.candidates.length,
    providerCandidateCount: providerResult.candidates.length,
    partial: providerResult.partial,
    budget: providerResult.budget || null
  });
  const initialMerged = mergeDiscoveryCandidates({
    topic: plan.topic,
    preferredVenuePacks: plan.preferredVenuePacks,
    candidates: [
      ...seedCandidates,
      ...providerResult.candidates
    ]
  });
  const maxCandidates = resolveMaxCandidates(params, plan);
  const initialWindow = selectCandidateWindow(initialMerged, seedCandidates, maxCandidates);
  const expandCitations = shouldExpandCitations(params, plan);
  if (expandCitations) {
    await emitDiscoveryProgress(params, {
      runId,
      topic: plan.topic,
      stage: 'citation_expansion',
      status: 'running',
      candidateCount: initialWindow.length
    });
  }
  const citationExpansion = expandCitations
    ? await expandDiscoveryCitations({
        ...config,
        candidates: initialWindow,
        maxCitationSeeds: params.maxCitationSeeds || params.max_citation_seeds,
        maxCitationsPerSeed: params.maxCitationsPerSeed || params.max_citations_per_seed,
        maxRelatedPerSeed: params.maxRelatedPerSeed || params.max_related_per_seed,
        openAlexRelatedExpansion: params.openAlexRelatedExpansion ?? params.openalexRelatedExpansion ?? params.openalex_related_expansion
      })
    : {
        candidates: [],
        queryResults: [],
        summary: {
          seeds: 0,
          addedCandidates: 0,
          failedSeeds: 0
        }
      };
  if (expandCitations) {
    await emitDiscoveryProgress(params, {
      runId,
      topic: plan.topic,
      stage: 'citation_expansion',
      status: 'running',
      event: 'citation_expansion_completed',
      citationExpansion: citationExpansion.summary
    });
  }
  const merged = mergeDiscoveryCandidates({
    topic: plan.topic,
    preferredVenuePacks: plan.preferredVenuePacks,
    candidates: [
      ...seedCandidates,
      ...providerResult.candidates,
      ...citationExpansion.candidates
    ]
  });
  const candidateWindow = selectCandidateWindow(merged, seedCandidates, maxCandidates);
  await emitDiscoveryProgress(params, {
    runId,
    topic: plan.topic,
    stage: 'source_resolution',
    status: 'running',
    candidateCount: candidateWindow.length,
    skipped: params.resolveSources === false
  });
  const resolution = params.resolveSources === false
    ? {
        candidates: candidateWindow.map((candidate) => ({
          ...candidate,
          source: {
            sourceKind: 'metadata_only',
            sourcePath: '',
            sourceProvider: '',
            contentSha256: '',
            sourceId: '',
            resolutionStatus: 'metadata_only',
            fullTextStatus: candidate.pdfUrl ? 'open_pdf' : 'unknown',
            downloadStatus: candidate.pdfUrl ? 'eligible' : 'skipped',
            downloadError: candidate.pdfUrl ? null : 'Source resolution was not requested.',
            localPdfPath: null,
            localMarkdownPath: null,
            pdfUrl: candidate.pdfUrl || '',
            markdownUrl: candidate.markdownUrl || candidate.markdownUrls?.[0] || '',
            resolutionAttempts: [],
            supplementation: createDiscoverySupplementationInterface(candidate, {
              resolutionStatus: 'metadata_only'
            })
          }
        })),
        summary: {
          total: candidateWindow.length,
          resolvedFullText: 0,
          metadataOnly: candidateWindow.length,
          downloaded: 0
        }
      }
    : await resolveDiscoverySources({
        ...params,
        rootPath,
        candidates: candidateWindow
      });
  const run = {
    contractVersion: 'literature-discovery-v1',
    runId,
    generatedAt,
    rootPath,
    topic: plan.topic,
    plan,
    providers: providerResult.providers,
    queryResults: [
      ...providerResult.queryResults,
      ...citationExpansion.queryResults
    ],
    rawCandidateCount: seedCandidates.length + providerResult.candidates.length + citationExpansion.candidates.length,
    candidates: resolution.candidates,
    resolutionSummary: resolution.summary,
    citationExpansion: citationExpansion.summary,
    accessPolicy: {
      openAccessFirst: true,
      unauthorizedBypassEnabled: false,
      institutionalAccessMode: params.institutionalAccessMode || 'hints-only'
    },
    seedSummary: {
      supplied: collectSeedPaperInputs(params).length,
      accepted: seedCandidates.length,
      queryCount: plan.queries.filter((entry) => entry.family === 'client_seed').length
    },
    entitySummary: {
      supplied: collectSeedEntityInputs(params).length,
      accepted: seedEntities.length,
      queryCount: plan.queries.filter((entry) => entry.family === 'entity_seed').length
    }
  };
  run.partial = Boolean(
    providerResult.partial
    || providerResult.budget?.budgetExhausted
    || planLimitDiagnostics.truncated
  );
  run.budget = providerResult.budget || null;
  run.diagnostics = buildDiscoveryDiagnostics({
    plan,
    planLimitDiagnostics,
    providerResult,
    budget,
    operation,
    searchMode
  });
  run.metadataGraph = buildDiscoveryMetadataGraph(run.candidates);
  run.coverage = buildCoverage(run);
  const saved = params.persist === false ? null : await saveDiscoveryRun(rootPath, run);
  const deferCompletedProgress = Boolean(params.deferCompletedProgress || params.defer_completed_progress);
  await emitDiscoveryProgress(params, {
    runId,
    topic: plan.topic,
    stage: deferCompletedProgress ? 'discovery_completed' : 'completed',
    status: deferCompletedProgress ? 'running' : 'completed',
    completedAt: deferCompletedProgress ? null : new Date().toISOString(),
    coverage: run.coverage,
    rawCandidateCount: run.rawCandidateCount,
    candidateCount: run.candidates.length,
    partial: run.partial,
    artifacts: saved ? {
      runJsonPath: saved.runJsonPath,
      reportPath: saved.reportPath,
      downloadManifestPath: saved.downloadManifestPath,
      latestPath: saved.latestPath
    } : null
  });
  return {
    ...run,
    artifacts: saved ? {
      runJsonPath: saved.runJsonPath,
      reportPath: saved.reportPath,
      downloadManifestPath: saved.downloadManifestPath,
      latestPath: saved.latestPath
    } : null
  };
}

export async function buildLiteratureDiscoveryRunPlan(params = {}) {
  return buildLlmAugmentedLiteratureDiscoveryPlan(params);
}

export { buildLiteratureDiscoveryPlan, buildCoverage, buildDiscoveryMetadataGraph };
