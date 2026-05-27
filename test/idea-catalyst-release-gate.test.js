import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildIdeaCatalystReleaseGateManifest,
  IDEA_CATALYST_RELEASE_GATE_VERSION,
  prepareIdeaCatalystReleaseGateManifest,
  RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS,
  RELEASE_GATE_REQUIRED_ABLATIONS
} from '../src/core/eval/release-gate-manifest.js';
import {
  ENGINEERING_RELEASE_EVIDENCE_VERSION,
  REQUIRED_ENGINEERING_TESTS
} from '../src/core/eval/engineering-release-evidence.js';
import {
  DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
  REQUIRED_DOCS_SYNC_CHECKS,
  REQUIRED_DOCS_SYNC_INPUTS
} from '../src/core/eval/docs-sync-release-evidence.js';
import {
  GRAPH_REASONING_REPORT_VERSION
} from '../src/core/eval/graph-reasoning-report.js';
import {
  GRAPH_LINK_PREDICTION_EVAL_VERSION
} from '../src/core/eval/graph-link-prediction-eval.js';
import {
  buildScientificEmbeddingReleaseEvidenceReport
} from '../src/core/eval/scientific-embedding-release-evidence.js';
import {
  buildInnovationSidecarReleaseEvidenceReport
} from '../src/core/eval/innovation-sidecar-release-evidence.js';
import { SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION } from '../src/core/index/scientific-embeddings.js';
import { MODEL_ASSISTED_INNOVATION_VERSION } from '../src/core/graph/model-assisted-innovation.js';
import { COUNTERFACTUAL_SEARCH_CONTRACT_VERSION } from '../src/core/graph/counterfactual-search.js';
import { INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION } from '../src/core/ingestion/graph-mutation-executor.js';
import { INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION } from '../src/core/ingestion/parser-orchestrator.js';
import { prepareIdeaCatalystReleaseGateCli } from '../scripts/prepare-idea-catalyst-release-gate.mjs';

function gate(name, status = 'passed') {
  return { name, status, ok: status === 'passed' };
}

function replaySuite(format, options = {}) {
  const sourceLabel = options.source || (
    format === 'masterset'
      ? 'https://benchmarks.papernexus.org/masterset-openalex-coci-historical-slices/snapshot'
      : `https://benchmarks.papernexus.org/${format}/snapshot`
  );
  const releaseReadiness = options.releaseReadiness === undefined
    ? {
        status: 'ready_for_release_gate',
        releaseCandidate: true,
        reason: 'release_metadata_and_family_gates_present',
        checks: [
          gate('strict_time_cutoffs_present'),
          gate('venue_year_holdout_present'),
          gate('time_slice_policy_present'),
          gate('release_grade_improvement_thresholds_present'),
          gate('semantic_negative_coverage_present'),
          gate('statistical_significance_evidence_present'),
          gate('statistical_significance_provenance_auditable')
        ]
      }
    : options.releaseReadiness;
  return {
    contractVersion: 'idea-catalyst-replay-suite-v1',
    runId: `${format}-run`,
    status: options.status || 'passed',
    dataset: {
      name: options.name || format,
      format,
      source: sourceLabel,
      license_scope: options.licenseScope || 'public benchmark research use',
      source_families: options.sourceFamilies || (format === 'masterset' ? ['masterset', 'openalex', 'coci'] : [])
    },
    inputs: [{
      role: 'raw_dataset',
      path: `/benchmarks/${format}.json`,
      sha256: `sha-${format}`
    }, {
      role: 'statistical_significance',
      path: `/benchmarks/${format}-statistical-significance.json`,
      sha256: `sha-${format}-statistics`
    }],
    diagnostics: {
      evaluable_must_cite_case_count: options.mustCiteCases || 0,
      evaluable_claim_case_count: options.claimCases || 0,
      evaluable_novelty_case_count: options.noveltyCases || 0,
      missing_time_cutoff_count: options.missingTimeCutoffCount || 0
    },
    gates: [
      gate('must_cite_recall_at_k', options.mustCiteGate || 'passed'),
      gate('novelty_beats_baseline', options.noveltyGate || 'passed'),
      gate('claim_grounding', options.claimGate || 'passed'),
      gate('major_metrics_beat_baseline', options.majorMetricsGate || 'passed'),
      gate('historical_replay_beats_live_discovery', options.historicalGate || 'passed')
    ],
    metrics: {
      must_cite_recall_at_k: 0.9,
      must_cite_recall_at_k_improvement: 0.12,
      claim_grounding_f1: 0.82,
      claim_grounding_f1_improvement: 0.11,
      unsupported_claim_rate_reduction: 0.2,
      claim_source_span_completeness: 1,
      novelty_score_improvement: 0.08,
      major_metric_improvement_count: 3,
      evaluated_major_metric_count: 4,
      major_metric_improvements: [
        { id: 'novelty_score', value: 0.08, threshold: 0.08, status: 'passed' },
        { id: 'claim_grounding_f1', value: 0.11, threshold: 0.1, status: 'passed' },
        { id: 'historical_score', value: 0.06, threshold: 0.01, status: 'passed' }
      ],
      historical_score: 0.88,
      historical_score_improvement: 0.06,
      ...options.metrics
    },
    statistical_significance: options.statisticalSignificance || {
      tests: [
        { metric: 'must_cite_recall_at_k_improvement', test: 'paired bootstrap', sample_size: 25, effect_size: 0.12, p_value: 0.01 },
        { metric: 'novelty_score_improvement', test: 'wilcoxon signed-rank', sample_size: 25, effect_size: 0.08, p_value: 0.02 },
        { metric: 'claim_grounding_f1_improvement', test: 'paired bootstrap', sample_size: 25, effect_size: 0.11, p_value: 0.01 },
        { metric: 'unsupported_claim_rate_reduction', test: 'permutation test', sample_size: 25, effect_size: 0.2, p_value: 0.01 },
        { metric: 'historical_score_improvement', test: 'paired bootstrap', sample_size: 25, effect_size: 0.06, p_value: 0.03 }
      ]
    },
    statistical_significance_provenance: options.statisticalSignificanceProvenance || {
      source: 'statistical_significance_file',
      path: `/benchmarks/${format}-statistical-significance.json`
    },
    ...(releaseReadiness === null ? {} : { releaseReadiness })
  };
}

function humanAggregation(status = 'passed') {
  const releaseReadiness = status === 'passed'
    ? {
        status: 'ready_for_release_gate',
        releaseCandidate: true,
        reason: 'human_blind_protocol_and_preference_gate_passed',
        checks: [
          gate('aggregation_status_passed'),
          gate('independent_human_labels_present'),
          gate('reviewer_protocol_satisfied'),
          gate('reviewer_identity_independence_satisfied'),
          gate('assignment_coverage_satisfied'),
          gate('review_form_completeness_satisfied'),
          gate('comparison_coverage_satisfied'),
          gate('blinding_protocol_satisfied'),
          gate('target_preference_threshold_met'),
          gate('target_pairs_present')
        ]
      }
    : {
        status: 'incomplete',
        releaseCandidate: false,
        reason: 'human blind aggregation did not pass'
      };
  return {
    contractVersion: 'human-blind-eval-v1',
    status,
    target_preference_rate: status === 'passed' ? 0.6 : 0.4,
    preference_threshold: 0.6,
    label_counts: {
      total: 5,
      valid_human: 5,
      valid_human_target_pair: 5,
      excluded_non_human: 0
    },
    reviewer_protocol: {
      sufficient_reviewers: true,
      independent_reviewers: true,
      pairs: [{
        pair_id: 'pair:human-1',
        independent_reviewers: true,
        distinct_reviewer_count: 5,
        required_distinct_reviewer_count: 5,
        duplicate_reviewer_ids: []
      }]
    },
    assignment_protocol: {
      complete: true,
      target_pair_count: 4,
      target_pair_assignment_count: 20,
      required_target_pair_assignment_count: 20,
      completed_assignment_count: 20,
      missing_assignment_id_label_count: 0,
      invalid_assignment_label_count: 0,
      duplicate_assignment_ids: [],
      missing_required_assignments: [],
      missing_assignment_id_labels: [],
      invalid_assignment_labels: [],
      pairs_with_missing_assignment_slots: []
    },
    review_form_protocol: {
      complete: true,
      required_dimensions: ['novelty', 'significance', 'feasibility', 'grounding', 'storyline_coherence', 'must_cite_completeness'],
      valid_human_target_pair_label_count: 5,
      complete_dimension_score_label_count: 5,
      explicit_confidence_label_count: 5,
      major_concerns_label_count: 5,
      missing_dimension_score_labels: [],
      missing_confidence_labels: [],
      missing_major_concerns_labels: []
    },
    comparison_protocol: {
      complete: true,
      target_system: 'candidate',
      required_comparison_families: ['baseline', 'p0', 'p1', 'ablation'],
      covered_comparison_families: ['ablation', 'baseline', 'p0', 'p1'],
      missing_comparison_families: [],
      target_pair_count: 4
    },
    blinding_protocol: {
      complete: true,
      public_artifacts_present: true,
      payload_policy: 'proposal_and_evidence_export_only',
      missing_public_artifacts: [],
      forbidden_public_fields: [],
      unexpected_public_payload_fields: [],
      answer_key_private: true
    },
    inputs: [
      { role: 'human_blind_cases', path: '/benchmarks/human-blind/cases.json', sha256: 'sha-human-cases' },
      { role: 'human_blind_labels', path: '/benchmarks/human-blind/labels.json', sha256: 'sha-human-labels' }
    ],
    blind_review_artifacts: [
      { role: 'human_blind_pack', path: '/benchmarks/human-blind/blind-pack.json', sha256: 'sha-human-blind-pack' },
      { role: 'human_blind_assignments', path: '/benchmarks/human-blind/assignments.json', sha256: 'sha-human-assignments' },
      { role: 'human_blind_answer_key', path: '/benchmarks/human-blind/answer-key.json', sha256: 'sha-human-answer-key' },
      { role: 'human_blind_review_form_schema', path: '/benchmarks/human-blind/review-form.schema.json', sha256: 'sha-human-review-form' }
    ],
    releaseReadiness
  };
}

