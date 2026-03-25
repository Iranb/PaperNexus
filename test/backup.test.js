import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('backupCorpus copies the indexed corpus into the configured backup directory', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-corpus-'));
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-target-'));
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

    const [{ analyzeCorpus }, { backupCorpus, resolveGraphStorageMode }] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'backup-test-papers',
      force: true
    });

    const backup = await backupCorpus(tempCorpusRoot, {
      backupDir: backupRoot
    });

    assert.equal(backup.corpusName, 'backup-test-papers');
    await fs.access(path.join(backup.backupPath, 'backup.json'));
    await fs.access(path.join(backup.backupCorpusDir, 'meta.json'));
    await fs.access(path.join(
      backup.backupCorpusDir,
      (await resolveGraphStorageMode()) === 'kuzu+lite-index' ? 'graph.kuzu' : 'graph.json'
    ));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(backupRoot, { recursive: true, force: true });
  }
});
