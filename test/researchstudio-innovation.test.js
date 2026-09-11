import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  RESEARCHSTUDIO_SEED_PATTERN_CARDS,
  attachResearchStudioTrace,
  buildProposalGraphHandoff,
  compileInnovationPatternAnalysis,
  compileMechanismCollisionAudit,
  compileStructuralGapAnalysis
} from '../src/core/materials/researchstudio-innovation.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

function materialItem({ id, title, assumption, role, text }) {
  return {
    material_id: `material:${id}:${role}`,
    paper_id: id,
    title,
    status: 'in_graph',
    role,
    materials: {
      chunks: [{ chunk_id: `chunk:${id}`, text }],
      source_spans: []
    },
    graph_context: [{
      relationship_id: `rel:${id}:assumption`,
      relationship_type: 'ASSUMES',
      node_id: 'assumption:labels-available',
      node_type: 'Assumption',
      node_name: assumption,
      provenance: `span:${id}:assumption`
    }],
    provenance: [{ source_type: 'committed_graph_search', source_id: id }]
  };
}

function materialPackFixture() {
  const current = materialItem({
    id: 'paper:current',
    title: 'Current Method',
    assumption: 'Labels are available during adaptation',
    role: 'target_prior',
    text: 'The current representation loses boundary information and assumes labels are available during adaptation.'
  });
  const ancestor = materialItem({
    id: 'paper:ancestor',
    title: 'Ancestor Method',
    assumption: 'Labels are available during adaptation',
    role: 'novelty_risk',
    text: 'The ancestor also assumes labels are available during adaptation.'
  });
  return {
    target_domain: 'Adaptation',
    target_problem: 'Boundary information is lost under domain shift',
    groups: [{ role: 'target_prior', items: [current] }, {
      role: 'novelty_risk',
      items: [
        { ...current, role: 'novelty_risk', material_id: 'material:paper:current:novelty_risk' },
        ancestor
      ]
    }]
  };
}

function methodLineageFixture() {
  const current = {
    methodId: 'method:current',
    methodName: 'Current Method',
    paperId: 'paper:current',
    paperTitle: 'Current Method',
    year: 2025
  };
  const ancestor = {
    methodId: 'method:ancestor',
    methodName: 'Ancestor Method',
    paperId: 'paper:ancestor',
    paperTitle: 'Ancestor Method',
    year: 2022
  };
  const future = {
    methodId: 'method:future',
    methodName: 'Future Method',
    paperId: 'paper:future',
    paperTitle: 'Future Method',
    year: 2026
  };
  return {
    path: 'method_evolution_bottleneck_gap',
    query: 'Current Method',
    matchedMethod: { ...current, matchScore: 1 },
    direction: 'both',
    maxDepth: 3,
    lineages: [{
      direction: 'backward',
      score: 0.9,
      steps: [{
        ...current,
        edgeToNext: {
          edgeId: 'edge:current-ancestor',
          edgeType: 'VARIANT_OF',
          paperEdgeType: 'IMPROVES_METHOD',
          bottleneck: { dimension: 'boundary information loss', description: 'Preserve boundary information under shift.' },
          mechanism: { dimension: 'structured representation', description: 'Encode boundary structure.' },
          tradeoff: { dimension: 'compute', description: 'Adds compute cost.' },
          evidence: {
            quote: 'Current Method preserves boundary information lost by Ancestor Method.',
            paperId: 'paper:current',
            sourceSpanId: 'span:lineage'
          }
        }
      }, ancestor]
    }, {
      direction: 'forward',
      score: 0.82,
      steps: [{
        ...current,
        edgeToNext: {
          edgeId: 'edge:future-current',
          edgeType: 'VARIANT_OF',
          paperEdgeType: 'EXTENDS_METHOD',
          bottleneck: { dimension: 'adaptation cost', description: 'Avoid full retraining.' },
          mechanism: { dimension: 'conditional adaptation', description: 'Condition instead of retraining.' },
          tradeoff: { dimension: 'condition estimation', description: 'Requires a condition estimate.' },
          evidence: { quote: 'Future Method conditions adaptation without retraining.' }
        }
      }, future]
    }],
    nextGapCandidates: [{
      gap: 'reduce boundary information loss bottlenecks without increasing compute costs',
      bottleneckDimension: 'boundary information loss',
      tradeoffDimension: 'compute',
      groundingEdges: ['edge:current-ancestor'],
      evidenceQuotes: ['Current Method preserves boundary information lost by Ancestor Method.'],
      confidence: 0.8
    }],
    diagnostics: { ambiguity: 'resolved', acceptedEdgeCount: 2 }
  };
}

