import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

function toBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function removeIdentityEnvelope(target = {}) {
  for (const key of [
    'canonicalId',
    'canonicalIdSource',
    'identityConfidence',
    'identityAliases',
    'normalizedTitle',
    'titleSignature',
    'sourceProvider',
    'contentSha256',
    'normalizedTextSha256',
    'sourceId',
    'sourceIds',
    'resolutionStatus'
  ]) {
    delete target[key];
  }
}

test('imported papers with overlapping strong aliases merge into one paper and upgrade canonicalId to the strongest alias', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-identity-alias-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-identity-alias-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [ingestion, importStore, importWorker, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'paper-identity-alias-test',
      force: true
    });

    await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'alias-first.md',
          mimeType: 'text/markdown',
          contentBase64: toBase64(
            '# FixMatch Draft Variant\n\nAlice Example\n\n## Abstract\n\nThis draft variant uses a DOI-only identity.\n'
          ),
          paperMetadata: {
            identifiers: {
              doi: '10.48550/arXiv.2410.11206'
            },
            sourceProvider: 'provider-one'
          }
        }
      ]
    });
    await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      files: [
        {
          name: 'alias-second.md',
          mimeType: 'text/markdown',
          contentBase64: toBase64(
            '# Camera Ready FixMatch Analysis\n\nBob Example\n\n## Abstract\n\nThis camera-ready variant adds an arXiv identity while keeping the same DOI.\n'
          ),
          paperMetadata: {
            identifiers: {
              doi: '10.48550/arXiv.2410.11206',
              arxivId: '2410.11206'
            },
            sourceProvider: 'provider-two'
          }
        }
      ]
    });
    await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    const manifest = await corpusStore.loadSourceManifest(indexRoot);
    const importedEntries = (manifest.sources || []).filter((entry) => {
      const candidate = String(entry.sourcePath || entry.inputPath || '');
      const base = path.basename(candidate);
      return base === 'alias-first.md' || base === 'alias-second.md';
    });
    assert.equal(importedEntries.length, 2);
    assert.equal(new Set(importedEntries.map((entry) => entry.paperId)).size, 1);
    assert.equal(new Set(importedEntries.map((entry) => entry.canonicalId)).size, 1);
    assert.equal(importedEntries[0].canonicalId, 'arxiv:2410.11206');
    assert.equal(importedEntries[1].canonicalId, 'arxiv:2410.11206');
    assert.ok(importedEntries.every((entry) => entry.identityAliases.includes('doi:10.48550/arxiv.2410.11206')));
    assert.ok(importedEntries.every((entry) => entry.identityAliases.includes('arxiv:2410.11206')));
    assert.equal(new Set(importedEntries.map((entry) => entry.sourceId)).size, 2);
    assert.deepEqual(
      importedEntries.map((entry) => entry.sourceProvider).sort(),
      ['provider-one', 'provider-two']
    );

    const corpus = await corpusStore.loadCorpusLite(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);
    const paperNode = corpus.graph.getNode(importedEntries[0].paperId);
    assert.ok(paperNode);
    assert.equal(paperNode.properties.canonicalId, 'arxiv:2410.11206');
    assert.ok(paperNode.properties.identityAliases.includes('doi:10.48550/arxiv.2410.11206'));
    assert.ok(Array.isArray(paperNode.properties.sourceIds));
    assert.equal(paperNode.properties.sourceIds.length, 2);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('refresh writes the new identity envelope back onto legacy manifest and snapshot records', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-identity-upgrade-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paper-identity-upgrade-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const paperPath = path.join(tempCorpusRoot, 'legacy-identity-paper.md');

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.writeFile(
      paperPath,
      '# Legacy Identity Paper\n\nMina Lee\n\n## Abstract\n\nA legacy record missing the new identity envelope.\n',
      'utf8'
    );

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(tempCorpusRoot, {
      name: 'paper-identity-upgrade-test',
      force: true
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const entry = { ...(manifest.sources || [])[0] };
    assert.ok(entry);
    const snapshot = { ...(await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey)) };
    assert.ok(snapshot);

    removeIdentityEnvelope(entry);
    removeIdentityEnvelope(snapshot);
    await corpusStore.saveSourceManifest(tempCorpusRoot, {
      ...manifest,
      sources: [entry]
    });
    await corpusStore.saveSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey, snapshot);

    await ingestion.refreshPaperGraphContent(tempCorpusRoot, {
      rootPath: tempCorpusRoot,
      sourceKey: entry.sourceKey,
      includeDuplicateGroup: true,
      rebuildPdfMarkdown: false,
      semanticExtraction: 'heuristic-only'
    });

    const nextManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const nextEntry = nextManifest.sources[0];
    const nextSnapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, nextEntry.sourceKey);

    assert.ok(nextEntry.canonicalId.startsWith('title:'));
    assert.equal(nextEntry.canonicalIdSource, 'title');
    assert.equal(nextEntry.identityConfidence, 'provisional');
    assert.ok(Array.isArray(nextEntry.identityAliases));
    assert.ok(nextEntry.identityAliases.includes(nextEntry.canonicalId));
    assert.ok(nextEntry.normalizedTitle);
    assert.ok(nextEntry.titleSignature);
    assert.equal(nextEntry.sourceProvider, 'filesystem');
    assert.ok(nextEntry.contentSha256.startsWith('sha256:'));
    assert.ok(nextEntry.sourceId.includes('#markdown#filesystem#sha256:'));
    assert.equal(nextEntry.resolutionStatus, 'fulltext_ready');

    assert.equal(nextSnapshot.canonicalId, nextEntry.canonicalId);
    assert.equal(nextSnapshot.sourceId, nextEntry.sourceId);
    assert.equal(nextSnapshot.sourceProvider, 'filesystem');
    assert.ok(nextSnapshot.contentSha256.startsWith('sha256:'));
    assert.equal(nextSnapshot.resolutionStatus, 'fulltext_ready');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
