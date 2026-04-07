import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function createIndexedCorpus(prefix, corpusName) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-home-`));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-corpus-`));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousGraphBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

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

  const { analyzeCorpus } = await import('../src/core/ingestion/pipeline.js');
  await analyzeCorpus(tempCorpusRoot, {
    name: corpusName,
    force: true
  });

  return {
    tempHome,
    tempCorpusRoot,
    previousHome,
    previousGraphBackend
  };
}

async function cleanupIndexedCorpus(fixture) {
  if (!fixture) return;

  if (fixture.previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = fixture.previousHome;

  if (fixture.previousGraphBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
  else process.env.PAPERNEXUS_GRAPH_BACKEND = fixture.previousGraphBackend;

  await fs.rm(fixture.tempCorpusRoot, { recursive: true, force: true });
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
}

async function startHttpServer(port, serveConfig = {}, options = {}) {
  const { serveCommand } = await import('../src/server/http.js');
  return serveCommand({
    host: '127.0.0.1',
    port,
    enableEnhancements: false,
    enableImports: false,
    enableAuthoritativeSync: false,
    config: {
      serve: serveConfig
    },
    ...options
  });
}

async function postMcp(port, payload, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers || {})
  };
  const method = options.method || 'POST';
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${port}${options.path || '/mcp'}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body })
  });
  return response;
}

test('serveCommand exposes authenticated MCP over HTTP for initialize, metadata, tools, and resources', async () => {
  const fixture = await createIndexedCorpus('papernexus-mcp-http', 'mcp-http-papers');
  const port = 55000 + Math.floor(Math.random() * 1000);
  const serverHandle = await startHttpServer(port, {
    apiToken: 'secret-token',
    mcp: {
      enabled: true
    }
  });

  try {
    const initialized = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    }, { token: 'secret-token' }).then((response) => response.json());
    assert.equal(initialized.result.serverInfo.name, 'papernexus');
    assert.equal(initialized.result.protocolVersion, '2024-11-05');

    const tools = await postMcp(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    }, { token: 'secret-token' }).then((response) => response.json());
    assert.ok(tools.result.tools.some((tool) => tool.name === 'refresh_corpus'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'mutate_graph'));

    const prompt = await postMcp(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'brainstorm_topic' }
    }, { token: 'secret-token' }).then((response) => response.json());
    assert.match(prompt.result.description, /divergent exploration/i);

    const methods = await postMcp(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: {
        uri: 'papernexus://corpus/mcp-http-papers/methods'
      }
    }, { token: 'secret-token' }).then((response) => response.json());
    assert.equal(methods.result.contents[0].mimeType, 'text/markdown');
    assert.match(methods.result.contents[0].text, /Methods:/);

    const query = await postMcp(port, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          corpus: fixture.tempCorpusRoot,
          query: 'graph augmented literature mapping',
          limit: 3
        }
      }
    }, { token: 'secret-token' }).then((response) => response.json());
    assert.match(query.result.content[0].text, /Results for/);
  } finally {
    await serverHandle.stop();
    await cleanupIndexedCorpus(fixture);
  }
});

test('serveCommand rejects unauthorized, disabled, invalid, and unsupported HTTP MCP requests', async () => {
  const fixture = await createIndexedCorpus('papernexus-mcp-http-errors', 'mcp-http-error-papers');
  const enabledPort = 56000 + Math.floor(Math.random() * 500);
  const disabledPort = enabledPort + 500;

  const enabledServer = await startHttpServer(enabledPort, {
    apiToken: 'secret-token',
    mcp: {
      enabled: true
    }
  });

  const disabledServer = await startHttpServer(disabledPort, {
    apiToken: 'secret-token'
  });

  try {
    const unauthorized = await postMcp(enabledPort, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });
    assert.equal(unauthorized.status, 401);

    const batchResponse = await postMcp(enabledPort, [
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {}
      }
    ], { token: 'secret-token' });
    assert.equal(batchResponse.status, 400);
    const batchPayload = await batchResponse.json();
    assert.equal(batchPayload.error.code, -32600);

    const invalidJsonResponse = await postMcp(enabledPort, '{', {
      token: 'secret-token',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    assert.equal(invalidJsonResponse.status, 400);
    const invalidJsonPayload = await invalidJsonResponse.json();
    assert.equal(invalidJsonPayload.error.code, -32700);

    const unsupportedMethod = await postMcp(enabledPort, '', {
      token: 'secret-token',
      method: 'GET'
    });
    assert.equal(unsupportedMethod.status, 405);

    const disabled = await postMcp(disabledPort, {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {}
    }, { token: 'secret-token' });
    assert.equal(disabled.status, 404);
  } finally {
    await enabledServer.stop();
    await disabledServer.stop();
    await cleanupIndexedCorpus(fixture);
  }
});

test('serveCommand fails closed for HTTP MCP when auth is not configured', async () => {
  const fixture = await createIndexedCorpus('papernexus-mcp-http-authless', 'mcp-http-authless-papers');
  const port = 57000 + Math.floor(Math.random() * 500);
  const serverHandle = await startHttpServer(port, {
    mcp: {
      enabled: true
    }
  });

  try {
    const response = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    }, {
      token: 'anything'
    });
    assert.equal(response.status, 503);
  } finally {
    await serverHandle.stop();
    await cleanupIndexedCorpus(fixture);
  }
});
