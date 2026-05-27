# Release Evidence Bundle Audit

`papernexus-release-evidence-bundle-v1` audits the final `artifacts/release-evidence/<date>/...` directory before a PaperNexus release claim is made. It does not generate benchmark results; it checks that the evidence bundle contains the files needed to reproduce and review the release decision.

## Bundle Manifest

Create `release-evidence-bundle.json` in the bundle root:

```json
{
  "contractVersion": "papernexus-release-evidence-bundle-spec-v1",
  "runId": "2026-05-27-release-candidate",
  "releaseScope": "p0-p1",
  "artifacts": [
    { "role": "raw_input", "path": "raw-inputs/masterset.json" },
    { "role": "normalized_dataset", "path": "normalized-datasets/masterset-replay.json" },
    { "role": "run_config", "path": "run-config.json" },
    { "role": "evidence_report", "path": "reports/replay-suite-manifest.json" },
    { "role": "ablation_manifest", "path": "reports/ablation-manifest.json" },
    { "role": "human_blind_aggregation", "path": "reports/human-blind-aggregation.json" },
    { "role": "human_blind_cases", "path": "human-blind/cases.json" },
    { "role": "human_blind_labels", "path": "human-blind/labels.json" },
    { "role": "human_blind_pack", "path": "human-blind/blind-pack.json" },
    { "role": "human_blind_assignments", "path": "human-blind/assignments.json" },
    { "role": "human_blind_answer_key", "path": "human-blind/answer-key.json" },
    { "role": "human_blind_review_form_schema", "path": "human-blind/review-form.schema.json" },
    { "role": "ingestion_graph_mutation_execution", "path": "reports/graph-mutation-execution-report.json" },
    { "role": "graph_mutations", "path": "ingestion/graph-mutations.json" },
    { "role": "graph_apply_plan", "path": "ingestion/graph-apply-plan.json" },
    { "role": "citation_intent_gold_labels", "path": "ingestion/citation-intent-gold.json" },
    { "role": "claim_extraction_gold_labels", "path": "ingestion/claim-extraction-gold.json" },
    { "role": "multimodal_assets", "path": "ingestion/multimodal-assets.json" },
    { "role": "rollback_manifest", "path": "ingestion/rollback-manifest.json" },
    { "role": "before_graph_snapshot", "path": "ingestion/before-graph-snapshot.json" },
    { "role": "engineering_package_manifest", "path": "source/package.json" },
    { "role": "engineering_required_test_file", "path": "source/test/mcp.test.js" },
    { "role": "docs_sync_required_input", "path": "source/docs/eval/release-evidence-bundle.md" },
    { "role": "docs_sync_release_evidence", "path": "reports/docs-sync-release-evidence.json" },
    { "role": "release_gate_manifest", "path": "release-gate-manifest.json" },
    { "role": "stdout_log", "path": "logs/stdout.log" },
    { "role": "stderr_log", "path": "logs/stderr.log" }
  ]
}
```

Required roles are `raw_input`, `normalized_dataset`, `run_config`, `evidence_report`, `docs_sync_release_evidence`, `release_gate_manifest`, `stdout_log`, and `stderr_log`. More artifacts can be listed; each file is hashed in the audit report. The docs-sync artifact must also be one of the files consumed by `release-gate-manifest.json.evidence_inputs[]`, so the final bundle proves D1 was part of the release decision rather than a loose extra file.

`releaseScope` is optional and defaults to `full`. For the current P0/P1 closure, set it to `p0-p1` or pass `--scope p0-p1` to the audit CLI. The audit requires this expected scope to match the bundled `release-gate-manifest.json.releaseScope`, so a P0/P1 bundle cannot accidentally package a full-scope or scope-less gate result.

The audit also checks the release-gate input roles expected for the selected scope. For `p0-p1`, `release-gate-manifest.json.evidence_inputs[]` must include hashed records for:

- `replay_suite_manifest`
- `ablation_manifest`
- `human_blind_aggregation`
- `ingestion_graph_mutation_execution`
- `engineering_release_evidence`
- `docs_sync_release_evidence`

Full scope additionally requires `graph_reasoning_report`, `scientific_embedding_release_evidence`, `innovation_sidecar_release_evidence`, and `graph_link_prediction_report`. Those full-scope sidecar roles remain outside the current P0/P1 non-training closure.

## Dataset Metadata

For release evidence, the bundle must also expose auditable dataset metadata across the bundled `raw_input`, `normalized_dataset`, `run_config`, or `evidence_report` JSON files:

- `source`
- `license_scope`
- `raw_input_sha256`
- `time_cutoff`
- `adapter_format`
- `holdout_policy`
- `time_slice_policy`

