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

test('backup archive export skips common filesystem metadata files from source directories', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-meta-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-meta-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const archivePath = path.join(workspaceRoot, 'papernexus-backup-meta.tgz');
  const unpackRoot = path.join(workspaceRoot, 'unpacked');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(path.join(inputRoot, '__MACOSX'), { recursive: true });
    await fs.writeFile(path.join(inputRoot, 'paper.md'), '# Backup Test\n\n## Abstract\n\nKeep me.\n', 'utf8');
    await fs.writeFile(path.join(inputRoot, '.DS_Store'), 'ignore me', 'utf8');
    await fs.writeFile(path.join(inputRoot, '._paper.md'), 'ignore me too', 'utf8');
    await fs.writeFile(path.join(inputRoot, 'Thumbs.db'), 'ignore windows metadata', 'utf8');
    await fs.writeFile(path.join(inputRoot, '__MACOSX', 'ghost.md'), '# Ghost', 'utf8');

    const [{ analyzeCorpus }, backupArchive] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/backup-archive.js')
    ]);

    await analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'backup-metadata-test',
      force: true
    });

    await backupArchive.exportCorpusArchive(indexRoot, archivePath);
    await backupArchive.unpackCorpusArchive(archivePath, unpackRoot);

    const restoredSourceRoot = path.join(unpackRoot, 'sources', '0');
    const restoredEntries = await fs.readdir(restoredSourceRoot);
    assert.deepEqual(restoredEntries.sort(), ['paper.md']);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('backup archive unpack tolerates large tar stderr output', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-archive-stderr-'));
  const archivePath = path.join(workspaceRoot, 'dummy-backup.tgz');
  const unpackRoot = path.join(workspaceRoot, 'unpacked');
  const fakeTarPath = path.join(workspaceRoot, 'fake-tar.sh');

  try {
    await fs.writeFile(archivePath, 'placeholder archive');
    await fs.writeFile(
      fakeTarPath,
      `#!/bin/sh
set -eu
target=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ]; then
    target="$arg"
    prev=""
    continue
  fi
  if [ "$arg" = "-C" ]; then
    prev="-C"
  fi
done
python3 - <<'PY' >&2
print("x" * 200000)
PY
mkdir -p "$target/index/.papernexus" "$target/sources/0"
printf '{"version":1}\\n' > "$target/export.json"
printf '{"name":"fake"}\\n' > "$target/index/.papernexus/meta.json"
printf '# fake source\\n' > "$target/sources/0/test.md"
`
    );
    await fs.chmod(fakeTarPath, 0o755);

    const backupArchive = await import('../src/storage/backup-archive.js');
    const unpacked = await backupArchive.unpackCorpusArchive(archivePath, unpackRoot, {
      tarBin: fakeTarPath
    });

    assert.equal(unpacked.outputPath, unpackRoot);
    await fs.access(path.join(unpackRoot, 'export.json'));
    await fs.access(path.join(unpackRoot, 'index', '.papernexus', 'meta.json'));
    await fs.access(path.join(unpackRoot, 'sources', '0', 'test.md'));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
