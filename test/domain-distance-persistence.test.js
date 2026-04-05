import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('analyzeCorpus persists domainDistanceMatrix into corpus meta and lite cache', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-domain-distance-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-domain-distance-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

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

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'domain-distance-persistence-test',
      force: true
    });
    const paths = corpusStore.getCorpusPaths(tempCorpusRoot);
    const litePayload = JSON.parse(await fs.readFile(paths.liteGraphPath, 'utf8'));

    assert.equal(result.meta.domainDistanceMatrix?.version, 'idea-catalyst-domain-distance-v1');
    assert.deepEqual(litePayload.derived?.domainDistanceMatrix, result.meta.domainDistanceMatrix);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
