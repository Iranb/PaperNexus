import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { saveCorpus } from '../src/storage/corpus-store.js';

test('saveCorpus reports progress across authoritative graph, lite view, and metadata writes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-corpus-progress-'));
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const events = [];

  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'paper:1',
      type: 'Paper',
      name: 'Progress Test Paper',
      properties: {
        paperId: 'paper:1',
        paperTitle: 'Progress Test Paper',
        layer: 'PaperLayer'
      }
    });
    graph.addNode({
      id: 'problem:1',
      type: 'Problem',
      name: 'graph progress visibility',
      properties: {
        paperId: 'paper:1',
        paperTitle: 'Progress Test Paper',
        layer: 'ProblemLayer',
        brainstormEligible: true
      }
    });
    graph.addRelationship({
      id: 'rel:1',
      sourceId: 'paper:1',
      targetId: 'problem:1',
      type: 'HAS_PROBLEM',
      properties: {
        layerPath: 'PaperLayer->ProblemLayer'
      }
    });

    await saveCorpus(tempRoot, graph, {
      name: 'progress-test',
      indexedAt: new Date().toISOString(),
      paperCount: 1,
      relationshipCount: 1
    }, {
      liteViewMode: 'incremental',
      liteViewSources: [{
        sourceKey: '/tmp/progress-test.md',
        paperId: 'paper:1',
        paperTitle: 'Progress Test Paper',
        fingerprint: '1:1'
      }],
      onProgress(event) {
        events.push(event);
      }
    });

    assert.ok(events.some((event) => event.phase === 'authoritative-graph' && /authoritative graph/i.test(event.label)));
    assert.ok(events.some((event) => event.phase === 'lite-view' && /lite graph/i.test(event.label)));
    assert.ok(events.some((event) => event.phase === 'meta' && /metadata/i.test(event.label)));
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
