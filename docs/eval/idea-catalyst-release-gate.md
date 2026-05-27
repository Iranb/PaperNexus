# Idea-Catalyst Release Gate

`idea-catalyst-release-gate-v1` aggregates the evidence required by the deep research alignment report into one auditable manifest.

The manifest is intentionally conservative. Passing a unit fixture or synthetic mini run is not enough unless `--allow-fixture-evidence` is explicitly set. By default, replay-suite evidence must carry a dataset source, license scope, raw input hash, and `releaseReadiness.status: "ready_for_release_gate"` before it can count as release-grade evidence. Replay-suite release readiness must also include passed checks for strict per-case time cutoffs, venue/year holdout, OpenAlex/S2ORC/reference time slicing, release-grade improvement thresholds, semantic negative coverage, and paired statistical significance evidence. Ingestion graph mutation evidence must use the full `graph-mutation-execution-report.json` report from an actual release-gated apply, not a dry-run preview. Graph reasoning evidence must use the full `graph-reasoning-report.json` report and cover SciRepEval, OAG-Bench, and GraphRAG-Bench families. Scientific embedding evidence must use the full `scientific-embedding-release-evidence.json` wrapper for `R4`, not only the embedding manifest. Innovation sidecar evidence must use the full `innovation-sidecar-release-evidence.json` report for calibrated model-assisted and ToT/model-assisted counterfactual artifacts. Graph link-prediction evidence must use the full `graph-link-prediction-eval.json` report, not only the lightweight `manifest.json`, because the release gate verifies source-family coverage, input hashes, and per-gate status. Ablation evidence must include hash lineage for the benchmark input and for every required variant report, so a hand-written ablation summary cannot pass without auditable source files.

## Command

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --run-id run-001 \
  --replay-suite-manifest artifacts/masterset/replay-suite-manifest.json,artifacts/novbench/replay-suite-manifest.json,artifacts/claimcheck/replay-suite-manifest.json,artifacts/openreview/replay-suite-manifest.json \
  --ablation-manifest artifacts/ablations/ablation-manifest.json \
  --human-aggregation artifacts/human-blind-eval/aggregation.json \
  --ingestion-graph-mutation-execution artifacts/ingestion-graph-mutation-execution/run-001/graph-mutation-execution-report.json \
  --engineering-evidence artifacts/engineering-release-evidence/run-001/engineering-release-evidence.json \
  --graph-reasoning-report artifacts/graph-reasoning/scirepeval-oag-graphrag-report.json \
  --scientific-embedding-evidence artifacts/scientific-embedding-release-evidence/run-001/scientific-embedding-release-evidence.json \
  --innovation-sidecar-evidence artifacts/innovation-sidecar-release-evidence/run-001/innovation-sidecar-release-evidence.json \
  --graph-link-prediction-report artifacts/graph-link-prediction-eval/run-001/graph-link-prediction-eval.json \
  --docs-sync-evidence artifacts/docs-sync-release-evidence/run-001/docs-sync-release-evidence.json \
  --require-passed
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `release-gate-manifest.json` | Machine-readable E1-E7, R3-R7, T1, D1, ablation status, and SHA-256 records for every evidence report file read by the release gate. |
| `release-gate-report.md` | Human-readable requirement summary, evidence counts, and evidence input hashes. |

## Scope

The default release gate remains the full deep-research gate. For the current P0/P1 closure, run the same command with `--scope p0-p1` or pass `releaseScope: "p0-p1"` to the manifest builder. That scope keeps `E1`, `E2`, `E3`, `E4`, `E6`, `E7`, `R3`, `T1`, `D1`, and `AB1`, then omits `E5` and `R4`-`R7` because graph-reasoning sidecars, scientific embedding evidence, calibrated model-assisted sidecars, counterfactual usefulness, and temporal graph link prediction are deferred outside the current non-training P0/P1 completion target.

P0/P1 scope still requires the core structural ablations for claim graph, must-cite, reviewer panel, meta-reviewer, storyline DAG, temporal cutoff, COCI/OpenAlex support, and GraphRAG summaries. It does not require `without_link_prediction_signal` or `without_counterfactual_planner`, which belong to deferred P2/sidecar lanes.

