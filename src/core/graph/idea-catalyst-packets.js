import { scoreTokenOverlap, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from './domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from './interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from './takeaway-extraction.js';
import { NODE_TYPES } from './schema.js';

export const IDEA_CATALYST_PACKET_BUNDLE_VERSION = 'idea-catalyst-packet-bundle-v1';

function normalizeLabel(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function collectNodeDomains(node) {
  return normalizeDomainTags([
    node.properties?.fieldOfStudy,
    ...(node.properties?.fieldCandidates || []),
    ...(node.properties?.domainTags || []),
    ...(node.properties?.sourceDomains || []),
    node.properties?.targetDomain
  ]);
}

function nodeMatchesDomain(node, targetDomain) {
  const normalized = normalizeFieldOfStudy(targetDomain);
  return normalized ? collectNodeDomains(node).includes(normalized) : false;
}

function scoreAffinity(query, text) {
  const queryTokens = tokenizeWithoutStopwords(String(query || '').toLowerCase());
  const textTokens = tokenizeWithoutStopwords(String(text || '').toLowerCase());
  if (!queryTokens.length || !textTokens.length) return 0;
  return scoreTokenOverlap(queryTokens, textTokens);
}

function compareByAffinity(query, left, right) {
  const leftText = [
    left.name,
    left.properties?.domainSpecificText,
    left.properties?.domainAgnosticText,
    left.properties?.text
  ].filter(Boolean).join(' ');
  const rightText = [
    right.name,
    right.properties?.domainSpecificText,
    right.properties?.domainAgnosticText,
    right.properties?.text
  ].filter(Boolean).join(' ');
  return scoreAffinity(query, rightText) - scoreAffinity(query, leftText)
    || left.name.localeCompare(right.name);
}

function collectResearchQuestions(graph, targetDomain, abstractChallenge, fineGrainedDomain, coarseGrainedDomain, mechanisms = [], limit = 5) {
  const questions = graph.getNodesByType(NODE_TYPES.RESEARCH_QUESTION)
    .filter((node) => nodeMatchesDomain(node, targetDomain))
    .sort((left, right) => compareByAffinity(abstractChallenge, left, right))
    .slice(0, limit)
    .map((node, index) => ({
      question_id: node.id || `rq-${index + 1}`,
      domain_specific_question: normalizeLabel(node.properties?.domainSpecificText, node.name),
      domain_agnostic_question: normalizeLabel(node.properties?.domainAgnosticText, node.name),
      rationale: normalizeLabel(
        node.properties?.rationale,
        `${node.name} keeps the target-domain decomposition grounded in the current graph evidence.`
      ),
      target_domain_queries: unique([
        normalizeLabel(node.properties?.domainSpecificText),
        normalizeLabel(node.properties?.domainAgnosticText),
        normalizeLabel(`${fineGrainedDomain} ${abstractChallenge}`),
        normalizeLabel(`${coarseGrainedDomain} ${abstractChallenge}`),
        ...mechanisms.map((mechanism) => normalizeLabel(`${abstractChallenge} ${mechanism}`))
      ].filter(Boolean)).slice(0, 5)
    }));

  if (questions.length) {
    return questions;
  }

  return [
    {
      question_id: 'rq-fallback-1',
      domain_specific_question: abstractChallenge,
      domain_agnostic_question: abstractChallenge,
      rationale: `No explicit ResearchQuestion node matched ${targetDomain}, so the abstract challenge is used as the decomposition anchor.`,
      target_domain_queries: unique([
        normalizeLabel(`${fineGrainedDomain} ${abstractChallenge}`),
        normalizeLabel(`${coarseGrainedDomain} ${abstractChallenge}`),
        abstractChallenge,
        ...mechanisms.map((mechanism) => normalizeLabel(`${abstractChallenge} ${mechanism}`))
      ].filter(Boolean)).slice(0, 5)
    }
  ];
}

function collectChallengeSummaries(graph, targetDomain, abstractChallenge, limit = 5) {
  return graph.getNodesByType(NODE_TYPES.CHALLENGE)
    .filter((node) => nodeMatchesDomain(node, targetDomain))
    .sort((left, right) => compareByAffinity(abstractChallenge, left, right))
    .slice(0, limit)
    .map((node, index) => ({
      challenge_id: node.id || `challenge-${index + 1}`,
      name: node.name,
      domain_specific_challenge_question: normalizeLabel(node.properties?.domainSpecificText, node.name),
      domain_agnostic_challenge_question: normalizeLabel(node.properties?.domainAgnosticText, node.name),
      why_unaddressed: normalizeLabel(
        node.properties?.whyUnaddressed,
        `The graph still marks ${node.name} as an open challenge in ${targetDomain}.`
      ),
      importance: normalizeLabel(
        node.properties?.importance,
        scoreAffinity(abstractChallenge, `${node.properties?.domainSpecificText || ''} ${node.properties?.domainAgnosticText || ''}`) > 0.2
          ? 'high'
          : 'medium'
      )
    }));
}

function buildCrossDomainQueries(candidateDomains, params = {}, potentialReport = null) {
  const fineGrainedDomain = normalizeLabel(params.fineGrainedDomain, params.targetDomain || '');
  const coarseGrainedDomain = normalizeLabel(params.coarseGrainedDomain, params.targetDomain || '');
  const abstractChallenge = normalizeLabel(params.abstractChallenge);
  const mechanisms = Array.isArray(params.mechanisms) ? params.mechanisms : [];

  return candidateDomains.map((entry) => {
    const potential = potentialReport?.rankedSourceDomains?.find((candidate) => candidate.domain === entry.domain) || null;
    const queries = unique([
      ...((entry.matchedChallenges || []).map((challenge) => normalizeLabel(`${entry.domain} ${challenge}`))),
      normalizeLabel(`${entry.domain} ${abstractChallenge}`),
      normalizeLabel(`${entry.domain} ${fineGrainedDomain} ${abstractChallenge}`),
      normalizeLabel(`${entry.domain} ${coarseGrainedDomain} ${abstractChallenge}`),
      ...mechanisms.map((mechanism) => normalizeLabel(`${entry.domain} ${mechanism} ${abstractChallenge}`))
    ].filter(Boolean)).slice(0, 5);

    return {
      domain: entry.domain,
      domain_rationale: potential?.selectionRationale
        || `Search ${entry.domain} because it ranks highly as a cross-domain bridge for ${params.targetDomain}.`,
      queries,
      shared_mechanisms: unique([
        ...(entry.bridgeEvidence || []).map((item) => item.mechanism),
        ...(potential?.sharedMechanisms || [])
      ]).slice(0, 8),
      supporting_papers: Array.isArray(potential?.supportingPapers) ? potential.supportingPapers : []
    };
  });
}

function buildSourceDomainAnalyses(crossDomainQueries, takeaways, potentialReport) {
  return crossDomainQueries.map((entry) => {
    const ranking = potentialReport.rankedSourceDomains.find((candidate) => candidate.domain === entry.domain) || null;
    const domainTakeaways = takeaways
      .filter((takeaway) => takeaway.source_domain === entry.domain)
      .map((takeaway) => ({
        ...takeaway,
        supporting_papers: Array.isArray(takeaway.supporting_papers) ? takeaway.supporting_papers : []
      }))
      .sort((left, right) => (
        (right.supporting_papers.length - left.supporting_papers.length)
        || left.concept.localeCompare(right.concept)
      ))
      .slice(0, 5);

    return {
      source_domain: entry.domain,
      domain_rationale: entry.domain_rationale,
      shared_mechanisms: entry.shared_mechanisms,
      supporting_papers: unique(domainTakeaways.flatMap((takeaway) => takeaway.supporting_papers || [])).slice(0, 8),
      takeaways: domainTakeaways,
      domain_distance: Number(ranking?.domainDistance || 0),
      interdisciplinary_potential: Number(ranking?.interdisciplinaryPotentialScore || 0),
      selection_rationale: ranking?.selectionRationale || entry.domain_rationale
    };
  });
}

function buildIdeaFragments(sourceDomainAnalyses, ranking, params = {}) {
  const targetDomain = normalizeLabel(params.targetDomain);
  const abstractChallenge = normalizeLabel(params.abstractChallenge);
  const rankedByDomain = sourceDomainAnalyses
    .map((analysis) => {
      const ranked = ranking.ranked_candidates.find((entry) => entry.source_domain === analysis.source_domain) || null;
      return {
        analysis,
        ranked
      };
    })
    .sort((left, right) => (
      Number(right.ranked?.interdisciplinary_potential || 0) - Number(left.ranked?.interdisciplinary_potential || 0)
      || left.analysis.source_domain.localeCompare(right.analysis.source_domain)
    ));

  return rankedByDomain
    .filter(({ analysis }) => analysis.takeaways.length > 0)
    .slice(0, 3)
    .map(({ analysis, ranked }, index) => {
      const topTakeaway = analysis.takeaways[0];
      const mechanism = topTakeaway?.mechanism || analysis.shared_mechanisms[0] || 'transferable mechanism';
      return {
        rank: index + 1,
        title: `${analysis.source_domain} bridge for ${targetDomain}`.slice(0, 120),
        source_domain: analysis.source_domain,
        target_challenge: abstractChallenge,
        core_insight: topTakeaway?.source_domain_formulation || `${analysis.source_domain} contributes graph-grounded evidence for ${abstractChallenge}.`,
        integration_mechanism: mechanism,
        challenge_resolution: `Use ${mechanism} to address ${abstractChallenge} inside ${targetDomain}.`,
        concrete_realization: topTakeaway?.concept
          ? `Operationalize ${topTakeaway.concept} as a ${targetDomain} intervention.`
          : `Translate the strongest ${analysis.source_domain} takeaway into a ${targetDomain} prototype.`,
        source_takeaways: analysis.takeaways.map((takeaway) => takeaway.concept).slice(0, 5),
        supporting_papers: analysis.supporting_papers,
        supporting_kg_nodes: analysis.takeaways.map((takeaway) => takeaway.kg_evidence?.node_id).filter(Boolean),
        ranking_signals: ranked || null,
        idea_fragment: {
          title: `${analysis.source_domain} bridge for ${targetDomain}`.slice(0, 120),
          core_insight: topTakeaway?.source_domain_formulation || `${analysis.source_domain} contributes graph-grounded evidence for ${abstractChallenge}.`,
          integration_mechanism: mechanism,
          challenge_resolution: `Use ${mechanism} to address ${abstractChallenge} inside ${targetDomain}.`,
          concrete_realization: topTakeaway?.concept
            ? `Operationalize ${topTakeaway.concept} as a ${targetDomain} intervention.`
            : `Translate the strongest ${analysis.source_domain} takeaway into a ${targetDomain} prototype.`
        }
      };
    });
}

function buildInterdisciplinaryRanking(report) {
  return {
    contractVersion: report.contractVersion,
    ranking_criteria: [
      'DEPTH OF INTEGRATION',
      'MULTI-STAGE DISCIPLINARY ENGAGEMENT',
      'INNOVATION PAYOFF',
      'NOVELTY + FEASIBILITY'
    ],
    ranked_candidates: (report.rankedSourceDomains || []).map((entry, index) => ({
      rank: index + 1,
      source_domain: entry.domain,
      interdisciplinary_potential: entry.interdisciplinaryPotentialScore,
      depth_of_integration: entry.depthOfIntegration,
      multi_stage_disciplinary_engagement: entry.multiStageDisciplinaryEngagement,
      innovation_payoff: entry.innovationPayoff,
      novelty_plus_feasibility: entry.noveltyPlusFeasibility,
      supporting_papers: entry.supportingPapers || [],
      shared_mechanisms: entry.sharedMechanisms || [],
      rationale: entry.selectionRationale || ''
    }))
  };
}

function buildRequisitionReport(crossDomainQueries, sourceDomainAnalyses, params = {}) {
  const missingDomains = crossDomainQueries
    .filter((entry) => !sourceDomainAnalyses.some((analysis) => analysis.source_domain === entry.domain && analysis.takeaways.length > 0))
    .map((entry) => entry.domain);

  return {
    status: 'DATA_STARVATION',
    target_challenge: normalizeLabel(params.abstractChallenge),
    missing_domains: missingDomains,
    required_topics: crossDomainQueries
      .filter((entry) => missingDomains.includes(entry.domain))
      .map((entry) => ({
        topic: entry.domain,
        search_keywords: entry.queries.slice(0, 3),
        reason: `Need stronger ${entry.domain} evidence to support ${params.abstractChallenge}.`
      }))
  };
}

export function buildIdeaCatalystPacketBundle(graph, catalystResult = {}, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain || catalystResult.targetDomain);
  const fineGrainedDomain = normalizeLabel(params.fineGrainedDomain, targetDomain || '');
  const coarseGrainedDomain = normalizeLabel(params.coarseGrainedDomain, targetDomain || '');
  const abstractChallenge = normalizeLabel(params.abstractChallenge || catalystResult.abstractChallenge);
  const mechanisms = Array.isArray(params.mechanisms) && params.mechanisms.length
    ? params.mechanisms
    : (Array.isArray(catalystResult.targetMechanisms) ? catalystResult.targetMechanisms : []);
  const limit = Math.max(1, Number(params.limit || 5));
  const numSourceDomains = Math.max(1, Number(params.numSourceDomains || 3));
  const relevanceThreshold = Math.max(1, Number(params.relevanceThreshold || 3));

  const researchQuestions = collectResearchQuestions(
    graph,
    targetDomain,
    abstractChallenge,
    fineGrainedDomain,
    coarseGrainedDomain,
    mechanisms,
    limit
  );
  const remainingChallenges = collectChallengeSummaries(graph, targetDomain, abstractChallenge, limit);
  const potentialReport = buildInterdisciplinaryPotentialReport(graph, {
    targetDomain,
    query: abstractChallenge,
    agnosticChallenges: [abstractChallenge],
    limit: Math.max(limit, numSourceDomains)
  });
  const crossDomainQueries = buildCrossDomainQueries(
    (catalystResult.candidateDomains || []).slice(0, Math.max(limit, numSourceDomains)),
    {
      targetDomain,
      fineGrainedDomain,
      coarseGrainedDomain,
      abstractChallenge,
      mechanisms
    },
    potentialReport
  ).slice(0, numSourceDomains);
  const takeawayReport = extractTakeawaysFromBridgeNodes(graph, {
    targetDomain,
    agnosticChallenges: [abstractChallenge],
    bridgeNodes: catalystResult.bridgeNodes || []
  });
  const sourceDomainAnalyses = buildSourceDomainAnalyses(
    crossDomainQueries,
    takeawayReport.takeaways || [],
    potentialReport
  );
  const interdisciplinaryRanking = buildInterdisciplinaryRanking(potentialReport);
  const ideaFragments = buildIdeaFragments(sourceDomainAnalyses, interdisciplinaryRanking, {
    targetDomain,
    abstractChallenge
  });
  const sufficient = sourceDomainAnalyses.some((analysis) => (
    analysis.takeaways.length >= relevanceThreshold
    || analysis.supporting_papers.length >= relevanceThreshold
  ));
  const requisitionReport = sufficient ? null : buildRequisitionReport(crossDomainQueries, sourceDomainAnalyses, {
    abstractChallenge
  });

  const decomposition = {
    coarse_grained_domain: coarseGrainedDomain,
    fine_grained_domain: fineGrainedDomain,
    core_challenge: abstractChallenge,
    research_questions: researchQuestions,
    questions: researchQuestions
  };
  const targetDomainAnalysis = [
    {
      target_domain: targetDomain,
      fine_grained_domain: fineGrainedDomain,
      addressed_aspects: researchQuestions.slice(0, 3).map((question) => ({
        sub_question: question.domain_specific_question,
        evidence: question.rationale
      })),
      remaining_challenges: remainingChallenges,
      overall_assessment: remainingChallenges.length
        ? (researchQuestions.length > remainingChallenges.length ? 'partially addressed' : 'largely unaddressed')
        : 'substantially addressed'
    }
  ];

  return {
    contractVersion: IDEA_CATALYST_PACKET_BUNDLE_VERSION,
    decomposition,
    target_domain_analysis: targetDomainAnalysis,
    cross_domain_queries: crossDomainQueries,
    cross_domain_searches: crossDomainQueries,
    source_domain_analyses: sourceDomainAnalyses,
    cross_domain_analysis: sourceDomainAnalyses,
    idea_fragments: requisitionReport ? [] : ideaFragments,
    interdisciplinary_ranking: interdisciplinaryRanking,
    requisition_report: requisitionReport
  };
}
