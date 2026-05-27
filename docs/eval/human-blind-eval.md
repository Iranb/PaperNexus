# Human Blind Evaluation

`human-blind-eval-v1` is the offline sandbox for the expert pairwise preference gate described in the deep research alignment plan.

It does not replace real expert review. It prepares anonymized packets, reviewer assignments, and a review form schema, then aggregates completed labels conservatively. AI, model-generated, author, self-review, and unverified labels are recorded but excluded from release-pass human evidence.

## Command

```bash
npm run eval:human-blind -- \
  --input-path cases.json \
  --output-dir artifacts/human-blind-eval/run-001 \
  --run-id run-001 \
  --seed run-001 \
  --target-system candidate
```

With completed labels:

```bash
npm run eval:human-blind -- \
  --input-path cases.json \
  --labels-path labels.json \
  --output-dir artifacts/human-blind-eval/run-001 \
  --run-id run-001 \
  --seed run-001 \
  --require-passed
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `blind-pack.json` | Anonymous case, packet, and pair records for reviewers. |
| `assignments.json` | Reviewer role slots for each pair. |
| `answer-key.json` | Private mapping from blinded packet ids to system keys. Do not send this to reviewers. |
| `review-form.schema.json` | JSON schema for completed review labels. |
| `aggregation.json` | Preference, confidence-weighted preference, reviewer role sufficiency, dimensions, and agreement. Written only when labels are supplied. |

`aggregation.json` also includes `releaseReadiness`. This preflight is stricter than `status`: it requires a passed aggregation, at least one valid independent human target-pair label, sufficient reviewer role counts for every target pair, distinct reviewer identities covering every required reviewer slot, completed labels bound to generated assignment slots, complete review-form labels, target-system comparison coverage for baseline/P0/P1/ablation, a passed blinding protocol audit, a target preference rate at or above the configured threshold, and at least one target-system blind pair. Complete review-form labels must include both-side scores for every protocol dimension, an explicit confidence value, and a recorded `major_concerns` array for every valid human target-pair label. Assignment coverage requires each valid release label to include an `assignment_id` from `assignments.json` that matches the same `pair_id` and reviewer role, with every target-pair reviewer slot completed exactly once. The blinding audit requires reviewer-visible public artifacts to omit system/model identifier fields, restrict blind packet payloads to `proposal` plus `evidence_export`, and keep `answer-key.json` private. When the CLI is run with file paths, the aggregation also records SHA-256 `inputs[]` for the blinded case input and completed label file, plus `blind_review_artifacts[]` hashes for the blind pack, assignments, private answer key, and review form schema. Release-gate E7 requires `releaseReadiness.status: "ready_for_release_gate"` plus these input and artifact hashes.

## Input

Each case can provide `systems`, `variants`, or `packets`, or the convenience fields `baseline`, `candidate`, `p0`, and `p1`. For release readiness, each target case should include the current repo baseline, P0, P1, and at least one key ablation under `ablations`; the default pair builder will compare the target system against each non-target system.

```json
{
  "name": "idea-catalyst-human-blind-mini",
  "cases": [
    {
      "id": "case:example",
      "topic": "grounded idea evaluation",
      "baseline": {
        "proposal": { "title": "Baseline proposal" },
        "evidence_export": { "must_cite_set": [] }
      },
      "candidate": {
        "proposal": { "title": "V2 proposal" },
        "evidence_export": {
          "must_cite_set": [{ "title": "Anchor Method" }],
          "contribution_claims": [
            {
              "claim_id": "claim:1",
              "claim_text": "The proposal improves grounding.",
              "source_span_ids": ["span:1"]
            }
          ]
        }
      },
      "p0": {
        "proposal": { "title": "P0 proposal" }
      },
      "p1": {
        "proposal": { "title": "P1 proposal" }
      },
      "ablations": {
        "without_claim_graph": {
          "proposal": { "title": "Ablated proposal" }
        }
      }
    }
  ]
}
```

The blind pack exposes only the reviewer-visible `proposal` and `evidence_export` payload sections. It strips system-label fields such as `system_label`, `variant`, `model_name`, and related metadata from those sections, and the blinding audit records `blinding_protocol.payload_policy: "proposal_and_evidence_export_only"`. Unexpected top-level payload fields such as provider traces, internal notes, scorer metadata, or experiment logs make the blinding protocol incomplete. The scrubber cannot safely remove labels embedded in free-form proposal text, so packet producers should avoid writing system names into reviewer-visible content.

## Review Labels

The default protocol follows the report requirement: each target pair must have `3` domain experts, `1` methodology reviewer, and `1` reproducibility reviewer. These five required slots must be covered by distinct `reviewer_id` values; the same person cannot fill a domain slot and a methodology or reproducibility slot for the same target pair. The target system passes only when blind preference is at least `0.6`.

```json
{
  "labels": [
    {
      "pair_id": "pair:example",
      "assignment_id": "assignment:example-domain-1",
      "reviewer_id": "expert:1",
      "reviewer_role": "domain_expert",
      "reviewer_source": "human",
      "selected_side": "left",
      "confidence": 0.9,
      "scores": {
        "left": {
          "novelty": 5,
          "significance": 4,
          "feasibility": 4,
          "grounding": 5,
          "storyline_coherence": 4,
          "must_cite_completeness": 5
        },
        "right": {
          "novelty": 3,
          "significance": 3,
          "feasibility": 3,
          "grounding": 2,
          "storyline_coherence": 3,
          "must_cite_completeness": 2
        }
      },
      "major_concerns": []
    }
  ]
}
```

Use `reviewer_source: "human"` or `is_human: true` for independent human labels. Labels with `reviewer_source` values such as `ai`, `model`, `author`, or `self` are excluded from release-pass evidence.

## Release Readiness

Human evidence is release-ready only when:

- `aggregation.status` is `passed`.
- `releaseReadiness.status` is `ready_for_release_gate`.
- `reviewer_protocol.sufficient_reviewers` is `true`.
- `reviewer_protocol.independent_reviewers` is `true`, meaning every target pair has distinct reviewer IDs for all required reviewer slots.
- `assignment_protocol.complete` is `true`, meaning every valid human target-pair label binds to a generated `assignment_id` for the same pair and reviewer role, every required target-pair assignment slot is completed, and no assignment id is duplicated across labels.
- `review_form_protocol.complete` is `true`, meaning every valid human target-pair label records all six dimension scores for both sides, explicit `confidence`, and a `major_concerns` array.
- `comparison_protocol.complete` is `true`, meaning target-system blind pairs cover the current baseline, P0, P1, and at least one ablation comparator.
- `blinding_protocol.complete` is `true`, meaning reviewer-visible public artifacts are present, contain no system/model identifier fields, expose only `proposal` plus `evidence_export` payload fields, and keep the answer key private.
- `label_counts.valid_human_target_pair` is greater than zero.
- `target_preference_rate >= preference_threshold`.
- `inputs[]` includes SHA-256 hashes for `human_blind_cases` and `human_blind_labels`.
- `blind_review_artifacts[]` includes SHA-256 hashes for `human_blind_pack`, `human_blind_assignments`, `human_blind_answer_key`, and `human_blind_review_form_schema`.

Legacy aggregation files without `releaseReadiness`, input hashes, or blind-review artifact hashes are treated as incomplete by the release gate. Re-run `eval:human-blind` after collecting labels so the aggregation records the preflight checks, label provenance, and blind-material provenance.
