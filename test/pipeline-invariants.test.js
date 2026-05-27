import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateContributionClaimGroundingInvariant,
  validateContributionClaimProvenanceInvariant,
  validateFalsificationPlanInvariant,
  validateGraphReadyInvariant,
  validateIdeaCatalystEvidenceExportInvariant,
  validateLlmEnhancedInvariant,
  validateMustCiteInvariant,
  validateNoveltyCertificateInvariant,
  validatePipelineInvariants,
  validateProjectionReadyInvariant,
  validateReviewConcernProvenanceInvariant,
  validateReviewPacketInvariant,
  validateStoryBeatProvenanceInvariant,
  validateStorylineCoverageInvariant,
  validateQueueCompletedInvariant
} from '../src/core/control/pipeline-invariants.js';

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
    reason: `${axis} is explained for this fixture.`
  }));
}

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
      source_spans: [{
        span_id: 'span:1',
        paper_key: 'paper:1',
        text: 'evidence',
        license_scope: 'research evaluation',
        evidence_hash: 'hash-span-1'
      }],
      contribution_claims: [{
        claim_id: 'claim:1',
        claim_text: 'A source-backed contribution.',
        source_span_ids: ['span:1'],
        provenance_ref: 'prov:claim-1'
      }],
      provenance_refs: [{
        provenance_id: 'prov:claim-1',
        generated_by_activity: 'idea_catalyst_claim_evidence_export',
        output_hash: 'hash-claim-1'
      }, {
        provenance_id: 'prov:concern-1',
        generated_by_activity: 'idea_catalyst_review_evidence_export',
        concern_id: 'concern:1',
        output_hash: 'hash-concern-1'
      }, {
        provenance_id: 'prov:beat-1',
        generated_by_activity: 'idea_catalyst_storybeat_evidence_export',
        beat_id: 'beat:1',
        output_hash: 'hash-beat-1'
      }],
      must_cite_set: [{
        citation_id: 'mustcite:1',
        title: 'Prior Art',
        evidence_span_ids: ['span:1']
      }],
      novelty_certificate: {
        novelty: 0.7,
        significance: 0.8,
        feasibility: 0.6,
        grounding: 1,
        must_cite_completeness: 1,
        temporal_validity: 1,
        reasons: noveltyAxisReasons()
      },
      review_packet: {
        reviewers: [
          { reviewer_id: 'reviewer:novelty', role: 'novelty' },
          { reviewer_id: 'reviewer:methods', role: 'methods' },
          { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
          { reviewer_id: 'reviewer:outsider', role: 'outsider' }
        ],
        meta_review: { recommendation: 'weak_accept' },
        major_concerns: [{
          concern_id: 'concern:1',
          reviewer_role: 'methods',
          severity: 'minor',
          concern: 'Validate the claim under a stronger baseline.',
          affected_claim_ids: ['claim:1'],
          addressed: false,
          provenance_ref: 'prov:concern-1'
        }]
      },
      storyline_dag: {
        beats: [{
          beat_id: 'beat:1',
          supported: true,
          trace_refs: [{ kind: 'claim', id: 'claim:1' }],
          claim_ids: ['claim:1'],
          review_concern_ids: ['concern:1'],
          provenance_ref: 'prov:beat-1'
        }],
        edges: [],
        unsupported_beats: []
      },
      counterfactuals: [{
        falsification_plan_id: 'falsification:1',
        claim_id: 'claim:1',
        question: 'Would the claim still hold under a stronger baseline?',
        required_evidence: ['baseline_comparison'],
        status: 'planned'
      }]
    }
  });

  assert.equal(validateIdeaCatalystEvidenceExportInvariant({
    evidence_status: 'source_backed',
    idea_fragments: [{ id: 'fragment:1' }],
    supporting_papers: [{
      paper_key: 'paper:1',
      license_scope: 'research evaluation',
      evidence_hash: 'hash-paper-1'
    }]
  }).ok, true);
  assert.equal(validateIdeaCatalystEvidenceExportInvariant({
    evidence_status: 'source_backed',
    idea_fragments: [{ id: 'fragment:1' }],
    source_spans: [{ paper_key: 'paper:1', text: 'metadata without audit fields' }]
  }).ok, false);
  assert.equal(summary.ok, true);
  assert.equal(summary.violation_count, 0);
});

