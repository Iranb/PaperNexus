# Counterfactual Search

`papernexus-counterfactual-search-v1` is the bounded offline falsification-planning contract for idea-catalyst innovation artifacts.

The current implementation is deterministic and local. It expands candidate perturbations from contribution claims, must-cite or supporting papers, target-domain challenges, source-domain takeaways, reviewer concerns, metrics, and time-cutoff signals. It then reranks candidates under an explicit budget and returns the selected plans through the existing `counterfactuals` / `falsification_plans` array fields.

This is not a release-grade Tree-of-Thought or online model-search engine. It is the contract and offline search substrate needed to make the report's P2 counterfactual lane measurable without adding default online latency.

## Output Contract

Each selected plan preserves the previous public fields:

- `falsification_plan_id`
- `claim_id`
- `question`
- `required_evidence`
- `status`

It also adds search metadata:

- `search_contract_version: "papernexus-counterfactual-search-v1"`
- `search_mode: "bounded_offline"`
- `candidate_id`
- `perturbation_type`
- `rank`
- `score`
- `anchor`
- `search_trace`
- `discard_reasons`

Supported perturbation types are:

- `baseline_swap`: test whether the idea still holds when a must-cite or supporting baseline is stronger.
- `assumption_stress`: test whether the source-to-target transfer assumption fails.
- `dataset_shift`: test whether the claim survives a harder target-domain deployment slice.
- `metric_shift`: test whether the idea remains useful under a stricter or secondary metric.
- `temporal_cutoff`: test whether novelty and grounding survive a declared time cutoff.

## Budgets

`counterfactualBudget` controls how many falsification plans are selected. The selected budget is capped at `10`.

`counterfactualSearchBudget` controls how many candidates are expanded and evaluated before rerank. The search budget is capped at `50`. When not provided, it defaults to a small multiple of `counterfactualBudget`.

`counterfactualSearchMode: "off"` disables the lane and returns an empty array.

## Release Boundary

The lane is useful for structural ablation and falsification-plan coverage, but it is still incomplete as P2 release evidence until at least one stronger search backend is evaluated:

- ToT or model-assisted candidate expansion with bounded cost.
- Historical replay evidence showing selected counterfactual plans expose real failure modes.
- Ablation evidence showing `without_counterfactual_planner` changes the relevant release gates.
- Human or benchmark labels for plan usefulness, specificity, and evidence grounding.

Until those artifacts exist, release-gate manifests should treat this lane as a bounded offline contract, not as proof that PaperNexus has solved counterfactual hypothesis search.

For release gating, wrap ToT/model-assisted counterfactual usefulness output with `npm run eval:innovation-sidecar-release-evidence`. The main Idea-Catalyst release gate records this as `R6` and rejects bounded offline deterministic output unless a separate model-assisted report provides candidates, selected plans, usefulness labels/score, source/license metadata, input hashes, and non-fixture provenance.
