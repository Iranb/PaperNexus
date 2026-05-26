import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { NODE_TYPES } from '../src/core/graph/schema.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { createChunkRecordsForParsedPaper, writePaperChunks } from '../src/storage/chunk-store.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

async function createCrowdedComponentCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-composition-collision-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const papers = [{
    id: 'paper:parametric-gcd',
    title: 'Parametric GCD Prior Capacity Calibration',
    text: 'Parametric GCD studies prior capacity calibration for known and novel class balance in generalized category discovery.'
  }, {
    id: 'paper:hidisc-tradeoff',
    title: 'HiDISC Seen Novel Prior Calibration',
    text: 'HiDISC tunes seen/novel trade-off with prior calibration under generalized category discovery domain shift.'
  }, {
    id: 'paper:cdad-capacity',
    title: 'CDAD-Net Entropy Distance Capacity Calibration',
    text: 'CDAD-Net separates source-aligned target and novel target with entropy distance signals and capacity calibration.'
  }];

  const graph = createKnowledgeGraph();
  const sources = [];
  for (const paper of papers) {
    const sourceKey = `source:${paper.id.replace('paper:', '')}`;
    const sourcePath = path.join(rootPath, `${paper.id.replace('paper:', '')}.md`);
    await fs.writeFile(sourcePath, [`# ${paper.title}`, '', paper.text].join('\n'), 'utf8');
    graph.addNode({
      id: paper.id,
      type: NODE_TYPES.PAPER,
      name: paper.title,
      properties: {
        paperId: paper.id,
        paperTitle: paper.title,
        abstract: paper.text,
        fieldOfStudy: 'Generalized Category Discovery'
      }
    });
    sources.push({
      sourceKey,
      sourcePath,
      inputPath: sourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: paper.id,
      paperTitle: paper.title,
      activeInGraph: true
    });
    await writePaperChunks(rootPath, sourceKey, createChunkRecordsForParsedPaper({
      sourceKey,
      paperId: paper.id,
      paperTitle: paper.title,
      sections: [{
        id: `section:${paper.id}`,
        heading: 'Abstract',
        role: 'abstract',
        order: 1,
        text: paper.text,
        chunks: [{ order: 1, text: paper.text }]
      }]
    }));
  }

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'composition-collision-test',
    indexedAt: new Date().toISOString(),
    paperCount: papers.length,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'composition-collision-test',
    rootPath,
    inputPath: rootPath,
    sources
  });
  return rootPath;
}

test('composition_collision_matrix audits crowded components without upgrading unseen full combination to novelty', async () => {
  const rootPath = await createCrowdedComponentCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'CompositionCollision',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'certified Absorb Separate Buffer non-identifiable reporting with prior capacity calibration',
      ideaComponents: ['prior/capacity calibration', 'Absorb', 'Separate', 'Buffer', 'non-identifiable reporting']
    });

    const priorComponent = payload.composition_collision_matrix.single_component_hits
      .find((entry) => entry.component === 'prior/capacity calibration');
    assert.equal(priorComponent.status, 'crowded_component');
    assert.ok(priorComponent.graph_hit_count >= 2);
    assert.equal(payload.composition_collision_matrix.full_combination_hits.status, 'full_combination_not_seen_in_graph_scope');
    assert.notEqual(payload.composition_collision_matrix.collision_risk, 'full_combination_seen_in_graph');
    assert.equal(payload.evidence_sufficiency.novelty_claim_allowed, false);
    assert.ok(payload.composition_collision_matrix.graph_scope_limit.includes('not novelty proof'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
