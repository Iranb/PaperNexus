import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'run-import-burst-harness.mjs');

function runScript(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(options.env || {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

async function tempWorkspace(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function createFakeImportServer() {
  const requests = [];
  const tasks = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};

    requests.push({
      method: request.method,
      path: url.pathname,
      corpus: url.searchParams.get('name'),
      authorization: request.headers.authorization || '',
      body
    });

    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (request.headers.authorization !== 'Bearer fake-token') {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/imports') {
      const taskId = `imp:fake-${tasks.size + 1}`;
      const uploaded = body.files?.[0] || {};
      const task = {
        id: taskId,
        status: 'pending',
        stage: 'queued',
        processingProfile: body.processingProfile,
        completionPolicy: body.completionPolicy,
        graphVisibilityStatus: 'pending',
        semanticStatus: 'queued',
        files: [
          {
            originalName: uploaded.name || null
          }
        ]
      };
      tasks.set(taskId, {
        task,
        polls: 0
      });
      response.statusCode = 202;
      response.end(JSON.stringify({ task, deduped: false }));
      return;
    }

    const match = url.pathname.match(/^\/api\/imports\/([^/]+)$/);
    if (request.method === 'GET' && match) {
      const taskId = decodeURIComponent(match[1]);
      const entry = tasks.get(taskId);
      if (!entry) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'missing task' }));
        return;
      }
      entry.polls += 1;
      const task = {
        ...entry.task,
        status: 'completed',
        stage: 'completed',
        graphVisibilityStatus: 'completed',
        semanticStatus: 'queued',
        authoritativeSyncStatus: 'pending',
        throughputMetrics: {
          graphVisibleLatencyMs: 25
        },
        result: {
          metrics: {
            importPerformance: {
              llmOptimizeSkipped: true,
              stageTimingsMs: {
                materialize: 5,
                fastCommit: 2
              },
              fastCommitPhasesMs: {
                applyDelta: 1
              }
            }
          },
          fastCommitted: {
            changedSourceKeys: [`sources/${taskId}.md`]
          },
          semanticEnrichment: {
            jobIds: [`sem:${taskId}`]
          }
        }
      };
      entry.task = task;
      response.statusCode = 200;
      response.end(JSON.stringify({ task }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function fakeImportWorkflowToolSchema({ legacy = false } = {}) {
  const properties = {
    operation: {
      type: 'string',
      enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait']
    },
    corpus: {
      type: 'string'
    },
    taskId: {
      type: 'string'
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true
      }
    },
    waitForAuthoritativeSync: {
      type: 'boolean'
    }
  };
  if (!legacy) {
    Object.assign(properties, {
      processingProfile: {
        type: 'string',
        enum: ['full', 'fast-md-structural', 'fast-md-background-semantic', 'long-context-full-md']
      },
      completionPolicy: {
        type: 'string',
        enum: ['full', 'graph-visible', 'semantic-complete']
      },
      llmContextWindowTokens: {
        type: 'number',
        minimum: 1
      },
      llmExtractionStrategy: {
        type: 'string',
        enum: ['long-context-first', 'chunk-first', 'auto']
      },
      llmLongContextMaxPapersPerCall: {
        type: 'number',
        minimum: 1
      },
      llmBatchConcurrency: {
        type: 'number',
        minimum: 1
      },
      waitUntil: {
        type: 'string',
        enum: ['task-completed', 'graph-visible', 'semantic-complete', 'authoritative-sync']
      }
    });
  }
  return {
    name: 'import_workflow',
    description: 'fake import workflow',
    inputSchema: {
      type: 'object',
      properties,
      required: ['operation']
    }
  };
}

async function createFakeMcpImportServer(options = {}) {
  const requests = [];
  const toolCalls = [];
  const tasks = new Map();
  const sessionId = 'fake-mcp-session';
  const legacySchema = Boolean(options.legacySchema);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : {};

    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization || '',
      sessionId: request.headers['mcp-session-id'] || '',
      body
    });

    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Mcp-Session-Id', sessionId);

    if (request.headers.authorization !== 'Bearer fake-token') {
      response.statusCode = 401;
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'Unauthorized' } }));
      return;
    }

    if (body.method === 'initialize') {
      response.statusCode = 200;
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'fake-papernexus-mcp',
            version: '1.0.0'
          },
          capabilities: {
            tools: {}
          }
        }
      }));
      return;
    }

    if (body.method === 'tools/list') {
      response.statusCode = 200;
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [fakeImportWorkflowToolSchema({ legacy: legacySchema })]
        }
      }));
      return;
    }

    if (body.method === 'tools/call' && body.params?.name === 'import_workflow') {
      const args = body.params.arguments || {};
      toolCalls.push(args);
      let payload;
      if (args.operation === 'submit') {
        const taskId = `imp:mcp-fake-${tasks.size + 1}`;
        const uploaded = args.files?.[0] || {};
        const task = {
          id: taskId,
          status: 'pending',
          stage: 'queued',
          processingProfile: args.processingProfile,
          completionPolicy: args.completionPolicy,
          graphVisibilityStatus: 'pending',
          semanticStatus: 'queued',
          authoritativeSyncStatus: 'pending',
          files: [
            {
              originalName: uploaded.name || null
            }
          ]
        };
        tasks.set(taskId, task);
        payload = { task, deduped: false };
      } else if (args.operation === 'wait') {
        const task = tasks.get(args.taskId);
        if (!task) {
          response.statusCode = 404;
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'missing task' } }));
          return;
        }
        const semanticDone = args.waitUntil === 'semantic-complete';
        const updated = {
          ...task,
          status: 'completed',
          stage: 'completed',
          graphVisibilityStatus: 'completed',
          semanticStatus: semanticDone ? 'completed' : 'queued',
          authoritativeSyncStatus: 'pending',
          throughputMetrics: {
            graphVisibleLatencyMs: 20
          },
          result: {
            authoritativeSync: {
              status: 'pending'
            },
            metrics: {
              importPerformance: {
                llmOptimizeSkipped: true,
                stageTimingsMs: {
                  materialize: 6,
                  fastCommit: 3
                },
                fastCommitPhasesMs: {
                  applyDelta: 2
                }
              }
            },
            fastCommitted: {
              changedSourceKeys: [`sources/${args.taskId}.md`]
            },
            semanticEnrichment: {
              jobIds: [`sem:${args.taskId}`]
            }
          }
        };
        tasks.set(args.taskId, updated);
        payload = {
          waitTarget: args.waitUntil,
          waitForAuthoritativeSync: Boolean(args.waitForAuthoritativeSync),
          waitStatus: {
            satisfied: true,
            reason: args.waitUntil
          },
          task: updated
        };
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'unsupported operation' } }));
        return;
      }

      response.statusCode = 200;
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload)
            }
          ]
        }
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'not found' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    toolCalls,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('live import burst harness writes a dry-run report without a token', async () => {
  const workspace = await tempWorkspace('papernexus-burst-dry-');
  const reportPath = path.join(workspace, 'dry-run-report.json');
  try {
    await fs.writeFile(path.join(workspace, 'paper-a.md'), '# Paper A\n\n## Abstract\n\nDry run.\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'paper-b.md'), '# Paper B\n\n## Abstract\n\nDry run.\n', 'utf8');

    const result = await runScript([
      '--source-dir', workspace,
      '--limit', '1',
      '--report', reportPath,
      '--run-id', 'dry-run-test'
    ], {
      env: {
        PAPERNEXUS_API_TOKEN: ''
      }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run selected 1 markdown file/);
    const report = await readJson(reportPath);
    assert.equal(report.contractVersion, 'papernexus-live-import-burst-report-v1');
    assert.equal(report.dryRun, true);
    assert.equal(report.runId, 'dry-run-test');
    assert.equal(report.transport, 'http');
    assert.equal(report.mcpUrl, null);
    assert.equal(report.sourceFiles.length, 1);
    assert.equal(report.token.present, false);
    assert.equal(report.options.transport, 'http');
    assert.equal(report.effectiveConfig.llmContextWindowTokens, 1_000_000);
    assert.equal(report.effectiveConfig.llmExtractionStrategy, 'long-context-first');
    assert.equal(report.effectiveConfig.llmLongContextMaxPapersPerCall, 2);
    assert.equal(report.effectiveConfig.llmBatchConcurrency, 1);
    assert.equal(report.effectiveConfig.deviatesFromDefault1mContext, false);
    assert.equal(report.acceptance.reason, 'dry-run');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('live import burst harness submits tasks and polls graph-visible status over HTTP', async () => {
  const workspace = await tempWorkspace('papernexus-burst-live-');
  const reportPath = path.join(workspace, 'live-report.json');
  const fakeServer = await createFakeImportServer();
  try {
    await fs.writeFile(path.join(workspace, 'paper-a.md'), '# Paper A\n\n## Abstract\n\nLive run A.\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'paper-b.md'), '# Paper B\n\n## Abstract\n\nLive run B.\n', 'utf8');

    const result = await runScript([
      '--execute',
      '--api-base', fakeServer.baseUrl,
      '--token', 'fake-token',
      '--corpus', 'GCD',
      '--source-dir', workspace,
      '--limit', '2',
      '--report', reportPath,
      '--run-id', 'fake-run',
      '--poll-interval-ms', '5',
      '--timeout-ms', '2000',
      '--request-timeout-ms', '1000'
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Submitted 2 task/);
    const reportText = await fs.readFile(reportPath, 'utf8');
    assert.equal(reportText.includes('fake-token'), false);
    const report = JSON.parse(reportText);
    assert.equal(report.dryRun, false);
    assert.equal(report.transport, 'http');
    assert.equal(report.mcpUrl, null);
    assert.equal(report.corpus, 'GCD');
    assert.equal(report.submittedTasks.length, 2);
    assert.equal(report.tasks.length, 2);
    assert.equal(report.acceptance.completedCount, 2);
    assert.equal(report.acceptance.failedCount, 0);
    assert.equal(report.acceptance.passedFromLastSubmit, true);
    assert.equal(report.acceptance.passedMaxLatency, true);
    assert.equal(report.options.processingProfile, 'fast-md-background-semantic');
    assert.equal(report.options.transport, 'http');
    assert.equal(report.options.completionPolicy, 'graph-visible');
    assert.equal(report.options.llmContextWindowTokens, 1_000_000);
    assert.equal(report.options.llmExtractionStrategy, 'long-context-first');
    assert.equal(report.options.llmLongContextMaxPapersPerCall, 2);
    assert.equal(report.options.llmBatchConcurrency, 1);
    assert.equal(report.effectiveConfig.llmConfigScope, 'task-request');
    assert.equal(report.effectiveConfig.taskLevelLlmOverride, true);
    assert.deepEqual(report.effectiveConfig.deviationReasons, []);

    const posts = fakeServer.requests.filter((entry) => entry.method === 'POST');
    const gets = fakeServer.requests.filter((entry) => entry.method === 'GET');
    assert.equal(posts.length, 2);
    assert.equal(gets.length, 2);
    assert.deepEqual(new Set(posts.map((entry) => entry.corpus)), new Set(['GCD']));
    assert.ok(posts.every((entry) => entry.authorization === 'Bearer fake-token'));
    assert.ok(posts.every((entry) => entry.body.processingProfile === 'fast-md-background-semantic'));
    assert.ok(posts.every((entry) => entry.body.completionPolicy === 'graph-visible'));
    assert.ok(posts.every((entry) => entry.body.llmContextWindowTokens === 1_000_000));
    assert.ok(posts.every((entry) => entry.body.llmExtractionStrategy === 'long-context-first'));
    assert.ok(posts.every((entry) => entry.body.llmLongContextMaxPapersPerCall === 2));
    assert.ok(posts.every((entry) => entry.body.llmBatchConcurrency === 1));
    assert.ok(posts.every((entry) => entry.body.files[0].paperMetadata.identifiers.doi.startsWith('10.48550/papernexus.live-burst.fake-run.')));
    const decodedUpload = Buffer.from(posts[0].body.files[0].contentBase64, 'base64').toString('utf8');
    assert.match(decodedUpload, /papernexus-live-burst run=fake-run index=1/);
  } finally {
    await fakeServer.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('live import burst harness submits and waits through MCP import_workflow', async () => {
  const workspace = await tempWorkspace('papernexus-burst-mcp-');
  const reportPath = path.join(workspace, 'mcp-report.json');
  const fakeServer = await createFakeMcpImportServer();
  try {
    await fs.writeFile(path.join(workspace, 'paper-a.md'), '# Paper A\n\n## Abstract\n\nMCP run A.\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'paper-b.md'), '# Paper B\n\n## Abstract\n\nMCP run B.\n', 'utf8');

    const result = await runScript([
      '--execute',
      '--transport', 'mcp',
      '--mcp-url', fakeServer.mcpUrl,
      '--token', 'fake-token',
      '--corpus', 'GCD',
      '--source-dir', workspace,
      '--limit', '2',
      '--report', reportPath,
      '--run-id', 'fake-mcp-run',
      '--poll-interval-ms', '5',
      '--timeout-ms', '2000',
      '--request-timeout-ms', '1000',
      '--wait-semantic'
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Submitted 2 task/);
    const reportText = await fs.readFile(reportPath, 'utf8');
    assert.equal(reportText.includes('fake-token'), false);
    const report = JSON.parse(reportText);
    assert.equal(report.dryRun, false);
    assert.equal(report.transport, 'mcp');
    assert.equal(report.mcpUrl, fakeServer.mcpUrl);
    assert.equal(report.options.transport, 'mcp');
    assert.equal(report.corpus, 'GCD');
    assert.equal(report.submittedTasks.length, 2);
    assert.ok(report.submittedTasks.every((task) => task.transport === 'mcp'));
    assert.equal(report.tasks.length, 2);
    assert.equal(report.acceptance.completedCount, 2);
    assert.equal(report.acceptance.failedCount, 0);
    assert.equal(report.acceptance.passedFromLastSubmit, true);
    assert.equal(report.acceptance.passedMaxLatency, true);
    assert.equal(report.effectiveConfig.llmContextWindowTokens, 1_000_000);
    assert.equal(report.effectiveConfig.llmExtractionStrategy, 'long-context-first');
    assert.equal(report.effectiveConfig.llmLongContextMaxPapersPerCall, 2);
    assert.equal(report.effectiveConfig.llmBatchConcurrency, 1);
    assert.deepEqual(report.effectiveConfig.deviationReasons, []);
    assert.ok(report.tasks.every((task) => task.semanticStatus === 'completed'));

    const submitCalls = fakeServer.toolCalls.filter((entry) => entry.operation === 'submit');
    const graphWaitCalls = fakeServer.toolCalls.filter((entry) => entry.operation === 'wait' && entry.waitUntil === 'graph-visible');
    const semanticWaitCalls = fakeServer.toolCalls.filter((entry) => entry.operation === 'wait' && entry.waitUntil === 'semantic-complete');
    assert.equal(submitCalls.length, 2);
    assert.equal(graphWaitCalls.length, 2);
    assert.equal(semanticWaitCalls.length, 2);
    assert.ok(fakeServer.requests.every((entry) => entry.authorization === 'Bearer fake-token'));
    assert.ok(submitCalls.every((entry) => entry.corpus === 'GCD'));
    assert.ok(submitCalls.every((entry) => entry.processingProfile === 'fast-md-background-semantic'));
    assert.ok(submitCalls.every((entry) => entry.completionPolicy === 'graph-visible'));
    assert.ok(submitCalls.every((entry) => entry.llmContextWindowTokens === 1_000_000));
    assert.ok(submitCalls.every((entry) => entry.llmExtractionStrategy === 'long-context-first'));
    assert.ok(submitCalls.every((entry) => entry.llmLongContextMaxPapersPerCall === 2));
    assert.ok(submitCalls.every((entry) => entry.llmBatchConcurrency === 1));
    assert.ok(submitCalls.every((entry) => entry.files[0].paperMetadata.identifiers.doi.startsWith('10.48550/papernexus.live-burst.fake-mcp-run.')));
    assert.ok(graphWaitCalls.every((entry) => entry.waitForAuthoritativeSync === false));
    assert.ok(semanticWaitCalls.every((entry) => entry.waitForAuthoritativeSync === false));
  } finally {
    await fakeServer.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('live import burst harness can check MCP schema without sources or task submission', async () => {
  const fakeServer = await createFakeMcpImportServer();
  try {
    const result = await runScript([
      '--schema-check-only',
      '--transport', 'mcp',
      '--mcp-url', fakeServer.mcpUrl,
      '--token', 'fake-token',
      '--request-timeout-ms', '1000'
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /schema is ready/);
    assert.match(result.stdout, /no import tasks submitted/);
    assert.equal(fakeServer.toolCalls.length, 0);
    assert.ok(fakeServer.requests.some((entry) => entry.body?.method === 'tools/list'));
  } finally {
    await fakeServer.close();
  }
});

test('live import burst harness schema-check-only refuses stale MCP schema without submitting', async () => {
  const fakeServer = await createFakeMcpImportServer({ legacySchema: true });
  try {
    const result = await runScript([
      '--schema-check-only',
      '--transport', 'mcp',
      '--mcp-url', fakeServer.mcpUrl,
      '--token', 'fake-token',
      '--request-timeout-ms', '1000'
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /MCP import_workflow schema is not ready/);
    assert.match(result.stderr, /processingProfile=fast-md-background-semantic/);
    assert.match(result.stderr, /waitUntil=graph-visible/);
    assert.equal(fakeServer.toolCalls.length, 0);
  } finally {
    await fakeServer.close();
  }
});

test('live import burst harness refuses MCP execute when import_workflow schema is stale', async () => {
  const workspace = await tempWorkspace('papernexus-burst-mcp-stale-');
  const reportPath = path.join(workspace, 'mcp-stale-report.json');
  const fakeServer = await createFakeMcpImportServer({ legacySchema: true });
  try {
    await fs.writeFile(path.join(workspace, 'paper-a.md'), '# Paper A\n\n## Abstract\n\nStale MCP schema.\n', 'utf8');

    const result = await runScript([
      '--execute',
      '--transport', 'mcp',
      '--mcp-url', fakeServer.mcpUrl,
      '--token', 'fake-token',
      '--corpus', 'GCD',
      '--source-dir', workspace,
      '--limit', '1',
      '--report', reportPath,
      '--run-id', 'stale-mcp-run',
      '--request-timeout-ms', '1000'
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /MCP import_workflow schema is not ready/);
    assert.match(result.stderr, /processingProfile=fast-md-background-semantic/);
    assert.match(result.stderr, /completionPolicy=graph-visible/);
    assert.match(result.stderr, /llmContextWindowTokens/);
    assert.match(result.stderr, /waitUntil=graph-visible/);
    assert.equal(fakeServer.toolCalls.length, 0);
    await assert.rejects(() => fs.access(reportPath));
  } finally {
    await fakeServer.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
