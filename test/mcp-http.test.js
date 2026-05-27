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
    apiToken: 'test',
    mcp: {
      enabled: true
    }
  });

  try {
    const initializedResponse = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    }, { token: 'test' });
    const sessionId = initializedResponse.headers.get('mcp-session-id');
    assert.match(sessionId, /^pn-[0-9a-f-]+$/i);
    const initialized = await initializedResponse.json();
    assert.equal(initialized.result.serverInfo.name, 'papernexus');
    assert.equal(initialized.result.protocolVersion, '2024-11-05');

    const notification = await postMcp(port, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }, {
      token: 'test',
      headers: { 'Mcp-Session-Id': sessionId }
    });
    assert.equal(notification.status, 202);
    assert.equal(notification.headers.get('mcp-session-id'), sessionId);
    assert.equal(await notification.text(), '');

    const tools = await postMcp(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    }, {
      token: 'test',
      headers: { 'Mcp-Session-Id': sessionId }
    }).then((response) => {
      assert.equal(response.headers.get('mcp-session-id'), sessionId);
      return response.json();
    });
    assert.ok(tools.result.tools.some((tool) => tool.name === 'runtime_init'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'create_corpus'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'refresh_corpus'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'mutate_graph'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'corpus_sources'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'research_lookup'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'research_briefing'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'import_workflow'));
    assert.ok(tools.result.tools.some((tool) => tool.name === 'idea_catalyst'));

    const streamController = new AbortController();
    const eventStream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer test',
        'Mcp-Session-Id': sessionId
      },
      signal: streamController.signal
    });
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(eventStream.headers.get('mcp-session-id'), sessionId);
    const streamReader = eventStream.body.getReader();
    const streamChunk = await streamReader.read();
    assert.match(new TextDecoder().decode(streamChunk.value), /papernexus stream opened/);
    await streamReader.cancel();
    streamController.abort();

    const deleted = await postMcp(port, '', {
      token: 'test',
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId }
    });
    assert.equal(deleted.status, 202);
    assert.equal(deleted.headers.get('mcp-session-id'), sessionId);
    assert.equal(await deleted.text(), '');

    const prompt = await postMcp(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'brainstorm_topic' }
    }, { token: 'test' }).then((response) => response.json());
    assert.match(prompt.result.description, /divergent exploration/i);

    const methods = await postMcp(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: {
        uri: 'papernexus://corpus/mcp-http-papers/methods'
      }
    }, { token: 'test' }).then((response) => response.json());
    assert.equal(methods.result.contents[0].mimeType, 'text/markdown');
    assert.match(methods.result.contents[0].text, /Methods:/);

    const resourceTemplates = await postMcp(port, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/templates/list',
      params: {}
    }, { token: 'test' }).then((response) => response.json());
    assert.deepEqual(resourceTemplates.result.resourceTemplates, []);

    const query = await postMcp(port, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          corpus: fixture.tempCorpusRoot,
          query: 'graph augmented literature mapping',
          limit: 3
        }
      }
    }, { token: 'test' }).then((response) => response.json());
    assert.match(query.result.content[0].text, /Results for/);

    const aggregatedLookup = await postMcp(port, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'research_lookup',
        arguments: {
          operation: 'query',
          corpus: fixture.tempCorpusRoot,
          query: 'graph augmented literature mapping',
          options: {
            limit: 3
          }
        }
      }
    }, { token: 'test' }).then((response) => response.json());
    const parsedLookup = JSON.parse(aggregatedLookup.result.content[0].text);
    assert.equal(parsedLookup.result.query, 'graph augmented literature mapping');
    assert.ok(parsedLookup.result.groups.length > 0);

    const corpusSources = await postMcp(port, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'corpus_sources',
        arguments: {
          corpus: fixture.tempCorpusRoot
        }
      }
    }, { token: 'test' }).then((response) => response.json());
    const parsedSources = JSON.parse(corpusSources.result.content[0].text);
    assert.equal(parsedSources.meta.name, 'mcp-http-papers');
    assert.ok(Array.isArray(parsedSources.sources));
    assert.equal(parsedSources.sources.length, 2);

    const apiSources = await fetch(
      `http://127.0.0.1:${port}/api/corpus-sources?name=mcp-http-papers`,
      {
        headers: {
          Authorization: 'Bearer test'
        }
      }
    ).then((response) => response.json());
    assert.equal(apiSources.meta.name, 'mcp-http-papers');
    assert.ok(Array.isArray(apiSources.sources));
    assert.equal(apiSources.sources.length, 2);
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
    apiToken: 'test',
    mcp: {
      enabled: true
    }
  });

  const disabledServer = await startHttpServer(disabledPort, {
    apiToken: 'test'
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
    ], { token: 'test' });
    assert.equal(batchResponse.status, 400);
    const batchPayload = await batchResponse.json();
    assert.equal(batchPayload.error.code, -32600);

    const invalidJsonResponse = await postMcp(enabledPort, '{', {
      token: 'test',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    assert.equal(invalidJsonResponse.status, 400);
    const invalidJsonPayload = await invalidJsonResponse.json();
    assert.equal(invalidJsonPayload.error.code, -32700);

    const missingSessionStream = await postMcp(enabledPort, '', {
      token: 'test',
      method: 'GET'
    });
    assert.equal(missingSessionStream.status, 400);
    const missingSessionPayload = await missingSessionStream.json();
    assert.equal(missingSessionPayload.error.code, -32600);

    const unsupportedMethod = await postMcp(enabledPort, '', {
      token: 'test',
      method: 'PUT'
    });
    assert.equal(unsupportedMethod.status, 405);

    const disabled = await postMcp(disabledPort, {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {}
    }, { token: 'test' });
    assert.equal(disabled.status, 404);
  } finally {
    await enabledServer.stop();
    await disabledServer.stop();
    await cleanupIndexedCorpus(fixture);
  }
});

