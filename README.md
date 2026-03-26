# PaperNexus

PaperNexus is a local-first research knowledge graph system for paper corpora. It ingests PDF or Markdown, materializes reusable paper snapshots, builds a multilayer graph, and exposes that graph through a CLI, local dashboard, MCP server, and background services.

Preferred setup path: run `papernexus init`, then `papernexus analyze --force`.

[Getting Started](docs/getting-started.md) · [CLI Reference](docs/cli-reference.md) · [Configuration](docs/configuration.md) · [Pipeline & Storage](docs/pipeline-and-storage.md) · [Architecture](docs/architecture.md) · [Services & UI](docs/services-and-ui.md) · [Manual Walkthrough](#manual-walkthrough)

## Install

From the project root:

```bash
npm install
npm link
```

If the global command is not found:

```bash
npm bin -g
```

Add that directory to your shell `PATH`.

## Quick Start

Install parser dependencies first:

```bash
pip install docling marker-pdf
```

Run the recommended first-time flow:

```bash
papernexus init
papernexus analyze --force
papernexus serve
```

Then open:

```text
http://127.0.0.1:4821
```

If you want the full background setup:

```bash
papernexus service install
papernexus service status
papernexus logs watch
```

## Most Common Commands

```bash
# Interactive setup
papernexus init

# Full rebuild
papernexus analyze --force

# Incremental rebuild / resume
papernexus analyze

# Stage 1: markdown cache + heuristic snapshots
papernexus materialize --continue

# Stage 2: batched LLM enrichment, dirty-only and cache-first
papernexus llm-optimize --continue --semantic-extraction llm-primary --batch-size 16

# Stage 3: staged graph build
papernexus build-graph --continue

# Stage 4a: merge similar evaluation nodes
papernexus merge-graph --continue

# Merge currently relies on deterministic heuristics only
papernexus merge-graph --continue

# Stage 4b: commit the staged graph
papernexus write-index --continue

# Or run stages 2-5 together
papernexus optimize --continue --semantic-extraction llm-primary

# Query and idea support
papernexus status
papernexus query "experiment planning"
papernexus context "knowledge graph"
papernexus impact "knowledge graph" --direction upstream
papernexus ideas "evidence tracing"
papernexus brainstorm "semi-supervised learning" --mode diverge

# Enhancement overlays
papernexus enhance --once

# Local UI / services
papernexus serve
papernexus service install
papernexus logs watch
```

## Manual Walkthrough

This section folds the old `manual/README.md` into the main entrypoint so you can exercise the full product from top to bottom in one place.

### 1. Open the project root

```bash
cd "/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus"
```

### 2. Install and expose the CLI

```bash
npm install
npm link
papernexus help
```

### 3. Prepare a paper source folder

Recommended default source directory:

```bash
/Users/iranb/.papernexus/papers
```

Create it if needed:

```bash
mkdir -p /Users/iranb/.papernexus/papers
```

You can start with built-in examples:

```bash
mkdir -p /Users/iranb/.papernexus/papers/demo
cp ./examples/*.md /Users/iranb/.papernexus/papers/demo/
```

Or place your own `.md` / `.pdf` papers there.

### 4. Run first-time setup

```bash
papernexus init
```

Recommended answers:

- paper source directory: `/Users/iranb/.papernexus/papers`
- corpus name: a short name such as `demo` or `gcd`
- index directory: `/Users/iranb/.papernexus/index-store`

Default runtime config path:

```bash
/Users/iranb/.papernexus/config.json
```

### 5. Build the first corpus

```bash
papernexus analyze --force
```

This should:

- parse papers or reuse cached Markdown
- build the graph
- write the authoritative graph store and lite index
- enqueue enhancement overlays

### 6. Inspect the corpus

```bash
papernexus list
papernexus status
```

Or for a named corpus:

```bash
papernexus status --corpus <your-corpus-name>
```

### 7. Explore the graph manually

```bash
papernexus query "experiment planning" --corpus <your-corpus-name>
papernexus context "knowledge graph" --corpus <your-corpus-name>
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction upstream
papernexus impact "knowledge graph" --corpus <your-corpus-name> --direction downstream
papernexus ideas "evidence tracing for experiment planning" --corpus <your-corpus-name>
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode diverge
papernexus brainstorm "experiment planning" --corpus <your-corpus-name> --mode converge
```

### 8. Refresh enhancement overlays

```bash
papernexus enhance --once --corpus <your-corpus-name>
```

This populates:

- theory overlay
- storyline overlay
- reflection overlay

### 9. Open the dashboard

```bash
papernexus serve
```

Open:

```text
http://127.0.0.1:4821
```

### 10. Turn on background mode

```bash
papernexus service install
papernexus service status
papernexus logs watch
```

By default this installs:

- `watch` for incremental refresh
- `serve` for dashboard/API and enhancement worker

### 11. Verify dynamic updates

1. Add or edit a paper under `/Users/iranb/.papernexus/papers`
2. Wait a few seconds
3. Run:

```bash
papernexus status --corpus <your-corpus-name>
```

4. Refresh the dashboard

You should see updated graph state and refreshed enhancements.

### 12. Optional: remote Ollama

In `config.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:0.5b",
    "baseUrl": "http://127.0.0.1:11434",
    "sshHost": "your-remote-host",
    "relations": true,
    "batchSize": 8
  }
}
```

Then rerun:

```bash
papernexus analyze --force
```

### 13. Optional: MCP mode

```bash
papernexus mcp
papernexus setup
```

### 14. Optional: exercise reflection-oriented reasoning

1. Run `papernexus enhance --once --corpus <your-corpus-name>`
2. Open the dashboard
3. Inspect `Innovation`, `Experiment`, `Outcome`, and `Reflection`

### 15. What counts as “everything worked”

You’ve exercised the full PaperNexus flow when:

- `papernexus` runs globally
- the corpus indexes without errors
- query/context/impact/ideas/brainstorm return results
- enhancement overlays are generated
- the dashboard opens
- services show as loaded
- adding a paper triggers an incremental update

## Highlights

- PDF and Markdown ingestion with cache-first reuse
- staged pipeline with resumable commands
- optional LLM-assisted semantic extraction and relation extraction
- graph merge stage for duplicate evaluation nodes
- merge-time LLM node deletion is currently disabled; do not rely on `--node-llm-check`
- Kuzu-backed authoritative graph with lite JSON read index
- theory, storyline, and reflection overlays
- local dashboard, MCP server, and macOS background services

## How It Works

```text
papers (.pdf / .md)
  ->
materialize
  ->
llm-optimize
  ->
build-graph
  ->
merge-graph
  ->
write-index
  ->
query / brainstorm / serve / watch / enhance
```

Key idea:

- source files stay under the paper source directory
- reusable markdown cache and semantic snapshots live under the corpus `.papernexus/`
- graph commit is separated from earlier stages so interrupted runs can resume cleanly

## Documentation Map

Use the docs folder for detail pages that were previously embedded in the README:

- [Getting Started](docs/getting-started.md)
  Beginner setup, default paths, first corpus, and common first-run flows.
- [CLI Reference](docs/cli-reference.md)
  Command surface, stage commands, common flags, and examples.
- [Configuration](docs/configuration.md)
  `config.json`, parser selection, LLM config, Keychain, and remote Ollama.
- [Pipeline & Storage](docs/pipeline-and-storage.md)
  Stage semantics, `--continue` / `--force`, cache behavior, merge stage, and storage layout.
- [Architecture](docs/architecture.md)
  Graph model, node types, overlays, and repository layout.
- [Services & UI](docs/services-and-ui.md)
  Dashboard, `watch`, `serve`, `logs watch`, MCP, and service lifecycle.

## Development

Core files:

- `src/cli/index.js`
- `src/core/ingestion/pipeline.js`
- `src/core/llm/ollama.js`
- `src/storage/corpus-store.js`
- `src/core/enhancements/worker.js`
- `src/server/http.js`

Common verification commands:

```bash
node --test test/workflow.test.js
node --test test/materialize-optimize.test.js
node --test test/staged-pipeline.test.js
node --test test/merge-graph-stage.test.js
```
