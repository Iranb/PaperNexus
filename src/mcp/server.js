import { buildBrainstorm, buildContext, buildImpact, buildResearchIdeas, searchGraph } from '../core/search/search.js';
import { renderBrainstormResult, renderContextResult, renderCorpusList, renderIdeasResult, renderImpactResult, renderMutationResult, renderQueryResult, renderStatus } from '../lib/render.js';
import { applyCorpusMutations, loadCorpus, loadCorpusLite, resolveCorpus } from '../storage/corpus-store.js';
import { loadRegistry } from '../storage/registry.js';
import { PAPERNEXUS_PROMPTS, getPrompt } from './prompts.js';
import { listResources, readResource } from './resources.js';
import { PAPERNEXUS_TOOLS } from './tools.js';

const SERVER_INFO = {
  name: 'papernexus',
  version: '0.1.0'
};

function sendMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function executeTool(name, args) {
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
    return renderBrainstormResult(buildBrainstorm(graph, args.query, {
      mode: args.mode || 'diverge',
      maxHops: args.maxHops,
      limit: args.limit,
      layers: args.layers,
      layerMode: args.layerMode || 'any'
    }));
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

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
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
        content: [
          {
            type: 'text',
            text: await executeTool(message.params?.name, message.params?.arguments || {})
          }
        ]
      };
    case 'resources/list':
      return { resources: await listResources() };
    case 'resources/read':
      return {
        contents: [
          {
            uri: message.params?.uri,
            mimeType: 'text/markdown',
            text: await readResource(message.params?.uri)
          }
        ]
      };
    case 'prompts/list':
      return { prompts: PAPERNEXUS_PROMPTS };
    case 'prompts/get':
      return getPrompt(message.params?.name);
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}

export function startMcpServer() {
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + bodyLength;
      if (buffer.length < messageEnd) return;

      const body = buffer.slice(headerEnd + 4, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        continue;
      }

      try {
        const result = await handleRequest(message);
        sendMessage({
          jsonrpc: '2.0',
          id: message.id,
          result
        });
      } catch (error) {
        sendMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: error.message
          }
        });
      }
    }
  });
}
