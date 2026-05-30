import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLiteratureDiscoveryPlan } from '../src/core/discovery/query-planner.js';
import { extractResearchEntitiesFromText } from '../src/core/discovery/entities.js';
import { expandDiscoveryCitations } from '../src/core/discovery/citation-expansion.js';
import { DEFAULT_DISCOVERY_PROVIDERS, KNOWN_DISCOVERY_PROVIDERS, executeProviderQueries } from '../src/core/discovery/providers.js';
import { resetSemanticScholarRateLimitForTests } from '../src/core/discovery/s2-rate-limit.js';
import {
  readDiscoveryRequestSchedulerState,
  resetDiscoveryRequestSchedulerForTests,
  scheduleDiscoveryFetch
} from '../src/core/discovery/request-scheduler.js';
import { mergeDiscoveryCandidates } from '../src/core/discovery/merge.js';
import { resolveDiscoverySources } from '../src/core/discovery/source-resolution.js';
import { submitDiscoveryImports } from '../src/core/discovery/import-bridge.js';
import { buildLiteratureDiscoveryRunPlan, runLiteratureDiscovery } from '../src/core/discovery/workflow.js';
import { loadDiscoveryRun, saveDiscoveryRun } from '../src/core/discovery/store.js';
import { handleMessage } from '../src/mcp/core.js';
import { executeLiteratureDiscoveryTool } from '../src/mcp/tool-literature-discovery.js';
import { createContentSha256, createPaperIdentity } from '../src/lib/paper-identifiers.js';

const originalFetch = globalThis.fetch;

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    async json() {
      return payload;
    }
  };
}

function createJsonStatusResponse(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([['content-type', 'application/json']]),
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function createTextResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/plain']]),
    async text() {
      return payload;
    }
  };
}

function createMarkdownResponse(payload = '') {
  const markdown = payload || [
    '# Test Paper',
    '',
    '## Abstract',
    '',
    'This is a valid paper markdown fixture used by literature discovery tests.',
    '',
    '## Introduction',
    '',
    'The body contains enough text to pass validation and exercise Markdown-first source resolution.'
  ].join('\n');
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/markdown']]),
    async text() {
      return markdown;
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
  const html = `<html><body>HTML full text is available here.</body></html>${' '.repeat(800)}`;
  const buffer = Buffer.from(html);
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    async text() {
      return html;
    },
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
    markdownUrl: overrides.markdownUrl || '',
    markdownUrls: overrides.markdownUrls || [],
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

test('scheduleDiscoveryFetch deduplicates identical in-flight requests', async () => {
  let calls = 0;
  let releaseFetch = () => {};
  let markFetchStarted = () => {};
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => {
        releaseFetch = resolve;
        markFetchStarted();
      });
      return createJsonResponse({ ok: true, source: 'network' });
    };

    const first = scheduleDiscoveryFetch('https://api.openalex.org/works?search=inflight', {
      timeoutMs: 500
    });
    const second = scheduleDiscoveryFetch('https://api.openalex.org/works?search=inflight', {
      timeoutMs: 500
    });

    await fetchStarted;
    releaseFetch();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    assert.equal(calls, 1);
    assert.deepEqual(await firstResponse.json(), { ok: true, source: 'network' });
    assert.deepEqual(await secondResponse.json(), { ok: true, source: 'network' });
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch uses opt-in memory cache for repeated successful requests', async () => {
  let calls = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return createJsonResponse({ calls });
    };

    const first = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=cacheable', {
      timeoutMs: 500,
      discoveryRequestCache: true,
      discoveryRequestCacheTtlMs: 1000
    });
    const second = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=cacheable', {
      timeoutMs: 500,
      discoveryRequestCache: true,
      discoveryRequestCacheTtlMs: 1000
    });

    assert.equal(calls, 1);
    assert.deepEqual(await first.json(), { calls: 1 });
    assert.deepEqual(await second.json(), { calls: 1 });
    const stats = readDiscoveryRequestSchedulerState().requestStats;
    assert.equal(stats.total, 2);
    assert.equal(stats.networkRequests, 1);
    assert.equal(stats.cacheMisses, 1);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMemoryHits, 1);
    assert.equal(stats.cacheDiskHits, 0);
    assert.equal(stats.byProvider[0].provider, 'openalex');
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch persists cached responses across scheduler resets', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-discovery-cache-'));
  let calls = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return createJsonResponse({ calls, source: 'network' });
    };

    const first = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=persistent-cache', {
      timeoutMs: 500,
      discoveryRequestCache: true,
      discoveryRequestCacheTtlMs: 1000,
      discoveryRequestCacheDir: cacheDir
    });

    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return createJsonResponse({ calls, source: 'should-not-run' });
    };

    const second = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=persistent-cache', {
      timeoutMs: 500,
      discoveryRequestCache: true,
      discoveryRequestCacheTtlMs: 1000,
      discoveryRequestCacheDir: cacheDir
    });

    assert.equal(calls, 1);
    assert.deepEqual(await first.json(), { calls: 1, source: 'network' });
    assert.deepEqual(await second.json(), { calls: 1, source: 'network' });
    const state = readDiscoveryRequestSchedulerState();
    assert.ok(state.cacheEntries > 0);
    assert.equal(state.requestStats.total, 1);
    assert.equal(state.requestStats.cacheHits, 1);
    assert.equal(state.requestStats.cacheDiskHits, 1);
    assert.equal(state.requestStats.networkRequests, 0);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch rejects oversized provider responses before caching', async () => {
  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-length', '128']]),
      async text() {
        return 'x'.repeat(128);
      }
    });

    await assert.rejects(
      scheduleDiscoveryFetch('https://api.openalex.org/works?search=oversized', {
        timeoutMs: 500
      }, {}, {
        maxResponseBytes: 64
      }),
      /response-too-large/
    );

    const state = readDiscoveryRequestSchedulerState();
    assert.equal(state.inFlightCount, 0);
    assert.equal(state.requestStats.networkErrors, 1);
    assert.equal(state.requestStats.cacheWrites, 0);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch caps externally configured provider concurrency', async () => {
  let active = 0;
  let maxActive = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return createJsonResponse({ ok: true });
      } finally {
        active -= 1;
      }
    };

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      scheduleDiscoveryFetch(`https://example.org/provider-cap?i=${index}`, {
        timeoutMs: 500,
        providerRequestMaxConcurrent: 999
      }, {}, {
        provider: 'provider-cap'
      })
    )));

    assert.equal(maxActive, 16);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch opens a provider circuit breaker after repeated retryable failures', async () => {
  let calls = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return createJsonStatusResponse(503, { error: 'upstream unavailable' });
    };

    const first = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=circuit-breaker-1', {
      timeoutMs: 500,
      discoveryCircuitBreakerFailureThreshold: 1,
      discoveryCircuitBreakerCooldownMs: 1000
    });

    const second = await scheduleDiscoveryFetch('https://api.openalex.org/works?search=circuit-breaker-2', {
      timeoutMs: 500,
      discoveryCircuitBreakerFailureThreshold: 1,
      discoveryCircuitBreakerCooldownMs: 1000
    });

    assert.equal(calls, 1);
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.match(second.statusText, /provider circuit breaker open/i);
    assert.equal(readDiscoveryRequestSchedulerState().circuitBreakers[0].open, true);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('scheduleDiscoveryFetch can pace OpenAlex requests separately from provider worker delay', async () => {
  const starts = [];

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      starts.push(Date.now());
      return createJsonResponse({ results: [] });
    };

    await scheduleDiscoveryFetch('https://api.openalex.org/works?search=first', {
      timeoutMs: 500,
      openAlexRequestDelayMs: 15,
      openAlexMaxConcurrent: 1
    });
    await scheduleDiscoveryFetch('https://api.openalex.org/works?search=second', {
      timeoutMs: 500,
      openAlexRequestDelayMs: 15,
      openAlexMaxConcurrent: 1
    });

    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 10);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

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

