---
name: papernexus-corpus-refresh
description: Use when an already-indexed PaperNexus corpus needs corpus-scale batch refresh, Stage 1 rematerialization, Stage 2 batch LLM optimization, or cached-snapshot optimize over remote HTTP MCP.
---

# PaperNexus Corpus Refresh

Use this skill when many already-tracked papers changed, or when the caller needs corpus-scale maintenance instead of a single-paper repair.
Assume OpenClaw already has a configured PaperNexus MCP server named `papernexus-remote`.

## Live Graph Policy

- use remote HTTP MCP only
- do not call raw `/api/*`
- do not use local CLI graph commands against a live user corpus
- do not use this skill for one-paper repair; prefer `refresh_paper_graph` or the `PaperNexusPaperRefresh` skill for that
- prefer the `refresh_corpus` MCP tool on `papernexus-remote`

Shell fallback entry point:

```bash
python3 SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py \
  --corpus "<corpus>" \
  --mode analyze \
  [--force] \
  [--no-incremental] \
  [--semantic-extraction auto] \
  [--llm-batch-size 16] \
  [--rebuild-pdf-markdown] \
  [--changed-source-key "<sourceKey>"] \
  [--json]
```

## Mode Rules

- `analyze`: full end-to-end corpus refresh with graph commit
- `materialize`: Stage 1 only, refresh markdown cache and reusable snapshots without committing the graph
- `llm_optimize`: Stage 2 only, run batch semantic/relation optimization over cached snapshots without committing the graph
- `optimize`: resume from cached snapshots and commit stages 2-5

Choose modes this way:

- use `analyze` when source files changed and you want the committed graph updated now
- use `materialize` when you only need fresh snapshots or want to split Stage 1 from later LLM work
- use `llm_optimize` when Stage 1 snapshots are already good and you want batch LLM refresh without re-parsing every source
- use `optimize` when Stage 1 is already done and you want Stage 2 plus graph commit in one run

## Batch Scope Rules

- `--no-incremental` only applies to `analyze`; it means refresh all tracked sources instead of dirty-only reuse
- `--changed-source-key` scopes `llm_optimize` or `optimize` to selected manifest `sourceKey` entries
- `--semantic-extraction` controls whether Stage 2 stays heuristic-only or uses `llm-assisted` / `llm-primary`
- `--llm-batch-size` is the main throughput knob for batch LLM optimization
- `--rebuild-pdf-markdown` forces PDF sources back through Stage 1 re-materialization before downstream steps

## Output Contract

Important fields:

- `contractVersion`
- `mode`
- `stage`
- `graphCommitted`
- `reused`
- `changes`
- `meta`

Interpretation:

- `graphCommitted=true` only for `analyze` and `optimize`
- `stage=materialized` means Stage 1 stopped before graph commit
- `stage=llm-optimized` means Stage 2 snapshots are refreshed but the graph was not committed
- `reused=true` means the selected mode found reusable state and did not need full work

## Example

Run a scoped Stage 2 batch optimization over two known sources:

```bash
python3 SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py \
  --corpus "GCD" \
  --mode llm_optimize \
  --semantic-extraction llm-primary \
  --llm-batch-size 16 \
  --changed-source-key "papers/a.md" \
  --changed-source-key "papers/b.md" \
  --json
```
