import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLiteratureDiscoveryPlan } from '../src/core/discovery/query-planner.js';
import { extractResearchEntitiesFromText } from '../src/core/discovery/entities.js';
import { expandDiscoveryCitations } from '../src/core/discovery/citation-expansion.js';
import { executeProviderQueries } from '../src/core/discovery/providers.js';
import { resetSemanticScholarRateLimitForTests } from '../src/core/discovery/s2-rate-limit.js';
import { mergeDiscoveryCandidates } from '../src/core/discovery/merge.js';
import { resolveDiscoverySources } from '../src/core/discovery/source-resolution.js';
import { buildLiteratureDiscoveryRunPlan, runLiteratureDiscovery } from '../src/core/discovery/workflow.js';
import { loadDiscoveryRun } from '../src/core/discovery/store.js';
import { handleMessage } from '../src/mcp/core.js';
import { createPaperIdentity } from '../src/lib/paper-identifiers.js';

const originalFetch = globalThis.fetch;

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    }
  };
}

function createTextResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return payload;
    }
  };
}

function createPdfResponse() {
  const buffer = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(800, 32),
    Buffer.from('\n%%EOF\n')
  ]);
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/pdf']]),
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

function createHtmlResponse() {
  const buffer = Buffer.from(`<html><body>HTML full text is available here.</body></html>${' '.repeat(800)}`);
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

async function createTempCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-literature-discovery-'));
  await fs.mkdir(path.join(rootPath, '.papernexus'), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, '.papernexus', 'meta.json'),
    JSON.stringify({ name: 'literature-discovery-test', paperCount: 0, nodeCount: 0, relationshipCount: 0 }, null, 2)
  );
  return rootPath;
}

function createDiscoveryCandidate(overrides = {}) {
  const identity = createPaperIdentity({
    title: overrides.title,
    identifiers: overrides.identifiers || {}
  });
  return {
    id: overrides.id || `${overrides.provider || 'test'}:${identity.canonicalId || identity.titleSignature}`,
    provider: overrides.provider || 'test',
    title: overrides.title || '',
    authors: overrides.authors || [],
    year: overrides.year || null,
    publicationDate: overrides.publicationDate || null,
    venue: overrides.venue || '',
    venueFamily: overrides.venueFamily || '',
    venueType: overrides.venueType || '',
    venuePackHits: overrides.venuePackHits || [],
    venueAliasesMatched: overrides.venueAliasesMatched || [],
    publicationType: overrides.publicationType || '',
    abstract: overrides.abstract || '',
    citationCount: overrides.citationCount || null,
    openAccessStatus: overrides.openAccessStatus || '',
    license: overrides.license || '',
    pdfUrl: overrides.pdfUrl || '',
    bestOaUrl: overrides.bestOaUrl || '',
    landingPageUrl: overrides.landingPageUrl || '',
    fullTextUrls: overrides.fullTextUrls || [],
    sourceHints: overrides.sourceHints || [],
    retrievalEvidence: overrides.retrievalEvidence || [],
    rawSummary: overrides.rawSummary || '',
    ...identity
  };
}

test('buildLiteratureDiscoveryPlan creates deterministic discipline-aware queries', () => {
  const plan = buildLiteratureDiscoveryPlan({
    topic: 'LLM agents for time series forecasting',
    depth: 'default'
  });

  assert.equal(plan.discipline, 'computer-science');
  assert.equal(plan.queries[0].family, 'direct');
  assert.ok(plan.queries.some((query) => (
    query.family === 'venue_bias'
    && query.venue === 'IEEE'
    && query.providerAllowList.includes('semantic_scholar')
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'discipline_bias'
    && query.semanticScholarFieldsOfStudy.includes('Computer Science')
    && query.providerAllowList.includes('semantic_scholar')
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'title_scope'
    && query.fieldScope === 'title'
    && query.providerAllowList.includes('openalex')
    && query.providerAllowList.includes('dblp')
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'abstract_scope'
    && query.fieldScope === 'abstract'
    && query.providerAllowList.includes('openalex')
    && !query.providerAllowList.includes('dblp')
  )));
  assert.ok(plan.queries.some((query) => query.family === 'artifact_expansion'));
  assert.ok(plan.queries.length <= 18);
});

test('buildLiteratureDiscoveryPlan adds topic-agnostic terminology and acronym expansions', () => {
  const plan = buildLiteratureDiscoveryPlan({
    topic: 'Generalized Category Discovery',
    depth: 'default'
  });

  assert.equal(plan.discipline, 'computer-science');
  assert.ok(plan.queries.some((query) => (
    query.family === 'exact_phrase'
    && query.query === '"Generalized Category Discovery"'
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'terminology_variant'
    && query.query === 'Generalized Class Discovery'
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'acronym_expansion'
    && query.query.includes('"GCD"')
  )));
  assert.equal(plan.queries.some((query) => query.family === 'related_work_expansion'), false);
});

test('buildLiteratureDiscoveryPlan deep plans add discovery-neighborhood expansion', () => {
  const plan = buildLiteratureDiscoveryPlan({
    topic: 'Generalized Category Discovery',
    depth: 'deep'
  });

  assert.ok(plan.queries.length <= 64);
  assert.ok(plan.queries.some((query) => query.family === 'title_scope'));
  assert.ok(plan.queries.some((query) => query.family === 'abstract_scope'));
  assert.ok(plan.queries.some((query) => query.family === 'artifact_expansion'));
  assert.ok(plan.queries.some((query) => query.family === 'review_expansion'));
  assert.ok(plan.queries.some((query) => (
    query.family === 'related_work_expansion'
    && query.query === 'novel class discovery'
  )));
  assert.ok(plan.queries.some((query) => (
    query.family === 'related_work_expansion'
    && query.query === 'generalized category discovery catastrophic forgetting'
  )));
});

