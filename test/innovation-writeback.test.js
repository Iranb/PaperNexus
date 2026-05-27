import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { stableHash } from '../src/lib/utils.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import {
  buildInnovationArtifactGraphMutations,
  INNOVATION_WRITEBACK_CONTRACT_VERSION
} from '../src/core/graph/innovation-writeback.js';
import { applyGraphMutations } from '../src/core/graph/mutations.js';
import { NODE_TYPES } from '../src/core/graph/schema.js';

const execFileAsync = promisify(execFile);

const noveltyReasonAxes = [
  'novelty',
  'significance',
  'feasibility',
  'grounding',
  'must_cite_completeness',
  'temporal_validity'
];

function noveltyAxisReasons() {
  return noveltyReasonAxes.map((axis) => ({
    axis,
    reason: `${axis} is supported by the writeback fixture.`
  }));
}

function sampleArtifact() {
  return {
    innovation_contract_version: 'papernexus-innovation-artifacts-v1',
    packet_version: 'idea-catalyst-packet-bundle-v2',
    run_id: 'run:writeback-fixture',
    trace_id: 'trace:writeback-fixture',
    research_problem: 'grounded idea generation',
    target_domain: 'scientific discovery',
    source_spans: [{
      span_id: 'span:prior-method',
      paper_key: 'paper:prior-method',
      paper_title: 'Prior Method Paper',
      section: 'Method',
      text: 'Prior method evidence supports the bridge mechanism.'
    }],
    contribution_claims: [{
      claim_id: 'claim:bridge',
      claim_type: 'contribution',
      claim_text: 'Bridge mechanism improves grounded idea generation.',
      source_domain: 'retrieval',
      source_span_ids: ['span:prior-method'],
      citation_context_ids: ['citation-context:prior-method'],
      supporting_paper_keys: ['paper:prior-method'],
      confidence: 0.82,
      writeback_policy: 'optional_graph_writeback'
    }],
    must_cite_set: [{
      citation_id: 'mustcite:prior-method',
      paper_key: 'paper:prior-method',
      title: 'Prior Method Paper',
      obligation_type: 'baseline_or_method_anchor',
      evidence_span_ids: ['span:prior-method'],
      temporal_status: 'valid',
      coverage_status: 'covered'
    }],
    novelty_certificate: {
      certificate_id: 'novelty:writeback-fixture',
      certificate_version: 'novelty-certificate-v1',
      novelty: 0.76,
      significance: 0.74,
      feasibility: 0.8,
      grounding: 0.82,
      must_cite_completeness: 1,
      temporal_validity: 1,
      claim_count: 1,
      future_leakage_count: 0,
      unsupported_claim_count: 0,
      must_cite_count: 1,
      reasons: noveltyAxisReasons(),
      time_cutoff: '2025-12-31'
    },
    review_packet: {
      reviewers: [
        {
          reviewer_id: 'reviewer:novelty',
          role: 'novelty',
          score: 0.78,
          concerns: [],
          summary: 'Novelty is plausible.'
        },
        {
          reviewer_id: 'reviewer:methods',
          role: 'methods',
          score: 0.74,
          concerns: [],
          summary: 'Method transfer is plausible.'
        },
        {
          reviewer_id: 'reviewer:reproducibility',
          role: 'reproducibility',
          score: 0.7,
          concerns: ['concern:grounding'],
          summary: 'Held-out replay is required.'
        },
        {
          reviewer_id: 'reviewer:outsider',
          role: 'outsider',
          score: 0.72,
          concerns: [],
          summary: 'The storyline is readable outside the source domain.'
        }
      ],
      meta_review: {
        recommendation: 'weak_accept',
        major_concern_count: 0,
        summary: 'Structured review found no blocking concern.'
      },
      major_concerns: [{
        concern_id: 'concern:grounding',
        reviewer_role: 'reproducibility',
        severity: 'minor',
        concern: 'Grounding should be checked in a held-out replay.',
        affected_claim_ids: ['claim:bridge'],
        evidence_gap: 'benchmark_replay',
        addressed: false
      }]
    },
    storyline_dag: {
      beats: [
        {
          beat_id: 'beat:1:problem',
          beat_type: 'problem',
          text: 'Research problem',
          claim_ids: ['claim:bridge'],
          trace_refs: [{ kind: 'claim', id: 'claim:bridge', text: 'Bridge claim' }],
          supported: true
        },
        {
          beat_id: 'beat:2:risk',
          beat_type: 'risk',
          text: 'Replay risk',
          review_concern_ids: ['concern:grounding'],
          trace_refs: [{ kind: 'review_concern', id: 'concern:grounding', text: 'Replay concern' }],
          supported: true
        }
      ],
      edges: [{
        source_beat_id: 'beat:1:problem',
        target_beat_id: 'beat:2:risk',
        relation: 'precedes'
      }]
    },
    counterfactuals: [{
      falsification_plan_id: 'falsification:bridge',
      claim_id: 'claim:bridge',
      question: 'Does the bridge still help when the prior method baseline is stronger?',
      required_evidence: ['baseline_comparison'],
      status: 'planned'
    }]
  };
}

