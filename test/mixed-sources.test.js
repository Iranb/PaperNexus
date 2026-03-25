import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('analyzeCorpus dedupes mixed pdf and markdown sources for the same paper and prefers markdown as the active source', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mixed-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mixed-corpus-'));
  const templateMarkdownPath = path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md');
  const pdfPath = path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.pdf');
  const markdownPath = path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.md');
  const markerScriptPath = path.join(tempCorpusRoot, 'fake-marker.mjs');

  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(pdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(markerScriptPath, `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfArg = args[0];
const outputDir = args[args.indexOf('--output_dir') + 1];
const basename = path.basename(pdfArg, path.extname(pdfArg));
await fs.mkdir(outputDir, { recursive: true });
await fs.copyFile(${JSON.stringify(templateMarkdownPath)}, path.join(outputDir, \`\${basename}.md\`));
`, 'utf8');
    await fs.chmod(markerScriptPath, 0o755);

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const firstRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'mixed-paper-test',
      force: true,
      pdfParser: 'marker',
      markerCommand: markerScriptPath
    });

    const firstManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(firstRun.meta.paperCount, 1);
    assert.equal(firstRun.meta.sourceCount, 1);
    assert.equal(firstManifest.sources.length, 1);
    assert.equal(firstManifest.sources[0].kind, 'pdf');
    assert.equal(firstManifest.sources[0].activeInGraph, true);
    const stablePaperId = firstManifest.sources[0].paperId;

    await fs.copyFile(templateMarkdownPath, markdownPath);

    const secondRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'mixed-paper-test',
      force: true,
      pdfParser: 'marker',
      markerCommand: markerScriptPath
    });

    const secondManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const activeSources = secondManifest.sources.filter((entry) => entry.activeInGraph !== false);
    const duplicateSources = secondManifest.sources.filter((entry) => entry.activeInGraph === false);
    const fullCorpus = await corpusStore.loadCorpus(tempCorpusRoot);
    const paperNodes = fullCorpus.graph.nodes.filter((node) => node.type === 'Paper');

    assert.equal(secondRun.meta.paperCount, 1);
    assert.equal(secondRun.meta.sourceCount, 2);
    assert.equal(secondManifest.sources.length, 2);
    assert.equal(activeSources.length, 1);
    assert.equal(duplicateSources.length, 1);
    assert.equal(activeSources[0].kind, 'markdown');
    assert.equal(duplicateSources[0].kind, 'pdf');
    assert.equal(activeSources[0].paperId, stablePaperId);
    assert.equal(duplicateSources[0].paperId, stablePaperId);
    assert.equal(duplicateSources[0].duplicateOfSourceKey, activeSources[0].sourceKey);
    assert.equal(paperNodes.length, 1);
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
