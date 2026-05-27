# Idea-Catalyst Historical Replay

`idea-catalyst-historical-replay-v1` is the release-gate harness for checking whether v2 Idea-Catalyst packets are stronger than the current live-discovery baseline under a strict historical cutoff.

It is intended to operationalize the report requirements around MasterSet-style must-cite recall, novelty benchmarks, claim grounding, storyline traceability, and historical replay. The harness does not download external benchmark datasets by itself. External datasets must be normalized into the replay JSON contract below, then run through the CLI.

## Command

For release-gate work, prefer the suite command. It normalizes the raw benchmark, runs the historical replay, records input SHA-256 hashes, preserves dataset source/license metadata, and writes a single suite manifest:

```bash
npm run eval:idea-catalyst-replay-suite -- \
  --input-path raw-openreview.json \
  --output-dir artifacts/idea-catalyst-replay/openreview-2026-05-26 \
  --format openreview \
  --run-id openreview-2026-05-26 \
  --candidate-packets-path candidate-packets.json \
  --baseline-packets-path baseline-packets.json \
  --cutoffs 5,10,20 \
  --primary-cutoff 20 \
  --dataset-source "OpenReview snapshot id or URL" \
  --license-scope "dataset license / internal-use scope" \
  --holdout-policy "venue/year holdout: train venues <=2024, held-out venue-year=ICLR 2025" \
  --time-slice-policy "OpenAlex/S2ORC/reference graph sliced at each case timeCutoff" \
  --statistical-significance-json @statistical-significance.json \
  --require-passed
```

The suite writes `normalized-replay.json`, a nested historical replay artifact directory, and `replay-suite-manifest.json`. Missing candidate packets, baseline packets, gold labels, or strict time cutoffs are reported in `diagnostics.messages`; missing packets or all-gold-label absence make the suite `incomplete` rather than silently passing. The suite manifest schema is maintained at [`idea-catalyst-replay-suite.schema.json`](./idea-catalyst-replay-suite.schema.json).

The suite manifest also includes `releaseReadiness`. This field is stricter than the suite `status`: a fixture can pass the replay mechanics while still being `releaseReadiness.status: "incomplete"`. `releaseReadiness` requires a passed suite, dataset source, license scope, raw input SHA-256, non-fixture provenance, strict time cutoffs for every replay case, an explicit venue/year holdout policy, an explicit OpenAlex/S2ORC/reference time-slice policy, release-grade improvement thresholds, semantic negative coverage, paired statistical significance evidence, and at least one ready evidence family (`must_cite`, `novelty`, `claim_grounding`, or `historical_replay`). Downstream `eval:idea-catalyst-release-gate` still performs the final E1-E7 check, but this early audit makes non-release-grade replay runs visible before they are bundled into a release manifest.

Holdout and time-slice policy text is treated as evidence, not decoration. Policies that explicitly negate the requirement, such as `no venue/year holdout configured` or `no time slice configured for OpenAlex/S2ORC/reference snapshots`, are rejected even though they contain the same keywords.

Normalize a raw external benchmark first when it is not already in replay format:

```bash
npm run eval:prepare-idea-catalyst-replay -- \
  --input-path raw-masterset.json \
  --output-path replay.json \
  --format masterset \
  --candidate-packets-path candidate-packets.json \
  --baseline-packets-path baseline-packets.json \
  --time-cutoff 2024 \
  --dataset-source "MasterSet snapshot id or URL" \
  --license-scope "dataset license / internal-use scope"
```

Supported adapter families are `masterset`, `novbench`, `rinobench`, `axiomatic_novelty`, `claim-bench`, `claimcheck`, `openreview`, `peerread`, `moprd`, and `re2`. The adapter preserves unknown source fields and adds `source_metadata` so released dataset ids, venue metadata, license scope, and review labels remain auditable.

