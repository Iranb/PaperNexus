---
name: papernexus-reflection
description: Use this skill when a Coder or Analyzer agent needs to inspect, summarize, or update PaperNexus experiment-reflection overlays. It is for tracing a paper's Innovation, Experiment, Outcome, and Reflection chain, checking what was validated or failed, and refreshing the overlay through the normal incremental PaperNexus workflow.
---

# PaperNexus Reflection

Use this skill when the task is about experiment reflection in the PaperNexus repository.

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

Reflection data is refreshed through the existing incremental enhancement workflow.

When the refresh path needs PDF parsing, prefer the repo default remote MinerU path first. Only fall back to a local parser if the remote PDF backend is unavailable or the task explicitly calls for local parsing.
Do not add `--force` by default here. Reflection refresh should normally follow incremental graph refresh behavior unless the user explicitly wants a full rebuild.

Typical update path:

```bash
papernexus analyze
papernexus enhance --once
```

Equivalent staged path:

```bash
papernexus materialize --continue
papernexus llm-optimize --continue
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
papernexus enhance --once
```

Keep the configured corpus in single-graph mode. Once an index root already has snapshots or a committed graph, do not point stage commands at a narrower paper subdirectory on that same root.

Use `papernexus analyze --force` only when the user explicitly asks for a full rebuild or when cached stage outputs are known bad and normal resume cannot recover.

If PDFs are involved and you need to spell the parser out explicitly, prefer:

```bash
papernexus analyze --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
```

If the paper content did not change and the previous run only missed LLM-assisted extraction because of network/model failures, `papernexus analyze` is enough. Incremental ingestion now retries those failed papers and reuses snapshots for papers that already succeeded.

If Stage 3 already finished and you want to clean up duplicate `Dataset` / `Benchmark` nodes before committing, run `papernexus merge-graph --continue`.

If the staged graph still contains generic evaluation nodes such as `training dataset`, do not rely on `--node-llm-check` right now. That merge-time LLM node deletion path is temporarily disabled.

If the staged graph already looks correct and only needs to be committed, use `papernexus write-index --continue` instead of rebuilding earlier stages. `write-index` will auto-run the merge step if it was skipped.

Before `write-index` overwrites the committed graph, PaperNexus now creates a backup under `<rootPath>/.papernexus-backups/`.

If raw source files changed after Stage 3 and you want those new changes reflected in the graph, rerun Stage 1-3 before running Stage 4. Stage 4 only commits the staged graph that already exists.

For ongoing updates:

```bash
papernexus service install
papernexus service status
papernexus logs watch
```

In the default background service mode:

- `watch` monitors source file changes
- `serve` runs the dashboard/API and enhancement worker

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

1. Confirm the paper source is current.
2. Re-run `analyze` if the Markdown changed.
3. Re-run `enhance --once` or let the background worker refresh it.
4. Read the reflection overlay.
5. Summarize in this order:

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

- the paper Markdown changed but `analyze` was not rerun
- enhancement jobs are still pending
- the background `serve` worker is not running
- the corpus selected in `--corpus` is not the one you expect

Useful commands:

```bash
papernexus status --corpus <name>
papernexus analyze --corpus <name>
papernexus enhance --once --corpus <name>
papernexus service status
papernexus logs watch
```
