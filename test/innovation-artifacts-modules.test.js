import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContributionClaims } from '../src/core/graph/claim-linking.js';
import { buildCounterfactuals } from '../src/core/graph/counterfactual-search.js';
import { buildIdeaCatalystInnovationArtifacts } from '../src/core/graph/innovation-contracts.js';
import { buildNoveltyCertificate } from '../src/core/graph/novelty-scoring.js';
import { buildMustCiteSet } from '../src/core/graph/prior-art-contrast.js';
import { buildReviewPacket } from '../src/core/graph/reviewer-simulation.js';
import { buildStorylineDAG } from '../src/core/graph/storyline-dag.js';

function sourceBackedPayload() {
  return {
    problem: 'How can tutoring systems reduce biased belief updates?',
    target_domain_analysis: [{
      target_domain: 'Education',
      remaining_challenges: [{
        challenge_id: 'challenge:edu-bias',
        domain_agnostic_challenge: 'Interactive systems need to calibrate beliefs without asymmetric feedback loops.'
      }]
    }],
    source_domain_analyses: [{
      source_domain: 'Psychology',
      takeaways: [{
        takeaway_id: 'takeaway:reflective-prompts',
        concept: 'Reflective prompts stabilize belief updating.'
      }],
      supporting_papers: [{
        paper_key: 'paper:psych-1',
        title: 'Belief Updating Under Uncertainty',
        year: 2020,
        snippets: [{
          text: 'Reflective prompts improve uncertainty-aware belief revision.',
          section: 'Discussion'
        }]
      }]
    }],
    idea_fragments: [{
      id: 'fragment:reflective-tutor',
      title: 'Reflective tutoring feedback scaffold',
      core_insight: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
      source_domain: 'Psychology',
      source_takeaway_ids: ['takeaway:reflective-prompts'],
      target_challenge_id: 'challenge:edu-bias',
      supporting_paper_keys: ['paper:psych-1'],
      novelty_score: 0.8,
      usefulness_score: 0.75
    }]
  };
}

test('independent innovation artifact modules compose the same source-backed v2 contract as the facade', () => {
  const payload = sourceBackedPayload();
  const options = { mustCiteK: 3, counterfactualBudget: 1 };

  const mustCiteSet = buildMustCiteSet(payload, options);
  const contributionClaims = buildContributionClaims(payload, options);
  const noveltyCertificate = buildNoveltyCertificate(payload, { ...options, mustCiteSet, contributionClaims });
  const reviewPacket = buildReviewPacket(payload, { ...options, mustCiteSet, contributionClaims, noveltyCertificate });
  const storylineDAG = buildStorylineDAG(payload, { ...options, contributionClaims, reviewPacket });
  const counterfactuals = buildCounterfactuals(payload, {
    ...options,
    mustCiteSet,
    contributionClaims,
    noveltyCertificate,
    reviewPacket
  });
  const artifacts = buildIdeaCatalystInnovationArtifacts(payload, options);

  assert.equal(mustCiteSet[0].coverage_status, 'covered');
  assert.equal(contributionClaims[0].source_span_ids.length > 0, true);
  assert.equal(noveltyCertificate.grounding, 1);
  assert.equal(noveltyCertificate.must_cite_completeness, 1);
  assert.deepEqual(noveltyCertificate.reasons.map((reason) => reason.axis), [
    'novelty',
    'significance',
    'feasibility',
    'grounding',
    'must_cite_completeness',
    'temporal_validity'
  ]);
  assert.equal(reviewPacket.meta_review.recommendation, 'weak_accept');
  assert.equal(reviewPacket.major_concerns.length, 0);
  assert.equal(storylineDAG.beats.every((beat) => beat.supported && beat.trace_refs.length), true);
  assert.equal(storylineDAG.beats.flatMap((beat) => beat.trace_refs).some((ref) => ref.text === '[object Object]'), false);
  assert.equal(counterfactuals.length, 1);
  assert.equal(counterfactuals[0].search_contract_version, 'papernexus-counterfactual-search-v1');
  assert.equal(counterfactuals[0].search_mode, 'bounded_offline');

  assert.deepEqual(artifacts.must_cite_set, mustCiteSet);
  assert.deepEqual(artifacts.contribution_claims, contributionClaims);
  assert.deepEqual(artifacts.novelty_certificate, noveltyCertificate);
  assert.deepEqual(artifacts.review_packet, reviewPacket);
  assert.deepEqual(artifacts.storyline_dag, storylineDAG);
  assert.deepEqual(artifacts.counterfactuals, counterfactuals);
});