Prepared replay JSON also records top-level `dataset_source`, `license_scope`, `inputs[]`, and `provenance.inputs[]`. Each input record includes role, absolute path, file size, modified time, and SHA-256 for the raw benchmark and any candidate/baseline packet files supplied to the adapter. This is separate from the replay-suite manifest hash chain: it makes the normalized dataset itself auditable when the prepare step and replay step are run separately.

Run the normalized replay dataset:

```bash
npm run eval:idea-catalyst-replay -- \
  --dataset-path replay.json \
  --output-dir artifacts/idea-catalyst-replay/run-001 \
  --run-id run-001 \
  --cutoffs 5,10,20 \
  --primary-cutoff 20
```

Optional thresholds can be supplied inline or by file:

```bash
npm run eval:idea-catalyst-replay -- \
  --dataset-path replay.json \
  --thresholds-json @thresholds.json
```

The schema is maintained at [`idea-catalyst-historical-replay.schema.json`](./idea-catalyst-historical-replay.schema.json).

## Minimal Dataset

```json
{
  "name": "mini-idea-catalyst-replay",
  "format": "custom",
  "cases": [
    {
      "id": "case:example",
      "dataset": "masterset-novbench-claimcheck",
      "timeCutoff": 2024,
      "candidate": {
        "evidence_status": "source_backed",
        "must_cite_set": [
          { "title": "Anchor Method", "doi": "10.1000/anchor", "year": 2020 }
        ],
        "novelty_certificate": {
          "novelty": 0.9,
          "significance": 0.8,
          "feasibility": 0.7,
          "grounding": 1,
          "must_cite_completeness": 1,
          "temporal_validity": 1,
          "future_leakage_count": 0,
          "reasons": ["all claims and citations are grounded"]
        },
        "contribution_claims": [
          {
            "claim_id": "claim:1",
            "claim_text": "The proposed bridge improves grounding.",
            "source_span_ids": ["span:1"]
          }
        ],
        "storyline_dag": {
          "beats": [
            { "beat_id": "beat:problem", "trace_refs": [{ "kind": "claim", "id": "claim:1" }] }
          ],
          "edges": [],
          "unsupported_beats": []
        },
        "bridge_rerank_signals": {
          "signals": [
            {
              "source_id": "challenge:grounding",
              "target_id": "method:bridge",
              "predicted_edge_type": "ADAPTS_METHOD",
              "score": 0.92,
              "rank": 1
            }
          ]
        }
      },
      "baseline": {
        "evidence_status": "weak_evidence",
        "must_cite_set": [],
        "novelty_certificate": {
          "novelty": 0.4,
          "significance": 0.4,
          "feasibility": 0.4,
          "grounding": 0,
          "must_cite_completeness": 0,
          "temporal_validity": 1,
          "future_leakage_count": 0,
          "reasons": ["baseline has weak evidence"]
        },
        "contribution_claims": [],
        "storyline_dag": { "beats": [], "edges": [], "unsupported_beats": [] }
      },
      "gold": {
        "must_cite_set": [
          { "title": "Anchor Method", "doi": "10.1000/anchor" }
        ],
        "claims": [
          { "claim_id": "claim:1", "label": "supported" }
        ],
        "novelty_certificate": {
          "novelty": 0.9,
          "significance": 0.8,
          "feasibility": 0.7,
          "grounding": 1,
          "must_cite_completeness": 1,
          "temporal_validity": 1
        },
        "bridge_edges": [
          {
            "source_id": "challenge:grounding",
            "target_id": "method:bridge",
            "edge_type": "ADAPTS_METHOD"
          }
        ]
      }
    }
  ]
}
```

## Adapter Mapping

External benchmark adapters should normalize released data into one replay case per topic, paper, or proposal.