## Evidence Inputs

When evidence is passed by file path, the release gate records each report as an `evidence_inputs[]` entry with:

| Field | Meaning |
| --- | --- |
| `role` | Evidence category, such as `replay_suite_manifest`, `scientific_embedding_release_evidence`, or `docs_sync_release_evidence`. |
| `path` | Absolute path read by the release gate. |
| `sha256` | SHA-256 of the exact JSON file consumed. |
| `contract_version` | Top-level `contractVersion`, when present. |
| `run_id` | Top-level `runId`, when present. |
| `status` | Top-level evidence status. |

This is separate from the raw-input hashes inside each evidence report. The aggregate manifest now proves both levels: which reports were bundled, and what raw inputs those reports claim.

## Requirement Mapping

| ID | Report requirement | Expected evidence |
| --- | --- | --- |
| `E1` | Current baseline comparison beats `live_discovery`. | Passed OpenReview / PeerRead / MOPRD / Re2-style replay-suite with `major_metrics_beat_baseline`, at least three configured positive major-metric lift thresholds, `minMajorMetricImprovements >= 3`, and at least three significant paired major-metric lifts. |
| `E2` | NovBench / RINoBench / axiomatic novelty benchmark. | Passed replay-suite with novelty gold cases, `novelty_beats_baseline`, configured novelty lift of at least 0.08, and significant paired novelty lift evidence. |
| `E3` | CLAIM-BENCH / CLAIMCHECK claim grounding. | Passed replay-suite with claim gold cases, `claim_grounding`, configured claim-evidence F1 lift of at least 0.10, positive unsupported-claim-rate reduction, and significant paired evidence for both metrics. |
| `E4` | MasterSet-style must-cite retrieval. | Passed replay-suite with must-cite gold cases, `primaryCutoff=20`, `must_cite_recall_at_k`, configured Recall@20 lift of at least 0.10, significant paired Recall@20 lift evidence, and provenance covering both OpenAlex and COCI/OpenCitations historical citation slices. |
| `E5` | SciRepEval / OAG-Bench / GraphRAG-Bench graph reasoning. | Passed `papernexus-graph-reasoning-report-v1` evidence covering all three benchmark families, required graph reasoning gates, source/license metadata, and input hashes. |
| `E6` | Strict historical replay. | Passed OpenReview / PeerRead / MOPRD / Re2-style replay-suite with no missing time cutoffs, explicit venue/year holdout, source time-slice policy, positive configured lift over the current live baseline, and significant paired historical-score lift evidence. |
| `E7` | Human blind pairwise preference >= 60%. | Passed human blind aggregation with sufficient reviewer roles, distinct reviewer identities for every required target-pair slot, completed labels bound to generated assignment ids for the same pair and reviewer role, complete six-dimension review-form labels with explicit confidence and recorded major concerns, target-system comparison coverage for baseline/P0/P1/ablation, blinding audit proving reviewer-visible artifacts omit system/model identifier fields, expose only `proposal` plus `evidence_export` payload fields, and keep the answer key private, all human release-readiness checks passed, numeric target preference at or above the configured threshold, target-pair count greater than zero, SHA-256 hashes for the blinded case input and completed label file, and hashes for the blind pack, assignments, answer key, and review form schema. |
| `R3` | Release-gated ingestion graph mutation apply. | Passed `graph-mutation-execution-report.json` with actual apply, ready apply plan, non-empty audited multimodal assets, claim/citation gates passed, explicit release-gated apply, changed graph checksum, rollback manifest path/hash, before-graph snapshot path/hash, and role-specific input hashes for graph mutations, graph apply plan, citation-intent gold labels, claim-extraction gold labels, and multimodal assets. |
| `R4` | Scientific embedding retrieval evidence. | Passed `scientific-embedding-release-evidence.json` with external SPECTER2 or equivalent scientific encoder evidence, SciRepEval/OAG/GraphRAG family coverage, lexical/dense/hybrid fixed-corpus rows, role-specific input hashes for the benchmark, vector source, dataset, lexical scores, dense scores, and hybrid scores, source/license metadata, and dense or hybrid lift over lexical. |
| `R5` | Calibrated model-assisted innovation evidence. | Passed `papernexus-innovation-sidecar-release-evidence-v1` report with calibrated model id, prompt version, calibration dataset/run/labels, independent holdout/evaluation dataset and policy with no calibration split reuse, role-specific hashes for calibration labels and holdout/evaluation evidence, NovBench/RINoBench/claim/OpenReview-style family coverage, `model_calibration_complete` and `benchmark_metrics_passed` gates passed, source/license metadata, and input hashes. |
| `R6` | ToT/model-assisted counterfactual usefulness evidence. | Passed `papernexus-innovation-sidecar-release-evidence-v1` report with model-assisted or ToT search, candidates, selected plans, labels covering selected plans, role-specific hashes for generated candidates, selected plans, and usefulness labels, usefulness score at or above `0.5`, positive failure-discovery metric, `counterfactual_usefulness` gate passed, source/license metadata, and input hashes. |
| `R7` | OAG/OpenAlex/internal-KG temporal graph link prediction. | Passed `graph-link-prediction-eval.json` covering OAG, OpenAlex, and internal-KG source families with `temporal_split_clean`, `link_prediction_quality`, `release_provenance_complete`, source/license/input hashes, model, training slice, cutoff, and negative sampling policy. |
| `T1` | Named engineering release tests pass. | Passed `engineering-release-evidence.json` covering `mcp.test.js`, `mcp-http.test.js`, `pipeline-invariants.test.js`, and `engineering-control-acceptance.test.js` with input hashes. The pipeline invariant check requires `source_backed` evidence exports to carry source-span/supporting-paper `license_scope` and audit hashes, requires `source_backed` claims to carry `source_span_ids` that resolve to source evidence records, requires `source_backed` must-cite entries to carry source-span or citation-context evidence whose explicit ids resolve to source evidence records, requires novelty certificates to include textual reasons covering all six score axes (`novelty`, `significance`, `feasibility`, `grounding`, `must_cite_completeness`, and `temporal_validity`), requires review packets to include novelty/methods/reproducibility/outsider reviewers plus a meta-review recommendation, structured concerns tied to reviewer roles, resolvable reviewer/affected-claim refs, unresolved concerns for claims without source spans, and blocking meta-review recommendations when major concerns remain unresolved, and requires storyline beats to trace to resolvable claim, challenge, takeaway, or review-concern records, not only paper/source-span refs. |
| `D1` | Docs, schema snapshots, packet fixtures, and migration notes are synced. | Passed `docs-sync-release-evidence.json` covering docs build, MCP schema snapshot, packet fixture drift tests, migration notes, input hashes, and `input_stability.checked=true` with no changed synced inputs. |
| `AB1` | Required ablations. | Passed ablation manifest containing the report-required structural ablations, with artifact-removal audits proving each target structure existed before ablation and was removed afterward, effect audits for measured lanes, a hashed `ablation_benchmark` input, and a hashed `report_artifact` for every required ablation variant. |