test('buildLiteratureDiscoveryPlan decomposes clue-style live provider queries', () => {
  const plan = buildLiteratureDiscoveryPlan({
    topic: 'Find the paper published at NeurIPS 2024 that uses retrieval augmented generation with graph neural networks for scientific literature review and cites benchmark datasets.',
    depth: 'default',
    queryDecomposition: true
  });

  const families = new Set(plan.queries.map((query) => query.family));
  assert.ok(families.has('clue_entity'));
  assert.ok(families.has('clue_venue_year'));
  assert.ok(families.has('clue_method_task'));
  assert.ok(families.has('clue_citation'));
  assert.ok(plan.queries.some((query) => (
    query.family === 'clue_venue_year'
    && query.decomposition.kind === 'venue_year'
    && query.decomposition.venues.includes('NeurIPS')
    && query.decomposition.years.includes('2024')
    && query.providerAllowList.includes('openalex')
  )));
  assert.ok(plan.queries.every((query) => query.query.length <= 220));
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

test('buildLiteratureDiscoveryRunPlan keeps operation=search rule-based by default', async () => {
  let plannerCalled = false;
  const plan = await buildLiteratureDiscoveryRunPlan({
    operation: 'search',
    topic: 'LLM agents for time series forecasting',
    depth: 'quick',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmQueryPlannerJson: async () => {
      plannerCalled = true;
      return { queries: [{ query: 'should not be used', family: 'direct' }] };
    }
  });

  assert.equal(plannerCalled, false);
  assert.equal(plan.queryPlanner.mode, 'rules');
  assert.equal(plan.queryPlanner.reason, 'search-default-rule-based');
});

test('buildLiteratureDiscoveryRunPlan caps explicit operation=search LLM planning', async () => {
  let capturedConfig = null;
  const plan = await buildLiteratureDiscoveryRunPlan({
    operation: 'search',
    searchMode: 'balanced',
    planningMode: 'llm_augmented',
    topic: 'LLM agents for time series forecasting',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmTimeoutMs: 45000,
    llmQueryPlannerJson: async (prompt, { config }) => {
      capturedConfig = config;
      assert.match(prompt, /Return strict JSON only/);
      return {
        queries: [
          { query: 'autonomous agent forecasting benchmark', family: 'context' },
          { query: 'LLM agent planning evaluation', family: 'context' },
          { query: 'time series foundation models agents', family: 'context' },
          { query: 'agentic forecasting survey', family: 'context' }
        ]
      };
    }
  });

  const llmQueries = plan.queries.filter((query) => String(query.family || '').startsWith('llm_'));
  assert.equal(capturedConfig.timeoutMs, 12000);
  assert.equal(plan.queryPlanner.mode, 'llm');
  assert.equal(plan.queryPlanner.llmQueryCount, 2);
  assert.equal(llmQueries.length, 2);
});

test('buildLiteratureDiscoveryRunPlan caps deep operation=search LLM planning', async () => {
  let capturedConfig = null;
  const plan = await buildLiteratureDiscoveryRunPlan({
    operation: 'search',
    searchMode: 'deep',
    planningMode: 'llm_augmented',
    topic: 'LLM agents for time series forecasting',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmApiKey: 'test-key',
    llmTimeoutMs: 45000,
    llmQueryPlannerJson: async (prompt, { config }) => {
      capturedConfig = config;
      assert.match(prompt, /Return strict JSON only/);
      return {
        queries: [
          { query: 'autonomous agent forecasting benchmark', family: 'context' },
          { query: 'LLM agent planning evaluation', family: 'context' },
          { query: 'time series foundation models agents', family: 'context' },
          { query: 'agentic forecasting survey', family: 'context' },
          { query: 'forecasting agents tool use', family: 'context' },
          { query: 'time series benchmark failure modes', family: 'context' }
        ]
      };
    }
  });

  const llmQueries = plan.queries.filter((query) => String(query.family || '').startsWith('llm_'));
  assert.equal(capturedConfig.timeoutMs, 18000);
  assert.equal(plan.queryPlanner.mode, 'llm');
  assert.equal(plan.queryPlanner.llmQueryCount, 4);
  assert.equal(llmQueries.length, 4);
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

test('executeProviderQueries returns partial diagnostics when budget skips remaining queries', async () => {
  let calls = 0;
  const startedAt = Date.now();

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return createJsonResponse({ results: [] });
    };

    const result = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q1', query: 'first budgeted query', family: 'direct' },
          { id: 'q2', query: 'second budgeted query', family: 'artifact_expansion' }
        ]
      },
      maxResultsPerQuery: 1,
      providerRequestDelayMs: 0,
      retryCount: 0,
      timeoutMs: 100,
      minProviderQueryBudgetMs: 10,
      budget: {
        startedAt,
        deadlineAt: startedAt + 35,
        budgetMs: 35
      }
    });

    assert.equal(calls, 1);
    assert.equal(result.partial, true);
    assert.equal(result.budget.budgetExhausted, true);
    assert.equal(result.queryResults.length, 2);
    assert.equal(result.queryResults[1].skipped, true);
    assert.equal(result.queryResults[1].reason, 'budget_exhausted');
    assert.equal(result.diagnostics.providers[0].truncationReason, 'budget_exhausted');
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries skips remaining provider queries after a search rate limit', async () => {
  let calls = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        async json() {
          return {};
        },
        async text() {
          return '{}';
        }
      };
    };

    const result = await executeProviderQueries({
      providers: ['openalex'],
      plan: {
        queries: [
          { id: 'q1', query: 'quota limited query', family: 'direct' },
          { id: 'q2', query: 'query that should be skipped', family: 'review_expansion' }
        ]
      },
      retryCount: 0,
      skipRemainingProviderQueriesOnRateLimit: true,
      discoveryCircuitBreakerFailureThreshold: 1,
      discoveryCircuitBreakerCooldownMs: 1000
    });

    assert.equal(calls, 1);
    assert.equal(result.partial, true);
    assert.match(result.queryResults[0].reason, /openalex http 429/);
    assert.equal(result.queryResults[1].skipped, true);
    assert.equal(result.queryResults[1].reason, 'provider_rate_limited');
    assert.equal(result.diagnostics.providers[0].rateLimited, 1);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
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

