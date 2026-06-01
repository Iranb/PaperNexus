import test from 'node:test';
import assert from 'node:assert/strict';

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

function snippet(corpusId, title, text, score = 0.8, metadata = {}) {
  return {
    score,
    paper: {
      corpusId,
      title,
      authors: ['A. Researcher'],
      ...metadata
    },
    snippet: {
      text,
      snippetKind: 'abstract',
      section: 'Abstract'
    }
  };
}

function makeLlmJson() {
  return async ({ task, prompt }) => {
    if (task === 'decompose') {
      return {
        research_questions: [{
          id: 'q1',
          domain_specific_question: 'How can NLP systems adapt to changing user intent during collaboration?',
          domain_agnostic_question: 'How can behavior adapt to collaborators with changing goals?',
          target_search_queries: ['adaptive user intent collaboration']
        }]
      };
    }
    if (task === 'target_assessment') {
      return {
        progress: 'partially addressed',
        rationale: 'Target snippets discuss adaptation but not cross-collaborator variability.',
        remaining_challenges: [{
          id: 'challenge:intent-adaptation',
          domain_specific_challenge: 'NLP systems need robust real-time adaptation to changing user intent.',
          domain_agnostic_challenge: 'How can behavior adapt to collaborators with changing goals and feedback?',
          rationale: 'The snippets leave collaborator variability unresolved.',
          target_evidence_ids: []
        }]
      };
    }
    if (task === 'source_domains') {
      return {
        source_domains: [
          {
            domain: 'Psychology',
            rationale: 'Psychology studies adaptive goal regulation.',
            source_search_queries: ['goal regulation changing collaborators']
          },
          {
            domain: 'Sociology',
            rationale: 'Sociology studies coordination roles and norms.',
            source_search_queries: ['team coordination role adaptation']
          },
          {
            domain: 'Economics',
            rationale: 'Economics can model incentives but is less directly grounded here.',
            source_search_queries: ['incentives goal adaptation']
          }
        ]
      };
    }
    if (task === 'source_relevance') {
      if (prompt.includes('Source domain: Psychology')) {
        return {
          papers: [
            { paper_key: 'psy1', relevant: true, reason: 'Goal regulation maps to adaptation.' },
            { paper_key: 'psy2', relevant: true, reason: 'Cognitive control maps to changing goals.' },
            { paper_key: 'psy3', relevant: false, reason: 'Too generic.' }
          ]
        };
      }
      if (prompt.includes('Source domain: Sociology')) {
        return {
          papers: [
            { paper_key: 'soc1', relevant: true, reason: 'Role adaptation is transferable.' },
            { paper_key: 'soc2', relevant: true, reason: 'Coordination norms are transferable.' }
          ]
        };
      }
      return {
        papers: [
          { paper_key: 'eco1', relevant: false, reason: 'Not conceptually grounded.' },
          { paper_key: 'eco2', relevant: false, reason: 'Not conceptually grounded.' }
        ]
      };
    }
    if (task === 'source_takeaways') {
      if (prompt.includes('Source domain: Psychology')) {
        return {
          takeaways: [{
            id: 'takeaway:psych-control',
            concept: 'Metacontrol balance',
            mechanism: 'Adaptive behavior balances persistence and flexibility as goals change.',
            source_logic: 'Goal regulation can switch modes while preserving task focus.',
            paper_keys: ['psy1', 'psy2']
          }]
        };
      }
      return {
        takeaways: [{
          id: 'takeaway:soc-roles',
          concept: 'Role renegotiation',
          mechanism: 'Teams renegotiate roles when coordination demands shift.',
          source_logic: 'Coordination remains stable by changing local responsibilities.',
          paper_keys: ['soc1', 'soc2']
        }]
      };
    }
    if (task === 'idea_fragments') {
      return {
        idea_fragments: [
          {
            id: 'fragment:psych',
            title: 'Metacontrol-inspired intent adaptation',
            target_challenge_id: 'challenge:intent-adaptation',
            target_challenge: 'How can behavior adapt to collaborators with changing goals and feedback?',
            source_domain: 'Psychology',
            source_takeaway_ids: ['takeaway:psych-control'],
            integration_rationale: 'Use metacontrol to decide when an NLP assistant should persist or switch goals.',
            novelty_score: 0.76,
            usefulness_score: 0.72,
            supporting_paper_keys: ['psy1', 'psy2']
          },
          {
            id: 'fragment:soc',
            title: 'Role-renegotiation interface policy',
            target_challenge_id: 'challenge:intent-adaptation',
            target_challenge: 'How can behavior adapt to collaborators with changing goals and feedback?',
            source_domain: 'Sociology',
            source_takeaway_ids: ['takeaway:soc-roles'],
            integration_rationale: 'Map role renegotiation into explicit assistant initiative policies.',
            novelty_score: 0.82,
            usefulness_score: 0.75,
            supporting_paper_keys: ['soc1', 'soc2']
          }
        ]
      };
    }
    if (task === 'pairwise_ranking') {
      return {
        comparisons: [{
          pair_id: 'p1_2',
          winner_id: 'fragment:soc',
          reason: 'Role renegotiation has deeper target-source integration.'
        }]
      };
    }
    return {};
  };
}

