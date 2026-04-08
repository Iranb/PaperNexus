---
name: papernexus-idea-catalyst
description: Use this skill when the goal is to decompose a research problem, search the PaperNexus graph for cross-domain support, and return either idea fragments or a data-starvation requisition through remote HTTP MCP.
---

# PaperNexus IDEA-CATALYST

Use this skill when the user wants interdisciplinary ideation grounded in the current PaperNexus graph.

## Canonical Entry

This directory has exactly one canonical skill document:

- `SKILL/PaperNexusIdeaCatalyst/SKILL.md`

And exactly one canonical script entry:

- `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`

Do not create or rely on local duplicate copies such as `SKILL 2.md` or `scripts 2/`. Those are stale local artifacts, not supported skill entry points.

## Live Graph Policy

- use the skill-local wrapper over remote HTTP MCP
- do not call raw `/api/*`
- do not use stdio/local MCP for live graph work

Entry point:

```bash
python3 SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  --problem "Your research problem statement here" \
  --target-domain "Computer Science" \
  [--num-source-domains 3] \
  [--relevance-threshold 3] \
  [--limit 8] \
  [--json]
```

This wrapper calls the remote `idea_catalyst` MCP tool.

## Expected Output

Exactly one of:

- `idea_fragments`
- `requisition_report`

Interpretation:

- if the graph has enough cross-domain evidence, return `idea_fragments`
- if the graph is data-starved, return `requisition_report.status = DATA_STARVATION`

## Rules

1. Do not hallucinate ideas when the graph is data-starved.
2. Do not return both success and starvation outputs together.
3. Keep source domains distinct from the target domain.
4. Ground takeaways in returned KG node and paper evidence.
