# Ideation: generate hypotheses, then challenge selected ones

Start from a concrete failure mechanism and source-backed material. `idea_generation/gaps` identifies bounded structural gaps. `generate` gives graph candidates; targetDomain selects cross-domain catalyst. `diverge` and `converge` vary exploration depth. Do not treat their output as novel findings.

Write lightweight candidates with intervention, mechanism, predicted outcome pattern, closest prior, evidence debt, alternative explanation and cheapest falsifier. Select candidates by distinct mechanisms rather than different names for the same idea. Budget breadth to the question; inspect target/near/far sources when they answer distinct evidence gaps, not as unconditional repeated discovery.

For a concrete candidate call `evaluate` with `candidateMechanism`; inspect `evidence_sufficiency`, `mechanism_collision_audit`, `required_followup` and source spans. Coverage sufficient is not semantic novelty verified. `full_combination_collision` based only on a broad domain word does not establish mechanism identity. Compare input assumptions, intervention, objective, output and claimed effect against exact closest-prior text.

Keep speculative ideas available with explicit evidence debt; do not promote them to experiment-ready until the chosen idea has baseline/protocol evidence, counterevidence and a discriminating pilot. `experiment_materials` provides anchors/cost facts, not an executed experiment or launch approval.

Use one primary candidate generator and one review stage. Do not mechanically regenerate the same idea set in idea_catalyst, research_controller, proposal_graph_session and the AutoResearch panel. Reuse candidate IDs and evidence packets. For proposal actions, read [advanced.md](advanced.md).