test('runLiveIdeaCatalyst executes snippet retrieval, majority pruning, and pairwise ranking', async () => {
  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/snippet/search'), `Unexpected request ${url.toString()}`);
      const field = url.searchParams.get('fieldsOfStudy');
      if (field === 'Computer Science') {
        return createJsonResponse({
          retrievalVersion: 'target',
          data: [
            snippet('cs1', 'Adaptive User Intent', 'NLP systems adapt to user intent with contextual signals.'),
            snippet('cs2', 'Collaborative Assistants', 'Assistants can update policies during interaction.')
          ]
        });
      }
      if (field === 'Psychology') {
        return createJsonResponse({
          retrievalVersion: 'psychology',
          data: [
            snippet('psy1', 'Metacontrol in Goal Pursuit', 'Metacontrol balances persistence and flexibility as goals change.', 0.8, { publicationDate: '2024-02-01' }),
            snippet('psy2', 'Cognitive Control Adaptation', 'Cognitive control adapts prospectively to expected goal switches.', 0.8, { publicationDate: '2026-01-15' }),
            snippet('psy3', 'Unrelated Memory Study', 'Memory recall varies across conditions.', 0.8, { year: 2023 })
          ]
        });
      }
      if (field === 'Sociology') {
        return createJsonResponse({
          retrievalVersion: 'sociology',
          data: [
            snippet('soc1', 'Role Adaptation in Teams', 'Teams renegotiate roles as coordination demands change.'),
            snippet('soc2', 'Coordination Norms', 'Norms stabilize collaboration while roles shift.')
          ]
        });
      }
      if (field === 'Economics') {
        return createJsonResponse({
          retrievalVersion: 'economics',
          data: [
            snippet('eco1', 'Market Incentives', 'Markets price incentives under uncertainty.'),
            snippet('eco2', 'Auction Design', 'Auctions allocate goods under bids.')
          ]
        });
      }
      assert.fail(`Unexpected field ${field}`);
    };

    const result = await runLiveIdeaCatalyst({
      problem: 'adaptive human-AI collaboration under changing user intent',
      targetDomain: 'Natural Language Processing',
      numQuestions: 1,
      numSourceDomains: 3,
      maxPapersPerQuery: 20,
      sourceRelevanceThreshold: 0.5,
      llmJson: makeLlmJson(),
      retryCount: 0
    });

    assert.equal(result.contractVersion, 'idea-catalyst-live-discovery-v1');
    assert.equal(result.contractVersionV2, 'idea-catalyst-live-discovery-v2');
    assert.equal(result.packet_version, 'idea-catalyst-live-packet-bundle-v2');
    assert.equal(result.targetFieldOfStudy, 'Computer Science');
    assert.equal(result.source_domain_analyses.length, 3);
    assert.equal(result.source_domain_analyses.find((entry) => entry.source_domain === 'Psychology').accepted, true);
    assert.deepEqual(
      result.source_domain_analyses
        .find((entry) => entry.source_domain === 'Psychology')
        .supporting_papers
        .map((paper) => paper.paper_key),
      ['psy2', 'psy1']
    );
    assert.equal(
      result.source_domain_analyses.find((entry) => entry.source_domain === 'Psychology').supporting_papers[0].publicationDate,
      '2026-01-15'
    );
    assert.equal(result.source_domain_analyses.find((entry) => entry.source_domain === 'Economics').accepted, false);
    assert.equal(result.source_domain_analyses.find((entry) => entry.source_domain === 'Economics').pruning_decision, 'pruned_below_majority_relevance');
    assert.equal(result.interdisciplinary_ranking.ranking_backend, 'llm-pairwise-v1');
    assert.equal(result.idea_fragments[0].id, 'fragment:soc');
    assert.equal(result.faithfulness_report.semantic_scholar_snippets_adapter, true);
    assert.equal(result.faithfulness_report.source_domain_majority_relevance_pruning, true);
    assert.equal(result.packetBundle.idea_fragments[0].id, 'fragment:soc');
    assert.equal(result.packetBundle.packet_version, 'idea-catalyst-live-packet-bundle-v2');
    assert.ok(result.must_cite_set.length > 0);
    assert.ok(result.contribution_claims.length > 0);
    assert.ok(result.contribution_claims.every((claim) => claim.source_span_ids.length > 0));
    assert.equal(result.novelty_certificate.unsupported_claim_count, 0);
    assert.ok(result.review_packet.reviewers.length > 0);
    assert.ok(result.storyline_dag.beats.length > 0);
    assert.ok(result.evidence_export.must_cite_set.length > 0);
    assert.ok(result.evidence_export.review_packet.reviewers.length > 0);
    assert.ok(result.evidence_export.source_spans.every((span) => span.license_scope && span.evidence_hash && span.source_anchor));
    assert.ok(result.evidence_export.supporting_papers.every((paper) => paper.license_scope && paper.evidence_hash && paper.source_anchor));
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});

