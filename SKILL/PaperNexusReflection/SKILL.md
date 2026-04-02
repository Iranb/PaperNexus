---
name: papernexus-reflection
description: Use this skill when a Coder or Analyzer agent needs to inspect, summarize, or update PaperNexus experiment-reflection overlays through authenticated API-backed workflows instead of local live-graph CLI operations.
---

# PaperNexus Reflection

Use this skill when the task is about experiment reflection in the PaperNexus repository.

## Live Graph Access Policy

For a running user graph, prefer the skill-local Python wrappers in `SKILL/PaperNexusReflection/scripts/` as the default interface. They call the authenticated HTTP API underneath and are the preferred agent path.

If both a remote server API and a local checkout are available, use the remote API path first.
Do not use local CLI commands such as `papernexus analyze`, `papernexus enhance --once`, or staged pipeline commands against the live graph when the goal is to ingest a paper, inspect a reflection overlay, or answer a graph-backed question.

Allowed live-graph reflection entrypoints:

- `POST /api/imports?name=<corpus>`
- `GET /api/imports?name=<corpus>`
- `GET /api/imports/:taskId`
- `GET /api/imports/:taskId/log`
- `GET /api/enhancements?name=<corpus>`
- `GET /api/paper-enhancement?name=<corpus>&paperId=<paperId>`
- `GET /api/corpus?name=<corpus>`
- `POST /api/reflection-chain`
- `POST /api/evidence-chain`
- `POST /api/research-brief`
- `POST /api/storyline-brief`

Every API request must include:

- `Authorization: Bearer <token>`

If the needed reflection workflow is not exposed through these endpoints, report the missing API capability instead of falling back to local CLI on the live graph.

## What This Skill Covers

This skill is for the paper-local reflection overlay:

- `Innovation`: the paper's key novelty, core change, or main contribution point
- `Experiment`: an experimental unit such as a main evaluation, ablation, comparison, robustness test, or failed attempt
- `Outcome`: the result of that experiment, labeled as `success`, `failure`, `mixed`, or `inconclusive`
- `Reflection`: the lesson, boundary, takeaway, design implication, or future-facing insight

The reflection overlay is an enhancement layer, not a hard dependency of the core graph build.

## When To Use It

Use this skill when you need to:

- inspect a paper's innovation-to-experiment-to-outcome chain
- summarize why an approach succeeded or failed
- compare reflected lessons across papers
- refresh reflection overlays after new Markdown or graph updates
- produce notes for brainstorming, experiment review, or writing support

## How The Data Updates

Reflection data is refreshed through the existing enhancement workflow, but live-graph agents should drive and inspect it through the API.

One-off uploaded PDFs or Markdown files should normally enter through queued import tasks under `.papernexus/imports/` first. Let the import worker merge them into the main graph rather than manually moving them into the main paper directory during automation.
If an import or enhancement pass stalls, report the current stage, recent task log lines, and the likely blocker first. Do not blindly rerun the same operation over and over without new evidence.

When the refresh path needs PDF parsing, prefer the repo default remote MinerU path first. Only fall back to a local parser if the remote PDF backend is unavailable or the task explicitly calls for local parsing.
Do not add `--force` by default here. Reflection refresh should normally follow incremental graph refresh behavior unless the user explicitly wants a full rebuild.

Typical live-graph update path:

1. If a single PDF or Markdown file exists only on the local agent machine, prefer `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`. That wrapper stages the file and submits the import in one step.
2. If you need to ingest many local files, prefer `python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py --manifest <json> submit`, then use `status` or `wait` with the same manifest.
3. If you need explicit control for a directory, stage it first with `python3 SKILL/PaperNexusReflection/scripts/pn_stage_sync.py`, then submit one staged file with `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --server-file-path <remote-file>`.
4. Poll with `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py wait --paper-id <paperId>` or `--source <local-file>` until the task completes.
5. Prefer reading the refreshed reflection view through `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py reflection-chain "<topic>"`.
6. Use `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py paper-enhancement --paper-id <paperId>` when you need raw overlay cards or anchors for a specific paper.

Do not default to `files[].contentBase64` for large local PDFs. Prefer stable remote staging such as `rsync` and then use `serverFilePath`.

Read queue state like this:

- `pending` + `queued`: the import is waiting for worker pickup
- `running`: use `stage` and the newest `/log` lines to see whether it is in `materialize`, `llm-optimize`, or `fast-commit`
- `completed`: safe to query reflection outputs
- `failed`: report `error.message`, current `stage`, and recent log lines before retrying

Equivalent repo-local staged path for isolated development only:

```bash
papernexus materialize --continue
papernexus llm-optimize --continue
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
papernexus enhance --once
```

Keep the configured corpus in single-graph mode. Once an index root already has snapshots or a committed graph, do not point stage commands at a narrower paper subdirectory on that same root.

Use `papernexus analyze --force` only in isolated repo-local testing when the user explicitly asks for a full rebuild or when cached stage outputs are known bad and normal resume cannot recover.

