import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { handleMessage } from '../src/mcp/core.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';
import { createChunkRecordsForParsedPaper, writePaperChunks } from '../src/storage/chunk-store.js';

async function createMaterialCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-agent-materials-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });

  const sourcePath = path.join(rootPath, 'calibrated-gcd.md');
  await fs.writeFile(sourcePath, [
    '# Reliability-Calibrated GCD',
    '',
    '## Abstract',
    '',
    'A target-domain prior for generalized category discovery with domain shift, calibration, baseline evaluation, and known/novel prior shift.',
    '',
    '## Method',
    '',
    'The method uses confidence calibration and domain adaptation to separate known and novel classes.'
  ].join('\n'), 'utf8');

  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:gcd-calibration',
    type: NODE_TYPES.PAPER,
    name: 'Reliability-Calibrated GCD',
    properties: {
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      abstract: 'A target-domain prior for generalized category discovery with domain shift and calibration.',
      fieldOfStudy: 'Generalized Category Discovery'
    }
  });
  graph.addNode({
    id: 'domain:gcd',
    type: NODE_TYPES.DOMAIN,
    name: 'Generalized Category Discovery',
    properties: {}
  });
  graph.addNode({
    id: 'domain:calibration',
    type: NODE_TYPES.DOMAIN,
    name: 'Calibration',
    properties: {}
  });
  graph.addNode({
    id: 'method:confidence-calibration',
    type: NODE_TYPES.METHOD,
    name: 'confidence calibration under domain shift',
    properties: {
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      text: 'Calibration method for domain shift and known novel prior shift.'
    }
  });
  graph.addRelationship({
    id: 'rel:paper-method',
    type: EDGE_TYPES.USES,
    sourceId: 'paper:gcd-calibration',
    targetId: 'method:confidence-calibration',
    properties: {}
  });

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'agent-materials-test',
    indexedAt: new Date().toISOString(),
    paperCount: 1,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'agent-materials-test',
    rootPath,
    inputPath: rootPath,
    sources: [{
      sourceKey: 'source:calibrated-gcd',
      sourcePath,
      inputPath: sourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      identifiers: {
        doi: '10.0000/gcd'
      },
      activeInGraph: true
    }]
  });

  const parsedPaper = {
    sourceKey: 'source:calibrated-gcd',
    paperId: 'paper:gcd-calibration',
    paperTitle: 'Reliability-Calibrated GCD',
    sections: [{
      id: 'section:abstract',
      heading: 'Abstract',
      role: 'abstract',
      order: 1,
      text: 'A target-domain prior for generalized category discovery with domain shift, calibration, baseline evaluation, and known/novel prior shift.',
      chunks: [{
        order: 1,
        text: 'A target-domain prior for generalized category discovery with domain shift, calibration, baseline evaluation, and known/novel prior shift.'
      }]
    }]
  };
  await writePaperChunks(rootPath, 'source:calibrated-gcd', createChunkRecordsForParsedPaper(parsedPaper));

  return rootPath;
}

test('agent_materials paper_material_view returns source, graph, and chunk materials', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'paper_material_view',
      corpus: rootPath,
      paperId: 'paper:gcd-calibration'
    });

    assert.equal(payload.operation, 'paper_material_view');
    assert.equal(payload.paper.paper_id, 'paper:gcd-calibration');
    assert.equal(payload.paper.availability.markdown, true);
    assert.equal(payload.paper.availability.graph_context, true);
    assert.equal(payload.paper.availability.chunks, true);
    assert.ok(payload.materials.chunks[0].text.includes('generalized category discovery'));
    assert.ok(payload.graph_context.some((entry) => entry.node_id === 'method:confidence-calibration'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials research_material_pack groups materials and records missing seeds', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'research_material_pack',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known novel prior shift calibration',
      roles: ['target_prior', 'near_source_method'],
      seedPapers: [{
        title: 'Missing Source Paper',
        role: 'far_source_story',
        markdownUrl: 'https://example.test/missing.md'
      }]
    });

    assert.equal(payload.operation, 'research_material_pack');
    assert.deepEqual(payload.groups.map((group) => group.role), ['target_prior', 'near_source_method']);
    assert.ok(payload.groups[0].items.some((item) => item.paper_id === 'paper:gcd-calibration'));
    assert.ok(payload.source_discovery.target_queries.length > 0);
    assert.ok(payload.import_requisitions.some((entry) => entry.title === 'Missing Source Paper'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('MCP exposes agent_materials and dispatches read-only material operations', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const tools = await handleMessage({ method: 'tools/list' });
    assert.ok(tools.tools.some((tool) => tool.name === 'agent_materials'));

    const result = await handleMessage({
      method: 'tools/call',
      params: {
        name: 'agent_materials',
        arguments: {
          operation: 'source_discovery_plan',
          corpus: rootPath,
          targetDomain: 'Generalized Category Discovery',
          targetProblem: 'known novel prior shift calibration',
          roles: ['target_prior']
        }
      }
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.operation, 'source_discovery_plan');
    assert.ok(payload.target_queries.length > 0);
    assert.ok(payload.candidate_papers.some((entry) => entry.paper_id === 'paper:gcd-calibration'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
