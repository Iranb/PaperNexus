---
name: papernexus-agentic-reasoning
description: Use this skill when an agent needs stepwise reasoning over an existing PaperNexus graph. Live graph reads and imports must go through remote HTTP MCP wrappers, not the legacy HTTP API.
---

# PaperNexus Agentic Reasoning

Use this skill when the goal is to reason through a research problem step by step on top of a live PaperNexus graph.

## Live Graph Policy

- use remote HTTP MCP only
- do not call raw `/api/*`
- do not use stdio/local MCP for a live graph
- do not use local CLI graph commands against the live graph

Preferred wrappers:

- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_queue.py`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py`

## Tool Policy

Use this order:

1. `pn_graph_query.py` for anchor resolution and graph lookup
2. `pn_research_chains.py` for typed chains and briefs
3. import wrappers only when new papers are needed
4. local repo commands only for isolated development

Default MCP mapping:

- `pn_graph_query.py` -> `research_lookup`
- `pn_research_chains.py` -> `research_briefing`
- import wrappers -> `import_workflow`

## Import Boundary Rules

- `import_workflow submit` expects a remote `serverFilePath`, not a local `/Users/...` path.
- If a server path lives under the PaperNexus server user's home directory, keep it as `~/...` instead of guessing a concrete `/home/...` prefix.
- If the paper is local to the agent machine, use `pn_import_submit.py --source ... --ssh-target ...` or `pn_batch_import.py submit`.
- Only use `--server-file-path` when the file is already on the PaperNexus server.
- During reasoning tasks, do not tell the user a paper is in the graph right after submit; check queue status first.

## Reasoning Loop

For non-trivial research tasks, keep this compact state:

```text
Objective:
Current anchor:
Known support:
Known limitation:
Open gap:
Next action:
```

Each step should end with one of:

- confirmed
- uncertain
- contradicted
- needs external evidence

## Recommended Commands

Understand a topic:

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" query "<topic>" --limit 8
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" context "<topic>" --node-view brainstorm
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" evidence-chain "<topic>" --limit 5
```

Generate a direction:

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" ideas "<topic>" --limit 6
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" brainstorm "<topic>" --mode converge --limit 6
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" brainstorm-brief "<topic>" --limit 6
```

Check import progress:

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_queue.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" status --paper-id "<paperId>"
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status
```

Read:

- `task.progress.percent`
- `task.progress.stagePercent`
- `task.progress.queuePosition`
- `summary.remaining`
- `summary.overallPercent`

## Graph Thinking Rules

- prefer typed chains and briefs over raw graph dumps
- keep graph fact, overlay fact, inference, and open risk separate
- when the graph cannot answer a question, report the gap instead of silently falling back to local CLI