`raw_input_sha256` must match the SHA-256 of a bundled `raw_input` artifact. This prevents a final bundle from passing only because files exist while the dataset source, license scope, temporal cutoff, adapter, holdout, or time-slice policy is missing.

The audit also requires the same metadata coverage per release benchmark family:

- MasterSet
- NovBench
- RINoBench
- axiomatic novelty benchmark
- CLAIM-BENCH
- CLAIMCHECK
- OpenReview
- PeerRead
- MOPRD
- Re2 / Re²

Family-level checks only count metadata from artifacts or nested dataset entries that are explicitly scoped to that family. A global `run_config` metadata block is not reused as evidence for every benchmark family. Each family must provide a `raw_input_sha256` that matches that family's bundled `raw_input` artifact.

The bundle also verifies raw-input lineage through the final release gate. For every required benchmark family, the matched `raw_input_sha256` must appear inside that family's scoped entry in an `evidence_report` artifact whose SHA-256 is listed in `release-gate-manifest.json.evidence_inputs[]`. A top-level raw input list is not enough. This prevents adding benchmark raw inputs to the package after the release gate ran, and it prevents one global input list from standing in for family-specific evaluation evidence.

For R1-SIG, the audit also follows replay-suite statistical-significance provenance. Each release-gate consumed `idea-catalyst-replay-suite-v1` manifest must point to auditable statistical evidence: either an `inputs[]` record with `role=statistical_significance` when `statistical_significance_provenance.source=statistical_significance_file`, or a hashed raw-dataset/raw-input record when the statistical evidence is embedded in raw dataset metadata. The referenced input SHA-256 must resolve to a file listed in the final bundle.

For T1, the audit follows engineering release evidence provenance. The release-gate consumed `papernexus-engineering-release-evidence-v1` report must include hashes for the named required test files, and every `inputs[]` SHA-256 it records must resolve to a bundled source snapshot such as `source/package.json` or `source/test/*.js`. Packaging only `engineering-release-evidence.json` is not enough.

For D1, the audit follows docs-sync release evidence provenance. The release-gate consumed `papernexus-docs-sync-release-evidence-v1` report must include both final `inputs[]` and `precheck_inputs[]` hashes for the required docs, schema snapshots, generated references, scripts, and packet tests. `input_stability.checked` must be true, no changed synced inputs may be recorded, and every referenced SHA-256 must resolve to a bundled `source/**` artifact.

For R2, the audit follows human-blind aggregation provenance. The release-gate consumed `human-blind-eval-v1` aggregation must include hashed `inputs[]` records for `human_blind_cases` and `human_blind_labels`, plus hashed `blind_review_artifacts[]` records for `human_blind_pack`, `human_blind_assignments`, `human_blind_answer_key`, and `human_blind_review_form_schema`. Every referenced SHA-256 must resolve to a file listed in the final bundle; packaging only the aggregation summary is not enough.

For R3, the audit follows ingestion graph mutation execution provenance. The release-gate consumed `papernexus-ingestion-graph-mutation-execution-v1` report must include hashed `inputs[]` records for `graph_mutations`, `graph_apply_plan`, `citation_intent_gold_labels`, `claim_extraction_gold_labels`, and `multimodal_assets`. It must also include hashes for `rollback_manifest` and `before_graph_snapshot` through the execution report `artifacts` or `safety` fields. Every referenced SHA-256 must resolve to a file listed in the final bundle; packaging only `graph-mutation-execution-report.json` is not enough.

For AB1, the audit follows ablation-manifest provenance. Each release-gate consumed `idea-catalyst-ablation-runner-v1` manifest must include a hashed benchmark input record with `role=ablation_benchmark` or a compatible dataset alias, and every required ablation variant must include a hashed `report_artifact`. The audit requires those benchmark and per-variant report hashes to resolve to files listed in the final bundle.

## Command

Initialize a non-passing P0/P1 bundle skeleton before copying real artifacts:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --scope p0-p1 \
  --run-id 2026-05-27-release-candidate \
  --init-skeleton
```

This writes `release-evidence-bundle.json`, creates the expected directories, and writes `RELEASE-EVIDENCE-TODO.md`. It does not create raw inputs, reports, labels, logs, release-gate output, or any passing evidence artifact. The skeleton remains non-release evidence until the real files exist and the audit below passes with `--require-passed`.

After the real P0/P1 release gate has run, copy the gate manifest and every hashed `evidence_inputs[]` report it consumed into canonical bundle paths:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --collect-release-gate-inputs \
  --release-gate-manifest artifacts/idea-catalyst-release-gate/run-001/release-gate-manifest.json
```

