# CLI Reference

This page is the detailed companion to the short command list in the repository [README](../README.md).

## Install The Global Command

From the project root:

```bash
npm install
npm link
```

If `papernexus` is not found:

```bash
npm bin -g
```

Add that directory to your shell `PATH`.

## Global Flags

- `--config <path>`: use an explicit runtime config file
- `--no-config`: ignore config discovery and rely on CLI flags only
- `--quiet`: keep output minimal and rely on progress bars

## Most Common End-To-End Commands

```bash
papernexus init
papernexus analyze --force
papernexus analyze
papernexus serve
papernexus service install
papernexus logs watch
```

## Staged Build Commands

PaperNexus now supports a staged pipeline so long-running work can be resumed instead of restarted.

### Stage 1: `materialize`

```bash
papernexus materialize [<path>] [--name <corpus>] [--continue] [--force]
```

Use this when you want to:

- convert PDF to reusable Markdown cache
- copy source Markdown into the corpus cache
- generate heuristic paper snapshots without running LLM enrichment

Useful flags:

- `--continue`: reuse existing markdown cache and snapshots when fingerprints match
- `--force`: rematerialize source states
- `--rebuild-pdf-markdown`: force all PDF-derived Markdown to be regenerated
- `--pdf-parser <docling|marker|mineru>`

### Stage 2: `llm-optimize`

```bash
papernexus llm-optimize [<path>] [--name <corpus>] [--continue] [--force]
```

Use this when you want to:

- enrich snapshots with LLM semantic extraction
- run relation extraction
- keep PDF and Markdown cache untouched

Useful flags:

- `--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>`
- `--batch-size <n>`
- `--concurrency <n>`
- `--force`: rerun LLM enrichment for all reusable snapshots

### Stage 3: `build-graph`

```bash
papernexus build-graph [<path>] [--name <corpus>] [--continue] [--force]
```

Use this when you want to:

- load semantic snapshots
- build a staged graph
- stop before merge and final commit

### Stage 4: `merge-graph`

```bash
papernexus merge-graph [<path>] [--continue] [--force] [--node-llm-check]
```

Use this when you want to:

- canonicalize similar evaluation nodes
- merge duplicate `Dataset` and `Benchmark` nodes
- optionally run an LLM review pass that can drop or rename low-value evaluation nodes such as `training dataset`

Useful flags:

- `--continue`: reuse the existing staged graph when available
- `--force`: rerun the merge logic
- `--node-llm-check`: optional extra review pass, disabled by default

### Stage 5: `write-index`

```bash
papernexus write-index [<path>] [--continue] [--force] [--node-llm-check]
```

Use this when you want to:

- commit the staged graph into the corpus index
- write the authoritative graph store
- write the lite graph view, metadata, and manifest

If you skip `merge-graph`, `write-index` will automatically run the merge step before commit so older workflows still work.

### `backup-export`

```bash
papernexus backup-export <archive-path> [--corpus <name>]
```

Exports the current single-graph environment into a compressed archive that includes the committed index plus current source inputs.

### `backup-unpack` / `backup-load`

```bash
papernexus backup-unpack <archive-path> --output <dir>
papernexus backup-load <archive-path> --output <dir>
```

Unpacks the archive into an inspectable directory. It does not overwrite the live graph automatically.

## Combined Commands

### `analyze`

```bash
papernexus analyze [<path>] [--name <corpus>] [--continue] [--force]
```

Runs the full pipeline:

1. materialize
2. llm-optimize
3. build-graph
4. merge-graph
5. write-index

Use `--force` when you want a clean rebuild of the corpus pipeline state.

### `optimize`

```bash
papernexus optimize [<path>] [--name <corpus>] [--continue] [--force]
```

Runs stages 2 through 5:

1. llm-optimize
2. build-graph
3. merge-graph
4. write-index

This is useful after Stage 1 already completed and you want to keep reusing markdown cache and snapshots.

## Stage Aliases

These aliases are kept for convenience:

- `stage1` -> `materialize`
- `stage2` -> `llm-optimize`
- `stage3` -> `build-graph`
- `stage4` -> `write-index`

For the current system, `merge-graph` remains an explicit named stage rather than a numeric alias so the merge step stays visible.

## Query And Exploration Commands

These commands read the current corpus, usually through the lite graph index.

```bash
papernexus list
papernexus status [--corpus <name>]
papernexus query "<text>" [--corpus <name>]
papernexus context "<text>" [--corpus <name>]
papernexus impact "<text>" [--corpus <name>] [--direction upstream|downstream]
papernexus ideas "<text>" [--corpus <name>]
papernexus brainstorm "<text>" [--corpus <name>] [--mode diverge|converge]
```

## Enhancement Commands

```bash
papernexus enhance --once [--corpus <name>]
```

This runs the long-horizon enhancement overlays:

- theory
- storyline
- reflection

## Dashboard And Service Commands

```bash
papernexus serve
papernexus service install
papernexus service status
papernexus service uninstall
papernexus logs watch
papernexus backup-export ./papernexus-backup.tgz
papernexus backup-unpack ./papernexus-backup.tgz --output ./restored-papernexus
```

By default, `papernexus service install` installs both:

- `watch`
- `serve`

## Auth, Probe, And Integration Commands

```bash
papernexus auth llm set --provider openai --base-url https://api.openai.com/v1
papernexus probe --provider openai --model gpt-4o-mini --base-url https://api.openai.com/v1
papernexus mcp
papernexus setup
```

Use `auth llm set` to store an API key reference, ideally through macOS Keychain.

## Common Usage Patterns

### Clean First Build

```bash
papernexus analyze --force
```

### Resume An Interrupted Build

```bash
papernexus analyze
```

### Reuse Completed Stage 1 Work

```bash
papernexus llm-optimize --continue --semantic-extraction llm-primary
papernexus build-graph --continue
papernexus merge-graph --continue --node-llm-check
papernexus write-index --continue
```

### Rebuild Only The Final Commit

```bash
papernexus write-index --continue
```

### Watch A Source Folder In Foreground

```bash
papernexus watch
```

This is best for local debugging. For long-lived use, prefer `papernexus service install`.
