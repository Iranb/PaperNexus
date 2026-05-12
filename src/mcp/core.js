import { buildBrainstorm, buildContext, buildImpact, buildResearchIdeas, searchGraph } from '../core/search/search.js';
import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy } from '../core/graph/domain-taxonomy.js';
import { buildInterdisciplinaryPotentialReport } from '../core/graph/interdisciplinary-potential.js';
import { extractTakeawaysFromBridgeNodes } from '../core/graph/takeaway-extraction.js';
import { renderBrainstormResult, renderContextResult, renderCorpusList, renderIdeasResult, renderImpactResult, renderMutationResult, renderQueryResult, renderStatus } from '../lib/render.js';
import { applyCorpusMutations, loadCorpus, loadCorpusLite, loadSourceManifest, resolveCorpus } from '../storage/corpus-store.js';
import { loadRegistry } from '../storage/registry.js';
import { PAPERNEXUS_PROMPTS, getPrompt } from './prompts.js';
import { listResources, readResourcePayload } from './resources.js';
import { corpusSourcesPayload } from '../server/api.js';
import { executeIdeaCatalystTool } from './tool-idea-catalyst.js';
import { executeImportWorkflowTool } from './tool-import-workflow.js';
import { executeLiteratureDiscoveryTool } from './tool-literature-discovery.js';
import { executeResearchBriefingTool } from './tool-research-briefing.js';
import { executeResearchLookupTool } from './tool-research-lookup.js';
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

export async function executeTool(name, args, options = {}) {
  if (name === 'list_corpora') {
    const registry = await loadRegistry();
    return renderCorpusList(registry.corpora);
  }

  if (name === 'corpus_status') {
    const rootPath = await resolveCorpus(args.corpus);
    const { meta } = await loadCorpus(rootPath);
    return renderStatus(meta);
  }

  if (name === 'corpus_sources') {
    return corpusSourcesPayload(args.corpus, options);
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
    const {
      analyzeCorpus,
      llmOptimizeCorpus,
      materializeCorpus,
      optimizeCorpus
    } = await import('../core/ingestion/pipeline.js');
    const manifest = await loadSourceManifest(rootPath);
    const inputRoot = Array.isArray(manifest?.inputPaths) && manifest.inputPaths.length
      ? manifest.inputPaths
      : (manifest?.inputPath || rootPath.replace(/[/\\]\.papernexus$/, ''));
    const mode = String(args.mode || 'analyze').trim().toLowerCase().replace(/-/g, '_') || 'analyze';
    const rawBatchSize = (
      args.llmBatchSize
      ?? args.llm_batch_size
      ?? args.batchSize
      ?? args.batch_size
    );
    const parsedBatchSize = Number(rawBatchSize);
    const llmBatchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
      ? parsedBatchSize
      : undefined;
    const changedSourceKeys = (
      Array.isArray(args.changedSourceKeys)
        ? args.changedSourceKeys
        : (Array.isArray(args.changed_source_keys) ? args.changed_source_keys : [])
    ).map((value) => String(value || '').trim()).filter(Boolean);
    const semanticExtraction = typeof (args.semanticExtraction ?? args.semantic_extraction) === 'string'
      && String(args.semanticExtraction ?? args.semantic_extraction).trim()
      ? String(args.semanticExtraction ?? args.semantic_extraction).trim()
      : undefined;
    const rebuildPdfMarkdown = args.rebuildPdfMarkdown ?? args.rebuild_pdf_markdown;
    const incremental = args.incremental !== false;
    const force = args.force === true || (mode === 'analyze' && incremental === false);
    const executionArgs = {
      rootPath,
      force,
      ...(semanticExtraction ? { semanticExtraction } : {}),
      ...(rebuildPdfMarkdown === undefined ? {} : { rebuildPdfMarkdown: rebuildPdfMarkdown === true }),
      ...(llmBatchSize === undefined ? {} : { llmBatchSize, batchSize: llmBatchSize }),
      ...(changedSourceKeys.length ? { changedSourceKeys } : {})
    };

    let result;
    if (mode === 'materialize') {
      result = await materializeCorpus(inputRoot, executionArgs);
    } else if (mode === 'llm_optimize') {
      result = await llmOptimizeCorpus(inputRoot, executionArgs);
    } else if (mode === 'optimize') {
      result = await optimizeCorpus(inputRoot, executionArgs);
    } else if (mode === 'analyze') {
      result = await analyzeCorpus(inputRoot, executionArgs);
    } else {
      throw new Error(`Unknown refresh_corpus mode: ${args.mode || '<missing>'}`);
    }

    return JSON.stringify({
      contractVersion: 'papernexus-corpus-refresh-v1',
      corpus: result.meta?.name || '',
      rootPath: result.rootPath || rootPath,
      inputPath: result.inputPath || inputRoot,
      mode,
      stage: result.stage || result.meta?.stage || (
        mode === 'materialize'
          ? 'materialized'
          : (mode === 'llm_optimize' ? 'llm-optimized' : 'completed')
      ),
      graphCommitted: mode === 'analyze' || mode === 'optimize',
      reused: Boolean(result.reused),
      changes: result.changes || result.meta?.lastChangeSummary || null,
      options: {
        incremental: mode === 'analyze' ? incremental : null,
        force,
        semanticExtraction: semanticExtraction || null,
        rebuildPdfMarkdown: rebuildPdfMarkdown === undefined ? null : rebuildPdfMarkdown === true,
        llmBatchSize: llmBatchSize ?? null,
        changedSourceKeys
      },
      meta: result.meta
        ? {
            ...result.meta,
            rootPath: result.rootPath || rootPath
          }
        : null
    }, null, 2);
  }

  if (name === 'refresh_paper_graph') {
    const rootPath = await resolveCorpus(args.corpus);
    const { refreshPaperGraphContent } = await import('../core/ingestion/pipeline.js');
    return JSON.stringify(await refreshPaperGraphContent(rootPath, {
      rootPath,
      paperId: args.paperId,
      sourceKey: args.sourceKey,
      source: args.source,
      paperTitle: args.paperTitle,
      includeDuplicateGroup: args.includeDuplicateGroup !== false,
      rebuildPdfMarkdown: args.rebuildPdfMarkdown !== false,
      semanticExtraction: args.semanticExtraction
    }), null, 2);
  }

  if (name === 'research_lookup') {
    return executeResearchLookupTool(args, options);
  }

  if (name === 'research_briefing') {
    return executeResearchBriefingTool(args, options);
  }

  if (name === 'import_workflow') {
    return executeImportWorkflowTool(args, options);
  }

  if (name === 'literature_discovery') {
    return executeLiteratureDiscoveryTool(args, options);
  }

  if (name === 'idea_catalyst') {
    return executeIdeaCatalystTool(args, options);
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

export async function handleMessage(message, options = {}) {
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
        content: normalizeToolContent(await executeTool(message.params?.name, message.params?.arguments || {}, options))
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