test('runLiveIdeaCatalyst preserves zero scores and rejects incomplete pairwise rankings', async () => {
  try {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/snippet/search'), `Unexpected request ${url.toString()}`);
      const field = url.searchParams.get('fieldsOfStudy');
      if (field === 'Computer Science') {
        return createJsonResponse({
          data: [snippet('cs1', 'Unresolved Intent Adaptation', 'User intent adaptation remains unresolved in collaborative NLP systems.')]
        });
      }
      if (field === 'Psychology') {
        return createJsonResponse({
          data: [snippet('psy1', 'Goal Switching', 'Goal switching studies how people adapt behavior under changing feedback.')]
        });
      }
      if (field === 'Sociology') {
        return createJsonResponse({
          data: [snippet('soc1', 'Role Change', 'Role change studies how teams coordinate under shifting responsibilities.')]
        });
      }
      if (field === 'Economics') {
        return createJsonResponse({
          data: [snippet('eco1', 'Adaptive Incentives', 'Adaptive incentives model behavior under changing constraints.')]
        });
      }
      assert.fail(`Unexpected field ${field}`);
    };

    const llmJson = async ({ task, prompt }) => {
      if (task === 'decompose') {
        return {
          research_questions: [{
            id: 'q1',
            domain_specific_question: 'How can NLP adapt to changing user intent?',
            domain_agnostic_question: 'How can systems adapt to changing goals?',
            target_search_queries: ['unresolved user intent adaptation']
          }]
        };
      }
      if (task === 'target_assessment') {
        return {
          progress: 'unresolved',
          remaining_challenges: [{
            id: 'challenge:unresolved',
            domain_specific_challenge: 'NLP intent adaptation is still unresolved.',
            domain_agnostic_challenge: 'How can systems adapt to changing goals?',
            target_evidence_ids: []
          }]
        };
      }
      if (task === 'source_domains') {
        return {
          source_domains: [
            { domain: 'Psychology', source_search_queries: ['goal switching feedback'] },
            { domain: 'Sociology', source_search_queries: ['role change coordination'] },
            { domain: 'Economics', source_search_queries: ['adaptive incentives constraints'] }
          ]
        };
      }
      if (task === 'source_relevance') {
        const domain = prompt.match(/Source domain: ([^\n]+)/)?.[1] || 'source';
        const key = domain === 'Psychology' ? 'psy1' : domain === 'Sociology' ? 'soc1' : 'eco1';
        const relevant = domain !== 'Economics';
        return {
          papers: [{ paper_key: key, relevant, relevance_score: 0, reason: 'Explicit zero score should be preserved.' }]
        };
      }
      if (task === 'source_takeaways') {
        const domain = prompt.match(/Source domain: ([^\n]+)/)?.[1] || 'Source';
        return {
          takeaways: [{
            id: `takeaway:${domain.toLowerCase()}`,
            concept: `${domain} mechanism`,
            mechanism: `${domain} offers a transferable adaptation mechanism.`,
            paper_keys: [domain === 'Psychology' ? 'psy1' : domain === 'Sociology' ? 'soc1' : 'eco1']
          }]
        };
      }
      if (task === 'idea_fragments') {
        return {
          idea_fragments: [
            {
              id: 'fragment:psych',
              title: 'Psychology fragment',
              source_domain: 'Psychology',
              novelty_score: 0,
              usefulness_score: 0,
              supporting_paper_keys: ['psy1']
            },
            {
              id: 'fragment:soc',
              title: 'Sociology fragment',
              source_domain: 'Sociology',
              novelty_score: 0,
              usefulness_score: 0,
              supporting_paper_keys: ['soc1']
            },
            {
              id: 'fragment:eco',
              title: 'Economics fragment',
              source_domain: 'Economics',
              novelty_score: 0,
              usefulness_score: 0,
              supporting_paper_keys: ['eco1']
            }
          ]
        };
      }
      if (task === 'pairwise_ranking') {
        return {
          comparisons: [{
            pair_id: 'p1_2',
            winner_id: 'fragment:soc',
            reason: 'Only one of three required comparisons is intentionally returned.'
          }]
        };
      }
      return {};
    };

    const result = await runLiveIdeaCatalyst({
      problem: 'adaptive human-AI collaboration under changing user intent',
      targetDomain: 'Natural Language Processing',
      numQuestions: 1,
      numSourceDomains: 3,
      maxPapersPerQuery: 20,
      sourceRelevanceThreshold: 0,
      llmJson,
      retryCount: 0
    });

    assert.equal(result.target_domain_analysis[0].question_analyses[0].progress, 'largely unexplored');
    assert.equal(result.live_retrieval.source_relevance_threshold, 0);
    assert.equal(result.source_domain_analyses.find((entry) => entry.source_domain === 'Economics').accepted, true);
    assert.equal(result.source_domain_analyses[0].relevance[0].relevance_score, 0);
    assert.equal(result.idea_fragments.find((entry) => entry.id === 'fragment:psych').novelty_score, 0);
    assert.equal(result.interdisciplinary_ranking.ranking_backend, 'heuristic-pairwise-fallback-v1');
    assert.match(result.interdisciplinary_ranking.fallback_reason, /incomplete pairwise comparisons \(1\/3\)/);
    assert.equal(result.faithfulness_report.pairwise_llm_interdisciplinary_ranking, false);
  } finally {
    resetDiscoveryRequestSchedulerForTests();
    globalThis.fetch = originalFetch;
  }
});
