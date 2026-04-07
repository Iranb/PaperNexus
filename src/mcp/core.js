import { buildBrainstorm, buildContext, buildImpact, buildResearchIdeas, searchGraph } from '../core/search/search.js';
import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy } from '../core/graph/domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from '../core/graph/interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from '../core/graph/takeaway-extraction.js';
import { renderBrainstormResult, renderContextResult, renderCorpusList, renderIdeasResult, renderImpactResult, renderMutationResult, renderQueryResult, renderStatus } from '../lib/render.js';
import { applyCorpusMutations, loadCorpus, loadCorpusLite, resolveCorpus } from '../storage/corpus-store.js';
import { loadRegistry } from '../storage/registry.js';
import { PAPERNEXUS_PROMPTS, getPrompt } from './prompts.js';
import { listResources, readResourcePayload } from './resources.js';
import { PAPERNEXUS_TOOLS } from './tools.js';

export const SERVER_INFO = {
  name: 'papernexus',
  version: '0.1.0'
};

export function createJsonRpcSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

export function createJsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

export async function executeTool(name, args) {
  if (name === 'list_corpora') {
    const registry = await loadRegistry();
    return renderCorpusList(registry.corpora);
  }

  if (name === 'corpus_status') {
    const rootPath = await resolveCorpus(args.corpus);
    const { meta } = await loadCorpus(rootPath);
    return renderStatus(meta);
  }

  if (name === 'query') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderQueryResult(searchGraph(graph, args.query, {
      limit: args.limit,
      layers: args.layers
    }));
  }

  if (name === 'context') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderContextResult(buildContext(graph, args.query, {
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    }));
  }

  if (name === 'impact') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderImpactResult(buildImpact(graph, args.query, {
      direction: args.direction,
      maxDepth: args.maxDepth,
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    }));
  }

  if (name === 'ideas') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return renderIdeasResult(buildResearchIdeas(graph, args.query, {
      limit: args.limit,
      layers: args.layers
    }));
  }

  if (name === 'brainstorm') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    const result = buildBrainstorm(graph, args.query, {
      mode: args.mode || 'diverge',
      maxHops: args.maxHops,
      limit: args.limit,
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    });

    if ((args.mode || 'diverge') === 'diverge') {
      return [
        {
          type: 'text',
          text: renderBrainstormResult(result)
        },
        {
          type: 'text',
          text: JSON.stringify({
            domainProfile: result.domainProfile,
            communityAnalysis: result.communityAnalysis
          }, null, 2)
        }
      ];
    }

    return renderBrainstormResult(result);
  }

  if (name === 'domain_distance') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph, meta } = await loadCorpusLite(rootPath);
    const matrix = meta.domainDistanceMatrix?.mechanismCoverage
      ? meta.domainDistanceMatrix
      : deriveDomainTaxonomyFromGraph(graph);
    const targetDomain = normalizeFieldOfStudy(args.targetDomain);
    const distances = targetDomain
      ? Object.entries(matrix.distances?.[targetDomain] || {})
        .map(([domain, distance]) => ({ domain, distance }))
        .sort((left, right) => right.distance - left.distance || left.domain.localeCompare(right.domain))
      : [];

    return JSON.stringify({
      ...matrix,
      targetDomain,
      distances
    }, null, 2);
  }

  if (name === 'extract_takeaways') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return JSON.stringify(extractTakeawaysFromBridgeNodes(graph, {
      targetDomain: args.targetDomain,
      agnosticChallenges: args.agnosticChallenges,
      limit: args.limit,
      minDomainDistance: args.minDomainDistance
    }), null, 2);
  }

  if (name === 'interdisciplinary_potential') {
    const rootPath = await resolveCorpus(args.corpus);
    const { graph } = await loadCorpusLite(rootPath);
    return JSON.stringify(buildInterdisciplinaryPotentialReport(graph, {
      targetDomain: args.targetDomain,
      query: args.query,
      agnosticChallenges: args.agnosticChallenges,
      excludeProximalDomains: args.excludeProximalDomains,
      limit: args.limit
    }), null, 2);
  }

  if (name === 'mutate_graph') {
    const rootPath = await resolveCorpus(args.corpus);
    const { meta, mutationResult } = await applyCorpusMutations(rootPath, args.operations, {
      actor: args.actor,
      dryRun: args.dryRun !== false
    });
    return renderMutationResult({
      ...mutationResult,
      rootPath,
      corpusName: meta.name
    });
  }

  if (name === 'refresh_corpus') {
    const rootPath = await resolveCorpus(args.corpus);
    const { analyzeCorpus } = await import('../core/ingestion/pipeline.js');
    const inputRoot = rootPath.replace(/[/\\]\.papernexus$/, '');
    await analyzeCorpus(inputRoot, {
      rootPath,
      incremental: args.incremental !== false,
      force: args.force === true
    });
    const { meta } = await loadCorpus(rootPath);
    return renderStatus(meta);
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function normalizeToolContent(result) {
  if (Array.isArray(result)) {
    return result;
  }

  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content;
  }

  return [
    {
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    }
  ];
}

export async function handleMessage(message) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: SERVER_INFO
      };
    case 'tools/list':
      return { tools: PAPERNEXUS_TOOLS };
    case 'tools/call':
      return {
        content: normalizeToolContent(await executeTool(message.params?.name, message.params?.arguments || {}))
      };
    case 'resources/list':
      return { resources: await listResources() };
    case 'resources/read':
      {
        const payload = await readResourcePayload(message.params?.uri);
        return {
          contents: [
            {
              uri: message.params?.uri,
              mimeType: payload.mimeType,
              text: payload.text
            }
          ]
        };
      }
    case 'prompts/list':
      return { prompts: PAPERNEXUS_PROMPTS };
    case 'prompts/get':
      return getPrompt(message.params?.name);
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}