test('innovation writeback emits schema-valid dry-run mutation operations', () => {
  const payload = buildInnovationArtifactGraphMutations(sampleArtifact(), {
    actor: 'writeback-test'
  });

  assert.equal(payload.contractVersion, INNOVATION_WRITEBACK_CONTRACT_VERSION);
  assert.equal(payload.writebackStatus, 'ready');
  assert.ok(payload.operations.length > 0);
  assert.ok(payload.nodes.some((operation) => operation.type === NODE_TYPES.CONTRIBUTION_CLAIM));
  const noveltyCertificate = payload.nodes.find((operation) => operation.type === NODE_TYPES.NOVELTY_CLAIM);
  assert.ok(noveltyCertificate);
  assert.equal(noveltyCertificate.properties.reasonCount, 6);
  assert.deepEqual(noveltyCertificate.properties.reasonAxes, noveltyReasonAxes);
  assert.deepEqual(noveltyCertificate.properties.axisReasons.map((entry) => entry.axis), noveltyReasonAxes);
  assert.equal(noveltyCertificate.properties.temporalValidity, 1);
  assert.ok(payload.nodes.some((operation) => operation.type === NODE_TYPES.REVIEW_ASPECT && operation.properties.reviewAspectType === 'reviewer'));
  assert.ok(payload.nodes.some((operation) => operation.type === NODE_TYPES.REVIEW_ASPECT && operation.properties.reviewAspectType === 'meta_review'));
  assert.ok(payload.nodes.some((operation) => operation.type === NODE_TYPES.REVIEW_CONCERN));
  assert.ok(payload.nodes.some((operation) => operation.type === NODE_TYPES.STORY_BEAT));
  const evidenceSnippet = payload.nodes.find((operation) => (
    operation.type === NODE_TYPES.EVIDENCE_SNIPPET
    && operation.properties.sourceSpanId === 'span:prior-method'
  ));
  assert.equal(evidenceSnippet.properties.licenseScope, 'derived_snippet_research_use');
  assert.ok(evidenceSnippet.properties.evidenceHash);
  assert.equal(evidenceSnippet.properties.sourceAnchor, 'paper:prior-method#span:prior-method');
  assert.ok(payload.relationships.some((operation) => operation.edgeType === 'CITES_FOR_BASELINE'));
  assert.ok(payload.relationships.some((operation) => operation.edgeType === 'HAS_FALSIFICATION_PLAN'));
  assert.ok(payload.relationships.some((operation) => (
    operation.sourceId === noveltyCertificate.id
    && operation.edgeType === 'DERIVED_FROM_VERSION'
  )));
  assert.ok(payload.relationships.some((operation) => (
    operation.sourceId === noveltyCertificate.id
    && operation.edgeType === 'VALID_DURING'
  )));
  assert.ok(payload.relationships.some((operation) => (
    operation.edgeType === 'RAISES_CONCERN'
    && operation.properties.reviewerRole === 'reproducibility'
  )));
  assert.ok(payload.relationships.some((operation) => (
    operation.edgeType === 'FORMS_BEAT'
    && operation.sourceId === 'claim:bridge'
    && operation.targetId === 'beat:1:problem'
  )));
  assert.ok(payload.relationships.some((operation) => (
    operation.edgeType === 'FORMS_BEAT'
    && operation.sourceId === 'concern:grounding'
    && operation.targetId === 'beat:2:risk'
  )));

  const graph = createKnowledgeGraph();
  const applied = applyGraphMutations(graph, payload.operations, {
    actor: 'writeback-test',
    dryRun: true
  });
  assert.equal(graph.nodeCount, 0);
  assert.equal(applied.graph.nodes.some((node) => node.type === NODE_TYPES.CONTRIBUTION_CLAIM), true);
  assert.equal(applied.graph.relationships.some((relationship) => relationship.type === 'PRECEDES_BEAT'), true);
});

