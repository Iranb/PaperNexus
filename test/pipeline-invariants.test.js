import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateGraphReadyInvariant,
  validateIdeaCatalystEvidenceExportInvariant,
  validateLlmEnhancedInvariant,
  validatePipelineInvariants,
  validateProjectionReadyInvariant,
  validateQueueCompletedInvariant
} from '../src/core/control/pipeline-invariants.js';

test('pipeline invariants reject ready states without receipts, ledgers, and terminal reports', () => {
  assert.equal(validateLlmEnhancedInvariant({ llm_enhanced: true }).ok, false);
  assert.equal(validateGraphReadyInvariant({ graph_ready: true }).ok, false);
  assert.equal(validateProjectionReadyInvariant({
    projection_ready: true,
    projection_graph_generation: 3,
    kuzu_commit_receipt: { graph_generation: 4 }
  }).ok, false);
  assert.equal(validateQueueCompletedInvariant({
    status: 'completed',
    failed_paper_count: 1,
    terminal_report_path: 'terminal.json'
  }).ok, false);
});

test('pipeline invariant summary accepts verified graph and source-backed Idea-Catalyst export', () => {
  const summary = validatePipelineInvariants({
    paper: {
      status: 'completed',
      parseArtifactPath: 'paper.md'
    },
    llm: {
      llm_enhanced: true,
      llm_ledger_refs: [{ ledger_dir: '.papernexus/llm-jobs/test' }]
    },
    graph: {
      graph_ready: true,
      kuzu_commit_receipt: {
        status: 'committed',
        graph_generation: 7,
        verification_queries: [{ name: 'paper_node_visible', status: 'passed', row_count: 1 }]
      }
    },
    projection: {
      projection_ready: true,
      projection_graph_generation: 7,
      kuzu_commit_receipt: {
        graph_generation: 7
      }
    },
    mcp: {
      mcp_research_lookup_ready: true,
      graph_generation: 7
    },
    queue: {
      status: 'completed',
      terminal_report_path: 'terminal.json'
    },
    idea_catalyst_export: {
      evidence_status: 'source_backed',
      idea_fragments: [{ id: 'fragment:1' }],
      source_spans: [{ paper_key: 'paper:1', text: 'evidence' }]
    }
  });

  assert.equal(validateIdeaCatalystEvidenceExportInvariant({
    evidence_status: 'source_backed',
    idea_fragments: [{ id: 'fragment:1' }],
    supporting_papers: [{ paper_key: 'paper:1' }]
  }).ok, true);
  assert.equal(summary.ok, true);
  assert.equal(summary.violation_count, 0);
});
