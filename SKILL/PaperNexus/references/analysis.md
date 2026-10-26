# Analysis: separate source statements from graph inference

For a field-wide lineage construction or rebuild, use [the field lineage workflow](field-lineage.md). A landscape query reads the current corpus; it does not establish that the field has been researched adequately.

Use `lineage_analysis/landscape`, when advertised, for a field-wide corpus scan and timeline of papers and methods. Supply a topic query, targetDomain label, or explicit seedNodeIds, with optional year and graph budgets. Inspect scope/counts and diagnostics before interpreting families, mainlines or turningPoints. Families are connected method components; mainlines are longest validated paths, not influence rankings. Paper relations are projections of source-backed method relations. The browser exposes this result through **Build evolution map**, with paper/method switching, family filters, evidence details and SVG/JSON export.

Use `lineage_analysis/overview` to inspect a bounded topic, `problem` for dated observations, `method` for validated lineage and `evidence` for exact edge quotes. `context`, `path` and `impact` describe graph connections. An endpoint is a bounded frontier candidate, not a globally unexplored problem.

For each conclusion preserve: source statement, supporting span, task/protocol, contrary evidence, inference and confidence limit. Compare static/continual/open-set tasks separately unless a justified transfer bridge exists. Do not use cached global layer counts to infer field frequency; prefer the returned effective view and diagnostics.

If an analysis chain is empty, identify missing anchors, missing semantic/overlay data, quality quarantine or insufficient coverage. Choose a source-backed paper read or targeted discovery accordingly. Empty openRisks is not absence of risk. Do not rerun the same empty chain as a substitute for collecting missing evidence.

Legacy typed chains live in `research_briefing` (evidence_chain, theory_brief, storyline_brief, research_brief). Load advanced capabilities only when these are needed; a brief may have no populated overlays. Ordinary analysis does not authorize graph refresh or LLM enrichment.
