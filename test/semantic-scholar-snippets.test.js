import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeS2FieldOfStudy,
  searchSemanticScholarSnippets
} from '../src/core/discovery/semantic-scholar-snippets.js';
import { resetDiscoveryRequestSchedulerForTests } from '../src/core/discovery/request-scheduler.js';

const originalFetch = globalThis.fetch;

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null, entries: () => [][Symbol.iterator]() },
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    }
  };
}

test('normalizeS2FieldOfStudy maps fine-grained AI domains to Semantic Scholar fields', () => {
  assert.equal(normalizeS2FieldOfStudy('Natural Language Processing'), 'Computer Science');
  assert.equal(normalizeS2FieldOfStudy('biomedicine'), 'Medicine');
  assert.equal(normalizeS2FieldOfStudy('Psychology'), 'Psychology');
});

test('searchSemanticScholarSnippets calls snippet search with field filter and abstract fallback', async () => {
  const requests = [];
  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith('/snippet/search')) {
        assert.equal(url.searchParams.get('query'), 'adaptive collaboration');
        assert.equal(url.searchParams.get('fieldsOfStudy'), 'Computer Science');
        assert.equal(url.searchParams.get('limit'), '2');
        assert.ok(url.searchParams.get('fields').includes('paper.publicationDate'));
        return createJsonResponse({
          retrievalVersion: 'test-snippets',
          data: [{
            score: 0.92,
            paper: {
              corpusId: '123',
              title: 'Adaptive Collaboration'
            },
            snippet: {
              text: 'Adaptive Collaboration',
              snippetKind: 'title'
            }
          }]
        });
      }
      if (url.pathname.includes('/paper/')) {
        return createJsonResponse({
          corpusId: '123',
          title: 'Adaptive Collaboration',
          abstract: 'Adaptive systems can update interaction policies as collaborators change goals and constraints.',
          year: 2024,
          publicationDate: '2024-06-01',
          publicationDateOrYear: '2024-06-01',
          fieldsOfStudy: ['Computer Science']
        });
      }
      assert.fail(`Unexpected request ${url.toString()}`);
    };

    const result = await searchSemanticScholarSnippets({
      query: 'adaptive collaboration',
      fieldsOfStudy: ['Natural Language Processing'],
      limit: 2,
      timeoutMs: 2000,
      retryCount: 0
    });

    assert.equal(result.contractVersion, 'semantic-scholar-snippets-v1');
    assert.equal(result.fieldsOfStudy[0], 'Computer Science');
    assert.equal(result.resultCount, 1);
    assert.equal(result.abstractFallbackCount, 1);
    assert.match(result.results[0].text, /update interaction policies/);
    assert.equal(result.results[0].paper.publicationDate, '2024-06-01');
    assert.equal(requests.length, 2);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});
