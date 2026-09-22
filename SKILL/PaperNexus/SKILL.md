---
name: papernexus
description: Discover and read literature with PaperNexus, trace source-backed methods and problems, and generate and audit hypotheses. Use for research evidence, not corpus maintenance or experiment execution.
---

# PaperNexus Research

This is the canonical research entrypoint. Its existing `papernexus` name remains compatible. Load only the stage reference needed now.

## Start with capabilities and scope

Use the configured remote PaperNexus MCP. Read [the shared remote contract](references/remote-contract.md) once per setup or reconnect. Inspect the advertised tools; when `literature_review` exists, call `operation=capabilities` once and retain the result for this connection. Use `corpora` only if the corpus is unknown. A newer skill does not make an operation available on an older server.

Use `responseMode=summary` for triage on servers advertising it. It is a bounded preview, not a complete evidence review. Read exact papers and source spans before adopting a claim. Preserve original gate denials and unknowns; omitted evidence is never approval.

## Select the depth that serves the request

- Quick: answer one question from existing evidence; return sources and uncertainty. Do not initialize a full AutoResearch project or trigger imports just to answer a question.
- Standard: map related work, read selected papers and fill concrete evidence gaps. Reuse prior evidence by paper identity and source version.
- Deep: support a selected research idea with closest-prior comparison, protocol, counterevidence and a falsifiable experiment. Existing project acceptance gates remain authoritative.

Depth controls work budget, not claim truth. Missing evidence limits the conclusion at every depth.

## Route the current stage

| Need | Reference | Primary tools |
|---|---|---|
| Find, select, read or compare papers | [Literature](references/literature.md) | `literature_review` |
| Explain methods, assumptions, evidence or evolution | [Analysis](references/analysis.md) | `lineage_analysis` |
| Generate, contrast or reject a hypothesis | [Ideation](references/ideation.md) | `idea_generation` |
| Action-driven proposals and AutoResearch handoff | [Advanced](references/advanced.md), [adapter](references/autoresearch-adapter.md) | feature-detected `agent_materials` |
| Upload, refresh or repair corpus files | [Maintenance skill](../PaperNexusMaintenance/SKILL.md) | explicit discovery/import/maintenance operations |
| Analyze actual experiment outcomes | [Reflection skill](../PaperNexusReflection/SKILL.md) | evidence and reflection reads |

## Preserve research boundaries

`in_graph` means stored/visible, not verified publication. Inspect `source_admission`; quarantined sources cannot support research claims. Eligibility alone is not independent bibliographic verification. Keep discovery, graph evidence, source evidence, inference and experiment outcomes distinct.

Graph paths are connectivity, not causal proof. Sparse results are not evidence of an unexplored field. Lexical collision is a screening signal, not semantic equivalence. A committed proposal is structurally accepted, not scientifically validated. Respect all returned evidence gates, including the stricter mechanism audit when other coverage fields look sufficient.

For every consequential conclusion retain paper/version, source span, task/protocol and uncertainty. Reuse an existing packet only when source/graph/quality versions and the current evidence role remain compatible. Refetch after graph or quality changes.

## Compatible older servers

If only legacy tools are advertised, map search/paper/survey to `research_lookup/query`, `agent_materials/paper_material_view`, `agent_materials/research_material_pack`; map analysis to `research_lookup` and `research_briefing`; map ideation to `idea_catalyst` and `agent_materials/innovation_evidence_pack`. Only send fields present in the advertised schema. Read the advanced reference for stateful workflows; do not send unsupported `candidateMechanism` to an older material tool and assume it was used.

Stable shell wrappers remain in `SKILL/PaperNexus/scripts`; specialized wrappers forward here. They are for configured shell clients and local staging, not a reason to reproduce authentication or protocol code.
