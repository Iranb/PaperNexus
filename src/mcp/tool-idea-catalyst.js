import { buildInterdisciplinaryPotentialReport } from '../core/graph/interdisciplinary-potential.js';
import {
  catalystGraphPayload,
  loadCorpusLiteForApi,
  resolveCorpusForApi
} from '../server/api.js';

function clampScore(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMechanisms(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function buildIdeaFragment(entry, problem, threshold, index) {
  const topTakeaways = Array.isArray(entry.topTakeaways) ? entry.topTakeaways : [];
  return {
    rank: index + 1,
    title: `${entry.domain} bridge for ${problem}`.slice(0, 120),
    target_challenge: problem,
    abstract_challenge: problem,
    source_domain: entry.domain,
    source_takeaways: topTakeaways.map((takeaway) => ({
      concept: takeaway.concept,
      mechanism: takeaway.mechanism,
      source_papers: Array.isArray(takeaway.kg_evidence?.paper_titles) ? takeaway.kg_evidence.paper_titles : []
    })),
    integration_rationale: [
      `Prioritize ${entry.domain} because it scores ${entry.interdisciplinaryPotentialScore} on the graph-derived interdisciplinary ranking.`,
      entry.sharedMechanisms?.length
        ? `Shared mechanisms: ${entry.sharedMechanisms.join(', ')}.`
        : 'No explicit shared mechanisms were surfaced; rely on bridge-node evidence instead.'
    ].join(' '),
    novelty_score: Number((clampScore(Number(entry.interdisciplinaryPotentialScore || 0), 0, 1) * 5).toFixed(2)),
    usefulness_score: Number((clampScore(Number(entry.bridgeNodeCount || 0) / Math.max(1, threshold), 0, 1) * 5).toFixed(2)),
    supporting_kg_nodes: topTakeaways
      .map((takeaway) => takeaway.kg_evidence?.node_id)
      .filter(Boolean)
  };
}

export async function executeIdeaCatalystTool(args = {}, options = {}) {
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;
  const problem = String(args.problem || args.query || '').trim();
  const targetDomain = String(args.targetDomain || args.target_domain || '').trim();
  const limit = Math.max(1, Number(args.limit || 8));
  const numSourceDomains = Math.max(1, Number(args.numSourceDomains || args.num_source_domains || 3));
  const relevanceThreshold = Math.max(1, Number(args.relevanceThreshold || args.relevance_threshold || 3));
  const mechanisms = normalizeMechanisms(args.mechanisms);

  if (!problem) {
    throw new Error('problem is required.');
  }
  if (!targetDomain) {
    throw new Error('targetDomain is required.');
  }

  const rootPath = await resolveCorpusForApi(candidate, options);
  const { graph } = await loadCorpusLiteForApi(rootPath, options);
  const catalyst = await catalystGraphPayload(candidate, {
    name: candidate,
    targetDomain,
    query: problem,
    mechanisms,
    options: {
      limit
    }
  }, options);
  const potential = buildInterdisciplinaryPotentialReport(graph, {
    targetDomain,
    query: problem,
    agnosticChallenges: [problem],
    limit: Math.max(limit, numSourceDomains)
  });
  const rankedSourceDomains = (potential.rankedSourceDomains || []).slice(0, numSourceDomains);
  const sufficient = rankedSourceDomains.some((entry) => (
    Number(entry.bridgeNodeCount || 0) >= relevanceThreshold
    || (Array.isArray(entry.topTakeaways) ? entry.topTakeaways.length : 0) >= relevanceThreshold
  ));

  if (!sufficient) {
    const missingDomains = rankedSourceDomains.length
      ? rankedSourceDomains.map((entry) => entry.domain)
      : (catalyst.result.candidateSourceDomains || []).slice(0, numSourceDomains).map((entry) => entry.domain).filter(Boolean);
    const requiredTopics = missingDomains.map((domain, index) => {
      const candidateDomain = rankedSourceDomains.find((entry) => entry.domain === domain)
        || (catalyst.result.candidateSourceDomains || []).find((entry) => entry.domain === domain)
        || {};
      return {
        topic: domain,
        search_keywords: [
          domain,
          ...(Array.isArray(candidateDomain.matchedChallenges) ? candidateDomain.matchedChallenges.slice(0, 2) : []),
          ...mechanisms.slice(0, 2)
        ].filter(Boolean),
        reason: `Need stronger ${domain} evidence to address "${problem}" without hallucinating beyond the current graph.`
      };
    });

    return {
      rootPath,
      requisition_report: {
        status: 'DATA_STARVATION',
        target_challenge: problem,
        missing_domains: missingDomains,
        required_topics: requiredTopics
      },
      analysis: {
        target_domain: targetDomain,
        candidate_source_domains: rankedSourceDomains,
        catalyst: catalyst.result
      },
      generatedAt: new Date().toISOString()
    };
  }

  return {
    rootPath,
    idea_fragments: rankedSourceDomains
      .slice(0, Math.min(3, rankedSourceDomains.length))
      .map((entry, index) => buildIdeaFragment(entry, problem, relevanceThreshold, index)),
    analysis: {
      target_domain: targetDomain,
      candidate_source_domains: rankedSourceDomains,
      catalyst: catalyst.result
    },
    generatedAt: new Date().toISOString()
  };
}
