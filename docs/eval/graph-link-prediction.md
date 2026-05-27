# Graph Link Prediction

`papernexus-graph-link-prediction-v1` is the offline sidecar contract for scholarly KG link prediction and bridge reranking.

The report asks for a P2 GNN/link-prediction lane that can learn candidate bridge edges across source domains, mechanisms, challenges, citation contexts, and must-cite evidence without blocking the online PaperNexus graph path. This implementation owns the artifact format and local plumbing. It does not train a real GNN in the Node process.

## CLI

```bash
npm run index:graph-link-prediction -- \
  --graph-path artifacts/graph-snapshot.json \
  --output-dir artifacts/graph-link-prediction/run-001 \
  --time-cutoff 2025 \
  --training-slice openalex-oag-2020-2025
```

Outputs:

- `predicted-bridge-edges.json`
- `bridge-rerank-signals.json`
- `manifest.json`

`bridge-rerank-signals.json` is intentionally small and keyed by `source_id->target_id`, so main graph and idea-catalyst paths can consume it as an optional rerank signal. Predicted edges must not be written into the authoritative KG by default.

## Temporal Benchmark Evaluator

```bash
npm run eval:graph-link-prediction -- \
  --predicted-bridge-edges artifacts/graph-link-prediction/run-001/predicted-bridge-edges.json \
  --gold-temporal-edges artifacts/benchmarks/oag-openalex-link-prediction/gold-temporal-edges.json \
  --output-dir artifacts/graph-link-prediction-eval/run-001 \
  --benchmark-name "OAG OpenAlex Internal KG Temporal Link Prediction 2026-05" \
  --dataset-source https://benchmarks.example.org/oag-openalex-link-prediction/2026-05 \
  --license-scope "public benchmark research use" \
  --model hgt-temporal-link-prediction \
  --time-cutoff 2024 \
  --training-slice openalex-oag-2020-2024 \
  --negative-sampling-policy type_balanced_non_edges_v1 \
  --release-evidence
```

Outputs:

- `graph-link-prediction-eval.json`
- `graph-link-prediction-eval.md`
- `manifest.json`

The evaluator measures exact held-out edge recovery against positive and negative temporal gold edges:

- `hits_at_1`
- `hits_at_10`
- `mrr`
- `auc_like_pair_accuracy`
- `future_leakage_count`
- `missing_positive_prediction_count`

It also gates release evidence on non-fixture benchmark source, license scope, input SHA-256 records, model, training slice, time cutoff, and negative sampling policy. Fixture, synthetic, mock, mini, sample, or unit-test evidence stays `incomplete` even when metrics are high.

Pass the full report into the release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --graph-link-prediction-report artifacts/graph-link-prediction-eval/run-001/graph-link-prediction-eval.json
```

The release gate records this as `R7` and rejects lightweight graph-link-prediction manifests that do not include raw input hashes. The full eval report must also cover the report-named OAG, OpenAlex, and internal-KG source families; an OpenAlex-only or generic temporal-link-prediction report remains incomplete.

## Downstream Bridge-Rerank Ablation

Graph link prediction is not release-aligned until it improves a downstream PaperNexus task. Normalize bridge labels into replay cases with `gold.bridge_edges[]`, attach the sidecar output as `candidate.bridge_rerank_signals`, `candidate.predicted_bridge_edges`, or `candidate.graph_link_prediction.predicted_bridge_edges`, then run:

```bash
npm run eval:idea-catalyst-ablation-suite -- \
  --dataset-path artifacts/idea-catalyst-replay/bridge-rerank/replay.json \
  --output-dir artifacts/idea-catalyst-ablations/bridge-rerank-run-001 \
  --run-id bridge-rerank-run-001 \
  --cutoffs 5,10,20 \
  --primary-cutoff 20 \
  --require-passed
```

The default suite includes `without_link_prediction_signal`. Historical replay reports `bridge_rerank_recall_at_k` whenever gold bridge edges exist, and the ablation manifest records the delta from the full packet. This is the required downstream evidence lane for deciding whether the sidecar improves idea-catalyst grounding, must-cite coverage, or storyline coherence.

## Contract

Each predicted edge records:

- `prediction_id`
- `source_id`, `source_type`, `source_name`
- `target_id`, `target_type`, `target_name`
- `predicted_edge_type`
- `score`
- `rank`
- `evidence`
- `status`
- `online_use: "rerank_signal_only"`

The manifest records:

- model and method provenance
- dataset source and license scope
- training slice
- time cutoff
- negative sampling policy
- release-gate status

## Default Backend

The default backend is `deterministic-heterogeneous-link-prediction-v1`. It scores non-edges with simple heterogeneous graph and text features:

- source/target type prior
- shared tokens
- common neighbors
- bridge-relevant edge-type context

This backend is useful for local regression tests and artifact plumbing. It is not a trained GNN and is not release-grade evidence.

## External GNN Results

External sidecars can provide JSON or JSONL predictions with fields such as:

```json
{
  "source_id": "challenge:bias",
  "target_id": "method:reflective-prompts",
  "predicted_edge_type": "ADAPTS_METHOD",
  "score": 0.91
}
```

When an external prediction source is supplied, PaperNexus preserves the scores and attaches provenance. The manifest becomes `ready_for_evaluation` only when model, dataset source, license scope, training slice, and time cutoff are all present. It still does not become release-pass evidence until an external temporal link-prediction benchmark passes.

## Release Boundary

This lane remains incomplete for the full deep-research goal until the project has:

- a real GNN or temporal link-prediction sidecar,
- frozen OpenAlex/OAG/internal-KG train/validation/test slices,
- explicit negative sampling policy,
- time-cutoff enforcement to avoid future leakage,
- temporal benchmark reports from `eval:graph-link-prediction` proving link-prediction quality,
- downstream `without_link_prediction_signal` ablation reports proving idea-catalyst benefit.
