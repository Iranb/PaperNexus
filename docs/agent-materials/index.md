# Agent Materials

`agent_materials` is the MCP surface for Agent-facing research materials. It assembles graph/source evidence, source-discovery plans, import requisitions, negative-evidence packs, experiment-cost snippets, structural-gap and innovation-pattern audits, innovation evidence packs, research-controller artifacts, and episode-local proposal graph sessions without turning them into raw corpus graph facts.

Use this section when an Agent needs structured materials for a research task but must preserve evidence boundaries.

## What Lives Here

| Area | Entry Point | State Boundary |
| --- | --- | --- |
| Paper material view | `operation=paper_material_view` | Reads committed graph/source state and paper-local material records |
| Source discovery plan | `operation=source_discovery_plan` | Combines committed graph candidates with optional provider/live/literature-discovery evidence |
| Research material pack | `operation=research_material_pack` | Groups materials by role and records missing materials/import requisitions |
| Structural gap pack | `operation=structural_gap_pack` | Separates additive and subtractive gaps, bounded lineage frontiers, persistent assumptions, and historical-regression risks |
| Innovation pattern pack | `operation=innovation_pattern_pack` | Matches auditable research-action cards to already-compiled structural gaps; built-in cards remain a seed taxonomy |
| Innovation evidence pack | `operation=innovation_evidence_pack` | Adds the ordered structural/pattern trace, mechanism-collision search plan, and proposal handoff to existing novelty-risk and AutoResearch artifacts without proving novelty |
| Project overlay memory | `paper_role_overlay`, `evidence_cart`, `workflow_state` | Stores project-local judgments outside the raw graph |
| Research controller | `operation=research_controller` | Writes controller artifacts and approval-gated material-request records outside the raw graph |
| Proposal graph session | `operation=proposal_graph_session` | Validates role actions against frozen snapshots, commits only gate-passing proposal subgraphs, and writes proposal artifacts outside the raw graph |

## Operating Rules

- Provider evidence, live discovery, literature discovery, import submission, import processing, and experiment planning are opt-in paths.
- Paper-like arrays such as `candidate_papers`, provider/live/literature discovery candidates, and `supporting_papers` are ordered newest-first when publication metadata is available; undated records retain stable fallback ordering after dated records.
- Discovery-only and provider-only papers are not graph evidence until import tasks complete and authoritative graph sync is visible.
- Project overlays are Agent memory, not paper truth.
- Research-action matching is gap-first: committed evidence forms a structural gap before a pattern can be selected. Topic keywords alone are not a valid match basis.
- A bounded method-lineage endpoint is a `frontier_candidate`, not proof of a corpus-global leaf. Persistent assumptions count distinct graph-backed papers, not duplicate material roles.
- The 15 built-in ResearchStudio-style cards are `seed_taxonomy` heuristics, not empirical Oral/Reject outcome evidence. Mechanism collision output is a query plan and lexical prefilter, not semantic novelty proof.
- Research-controller outputs are planning artifacts. They do not prove novelty, select a final direction, run experiments, or mutate the raw graph.
- Proposal graph sessions are episode-local ideation artifacts. They can cite graph or discovery evidence, but they do not write corpus facts.

## Read Next

- [Agent Material Backend](/agent-material-backend)
- [Research Controller Skill Contract](/agent-materials/research-controller-skill)
- [MCP And Skill Contract Guardrails](/interfaces/mcp-skill-contracts)
- [Generated MCP Tool Reference](/reference/generated/mcp-tools)
