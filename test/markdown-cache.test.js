import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeCorpus } from '../src/core/ingestion/pipeline.js';
import { getCorpusPaths, loadSemanticPaperSnapshot, loadSourceManifest } from '../src/storage/corpus-store.js';

test('analyzeCorpus caches source markdown files into the corpus markdown directory and refreshes them when source markdown changes', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-md-cache-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-md-cache-corpus-'));
  process.env.PAPERNEXUS_HOME = tempHome;

  try {
    const sourceMarkdownPath = path.join(tempCorpusRoot, 'paper-a.md');
    await fs.writeFile(sourceMarkdownPath, [
      '# Cached Markdown Paper',
      '',
      '## Abstract',
      '',
      'We study evidence-aware experiment planning.'
    ].join('\n'));

    await analyzeCorpus(tempCorpusRoot, {
      name: 'markdown-cache-test',
      force: true
    });

    const firstManifest = await loadSourceManifest(tempCorpusRoot);
    const manifestEntry = firstManifest.sources.find((entry) => entry.sourcePath === sourceMarkdownPath);
    assert.ok(manifestEntry, 'expected source manifest entry for markdown input');
    assert.match(manifestEntry.sourceMarkdownPath, /\.papernexus\/markdown\/source\//);
    assert.equal(manifestEntry.materializedFrom, 'source-refresh');
    assert.equal(typeof manifestEntry.sourceMtimeMs, 'number');
    assert.equal(typeof manifestEntry.sourceSizeBytes, 'number');

    const cachedPath = manifestEntry.sourceMarkdownPath;
    const initialCachedMarkdown = await fs.readFile(cachedPath, 'utf8');
    assert.match(initialCachedMarkdown, /evidence-aware experiment planning/i);

    await fs.writeFile(sourceMarkdownPath, [
      '# Cached Markdown Paper',
      '',
      '## Abstract',
      '',
      'We study evidence-aware experiment planning with structured notes.'
    ].join('\n'));

    await analyzeCorpus(tempCorpusRoot, {
      name: 'markdown-cache-test'
    });

    const secondManifest = await loadSourceManifest(tempCorpusRoot);
    const secondEntry = secondManifest.sources.find((entry) => entry.sourcePath === sourceMarkdownPath);
    assert.equal(secondEntry.sourceMarkdownPath, cachedPath);
    assert.equal(secondEntry.materializedFrom, 'source-refresh');

    const updatedCachedMarkdown = await fs.readFile(cachedPath, 'utf8');
    assert.match(updatedCachedMarkdown, /structured notes/i);

    const { markdownDir } = getCorpusPaths(tempCorpusRoot);
    const sourceCacheDir = path.join(markdownDir, 'source');
    const cachedFiles = await fs.readdir(sourceCacheDir);
    assert.equal(cachedFiles.length, 1);
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('force analyze rebuilds from cached markdown when the source file fingerprint is unchanged', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-md-force-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-md-force-corpus-'));
  process.env.PAPERNEXUS_HOME = tempHome;

  try {
    const sourceMarkdownPath = path.join(tempCorpusRoot, 'paper-b.md');
    await fs.writeFile(sourceMarkdownPath, [
      '# Cached Force Paper',
      '',
      '## Abstract',
      '',
      'Original source markdown text.'
    ].join('\n'));

    await analyzeCorpus(tempCorpusRoot, {
      name: 'markdown-force-test',
      force: true
    });

    const firstManifest = await loadSourceManifest(tempCorpusRoot);
    const manifestEntry = firstManifest.sources.find((entry) => entry.sourcePath === sourceMarkdownPath);
    assert.ok(manifestEntry);

    await fs.writeFile(manifestEntry.sourceMarkdownPath, [
      '# Cached Force Paper',
      '',
      '## Abstract',
      '',
      'Cached markdown should be reused during force analyze.'
    ].join('\n'));

    await analyzeCorpus(tempCorpusRoot, {
      name: 'markdown-force-test',
      force: true
    });

    const secondManifest = await loadSourceManifest(tempCorpusRoot);
    const secondEntry = secondManifest.sources.find((entry) => entry.sourcePath === sourceMarkdownPath);
    assert.equal(secondEntry.markdownCacheStatus, 'reused');
    assert.equal(secondEntry.materializedFrom, 'markdown-cache');

    const snapshot = await loadSemanticPaperSnapshot(tempCorpusRoot, secondEntry.sourceKey);
    assert.match(snapshot.abstract, /cached markdown should be reused/i);
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
