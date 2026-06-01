import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIdeaCatalystEvidenceExport } from '../src/core/graph/idea-catalyst-evidence-export.js';

function baseLive(overrides = {}) {
  return {
    problem: 'How can tutoring systems reduce biased belief updates?',
    targetDomain: 'Education',
    source_domain_analyses: [{
      source_domain: 'Psychology',
      takeaways: [{
        id: 'takeaway:reflective-prompts',
        concept: 'Reflective prompts stabilize belief updating.'
      }],
      supporting_papers: [{
        paper_key: 'paper:psych-1',
        title: 'Belief Updating Under Uncertainty',
        snippets: [{
          snippet_id: 'span:1',
          text: 'Reflective prompts improve uncertainty-aware belief revision.',
          section: 'Discussion'
        }]
      }]
    }],
    idea_fragments: [{
      id: 'fragment:reflective-tutor',
      title: 'Reflective tutoring feedback scaffold',
      source_domain: 'Psychology',
      source_takeaway_ids: ['takeaway:reflective-prompts'],
      supporting_paper_keys: ['paper:psych-1']
    }],
    contribution_claims: [{
      claim_id: 'claim:reflective-tutor',
      claim_text: 'Reflective prompt feedback can reduce biased belief updates.',
      source_span_ids: ['span:1'],
      supporting_paper_keys: ['paper:psych-1']
    }],
    novelty_certificate: {
      unsupported_claim_count: 0
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
        concern_id: 'concern:grounding-caveat',
        reviewer_role: 'methods',
        severity: 'minor',
        concern: 'Validate the reflective scaffold under a stronger tutoring baseline.',
        addressed: false,
        affected_claim_ids: ['claim:reflective-tutor']
      }]
    },
    storyline_dag: {
      beats: [{
        beat_id: 'beat:reflective-tutor',
        supported: true,
        trace_refs: [{ kind: 'claim', id: 'claim:reflective-tutor' }],
        claim_ids: ['claim:reflective-tutor'],
        review_concern_ids: ['concern:grounding-caveat']
      }],
      edges: [],
      unsupported_beats: []
    },
    counterfactuals: [{
      falsification_plan_id: 'falsification:reflective-tutor',
      claim_id: 'claim:reflective-tutor',
      question: 'Would the claim still hold against a stronger baseline?',
      required_evidence: ['baseline_comparison']
    }],
    falsification_plans: [{
      falsification_plan_id: 'falsification:reflective-tutor',
      claim_id: 'claim:reflective-tutor',
      question: 'Would the claim still hold against a stronger baseline?',
      required_evidence: ['baseline_comparison']
    }],
    ...overrides
  };
}

function evidenceExport(overrides = {}) {
  return buildIdeaCatalystEvidenceExport({
    live: baseLive(overrides)
  });
}

test('idea-catalyst evidence export remains source-backed when falsification plans resolve to contribution claims', () => {
  const result = evidenceExport();
  const claim = result.contribution_claims[0];
  const concern = result.review_packet.major_concerns[0];
  const beat = result.storyline_dag.beats[0];
  const claimProvenance = result.provenance_refs.find((entry) => entry.provenance_id === claim.provenance_ref);
  const concernProvenance = result.provenance_refs.find((entry) => entry.provenance_id === concern.provenance_ref);
  const beatProvenance = result.provenance_refs.find((entry) => entry.provenance_id === beat.provenance_ref);

  assert.equal(result.evidence_status, 'source_backed');
  assert.ok(claim.provenance_ref);
  assert.equal(claimProvenance.generated_by_activity, 'idea_catalyst_claim_evidence_export');
  assert.equal(claimProvenance.claim_id, 'claim:reflective-tutor');
  assert.ok(concern.provenance_ref);
  assert.equal(concernProvenance.generated_by_activity, 'idea_catalyst_review_evidence_export');
  assert.equal(concernProvenance.concern_id, 'concern:grounding-caveat');
  assert.ok(beat.provenance_ref);
  assert.equal(beatProvenance.generated_by_activity, 'idea_catalyst_storybeat_evidence_export');
  assert.equal(beatProvenance.beat_id, 'beat:reflective-tutor');
});

test('idea-catalyst evidence export sorts supporting papers by newest publication date', () => {
  const result = evidenceExport({
    source_domain_analyses: [{
      source_domain: 'Psychology',
      takeaways: [],
      supporting_papers: [
        { paper_key: 'paper:old', title: 'Older Source', year: 2023, snippets: [] },
        { paper_key: 'paper:new', title: 'Newer Source', publicationDate: '2026-05-01', snippets: [] },
        { paper_key: 'paper:undated', title: 'Undated Source', snippets: [] }
      ]
    }]
  });

  assert.deepEqual(result.supporting_papers.map((paper) => paper.paper_key), [
    'paper:new',
    'paper:old',
    'paper:undated'
  ]);
  assert.equal(result.supporting_papers[0].publicationDate, '2026-05-01');
});

test('idea-catalyst evidence export downgrades stale falsification claim refs to weak evidence', () => {
  const result = evidenceExport({
    counterfactuals: [],
    falsification_plans: [{
      falsification_plan_id: 'falsification:stale',
      claim_id: 'claim:missing',
      question: 'Would the claim still hold against a stronger baseline?',
      required_evidence: ['baseline_comparison']
    }]
  });

  assert.equal(result.evidence_status, 'weak_evidence');
});

test('idea-catalyst evidence export downgrades incomplete falsification plans to weak evidence', () => {
  const result = evidenceExport({
    counterfactuals: [],
    falsification_plans: [{
      falsification_plan_id: 'falsification:incomplete',
      claim_id: 'claim:reflective-tutor',
      question: '',
      required_evidence: []
    }]
  });

  assert.equal(result.evidence_status, 'weak_evidence');
});

test('idea-catalyst evidence export does not require falsification plans when counterfactual budget is disabled', () => {
  const result = evidenceExport({
    counterfactuals: [],
    falsification_plans: []
  });

  assert.equal(result.evidence_status, 'source_backed');
});
