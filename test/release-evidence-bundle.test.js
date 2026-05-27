import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  collectReleaseGateEvidenceInputs,
  collectReleaseEvidenceLineageArtifacts,
  collectReleaseEvidenceSourceSnapshots,
  createReleaseEvidenceBundleSkeleton,
  prepareReleaseEvidenceBundleAudit,
  RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
  RELEASE_EVIDENCE_BUNDLE_VERSION
} from '../src/core/eval/release-evidence-bundle.js';
import {
  DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
  REQUIRED_DOCS_SYNC_CHECKS,
  REQUIRED_DOCS_SYNC_INPUTS
} from '../src/core/eval/docs-sync-release-evidence.js';
import {
  ENGINEERING_RELEASE_EVIDENCE_VERSION,
  REQUIRED_ENGINEERING_TESTS
} from '../src/core/eval/engineering-release-evidence.js';
import { IDEA_CATALYST_RELEASE_GATE_VERSION } from '../src/core/eval/release-gate-manifest.js';

const execFileAsync = promisify(execFile);
const RELEASE_DATASET_FAMILIES = [
  { id: 'masterset', slug: 'masterset', label: 'MasterSet' },
  { id: 'novbench', slug: 'novbench', label: 'NovBench' },
  { id: 'rinobench', slug: 'rinobench', label: 'RINoBench' },
  { id: 'axiomatic_novelty', slug: 'axiomatic-novelty', label: 'axiomatic novelty benchmark' },
  { id: 'claim_bench', slug: 'claim-bench', label: 'CLAIM-BENCH' },
  { id: 'claimcheck', slug: 'claimcheck', label: 'CLAIMCHECK' },
  { id: 'openreview', slug: 'openreview', label: 'OpenReview' },
  { id: 'peerread', slug: 'peerread', label: 'PeerRead' },
  { id: 'moprd', slug: 'moprd', label: 'MOPRD' },
  { id: 're2', slug: 're2', label: 'Re2 historical replay' }
];
const RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE = {
  full: [
    'replay_suite_manifest',
    'ablation_manifest',
    'human_blind_aggregation',
    'graph_reasoning_report',
    'scientific_embedding_release_evidence',
    'innovation_sidecar_release_evidence',
    'graph_link_prediction_report',
    'ingestion_graph_mutation_execution',
    'engineering_release_evidence',
    'docs_sync_release_evidence'
  ],
  p0_p1: [
    'replay_suite_manifest',
    'ablation_manifest',
    'human_blind_aggregation',
    'ingestion_graph_mutation_execution',
    'engineering_release_evidence',
    'docs_sync_release_evidence'
  ]
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function normalizeReleaseScope(value = '') {
  const key = String(value || 'full').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['p0_p1', 'p0p1', 'p0_p1_only', 'p0_and_p1', 'phase_p0_p1'].includes(key)) return 'p0_p1';
  return 'full';
}

