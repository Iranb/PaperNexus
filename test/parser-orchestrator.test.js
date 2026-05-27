import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildIngestionGraphApplyPlan,
  buildIngestionGraphMutations,
  INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
  PARSER_ORCHESTRATOR_CONTRACT_VERSION,
  runParserOrchestrator
} from '../src/core/ingestion/parser-orchestrator.js';
import { analyzeCorpus } from '../src/core/ingestion/pipeline.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { applyGraphMutations } from '../src/core/graph/mutations.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { loadSourceManifest } from '../src/storage/corpus-store.js';

const execFileAsync = promisify(execFile);

function sampleTei() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <body>
      <div type="method" xml:id="sec-method">
        <head>Method</head>
        <p xml:id="p1">Our framework uses BM25 retrieval <ref type="bibr" target="#b0">Robertson et al., 1995</ref> and aligns retrieved evidence spans with claims.</p>
      </div>
    </body>
    <back>
      <listBibl>
        <biblStruct xml:id="b0">
          <analytic>
            <title level="a">Okapi at TREC</title>
            <author><persName><surname>Robertson</surname></persName></author>
          </analytic>
          <monogr><imprint><date when="1995"/></imprint></monogr>
          <idno type="DOI">10.1145/okapi</idno>
        </biblStruct>
      </listBibl>
    </back>
  </text>