test('innovation writeback resolves generated storyline takeaway trace ids', () => {
  const artifact = sampleArtifact();
  const takeawayText = 'Reflective prompts stabilize belief updating';
  const generatedTakeawayTraceId = `takeaway:${stableHash(takeawayText, 12)}`;
  artifact.source_domain_analyses = [{
    source_domain: 'Psychology',
    takeaways: [{
      concept: takeawayText,
      source_logic: 'A pause before feedback helps users revise beliefs.'
    }]
  }];
  artifact.storyline_dag.beats.push({
    beat_id: 'beat:3:bridge_principle',
    beat_type: 'bridge_principle',
    text: 'Bridge via reflective prompts.',
    takeaway_ids: [generatedTakeawayTraceId],
    trace_refs: [{
      kind: 'takeaway',
      id: generatedTakeawayTraceId,
      text: takeawayText,
      source: 'source_domain_analysis'
    }],
    supported: true
  });
  artifact.storyline_dag.edges.push({
    source_beat_id: 'beat:2:risk',
    target_beat_id: 'beat:3:bridge_principle',
    relation: 'precedes'
  });

  const payload = buildInnovationArtifactGraphMutations(artifact, {
    actor: 'writeback-test'
  });

  assert.equal(payload.writebackStatus, 'ready');
  assert.equal(payload.warnings.some((entry) => entry.code === 'invalid_storyline_dag_block_writeback'), false);
  assert.ok(payload.relationships.some((operation) => (
    operation.edgeType === 'FORMS_BEAT'
    && operation.targetId === 'beat:3:bridge_principle'
    && operation.sourceId.startsWith('takeaway:')
  )));
});

test('innovation writeback blocks ungrounded artifacts by default', () => {
  const artifact = sampleArtifact();
  artifact.contribution_claims[0].source_span_ids = [];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  assert.equal(payload.warnings.some((warning) => warning.code === 'ungrounded_claims_block_writeback'), true);
});

test('innovation writeback blocks claim span ids that lack source span records', () => {
  const artifact = sampleArtifact();
  artifact.source_spans = [];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'missing_source_span_records_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.missing_source_span_refs, [{
    claim_id: 'claim:bridge',
    source_span_id: 'span:prior-method'
  }]);
});

test('innovation writeback blocks source-backed must-cite entries without evidence refs', () => {
  const artifact = sampleArtifact();
  artifact.evidence_status = 'source_backed';
  artifact.must_cite_set[0] = {
    citation_id: 'mustcite:metadata-only',
    paper_key: 'paper:prior-method',
    title: 'Prior Method Paper',
    obligation_type: 'baseline_or_method_anchor',
    temporal_status: 'valid',
    coverage_status: 'covered'
  };
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_must_cite_set_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.ungrounded_citation_ids, ['mustcite:metadata-only']);
});

test('innovation writeback blocks source-backed must-cite entries with stale evidence refs', () => {
  const artifact = sampleArtifact();
  artifact.evidence_status = 'source_backed';
  artifact.must_cite_set[0].evidence_span_ids = ['span:missing'];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_must_cite_set_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_evidence_refs, [{
    citation_id: 'mustcite:prior-method',
    evidence_ref_id: 'span:missing'
  }]);
});