function ablationManifest(ids = RELEASE_GATE_REQUIRED_ABLATIONS) {
  const effectRequired = new Set(RELEASE_GATE_REQUIRED_ABLATIONS);
  return {
    contractVersion: 'idea-catalyst-ablation-runner-v1',
    runId: 'ablation-release',
    status: 'passed',
    inputs: [{
      role: 'ablation_benchmark',
      path: '/benchmarks/ablation-release.json',
      sha256: 'sha-ablation-benchmark'
    }],
    ablations: ids.map((id) => ({
      ablation_id: id,
      status: id === 'full' ? 'passed' : 'failed',
      report_artifact: {
        role: 'ablation_variant_report',
        path: `/benchmarks/ablations/${id}/report.json`,
        sha256: `sha-ablation-${id}`
      },
      deltas_from_control: { historical_score: -0.1 },
      artifact_removal_audit: {
        target_id: id,
        status: 'passed',
        target_present_before: true,
        target_removed: true,
        before_count: 1,
        after_count: 0
      },
      ablation_effect_audit: {
        target_id: id,
        status: effectRequired.has(id) ? 'passed' : 'structural_only',
        effect_required: effectRequired.has(id),
        target_metric: effectRequired.has(id) ? 'historical_score' : null,
        expected_direction: effectRequired.has(id) ? 'decrease' : null,
        delta_from_control: effectRequired.has(id) ? -0.1 : null,
        relevant_gate_status: effectRequired.has(id) ? 'failed' : null,
        effect_observed: effectRequired.has(id) ? true : null
      }
    }))
  };
}

function graphReasoningReport(status = 'passed', options = {}) {
  const format = options.format || 'scirepeval-oag-graphrag';
  const releaseGateStatus = options.releaseGateStatus || status;
  return {
    contractVersion: GRAPH_REASONING_REPORT_VERSION,
    runId: `${format}-release`,
    status,
    benchmark: {
      name: options.name || 'SciRepEval OAG-Bench GraphRAG-Bench release slice',
      format,
      source: options.source || `https://benchmarks.papernexus.org/${format}/snapshot`,
      license_scope: options.licenseScope || 'public benchmark research use'
    },
    inputs: options.inputs || [
      {
        role: 'graph_snapshot',
        path: `/benchmarks/${format}-graph.json`,
        sha256: `sha-${format}-graph`
      },
      {
        role: 'graph_reasoning_tasks',
        path: `/benchmarks/${format}-tasks.json`,
        sha256: `sha-${format}-tasks`
      },
      {
        role: 'graphrag_summaries',
        path: `/benchmarks/${format}-summaries.json`,
        sha256: `sha-${format}-summaries`
      }
    ],
    gates: [
      gate('evaluable_gold_tasks', options.evaluableGate || status),
      gate('graph_reasoning_beats_baseline', options.graphGate || status),
      gate('global_local_summary_evaluable', options.summaryGate || status),
      gate('storyline_coherence_not_regressed', options.storylineGate || status),
      gate('release_provenance_complete', options.provenanceGate || status)
    ],
    metrics: {
      retrieval_score_delta: 0.12,
      graph_reasoning_score_delta: 0.09,
      global_local_summary_delta: options.summaryDelta ?? 0.06,
      storyline_coherence_delta: 0.04
    },
    releaseGate: {
      status: releaseGateStatus,
      reason: releaseGateStatus === 'passed' ? 'graph_reasoning_release_gates_passed' : 'graph reasoning evidence is incomplete'
    }
  };
}

function graphLinkPredictionReport(status = 'passed', options = {}) {
  return {
    contractVersion: options.contractVersion || GRAPH_LINK_PREDICTION_EVAL_VERSION,
    runId: 'oag-openalex-link-prediction-release',
    status,
    benchmark: {
      name: options.name || 'OAG OpenAlex Internal KG Temporal Link Prediction 2026-05',
      format: options.format || 'temporal-link-prediction',
      source: options.source || 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05',
      license_scope: 'public benchmark research use'
    },
    model: options.model || 'hgt-temporal-link-prediction',
    method: options.method || 'external-hgt-temporal-link-prediction',
    timeCutoff: options.timeCutoff || '2024',
    trainingSlice: options.trainingSlice || 'openalex-oag-internal-kg-2020-2024',
    negativeSamplingPolicy: options.negativeSamplingPolicy || 'type_balanced_non_edges_v1',
    inputs: [{
      role: 'temporal_gold_edges',
      path: options.inputPath || '/benchmarks/oag-openalex-internal-kg-link-prediction/gold-temporal-edges.json',
      sha256: 'sha-oag-openalex-link-prediction'
    }],
    gates: [
      gate('temporal_gold_edges_present', 'passed'),
      gate('temporal_split_clean', options.temporalGate || 'passed'),
      gate('link_prediction_quality', options.qualityGate || 'passed'),
      gate('negative_sampling_declared', 'passed'),
      gate('release_provenance_complete', options.provenanceGate || 'passed')
    ],
    metrics: {
      hits_at_1: 0.62,
      hits_at_10: 0.86,
      mrr: 0.44,
      auc_like_pair_accuracy: 0.91,
      future_leakage_count: 0
    },
    releaseGate: {
      status,
      reason: status === 'passed' ? 'temporal_link_prediction_release_gates_passed' : 'temporal link-prediction evidence is incomplete'
    }
  };
}

function scientificEmbeddingManifest(overrides = {}) {
  return {
    contractVersion: SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION,
    runId: 'specter2-scientific-embedding-release',
    status: 'completed',
    releaseGateStatus: 'ready_for_evaluation',
    method: 'external-scientific-embedding-vectors',
    model: 'SPECTER2 scientific encoder',
    datasetSource: 'SciRepEval OAG GraphRAG benchmark snapshot 2026-05',
    licenseScope: 'public benchmark research use',
    inputs: [{
      role: 'scientific_embedding_benchmark',
      path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
      sha256: 'sha-scientific-embedding-benchmark'
    }, {
      role: 'scientific_embedding_source',
      path: '/benchmarks/specter2-vectors.jsonl',
      sha256: 'sha-specter2-vectors'
    }],
    diagnostics: {
      documentEmbeddingLoadedRows: 1000,
      queryEmbeddingLoadedRows: 100,
      deterministicFallbackDocumentCount: 0,
      deterministicFallbackQueryCount: 0
    },
    ...overrides
  };
}

function scientificRetrievalSuiteReport(overrides = {}) {
  return {
    contractVersion: 'fixed-corpus-retrieval-suite-v1',
    runId: 'scientific-embedding-retrieval-suite',
    status: 'completed',
    datasetPath: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
    benchmark: {
      name: 'SciRepEval OAG GraphRAG fixed-corpus retrieval benchmark',
      format: 'scirepeval-oag-graphrag'
    },
    inputs: [{
      role: 'fixed_corpus_dataset',
      path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
      sha256: 'sha-retrieval-suite-dataset'
    }, {
      role: 'fixed_corpus_lexical_scores',
      path: '/benchmarks/bm25-lexical-scores.json',
      sha256: 'sha-retrieval-suite-lexical'
    }, {
      role: 'fixed_corpus_dense_scores',
      path: '/benchmarks/specter2-dense-scores.json',
      sha256: 'sha-retrieval-suite-dense'
    }, {
      role: 'fixed_corpus_hybrid_scores',
      path: '/benchmarks/specter2-hybrid-scores.json',
      sha256: 'sha-retrieval-suite-hybrid'
    }],
    rows: [
      { mode: 'lexical', status: 'completed', metrics: { 'ndcg@10': 0.41, 'recall@10': 0.52 } },
      { mode: 'dense', status: 'completed', metrics: { 'ndcg@10': 0.46, 'recall@10': 0.57 } },
      { mode: 'hybrid', status: 'completed', metrics: { 'ndcg@10': 0.58, 'recall@10': 0.68 } }
    ],
    ...overrides
  };
}

function scientificEmbeddingEvidence(options = {}) {
  return buildScientificEmbeddingReleaseEvidenceReport({
    generatedAt: '2026-05-26T00:00:00.000Z',
    runId: 'scientific-embedding-release',
    scientificEmbeddingManifest: scientificEmbeddingManifest(options.manifest || {}),
    retrievalSuiteReport: scientificRetrievalSuiteReport(options.retrieval || {}),
    inputs: options.inputs || [
      { role: 'scientific_embedding_manifest', path: '/reports/scientific-embedding-manifest.json', sha256: 'sha-scientific-manifest' },
      { role: 'fixed_corpus_retrieval_suite_report', path: '/reports/scientific-retrieval-suite.json', sha256: 'sha-scientific-retrieval-suite' }
    ]
  });
}