test('idea catalyst v2 invariants catch ungrounded claims and storyline coverage gaps', () => {
  assert.equal(validateContributionClaimGroundingInvariant({
    evidence_status: 'source_backed',
    contribution_claims: [{ claim_id: 'claim:missing', claim_text: 'Ungrounded claim.' }]
  }).ok, false);
  assert.equal(validateContributionClaimProvenanceInvariant({
    evidence_status: 'source_backed',
    contribution_claims: [{
      claim_id: 'claim:no-prov',
      source_span_ids: ['span:1']
    }],
    provenance_refs: []
  }).ok, false);
  assert.equal(validateContributionClaimProvenanceInvariant({
    evidence_status: 'source_backed',
    contribution_claims: [{
      claim_id: 'claim:stale-prov',
      source_span_ids: ['span:1'],
      provenance_ref: 'prov:missing'
    }],
    provenance_refs: [{ provenance_id: 'prov:claim-1' }]
  }).ok, false);
  assert.equal(validateContributionClaimProvenanceInvariant({
    evidence_status: 'source_backed',
    contribution_claims: [{
      claim_id: 'claim:resolved-prov',
      source_span_ids: ['span:1'],
      provenance_ref: 'prov:claim-1'
    }],
    provenance_refs: [{ provenance_id: 'prov:claim-1' }]
  }).ok, true);
  assert.equal(validateReviewConcernProvenanceInvariant({
    evidence_status: 'source_backed',
    review_packet: {
      major_concerns: [{
        concern_id: 'concern:no-prov',
        reviewer_role: 'methods',
        severity: 'minor',
        concern: 'Missing provenance.',
        addressed: false
      }]
    },
    provenance_refs: []
  }).ok, false);
  assert.equal(validateReviewConcernProvenanceInvariant({
    evidence_status: 'source_backed',
    review_packet: {
      major_concerns: [{
        concern_id: 'concern:stale-prov',
        reviewer_role: 'methods',
        severity: 'minor',
        concern: 'Stale provenance.',
        addressed: false,
        provenance_ref: 'prov:concern-1'
      }]
    },
    provenance_refs: [{
      provenance_id: 'prov:concern-1',
      generated_by_activity: 'idea_catalyst_review_evidence_export',
      concern_id: 'concern:other'
    }]
  }).ok, false);
  assert.equal(validateReviewConcernProvenanceInvariant({
    evidence_status: 'source_backed',
    review_packet: {
      major_concerns: [{
        concern_id: 'concern:resolved-prov',
        reviewer_role: 'methods',
        severity: 'minor',
        concern: 'Resolved provenance.',
        addressed: false,
        provenance_ref: 'prov:concern-1'
      }]
    },
    provenance_refs: [{
      provenance_id: 'prov:concern-1',
      generated_by_activity: 'idea_catalyst_review_evidence_export',
      concern_id: 'concern:resolved-prov'
    }]
  }).ok, true);
  assert.equal(validateStoryBeatProvenanceInvariant({
    evidence_status: 'source_backed',
    storyline_dag: {
      beats: [{
        beat_id: 'beat:no-prov',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:1' }]
      }]
    },
    provenance_refs: []
  }).ok, false);
  assert.equal(validateStoryBeatProvenanceInvariant({
    evidence_status: 'source_backed',
    storyline_dag: {
      beats: [{
        beat_id: 'beat:stale-prov',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:1' }],
        provenance_ref: 'prov:beat-1'
      }]
    },
    provenance_refs: [{
      provenance_id: 'prov:beat-1',
      generated_by_activity: 'idea_catalyst_storybeat_evidence_export',
      beat_id: 'beat:other'
    }]
  }).ok, false);
  assert.equal(validateStoryBeatProvenanceInvariant({
    evidence_status: 'source_backed',
    storyline_dag: {
      beats: [{
        beat_id: 'beat:resolved-prov',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:1' }],
        provenance_ref: 'prov:beat-1'
      }]
    },
    provenance_refs: [{
      provenance_id: 'prov:beat-1',
      generated_by_activity: 'idea_catalyst_storybeat_evidence_export',
      beat_id: 'beat:resolved-prov'
    }]
  }).ok, true);
  const unresolvedClaim = validateContributionClaimGroundingInvariant({
    evidence_status: 'source_backed',
    source_spans: [{
      span_id: 'span:1',
      paper_key: 'paper:1',
      text: 'evidence',
      license_scope: 'research evaluation',
      evidence_hash: 'hash-span-1'
    }],
    contribution_claims: [{
      claim_id: 'claim:unresolved',
      claim_text: 'A source-backed claim with a stale pointer.',
      source_span_ids: ['span:missing']
    }]
  });
  assert.equal(unresolvedClaim.ok, false);
  assert.deepEqual(unresolvedClaim.unresolved_source_span_refs, [{
    claim_id: 'claim:unresolved',
    source_span_id: 'span:missing'
  }]);
  assert.equal(validateContributionClaimGroundingInvariant({
    evidence_status: 'source_backed',
    source_spans: [{
      span_id: 'span:1',
      paper_key: 'paper:1',
      text: 'evidence',
      license_scope: 'research evaluation',
      evidence_hash: 'hash-span-1'
    }],
    contribution_claims: [{
      claim_id: 'claim:resolved',
      claim_text: 'A source-backed claim.',
      source_span_ids: ['span:1']
    }]
  }).ok, true);
  assert.equal(validateMustCiteInvariant({
    must_cite_set: [{ citation_id: 'mustcite:missing-title' }]
  }).ok, false);
  assert.equal(validateMustCiteInvariant({
    evidence_status: 'source_backed',
    must_cite_set: [{
      citation_id: 'mustcite:metadata-only',
      title: 'Metadata Only Prior Art'
    }]
  }).ok, false);
  const unresolvedMustCite = validateMustCiteInvariant({
    evidence_status: 'source_backed',
    source_spans: [{
      span_id: 'span:1',
      paper_key: 'paper:1',
      text: 'evidence',
      license_scope: 'research evaluation',
      evidence_hash: 'hash-span-1'
    }],
    must_cite_set: [{
      citation_id: 'mustcite:stale',
      title: 'Stale Prior Art',
      source_span_ids: ['span:missing']
    }]
  });
  assert.equal(unresolvedMustCite.ok, false);
  assert.deepEqual(unresolvedMustCite.unresolved_evidence_refs, [{
    citation_id: 'mustcite:stale',
    evidence_ref_id: 'span:missing'
  }]);
  assert.equal(validateMustCiteInvariant({
    evidence_status: 'source_backed',
    source_spans: [{
      span_id: 'span:1',
      paper_key: 'paper:1',
      text: 'evidence',
      license_scope: 'research evaluation',
      evidence_hash: 'hash-span-1'
    }],
    must_cite_set: [{
      citation_id: 'mustcite:resolved',
      title: 'Resolved Prior Art',
      source_span_ids: ['span:1']
    }]
  }).ok, true);
  assert.equal(validateNoveltyCertificateInvariant({
    novelty_certificate: {
      novelty: 1.4,
      significance: 0.5,
      feasibility: 0.5,
      grounding: 0.5,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      reasons: []
    }
  }).ok, false);
  assert.equal(validateNoveltyCertificateInvariant({
    novelty_certificate: {
      novelty: 0.5,
      significance: 0.5,
      feasibility: 0.5,
      grounding: 0.5,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: []
    }
  }).ok, false);
  const genericNoveltyReasons = validateNoveltyCertificateInvariant({
    novelty_certificate: {
      novelty: 0.5,
      significance: 0.5,
      feasibility: 0.5,
      grounding: 0.5,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: ['all claims are grounded']
    }
  });
  assert.equal(genericNoveltyReasons.ok, false);
  assert.deepEqual(genericNoveltyReasons.missing_reason_axes, noveltyReasonAxes);
  assert.equal(validateNoveltyCertificateInvariant({
    novelty_certificate: {
      novelty: 0.5,
      significance: 0.5,
      feasibility: 0.5,
      grounding: 0.5,
      must_cite_completeness: 0.5,
      temporal_validity: 1,
      future_leakage_count: 0,
      reasons: noveltyAxisReasons()
    }
  }).ok, true);
  assert.equal(validateNoveltyCertificateInvariant({
    novelty_certificate: {
      novelty: 0.5,
      significance: 0.5,
      feasibility: 0.5,
      grounding: 0.5,
      must_cite_completeness: 0.5,
      temporal_validity: 0,
      future_leakage_count: 1,
      reasons: ['1 must-cite entry violates the cutoff.']
    }
  }).ok, false);
  assert.equal(validateReviewPacketInvariant({
    review_packet: {
      reviewers: [{ reviewer_id: 'reviewer:novelty', role: 'novelty' }],
      meta_review: {},
      major_concerns: [{ concern: 'Missing id.' }]
    }
  }).ok, false);
  const validReviewPacket = validateReviewPacketInvariant({
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:1',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Claim lacks source-span grounding.',
        addressed: false
      }]
    }
  });
  assert.equal(validReviewPacket.ok, true);
  const nonBlockingMetaReview = validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'weak_accept' },
      major_concerns: [{
        concern_id: 'concern:blocking',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Major concern remains unresolved.',
        affected_claim_ids: ['claim:1'],
        addressed: false
      }]
    }
  });
  assert.equal(nonBlockingMetaReview.ok, false);
  assert.deepEqual(nonBlockingMetaReview.invalid_meta_review_major_concern_ids, ['concern:blocking']);
  const invalidConcernRole = validateReviewPacketInvariant({
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:ghost-role',
        reviewer_role: 'ghost',
        severity: 'major',
        concern: 'Concern is not owned by any reviewer role.',
        addressed: false
      }]
    }
  });
  assert.equal(invalidConcernRole.ok, false);
  assert.deepEqual(invalidConcernRole.invalid_concern_reviewer_roles, [{
    concern_id: 'concern:ghost-role',
    reviewer_role: 'ghost'
  }]);
  const staleReviewerConcernRef = validateReviewPacketInvariant({
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty', concerns: ['concern:missing'] },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'weak_accept' },
      major_concerns: [{
        concern_id: 'concern:resolved-ref',
        reviewer_role: 'novelty',
        severity: 'minor',
        concern: 'Resolvable concern exists, but reviewer points elsewhere.',
        addressed: false
      }]
    }
  });
  assert.equal(staleReviewerConcernRef.ok, false);
  assert.deepEqual(staleReviewerConcernRef.unresolved_reviewer_concern_refs, [{
    reviewer_id: 'reviewer:novelty',
    concern_id: 'concern:missing'
  }]);
  assert.equal(validateReviewPacketInvariant({
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty', concerns: ['concern:resolved-ref'] },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'weak_accept' },
      major_concerns: [{
        concern_id: 'concern:resolved-ref',
        reviewer_role: 'novelty',
        severity: 'minor',
        concern: 'Reviewer concern ref resolves.',
        addressed: false
      }]
    }
  }).ok, true);
  const staleReviewConcernClaimRef = validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:stale',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Claim ref is stale.',
        affected_claim_ids: ['claim:missing'],
        addressed: false
      }]
    }
  });
  assert.equal(staleReviewConcernClaimRef.ok, false);
  assert.deepEqual(staleReviewConcernClaimRef.unresolved_affected_claim_refs, [{
    concern_id: 'concern:stale',
    claim_id: 'claim:missing'
  }]);
  assert.equal(validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:resolved',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Claim ref resolves.',
        affected_claim_ids: ['claim:1'],
        addressed: false
      }]
    }
  }).ok, true);
  const uncoveredUnsupportedClaim = validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:ungrounded' }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: []
    }
  });
  assert.equal(uncoveredUnsupportedClaim.ok, false);
  assert.deepEqual(uncoveredUnsupportedClaim.uncovered_unsupported_claim_ids, ['claim:ungrounded']);
  assert.equal(validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:ungrounded' }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:false-resolution',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Claim lacks source-span grounding but is marked resolved.',
        affected_claim_ids: ['claim:ungrounded'],
        addressed: true
      }]
    }
  }).ok, false);
  assert.equal(validateReviewPacketInvariant({
    contribution_claims: [{ claim_id: 'claim:ungrounded' }],
    review_packet: {
      reviewers: [
        { reviewer_id: 'reviewer:novelty', role: 'novelty' },
        { reviewer_id: 'reviewer:methods', role: 'methods' },
        { reviewer_id: 'reviewer:reproducibility', role: 'reproducibility' },
        { reviewer_id: 'reviewer:outsider', role: 'outsider' }
      ],
      meta_review: { recommendation: 'major_revision' },
      major_concerns: [{
        concern_id: 'concern:unsupported',
        reviewer_role: 'reproducibility',
        severity: 'major',
        concern: 'Contribution claim lacks source-span grounding.',
        affected_claim_ids: ['claim:ungrounded'],
        addressed: false
      }]
    }
  }).ok, true);
  assert.equal(validateStorylineCoverageInvariant({
    storyline_dag: {
      beats: [
        { beat_id: 'beat:1', supported: true },
        { beat_id: 'beat:2', supported: false }
      ],
      edges: [{ source_beat_id: 'beat:1', target_beat_id: 'beat:missing' }],
      unsupported_beats: []
    }
  }).ok, false);
  const staleStorylineTrace = validateStorylineCoverageInvariant({
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'A grounded claim.',
      source_span_ids: ['span:1']
    }],
    storyline_dag: {
      beats: [{
        beat_id: 'beat:stale-claim',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:missing' }],
        claim_ids: ['claim:missing']
      }],
      edges: [],
      unsupported_beats: []
    }
  });
  assert.equal(staleStorylineTrace.ok, false);
  assert.deepEqual(staleStorylineTrace.unresolved_trace_refs, [
    { beat_id: 'beat:stale-claim', trace_type: 'claim', trace_id: 'claim:missing' },
    { beat_id: 'beat:stale-claim', trace_type: 'claim', trace_id: 'claim:missing' }
  ]);
  assert.equal(validateStorylineCoverageInvariant({
    contribution_claims: [{
      claim_id: 'claim:1',
      claim_text: 'A grounded claim.',
      source_span_ids: ['span:1']
    }],
    storyline_dag: {
      beats: [{
        beat_id: 'beat:resolved-claim',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:1' }],
        claim_ids: ['claim:1']
      }],
      edges: [],
      unsupported_beats: []
    }
  }).ok, true);
  const paperOnlyTrace = validateStorylineCoverageInvariant({
    storyline_dag: {
      beats: [
        { beat_id: 'beat:paper-only', supported: true, trace_refs: [{ kind: 'paper', id: 'paper:1' }] }
      ],
      edges: [],
      unsupported_beats: []
    }
  });
  assert.equal(paperOnlyTrace.ok, false);
  assert.deepEqual(paperOnlyTrace.unsupported_trace_refs, [{
    beat_id: 'beat:paper-only',
    trace_type: 'paper'
  }]);
  const staleFalsificationPlan = validateFalsificationPlanInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    counterfactuals: [{
      falsification_plan_id: 'falsification:stale',
      claim_id: 'claim:missing',
      question: 'Would the claim still hold?',
      required_evidence: ['baseline_comparison']
    }]
  });
  assert.equal(staleFalsificationPlan.ok, false);
  assert.deepEqual(staleFalsificationPlan.unresolved_claim_refs, [{
    falsification_plan_id: 'falsification:stale',
    claim_id: 'claim:missing'
  }]);
  const incompleteFalsificationPlan = validateFalsificationPlanInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    counterfactuals: [{
      falsification_plan_id: 'falsification:incomplete',
      claim_id: 'claim:1',
      question: '',
      required_evidence: []
    }]
  });
  assert.equal(incompleteFalsificationPlan.ok, false);
  assert.deepEqual(incompleteFalsificationPlan.invalid_plans, [{
    falsification_plan_id: 'falsification:incomplete',
    missing_claim_ref: false,
    missing_question: true,
    missing_required_evidence: true
  }]);
  assert.equal(validateFalsificationPlanInvariant({
    contribution_claims: [{ claim_id: 'claim:1', source_span_ids: ['span:1'] }],
    counterfactuals: [{
      falsification_plan_id: 'falsification:resolved',
      claim_id: 'claim:1',
      question: 'Would the claim still hold under a stronger baseline?',
      required_evidence: ['baseline_comparison']
    }]
  }).ok, true);
});