test('buildLiteratureDiscoveryRunPlan inserts LLM-planned orthogonal queries before deterministic expansion', async () => {
  const plan = await buildLiteratureDiscoveryRunPlan({
    topic: 'LLM agents for time series forecasting',
    depth: 'quick',
    maxQueries: 5,
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmQueryPlannerJson: async (prompt) => {
      assert.match(prompt, /orthogonal source-search queries/);
      return {
        discipline: 'computer-science',
        queries: [
          {
            query: 'autonomous agent forecasting benchmark',
            family: 'artifact',
            rationale: 'Find benchmark and dataset entry points.'
          },
          {
            query: 'LLM agent planning evaluation',
            family: 'context',
            rationale: 'Find evaluation papers from the agent planning community.'
          },
          {
            query: 'time series foundation models agents',
            family: 'synonym',
            rationale: 'Find adjacent terminology around forecasting agents.'
          }
        ]
      };
    }
  });

  assert.equal(plan.queryPlanner.mode, 'llm');
  assert.equal(plan.discipline, 'computer-science');
  assert.deepEqual(plan.queries.slice(0, 4).map((query) => query.query), [
    'LLM agents for time series forecasting',
    'autonomous agent forecasting benchmark',
    'LLM agent planning evaluation',
    'time series foundation models agents'
  ]);
  assert.equal(plan.queries[1].family, 'llm_artifact');
  assert.equal(plan.queries[2].family, 'llm_context');
  assert.equal(plan.queries[3].family, 'llm_synonym');
  assert.ok(plan.queries.length <= 5);
});

test('buildLiteratureDiscoveryRunPlan deep defaults keep LLM routes and deterministic expansion', async () => {
  const plan = await buildLiteratureDiscoveryRunPlan({
    topic: 'Generalized Category Discovery',
    depth: 'deep',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmQueryPlannerJson: async (prompt) => {
      assert.match(prompt, /established adjacent terminology/);
      return {
        discipline: 'computer-science',
        queries: [
          { query: 'novel class discovery open world recognition', family: 'synonym' },
          { query: 'open set recognition survey', family: 'review' },
          { query: 'visual category discovery benchmarks', family: 'benchmark' },
          { query: 'self supervised representation learning category discovery', family: 'context' },
          { query: 'continual category discovery', family: 'adjacent' },
          { query: 'medical image category discovery', family: 'context' },
          { query: 'few shot open set recognition', family: 'adjacent' },
          { query: 'category discovery semantic segmentation', family: 'context' },
          { query: 'extra route should be capped', family: 'context' }
        ]
      };
    }
  });

  assert.equal(plan.queryPlanner.mode, 'llm');
  assert.equal(plan.queryPlanner.llmQueryCount, 8);
  assert.ok(plan.queries.length > buildLiteratureDiscoveryPlan({ topic: 'Generalized Category Discovery', depth: 'deep' }).queries.length);
  assert.ok(plan.queries.some((query) => query.query === 'novel class discovery open world recognition'));
  assert.equal(plan.queries.some((query) => query.query === 'extra route should be capped'), false);
  assert.ok(plan.queries.some((query) => query.family === 'title_scope'));
  assert.ok(plan.queries.some((query) => query.family === 'abstract_scope'));
  assert.ok(plan.queries.some((query) => query.family === 'artifact_expansion'));
  assert.ok(plan.queries.some((query) => query.family === 'review_expansion'));
  assert.ok(plan.queries.some((query) => query.family === 'related_work_expansion'));
});

test('buildLiteratureDiscoveryRunPlan falls back to deterministic planning when LLM planning fails', async () => {
  const plan = await buildLiteratureDiscoveryRunPlan({
    topic: 'LLM agents for time series forecasting',
    depth: 'quick',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmQueryPlannerJson: async () => {
      throw new Error('planner unavailable');
    }
  });

  assert.equal(plan.queryPlanner.mode, 'rules');
  assert.equal(plan.queryPlanner.attempted, true);
  assert.match(plan.queryPlanner.reason, /llm-failed/);
  assert.equal(plan.queries[0].family, 'direct');
});

test('extractResearchEntitiesFromText finds dataset and benchmark mentions', () => {
  const entities = extractResearchEntitiesFromText(
    'We evaluate Idea-Catalyst using the CHIMERA dataset. Benchmarks like IdeaBench explore literature-grounded idea generation. CreativityPrism: A Holistic Benchmark for Large Language Model Creativity is also related.',
    { sourceTitle: 'Idea-Catalyst' }
  );

  assert.ok(entities.some((entity) => entity.name === 'CHIMERA' && entity.kind === 'dataset'));
  assert.ok(entities.some((entity) => entity.name === 'IdeaBench' && entity.kind === 'benchmark'));
  assert.ok(entities.some((entity) => entity.name === 'CreativityPrism' && entity.kind === 'benchmark'));
});

test('mergeDiscoveryCandidates dedupes fuzzy title matches with secondary evidence', () => {
  const candidates = [
    createDiscoveryCandidate({
      provider: 'openalex',
      title: 'Graph Neural Networks for Materials Discovery',
      authors: ['Jane Doe', 'Alan Smith'],
      year: 2024,
      venue: 'Journal of Test Materials',
      identifiers: { doi: '10.1234/materials.1' }
    }),
    createDiscoveryCandidate({
      provider: 'semantic_scholar',
      title: 'Graph neural networks in materials discovery',
      authors: ['J. Doe', 'A. Smith'],
      year: 2024,
      venue: 'Journal of Test Materials'
    })
  ];

  const merged = mergeDiscoveryCandidates({
    topic: 'graph neural networks for materials discovery',
    candidates
  });

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].providers.sort(), ['openalex', 'semantic_scholar']);
  assert.ok(merged[0].dedupeEvidence.some((entry) => entry.reason === 'fuzzy_title_with_secondary_evidence'));
});

test('mergeDiscoveryCandidates preserves conflicting strong identities and records relation hints', () => {
  const candidates = [
    createDiscoveryCandidate({
      provider: 'arxiv',
      title: 'Efficient Transformers for Protein Design',
      authors: ['Ada Lovelace'],
      year: 2023,
      publicationType: 'preprint',
      identifiers: { arxivId: '2301.01234' }
    }),
    createDiscoveryCandidate({
      provider: 'crossref',
      title: 'Efficient transformer models for protein design',
      authors: ['Ada Lovelace'],
      year: 2024,
      publicationType: 'journal-article',
      identifiers: { doi: '10.5555/protein.design' }
    }),
    createDiscoveryCandidate({
      provider: 'semantic_scholar',
      title: 'Efficient Transformers for Protein Design',
      authors: ['Ada Lovelace'],
      year: 2024,
      publicationType: 'journal-article',
      identifiers: { doi: '10.7777/different.protein.design' }
    })
  ];

  const merged = mergeDiscoveryCandidates({
    topic: 'efficient transformers for protein design',
    candidates
  });

  assert.equal(merged.length, 2);
  assert.ok(merged.some((candidate) => candidate.identifiers.arxivId === '2301.01234'));
  assert.ok(merged.some((candidate) => (
    (candidate.relations || []).some((relation) => (
      (relation.type === 'preprint_of' || relation.type === 'has_preprint')
      && relation.evidence.strongIdentifierConflict
    ))
  )));
});

