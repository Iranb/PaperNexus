import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { createChunkRecordsForParsedPaper, writePaperChunks } from '../src/storage/chunk-store.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

async function createStorylineCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-storyline-chain-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });

  const sourcePath = path.join(rootPath, 'calibrated-gcd-story.md');
  const sourceText = [
    '# Reliability-Calibrated GCD Story',
    '',
    'A target-domain prior for generalized category discovery with known novel prior shift calibration.',
    'The method uses confidence calibration under domain shift, but fails when novel class priors drift without recalibration.',
    'Evaluation uses OfficeHome, GCD-Shift, ECE, accuracy, and an ablation that removes prior-shift correction.',
    'Training uses one A100 GPU for 6 hours with batch size 256.'
  ].join('\n');
  await fs.writeFile(sourcePath, sourceText, 'utf8');

  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:gcd-story',
    type: NODE_TYPES.PAPER,
    name: 'Reliability-Calibrated GCD Story',
    properties: {
      paperId: 'paper:gcd-story',
      paperTitle: 'Reliability-Calibrated GCD Story',
      abstract: sourceText,
      fieldOfStudy: 'Generalized Category Discovery'
    }
  });
  graph.addNode({
    id: 'method:prior-shift-calibration',
    type: NODE_TYPES.METHOD,
    name: 'prior-shift confidence calibration',
    properties: { text: 'confidence calibration under known novel prior shift' }
  });
  graph.addNode({
    id: 'limitation:novel-prior-drift',
    type: NODE_TYPES.LIMITATION,
    name: 'fails when novel class priors drift without recalibration',
    properties: { text: 'novel class prior drift remains a failure mode' }
  });
  graph.addNode({
    id: 'claim:reliability',
    type: NODE_TYPES.CLAIM,
    name: 'calibration improves reliability under domain shift',
    properties: { text: 'reported reliability claim under domain shift' }
  });
  graph.addNode({
    id: 'dataset:officehome',
    type: NODE_TYPES.DATASET,
    name: 'OfficeHome',
    properties: {}
  });
  graph.addNode({
    id: 'benchmark:gcd-shift',
    type: NODE_TYPES.BENCHMARK,
    name: 'GCD-Shift',
    properties: {}
  });
  graph.addNode({
    id: 'metric:ece',
    type: NODE_TYPES.METRIC,
    name: 'ECE',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:method',
    type: EDGE_TYPES.USES,
    sourceId: 'paper:gcd-story',
    targetId: 'method:prior-shift-calibration',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:limitation',
    type: EDGE_TYPES.HAS_LIMITATION,
    sourceId: 'paper:gcd-story',
    targetId: 'limitation:novel-prior-drift',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:claim',
    type: EDGE_TYPES.CLAIMS,
    sourceId: 'paper:gcd-story',
    targetId: 'claim:reliability',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:dataset',
    type: EDGE_TYPES.EVALUATES_ON,
    sourceId: 'paper:gcd-story',
    targetId: 'dataset:officehome',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:benchmark',
    type: EDGE_TYPES.BENCHMARKED_ON,
    sourceId: 'paper:gcd-story',
    targetId: 'benchmark:gcd-shift',
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:story:metric',
    type: EDGE_TYPES.REPORTS,
    sourceId: 'paper:gcd-story',
    targetId: 'metric:ece',
    properties: {}
  });

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'storyline-chain-test',
    indexedAt: new Date().toISOString(),
    paperCount: 1,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'storyline-chain-test',
    rootPath,
    inputPath: rootPath,
    sources: [{
      sourceKey: 'source:gcd-story',
      sourcePath,
      inputPath: sourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: 'paper:gcd-story',
      paperTitle: 'Reliability-Calibrated GCD Story',
      activeInGraph: true
    }]
  });
  await writePaperChunks(rootPath, 'source:gcd-story', createChunkRecordsForParsedPaper({
    sourceKey: 'source:gcd-story',
    paperId: 'paper:gcd-story',
    paperTitle: 'Reliability-Calibrated GCD Story',
    sections: [{
      id: 'section:story',
      heading: 'Story',
      role: 'abstract',
      order: 1,
      text: sourceText,
      chunks: [{ order: 1, text: sourceText }]
    }]
  }));
  return rootPath;
}

test('innovation_evidence_pack builds cross-paper-style storyline chains with explicit risks and source refs', async () => {
  const rootPath = await createStorylineCorpus();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-storyline-chain-output-'));
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'StorylineChain',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known novel prior shift calibration failure under domain shift',
      outputDir
    });

    assert.ok(payload.idea_evidence_cards.length > 0);
    assert.ok(payload.storyline_chains.length > 0);

    const chain = payload.storyline_chains[0];
    for (const beat of ['status_quo', 'tension', 'gap', 'mechanism', 'intervention', 'validation', 'contribution']) {
      assert.ok(Object.hasOwn(chain, beat), `missing storyline beat ${beat}`);
    }
    assert.ok(Array.isArray(chain.risk_and_boundary));
    assert.ok(Array.isArray(chain.missing_beats));
    assert.ok(Array.isArray(chain.story_risks));
    assert.ok(Array.isArray(chain.supporting_papers));
    assert.ok(Array.isArray(chain.source_spans));
    assert.ok(chain.source_spans.length > 0);
    assert.ok(chain.risk_and_boundary.some((entry) => entry.includes('does not claim final novelty')));

    const markdown = await fs.readFile(payload.exports.storyline_chains_markdown_path, 'utf8');
    assert.ok(markdown.includes('Contribution boundary'));
    assert.ok(markdown.includes('Risk and boundary'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
