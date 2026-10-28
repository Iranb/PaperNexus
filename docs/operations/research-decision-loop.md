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

## Mechanism selection example

Run the mechanism behavior cases and measured historical replay locally:

```sh
node scripts/evaluate-mechanism-selection.mjs --output /tmp/pn-mechanism-selection
```

The output contains full input entities, source artifacts, per-case traces and state, an evaluation report, and historical source copies. Repeating a completed output returns its saved result; use a fresh directory to rerun revised code. The cases cover missing quantitative grounds, missing controls, graph links preserved only as text, source changes, duplicate designs, replication, different protocols/comparators and a retrieval example. Historical GPU costs are reported separately from current local CPU/time. No experiment or model is launched.

`ablation/common-facts.json` freezes the same facts and time cutoff for a future text/graph/graph-with-selection evaluation. No model comparison has been run. The deterministic text-only case verifies the requirement for explicit relation bindings; it does not establish that graphs reason better than text.

Complete request files and source artifacts are in `SKILL/PaperNexus/examples/mechanism-selection/`. Set their corpus and artifact paths to server-readable locations, then send init, hypothesis registration and action registration in order. The example marks its quantities and sources as synthetic. `recommend-next.json` should select `E1` with a ready mechanism test and two planned count checks. `evidence-view.json` exposes the paths and numerical rationale.

When the tool reports `prediction_basis_missing`, supply a justified quantitative prediction in a new hypothesis version or explicitly register bounded exploration. When it reports `required_control_missing`, register the named control and its operational check in a new action version. A `diagnostic` with a matching `information_targets` entry can gather the missing evidence. Do not invent a numerical bound to clear the gate.

Read `reuse_evidence` records before launching a renamed copy of a completed design. Use an explicit `replicate` action when the intended question needs independent data. After recording results, confirm that the listed controls actually passed and inspect both interval relations and mechanism gates.

For a chain such as relation quality → gradient alignment → final accuracy, register the quantities as `observation`, `proxy` and `target` through `evidence_role`. On the gradient prediction, set `proxy_for` to the accuracy prediction ID. Declare the same roles on matching evaluation outcomes. A primary gradient endpoint is still a proxy. Inspect `evidence_chain.target_status` and `comparison_summary[].performance_claim` before drawing performance conclusions. A negative proxy test can revise the mechanism explanation while the final target remains unmeasured.

Register a bounded diagnostic with `information_targets=[{hypothesis_id,hypothesis_version,kind:"proxy_bridge",prediction_id}]` to test the proxy link, or use `kind:"target_measurement"` for a missing target. The recommendation identifies the matching research gap. Existing budget and execution authorization still apply. Jointly observing the proxy and target does not by itself validate the relationship.

## AutoResearch handoff

Retrieve feedback without resending outcomes:

```json
{"operation":"evidence_view","corpus":"my-corpus","project":"selection-mechanism","limit":10,"responseMode":"full"}
```

Submit this request through `pn_research_decision.py --request-file`. The wrapper already passes optional fields through; no client rewrite is needed. Example files are in `SKILL/PaperNexus/examples/research-feedback/`.

For a measured historical HTTP replay and recovery exercise:

```sh
node scripts/evaluate-research-feedback.mjs --input test/fixtures/research-feedback/measured --output /tmp/pn-feedback-history --mode engineering --seed 17
node scripts/evaluate-research-feedback.mjs --input test/fixtures/research-feedback/measured --output /tmp/pn-feedback-history --mode engineering --seed 17 --resume
node scripts/evaluate-research-feedback.mjs --input test/fixtures/research-feedback/measured --output /tmp/pn-feedback-ablation --mode prepare-ablation --seed 17
```

Engineering mode starts only a local HTTP MCP server and keeps its corpus, frozen requests, trace and receipts in the output directory. A completed output returns `existing_output`. An interrupted output requires `--resume`, unchanged source versions/configuration and the same requests. Lost mutation responses are recovered by requestId. Historical GPU cost is separate from the current validation CPU/time; no training or provider call is launched.

The replay retains the measured NEW decline and OLD improvement as a tradeoff. The one-seed, fixed-model and retrospective limits remain explicit. Ablation preparation exports equivalent source facts in text, structured and graph forms at three decision points, with labels and review templates outside visible materials. It performs no model calls or blind review and does not establish graph utility.

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