function gapMapFixture() {
  return [{
    gap_id: 'gap:representation',
    gap_type: 'mechanism_uncertainty',
    statement: 'The current representation loses boundary information under domain shift.',
    supporting_papers: [{ paper_id: 'paper:current', title: 'Current Method' }],
    source_spans: [{ source_type: 'chunk', source_id: 'chunk:paper:current' }]
  }, {
    gap_id: 'gap:assumption',
    gap_type: 'assumption_risk',
    statement: 'Labels are available during adaptation',
    supporting_papers: [{ paper_id: 'paper:current', title: 'Current Method' }],
    source_spans: [{ source_type: 'graph_relationship', source_id: 'rel:paper:current:assumption' }]
  }];
}

async function createResearchStudioCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-researchstudio-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const graph = createKnowledgeGraph();

  for (const paper of [{
    id: 'paper:current',
    title: 'Current Boundary Adaptation Method',
    year: 2025,
    abstract: 'Boundary information is lost under domain shift and labels are available during adaptation.'
  }, {
    id: 'paper:ancestor',
    title: 'Ancestor Boundary Adaptation Method',
    year: 2022,
    abstract: 'An earlier domain adaptation method assumes labels are available during adaptation.'
  }, {
    id: 'paper:future',
    title: 'Conditional Boundary Adaptation Method',
    year: 2026,
    abstract: 'Conditional adaptation avoids full retraining while preserving boundary information.'
  }]) {
    graph.addNode({
      id: paper.id,
      type: NODE_TYPES.PAPER,
      name: paper.title,
      properties: {
        paperId: paper.id,
        paperTitle: paper.title,
        publicationYear: paper.year,
        abstract: paper.abstract,
        fieldOfStudy: 'Domain Adaptation'
      }
    });
  }

  for (const method of [{
    id: 'method:current', name: 'Current Boundary Method', paperId: 'paper:current', paperTitle: 'Current Boundary Adaptation Method', year: 2025
  }, {
    id: 'method:ancestor', name: 'Ancestor Boundary Method', paperId: 'paper:ancestor', paperTitle: 'Ancestor Boundary Adaptation Method', year: 2022
  }, {
    id: 'method:future', name: 'Conditional Boundary Method', paperId: 'paper:future', paperTitle: 'Conditional Boundary Adaptation Method', year: 2026
  }]) {
    graph.addNode({
      id: method.id,
      type: NODE_TYPES.METHOD,
      name: method.name,
      properties: {
        paperId: method.paperId,
        paperTitle: method.paperTitle,
        year: method.year,
        aliases: [method.name.replace(' Method', '')]
      }
    });
  }

  graph.addNode({
    id: 'assumption:labels-available',
    type: NODE_TYPES.ASSUMPTION,
    name: 'Labels are available during adaptation',
    properties: {}
  });
  for (const paperId of ['paper:current', 'paper:ancestor']) {
    graph.addRelationship({
      id: `rel:${paperId}:assumption`,
      type: EDGE_TYPES.ASSUMES,
      sourceId: paperId,
      targetId: 'assumption:labels-available',
      properties: { sourceSpanId: `span:${paperId}:assumption` }
    });
  }
  for (const [paperId, methodId] of [['paper:current', 'method:current'], ['paper:ancestor', 'method:ancestor'], ['paper:future', 'method:future']]) {
    graph.addRelationship({
      id: `rel:${paperId}:method`,
      type: EDGE_TYPES.USES,
      sourceId: paperId,
      targetId: methodId,
      properties: {}
    });
  }
  graph.addRelationship({
    id: 'edge:current-ancestor',
    type: EDGE_TYPES.IMPROVES_METHOD,
    sourceId: 'method:current',
    targetId: 'method:ancestor',
    properties: {
      validationStatus: 'authoritative',
      exactMatch: true,
      exactQuote: 'Current Boundary Method preserves boundary information lost by Ancestor Boundary Method.',
      paperId: 'paper:current',
      paperTitle: 'Current Boundary Adaptation Method',
      sourceSpanId: 'span:lineage:current',
      bottleneck: { dimension: 'boundary information loss', description: 'Preserve boundary information.' },
      mechanism: { dimension: 'structured representation', description: 'Encode boundary structure.' },
      tradeoff: { dimension: 'compute', description: 'Adds compute cost.' },
      confidence: 0.9
    }
  });
  graph.addRelationship({
    id: 'edge:future-current',
    type: EDGE_TYPES.EXTENDS_METHOD,
    sourceId: 'method:future',
    targetId: 'method:current',
    properties: {
      validationStatus: 'authoritative',
      exactMatch: true,
      exactQuote: 'Conditional Boundary Method avoids full retraining through conditional adaptation.',
      paperId: 'paper:future',
      paperTitle: 'Conditional Boundary Adaptation Method',
      sourceSpanId: 'span:lineage:future',
      bottleneck: { dimension: 'adaptation cost', description: 'Avoid full retraining.' },
      mechanism: { dimension: 'conditional adaptation', description: 'Condition instead of retraining.' },
      tradeoff: { dimension: 'condition estimation', description: 'Requires a condition estimate.' },
      confidence: 0.86
    }
  });

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'researchstudio-operation-test',
    indexedAt: new Date().toISOString(),
    paperCount: 3,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'researchstudio-operation-test',
    rootPath,
    inputPath: rootPath,
    sources: []
  });
  return rootPath;
}

