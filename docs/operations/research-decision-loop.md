# Operate a research decision loop

Use `research_decision` after literature reading has produced concrete competing explanations. PaperNexus maintains decision evidence and budget accounting. AutoResearch or another executor owns submissions, raw measurements, project phases and scientific acceptance gates.

## Complete local example

Run the frozen synthetic examples in a fresh output directory:

```sh
node scripts/evaluate-research-decisions.mjs --seed 17 --output /tmp/papernexus-decision-evaluation
```

The command records full requests and responses, exported state, a machine-readable evaluation and a Markdown report. It covers a category-discovery example and a retrieval example using separate quantities. Outcomes are revealed only after the first action is selected. The baseline is an explicitly frozen candidate-priority ranking, not a measured run of the legacy controller.

Both explanations predict headline improvement, so the matched control is the useful first action. Precise negative evidence selects a replication of the remaining explanation; a wide interval selects a precision follow-up. An observation outside both predictions retains an unmodeled explanation. These fixtures test decision behavior, not real novelty, GPU savings or research success.

The full error and recovery acceptance suite is:

```sh
node --test test/research-decision-*.test.js test/mcp-research-decision.test.js
```

## AutoResearch handoff

1. Feature-detect `research_decision` and retain its contract version. Choose a PaperNexus project ID linked to the actual AutoResearch unit and corpus. Initialize an explicit total budget and optional exploration cap.
2. Register hypotheses, predictions and complete action versions before starting prospective experiments. Retain registration request receipts beside the executor plan.
3. Call `recommend_next`. Read its scientific and budget gates. A recommendation does not advance an AutoResearch stage or authorize a job.
4. Submit through the executor's existing approved path. Preserve its native run/attempt IDs, exact protocol, command, code source, manifest and raw metrics. Send a `queued` or `running` record with cumulative costs after acceptance.
5. On completion, submit a new source revision for the same attempt, referencing the previous record. Use `cost_final=true` only when cumulative costs are known. Failed and cancelled attempts still consume their actual budget.
6. Assess the saved results using exact hypothesis versions. Review any statistical calculation and provenance before marking it reviewed. Historical results remain retrospective.
7. Read the next recommendation and export JSON/Markdown. Keep AutoResearch claim promotion and project completion in its existing authority. Refresh dependencies after source or admission changes.

Use the canonical Python client for a configured HTTP server:

```sh
python3 SKILL/PaperNexus/scripts/pn_research_decision.py \
  --request-file /absolute/local/request.json --json
```

The wrapper reuses the shared connection/authentication settings and sends one request without automatic retries. The request file is local to the client. Run manifests and artifact paths inside it must be readable on the PaperNexus server. For local validation, a corpus metadata directory and the normal MCP server are sufficient; no production restart is implied.

## Common recovery paths

| Situation | Next action |
| --- | --- |
| Response lost after mutation | `status` with original requestId; retain the original payload and revision |
| Revision conflict | Read state, reconcile the new fact, then prepare a new request |
| Unknown job state | Query the executor and update that attempt; do not resubmit blindly |
| Missing or mismatched protocol | Repair the specific provenance or register a new action; do not reinterpret failure as a hypothesis rejection |
| Source changed or quarantined | `refresh_evidence`, inspect stale assessments, then reassess supported current records |
| Missing final cost | Reconcile cumulative usage; the uncertain balance is not free capacity |
| Corrupt state | Preserve the damaged file and restore a known project backup; do not initialize over it |
| Export failed | Read/export again to a writable directory; state is already committed |

Back up the project overlay as a unit when no writer holds its lock. Do not edit JSON state to override assessments or budget. Rolling back server code does not require migrating the old controller; older versions simply cannot operate the new decision file. Reconnect clients to refresh tool discovery after any deployment.

## Validation boundaries

Synthetic acceptance demonstrates the interface, recovery and deterministic decision rules. Real executor validation must separately record protocol alignment, outcome provenance, statistical limits, actual costs and the action chosen after feedback. Paper comparisons need verified paper-reported numbers under comparable conditions. A gain over an internal reproduction alone is insufficient.

The first version uses externally calculated intervals and declared analysis plans. It does not independently reconstruct arbitrary statistics, certify causal mechanisms, search exhaustively for all explanations, or prevent oversubscription outside the executor. Deterministic recommendations remain bounded by the registered alternatives and inputs.
