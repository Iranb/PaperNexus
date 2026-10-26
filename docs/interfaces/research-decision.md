# Research decision contract

`research_decision` records competing explanations, selects a concrete next action and reassesses that choice after an external result. Its contract is `papernexus-research-decision-v1`. The default `research` profile advertises four tools; `legacy` retains 23 and `all` exposes 27. Reconnect clients after upgrading and feature-detect optional operations and evaluation purposes.

## Requests and operations

Every request has `operation`, `project`, optional `corpus`, and `responseMode=full|summary` (default `full`). Outer fields use camelCase; entity fields inside `payload` use snake_case. Unknown fields are rejected. Mutations require a stable `requestId` and `expectedRevision`; only the first `init` can omit the revision. `dryRun=true` validates the operation without creating state directories or report files.

| Operation | Payload or selector | Effect |
| --- | --- | --- |
| `init` | `{objective, goal_phase, budget, exploration_limit?}` | Create a project; an existing project is never reset |
| `status` | Optional `requestId` or `entityId` | Read state or the original committed receipt |
| `evidence_view` | Optional `query`, `limit` (default 10, maximum 50), `includeHistory` | Read a project evidence projection and live dependency freshness |
| `register_hypotheses` | `{hypotheses:[...]}` | Append immutable hypothesis and prediction versions |
| `register_actions` | `{actions:[...]}` | Append plans; submit no jobs |
| `record_run` | `{run:{...}}` | Accept cumulative external attempt facts and cost |
| `assess_results` | `{run_record_ids, hypothesis_versions, analysis_annotations?}` | Save a scoped assessment |
| `recommend_next` | Optional `{action_ids:[...]}` | Read one next action or a specific blocking step |
| `update_opportunities` | `{changes:[...]}` | Park, reactivate, retire, set conditions, budget or goal |
| `refresh_evidence` | Optional `{source_refs, candidate_refs}` | Recheck local evidence and import existing controller candidates |
| `export` | Optional `assessmentId`, `outputDir` | Return JSON and Markdown; write only with explicit outputDir |

The generated [MCP reference](../reference/generated/mcp-tools.md) contains the complete schema. Start a project with:

```json
{
  "operation": "init",
  "corpus": "my-corpus",
  "project": "selection-mechanism",
  "requestId": "selection-init-1",
  "payload": {
    "objective": "Distinguish quality filtering from sample-count effects.",
    "goal_phase": "mechanism_validation",
    "budget": {"gpu_hours": [{"resource": "V100", "limit": 6}], "provider_calls": {"limit": 0}},
    "exploration_limit": {"max_actions": 1, "gpu_hours": [{"resource": "V100", "limit": 1}]}
  }
}
```

GPU hours mean GPU count multiplied by elapsed hours. Resource identities and currencies remain separate. Missing cost is unknown; it is never silently zero. A zero-cost action must explicitly report zero for each constrained resource. Estimates use `{lower?, upper}`; actual cost uses cumulative `amount`, while budgets use `limit`. Resource keys must be unique.

## Scientific entities

A hypothesis has `hypothesis_id`, consecutive `version`, `statement`, `mechanism`, `scope`, `intervention`, `control`, `evidence_refs`, `alternative_hypothesis_ids`, `predictions`, and an optional `falsification_rule`. Incomplete hypotheses are saved as `draft`. A prediction names a quantity and unit, a threshold or interval, a minimum meaningful effect and optional protocol conditions. Necessary prediction IDs must belong to that hypothesis.

Actions bind exact `hypothesis_versions` and `prediction_ids`. A recommendable experiment declares the intervention, what is held constant, measured quantities, protocol and required fields, operational validity checks, interval precision, estimated upper cost, analysis plan, stopping rule and result branches. The supported experiment types are `controlled_experiment`, `replicate` and `scale_test`; bounded reading, search, code inspection, profiling, baseline repair and diagnostic actions are also available. Missing design details remain explicit gaps.

`scope` and prediction conditions compare structured protocol fields. Relevant dataset/split, label access, model, preprocessing, training horizon, tuning budget, checkpoint rule, metric code, code revision, command and environment belong in the declared protocol. Independent unit and seed information must be retained with the source artifacts. Do not equate two experiments merely because their metric names match.

Evidence origins are `paper_reported`, `external_measured`, `code_inspected`, `agent_inferred`, `search_absence`, and `synthetic_fixture`. Each reference contains `source_id`, `source_version`, `locator`, and the applicable `paper_id`/`source_key` or server-local `artifact_path`. Paper references require the selected source key as their version and use existing admission rules. Agent inference and search absence cannot independently support an experimental conclusion.