test('default literature discovery providers keep direct papers.cool and PASA opt-in', () => {
  assert.deepEqual(DEFAULT_DISCOVERY_PROVIDERS, ['openalex', 'semantic_scholar', 'crossref', 'arxiv']);
  assert.equal(DEFAULT_DISCOVERY_PROVIDERS.includes('papers_cool'), false);
  assert.equal(DEFAULT_DISCOVERY_PROVIDERS.includes('pasa'), false);
  assert.ok(KNOWN_DISCOVERY_PROVIDERS.has('papers_cool'));
  assert.ok(KNOWN_DISCOVERY_PROVIDERS.has('pasa'));
});

test('executeProviderQueries maps papers.cool search HTML to PDF-ready candidates', async () => {
  resetDiscoveryRequestSchedulerForTests();
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    assert.equal(url.hostname, 'papers.cool');
    assert.equal(url.pathname, '/arxiv/search');
    return createTextResponse(`
<html><body>
  <div class="papers">
    <div id="2602.20400" class="panel paper">
      <h2 class="title">
        <a href="https://arxiv.org/abs/2602.20400" target="_blank"><span class="index notranslate">#1</span></a>
        <a id="title-2602.20400" class="title-link notranslate" href="/arxiv/2602.20400" target="_blank">Papers Cool Retrieval Test</a>
        <a id="pdf-2602.20400" class="title-pdf notranslate" data="https://arxiv.org/pdf/2602.20400">[PDF]</a>
      </h2>
      <p id="authors-2602.20400" class="metainfo authors notranslate"><strong>Authors</strong>:
        <a class="author notranslate">Ada Lovelace</a>
      </p>
      <p id="summary-2602.20400" class="summary notranslate">An arXiv paper discovered through papers.cool.</p>
      <p id="date-2602.20400" class="metainfo date"><strong>Publish</strong>: <span class="date-data">2026-02-20 00:00:00 UTC</span></p>
    </div>
  </div>
</body></html>`);
  };
  try {
    const result = await executeProviderQueries({
      providers: ['papers_cool'],
      maxResultsPerQuery: 1,
      plan: {
        queries: [
          { id: 'q1', query: 'retrieval test', family: 'direct' }
        ]
      }
    });

    assert.equal(result.queryResults[0].ok, true);
    assert.equal(requested[0].searchParams.get('query'), 'retrieval test');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, 'papers_cool');
    assert.equal(result.candidates[0].identifiers.arxivId, '2602.20400');
    assert.equal(result.candidates[0].pdfUrl, 'https://arxiv.org/pdf/2602.20400.pdf');
    assert.ok(result.candidates[0].sourceHints.includes('https://papers.cool/arxiv/2602.20400'));
    assert.deepEqual(result.candidates[0].authors, ['Ada Lovelace']);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries maps direct PASA API results to PDF-ready candidates', async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split('/').pop();
    calls.push({ endpoint, method: init.method, body: JSON.parse(init.body || '{}') });
    assert.equal(url.hostname, 'pasa-agent.ai');
    assert.equal(init.method, 'POST');
    if (endpoint === 'single_paper_agent') return createJsonResponse({ base_resp: { status_code: 0 } });
    return createJsonResponse({
      finish: true,
      papers: JSON.stringify({
        0: {
          entry_id: '2501.00001',
          title: 'PASA Retrieval Test',
          authors: ['Ada Lovelace'],
          publish_time: '2025-01-01',
          score: 0.91,
          abstract: 'A paper found by PASA.',
          json_result: JSON.stringify({
            link: 'https://www.arxiv.org/abs/2501.00001'
          }),
          select_reason: 'true'
        }
      })
    });
  };
  try {
    const result = await executeProviderQueries({
      providers: ['pasa'],
      maxResultsPerQuery: 1,
      plan: {
        queries: [
          { id: 'q1', query: 'pasa retrieval', family: 'direct' }
        ]
      }
    });

    assert.equal(result.queryResults[0].ok, true);
    assert.equal(calls[0].endpoint, 'single_paper_agent');
    assert.equal(calls[1].endpoint, 'single_get_result');
    assert.equal(calls[0].body.user_query, 'pasa retrieval');
    assert.equal(calls[0].body.session_id, calls[1].body.session_id);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, 'pasa');
    assert.equal(result.candidates[0].identifiers.arxivId, '2501.00001');
    assert.equal(result.candidates[0].pdfUrl, 'https://arxiv.org/pdf/2501.00001.pdf');
    assert.equal(result.candidates[0].retrievalEvidence[0].sessionId, calls[0].body.session_id);
    assert.equal(result.candidates[0].retrievalEvidence[0].selectedByPasa, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries caps PASA polling with the remaining search budget', async () => {
  const calls = [];
  const startedAt = Date.now();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split('/').pop();
    calls.push({ endpoint, body: JSON.parse(init.body || '{}') });
    assert.equal(url.hostname, 'pasa-agent.ai');
    if (endpoint === 'single_paper_agent') return createJsonResponse({ base_resp: { status_code: 0 } });
    return createJsonResponse({
      finish: false,
      papers: JSON.stringify({})
    });
  };
  try {
    resetDiscoveryRequestSchedulerForTests();
    const budgetStartedAt = Date.now();
    const result = await executeProviderQueries({
      providers: ['pasa'],
      retryCount: 0,
      maxResultsPerQuery: 1,
      pasaTimeoutSeconds: 30,
      pasaPollIntervalSeconds: 10,
      budgetSafetyMarginMs: 0,
      minProviderQueryBudgetMs: 1,
      budget: {
        startedAt: budgetStartedAt,
        deadlineAt: budgetStartedAt + 40,
        budgetMs: 40
      },
      plan: {
        queries: [
          { id: 'q1', query: 'budgeted pasa retrieval', family: 'direct' }
        ]
      }
    });

    assert.ok(Date.now() - startedAt < 500);
    assert.equal(result.partial, true);
    assert.equal(result.budget.budgetExhausted, true);
    assert.equal(result.queryResults[0].ok, true);
    assert.ok(calls.some((entry) => entry.endpoint === 'single_paper_agent'));
    assert.ok(calls.some((entry) => entry.endpoint === 'single_get_result'));
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('executeProviderQueries reports direct papers.cool HTTP failures without aborting discovery', async () => {
  resetDiscoveryRequestSchedulerForTests();
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: new Map(),
    async text() {
      return 'unavailable';
    }
  });
  try {
    const result = await executeProviderQueries({
      providers: ['papers_cool'],
      plan: {
        queries: [
          { id: 'q1', query: 'temporary service failure', family: 'direct' }
        ]
      }
    });

    assert.equal(result.candidates.length, 0);
    assert.equal(result.queryResults[0].provider, 'papers_cool');
    assert.equal(result.queryResults[0].ok, false);
    assert.match(result.queryResults[0].reason, /papers_cool http 503/);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
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

      if (['huggingface.co', 'arxiv2md.org', 'markxiv.org'].includes(url.hostname)) {
        return {
          ok: false,
          status: 404,
          async text() {
            return 'not found';
          }
        };
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
      providers: ['openalex', 'semantic_scholar', 'crossref', 'arxiv', 'dblp'],
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

test('runLiteratureDiscovery bounds operation=search with rule planning and diagnostics', async () => {
  const rootPath = await createTempCorpus();
  const requestedQueries = [];
  let plannerCalled = false;

  try {
    resetDiscoveryRequestSchedulerForTests();
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
      operation: 'search',
      topic: 'Find the ICLR 2024 paper about long-context retrieval augmented generation benchmark failures and graph neural reranking.',
      providers: ['openalex'],
      providerRequestDelayMs: 0,
      discoveryRequestCache: false,
      searchBudgetMs: 1000,
      minProviderQueryBudgetMs: 10,
      resolveSources: false,
      persist: false,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmApiKey: 'test-key',
      llmQueryPlannerJson: async () => {
        plannerCalled = true;
        return { queries: [{ query: 'should not be planned by default', family: 'direct' }] };
      }
    });

    assert.equal(plannerCalled, false);
    assert.equal(run.plan.queryPlanner.mode, 'rules');
    assert.equal(run.plan.queryPlanner.reason, 'search-default-rule-based');
    assert.ok(run.plan.queries.length <= 6);
    assert.equal(requestedQueries.length, 3);
    assert.equal(run.budget.budgetMs, 1000);
    assert.equal(run.diagnostics.searchMode, 'balanced');
    assert.equal(run.diagnostics.providers[0].scheduledQueries, 3);
    assert.ok(run.diagnostics.providers[0].skippedQueries > 0);
    assert.equal(run.partial, true);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery applies quick search caps while deep search preserves larger plans', async () => {
  const rootPath = await createTempCorpus();
  const requestedQueries = [];

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.openalex.org') {
        requestedQueries.push(url.searchParams.get('search') || '');
        return createJsonResponse({ results: [] });
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const topic = 'ICLR 2024 long-context retrieval benchmark failure cases transformer reranking';
    const quick = await runLiteratureDiscovery({
      rootPath,
      operation: 'search',
      searchMode: 'quick',
      topic,
      providers: ['openalex'],
      providerRequestDelayMs: 0,
      discoveryRequestCache: false,
      resolveSources: false,
      persist: false
    });
    const quickRequestCount = requestedQueries.length;

    const deep = await runLiteratureDiscovery({
      rootPath,
      operation: 'search',
      searchMode: 'deep',
      topic,
      providers: ['openalex'],
      providerRequestDelayMs: 0,
      discoveryRequestCache: false,
      resolveSources: false,
      persist: false
    });

    assert.equal(quick.budget.budgetMs, 25000);
    assert.equal(quick.diagnostics.searchMode, 'quick');
    assert.equal(quick.diagnostics.planning.queryLimit.maxQueries, 4);
    assert.equal(quick.diagnostics.planning.queryLimit.truncated, true);
    assert.ok(quick.plan.queries.length <= 4);
    assert.equal(quick.diagnostics.providers[0].scheduledQueries, 2);
    assert.ok(quick.diagnostics.skipped.some((entry) => entry.reason === 'search_query_limit'));
    assert.equal(quick.partial, true);

    assert.equal(deep.budget.budgetMs, 600000);
    assert.equal(deep.diagnostics.searchMode, 'deep');
    assert.equal(deep.diagnostics.planning.queryLimit.applied, true);
    assert.equal(deep.diagnostics.planning.queryLimit.maxQueries, 10);
    assert.ok(deep.plan.queries.length <= 10);
    assert.ok(deep.plan.queries.length > quick.plan.queries.length);
    assert.ok(deep.diagnostics.providers[0].scheduledQueries > quick.diagnostics.providers[0].scheduledQueries);
    assert.equal(requestedQueries.length - quickRequestCount, deep.diagnostics.providers[0].scheduledQueries);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('runLiteratureDiscovery operation=search defaults to zero provider retries', async () => {
  const rootPath = await createTempCorpus();
  let calls = 0;

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async () => {
      calls += 1;
      return createJsonStatusResponse(500, { error: 'temporary provider failure' });
    };

    const run = await runLiteratureDiscovery({
      rootPath,
      operation: 'search',
      topic: 'retry bounded search benchmark failure query',
      providers: ['openalex'],
      providerRequestDelayMs: 0,
      discoveryRequestCache: false,
      discoveryCircuitBreakerFailureThreshold: 100,
      searchBudgetMs: 5000,
      minProviderQueryBudgetMs: 1,
      resolveSources: false,
      persist: false
    });

    assert.ok(run.diagnostics.providers[0].scheduledQueries > 0);
    assert.equal(calls, run.diagnostics.providers[0].scheduledQueries);
    assert.equal(run.diagnostics.providers[0].failedQueries, run.diagnostics.providers[0].scheduledQueries);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
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
      if (['huggingface.co', 'arxiv2md.org', 'markxiv.org'].includes(url.hostname)) {
        return {
          ok: false,
          status: 404,
          async text() {
            return 'not found';
          }
        };
      }
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

test('resolveDiscoverySources downloads Markdown before trying PDF fallback', async () => {
  const rootPath = await createTempCorpus();
  const requestedPaths = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith('.md')) {
        return createMarkdownResponse('# Markdown First Paper\n\n## Abstract\n\nThis Markdown source should be preferred over PDF fallback.\n\n## Introduction\n\nEnough valid body text is present for the source validator to accept the paper markdown.');
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      candidates: [
        createDiscoveryCandidate({
          provider: 'openalex',
          title: 'Markdown First Paper',
          identifiers: { doi: '10.7777/markdown.first' },
          markdownUrl: 'https://example.org/markdown-first.md',
          pdfUrl: 'https://example.org/markdown-first.pdf'
        })
      ]
    });

    const source = result.candidates[0].source;
    assert.equal(source.sourceKind, 'markdown');
    assert.equal(source.fullTextStatus, 'open_markdown');
    assert.equal(source.downloadStatus, 'downloaded');
    assert.ok(source.localMarkdownPath.endsWith('.md'));
    assert.ok(await fs.stat(source.localMarkdownPath));
    assert.deepEqual(requestedPaths, ['/markdown-first.md']);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources falls back to PDF when Markdown is unavailable', async () => {
  const rootPath = await createTempCorpus();
  const requestedPaths = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname.endsWith('.md')) {
        return {
          ok: false,
          status: 404,
          async text() {
            return 'not found';
          }
        };
      }
      if (url.pathname.endsWith('.pdf')) {
        return createPdfResponse();
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      candidates: [
        createDiscoveryCandidate({
          provider: 'openalex',
          title: 'PDF Fallback Paper',
          identifiers: { doi: '10.7777/pdf.fallback' },
          markdownUrl: 'https://example.org/pdf-fallback.md',
          pdfUrl: 'https://example.org/pdf-fallback.pdf'
        })
      ]
    });

    const source = result.candidates[0].source;
    assert.equal(source.sourceKind, 'pdf');
    assert.equal(source.fullTextStatus, 'open_pdf');
    assert.equal(source.downloadStatus, 'downloaded');
    assert.ok(source.localPdfPath.endsWith('.pdf'));
    assert.deepEqual(requestedPaths, ['/pdf-fallback.md', '/pdf-fallback.pdf']);
    assert.ok(source.resolutionAttempts.some((attempt) => attempt.sourceKind === 'markdown' && attempt.status === 'failed'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources rejects oversized downloads without failing the run', async () => {
  const rootPath = await createTempCorpus();

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('.md')) {
        return createMarkdownResponse('# Oversized Markdown\n\n## Abstract\n\nThis response should exceed the configured byte limit before it is accepted as a paper source.');
      }
      if (url.pathname.endsWith('.pdf')) {
        return createPdfResponse();
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      maxMarkdownDownloadBytes: 96,
      maxPdfDownloadBytes: 96,
      candidates: [
        createDiscoveryCandidate({
          provider: 'openalex',
          title: 'Oversized Download Paper',
          identifiers: { doi: '10.7777/oversized.download' },
          markdownUrl: 'https://example.org/oversized.md',
          pdfUrl: 'https://example.org/oversized.pdf'
        })
      ]
    });

    const source = result.candidates[0].source;
    assert.equal(source.resolutionStatus, 'metadata_only');
    assert.equal(source.downloadStatus, 'failed');
    assert.match(source.downloadError, /download-too-large/);
    assert.equal(source.resolutionAttempts.length, 2);
    assert.ok(source.resolutionAttempts.every((attempt) => attempt.status === 'failed'));
    assert.ok(source.resolutionAttempts.every((attempt) => /download-too-large/.test(attempt.detail)));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources keeps generated arXiv Markdown sources opt-in', async () => {
  const rootPath = await createTempCorpus();
  const requested = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === 'arxiv.org' && url.pathname === '/pdf/2602.20400.pdf') {
        return createPdfResponse();
      }
      assert.fail(`unexpected generated Markdown request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      candidates: [
        createDiscoveryCandidate({
          provider: 'arxiv',
          title: 'Default arXiv PDF Paper',
          identifiers: { arxivId: '2602.20400' }
        })
      ]
    });

    assert.equal(result.candidates[0].source.sourceKind, 'pdf');
    assert.equal(result.candidates[0].source.fullTextStatus, 'open_pdf');
    assert.deepEqual(requested.map((url) => `${url.hostname}${url.pathname}`), [
      'arxiv.org/pdf/2602.20400.pdf'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources tries generated arXiv Markdown sources when enabled', async () => {
  const rootPath = await createTempCorpus();
  const requested = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === 'huggingface.co' && url.pathname === '/papers/2602.20400.md') {
        return createMarkdownResponse('# Generated arXiv Markdown\n\n## Abstract\n\nThis generated Markdown fixture should be accepted before PDF fallback.\n\n## Introduction\n\nThe body contains enough text to pass validation and exercise opt-in generated arXiv Markdown source resolution.');
      }
      assert.fail(`unexpected generated Markdown request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      generateArxivMarkdownSources: true,
      candidates: [
        createDiscoveryCandidate({
          provider: 'arxiv',
          title: 'Generated arXiv Markdown Paper',
          identifiers: { arxivId: '2602.20400' }
        })
      ]
    });

    assert.equal(result.candidates[0].source.sourceKind, 'markdown');
    assert.equal(result.candidates[0].source.fullTextStatus, 'open_markdown');
    assert.deepEqual(requested.map((url) => `${url.hostname}${url.pathname}`), [
      'huggingface.co/papers/2602.20400.md'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources continues after generated Markdown fetch failures', async () => {
  const rootPath = await createTempCorpus();
  const requested = [];

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.hostname === 'huggingface.co' && url.pathname === '/papers/2602.20400.md') {
        throw new TypeError('fetch failed');
      }
      if (url.hostname === 'arxiv2md.org' && url.pathname === '/api/markdown') {
        return createMarkdownResponse('# Fallback Generated Markdown\n\n## Abstract\n\nThe first generated Markdown provider failed, so source resolution should continue to the next provider.\n\n## Introduction\n\nThe fallback Markdown contains enough body text to pass validation and avoid falling back to PDF.');
      }
      assert.fail(`unexpected generated Markdown request ${url.toString()}`);
    };

    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      generateArxivMarkdownSources: true,
      candidates: [
        createDiscoveryCandidate({
          provider: 'arxiv',
          title: 'Generated arXiv Markdown Fallback Paper',
          identifiers: { arxivId: '2602.20400' }
        })
      ]
    });

    const source = result.candidates[0].source;
    assert.equal(source.sourceKind, 'markdown');
    assert.equal(source.sourceProvider, 'arxiv2md-api');
    assert.equal(source.fullTextStatus, 'open_markdown');
    assert.deepEqual(requested.map((url) => `${url.hostname}${url.pathname}`), [
      'huggingface.co/papers/2602.20400.md',
      'arxiv2md.org/api/markdown'
    ]);
    assert.equal(source.resolutionAttempts[0].status, 'failed');
    assert.match(source.resolutionAttempts[0].detail, /^fetch-failed:/);
    assert.equal(source.resolutionAttempts[1].status, 'success');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources preserves metadata-only candidates with a supplement interface', async () => {
  const rootPath = await createTempCorpus();

  try {
    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      candidates: [
        createDiscoveryCandidate({
          provider: 'crossref',
          title: 'Metadata Only Paper',
          identifiers: { doi: '10.7777/metadata.only' }
        })
      ]
    });

    const source = result.candidates[0].source;
    assert.equal(source.resolutionStatus, 'metadata_only');
    assert.equal(source.supplementation.status, 'needed');
    assert.equal(source.supplementation.reservedOperation, 'supplement');
    assert.ok(source.supplementation.acceptedSourceKinds.includes('markdown'));
  } finally {
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

test('resolveDiscoverySources uses browser-session downloader when institutional browser mode is enabled', async () => {
  const rootPath = await createTempCorpus();
  const calls = [];

  try {
    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      institutionalAccessMode: 'headless-browser',
      candidates: [
        createDiscoveryCandidate({
          provider: 'crossref',
          title: 'Subscription Browser Session Paper',
          identifiers: { doi: '10.1021/browser.session' },
          landingPageUrl: 'https://pubs.acs.org/doi/10.1021/browser.session'
        })
      ],
      browserSessionDownloader: async (candidate, outputPath) => {
        calls.push({ candidate, outputPath });
        const buffer = Buffer.concat([
          Buffer.from('%PDF-1.7\n'),
          Buffer.alloc(800, 32),
          Buffer.from('\n%%EOF\n')
        ]);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, buffer);
        return {
          ok: true,
          reason: 'pdf-header-ok',
          url: 'https://pubs.acs.org/doi/pdf/10.1021/browser.session',
          strategy: 'browser_context_request',
          contentSha256: createContentSha256(buffer)
        };
      }
    });

    assert.equal(calls.length, 1);
    const source = result.candidates[0].source;
    assert.equal(source.sourceKind, 'pdf');
    assert.equal(source.sourceProvider, 'browser_session');
    assert.equal(source.fullTextStatus, 'open_pdf');
    assert.equal(source.downloadStatus, 'downloaded');
    assert.equal(source.pdfUrl, 'https://pubs.acs.org/doi/pdf/10.1021/browser.session');
    assert.ok(source.localPdfPath.endsWith('.pdf'));
    assert.ok(await fs.stat(source.localPdfPath));
    assert.ok(source.resolutionAttempts.some((attempt) => attempt.provider === 'browser_session' && attempt.status === 'success'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('resolveDiscoverySources records browser-session SSO barriers without throwing', async () => {
  const rootPath = await createTempCorpus();

  try {
    const result = await resolveDiscoverySources({
      rootPath,
      maxDownloads: 1,
      institutionalAccessMode: 'browser-session',
      browserAuthHosts: ['sso.example.edu'],
      candidates: [
        createDiscoveryCandidate({
          provider: 'crossref',
          title: 'SSO Protected Browser Session Paper',
          identifiers: { doi: '10.1002/sso.session' },
          landingPageUrl: 'https://doi.org/10.1002/sso.session'
        })
      ],
      browserSessionDownloader: async () => ({
        ok: false,
        reason: 'institution_auth_redirect',
        url: 'https://sso.example.edu/login',
        strategy: 'browser_article_page',
        accessBarrier: {
          kind: 'sso',
          reason: 'institution_auth_redirect',
          url: 'https://sso.example.edu/login',
          title: 'University Single Sign-On'
        }
      })
    });

    const source = result.candidates[0].source;
    assert.equal(source.resolutionStatus, 'metadata_only');
    assert.equal(source.fullTextStatus, 'needs_institution');
    assert.equal(source.downloadStatus, 'skipped');
    assert.match(source.downloadError, /SSO/);
    assert.equal(source.browserAccessBarriers.length, 1);
    assert.equal(source.browserAccessBarriers[0].kind, 'sso');
    assert.ok(source.resolutionAttempts.some((attempt) => (
      attempt.provider === 'browser_session'
      && attempt.status === 'manual_pending'
      && attempt.accessBarrier?.kind === 'sso'
    )));
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
    assert.equal(run.metadataGraph.partialPaperCount, 1);
    assert.ok(run.metadataGraph.nodes.some((node) => node.type === 'Paper' && node.properties.partial));
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

test('literature_discovery ingest processes downloaded PDFs into the graph', async () => {
  const rootPath = await createTempCorpus();
  const fakeDoclingPath = path.join(rootPath, 'fake-docling.sh');

  try {
    await fs.writeFile(fakeDoclingPath, `#!/bin/sh
input="$1"
shift
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
base=$(basename "$input" .pdf)
mkdir -p "$out"
printf '# %s\\n\\n## Abstract\\n\\nThis imported PDF was parsed during literature discovery ingest.\\n' "$base" > "$out/$base.md"
`, { mode: 0o755 });

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: []
            }
          }
        });
      }
      if (url.hostname === 'example.org') {
        return createPdfResponse();
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = JSON.parse(await executeLiteratureDiscoveryTool({
      operation: 'ingest',
      corpus: rootPath,
      topic: 'discovery ingest test',
      providers: ['dblp'],
      llmQueryPlanner: false,
      seedPapers: [{
        title: 'Discovery Ingest Test Paper',
        doi: '10.5555/ingest-test',
        pdfUrl: 'https://example.org/ingest-test.pdf'
      }],
      maxResultsPerQuery: 1,
      maxDownloads: 1,
      maxImported: 1,
      importMaxPasses: 1,
      semanticExtraction: 'heuristic-only',
      pdfParser: 'docling',
      doclingCommand: fakeDoclingPath
    }));

    assert.equal(run.importSummary.completed, 1);
    assert.equal(run.importSummary.processing.completedTaskIds.length, 1);
    assert.equal(run.coverage.importedCount, 1);
    assert.equal(run.candidates[0].import.status, 'completed');
    assert.equal(run.candidates[0].import.graphUpdate.paperCount, 1);

    const { loadCorpusLite } = await import('../src/storage/corpus-store.js');
    const corpus = await loadCorpusLite(rootPath);
    assert.equal(corpus.meta.paperCount, 1);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature_discovery ingest processes downloaded Markdown into the graph', async () => {
  const rootPath = await createTempCorpus();

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: []
            }
          }
        });
      }
      if (url.hostname === 'example.org' && url.pathname.endsWith('.md')) {
        return createMarkdownResponse([
          '# Discovery Markdown Ingest Test Paper',
          '',
          '## Abstract',
          '',
          'This imported Markdown was retrieved during literature discovery ingest.',
          '',
          '## Introduction',
          '',
          'The Markdown path should bypass PDF conversion and still create a Paper node in the graph.'
        ].join('\n'));
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = JSON.parse(await executeLiteratureDiscoveryTool({
      operation: 'ingest',
      corpus: rootPath,
      topic: 'discovery markdown ingest test',
      providers: ['dblp'],
      llmQueryPlanner: false,
      seedPapers: [{
        title: 'Discovery Markdown Ingest Test Paper',
        doi: '10.5555/markdown-ingest-test',
        markdownUrl: 'https://example.org/markdown-ingest-test.md',
        pdfUrl: 'https://example.org/markdown-ingest-test.pdf'
      }],
      maxResultsPerQuery: 1,
      maxDownloads: 1,
      maxImported: 1,
      importMaxPasses: 1,
      semanticExtraction: 'heuristic-only'
    }));

    assert.equal(run.candidates[0].source.sourceKind, 'markdown');
    assert.equal(run.candidates[0].source.fullTextStatus, 'open_markdown');
    assert.equal(run.importSummary.completed, 1);
    assert.equal(run.coverage.importedCount, 1);
    assert.equal(run.candidates[0].import.status, 'completed');
    assert.equal(run.candidates[0].import.graphUpdate.paperCount, 1);

    const { loadCorpusLite } = await import('../src/storage/corpus-store.js');
    const corpus = await loadCorpusLite(rootPath);
    assert.equal(corpus.meta.paperCount, 1);
    assert.ok(corpus.graph.nodes.some((node) => node.type === 'Paper'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('submitDiscoveryImports preserves top-level candidate identifiers in import tasks', async () => {
  const rootPath = await createTempCorpus();
  const sourcePath = path.join(rootPath, 'top-level-identifiers.md');

  try {
    await fs.writeFile(sourcePath, [
      '# Top-Level Identifier Import',
      '',
      '## Abstract',
      '',
      'This fixture validates direct literature discovery import metadata.'
    ].join('\n'), 'utf8');

    const result = await submitDiscoveryImports({
      corpus: rootPath,
      maxImported: 1,
      candidates: [{
        id: 'candidate:top-level-identifiers',
        title: 'Top-Level Identifier Import',
        doi: 'https://doi.org/10.5555/top-level-import',
        arxiv_id: '2403.01234',
        source: {
          resolution_status: 'fulltext_ready',
          source_path: sourcePath,
          source_provider: 'fixture-provider'
        }
      }]
    });

    assert.equal(result.submitted, 1);
    assert.equal(result.results[0].identifiers.doi, '10.5555/top-level-import');
    assert.equal(result.results[0].identifiers.arxivId, '2403.01234');

    const { loadImportTask } = await import('../src/storage/import-store.js');
    const task = await loadImportTask(rootPath, result.results[0].taskId);
    assert.equal(task.files[0].paperMetadata.identifiers.doi, '10.5555/top-level-import');
    assert.equal(task.files[0].paperMetadata.identifiers.arxivId, '2403.01234');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature_discovery inline import processing batches multiple imports by default', async () => {
  const rootPath = await createTempCorpus();
  const inputRoot = path.join(rootPath, 'seed-input');

  try {
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.writeFile(
      path.join(inputRoot, 'seed.md'),
      '# Default Batch Seed\n\n## Abstract\n\nSeed corpus used to validate default MCP import batching.\n',
      'utf8'
    );
    const { analyzeCorpus } = await import('../src/core/ingestion/pipeline.js');
    await analyzeCorpus(inputRoot, {
      rootPath,
      name: 'literature-discovery-default-batch-test',
      force: true,
      quiet: true,
      semanticExtraction: 'heuristic-only'
    });

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: []
            }
          }
        });
      }
      if (url.hostname === 'example.org' && url.pathname.endsWith('/one.md')) {
        return createMarkdownResponse([
          '# Default Batch Import One',
          '',
          '## Abstract',
          '',
          'The first Markdown paper should be imported through the default MCP batch path.',
          '',
          '## Introduction',
          '',
          'This body gives the importer enough text to build a paper node.'
        ].join('\n'));
      }
      if (url.hostname === 'example.org' && url.pathname.endsWith('/two.md')) {
        return createMarkdownResponse([
          '# Default Batch Import Two',
          '',
          '## Abstract',
          '',
          'The second Markdown paper should share a logical import batch with the first paper.',
          '',
          '## Introduction',
          '',
          'This body gives the importer enough text to build another paper node.'
        ].join('\n'));
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const run = JSON.parse(await executeLiteratureDiscoveryTool({
      operation: 'ingest',
      corpus: rootPath,
      topic: 'default import batch test',
      providers: ['dblp'],
      llmQueryPlanner: false,
      seedPapers: [
        {
          title: 'Default Batch Import One',
          doi: '10.5555/default-batch-one',
          markdownUrl: 'https://example.org/one.md'
        },
        {
          title: 'Default Batch Import Two',
          doi: '10.5555/default-batch-two',
          markdownUrl: 'https://example.org/two.md'
        }
      ],
      maxResultsPerQuery: 1,
      maxDownloads: 2,
      maxImported: 2,
      semanticExtraction: 'heuristic-only'
    }));

    assert.equal(run.importSummary.completed, 2);
    assert.equal(run.importSummary.processing.completedTaskIds.length, 2);

    const taskIds = run.candidates.map((candidate) => candidate.import?.taskId).filter(Boolean);
    assert.equal(taskIds.length, 2);

    const { loadImportTask } = await import('../src/storage/import-store.js');
    const tasks = await Promise.all(taskIds.map((taskId) => loadImportTask(rootPath, taskId)));
    assert.deepEqual(tasks.map((task) => task.status), ['completed', 'completed']);

    const batchIds = new Set(tasks.map((task) => task.result?.batch?.batchId).filter(Boolean));
    assert.equal(batchIds.size, 1);
    assert.match([...batchIds][0], /^impbatch:/);

    const batchTaskIds = new Set(tasks[0].result.fastCommitted.batchTaskIds);
    assert.equal(taskIds.every((taskId) => batchTaskIds.has(taskId)), true);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature_discovery supplement attaches a later Markdown source to a metadata-only candidate', async () => {
  const rootPath = await createTempCorpus();
  const supplementalMarkdownPath = path.join(rootPath, 'supplemental-source.md');

  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'dblp.org') {
        return createJsonResponse({
          result: {
            hits: {
              hit: []
            }
          }
        });
      }
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const initialRun = await runLiteratureDiscovery({
      rootPath,
      topic: 'supplement source later',
      providers: ['dblp'],
      llmQueryPlanner: false,
      seedPapers: [{
        title: 'Supplement Later Paper',
        doi: '10.5555/supplement-later'
      }],
      maxResultsPerQuery: 1,
      maxDownloads: 0,
      resolveSources: false
    });

    await fs.writeFile(supplementalMarkdownPath, [
      '# Supplement Later Paper',
      '',
      '## Abstract',
      '',
      'This Markdown source was supplied after the initial metadata-only discovery run.',
      '',
      '## Introduction',
      '',
      'The supplement operation should update source metadata without requiring a new discovery search.'
    ].join('\n'));

    const supplementedRun = JSON.parse(await executeLiteratureDiscoveryTool({
      operation: 'supplement',
      corpus: rootPath,
      runId: initialRun.runId,
      canonicalId: 'doi:10.5555/supplement-later',
      sourcePath: supplementalMarkdownPath,
      sourceProvider: 'manual_test'
    }));

    assert.equal(supplementedRun.candidates[0].source.sourceKind, 'markdown');
    assert.equal(supplementedRun.candidates[0].source.fullTextStatus, 'open_markdown');
    assert.equal(supplementedRun.candidates[0].source.supplementation.status, 'complete');
    assert.equal(supplementedRun.metadataGraph.partialPaperCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature_discovery supplement import does not fan out across candidates without canonical ids', async () => {
  const rootPath = await createTempCorpus();
  const supplementalMarkdownPath = path.join(rootPath, 'supplemental-no-canonical.md');

  try {
    const run = {
      runId: 'disc-no-canonical-import-map',
      generatedAt: new Date('2026-05-19T00:00:00.000Z').toISOString(),
      topic: 'supplement import mapping without canonical ids',
      candidates: [{
        candidate_id: '10.5555/candidate-id-collision',
        title: 'Title Collision Without Canonical Id',
        identifiers: {
          doi: '10.5555/no-canonical-importable'
        },
        providers: ['fixture-provider'],
        source: {
          resolutionStatus: 'metadata_only',
          sourceKind: 'metadata_only',
          fullTextStatus: 'unknown'
        }
      }, {
        id: 'candidate:no-canonical-metadata',
        title: 'Title Collision Without Canonical Id',
        identifiers: {
          doi: '10.5555/candidate-id-collision'
        },
        providers: ['fixture-provider'],
        source: {
          resolutionStatus: 'metadata_only',
          sourceKind: 'metadata_only',
          fullTextStatus: 'unknown'
        }
      }],
      coverage: {
        candidateCount: 2,
        resolvedFullTextCount: 0,
        metadataOnlyCount: 2
      }
    };
    await saveDiscoveryRun(rootPath, run);
    await fs.writeFile(supplementalMarkdownPath, [
      '# Title Collision Without Canonical Id',
      '',
      '## Abstract',
      '',
      'This Markdown source lets the supplement import path submit one candidate only.',
      '',
      '## Introduction',
      '',
      'The second candidate has no canonical id and must not inherit the import result.'
    ].join('\n'));

    const supplementedRun = JSON.parse(await executeLiteratureDiscoveryTool({
      operation: 'supplement',
      corpus: rootPath,
      runId: run.runId,
      candidateId: '10.5555/candidate-id-collision',
      sourcePath: supplementalMarkdownPath,
      sourceProvider: 'manual_test',
      importResolved: true
    }));

    assert.equal(supplementedRun.candidates[0].import.status, 'submitted');
    assert.ok(supplementedRun.candidates[0].import.taskId);
    assert.equal(supplementedRun.candidates[1].import, undefined);
  } finally {
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
  assert.ok(tool.inputSchema.properties.operation.enum.includes('ingest'));
  assert.ok(tool.inputSchema.properties.operation.enum.includes('supplement'));
  assert.ok(tool.inputSchema.properties.seedPapers);
  assert.ok(tool.inputSchema.properties.entitySeeds);
  assert.ok(tool.inputSchema.properties.datasetSeeds);
  assert.ok(tool.inputSchema.properties.seedTexts);
  assert.ok(tool.inputSchema.properties.providerConcurrency);
  assert.ok(tool.inputSchema.properties.providerRequestSchedulerDelayMs);
  assert.ok(tool.inputSchema.properties.providerRequestMaxConcurrent);
  assert.ok(tool.inputSchema.properties.discoveryRequestCache);
  assert.ok(tool.inputSchema.properties.discoveryRequestCacheTtlMs);
  assert.ok(tool.inputSchema.properties.openAlexRequestDelayMs);
  assert.ok(tool.inputSchema.properties.openAlexMaxConcurrent);
  assert.ok(tool.inputSchema.properties.semanticScholarRequestDelayMs);
  assert.ok(tool.inputSchema.properties.semanticScholarMaxConcurrent);
  assert.ok(tool.inputSchema.properties.papersCoolBaseUrl);
  assert.ok(tool.inputSchema.properties.papersCoolMaxQueries);
  assert.ok(tool.inputSchema.properties.pasaApiBaseUrl);
  assert.ok(tool.inputSchema.properties.pasaRequestTimeoutMs);
  assert.ok(tool.inputSchema.properties.pasaTimeoutSeconds);
  assert.ok(tool.inputSchema.properties.pasaMaxQueries);
  assert.ok(tool.inputSchema.properties.preferMarkdown);
  assert.ok(tool.inputSchema.properties.generateArxivMarkdownSources);
  assert.ok(tool.inputSchema.properties.markdownStagingRoot);
  assert.ok(tool.inputSchema.properties.markdownUrl);
  assert.ok(tool.inputSchema.properties.sourcePath);
  assert.ok(tool.inputSchema.properties.sourceKind);
  assert.ok(tool.inputSchema.properties.downloadConcurrency);
  assert.ok(tool.inputSchema.properties.retryCount);
  assert.ok(tool.inputSchema.properties.providerRequestDelayMs);
  assert.ok(tool.inputSchema.properties.maxRetryAfterMs);
  assert.ok(tool.inputSchema.properties.processImports);
  assert.ok(tool.inputSchema.properties.importBatchInitialTasks);
  assert.ok(tool.inputSchema.properties.importBatchProgressive);
  assert.ok(tool.inputSchema.properties.importMaxPasses);
  assert.ok(tool.inputSchema.properties.semanticExtraction);
  assert.ok(tool.inputSchema.properties.pdfParser);
  assert.ok(tool.inputSchema.properties.doclingCommand);
  assert.ok(tool.inputSchema.properties.openAlexApiKey);
  assert.ok(tool.inputSchema.properties.openAlexApiKeyFile);
  assert.ok(tool.inputSchema.properties.semanticScholarApiKey);
  assert.ok(tool.inputSchema.properties.openAlexRelatedExpansion);
  assert.ok(tool.inputSchema.properties.maxRelatedPerSeed);
});

test('literature_discovery reads provider credentials from runtime config', async () => {
  const rootPath = await createTempCorpus();
  const requests = [];

  function headerValue(headers = {}, name = '') {
    const target = name.toLowerCase();
    if (typeof headers.get === 'function') return headers.get(name) || headers.get(target) || '';
    return Object.entries(headers || {}).find(([key, value]) => (
      String(key || '').toLowerCase() === target && String(value || '').trim()
    ))?.[1] || '';
  }

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({
        host: url.hostname,
        apiKey: url.searchParams.get('api_key') || '',
        mailto: url.searchParams.get('mailto') || '',
        semanticScholarApiKey: headerValue(init.headers, 'x-api-key'),
        authorization: headerValue(init.headers, 'authorization')
      });

      if (url.hostname === 'api.openalex.org') return createJsonResponse({ results: [] });
      if (url.hostname === 'api.semanticscholar.org') return createJsonResponse({ data: [] });
      if (url.hostname === 'api.core.ac.uk') return createJsonResponse({ results: [] });
      assert.fail(`unexpected request ${url.toString()}`);
    };

    const output = await executeLiteratureDiscoveryTool({
      corpus: rootPath,
      operation: 'search',
      topic: 'provider credentials from config',
      providers: ['openalex', 'semantic_scholar', 'core'],
      maxQueries: 1,
      maxResultsPerQuery: 1,
      citationExpansion: false,
      persist: false
    }, {
      config: {
        literatureDiscovery: {
          mailto: 'paper@example.com',
          openAlexApiKey: 'openalex-config-key',
          semanticScholarApiKey: 's2-config-key',
          coreApiKey: 'core-config-key',
          providerConcurrency: 1,
          discoveryRequestCache: false
        }
      }
    });
    const run = JSON.parse(output);

    assert.deepEqual(run.providers, ['openalex', 'semantic_scholar', 'core']);
    assert.equal(requests.find((entry) => entry.host === 'api.openalex.org')?.apiKey, 'openalex-config-key');
    assert.equal(requests.find((entry) => entry.host === 'api.openalex.org')?.mailto, 'paper@example.com');
    assert.equal(requests.find((entry) => entry.host === 'api.semanticscholar.org')?.semanticScholarApiKey, 's2-config-key');
    assert.equal(requests.find((entry) => entry.host === 'api.core.ac.uk')?.authorization, 'Bearer core-config-key');
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
