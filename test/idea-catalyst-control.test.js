import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runLiveIdeaCatalyst } from '../src/core/graph/idea-catalyst-live.js';
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

function snippet(corpusId, title, text) {
  return {
    score: 0.9,
    paper: {
      corpusId,
      title,
      authors: ['A. Researcher']
    },
    snippet: {
      text,
      snippetKind: 'abstract',
      section: 'Abstract'
    }
  };
}

function makeLlmJson(counter) {
  return async ({ task }) => {
    counter.count += 1;
    if (task === 'decompose') {
      return {
        research_questions: [{
          id: 'q1',
          domain_specific_question: 'How can assistants adapt to shifting intent?',
          domain_agnostic_question: 'How can behavior adapt to shifting collaborators?',
          target_search_queries: ['adaptive intent collaboration']
        }]
      };
    }
    if (task === 'target_assessment') {
      return {
        progress: 'partially addressed',
        remaining_challenges: [{
          id: 'challenge:shift',
          domain_specific_challenge: 'Assistants need robust intent-shift adaptation.',
          domain_agnostic_challenge: 'How can behavior adapt to shifting collaborators?',
          target_evidence_ids: ['target-1']
        }]
      };
    }
    if (task === 'source_domains') {
      return {
        source_domains: [{
          domain: 'Psychology',
          rationale: 'Psychology studies metacontrol under shifting goals.',
          source_search_queries: ['metacontrol shifting goals']
        }]
      };
    }
    if (task === 'source_relevance') {
      return {
        papers: [{ paper_key: 'psy1', relevant: true, reason: 'Metacontrol is transferable.' }]
      };
    }
    if (task === 'source_takeaways') {
      return {
        takeaways: [{
          id: 'takeaway:metacontrol',
          concept: 'Metacontrol switching',
          mechanism: 'Systems switch between persistence and flexibility under changing goals.',
          source_logic: 'Goal regulation provides the transfer mechanism.',
          paper_keys: ['psy1']
        }]
      };
    }
    if (task === 'idea_fragments') {
      return {
        idea_fragments: [{
          id: 'fragment:metacontrol',
          title: 'Metacontrol-inspired intent switching',
          target_challenge_id: 'challenge:shift',
          target_challenge: 'How can behavior adapt to shifting collaborators?',
          source_domain: 'Psychology',
          source_takeaway_ids: ['takeaway:metacontrol'],
          integration_rationale: 'Use metacontrol to decide when to persist or switch assistant goals.',
          novelty_score: 0.7,
          usefulness_score: 0.8,
          supporting_paper_keys: ['psy1']
        }]
      };
    }
    return {};
  };
}

test('live Idea-Catalyst writes resumable LLM ledger and source-backed evidence export', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-idea-control-'));
  const ledgerDir = path.join(tempRoot, 'ledger');

  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/snippet/search'), `Unexpected request ${url.toString()}`);
      const field = url.searchParams.get('fieldsOfStudy');
      if (field === 'Computer Science') {
        return createJsonResponse({
          data: [snippet('target-1', 'Adaptive Assistants', 'Assistants adapt to user intent.')]
        });
      }
      if (field === 'Psychology') {
        return createJsonResponse({
          data: [snippet('psy1', 'Metacontrol', 'Metacontrol balances persistence and flexibility.')]
        });
      }
      assert.fail(`Unexpected field ${field}`);
    };

    const counter = { count: 0 };
    const first = await runLiveIdeaCatalyst({
      problem: 'adaptive human-AI collaboration under shifting intent',
      targetDomain: 'Natural Language Processing',
      numQuestions: 1,
      numSourceDomains: 1,
      maxPapersPerQuery: 5,
      sourceRelevanceThreshold: 0.5,
      llmJson: makeLlmJson(counter),
      llmBatchLedgerDir: ledgerDir,
      llmBatchRunId: 'idea-ledger-test',
      traceId: 'trace:idea-ledger-test',
      retryCount: 0
    });
    const ledgerResults = await fs.readFile(path.join(ledgerDir, 'llm-results.jsonl'), 'utf8');

    assert.equal(first.evidence_export.export_version, 'papernexus-idea-catalyst-evidence-v1');
    assert.equal(first.evidence_export.evidence_status, 'source_backed');
    assert.equal(first.evidence_export.llm_ledger_refs.length, 1);
    assert.match(ledgerResults, /idea_fragments/);
    assert.ok(counter.count >= 6);

    const secondCounter = { count: 0 };
    const second = await runLiveIdeaCatalyst({
      problem: 'adaptive human-AI collaboration under shifting intent',
      targetDomain: 'Natural Language Processing',
      numQuestions: 1,
      numSourceDomains: 1,
      maxPapersPerQuery: 5,
      sourceRelevanceThreshold: 0.5,
      llmJson: makeLlmJson(secondCounter),
      llmBatchLedgerDir: ledgerDir,
      llmBatchRunId: 'idea-ledger-test',
      llmBatchResume: true,
      traceId: 'trace:idea-ledger-test',
      retryCount: 0
    });

    assert.equal(secondCounter.count, 0);
    assert.equal(second.idea_fragments[0].id, 'fragment:metacontrol');
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