This copies `release-gate-manifest.json` plus hash-matching evidence input reports such as `reports/replay-suite-manifest.json`, `reports/ablation-manifest.json`, `reports/human-blind-aggregation.json`, `reports/graph-mutation-execution-report.json`, `reports/engineering-release-evidence.json`, and `reports/docs-sync-release-evidence.json`, then appends the corresponding manifest entries. Relative evidence input paths are resolved from the original release-gate manifest directory, `--evidence-root`, and the bundle root. Missing inputs, hash mismatches, or destination hash conflicts keep the collection incomplete.

After real T1/D1 reports have been copied into `reports/`, collect the source snapshots they reference:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --collect-source-snapshots \
  --source-root .
```

This copies only files whose current SHA-256 matches the hashes inside bundled `engineering-release-evidence.json` and `docs-sync-release-evidence.json`, then appends the `source/**` artifacts to `release-evidence-bundle.json`. It does not generate engineering/docs-sync reports and it refuses missing or hash-mismatched source files.

After real R1-SIG/R2/R3/AB1 reports have been copied into `reports/`, collect the non-source lineage artifacts they reference:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --collect-lineage-artifacts \
  --artifact-root artifacts
```

This copies only hash-matching files referenced by bundled replay-suite statistical-significance provenance, human-blind aggregation, ingestion graph mutation execution, and ablation manifests. It appends canonical bundle entries such as `reports/statistical-significance.json`, `human-blind/*.json`, `ingestion/*.json`, and `ablations/*-report.json`. It does not create benchmark results, human labels, ingestion outputs, or ablation reports; missing files, hash mismatches, or destination hash conflicts keep the collection incomplete.

The three collectors can also run in one command after the release gate and all referenced evidence files already exist:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --collect-release-gate-inputs \
  --release-gate-manifest artifacts/idea-catalyst-release-gate/run-001/release-gate-manifest.json \
  --collect-lineage-artifacts \
  --artifact-root artifacts \
  --collect-source-snapshots \
  --source-root .
```

The CLI executes them in this order: release-gate evidence inputs, R1-SIG/R2/R3/AB1 lineage artifacts, then T1/D1 source snapshots. The combined command still only copies hash-matching existing files.

Audit the final bundle after the real artifacts have been copied:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --scope p0-p1 \
  --require-passed
```

Outputs:

| File | Purpose |
|---|---|
| `release-evidence-bundle-audit.json` | Machine-readable bundle audit with artifact SHA-256 records and release-gate evidence input coverage. |
| `release-evidence-bundle-audit.md` | Human-readable audit summary. |
| `release-evidence-bundle-audit-manifest.json` | Compact manifest for release packaging. |

## Gate Semantics

The audit passes only when:

- the bundle manifest uses `papernexus-release-evidence-bundle-spec-v1`;
- every required role is present;
- every listed artifact exists and declared hashes match;
- non-log artifacts are non-empty;
- the bundled release-gate manifest is `idea-catalyst-release-gate-v1` with `status=passed`;
- the bundle's expected release scope matches the bundled release-gate manifest scope;
- `release-gate-manifest.json.evidence_inputs[]` includes every evidence input role required by the selected scope;
- every `release-gate-manifest.json.evidence_inputs[].sha256` is represented by a file in the bundle;
- `docs_sync_release_evidence` is bundled and its SHA-256 appears under `release-gate-manifest.json.evidence_inputs[]`;
- every release-gate consumed engineering release evidence report has required test-file input hashes that resolve to bundled source snapshots;
- every release-gate consumed docs-sync release evidence report has required final and precheck input hashes that resolve to bundled source snapshots, with input stability checked and unchanged;
- dataset metadata includes `source`, `license_scope`, `raw_input_sha256`, `time_cutoff`, `adapter_format`, `holdout_policy`, and `time_slice_policy`;
- every required benchmark family has its own scoped dataset metadata and a matching bundled raw-input SHA-256;
- every family raw-input SHA-256 is present in that family's scoped entry in a release-gate consumed evidence report;
- every release-gate consumed replay-suite manifest has statistical-significance input hashes that resolve to bundled files.
- every release-gate consumed human-blind aggregation has case, label, blind-pack, assignment, answer-key, and review-form schema hashes that resolve to bundled files.
- every release-gate consumed ingestion graph mutation execution report has graph-mutation, apply-plan, gold-label, multimodal-asset, rollback-manifest, and before-graph-snapshot hashes that resolve to bundled files.
- every release-gate consumed ablation manifest has benchmark input and per-variant report hashes that resolve to bundled files.

This is not a substitute for R1/R2/R3/R4-R8 release evidence. It only proves that the final evidence package is auditable and that the release gate consumed files actually included in the bundle.