function modelAssistedReport(overrides = {}) {
  return {
    contractVersion: MODEL_ASSISTED_INNOVATION_VERSION,
    runId: 'model-assisted-calibration-release',
    status: 'passed',
    mode: 'calibrated',
    model_id: 'model-assisted-novelty-judge-v1',
    prompt_version: 'innovation-calibration-prompt-v1',
    calibration_dataset: 'novbench-rinobench-claim-openreview-style-gold-2026-05',
    calibration_run_id: 'calibration-run-2026-05',
    evaluation_dataset: 'novbench-rinobench-claim-openreview-style-holdout-2026-05',
    evaluation_run_id: 'holdout-eval-run-2026-05',
    holdout_policy: 'venue/year holdout with no calibration-label overlap',
    calibration_split: 'calibration',
    evaluation_split: 'holdout',
    overlap_count: 0,
    label_count: 240,
    benchmark_families: ['novbench', 'rinobench', 'claim-bench', 'claimcheck', 'openreview', 'peerread', 'moprd', 're2'],
    dataset: {
      name: 'NovBench RINoBench CLAIM-BENCH CLAIMCHECK OpenReview-style calibration set',
      format: 'novbench-rinobench-claim-openreview-style',
      source: 'https://benchmarks.papernexus.org/model-assisted-calibration/2026-05',
      license_scope: 'public benchmark research use'
    },
    inputs: [{
      role: 'calibration_dataset',
      path: '/benchmarks/model-assisted-calibration.jsonl',
      sha256: 'sha-model-assisted-calibration'
    }, {
      role: 'evaluation_dataset',
      path: '/benchmarks/model-assisted-holdout-evaluation.jsonl',
      sha256: 'sha-model-assisted-holdout-evaluation'
    }],
    gates: [
      gate('model_calibration_complete', 'passed'),
      gate('benchmark_metrics_passed', 'passed')
    ],
    metrics: {
      novelty_auc: 0.82,
      claim_f1: 0.76,
      reviewer_agreement: 0.71
    },
    ...overrides
  };
}

function counterfactualReport(overrides = {}) {
  return {
    contractVersion: COUNTERFACTUAL_SEARCH_CONTRACT_VERSION,
    runId: 'counterfactual-usefulness-release',
    status: 'passed',
    search_mode: 'tot_model_assisted',
    backend: 'llm-provider-tree-of-thought',
    candidate_count: 48,
    selected_plan_count: 12,
    usefulness_label_count: 80,
    usefulness_score: 0.64,
    dataset: {
      name: 'OpenReview counterfactual failure discovery labels',
      format: 'openreview-counterfactual-usefulness',
      source: 'https://benchmarks.papernexus.org/counterfactual-usefulness/2026-05',
      license_scope: 'public benchmark research use'
    },
    inputs: [{
      role: 'counterfactual_candidates',
      path: '/benchmarks/counterfactual-candidates.jsonl',
      sha256: 'sha-counterfactual-candidates'
    }, {
      role: 'selected_plans',
      path: '/benchmarks/counterfactual-selected-plans.jsonl',
      sha256: 'sha-counterfactual-selected-plans'
    }, {
      role: 'usefulness_labels',
      path: '/benchmarks/counterfactual-usefulness.jsonl',
      sha256: 'sha-counterfactual-usefulness'
    }],
    gates: [
      gate('counterfactual_usefulness', 'passed')
    ],
    metrics: {
      usefulness_score: 0.64,
      failure_discovery_rate: 0.58
    },
    ...overrides
  };
}

function innovationSidecarEvidence(options = {}) {
  return buildInnovationSidecarReleaseEvidenceReport({
    generatedAt: '2026-05-26T00:00:00.000Z',
    runId: 'innovation-sidecar-release',
    modelAssistedReport: modelAssistedReport(options.model || {}),
    counterfactualReport: counterfactualReport(options.counterfactual || {}),
    inputs: options.inputs || [
      { role: 'model_assisted_calibration_report', path: '/reports/model-assisted-calibration.json', sha256: 'sha-model-report' },
      { role: 'counterfactual_usefulness_report', path: '/reports/counterfactual-usefulness.json', sha256: 'sha-counterfactual-report' }
    ]
  });
}

function ingestionGraphMutationExecutionReport(overrides = {}) {
  const planOverrides = overrides.plan || {};
  const safetyOverrides = overrides.safety || {};
  const artifactOverrides = overrides.artifacts || {};
  return {
    contractVersion: overrides.contractVersion || INGESTION_GRAPH_MUTATION_EXECUTION_CONTRACT_VERSION,
    generatedAt: '2026-05-26T00:00:00.000Z',
    status: overrides.status || 'applied',
    applyStatus: overrides.applyStatus || 'applied',
    dryRun: overrides.dryRun ?? false,
    actor: 'release-gate-test',
    corpusRoot: '/corpora/papernexus-release',
    graphMutationsPath: '/artifacts/ingestion/graph-mutations.json',
    graphApplyPlanPath: '/artifacts/ingestion/graph-apply-plan.json',
    inputs: overrides.inputs || [
      { role: 'graph_mutations', path: '/artifacts/ingestion/graph-mutations.json', sha256: 'sha-graph-mutations' },
      { role: 'graph_apply_plan', path: '/artifacts/ingestion/graph-apply-plan.json', sha256: 'sha-graph-apply-plan' },
      { role: 'citation_intent_gold_labels', path: '/artifacts/ingestion/citation-intent-gold.json', sha256: 'sha-citation-intent-gold' },
      { role: 'claim_extraction_gold_labels', path: '/artifacts/ingestion/claim-extraction-gold.json', sha256: 'sha-claim-extraction-gold' },
      { role: 'multimodal_assets', path: '/artifacts/ingestion/multimodal-assets.json', sha256: 'sha-multimodal-assets' }
    ],
    operationCount: overrides.operationCount ?? 4,
    graphBefore: {
      nodeCount: 10,
      relationshipCount: 12,
      checksum: overrides.beforeChecksum || 'checksum-before'
    },
    projectedGraphAfter: {
      nodeCount: 13,
      relationshipCount: 15,
      checksum: overrides.projectedChecksum || overrides.afterChecksum || 'checksum-after'
    },
    authoritativeGraphAfter: {
      nodeCount: 13,
      relationshipCount: 15,
      checksum: overrides.afterChecksum || 'checksum-after'
    },
    mutationSummary: {
      applied: 4,
      skipped: 0,
      failed: 0
    },
    plan: {
      contractVersion: planOverrides.contractVersion || INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
      status: planOverrides.status || 'ready_to_apply',
      mode: planOverrides.mode || 'release-gated',
      canApply: planOverrides.canApply ?? true,
      releaseGateStatus: planOverrides.releaseGateStatus || 'passed',
      gates: planOverrides.gates || [
        gate('graph_mutations_present', 'passed'),
        gate('multimodal_asset_audit_complete', 'passed'),
        gate('citation_intent_benchmark_passed', 'passed'),
        gate('claim_extraction_benchmark_passed', 'passed'),
        gate('explicit_release_gated_apply_requested', 'passed')
      ]
    },
    blockingReasons: overrides.blockingReasons || [],
    diagnostics: {
      warningCount: 0,
      warnings: []
    },
    safety: {
      defaultBehavior: 'dry-run',
      explicitApplyRequested: true,
      planAllowsApply: true,
      authoritativeGraphWritePerformed: safetyOverrides.authoritativeGraphWritePerformed ?? true,
      blockedActualApply: false,
      rollbackManifestRequired: safetyOverrides.rollbackManifestRequired ?? true
    },
    artifacts: {
      report: artifactOverrides.report ?? '/artifacts/ingestion/graph-mutation-execution-report.json',
      markdownReport: artifactOverrides.markdownReport ?? '/artifacts/ingestion/graph-mutation-execution-report.md',
      manifest: artifactOverrides.manifest ?? '/artifacts/ingestion/manifest.json',
      rollbackManifest: artifactOverrides.rollbackManifest ?? '/artifacts/ingestion/rollback-manifest.json',
      rollbackManifestSha256: artifactOverrides.rollbackManifestSha256 ?? 'sha-rollback-manifest',
      beforeGraphSnapshot: artifactOverrides.beforeGraphSnapshot ?? '/artifacts/ingestion/before-graph-snapshot.json',
      beforeGraphSnapshotSha256: artifactOverrides.beforeGraphSnapshotSha256 ?? 'sha-before-graph-snapshot'
    }
  };
}

function engineeringEvidence(status = 'passed', options = {}) {
  const missingTests = options.missingTests || [];
  const failedTests = options.failedTests || [];
  const includedTests = REQUIRED_ENGINEERING_TESTS.filter((file) => !missingTests.includes(file));
  return {
    contractVersion: ENGINEERING_RELEASE_EVIDENCE_VERSION,
    runId: 'engineering-release-tests',
    status,
    required_tests: REQUIRED_ENGINEERING_TESTS,
    test_runs: includedTests.map((file) => ({
      test_files: [file],
      command: `${process.execPath} --test ${file}`,
      status: failedTests.includes(file) ? 'failed' : 'passed',
      exit_code: failedTests.includes(file) ? 1 : 0,
      duration_ms: 10
    })),
    inputs: REQUIRED_ENGINEERING_TESTS.map((file) => ({
      role: 'required_test_file',
      path: `/repo/${file}`,
      sha256: `sha-${file}`
    })),
    diagnostics: {
      required_test_count: REQUIRED_ENGINEERING_TESTS.length,
      passed_required_test_count: includedTests.length - failedTests.length,
      failed_required_tests: failedTests,
      missing_required_tests: missingTests,
      missing_input_hashes: options.missingInputHashes || []
    },
    environment: {
      node_version: process.version,
      platform: process.platform
    },
    releaseGate: {
      status,
      reason: status === 'passed' ? 'required_engineering_tests_passed' : 'required_engineering_tests_failed'
    }
  };
}

