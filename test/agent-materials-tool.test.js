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

test('agent_materials research_controller initializes status and export artifacts', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const emptyStatus = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'status',
      corpus: rootPath,
      project: 'GCD Research Controller'
    });

    assert.equal(emptyStatus.operation, 'research_controller');
    assert.equal(emptyStatus.status, 'needs_input');
    assert.equal(emptyStatus.controller_state_summary.empty, true);
    assert.ok(emptyStatus.user_decision_needed.includes('Initialize the research controller with init_task or run_round.'));

    const init = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'init_task',
      corpus: rootPath,
      project: 'GCD Research Controller',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known-class bias, class-count estimation, confidence calibration, and pseudo-label generation',
      mode: 'planning',
      subproblemHints: ['known-class bias', 'class number estimation', 'confidence calibration', 'pseudo-label generation']
    });

    assert.equal(init.status, 'ok');
    assert.equal(init.controller_state_summary.lifecycle, 'initialized');
    assert.equal(init.controller_state_summary.mode, 'planning');
    assert.equal(init.controller_state_summary.task_family, 'gcd');
    assert.equal(init.controller_state_summary.budget_profile, 'gcd_mvp_planning');
    assert.equal(init.controller_state_summary.candidate_node_count, 0);
    assert.ok(init.artifact_paths.controller_state.endsWith('controller-state.json'));

    const controllerState = JSON.parse(await fs.readFile(init.artifact_paths.controller_state, 'utf8'));
    assert.equal(controllerState.target_domain, 'Generalized Category Discovery');
    assert.equal(controllerState.budget.profile, 'gcd_mvp_planning');
    assert.equal(controllerState.budget.max_candidate_nodes, 72);
    assert.equal(controllerState.budget.max_edge_judgments, 96);
    assert.equal(controllerState.budget.max_agent_calls, 18);
    assert.equal(controllerState.budget.max_selected_candidates, 3);
    assert.equal(controllerState.budget.max_solution_sketches, 3);
    assert.equal(controllerState.budget.max_experiment_plans, 2);
    assert.equal(controllerState.budget.max_provider_queries, 0);
    assert.equal(controllerState.budget.max_imports, 0);
    assert.equal(controllerState.provider_policy.submit_imports, false);
    assert.ok(controllerState.next_actions.includes('generate_candidates'));

    const taskSpecs = JSON.parse(await fs.readFile(init.artifact_paths.task_spec_variants, 'utf8'));
    assert.equal(taskSpecs.variants.length, 3);
    assert.ok(taskSpecs.variants.some((variant) => variant.status === 'selected'));

    const subproblemGraph = JSON.parse(await fs.readFile(init.artifact_paths.subproblem_graph, 'utf8'));
    assert.equal(subproblemGraph.subproblems.length, 4);
    assert.ok(subproblemGraph.subproblems.some((entry) => entry.name === 'confidence calibration'));

    const generatedDecomposition = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'generate_decomposition',
      corpus: rootPath,
      project: 'GCD Research Controller',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'known-class bias, class-count estimation, confidence calibration, and pseudo-label generation'
    }, {
      async llmJson({ task }) {
        assert.equal(task, 'research_controller.generate_decomposition');
        return {
          task_spec_variants: {
            selected_task_spec_id: 'task-spec:agent-primary-gcd',
            variants: [
              {
                task_spec_id: 'task-spec:agent-primary-gcd',
                variant_key: 'agent_primary',
                target_domain: 'Generalized Category Discovery',
                target_problem: 'known-class bias and calibrated pseudo-label generation',
                task_goal: 'Improve novel-class discovery without leaking unknown labels.',
                evaluation_metrics: ['known accuracy', 'novel accuracy', 'NMI'],
                design_boundaries: ['Do not use unknown-class labels during method design or validation.'],
                uncertainty_notes: ['Class-count assumptions need evidence.'],
                status: 'selected'
              },
              {
                variant_key: 'agent_protocol_stress',
                task_goal: 'Stress-test fair protocol boundaries for calibrated GCD.',
                evaluation_metrics: ['protocol compliance'],
                uncertainty_notes: ['Benchmark protocol may dominate apparent gains.'],
                status: 'proposed'
              }
            ]
          },
          subproblem_graph: {
            decomposition_version: 'decomp:agent-gcd-v1',
            task_spec_id: 'task-spec:agent-primary-gcd',
            subproblems: [
              {
                name: 'known-class bias',
                abstract_challenge: 'Known classifiers can absorb novel unlabeled structure.',
                failure_modes: ['novel samples collapse into known classes'],
                metrics: ['known accuracy', 'novel accuracy'],
                query_plan: ['known class bias generalized category discovery']
              },
              {
                name: 'confidence calibration',
                abstract_challenge: 'Pseudo labels need uncertainty-aware acceptance.',
                failure_modes: ['overconfident wrong pseudo labels'],
                metrics: ['calibration error', 'pseudo-label precision'],
                query_plan: ['confidence calibration pseudo labels generalized category discovery']
              },
              {
                name: 'class number estimation',
                abstract_challenge: 'Novel class counts should remain bounded and testable.',
                failure_modes: ['over-estimated novel class count'],
                metrics: ['class count error', 'NMI'],
                query_plan: ['generalized category discovery class number estimation']
              }
            ],
            dependencies: [
              {
                source: 'known-class bias',
                target: 'confidence calibration',
                relation_type: 'CONTEXT_FOR',
                confidence: 0.71
              }
            ],
            uncertainty_notes: ['External Agent generated this decomposition for controller review.']
          }
        };
      }
    });
    assert.equal(generatedDecomposition.status, 'ok');
    assert.equal(generatedDecomposition.controller_state_summary.lifecycle, 'decomposition_generated');
    assert.equal(generatedDecomposition.decomposition_run.backend, 'single_model_llm_json');
    assert.equal(generatedDecomposition.task_spec_variants.selected_task_spec_id, 'task-spec:agent-primary-gcd');
    assert.equal(generatedDecomposition.subproblem_graph.decomposition_version, 'decomp:agent-gcd-v1');

    const generatedTaskSpecs = JSON.parse(await fs.readFile(generatedDecomposition.artifact_paths.task_spec_variants, 'utf8'));
    assert.equal(generatedTaskSpecs.variants.length, 2);
    assert.ok(generatedTaskSpecs.variants.some((variant) => variant.variant_key === 'agent_primary'));

    const generatedSubproblemGraph = JSON.parse(await fs.readFile(generatedDecomposition.artifact_paths.subproblem_graph, 'utf8'));
    assert.equal(generatedSubproblemGraph.subproblems.length, 3);
    assert.ok(generatedSubproblemGraph.dependencies.some((edge) => edge.relation_type === 'CONTEXT_FOR'));

    const reviewedDecomposition = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'review_decomposition',
      corpus: rootPath,
      project: 'GCD Research Controller',
      externalInputs: {
        decomposition_review_payload: {
          recommendation: 'accept',
          confidence: 0.82,
          missing_subproblem_risk: 'medium',
          over_decomposition_risk: 'low',
          dependency_error_risk: 'low',
          metric_mismatch_risk: 'medium',
          alternative_decompositions: ['Split class-count estimation from calibration if evidence volume is high.'],
          critic_questions: ['Does calibration improve novel accuracy without hurting known accuracy?']
        }
      }
    });
    assert.equal(reviewedDecomposition.status, 'ok');
    assert.equal(reviewedDecomposition.controller_state_summary.lifecycle, 'decomposition_reviewed');
    assert.equal(reviewedDecomposition.decomposition_review_run.backend, 'external_agent_inputs');
    assert.equal(reviewedDecomposition.decomposition_review.recommendation, 'accept');

    const generated = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'generate_candidates',
      corpus: rootPath,
      project: 'GCD Research Controller',
      maxCandidateNodes: 8
    });
    assert.equal(generated.status, 'ok');
    assert.equal(generated.controller_state_summary.lifecycle, 'candidates_generated');
    assert.ok(generated.controller_state_summary.candidate_node_count > 0);

    const candidateGraphText = await fs.readFile(generated.artifact_paths.candidate_graph, 'utf8');
    const candidateRecords = candidateGraphText.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(candidateRecords.some((record) => record.record_type === 'candidate_node'));
    assert.ok(candidateRecords[0].evidence.graph_refs.length > 0);
    assert.equal(candidateRecords[0].status, 'proposed');
    const generatedCandidateNodes = candidateRecords.filter((record) => record.record_type === 'candidate_node');
    assert.ok(generatedCandidateNodes.length >= 2);
    const producerCandidateId = generatedCandidateNodes[0].candidate_id;
    const consumerCandidateId = generatedCandidateNodes[1].candidate_id;
    const farSourceCandidateId = producerCandidateId;
    const enrichedCandidateRecords = candidateRecords.map((record) => {
      if (record.candidate_id === producerCandidateId) {
        return {
          ...record,
          source_domain: 'Distant Control Theory',
          source_layer: 'far_source',
          method_card: {
            ...(record.method_card || {}),
            output_signal: 'calibrated confidence score',
            training_objective: 'shared A100 backbone budget',
            assumptions: [
              ...(record.method_card?.assumptions || []),
              'requires known class count'
            ]
          },
          evaluation_plan: {
            ...(record.evaluation_plan || {}),
            baseline: 'matched backbone and A100 budget'
          },
          scores: {
            ...(record.scores || {}),
            graph_evidence_strength: 0.95,
            mechanism_fit: 0.22
          }
        };
      }
      if (record.candidate_id === consumerCandidateId) {
        return {
          ...record,
          method_card: {
            ...(record.method_card || {}),
            input_signal: 'calibrated confidence score',
            training_objective: 'shared A100 backbone budget',
            assumptions: [
              ...(record.method_card?.assumptions || []),
              'unknown class count estimation'
            ]
          },
          evaluation_plan: {
            ...(record.evaluation_plan || {}),
            baseline: 'matched backbone and A100 budget'
          }
        };
      }
      return record;
    });
    await fs.writeFile(
      generated.artifact_paths.candidate_graph,
      `${enrichedCandidateRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8'
    );

    const edgeProposal = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'propose_edges',
      corpus: rootPath,
      project: 'GCD Research Controller',
      maxEdgeJudgments: 12
    });
    assert.equal(edgeProposal.status, 'ok');
    assert.equal(edgeProposal.controller_state_summary.lifecycle, 'candidate_edges_proposed');
    assert.ok(edgeProposal.controller_state_summary.candidate_edge_count > 0);

    const candidateGraphWithEdgesText = await fs.readFile(edgeProposal.artifact_paths.candidate_graph, 'utf8');
    const candidateRecordsWithEdges = candidateGraphWithEdgesText.trim().split('\n').map((line) => JSON.parse(line));
    const candidateEdges = candidateRecordsWithEdges.filter((record) => record.record_type === 'candidate_edge');
    assert.ok(candidateEdges.length > 0);
    assert.ok(candidateEdges.some((record) => record.relation_types.includes('COMPLEMENTS')));
    assert.ok(candidateEdges.some((record) => record.relation_types.includes('SHARES_MECHANISM')));
    assert.ok(candidateEdges.some((record) => record.relation_types.includes('PREREQUISITE')));
    assert.ok(candidateEdges.some((record) => record.relation_types.includes('CONFLICTS_WITH')));
    assert.ok(candidateEdges.some((record) => record.relation_types.includes('COST_COUPLED')));
    assert.ok(candidateEdges.some((record) => record.evidence.prerequisite_signals?.includes('confidence')));
    assert.ok(candidateEdges.some((record) => record.evidence.conflict_phrases?.length));
    assert.ok(candidateEdges.some((record) => record.evidence.shared_cost_terms?.includes('a100')));
    assert.ok(candidateEdges.every((record) => record.status === 'proposed'));

    const judged = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'judge_batch',
      corpus: rootPath,
      project: 'GCD Research Controller',
      judge: { model: 'fixture-judge' },
      maxJudgeItems: 6,
      judgeConsistencyChecks: 3
    }, {
      async llmJson({ task, candidates, edges, candidatePairs, consistencyProbe }) {
        assert.ok(['research_controller.judge_batch', 'research_controller.judge_batch_consistency_probe'].includes(task));
        if (task === 'research_controller.judge_batch_consistency_probe') {
          assert.equal(consistencyProbe.probe_type, 'order_swap');
        }
        return {
          summary: task === 'research_controller.judge_batch_consistency_probe'
            ? 'Fixture consistency probe keeps the same judgments under reversed order.'
            : 'Fixture judge accepts graph-backed candidates and relations for later selection.',
          node_judgments: candidates.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            verdict: 'needs_evidence',
            scores: {
              evidence_support: 0.72,
              mechanism_fit: candidate.candidate_id === farSourceCandidateId ? 0.31 : 0.68,
              feasibility: 0.51,
              novelty_potential: 0.46,
              risk: 0.42,
              evaluation_readiness: 0.38
            },
            rationale: 'Useful graph-backed candidate, but method-card details and baseline plan need extraction.',
            missing_evidence: ['method-card details', 'baseline plan']
          })),
          edge_judgments: edges.map((edge) => ({
            edge_id: edge.edge_id,
            verdict: 'keep',
            valid_relation_types: edge.relation_types,
            confidence: 0.66,
            rationale: 'Relation is useful as bounded graph-search evidence.'
          })),
          pairwise_preferences: candidatePairs.map((pair) => ({
            pair_id: pair.pair_id,
            candidate_a_id: pair.candidate_a_id,
            candidate_b_id: pair.candidate_b_id,
            winner: task === 'research_controller.judge_batch_consistency_probe' ? 'B' : 'A',
            confidence: 0.7,
            decision_basis: {
              evidence: 'Candidate A has stronger graph-backed evidence in the fixture order.',
              feasibility: 'Both candidates remain feasible after method-card expansion.',
              novelty: 'Candidate A keeps slightly more novelty potential.',
              expected_gain: 'Expected gain is still speculative.',
              risk: 'No pair-specific blocker was found.'
            },
            missing_evidence: ['pairwise preference calibration']
          }))
        };
      }
    });
    assert.equal(judged.status, 'ok');
    assert.equal(judged.controller_state_summary.lifecycle, 'judged');
    assert.ok(judged.controller_state_summary.judge_decision_count > 0);
    assert.equal(judged.judge_run.backend, 'single_model_llm_json');
    assert.equal(judged.judge_run.model, 'fixture-judge');
    assert.equal(judged.judge_run.self_consistency.status, 'consistent');
    assert.equal(judged.judge_run.self_consistency.probe_type, 'order_swap');
    assert.ok(judged.judge_run.self_consistency.checked_count > 0);
    assert.ok(judged.judge_run.self_consistency.pairwise_checked_count > 0);
    assert.ok(judged.consistency_probe_decisions.length > 0);
    assert.ok(judged.judge_request.judge_method.output_schema.node_judgments.length > 0);
    assert.ok(judged.judge_request.candidate_pairs.length > 0);

    const judgeDecisionText = await fs.readFile(judged.artifact_paths.judge_decisions, 'utf8');
    const judgeDecisionRecords = judgeDecisionText.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(judgeDecisionRecords.some((record) => record.decision_scope === 'candidate_node'));
    assert.ok(judgeDecisionRecords.some((record) => record.decision_scope === 'candidate_edge'));
    assert.ok(judgeDecisionRecords.some((record) => record.decision_scope === 'candidate_pairwise_preference'));
    assert.ok(judgeDecisionRecords.some((record) => record.decision_scope === 'consistency_probe_candidate_node'));
    assert.ok(judgeDecisionRecords.some((record) => record.decision_scope === 'consistency_probe_candidate_pairwise_preference'));
    assert.ok(judgeDecisionRecords.every((record) => record.judge.mode === 'single_model'));

    const selected = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'select_batch',
      corpus: rootPath,
      project: 'GCD Research Controller',
      maxSelectedCandidates: 2
    });
    assert.equal(selected.status, 'ok');
    assert.equal(selected.controller_state_summary.lifecycle, 'batch_selected');
    assert.equal(selected.selection.subgraphs.length, 2);
    assert.ok(selected.selection.diagnostics.selected_subproblem_count >= 1);
    assert.ok(selected.selection.diagnostics.pairwise_preference_count > 0);
    assert.ok(selected.selection.diagnostics.pairwise_candidate_count > 0);
    assert.ok(selected.selection.diagnostics.far_source_gated_count > 0);
    assert.ok(selected.selection.diagnostics.selected_mechanism_count >= 1);
    assert.ok(selected.selection.diagnostics.selected_source_domain_count >= 1);
    assert.ok(selected.selection.diagnostics.batch_objective_score > 0);
    assert.ok(selected.selection.selection_policy.utility_terms.includes('agent_preference'));
    assert.equal(selected.selection.selection_policy.preference_aggregation.backend, 'bradley_terry_mm');
    assert.equal(selected.selection.selection_policy.batch_objective.backend, 'greedy_submodular_marginal_gain');
    assert.ok(selected.selection.selection_policy.batch_objective.coverage_terms.includes('mechanism'));
    assert.ok(selected.selection.selection_policy.batch_objective.negative_relation_terms.includes('CONFLICTS_WITH'));
    assert.ok(selected.selection.selection_policy.hard_gates.includes('far_source_requires_mechanism_fit_or_bridge_evidence'));
    assert.ok(selected.selection.subgraphs.every((subgraph) => subgraph.primary_candidate_id));
    assert.ok(selected.selection.subgraphs.every((subgraph) => typeof subgraph.marginal_gain === 'number'));
    assert.ok(selected.selection.subgraphs.every((subgraph) => subgraph.selection_reasons.length > 0));
    assert.ok([
      ...selected.selection.subgraphs,
      ...selected.selection.parked
    ].some((entry) => entry.pairwise_preference?.aggregation === 'bradley_terry_mm'));
    assert.ok(selected.selection.parked.length > 0);
    assert.ok(!selected.selection.subgraphs.some((subgraph) => subgraph.candidate_ids.includes(farSourceCandidateId)));
    assert.ok(selected.selection.parked.some((entry) => (
      entry.candidate_id === farSourceCandidateId
      && entry.reason === 'far_source_requires_mechanism_fit_or_bridge_evidence'
    )));

    const selectedSubgraphs = JSON.parse(await fs.readFile(selected.artifact_paths.selected_subgraphs, 'utf8'));
    assert.equal(selectedSubgraphs.record_type, 'selected_subgraphs');
    assert.equal(selectedSubgraphs.subgraphs.length, 2);
    const candidateGraphAfterSelectionText = await fs.readFile(selected.artifact_paths.candidate_graph, 'utf8');
    const candidateRecordsAfterSelection = candidateGraphAfterSelectionText.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(candidateRecordsAfterSelection.some((record) => record.record_type === 'candidate_node' && record.status === 'selected'));
    assert.ok(candidateRecordsAfterSelection.some((record) => (
      record.record_type === 'candidate_node'
      && record.candidate_id === farSourceCandidateId
      && record.status === 'needs_evidence'
    )));

    const expanded = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'expand_evidence',
      corpus: rootPath,
      project: 'GCD Research Controller'
    });
    assert.equal(expanded.status, 'ok');
    assert.equal(expanded.controller_state_summary.lifecycle, 'evidence_expanded');
    assert.equal(expanded.method_card_pack.method_cards.length, 2);
    assert.equal(expanded.method_card_pack.expansion_policy.provider_evidence_enabled, false);
    assert.equal(expanded.method_card_pack.expansion_policy.material_pack_requests_enabled, true);
    assert.equal(expanded.method_card_pack.material_expansion_requests.length, 6);
    assert.deepEqual(
      [...new Set(expanded.method_card_pack.material_expansion_requests.map((request) => request.operation))].sort(),
      ['import_requisition_pack', 'negative_evidence_pack', 'research_material_pack']
    );
    assert.ok(expanded.method_card_pack.material_expansion_requests.every((request) => request.execution_status === 'not_run'));
    assert.ok(expanded.method_card_pack.material_expansion_requests.every((request) => request.arguments.includeProviderEvidence === false));
    assert.ok(expanded.method_card_pack.material_expansion_requests.some((request) => (
      request.operation === 'import_requisition_pack'
      && request.approval_required === true
      && request.status === 'approval_required'
    )));
    assert.ok(expanded.method_card_pack.material_expansion_requests.some((request) => (
      request.operation === 'research_material_pack'
      && request.approval_required === false
      && request.status === 'planned'
    )));
    assert.ok(expanded.method_card_pack.method_cards.every((card) => card.candidate_id));
    assert.ok(expanded.method_card_pack.method_cards.every((card) => card.baseline_comparability));
    assert.ok(expanded.method_card_pack.method_cards.some((card) => (
      card.method_card.paper_material_extraction?.backend === 'local_source_span_heuristic'
      && card.method_card.paper_material_extraction.extracted_fields.includes('inference_behavior')
    )));
    assert.ok(expanded.method_card_pack.method_cards.some((card) => (
      card.method_card.output_signal
      && card.method_card.training_objective
      && card.method_card.inference_behavior
    )));
    assert.ok(expanded.method_card_pack.method_cards.some((card) => (
      card.method_card.cost_terms?.includes('a100')
      || card.method_card.cost_terms?.includes('batch')
      || card.method_card.cost_terms?.includes('epochs')
    )));
    assert.ok(expanded.method_card_pack.missing_evidence.includes('baseline plan'));
    const methodCardPackMarkdown = await fs.readFile(expanded.artifact_paths.method_card_pack, 'utf8');
    assert.match(methodCardPackMarkdown, /Selected Method Cards/);
    assert.match(methodCardPackMarkdown, /Missing evidence/);
    assert.match(methodCardPackMarkdown, /Local material extraction/);
    assert.match(methodCardPackMarkdown, /Planned Material Expansion Requests/);

    const materialRequests = expanded.method_card_pack.material_expansion_requests;
    const executableRequests = materialRequests
      .filter((request) => request.operation !== 'import_requisition_pack')
      .slice(0, 2);
    const executedMaterials = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'execute_material_requests',
      corpus: rootPath,
      project: 'GCD Research Controller',
      approveMaterialRequestExecution: true,
      approvedMaterialRequestIds: executableRequests.map((request) => request.request_id),
      maxMaterialRequests: 2,
      materialRequestExecutionApproval: {
        approver: 'fixture-human',
        source: 'unit-test'
      }
    });
    assert.equal(executedMaterials.status, 'ok');
    assert.equal(executedMaterials.controller_state_summary.lifecycle, 'material_requests_executed');
    assert.equal(executedMaterials.material_result_count, 2);
    assert.equal(executedMaterials.material_results.length, 2);
    assert.ok(executedMaterials.material_results.every((record) => record.source === 'research_controller.execute_material_requests'));
    assert.ok(executedMaterials.method_card_pack.material_expansion_requests.some((request) => (
      request.execution_status === 'executed'
      && request.status === 'result_recorded'
      && request.result_id
    )));
    const executedMaterialResultText = await fs.readFile(executedMaterials.artifact_paths.material_expansion_results, 'utf8');
    assert.equal(executedMaterialResultText.trim().split('\n').length, 2);

    const remainingMaterialRequests = executedMaterials.method_card_pack.material_expansion_requests
      .filter((request) => !request.result_id)
      .slice(0, 2);
    const recorded = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'record_material_results',
      corpus: rootPath,
      project: 'GCD Research Controller',
      externalInputs: {
        material_expansion_results: remainingMaterialRequests.map((request) => ({
          request_id: request.request_id,
          operation: request.operation,
          candidate_id: request.candidate_id,
          status: 'ok',
          source: 'fixture-external-agent',
          summary: {
            evidence_items: 2,
            finding: 'Fixture material result recorded for selected candidate; one metric mismatch may require decomposition review.',
            unresolved: ['full paper-material extraction still needed']
          },
          artifact_paths: {
            source: `/tmp/${request.request_id}.json`
          },
          missing_evidence_resolved: ['paper material span'],
          remaining_missing_evidence: ['baseline plan']
        }))
      }
    });
    assert.equal(recorded.status, 'ok');
    assert.equal(recorded.controller_state_summary.lifecycle, 'material_results_recorded');
    assert.equal(recorded.controller_state_summary.material_expansion_result_count, 4);
    assert.equal(recorded.controller_state_summary.decomposition_drift_status, 'possible');
    assert.equal(recorded.decomposition_drift_review.status, 'possible');
    assert.equal(recorded.decomposition_drift_review.requires_revisit, true);
    assert.equal(recorded.material_result_count, 4);
    assert.equal(recorded.method_card_pack.material_result_count, 4);
    assert.equal(recorded.method_card_pack.fulfilled_material_expansion_request_count, 4);
    assert.ok(recorded.method_card_pack.material_expansion_requests.some((request) => (
      request.status === 'result_recorded'
      && request.execution_status === 'recorded'
      && request.result_id
    )));
    const materialResultText = await fs.readFile(recorded.artifact_paths.material_expansion_results, 'utf8');
    const materialResultRecords = materialResultText.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(materialResultRecords.length, 4);
    assert.ok(materialResultRecords.every((record) => record.record_type === 'material_expansion_result'));
    const driftReview = JSON.parse(await fs.readFile(recorded.artifact_paths.decomposition_review, 'utf8')).post_evidence_drift_review;
    assert.equal(driftReview.status, 'possible');
    assert.ok(driftReview.critic_questions.some((question) => question.includes('selected candidates')));
    const recordedMethodCardMarkdown = await fs.readFile(recorded.artifact_paths.method_card_pack, 'utf8');
    assert.match(recordedMethodCardMarkdown, /Material expansion results: 4/);

    const composed = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'compose_solutions',
      corpus: rootPath,
      project: 'GCD Research Controller',
      judge: { model: 'fixture-solution-agent' },
      maxSolutionSketches: 3
    }, {
      async llmJson({ task, methodCards, candidateRelations }) {
        assert.equal(task, 'research_controller.compose_solutions');
        assert.ok(methodCards.length > 0);
        return {
          solution_sketches: methodCards.slice(0, 2).map((card, index) => ({
            variant_key: `agent_revision_${index + 1}`,
            source_candidate_ids: [card.candidate_id],
            source_edge_ids: candidateRelations.map((edge) => edge.edge_id).slice(0, 2),
            problem_claim: `Agent-refined solution for ${card.subproblem?.name || 'selected subproblem'}.`,
            core_idea: `Agent-refined mechanism using ${card.mechanism || card.candidate_id} without claiming final novelty.`,
            algorithm_flow: ['Prepare selected evidence.', 'Instantiate bounded module.', 'Evaluate with declared metrics.'],
            module_interfaces: [{
              module_id: `agent-module-${index + 1}`,
              candidate_id: card.candidate_id,
              input_signal: 'representation features',
              output_signal: 'calibrated assignment score'
            }],
            training_objective: 'bounded agent-refined objective',
            inference_behavior: 'produce calibrated assignments without evaluation-only labels',
            expected_observations: ['novel accuracy should improve under fair baselines'],
            ablation_suggestions: ['Remove the agent-refined module and compare against the same backbone.'],
            discard_conditions: ['Discard if evidence remains missing or fair-baseline gains disappear.'],
            evidence_boundaries: {
              evidence_supported: ['source_candidate_ids'],
              agent_inferred: ['core_idea', 'algorithm_flow'],
              speculative: ['expected_observations']
            },
            missing_evidence: ['closest prior novelty check'],
            status: 'proposed'
          }))
        };
      }
    });
    assert.equal(composed.status, 'ok');
    assert.equal(composed.controller_state_summary.lifecycle, 'solutions_composed');
    assert.equal(composed.solution_composition_run.backend, 'single_model_llm_json');
    assert.equal(composed.solution_composition_run.model, 'fixture-solution-agent');
    assert.ok(composed.solution_sketches.length >= 2);
    assert.ok(composed.solution_sketches.every((sketch) => sketch.generated_by === 'research_controller.compose_solutions.single_model_revision'));
    assert.ok(composed.solution_sketches.every((sketch) => sketch.core_idea.includes('Agent-refined')));
    assert.ok(composed.solution_sketches.every((sketch) => sketch.discard_conditions.length > 0));
    assert.ok(composed.solution_sketches.every((sketch) => sketch.ablation_suggestions.length > 0));
    const solutionSketchesMarkdown = await fs.readFile(composed.artifact_paths.solution_sketches_md, 'utf8');
    assert.match(solutionSketchesMarkdown, /Solution Sketches/);
    assert.match(solutionSketchesMarkdown, /Discard conditions/);

    const designReview = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'design_review',
      corpus: rootPath,
      project: 'GCD Research Controller',
      judge: { model: 'fixture-design-reviewer' }
    }, {
      async llmJson({ task, solutionSketches }) {
        assert.equal(task, 'research_controller.design_review');
        assert.ok(solutionSketches.length > 0);
        return {
          summary: 'Fixture design reviewer keeps sketches as revise-only user decision artifacts.',
          reviews: solutionSketches.map((sketch) => ({
            solution_id: sketch.solution_id,
            decision: 'revise',
            novelty_risk: 'medium',
            novelty_claim_status: 'not_claimed',
            evidence_coverage: 'low',
            feasibility: 'medium',
            evaluation_suggestion_quality: 'medium',
            decomposition_drift: 'none',
            design_boundary_review: {
              status: 'needs_human_review',
              violations: []
            },
            closest_prior_checks: ['closest prior novelty check is still missing'],
            main_reason: 'Agent review requires closest-prior evidence before promotion.',
            missing_evidence: ['closest prior novelty check'],
            highest_risk_assumption: 'expected gain remains speculative',
            suggested_revision: 'Run closest-prior evidence expansion before experiment planning.',
            user_decision_needed: ['Decide whether to request closest-prior evidence expansion.']
          })),
          user_decision_needed: ['Decide whether to request closest-prior evidence expansion.']
        };
      }
    });
    assert.equal(designReview.status, 'ok');
    assert.equal(designReview.controller_state_summary.lifecycle, 'design_reviewed');
    assert.equal(designReview.design_review_run.backend, 'single_model_llm_json');
    assert.equal(designReview.design_review_run.model, 'fixture-design-reviewer');
    assert.equal(designReview.design_review.review_policy.backend, 'single_model_llm_json');
    assert.equal(designReview.design_review.reviews.length, composed.solution_sketches.length);
    assert.ok(designReview.design_review.reviews.every((review) => ['recommend', 'revise', 'reject'].includes(review.decision)));
    assert.ok(designReview.design_review.reviews.every((review) => review.closest_prior_checks.includes('closest prior novelty check is still missing')));
    assert.ok(designReview.design_review.reviews.some((review) => review.closest_prior_evidence?.length > 0));
    assert.ok(designReview.design_review.reviews
      .flatMap((review) => review.closest_prior_evidence || [])
      .some((entry) => entry.status === 'graph_prior_found'));
    assert.ok(designReview.design_review.reviews.every((review) => review.closest_prior_request_ids?.length > 0));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.length > 0);
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.approval_required === true));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.execution_status === 'not_run'));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.status === 'opt_in_requested_not_executed'));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.arguments.includeProviderEvidence === false));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.requested_opt_ins.include_provider_evidence === true));
    assert.ok(designReview.design_review.closest_prior_expansion_requests.every((request) => request.requested_opt_ins.include_literature_discovery === true));
    assert.equal(designReview.design_review.decomposition_drift_review.status, 'possible');
    assert.ok(designReview.controller_state_summary.next_actions.includes('review_decomposition'));
    assert.ok(designReview.design_review.reviews.every((review) => review.design_boundary_review));
    const designReviewMarkdown = await fs.readFile(designReview.artifact_paths.design_review_md, 'utf8');
    assert.match(designReviewMarkdown, /Design Review/);
    assert.match(designReviewMarkdown, /Decision/);
    assert.match(designReviewMarkdown, /Closest prior evidence/);
    assert.match(designReviewMarkdown, /Decomposition Drift Review/);
    assert.match(designReviewMarkdown, /Closest Prior Expansion Requests/);

    const closestPriorRequest = designReview.design_review.closest_prior_expansion_requests[0];
    const recordedClosestPrior = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'record_material_results',
      corpus: rootPath,
      project: 'GCD Research Controller',
      externalInputs: {
        material_expansion_results: [{
          request_id: closestPriorRequest.request_id,
          request_type: closestPriorRequest.request_type,
          operation: closestPriorRequest.operation,
          solution_id: closestPriorRequest.solution_id,
          review_id: closestPriorRequest.review_id,
          status: 'ok',
          source: 'fixture-closest-prior-agent',
          summary: {
            closest_prior_hits: 1,
            finding: 'Fixture closest-prior material check was recorded for design review.',
            unresolved: ['manual novelty interpretation is still required']
          },
          artifact_paths: {
            source: `/tmp/${closestPriorRequest.request_id}.json`
          },
          remaining_missing_evidence: ['manual novelty interpretation']
        }]
      }
    });
    assert.equal(recordedClosestPrior.status, 'ok');
    assert.equal(recordedClosestPrior.material_result_count, 5);
    assert.equal(recordedClosestPrior.design_review.fulfilled_closest_prior_expansion_request_count, 1);
    assert.ok(recordedClosestPrior.design_review.closest_prior_expansion_requests.some((request) => (
      request.request_id === closestPriorRequest.request_id
      && request.status === 'result_recorded'
      && request.execution_status === 'recorded'
      && request.result_id
    )));
    assert.ok(recordedClosestPrior.design_review.reviews.some((review) => (
      review.closest_prior_material_result_count === 1
      && review.closest_prior_result_ids.length === 1
      && review.closest_prior_expansion_status === 'external_results_recorded'
    )));
    const recordedDesignReviewMarkdown = await fs.readFile(recordedClosestPrior.artifact_paths.design_review_md, 'utf8');
    assert.match(recordedDesignReviewMarkdown, /Closest prior material results/);

    const innovationBriefs = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'compose_innovation_briefs',
      corpus: rootPath,
      project: 'GCD Research Controller',
      maxInnovationBriefs: 2
    });
    assert.equal(innovationBriefs.status, 'ok');
    assert.equal(innovationBriefs.controller_state_summary.lifecycle, 'innovation_briefs_composed');
    assert.equal(innovationBriefs.controller_state_summary.innovation_brief_count, 2);
    assert.equal(innovationBriefs.innovation_briefs.record_type, 'innovation_brief_pack');
    assert.equal(innovationBriefs.innovation_briefs.briefs.length, 2);
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.idea_id));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.source_candidate_ids.length > 0));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.what_is_evidence_supported.length > 0));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.what_is_agent_inferred.includes('innovation brief synthesis from selected subgraphs')));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.what_is_speculative.includes('actual metric gain until experiments are run')));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.evaluation_plan.metrics.length > 0));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.discard_conditions.length > 0));
    assert.ok(innovationBriefs.innovation_briefs.briefs.every((brief) => brief.next_action.includes('Resolve missing materials')));
    const innovationBriefsMarkdown = await fs.readFile(innovationBriefs.artifact_paths.innovation_briefs_md, 'utf8');
    assert.match(innovationBriefsMarkdown, /Innovation Briefs/);
    assert.match(innovationBriefsMarkdown, /Evidence-supported/);
    assert.match(innovationBriefsMarkdown, /Speculative/);

    const experimentPlanWithoutApproval = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'generate_experiment_plan',
      corpus: rootPath,
      project: 'GCD Research Controller'
    });
    assert.equal(experimentPlanWithoutApproval.status, 'needs_approval');
    assert.ok(experimentPlanWithoutApproval.user_decision_needed.some((item) => item.includes('approveExperimentPlanning=true')));

    const experimentPlan = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'generate_experiment_plan',
      corpus: rootPath,
      project: 'GCD Research Controller',
      approveExperimentPlanning: true,
      experimentPlanApproval: {
        approver: 'fixture-human',
        source: 'fixture-test',
        note: 'Plan only; do not execute.'
      },
      maxExperimentPlans: 2,
      maxGpuHours: 12
    });
    assert.equal(experimentPlan.status, 'ok');
    assert.equal(experimentPlan.controller_state_summary.lifecycle, 'experiment_plan_generated');
    assert.equal(experimentPlan.controller_state_summary.experiment_plan_count, 2);
    assert.equal(experimentPlan.experiment_plan.execution_status, 'not_executed');
    assert.equal(experimentPlan.experiment_plan.approval.approved, true);
    assert.equal(experimentPlan.experiment_plan.approval.approver, 'fixture-human');
    assert.equal(experimentPlan.experiment_plan.plans.length, 2);
    assert.ok(experimentPlan.experiment_plan.plans.every((plan) => plan.status === 'planned_not_executed'));
    assert.ok(experimentPlan.experiment_plan.plans.every((plan) => plan.execution_policy.execution_status === 'not_executed'));
    assert.ok(experimentPlan.experiment_plan.plans.every((plan) => plan.execution_policy.forbidden_actions.includes('train_model')));
    assert.ok(experimentPlan.experiment_plan.plans.every((plan) => plan.execution_policy.forbidden_actions.includes('submit_job')));
    assert.ok(experimentPlan.experiment_plan.plans.every((plan) => plan.budget.max_gpu_hours === 12));
    const experimentPlanMarkdown = await fs.readFile(experimentPlan.artifact_paths.experiment_plan_md, 'utf8');
    assert.match(experimentPlanMarkdown, /Experiment Plan/);
    assert.match(experimentPlanMarkdown, /Execution status: not_executed/);

    const exported = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'export',
      corpus: rootPath,
      project: 'GCD Research Controller'
    });

    assert.equal(exported.status, 'ok');
    assert.equal(exported.export.record_type, 'controller_export');
    assert.equal(exported.export.budget.profile, 'gcd_mvp_planning');
    assert.equal(exported.export.task_spec.summary.target_domain, 'Generalized Category Discovery');
    assert.ok(exported.export.subproblem_graph.subproblem_summaries.length >= 3);
    assert.ok(exported.export.method_cards.length > 0);
    assert.equal(exported.export.candidate_subgraphs.selected.length, 2);
    assert.ok(exported.export.candidate_subgraphs.parked.length > 0);
    assert.ok(exported.export.candidate_relations.length > 0);
    assert.equal(exported.export.method_card_pack.available, true);
    assert.equal(exported.export.method_card_pack.material_result_count, 5);
    assert.equal(exported.export.material_expansion_results.length, 5);
    assert.equal(exported.export.selected_method_cards.length, 2);
    assert.ok(exported.export.solution_sketches.length >= 2);
    assert.equal(exported.export.design_reviews.length, exported.export.solution_sketches.length);
    assert.equal(exported.export.innovation_briefs.length, 2);
    assert.equal(exported.export.innovation_brief_pack.brief_policy.authority, 'downstream_ideation_seed_only');
    assert.ok(exported.export.innovation_briefs.every((brief) => brief.status === 'candidate_brief_for_human_review'));
    assert.ok(exported.export.closest_prior_expansion_requests.length > 0);
    assert.equal(exported.export.fulfilled_closest_prior_expansion_request_count, 1);
    assert.ok(exported.export.closest_prior_expansion_requests.some((request) => (
      request.request_id === closestPriorRequest.request_id
      && request.execution_status === 'recorded'
    )));
    assert.ok(exported.export.next_material_requests.some((request) => (
      typeof request === 'object'
      && request.request_id?.startsWith('cpreq:')
      && request.operation === 'research_material_pack'
    )));
    assert.equal(exported.export.experiment_plans.length, 2);
    assert.equal(exported.export.experiment_plan_pack.execution_status, 'not_executed');
    assert.equal(exported.export.decomposition_drift_review.status, 'possible');
    assert.ok(exported.export.user_decision_needed.some((item) => item.includes('Post-evidence drift signals')));
    assert.ok(exported.export.judge_trace_summary.decision_count > 0);
    assert.ok(exported.export.judge_trace_summary.latest_decisions.length > 0);
    assert.ok(exported.artifact_paths.controller_export_json.endsWith('controller-export.json'));
    const exportMarkdown = await fs.readFile(exported.artifact_paths.controller_export_md, 'utf8');
    assert.match(exportMarkdown, /Candidate Method Cards/);
    assert.match(exportMarkdown, /Selected Method Card Pack/);
    assert.match(exportMarkdown, /Post-Evidence Decomposition Drift/);
    assert.match(exportMarkdown, /Material Expansion Results/);
    assert.match(exportMarkdown, /Solution Sketches/);
    assert.match(exportMarkdown, /Design Reviews/);
    assert.match(exportMarkdown, /Innovation Briefs/);
    assert.match(exportMarkdown, /Closest prior evidence/);
    assert.match(exportMarkdown, /Closest Prior Expansion Requests/);
    assert.match(exportMarkdown, /Experiment Plans/);
    assert.match(exportMarkdown, /Candidate Relations/);
    assert.match(exportMarkdown, /Judge Decisions/);
    assert.match(exportMarkdown, /Selected Subgraphs/);

    const runRound = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'run_round',
      corpus: rootPath,
      project: 'Fresh Controller',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'domain-shift robust generalized category discovery'
    });
    assert.equal(runRound.status, 'ok');
    assert.equal(runRound.action, 'run_round');
    assert.equal(runRound.action_completed, 'run_round_planning_full_design_packet');
    assert.equal(runRound.export.record_type, 'controller_export');
    assert.ok(runRound.export.method_cards.length > 0);
    assert.ok(runRound.export.candidate_relations.length > 0);
    assert.ok(runRound.export.selected_method_cards.length > 0);
    assert.ok(runRound.export.solution_sketches.length > 0);
    assert.ok(runRound.export.design_reviews.length > 0);
    assert.ok(runRound.export.innovation_briefs.length > 0);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('agent_materials research_controller applies non-GCD task-family defaults', async () => {
  const rootPath = await createMaterialCorpus();
  try {
    const domainAdaptation = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'init_task',
      corpus: rootPath,
      project: 'Domain Adaptation Controller',
      targetDomain: 'Unsupervised Domain Adaptation',
      targetProblem: 'robust image classification under source to target domain shift',
      mode: 'quick'
    });

    assert.equal(domainAdaptation.status, 'ok');
    assert.equal(domainAdaptation.controller_state_summary.task_family, 'domain_adaptation');
    assert.equal(domainAdaptation.controller_state_summary.budget_profile, 'domain_adaptation_quick');

    const domainState = JSON.parse(await fs.readFile(domainAdaptation.artifact_paths.controller_state, 'utf8'));
    assert.ok(domainState.constraints.design_boundaries.some((entry) => entry.includes('source/target labels')));

    const domainSubproblems = JSON.parse(await fs.readFile(domainAdaptation.artifact_paths.subproblem_graph, 'utf8'));
    assert.ok(domainSubproblems.subproblems.some((entry) => entry.name === 'domain protocol and split control'));
    assert.ok(domainSubproblems.subproblems.some((entry) => entry.query_plan.some((query) => query.includes('source target split'))));

    const retrieval = await executeAgentMaterialsTool({
      operation: 'research_controller',
      action: 'init_task',
      corpus: rootPath,
      project: 'Retrieval Controller',
      targetDomain: 'Retrieval-Augmented Generation',
      targetProblem: 'reduce hallucination in RAG question answering with reranking and evidence grounding',
      mode: 'planning'
    });

    assert.equal(retrieval.status, 'ok');
    assert.equal(retrieval.controller_state_summary.task_family, 'retrieval');
    assert.equal(retrieval.controller_state_summary.budget_profile, 'retrieval_planning');

    const retrievalState = JSON.parse(await fs.readFile(retrieval.artifact_paths.controller_state, 'utf8'));
    assert.ok(retrievalState.constraints.design_boundaries.some((entry) => entry.includes('Do not index test answers')));

    const retrievalSubproblems = JSON.parse(await fs.readFile(retrieval.artifact_paths.subproblem_graph, 'utf8'));
    assert.ok(retrievalSubproblems.subproblems.some((entry) => entry.name === 'first-stage recall'));
    assert.ok(retrievalSubproblems.metrics.includes('Recall@k'));
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
