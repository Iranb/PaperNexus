# PaperNexus Research Controller Skill Contract

This document is the draft Skill recipe for external Agents that consume the
PaperNexus research-controller workflow through MCP.

## When To Use

Use this workflow when a user gives a research task and wants structured help
for problem decomposition, method-candidate exploration, bounded ideation, and
innovation-brief construction.

Do not use it as an experiment runner, paper importer, code editor, or final
research-direction selector.

## MCP Entry Point

Call the existing Agent Materials tool:

```json
{
  "operation": "research_controller",
  "action": "run_round",
  "mode": "planning",
  "corpus": "GCD",
  "project": "gcd-research-controller",
  "targetDomain": "Generalized Category Discovery",
  "targetProblem": "known-class bias, class-count estimation, confidence calibration, and pseudo-label generation"
}
```

The runtime authority is MCP plus project overlay state. The Skill is only a
usage protocol.

If `project` is omitted, GCD tasks default to `gcd-research-controller`; other
research-controller tasks default to `research-controller`. Passing an explicit
project is still recommended for repeatable cross-Agent handoff.

## Modes

- `quick`: graph-only scouting and export. No provider calls or imports.
- `planning`: default research-design pass.
- `deep`: evidence expansion for selected candidates only, with explicit opt-in
  for provider evidence, live discovery, literature discovery, or imports.

For GCD tasks, the controller writes an explicit `gcd_mvp_*` budget profile into
`controller-state.json`, response summaries, and `controller-export.json`.
Provider queries and imports remain `0` unless the caller supplies an explicit
budget and opt-in policy.

Configured controller LLM calls are also disabled by default. To let the
controller call one configured network model instead of only external payloads
or a local `llmJson` hook, pass a positive `max_provider_queries` budget and:

```json
{
  "providerPolicy": {
    "enable_controller_llm": true,
    "controller_llm": {
      "provider": "openai_compatible",
      "model": "model-name",
      "base_url": "https://example.com/v1",
      "api_key_env": "PAPERNEXUS_CONTROLLER_LLM_API_KEY"
    }
  }
}
```

The configured provider is tried after external payloads and `llmJson`, before
the deterministic controller fallback. It returns structured JSON evidence only;
it still cannot directly move candidate lifecycle state.

For non-GCD tasks, the controller classifies the request into conservative task
families when possible: `domain_adaptation`, `clustering`,
`computer_vision`, `nlp`, `retrieval`, or `generic`. These families only set
offline budget profile names, design-boundary defaults, and initial subproblem
seeds. They do not enable provider calls, imports, experiments, or raw graph
mutation.

## Required Sequence

1. Normalize the user request into `targetDomain`, `targetProblem`,
   constraints, and any known evaluation protocol.
2. Call `action=status`.
3. If no controller state exists, call `action=init_task` or `action=run_round`.
4. If using manual steps, call `action=generate_decomposition` before candidate
   generation. External systems may submit `externalInputs.decomposition_payload`;
   local harnesses may provide a single-model `llmJson` hook. If explicitly
   enabled, the controller can then call the configured single-model provider.
5. Call `action=review_decomposition` before treating the decomposition as a
   search plan. External systems may submit
   `externalInputs.decomposition_review_payload`.
6. Call `action=generate_candidates`, then
   `action=propose_edges`. Candidate generation writes `search-trace.json`
   with MVP `IdeaSearchState` records, per-depth expansion/pruning counts,
   finalized state ids, and requisitioned weak-evidence state ids. Treat this
   as an audit trace for how graph hits became candidates, not as a novelty
   proof.
7. Call `action=judge_batch` when candidate nodes and relations are ready.
   External systems may submit `externalInputs.judge_payload`; local harnesses
   may provide a single-model `llmJson` hook; if explicitly enabled, the same
   configured provider can judge the batch. Set `judgeConsistencyChecks` to a
   small integer when the Agent should run an order-swap probe; probe decisions
   are stored under consistency-probe scopes and do not drive selection. The
   judge payload may include `pairwise_preferences`; these are stored as
   evidence and aggregated with a Bradley-Terry-compatible controller score
   during selection.
8. Call `action=select_batch` to produce bounded `selected-subgraphs.json`.
   Selection uses a greedy submodular marginal-gain objective over controller
   utility, subproblem/mechanism/source-domain/challenge-aspect/evidence-cluster
   coverage, and positive/negative candidate-edge relations. Read
   `selection-trace.json` before explaining why a batch was chosen: it contains
   top-k, MMR, and greedy-submodular selector traces over the same eligible
   pool. Also read `bandit-simulation.json` when planning future exploration;
   it is an offline UCB/Thompson proxy over source-domain and mechanism arms,
   not a human novelty or experiment score.
   For manuscript-table preparation, read `icml-main-table.json` or
   `icml-main-table.md` after export or GCD validation. These files compare
   beam graph search, top-k, MMR, and greedy submodular traces using
   artifact-derived proxy metrics for evidence pass, usable idea rate,
   unsupported bridge claims, diversity, and follow-up cost. They are table
   scaffolds, not novelty, correctness, or empirical-performance evidence.
   Read `selection_policy.batch_objective` and each selected subgraph's
   `marginal_gain` before explaining why a batch was chosen.
   Also read `selection_policy.posterior_update` and `controller-state.json`
   `posterior`: the MVP keeps a Beta-Bernoulli dueling posterior over
   candidate pairwise preferences, including posterior mean, uncertainty, and
   an exploration index. Treat this as a controller exploration signal, not as
   proof that a method will work.
