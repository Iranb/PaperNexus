import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('backup archive export and unpack preserve the index plus source papers', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-archive-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-archive-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const archivePath = path.join(workspaceRoot, 'papernexus-backup.tgz');
  const unpackRoot = path.join(workspaceRoot, 'unpacked');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [{ analyzeCorpus }, backupArchive] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/backup-archive.js')
    ]);

    const exportProgress = [];
    const exportStages = [];
    const unpackProgress = [];
    const unpackStages = [];

    await analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'backup-archive-test',
      force: true
    });

    const exported = await backupArchive.exportCorpusArchive(indexRoot, archivePath, {
      onStage(step, total, title) {
        exportStages.push({ step, total, title });
      },
      onProgress(progress) {
        exportProgress.push(progress);
      }
    });
    assert.equal(exported.archivePath, archivePath);
    await fs.access(archivePath);
    assert.ok(exportStages.some((stage) => /Exporting backup archive/i.test(stage.title)));
    assert.ok(exportProgress.some((progress) => progress.completed >= progress.total));

    const unpacked = await backupArchive.unpackCorpusArchive(archivePath, unpackRoot, {
      onStage(step, total, title) {
        unpackStages.push({ step, total, title });
      },
      onProgress(progress) {
        unpackProgress.push(progress);
      }
    });
    await fs.access(path.join(unpacked.outputPath, 'export.json'));
    await fs.access(path.join(unpacked.outputPath, 'index', '.papernexus', 'meta.json'));
    await fs.access(path.join(unpacked.outputPath, 'sources', '0', 'retrieval-augmented-experiment-planning.md'));
    assert.ok(unpackStages.some((stage) => /Unpacking backup archive/i.test(stage.title)));
    assert.ok(unpackProgress.some((progress) => progress.completed >= progress.total));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