function releaseGateEvidenceInputRolesForScope(scope = 'full') {
  return RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE[normalizeReleaseScope(scope)]
    || RELEASE_GATE_EVIDENCE_INPUT_ROLES_BY_SCOPE.full;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function createBundleFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-bundle-'));
  const releaseScope = normalizeReleaseScope(options.releaseScope || 'full');
  const rawInputs = [];
  const normalizedDatasets = [];
  const datasetMetadatas = [];
  const runConfig = path.join(root, 'run-config.json');
  const evidenceReport = path.join(root, 'reports', 'replay-suite-manifest.json');
  const statisticalSignificanceReport = path.join(root, 'reports', 'statistical-significance.json');
  const ablationManifest = path.join(root, 'reports', 'ablation-manifest.json');
  const ablationBenchmark = path.join(root, 'ablations', 'ablation-benchmark.json');
  const ablationVariantReport = path.join(root, 'ablations', 'without-must-cite-report.json');
  const humanBlindCases = path.join(root, 'human-blind', 'cases.json');
  const humanBlindLabels = path.join(root, 'human-blind', 'labels.json');
  const humanBlindPack = path.join(root, 'human-blind', 'blind-pack.json');
  const humanBlindAssignments = path.join(root, 'human-blind', 'assignments.json');
  const humanBlindAnswerKey = path.join(root, 'human-blind', 'answer-key.json');
  const humanBlindReviewFormSchema = path.join(root, 'human-blind', 'review-form.schema.json');
  const humanBlindAggregation = path.join(root, 'reports', 'human-blind-aggregation.json');
  const ingestionGraphMutations = path.join(root, 'ingestion', 'graph-mutations.json');
  const ingestionGraphApplyPlan = path.join(root, 'ingestion', 'graph-apply-plan.json');
  const ingestionCitationIntentGold = path.join(root, 'ingestion', 'citation-intent-gold.json');
  const ingestionClaimExtractionGold = path.join(root, 'ingestion', 'claim-extraction-gold.json');
  const ingestionMultimodalAssets = path.join(root, 'ingestion', 'multimodal-assets.json');
  const ingestionRollbackManifest = path.join(root, 'ingestion', 'rollback-manifest.json');
  const ingestionBeforeGraphSnapshot = path.join(root, 'ingestion', 'before-graph-snapshot.json');
  const ingestionGraphMutationExecution = path.join(root, 'reports', 'graph-mutation-execution-report.json');
  const engineeringReport = path.join(root, 'reports', 'engineering-release-evidence.json');
  const docsSyncReport = path.join(root, 'reports', 'docs-sync-release-evidence.json');
  const sourceRoot = path.join(root, 'source');
  const releaseGateManifest = path.join(root, 'release-gate-manifest.json');
  const stdoutLog = path.join(root, 'logs', 'stdout.log');
  const stderrLog = path.join(root, 'logs', 'stderr.log');
  const sourceFiles = new Map();

  async function writeSourceInput(relativePath, content = '') {
    const normalizedPath = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
    const filePath = path.join(sourceRoot, normalizedPath);
    await writeText(filePath, content || `fixture source snapshot for ${normalizedPath}\n`);
    sourceFiles.set(normalizedPath, filePath);
    return filePath;
  }

  async function sourceInputRecord(relativePath, role = 'required_sync_input') {
    const normalizedPath = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
    const filePath = sourceFiles.get(normalizedPath) || await writeSourceInput(normalizedPath);
    const stats = await fs.stat(filePath);
    return {
      role,
      path: filePath,
      relative_path: normalizedPath,
      exists: true,
      size_bytes: stats.size,
      sha256: await sha256File(filePath)
    };
  }

  for (const family of RELEASE_DATASET_FAMILIES) {
    const rawInput = path.join(root, 'raw-inputs', `${family.slug}.json`);
    const normalizedDataset = path.join(root, 'normalized-datasets', `${family.slug}-replay.json`);
    await writeJson(rawInput, options.missingDatasetMetadata
      ? { dataset: `${family.label} release input`, family: family.id }
      : {
          dataset: `${family.label} release input`,
          family: family.id,
          metadata: {
            source: `${family.label} 2026-05 release snapshot`,
            license_scope: 'public benchmark research use'
          }
        });
    const rawInputSha256 = await sha256File(rawInput);
    const omitFamilyMetadata = options.missingDatasetMetadata || options.omitFamilyMetadata === family.id;
    const datasetMetadata = {
      family: family.id,
      name: family.label,
      source: `${family.label} 2026-05 release snapshot`,
      license_scope: 'public benchmark research use',
      raw_input_sha256: rawInputSha256,
      time_cutoff: '2024-12-31',
      adapter_format: `${family.slug}-replay-v1`,
      holdout_policy: 'venue/year holdout split with no target venue-year overlap',
      time_slice_policy: 'OpenAlex/S2ORC/reference snapshot cutoff at 2024-12-31'
    };
    await writeJson(normalizedDataset, omitFamilyMetadata
      ? {
          family: family.id,
          cases: [{ id: `case:${family.id}`, time_cutoff: '2024-12-31' }]
        }
      : {
          family: family.id,
          metadata: datasetMetadata,
          cases: [{ id: `case:${family.id}`, time_cutoff: '2024-12-31' }]
        });
    rawInputs.push(rawInput);
    normalizedDatasets.push(normalizedDataset);
    datasetMetadatas.push(omitFamilyMetadata ? { family: family.id, name: family.label } : datasetMetadata);
  }
  const runConfigRecord = {
    command: 'npm run eval:idea-catalyst-release-gate',
    datasets: datasetMetadatas
  };
  if (options.globalRunConfigMetadata) {
    Object.assign(runConfigRecord, {
      source: 'global release snapshot',
      license_scope: 'global research use',
      raw_input_sha256: await sha256File(rawInputs[0]),
      time_cutoff: '2024-12-31',
      adapter_format: 'global-replay-v1',
      holdout_policy: 'global venue/year holdout split',
      time_slice_policy: 'global source time slice policy'
    });
  }
  await writeJson(runConfig, options.missingDatasetMetadata
    ? { command: 'npm run eval:idea-catalyst-release-gate' }
    : runConfigRecord);
  const evidenceFamilies = datasetMetadatas
    .filter((entry) => entry.family !== options.omitEvidenceReportRawHashForFamily)
    .map((entry) => ({
      family: entry.family,
      raw_input_sha256: entry.raw_input_sha256,
      inputs: [{ role: 'raw_input', sha256: entry.raw_input_sha256 }]
    }));
  await writeJson(statisticalSignificanceReport, {
    contractVersion: 'papernexus-statistical-significance-report-v1',
    status: 'passed',
    paired_case_ids: RELEASE_DATASET_FAMILIES.map((entry) => `case:${entry.id}`),
    tests: [
      {
        metric: 'novelty_precision_at_10',
        p_value: 0.01,
        confidence_interval: [0.04, 0.12],
        effect_size: 0.08
      }
    ]
  });
  const statisticalSignificanceSha256 = await sha256File(statisticalSignificanceReport);
  const evidenceReportInputs = [
    {
      role: 'statistical_significance',
      path: statisticalSignificanceReport,
      sha256: statisticalSignificanceSha256
    }
  ];
  const evidenceReportRecord = {
    contractVersion: 'idea-catalyst-replay-suite-v1',
    status: 'passed',
    statistical_significance_provenance: {
      source: 'statistical_significance_file',
      path: statisticalSignificanceReport
    },
    inputs: evidenceReportInputs,
    evidence_families: evidenceFamilies
  };
  if (options.addTopLevelRawInputHashesToEvidenceReport) {
    evidenceReportInputs.push(...datasetMetadatas
      .map((entry) => ({ role: 'raw_input', sha256: entry.raw_input_sha256 })));
  }
  await writeJson(evidenceReport, evidenceReportRecord);
  await writeJson(ablationBenchmark, {
    contractVersion: 'idea-catalyst-ablation-benchmark-v1',
    status: 'passed',
    cases: [{ id: 'case:ablation', family: 'masterset' }]
  });
  await writeJson(ablationVariantReport, {
    contractVersion: 'idea-catalyst-historical-replay-v1',
    runId: 'without-must-cite',
    status: 'passed'
  });
  const ablationBenchmarkSha256 = await sha256File(ablationBenchmark);
  const ablationVariantReportSha256 = await sha256File(ablationVariantReport);
  await writeJson(ablationManifest, {
    contractVersion: 'idea-catalyst-ablation-runner-v1',
    runId: 'ablation-release',
    status: 'passed',
    inputs: [{
      role: 'ablation_benchmark',
      path: ablationBenchmark,
      sha256: ablationBenchmarkSha256
    }],
    ablations: [{
      ablation_id: 'without_must_cite',
      status: 'passed',
      report_artifact: {
        role: 'ablation_variant_report',
        path: ablationVariantReport,
        sha256: ablationVariantReportSha256
      }
    }]
  });
  await writeJson(humanBlindCases, {
    contractVersion: 'papernexus-human-blind-cases-v1',
    cases: [{ pair_id: 'pair:1', systems: ['baseline', 'p0'] }]
  });
  await writeJson(humanBlindLabels, {
    contractVersion: 'papernexus-human-blind-labels-v1',
    labels: [{ assignment_id: 'assignment:1', pair_id: 'pair:1', reviewer_role: 'domain_expert' }]
  });
  await writeJson(humanBlindPack, {
    contractVersion: 'papernexus-human-blind-pack-v1',
    pairs: [{ pair_id: 'pair:1', payload: { proposal: {}, evidence_export: {} } }]
  });
  await writeJson(humanBlindAssignments, {
    contractVersion: 'papernexus-human-blind-assignments-v1',
    assignments: [{ assignment_id: 'assignment:1', pair_id: 'pair:1', reviewer_role: 'domain_expert' }]
  });
  await writeJson(humanBlindAnswerKey, {
    contractVersion: 'papernexus-human-blind-answer-key-v1',
    systems: [{ pair_id: 'pair:1', blind_id: 'A', system: 'p0' }]
  });
  await writeJson(humanBlindReviewFormSchema, {
    contractVersion: 'papernexus-human-blind-review-form-schema-v1',
    required_dimensions: ['novelty', 'significance', 'feasibility', 'grounding', 'storyline_coherence', 'must_cite_completeness']
  });
  const humanBlindCaseSha256 = await sha256File(humanBlindCases);
  const humanBlindLabelsSha256 = await sha256File(humanBlindLabels);
  const humanBlindPackSha256 = await sha256File(humanBlindPack);
  const humanBlindAssignmentsSha256 = await sha256File(humanBlindAssignments);
  const humanBlindAnswerKeySha256 = await sha256File(humanBlindAnswerKey);
  const humanBlindReviewFormSchemaSha256 = await sha256File(humanBlindReviewFormSchema);
  await writeJson(humanBlindAggregation, {
    contractVersion: 'human-blind-eval-v1',
    runId: 'human-blind-release',
    status: 'passed',
    inputs: [
      {
        role: 'human_blind_cases',
        path: humanBlindCases,
        sha256: humanBlindCaseSha256
      },
      {
        role: 'human_blind_labels',
        path: humanBlindLabels,
        sha256: humanBlindLabelsSha256
      }
    ],
    blind_review_artifacts: [
      {
        role: 'human_blind_pack',
        path: humanBlindPack,
        sha256: humanBlindPackSha256
      },
      {
        role: 'human_blind_assignments',
        path: humanBlindAssignments,
        sha256: humanBlindAssignmentsSha256
      },
      {
        role: 'human_blind_answer_key',
        path: humanBlindAnswerKey,
        sha256: humanBlindAnswerKeySha256
      },
      {
        role: 'human_blind_review_form_schema',
        path: humanBlindReviewFormSchema,
        sha256: humanBlindReviewFormSchemaSha256
      }
    ]
  });
  await writeJson(ingestionGraphMutations, {
    contractVersion: 'papernexus-ingestion-graph-mutations-v1',
    operations: [{ action: 'create_node', id: 'claim:release-fixture', type: 'Claim' }]
  });
  await writeJson(ingestionCitationIntentGold, {
    contractVersion: 'papernexus-citation-intent-gold-v1',
    labels: [{ citation_id: 'citation:1', intent: 'background' }]
  });
  await writeJson(ingestionClaimExtractionGold, {
    contractVersion: 'papernexus-claim-extraction-gold-v1',
    labels: [{ claim_id: 'claim:1', supported: true }]
  });
  await writeJson(ingestionMultimodalAssets, {
    contractVersion: 'papernexus-multimodal-assets-v1',
    assets: [{ id: 'asset:1', type: 'figure', evidenceHash: 'asset-hash' }]
  });
  const ingestionGraphMutationsSha256 = await sha256File(ingestionGraphMutations);
  const ingestionCitationIntentGoldSha256 = await sha256File(ingestionCitationIntentGold);
  const ingestionClaimExtractionGoldSha256 = await sha256File(ingestionClaimExtractionGold);
  const ingestionMultimodalAssetsSha256 = await sha256File(ingestionMultimodalAssets);
  await writeJson(ingestionGraphApplyPlan, {
    contractVersion: 'papernexus-ingestion-graph-apply-plan-v1',
    status: 'ready_to_apply',
    canApply: true,
    inputs: [
      {
        role: 'citation_intent_gold_labels',
        path: ingestionCitationIntentGold,
        sha256: ingestionCitationIntentGoldSha256
      },
      {
        role: 'claim_extraction_gold_labels',
        path: ingestionClaimExtractionGold,
        sha256: ingestionClaimExtractionGoldSha256
      },
      {
        role: 'multimodal_assets',
        path: ingestionMultimodalAssets,
        sha256: ingestionMultimodalAssetsSha256
      }
    ]
  });
  await writeJson(ingestionRollbackManifest, {
    contractVersion: 'papernexus-ingestion-graph-mutation-rollback-v1',
    status: 'ready_for_manual_restore',
    beforeGraphSnapshotPath: ingestionBeforeGraphSnapshot
  });
  await writeJson(ingestionBeforeGraphSnapshot, {
    contractVersion: 'papernexus-before-graph-snapshot-v1',
    graph: { nodes: [], edges: [] }
  });
  const ingestionGraphApplyPlanSha256 = await sha256File(ingestionGraphApplyPlan);
  const ingestionRollbackManifestSha256 = await sha256File(ingestionRollbackManifest);
  const ingestionBeforeGraphSnapshotSha256 = await sha256File(ingestionBeforeGraphSnapshot);
  await writeJson(ingestionGraphMutationExecution, {
    contractVersion: 'papernexus-ingestion-graph-mutation-execution-v1',
    status: 'applied',
    applyStatus: 'applied',
    dryRun: false,
    inputs: [
      {
        role: 'graph_mutations',
        path: ingestionGraphMutations,
        sha256: ingestionGraphMutationsSha256
      },
      {
        role: 'graph_apply_plan',
        path: ingestionGraphApplyPlan,
        sha256: ingestionGraphApplyPlanSha256
      },
      {
        role: 'citation_intent_gold_labels',
        path: ingestionCitationIntentGold,
        sha256: ingestionCitationIntentGoldSha256
      },
      {
        role: 'claim_extraction_gold_labels',
        path: ingestionClaimExtractionGold,
        sha256: ingestionClaimExtractionGoldSha256
      },
      {
        role: 'multimodal_assets',
        path: ingestionMultimodalAssets,
        sha256: ingestionMultimodalAssetsSha256
      }
    ],
    artifacts: {
      rollbackManifest: ingestionRollbackManifest,
      rollbackManifestSha256: ingestionRollbackManifestSha256,
      beforeGraphSnapshot: ingestionBeforeGraphSnapshot,
      beforeGraphSnapshotSha256: ingestionBeforeGraphSnapshotSha256
    },
    safety: {
      rollbackManifestSha256: ingestionRollbackManifestSha256,
      beforeGraphSnapshotSha256: ingestionBeforeGraphSnapshotSha256
    }
  });
  await writeSourceInput('package.json', JSON.stringify({
    name: 'papernexus-release-fixture',
    scripts: {
      test: 'node --test'
    }
  }, null, 2));
  for (const testFile of REQUIRED_ENGINEERING_TESTS) {
    await writeSourceInput(testFile, `import test from 'node:test';\ntest('${testFile}', () => {});\n`);
  }
  for (const inputFile of REQUIRED_DOCS_SYNC_INPUTS) {
    if (!sourceFiles.has(inputFile)) {
      await writeSourceInput(inputFile, `fixture docs-sync source snapshot for ${inputFile}\n`);
    }
  }
  const engineeringTestInputs = await Promise.all(REQUIRED_ENGINEERING_TESTS.map((testFile) => (
    sourceInputRecord(testFile, 'required_test_file')
  )));
  const engineeringInputs = [
    await sourceInputRecord('package.json', 'package_manifest'),
    ...engineeringTestInputs
  ];
  await writeJson(engineeringReport, {
    contractVersion: ENGINEERING_RELEASE_EVIDENCE_VERSION,
    runId: 'engineering-release',
    status: 'passed',
    required_tests: REQUIRED_ENGINEERING_TESTS,
    test_runs: REQUIRED_ENGINEERING_TESTS.map((testFile) => ({
      test_files: [testFile],
      command: `node --test ${testFile}`,
      status: 'passed',
      exit_code: 0,
      duration_ms: 10
    })),
    inputs: engineeringInputs,
    diagnostics: {
      missing_required_tests: [],
      failed_required_tests: [],
      missing_input_hashes: []
    },
    releaseGate: {
      status: 'passed',
      reason: 'required_engineering_tests_passed'
    }
  });
  const docsSyncInputs = await Promise.all(REQUIRED_DOCS_SYNC_INPUTS.map((inputFile) => (
    sourceInputRecord(inputFile, 'required_sync_input')
  )));
  await writeJson(docsSyncReport, {
    contractVersion: DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
    runId: 'docs-sync-release',
    status: 'passed',
    required_checks: REQUIRED_DOCS_SYNC_CHECKS.map((entry) => entry.id),
    required_inputs: REQUIRED_DOCS_SYNC_INPUTS,
    checks: REQUIRED_DOCS_SYNC_CHECKS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      command: entry.command || 'file_presence',
      status: 'passed',
      exit_code: entry.kind === 'file_presence' ? null : 0,
      duration_ms: 10,
      files: entry.files || []
    })),
    precheck_inputs: docsSyncInputs,
    inputs: docsSyncInputs,
    input_stability: {
      checked: true,
      changed_input_count: 0,
      changed_inputs: []
    },
    diagnostics: {
      missing_required_checks: [],
      failed_required_checks: [],
      incomplete_required_checks: [],
      missing_input_hashes: [],
      changed_input_hashes: []
    },
    releaseGate: {
      status: 'passed',
      reason: 'docs_schema_fixtures_and_migration_notes_synced'
    }
  });
  await writeText(stdoutLog, 'release gate completed\n');
  await writeText(stderrLog, '');

  const supplementalEvidenceReports = [];
  const evidenceFileByRole = new Map([
    ['replay_suite_manifest', evidenceReport],
    ['ablation_manifest', ablationManifest],
    ['human_blind_aggregation', humanBlindAggregation],
    ['ingestion_graph_mutation_execution', ingestionGraphMutationExecution],
    ['engineering_release_evidence', engineeringReport],
    ['docs_sync_release_evidence', docsSyncReport]
  ]);
  for (const role of releaseGateEvidenceInputRolesForScope(releaseScope)) {
    if (evidenceFileByRole.has(role)) continue;
    const reportPath = path.join(root, 'reports', `${role}.json`);
    await writeJson(reportPath, {
      contractVersion: `${role}-fixture-v1`,
      role,
      status: 'passed'
    });
    evidenceFileByRole.set(role, reportPath);
    supplementalEvidenceReports.push(reportPath);
  }

  const omittedEvidenceInputRoles = new Set(asArray(options.omitReleaseGateEvidenceInputRole));
  if (options.omitDocsSyncEvidenceInput) omittedEvidenceInputRoles.add('docs_sync_release_evidence');
  const releaseGateEvidenceInputs = [];
  for (const role of releaseGateEvidenceInputRolesForScope(releaseScope)) {
    if (omittedEvidenceInputRoles.has(role)) continue;
    const filePath = evidenceFileByRole.get(role);
    releaseGateEvidenceInputs.push({
      role,
      path: filePath,
      sha256: options.missingEvidenceInput && role === 'replay_suite_manifest'
        ? '0'.repeat(64)
        : await sha256File(filePath)
    });
  }
  await writeJson(releaseGateManifest, {
    contractVersion: IDEA_CATALYST_RELEASE_GATE_VERSION,
    status: options.releaseGateStatus || 'passed',
    releaseScope: options.releaseGateReleaseScope || releaseScope,
    evidence_inputs: releaseGateEvidenceInputs
  });

  const docsSyncArtifact = options.omitDocsSyncBundleArtifact
    ? []
    : [{ role: 'docs_sync_release_evidence', path: path.relative(root, docsSyncReport) }];
  const engineeringArtifact = options.omitEngineeringBundleArtifact
    ? []
    : [{ role: 'engineering_release_evidence', path: path.relative(root, engineeringReport) }];
  const statisticalSignificanceArtifact = options.omitStatisticalSignificanceBundleArtifact
    ? []
    : [{ role: 'evidence_report', path: path.relative(root, statisticalSignificanceReport) }];
  const ablationLineageArtifacts = [
    { role: 'evidence_report', path: path.relative(root, ablationManifest) },
    { role: 'normalized_dataset', path: path.relative(root, ablationBenchmark) },
    ...(
      options.omitAblationVariantReportBundleArtifact
        ? []
        : [{ role: 'evidence_report', path: path.relative(root, ablationVariantReport) }]
    )
  ];
  const humanBlindLineageArtifacts = [
    { role: 'human_blind_aggregation', path: path.relative(root, humanBlindAggregation) },
    { role: 'human_blind_cases', path: path.relative(root, humanBlindCases) },
    { role: 'human_blind_labels', path: path.relative(root, humanBlindLabels) },
    { role: 'human_blind_pack', path: path.relative(root, humanBlindPack) },
    { role: 'human_blind_assignments', path: path.relative(root, humanBlindAssignments) },
    { role: 'human_blind_answer_key', path: path.relative(root, humanBlindAnswerKey) },
    ...(
      options.omitHumanBlindReviewFormSchemaBundleArtifact
        ? []
        : [{ role: 'human_blind_review_form_schema', path: path.relative(root, humanBlindReviewFormSchema) }]
    )
  ];
  const ingestionLineageArtifacts = [
    { role: 'ingestion_graph_mutation_execution', path: path.relative(root, ingestionGraphMutationExecution) },
    { role: 'graph_mutations', path: path.relative(root, ingestionGraphMutations) },
    { role: 'graph_apply_plan', path: path.relative(root, ingestionGraphApplyPlan) },
    { role: 'citation_intent_gold_labels', path: path.relative(root, ingestionCitationIntentGold) },
    { role: 'claim_extraction_gold_labels', path: path.relative(root, ingestionClaimExtractionGold) },
    ...(
      options.omitIngestionMultimodalAssetsBundleArtifact
        ? []
        : [{ role: 'multimodal_assets', path: path.relative(root, ingestionMultimodalAssets) }]
    ),
    { role: 'rollback_manifest', path: path.relative(root, ingestionRollbackManifest) },
    { role: 'before_graph_snapshot', path: path.relative(root, ingestionBeforeGraphSnapshot) }
  ];
  const omittedEngineeringTestInput = options.omitEngineeringTestInputBundleArtifact || '';
  const omittedDocsSyncInput = options.omitDocsSyncInputBundleArtifact || '';
  const sourceLineageArtifacts = [
    { role: 'engineering_package_manifest', path: path.relative(root, sourceFiles.get('package.json')) },
    ...REQUIRED_ENGINEERING_TESTS
      .filter((testFile) => testFile !== omittedEngineeringTestInput)
      .map((testFile) => ({
        role: 'engineering_required_test_file',
        path: path.relative(root, sourceFiles.get(testFile))
      })),
    ...REQUIRED_DOCS_SYNC_INPUTS
      .filter((inputFile) => inputFile !== omittedDocsSyncInput)
      .map((inputFile) => ({
        role: 'docs_sync_required_input',
        path: path.relative(root, sourceFiles.get(inputFile))
      }))
  ];
  const bundleManifest = path.join(root, 'release-evidence-bundle.json');
  await writeJson(bundleManifest, {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
    runId: 'bundle-fixture',
    releaseScope: options.releaseScope || 'full',
    artifacts: [
      ...rawInputs.map((filePath) => ({ role: 'raw_input', path: path.relative(root, filePath) })),
      ...normalizedDatasets.map((filePath) => ({ role: 'normalized_dataset', path: path.relative(root, filePath) })),
      { role: 'run_config', path: path.relative(root, runConfig) },
      { role: 'evidence_report', path: path.relative(root, evidenceReport) },
      ...statisticalSignificanceArtifact,
      ...ablationLineageArtifacts,
      ...humanBlindLineageArtifacts,
      ...ingestionLineageArtifacts,
      ...sourceLineageArtifacts,
      ...engineeringArtifact,
      ...supplementalEvidenceReports.map((filePath) => ({ role: 'evidence_report', path: path.relative(root, filePath) })),
      ...docsSyncArtifact,
      { role: 'release_gate_manifest', path: path.relative(root, releaseGateManifest) },
      { role: 'stdout_log', path: path.relative(root, stdoutLog) },
      { role: 'stderr_log', path: path.relative(root, stderrLog) }
    ]
  });

  return { root, bundleManifest };
}

