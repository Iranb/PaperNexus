# Agent Materials

`agent_materials` is the MCP surface for Agent-facing research materials. It assembles graph/source evidence, source-discovery plans, import requisitions, negative-evidence packs, experiment-cost snippets, innovation evidence packs, research-controller artifacts, and episode-local proposal graph sessions without turning them into raw corpus graph facts.

Use this section when an Agent needs structured materials for a research task but must preserve evidence boundaries.

## What Lives Here

| Area | Entry Point | State Boundary |
| --- | --- | --- |
| Paper material view | `operation=paper_material_view` | Reads committed graph/source state and paper-local material records |
| Source discovery plan | `operation=source_discovery_plan` | Combines committed graph candidates with optional provider/live/literature-discovery evidence |
| Research material pack | `operation=research_material_pack` | Groups materials by role and records missing materials/import requisitions |
| Innovation evidence pack | `operation=innovation_evidence_pack` | Compiles novelty-risk, gap, closest-prior, evidence-sufficiency, and AutoResearch handoff artifacts without proving novelty |
| Project overlay memory | `paper_role_overlay`, `evidence_cart`, `workflow_state` | Stores project-local judgments outside the raw graph |
| Research controller | `operation=research_controller` | Writes controller artifacts and approval-gated material-request records outside the raw graph |
| Proposal graph session | `operation=proposal_graph_session` | Validates role actions against frozen snapshots, commits only gate-passing proposal subgraphs, and writes proposal artifacts outside the raw graph |

## Operating Rules

- Provider evidence, live discovery, literature discovery, import submission, import processing, and experiment planning are opt-in paths.
- Discovery-only and provider-only papers are not graph evidence until import tasks complete and authoritative graph sync is visible.
- Project overlays are Agent memory, not paper truth.
- Research-controller outputs are planning artifacts. They do not prove novelty, select a final direction, run experiments, or mutate the raw graph.
- Proposal graph sessions are episode-local ideation artifacts. They can cite graph or discovery evidence, but they do not write corpus facts.

## Read Next

- [Agent Material Backend](/agent-material-backend)
- [Research Controller Skill Contract](/agent-materials/research-controller-skill)
- [MCP And Skill Contract Guardrails](/interfaces/mcp-skill-contracts)
- [Generated MCP Tool Reference](/reference/generated/mcp-tools)
