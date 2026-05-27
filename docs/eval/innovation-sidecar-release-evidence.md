# Innovation Sidecar Release Evidence

`papernexus-innovation-sidecar-release-evidence-v1` is the release-gate evidence wrapper for the model-assisted and counterfactual lanes that remain outside the deterministic default path.

It does not create calibrated labels, run a model, or perform Tree-of-Thought search. It verifies that those external artifacts are present, auditable, non-fixture, and strong enough for the Idea-Catalyst release gate to count `R5` and `R6`.

## Command

```bash
npm run eval:innovation-sidecar-release-evidence -- \
  --output-dir artifacts/innovation-sidecar-release-evidence/run-001 \
  --run-id sidecar-run-001 \
  --model-assisted-report artifacts/model-assisted/calibration-report.json \
  --counterfactual-report artifacts/counterfactual/usefulness-report.json \
  --require-passed
```

Outputs:

| Artifact | Purpose |
| --- | --- |
| `innovation-sidecar-release-evidence.json` | Machine-readable `R5` and `R6` status, diagnostics, input hashes, and nested evidence summaries. |
| `innovation-sidecar-release-evidence.md` | Human-readable sidecar evidence summary. |
| `manifest.json` | Compact manifest for downstream artifact registries. |

Pass the full JSON report into the main release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --innovation-sidecar-evidence artifacts/innovation-sidecar-release-evidence/run-001/innovation-sidecar-release-evidence.json
```

## R5: Model-Assisted Calibration

`R5` passes only when the input report provides:

- supported contract version: `model-assisted-innovation-v1` or `papernexus-model-assisted-calibration-v1`
- `status: "passed"` or equivalent release-ready status
- `mode: "calibrated"`
- model id and prompt version
- calibration dataset, calibration run id, and positive label count
- independent evaluation or holdout dataset plus holdout policy; the evaluation dataset/split must not be the calibration dataset/split, and any reported overlap count must be zero
- role-specific SHA-256 inputs for calibration labels and holdout/evaluation evidence
- benchmark-family coverage for `novbench`, `rinobench`, claim verification, and OpenReview-style reviewer data
- required gates `model_calibration_complete` and `benchmark_metrics_passed`, both with `status: "passed"`
- dataset source, license scope, and input SHA-256 hashes
- no fixture, synthetic, mock, toy, mini, example, demo, sample, or unit-test provenance

## R6: Counterfactual Usefulness

`R6` passes only when the input report provides:

- supported contract version: `papernexus-counterfactual-search-v1` or `papernexus-counterfactual-usefulness-v1`
- `status: "passed"`
- ToT/model-assisted search mode or backend, not only bounded deterministic offline search
- positive candidate count and selected-plan count
- usefulness labels covering every selected plan
- role-specific SHA-256 inputs for generated counterfactual candidates, selected plans, and usefulness labels
- usefulness score at or above `0.5`
- positive `failure_discovery_rate` or equivalent failure-discovery metric
- required gate `counterfactual_usefulness` with `status: "passed"`
- dataset source, license scope, and input SHA-256 hashes
- no fixture or synthetic provenance

## Release Boundary

The existing deterministic `counterfactual-search.js` lane remains useful as the offline contract and regression substrate, but it cannot satisfy `R6` by itself. Likewise, `model-assisted-innovation.js` can emit the model-assisted contract fields, but `R5` requires real calibrated benchmark artifacts and passed required gates before the main release gate can pass. Hand-written reports that set top-level `status: "passed"` without these gates, or with only a single generic input hash instead of role-specific hashes, remain incomplete.