function docsSyncEvidence(status = 'passed', options = {}) {
  const missingChecks = options.missingChecks || [];
  const failedChecks = options.failedChecks || [];
  const includedChecks = REQUIRED_DOCS_SYNC_CHECKS.filter((check) => !missingChecks.includes(check.id));
  return {
    contractVersion: DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
    runId: 'docs-sync-release',
    status,
    required_checks: REQUIRED_DOCS_SYNC_CHECKS.map((check) => check.id),
    required_inputs: REQUIRED_DOCS_SYNC_INPUTS,
    checks: includedChecks.map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command ? [check.command, ...(check.args || [])].join(' ') : `internal:${check.kind}`,
      status: failedChecks.includes(check.id) ? 'failed' : 'passed',
      exit_code: failedChecks.includes(check.id) ? 1 : 0,
      duration_ms: 10
    })),
    inputs: REQUIRED_DOCS_SYNC_INPUTS.map((file) => ({
      role: 'required_sync_input',
      relative_path: file,
      path: `/repo/${file}`,
      sha256: `sha-${file}`
    })),
    input_stability: {
      checked: options.inputStabilityChecked ?? true,
      changed_input_count: options.changedInputCount ?? 0,
      changed_inputs: options.changedInputs || []
    },
    diagnostics: {
      required_check_count: REQUIRED_DOCS_SYNC_CHECKS.length,
      passed_required_check_count: includedChecks.length - failedChecks.length,
      failed_required_checks: failedChecks,
      incomplete_required_checks: [],
      missing_required_checks: missingChecks,
      missing_input_hashes: options.missingInputHashes || [],
      changed_input_hashes: options.changedInputHashes || []
    },
    environment: {
      node_version: process.version,
      platform: process.platform
    },
    releaseGate: {
      status,
      reason: status === 'passed' ? 'docs_schema_fixtures_and_migration_notes_synced' : 'docs_sync_checks_failed'
    }
  };
}

function releaseInputs(overrides = {}) {
  return {
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 4 }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('rinobench', { noveltyCases: 4 }),
      replaySuite('axiomatic_novelty', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('claimcheck', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2, claimCases: 2, mustCiteCases: 2 }),
      replaySuite('peerread', { noveltyCases: 2, claimCases: 2, mustCiteCases: 2 }),
      replaySuite('moprd', { noveltyCases: 2, claimCases: 2, mustCiteCases: 2 }),
      replaySuite('re2', { noveltyCases: 2, claimCases: 2, mustCiteCases: 2 })
    ],
    ablationManifests: [ablationManifest()],
    humanAggregations: [humanAggregation()],
    graphReasoningReports: [graphReasoningReport()],
    graphLinkPredictionReports: [graphLinkPredictionReport()],
    scientificEmbeddingEvidenceReports: [scientificEmbeddingEvidence()],
    innovationSidecarEvidenceReports: [innovationSidecarEvidence()],
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport()],
    engineeringEvidenceReports: [engineeringEvidence()],
    docsSyncEvidenceReports: [docsSyncEvidence()],
    runId: 'release-gate-pass',
    generatedAt: '2026-05-26T00:00:00.000Z',
    ...overrides
  };
}

test('idea-catalyst release gate passes only with all external evidence categories present', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs());

  assert.equal(manifest.contractVersion, IDEA_CATALYST_RELEASE_GATE_VERSION);
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.summary.release_pass, true);
  assert.equal(manifest.requirements.length, 15);
  assert.deepEqual(manifest.requirements.map((entry) => entry.status), Array(15).fill('passed'));
  assert.equal(manifest.evidence_counts.ingestion_graph_mutation_execution_reports, 1);
  assert.equal(manifest.evidence_counts.scientific_embedding_evidence_reports, 1);
  assert.equal(manifest.evidence_counts.innovation_sidecar_evidence_reports, 1);
  assert.equal(manifest.evidence_counts.graph_link_prediction_reports, 1);
  assert.equal(manifest.evidence_counts.engineering_evidence_reports, 1);
  assert.equal(manifest.evidence_counts.docs_sync_evidence_reports, 1);
});

test('idea-catalyst release gate supports P0/P1 scope without deferred sidecar evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    releaseScope: 'p0-p1',
    graphReasoningReports: [],
    graphLinkPredictionReports: [],
    scientificEmbeddingEvidenceReports: [],
    innovationSidecarEvidenceReports: [],
    ablationManifests: [ablationManifest(RELEASE_GATE_P0_P1_REQUIRED_ABLATIONS)]
  }));

  const requirementIds = manifest.requirements.map((entry) => entry.id);
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(manifest.releaseScope, 'p0_p1');
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.summary.requirement_count, 10);
  assert.deepEqual(requirementIds, ['E1', 'E2', 'E3', 'E4', 'E6', 'R3', 'T1', 'D1', 'E7', 'AB1']);
  assert.equal(requirementIds.includes('E5'), false);
  assert.equal(requirementIds.includes('R4'), false);
  assert.equal(requirementIds.includes('R5'), false);
  assert.equal(requirementIds.includes('R6'), false);
  assert.equal(requirementIds.includes('R7'), false);
  assert.equal(ablation.evidence[0].required_ablations.includes('without_link_prediction_signal'), false);
  assert.equal(ablation.evidence[0].required_ablations.includes('without_counterfactual_planner'), false);
  assert.equal(ablation.evidence[0].required_ablations.includes('without_graphrag_summaries'), true);
});

test('idea-catalyst release gate CLI help exposes scientific embedding evidence flag', async () => {
  const result = await prepareIdeaCatalystReleaseGateCli(['--help']);
  assert.match(result.help, /--scientific-embedding-evidence/);
});

test('idea-catalyst release gate treats fixture replay evidence as incomplete by default', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 1, name: 'mini masterset fixture', source: 'fixture' }),
      replaySuite('novbench', { noveltyCases: 1 }),
      replaySuite('claim-bench', { claimCases: 1 }),
      replaySuite('openreview', { noveltyCases: 1 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /fixture_or_synthetic_evidence/);
});

test('idea-catalyst release gate requires every report-named novelty benchmark family', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 4 }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('claimcheck', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 }),
      replaySuite('peerread', { noveltyCases: 2 }),
      replaySuite('moprd', { noveltyCases: 2 }),
      replaySuite('re2', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const novelty = manifest.requirements.find((entry) => entry.id === 'E2');
  assert.equal(novelty.status, 'incomplete');
  assert.match(novelty.message, /missing rinobench replay-suite evidence/);
  assert.match(novelty.message, /missing axiomatic_novelty replay-suite evidence/);
});

test('idea-catalyst release gate requires both claim benchmark families', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: releaseInputs().replaySuites.filter((entry) => entry.dataset.format !== 'claimcheck')
  }));

  assert.equal(manifest.status, 'incomplete');
  const claim = manifest.requirements.find((entry) => entry.id === 'E3');
  assert.equal(claim.status, 'incomplete');
  assert.match(claim.message, /missing claimcheck replay-suite evidence/);
});

test('idea-catalyst release gate requires every historical replay family', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: releaseInputs().replaySuites.filter((entry) => !['peerread', 'moprd', 're2'].includes(entry.dataset.format))
  }));

  assert.equal(manifest.status, 'incomplete');
  const historical = manifest.requirements.find((entry) => entry.id === 'E6');
  assert.equal(historical.status, 'incomplete');
  assert.match(historical.message, /missing peerread replay-suite evidence/);
  assert.match(historical.message, /missing moprd replay-suite evidence/);
  assert.match(historical.message, /missing re2 replay-suite evidence/);
});

test('idea-catalyst release gate requires every graph reasoning benchmark family', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphReasoningReports: [
      graphReasoningReport('passed', {
        name: 'SciRepEval release slice',
        format: 'scirepeval'
      })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const graphReasoning = manifest.requirements.find((entry) => entry.id === 'E5');
  assert.equal(graphReasoning.status, 'incomplete');
  assert.match(graphReasoning.message, /missing oag_bench graph reasoning evidence/);
  assert.match(graphReasoning.message, /missing graphrag_bench graph reasoning evidence/);
});

test('idea-catalyst release gate fails when a graph reasoning required gate fails', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphReasoningReports: [
      graphReasoningReport('passed', {
        summaryGate: 'failed'
      })
    ]
  }));

  assert.equal(manifest.status, 'failed');
  const graphReasoning = manifest.requirements.find((entry) => entry.id === 'E5');
  assert.equal(graphReasoning.status, 'failed');
  assert.match(graphReasoning.message, /global_local_summary_evaluable/);
});

test('idea-catalyst release gate requires GraphRAG summary input hash for graph reasoning evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphReasoningReports: [
      graphReasoningReport('passed', {
        inputs: [
          {
            role: 'graph_snapshot',
            path: '/benchmarks/scirepeval-oag-graphrag-graph.json',
            sha256: 'sha-graph'
          },
          {
            role: 'graph_reasoning_tasks',
            path: '/benchmarks/scirepeval-oag-graphrag-tasks.json',
            sha256: 'sha-tasks'
          }
        ]
      })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const graphReasoning = manifest.requirements.find((entry) => entry.id === 'E5');
  assert.equal(graphReasoning.status, 'incomplete');
  assert.match(graphReasoning.message, /missing_graphrag_summaries_input_hash/);
});

