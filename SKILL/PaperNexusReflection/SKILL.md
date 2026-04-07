---
name: papernexus-reflection
description: Use this skill when a Coder or Analyzer agent needs to inspect, summarize, or update PaperNexus experiment-reflection overlays through remote HTTP MCP workflows instead of local live-graph CLI operations.
---

# PaperNexus Reflection

Use this skill when the task is about experiment reflection in a live PaperNexus corpus.

## Live Graph Policy

- use remote HTTP MCP wrappers
- do not call raw `/api/*`
- do not use stdio/local MCP for live graph work
- do not run local live-graph CLI commands as the default path

Preferred wrappers:

- `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py`

Wrapper mapping:

- import wrappers -> `import_workflow`
- chain/brief wrappers -> `research_briefing`

## Typical Workflow

1. If needed, import a new source through the remote queue.
2. Wait until the task reaches `completed`.
3. Read `reflection-chain` for typed `Innovation -> Experiment -> Outcome -> Reflection`.
4. Read `paper-enhancement` when you need raw overlay cards for one paper.
5. Use `research-brief` or `evidence-chain` if you also need supporting claims and limitations.

Examples:

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" --source "/absolute/path/paper.pdf" --ssh-target "hyq@<host>"
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" wait --paper-id "<paperId>" --timeout 1800 --interval 15
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" reflection-chain "<topic>" --limit 5
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --mcp-url "http://<host>:4821/mcp" --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```

## Output Style

When summarizing reflection, prefer:

```text
Innovation:
Experiment:
Outcome:
Reflection:
Open risk:
```

Keep extracted evidence, inference, and uncertainty separate.

## Repo-Local Exception

Repo-local staged commands are for isolated development only. They are not the live-graph control plane for reflection work.