`code_inspected` also requires `repository`, `code_revision`, `file_path` and `observation`. Its JSON artifact must contain those same fields. Verification is `code_artifact_present`, which establishes the availability of a saved static observation, not execution or causality. Optional `hypothesis.mechanism_evidence` contains typed components and links with `source_supported`, `code_observed`, `measured_association` or `hypothesized` status. Actions reference changed components through `intervention_components` and held or matched components through `controlled_components`. A control names its exact hypothesis version and an operational `check` registered in `validity_checks`. The same component cannot be both changed and held constant.

## Mechanism paths and prediction grounds

A prediction may carry `basis={kind,rationale,evidence_refs}`, where `kind` is `empirical`, `derivation` or `assumption`. The first two record the quantitative rationale for the interval or threshold and its sources. A source being readable or admitted does not independently validate that rationale. `prediction_basis.status` is `documented`, `assumed`, `missing` or `stale`; only a documented current basis permits mechanism support or exclusion. A precision estimate is not a prediction rationale. Older requests still parse, but unsupported quantitative predictions now produce `needs_input` for confirmatory experiments. Their observed interval relations remain visible without a mechanism winner.

A mechanism component may name `graph_node_id`; an observable may name both `quantity` and `unit`. Links may name `graph_relation_ids` and `required_controls`, which are local component IDs. Explicit graph references must exist in the cited current paper context. When both endpoints name graph nodes, the cited directed relations must connect them. Node names do not establish identity. Links retain their declared `source_supported`, `code_observed`, `measured_association` or `hypothesized` status after source verification.

`mechanism_analysis` connects exact hypothesis versions, sources, registered links, measurements, predictions and control requirements. It exposes per-prediction `paths`, basis status, scoped observations and `evidence_gaps`. `source_backed_hypothesis` describes a grounded proposed path, not an identified causal effect. Path search is bounded to six links, 24 paths and 256 expansions per prediction; `coverage.truncated` discloses incomplete search. Multiple explanations can remain compatible.

The action's `mechanism_test` reports selected paths, required controls, actual check status when a run is supplied, and concrete reason codes. `path_interventions` lists changed components on each path and other changed components in that hypothesis. Joint interventions do not identify individual component effects. An unmet control blocks confirmatory mechanism interpretation even when the observed interval fits a prediction. Bounded exploration can gather evidence while keeping these gaps explicit.

Diagnostic actions may declare `information_targets`: `{hypothesis_id,hypothesis_version,kind,prediction_id}` for `prediction_basis`, `precision` or `path`; use `component_id` instead for `control`. Only targets matching an actual current gap receive diagnostic priority. The returned `selection_basis` names the matched targets. A generic diagnostic name is insufficient.

`reuse_evidence` returns current completed records that already cover the same exact registered hypothesis versions, protocol, intervention, controls, measurements, precision and analysis rules. The analysis registration ID may differ; the analysis itself must match. The existing result must have a resolved confirmatory assessment. Incomplete, superseded, stale, inconclusive or differently scoped records do not qualify. `replicate` remains a request for independent evidence and is never replaced with reuse. Reuse is a read decision and reserves no resources.

Old saved assessments remain unchanged. Current views do not treat an old assessment without prediction grounds and mechanism checks as confirmation; they expose the observation with an inconclusive mechanism status and a reassessment requirement. Explicit source refresh and new hypothesis/action versions supply missing inputs. An assessment export preserves its raw rows and adds `current_policy_version` and `current_scientific_state`; Markdown reports the current interpretation. There is no automatic backfill of scientific grounds.

## Project evidence and task purposes

`evidence_view` projects existing state at `based_on_revision`; it does not create a graph database, initialize a missing project or change revision/cost. It returns observations, comparison summaries, open explanations, `mechanism_analysis`, registered mechanism paths, source readiness, evidence requests and nodes/edges. Query matching selects records without changing scientific conclusions. Coverage reports truncation; outstanding runs, budget and limitations remain visible regardless of the query.

`idea_generation/generate` accepts optional `project`. Its `project_evidence`, `mechanism_guidance` and `research_focus` cite saved runs, predictions and unresolved mechanism requirements. Candidates receive `project_assessment` through explicit candidate/source references. Candidates with no explicit connection remain `unlinked`; title similarity is not experiment identity.

`idea_generation/evaluate` accepts `purpose`:

