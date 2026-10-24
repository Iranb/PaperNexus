# Research decision contract

`research_decision` records competing explanations, selects a concrete next action and reassesses that choice after an external result. Its contract is `papernexus-research-decision-v1`. The default `research` profile advertises four tools; `legacy` retains 23 and `all` exposes 27. Reconnect clients after upgrading. The original three workflow schemas remain unchanged.

## Requests and operations

Every request has `operation`, `project`, optional `corpus`, and `responseMode=full|summary` (default `full`). Outer fields use camelCase; entity fields inside `payload` use snake_case. Unknown fields are rejected. Mutations require a stable `requestId` and `expectedRevision`; only the first `init` can omit the revision. `dryRun=true` validates the operation without creating state directories or report files.

| Operation | Payload or selector | Effect |
| --- | --- | --- |
| `init` | `{objective, goal_phase, budget, exploration_limit?}` | Create a project; an existing project is never reset |
| `status` | Optional `requestId` or `entityId` | Read state or the original committed receipt |
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

Evidence origins are `paper_reported`, `external_measured`, `agent_inferred`, `search_absence`, and `synthetic_fixture`. Each reference contains `source_id`, `source_version`, `locator`, and the applicable `paper_id`/`source_key` or server-local `artifact_path`. Paper references require the selected source key as their version and use existing admission rules. Agent inference and search absence cannot independently support an experimental conclusion.

## External runs

A run has `record_id`, `executor_id`, `run_id`, `attempt_id`, increasing `source_revision`, status, action ID/version and evidence origin. It also carries protocol, analysis, measurements, operational checks, baseline/comparison information, cumulative actual cost and artifact references. A state update for one attempt reuses its identity. A restart or independent replication uses a new attempt.

For `external_measured`, `manifest_path` points to a server-readable JSON file containing either the run object or `{ "run": ... }`. Verification compares the submitted fields to this manifest and checks referenced local artifacts. The executor owns the source record. Copying a declaration into a manifest does not independently certify scientific or statistical correctness.

`registration_receipt` references the action registration request. A verifiable executor start after that registration establishes `registered_before_run`; an earlier start is retrospective and missing provenance remains unknown. Plan versions cannot be overwritten. A later correction uses a new record and `supersedes_record_id`; older source revisions never replace the latest cumulative cost or current assessment basis.

Measurements contain `quantity`, `unit`, `estimate`, an interval and its uncertainty metadata: method, level, independent unit/count, calculation reference and review status/reference. Confirmatory exclusion requires a reviewed method, adequate precision, a necessary prediction, matched protocol, valid implementation, verified provenance, prospective registration and a matching fixed-final or adjusted analysis plan. Uncontrolled multiple looks or post-hoc selection remain exploratory.

## Results and decisions

Responses include `contractVersion`, `tool`, `operation`, `project`, `revision`, `result`, `effect`, `evidenceBoundary` and `nextActions`. Scientific insufficiency is a business result, while invalid inputs and state conflicts remain errors. Stable error codes include `invalid_input`, `invalid_reference`, `revision_conflict`, `request_conflict`, `state_corrupt`, `unsupported_version` and `stale_dependencies`.

An interval inside a prediction is compatible; a disjoint interval is inconsistent; partial overlap is inconclusive. Support requires distinguishing a specific competing explanation. Exclusion applies only to the registered necessary prediction and scope. Conflicting valid results remain conflicted. Failed execution is diagnostic evidence; correctly applied intervention with a failed mediator prediction can weaken the mechanism. Explanations need not be exhaustive or mutually exclusive.

Comparisons retain `vs paper-reported baseline`, `vs reproduced baseline`, or `vs matched reproduced baseline`. The matched label requires declared protocol verification and verified run provenance. Without a verified paper source and protocol the response says `paper-report comparison not established`. Baseline shortfalls remain visible.

`decision.kind` is `execute_action`, `assess_results`, `await_run`, `reconcile_run`, `needs_input` or `stop`. An unfinished attempt is reconciled before another submission. A completed result is assessed before new experimentation. Feasible actions are compared by relevant prerequisites, differing predictions, achievable precision and resource bounds. Alternatives remain visible where tradeoffs are unresolved. No success probability is invented.

Recommendations identify `based_on_revision` and a structured `recommendation_ref`. Reading a recommendation reserves no budget. An executor can return that reference with its accepted run to preserve the decision snapshot. It still performs its own authorization, concurrency and budget checks.

## Evidence freshness and opportunities

`recommend_next` and `assess_results` recheck their actual evidence dependencies. Changed versions or admission produce stale dependencies and a refresh requirement. Refresh invalidates dependent assessments and can revisit parked opportunities after new admitted evidence, resolved dependencies, weakened competing hypotheses or changed resources. It never starts providers, imports papers or launches experiments. Existing controller candidate coverage and original records are retained.

Opportunity lifecycle (`active`, `parked`, `retired`) is distinct from scientific status. Repeated refresh with unchanged conditions does not repeatedly reactivate candidates. Exploration must have an explicit cap and still fit the total budget.

## Persistence and recovery

The project overlay's `research-decision-state.json` is the authority for this tool. The existing file lock and atomic replacement commit state and request receipt together. The old controller, evidence cart, workflow state and external executor retain their own responsibilities.

After a timeout, call `status` with the original requestId. If committed, use that receipt; if absent, reconcile the transport and retry the exact request. Reusing a request ID with changed contents is an error. On revision conflict, read current state and make a new decision before using a new request ID. Never automatically replay a mutation merely to expand a summary.

Summary responses preserve bounded gates and use read-only status/export links. When a gate cannot fit, retrieve full output before deciding. `status` and `export` show stored evidence snapshots and current validity against local state; they do not themselves perform a live evidence refresh. An export write failure returns `export_pending` without undoing committed state. `outputDir` belongs to the server filesystem.

See the [end-to-end operating guide](../operations/research-decision-loop.md) for the runnable fixture, AutoResearch handoff and recovery checks.