test('counterfactual module runs bounded offline candidate expansion and deterministic rerank', () => {
  const payload = sourceBackedPayload();
  const mustCiteSet = buildMustCiteSet(payload, { mustCiteK: 3 });
  const contributionClaims = buildContributionClaims(payload, {});
  const reviewPacket = buildReviewPacket(payload, { mustCiteSet, contributionClaims });
  const options = {
    mustCiteSet,
    contributionClaims,
    reviewPacket,
    counterfactualBudget: 3,
    counterfactualSearchBudget: 8,
    counterfactualSearchMode: 'bounded_offline'
  };

  const counterfactuals = buildCounterfactuals(payload, options);
  const rerun = buildCounterfactuals(payload, options);
  const artifacts = buildIdeaCatalystInnovationArtifacts(payload, {
    mustCiteK: 3,
    counterfactualBudget: 3,
    counterfactualSearchBudget: 8,
    counterfactualSearchMode: 'bounded_offline'
  });

  assert.equal(counterfactuals.length, 3);
  assert.deepEqual(counterfactuals, rerun);
  assert.deepEqual(counterfactuals.map((plan) => plan.rank), [1, 2, 3]);
  assert.ok(counterfactuals.every((plan) => plan.score > 0 && plan.score <= 1));
  assert.ok(counterfactuals.every((plan) => plan.search_trace.generated_candidates <= 8));
  assert.ok(counterfactuals.every((plan) => Array.isArray(plan.search_trace.discarded_candidates)));
  assert.ok(counterfactuals.every((plan) => Array.isArray(plan.discard_reasons)));
  assert.ok(counterfactuals.every((plan) => plan.candidate_id && plan.perturbation_type));
  assert.ok(new Set(counterfactuals.map((plan) => plan.perturbation_type)).size >= 2);
  assert.ok(counterfactuals.some((plan) => plan.perturbation_type === 'baseline_swap'));
  assert.ok(counterfactuals.some((plan) => plan.perturbation_type === 'assumption_stress'));
  assert.deepEqual(artifacts.counterfactuals, counterfactuals);
});

test('novelty and reviewer modules surface ungrounded claims and future leakage as release-gate evidence', () => {
  const payload = sourceBackedPayload();
  payload.source_domain_analyses[0].supporting_papers = [{
    paper_key: 'paper:future-1',
    title: 'Future Evidence for Reflective Tutoring',
    year: 2028
  }];
  payload.idea_fragments[0].supporting_paper_keys = ['paper:future-1'];

  const mustCiteSet = buildMustCiteSet(payload, { timeCutoff: '2026' });
  const contributionClaims = buildContributionClaims(payload, {});
  const noveltyCertificate = buildNoveltyCertificate(payload, {
    timeCutoff: '2026',
    mustCiteSet,
    contributionClaims
  });
  const reviewPacket = buildReviewPacket(payload, {
    timeCutoff: '2026',
    mustCiteSet,
    contributionClaims,
    noveltyCertificate
  });
  const counterfactuals = buildCounterfactuals(payload, {
    timeCutoff: '2026',
    mustCiteSet,
    contributionClaims,
    reviewPacket,
    counterfactualBudget: 2
  });

  assert.equal(mustCiteSet[0].temporal_status, 'future_leakage');
  assert.equal(mustCiteSet[0].coverage_status, 'metadata_only');
  assert.equal(contributionClaims[0].source_span_ids.length, 0);
  assert.equal(noveltyCertificate.temporal_validity, 0);
  assert.equal(noveltyCertificate.unsupported_claim_count, 1);
  assert.equal(reviewPacket.meta_review.recommendation, 'major_revision');
  assert.equal(reviewPacket.major_concerns.some((concern) => concern.evidence_gap === 'source_span_ids'), true);
  assert.equal(reviewPacket.major_concerns.some((concern) => concern.evidence_gap === 'temporal_cutoff'), true);
  assert.equal(counterfactuals[0].perturbation_type, 'temporal_cutoff');
  assert.match(counterfactuals[0].question, /using only/i);
});

test('model-assisted innovation lane records calibrated advisory evidence without replacing deterministic gates', () => {
  const payload = sourceBackedPayload();
  const artifacts = buildIdeaCatalystInnovationArtifacts(payload, {
    modelAssisted: {
      enabled: true,
      mode: 'calibrated',
      provider: 'openai-compatible',
      modelId: 'reviewer-adapter-fixture',
      promptVersion: 'innovation-reviewer-v1',
      inferenceRunId: 'model-run-001',
      calibrationDataset: 'PeerRead-NovBench-fixture',
      calibrationRunId: 'calibration-run-001',
      labels: [{ id: 'case-1' }, { id: 'case-2' }],
      uncertainty: 0.18,
      noveltyScores: {
        novelty: 0.9,
        significance: 0.82,
        feasibility: 0.77,
        grounding: 0.88
      },
      noveltyReasons: ['Model judge found a strong cross-domain transfer signal.'],
      reviewerAssessments: [{
        role: 'novelty',
        score: 0.86,
        confidence: 0.7,
        summary: 'The idea appears novel relative to the supplied prior-art packet.',
        concerns: ['Check the nearest tutoring-feedback baseline.']
      }],
      metaReview: {
        recommendation: 'weak_accept',
        confidence: 0.68,
        summary: 'Acceptable as a proposal after must-cite verification.'
      },
      storyline: {
        suggestions: ['Make the why-now beat cite the new review concern packet.']
      }
    }
  });

  assert.equal(artifacts.model_assisted.status, 'calibrated');
  assert.equal(artifacts.model_assisted.model.model_id, 'reviewer-adapter-fixture');
  assert.equal(artifacts.model_assisted.calibration.label_count, 2);
  assert.equal(artifacts.novelty_certificate.grounding, 1);
  assert.equal(artifacts.novelty_certificate.model_assisted.mode, 'calibrated');
  assert.equal(artifacts.novelty_certificate.model_assisted.advisory_scores.novelty, 0.9);
  assert.equal(artifacts.novelty_certificate.model_assisted.score_deltas.novelty, 0.1);
  assert.equal(artifacts.review_packet.model_assisted.reviewer_assessments[0].role, 'novelty');
  assert.equal(artifacts.review_packet.meta_review.recommendation, 'weak_accept');
  assert.equal(artifacts.storyline_dag.model_assisted.annotations.suggestions.length, 1);
});