| Purpose | Required input | Result |
| --- | --- | --- |
| `novelty_audit` (default) | `query`, `candidateMechanism` | Existing innovation evidence audit |
| `mechanism_diagnosis` | `project`, `actionId`; optional `actionVersion` | Registered intervention, control, predictions, validity and evidence gaps |
| `performance_validation` | Same registered action identity | Original baseline, primary target, guardrail, analysis and inference gaps |

Project purposes return `task_gate.status=ready_for_design|needs_input`, `novelty_claim_allowed=false` and a separate `performance_claim_status`. They do not accept candidate overrides or grant execution permission. Missing action versions remain explicit gaps. The default novelty audit retains its existing evidence requirements; lexical collision candidates do not establish semantic equivalence.

Paper material views expose `paper.graph_readiness`: readable source, admission, semantic node and source-anchored relation count. Status is `unavailable`, `source_only`, `node_only` or `anchored_relations`. The separate `mechanism_context` contains up to three hops and 48 semantic relations, with actual relation IDs, direction, paper identity, quotes, source paths and coverage. Corpus membership, cross-paper relations and unverified quotes cannot become source-anchored mechanism evidence. Changes to this context invalidate the dependent project snapshot. Missing semantics returns an existing task status or explicit staged-file import handoff; reads do not perform that import.

## Comparators and outcome vectors

An action's immutable `evaluation_plan` declares `comparators`, `outcomes` and `inference_target`. Comparators have `comparison_id`, `role=original|control|paper`, required protocol fields and a reference: `{kind:"run_record",record_id}` or `{kind:"external_manifest"|"paper_report",source_ref,protocol_locator,measurements_locator}`. External locators use JSON Pointer or dotted object paths in a readable structured extraction artifact. Reference snapshots retain source versions, protocol and absolute measurements.

Outcomes declare quantity, difference unit, direction, `role=primary|guardrail|diagnostic`, comparison IDs and a minimum effect or maximum regression. New runs use `comparisons[]`; they cannot also use legacy `baseline`/`comparison`. Each comparison repeats its registered reference and contains measurements. Top-level measurements remain available for observations independent of a comparator. Legacy single-comparison inputs remain accepted.

For a difference, `estimate=candidate_estimate-reference_estimate`. Absolute values share `value_unit`; the difference uses `unit`, such as `percent` and `pp`. The interval describes the difference. Units are not implicitly converted. Repeated comparison IDs, inconsistent absolute references and conflicting candidate estimates are rejected. Matched comparison labels require aligned candidate/reference protocol and resolved reference measurements.

Predictions bind `comparison_id`. A new analysis binds `primary_comparison_id` and `primary_outcome`; adjusted analysis lists the covered `(comparison_id,quantity)` pairs in `family` and supplies its adjustment reference. Another comparison with the same quantity is still secondary. Multiple comparisons remain one physical attempt with one cumulative cost. Corrections supersede the old record and invalidate dependent assessments.

Summary status is `not_assessed`, `inconclusive`, `tradeoff`, `partial_recovery` or `improved_in_scope`. A control gain below the original baseline remains partial recovery. Diagnostic gains cannot replace the primary target. Only valid prospective analysis with the original primary target and guards satisfied can establish improvement in scope. Every metric and limitation remains visible.

## Precision and inference

`precision.max_interval_width` is a planned threshold. `anticipated_interval_width` and admitted `basis_refs` provide a precision estimate. The policy `discriminating-action-v3` reports required, planned and anticipated widths separately. A controlled mechanism experiment without adequate evidence of achievable precision requests a bounded diagnostic or a revised measurement. Explicit bounded exploration remains available without a discrimination claim. Legacy inputs still parse; lacking precision evidence can now change the recommendation to `needs_input`.

Register `inference_target=fixed_model|training_procedure` on the evaluation plan or precision/prediction and on measurement uncertainty. Training-procedure inference requires distinct completed `independent_run_refs`, matching independent-unit counts and distinct recorded independence groups. Related epochs and repeated references do not count as independent training runs. These provenance checks do not replace an applicable uncertainty calculation or statistical review.

## External runs

A run has `record_id`, `executor_id`, `run_id`, `attempt_id`, increasing `source_revision`, status, action ID/version and evidence origin. It also carries protocol, analysis, measurements, operational checks, baseline/comparison information, cumulative actual cost and artifact references. A state update for one attempt reuses its identity. A restart or independent replication uses a new attempt.

