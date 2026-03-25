import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../src/lib/fs.js';
import { createApiCache, corpusPayload } from '../src/server/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('withFileLock serializes concurrent writers to the same resource', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-lock-'));
  const lockPath = path.join(workspaceRoot, 'resource.lock');
  const steps = [];
  let releaseFirstWriter = null;

  try {
    const firstWriterStarted = new Promise((resolve) => {
      releaseFirstWriter = resolve;
    });
    let secondWriterEntered = false;

    const firstWriter = withFileLock(lockPath, async () => {
      steps.push('first:entered');
      await firstWriterStarted;
      steps.push('first:released');
    }, {
      timeoutMs: 2000,
      pollIntervalMs: 25
    });

    await sleep(100);

    const secondWriter = withFileLock(lockPath, async () => {
      secondWriterEntered = true;
      steps.push('second:entered');
    }, {
      timeoutMs: 2000,
      pollIntervalMs: 25
    });

    await sleep(120);
    assert.equal(secondWriterEntered, false);

    releaseFirstWriter();
    await Promise.all([firstWriter, secondWriter]);
    assert.deepEqual(steps, ['first:entered', 'first:released', 'second:entered']);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('corpusPayload reuses cached corpus snapshots until a new index is published', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cache-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cache-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
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

    const [{ analyzeCorpus }] = await Promise.all([
      import('../src/core/ingestion/pipeline.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'cache-papers',
      force: true
    });

    const cache = createApiCache();
    const firstPayload = await corpusPayload(tempCorpusRoot, { cache });
    const secondPayload = await corpusPayload(tempCorpusRoot, { cache });

    assert.equal(firstPayload, secondPayload);

    await sleep(30);
    await analyzeCorpus(tempCorpusRoot, {
      name: 'cache-papers',
      force: true
    });

    const thirdPayload = await corpusPayload(tempCorpusRoot, { cache });
    assert.notEqual(thirdPayload, firstPayload);
    assert.notEqual(thirdPayload.meta.indexedAt, firstPayload.meta.indexedAt);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
