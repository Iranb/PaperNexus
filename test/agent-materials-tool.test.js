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
    'The method uses confidence calibration and domain adaptation to separate known and novel classes.',
    '',
    '## Experiments',
    '',
    'Training uses batch size 256 for 100 epochs on a single A100 GPU. The code is available at https://github.com/example/gcd.',
    '',
    'Table 1: Compute budget for the reliability calibration run.',
    '',
    '| GPU | Runtime | Batch size |',
    '| --- | --- | --- |',
    '| A100 | 6 hours | 256 |',
    '',
    'Figure 1: Reliability diagram generated on A100 after 100 epochs.'
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
      fieldCandidates: ['Generalized Category Discovery', 'Calibration'],
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
        text: 'A target-domain prior for generalized category discovery with domain shift, calibration, baseline evaluation, and known/novel prior shift. Training uses batch size 256 for 100 epochs on a single A100 GPU.'
      }]
    }]
  };
  await writePaperChunks(rootPath, 'source:calibrated-gcd', createChunkRecordsForParsedPaper(parsedPaper));

  return rootPath;
}

async function createMultiDomainMaterialCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-agent-materials-multidomain-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });

  const graph = createKnowledgeGraph();
  const domains = [
    'Robotic Manipulation',
    'Tactile Sensing',
    'Control Theory',
    'Medical Imaging',
    'Uncertainty Calibration',
    'Human Factors'
  ];
  for (const domain of domains) {
    graph.addNode({
      id: `domain:${domain.toLowerCase().replace(/\s+/g, '-')}`,
      type: NODE_TYPES.DOMAIN,
      name: domain,
      properties: {}
    });
  }

  const papers = [
    {
      paperId: 'paper:robot-prior',
      title: 'Occlusion-Aware Robotic Grasping',
      domain: 'Robotic Manipulation',
      methodDomains: ['Robotic Manipulation'],
      text: 'A target-domain prior for robotic manipulation and grasp planning under sensor occlusion with low-cost sensors.'
    },
    {
      paperId: 'paper:tactile-transfer',
      title: 'Tactile Transfer for Robust Grasping',
      domain: 'Tactile Sensing',
      methodDomains: ['Robotic Manipulation', 'Tactile Sensing'],
      text: 'Tactile sensing transfer adaptation for robust grasp planning under sensor occlusion and contact uncertainty.'
    },
    {
      paperId: 'paper:control-story',
      title: 'Abstraction in Feedback Control',
      domain: 'Control Theory',
      methodDomains: ['Control Theory'],
      text: 'Control theory mechanism analogy and abstraction for planning under partial observation, feedback, and uncertainty.'
    },
    {
      paperId: 'paper:medical-prior',
      title: 'Scanner-Shift Lesion Segmentation',
      domain: 'Medical Imaging',
      methodDomains: ['Medical Imaging'],
      text: 'A target-domain prior for medical imaging lesion segmentation under scanner shift and hospital-domain drift.'
    },
    {
      paperId: 'paper:uncertainty-transfer',
      title: 'Uncertainty Calibration for Scanner Shift',
      domain: 'Uncertainty Calibration',
      methodDomains: ['Medical Imaging', 'Uncertainty Calibration'],
      text: 'Uncertainty calibration transfer adaptation for lesion segmentation under scanner shift and distribution drift.'
    },
    {
      paperId: 'paper:human-factors-story',
      title: 'Human Factors in Diagnostic Uncertainty',
      domain: 'Human Factors',
      methodDomains: ['Human Factors'],
      text: 'Human factors mechanism analogy for communicating diagnostic uncertainty and reframing failure modes.'
    }
  ];

  const sources = [];
  for (const [index, paper] of papers.entries()) {
    const sourceKey = `source:${paper.paperId.replace('paper:', '')}`;
    const sourcePath = path.join(rootPath, `${paper.paperId.replace('paper:', '')}.md`);
    await fs.writeFile(sourcePath, [`# ${paper.title}`, '', paper.text].join('\n'), 'utf8');
    graph.addNode({
      id: paper.paperId,
      type: NODE_TYPES.PAPER,
      name: paper.title,
      properties: {
        paperId: paper.paperId,
        paperTitle: paper.title,
        abstract: paper.text,
        fieldOfStudy: paper.domain
      }
    });
    graph.addNode({
      id: `method:${paper.paperId.replace('paper:', '')}`,
      type: NODE_TYPES.METHOD,
      name: paper.text,
      properties: {
        paperId: paper.paperId,
        paperTitle: paper.title,
        fieldCandidates: paper.methodDomains,
        text: paper.text
      }
    });
    graph.addRelationship({
      id: `rel:${paper.paperId.replace('paper:', '')}:method`,
      type: EDGE_TYPES.USES,
      sourceId: paper.paperId,
      targetId: `method:${paper.paperId.replace('paper:', '')}`,
      properties: {}
    });
    sources.push({
      sourceKey,
      sourcePath,
      inputPath: sourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: paper.paperId,
      paperTitle: paper.title,
      activeInGraph: true
    });
    await writePaperChunks(rootPath, sourceKey, createChunkRecordsForParsedPaper({
      sourceKey,
      paperId: paper.paperId,
      paperTitle: paper.title,
      sections: [{
        id: `section:${index}:abstract`,
        heading: 'Abstract',
        role: 'abstract',
        order: 1,
        text: paper.text,
        chunks: [{ order: 1, text: paper.text }]
      }]
    }));
  }

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'agent-materials-multidomain-test',
    indexedAt: new Date().toISOString(),
    paperCount: papers.length,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'agent-materials-multidomain-test',
    rootPath,
    inputPath: rootPath,
    sources
  });

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
    assert.equal(payload.paper.availability.tables, true);
    assert.equal(payload.paper.availability.figures, true);
    assert.ok(payload.materials.chunks[0].text.includes('generalized category discovery'));
    assert.ok(payload.materials.tables.some((table) => table.caption?.includes('Compute budget')));
    assert.ok(payload.materials.figures.some((figure) => figure.caption?.includes('Reliability diagram')));
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
    assert.equal(payload.source_discovery.router_policy.backend, 'graph_native_source_router_v1');
    assert.ok(payload.source_discovery.candidate_source_domains.some((entry) => entry.domain === 'Calibration'));
    assert.ok(payload.source_discovery.source_domain_queries.some((entry) => entry.domain === 'Calibration'));
    assert.ok(payload.source_discovery.source_relevance_scores.some((entry) => entry.domain === 'Calibration'));
    assert.ok(payload.import_requisitions.some((entry) => entry.title === 'Missing Source Paper'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials graph-native source router records domain hints and proximal leakage', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known novel prior shift calibration',
      roles: ['near_source_method'],
      nearSourceDomains: ['Calibration'],
      minDomainDistance: 0.5,
      maxProximalResults: 1,
      sourceDomainLimit: 4
    });

    assert.equal(payload.router_policy.backend, 'graph_native_source_router_v1');
    assert.deepEqual(payload.router_policy.near_source_domains, ['Calibration']);
    assert.equal(payload.router_policy.min_domain_distance, 0.5);
    const calibration = payload.candidate_source_domains.find((entry) => entry.domain === 'Calibration');
    assert.ok(calibration);
    assert.equal(calibration.layer, 'near_source');
    assert.equal(calibration.source, 'user_layer_hint');
    assert.equal(calibration.proximal_leakage, true);
    assert.ok(payload.source_domain_queries.some((entry) => entry.domain === 'Calibration' && entry.role === 'near_source_method'));
    assert.ok(payload.source_relevance_scores.some((entry) => entry.domain === 'Calibration' && entry.proximal_leakage === true));
    assert.ok(payload.candidate_papers.some((entry) => entry.source_domain === 'Calibration' && entry.role === 'near_source_method'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials opt-in provider evidence records provider hits without importing', async () => {
  const rootPath = await createMaterialCorpus();
  const requests = [];
  const fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.ok(url.pathname.endsWith('/snippet/search'));
    const query = url.searchParams.get('query') || '';
    assert.equal(url.searchParams.get('limit'), '1');
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'query';
    return createJsonResponse({
      retrievalVersion: 'provider-evidence-test',
      data: [{
        score: 0.73,
        paper: {
          paperId: `s2-${slug}`,
          corpusId: `9${requests.length}`,
          title: `Provider Evidence for ${slug}`,
          year: 2025,
          venue: 'Provider Test',
          url: `https://example.test/${slug}`,
          externalIds: {
            DOI: `10.1234/${slug}`
          },
          fieldsOfStudy: ['Computer Science'],
          isOpenAccess: true,
          openAccessPdf: {
            url: `https://example.test/${slug}.pdf`
          }
        },
        snippet: {
          text: `Provider snippet for ${query} with bounded evidence only.`,
          snippetKind: 'abstract',
          section: 'Abstract'
        }
      }]
    });
  };

  try {
    const plan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'ProviderEvidenceSmoke',
      targetDomain: 'Computer Science',
      targetProblem: 'calibrated discovery under distribution shift',
      roles: ['target_prior'],
      includeProviderEvidence: true,
      persistProviderEvidence: true,
      providerEvidenceLimit: 1,
      providerEvidenceQueryLimit: 2,
      providerEvidencePersistLimit: 2
    }, { fetch });

    assert.equal(plan.provider_evidence.enabled, true);
    assert.equal(plan.provider_evidence.backend, 'semantic_scholar_snippets');
    assert.ok(plan.provider_evidence.query_runs.length > 0);
    assert.equal(plan.provider_evidence.persistence.status, 'persisted');
    assert.equal(plan.provider_evidence.persistence.persisted_count, 2);
    assert.ok(plan.candidate_papers.some((entry) => entry.provider === 'semantic_scholar_snippets'));
    assert.ok(plan.import_requisitions.some((entry) => entry.why_needed.includes('Provider evidence hit')));

    const cart = await executeAgentMaterialsTool({
      operation: 'evidence_cart',
      action: 'list',
      corpus: rootPath,
      project: 'ProviderEvidenceSmoke',
      tags: ['provider_evidence']
    });
    assert.equal(cart.items.length, 2);
    assert.ok(cart.items.every((item) => item.source_type === 'provider_snippet'));

    const pack = await executeAgentMaterialsTool({
      operation: 'research_material_pack',
      corpus: rootPath,
      project: 'ProviderEvidenceSmoke',
      targetDomain: 'Computer Science',
      targetProblem: 'calibrated discovery under distribution shift',
      roles: ['target_prior'],
      includeProviderEvidence: true,
      providerEvidenceLimit: 1,
      providerEvidenceQueryLimit: 1
    }, { fetch });
    const providerItem = pack.groups[0].items.find((entry) => entry.materials.provider_snippets?.length);
    assert.ok(providerItem);
    assert.equal(providerItem.provenance[0].source_type, 'provider_search');
    assert.equal(pack.source_discovery.provider_evidence.enabled, true);

    const negative = await executeAgentMaterialsTool({
      operation: 'negative_evidence_pack',
      corpus: rootPath,
      project: 'ProviderEvidenceSmoke',
      targetDomain: 'Computer Science',
      targetProblem: 'unseen direct setting for provider evidence',
      roles: ['negative_evidence'],
      includeProviderEvidence: true,
      persistProviderEvidence: true,
      providerEvidenceLimit: 1,
      providerEvidenceQueryLimit: 2,
      providerEvidencePersistLimit: 1
    }, { fetch });
    assert.ok(negative.records[0].direct_provider_hit_count > 0);
    assert.equal(negative.records[0].provider_evidence.enabled, true);
    assert.equal(negative.records[0].provider_evidence.persistence.persisted_count, 1);
    assert.ok(negative.records[0].provider_evidence.query_runs.some((run) => run.hit_classification === 'direct'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials generic multi-domain regression exports separated packs and source plans', async () => {
  const rootPath = await createMultiDomainMaterialCorpus();
  try {
    const outputDir = path.join(rootPath, 'exports-robotics');
    const roboticsPack = await executeAgentMaterialsTool({
      operation: 'research_material_pack',
      corpus: rootPath,
      project: 'GenericRoboticsSmoke',
      targetDomain: 'Robotic Manipulation',
      targetProblem: 'grasp planning under sensor occlusion',
      constraints: ['low-cost sensors'],
      roles: ['target_prior', 'near_source_method', 'far_source_story'],
      sourceDomainLimit: 6,
      outputDir
    });

    assert.equal(roboticsPack.operation, 'research_material_pack');
    assert.deepEqual(roboticsPack.groups.map((group) => group.role), ['target_prior', 'near_source_method', 'far_source_story']);
    assert.ok(await fs.stat(path.join(outputDir, 'material_pack.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'material_pack.md')));
    assert.ok(await fs.stat(path.join(outputDir, 'source_discovery_plan.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'missing_materials.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'negative_evidence.json')));
    assert.ok(await fs.stat(path.join(outputDir, 'overlay_summary.json')));
    assert.equal(roboticsPack.exports.source_discovery_plan_path, path.join(outputDir, 'source_discovery_plan.json'));
    assert.equal(roboticsPack.exports.missing_materials_path, path.join(outputDir, 'missing_materials.json'));
    assert.equal(roboticsPack.exports.negative_evidence_path, path.join(outputDir, 'negative_evidence.json'));
    assert.equal(roboticsPack.exports.overlay_summary_path, path.join(outputDir, 'overlay_summary.json'));

    const exportedPlan = JSON.parse(await fs.readFile(path.join(outputDir, 'source_discovery_plan.json'), 'utf8'));
    const exportedOverlay = JSON.parse(await fs.readFile(path.join(outputDir, 'overlay_summary.json'), 'utf8'));
    assert.equal(exportedPlan.operation, 'source_discovery_plan');
    assert.equal(exportedOverlay.operation, 'overlay_summary');
    assert.ok(exportedPlan.candidate_source_domains.some((entry) => entry.domain === 'Tactile Sensing'));
    assert.ok(roboticsPack.groups
      .flatMap((group) => group.items)
      .every((item) => item.availability && Array.isArray(item.provenance)));
    assert.ok(roboticsPack.groups
      .find((group) => group.role === 'near_source_method')
      .items.some((item) => item.source_domain === 'Tactile Sensing'));

    const medicalPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'GenericMedicalSmoke',
      targetDomain: 'Medical Imaging',
      targetProblem: 'lesion segmentation under scanner shift',
      constraints: ['hospital-domain drift'],
      roles: ['target_prior', 'near_source_method', 'far_source_story'],
      sourceDomainLimit: 6
    });
    const roboticsDomains = roboticsPack.source_discovery.candidate_source_domains.map((entry) => entry.domain).slice(0, 3);
    const medicalDomains = medicalPlan.candidate_source_domains.map((entry) => entry.domain).slice(0, 3);

    assert.ok(medicalDomains.includes('Uncertainty Calibration'));
    assert.notDeepEqual(roboticsDomains, medicalDomains);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials stores project overlays and merges paper roles into material packs', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const role = await executeAgentMaterialsTool({
      operation: 'paper_role_overlay',
      action: 'add',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      role: 'novelty_risk',
      layer: 'target_domain',
      judgmentType: 'closest_prior_overlap',
      confidence: 'medium',
      supportingEvidenceIds: ['evidence:gcd-calibration-abstract'],
      notes: 'Use this as a recoverable Agent judgment, not a raw graph fact.'
    });

    assert.equal(role.operation, 'paper_role_overlay');
    assert.equal(role.roles[0].role, 'novelty_risk');
    assert.equal(role.roles[0].paper_id, 'paper:gcd-calibration');

    const evidence = await executeAgentMaterialsTool({
      operation: 'evidence_cart',
      action: 'add',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      evidenceId: 'evidence:gcd-calibration-abstract',
      itemType: 'snippet',
      sourceType: 'chunk',
      sourceId: 'section:abstract',
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      role: 'novelty_risk',
      text: 'Known/novel prior shift and calibration overlap with the proposed setting.'
    });

    assert.equal(evidence.operation, 'evidence_cart');
    assert.equal(evidence.items[0].evidence_id, 'evidence:gcd-calibration-abstract');

    const workflow = await executeAgentMaterialsTool({
      operation: 'workflow_state',
      action: 'update',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      hypothesis: 'Reliability-calibrated Cross-Domain GCD under known/novel prior shift',
      openQuestions: ['Does closest prior already cover abstention?'],
      neededMaterials: ['More target-domain prior evidence']
    });

    assert.equal(workflow.operation, 'workflow_state');
    assert.equal(workflow.state.open_questions[0], 'Does closest prior already cover abstention?');

    const pack = await executeAgentMaterialsTool({
      operation: 'research_material_pack',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known novel prior shift calibration',
      roles: ['novelty_risk']
    });

    const item = pack.groups[0].items.find((entry) => entry.paper_id === 'paper:gcd-calibration');
    assert.ok(item);
    assert.equal(item.overlay_roles[0].role, 'novelty_risk');
    assert.equal(pack.project_overlay.role_count, 1);
    assert.equal(pack.project_overlay.evidence_count, 1);
    assert.equal(pack.project_overlay.workflow_state.hypothesis, 'Reliability-calibrated Cross-Domain GCD under known/novel prior shift');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials returns negative evidence and experiment cost materials', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const negative = await executeAgentMaterialsTool({
      operation: 'negative_evidence_pack',
      corpus: rootPath,
      project: 'CrossDomainGCD',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'nonexistent direct setting xyz',
      roles: ['negative_evidence'],
      timeWindow: '2020-2026'
    });

    assert.equal(negative.operation, 'negative_evidence_pack');
    assert.equal(negative.records[0].filters.time_window, '2020-2026');
    assert.ok(Array.isArray(negative.records[0].searched_queries));
    assert.equal(typeof negative.records[0].direct_hit_count, 'number');

    const cost = await executeAgentMaterialsTool({
      operation: 'experiment_cost_materials',
      corpus: rootPath,
      paperId: 'paper:gcd-calibration'
    });

    assert.equal(cost.operation, 'experiment_cost_materials');
    assert.equal(cost.extraction_policy.backend, 'regex_plus_structured_markdown_v1');
    assert.equal(cost.signals.hardware.status, 'reported');
    assert.ok(cost.signals.hardware.snippets.some((snippet) => snippet.match.includes('A100')));
    assert.ok(cost.signals.hardware.snippets.some((snippet) => snippet.provenance.source_type === 'figure_caption'));
    assert.equal(cost.signals.batch_size.status, 'reported');
    assert.equal(cost.signals.runtime.status, 'reported');
    assert.ok(cost.signals.runtime.snippets.some((snippet) => snippet.provenance.source_type === 'markdown_table'));
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