For `external_measured`, `manifest_path` points to a server-readable JSON file containing either the run object or `{ "run": ... }`. Verification compares the submitted fields to this manifest and checks referenced local artifacts. The executor owns the source record. Copying a declaration into a manifest does not independently certify scientific or statistical correctness.

`registration_receipt` references the action registration request. A verifiable executor start after that registration establishes `registered_before_run`; an earlier start is retrospective and missing provenance remains unknown. Plan versions cannot be overwritten. A later correction uses a new record and `supersedes_record_id`; older source revisions never replace the latest cumulative cost or current assessment basis.

Measurements contain `quantity`, `unit`, `estimate`, an interval and its uncertainty metadata: method, level, independent unit/count, calculation reference and review status/reference. Confirmatory exclusion requires documented prediction grounds, a ready mechanism test with passed controls, a reviewed method, adequate precision, a necessary prediction, matched protocol, valid implementation, verified provenance, prospective registration and a matching fixed-final or adjusted analysis plan. Uncontrolled multiple looks or post-hoc selection remain exploratory.

## Results and decisions

Responses include `contractVersion`, `tool`, `operation`, `project`, `revision`, `result`, `effect`, `evidenceBoundary` and `nextActions`. Scientific insufficiency is a business result, while invalid inputs and state conflicts remain errors. Stable error codes include `invalid_input`, `invalid_reference`, `revision_conflict`, `request_conflict`, `state_corrupt`, `unsupported_version` and `stale_dependencies`.

An interval inside a prediction is compatible; a disjoint interval is inconsistent; partial overlap is inconclusive. Support requires distinguishing a specific competing explanation. Exclusion applies only to the registered necessary prediction and scope. Conflicting valid results remain conflicted. Failed execution is diagnostic evidence; correctly applied intervention with a failed mediator prediction can weaken the mechanism. Explanations need not be exhaustive or mutually exclusive.

Comparisons retain `vs paper-reported baseline`, `vs reproduced baseline`, or `vs matched reproduced baseline`. The matched label requires declared protocol verification and verified run provenance. Without a verified paper source and protocol the response says `paper-report comparison not established`. Baseline shortfalls remain visible.

`decision.kind` is `execute_action`, `reuse_evidence`, `assess_results`, `await_run`, `reconcile_run`, `needs_input` or `stop`. An unfinished attempt is reconciled before another submission. A completed result is assessed before new experimentation. Feasible actions are compared by relevant prerequisites, grounded differing predictions, mechanism controls, achievable precision and resource bounds. Different protocols, comparison identities, units or control requirements remain separate; costs are not converted into an invented utility. Alternatives remain visible where tradeoffs are unresolved. No success probability is invented.

Recommendations identify `based_on_revision` and a structured `recommendation_ref`. Reading a recommendation reserves no budget. An executor can return that reference with its accepted run to preserve the decision snapshot. It still performs its own authorization, concurrency and budget checks.

## Evidence freshness and opportunities

`recommend_next` and `assess_results` recheck their actual evidence dependencies. Changed versions or admission produce stale dependencies and a refresh requirement. Refresh invalidates dependent assessments and can revisit parked opportunities after new admitted evidence, resolved dependencies, weakened competing hypotheses or changed resources. It never starts providers, imports papers or launches experiments. Existing controller candidate coverage and original records are retained.

Opportunity lifecycle (`active`, `parked`, `retired`) is distinct from scientific status. Repeated refresh with unchanged conditions does not repeatedly reactivate candidates. Exploration must have an explicit cap and still fit the total budget.

## Persistence and recovery

The project overlay's `research-decision-state.json` is the authority for this tool. The existing file lock and atomic replacement commit state and request receipt together. The old controller, evidence cart, workflow state and external executor retain their own responsibilities.

After a timeout, call `status` with the original requestId. If committed, use that receipt; if absent, reconcile the transport and retry the exact request. Reusing a request ID with changed contents is an error. On revision conflict, read current state and make a new decision before using a new request ID. Never automatically replay a mutation merely to expand a summary.

Summary responses preserve bounded gates and use read-only expansion requests. Oversized gates are marked `read_full_required`. `status` shows stored snapshots; `evidence_view`, project evaluation and export check live dependency freshness without writing refreshed state. Mutation summaries expand through `status(requestId)`, and evidence views expand through `evidence_view`. An export write failure returns `export_pending` without undoing committed state. `outputDir` belongs to the server filesystem.

See the [end-to-end operating guide](../operations/research-decision-loop.md) for the runnable fixture, AutoResearch handoff and recovery checks.
