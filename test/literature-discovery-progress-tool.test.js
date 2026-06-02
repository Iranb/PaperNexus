import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadDiscoveryProgress, saveDiscoveryProgress } from '../src/core/discovery/store.js';
import { handleMessage } from '../src/mcp/core.js';
import { executeLiteratureDiscoveryProgressTool } from '../src/mcp/tool-literature-discovery-progress.js';
import { startLiteratureDiscoveryRecoveryWorker } from '../src/mcp/tool-literature-discovery.js';

async function createTempCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-literature-discovery-progress-'));
  await fs.mkdir(path.join(rootPath, '.papernexus'), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, '.papernexus', 'meta.json'),
    JSON.stringify({ name: 'literature-discovery-progress-test', paperCount: 0, nodeCount: 0, relationshipCount: 0 }, null, 2)
  );
  return rootPath;
}

test('MCP tool list includes literature_discovery_progress', async () => {
  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  });

  const tool = response.tools.find((entry) => entry.name === 'literature_discovery_progress');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.pollIntervalMinutes.default, 5);
  assert.equal(tool.inputSchema.properties.staleAfterMinutes.default, 10);
  assert.ok(tool.inputSchema.properties.runId);
});

test('literature_discovery_progress summarizes budget ETA and poll recommendation', async () => {
  const rootPath = await createTempCorpus();
  const nowMs = Date.now();
  const runId = 'deep-progress-run';

  try {
    await saveDiscoveryProgress(rootPath, {
      runId,
      status: 'running',
      stage: 'provider_search',
      topic: 'timeout-safe literature survey',
      operation: 'search',
      searchMode: 'deep',
      submittedAt: new Date(nowMs - 60000).toISOString(),
      startedAt: new Date(nowMs - 30000).toISOString(),
      updatedAt: new Date(nowMs - 1000).toISOString(),
      rawCandidateCount: 506,
      providerCandidateCount: 343,
      candidateCount: 270,
      queryCount: 10,
      budget: {
        budgetMs: 600000,
        deadlineAt: nowMs + (7 * 60000),
        remainingMs: 7 * 60000
      }
    });

    const result = JSON.parse(await executeLiteratureDiscoveryProgressTool({
      corpus: rootPath,
      runId
    }));

    assert.equal(result.contractVersion, 'literature-discovery-progress-query-v1');
    assert.equal(result.current.runId, runId);
    assert.equal(result.current.stage, 'provider_search');
    assert.equal(result.current.counts.rawCandidateCount, 506);
    assert.equal(result.current.counts.candidateCount, 270);
    assert.equal(result.current.eta.source, 'budget.deadlineAt');
    assert.equal(result.current.eta.estimatedWaitMinutes, 7);
    assert.equal(result.current.wait.recommendedPollIntervalMinutes, 5);
    assert.equal(result.current.wait.recommendedAction, 'schedule_recheck');
    assert.ok(result.current.wait.nextPollAt);
    assert.equal(result.progress.runId, runId);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature_discovery_progress marks non-terminal stale snapshots without fake ETA', async () => {
  const rootPath = await createTempCorpus();
  const nowMs = Date.now();
  const runId = 'stale-progress-run';

  try {
    await saveDiscoveryProgress(rootPath, {
      runId,
      status: 'running',
      stage: 'citation_expansion',
      topic: 'stale citation expansion',
      operation: 'search',
      updatedAt: new Date(nowMs - (20 * 60000)).toISOString(),
      candidateCount: 306
    });

    const result = JSON.parse(await executeLiteratureDiscoveryProgressTool({
      corpus: rootPath,
      runId,
      staleAfterMinutes: 10
    }));

    assert.equal(result.current.runId, runId);
    assert.equal(result.current.isStale, true);
    assert.equal(result.current.eta.source, 'stale-progress');
    assert.equal(result.current.eta.estimatedWaitMs, null);
    assert.equal(result.current.wait.recommendedAction, 'schedule_recheck_stale_progress');
    assert.equal(result.current.wait.recommendedPollIntervalMinutes, 5);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('literature discovery recovery worker claims queued persisted runs', async () => {
  const rootPath = await createTempCorpus();
  const runId = 'queued-recovery-run';
  let capturedArgs = null;
  let worker = null;

  try {
    await saveDiscoveryProgress(rootPath, {
      runId,
      status: 'queued',
      stage: 'queued',
      topic: 'restart recoverable discovery',
      operation: 'search',
      searchMode: 'quick',
      recovery: {
        args: {
          operation: 'search',
          topic: 'restart recoverable discovery',
          searchMode: 'quick'
        }
      }
    });

    worker = startLiteratureDiscoveryRecoveryWorker({
      rootPaths: [rootPath],
      intervalMs: 60000,
      executeLiteratureDiscoveryTool: async (args, options = {}) => {
        capturedArgs = args;
        await options.onLiteratureDiscoveryProgress?.({
          runId: args.runId,
          topic: args.topic,
          operation: args.operation,
          searchMode: args.searchMode,
          status: 'completed',
          stage: 'completed',
          event: 'completed',
          completedAt: new Date().toISOString()
        });
        return '{}';
      },
      logger: {
        log() {},
        warn() {}
      }
    });
    worker.pollNow();

    for (let attempt = 0; attempt < 50 && !capturedArgs; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(capturedArgs);
    assert.equal(capturedArgs.runId, runId);
    assert.equal(capturedArgs.operation, 'search');
    assert.equal(capturedArgs.corpus, rootPath);

    const progress = await loadDiscoveryProgress(rootPath, runId);
    assert.equal(progress.status, 'completed');
    assert.equal(progress.stage, 'completed');
  } finally {
    worker?.stop?.();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
