import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  ensureDir,
  fileExists,
  readJson,
  removePath,
  writeJson
} from '../lib/fs.js';
import { getDefaultRuntimeConfigPath, getDefaultRuntimeConfigRoot } from '../lib/config.js';
import { slugify } from '../lib/utils.js';
import { getCorpusPaths, loadCorpusMeta, loadSourceManifest, resolveCorpus } from './corpus-store.js';

function emitStage(options, step, total, title, detail = '') {
  options.onStage?.(step, total, title, detail);
}

function emitProgress(options, progress) {
  options.onProgress?.(progress);
}

function resolveTarBin(options = {}) {
  return String(options.tarBin || process.env.PAPERNEXUS_TAR_BIN || 'tar').trim() || 'tar';
}

async function runTar(args, options = {}) {
  const tarBin = resolveTarBin(options);
  const env = {
    ...process.env,
    ...(options.env || {})
  };
  const maxCapturedStdoutBytes = 1024 * 1024;
  const maxCapturedStderrBytes = 16 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(tarBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let stdout = '';
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = '';
    let stderrBytes = 0;
    let stderrTruncated = false;

    child.stdout.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const chunkBytes = Buffer.byteLength(text);
      if (stdoutBytes < maxCapturedStdoutBytes) {
        const remainingBytes = maxCapturedStdoutBytes - stdoutBytes;
        const slice = Buffer.from(text, 'utf8').subarray(0, remainingBytes).toString('utf8');
        stdout += slice;
      } else {
        stdoutTruncated = true;
      }
      stdoutBytes += chunkBytes;
      if (stdoutBytes > maxCapturedStdoutBytes) {
        stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const chunkBytes = Buffer.byteLength(text);
      if (stderrBytes < maxCapturedStderrBytes) {
        const remainingBytes = maxCapturedStderrBytes - stderrBytes;
        const slice = Buffer.from(text, 'utf8').subarray(0, remainingBytes).toString('utf8');
        stderr += slice;
      } else {
        stderrTruncated = true;
      }
      stderrBytes += chunkBytes;
      if (stderrBytes > maxCapturedStderrBytes) {
        stderrTruncated = true;
      }
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(`${stdout}${stdoutTruncated ? '\n...stdout truncated...' : ''}`);
        return;
      }
      const detail = stderr.trim()
        ? `${stderr.trim()}${stderrTruncated ? '\n...stderr truncated...' : ''}`
        : `tar exited with code ${code}`;
      reject(new Error(detail));
    });
  });
}

