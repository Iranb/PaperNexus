import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeCorpus } from '../src/core/ingestion/pipeline.js';
import { loadSemanticPaperSnapshot, loadSourceManifest } from '../src/storage/corpus-store.js';
import { getImportTaskPaths } from '../src/storage/import-store.js';

test('identifier-only import metadata preserves the title parsed from full text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-title-'));
  const taskId = 'imp:identifier-only-title';
  const paths = getImportTaskPaths(root, taskId);
  const sourcePath = path.join(paths.sourcesDir, 'paper.md');
  const title = 'Incremental Representation Learning with Exemplar Memory';
  try {
    await fs.mkdir(paths.sourcesDir, { recursive: true });
    await fs.writeFile(sourcePath, `# ${title}

## Abstract
We study class-incremental representation learning with bounded exemplar memory. The classifier learns newly arriving classes while preserving discrimination among previously observed categories. Our approach combines knowledge distillation and feature regularization to maintain the geometry of old classes under changing data distributions.

## Method
We propose a memory-based representation learning method. The loss combines cross-entropy on new examples with distillation of the previous model predictions. An exemplar selection step preserves a small representative set for each old class.
`);
    await fs.writeFile(paths.taskPath, JSON.stringify({ id: taskId, files: [{
      storedPath: sourcePath, kind: 'markdown',
      paperMetadata: { identifiers: { arxivId: '1611.07725' }, sourceProvider: 'arxiv' }
    }] }));
    const result = await analyzeCorpus(paths.sourcesDir, {
      rootPath: root, name: 'identifier-only-title', force: true,
      includeActiveImportSources: false, includePersistentImportSources: false,
      semanticExtraction: 'heuristic-only', enableLlmEnrichment: false
    });
    const manifest = await loadSourceManifest(root);
    const entry = manifest.sources[0];
    const snapshot = await loadSemanticPaperSnapshot(root, entry.sourceKey);
    assert.equal(entry.paperTitle, title);
    assert.equal(entry.identifiers.arxivId, '1611.07725');
    assert.notEqual(entry.paperMetadata?.title, 'undefined');
    assert.equal(snapshot.paperTitle, title);
    assert.equal(result.graph.nodes.find(node => node.type === 'Paper').name, title);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