test('idea-catalyst release gate fails graph reasoning evidence without positive summary lift', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphReasoningReports: [
      graphReasoningReport('passed', {
        summaryDelta: 0
      })
    ]
  }));

  assert.equal(manifest.status, 'failed');
  const graphReasoning = manifest.requirements.find((entry) => entry.id === 'E5');
  assert.equal(graphReasoning.status, 'failed');
  assert.match(graphReasoning.message, /global_local_summary_delta must be positive/);
});

test('idea-catalyst release gate requires scientific embedding release evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    scientificEmbeddingEvidenceReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const scientificEmbedding = manifest.requirements.find((entry) => entry.id === 'R4');
  assert.equal(scientificEmbedding.status, 'incomplete');
  assert.match(scientificEmbedding.message, /missing scientific embedding release evidence/);
});

test('idea-catalyst release gate propagates incomplete scientific embedding evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    scientificEmbeddingEvidenceReports: [scientificEmbeddingEvidence({
      retrieval: {
        rows: [
          { mode: 'lexical', status: 'completed', metrics: { 'ndcg@10': 0.60 } },
          { mode: 'dense', status: 'completed', metrics: { 'ndcg@10': 0.50 } },
          { mode: 'hybrid', status: 'completed', metrics: { 'ndcg@10': 0.60 } }
        ]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const scientificEmbedding = manifest.requirements.find((entry) => entry.id === 'R4');
  assert.equal(scientificEmbedding.status, 'incomplete');
  assert.match(scientificEmbedding.message, /does not improve over lexical/);
  assert.equal(scientificEmbedding.evidence[0].requirement_status, 'incomplete');
});

test('idea-catalyst release gate rejects scientific embedding evidence missing input hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    scientificEmbeddingEvidenceReports: [scientificEmbeddingEvidence({
      inputs: [{ role: 'scientific_embedding_manifest', path: '/reports/scientific-embedding-manifest.json' }]
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const scientificEmbedding = manifest.requirements.find((entry) => entry.id === 'R4');
  assert.equal(scientificEmbedding.status, 'incomplete');
  assert.match(scientificEmbedding.message, /missing input hashes/);
});

test('idea-catalyst release gate propagates scientific embedding role-specific input hash failures', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    scientificEmbeddingEvidenceReports: [scientificEmbeddingEvidence({
      retrieval: {
        inputs: [{
          role: 'fixed_corpus_dataset',
          path: '/benchmarks/scirepeval-oag-graphrag-fixed-corpus.json',
          sha256: 'sha-retrieval-suite-dataset'
        }, {
          role: 'fixed_corpus_dense_scores',
          path: '/benchmarks/specter2-dense-scores.json',
          sha256: 'sha-retrieval-suite-dense'
        }]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const scientificEmbedding = manifest.requirements.find((entry) => entry.id === 'R4');
  assert.equal(scientificEmbedding.status, 'incomplete');
  assert.match(scientificEmbedding.message, /missing retrieval suite role-specific input hashes/);
});

test('idea-catalyst release gate requires replay-suite release readiness preflight', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'incomplete',
          releaseCandidate: false,
          reason: 'fixture/synthetic/mock/mini evidence cannot be release evidence'
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_incomplete/);
  assert.equal(mustCite.evidence[0].release_readiness_status, 'incomplete');
  assert.equal(mustCite.evidence[0].release_candidate, false);
});

test('idea-catalyst release gate rejects legacy replay manifests missing release readiness', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 4, releaseReadiness: null }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /missing_replay_suite_release_readiness/);
});

test('idea-catalyst release gate requires replay-suite holdout and time-slice readiness checks', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'ready_for_release_gate',
          releaseCandidate: true,
          reason: 'legacy ready preflight without holdout checks',
          checks: [
            gate('strict_time_cutoffs_present')
          ]
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_missing_venue_year_holdout_present/);
});

test('idea-catalyst release gate requires replay-suite release-grade improvement threshold check', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'ready_for_release_gate',
          releaseCandidate: true,
          reason: 'legacy ready preflight without release threshold checks',
          checks: [
            gate('strict_time_cutoffs_present'),
            gate('venue_year_holdout_present'),
            gate('time_slice_policy_present')
          ]
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_missing_release_grade_improvement_thresholds_present/);
});

test('idea-catalyst release gate requires replay-suite statistical significance preflight', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'ready_for_release_gate',
          releaseCandidate: true,
          reason: 'legacy ready preflight without statistical checks',
          checks: [
            gate('strict_time_cutoffs_present'),
            gate('venue_year_holdout_present'),
            gate('time_slice_policy_present'),
            gate('release_grade_improvement_thresholds_present'),
            gate('semantic_negative_coverage_present')
          ]
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_missing_statistical_significance_evidence_present/);
});

test('idea-catalyst release gate requires replay-suite statistical significance provenance preflight', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'ready_for_release_gate',
          releaseCandidate: true,
          reason: 'legacy ready preflight without statistical provenance checks',
          checks: [
            gate('strict_time_cutoffs_present'),
            gate('venue_year_holdout_present'),
            gate('time_slice_policy_present'),
            gate('release_grade_improvement_thresholds_present'),
            gate('semantic_negative_coverage_present'),
            gate('statistical_significance_evidence_present')
          ]
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_missing_statistical_significance_provenance_auditable/);
});

test('idea-catalyst release gate requires replay-suite semantic negative coverage preflight', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        releaseReadiness: {
          status: 'ready_for_release_gate',
          releaseCandidate: true,
          reason: 'legacy ready preflight without semantic negative checks',
          checks: [
            gate('strict_time_cutoffs_present'),
            gate('venue_year_holdout_present'),
            gate('time_slice_policy_present'),
            gate('release_grade_improvement_thresholds_present')
          ]
        }
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /replay_suite_release_readiness_missing_semantic_negative_coverage_present/);
});

test('idea-catalyst release gate requires replay-suite statistical significance payload', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        statisticalSignificance: {}
      }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /missing_statistical_significance_evidence/);
});

test('idea-catalyst release gate requires OpenAlex and COCI citation slices for E4', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', {
        mustCiteCases: 4,
        source: 'https://benchmarks.papernexus.org/masterset/snapshot',
        sourceFamilies: ['masterset']
      }),
      ...releaseInputs().replaySuites.filter((entry) => entry.dataset.format !== 'masterset')
    ]
  }));

  assert.equal(manifest.status, 'incomplete');
  const mustCite = manifest.requirements.find((entry) => entry.id === 'E4');
  assert.equal(mustCite.status, 'incomplete');
  assert.match(mustCite.message, /missing required citation source families: openalex, coci/);
  assert.deepEqual(mustCite.evidence[0].missing_source_families, ['openalex', 'coci']);
});

test('idea-catalyst release gate requires E1 major metric lift gate', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 4 }),
      replaySuite('novbench', { noveltyCases: 4 }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', {
        noveltyCases: 2,
        majorMetricsGate: 'failed',
        metrics: {
          major_metric_improvement_count: 2
        }
      })
    ]
  }));

  assert.equal(manifest.status, 'failed');
  const baseline = manifest.requirements.find((entry) => entry.id === 'E1');
  assert.equal(baseline.status, 'failed');
  assert.match(baseline.message, /replay-suite evidence failed/);
  assert.equal(baseline.evidence[0].gate, 'major_metrics_beat_baseline');
});

test('idea-catalyst release gate requires human blind release readiness preflight', () => {
  const aggregation = humanAggregation('passed');
  aggregation.releaseReadiness = {
    status: 'incomplete',
    releaseCandidate: false,
    reason: 'required reviewer role counts are not satisfied'
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human blind release readiness is incomplete/);
  assert.equal(human.evidence[0].release_readiness_status, 'incomplete');
  assert.equal(human.evidence[0].release_candidate, false);
});

test('idea-catalyst release gate requires independent human reviewer identities', () => {
  const aggregation = humanAggregation('passed');
  aggregation.reviewer_protocol.independent_reviewers = false;
  aggregation.reviewer_protocol.pairs = [{
    pair_id: 'pair:human-1',
    independent_reviewers: false,
    distinct_reviewer_count: 3,
    required_distinct_reviewer_count: 5,
    duplicate_reviewer_ids: ['human:1', 'human:2']
  }];
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human reviewer identities are not independent/);
  assert.equal(human.evidence[0].independent_reviewers, false);
  assert.deepEqual(human.evidence[0].pairs_without_independent_reviewers, ['pair:human-1']);
  assert.deepEqual(human.evidence[0].duplicate_reviewer_ids, ['human:1', 'human:2']);
});

test('idea-catalyst release gate rejects legacy human aggregations missing release readiness', () => {
  const aggregation = humanAggregation('passed');
  delete aggregation.releaseReadiness;
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind release readiness preflight/);
});

test('idea-catalyst release gate requires human blind assignment coverage preflight', () => {
  const aggregation = humanAggregation('passed');
  aggregation.releaseReadiness = {
    status: 'ready_for_release_gate',
    releaseCandidate: true,
    reason: 'legacy ready preflight without assignment coverage check',
    checks: [
      gate('review_form_completeness_satisfied')
    ]
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind assignment coverage check/);
});