If PDFs are involved and you need to spell the parser out explicitly, prefer:

```bash
papernexus analyze --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
```

If the paper content did not change and the previous run only missed LLM-assisted extraction because of network/model failures, `papernexus analyze` is enough. Incremental ingestion now retries those failed papers and reuses snapshots for papers that already succeeded.

If Stage 3 already finished and you want to clean up duplicate `Dataset` / `Benchmark` nodes before committing, run `papernexus merge-graph --continue`.

If the staged graph still contains generic evaluation nodes such as `training dataset`, do not rely on `--node-llm-check` right now. That merge-time LLM node deletion path is temporarily disabled.

If the staged graph already looks correct and only needs to be committed, use `papernexus write-index --continue` instead of rebuilding earlier stages. `write-index` will auto-run the merge step if it was skipped.

If raw source files changed after Stage 3 and you want those new changes reflected in the graph, rerun Stage 1-3 before running Stage 4. Stage 4 only commits the staged graph that already exists.

For ongoing live usage:

- assume the remote `serve` process already exposes the API
- do not start `watch` or `service install` as part of normal reflection inspection
- API access through `serve` requires the configured PaperNexus token; do not assume anonymous access when inspecting reflection overlays remotely

## What To Read First

Read these files first when you need implementation context:

- `src/core/enhancements/extract.js`
- `src/storage/enhancement-store.js`
- `src/core/enhancements/worker.js`
- `src/server/api.js`

## How To Inspect Reflection Output

At the paper level, look under the enhancement overlay and inspect:

- `overlays.reflection.cards`
- `overlays.reflection.slots.innovations`
- `overlays.reflection.slots.experiments`
- `overlays.reflection.slots.outcomes`
- `overlays.reflection.slots.reflections`
- `overlays.reflection.links`
- `overlays.reflection.verdictCounts`
- `overlays.reflection.risks`

## Recommended Reflection Workflow

1. Confirm the import task or corpus data is current through the API.
2. If a new source is needed, prefer `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>` for one local file, or `python3 SKILL/PaperNexusReflection/scripts/pn_stage_sync.py` plus `python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --server-file-path ...` for explicit staging control.
3. Wait until the import task completes.
4. Read `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py reflection-chain` for typed innovation-experiment-outcome-reflection chains.
5. Read `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py evidence-chain` or `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py research-brief` if you also need supporting paper claims and limitations.
6. Summarize in this order:

- innovation
- experiment design
- outcome verdict
- takeaway or boundary

## Output Style For Coder Or Analyzer Agents

When writing a reflection summary, prefer this compact structure:

```text
Innovation:
Experiment:
Outcome:
Reflection:
Open risk:
```

Guidelines:

- keep claims tied to extracted evidence
- distinguish clear wins from mixed or inconclusive results
- surface failure conditions explicitly
- mention when the reflection is thin or weakly supported

## When Reflection Should Modify The Graph

Reflection findings do not automatically mean the main graph should be edited.

Agent safety rule for reflection work:

- only add or update graph understanding
- do not delete corpus data, restore archive snapshots, or run whole-database backup/restore commands as part of normal reflection workflows

Prefer graph mutation only when the reflection process reveals a clear, local, high-confidence graph error, such as:

- an obviously wrong node label
- a duplicated node that should be unified
- a missing relationship with direct textual support
- a relationship that points to the wrong paper, claim, method, or finding

What reflection work can safely drive:

- small node property corrections
- relationship fixes
- schema-valid local additions that clarify an already-supported structure

What reflection work should usually not do:

- rewrite the graph based on a weak interpretation
- treat a tentative takeaway as a confirmed graph fact
- promote a thin reflection into a permanent canonical truth

If support is weak or interpretive, prefer recording:

- `Open risk`
- a reflection note
- a limitation
- an uncertainty for later review

Use `dryRun: true` first when applying graph mutation through MCP.

Important limitation:

- graph mutation affects the current indexed graph
- a later `papernexus analyze --force` or rebuild can overwrite those edits

So use mutation here for corrective curation, not as the only long-term memory layer.

## Dynamic-Update Notes

If the overlay looks stale, suspect:

- the import task has not completed yet
- enhancement jobs are still pending
- the background `serve` worker is not running
- the API token, corpus name, or paper id is wrong

Useful API checks:

- `GET /api/imports?name=<corpus>`
- `GET /api/imports/:taskId/log`
- `GET /api/enhancements?name=<corpus>`
- `GET /api/paper-enhancement?name=<corpus>&paperId=<paperId>`

Preferred script checks:

- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --api-base <url> --corpus <corpus> list`
- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --api-base <url> --corpus <corpus> status --paper-id <paperId>`
- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --api-base <url> --corpus <corpus> status --source <local-file>`
- `python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --api-base <url> --corpus <corpus> log <taskId>`
- `python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --api-base <url> --corpus <corpus> reflection-chain "<topic>"`