test('mergeDiscoveryCandidates ranks expanded-query title matches into the candidate window', () => {
  const merged = mergeDiscoveryCandidates({
    topic: 'generalized category discovery',
    candidates: [
      createDiscoveryCandidate({
        provider: 'openalex',
        title: 'A Low Signal Generalized Category Discovery Poster',
        year: 2024,
        citationCount: 1,
        retrievalEvidence: [{
          provider: 'openalex',
          queryId: 'q1',
          query: 'Generalized Category Discovery',
          family: 'direct'
        }]
      }),
      createDiscoveryCandidate({
        provider: 'crossref',
        title: 'Recent Advances in Open Set Recognition: A Survey',
        year: 2020,
        citationCount: 1,
        retrievalEvidence: [{
          provider: 'crossref',
          queryId: 'q2',
          query: 'open-set recognition survey',
          family: 'related_work_expansion'
        }]
      })
    ]
  });

  assert.equal(merged[0].title, 'Recent Advances in Open Set Recognition: A Survey');
  assert.ok(merged[0].selectionScore > merged[1].selectionScore);
});

test('executeProviderQueries retries transient provider failures', async () => {
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          async json() {
            return {};
          }
        };
      }
      return createJsonResponse({ results: [] });
    };

    const result = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q1', query: 'retryable provider query', family: 'direct' }
        ]
      },
      retryCount: 1,
      retryBackoffMs: 1
    });

    assert.equal(calls, 2);
    assert.equal(result.queryResults[0].ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries does not wait or retry long provider retry-after windows', async () => {
  let calls = 0;

  try {
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => '3600' },
        async json() {
          return {};
        }
      };
    };

    const result = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q1', query: 'quota limited provider query', family: 'direct' }
        ]
      },
      retryCount: 2,
      retryBackoffMs: 1
    });

    assert.equal(calls, 1);
    assert.equal(result.queryResults[0].ok, false);
    assert.match(result.queryResults[0].reason, /openalex http 429/);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => new Date(Date.now() + 60 * 60 * 1000).toUTCString() },
        async json() {
          return {};
        }
      };
    };

    const httpDateResult = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q2', query: 'http-date quota limited provider query', family: 'direct' }
        ]
      },
      retryCount: 2,
      retryBackoffMs: 1
    });

    assert.equal(calls, 1);
    assert.equal(httpDateResult.queryResults[0].ok, false);
    assert.match(httpDateResult.queryResults[0].reason, /openalex http 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries can pace consecutive requests to the same provider', async () => {
  const starts = [];

  try {
    globalThis.fetch = async () => {
      starts.push(Date.now());
      return createJsonResponse({ results: [] });
    };

    const result = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q1', query: 'first paced query', family: 'direct' },
          { id: 'q2', query: 'second paced query', family: 'direct' }
        ]
      },
      maxResultsPerQuery: 1,
      providerRequestDelayMs: 15
    });

    assert.equal(result.queryResults.length, 2);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries rate limits Semantic Scholar API-key retries', async () => {
  const previousDelay = process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS;
  const starts = [];

  try {
    process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS = '15';
    resetSemanticScholarRateLimitForTests();
    globalThis.fetch = async () => {
      starts.push(Date.now());
      if (starts.length === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          async json() {
            return {};
          }
        };
      }
      return createJsonResponse({ data: [] });
    };

    const result = await executeProviderQueries({
      providers: ['semantic_scholar'],
      plan: {
        queries: [
          { id: 'q1', query: 'semantic scholar retry query', family: 'direct' }
        ]
      },
      semanticScholarApiKey: 'test-s2-key',
      retryCount: 1,
      retryBackoffMs: 1
    });

    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 10);
    assert.equal(result.queryResults[0].ok, true);
  } finally {
    if (previousDelay === undefined) {
      delete process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS;
    } else {
      process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS = previousDelay;
    }
    resetSemanticScholarRateLimitForTests();
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries applies Semantic Scholar-only venue and field-of-study filters', async () => {
  const requested = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requested.push({
        host: url.hostname,
        query: url.searchParams.get('query') || url.searchParams.get('search') || '',
        venue: url.searchParams.get('venue') || '',
        fieldsOfStudy: url.searchParams.get('fieldsOfStudy') || ''
      });

      if (url.hostname === 'api.openalex.org') return createJsonResponse({ results: [] });
      if (url.hostname === 'api.semanticscholar.org') return createJsonResponse({ data: [] });
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await executeProviderQueries({
      providers: ['openalex', 'semantic_scholar'],
      plan: {
        queries: [
          { id: 'q1', query: 'generalized category discovery', family: 'direct' },
          {
            id: 'q2',
            query: 'generalized category discovery',
            family: 'venue_bias',
            providerAllowList: ['semantic_scholar'],
            venue: 'IEEE'
          },
          {
            id: 'q3',
            query: 'generalized category discovery',
            family: 'discipline_bias',
            providerAllowList: ['semantic_scholar'],
            semanticScholarFieldsOfStudy: ['Computer Science']
          }
        ]
      },
      maxResultsPerQuery: 1
    });

    const openAlexRequests = requested.filter((entry) => entry.host === 'api.openalex.org');
    const semanticScholarRequests = requested.filter((entry) => entry.host === 'api.semanticscholar.org');

    assert.equal(openAlexRequests.length, 1);
    assert.equal(semanticScholarRequests.length, 3);
    assert.ok(semanticScholarRequests.some((entry) => (
      entry.query === 'generalized category discovery'
      && entry.venue === 'IEEE'
    )));
    assert.ok(semanticScholarRequests.some((entry) => (
      entry.query === 'generalized category discovery'
      && entry.fieldsOfStudy === 'Computer Science'
    )));
    assert.ok(result.queryResults.some((entry) => entry.family === 'venue_bias' && entry.venue === 'IEEE'));
    assert.ok(result.queryResults.some((entry) => (
      entry.family === 'discipline_bias'
      && entry.semanticScholarFieldsOfStudy.includes('Computer Science')
    )));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries maps field-scoped queries to source-native search parameters', async () => {
  const requested = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requested.push({
        host: url.hostname,
        search: url.searchParams.get('search') || '',
        filter: url.searchParams.get('filter') || '',
        query: url.searchParams.get('query') || '',
        queryTitle: url.searchParams.get('query.title') || '',
        queryBibliographic: url.searchParams.get('query.bibliographic') || '',
        arxivSearchQuery: url.searchParams.get('search_query') || '',
        dblpQuery: url.searchParams.get('q') || ''
      });

      if (url.hostname === 'api.openalex.org') return createJsonResponse({ results: [] });
      if (url.hostname === 'api.crossref.org') return createJsonResponse({ message: { items: [] } });
      if (url.hostname === 'export.arxiv.org') return createTextResponse('<feed></feed>');
      if (url.hostname === 'dblp.org') return createJsonResponse({ result: { hits: { hit: [] } } });
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await executeProviderQueries({
      providers: ['openalex', 'crossref', 'arxiv', 'dblp'],
      plan: {
        queries: [
          {
            id: 'q1',
            query: 'generalized category discovery',
            family: 'title_scope',
            fieldScope: 'title',
            providerAllowList: ['openalex', 'crossref', 'arxiv', 'dblp']
          },
          {
            id: 'q2',
            query: 'generalized category discovery',
            family: 'abstract_scope',
            fieldScope: 'abstract',
            providerAllowList: ['openalex', 'crossref', 'arxiv']
          }
        ]
      },
      maxResultsPerQuery: 1
    });

    assert.ok(requested.some((entry) => (
      entry.host === 'api.openalex.org'
      && entry.filter === 'title.search:generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'api.openalex.org'
      && entry.filter === 'abstract.search:generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'api.crossref.org'
      && entry.queryTitle === 'generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'api.crossref.org'
      && entry.queryBibliographic === 'generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'export.arxiv.org'
      && entry.arxivSearchQuery === 'ti:generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'export.arxiv.org'
      && entry.arxivSearchQuery === 'abs:generalized category discovery'
    )));
    assert.ok(requested.some((entry) => (
      entry.host === 'dblp.org'
      && entry.dblpQuery === 'generalized category discovery$'
    )));
    assert.equal(requested.filter((entry) => entry.host === 'dblp.org').length, 1);
    assert.ok(result.queryResults.every((entry) => !entry.fieldScope || ['title', 'abstract'].includes(entry.fieldScope)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries searches provider sources with at most four concurrent workers', async () => {
  const providers = ['openalex', 'semantic_scholar', 'crossref', 'arxiv', 'dblp'];
  const hostToProvider = new Map([
    ['api.openalex.org', 'openalex'],
    ['api.semanticscholar.org', 'semantic_scholar'],
    ['api.crossref.org', 'crossref'],
    ['export.arxiv.org', 'arxiv'],
    ['dblp.org', 'dblp']
  ]);
  const plan = {
    queries: [
      { id: 'q1', query: 'graph neural networks', family: 'direct' },
      { id: 'q2', query: 'materials discovery', family: 'artifact_expansion' }
    ]
  };
  const activeProviders = new Set();
  const requestedProviders = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const provider = hostToProvider.get(url.hostname);
      assert.ok(provider, `unexpected host ${url.hostname}`);
      assert.equal(activeProviders.has(provider), false, `${provider} queries should stay sequential`);
      activeProviders.add(provider);
      requestedProviders.push(provider);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        activeRequests -= 1;
        activeProviders.delete(provider);
      }

      if (provider === 'openalex') return createJsonResponse({ results: [] });
      if (provider === 'semantic_scholar') return createJsonResponse({ data: [] });
      if (provider === 'crossref') return createJsonResponse({ message: { items: [] } });
      if (provider === 'arxiv') return createTextResponse('<feed></feed>');
      if (provider === 'dblp') return createJsonResponse({ result: { hits: { hit: [] } } });
      assert.fail(`unexpected provider ${provider}`);
    };

    const result = await executeProviderQueries({
      providers,
      plan,
      maxResultsPerQuery: 1
    });

    assert.equal(maxActiveRequests, 4);
    assert.deepEqual(result.providers, providers);
    assert.equal(result.queryResults.length, providers.length * plan.queries.length);
    assert.deepEqual(result.queryResults.map((entry) => entry.provider), providers.flatMap((provider) => [provider, provider]));
    assert.deepEqual([...new Set(requestedProviders)].sort(), [...providers].sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runLiteratureDiscovery merges providers, downloads legal PDFs, and persists artifacts', async () => {
  const rootPath = await createTempCorpus();
  const requestedHosts = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);

      if (url.hostname === 'api.openalex.org') {
        return createJsonResponse({
          results: [
            {
              id: 'https://openalex.org/W123',
              doi: 'https://doi.org/10.1234/example.1',
              title: 'Graph Neural Networks for Materials Discovery',
              publication_year: 2024,
              publication_date: '2024-01-15',
              cited_by_count: 42,
              type: 'journal-article',
              authorships: [{ author: { display_name: 'Jane Doe' } }],
              ids: { doi: 'https://doi.org/10.1234/example.1' },
              primary_location: {
                source: { display_name: 'Journal of Test Materials' },
                landing_page_url: 'https://doi.org/10.1234/example.1',
                pdf_url: 'https://example.org/paper.pdf'
              },
              best_oa_location: {
                landing_page_url: 'https://example.org/article',
                pdf_url: 'https://example.org/paper.pdf'
              },
              open_access: { oa_status: 'gold' }
            }
          ]
        });
      }

      if (url.hostname === 'api.semanticscholar.org') {
        return createJsonResponse({
          data: [
            {
              paperId: 's2-1',
              title: 'Graph Neural Networks for Materials Discovery',
              authors: [{ name: 'Jane Doe' }],
              year: 2024,
              venue: 'Journal of Test Materials',
              citationCount: 48,
              externalIds: { DOI: '10.1234/example.1' },
              openAccessPdf: { url: 'https://example.org/paper.pdf' },
              isOpenAccess: true
            }
          ]
        });
      }

      if (url.hostname === 'api.crossref.org') {
        return createJsonResponse({
          message: {
            items: [
              {
                DOI: '10.1234/example.1',
                title: ['Graph Neural Networks for Materials Discovery'],
                author: [{ given: 'Jane', family: 'Doe' }],
                published: { 'date-parts': [[2024, 1, 15]] },
                'container-title': ['Journal of Test Materials'],
                type: 'journal-article'
              }
            ]
          }
        });
      }

      if (url.hostname === 'export.arxiv.org') {
        return createTextResponse(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>https://arxiv.org/abs/2401.01234</id>
    <title>Graph Neural Networks for Materials Discovery</title>
    <summary>We study graph neural networks for materials discovery.</summary>
    <published>2024-01-15T00:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <arxiv:doi>10.1234/example.1</arxiv:doi>
    <link href="https://arxiv.org/pdf/2401.01234.pdf" rel="related" type="application/pdf"/>
  </entry>
</feed>`);
      }

      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: []
            }
          }
        });
      }

      if (url.hostname === 'example.org' || url.hostname === 'arxiv.org') {
        return createPdfResponse();
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'graph neural networks for materials discovery',
      depth: 'quick',
      maxResultsPerQuery: 2,
      maxDownloads: 2,
      mailto: 'paper@example.com'
    });

    assert.equal(run.coverage.verdict, 'strong');
    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].source.resolutionStatus, 'fulltext_ready');
    assert.equal(run.candidates[0].identifiers.doi, '10.1234/example.1');
    assert.equal(run.candidates[0].identifiers.arxivId, '2401.01234');
    assert.ok(run.candidates[0].providers.includes('openalex'));
    assert.ok(run.candidates[0].providers.includes('semantic_scholar'));
    assert.ok(run.candidates[0].providers.includes('crossref'));
    assert.ok(run.candidates[0].providers.includes('arxiv'));
    assert.ok(await fs.stat(run.artifacts.runJsonPath));
    assert.ok(await fs.stat(run.artifacts.reportPath));
    assert.ok(await fs.stat(run.artifacts.downloadManifestPath));

    const downloadManifest = JSON.parse(await fs.readFile(run.artifacts.downloadManifestPath, 'utf8'));
    assert.equal(downloadManifest.length, 1);
    assert.equal(downloadManifest[0].full_text_status, 'open_pdf');
    assert.equal(downloadManifest[0].download_status, 'downloaded');
    assert.equal(downloadManifest[0].doi, '10.1234/example.1');
    assert.ok(downloadManifest[0].local_pdf_path.endsWith('.pdf'));

    const persisted = await loadDiscoveryRun(rootPath, run.runId);
    assert.equal(persisted.runId, run.runId);
    assert.ok(requestedHosts.includes('api.openalex.org'));
    assert.ok(requestedHosts.includes('api.semanticscholar.org'));
    assert.ok(requestedHosts.includes('api.crossref.org'));
    assert.ok(requestedHosts.includes('export.arxiv.org'));
    assert.ok(requestedHosts.includes('dblp.org'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery executes LLM-planned queries by default when configured', async () => {
  const rootPath = await createTempCorpus();
  const requestedQueries = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.openalex.org') {
        requestedQueries.push(url.searchParams.get('search') || '');
        return createJsonResponse({ results: [] });
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'LLM agents for time series forecasting',
      providers: ['openalex'],
      depth: 'quick',
      maxQueries: 4,
      resolveSources: false,
      persist: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'test-key',
      llmQueryPlannerJson: async () => ({
        discipline: 'computer-science',
        queries: [
          { query: 'autonomous agent forecasting benchmark', family: 'artifact' },
          { query: 'LLM agent planning evaluation', family: 'context' },
          { query: 'time series foundation models agents', family: 'synonym' }
        ]
      })
    });

    assert.equal(run.plan.queryPlanner.mode, 'llm');
    assert.ok(requestedQueries.includes('LLM agents for time series forecasting'));
    assert.ok(requestedQueries.includes('autonomous agent forecasting benchmark'));
    assert.ok(requestedQueries.includes('LLM agent planning evaluation'));
    assert.ok(requestedQueries.includes('time series foundation models agents'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery resolves client seed papers on the PaperNexus server', async () => {
  const rootPath = await createTempCorpus();
  const previousCoreApiKey = process.env.CORE_API_KEY;
  const requestedHosts = [];

  try {
    delete process.env.CORE_API_KEY;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);
      if (url.hostname === 'arxiv.org') {
        return createPdfResponse();
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'remote seed source resolution',
      providers: ['core'],
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxCandidates: 1,
      maxDownloads: 1,
      seedPapers: [
        {
          title: 'Client Supplied arXiv Seed',
          arxivId: '2501.00001',
          year: 2025,
          venue: 'SeedConf'
        }
      ]
    });

    assert.equal(run.seedSummary.supplied, 1);
    assert.equal(run.seedSummary.accepted, 1);
    assert.equal(run.seedSummary.queryCount, 1);
    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].providers[0], 'client_seed');
    assert.equal(run.candidates[0].identifiers.arxivId, '2501.00001');
    assert.equal(run.candidates[0].source.resolutionStatus, 'fulltext_ready');
    assert.equal(run.candidates[0].source.sourceProvider, 'client_seed');
    assert.ok(requestedHosts.includes('arxiv.org'));
    assert.ok(!requestedHosts.includes('api.core.ac.uk'));
  } finally {
    if (previousCoreApiKey === undefined) {
      delete process.env.CORE_API_KEY;
    } else {
      process.env.CORE_API_KEY = previousCoreApiKey;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery expands extracted dataset and benchmark entities into provider queries', async () => {
  const rootPath = await createTempCorpus();
  const requestedQueries = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'api.openalex.org');
      const query = url.searchParams.get('search') || '';
      requestedQueries.push(query);
      if (/CHIMERA/i.test(query)) {
        return createJsonResponse({
          results: [
            {
              id: 'https://openalex.org/W123',
              doi: 'https://doi.org/10.5555/chimera.dataset',
              title: 'CHIMERA: A Knowledge Base of Idea Recombination in Scientific Literature',
              publication_year: 2025,
              publication_date: '2025-05-01',
              authorships: [
                { author: { display_name: 'Noy Sternlicht' } },
                { author: { display_name: 'Tom Hope' } }
              ],
              ids: {},
              primary_location: {
                source: { display_name: 'arXiv' },
                landing_page_url: 'https://arxiv.org/abs/2505.20779'
              },
              best_oa_location: {},
              open_access: { oa_status: 'green' },
              cited_by_count: 3,
              type: 'preprint'
            }
          ]
        });
      }
      return createJsonResponse({ results: [] });
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'interdisciplinary research ideation',
      providers: ['openalex'],
      maxQueries: 1,
      maxResultsPerQuery: 2,
      maxCandidates: 10,
      resolveSources: false,
      persist: false,
      maxExtractedEntities: 1,
      sourceIndex: {
        texts: [
          {
            text: 'We evaluate Idea-Catalyst using the CHIMERA dataset, a collection of interdisciplinary research papers.',
            sourceTitle: 'Sparking Scientific Creativity via LLM-Driven Interdisciplinary Inspiration'
          }
        ]
      }
    });

    assert.equal(run.entitySummary.supplied, 1);
    assert.equal(run.entitySummary.accepted, 1);
    assert.equal(run.entitySummary.queryCount, 1);
    assert.ok(run.queryResults.some((entry) => entry.family === 'entity_seed'));
    assert.ok(requestedQueries.some((query) => /"CHIMERA" dataset/i.test(query)));
    assert.ok(run.candidates.some((candidate) => /CHIMERA/.test(candidate.title)));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery supports Europe PMC and PMC PDF resolution', async () => {
  const rootPath = await createTempCorpus();

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'www.ebi.ac.uk') {
        return createJsonResponse({
          resultList: {
            result: [
              {
                id: '37000001',
                pmid: '37000001',
                pmcid: 'PMC1234567',
                doi: '10.5555/pmc.example',
                title: 'Single cell biomarkers for therapy response',
                authorString: 'Ada Lovelace, Grace Hopper',
                pubYear: '2025',
                firstPublicationDate: '2025-02-03',
                journalTitle: 'Open Biomedical Reports',
                isOpenAccess: 'Y',
                citedByCount: 7,
                abstractText: 'We report single cell biomarkers.',
                fullTextUrlList: {
                  fullTextUrl: [
                    {
                      documentStyle: 'pdf',
                      availability: 'Open access',
                      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/pdf/'
                    }
                  ]
                }
              }
            ]
          }
        });
      }

      if (url.hostname === 'pmc.ncbi.nlm.nih.gov') {
        return createPdfResponse();
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'single cell biomarkers therapy response',
      discipline: 'biomedicine',
      providers: ['europe_pmc'],
      maxQueries: 1,
      maxResultsPerQuery: 2,
      maxDownloads: 1
    });

    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].providers[0], 'europe_pmc');
    assert.equal(run.candidates[0].identifiers.pmcid, 'PMC1234567');
    assert.equal(run.candidates[0].source.fullTextStatus, 'open_pdf');
    assert.equal(run.candidates[0].source.downloadStatus, 'downloaded');

    const downloadManifest = JSON.parse(await fs.readFile(run.artifacts.downloadManifestPath, 'utf8'));
    assert.equal(downloadManifest[0].download_source, 'pubmed_central');
    assert.equal(downloadManifest[0].pmcid, 'PMC1234567');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources classifies HTML PDF routes for download manifests', async () => {
  const rootPath = await createTempCorpus();

  try {
    globalThis.fetch = async () => createHtmlResponse();

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      candidates: [
        {
          title: 'HTML-only publisher article',
          authors: ['Test Author'],
          year: 2026,
          providers: ['openalex'],
          identifiers: {
            doi: '10.7777/html.only'
          },
          canonicalId: 'doi:10.7777/html.only',
          pdfUrl: 'https://publisher.example/article.pdf',
          landingPageUrl: 'https://publisher.example/article'
        }
      ]
    });

    assert.equal(result.candidates[0].source.fullTextStatus, 'html_not_pdf');
    assert.equal(result.candidates[0].source.downloadStatus, 'not_pdf');
    assert.match(result.candidates[0].source.downloadError, /HTML/);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources downloads PDFs with bounded concurrency', async () => {
  const rootPath = await createTempCorpus();
  let activeDownloads = 0;
  let maxActiveDownloads = 0;
  const requestedPaths = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, 'example.org');
      requestedPaths.push(url.pathname);
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return createPdfResponse();
      } finally {
        activeDownloads -= 1;
      }
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 4,
      downloadConcurrency: 8,
      candidates: Array.from({ length: 5 }, (_, index) => createDiscoveryCandidate({
        provider: 'openalex',
        title: `Concurrent Download Paper ${index + 1}`,
        identifiers: { doi: `10.7777/concurrent.${index + 1}` },
        pdfUrl: `https://example.org/paper-${index + 1}.pdf`
      }))
    });

    assert.equal(maxActiveDownloads, 4);
    assert.equal(requestedPaths.length, 4);
    assert.equal(result.summary.downloaded, 4);
    assert.equal(result.summary.resolvedFullText, 4);
    assert.equal(result.candidates[4].source.downloadStatus, 'eligible');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources records institutional-access candidates without downloading', async () => {
  const rootPath = await createTempCorpus();

  try {
    const result = await resolveDiscoverySources({
      rootPath,
      allowDownloads: false,
      candidates: [
        {
          title: 'Subscription journal article',
          authors: ['Test Author'],
          year: 2026,
          providers: ['crossref'],
          identifiers: {
            doi: '10.8888/subscription.article'
          },
          canonicalId: 'doi:10.8888/subscription.article',
          landingPageUrl: 'https://doi.org/10.8888/subscription.article'
        }
      ]
    });

    assert.equal(result.candidates[0].source.fullTextStatus, 'needs_institution');
    assert.equal(result.candidates[0].source.downloadStatus, 'skipped');
    assert.equal(result.candidates[0].source.authorizedAccessStatus, 'institutional_access_may_be_available');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery uses DBLP venue metadata for CS venue coverage', async () => {
  const rootPath = await createTempCorpus();

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: [
                {
                  info: {
                    key: 'conf/nips/Test2025',
                    title: 'Graph Neural Agents for Retrieval',
                    authors: {
                      author: [
                        { text: 'Jane Doe' },
                        { text: 'John Smith' }
                      ]
                    },
                    year: '2025',
                    venue: 'NeurIPS',
                    ee: 'https://doi.org/10.9999/dblp.example',
                    doi: '10.9999/dblp.example',
                    url: 'https://dblp.org/rec/conf/nips/Test2025'
                  }
                }
              ]
            }
          }
        });
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'graph neural agents for retrieval',
      discipline: 'computer-science',
      providers: ['dblp'],
      maxQueries: 1,
      maxResultsPerQuery: 2,
      allowDownloads: false
    });

    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].providers[0], 'dblp');
    assert.equal(run.candidates[0].venueFamily, 'neurips');
    assert.ok(run.candidates[0].venuePackHits.includes('cs_ml_core'));
    assert.equal(run.candidates[0].identifiers.doi, '10.9999/dblp.example');
    assert.equal(run.candidates[0].source.fullTextStatus, 'needs_institution');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery downloads CORE repository PDFs when CORE_API_KEY is available', async () => {
  const rootPath = await createTempCorpus();
  const previousCoreApiKey = process.env.CORE_API_KEY;

  try {
    process.env.CORE_API_KEY = 'test-core-key';
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'api.core.ac.uk' && url.pathname.includes('/search/works')) {
        return createJsonResponse({
          results: [
            {
              id: 'core-1',
              title: 'Repository PDF for Open Retrieval',
              authors: ['Ada Lovelace'],
              yearPublished: 2024,
              publisher: 'Example Repository',
              doi: '10.4242/core.example',
              abstract: 'A repository-hosted open access manuscript.',
              downloadUrl: 'https://api.core.ac.uk/v3/outputs/core-1/download',
              fullTextIdentifier: 'https://api.core.ac.uk/v3/outputs/core-1/download'
            }
          ]
        });
      }

      if (url.hostname === 'api.core.ac.uk' && url.pathname.includes('/download')) {
        return createPdfResponse();
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'repository PDF open retrieval',
      providers: ['core'],
      maxQueries: 1,
      maxResultsPerQuery: 2,
      maxDownloads: 1
    });

    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].providers[0], 'core');
    assert.equal(run.candidates[0].source.fullTextStatus, 'open_pdf');
    assert.equal(run.candidates[0].source.downloadStatus, 'downloaded');
    assert.equal(run.candidates[0].identifiers.doi, '10.4242/core.example');

    const downloadManifest = JSON.parse(await fs.readFile(run.artifacts.downloadManifestPath, 'utf8'));
    assert.equal(downloadManifest[0].download_source, 'core');
    assert.equal(downloadManifest[0].download_status, 'downloaded');
  } finally {
    if (previousCoreApiKey === undefined) {
      delete process.env.CORE_API_KEY;
    } else {
      process.env.CORE_API_KEY = previousCoreApiKey;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery reports CORE missing credentials explicitly', async () => {
  const rootPath = await createTempCorpus();
  const previousCoreApiKey = process.env.CORE_API_KEY;

  try {
    delete process.env.CORE_API_KEY;
    globalThis.fetch = async () => {
      assert.fail('CORE should not issue a request without CORE_API_KEY');
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'repository PDF open retrieval',
      providers: ['core'],
      maxQueries: 1,
      maxResultsPerQuery: 2,
      maxDownloads: 1
    });

    assert.equal(run.candidates.length, 0);
    assert.equal(run.queryResults[0].provider, 'core');
    assert.equal(run.queryResults[0].ok, false);
    assert.match(run.queryResults[0].reason, /missing_credentials/);
  } finally {
    if (previousCoreApiKey === undefined) {
      delete process.env.CORE_API_KEY;
    } else {
      process.env.CORE_API_KEY = previousCoreApiKey;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery can add Semantic Scholar citation expansion candidates', async () => {
  const rootPath = await createTempCorpus();
  let citationCalls = 0;

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'api.semanticscholar.org' && url.pathname.endsWith('/paper/search')) {
        return createJsonResponse({
          data: [
            {
              paperId: 'seed-1',
              title: 'Seed Paper for Citation Expansion',
              authors: [{ name: 'Seed Author' }],
              year: 2024,
              venue: 'NeurIPS',
              citationCount: 10,
              externalIds: { DOI: '10.1010/seed.paper' },
              isOpenAccess: false,
              url: 'https://semanticscholar.org/paper/seed-1'
            }
          ]
        });
      }

      if (url.hostname === 'api.semanticscholar.org' && url.pathname.includes('/paper/DOI%3A10.1010%2Fseed.paper')) {
        citationCalls += 1;
        if (citationCalls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: () => null },
            async json() {
              return {};
            }
          };
        }

        return createJsonResponse({
          references: [
            {
              paperId: 'ref-1',
              title: 'Earlier Reference Paper',
              authors: [{ name: 'Reference Author' }],
              year: 2021,
              venue: 'ICML',
              citationCount: 20,
              externalIds: { DOI: '10.1010/reference.paper' },
              url: 'https://semanticscholar.org/paper/ref-1'
            }
          ],
          citations: [
            {
              paperId: 'cit-1',
              title: 'Later Citing Paper',
              authors: [{ name: 'Citing Author' }],
              year: 2025,
              venue: 'ICLR',
              citationCount: 3,
              externalIds: { DOI: '10.1010/citing.paper' },
              url: 'https://semanticscholar.org/paper/cit-1'
            }
          ]
        });
      }

      if (url.hostname === 'api.openalex.org' && url.pathname.includes('/works/https%3A%2F%2Fdoi.org%2F10.1010%2Fseed.paper')) {
        assert.equal(url.searchParams.get('api_key'), 'openalex-test-key');
        return createJsonResponse({
          id: 'https://openalex.org/W100',
          title: 'Seed Paper for Citation Expansion',
          related_works: ['https://openalex.org/W200', 'https://openalex.org/W201']
        });
      }

      if (url.hostname === 'api.openalex.org' && url.pathname === '/works') {
        assert.equal(url.searchParams.get('filter'), 'ids.openalex:W200');
        assert.equal(url.searchParams.get('api_key'), 'openalex-test-key');
        return createJsonResponse({
          results: [
            {
              id: 'https://openalex.org/W200',
              doi: 'https://doi.org/10.1010/openalex.related',
              title: 'OpenAlex Related Paper',
              publication_year: 2022,
              publication_date: '2022-05-01',
              cited_by_count: 12,
              type: 'conference-paper',
              authorships: [{ author: { display_name: 'Related Author' } }],
              ids: { doi: 'https://doi.org/10.1010/openalex.related' },
              primary_location: {
                source: { display_name: 'CVPR' },
                landing_page_url: 'https://doi.org/10.1010/openalex.related'
              },
              best_oa_location: {},
              open_access: { oa_status: 'green' }
            }
          ]
        });
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'seed citation expansion',
      providers: ['semantic_scholar'],
      maxQueries: 1,
      maxResultsPerQuery: 1,
      citationExpansion: true,
      maxCitationSeeds: 1,
      maxCitationsPerSeed: 1,
      maxRelatedPerSeed: 1,
      openAlexApiKey: 'openalex-test-key',
      retryCount: 1,
      retryBackoffMs: 1,
      resolveSources: false
    });

    assert.equal(citationCalls, 2);
    assert.equal(run.citationExpansion.addedCandidates, 3);
    assert.equal(run.citationExpansion.semanticScholarAddedCandidates, 2);
    assert.equal(run.citationExpansion.openAlexRelatedAddedCandidates, 1);
    assert.equal(run.candidates.length, 4);
    assert.ok(run.candidates.some((candidate) => candidate.title === 'Earlier Reference Paper'));
    assert.ok(run.candidates.some((candidate) => candidate.title === 'Later Citing Paper'));
    assert.ok(run.candidates.some((candidate) => candidate.title === 'OpenAlex Related Paper'));
    assert.ok(run.queryResults.some((entry) => entry.provider === 'semantic_scholar_citation' && entry.ok));
    assert.ok(run.queryResults.some((entry) => entry.provider === 'openalex_related' && entry.ok));
    assert.equal(run.coverage.citationExpansionCoverage.addedCandidates, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery shares Semantic Scholar rate limit across search and citation expansion', async () => {
  const previousDelay = process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS;
  const rootPath = await createTempCorpus();
  const starts = [];

  try {
    process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS = '15';
    resetSemanticScholarRateLimitForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'api.semanticscholar.org') {
        starts.push({
          pathname: url.pathname,
          startedAt: Date.now()
        });
      }

      if (url.hostname === 'api.semanticscholar.org' && url.pathname.endsWith('/paper/search')) {
        return createJsonResponse({
          data: [
            {
              paperId: 'seed-1',
              title: 'Seed Paper for Shared Rate Limit',
              authors: [{ name: 'Seed Author' }],
              year: 2024,
              citationCount: 10,
              externalIds: { DOI: '10.1010/shared.rate.limit' },
              url: 'https://semanticscholar.org/paper/seed-1'
            }
          ]
        });
      }

      if (url.hostname === 'api.semanticscholar.org' && url.pathname.includes('/paper/DOI%3A10.1010%2Fshared.rate.limit')) {
        return createJsonResponse({
          references: [],
          citations: []
        });
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      topic: 'shared semantic scholar rate limit',
      providers: ['semantic_scholar'],
      semanticScholarApiKey: 'test-s2-key',
      maxQueries: 1,
      maxResultsPerQuery: 1,
      citationExpansion: true,
      maxCitationSeeds: 1,
      maxCitationsPerSeed: 1,
      openAlexRelatedExpansion: false,
      retryCount: 0,
      resolveSources: false
    });

    assert.equal(starts.length, 2);
    assert.ok(starts[1].startedAt - starts[0].startedAt >= 10);
    assert.equal(run.citationExpansion.seeds, 1);
  } finally {
    if (previousDelay === undefined) {
      delete process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS;
    } else {
      process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS = previousDelay;
    }
    resetSemanticScholarRateLimitForTests();
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('expandDiscoveryCitations uses OpenAlex-only seeds for related work expansion', async () => {
  const requestedHosts = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedHosts.push(url.hostname);

      if (url.hostname === 'api.openalex.org' && url.pathname.includes('/works/W900')) {
        return createJsonResponse({
          id: 'https://openalex.org/W900',
          title: 'OpenAlex Seed Without DOI',
          related_works: ['https://openalex.org/W901']
        });
      }

      if (url.hostname === 'api.openalex.org' && url.pathname === '/works') {
        assert.equal(url.searchParams.get('filter'), 'ids.openalex:W901');
        return createJsonResponse({
          results: [
            {
              id: 'https://openalex.org/W901',
              title: 'OpenAlex Related From Id Only Seed',
              publication_year: 2025,
              cited_by_count: 2,
              type: 'article',
              authorships: [{ author: { display_name: 'Related Author' } }],
              ids: {},
              primary_location: {
                source: { display_name: 'Test Journal' },
                landing_page_url: 'https://openalex.org/W901'
              },
              best_oa_location: {},
              open_access: { oa_status: 'bronze' }
            }
          ]
        });
      }

      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await expandDiscoveryCitations({
      candidates: [
        createDiscoveryCandidate({
          provider: 'openalex',
          title: 'OpenAlex Seed Without DOI',
          retrievalEvidence: [{
            provider: 'openalex',
            queryId: 'q1',
            query: 'openalex id only seed',
            family: 'direct',
            providerId: 'https://openalex.org/W900'
          }]
        })
      ],
      maxCitationSeeds: 1,
      maxRelatedPerSeed: 1,
      openAlexRelatedExpansion: true
    });

    assert.deepEqual(requestedHosts, ['api.openalex.org', 'api.openalex.org']);
    assert.equal(result.summary.seeds, 1);
    assert.equal(result.summary.semanticScholarAddedCandidates, 0);
    assert.equal(result.summary.openAlexRelatedAddedCandidates, 1);
    assert.equal(result.candidates[0].title, 'OpenAlex Related From Id Only Seed');
    assert.ok(result.queryResults.some((entry) => entry.provider === 'openalex_related' && entry.ok));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MCP tool list includes literature_discovery', async () => {
  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  });

  const tool = response.tools.find((entry) => entry.name === 'literature_discovery');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.seedPapers);
  assert.ok(tool.inputSchema.properties.entitySeeds);
  assert.ok(tool.inputSchema.properties.datasetSeeds);
  assert.ok(tool.inputSchema.properties.seedTexts);
  assert.ok(tool.inputSchema.properties.providerConcurrency);
  assert.ok(tool.inputSchema.properties.downloadConcurrency);
  assert.ok(tool.inputSchema.properties.retryCount);
  assert.ok(tool.inputSchema.properties.providerRequestDelayMs);
  assert.ok(tool.inputSchema.properties.maxRetryAfterMs);
  assert.ok(tool.inputSchema.properties.openAlexApiKey);
  assert.ok(tool.inputSchema.properties.openAlexApiKeyFile);
  assert.ok(tool.inputSchema.properties.openAlexRelatedExpansion);
  assert.ok(tool.inputSchema.properties.maxRelatedPerSeed);
});