test('idea-catalyst release gate requires human blind assignment coverage protocol', () => {
  const aggregation = humanAggregation('passed');
  aggregation.assignment_protocol = {
    ...aggregation.assignment_protocol,
    complete: false,
    target_pair_assignment_count: 20,
    required_target_pair_assignment_count: 20,
    completed_assignment_count: 19,
    missing_assignment_id_label_count: 1,
    missing_required_assignments: [{
      assignment_id: 'assignment:missing',
      pair_id: 'pair:human-1',
      reviewer_slot: 'domain_expert:1',
      reviewer_role: 'domain_expert'
    }]
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human blind assignment coverage is not satisfied/);
  assert.equal(human.evidence[0].assignment_coverage_complete, false);
  assert.equal(human.evidence[0].completed_assignment_count, 19);
  assert.equal(human.evidence[0].missing_assignment_id_label_count, 1);
});

test('idea-catalyst release gate requires human blind review form completeness preflight', () => {
  const aggregation = humanAggregation('passed');
  aggregation.releaseReadiness = {
    status: 'ready_for_release_gate',
    releaseCandidate: true,
    reason: 'legacy ready preflight without review form completeness check',
    checks: [
      gate('assignment_coverage_satisfied')
    ]
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind review form completeness check/);
});

test('idea-catalyst release gate requires human blind comparison coverage preflight', () => {
  const aggregation = humanAggregation('passed');
  aggregation.releaseReadiness = {
    status: 'ready_for_release_gate',
    releaseCandidate: true,
    reason: 'legacy ready preflight without comparison coverage check',
    checks: [
      gate('assignment_coverage_satisfied'),
      gate('review_form_completeness_satisfied')
    ]
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind comparison coverage check/);
});

test('idea-catalyst release gate requires human blind comparison coverage protocol', () => {
  const aggregation = humanAggregation('passed');
  aggregation.comparison_protocol = {
    complete: false,
    required_comparison_families: ['baseline', 'p0', 'p1', 'ablation'],
    covered_comparison_families: ['baseline'],
    missing_comparison_families: ['p0', 'p1', 'ablation']
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human blind comparison coverage is not satisfied/);
  assert.equal(human.evidence[0].comparison_coverage_complete, false);
  assert.deepEqual(human.evidence[0].missing_comparison_families, ['p0', 'p1', 'ablation']);
});

test('idea-catalyst release gate requires human blind blinding protocol audit', () => {
  const aggregation = humanAggregation('passed');
  aggregation.blinding_protocol = {
    complete: false,
    public_artifacts_present: true,
    payload_policy: 'proposal_and_evidence_export_only',
    missing_public_artifacts: [],
    forbidden_public_fields: ['blind_pack.packets[0].payload.system_label'],
    unexpected_public_payload_fields: [],
    answer_key_private: true
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human blind blinding protocol is not satisfied/);
  assert.equal(human.evidence[0].blinding_protocol_complete, false);
  assert.deepEqual(human.evidence[0].blinding_forbidden_public_fields, ['blind_pack.packets[0].payload.system_label']);
});

test('idea-catalyst release gate rechecks human blind payload policy', () => {
  const aggregation = humanAggregation('passed');
  aggregation.blinding_protocol = {
    ...aggregation.blinding_protocol,
    payload_policy: 'full_packet',
    unexpected_public_payload_fields: ['blind_pack.packets[0].payload.internal_notes']
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /human blind payload policy is not satisfied/);
  assert.equal(human.evidence[0].blinding_payload_policy, 'full_packet');
  assert.deepEqual(human.evidence[0].blinding_unexpected_public_payload_fields, ['blind_pack.packets[0].payload.internal_notes']);
});

test('idea-catalyst release gate rejects unexpected human blind public payload fields', () => {
  const aggregation = humanAggregation('passed');
  aggregation.blinding_protocol = {
    ...aggregation.blinding_protocol,
    unexpected_public_payload_fields: ['blind_pack.packets[0].payload.provider_trace']
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /public payload exposes unexpected fields/);
  assert.deepEqual(human.evidence[0].blinding_unexpected_public_payload_fields, ['blind_pack.packets[0].payload.provider_trace']);
});

test('idea-catalyst release gate rechecks human blind target preference threshold', () => {
  const aggregation = humanAggregation('passed');
  aggregation.target_preference_rate = 0.59;
  aggregation.preference_threshold = 0.6;
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /target preference threshold is not satisfied/);
  assert.equal(human.evidence[0].target_preference_rate, 0.59);
  assert.equal(human.evidence[0].preference_threshold, 0.6);
});

test('idea-catalyst release gate requires all human blind readiness checks', () => {
  const aggregation = humanAggregation('passed');
  aggregation.releaseReadiness = {
    status: 'ready_for_release_gate',
    releaseCandidate: true,
    reason: 'legacy ready preflight missing preference and target-pair checks',
    checks: [
      gate('assignment_coverage_satisfied'),
      gate('review_form_completeness_satisfied'),
      gate('comparison_coverage_satisfied'),
      gate('blinding_protocol_satisfied')
    ]
  };
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind release readiness checks/);
  assert.match(human.message, /target_preference_threshold_met/);
  assert.match(human.message, /target_pairs_present/);
});

test('idea-catalyst release gate requires human blind input hashes', () => {
  const aggregation = humanAggregation('passed');
  aggregation.inputs = [
    { role: 'human_blind_cases', path: '/benchmarks/human-blind/cases.json', sha256: 'sha-human-cases' },
    { role: 'human_blind_labels', path: '/benchmarks/human-blind/labels.json' }
  ];
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind input hashes/);
  assert.ok(human.evidence[0].missing_input_hashes.includes('human_blind_labels'));
});

test('idea-catalyst release gate requires human blind artifact hashes', () => {
  const aggregation = humanAggregation('passed');
  aggregation.blind_review_artifacts = aggregation.blind_review_artifacts.filter((entry) => entry.role !== 'human_blind_assignments');
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    humanAggregations: [aggregation]
  }));

  assert.equal(manifest.status, 'incomplete');
  const human = manifest.requirements.find((entry) => entry.id === 'E7');
  assert.equal(human.status, 'incomplete');
  assert.match(human.message, /missing human blind artifact hashes/);
  assert.ok(human.evidence[0].missing_blind_artifact_hashes.includes('human_blind_assignments'));
});

test('idea-catalyst release gate fails when a supplied benchmark gate fails', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    replaySuites: [
      replaySuite('masterset', { mustCiteCases: 4 }),
      replaySuite('novbench', { noveltyCases: 4, status: 'failed', noveltyGate: 'failed' }),
      replaySuite('claim-bench', { claimCases: 4 }),
      replaySuite('openreview', { noveltyCases: 2 })
    ]
  }));

  assert.equal(manifest.status, 'failed');
  const novelty = manifest.requirements.find((entry) => entry.id === 'E2');
  assert.equal(novelty.status, 'failed');
});

test('idea-catalyst release gate marks missing report-required ablations incomplete', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [ablationManifest(['without_must_cite', 'without_claim_spans', 'without_storyline_trace'])]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'incomplete');
  assert.ok(ablation.evidence[0].missing_ablations.includes('without_reviewer_panel'));
});

test('idea-catalyst release gate requires ablation artifact removal audits', () => {
  const legacyManifest = ablationManifest();
  delete legacyManifest.ablations.find((entry) => entry.ablation_id === 'without_must_cite').artifact_removal_audit;

  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [legacyManifest]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'incomplete');
  assert.ok(ablation.evidence[0].incomplete_ablation_audits.includes('without_must_cite'));
  assert.match(ablation.message, /without_must_cite is missing artifact removal audit/);
});

test('idea-catalyst release gate requires ablation effect audits', () => {
  const legacyManifest = ablationManifest();
  delete legacyManifest.ablations.find((entry) => entry.ablation_id === 'without_must_cite').ablation_effect_audit;

  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [legacyManifest]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'incomplete');
  assert.ok(ablation.evidence[0].incomplete_ablation_effect_audits.includes('without_must_cite'));
  assert.match(ablation.message, /without_must_cite is missing ablation effect audit/);
});

test('idea-catalyst release gate requires ablation input and variant report hashes', () => {
  const weakManifest = ablationManifest();
  weakManifest.inputs = [];
  delete weakManifest.ablations.find((entry) => entry.ablation_id === 'without_must_cite').report_artifact;

  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [weakManifest]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'incomplete');
  assert.ok(ablation.evidence[0].ablation_lineage_issues.includes('missing_ablation_benchmark_input_hash'));
  assert.ok(ablation.evidence[0].ablation_lineage_issues.includes('without_must_cite:missing_variant_report_hash'));
  assert.match(ablation.message, /missing hash lineage/);
});

test('idea-catalyst release gate rejects measured ablations without observed effect', () => {
  const weakManifest = ablationManifest();
  weakManifest.ablations.find((entry) => entry.ablation_id === 'without_claim_graph').ablation_effect_audit = {
    target_id: 'without_claim_graph',
    status: 'failed',
    effect_required: true,
    target_metric: 'claim_source_span_completeness',
    delta_from_control: 0,
    relevant_gate_status: 'passed',
    effect_observed: false
  };

  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [weakManifest]
  }));

  assert.equal(manifest.status, 'failed');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'failed');
  assert.ok(ablation.evidence[0].failed_ablation_effect_audits.includes('without_claim_graph'));
  assert.match(ablation.message, /without_claim_graph did not show the expected ablation effect/);
});

