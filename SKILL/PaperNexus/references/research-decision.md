# Experimental feedback and next actions

Feature-detect `research_decision` before using it. Read the advertised operation schema. Its contract is `papernexus-research-decision-v1`; older servers may expose only the original research workflows.

Use one project ID per research decision scope. Initialize the objective, goal phase and resource budget. Register competing hypotheses and their observable predictions, then concrete actions with controls, protocol, precision, estimated cost, analysis/stopping rules and outcome branches. Missing details remain draft. Retain exact immutable versions and registration receipts.

Call `recommend_next` to select the next bounded action. It can instead ask to assess a completed result, await a running attempt, reconcile unknown state, supply a missing input or stop. Read gates and alternatives. The recommendation does not authorize execution or advance AutoResearch state.

External executors return native attempt identities, cumulative costs, protocol and raw artifact references via `record_run`. For measured runs, stage a readable JSON manifest on the server and retain its source version. A correction supersedes a prior record; independent seeds or restarts have distinct attempt IDs. Never turn missing cost into zero or discard failed-run usage.

Use `assess_results` only for saved records and exact hypothesis versions. Keep paper reports, reproduced baselines, matched reproductions, synthetic fixtures and inference separate. Check baseline shortfalls, protocol alignment, uncertainty calculations, independent units, multiplicity and registration timing. Retrospective results cannot become prospective by registering a prediction later. Correct implementation with a failed mediator prediction is negative evidence, not an implementation failure.

`refresh_evidence` rechecks saved dependencies and existing controller candidates. It does not discover/import papers or launch jobs. Parked opportunities retain coverage, reasons and revisit conditions. `recommend_next` and `assess_results` also detect live dependency changes; status/export are stored views.

Every mutation uses a stable requestId and expectedRevision. On timeout, read `status(requestId)` before retrying the exact request. Summary read_more is read-only. `export` returns JSON/Markdown and writes only when outputDir is explicit; that path belongs to the server.

Use `scripts/pn_research_decision.py --request-file request.json --json` with the shared remote configuration. It sends once and never retries a mutation automatically. Full contract and examples: `docs/interfaces/research-decision.md` and `docs/operations/research-decision-loop.md` in the repository.
