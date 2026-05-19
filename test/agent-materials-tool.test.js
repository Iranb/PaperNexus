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
  const pmidCollisionSourcePath = path.join(rootPath, 'pmid-collision.md');
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
  await fs.writeFile(pmidCollisionSourcePath, [
    '# PMID Collision Fixture',
    '',
    '## Abstract',
    '',
    'This fixture should only match explicit PMID lookups, not arbitrary DOI URLs with similar digits.'
  ].join('\n'), 'utf8');

  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:gcd-calibration',
    type: NODE_TYPES.PAPER,
    name: 'Reliability-Calibrated GCD',
    properties: {
      paperId: 'paper:gcd-calibration',
      paperTitle: 'Reliability-Calibrated GCD',
      identifiers: {
        doi: '10.0000/gcd',
        arxiv_id: '2401.01234'
      },
      doi: '10.0000/gcd',
      arxivId: '2401.01234',
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
    id: 'paper:graph-only-identifiers',
    type: NODE_TYPES.PAPER,
    name: 'Graph-Only Identifier Paper',
    properties: {
      paperId: 'paper:graph-only-identifiers',
      paperTitle: 'Graph-Only Identifier Paper',
      identifiers: {
        doi: '10.0000/graph-only',
        arxiv_id: '2402.01234'
      },
      doi: '10.0000/graph-only',
      arxivId: '2402.01234',
      abstract: 'A graph-only paper without a source manifest entry.'
    }
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
    paperCount: 2,
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
        doi: '10.0000/gcd',
        arxiv_id: '2401.01234'
      },
      activeInGraph: true
    }, {
      sourceKey: 'source:pmid-collision',
      sourcePath: pmidCollisionSourcePath,
      inputPath: pmidCollisionSourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: 'paper:pmid-collision',
      paperTitle: 'PMID Collision Fixture',
      identifiers: {
        pmid: '100000'
      },
      activeInGraph: false
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

test('agent_materials paper_material_view rejects same-title graph matches when identifiers conflict', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'paper_material_view',
      corpus: rootPath,
      title: 'Reliability-Calibrated GCD',
      doi: '10.0000/different-paper'
    });

    assert.equal(payload.operation, 'paper_material_view');
    assert.equal(payload.paper.title, 'Reliability-Calibrated GCD');
    assert.equal(payload.paper.status, 'material_unavailable');
    assert.equal(payload.paper.availability.markdown, false);
    assert.equal(payload.paper.availability.graph_context, false);
    assert.deepEqual(payload.sources, []);
    assert.deepEqual(payload.graph_context, []);
    assert.equal(payload.import_requisitions.length, 1);
    assert.equal(payload.import_requisitions[0].identifiers.doi, '10.0000/different-paper');
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials paper_material_view returns graph-only paper identifiers', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'paper_material_view',
      corpus: rootPath,
      title: 'Graph-Only Identifier Paper'
    });

    assert.equal(payload.paper.paper_id, 'paper:graph-only-identifiers');
    assert.equal(payload.paper.status, 'in_graph');
    assert.equal(payload.paper.availability.graph_context, true);
    assert.equal(payload.paper.availability.markdown, false);
    assert.equal(payload.paper.identifiers.doi, '10.0000/graph-only');
    assert.equal(payload.paper.identifiers.arxivId, '2402.01234');
    assert.deepEqual(payload.import_requisitions, []);
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
        title: 'Seed Title Differs From Manifest',
        identifiers: {
          doi: '10.0000/gcd'
        },
        role: 'target_prior'
      }, {
        title: 'Generic DOI URL Seed',
        identifier: 'https://doi.org/10.0000/gcd',
        role: 'target_prior'
      }, {
        title: 'DOI URL Should Not Match PMID',
        identifier: 'https://doi.org/10.0000/not-in-corpus',
        role: 'target_prior',
        markdownUrl: 'https://example.test/doi-url-should-not-match-pmid.md'
      }, {
        title: 'Reliability-Calibrated GCD',
        identifiers: {
          doi: '10.0000/different-paper'
        },
        role: 'far_source_story',
        markdownUrl: 'https://example.test/title-collision.md'
      }, {
        title: 'Reliability-Calibrated GCD',
        identifiers: {
          arxivId: '2401.99999'
        },
        role: 'far_source_story',
        markdownUrl: 'https://example.test/arxiv-title-collision.md'
      }, {
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
    assert.ok(!payload.import_requisitions.some((entry) => entry.title === 'Seed Title Differs From Manifest'));
    assert.ok(!payload.import_requisitions.some((entry) => entry.title === 'Generic DOI URL Seed'));
    assert.ok(payload.import_requisitions.some((entry) => entry.title === 'DOI URL Should Not Match PMID'));
    assert.ok(payload.import_requisitions.some((entry) => entry.title === 'Reliability-Calibrated GCD'));
    assert.ok(payload.import_requisitions.some((entry) => entry.identifiers.arxivId === '2401.99999'));
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

    const literatureCalls = [];
    const seededProviderPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'ProviderEvidenceSeededLiterature',
      targetDomain: 'Computer Science',
      targetProblem: 'calibrated discovery under distribution shift',
      roles: ['target_prior'],
      includeProviderEvidence: true,
      includeLiteratureDiscoveryEvidence: true,
      literatureDiscoverySeedProviderPapers: true,
      providerEvidenceLimit: 1,
      providerEvidenceQueryLimit: 1
    }, {
      fetch,
      async runLiteratureDiscovery(params) {
        literatureCalls.push(params);
        return {
          runId: 'lit-provider-seeded',
          topic: params.topic,
          plan: {
            topic: params.topic,
            queries: params.seedPapers.map((seed, index) => ({
              id: `provider-seed-${index + 1}`,
              query: seed.title,
              family: 'client_seed',
              rationale: 'Resolve a provider evidence hit.'
            }))
          },
          queryResults: [],
          candidates: [],
          resolutionSummary: {
            total: 0,
            resolvedFullText: 0,
            metadataOnly: 0,
            downloaded: 0
          },
          coverage: {
            mergedPaperCount: 0,
            resolvedFullTextCount: 0,
            metadataOnlyCount: 0,
            importedCount: 0,
            queryCoverage: []
          },
          artifacts: null
        };
      }
    });
    assert.equal(literatureCalls.length, 1);
    assert.equal(literatureCalls[0].seedPapers.length, 1);
    assert.equal(literatureCalls[0].seedPapers[0].seed_source, 'provider_search');
    assert.ok(literatureCalls[0].seedPapers[0].sourceHints.some((entry) => entry.endsWith('.pdf')));
    assert.equal(seededProviderPlan.literature_discovery_evidence.seed_paper_count, 1);
    assert.equal(seededProviderPlan.literature_discovery_evidence.seed_papers[0].seed_source, 'provider_search');

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