test('idea-catalyst release gate rejects structural-only required ablation lanes', () => {
  const structuralOnlyManifest = ablationManifest();
  structuralOnlyManifest.ablations.find((entry) => entry.ablation_id === 'without_graphrag_summaries').ablation_effect_audit = {
    target_id: 'without_graphrag_summaries',
    status: 'structural_only',
    effect_required: false,
    reason: 'artifact removal only'
  };

  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ablationManifests: [structuralOnlyManifest]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ablation = manifest.requirements.find((entry) => entry.id === 'AB1');
  assert.equal(ablation.status, 'incomplete');
  assert.ok(ablation.evidence[0].incomplete_ablation_effect_audits.includes('without_graphrag_summaries'));
  assert.match(ablation.message, /without_graphrag_summaries requires a measured ablation effect audit/);
});

test('idea-catalyst release gate requires graph link-prediction benchmark evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphLinkPredictionReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const linkPrediction = manifest.requirements.find((entry) => entry.id === 'R7');
  assert.equal(linkPrediction.status, 'incomplete');
  assert.match(linkPrediction.message, /missing graph link-prediction benchmark evidence/);
});

test('idea-catalyst release gate rejects non-release graph link-prediction reports', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphLinkPredictionReports: [graphLinkPredictionReport('passed', {
      name: 'temporal-link-prediction fixture',
      source: 'fixture'
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const linkPrediction = manifest.requirements.find((entry) => entry.id === 'R7');
  assert.equal(linkPrediction.status, 'incomplete');
  assert.match(linkPrediction.message, /fixture_or_synthetic_evidence/);
});

test('idea-catalyst release gate requires every graph link-prediction source family', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphLinkPredictionReports: [graphLinkPredictionReport('passed', {
      name: 'OAG OpenAlex Temporal Link Prediction 2026-05',
      source: 'https://benchmarks.papernexus.org/oag-openalex-link-prediction/2026-05',
      trainingSlice: 'openalex-oag-2020-2024',
      inputPath: '/benchmarks/oag-openalex-link-prediction/gold-temporal-edges.json'
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const linkPrediction = manifest.requirements.find((entry) => entry.id === 'R7');
  assert.equal(linkPrediction.status, 'incomplete');
  assert.match(linkPrediction.message, /missing graph link-prediction source families: internal_kg/);
  assert.deepEqual(linkPrediction.evidence[0].missing_source_families, ['internal_kg']);
});

test('idea-catalyst release gate requires full graph link-prediction eval reports', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    graphLinkPredictionReports: [graphLinkPredictionReport('passed', {
      contractVersion: 'papernexus-graph-link-prediction-manifest-v1'
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const linkPrediction = manifest.requirements.find((entry) => entry.id === 'R7');
  assert.equal(linkPrediction.status, 'incomplete');
  assert.match(linkPrediction.message, /contract version is missing or unsupported/);
});

test('idea-catalyst release gate requires ingestion graph mutation execution evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /missing ingestion graph mutation execution evidence/);
});

test('idea-catalyst release gate rejects preview-only ingestion mutation execution', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      status: 'previewed',
      applyStatus: 'previewed',
      dryRun: true,
      safety: {
        authoritativeGraphWritePerformed: false,
        rollbackManifestRequired: false
      },
      plan: {
        status: 'preview_only',
        canApply: false,
        releaseGateStatus: 'incomplete',
        gates: [
          gate('graph_mutations_present', 'passed'),
          gate('citation_intent_benchmark_passed', 'incomplete'),
          gate('claim_extraction_benchmark_passed', 'incomplete'),
          gate('explicit_release_gated_apply_requested', 'incomplete')
        ]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /did not apply authoritative graph mutations/);
});

test('idea-catalyst release gate fails when ingestion claim or citation gates fail', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      plan: {
        gates: [
          gate('graph_mutations_present', 'passed'),
          gate('citation_intent_benchmark_passed', 'failed'),
          gate('claim_extraction_benchmark_passed', 'passed'),
          gate('explicit_release_gated_apply_requested', 'passed')
        ]
      }
    })]
  }));

  assert.equal(manifest.status, 'failed');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'failed');
  assert.match(ingestion.message, /citation_intent_benchmark_passed/);
});

test('idea-catalyst release gate requires multimodal asset audit gate for ingestion execution', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      plan: {
        gates: [
          gate('graph_mutations_present', 'passed'),
          gate('citation_intent_benchmark_passed', 'passed'),
          gate('claim_extraction_benchmark_passed', 'passed'),
          gate('explicit_release_gated_apply_requested', 'passed')
        ]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /multimodal_asset_audit_complete/);
});

test('idea-catalyst release gate requires ingestion execution input hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      inputs: [
        { role: 'graph_mutations', path: '/artifacts/ingestion/graph-mutations.json' },
        { role: 'graph_apply_plan', path: '/artifacts/ingestion/graph-apply-plan.json', sha256: 'sha-graph-apply-plan' },
        { role: 'citation_intent_gold_labels', path: '/artifacts/ingestion/citation-intent-gold.json', sha256: 'sha-citation-intent-gold' },
        { role: 'claim_extraction_gold_labels', path: '/artifacts/ingestion/claim-extraction-gold.json', sha256: 'sha-claim-extraction-gold' },
        { role: 'multimodal_assets', path: '/artifacts/ingestion/multimodal-assets.json', sha256: 'sha-multimodal-assets' }
      ]
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /missing input hashes/);
});

test('idea-catalyst release gate requires ingestion role-specific input hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      inputs: [
        { role: 'graph_mutations', path: '/artifacts/ingestion/graph-mutations.json', sha256: 'sha-graph-mutations' },
        { role: 'graph_apply_plan', path: '/artifacts/ingestion/graph-apply-plan.json', sha256: 'sha-graph-apply-plan' }
      ]
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /missing ingestion role-specific input hashes/);
  assert.deepEqual(ingestion.evidence[0].missing_input_role_hashes, [
    'citation_intent_gold_labels',
    'claim_extraction_gold_labels',
    'multimodal_assets'
  ]);
});

test('idea-catalyst release gate requires rollback artifact hashes for ingestion mutation execution', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [ingestionGraphMutationExecutionReport({
      artifacts: {
        rollbackManifestSha256: '',
        beforeGraphSnapshotSha256: ''
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /rollback manifest or before-graph snapshot hash/);
  assert.equal(ingestion.evidence[0].rollback_manifest_sha256, null);
  assert.equal(ingestion.evidence[0].before_graph_snapshot_sha256, null);
});

test('idea-catalyst release gate rejects fixture ingestion mutation execution evidence', () => {
  const report = ingestionGraphMutationExecutionReport();
  report.corpusRoot = '/tmp/fixture-corpus';
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    ingestionGraphMutationExecutionReports: [report]
  }));

  assert.equal(manifest.status, 'incomplete');
  const ingestion = manifest.requirements.find((entry) => entry.id === 'R3');
  assert.equal(ingestion.status, 'incomplete');
  assert.match(ingestion.message, /fixture_or_synthetic_evidence/);
});

test('idea-catalyst release gate requires innovation sidecar evidence for R5 and R6', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  const counterfactual = manifest.requirements.find((entry) => entry.id === 'R6');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.equal(counterfactual.status, 'incomplete');
  assert.match(modelAssisted.message, /missing innovation sidecar release evidence/);
  assert.match(counterfactual.message, /missing innovation sidecar release evidence/);
});

test('idea-catalyst release gate rejects sidecar evidence missing an R5 requirement', () => {
  const sidecar = innovationSidecarEvidence();
  sidecar.requirements = sidecar.requirements.filter((entry) => entry.id !== 'R5');
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [sidecar]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /missing R5/);
});

test('idea-catalyst release gate rejects incomplete model-assisted sidecar evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      model: {
        benchmark_families: ['novbench', 'claim-bench', 'openreview'],
        dataset: {
          name: 'NovBench CLAIM-BENCH OpenReview calibration set',
          format: 'novbench-claim-openreview-style',
          source: 'https://benchmarks.papernexus.org/model-assisted-calibration/2026-05',
          license_scope: 'public benchmark research use'
        }
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /missing model-assisted benchmark families: rinobench/);
});

test('idea-catalyst release gate rejects model-assisted calibration without holdout split', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      model: {
        evaluation_dataset: '',
        evaluation_run_id: '',
        holdout_policy: ''
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /independent evaluation\/holdout split/);
});

test('idea-catalyst release gate rejects sidecar model evidence missing required gates', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      model: {
        gates: []
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /missing required model-assisted gates/);
  assert.deepEqual(modelAssisted.evidence[0].nested_evidence[0].missing_required_gates, ['model_calibration_complete', 'benchmark_metrics_passed']);
});

test('idea-catalyst release gate rejects sidecar model evidence missing role-specific hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      model: {
        inputs: [{
          role: 'calibration_dataset',
          path: '/benchmarks/model-assisted-calibration.jsonl',
          sha256: 'sha-model-assisted-calibration'
        }]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /missing model-assisted role-specific input hashes/);
  assert.deepEqual(modelAssisted.evidence[0].nested_evidence[0].missing_input_role_hashes, ['holdout_evaluation']);
});

test('idea-catalyst release gate rejects failed counterfactual sidecar evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      counterfactual: {
        status: 'failed',
        gates: [gate('counterfactual_usefulness', 'failed')]
      }
    })]
  }));

  assert.equal(manifest.status, 'failed');
  const counterfactual = manifest.requirements.find((entry) => entry.id === 'R6');
  assert.equal(counterfactual.status, 'failed');
  assert.match(counterfactual.message, /counterfactual usefulness evidence failed/);
});