9. Call `action=expand_evidence` to produce selected-only
   `method-card-pack.md`. This uses graph/material refs and local paper spans
   only by default, and adds heuristic `paper_material_extraction` fields for
   input/output signals, objectives, inference behavior, assumptions, adaptable
   components, and cost terms when the local source text supports them. It emits
   planned `material_expansion_requests` for
   `research_material_pack`, `negative_evidence_pack`, and
   `import_requisition_pack`. These requests are not auto-executed;
   controller-side or external execution may consume them only after checking
   `approval_required`, `execution_status`, requested opt-ins, and the disabled
   provider/import flags.
10. If an external Agent executes approved material requests, call
   `action=execute_material_requests` only after explicit human approval with
   `approveMaterialRequestExecution=true` and, preferably,
   `approvedMaterialRequestIds`. By default this executes only safe local
   `research_material_pack`, `negative_evidence_pack`, or
   `import_requisition_pack` requests and records the results in
   `material-expansion-results.jsonl`. If the reviewed request explicitly
   asked for provider/live/literature evidence opt-ins, pass
   `allowProviderMaterialOptIns=true` or equivalent granular approval metadata.
   If the reviewed request explicitly asked for import submission or processing,
   pass `allowImportSubmission=true` and/or `allowImportProcessing=true`.
   Without those separate flags, opt-in requests are skipped rather than run.
11. If an external Agent executes material requests outside the controller, call
   `action=record_material_results` with
   `externalInputs.material_expansion_results`. This records results in
   `material-expansion-results.jsonl` and updates matching selected-candidate
   material request statuses. The same result channel can record approved
   `closest_prior_expansion_requests` after design review; matched design
   reviews receive `closest_prior_result_ids` and recorded request statuses. It
   also refreshes the post-evidence decomposition drift review when result
   text indicates missing subproblems, task-framing, protocol, or metric
   mismatch. It still does not mutate the raw corpus graph or submit imports.
12. Call `action=compose_solutions` to produce `solution-sketches.jsonl` and
   `solution-sketches.md` from selected subgraphs. External systems may submit
   `externalInputs.solution_payload`; local harnesses may provide a
   single-model `llmJson` hook or explicit configured-provider opt-in.
   Agent-composed sketches must keep
   evidence-supported / agent-inferred / speculative boundaries.
13. Call `action=design_review` before treating any solution sketch as a
   user-facing recommendation candidate. External systems may submit
   `externalInputs.design_review_payload`; local harnesses may provide a
   single-model `llmJson` hook or explicit configured-provider opt-in. The
   controller also attaches graph-grounded
   `closest_prior_evidence` from candidate edges and candidate overlap when
   available. Reviews remain evidence only and do not make a sketch final,
   novel, or execution-ready. If deeper closest-prior checks are needed, read
   `closest_prior_expansion_requests`; these are planned requests only and use
   disabled provider/literature flags until a separate approval path executes
   them. Also inspect `decomposition_drift_review`; if it requires revisit,
   run `review_decomposition` or regenerate decomposition before promoting a
   sketch or planning experiments.
14. Call `action=compose_innovation_briefs` to produce
   `innovation-briefs.json` and `innovation-briefs.md`. These are bounded
   downstream ideation seeds built from selected subgraphs, solution sketches,
   design reviews, method cards, and candidate relations. They preserve
   evidence-supported / agent-inferred / speculative boundaries and remain
   human-review artifacts, not final research directions.
15. Only after explicit human approval, call `action=generate_experiment_plan`
   with `approveExperimentPlanning=true` and approval metadata. This writes
   `experiment-plan.json` and `experiment-plan.md` as plan-only artifacts. It
   does not run training, submit jobs, mutate the raw graph, import papers, or
   make a final result claim.
16. Call `action=export`.
17. For GCD MVP closure, call `action=validate_gcd_mvp`. This writes
   `gcd-mvp-validation.json` and `gcd-mvp-validation.md`, checks local overlay
   artifact coverage such as 30+ candidates across 5+ subproblems, and keeps
   remote MCP smoke validation separate. It is complete only after the action is
   successfully run through the MCP tool surface exposed by `papernexus-remote`.
18. Call `action=export` again if downstream Agents need the validation report
   included in `controller-export.json`. Export also refreshes
   `icml-main-table.json` and `icml-main-table.md` from the current controller
   artifacts.
19. Read `controller-export.json` first. Use `controller-export.md` only for
   human-facing synthesis.
20. Generate or revise downstream innovation briefs from selected subgraphs and evidence
   boundaries, not from unsupported free-form brainstorming.

## Hard Rules

- Do not mutate the raw corpus graph.
- Do not directly mutate candidate lifecycle state outside
  `controller-state.json`.