| Source family | Replay fields |
| --- | --- |
| MasterSet-style must-cite data | `gold.must_cite_set[]` with DOI, arXiv, S2, OpenAlex, or title aliases. |
| NovBench / RINoBench / axiomatic novelty | `gold.novelty_certificate` dimensions in the 0..1 range. |
| CLAIM-BENCH / CLAIMCHECK | `gold.claims[]` with `claim_id` or claim text plus `label` / `verdict` / `supported`. |
| OpenReview / PeerRead / MOPRD / Re2 | `timeCutoff`, `baseline`, `candidate`, review-derived labels, later accepted or cited directions as gold evidence, and venue/year holdout metadata in the suite manifest. |
| OpenAlex / S2ORC / COCI historical slices | Citation identifiers, publication years, and must-cite labels used to prove no future-paper leakage. |
| Graph link-prediction / bridge rerank | Optional `candidate.bridge_rerank_signals`, `candidate.predicted_bridge_edges`, or `candidate.graph_link_prediction.predicted_bridge_edges` plus `gold.bridge_edges[]`. |

Adapters should preserve original dataset ids in additional fields. The harness ignores unknown properties, so raw labels, venue metadata, reviewer ids, and license or provenance records can travel with each case.

## Gates

The replay report emits these gate names:

| Gate | Requirement |
| --- | --- |
| `must_cite_recall_at_k` | Candidate `must_cite_set` reaches the configured Recall@K threshold against gold must-cite labels. |
| `novelty_beats_baseline` | Candidate novelty certificate has non-negative or configured-positive improvement over baseline on gold-labeled cases. |
| `claim_grounding` | Source-backed claims have source spans and claim F1 or span completeness reaches the configured threshold. |
| `claim_grounding_release_lift` | When configured, claim F1 must improve over baseline and unsupported claim rate must drop. |
| `storyline_traceability` | Every storyline beat is traceable to a claim, challenge, takeaway, or review concern. Generic paper, source-span, or artifact refs alone do not count as traceability for this gate. |
| `major_metrics_beat_baseline` | When configured, at least the requested number of major metrics beat the baseline. This supports the E1 "at least 3 major metrics" release check. |
| `historical_replay_beats_live_discovery` | Candidate historical score beats the baseline under the configured time cutoff and has no future leakage. |

When `gold.bridge_edges[]` is present, the report also emits `bridge_rerank_recall_at_k` and includes bridge-rerank Recall@K in the per-case `historical_score`. This is intentionally optional so older must-cite, novelty, claim, and historical replay datasets do not become incomplete merely because they lack link-prediction labels.

The default thresholds keep local plumbing runs usable. Release candidates must configure stricter threshold fields so the suite proves the deep-research deltas instead of only proving that the harness ran:

```json
{
  "mustCiteRecallAtK": 0.8,
  "mustCiteRecallAtKImprovement": 0,
  "noveltyImprovement": 0,
  "claimGroundingF1": 0.7,
  "claimGroundingF1Improvement": 0,
  "unsupportedClaimRateReduction": 0,
  "claimSourceSpanCompleteness": 1,
  "storylineTraceCoverage": 1,
  "storylineTraceCoverageImprovement": 0,
  "historicalReplayImprovement": 0,
  "minMajorMetricImprovements": 0,
  "futureLeakageCount": 0,
  "sourceBackedUngroundedClaims": 0
}
```

For `releaseReadiness.status: "ready_for_release_gate"`, the suite preflight requires the relevant configured thresholds to match the deep-research minima:

```json
{
  "primaryCutoff": 20,
  "mustCiteRecallAtKImprovement": 0.1,
  "noveltyImprovement": 0.08,
  "claimGroundingF1Improvement": 0.1,
  "unsupportedClaimRateReduction": "> 0",
  "historicalReplayImprovement": "> 0",
  "minMajorMetricImprovements": 3,
  "positiveMajorMetricThresholdCount": 3
}
```

The report metrics include candidate, baseline, and delta fields for the release-critical measurements: `must_cite_recall_at_k`, `novelty_score`, `claim_grounding_f1`, `unsupported_claim_rate`, `storyline_trace_coverage`, and `historical_score`. It also writes `major_metric_improvement_count`, `evaluated_major_metric_count`, and `major_metric_improvements[]` so the release gate can audit which metrics counted toward E1.