test('innovation writeback blocks must-cite entries that cannot link to any claim', () => {
  const artifact = sampleArtifact();
  artifact.evidence_status = 'source_backed';
  artifact.source_spans.push({
    span_id: 'span:unlinked-prior',
    paper_key: 'paper:unlinked-prior',
    paper_title: 'Unlinked Prior Art',
    text: 'This prior art is not tied to any contribution claim.'
  });
  artifact.must_cite_set[0] = {
    citation_id: 'mustcite:unlinked',
    paper_key: 'paper:unlinked-prior',
    title: 'Unlinked Prior Art',
    obligation_type: 'baseline_or_method_anchor',
    source_span_ids: ['span:unlinked-prior'],
    temporal_status: 'valid',
    coverage_status: 'covered'
  };
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_must_cite_set_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unlinked_entries, [{
    citation_id: 'mustcite:unlinked',
    paper_key: 'paper:unlinked-prior'
  }]);
});

test('innovation writeback blocks incomplete review packets by default', () => {
  const artifact = sampleArtifact();
  artifact.review_packet.reviewers = [{ reviewer_id: 'reviewer:novelty', role: 'novelty' }];
  artifact.review_packet.meta_review = {};
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_review_packet_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.missing_reviewer_roles, ['methods', 'reproducibility', 'outsider']);
  assert.equal(warning.missing_meta_review, true);
});

test('innovation writeback blocks unresolved reviewer concern refs by default', () => {
  const artifact = sampleArtifact();
  artifact.review_packet.reviewers[0].concerns = ['concern:missing'];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_review_packet_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_reviewer_concern_refs, [{
    reviewer_id: 'reviewer:novelty',
    concern_id: 'concern:missing'
  }]);
});

test('innovation writeback blocks review concern roles outside the reviewer panel', () => {
  const artifact = sampleArtifact();
  artifact.review_packet.major_concerns[0].reviewer_role = 'ghost';
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_review_packet_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.invalid_concern_reviewer_roles, [{
    concern_id: 'concern:grounding',
    reviewer_role: 'ghost'
  }]);
});

test('innovation writeback blocks stale affected claim refs in review concerns', () => {
  const artifact = sampleArtifact();
  artifact.review_packet.major_concerns[0].affected_claim_ids = ['claim:missing'];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_review_packet_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_affected_claim_refs, [{
    concern_id: 'concern:grounding',
    claim_id: 'claim:missing'
  }]);
});

test('innovation writeback blocks weak meta-review decisions when major concerns remain unresolved', () => {
  const artifact = sampleArtifact();
  artifact.review_packet.major_concerns[0].severity = 'major';
  artifact.review_packet.major_concerns[0].addressed = false;
  artifact.review_packet.meta_review.recommendation = 'weak_accept';
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_review_packet_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.invalid_meta_review_major_concern_ids, ['concern:grounding']);
});

test('innovation writeback blocks stale falsification plan claim refs', () => {
  const artifact = sampleArtifact();
  artifact.counterfactuals[0].claim_id = 'claim:missing';
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_falsification_plans_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_claim_refs, [{
    falsification_plan_id: 'falsification:bridge',
    claim_id: 'claim:missing'
  }]);
});

test('innovation writeback blocks incomplete falsification plans', () => {
  const artifact = sampleArtifact();
  delete artifact.counterfactuals[0].claim_id;
  artifact.counterfactuals[0].question = '';
  artifact.counterfactuals[0].required_evidence = [];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_falsification_plans_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.invalid_plans, [{
    falsification_plan_id: 'falsification:bridge',
    missing_claim_ref: true,
    missing_question: true,
    missing_required_evidence: true
  }]);
});

test('innovation writeback resolves unprefixed falsification plan claim ids', () => {
  const artifact = sampleArtifact();
  artifact.contribution_claims[0].claim_id = 'bridge';
  artifact.storyline_dag.beats[0].claim_ids = ['bridge'];
  artifact.storyline_dag.beats[0].trace_refs = [{ kind: 'claim', id: 'bridge', text: 'Bridge claim' }];
  artifact.review_packet.major_concerns[0].affected_claim_ids = ['bridge'];
  artifact.counterfactuals[0].claim_id = 'bridge';
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'ready');
  assert.ok(payload.relationships.some((operation) => (
    operation.edgeType === 'HAS_FALSIFICATION_PLAN'
    && operation.targetId === 'falsification:bridge'
  )));
});