</TEI>`;
}

function paperFixture() {
  return {
    paper: {
      paperId: 'paper:orchestrated-ingestion',
      paperTitle: 'Orchestrated Ingestion',
      sourcePath: '/tmp/orchestrated.md'
    },
    sections: [{
      id: 'sec-method',
      heading: 'Method',
      role: 'method',
      text: 'Our framework uses BM25 retrieval Robertson et al., 1995 and aligns retrieved evidence spans with claims.'
    }, {
      id: 'sec-results',
      heading: 'Results',
      role: 'evaluation',
      text: 'Experiments improve recall by 12 points over strong retrieval baselines.'
    }]
  };
}

function cociCsv() {
  return [
    'oci,citing,cited,creation',
    'oci-1,10.1000/source-one,10.1145/okapi,2022'
  ].join('\n');
}

function multimodalAssetsFixture() {
  return {
    contractVersion: 'papernexus-multimodal-assets-v1',
    license_scope: 'local-derived-research-use',
    assets: [{
      asset_id: 'figure:retrieval-architecture',
      asset_type: 'figure',
      paper_id: 'paper:orchestrated-ingestion',
      page: 3,
      caption: 'Figure 1 illustrates the retrieval and claim-alignment architecture.',
      ocr_text: 'BM25 retrieval -> evidence span alignment -> claim graph',
      source_parser: 'paddleocr-vl',
      source_anchor: 'paper:orchestrated-ingestion#page=3#figure=1',
      evidence_hash: 'sha256:figure-retrieval-architecture',
      target_ids: ['claim:multimodal-placeholder']
    }]
  };
}

function passedBenchmarkArtifacts() {
  return {
    citationIntents: { evaluation: { status: 'passed', accuracy: 1, macro_f1: 1 } },
    claimExtraction: { evaluation: { status: 'passed', claim_recall: 1, source_span_completeness: 1, type_accuracy: 1 } }
  };
}

test('parser orchestrator builds default citation/claim/citation-graph artifacts and graph mutation preview', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-'));
  try {
    const teiPath = path.join(tempRoot, 'paper.tei.xml');
    const paperPath = path.join(tempRoot, 'paper.json');
    const cociPath = path.join(tempRoot, 'coci.csv');
    const multimodalAssetsPath = path.join(tempRoot, 'multimodal-assets.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(teiPath, sampleTei(), 'utf8');
    await fs.writeFile(paperPath, JSON.stringify(paperFixture(), null, 2), 'utf8');
    await fs.writeFile(cociPath, cociCsv(), 'utf8');
    await fs.writeFile(multimodalAssetsPath, JSON.stringify(multimodalAssetsFixture(), null, 2), 'utf8');

    const { manifest, artifacts } = await runParserOrchestrator({
      outputDir,
      teiPath,
      paperPath,
      cociPath,
      multimodalAssetsPath,
      paperId: 'paper:orchestrated-ingestion',
      paperTitle: 'Orchestrated Ingestion',
      sourceKey: 'orchestrator-fixture'
    });

    assert.equal(manifest.contractVersion, PARSER_ORCHESTRATOR_CONTRACT_VERSION);
    assert.equal(manifest.status, 'ready');
    assert.equal(manifest.releaseGateStatus, 'incomplete');
    assert.equal(manifest.parserPolicy.defaultCitationParser, 'grobid-tei');
    assert.equal(manifest.stages.grobid.status, 'completed');
    assert.equal(manifest.stages.citationContexts.status, 'completed');
    assert.equal(manifest.stages.citationIntents.status, 'completed');
    assert.equal(manifest.stages.claimExtraction.status, 'completed');
    assert.equal(manifest.stages.coci.status, 'completed');
    assert.equal(manifest.stages.multimodalAssets.status, 'completed');
    assert.equal(manifest.diagnostics.multimodalAssetCount, 1);
    assert.equal(manifest.diagnostics.multimodalAssetEdgeCount, 1);
    assert.ok(manifest.diagnostics.graphMutationOperationCount > 0);

    const operations = artifacts.graphMutations.operations;
    assert.ok(operations.some((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CITATION_CONTEXT));
    assert.ok(operations.some((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CLAIM));
    assert.ok(operations.some((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.MULTIMODAL_ASSET));
    assert.ok(operations.some((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.SUPPORTED_BY));
    assert.ok(operations.some((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.HAS_CITATION_INTENT));
    assert.ok(operations.some((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.CITES));
    assert.ok(operations.some((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.EXTRACTED_FROM_FIGURE));

    const manifestFromDisk = JSON.parse(await fs.readFile(path.join(outputDir, 'ingestion-orchestrator-manifest.json'), 'utf8'));
    assert.equal(manifestFromDisk.status, 'ready');
    assert.equal(manifestFromDisk.releaseGateStatus, 'incomplete');
    assert.ok(manifestFromDisk.artifacts.graphMutations.endsWith('graph-mutations.json'));
    assert.ok(manifestFromDisk.artifacts.graphApplyPlan.endsWith('graph-apply-plan.json'));
    assert.ok(manifestFromDisk.artifacts.multimodalAssets.endsWith('multimodal-assets.json'));
    assert.equal(manifestFromDisk.graphApplyPlan.status, 'preview_only');
    assert.equal(manifestFromDisk.graphApplyPlan.canApply, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('parser orchestrator projects multimodal assets into schema-valid graph mutations', () => {
  const graphMutations = buildIngestionGraphMutations({
    claimExtractionArtifact: {
      graph: {
        nodes: [{ id: 'claim:figure-grounded', type: NODE_TYPES.CLAIM, name: 'Figure-grounded claim' }],
        edges: []
      }
    },
    multimodalAssetsArtifact: {
      license_scope: 'local-derived-research-use',
      assets: [{
        asset_id: 'table:results',
        asset_type: 'table',
        paper_id: 'paper:asset-test',
        page: 5,
        caption: 'Table 2 reports recall improvements.',
        evidence_hash: 'sha256:table-results',
        source_anchor: 'paper:asset-test#page=5#table=2',
        claim_ids: ['claim:figure-grounded']
      }]
    }
  });

  assert.equal(graphMutations.dryRun, true);
  assert.equal(graphMutations.diagnostics.multimodalAssetNodeCount, 1);
  assert.equal(graphMutations.diagnostics.multimodalAssetEdgeCount, 1);
  assert.ok(graphMutations.operations.some((operation) => (
    operation.action === 'create_node'
    && operation.type === NODE_TYPES.MULTIMODAL_ASSET
    && operation.properties.licenseScope === 'local-derived-research-use'
    && operation.properties.evidenceHash === 'sha256:table-results'
  )));
  assert.ok(graphMutations.operations.some((operation) => (
    operation.action === 'create_edge'
    && operation.edgeType === EDGE_TYPES.EXTRACTED_FROM_TABLE
    && operation.targetId === 'claim:figure-grounded'
  )));

  const graph = createKnowledgeGraph();
  const applied = applyGraphMutations(graph, graphMutations.operations, {
    actor: 'parser-orchestrator-test',
    dryRun: true
  });
  assert.equal(applied.graph.nodes.some((node) => node.type === NODE_TYPES.MULTIMODAL_ASSET), true);
  assert.equal(applied.graph.relationships.some((relationship) => relationship.type === EDGE_TYPES.EXTRACTED_FROM_TABLE), true);
});

test('parser orchestrator mutation builder stays preview-only and reports incomplete inputs', () => {
  const payload = buildIngestionGraphMutations({});
  assert.equal(payload.dryRun, true);
  assert.equal(payload.operations.length, 0);
  assert.equal(payload.diagnostics.warnings.some((warning) => warning.code === 'no_graph_mutation_operations'), true);
});

test('parser orchestrator apply plan requires release-gated intent and passed extraction benchmarks', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-apply-plan-'));
  try {
    const teiPath = path.join(tempRoot, 'paper.tei.xml');
    const paperPath = path.join(tempRoot, 'paper.json');
    await fs.writeFile(teiPath, sampleTei(), 'utf8');
    await fs.writeFile(paperPath, JSON.stringify(paperFixture(), null, 2), 'utf8');

    const firstRun = await runParserOrchestrator({
      outputDir: path.join(tempRoot, 'bootstrap'),
      teiPath,
      paperPath,
      paperId: 'paper:orchestrated-ingestion',
      paperTitle: 'Orchestrated Ingestion'
    });
    const citationIntentGold = {
      labels: firstRun.artifacts.citationIntents.intents.map((intent) => ({
        citationContextId: intent.citationContextId,
        intent: intent.intent
      }))
    };
    const claimGold = {
      claims: firstRun.artifacts.claimExtraction.claims.map((claim) => ({
        claim_text: claim.claim_text,
        claim_type: claim.claim_type
      }))
    };
    const firstClaimId = firstRun.artifacts.claimExtraction.claims[0]?.claim_id;

    const { manifest, artifacts } = await runParserOrchestrator({
      outputDir: path.join(tempRoot, 'release-gated'),
      teiPath,
      paperPath,
      paperId: 'paper:orchestrated-ingestion',
      paperTitle: 'Orchestrated Ingestion',
      citationIntentGold,
      claimGold,
      minCitationIntentAccuracy: 1,
      minCitationIntentMacroF1: 1,
      minClaimRecall: 1,
      minSourceSpanCompleteness: 1,
      minTypeAccuracy: 1,
      multimodalAssets: {
        license_scope: 'local-derived-research-use',
        assets: [{
          asset_id: 'figure:orchestrated-ingestion',
          asset_type: 'figure',
          page: 1,
          caption: 'Figure 1 shows the orchestrated ingestion pipeline.',
          source_anchor: 'paper:orchestrated-ingestion#page=1#figure=1',
          evidence_hash: 'sha256:orchestrated-figure',
          claim_ids: [firstClaimId]
        }]
      },
      graphApplyMode: 'release-gated'
    });

    assert.equal(manifest.releaseGateStatus, 'passed');
    assert.equal(manifest.graphApplyPlan.status, 'ready_to_apply');
    assert.equal(manifest.graphApplyPlan.canApply, true);
    assert.equal(artifacts.graphApplyPlan.contractVersion, INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION);
    assert.equal(artifacts.graphApplyPlan.dryRun, true);
    assert.equal(artifacts.graphApplyPlan.safety.authoritativeGraphWritePerformed, false);
    assert.equal(artifacts.graphApplyPlan.gates.every((gate) => gate.status === 'passed'), true);
    assert.deepEqual(
      artifacts.graphApplyPlan.inputs.map((entry) => entry.role).sort(),
      ['citation_intent_gold_labels', 'claim_extraction_gold_labels', 'grobid_tei', 'multimodal_assets', 'paper_source'].sort()
    );
    assert.equal(artifacts.graphApplyPlan.inputs.every((entry) => entry.sha256), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('ingestion graph apply plan blocks failed benchmark gates', () => {
  const graphMutations = buildIngestionGraphMutations({
    claimExtractionArtifact: {
      graph: {
        nodes: [{ id: 'claim:1', type: NODE_TYPES.CLAIM, name: 'Claim one' }],
        edges: []
      }
    }
  });
  const plan = buildIngestionGraphApplyPlan({
    graphMutations,
    artifacts: {
      citationIntents: { evaluation: { status: 'passed', accuracy: 1 } },
      claimExtraction: { evaluation: { status: 'failed', claim_recall: 0 } }
    }
  }, {
    graphApplyMode: 'release-gated'
  });

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.canApply, false);
  assert.equal(plan.blockingReasons.some((reason) => reason.code === 'claim_extraction_benchmark_passed'), true);
});

test('ingestion graph apply plan allows release-gated apply with audited multimodal assets', () => {
  const graphMutations = buildIngestionGraphMutations({
    claimExtractionArtifact: {
      graph: {
        nodes: [{ id: 'claim:figure-grounded', type: NODE_TYPES.CLAIM, name: 'Figure-grounded claim' }],
        edges: []
      }
    },
    multimodalAssetsArtifact: {
      license_scope: 'local-derived-research-use',
      assets: [{
        asset_id: 'figure:audited',
        asset_type: 'figure',
        page: 2,
        caption: 'Figure 1 shows the pipeline.',
        source_anchor: 'paper:asset-audit#page=2#figure=1',
        evidence_hash: 'sha256:audited-figure',
        claim_ids: ['claim:figure-grounded']
      }]
    }
  });
  const plan = buildIngestionGraphApplyPlan({
    graphMutations,
    artifacts: passedBenchmarkArtifacts()
  }, {
    graphApplyMode: 'release-gated'
  });

  assert.equal(plan.status, 'ready_to_apply');
  assert.equal(plan.canApply, true);
  assert.equal(plan.multimodalAssetAudit.assetCount, 1);
  assert.equal(plan.multimodalAssetAudit.invalidAssetCount, 0);
  assert.equal(plan.gates.find((gate) => gate.name === 'multimodal_asset_audit_complete').status, 'passed');
});

test('ingestion graph apply plan blocks release-gated apply without multimodal assets', () => {
  const graphMutations = buildIngestionGraphMutations({
    claimExtractionArtifact: {
      graph: {
        nodes: [{ id: 'claim:no-multimodal', type: NODE_TYPES.CLAIM, name: 'Claim without multimodal evidence' }],
        edges: []
      }
    }
  });
  const plan = buildIngestionGraphApplyPlan({
    graphMutations,
    artifacts: passedBenchmarkArtifacts()
  }, {
    graphApplyMode: 'release-gated'
  });
  const auditGate = plan.gates.find((gate) => gate.name === 'multimodal_asset_audit_complete');

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.canApply, false);
  assert.equal(auditGate.status, 'incomplete');
  assert.equal(plan.blockingReasons.some((reason) => reason.code === 'multimodal_asset_audit_complete'), true);
});

test('ingestion graph apply plan blocks unaudited multimodal assets', () => {
  const graphMutations = buildIngestionGraphMutations({
    claimExtractionArtifact: {
      graph: {
        nodes: [{ id: 'claim:figure-grounded', type: NODE_TYPES.CLAIM, name: 'Figure-grounded claim' }],
        edges: []
      }
    },
    multimodalAssetsArtifact: {
      assets: [{
        asset_id: 'figure:unaudited',
        asset_type: 'figure',
        page: 2,
        caption: 'Figure 1 shows the pipeline.'
      }]
    }
  });
  const plan = buildIngestionGraphApplyPlan({
    graphMutations,
    artifacts: passedBenchmarkArtifacts()
  }, {
    graphApplyMode: 'release-gated'
  });
  const auditGate = plan.gates.find((gate) => gate.name === 'multimodal_asset_audit_complete');

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.canApply, false);
  assert.equal(plan.multimodalAssetAudit.invalidAssetCount, 1);
  assert.equal(auditGate.status, 'incomplete');
  assert.deepEqual(auditGate.invalidAssets[0].missing, ['license_scope', 'evidence_hash', 'source_anchor', 'target_link']);
  assert.equal(plan.blockingReasons.some((reason) => reason.code === 'multimodal_asset_audit_complete'), true);
});

test('parser orchestrator CLI writes a manifest summary', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-cli-'));
  try {
    const teiPath = path.join(tempRoot, 'paper.tei.xml');
    const paperPath = path.join(tempRoot, 'paper.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(teiPath, sampleTei(), 'utf8');
    await fs.writeFile(paperPath, JSON.stringify(paperFixture(), null, 2), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/run-ingestion-orchestrator.mjs'),
      '--output-dir', outputDir,
      '--tei-path', teiPath,
      '--paper-path', paperPath,
      '--paper-id', 'paper:orchestrated-ingestion',
      '--paper-title', 'Orchestrated Ingestion'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, PARSER_ORCHESTRATOR_CONTRACT_VERSION);
    assert.equal(summary.status, 'ready');
    assert.equal(summary.releaseGateStatus, 'incomplete');
    assert.ok(summary.citation_context_count > 0);
    assert.ok(summary.claim_count > 0);
    assert.ok(summary.graph_mutation_operation_count > 0);
    assert.equal(summary.graph_apply_plan_status, 'preview_only');
    assert.equal(summary.graph_apply_can_apply, false);
    assert.ok(summary.manifestPath.endsWith('ingestion-orchestrator-manifest.json'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('analyzeCorpus can run the parser orchestrator as an optional runtime substrate', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-home-'));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-analyze-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempRoot, 'runtime-orchestrator.md'), `# Runtime Orchestrator Paper