async function createSourceSnapshotFixture(options = {}) {
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-source-snapshot-bundle-'));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-source-snapshot-source-'));
  const sourceFiles = new Map();

  async function writeSource(relativePath, content = '') {
    const filePath = path.join(sourceRoot, relativePath);
    await writeText(filePath, content || `source snapshot fixture for ${relativePath}\n`);
    sourceFiles.set(relativePath, filePath);
    return filePath;
  }

  async function sourceRecord(relativePath, role = 'required_sync_input', includeRelativePath = true) {
    const filePath = sourceFiles.get(relativePath) || await writeSource(relativePath);
    const record = {
      role,
      path: filePath,
      sha256: await sha256File(filePath)
    };
    if (includeRelativePath) record.relative_path = relativePath;
    return record;
  }

  await writeSource('package.json', JSON.stringify({ name: 'papernexus-source-snapshot-fixture' }, null, 2));
  for (const testFile of REQUIRED_ENGINEERING_TESTS) {
    await writeSource(testFile, `import test from 'node:test';\ntest('${testFile}', () => {});\n`);
  }
  for (const inputFile of REQUIRED_DOCS_SYNC_INPUTS) {
    if (!sourceFiles.has(inputFile)) await writeSource(inputFile);
  }

  const engineeringReport = path.join(bundleRoot, 'reports', 'engineering-release-evidence.json');
  const docsSyncReport = path.join(bundleRoot, 'reports', 'docs-sync-release-evidence.json');
  const engineeringTestInputs = await Promise.all(REQUIRED_ENGINEERING_TESTS.map((testFile) => (
    sourceRecord(testFile, 'required_test_file', false)
  )));
  const engineeringInputs = [
    await sourceRecord('package.json', 'package_manifest', false),
    ...engineeringTestInputs
  ];
  const docsSyncInputs = await Promise.all(REQUIRED_DOCS_SYNC_INPUTS.map((inputFile) => (
    sourceRecord(inputFile, 'required_sync_input', true)
  )));
  if (options.mismatchDocsInputHash) {
    const target = docsSyncInputs.find((entry) => entry.relative_path === options.mismatchDocsInputHash);
    if (target) target.sha256 = '0'.repeat(64);
  }
  await writeJson(engineeringReport, {
    contractVersion: ENGINEERING_RELEASE_EVIDENCE_VERSION,
    runId: 'engineering-source-snapshot-fixture',
    status: 'passed',
    required_tests: REQUIRED_ENGINEERING_TESTS,
    test_runs: REQUIRED_ENGINEERING_TESTS.map((testFile) => ({
      test_files: [testFile],
      status: 'passed'
    })),
    inputs: engineeringInputs,
    diagnostics: {
      missing_input_hashes: []
    },
    releaseGate: {
      status: 'passed'
    }
  });
  await writeJson(docsSyncReport, {
    contractVersion: DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
    runId: 'docs-sync-source-snapshot-fixture',
    status: 'passed',
    required_checks: REQUIRED_DOCS_SYNC_CHECKS.map((entry) => entry.id),
    required_inputs: REQUIRED_DOCS_SYNC_INPUTS,
    checks: REQUIRED_DOCS_SYNC_CHECKS.map((entry) => ({
      id: entry.id,
      status: 'passed'
    })),
    precheck_inputs: docsSyncInputs,
    inputs: docsSyncInputs,
    input_stability: {
      checked: true,
      changed_input_count: 0,
      changed_inputs: []
    },
    diagnostics: {
      missing_input_hashes: [],
      changed_input_hashes: []
    },
    releaseGate: {
      status: 'passed'
    }
  });
  const bundleManifest = path.join(bundleRoot, 'release-evidence-bundle.json');
  await writeJson(bundleManifest, {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
    runId: 'source-snapshot-fixture',
    releaseScope: 'p0-p1',
    artifacts: [
      { role: 'engineering_release_evidence', path: path.relative(bundleRoot, engineeringReport) },
      { role: 'docs_sync_release_evidence', path: path.relative(bundleRoot, docsSyncReport) }
    ]
  });
  return { bundleRoot, sourceRoot, bundleManifest };
}

