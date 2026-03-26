import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  loadCorpus,
  loadStagedCorpusBuild,
  saveSourceManifest,
  saveStagedCorpusBuild
} from '../src/storage/corpus-store.js';

function createManifestToken(manifest) {
  return JSON.stringify({
    version: manifest.version || null,
    indexedAt: manifest.indexedAt || null,
    sourceCount: Array.isArray(manifest.sources) ? manifest.sources.length : 0,
    semanticExtractionMode: manifest.semanticExtractionMode || null
  });
}

test('mergeGraphCorpus canonicalizes similar evaluation nodes before write-index persists the graph', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-merge-stage-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-merge-stage-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    const sourcePath = path.join(tempCorpusRoot, 'paper-a.md');
    await fs.writeFile(sourcePath, '# Paper A\n\n## Results\n\nOffice-Home dataset.\n', 'utf8');
    const stats = await fs.stat(sourcePath);
    const fingerprint = `${Math.round(Number(stats.mtimeMs || 0))}:${Number(stats.size || 0)}`;

    const manifest = {
      version: 4,
      corpusName: 'merge-stage-test',
      rootPath: tempCorpusRoot,
      inputPath: tempCorpusRoot,
      inputPaths: [tempCorpusRoot],
      sourceMode: 'markdown',
      semanticExtractionMode: 'heuristic-only',
      indexedAt: '2026-03-26T00:00:00.000Z',
      lastChangeSummary: {
        added: 1,
        updated: 0,
        reused: 0,
        removed: 0
      },
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
      name: 'merge-stage-test',
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
      id: 'dataset:office-home',
      type: NODE_TYPES.DATASET,
      name: 'Office-Home dataset',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        aliases: ['Office Home dataset'],
        mentionCount: 1
      }
    });
    graph.addNode({
      id: 'benchmark:office-home',
      type: NODE_TYPES.BENCHMARK,
      name: 'Office Home benchmarks',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        aliases: ['Office-Home benchmark'],
        mentionCount: 1
      }
    });
    graph.addNode({
      id: 'dataset:oxford-pets',
      type: NODE_TYPES.DATASET,
      name: 'Oxford Pets dataset',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        mentionCount: 1
      }
    });
    graph.addNode({
      id: 'dataset:oxford-pet',
      type: NODE_TYPES.DATASET,
      name: 'Oxford-Pet dataset',
      properties: {
        layer: 'EvaluationLayer',
        paperTitles: ['Paper A'],
        mentionCount: 1
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
      id: 'rel:paper-office-dataset',
      sourceId: 'paper:1',
      targetId: 'dataset:office-home',
      type: EDGE_TYPES.EVALUATES_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'Office-Home dataset',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });
    graph.addRelationship({
      id: 'rel:paper-office-benchmark',
      sourceId: 'paper:1',
      targetId: 'benchmark:office-home',
      type: EDGE_TYPES.BENCHMARKED_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'Office Home benchmarks',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });
    graph.addRelationship({
      id: 'rel:paper-oxford-pets',
      sourceId: 'paper:1',
      targetId: 'dataset:oxford-pets',
      type: EDGE_TYPES.EVALUATES_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'Oxford Pets dataset',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });
    graph.addRelationship({
      id: 'rel:paper-oxford-pet',
      sourceId: 'paper:1',
      targetId: 'dataset:oxford-pet',
      type: EDGE_TYPES.EVALUATES_ON,
      properties: {
        sourcePaperId: 'paper:1',
        sourcePaperTitle: 'Paper A',
        evidenceText: 'Oxford Pets dataset',
        layerPath: 'DocumentLayer->EvaluationLayer'
      }
    });

    const meta = {
      name: 'merge-stage-test',
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
        EvaluationLayer: 4
      },
      layerPaths: {
        'CorpusLayer->DocumentLayer': 1,
        'DocumentLayer->EvaluationLayer': 4
      },
      brainstormView: {
        eligibleNodeCount: 0,
        nodeTypes: {}
      },
      llm: {
        enabled: false,
        providers: [],
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
      expectedSources: [
        {
          sourceKey: sourcePath,
          fingerprint
        }
      ]
    });

    const ingestion = await import('../src/core/ingestion/pipeline.js');

    const merged = await ingestion.mergeGraphCorpus(tempCorpusRoot, {});
    assert.equal(merged.stage, 'graph-merged');
    assert.equal(merged.graph.nodes.filter((node) => node.type === NODE_TYPES.DATASET || node.type === NODE_TYPES.BENCHMARK).length, 2);

    const mergedResumed = await ingestion.mergeGraphCorpus(tempCorpusRoot, {});
    assert.equal(mergedResumed.stage, 'graph-merged');
    assert.equal(mergedResumed.reused, true);

    const officeNodes = merged.graph.nodes.filter((node) => /office[- ]home/i.test(node.name) && [NODE_TYPES.DATASET, NODE_TYPES.BENCHMARK].includes(node.type));
    assert.equal(officeNodes.length, 1);
    assert.equal(officeNodes[0].type, NODE_TYPES.DATASET);
    assert.ok(Array.isArray(officeNodes[0].properties.aliases));
    assert.ok(officeNodes[0].properties.aliases.some((alias) => alias === 'Office Home benchmarks'));

    const oxfordNodes = merged.graph.nodes.filter((node) => /oxford/i.test(node.name) && node.type === NODE_TYPES.DATASET);
    assert.equal(oxfordNodes.length, 1);

    const paperEvalEdges = merged.graph.relationships.filter((relationship) => relationship.sourceId === 'paper:1' && [EDGE_TYPES.EVALUATES_ON, EDGE_TYPES.BENCHMARKED_ON].includes(relationship.type));
    assert.equal(paperEvalEdges.length, 2);
    assert.ok(paperEvalEdges.every((relationship) => relationship.type === EDGE_TYPES.EVALUATES_ON));

    const stagedBuild = await loadStagedCorpusBuild(tempCorpusRoot);
    assert.equal(stagedBuild.state.stage, 'graph-merged');

    const committed = await ingestion.writeIndexCorpus(tempCorpusRoot, {});
    assert.equal(committed.stage, 'index-written');
    const loaded = await loadCorpus(tempCorpusRoot);
    assert.equal(loaded.graph.nodes.filter((node) => node.type === NODE_TYPES.DATASET || node.type === NODE_TYPES.BENCHMARK).length, 2);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