test('serveCommand applies JSON body limits to HTTP MCP requests', async () => {
  const port = 56500 + Math.floor(Math.random() * 500);
  const serverHandle = await startHttpServer(port, {
    apiToken: 'test',
    mcp: {
      enabled: true
    }
  }, {
    maxJsonBodyBytes: 64
  });

  try {
    const response = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        oversized: 'x'.repeat(128)
      }
    }, { token: 'test' });

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.error.code, -32700);
    assert.match(payload.error.message, /exceeds the configured limit/);
  } finally {
    await serverHandle.stop();
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

test('serveCommand background workers ignore an invalid configured storage index', async () => {
  const fixture = await createIndexedCorpus('papernexus-mcp-http-worker-root', 'mcp-http-worker-root-papers');
  const invalidIndexRoot = path.join(fixture.tempHome, 'index-store');
  const port = 57500 + Math.floor(Math.random() * 500);
  const capturedRoots = {
    enhancement: null,
    authoritativeSync: null,
    import: null,
  };
  const makeStarter = (key) => (options = {}) => {
    capturedRoots[key] = options.rootPaths;
    return {
      stop() {}
    };
  };

  const { serveCommand } = await import('../src/server/http.js');
  const serverHandle = await serveCommand({
    host: '127.0.0.1',
    port,
    apiToken: 'test',
    enableMineruWarmup: false,
    config: {
      serve: {
        apiToken: 'test'
      },
      storage: {
        indexDir: invalidIndexRoot
      }
    },
    startEnhancementWorker: makeStarter('enhancement'),
    startAuthoritativeSyncWorker: makeStarter('authoritativeSync'),
    startImportWorker: makeStarter('import')
  });

  try {
    assert.equal(capturedRoots.enhancement, undefined);
    assert.equal(capturedRoots.authoritativeSync, undefined);
    assert.equal(capturedRoots.import, undefined);
  } finally {
    await serverHandle.stop();
    await cleanupIndexedCorpus(fixture);
  }
});