async function createLineageArtifactCollectorFixture(options = {}) {
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-lineage-artifact-bundle-'));
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-lineage-artifact-source-'));

  async function writeArtifact(relativePath, value) {
    const filePath = path.join(artifactRoot, relativePath);
    await writeJson(filePath, value);
    return filePath;
  }

  async function artifactRecord(role, relativePath, value, extra = {}) {
    const filePath = await writeArtifact(relativePath, value);
    const record = {
      role,
      path: filePath,
      relative_path: relativePath,
      sha256: await sha256File(filePath),
      ...extra
    };
    if (options.mismatchRole === role) record.sha256 = '0'.repeat(64);
    return record;
  }

  const statisticalSignificance = await artifactRecord(
    'statistical_significance',
    'stats/statistical-significance.json',
    {
      contractVersion: 'papernexus-statistical-significance-report-v1',
      status: 'passed',
      tests: [{ metric: 'novelty_precision_at_10', p_value: 0.01 }]
    }
  );
  const humanBlindCases = await artifactRecord(
    'human_blind_cases',
    'human/cases.json',
    { contractVersion: 'papernexus-human-blind-cases-v1', cases: [{ pair_id: 'pair:1' }] }
  );
  const humanBlindLabels = await artifactRecord(
    'human_blind_labels',
    'human/labels.json',
    { contractVersion: 'papernexus-human-blind-labels-v1', labels: [{ assignment_id: 'assignment:1' }] }
  );
  const humanBlindPack = await artifactRecord(
    'human_blind_pack',
    'human/blind-pack.json',
    { contractVersion: 'papernexus-human-blind-pack-v1', pairs: [{ pair_id: 'pair:1' }] }
  );
  const humanBlindAssignments = await artifactRecord(
    'human_blind_assignments',
    'human/assignments.json',
    { contractVersion: 'papernexus-human-blind-assignments-v1', assignments: [{ assignment_id: 'assignment:1' }] }
  );
  const humanBlindAnswerKey = await artifactRecord(
    'human_blind_answer_key',
    'human/answer-key.json',
    { contractVersion: 'papernexus-human-blind-answer-key-v1', systems: [{ pair_id: 'pair:1' }] }
  );
  const humanBlindReviewFormSchema = await artifactRecord(
    'human_blind_review_form_schema',
    'human/review-form.schema.json',
    { contractVersion: 'papernexus-human-blind-review-form-schema-v1', required_dimensions: ['novelty'] }
  );
  const graphMutations = await artifactRecord(
    'graph_mutations',
    'ingestion/graph-mutations.json',
    { contractVersion: 'papernexus-ingestion-graph-mutations-v1', operations: [] }
  );
  const graphApplyPlan = await artifactRecord(
    'graph_apply_plan',
    'ingestion/graph-apply-plan.json',
    { contractVersion: 'papernexus-ingestion-graph-apply-plan-v1', status: 'ready_to_apply' }
  );
  const citationGold = await artifactRecord(
    'citation_intent_gold_labels',
    'ingestion/citation-intent-gold.json',
    { contractVersion: 'papernexus-citation-intent-gold-v1', labels: [] }
  );
  const claimGold = await artifactRecord(
    'claim_extraction_gold_labels',
    'ingestion/claim-extraction-gold.json',
    { contractVersion: 'papernexus-claim-extraction-gold-v1', labels: [] }
  );
  const multimodalAssets = await artifactRecord(
    'multimodal_assets',
    'ingestion/multimodal-assets.json',
    { contractVersion: 'papernexus-multimodal-assets-v1', assets: [] }
  );
  const rollbackManifest = await artifactRecord(
    'rollback_manifest',
    'ingestion/rollback-manifest.json',
    { contractVersion: 'papernexus-ingestion-graph-mutation-rollback-v1', status: 'ready_for_manual_restore' }
  );
  const beforeGraphSnapshot = await artifactRecord(
    'before_graph_snapshot',
    'ingestion/before-graph-snapshot.json',
    { contractVersion: 'papernexus-before-graph-snapshot-v1', graph: { nodes: [], edges: [] } }
  );
  const ablationBenchmark = await artifactRecord(
    'ablation_benchmark',
    'ablations/ablation-benchmark.json',
    { contractVersion: 'idea-catalyst-ablation-benchmark-v1', cases: [] }
  );
  const ablationVariant = await artifactRecord(
    'ablation_variant_report',
    'ablations/without-must-cite-report.json',
    { contractVersion: 'idea-catalyst-historical-replay-v1', status: 'passed' },
    { ablation_id: 'without_must_cite' }
  );

  const replayReport = path.join(bundleRoot, 'reports', 'replay-suite-manifest.json');
  const humanReport = path.join(bundleRoot, 'reports', 'human-blind-aggregation.json');
  const ingestionReport = path.join(bundleRoot, 'reports', 'graph-mutation-execution-report.json');
  const ablationReport = path.join(bundleRoot, 'reports', 'ablation-manifest.json');
  await writeJson(replayReport, {
    contractVersion: 'idea-catalyst-replay-suite-v1',
    status: 'passed',
    statistical_significance_provenance: {
      source: 'statistical_significance_file',
      path: statisticalSignificance.path
    },
    inputs: [statisticalSignificance]
  });
  await writeJson(humanReport, {
    contractVersion: 'human-blind-eval-v1',
    status: 'passed',
    inputs: [humanBlindCases, humanBlindLabels],
    blind_review_artifacts: [
      humanBlindPack,
      humanBlindAssignments,
      humanBlindAnswerKey,
      humanBlindReviewFormSchema
    ]
  });
  await writeJson(ingestionReport, {
    contractVersion: 'papernexus-ingestion-graph-mutation-execution-v1',
    status: 'applied',
    inputs: [
      graphMutations,
      graphApplyPlan,
      citationGold,
      claimGold,
      multimodalAssets
    ],
    artifacts: {
      rollbackManifest: rollbackManifest.path,
      rollbackManifestSha256: rollbackManifest.sha256,
      beforeGraphSnapshot: beforeGraphSnapshot.path,
      beforeGraphSnapshotSha256: beforeGraphSnapshot.sha256
    }
  });
  await writeJson(ablationReport, {
    contractVersion: 'idea-catalyst-ablation-runner-v1',
    status: 'passed',
    inputs: [ablationBenchmark],
    ablations: [{
      ablation_id: 'without_must_cite',
      status: 'passed',
      report_artifact: ablationVariant
    }]
  });
  const bundleManifest = path.join(bundleRoot, 'release-evidence-bundle.json');
  await writeJson(bundleManifest, {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
    runId: 'lineage-artifact-collector-fixture',
    releaseScope: 'p0-p1',
    artifacts: [
      { role: 'evidence_report', path: path.relative(bundleRoot, replayReport) },
      { role: 'human_blind_aggregation', path: path.relative(bundleRoot, humanReport) },
      { role: 'ingestion_graph_mutation_execution', path: path.relative(bundleRoot, ingestionReport) },
      { role: 'ablation_manifest', path: path.relative(bundleRoot, ablationReport) }
    ]
  });
  return { bundleRoot, artifactRoot, bundleManifest };
}

