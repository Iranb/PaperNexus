---
name: papernexus-idea-catalyst
description: Use this skill when the goal is to decompose a research problem, analyze target-domain gaps, retrieve cross-domain support from the PaperNexus graph, and return either staged packet bundles, idea fragments, or a data-starvation requisition through remote HTTP MCP.
---

# PaperNexus IDEA-CATALYST

Use this skill when the user wants interdisciplinary ideation grounded in the current PaperNexus graph.

The flow is staged:

1. `decomposition`
2. `target-domain analysis`
3. `cross-domain retrieval`
4. `source-domain takeaways`
5. `integration`
6. `ranking` or `requisition`

## Canonical Entry

This directory has exactly one canonical skill document:

- `SKILL/PaperNexusIdeaCatalyst/SKILL.md`

And exactly one canonical script entry:

- `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`

Do not create or rely on local duplicate copies such as `SKILL 2.md` or `scripts 2/`. Those are stale local artifacts, not supported skill entry points.

## Live Graph Policy

- use the configured `papernexus-remote` MCP server first
- do not call raw `/api/*`
- do not use stdio/local MCP for live graph work

- do not repeat IPs, MCP URLs, or tokens in the skill

Preferred path:

- call the `idea_catalyst` MCP tool on `papernexus-remote`

Shell fallback entry point:

```bash
python3 SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py \
  --corpus "<corpus>" \
  --problem "Your research problem statement here" \
  --target-domain "Computer Science" \
  [--fine-grained-domain "Generalized Category Discovery"] \
  [--num-source-domains 3] \
  [--relevance-threshold 3] \
  [--limit 8] \
  [--output-mode idea_fragments|packet_bundle] \
  [--include-analysis] \
  [--json]
```

This wrapper is only a shell fallback around the remote `idea_catalyst` MCP tool.

## Expected Output

Default output:

- `idea_fragments`
- `requisition_report`

Packet mode:

- `packet_bundle`

Interpretation:

- if the graph has enough cross-domain evidence, return `idea_fragments`
- if staged consumers need the full upstream contract, use `--output-mode packet_bundle`
- if the graph is data-starved, return `requisition_report.status = DATA_STARVATION`

`packet_bundle` contains:

- `decomposition`
- `target_domain_analysis`
- `cross_domain_queries`
- `source_domain_analyses`
- `idea_fragments`
- `interdisciplinary_ranking`
- `requisition_report`

## Rules

1. Do not hallucinate ideas when the graph is data-starved.
2. Do not return both success and starvation outputs together.
3. Keep source domains distinct from the target domain.
4. Ground takeaways in returned KG node and paper evidence.
5. Use `--fine-grained-domain` when the target area is narrower than the graph's coarse domain label.
6. Prefer `--output-mode packet_bundle` when another system will do downstream storylining or orchestration.
