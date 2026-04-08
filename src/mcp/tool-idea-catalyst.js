import {
  catalystGraphPayload
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
  return {
    rank: index + 1,
    title: `${entry.source_domain} bridge for ${problem}`.slice(0, 120),
    target_challenge: problem,
    abstract_challenge: problem,
    source_domain: entry.source_domain,
    source_takeaways: Array.isArray(entry.source_takeaways) ? entry.source_takeaways : [],
    integration_rationale: [
      `Prioritize ${entry.source_domain} because it remains one of the strongest graph-ranked bridge domains for "${problem}".`,
      entry.integration_mechanism
        ? `Transfer mechanism: ${entry.integration_mechanism}.`
        : 'No explicit mechanism was returned; rely on the graph evidence in the packet bundle.'
    ].join(' '),
    novelty_score: Number((clampScore(Number(entry.ranking_signals?.interdisciplinary_potential || 0), 0, 1) * 5).toFixed(2)),
    usefulness_score: Number((clampScore(Number((entry.supporting_papers || []).length || 0) / Math.max(1, threshold), 0, 1) * 5).toFixed(2)),
    supporting_kg_nodes: Array.isArray(entry.supporting_kg_nodes) ? entry.supporting_kg_nodes : [],
    ...entry
  };
}

function buildLegacyIdeaCatalystResponse(payload, problem, relevanceThreshold) {
  const bundle = payload.packetBundle || payload.result?.packetBundle || {};
  if (bundle.requisition_report) {
    return {
      rootPath: payload.rootPath,
      requisition_report: bundle.requisition_report,
      analysis: {
        target_domain: payload.result?.targetDomain || '',
        candidate_source_domains: payload.result?.candidateSourceDomains || [],
        catalyst: payload.result
      },
      generatedAt: payload.generatedAt
    };
  }

  return {
    rootPath: payload.rootPath,
    idea_fragments: (bundle.idea_fragments || [])
      .slice(0, 3)
      .map((entry, index) => buildIdeaFragment(entry, problem, relevanceThreshold, index)),
    analysis: {
      target_domain: payload.result?.targetDomain || '',
      candidate_source_domains: payload.result?.candidateSourceDomains || [],
      catalyst: payload.result
    },
    generatedAt: payload.generatedAt
  };
}

export async function executeIdeaCatalystTool(args = {}, options = {}) {
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;
  const problem = String(args.problem || args.query || '').trim();
  const targetDomain = String(args.targetDomain || args.target_domain || '').trim();
  const fineGrainedDomain = String(args.fineGrainedDomain || args.fine_grained_domain || '').trim();
  const coarseGrainedDomain = String(args.coarseGrainedDomain || args.coarse_grained_domain || '').trim();
  const limit = Math.max(1, Number(args.limit || 8));
  const numSourceDomains = Math.max(1, Number(args.numSourceDomains || args.num_source_domains || 3));
  const relevanceThreshold = Math.max(1, Number(args.relevanceThreshold || args.relevance_threshold || 3));
  const mechanisms = normalizeMechanisms(args.mechanisms);
  const outputMode = String(args.outputMode || args.output_mode || 'idea_fragments').trim() || 'idea_fragments';
  const includeAnalysis = args.includeAnalysis === true || args.include_analysis === true;

  if (!problem) {
    throw new Error('problem is required.');
  }
  if (!targetDomain) {
    throw new Error('targetDomain is required.');
  }

  const payload = await catalystGraphPayload(candidate, {
    name: candidate,
    targetDomain,
    fineGrainedDomain,
    coarseGrainedDomain,
    abstractChallenge: problem,
    mechanisms,
    numSourceDomains,
    relevanceThreshold,
    options: {
      limit
    }
  }, options);

  if (outputMode === 'packet_bundle') {
    return {
      rootPath: payload.rootPath,
      packet_bundle: payload.packetBundle,
      ...(includeAnalysis ? {
        analysis: {
          target_domain: payload.result?.targetDomain || '',
          candidate_source_domains: payload.result?.candidateSourceDomains || [],
          catalyst: payload.result
        }
      } : {}),
      generatedAt: payload.generatedAt
    };
  }

  const legacy = buildLegacyIdeaCatalystResponse(payload, problem, relevanceThreshold);
  if (!includeAnalysis) {
    delete legacy.analysis;
  }
  return legacy;
}