test('innovation writeback blocks stale storyline claim trace refs', () => {
  const artifact = sampleArtifact();
  artifact.storyline_dag.beats[0].claim_ids = [];
  artifact.storyline_dag.beats[0].trace_refs = [{ kind: 'claim', id: 'claim:missing' }];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'invalid_storyline_dag_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_trace_refs, [{
    beat_id: 'beat:1:problem',
    trace_type: 'claim',
    trace_id: 'claim:missing'
  }]);
});

test('innovation writeback blocks stale storyline review concern ids', () => {
  const artifact = sampleArtifact();
  artifact.storyline_dag.beats[1].review_concern_ids = ['concern:missing'];
  artifact.storyline_dag.beats[1].trace_refs = [];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'invalid_storyline_dag_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.unresolved_trace_refs, [{
    beat_id: 'beat:2:risk',
    trace_type: 'review_concern',
    trace_id: 'concern:missing'
  }]);
});

test('innovation writeback blocks invalid storyline edge refs', () => {
  const artifact = sampleArtifact();
  artifact.storyline_dag.edges[0].target_beat_id = 'beat:missing';
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'invalid_storyline_dag_block_writeback');
  assert.ok(warning);
  assert.equal(warning.invalid_edge_count, 1);
});

test('innovation writeback blocks undeclared unsupported story beats', () => {
  const artifact = sampleArtifact();
  artifact.storyline_dag.beats[0].supported = false;
  artifact.storyline_dag.unsupported_beats = [];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'invalid_storyline_dag_block_writeback');
  assert.ok(warning);
  assert.deepEqual(warning.undeclared_unsupported_beat_ids, ['beat:1:problem']);
});

test('innovation writeback blocks missing novelty certificates by default', () => {
  const artifact = sampleArtifact();
  delete artifact.novelty_certificate;
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  assert.equal(payload.warnings.some((warning) => warning.code === 'missing_novelty_certificate_block_writeback'), true);
});

test('innovation writeback blocks incomplete novelty certificates by default', () => {
  const artifact = sampleArtifact();
  artifact.novelty_certificate.reasons = [];
  artifact.novelty_certificate.temporal_validity = 0;
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_novelty_certificate_block_writeback');
  assert.ok(warning);
  assert.equal(warning.reason_count, 0);
  assert.equal(warning.temporal_validity, 0);
});

test('innovation writeback blocks novelty certificates missing axis-level reasons', () => {
  const artifact = sampleArtifact();
  artifact.novelty_certificate.reasons = ['The bridge claim is grounded in a valid source span.'];
  const payload = buildInnovationArtifactGraphMutations(artifact);

  assert.equal(payload.writebackStatus, 'blocked');
  assert.deepEqual(payload.operations, []);
  const warning = payload.warnings.find((entry) => entry.code === 'incomplete_novelty_certificate_block_writeback');
  assert.ok(warning);
  assert.equal(warning.reason_count, 1);
  assert.deepEqual(warning.missing_reason_axes, noveltyReasonAxes);
});

test('innovation writeback CLI writes mutation preview artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-innovation-writeback-'));
  try {
    const inputPath = path.join(tempRoot, 'artifact.json');
    const outputPath = path.join(tempRoot, 'writeback.json');
    await fs.writeFile(inputPath, `${JSON.stringify(sampleArtifact(), null, 2)}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-innovation-writeback.mjs'),
      '--input-path', inputPath,
      '--output-path', outputPath,
      '--actor', 'writeback-cli-test'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, INNOVATION_WRITEBACK_CONTRACT_VERSION);
    assert.equal(summary.writeback_status, 'ready');
    assert.ok(summary.operation_count > 0);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.provenance.policy, 'dry_run_first');
    assert.equal(payload.relationships.some((operation) => operation.edgeType === 'SUPPORTED_BY'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