async function createReleaseGateInputCollectorFixture(options = {}) {
  const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-gate-input-bundle-'));
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-gate-input-source-'));
  const releaseGateDir = path.join(evidenceRoot, 'release-gate-run');
  const roleRelativePaths = new Map([
    ['replay_suite_manifest', 'reports/replay-suite-manifest.json'],
    ['ablation_manifest', 'reports/ablation-manifest.json'],
    ['human_blind_aggregation', 'reports/human-blind-aggregation.json'],
    ['ingestion_graph_mutation_execution', 'reports/graph-mutation-execution-report.json'],
    ['engineering_release_evidence', 'reports/engineering-release-evidence.json'],
    ['docs_sync_release_evidence', 'reports/docs-sync-release-evidence.json']
  ]);
  const releaseGateEvidenceInputs = [];
  for (const role of releaseGateEvidenceInputRolesForScope('p0-p1')) {
    const relativePath = roleRelativePaths.get(role);
    const filePath = path.join(releaseGateDir, relativePath);
    await writeJson(filePath, {
      contractVersion: `${role}-collector-fixture-v1`,
      role,
      status: 'passed'
    });
    releaseGateEvidenceInputs.push({
      role,
      path: relativePath,
      sha256: options.mismatchRole === role ? '0'.repeat(64) : await sha256File(filePath)
    });
  }

  const releaseGateManifest = path.join(releaseGateDir, 'release-gate-manifest.json');
  await writeJson(releaseGateManifest, {
    contractVersion: IDEA_CATALYST_RELEASE_GATE_VERSION,
    status: 'passed',
    releaseScope: 'p0-p1',
    evidence_inputs: releaseGateEvidenceInputs
  });
  const bundleManifest = path.join(bundleRoot, 'release-evidence-bundle.json');
  await writeJson(bundleManifest, {
    contractVersion: RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION,
    runId: 'release-gate-input-collector-fixture',
    releaseScope: 'p0-p1',
    artifacts: []
  });
  return { bundleRoot, evidenceRoot, releaseGateDir, releaseGateManifest, bundleManifest, roleRelativePaths };
}