## Required Ablations

By default, the release gate expects:

```json
[
  "without_claim_graph",
  "without_must_cite",
  "without_reviewer_panel",
  "without_meta_reviewer",
  "without_storyline_dag",
  "without_temporal_cutoff",
  "without_coci_openalex",
  "without_graphrag_summaries",
  "without_link_prediction_signal",
  "without_counterfactual_planner"
]
```

With `--scope p0-p1`, the default ablation list is reduced to:

```json
[
  "without_claim_graph",
  "without_must_cite",
  "without_reviewer_panel",
  "without_meta_reviewer",
  "without_storyline_dag",
  "without_temporal_cutoff",
  "without_coci_openalex",
  "without_graphrag_summaries"
]
```

Generate the ablation manifest with:

```bash
npm run eval:idea-catalyst-ablation-suite -- \
  --dataset-path replay.json \
  --output-dir artifacts/ablations/run-001 \
  --run-id ablations-run-001 \
  --cutoffs 5,10,20 \
  --primary-cutoff 20 \
  --require-passed
```

The offline ablation runner now emits these report-required structural ablations by default. Each non-control ablation writes `artifact_removal_audit` with `target_present_before`, `target_removed`, `before_count`, and `after_count`. It also writes `ablation_effect_audit`: every report-required ablation must show a measured downstream effect, either as a metric degradation or relevant gate degradation after removal. Lanes that the lightweight replay suite cannot isolate yet, such as reviewer/meta-reviewer, COCI/OpenAlex support, GraphRAG summaries, and counterfactual planning, remain `incomplete` until a measured effect audit is supplied.

