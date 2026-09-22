# Advanced proposal and controller contract

Feature-detect `agent_materials` and its operation fields. If the client needs advanced schemas use an appropriate advertised profile; do not guess unsupported arguments.

`proposal_graph_session` is an episode-local action validator and committer. It does not bind a server-side model generator. The caller must create proposalActions or proposalSlates from read evidence. problem/evidenceRefs alone returns final_status=diagnosis, input_status=needs_actions, round_count=0. Increasing maxRounds does not supply actions. Empty flat/nested/round-indexed slates also return zero rounds with the initial graph and validation report; malformed slate containers are rejected.

An action has stable id and type. A minimal speculative node action has this shape (replace every placeholder with task-specific content):

    {"id":"add-hypothesis-1","type":"add_node","node":{"id":"hypothesis:1","type":"Hypothesis","title":"<testable intervention>","text":"<predicted outcome and mechanism>","claim_label":"speculative","provenance":[{"kind":"agent_inference","ref":"<evidence-ledger-id>"}]}}

Connect it to the auto-created Problem via an add_edge action; use `__problem_node_id__` for the source token:

    {"id":"link-hypothesis-1","type":"add_edge","edge":{"id":"edge:problem-hypothesis","type":"supports","source":"__problem_node_id__","target":"hypothesis:1","provenance":[{"kind":"agent_inference","ref":"<decision-id>"}]}}

These actions begin a proposal; they do not satisfy commit requirements. A complete connected proposal needs Hypothesis, Mechanism, Method, NoveltyClaim, EvalPlan and Risk, source-backed EvidenceAttachment relationships, a closest-prior contrast, falsification route and storyline. EvalPlan must include datasets, baselines, metrics, ablations, leakage controls and falsifier. Evidence-supported labels require actual grounding; unknown novelty stays speculative. Repair blocking risks rather than deleting them to pass validation.

Call `agent_materials` with operation=proposal_graph_session, problem, stable runId, evidenceRefs and the constructed actions/slates. Omit outputDir for no persisted artifacts. If supplied, outputDir is a **server** path; copy returned artifact files through the authorized staging mechanism to a local project, never pass a workstation path to the server. A repeat creates a new reconstruction from submitted actions; this is not an append/resume API. Retain the full action set and source versions.

Read validation_report and commit_decisions. `committed` confirms structural requirements only, never novelty or empirical gains. `diagnosis` with actions means repair the named blockers; `needs_actions` means the caller has not supplied the generation step.

`research_controller` is a different stateful option with status/init/decomposition/judge/select/evidence/design/export stages. Reuse its existing project state and bounded run_round support; do not run it as a compulsory second generator after a completed proposal. Original controller state owns its completion, not local mirror files.
