# Model-Assisted Innovation Modes

PaperNexus keeps deterministic innovation artifacts as the default path. Optional model-assisted mode adds provenance and advisory/calibrated model evidence to the v2 artifact packet without replacing deterministic gates.

## Contract

Pass `modelAssisted` to the innovation artifact builders:

```js
buildIdeaCatalystInnovationArtifacts(packet, {
  modelAssisted: {
    enabled: true,
    mode: 'calibrated',
    provider: 'openai-compatible',
    modelId: 'reviewer-adapter-v1',
    promptVersion: 'innovation-reviewer-v1',
    inferenceRunId: 'model-run-001',
    calibrationDataset: 'PeerRead-NovBench-2026-05-slice',
    calibrationRunId: 'calibration-run-001',
    labels: [{ id: 'case-1' }],
    uncertainty: 0.18,
    noveltyScores: {
      novelty: 0.9,
      significance: 0.82,
      feasibility: 0.77,
      grounding: 0.88
    },
    reviewerAssessments: [{
      role: 'novelty',
      score: 0.86,
      confidence: 0.7,
      summary: 'The idea appears novel relative to the prior-art packet.',
      concerns: ['Check the nearest baseline.']
    }],
    metaReview: {
      recommendation: 'weak_accept',
      confidence: 0.68,
      summary: 'Acceptable as a proposal after must-cite verification.'
    },
    storyline: {
      suggestions: ['Tie why-now to the review concern packet.']
    }
  }
});
```

When enabled, the packet can include:

| Field | Purpose |
| --- | --- |
| `model_assisted` | Top-level model, prompt, calibration, status, and warning metadata. |
| `novelty_certificate.model_assisted` | Advisory model scores and score deltas against deterministic dimensions. |
| `review_packet.model_assisted` | Model reviewer assessments and optional model meta-review. |
| `storyline_dag.model_assisted` | Storyline annotations or revision suggestions. |

## Modes

| Mode | Status semantics |
| --- | --- |
| `off` | Default. No model-assisted fields are emitted. |
| `advisory` | Model evidence is attached, but missing model id or prompt version makes the lane `incomplete`. |
| `calibrated` | Requires model id, prompt version, calibration dataset, calibration run id, and labels. Missing any of these keeps the lane `incomplete`. |

## Release Boundary

Model-assisted fields do not overwrite deterministic `novelty`, `grounding`, `must_cite_completeness`, reviewer recommendation, or storyline support gates. They provide auditable side evidence for later adapter/LoRA/reviewer calibration work.

Release evidence still requires external benchmark artifacts:

- NovBench / RINoBench / axiomatic novelty for novelty judgment.
- CLAIM-BENCH / CLAIMCHECK for claim grounding.
- OpenReview / PeerRead / MOPRD / Re2 for reviewer/meta-reviewer calibration.
- Human blind labels for proposal preference.

This keeps the report alignment boundary explicit: PaperNexus now has a model-assisted contract lane, but it still needs real calibrated model runs before claiming P1 model-assisted evaluation is complete.

For release gating, wrap calibrated model-assisted benchmark output with `npm run eval:innovation-sidecar-release-evidence`. The main Idea-Catalyst release gate records this as `R5` and requires calibrated mode, model id, prompt version, calibration dataset/run/labels, NovBench/RINoBench/claim/OpenReview-style family coverage, source/license metadata, input hashes, and non-fixture provenance.
