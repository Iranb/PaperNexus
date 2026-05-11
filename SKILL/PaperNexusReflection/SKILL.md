---
name: papernexus-reflection
description: Use this skill when a Coder or Analyzer agent needs to inspect, summarize, or update PaperNexus experiment-reflection overlays through remote HTTP MCP workflows instead of local live-graph CLI operations.
---

# PaperNexus Reflection

Use this skill when the task is about experiment reflection in a live PaperNexus corpus.

## Live Graph Policy

- use the configured `papernexus-remote` MCP server first
- do not call raw `/api/*`
- do not use stdio/local MCP for live graph work
- do not run local live-graph CLI commands as the default path

Preferred MCP tools:

- `import_workflow`
- `research_briefing`

Shell fallback wrappers:

- `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py`
- `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py`

Wrapper mapping:

- import wrappers -> `import_workflow`
- chain/brief wrappers -> `research_briefing`

## Import Boundary Rules

- Remote `import_workflow` runs on the PaperNexus server.
- `serverFilePath` must therefore be a file path on the server, not a local `/Users/...` path on the agent machine.
- If that server path is under the server user's home directory, keep it in `~/...` form.
- For local PDFs or Markdown files, use `pn_import_submit.py --source ...` or `pn_batch_import.py submit`.
- Only read reflection overlays after the import task reaches `completed`.
- If a paper came from keyword `literature_discovery`, its discovery report can be available before reflection overlays are graph-committed. Treat that interim state as discovery evidence and wait for `status=completed` plus `stage=completed` before reading graph/reflection chains.

## Typical Workflow

1. If needed, import a new source through the remote queue.
2. Check upload progress with `status` or `wait` instead of guessing by time.
3. Wait until the task reaches `completed`.
4. Read `reflection-chain` for typed `Innovation -> Experiment -> Outcome -> Reflection`.
5. Read `paper-enhancement` when you need raw overlay cards for one paper.
6. Use `research-brief` or `evidence-chain` if you also need supporting claims and limitations.

Shell fallback examples:

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --corpus "<corpus>" --source "/absolute/path/paper.pdf"
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --corpus "<corpus>" status --paper-id "<paperId>"
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --corpus "<corpus>" wait --paper-id "<paperId>" --timeout 1800 --interval 15
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --corpus "<corpus>" reflection-chain "<topic>" --limit 5
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```

When checking queue state, read:

- `task.progress.percent`
- `task.progress.stagePercent`
- `task.progress.queuePosition`
- `task.stage`
- `task.error`

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