test('structural gap analysis separates frontier additions from cross-paper subtractive assumptions', () => {
  const result = compileStructuralGapAnalysis({
    materialPack: materialPackFixture(),
    gapMap: gapMapFixture(),
    methodLineage: methodLineageFixture()
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.sequence_contract.direct_topic_to_pattern_allowed, false);
  assert.equal(result.frontier_leaf_status.global_leaf_proven, false);
  assert.equal(result.frontier_leaf_status.candidates[0].method_id, 'method:future');
  assert.ok(result.additive_gaps.some((gap) => gap.source_gap_ids.includes('gap:representation')));
  assert.equal(result.persistent_assumptions.length, 1);
  assert.equal(result.persistent_assumptions[0].distinct_paper_count, 2);
  assert.equal(result.persistent_assumptions[0].lineage_generation_count, 2);
  assert.equal(result.subtractive_gaps[0].gap_kind, 'subtractive');
  assert.ok(result.historical_regression_watchlist.some((entry) => entry.protected_capability.includes('boundary information loss')));
});

test('structural persistence deduplicates the same paper repeated across material roles', () => {
  const pack = materialPackFixture();
  pack.groups[1].items = pack.groups[1].items.filter((item) => item.paper_id === 'paper:current');
  const result = compileStructuralGapAnalysis({
    materialPack: pack,
    gapMap: gapMapFixture(),
    methodLineage: methodLineageFixture()
  });

  assert.equal(result.persistent_assumptions.length, 0);
  assert.equal(result.observed_nonpersistent_assumptions[0].distinct_paper_count, 1);
  assert.equal(result.subtractive_gaps.length, 0);
});

test('sparse and unresolved evidence stays starved without manufacturing a gap', () => {
  const result = compileStructuralGapAnalysis({
    materialPack: { groups: [] },
    gapMap: [],
    methodLineage: {
      query: 'Ambiguous Method',
      matchedMethod: null,
      lineages: [],
      nextGapCandidates: [],
      diagnostics: { ambiguity: 'ambiguous_method' }
    }
  });

  assert.equal(result.status, 'starved');
  assert.equal(result.data_starvation.status, 'starved');
  assert.equal(result.sequence_contract.pattern_matching_allowed, false);
  assert.equal(result.additive_gaps.length, 0);
  assert.equal(result.subtractive_gaps.length, 0);
  assert.ok(result.reason_codes.includes('structural_gap_not_established'));
  assert.ok(result.reason_codes.includes('method_lineage_ambiguous_method'));
});

test('pattern matching is gap-first and seed cards never claim empirical outcome backing', () => {
  assert.equal(RESEARCHSTUDIO_SEED_PATTERN_CARDS.length, 15);
  assert.ok(RESEARCHSTUDIO_SEED_PATTERN_CARDS.every((card) => (
    card.evidence_origin.source_type === 'seed_taxonomy'
    && card.evidence_origin.empirical_outcome_backed === false
  )));

  const structural = compileStructuralGapAnalysis({
    materialPack: materialPackFixture(),
    gapMap: gapMapFixture(),
    methodLineage: methodLineageFixture()
  });
  const patterns = compileInnovationPatternAnalysis({ structuralGapAnalysis: structural });
  assert.equal(patterns.status, 'ready_for_mechanism_instantiation');
  assert.equal(patterns.outcome_evidence_status, 'seed_taxonomy_only');
  assert.ok(patterns.matches.length > 0);
  assert.ok(patterns.matches.every((match) => match.structural_gap_id));
  assert.ok(patterns.matches.some((match) => match.pattern_id === 'rs-audit-flip-assumption'));

  const blocked = compileInnovationPatternAnalysis({
    structuralGapAnalysis: { additive_gaps: [], subtractive_gaps: [] }
  });
  assert.equal(blocked.status, 'blocked_no_structural_gap');
  assert.equal(blocked.matches.length, 0);
});

test('caller outcome cards require evidence refs before empirical backing is retained', () => {
  const structural = compileStructuralGapAnalysis({
    materialPack: materialPackFixture(),
    gapMap: gapMapFixture(),
    methodLineage: methodLineageFixture()
  });
  const patterns = compileInnovationPatternAnalysis({
    structuralGapAnalysis: structural,
    args: {
      patternCards: [{
        id: 'custom-outcome-card',
        name: 'Unverified outcome card',
        empiricalOutcomeBacked: true,
        gapKinds: ['additive'],
        gapTypes: ['mechanism_uncertainty'],
        researchAction: 'Run a custom action.'
      }]
    }
  });
  const card = patterns.pattern_cards.find((entry) => entry.pattern_id === 'custom-outcome-card');
  assert.equal(card.evidence_origin.empirical_outcome_backed, false);
  assert.ok(card.evidence_origin.boundary.includes('no evidence refs'));
});

test('idea traces, mechanism collision audit, and proposal handoff preserve boundaries', () => {
  const materialPack = materialPackFixture();
  const structural = compileStructuralGapAnalysis({
    materialPack,
    gapMap: gapMapFixture(),
    methodLineage: methodLineageFixture()
  });
  const patterns = compileInnovationPatternAnalysis({ structuralGapAnalysis: structural });
  const cards = attachResearchStudioTrace([{
    idea_id: 'idea:representation',
    gap: { gap_id: 'gap:representation', statement: 'Representation loses boundary information.' },
    failure_signature: 'Boundary information is lost under domain shift.',
    intervention: 'Replace the flat representation with a boundary-structured representation.',
    falsifier: 'No improvement on the boundary-shift slice under matched capacity.',
    what_is_agent_inferred: []
  }], structural, patterns);
  assert.equal(cards[0].researchstudio_trace.status, 'structural_gap_linked');
  assert.ok(cards[0].researchstudio_trace.pattern_applications.length > 0);

  const collision = compileMechanismCollisionAudit({
    materialPack,
    ideaCards: cards,
    structuralGapAnalysis: structural
  });
  assert.equal(collision.semantic_equivalence_checked, false);
  assert.equal(collision.novelty_claim_allowed, false);
  assert.ok(collision.candidate_audits[0].decomposed_search_queries.length > 0);
  assert.ok(collision.interpretation_limit.includes('does not establish semantic equivalence'));

  const handoff = buildProposalGraphHandoff({
    structuralGapAnalysis: structural,
    innovationPatternAnalysis: patterns,
    mechanismCollisionAudit: collision,
    ideaCards: cards
  });
  assert.equal(handoff.target_operation, 'proposal_graph_session');
  assert.equal(handoff.episode_local, true);
  assert.equal(handoff.raw_graph_mutation, false);
  assert.ok(handoff.evidence_export.structural_gap_refs.length > 0);
  assert.ok(handoff.evidence_export.pattern_applications.length > 0);
  assert.equal(handoff.evidence_export.mechanism_collision_audits[0].semantic_equivalence_checked, false);
});

test('agent_materials exposes structural and pattern packs and integrates their trace into innovation evidence', async () => {
  const rootPath = await createResearchStudioCorpus();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-researchstudio-output-'));
  try {
    const common = {
      corpus: rootPath,
      project: 'ResearchStudioOperationTest',
      targetDomain: 'Domain Adaptation',
      targetProblem: 'Boundary information is lost under domain shift',
      method: 'Current Boundary Method',
      limit: 8
    };
    const structural = await executeAgentMaterialsTool({
      ...common,
      operation: 'structural_gap_pack'
    });
    assert.equal(structural.operation, 'structural_gap_pack');
    assert.equal(structural.method_lineage.matchedMethod.methodName, 'Current Boundary Method');
    assert.ok(structural.additive_gaps.length > 0);
    assert.equal(structural.persistent_assumptions[0].distinct_paper_count, 2);
    assert.equal(structural.subtractive_gaps.length, 1);
    assert.equal(structural.frontier_leaf_status.global_leaf_proven, false);

    const patterns = await executeAgentMaterialsTool({
      ...common,
      operation: 'innovation_pattern_pack'
    });
    assert.equal(patterns.operation, 'innovation_pattern_pack');
    assert.ok(patterns.matches.length > 0);
    assert.ok(patterns.matches.every((match) => match.structural_gap_id));
    assert.equal(patterns.outcome_evidence_status, 'seed_taxonomy_only');

    const innovation = await executeAgentMaterialsTool({
      ...common,
      operation: 'innovation_evidence_pack',
      outputDir
    });
    assert.equal(innovation.policy.researchstudio_order_enforced, true);
    assert.equal(innovation.structural_gap_analysis.frontier_leaf_status.global_leaf_proven, false);
    assert.equal(innovation.innovation_pattern_analysis.policy.direct_topic_to_pattern_allowed, false);
    assert.equal(innovation.mechanism_collision_audit.semantic_equivalence_checked, false);
    assert.equal(innovation.proposal_graph_handoff.raw_graph_mutation, false);
    assert.ok(innovation.idea_evidence_cards.every((card) => card.researchstudio_trace));
    await fs.access(innovation.exports.structural_gap_analysis_path);
    await fs.access(innovation.exports.innovation_pattern_analysis_path);
    await fs.access(innovation.exports.mechanism_collision_audit_path);
    await fs.access(innovation.exports.proposal_graph_handoff_path);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