test('agent_materials opt-in live discovery evidence adds source-domain materials', async () => {
  const rootPath = await createMaterialCorpus();
  const fetch = async (input) => {
    const url = new URL(String(input));
    assert.ok(url.pathname.endsWith('/snippet/search'));
    const field = url.searchParams.get('fieldsOfStudy');
    if (field !== 'Psychology') {
      return createJsonResponse({
        data: [{
          score: 0.8,
          paper: {
            paperId: 'cs-target',
            corpusId: 'cs-target',
            title: 'Adaptive Collaboration in Computer Science',
            fieldsOfStudy: ['Computer Science']
          },
          snippet: {
            text: 'Adaptive collaboration systems still struggle with changing goals and feedback.',
            snippetKind: 'abstract',
            section: 'Abstract'
          }
        }]
      });
    }
    if (field === 'Psychology') {
      return createJsonResponse({
        data: [{
          score: 0.9,
          paper: {
            paperId: 'psy-control',
            corpusId: 'psy-control',
            title: 'Goal Regulation Under Changing Feedback',
            fieldsOfStudy: ['Psychology']
          },
          snippet: {
            text: 'Goal regulation research studies how behavior balances persistence and flexibility under changing feedback.',
            snippetKind: 'abstract',
            section: 'Abstract'
          }
        }]
      });
    }
    assert.fail(`Unexpected field ${field}`);
  };
  const llmJson = async ({ task }) => {
    if (task === 'decompose') {
      return {
        research_questions: [{
          id: 'q1',
          domain_specific_question: 'How can computer systems adapt to changing collaboration goals?',
          domain_agnostic_question: 'How can behavior adapt under changing goals and feedback?',
          target_search_queries: ['adaptive collaboration changing goals']
        }]
      };
    }
    if (task === 'target_assessment') {
      return {
        progress: 'partially addressed',
        remaining_challenges: [{
          id: 'challenge:goals',
          domain_specific_challenge: 'Computer systems do not robustly adapt to changing collaboration goals.',
          domain_agnostic_challenge: 'How can behavior adapt under changing goals and feedback?',
          target_evidence_ids: []
        }]
      };
    }
    if (task === 'source_domains') {
      return {
        source_domains: [{
          domain: 'Psychology',
          rationale: 'Psychology studies goal regulation under changing feedback.',
          source_search_queries: ['goal regulation changing feedback']
        }]
      };
    }
    if (task === 'source_relevance') {
      return {
        papers: [{
          paper_key: 'psy-control',
          relevant: true,
          relevance_score: 0.88,
          reason: 'Goal regulation maps to adaptive behavior under changing goals.'
        }]
      };
    }
    if (task === 'source_takeaways') {
      return {
        takeaways: [{
          id: 'takeaway:goal-regulation',
          concept: 'Goal regulation',
          mechanism: 'Balance persistence and flexibility when feedback changes.',
          source_logic: 'Changing feedback can trigger adaptive control.',
          paper_keys: ['psy-control']
        }]
      };
    }
    if (task === 'idea_fragments') {
      return {
        idea_fragments: [{
          id: 'fragment:goal-regulation',
          title: 'Goal-regulation bridge for adaptive collaboration',
          target_challenge_id: 'challenge:goals',
          target_challenge: 'Adapt under changing goals and feedback.',
          source_domain: 'Psychology',
          source_takeaway_ids: ['takeaway:goal-regulation'],
          integration_rationale: 'Use goal-regulation evidence as far-source story material.',
          novelty_score: 0.5,
          usefulness_score: 0.7,
          supporting_paper_keys: ['psy-control']
        }]
      };
    }
    assert.fail(`Unexpected live-discovery LLM task ${task}`);
  };

  try {
    const pack = await executeAgentMaterialsTool({
      operation: 'research_material_pack',
      corpus: rootPath,
      project: 'LiveDiscoverySmoke',
      targetDomain: 'Computer Science',
      targetProblem: 'adaptive collaboration under changing goals',
      roles: ['far_source_story'],
      includeLiveDiscoveryEvidence: true,
      persistLiveDiscoveryEvidence: true,
      liveDiscoveryNumQuestions: 1,
      liveDiscoverySourceDomainLimit: 1,
      liveDiscoveryMaxPapersPerQuery: 1,
      liveDiscoveryIdeaFragmentLimit: 1,
      liveDiscoveryPersistLimit: 2
    }, { fetch, llmJson });

    assert.equal(pack.source_discovery.live_discovery_evidence.enabled, true);
    assert.equal(pack.source_discovery.live_discovery_evidence.status, 'ok');
    assert.equal(pack.source_discovery.live_discovery_evidence.persistence.status, 'persisted');
    assert.ok(pack.source_discovery.live_discovery_evidence.source_domain_analyses.some((entry) => entry.source_domain === 'Psychology'));
    assert.ok(pack.source_discovery.candidate_papers.some((entry) => entry.discovery_source === 'idea_catalyst_live_discovery'));
    const liveItem = pack.groups[0].items.find((entry) => entry.provenance[0].source_type === 'idea_catalyst_live_discovery');
    assert.ok(liveItem);
    assert.equal(liveItem.role, 'far_source_story');
    assert.ok(liveItem.materials.live_discovery.source_spans.length > 0);
    assert.ok(pack.import_requisitions.some((entry) => entry.why_needed.includes('Idea Catalyst live_discovery')));

    const cart = await executeAgentMaterialsTool({
      operation: 'evidence_cart',
      action: 'list',
      corpus: rootPath,
      project: 'LiveDiscoverySmoke'
    });
    assert.ok(cart.items.some((item) => item.source_type === 'idea_catalyst_live_discovery'));

    const literatureCalls = [];
    const seededPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'LiveDiscoverySeededLiterature',
      targetDomain: 'Computer Science',
      targetProblem: 'adaptive collaboration under changing goals',
      roles: ['far_source_story'],
      includeLiveDiscoveryEvidence: true,
      includeLiteratureDiscoveryEvidence: true,
      literatureDiscoverySeedLivePapers: true,
      liveDiscoveryNumQuestions: 1,
      liveDiscoverySourceDomainLimit: 1,
      liveDiscoveryMaxPapersPerQuery: 1,
      liveDiscoveryIdeaFragmentLimit: 1
    }, {
      fetch,
      llmJson,
      async runLiteratureDiscovery(params) {
        literatureCalls.push(params);
        return {
          runId: 'lit-live-seeded',
          topic: params.topic,
          plan: {
            topic: params.topic,
            queries: params.seedPapers.map((seed, index) => ({
              id: `seed-${index + 1}`,
              query: seed.title,
              family: 'client_seed',
              rationale: 'Resolve a live-discovery supporting paper.'
            }))
          },
          queryResults: [],
          candidates: [],
          resolutionSummary: {
            total: 0,
            resolvedFullText: 0,
            metadataOnly: 0,
            downloaded: 0
          },
          coverage: {
            mergedPaperCount: 0,
            resolvedFullTextCount: 0,
            metadataOnlyCount: 0,
            importedCount: 0,
            queryCoverage: []
          },
          artifacts: null
        };
      }
    });
    assert.equal(literatureCalls.length, 1);
    assert.equal(literatureCalls[0].seedPapers.length, 1);
    assert.equal(literatureCalls[0].seedPapers[0].title, 'Goal Regulation Under Changing Feedback');
    assert.equal(literatureCalls[0].seedPapers[0].seed_source, 'idea_catalyst_live_discovery');
    assert.equal(seededPlan.literature_discovery_evidence.seed_paper_count, 1);
    assert.equal(seededPlan.literature_discovery_evidence.seed_papers[0].seed_source, 'idea_catalyst_live_discovery');

    const sparseFallbackPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'LiveDiscoverySparseFallback',
      targetDomain: 'Unindexed Systems Domain',
      targetProblem: 'zzzxq nooverlap sparse live discovery gap',
      roles: ['unmapped_sparse_role'],
      runLiveIdeaCatalystIfNeeded: true,
      liveDiscoverySparseMinScore: 100,
      liveDiscoveryNumQuestions: 1,
      liveDiscoverySourceDomainLimit: 1,
      liveDiscoveryMaxPapersPerQuery: 1,
      liveDiscoveryIdeaFragmentLimit: 1
    }, { fetch, llmJson });
    assert.equal(sparseFallbackPlan.live_discovery_evidence.status, 'ok');
    assert.equal(sparseFallbackPlan.live_discovery_evidence.trigger_mode, 'graph_sparse_fallback');
    assert.equal(sparseFallbackPlan.live_discovery_evidence.trigger.graph_sparse, true);
    assert.ok(sparseFallbackPlan.live_discovery_evidence.trigger.sparse_roles.includes('unmapped_sparse_role'));

    let skippedFallbackCalled = false;
    const skippedFallbackPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      project: 'LiveDiscoverySkipFallback',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known novel prior shift calibration',
      roles: ['target_prior'],
      runLiveIdeaCatalystIfNeeded: true,
      liveDiscoveryNumQuestions: 1,
      liveDiscoverySourceDomainLimit: 1
    }, {
      async llmJson() {
        skippedFallbackCalled = true;
        return {};
      }
    });
    assert.equal(skippedFallbackPlan.live_discovery_evidence.status, 'skipped_not_sparse');
    assert.equal(skippedFallbackPlan.live_discovery_evidence.trigger.graph_sparse, false);
    assert.equal(skippedFallbackCalled, false);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials opt-in literature discovery resolves import-ready candidates before explicit submit', async () => {
  const rootPath = await createMaterialCorpus();
  const discoveryCalls = [];
  const submitCalls = [];
  const resolvedPath = path.join(rootPath, 'resolved-literature.md');
  const runLiteratureDiscovery = async (params) => {
    discoveryCalls.push(params);
    return {
      runId: 'lit-run-1',
      topic: params.topic,
      plan: {
        topic: params.topic,
        queries: [{
          id: 'q1',
          query: 'resolved source candidate',
          family: 'seed_text',
          rationale: 'fixture query'
        }]
      },
      queryResults: [],
      candidates: [{
        id: 'candidate:resolved',
        canonicalId: 'doi:10.5555/resolved',
        title: 'Resolved Literature Candidate',
        authors: ['A. Researcher'],
        year: 2026,
        abstract: 'A resolved candidate returned by literature discovery.',
        identifiers: {
          doi: '10.5555/resolved'
        },
        providers: ['fixture-provider'],
        providerAgreementCount: 1,
        identityConfidence: 'strong',
        source: {
          resolutionStatus: 'fulltext_ready',
          sourceKind: 'markdown',
          sourcePath: resolvedPath,
          sourceProvider: 'fixture-provider',
          fullTextStatus: 'open_markdown',
          markdownUrl: 'https://example.test/resolved.md',
          pdfUrl: ''
        }
      }],
      resolutionSummary: {
        total: 1,
        resolvedFullText: 1,
        metadataOnly: 0,
        downloaded: 1
      },
      coverage: {
        mergedPaperCount: 1,
        resolvedFullTextCount: 1,
        metadataOnlyCount: 0,
        importedCount: 0,
        queryCoverage: []
      },
      artifacts: null
    };
  };
  const submitDiscoveryImports = async (params) => {
    submitCalls.push(params);
    return {
      submitted: 1,
      deduped: 0,
      failed: 0,
      results: [{
        canonicalId: 'doi:10.5555/resolved',
        sourcePath: resolvedPath,
        status: 'submitted',
        taskId: 'task-resolved'
      }]
    };
  };

  try {
    const defaultPlan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      targetDomain: 'Computer Science',
      targetProblem: 'resolved source candidate',
      roles: ['target_prior']
    }, { runLiteratureDiscovery });
    assert.equal(defaultPlan.literature_discovery_evidence.status, 'disabled');
    assert.equal(discoveryCalls.length, 0);

    const plan = await executeAgentMaterialsTool({
      operation: 'source_discovery_plan',
      corpus: rootPath,
      targetDomain: 'Computer Science',
      targetProblem: 'resolved source candidate',
      roles: ['target_prior'],
      includeLiteratureDiscoveryEvidence: true,
      literatureDiscoveryMaxQueries: 2,
      literatureDiscoveryMaxCandidates: 3,
      literatureDiscoveryMaxDownloads: 1
    }, { runLiteratureDiscovery, submitDiscoveryImports });
    assert.equal(discoveryCalls.length, 1);
    assert.equal(discoveryCalls[0].persist, false);
    assert.equal(discoveryCalls[0].resolveSources, true);
    assert.equal(discoveryCalls[0].maxDownloads, 1);
    assert.equal(plan.literature_discovery_evidence.status, 'ok');
    assert.equal(plan.literature_discovery_evidence.queue_read_only, true);
    assert.equal(plan.literature_discovery_evidence.importable_count, 1);
    assert.equal(plan.literature_discovery_evidence.import_summary, null);
    assert.equal(submitCalls.length, 0);
    assert.ok(plan.candidate_papers.some((entry) => entry.discovery_source === 'literature_discovery'));
    assert.ok(plan.import_requisitions.some((entry) => entry.why_needed.includes('Literature discovery resolved')));

    const requisitions = await executeAgentMaterialsTool({
      operation: 'import_requisition_pack',
      corpus: rootPath,
      targetDomain: 'Computer Science',
      targetProblem: 'resolved source candidate',
      includeLiteratureDiscoveryEvidence: true,
      submitLiteratureDiscoveryImports: true,
      literatureDiscoveryMaxImported: 1
    }, { runLiteratureDiscovery, submitDiscoveryImports });
    assert.equal(submitCalls.length, 1);
    assert.equal(submitCalls[0].maxImported, 1);
    assert.equal(requisitions.literature_discovery_evidence.queue_read_only, false);
    assert.equal(requisitions.literature_discovery_evidence.import_summary.submitted, 1);
    assert.equal(requisitions.literature_discovery_evidence.candidates[0].import.taskId, 'task-resolved');
    assert.ok(requisitions.import_requisitions.some((entry) => entry.why_needed.includes('import status submitted')));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials maps literature import status without canonical ids', async () => {
  const rootPath = await createMaterialCorpus();
  const resolvedPath = path.join(rootPath, 'resolved-no-canonical.md');
  const runLiteratureDiscovery = async (params) => ({
    runId: 'lit-run-no-canonical',
    topic: params.topic,
    plan: {
      topic: params.topic,
      queries: []
    },
    candidates: [{
      candidate_id: '10.5555/collision-key',
      title: 'Candidate Title Collision Without Canonical Id',
      abstract: 'This candidate has a source path but no canonical id.',
      identifiers: {},
      providers: ['fixture-provider'],
      source: {
        resolution_status: 'fulltext_ready',
        source_kind: 'markdown',
        source_path: resolvedPath,
        source_provider: 'fixture-provider',
        full_text_status: 'open_markdown'
      }
    }, {
      id: 'candidate:no-canonical-metadata',
      title: 'Candidate Title Collision Without Canonical Id',
      abstract: 'This candidate should not inherit the import task from the first candidate.',
      identifiers: {
        doi: '10.5555/collision-key'
      },
      providers: ['fixture-provider'],
      source: {
        resolutionStatus: 'metadata_only',
        sourceKind: 'metadata_only',
        fullTextStatus: 'unknown'
      }
    }]
  });
  const submitDiscoveryImports = async (params) => ({
    submitted: 1,
    deduped: 0,
    failed: 0,
    results: params.candidates
      .filter((candidate) => candidate.source?.sourcePath || candidate.source?.source_path)
      .map((candidate) => ({
        candidateId: candidate.id || candidate.candidate_id,
        canonicalId: candidate.canonicalId,
        sourcePath: candidate.source.sourcePath || candidate.source.source_path,
        title: candidate.title,
        status: 'submitted',
        taskId: 'task-no-canonical'
      }))
  });

  try {
    const requisitions = await executeAgentMaterialsTool({
      operation: 'import_requisition_pack',
      corpus: rootPath,
      targetDomain: 'Computer Science',
      targetProblem: 'candidate without canonical id',
      includeLiteratureDiscoveryEvidence: true,
      submitLiteratureDiscoveryImports: true
    }, { runLiteratureDiscovery, submitDiscoveryImports });

    const candidates = requisitions.literature_discovery_evidence.candidates;
    assert.equal(
      candidates.find((entry) => entry.candidate_id === '10.5555/collision-key').import.taskId,
      'task-no-canonical'
    );
    assert.equal(
      candidates.find((entry) => entry.candidate_id === 'candidate:no-canonical-metadata').import.status,
      'not_submitted'
    );
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
    assert.equal(cost.extraction_policy.llm_enabled, false);
    assert.equal(cost.llm_extraction.status, 'disabled');
    assert.equal(cost.signals.hardware.status, 'reported');
    assert.ok(cost.signals.hardware.snippets.some((snippet) => snippet.match.includes('A100')));
    assert.ok(cost.signals.hardware.snippets.some((snippet) => snippet.provenance.source_type === 'figure_caption'));
    assert.equal(cost.signals.batch_size.status, 'reported');
    assert.equal(cost.signals.runtime.status, 'reported');
    assert.ok(cost.signals.runtime.snippets.some((snippet) => snippet.provenance.source_type === 'markdown_table'));

    const costWithLlm = await executeAgentMaterialsTool({
      operation: 'experiment_cost_materials',
      corpus: rootPath,
      paperId: 'paper:gcd-calibration',
      includeCostLlmExtraction: true,
      costLlmRecordLimit: 4,
      costLlmMaxInputChars: 3000
    }, {
      async llmJson({ records }) {
        const record = records.find((entry) => entry.text.includes('A100')) || records[0];
        return {
          summary: 'Training cost is explicitly reported.',
          fields: {
            hardware: {
              status: 'reported',
              value: 'single A100 GPU',
              confidence: 0.91,
              evidence_text: 'single A100 GPU',
              source_record_id: record.source_record_id
            },
            runtime: {
              status: 'reported',
              value: '6 hours',
              confidence: 0.89,
              evidence_text: '6 hours',
              source_record_id: record.source_record_id
            },
            epochs: { status: 'reported', value: '100 epochs', confidence: 0.87, evidence_text: '100 epochs', source_record_id: record.source_record_id },
            batch_size: { status: 'reported', value: '256', confidence: 0.85, evidence_text: 'batch size 256', source_record_id: record.source_record_id },
            dataset_scale: { status: 'not_reported', value: null, confidence: 0, evidence_text: null, source_record_id: null },
            backbone: { status: 'not_reported', value: null, confidence: 0, evidence_text: null, source_record_id: null },
            code_availability: { status: 'reported', value: 'GitHub repository', confidence: 0.82, evidence_text: 'code is available', source_record_id: record.source_record_id }
          }
        };
      }
    });

    assert.equal(costWithLlm.extraction_policy.llm_enabled, true);
    assert.equal(costWithLlm.extraction_policy.llm_status, 'ok');
    assert.equal(costWithLlm.llm_extraction.provider, 'custom-llm-json');
    assert.equal(costWithLlm.llm_extraction.fields.hardware.value, 'single A100 GPU');
    assert.equal(costWithLlm.llm_extraction.fields.dataset_scale.status, 'not_reported');
    assert.equal(costWithLlm.llm_extraction.fields.hardware.provenance.paper_id, 'paper:gcd-calibration');
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