test('release evidence bundle audit passes complete hashed bundle', async () => {
  const fixture = await createBundleFixture();
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-fixture'
  });

  assert.equal(report.contractVersion, RELEASE_EVIDENCE_BUNDLE_VERSION);
  assert.equal(report.status, 'passed');
  assert.equal(report.bundle.release_scope, 'full');
  assert.equal(report.release_gate.release_scope, 'full');
  assert.deepEqual(report.diagnostics.missing_roles, []);
  assert.deepEqual(report.release_gate.missing_evidence_input_hashes, []);
  assert.ok(report.diagnostics.docs_sync_release_evidence_hashes.length > 0);
  assert.ok(report.diagnostics.release_gate_docs_sync_input_hashes.length > 0);
  assert.deepEqual(report.diagnostics.dataset_metadata_missing_fields, []);
  assert.deepEqual(report.diagnostics.dataset_metadata_missing_families, []);
  assert.deepEqual(report.diagnostics.dataset_metadata_incomplete_families, []);
  assert.deepEqual(report.diagnostics.raw_input_lineage_missing_families, []);
  assert.ok(report.raw_input_lineage.consumed_evidence_report_count > 0);
  assert.equal(report.engineering_release_evidence_lineage.status, 'passed');
  assert.equal(report.engineering_release_evidence_lineage.consumed_engineering_release_evidence_count, 1);
  assert.deepEqual(report.engineering_release_evidence_lineage.missing_bundled_input_hashes, []);
  assert.deepEqual(report.engineering_release_evidence_lineage.missing_required_test_input_paths, []);
  assert.equal(report.docs_sync_release_evidence_lineage.status, 'passed');
  assert.equal(report.docs_sync_release_evidence_lineage.consumed_docs_sync_release_evidence_count, 1);
  assert.deepEqual(report.docs_sync_release_evidence_lineage.missing_bundled_input_hashes, []);
  assert.deepEqual(report.docs_sync_release_evidence_lineage.missing_required_input_paths, []);
  assert.deepEqual(report.docs_sync_release_evidence_lineage.missing_precheck_input_paths, []);
  assert.equal(report.replay_statistical_significance_lineage.status, 'passed');
  assert.equal(report.replay_statistical_significance_lineage.consumed_replay_suite_count, 1);
  assert.deepEqual(report.replay_statistical_significance_lineage.missing_bundled_input_hashes, []);
  assert.equal(report.human_blind_lineage.status, 'passed');
  assert.equal(report.human_blind_lineage.consumed_human_blind_aggregation_count, 1);
  assert.deepEqual(report.human_blind_lineage.missing_bundled_input_hashes, []);
  assert.deepEqual(report.human_blind_lineage.missing_input_hash_roles, []);
  assert.deepEqual(report.human_blind_lineage.missing_blind_artifact_hash_roles, []);
  assert.equal(report.ingestion_graph_mutation_lineage.status, 'passed');
  assert.equal(report.ingestion_graph_mutation_lineage.consumed_ingestion_graph_mutation_execution_count, 1);
  assert.deepEqual(report.ingestion_graph_mutation_lineage.missing_bundled_input_hashes, []);
  assert.deepEqual(report.ingestion_graph_mutation_lineage.missing_input_hash_roles, []);
  assert.deepEqual(report.ingestion_graph_mutation_lineage.missing_artifact_hash_roles, []);
  assert.equal(report.ablation_manifest_lineage.status, 'passed');
  assert.equal(report.ablation_manifest_lineage.consumed_ablation_manifest_count, 1);
  assert.deepEqual(report.ablation_manifest_lineage.missing_bundled_input_hashes, []);
  assert.equal(report.dataset_metadata.fields.raw_input_sha256.matched_raw_input_hashes.length, RELEASE_DATASET_FAMILIES.length);
  assert.deepEqual(report.release_gate.missing_evidence_input_roles, []);
  assert.deepEqual(report.release_gate.required_evidence_input_roles, releaseGateEvidenceInputRolesForScope('full'));
  assert.ok(report.artifacts.some((entry) => entry.role === 'release_gate_manifest' && entry.sha256));
  assert.ok(report.output_artifacts.reportPath.endsWith('release-evidence-bundle-audit.json'));
});

test('release evidence bundle skeleton creates non-passing P0/P1 manifest and checklist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-bundle-skeleton-'));
  const skeleton = await createReleaseEvidenceBundleSkeleton({
    bundleDir: root,
    releaseScope: 'p0-p1',
    runId: 'p0-p1-skeleton'
  });
  const manifestPath = path.join(root, 'release-evidence-bundle.json');
  const todoPath = path.join(root, 'RELEASE-EVIDENCE-TODO.md');
  const releaseGatePath = path.join(root, 'release-gate-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const todo = await fs.readFile(todoPath, 'utf8');

  assert.equal(skeleton.status, 'skeleton_created');
  assert.equal(manifest.contractVersion, RELEASE_EVIDENCE_BUNDLE_SPEC_VERSION);
  assert.equal(manifest.status, 'skeleton');
  assert.equal(manifest.releaseScope, 'p0-p1');
  assert.equal(manifest.artifacts.filter((entry) => entry.role === 'raw_input').length, RELEASE_DATASET_FAMILIES.length);
  assert.equal(manifest.artifacts.filter((entry) => entry.role === 'normalized_dataset').length, RELEASE_DATASET_FAMILIES.length);
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_aggregation'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_cases'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_labels'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_pack'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_assignments'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_answer_key'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'human_blind_review_form_schema'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'ingestion_graph_mutation_execution'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'graph_mutations'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'graph_apply_plan'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'citation_intent_gold_labels'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'claim_extraction_gold_labels'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'multimodal_assets'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'rollback_manifest'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'before_graph_snapshot'));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'engineering_package_manifest'));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'engineering_required_test_file' && entry.path === 'source/test/mcp.test.js'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'docs_sync_required_input' && entry.path === 'source/docs/eval/release-evidence-bundle.md'
  )));
  assert.ok(manifest.artifacts.some((entry) => entry.role === 'ablation_benchmark'));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'ablation_variant_report' && entry.ablation_id === 'without_claim_graph'
  )));
  assert.equal(manifest.artifacts.some((entry) => entry.ablation_id === 'without_link_prediction_signal'), false);
  assert.match(todo, /not release evidence/i);
  await assert.rejects(fs.stat(releaseGatePath), { code: 'ENOENT' });
});

test('release evidence bundle source snapshot collector copies T1 and D1 sources into bundle manifest', async () => {
  const fixture = await createSourceSnapshotFixture();
  const result = await collectReleaseEvidenceSourceSnapshots({
    bundleDir: fixture.bundleRoot,
    sourceRoot: fixture.sourceRoot
  });
  const manifest = JSON.parse(await fs.readFile(fixture.bundleManifest, 'utf8'));
  const packageSnapshot = path.join(fixture.bundleRoot, 'source', 'package.json');
  const docsSnapshot = path.join(fixture.bundleRoot, 'source', 'docs', 'eval', 'release-evidence-bundle.md');

  assert.equal(result.status, 'source_snapshots_collected');
  assert.equal(result.failed_count, 0);
  assert.ok(result.copied_count > 0);
  assert.ok(result.appended_manifest_artifact_count > 0);
  assert.equal(await sha256File(packageSnapshot), await sha256File(path.join(fixture.sourceRoot, 'package.json')));
  assert.equal(
    await sha256File(docsSnapshot),
    await sha256File(path.join(fixture.sourceRoot, 'docs', 'eval', 'release-evidence-bundle.md'))
  );
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'engineering_package_manifest' && entry.path === 'source/package.json'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'docs_sync_required_input' && entry.path === 'source/docs/eval/release-evidence-bundle.md'
  )));
});

test('release evidence bundle source snapshot collector refuses source hash mismatches', async () => {
  const fixture = await createSourceSnapshotFixture({
    mismatchDocsInputHash: 'docs/eval/release-evidence-bundle.md'
  });
  const result = await collectReleaseEvidenceSourceSnapshots({
    bundleDir: fixture.bundleRoot,
    sourceRoot: fixture.sourceRoot
  });
  const mismatches = result.snapshots.filter((entry) => entry.status === 'source_hash_mismatch');

  assert.equal(result.status, 'incomplete');
  assert.equal(result.failed_count, 1);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].source_relative_path, 'docs/eval/release-evidence-bundle.md');
  await assert.rejects(
    fs.stat(path.join(fixture.bundleRoot, 'source', 'docs', 'eval', 'release-evidence-bundle.md')),
    { code: 'ENOENT' }
  );
});

test('release evidence bundle lineage artifact collector copies R1-SIG, R2, R3, and AB1 artifacts', async () => {
  const fixture = await createLineageArtifactCollectorFixture();
  const result = await collectReleaseEvidenceLineageArtifacts({
    bundleDir: fixture.bundleRoot,
    artifactRoot: fixture.artifactRoot
  });
  const manifest = JSON.parse(await fs.readFile(fixture.bundleManifest, 'utf8'));

  assert.equal(result.status, 'lineage_artifacts_collected');
  assert.equal(result.failed_count, 0);
  assert.ok(result.copied_count > 0);
  assert.ok(result.appended_manifest_artifact_count > 0);
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'reports', 'statistical-significance.json')),
    await sha256File(path.join(fixture.artifactRoot, 'stats', 'statistical-significance.json'))
  );
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'human-blind', 'review-form.schema.json')),
    await sha256File(path.join(fixture.artifactRoot, 'human', 'review-form.schema.json'))
  );
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'ingestion', 'multimodal-assets.json')),
    await sha256File(path.join(fixture.artifactRoot, 'ingestion', 'multimodal-assets.json'))
  );
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'ablations', 'without_must_cite-report.json')),
    await sha256File(path.join(fixture.artifactRoot, 'ablations', 'without-must-cite-report.json'))
  );
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'statistical_significance' && entry.path === 'reports/statistical-significance.json'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'human_blind_review_form_schema' && entry.path === 'human-blind/review-form.schema.json'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'multimodal_assets' && entry.path === 'ingestion/multimodal-assets.json'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'ablation_variant_report' && entry.path === 'ablations/without_must_cite-report.json'
  )));
});