Release-gate `AB1` also checks ablation lineage. A release-grade ablation manifest must include `inputs[]` with a SHA-256 hash for `role=ablation_benchmark` or a compatible alias such as `benchmark_dataset`, `replay_dataset`, or `ablation_dataset`. Every required ablation entry must include `report_artifact.sha256` for the per-variant report generated by the runner. Legacy or hand-written ablation manifests that only list ablation ids, only prove target removal, omit benchmark input hash lineage, omit variant report hashes, or mark report-required lanes as `structural_only` stay `incomplete`.

## Status Semantics

| Status | Meaning |
| --- | --- |
| `passed` | Every required evidence category is present, passed, and release-grade. |
| `failed` | At least one supplied evidence category failed its gate. |
| `incomplete` | Evidence is missing, fixture-only, lacks source/license/hash metadata, or has not passed yet. |

This manifest does not download external datasets or create human labels. It prevents accidental promotion of harness-only progress into release evidence.

Replay-suite manifests generated before `releaseReadiness` was added are treated as `incomplete` by default. Re-run `eval:idea-catalyst-replay-suite` so the suite manifest records whether it is a real release candidate or only a plumbing/regression run. A replay-suite manifest with a ready status but without passed `strict_time_cutoffs_present`, `venue_year_holdout_present`, `time_slice_policy_present`, `release_grade_improvement_thresholds_present`, and `statistical_significance_evidence_present` checks is also treated as incomplete. For historical replay suites, that threshold preflight also requires the `major_metrics_beat_baseline` gate to pass with at least three positive major-metric lift thresholds configured, and the significance preflight requires at least three significant paired major-metric lifts.

`E4` also checks citation-slice provenance after replay-suite readiness passes. MasterSet-only reports remain incomplete until their source metadata, source-family fields, time-slice policy, provenance, or input records show both OpenAlex and COCI/OpenCitations historical slices.

Human blind aggregations generated before `releaseReadiness`, reviewer identity independence checks, assignment-slot coverage checks, review-form completeness checks, comparison coverage checks, blinding protocol audits, input hashes, or blind-review artifact hashes were added are also treated as `incomplete`. Re-run `eval:human-blind` with the completed labels so `aggregation.json` records reviewer-role sufficiency, distinct reviewer identity coverage, assignment binding to generated `assignments.json` slots, independent human label counts, six-dimension score coverage, explicit confidence coverage, major-concern recording, baseline/P0/P1/ablation comparison coverage, reviewer-visible blinding audit, preference-threshold readiness, SHA-256 hashes for the case and label inputs, and hashes for the blinded materials. The blinding audit also records `payload_policy` and rejects unexpected public payload fields outside `proposal` and `evidence_export`. The aggregate gate rechecks every required readiness check, verifies the numeric target preference threshold, and rejects zero target-pair aggregations even if a hand-written file claims `status: "passed"`.

Ingestion graph mutation execution reports are checked as `R3`. The release gate requires `status=applied`, `applyStatus=applied`, `dryRun=false`, a `ready_to_apply` graph apply plan, non-empty audited multimodal assets, passed `citation_intent_benchmark_passed` and `claim_extraction_benchmark_passed` gates, a changed authoritative graph checksum, matching projected and authoritative checksums, rollback safety evidence, artifact paths and SHA-256 hashes for both `rollback-manifest.json` and `before-graph-snapshot.json`, role-specific input hashes for `graph-mutations.json`, `graph-apply-plan.json`, citation-intent gold labels, claim-extraction gold labels, and multimodal assets, and non-fixture provenance. Preview-only, blocked executor reports, reports with rollback paths but missing hashes, or reports with only generic input hashes cannot pass `R3`.

