import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'SKILL', 'PaperNexus', 'scripts', 'pn_resilient_discovery.py');

async function runWrapper(args = [], options = {}) {
  const { stdout, stderr } = await execFileAsync('python3', [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAPERNEXUS_ALLOW_LOCAL_MCP: '1',
      ...(options.env || {})
    }
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

function mcpTextResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function startMockMcp(handler) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body || '{}');
    const params = rpc.params || {};
    const toolName = params.name || '';
    const toolArgs = params.arguments || {};
    const handled = await handler(toolName, toolArgs, rpc);

    if (handled?.httpStatus) {
      response.writeHead(handled.httpStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: handled.error || 'mock failure' }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: rpc.id,
      result: mcpTextResult(handled || {})
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

test('pn_resilient_discovery.py submits, polls report, and reads import queue progress', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-resilient-discovery-'));
  const ledgerPath = path.join(tempDir, 'ledger.json');
  const calls = [];
  const server = await startMockMcp((toolName, args) => {
    calls.push({ toolName, args });
    if (toolName === 'literature_discovery' && args.operation === 'submit') {
      assert.equal(args.discoveryOperation, 'search');
      assert.equal(args.corpus, 'GCD');
      assert.equal(args.topic, 'source-free GCD');
      assert.match(args.runId, /^pn-test-workflow-target-[a-f0-9]{12}$/);
      return {
        contractVersion: 'literature-discovery-submit-v1',
        runId: args.runId,
        status: 'submitted',
        stage: 'queued',
        progress: {
          runId: args.runId,
          status: 'queued',
          stage: 'queued'
        }
      };
    }
    if (toolName === 'literature_discovery' && args.operation === 'progress') {
      return {
        runId: args.runId,
        status: 'completed',
        stage: 'completed',
        event: 'completed'
      };
    }
    if (toolName === 'literature_discovery' && args.operation === 'report') {
      return {
        runId: args.runId,
        topic: 'source-free GCD',
        candidates: [
          {
            title: 'Mock Discovery Paper',
            import: {
              taskId: 'task-import-1'
            }
          }
        ],
        importSummary: {
          submitted: 1
        }
      };
    }
    if (toolName === 'import_workflow' && args.operation === 'queue_progress') {
      assert.deepEqual(args.taskIds, ['task-import-1']);
      return {
        contractVersion: 'import-progress-v1',
        tasks: [
          {
            id: 'task-import-1',
            status: 'completed',
            stage: 'completed'
          }
        ],
        summary: {
          remaining: 0,
          overallPercent: 100
        }
      };
    }
    throw new Error(`Unexpected tool call ${toolName} ${args.operation}`);
  });

  try {
    const commonArgs = [
      '--json',
      '--mcp-url', server.url,
      '--token', 'test',
      '--corpus', 'GCD',
      '--workflow-id', 'test-workflow',
      '--ledger', ledgerPath
    ];

    const submit = await runWrapper([
      ...commonArgs,
      'submit',
      '--lane', 'target',
      '--topic', 'source-free GCD'
    ]);
    const submitted = JSON.parse(submit.stdout);
    assert.equal(submitted.summary.submitted, 1);
    assert.equal(submitted.results[0].status, 'submitted');

    const poll = await runWrapper([
      ...commonArgs,
      'poll',
      '--lane', 'target'
    ]);
    const polled = JSON.parse(poll.stdout);
    assert.equal(polled.summary.reportReady, 1);
    assert.deepEqual(polled.results[0].importTaskIds, ['task-import-1']);

    const queue = await runWrapper([
      ...commonArgs,
      'queue',
      '--lane', 'target'
    ]);
    const queued = JSON.parse(queue.stdout);
    assert.equal(queued.status, 'read');
    assert.equal(queued.queueProgress.summary.overallPercent, 100);

    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    assert.equal(ledger.lanes.target.status, 'report_ready');
    assert.deepEqual(ledger.lanes.target.importTaskIds, ['task-import-1']);
    assert.equal(ledger.lanes.target.queueProgress.tasks[0].stage, 'completed');
    assert.ok(calls.some((call) => call.toolName === 'import_workflow'));
  } finally {
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pn_resilient_discovery.py records unknown_after_timeout for submit transport failures', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-resilient-discovery-timeout-'));
  const ledgerPath = path.join(tempDir, 'ledger.json');
  const server = await startMockMcp((toolName, args) => {
    assert.equal(toolName, 'literature_discovery');
    assert.equal(args.operation, 'submit');
    return {
      httpStatus: 503,
      error: {
        message: 'busy'
      }
    };
  });

  try {
    const result = await runWrapper([
      '--json',
      '--mcp-url', server.url,
      '--token', 'test',
      '--corpus', 'GCD',
      '--workflow-id', 'timeout-workflow',
      '--ledger', ledgerPath,
      'submit',
      '--lane', 'target',
      '--topic', 'source-free GCD'
    ]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.results[0].status, 'unknown_after_timeout');
    assert.equal(payload.summary.unknownAfterTimeout, 1);

    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    assert.equal(ledger.lanes.target.status, 'unknown_after_timeout');
    assert.equal(ledger.lanes.target.stage, 'needs_reconcile');
    assert.match(ledger.lanes.target.runId, /^pn-timeout-workflow-target-[a-f0-9]{12}$/);
    assert.match(ledger.lanes.target.lastError, /HTTP 503/);
  } finally {
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