test('release evidence bundle lineage artifact collector refuses artifact hash mismatches', async () => {
  const fixture = await createLineageArtifactCollectorFixture({
    mismatchRole: 'human_blind_review_form_schema'
  });
  const result = await collectReleaseEvidenceLineageArtifacts({
    bundleDir: fixture.bundleRoot,
    artifactRoot: fixture.artifactRoot
  });
  const mismatches = result.lineage_artifacts.filter((entry) => entry.status === 'source_hash_mismatch');

  assert.equal(result.status, 'incomplete');
  assert.equal(result.failed_count, 1);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].bundle_role, 'human_blind_review_form_schema');
  await assert.rejects(
    fs.stat(path.join(fixture.bundleRoot, 'human-blind', 'review-form.schema.json')),
    { code: 'ENOENT' }
  );
});

test('release evidence bundle release-gate input collector copies P0/P1 gate inputs into bundle manifest', async () => {
  const fixture = await createReleaseGateInputCollectorFixture();
  const result = await collectReleaseGateEvidenceInputs({
    bundleDir: fixture.bundleRoot,
    releaseGateManifestPath: fixture.releaseGateManifest
  });
  const manifest = JSON.parse(await fs.readFile(fixture.bundleManifest, 'utf8'));

  assert.equal(result.status, 'release_gate_inputs_collected');
  assert.equal(result.failed_count, 0);
  assert.equal(result.evidence_input_count, releaseGateEvidenceInputRolesForScope('p0-p1').length);
  assert.equal(result.copied_count, releaseGateEvidenceInputRolesForScope('p0-p1').length + 1);
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'release-gate-manifest.json')),
    await sha256File(fixture.releaseGateManifest)
  );
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'reports', 'docs-sync-release-evidence.json')),
    await sha256File(path.join(fixture.releaseGateDir, 'reports', 'docs-sync-release-evidence.json'))
  );
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'release_gate_manifest'
      && entry.path === 'release-gate-manifest.json'
      && entry.sha256
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'evidence_report'
      && entry.source_role === 'replay_suite_manifest'
      && entry.path === 'reports/replay-suite-manifest.json'
  )));
  assert.ok(manifest.artifacts.some((entry) => (
    entry.role === 'docs_sync_release_evidence'
      && entry.source_role === 'docs_sync_release_evidence'
      && entry.path === 'reports/docs-sync-release-evidence.json'
  )));
});

test('release evidence bundle release-gate input collector refuses evidence input hash mismatches', async () => {
  const fixture = await createReleaseGateInputCollectorFixture({
    mismatchRole: 'docs_sync_release_evidence'
  });
  const result = await collectReleaseGateEvidenceInputs({
    bundleDir: fixture.bundleRoot,
    releaseGateManifestPath: fixture.releaseGateManifest
  });
  const mismatches = result.evidence_inputs.filter((entry) => entry.status === 'source_hash_mismatch');
  const manifest = JSON.parse(await fs.readFile(fixture.bundleManifest, 'utf8'));

  assert.equal(result.status, 'incomplete');
  assert.equal(result.failed_count, 1);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].release_gate_input_role, 'docs_sync_release_evidence');
  assert.equal(manifest.artifacts.some((entry) => (
    entry.role === 'docs_sync_release_evidence'
      && entry.path === 'reports/docs-sync-release-evidence.json'
  )), false);
  await assert.rejects(
    fs.stat(path.join(fixture.bundleRoot, 'reports', 'docs-sync-release-evidence.json')),
    { code: 'ENOENT' }
  );
});

test('release evidence bundle audit accepts matching P0/P1 scope', async () => {
  const fixture = await createBundleFixture({ releaseScope: 'p0-p1' });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-p0-p1-scope'
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.bundle.release_scope, 'p0_p1');
  assert.equal(report.release_gate.release_scope, 'p0_p1');
  assert.equal(
    report.checks.find((entry) => entry.name === 'release_scope_matches_release_gate').status,
    'passed'
  );
  assert.deepEqual(report.release_gate.required_evidence_input_roles, releaseGateEvidenceInputRolesForScope('p0-p1'));
  assert.equal(report.release_gate.required_evidence_input_roles.includes('graph_reasoning_report'), false);
});

test('release evidence bundle audit requires P0/P1 release-gate evidence input roles', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitReleaseGateEvidenceInputRole: 'human_blind_aggregation'
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-p0-p1-role'
  });

  const roleCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_required_evidence_input_roles_present'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(roleCheck.status, 'incomplete');
  assert.deepEqual(report.release_gate.missing_evidence_input_roles, ['human_blind_aggregation']);
  assert.equal(report.release_gate.required_evidence_input_roles.includes('graph_link_prediction_report'), false);
});

test('release evidence bundle audit requires bundled replay-suite statistical significance inputs', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitStatisticalSignificanceBundleArtifact: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-statistical-significance-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_replay_statistical_significance_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.replay_statistical_significance_lineage.status, 'incomplete');
  assert.equal(report.replay_statistical_significance_lineage.consumed_replay_suite_count, 1);
  assert.equal(report.replay_statistical_significance_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(
    report.diagnostics.replay_statistical_significance_missing_bundled_hashes,
    report.replay_statistical_significance_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit requires bundled human blind aggregation lineage inputs', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitHumanBlindReviewFormSchemaBundleArtifact: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-human-blind-lineage-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_human_blind_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.human_blind_lineage.status, 'incomplete');
  assert.equal(report.human_blind_lineage.consumed_human_blind_aggregation_count, 1);
  assert.equal(report.human_blind_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(report.human_blind_lineage.missing_input_hash_roles, []);
  assert.deepEqual(report.human_blind_lineage.missing_blind_artifact_hash_roles, []);
  assert.deepEqual(
    report.diagnostics.human_blind_missing_bundled_hashes,
    report.human_blind_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit requires bundled ingestion graph mutation lineage inputs', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitIngestionMultimodalAssetsBundleArtifact: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-ingestion-lineage-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_ingestion_graph_mutation_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.ingestion_graph_mutation_lineage.status, 'incomplete');
  assert.equal(report.ingestion_graph_mutation_lineage.consumed_ingestion_graph_mutation_execution_count, 1);
  assert.equal(report.ingestion_graph_mutation_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(report.ingestion_graph_mutation_lineage.missing_input_hash_roles, []);
  assert.deepEqual(report.ingestion_graph_mutation_lineage.missing_artifact_hash_roles, []);
  assert.deepEqual(
    report.diagnostics.ingestion_graph_mutation_missing_bundled_hashes,
    report.ingestion_graph_mutation_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit requires bundled ablation manifest lineage inputs', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitAblationVariantReportBundleArtifact: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-ablation-lineage-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_ablation_manifest_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.ablation_manifest_lineage.status, 'incomplete');
  assert.equal(report.ablation_manifest_lineage.consumed_ablation_manifest_count, 1);
  assert.equal(report.ablation_manifest_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(
    report.diagnostics.ablation_manifest_missing_bundled_hashes,
    report.ablation_manifest_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit rejects scope mismatch with release gate manifest', async () => {
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    releaseGateReleaseScope: 'full'
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-scope-mismatch'
  });

  assert.equal(report.status, 'incomplete');
  assert.equal(report.bundle.release_scope, 'p0_p1');
  assert.equal(report.release_gate.release_scope, 'full');
  assert.equal(
    report.checks.find((entry) => entry.name === 'release_scope_matches_release_gate').status,
    'incomplete'
  );
});

test('release evidence bundle audit requires docs-sync artifact role', async () => {
  const fixture = await createBundleFixture({ omitDocsSyncBundleArtifact: true });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-docs-sync-role'
  });

  assert.equal(report.status, 'incomplete');
  assert.ok(report.diagnostics.missing_roles.includes('docs_sync_release_evidence'));
  assert.equal(
    report.checks.find((entry) => entry.name === 'required_artifact_roles_present').status,
    'incomplete'
  );
});

test('release evidence bundle audit requires docs-sync artifact consumed by release gate', async () => {
  const fixture = await createBundleFixture({ omitDocsSyncEvidenceInput: true });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-docs-sync-not-consumed'
  });

  assert.equal(report.status, 'incomplete');
  assert.equal(
    report.checks.find((entry) => entry.name === 'docs_sync_release_evidence_bundled_and_consumed').status,
    'incomplete'
  );
  assert.deepEqual(report.diagnostics.release_gate_docs_sync_input_hashes, []);
});

