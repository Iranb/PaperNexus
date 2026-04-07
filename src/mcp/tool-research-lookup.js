import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy } from '../core/graph/domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from '../core/graph/interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from '../core/graph/takeaway-extraction.js';
import {
  brainstormGraphPayload,
  contextGraphPayload,
  ideasGraphPayload,
  impactGraphPayload,
  loadCorpusLiteForApi,
  queryGraphPayload,
  resolveCorpusForApi
} from '../server/api.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function asOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function buildGraphRequestBody(args = {}) {
  return {
    name: args.corpus,
    query: args.query,
    options: asOptions(args.options)
  };
}

export async function executeResearchLookupTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation);
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;

  switch (operation) {
    case 'query':
      return queryGraphPayload(candidate, buildGraphRequestBody(args), options);
    case 'context':
      return contextGraphPayload(candidate, buildGraphRequestBody(args), options);
    case 'impact':
      return impactGraphPayload(candidate, buildGraphRequestBody(args), options);
    case 'ideas':
      return ideasGraphPayload(candidate, buildGraphRequestBody(args), options);
    case 'brainstorm':
      return brainstormGraphPayload(candidate, buildGraphRequestBody(args), options);
    case 'domain_distance': {
      const rootPath = await resolveCorpusForApi(candidate, options);
      const { graph, meta } = await loadCorpusLiteForApi(rootPath, options);
      const matrix = meta.domainDistanceMatrix?.mechanismCoverage
        ? meta.domainDistanceMatrix
        : deriveDomainTaxonomyFromGraph(graph);
      const targetDomain = normalizeFieldOfStudy(args.targetDomain);
      const distances = targetDomain
        ? Object.entries(matrix.distances?.[targetDomain] || {})
          .map(([domain, distance]) => ({ domain, distance }))
          .sort((left, right) => right.distance - left.distance || left.domain.localeCompare(right.domain))
        : [];

      return {
        rootPath,
        result: {
          ...matrix,
          targetDomain,
          distances
        },
        generatedAt: new Date().toISOString()
      };
    }
    case 'extract_takeaways': {
      const rootPath = await resolveCorpusForApi(candidate, options);
      const { graph } = await loadCorpusLiteForApi(rootPath, options);
      return {
        rootPath,
        result: extractTakeawaysFromBridgeNodes(graph, {
          targetDomain: args.targetDomain,
          agnosticChallenges: args.agnosticChallenges,
          limit: args.limit,
          minDomainDistance: args.minDomainDistance
        }),
        generatedAt: new Date().toISOString()
      };
    }
    case 'interdisciplinary_potential': {
      const rootPath = await resolveCorpusForApi(candidate, options);
      const { graph } = await loadCorpusLiteForApi(rootPath, options);
      return {
        rootPath,
        result: buildInterdisciplinaryPotentialReport(graph, {
          targetDomain: args.targetDomain,
          query: args.query,
          agnosticChallenges: args.agnosticChallenges,
          excludeProximalDomains: args.excludeProximalDomains,
          limit: args.limit
        }),
        generatedAt: new Date().toISOString()
      };
    }
    default:
      throw new Error(`Unknown research_lookup operation: ${args.operation || '<missing>'}`);
  }
}