function normalizeArchiveMemberPath(memberPath = '') {
  return String(memberPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function validateArchiveMemberPath(memberPath = '') {
  const normalized = normalizeArchiveMemberPath(memberPath);
  if (!normalized || normalized === '.') return;
  if (normalized.startsWith('/')) {
    throw new Error(`Unsafe backup archive entry uses an absolute path: ${memberPath}`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe backup archive entry escapes the output directory: ${memberPath}`);
  }
}

function validateArchiveVerboseListing(verboseOutput = '') {
  for (const rawLine of String(verboseOutput || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[lh]/.test(line) || line.includes(' -> ')) {
      throw new Error(`Unsafe backup archive entry uses a link: ${line}`);
    }
  }
}

async function validateBackupArchiveBeforeUnpack(absoluteArchivePath, options = {}) {
  const listing = await runTar(['-tzf', absoluteArchivePath], options);
  for (const memberPath of listing.split('\n').map((line) => line.trim()).filter(Boolean)) {
    validateArchiveMemberPath(memberPath);
  }
  const verboseListing = await runTar(['-tvzf', absoluteArchivePath], options);
  validateArchiveVerboseListing(verboseListing);
}

function createArchiveStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isMarkdownLikePath(filePath) {
  return /\.(md|markdown)$/i.test(String(filePath || ''));
}

function resolveArchiveFileName(entry, index) {
  const sourceReference = String(entry?.kind || '').toLowerCase() === 'pdf'
    ? firstNonEmptyString(entry.sourcePdfPath, entry.sourcePath, entry.inputPath, entry.paperId)
    : firstNonEmptyString(entry.sourcePath, entry.inputPath, entry.sourceMarkdownPath, entry.markdownCachePath, entry.paperId);
  const fallback = sourceReference || `source-${index + 1}.md`;
  const parsed = path.parse(fallback);
  const baseName = parsed.name || `source-${index + 1}`;
  const extension = isMarkdownLikePath(fallback) && parsed.ext
    ? parsed.ext
    : '.md';
  return `${baseName}${extension}`;
}

function resolveArchiveOutputPath(rootPath, meta, archivePath) {
  if (archivePath) {
    return path.resolve(String(archivePath));
  }

  const backupRoot = path.join(getDefaultRuntimeConfigRoot(), 'backups');
  const archiveLabel = slugify(meta?.name || path.basename(rootPath) || 'papernexus-backup');
  return path.join(backupRoot, `${archiveLabel}-${createArchiveStamp()}.tgz`);
}

async function copyPathToDestination(sourcePath, destinationPath) {
  const stats = await fs.stat(sourcePath);
  await ensureDir(path.dirname(destinationPath));

  if (stats.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, {
      recursive: true
    });
    return destinationPath;
  }

  await fs.copyFile(sourcePath, destinationPath);
  return destinationPath;
}

async function resolveSourceExportPlan(entry, index) {
  const markdownCandidates = [
    entry?.markdownCachePath,
    entry?.sourceMarkdownPath
  ].filter(Boolean);

  for (const candidate of markdownCandidates) {
    if (await fileExists(candidate)) {
      return {
        originalPath: firstNonEmptyString(entry?.sourcePath, entry?.inputPath, entry?.sourcePdfPath, candidate),
        sourcePath: candidate,
        archiveFileName: resolveArchiveFileName(entry, index),
        kind: 'file',
        exportKind: String(entry?.kind || '').toLowerCase() === 'pdf' ? 'derived-markdown' : 'cached-markdown',
        sourceKind: entry?.kind || null
      };
    }
  }

  const directMarkdownSource = firstNonEmptyString(entry?.sourcePath, entry?.inputPath);
  if (isMarkdownLikePath(directMarkdownSource) && await fileExists(directMarkdownSource)) {
    return {
      originalPath: directMarkdownSource,
      sourcePath: directMarkdownSource,
      archiveFileName: resolveArchiveFileName(entry, index),
      kind: 'file',
      exportKind: 'source-markdown',
      sourceKind: entry?.kind || 'markdown'
    };
  }

  return null;
}

async function listCommittedIndexEntries(paths) {
  const candidates = [
    { sourcePath: paths.metaPath, archiveRelativePath: 'meta.json' },
    { sourcePath: paths.manifestPath, archiveRelativePath: 'sources.json' },
    { sourcePath: paths.graphPath, archiveRelativePath: 'graph.json' },
    { sourcePath: paths.kuzuGraphPath, archiveRelativePath: 'graph.kuzu' },
    { sourcePath: paths.liteGraphPath, archiveRelativePath: 'graph.lite.json' },
    { sourcePath: paths.liteStatePath, archiveRelativePath: 'graph.lite.state.json' }
  ];
  const existing = [];

  for (const candidate of candidates) {
    if (await fileExists(candidate.sourcePath)) {
      existing.push(candidate);
    }
  }

  return existing;
}

export async function exportCorpusArchive(target, archivePath, options = {}) {
  emitStage(options, 1, 1, 'Exporting backup archive', 'capturing minimal committed graph state, runtime config, and markdown-first source files');
  const rootPath = await resolveCorpus(target);
  const paths = getCorpusPaths(rootPath);
  const { corpusDir } = paths;
  const [meta, manifest] = await Promise.all([
    loadCorpusMeta(rootPath),
    loadSourceManifest(rootPath)
  ]);

  if (!(await fileExists(corpusDir))) {
    throw new Error(`No indexed corpus exists at ${rootPath}.`);
  }

  const absoluteArchivePath = resolveArchiveOutputPath(rootPath, meta, archivePath);
  await ensureDir(path.dirname(absoluteArchivePath));

  const runtimeConfigPath = getDefaultRuntimeConfigPath();
  const hasRuntimeConfig = await fileExists(runtimeConfigPath);
  const committedIndexEntries = await listCommittedIndexEntries(paths);
  const manifestSources = Array.isArray(manifest?.sources)
    ? manifest.sources.filter((entry) => entry && entry.activeInGraph !== false)
    : [];
  const sourcePlans = [];
  for (let index = 0; index < manifestSources.length; index += 1) {
    const plan = await resolveSourceExportPlan(manifestSources[index], index);
    if (plan) {
      sourcePlans.push(plan);
    }
  }

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-backup-export-'));
  const sourceEntries = [];
  const inputPaths = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  const totalSteps = 3 + committedIndexEntries.length + sourcePlans.length + (hasRuntimeConfig ? 1 : 0);
  let completed = 1;

  emitProgress(options, {
    completed,
    total: totalSteps,
    label: 'loaded corpus metadata and source manifest'
  });

  try {
    if (hasRuntimeConfig) {
      await copyPathToDestination(runtimeConfigPath, path.join(stageRoot, 'config.json'));
      completed += 1;
      emitProgress(options, {
        completed,
        total: totalSteps,
        label: 'copied runtime config'
      });
    }

    const archiveIndexDir = path.join(stageRoot, 'index', '.papernexus');
    await ensureDir(archiveIndexDir);
    for (const entry of committedIndexEntries) {
      await copyPathToDestination(entry.sourcePath, path.join(archiveIndexDir, entry.archiveRelativePath));
      completed += 1;
      emitProgress(options, {
        completed,
        total: totalSteps,
        label: `copied committed index file ${entry.archiveRelativePath}`
      });
    }

    for (let index = 0; index < sourcePlans.length; index += 1) {
      const sourcePlan = sourcePlans[index];
      if (!(await fileExists(sourcePlan.sourcePath))) {
        completed += 1;
        emitProgress(options, {
          completed,
          total: totalSteps,
          label: `skipped missing source ${index + 1}/${sourcePlans.length}`
        });
        continue;
      }

      const sourceTarget = path.join(stageRoot, 'sources', String(index));
      const destinationPath = path.join(sourceTarget, sourcePlan.archiveFileName);
      await copyPathToDestination(sourcePlan.sourcePath, destinationPath);
      sourceEntries.push({
        originalPath: sourcePlan.originalPath,
        archivePath: destinationPath,
        kind: sourcePlan.kind,
        exportKind: sourcePlan.exportKind,
        sourceKind: sourcePlan.sourceKind
      });
      completed += 1;
      emitProgress(options, {
        completed,
        total: totalSteps,
        label: `copied source ${index + 1}/${sourcePlans.length}`
      });
    }

    const exportManifest = {
      version: 2,
      mode: 'lightweight-markdown-first',
      createdAt: new Date().toISOString(),
      archivePath: absoluteArchivePath,
      corpusName: meta.name,
      rootPath,
      paperCount: meta.paperCount,
      nodeCount: meta.nodeCount,
      relationshipCount: meta.relationshipCount,
      inputPaths,
      runtimeConfigPath: hasRuntimeConfig ? 'config.json' : null,
      committedIndexFiles: committedIndexEntries.map((entry) => path.join('index', '.papernexus', entry.archiveRelativePath)),
      sources: sourceEntries.map((entry) => ({
        originalPath: entry.originalPath,
        archivePath: path.relative(stageRoot, entry.archivePath),
        kind: entry.kind,
        exportKind: entry.exportKind,
        sourceKind: entry.sourceKind
      })),
      omitted: {
        intermediateDirs: [
          'index/.papernexus/markdown',
          'index/.papernexus/papers',
          'index/.papernexus/staged',
          'index/.papernexus/imports'
        ],
        pdfSources: 'omitted unless already materialized to markdown cache'
      }
    };

    await writeJson(path.join(stageRoot, 'export.json'), exportManifest);
    completed += 1;
    emitProgress(options, {
      completed,
      total: totalSteps,
      label: 'wrote export manifest'
    });

    await runTar(['-czf', absoluteArchivePath, '-C', stageRoot, '.'], {
      ...options,
      env: {
        ...(options.env || {}),
        COPYFILE_DISABLE: '1',
        COPY_EXTENDED_ATTRIBUTES_DISABLE: '1'
      }
    });
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
  await validateBackupArchiveBeforeUnpack(absoluteArchivePath, options);
  await runTar(['-xzf', absoluteArchivePath, '-C', absoluteOutputPath], options);
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