- Do not claim novelty, feasibility, or evidence support unless the export
  bundle labels it as evidence-supported.
- Do not promote far-source candidates unless they have either adequate
  mechanism fit or explicit bridge evidence; otherwise keep them in
  `needs_evidence`.
- Do not enable provider evidence, literature discovery imports, real
  experiments, code edits, or final direction selection without explicit human
  approval.
- Do not execute `material_expansion_requests` until the request status,
  approval requirement, and safe discovery/import flags are reviewed.
- Do not call `execute_material_requests` without
  `approveMaterialRequestExecution=true`. This approval alone is not permission
  to turn on provider calls, live/literature discovery, downloads, imports, or
  training. Provider/live/literature evidence requires
  `allowProviderMaterialOptIns=true` or granular approval metadata; import
  submission/processing requires `allowImportSubmission=true` and/or
  `allowImportProcessing=true`.
- Do not execute `closest_prior_expansion_requests` directly from the design
  review artifact. They are opt-in requests with provider/literature discovery
  disabled in their arguments until a separate approved workflow turns them on.
  If another approved Agent executes one, return the result through
  `record_material_results`; do not edit `design-review.json` by hand.
- Do not present solution sketches as final research directions.
- Do not ignore `post_evidence_drift_review` or
  `decomposition_drift_review`. If either requires revisit, treat current
  sketches and briefs as blocked on decomposition review.
- Do not present innovation briefs as final research directions. They are
  bounded ideation seeds for human review.
- Do not treat `closest_prior_evidence` as a novelty proof. It is an overlap
  and risk signal for comparison, not a claim that the idea is new.
- Do not treat `experiment-plan.json` or `experiment-plan.md` as permission to
  run an experiment. Experiment plans are design artifacts and still require a
  separate approved execution workflow before any training, job submission,
  import, or graph mutation.
- Do not treat `gcd-mvp-validation.json` as remote smoke evidence unless its
  `remote_mcp_smoke` criterion is `pass`. Direct/local function calls stay
  blocked; MCP tool calls record an invocation marker, and caller-supplied
  remote-validation metadata must remain auditable.

## Innovation Brief Schema

```yaml
idea_id:
title:
target_subproblems:
source_candidate_ids:
source_edge_ids:
core_mechanism:
proposed_method:
why_not_trivial:
what_is_evidence_supported:
what_is_agent_inferred:
what_is_speculative:
expected_gain:
evaluation_plan:
ablation_plan:
discard_conditions:
main_risks:
missing_materials:
next_action:
```

## Current Implementation Status

The current implementation provides controller initialization, status,
LLM/external/configured-provider/fallback task-spec and decomposition generation,
external/configured-provider/fallback decomposition review, graph-only candidate
generation with auditable `search-trace.json` / `IdeaSearchState` records,
heuristic blocked
candidate-edge proposal with complement/substitute/shared-mechanism/shared-failure
plus conservative prerequisite/conflict/cost-coupled signals, single-model hook,
configured-provider, or externally submitted judge-batch evidence, optional
order-swap self-consistency
probes, Bradley-Terry-compatible pairwise preference aggregation, greedy batch
selection with a submodular marginal-gain objective, Beta-Bernoulli dueling
posterior state for pairwise preference exploration, explicit GCD MVP budget
profiles and `mvp_contract` metadata, selector ablation traces for top-k,
MMR, and greedy submodular selection,
offline source-domain/mechanism UCB/Thompson proxy simulation,
profiles for quick/planning/deep modes, conservative non-GCD task-family
defaults for design boundaries and initial subproblem seeds, far-source bridge gating,
selected-only graph/material evidence expansion, method-card pack generation
with local paper-span extraction for method-card signals/objectives/cost terms,
planned selected-candidate material expansion requests for deeper
`agent_materials` operations, external material-result recording back into
controller overlay state, approval-gated material request execution with
separate provider/live/literature/import opt-in allow flags, deterministic or Agent-assisted solution-sketch composition,
structured static or Agent-assisted design review with
graph-grounded closest-prior evidence, planned closest-prior expansion requests,
and external closest-prior result recording back into design-review artifacts,
post-evidence decomposition drift surfacing from design reviews and material
results,
bounded innovation brief generation from selected subgraphs and design reviews,
plan-only experiment-plan generation after explicit approval, export,
GCD MVP validation/retrospective report generation through `validate_gcd_mvp`
with direct-call blocking and MCP invocation detection, and a
safe `run_round` path. In
`quick` mode `run_round` refreshes and reviews decomposition when needed, then
stops after graph candidates and relations; in default `planning` mode it also
runs judge evidence, selection, selected method-card expansion, solution
composition, design review, and innovation brief composition before export.
`generate_experiment_plan` is not called by `run_round`; it must be invoked
separately after approval. Solution sketches, innovation briefs, and experiment
plans remain user decision artifacts and are not final research directions or
executable run instructions. `validate_gcd_mvp` can be called at any time after
initialization, but a passing local report is still not a substitute for a
successful MCP-smoke criterion in `gcd-mvp-validation.json`.
