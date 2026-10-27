# Experimental feedback and next actions

Feature-detect `research_decision` before using it. Read the advertised operation schema. Its contract is `papernexus-research-decision-v1`; older servers may expose only the original research workflows.

Use one project ID per research decision scope. Initialize the objective, goal phase and resource budget. Register competing hypotheses and their observable predictions, then concrete actions with controls, protocol, precision, estimated cost, analysis/stopping rules and outcome branches. Missing details remain draft. Retain exact immutable versions and registration receipts.

Call `recommend_next` to select the next bounded action. It can instead return `reuse_evidence` for an equivalent assessed design, or ask to assess a completed result, await a running attempt, reconcile unknown state, supply a missing input or stop. Read gates and alternatives. The recommendation does not authorize execution or advance AutoResearch state.

External executors return native attempt identities, cumulative costs, protocol and raw artifact references via `record_run`. For measured runs, stage a readable JSON manifest on the server and retain its source version. A correction supersedes a prior record; independent seeds or restarts have distinct attempt IDs. Never turn missing cost into zero or discard failed-run usage.

Use `assess_results` only for saved records and exact hypothesis versions. Keep paper reports, reproduced baselines, matched reproductions, synthetic fixtures and inference separate. Check baseline shortfalls, protocol alignment, uncertainty calculations, independent units, multiplicity and registration timing. Retrospective results cannot become prospective by registering a prediction later. Correct implementation with a failed mediator prediction is negative evidence, not an implementation failure.

`refresh_evidence` rechecks saved dependencies and existing controller candidates. It does not discover/import papers or launch jobs. Parked opportunities retain coverage, reasons and revisit conditions. `recommend_next` and `assess_results` also detect live dependency changes. `status` is a stored view; export and `evidence_view` check live freshness without refreshing state.

Use `evidence_view` with project and optional query, limit (1–50) and includeHistory to retrieve prior runs, predictions, comparisons and mechanism paths. Pass project to `idea_generation/generate` to use saved feedback. Explicitly linked candidates receive scoped assessments; unrelated candidates remain unlinked.

For `idea_generation/evaluate`, default `purpose=novelty_audit` still needs query and candidateMechanism. Use `mechanism_diagnosis` or `performance_validation` with project, actionId and optional actionVersion to review a registered plan. `task_gate=ready_for_design` does not authorize execution and never establishes novelty.

Freeze original/control/paper references and primary/guardrail/diagnostic outcomes in action.evaluation_plan. Bind predictions and the analysis primary outcome to comparison_id. Each run.comparisons item retains its reference and measurements; it is not another physical run or another charge. Difference values are candidate minus reference with explicit value_unit and unit. A gain over a weaker control below the original baseline remains partial recovery.

Declare evidence_role=observation|proxy|target on predictions and evaluation outcomes. A primary proxy does not become a performance target. Use proxy_for to link a proxy to target prediction IDs in the same hypothesis. Inspect evidence_chain and research_gaps before interpreting a proxy result. A measured association or joint observation does not validate the link. Read performance_claim, not the aggregate comparison status, for target improvement or failure. Unspecified roles cannot establish performance claims; preserve historical records and register new versions when adding roles.

Separate planned max_interval_width from anticipated_interval_width and admitted basis_refs. Missing achievable precision can require a diagnostic; bounded exploration must be explicit. Fixed-model image intervals do not establish training-procedure stability. The latter requires actual independent run references and appropriate analysis.

Policy `discriminating-action-v4` requires a prediction's own `basis` (kind, quantitative rationale and evidence_refs) for confirmatory mechanism conclusions. `assumption` or missing grounds keep interval comparisons exploratory. A precision basis does not replace prediction grounds. Old assessments remain stored; current views can require reassessment.

Use `mechanism_analysis` and `mechanism_test` to inspect source-backed paths, observations and concrete gaps. Bind actual graph IDs when known; retain link evidence status. Declare required_controls on links and controlled_components/check on actions. The check must appear in validity_checks and pass in the external run. These paths are proposed explanations, not causal proof.

Use information_targets to bind a diagnostic to a particular prediction_basis, precision, path, control, proxy_bridge or target_measurement gap at an exact hypothesis version. A proxy_bridge names a proxy with declared proxy_for links; target_measurement names a target prediction. Only matching current gaps receive priority. `reuse_evidence` points to current equivalent results; `replicate` remains independent. Full request examples are in `examples/mechanism-selection/`.

Code observations use code_inspected and saved versioned artifacts. Mechanism paths retain code_observed, measured_association and hypothesized status; compound interventions remain explicit. Paper graph_readiness distinguishes readable sources, nodes and source-anchored relations. Use the returned existing import/task handoff only when that operation is authorized.

Every mutation uses a stable requestId and expectedRevision. On timeout, read `status(requestId)` before retrying the exact request. Summary read_more is read-only. `export` returns JSON/Markdown and writes only when outputDir is explicit; that path belongs to the server.

Use `scripts/pn_research_decision.py --request-file request.json --json` with the shared remote configuration. It sends once and never retries a mutation automatically. Full contract and examples: `docs/interfaces/research-decision.md` and `docs/operations/research-decision-loop.md` in the repository.