Generate ingestion graph mutation execution evidence with:

```bash
npm run ingest:apply-graph-mutations -- \
  --graph-mutations-path artifacts/ingestion/run-001/graph-mutations.json \
  --graph-apply-plan-path artifacts/ingestion/run-001/graph-apply-plan.json \
  --corpus-root /path/to/corpus \
  --output-dir artifacts/ingestion-graph-mutation-execution/run-001 \
  --actor release-operator \
  --apply
```

Graph link-prediction reports generated without `--release-evidence`, raw input hashes, model, training slice, time cutoff, negative sampling policy, or OAG/OpenAlex/internal-KG source-family coverage are treated as `incomplete`. A passed temporal graph benchmark still needs the downstream `without_link_prediction_signal` ablation in full-scope `AB1` before the sidecar can be treated as useful for Idea-Catalyst. P0/P1 scope does not require this lane.

Graph reasoning reports are checked per benchmark family. `E5` requires SciRepEval, OAG-Bench, and GraphRAG-Bench evidence; a single combined report may satisfy all three only if its benchmark metadata covers all three names and every required graph reasoning gate is passed. Reports missing `papernexus-graph-reasoning-report-v1`, source/license metadata, `release_provenance_complete`, role-specific hashes for `graph_snapshot`, `graph_reasoning_tasks`, and `graphrag_summaries`, or GraphRAG/global-local summary gates remain `incomplete` or `failed`. A passed report must also show positive `global_local_summary_delta`; zero-lift summary plumbing is not release evidence.

Scientific embedding evidence is checked as `R4`. The aggregate gate requires the wrapper report from `eval:scientific-embedding-release-evidence`; raw deterministic token-hash manifests, external-vector manifests without retrieval-suite evidence, missing role-specific input hashes, missing SciRepEval/OAG/GraphRAG coverage, or dense/hybrid runs that do not improve over lexical remain `incomplete`.

Generate scientific embedding release evidence with:

```bash
npm run eval:scientific-embedding-release-evidence -- \
  --output-dir artifacts/scientific-embedding-release-evidence/run-001 \
  --run-id scientific-embedding-run-001 \
  --scientific-embedding-manifest artifacts/scientific-embeddings/specter2-run-001/manifest.json \
  --retrieval-suite-report artifacts/fixed-corpus-retrieval-suite/specter2-run-001/report.json \
  --require-passed
```

Innovation sidecar reports are checked per requirement in full scope. `R5` requires calibrated model-assisted evidence across NovBench, RINoBench, claim verification, and OpenReview-style reviewer data, plus an independent holdout/evaluation split so calibration labels cannot be reused as release evidence. `R5` also requires `model_calibration_complete` and `benchmark_metrics_passed` gates to exist and pass, and it requires separate hashed input roles for calibration labels and holdout/evaluation evidence. `R6` requires ToT/model-assisted counterfactual usefulness evidence with label coverage for selected plans, usefulness score at or above `0.5`, a positive failure-discovery metric, and a passed `counterfactual_usefulness` gate; it also requires separate hashed input roles for generated candidates, selected plans, and usefulness labels. Bounded deterministic offline counterfactual output, weak usefulness evidence, missing required gates, missing calibration labels, missing holdout policy, missing role-specific input hashes, missing source/license/input hashes, or fixture provenance remains `incomplete`. P0/P1 scope defers these sidecar gates.

Generate innovation sidecar evidence with:

```bash
npm run eval:innovation-sidecar-release-evidence -- \
  --output-dir artifacts/innovation-sidecar-release-evidence/run-001 \
  --run-id sidecar-run-001 \
  --model-assisted-report artifacts/model-assisted/calibration-report.json \
  --counterfactual-report artifacts/counterfactual/usefulness-report.json \
  --require-passed
```

Generate engineering evidence with:

