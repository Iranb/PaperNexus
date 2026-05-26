import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    }
  };
}

async function createSparseCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-evidence-sufficiency-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const graph = createKnowledgeGraph();
  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'evidence-sufficiency-sparse-test',
    indexedAt: new Date().toISOString(),
    paperCount: 0,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'evidence-sufficiency-sparse-test',
    rootPath,
    inputPath: rootPath,
    sources: []
  });
  return rootPath;
}

test('innovation_evidence_pack gates sparse evidence with required follow-up', async () => {
  const rootPath = await createSparseCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'SparseGate',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'certified Absorb Separate Buffer non-identifiable reporting for GCD',
      ideaComponents: ['Absorb', 'Separate', 'Buffer', 'non-identifiable reporting']
    });

    assert.equal(payload.evidence_sufficiency.status, 'insufficient');
    assert.equal(payload.evidence_sufficiency.novelty_claim_allowed, false);
    assert.equal(payload.evidence_sufficiency.experiment_planning_allowed, false);
    assert.ok(payload.evidence_sufficiency.reason_codes.includes('missing_cross_domain_coverage'));
    assert.ok(payload.required_followup.some((entry) => entry.reason === 'missing_cross_domain_coverage'));
    assert.ok(payload.required_followup.some((entry) => entry.next_tool === 'literature_discovery'));
    assert.equal(payload.autoresearch_handoff.status, 'needs_more_materials');
    assert.equal(payload.autoresearch_handoff.novelty_claim_allowed, false);
    assert.ok(payload.coverage_matrix.some((row) => row.area.includes('selective prediction') && row.graph_coverage === 'none'));
    assert.ok(payload.composition_collision_matrix.full_combination_hits.status.includes('not_seen'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('provider 429/timeout makes negative evidence inconclusive', async () => {
  const rootPath = await createSparseCorpus();
  const fetch = async () => createJsonResponse({ message: 'rate limited' }, 429);
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'ProviderFailureGate',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'certified Absorb Separate Buffer non-identifiable reporting for GCD',
      includeProviderEvidence: true,
      providerEvidenceQueryLimit: 1,
      providerEvidenceLimit: 1
    }, { fetch });

    assert.equal(payload.negative_evidence_assessment.status, 'negative_inconclusive');
    assert.equal(payload.evidence_sufficiency.status, 'inconclusive');
    assert.ok(payload.evidence_sufficiency.reason_codes.includes('negative_evidence_inconclusive'));
    assert.equal(payload.evidence_sufficiency.novelty_claim_allowed, false);
    assert.ok(payload.required_followup.some((entry) => entry.reason === 'negative_inconclusive'));
    assert.ok(payload.negative_evidence_assessment.failure_modes.some((entry) => entry.includes('429')));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
