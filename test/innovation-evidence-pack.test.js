import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

async function createSparseMaterialCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-innovation-sparse-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });

  const graph = createKnowledgeGraph();
  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'innovation-evidence-sparse-test',
    indexedAt: new Date().toISOString(),
    paperCount: 0,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'innovation-evidence-sparse-test',
    rootPath,
    inputPath: rootPath,
    sources: []
  });
  return rootPath;
}

test('innovation_evidence_pack reports missing materials without claiming novelty in sparse corpora', async () => {
  const rootPath = await createSparseMaterialCorpus();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-innovation-sparse-output-'));
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'SparseInnovation',
      targetDomain: 'Sparse Target Domain',
      targetProblem: 'unsupported nonexistent mechanism transfer',
      outputDir
    });

    assert.equal(payload.operation, 'innovation_evidence_pack');
    assert.equal(payload.policy.final_idea_judge, false);
    assert.equal(payload.policy.novelty_proof, false);
    assert.equal(payload.autoresearch_handoff.status, 'needs_more_materials');
    assert.equal(payload.idea_evidence_cards.length, 0);
    assert.equal(payload.storyline_chains.length, 0);
    assert.ok(payload.missing_materials.some((entry) => entry.includes('target_prior')));
    assert.ok(payload.negative_evidence.length > 0);
    assert.ok(payload.closest_prior_map.some((entry) => entry.collision_relevance === 'negative_evidence_search_scope'));
    assert.ok(payload.autoresearch_handoff.required_consumer_checks.some((entry) => entry.includes('novelty proof')));

    const ideaCardsJsonl = await fs.readFile(payload.exports.idea_evidence_cards_jsonl_path, 'utf8');
    assert.equal(ideaCardsJsonl, '');
    const handoffMarkdown = await fs.readFile(payload.exports.autoresearch_handoff_markdown_path, 'utf8');
    assert.ok(handoffMarkdown.includes('does not choose the final research idea'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