```bash
npm run eval:engineering-release-evidence -- \
  --output-dir artifacts/engineering-release-evidence/run-001 \
  --run-id engineering-run-001 \
  --require-passed
```

This command runs the four named tests from the report completion definition one file at a time and records command status plus SHA-256 hashes for the required test files.

Generate docs sync evidence with:

```bash
npm run eval:docs-sync-release-evidence -- \
  --output-dir artifacts/docs-sync-release-evidence/run-001 \
  --run-id docs-sync-run-001 \
  --require-passed
```

`D1` is intentionally stronger than a standalone docs build. The report must include `docs_build`, `mcp_schema_snapshot`, `packet_fixture_drift`, and `migration_notes_present`, plus SHA-256 hashes for the required docs, snapshots, packet tests, and migration note files. Release gate also requires `input_stability.checked=true` and rejects reports with any changed synced input hashes, so a stale pre-stability `passed` report is treated as incomplete.

Package the final release evidence bundle with:

```bash
npm run eval:release-evidence-bundle -- \
  --bundle-dir artifacts/release-evidence/2026-05-27/run-001 \
  --require-passed
```

The bundle audit checks the final `artifacts/release-evidence/<date>/...` directory, not the individual benchmark metrics. It requires raw inputs, normalized datasets, run config, evidence reports, the docs-sync release evidence report consumed by the release gate, the passed release-gate manifest, stdout/stderr logs, and SHA-256 coverage for every file listed under `release-gate-manifest.json.evidence_inputs[]`.

Use `eval:release-evidence-bundle -- --collect-release-gate-inputs --release-gate-manifest <release-gate-manifest.json>` immediately after the real P0/P1 release gate run. It copies the gate manifest and the hash-matching report files listed in `evidence_inputs[]` into canonical bundle paths before the deeper lineage collectors run. It does not create replay, human, ingestion, engineering, docs-sync, or ablation evidence; hash mismatches remain incomplete.

When all evidence files are already present under stable artifact roots, the release bundle CLI can run the three packaging collectors in one invocation. The execution order is fixed as release-gate evidence inputs, R1-SIG/R2/R3/AB1 lineage artifacts, then T1/D1 source snapshots.

For P0/P1 T1/D1 evidence, the final bundle also follows the internals of the engineering and docs-sync release reports. The engineering report's required test-file input hashes must resolve to bundled `source/package.json` / `source/test/*.js` snapshots, and the docs-sync report's final plus precheck input hashes must resolve to bundled `source/**` snapshots with `input_stability.checked=true` and no changed inputs. A release-gate-passed T1/D1 summary without those source snapshots remains an incomplete bundle.

Use `eval:release-evidence-bundle -- --collect-source-snapshots --source-root .` after copying the real T1/D1 reports into the bundle to copy only hash-matching source snapshots and update `release-evidence-bundle.json`. Hash mismatches stay incomplete and must be resolved by regenerating the T1/D1 reports or using the exact source revision they recorded.

For P0/P1 R2 evidence, the final bundle also follows the `human_blind_aggregation` internals: the case file, completed label file, blind pack, assignments, answer key, and review form schema referenced by aggregation hashes must all be packaged. A release-gate-passed aggregation summary without those source files remains an incomplete bundle.

For P0/P1 R3 evidence, the final bundle follows the `ingestion_graph_mutation_execution` internals as well: graph mutations, graph apply plan, citation-intent gold labels, claim-extraction gold labels, multimodal assets, rollback manifest, and before-graph snapshot hashes must all resolve to packaged files. A release-gate-passed execution report without those source and rollback files remains an incomplete bundle.

Use `eval:release-evidence-bundle -- --collect-lineage-artifacts --artifact-root <artifact-root>` after copying the real R1-SIG/R2/R3/AB1 reports into the bundle to copy only hash-matching statistical-significance files, human-blind materials, ingestion inputs/rollback snapshots, and ablation benchmark/variant reports into their canonical bundle paths. This helper only packages already-existing evidence referenced by report hashes; it does not generate benchmark runs, labels, ingestion apply outputs, or ablation reports.
