import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendTraceSpan,
  createTraceId,
  loadTraceSpans
} from '../src/storage/trace-store.js';
import {
  startRun,
  updateRunStage,
  tailRunEvents
} from '../src/storage/run-store.js';

test('trace store records spans and run-store writes a run-local trace alias', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-trace-store-'));

  try {
    const traceId = createTraceId('import', 'trace-test');
    await appendTraceSpan(tempRoot, {
      trace_id: traceId,
      stage: 'literature_discovery',
      status: 'completed',
      run_id: 'run:test',
      artifact_paths: ['artifact.json']
    });

    const loaded = await loadTraceSpans(tempRoot, traceId);
    assert.equal(loaded.spans.length, 1);
    assert.equal(loaded.spans[0].trace_id, traceId);
    assert.equal(loaded.spans[0].stage, 'literature_discovery');

    const started = await startRun(tempRoot, {
      kind: 'import',
      traceId,
      idempotencyKey: 'source:paper-1',
      attemptId: 'attempt:1'
    });
    await updateRunStage(tempRoot, started.runId, 'llm-enhancement', {
      status: 'completed',
      artifactPaths: ['semantic.json'],
      outputHash: 'hash:semantic'
    });
    const events = await tailRunEvents(tempRoot, started.runId);
    const runTrace = await fs.readFile(started.paths.tracePath, 'utf8');

    assert.equal(started.run.traceId, traceId);
    assert.equal(started.state.idempotencyKey, 'source:paper-1');
    assert.ok(events.events.every((event) => event.traceId === traceId));
    assert.match(runTrace, /llm-enhancement/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
