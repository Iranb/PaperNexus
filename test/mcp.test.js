import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const examplesRoot = path.join(projectRoot, 'examples');
const cliPath = path.join(projectRoot, 'src', 'cli', 'index.js');

let tempHome;
let tempCorpusRoot;
let pending;
let nextId = 1;
let loadCorpus;
let previousGraphBackend;

function startMcpClient(env) {
  const child = spawn('node', [cliPath, 'mcp'], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const requests = new Map();
  let buffer = Buffer.alloc(0);
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.stdout.on('data', (chunk) => {
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
      } catch {
        continue;
      }

      const pendingRequest = requests.get(message.id);
      if (!pendingRequest) continue;
      requests.delete(message.id);

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message));
        continue;
      }

      pendingRequest.resolve(message.result);
    }
  });

  return {
    child,
    async request(method, params = {}) {
      const id = nextId;
      nextId += 1;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          requests.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}. stderr=${stderr.trim()}`));
        }, 5000);

        requests.set(id, {
          resolve(result) {
            clearTimeout(timeout);
            resolve(result);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('close', () => resolve());
        setTimeout(resolve, 1000);
      });
    }
  };
}

before(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-home-'));
  tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-corpus-'));
  previousGraphBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  process.env.PAPERNEXUS_HOME = tempHome;
  process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(
      path.join(examplesRoot, fileName),
      path.join(tempCorpusRoot, fileName)
    );
  }

  const [{ analyzeCorpus }, corpusStore] = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/storage/corpus-store.js')
  ]);

  loadCorpus = corpusStore.loadCorpus;

  await analyzeCorpus(tempCorpusRoot, {
    name: 'mcp-papers',
    force: true
  });

  pending = startMcpClient({
    ...process.env,
    PAPERNEXUS_HOME: tempHome,
    PAPERNEXUS_GRAPH_BACKEND: 'json'
  });
});

after(async () => {
  if (pending) {
    await pending.close();
  }
  if (previousGraphBackend === undefined) {
    delete process.env.PAPERNEXUS_GRAPH_BACKEND;
  } else {
    process.env.PAPERNEXUS_GRAPH_BACKEND = previousGraphBackend;
  }
  await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  await fs.rm(tempHome, { recursive: true, force: true });
});

test('MCP initialize, tools, prompts, and resources endpoints return expected metadata', async () => {
  const initialized = await pending.request('initialize', {});
  assert.equal(initialized.serverInfo.name, 'papernexus');
  assert.equal(initialized.protocolVersion, '2024-11-05');

  const tools = await pending.request('tools/list', {});
  assert.ok(tools.tools.some((tool) => tool.name === 'brainstorm'));
  assert.ok(tools.tools.some((tool) => tool.name === 'query'));
  assert.ok(tools.tools.some((tool) => tool.name === 'mutate_graph'));

  const prompts = await pending.request('prompts/list', {});
  assert.ok(prompts.prompts.some((prompt) => prompt.name === 'brainstorm_topic'));

  const brainstormPrompt = await pending.request('prompts/get', { name: 'brainstorm_topic' });
  assert.match(brainstormPrompt.description, /divergent exploration/i);
  assert.match(brainstormPrompt.messages[0].content.text, /Call brainstorm with mode diverge/);

  const resources = await pending.request('resources/list', {});
  assert.ok(resources.resources.some((resource) => resource.uri === 'papernexus://corpora'));
  assert.ok(resources.resources.some((resource) => resource.uri.includes('/context')));
  assert.ok(resources.resources.some((resource) => resource.uri.includes('/methods')));
});

test('MCP tool calls and resource reads work against an indexed corpus', async () => {
  const methodsResource = await pending.request('resources/read', {
    uri: 'papernexus://corpus/mcp-papers/methods'
  });
  assert.equal(methodsResource.contents[0].mimeType, 'text/markdown');
  assert.match(methodsResource.contents[0].text, /Methods:/);

  const brainstormResult = await pending.request('tools/call', {
    name: 'brainstorm',
    arguments: {
      corpus: tempCorpusRoot,
      query: 'experiment planning',
      mode: 'converge',
      maxHops: 2,
      layers: 'ProblemLayer,MethodLayer,ConstraintLayer',
      layerMode: 'cross'
    }
  });
  assert.equal(brainstormResult.content[0].type, 'text');
  assert.match(brainstormResult.content[0].text, /Mode: converge/);
  assert.match(brainstormResult.content[0].text, /Converged directions:/);

  const queryResult = await pending.request('tools/call', {
    name: 'query',
    arguments: {
      corpus: tempCorpusRoot,
      query: 'graph augmented literature mapping',
      limit: 3
    }
  });
  assert.match(queryResult.content[0].text, /Results for/);

  const statusResult = await pending.request('tools/call', {
    name: 'corpus_status',
    arguments: {
      corpus: tempCorpusRoot
    }
  });
  assert.match(statusResult.content[0].text, /Graph mode: explicit-multilayer/);
});

test('MCP mutate_graph previews and applies validated graph edits', async () => {
  const preview = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: true,
      operations: [
        {
          action: 'create_node',
          type: 'Problem',
          name: 'pseudo-label collapse under class imbalance'
        }
      ]
    }
  });
  assert.match(preview.content[0].text, /Graph mutation preview/);
  assert.match(preview.content[0].text, /\+1 nodes/);

  let corpus = await loadCorpus(tempCorpusRoot);
  assert.ok(!corpus.graph.nodes.some((node) => node.name === 'pseudo-label collapse under class imbalance'));

  const applyResult = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: false,
      operations: [
        {
          action: 'create_node',
          type: 'Problem',
          name: 'pseudo-label collapse under class imbalance'
        },
        {
          action: 'create_node',
          type: 'Method',
          name: 'class-balanced uncertainty gating'
        },
        {
          action: 'create_relationship',
          source: { type: 'Method', name: 'class-balanced uncertainty gating' },
          target: { type: 'Problem', name: 'pseudo-label collapse under class imbalance' },
          type: 'APPLIES_TO'
        }
      ]
    }
  });
  assert.match(applyResult.content[0].text, /Graph mutation applied/);
  assert.match(applyResult.content[0].text, /Created relationship/);

  corpus = await loadCorpus(tempCorpusRoot);
  const problemNode = corpus.graph.nodes.find((node) => node.name === 'pseudo-label collapse under class imbalance');
  const methodNode = corpus.graph.nodes.find((node) => node.name === 'class-balanced uncertainty gating');
  assert.ok(problemNode);
  assert.ok(methodNode);
  assert.ok(
    corpus.graph.relationships.some((relationship) => {
      return relationship.type === 'APPLIES_TO'
        && relationship.sourceId === methodNode.id
        && relationship.targetId === problemNode.id;
    })
  );

  const invalid = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: true,
      operations: [
        {
          action: 'create_relationship',
          source: { id: methodNode.id },
          target: { id: problemNode.id },
          type: 'SUPPORTED_BY'
        }
      ]
    }
  }).then(() => null).catch((error) => error);
  assert.ok(invalid);
  assert.match(invalid.message, /Invalid relationship/);
});