test('idea-catalyst release gate rejects sidecar counterfactual evidence missing required gates', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      counterfactual: {
        gates: []
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const counterfactual = manifest.requirements.find((entry) => entry.id === 'R6');
  assert.equal(counterfactual.status, 'incomplete');
  assert.match(counterfactual.message, /missing required counterfactual gates/);
  assert.deepEqual(counterfactual.evidence[0].nested_evidence[0].missing_required_gates, ['counterfactual_usefulness']);
});

test('idea-catalyst release gate rejects weak counterfactual sidecar usefulness evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      counterfactual: {
        usefulness_score: 0.49,
        metrics: {
          usefulness_score: 0.49,
          failure_discovery_rate: 0.58
        }
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const counterfactual = manifest.requirements.find((entry) => entry.id === 'R6');
  assert.equal(counterfactual.status, 'incomplete');
  assert.match(counterfactual.message, /usefulness score is missing or below 0\.5/);
  assert.equal(counterfactual.evidence[0].nested_evidence[0].min_usefulness_score, 0.5);
});

test('idea-catalyst release gate rejects sidecar counterfactual evidence missing role-specific hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      counterfactual: {
        inputs: [{
          role: 'usefulness_labels',
          path: '/benchmarks/counterfactual-usefulness.jsonl',
          sha256: 'sha-counterfactual-usefulness'
        }]
      }
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const counterfactual = manifest.requirements.find((entry) => entry.id === 'R6');
  assert.equal(counterfactual.status, 'incomplete');
  assert.match(counterfactual.message, /missing counterfactual role-specific input hashes/);
  assert.deepEqual(counterfactual.evidence[0].nested_evidence[0].missing_input_role_hashes, ['counterfactual_candidates', 'selected_plans']);
});

test('idea-catalyst release gate requires sidecar input hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    innovationSidecarEvidenceReports: [innovationSidecarEvidence({
      inputs: [
        { role: 'model_assisted_calibration_report', path: '/reports/model-assisted-calibration.json' },
        { role: 'counterfactual_usefulness_report', path: '/reports/counterfactual-usefulness.json', sha256: 'sha-counterfactual-report' }
      ]
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const modelAssisted = manifest.requirements.find((entry) => entry.id === 'R5');
  assert.equal(modelAssisted.status, 'incomplete');
  assert.match(modelAssisted.message, /missing input hashes/);
});

test('idea-catalyst release gate requires engineering test evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    engineeringEvidenceReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const engineering = manifest.requirements.find((entry) => entry.id === 'T1');
  assert.equal(engineering.status, 'incomplete');
  assert.match(engineering.message, /missing engineering release test evidence/);
});

test('idea-catalyst release gate fails when required engineering tests fail', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    engineeringEvidenceReports: [engineeringEvidence('failed', {
      failedTests: ['test/mcp-http.test.js']
    })]
  }));

  assert.equal(manifest.status, 'failed');
  const engineering = manifest.requirements.find((entry) => entry.id === 'T1');
  assert.equal(engineering.status, 'failed');
  assert.match(engineering.message, /required engineering release tests failed/);
});

test('idea-catalyst release gate requires docs sync evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    docsSyncEvidenceReports: []
  }));

  assert.equal(manifest.status, 'incomplete');
  const docsSync = manifest.requirements.find((entry) => entry.id === 'D1');
  assert.equal(docsSync.status, 'incomplete');
  assert.match(docsSync.message, /missing docs sync release evidence/);
});

test('idea-catalyst release gate fails when required docs sync checks fail', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    docsSyncEvidenceReports: [docsSyncEvidence('failed', {
      failedChecks: ['mcp_schema_snapshot']
    })]
  }));

  assert.equal(manifest.status, 'failed');
  const docsSync = manifest.requirements.find((entry) => entry.id === 'D1');
  assert.equal(docsSync.status, 'failed');
  assert.match(docsSync.message, /docs sync checks failed/);
});

test('idea-catalyst release gate requires docs sync input hashes', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    docsSyncEvidenceReports: [docsSyncEvidence('passed', {
      missingInputHashes: ['docs/eval/idea-catalyst-v2-migration-notes.md']
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const docsSync = manifest.requirements.find((entry) => entry.id === 'D1');
  assert.equal(docsSync.status, 'incomplete');
  assert.match(docsSync.message, /missing required docs sync input hashes/);
});

test('idea-catalyst release gate requires docs sync input stability evidence', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    docsSyncEvidenceReports: [docsSyncEvidence('passed', {
      inputStabilityChecked: false
    })]
  }));

  assert.equal(manifest.status, 'incomplete');
  const docsSync = manifest.requirements.find((entry) => entry.id === 'D1');
  assert.equal(docsSync.status, 'incomplete');
  assert.match(docsSync.message, /input stability was not checked/);
});

test('idea-catalyst release gate fails when docs sync inputs change during checks', () => {
  const manifest = buildIdeaCatalystReleaseGateManifest(releaseInputs({
    docsSyncEvidenceReports: [docsSyncEvidence('passed', {
      changedInputCount: 1,
      changedInputHashes: ['docs/reference/generated/mcp-tools.md']
    })]
  }));

  assert.equal(manifest.status, 'failed');
  const docsSync = manifest.requirements.find((entry) => entry.id === 'D1');
  assert.equal(docsSync.status, 'failed');
  assert.match(docsSync.message, /inputs changed during checks/);
  assert.ok(docsSync.evidence[0].changed_input_hashes.includes('docs/reference/generated/mcp-tools.md'));
});

test('idea-catalyst release gate preparation writes manifest and markdown report', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-gate-'));
  try {
    const replayPaths = [];
    const ablationPath = path.join(tempRoot, 'ablation.json');
    const humanPath = path.join(tempRoot, 'human.json');
    const graphPath = path.join(tempRoot, 'graph.json');
    const linkPredictionPath = path.join(tempRoot, 'graph-link-prediction.json');
    const scientificEmbeddingPath = path.join(tempRoot, 'scientific-embedding.json');
    const innovationSidecarPath = path.join(tempRoot, 'innovation-sidecar.json');
    const ingestionGraphMutationPath = path.join(tempRoot, 'ingestion-graph-mutation-execution.json');
    const engineeringPath = path.join(tempRoot, 'engineering.json');
    const docsSyncPath = path.join(tempRoot, 'docs-sync.json');
    const outputDir = path.join(tempRoot, 'out');

    for (const [index, suite] of releaseInputs().replaySuites.entries()) {
      const replayPath = path.join(tempRoot, `replay-${index + 1}-${suite.dataset.format}.json`);
      replayPaths.push(replayPath);
      await fs.writeFile(replayPath, `${JSON.stringify(suite, null, 2)}\n`);
    }
    await fs.writeFile(ablationPath, `${JSON.stringify(ablationManifest(), null, 2)}\n`);
    await fs.writeFile(humanPath, `${JSON.stringify(humanAggregation(), null, 2)}\n`);
    await fs.writeFile(graphPath, `${JSON.stringify(graphReasoningReport(), null, 2)}\n`);
    await fs.writeFile(linkPredictionPath, `${JSON.stringify(graphLinkPredictionReport(), null, 2)}\n`);
    await fs.writeFile(scientificEmbeddingPath, `${JSON.stringify(scientificEmbeddingEvidence(), null, 2)}\n`);
    await fs.writeFile(innovationSidecarPath, `${JSON.stringify(innovationSidecarEvidence(), null, 2)}\n`);
    await fs.writeFile(ingestionGraphMutationPath, `${JSON.stringify(ingestionGraphMutationExecutionReport(), null, 2)}\n`);
    await fs.writeFile(engineeringPath, `${JSON.stringify(engineeringEvidence(), null, 2)}\n`);
    await fs.writeFile(docsSyncPath, `${JSON.stringify(docsSyncEvidence(), null, 2)}\n`);

    const manifest = await prepareIdeaCatalystReleaseGateManifest({
      replaySuiteManifestPaths: replayPaths,
      ablationManifestPaths: [ablationPath],
      humanAggregationPaths: [humanPath],
      graphReasoningReportPaths: [graphPath],
      graphLinkPredictionReportPaths: [linkPredictionPath],
      scientificEmbeddingEvidencePaths: [scientificEmbeddingPath],
      innovationSidecarEvidencePaths: [innovationSidecarPath],
      ingestionGraphMutationExecutionPaths: [ingestionGraphMutationPath],
      engineeringEvidencePaths: [engineeringPath],
      docsSyncEvidencePaths: [docsSyncPath],
      outputDir,
      runId: 'release-write'
    });

    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.summary.evidence_input_count, 19);
    assert.equal(manifest.summary.evidence_input_hash_count, 19);
    assert.ok(manifest.evidence_inputs.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.ok(manifest.evidence_inputs.some((entry) => entry.role === 'scientific_embedding_release_evidence'));
    assert.ok(manifest.evidence_inputs.some((entry) => entry.role === 'docs_sync_release_evidence'));
    const manifestOnDisk = JSON.parse(await fs.readFile(path.join(outputDir, 'release-gate-manifest.json'), 'utf8'));
    assert.equal(manifestOnDisk.status, 'passed');
    assert.equal(manifestOnDisk.evidence_inputs.length, 19);
    assert.match(await fs.readFile(path.join(outputDir, 'release-gate-report.md'), 'utf8'), /Idea-Catalyst Release Gate/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