test('release evidence bundle audit requires bundled engineering release evidence source inputs', async () => {
  const omittedTestFile = 'test/mcp-http.test.js';
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitEngineeringTestInputBundleArtifact: omittedTestFile
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-engineering-source-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_engineering_release_evidence_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.engineering_release_evidence_lineage.status, 'incomplete');
  assert.equal(report.engineering_release_evidence_lineage.consumed_engineering_release_evidence_count, 1);
  assert.equal(report.engineering_release_evidence_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(report.engineering_release_evidence_lineage.missing_required_test_input_paths, []);
  assert.deepEqual(
    report.diagnostics.engineering_release_evidence_missing_bundled_hashes,
    report.engineering_release_evidence_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit requires bundled docs-sync release evidence source inputs', async () => {
  const omittedInputFile = 'docs/eval/release-evidence-bundle.md';
  const fixture = await createBundleFixture({
    releaseScope: 'p0-p1',
    omitDocsSyncInputBundleArtifact: omittedInputFile
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-docs-sync-source-input'
  });

  const lineageCheck = report.checks.find((entry) => (
    entry.name === 'release_gate_docs_sync_release_evidence_inputs_bundled'
  ));
  assert.equal(report.status, 'incomplete');
  assert.equal(lineageCheck.status, 'incomplete');
  assert.equal(report.docs_sync_release_evidence_lineage.status, 'incomplete');
  assert.equal(report.docs_sync_release_evidence_lineage.consumed_docs_sync_release_evidence_count, 1);
  assert.equal(report.docs_sync_release_evidence_lineage.missing_bundled_input_hashes.length, 1);
  assert.deepEqual(report.docs_sync_release_evidence_lineage.missing_required_input_paths, []);
  assert.deepEqual(report.docs_sync_release_evidence_lineage.missing_precheck_input_paths, []);
  assert.deepEqual(
    report.diagnostics.docs_sync_release_evidence_missing_bundled_hashes,
    report.docs_sync_release_evidence_lineage.missing_bundled_input_hashes
  );
});

test('release evidence bundle audit rejects gate inputs not copied into bundle', async () => {
  const fixture = await createBundleFixture({ missingEvidenceInput: true });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-hash'
  });

  assert.equal(report.status, 'incomplete');
  assert.equal(
    report.checks.find((entry) => entry.name === 'release_gate_evidence_inputs_bundled').status,
    'incomplete'
  );
  assert.deepEqual(report.release_gate.missing_evidence_input_hashes, ['0'.repeat(64)]);
});

test('release evidence bundle audit rejects missing dataset metadata', async () => {
  const fixture = await createBundleFixture({ missingDatasetMetadata: true });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-dataset-metadata'
  });

  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.diagnostics.dataset_metadata_missing_fields, [
    'source',
    'license_scope',
    'raw_input_sha256',
    'time_cutoff',
    'adapter_format',
    'holdout_policy',
    'time_slice_policy'
  ]);
  assert.equal(
    report.checks.find((entry) => entry.name === 'dataset_metadata_raw_input_sha256_present').status,
    'incomplete'
  );
});

test('release evidence bundle audit rejects incomplete per-family dataset metadata', async () => {
  const fixture = await createBundleFixture({ omitFamilyMetadata: 'peerread' });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-incomplete-family-metadata'
  });

  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.diagnostics.dataset_metadata_missing_families, []);
  assert.deepEqual(report.diagnostics.dataset_metadata_incomplete_families, ['peerread']);
  assert.equal(
    report.checks.find((entry) => entry.name === 'dataset_family_metadata_peerread_complete').status,
    'incomplete'
  );
  assert.ok(report.dataset_metadata.families.find((entry) => entry.id === 'peerread').missing_fields.includes('raw_input_sha256'));
});

test('release evidence bundle audit does not reuse global metadata for every dataset family', async () => {
  const fixture = await createBundleFixture({
    omitFamilyMetadata: 'peerread',
    globalRunConfigMetadata: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-global-metadata-not-family-scoped'
  });

  const peerread = report.dataset_metadata.families.find((entry) => entry.id === 'peerread');
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.diagnostics.dataset_metadata_incomplete_families, ['peerread']);
  assert.ok(peerread.missing_fields.includes('raw_input_sha256'));
  assert.ok(peerread.missing_fields.includes('adapter_format'));
  assert.equal(
    report.checks.find((entry) => entry.name === 'dataset_family_metadata_peerread_complete').status,
    'incomplete'
  );
});

test('release evidence bundle audit requires family raw input hashes in release-gate consumed evidence reports', async () => {
  const fixture = await createBundleFixture({
    omitEvidenceReportRawHashForFamily: 'moprd',
    addTopLevelRawInputHashesToEvidenceReport: true
  });
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: fixture.root,
    runId: 'bundle-audit-missing-family-lineage'
  });

  const moprd = report.raw_input_lineage.families.find((entry) => entry.id === 'moprd');
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.diagnostics.raw_input_lineage_missing_families, ['moprd']);
  assert.ok(moprd.raw_input_hashes.length > 0);
  assert.deepEqual(moprd.covered_raw_input_hashes, []);
  assert.equal(
    report.checks.find((entry) => entry.name === 'dataset_family_raw_input_lineage_moprd_covered').status,
    'incomplete'
  );
});

test('release evidence bundle CLI exposes required bundle roles', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--help'
  ], {
    cwd: process.cwd()
  });

  assert.match(stdout, /raw_input/);
  assert.match(stdout, /normalized_dataset/);
  assert.match(stdout, /docs_sync_release_evidence/);
  assert.match(stdout, /--scope full\|p0-p1/);
  assert.match(stdout, /--init-skeleton/);
  assert.match(stdout, /--collect-release-gate-inputs/);
  assert.match(stdout, /--release-gate-manifest/);
  assert.match(stdout, /--collect-lineage-artifacts/);
  assert.match(stdout, /--collect-source-snapshots/);
  assert.match(stdout, /--require-passed/);
});

test('release evidence bundle CLI creates skeleton without creating fake evidence files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-release-bundle-cli-skeleton-'));
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--bundle-dir',
    root,
    '--scope',
    'p0-p1',
    '--run-id',
    'cli-skeleton',
    '--init-skeleton'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-evidence-bundle.json'), 'utf8'));

  assert.equal(result.status, 'skeleton_created');
  assert.equal(result.releaseScope, 'p0-p1');
  assert.equal(manifest.runId, 'cli-skeleton');
  await assert.rejects(fs.stat(path.join(root, 'reports', 'replay-suite-manifest.json')), { code: 'ENOENT' });
});

test('release evidence bundle CLI collects source snapshots from T1 and D1 reports', async () => {
  const fixture = await createSourceSnapshotFixture();
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--bundle-dir',
    fixture.bundleRoot,
    '--source-root',
    fixture.sourceRoot,
    '--collect-source-snapshots'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'source_snapshots_collected');
  assert.equal(result.failed_count, 0);
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'source', 'test', 'mcp.test.js')),
    await sha256File(path.join(fixture.sourceRoot, 'test', 'mcp.test.js'))
  );
});

test('release evidence bundle CLI collects release-gate evidence inputs', async () => {
  const fixture = await createReleaseGateInputCollectorFixture();
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--bundle-dir',
    fixture.bundleRoot,
    '--release-gate-manifest',
    fixture.releaseGateManifest,
    '--collect-release-gate-inputs'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'release_gate_inputs_collected');
  assert.equal(result.failed_count, 0);
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'reports', 'replay-suite-manifest.json')),
    await sha256File(path.join(fixture.releaseGateDir, 'reports', 'replay-suite-manifest.json'))
  );
});

test('release evidence bundle CLI can run all bundle collectors in order', async () => {
  const fixture = await createBundleFixture({ releaseScope: 'p0-p1' });
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--bundle-dir',
    fixture.root,
    '--collect-release-gate-inputs',
    '--collect-lineage-artifacts',
    '--collect-source-snapshots'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'collection_steps_completed');
  assert.deepEqual(result.results.map((entry) => entry.status), [
    'release_gate_inputs_collected',
    'lineage_artifacts_collected',
    'source_snapshots_collected'
  ]);
  assert.equal(result.results.every((entry) => entry.failed_count === 0), true);
});

test('release evidence bundle CLI collects lineage artifacts from P0/P1 reports', async () => {
  const fixture = await createLineageArtifactCollectorFixture();
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-release-evidence-bundle.mjs',
    '--bundle-dir',
    fixture.bundleRoot,
    '--artifact-root',
    fixture.artifactRoot,
    '--collect-lineage-artifacts'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);

  assert.equal(result.status, 'lineage_artifacts_collected');
  assert.equal(result.failed_count, 0);
  assert.equal(
    await sha256File(path.join(fixture.bundleRoot, 'reports', 'statistical-significance.json')),
    await sha256File(path.join(fixture.artifactRoot, 'stats', 'statistical-significance.json'))
  );
});
