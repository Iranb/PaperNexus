import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir, fileExists, readJson, removePath, writeJson } from '../lib/fs.js';
import { getCorpusPaths, loadCorpusMeta, loadSourceManifest, resolveCorpus } from './corpus-store.js';

const execFileAsync = promisify(execFile);

function emitStage(options, step, total, title, detail = '') {
  options.onStage?.(step, total, title, detail);
}

function emitProgress(options, progress) {
  options.onProgress?.(progress);
}

async function copyPathIntoArchive(sourcePath, targetDir) {
  const stats = await fs.stat(sourcePath);
  if (stats.isDirectory()) {
    await ensureDir(targetDir);
    const entries = await fs.readdir(sourcePath);
    for (const entry of entries) {
      await fs.cp(path.join(sourcePath, entry), path.join(targetDir, entry), {
        recursive: true
      });
    }
    return {
      originalPath: sourcePath,
      archivePath: targetDir,
      kind: 'directory'
    };
  }

  await ensureDir(targetDir);
  const destinationPath = path.join(targetDir, path.basename(sourcePath));
  await fs.copyFile(sourcePath, destinationPath);
  return {
    originalPath: sourcePath,
    archivePath: destinationPath,
    kind: 'file'
  };
}

export async function exportCorpusArchive(target, archivePath, options = {}) {
  emitStage(options, 1, 1, 'Exporting backup archive', 'capturing graph state, cached markdown, snapshots, and source papers');
  const rootPath = await resolveCorpus(target);
  const { corpusDir } = getCorpusPaths(rootPath);
  const [meta, manifest] = await Promise.all([
    loadCorpusMeta(rootPath),
    loadSourceManifest(rootPath)
  ]);

  if (!(await fileExists(corpusDir))) {
    throw new Error(`No indexed corpus exists at ${rootPath}.`);
  }

  const absoluteArchivePath = path.resolve(String(archivePath));
  await ensureDir(path.dirname(absoluteArchivePath));

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-export-'));
  const sourceEntries = [];
  const inputPaths = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  const totalSteps = 4 + inputPaths.length;
  let completed = 1;

  emitProgress(options, {
    completed,
    total: totalSteps,
    label: 'loaded corpus metadata and source manifest'
  });

  try {
    const archiveIndexDir = path.join(stageRoot, 'index', '.papernexus');
    await ensureDir(path.dirname(archiveIndexDir));
    await fs.cp(corpusDir, archiveIndexDir, {
      recursive: true
    });
    completed += 1;
    emitProgress(options, {
      completed,
      total: totalSteps,
      label: 'copied committed corpus index'
    });

    for (let index = 0; index < inputPaths.length; index += 1) {
      const sourcePath = path.resolve(String(inputPaths[index]));
      if (!(await fileExists(sourcePath))) {
        completed += 1;
        emitProgress(options, {
          completed,
          total: totalSteps,
          label: `skipped missing source ${index + 1}/${inputPaths.length}`
        });
        continue;
      }

      const sourceTarget = path.join(stageRoot, 'sources', String(index));
      sourceEntries.push(await copyPathIntoArchive(sourcePath, sourceTarget));
      completed += 1;
      emitProgress(options, {
        completed,
        total: totalSteps,
        label: `copied source ${index + 1}/${inputPaths.length}`
      });
    }

    const exportManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      archivePath: absoluteArchivePath,
      corpusName: meta.name,
      rootPath,
      paperCount: meta.paperCount,
      nodeCount: meta.nodeCount,
      relationshipCount: meta.relationshipCount,
      inputPaths,
      sources: sourceEntries.map((entry) => ({
        originalPath: entry.originalPath,
        archivePath: path.relative(stageRoot, entry.archivePath),
        kind: entry.kind
      }))
    };

    await writeJson(path.join(stageRoot, 'export.json'), exportManifest);
    completed += 1;
    emitProgress(options, {
      completed,
      total: totalSteps,
      label: 'wrote export manifest'
    });

    await execFileAsync('tar', ['-czf', absoluteArchivePath, '-C', stageRoot, '.']);
    completed += 1;
    emitProgress(options, {
      completed,
      total: totalSteps,
      label: 'wrote compressed archive'
    });
    return {
      archivePath: absoluteArchivePath,
      manifest: exportManifest
    };
  } finally {
    await removePath(stageRoot);
  }
}

export async function unpackCorpusArchive(archivePath, outputPath, options = {}) {
  emitStage(options, 1, 1, 'Unpacking backup archive', 'extracting an inspectable restore directory without touching the live graph');
  const absoluteArchivePath = path.resolve(String(archivePath));
  const absoluteOutputPath = path.resolve(String(outputPath));
  const totalSteps = 3;
  let completed = 0;

  await ensureDir(absoluteOutputPath);
  completed += 1;
  emitProgress(options, {
    completed,
    total: totalSteps,
    label: 'prepared output directory'
  });
  await execFileAsync('tar', ['-xzf', absoluteArchivePath, '-C', absoluteOutputPath]);
  completed += 1;
  emitProgress(options, {
    completed,
    total: totalSteps,
    label: 'extracted archive contents'
  });
  const manifest = await readJson(path.join(absoluteOutputPath, 'export.json'), null);
  completed += 1;
  emitProgress(options, {
    completed,
    total: totalSteps,
    label: 'loaded export manifest'
  });
  return {
    archivePath: absoluteArchivePath,
    outputPath: absoluteOutputPath,
    manifest
  };
}