Alice Example

## Abstract

We propose a novel runtime parser orchestrator for claim-grounded ingestion.

## Method

Our framework uses BM25 retrieval and aligns retrieved evidence spans with claims.

## Results

Experiments improve recall by 12 points over strong retrieval baselines.
`, 'utf8');

    const result = await analyzeCorpus(tempRoot, {
      name: 'runtime-orchestrator-test',
      force: true,
      ingestionOrchestrator: true,
      identifierResolutionEnabled: false,
      semanticExtraction: 'heuristic-only'
    });

    assert.equal(result.ingestionOrchestrator.status, 'ready');
    assert.equal(result.ingestionOrchestrator.profile, 'preview');
    assert.equal(result.ingestionOrchestrator.writePolicy, 'preview-only');
    assert.equal(result.ingestionOrchestrator.releaseGateStatus, 'incomplete');
    assert.equal(result.ingestionOrchestrator.runCount, 1);

    const sourceManifest = await loadSourceManifest(tempRoot);
    assert.equal(sourceManifest.ingestionOrchestrator.status, 'ready');
    assert.equal(sourceManifest.ingestionOrchestrator.profile, 'preview');
    assert.equal(sourceManifest.ingestionOrchestrator.writePolicy, 'preview-only');
    assert.equal(sourceManifest.ingestionOrchestrator.runCount, 1);

    const runSummary = sourceManifest.ingestionOrchestrator.runs[0];
    const orchestratorManifest = JSON.parse(await fs.readFile(runSummary.manifestPath, 'utf8'));
    assert.equal(orchestratorManifest.stages.claimExtraction.status, 'completed');
    assert.equal(orchestratorManifest.stages.graphMutations.status, 'completed');

    const graphMutations = JSON.parse(await fs.readFile(orchestratorManifest.artifacts.graphMutations, 'utf8'));
    assert.ok(graphMutations.operations.some((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CLAIM));
    assert.ok(graphMutations.operations.some((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.SUPPORTED_BY));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus can enable parser orchestrator through a controlled preview profile', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-profile-home-'));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-orchestrator-profile-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempRoot, 'profile-orchestrator.md'), `# Profile Orchestrator Paper