Release-ready replay-suite manifests must also include `statistical_significance`, either embedded in the hashed raw dataset metadata or passed with `--statistical-significance-json @statistical-significance.json`. Inline JSON is accepted for plumbing and regression tests, but it is not release-auditable unless the same evidence is covered by a hashed raw dataset or a hashed `statistical_significance` input file. The accepted evidence shape is intentionally simple: an array/object of per-metric paired tests with `metric`, `test` or `test_type`, `sample_size`, positive `effect_size`/`delta`/`improvement`, and either `p_value <= 0.05` or a confidence interval whose lower bound is greater than zero. Accepted test labels include paired bootstrap, Wilcoxon signed-rank, permutation/randomization tests, McNemar/sign tests, or equivalent confidence-interval evidence. For historical replay/E1, at least three major metrics must have significant positive paired evidence.

Release-ready replay-suite manifests must also include semantic negative coverage. Random corruption is not enough for the report requirement; the suite should carry `semantic_negative_cases`, `semantic_negatives`, `negative_cases`, or equivalent per-case metadata covering `baseline_missing_citation`, `year_leakage`, `claim_evidence_swap`, `source_domain_mismatch`, `storyline_order_shuffle`, `terminology_only_novelty`, `contribution_result_decoupling`, and `review_concern_false_resolution`. At least one negative case must be marked `multi_step_failure`, `multi_step`, or equivalent so the suite covers long-chain workflow failures rather than only single-turn hallucination.

## Artifacts

When `--output-dir` is provided, the harness writes:

| Artifact | Purpose |
| --- | --- |
| `report.json` | Full machine-readable report with gates, metrics, and per-case scores. |
| `report.md` | Human-readable release-gate summary. |
| `summary.tsv` | Flat case-level table for quick comparison and spreadsheet import, including `bridge_rerank_recall` when gold bridge edges are available. |
| `manifest.json` | Run metadata and artifact paths. |

The suite command also writes:

| Artifact | Purpose |
| --- | --- |
| `normalized-replay.json` | Adapter-normalized replay dataset used by the run. |
| `historical-replay/` | The nested single-run report artifacts. |
| `replay-suite-manifest.json` | Dataset source/license, input hashes, adapter diagnostics, thresholds, statistical significance evidence, gates, metrics, and artifact paths. |

## R1 Release Evidence Skeleton

Before running real external benchmark suites, create a non-passing R1 evidence scaffold:

```bash
npm run eval:replay-release-skeleton -- \
  --output-dir artifacts/release-evidence/2026-05-27/r1-replay \
  --run-id r1-replay-2026-05-27
```

The scaffold writes `replay-release-evidence-skeleton.json`, `R1-REPLAY-EVIDENCE-TODO.md`, and empty directories for the required families: MasterSet, NovBench, RINoBench, axiomatic novelty, CLAIM-BENCH, CLAIMCHECK, OpenReview, PeerRead, MOPRD, and Re2/Re². Each family records target paths for raw input, normalized replay data, run config, release thresholds, paired statistical significance, and the final replay-suite manifest.

This command does not create raw inputs, normalized datasets, reports, statistical-significance files, or passing release evidence. It only fixes where real P0/P1 artifacts must land before they are consumed by `eval:idea-catalyst-release-gate -- --scope p0-p1` and then packaged by `eval:release-evidence-bundle`.

## Release Status

Passing synthetic fixtures proves that the gate code works. It does not prove report-level completion. Release alignment requires real external benchmark manifests and recorded runs for the benchmark families above, with artifacts preserved alongside the run id.

Use `releaseReadiness.status` as the replay-suite preflight:

- `ready_for_release_gate`: the suite is a release candidate and can be passed to the release-gate bundler.
- `incomplete`: the suite may still be useful for regression tests or plumbing, but it is missing release metadata, contains fixture/synthetic/mock/mini evidence, lacks raw input hashes, lacks strict time cutoffs, lacks venue/year holdout or source time-slice policy, lacks semantic negative coverage, lacks statistical significance evidence, or has no applicable benchmark family with passed gates.
