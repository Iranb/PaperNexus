import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  loadStagedCorpusBuild,
  saveSourceManifest,
  saveStagedCorpusBuild
} from '../src/storage/corpus-store.js';

const originalFetch = globalThis.fetch;

function createManifestToken(manifest) {
  return JSON.stringify({
    version: manifest.version || null,
    indexedAt: manifest.indexedAt || null,
    sourceCount: Array.isArray(manifest.sources) ? manifest.sources.length : 0,
    semanticExtractionMode: manifest.semanticExtractionMode || null
  });
}

test('mergeGraphCorpus keeps node LLM check disabled even when the flag is requested', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-check-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-check-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    const sourcePath = path.join(tempCorpusRoot, 'paper-a.md');
    await fs.writeFile(sourcePath, '# Paper A\n\n## Experiments\n\nWe evaluate on Office-Home and a training dataset.\n', 'utf8');
    const stats = await fs.stat(sourcePath);
    const fingerprint = `${Math.round(Number(stats.mtimeMs || 0))}:${Number(stats.size || 0)}`;

    const manifest = {
      version: 1,
      corpusName: 'node-check-test',
      rootPath: tempCorpusRoot,
      inputPath: tempCorpusRoot,
      inputPaths: [tempCorpusRoot],
      sourceMode: 'markdown',
      semanticExtractionMode: 'llm-primary',
      indexedAt: '2026-03-26T00:00:00.000Z',
      lastChangeSummary: { added: 1, updated: 0, reused: 0, removed: 0 },
      sources: [
        {
          sourceKey: sourcePath,
          inputPath: sourcePath,
          kind: 'markdown',
          fingerprint,
          sourceFingerprint: fingerprint,
          paperId: 'paper:1',
          paperTitle: 'Paper A',
          sourcePath,
          sourceMarkdownPath: sourcePath,
          markdownCachePath: sourcePath,
          markdownCacheFingerprint: fingerprint,
          markdownCacheExists: true,
          markdownCacheStatus: 'reused',
          materializedFrom: 'markdown-cache',
          snapshotPath: '.papernexus/papers/paper-a.json',
          activeInGraph: true,
          canonicalSourceKey: sourcePath,
          duplicateOfSourceKey: null,
          duplicateSourceCount: 1,
          availableSourceKinds: ['markdown']
        }
      ]
    };

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'corpus:1',
      type: NODE_TYPES.CORPUS,
      name: 'node-check-test',
      properties: { layer: 'CorpusLayer' }
    });
    graph.addNode({
      id: 'paper:1',
      type: NODE_TYPES.PAPER,
      name: 'Paper A',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:1',
        paperTitle: 'Paper A'
      }
    });
    graph.addNode({
      id: 'dataset:training',
      type: NODE_TYPES.DATASET,
      name: 'training dataset',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        aliases: ['the training dataset'],
        mentionCount: 1,
        confidence: 0.76
      }
    });
    graph.addNode({
      id: 'dataset:office-home',
      type: NODE_TYPES.DATASET,
      name: 'Office-Home dataset',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        aliases: ['Office Home dataset'],
        mentionCount: 1,
        confidence: 0.91
      }
    });
    graph.addRelationship({
      id: 'rel:contains-paper',
      sourceId: 'corpus:1',
      targetId: 'paper:1',
      type: EDGE_TYPES.CONTAINS,
      properties: { layerPath: 'CorpusLayer->DocumentLayer' }
    });
    graph.addRelationship({
      id: 'rel:paper-training-dataset',
      sourceId: 'paper:1',
      targetId: 'dataset:training',
      type: EDGE_TYPES.EVALUATES_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'We evaluate on the training dataset.',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });
    graph.addRelationship({
      id: 'rel:paper-office-home',
      sourceId: 'paper:1',
      targetId: 'dataset:office-home',
      type: EDGE_TYPES.EVALUATES_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'We evaluate on Office-Home.',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });

    const meta = {
      name: 'node-check-test',
      rootPath: tempCorpusRoot,
      indexedAt: '2026-03-26T00:00:00.000Z',
      sourceMode: 'markdown',
      storageMode: 'json+lite-index',
      paperCount: 1,
      sourceCount: 1,
      nodeCount: graph.nodeCount,
      relationshipCount: graph.relationshipCount,
      topProblems: [],
      topDomains: [],
      layers: {
        CorpusLayer: 1,
        DocumentLayer: 1,
        EvaluationLayer: 2
      },
      layerPaths: {
        'CorpusLayer->DocumentLayer': 1,
        'DocumentLayer->EvaluationLayer': 2
      },
      brainstormView: {
        eligibleNodeCount: 0,
        nodeTypes: {}
      },
      llm: {
        enabled: true,
        providers: ['openai'],
        relationCount: 0,
        crossPaperAccepted: 0
      },
      failedSourceCount: 0,
      failedSources: [],
      lastChangeSummary: manifest.lastChangeSummary
    };

    const manifestToken = createManifestToken(manifest);
    await saveSourceManifest(tempCorpusRoot, manifest);
    await saveStagedCorpusBuild(tempCorpusRoot, graph, meta, manifest, {
      version: 1,
      stage: 'graph-built',
      createdAt: '2026-03-26T00:00:00.000Z',
      baseManifestToken: manifestToken,
      stagedManifestToken: manifestToken,
      inputPath: tempCorpusRoot,
      inputPaths: [tempCorpusRoot],
      expectedSources: [{ sourceKey: sourcePath, fingerprint }]
    });

    const ingestion = await import('../src/core/ingestion/pipeline.js');
    const merged = await ingestion.mergeGraphCorpus(tempCorpusRoot, {
      nodeLlmCheck: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(merged.stage, 'graph-merged');
    assert.equal(merged.graph.nodes.some((node) => node.id === 'dataset:training'), true);
    assert.equal(merged.graph.nodes.some((node) => node.id === 'dataset:office-home'), true);
    assert.equal(
      merged.graph.relationships.some((relationship) => relationship.targetId === 'dataset:training'),
      true
    );
    assert.equal(
      merged.graph.relationships.filter((relationship) => relationship.sourceId === 'paper:1' && relationship.type === EDGE_TYPES.EVALUATES_ON).length,
      2
    );

    const staged = await loadStagedCorpusBuild(tempCorpusRoot);
    assert.equal(staged.state.stage, 'graph-merged');
    assert.equal(staged.meta.nodeLlmCheck.checkedNodeCount, 0);
    assert.equal(staged.meta.nodeLlmCheck.droppedNodeCount, 0);
    assert.equal(staged.state.nodeLlmCheckRequested, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