Alice Example

## Abstract

We propose a preview ingestion profile for claim-grounded citation extraction.

## Method

The method links citation contexts to contribution claims and evidence spans.
`, 'utf8');

    const result = await analyzeCorpus(tempRoot, {
      name: 'runtime-orchestrator-profile-test',
      force: true,
      ingestionOrchestratorProfile: 'preview',
      identifierResolutionEnabled: false,
      semanticExtraction: 'heuristic-only'
    });

    assert.equal(result.ingestionOrchestrator.status, 'ready');
    assert.equal(result.ingestionOrchestrator.profile, 'preview');
    assert.equal(result.ingestionOrchestrator.writePolicy, 'preview-only');
    assert.equal(result.ingestionOrchestrator.releaseGateStatus, 'incomplete');

    const sourceManifest = await loadSourceManifest(tempRoot);
    assert.equal(sourceManifest.ingestionOrchestrator.profile, 'preview');
    assert.equal(sourceManifest.ingestionOrchestrator.writePolicy, 'preview-only');

    const runSummary = sourceManifest.ingestionOrchestrator.runs[0];
    const graphMutations = JSON.parse(await fs.readFile(runSummary.artifacts.graphMutations, 'utf8'));
    assert.equal(graphMutations.dryRun, true);
    assert.ok(graphMutations.operations.some((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CLAIM));
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
