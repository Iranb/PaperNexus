---
name: papernexus-research-chains
description: Use this skill when an agent needs typed multi-hop research chains, evidence bundles, reflection bundles, or brief-style outputs from a live PaperNexus graph over remote HTTP MCP.
---

# PaperNexus Research Chains

Use this skill when the task is to answer a research question through explicit graph-supported chains rather than raw graph inspection.

## Live Graph Policy

- use remote HTTP MCP wrappers first
- do not call raw `/api/*`
- do not use local CLI graph queries against the live graph

Default wrappers:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py`
- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py`

Underlying MCP tools:

- `research_lookup`
- `research_briefing`

## Which Wrapper Matches Which Task

- anchor resolution:
  `pn_graph_query.py query|context|impact`
- ideation lookup:
  `pn_graph_query.py ideas|brainstorm`
- concrete multi-hop path:
  `pn_research_chains.py path-trace`
- evidence package:
  `pn_research_chains.py evidence-chain`
- experiment lessons:
  `pn_research_chains.py reflection-chain`
- mechanisms and assumptions:
  `pn_research_chains.py theory-brief`
- narrative and argument flow:
  `pn_research_chains.py storyline-brief`
- compact topic package:
  `pn_research_chains.py research-brief`
- ideation support package:
  `pn_research_chains.py brainstorm-brief`
- one paper's raw overlay:
  `pn_research_chains.py paper-enhancement`

## Minimal Examples

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" query "<topic>" --limit 8
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" evidence-chain "<topic>" --limit 5
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" reflection-chain "<topic>" --limit 5
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" research-brief "<topic>" --limit 5
```

## Output Discipline

Keep these separate:

- graph fact
- overlay fact
- inference
- open risk

If a typed chain returns no usable result:

1. report that it was not found
2. mention the closest available evidence
3. say whether the gap is missing anchors, missing overlay data, or a true graph gap
