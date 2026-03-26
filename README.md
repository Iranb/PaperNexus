# PaperNexus

PaperNexus is a local-first research knowledge graph framework for academic papers. It ingests PDFs or Markdown, extracts structured research entities, builds an explicit multilayer graph, and exposes that graph through a CLI, MCP server, and visual web workspace.

It is designed for the same style of workflow that GitNexus enables for code:

- precompute structure once
- reuse it across agents and tools
- traverse relationships instead of repeatedly rediscovering context

## Most Common Commands

If you have not registered the CLI yet, do this first from the project root:

```bash
npm link
```

After that, these are the commands most users will use first:

```bash
# Create or update config.json interactively
papernexus init

# Build or rebuild the corpus
papernexus analyze --force

# Prepare markdown cache + heuristic snapshots only
papernexus materialize

# Run Stage 2 only: batch LLM optimization on prepared snapshots
papernexus llm-optimize

# Run Stage 3 only: build a staged graph from current snapshots
papernexus build-graph

# Run the merge stage only: canonicalize near-duplicate datasets/benchmarks
papernexus merge-graph

# Run Stage 4 only: commit the staged graph into the index
papernexus write-index

# Run stages 2-4 together on top of prepared snapshots
papernexus optimize

# Resume a previously interrupted analyze run when possible
papernexus analyze

# Run the dashboard + background watch service on macOS
papernexus service install

# Check service status
papernexus service status

# Read the automatic graph-build log written by watch/service mode
papernexus logs watch

# Inspect the current corpus
papernexus status

# Search the graph
papernexus query "experiment planning"

# Open the local dashboard in the foreground
papernexus serve
```

Recommended day-one flow:

```bash
papernexus init
papernexus materialize --continue
papernexus llm-optimize --continue
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
papernexus service install
papernexus logs watch
papernexus status
```

## Quick Start

Install dependencies first:

```bash
pip install docling marker-pdf
```

Register the global CLI once:

```bash
npm link
```

Create a first-run config interactively:

```bash
papernexus init
```

Build the included example corpus:

```bash
papernexus analyze ./examples --name sample-papers
```

Try a few graph queries:

```bash
papernexus query "experiment planning" --corpus sample-papers
papernexus context "knowledge graph" --corpus sample-papers
papernexus ideas "evidence tracing for experiment planning" --corpus sample-papers
```

Open the local visual workspace:

```bash
papernexus serve
```

Then visit [http://127.0.0.1:4821](http://127.0.0.1:4821).

Once that flow works, point `analyze` at your own paper folder:

```bash
papernexus analyze ./papers --name my-corpus
```

Or run the staged pipeline independently:

```bash
papernexus materialize ./papers --name my-corpus --continue
papernexus llm-optimize ./papers --name my-corpus --continue --semantic-extraction llm-primary
papernexus build-graph ./papers --name my-corpus --continue
papernexus merge-graph ./papers --continue
papernexus write-index ./papers --continue
```

## What PaperNexus Does

PaperNexus currently supports:

- indexing local paper corpora from `PDF` or `Markdown`
- converting PDFs to Markdown via [Docling](https://docling-project.github.io/docling/) by default, with [Marker](https://github.com/datalab-to/marker) as a switchable alternative
- dynamic incremental rebuilds with per-paper semantic snapshots
- split pipeline stages so markdown materialization, LLM snapshot optimization, graph build, similar-node merge, and final index commit can run independently with cache-first resume behavior
- `watch` mode for continuous corpus monitoring
- an explicit multilayer research graph for topic mapping and idea generation
- semantic search, context lookup, and upstream/downstream impact traversal
- research idea generation and diverge/converge brainstorming
- optional LLM-assisted relation extraction and cross-paper relation adjudication via Ollama, OpenAI-compatible chat-completions APIs, and Anthropic Claude
- macOS Keychain-backed local encrypted storage for LLM API keys via CLI
- schema-aware graph mutation with dry-run previews
- local MCP tools, resources, and prompts
- a local visual graph UI with filters, inspector panels, and auto-refresh
- serve-side corpus caching plus atomic index writes with single-writer locks for safer concurrent access

## Current Graph Model

The current implementation is centered on a research-opportunity graph rather than the older `Domain / Story / Experiment` framing.

### Node Types

- `Corpus`
- `Paper`
- `Problem`
- `Method`
- `Claim`
- `Finding`
- `Limitation`
- `Assumption`
- `Evidence`
- `Dataset`
- `Benchmark`
- `Metric`
- `FutureDirection`

### Layers

- `CorpusLayer`
- `DocumentLayer`
- `ProblemLayer`
- `MethodLayer`
- `ClaimLayer`
- `ConstraintLayer`
- `EvidenceLayer`
- `EvaluationLayer`
- `FutureLayer`

### Relationship Types

- `CONTAINS`
- `SOLVES`
- `USES`
- `EVALUATES_ON`
- `BENCHMARKED_ON`
- `REPORTS`
- `REPORTS_FINDING`
- `CLAIMS`
- `HAS_LIMITATION`
- `ASSUMES`
- `SUGGESTS_FUTURE`
- `SUPPORTED_BY`
- `OBSERVED_ON`
- `MEASURED_BY`
- `APPLIES_TO`
- `TRANSFERABLE_TO`
- `REQUIRES`
- `DEPENDS_ON`
- `FAILS_UNDER`
- `HAS_GAP`
- `RELATED_TO`
- `SIMILAR_TO`
- `COMPATIBLE_WITH`
- `COMBINES_WITH`
- `MAY_BE_ADDRESSED_BY`
- `CONTRADICTS`
- `CITES`

This structure is aimed at workflows such as:

- literature review and topic mapping
- claim tracing and evidence inspection
- method transfer analysis
- limitation-driven idea discovery
- innovation composition and brainstorming

## Project Layout

```text
PaperNexus/
  src/
    cli/              # CLI entrypoint
    core/
      graph/          # Graph schema, storage, rules, mutations
      ingestion/      # Marker wrapper, markdown parser, incremental pipeline
      llm/            # Ollama-assisted extraction and relation adjudication
      search/         # Query, context, impact, ideas, brainstorming
    mcp/              # MCP tools, prompts, resources, stdio server
    server/           # Local HTTP API and UI server
    storage/          # Corpus storage and registry
  web/                # Visual graph workspace
  examples/           # Markdown fixtures for offline validation
  test/               # End-to-end and unit tests
```

## Requirements

- Node.js `20+`
- Python `3.10+`
- Docling installed locally for default PDF ingestion

PaperNexus now supports switchable PDF parsers.

- default parser: `docling`
- alternative parser: `marker`

Install both if you want the easiest local setup:

```bash
pip install docling marker-pdf
```

Default Docling command:

```bash
docling /path/to/file.pdf --image-export-mode referenced --output <dir>
```

Marker is still supported with:

```bash
marker_single /path/to/file.pdf --output_format markdown --output_dir <dir>
```

If local parsing fails and you have a remote machine that can read the PDF, you can use `--docling-ssh-host`, `--marker-ssh-host`, or `--pdf-ssh-host` as a fallback extraction path.

## CLI Usage

### 1. Register `papernexus` As a Global Command

From the project root, register the CLI so you can call `papernexus` directly in the terminal:

```bash
# Recommended during development: link the current checkout
npm link

# Alternative: install this local checkout globally
npm install -g .
```

After that, you can run `papernexus` directly instead of `node ./src/cli/index.js`:

```bash
papernexus init
papernexus analyze ./papers --name my-corpus
papernexus serve
```

If `papernexus` is not found after linking, check that your npm global bin directory is on `PATH`:

```bash
npm bin -g
```

### 2. Most Common CLI Flow

```bash
# Create or update config.json interactively
papernexus init

# Build or fully rebuild the current corpus
papernexus analyze --force

# Resume an interrupted analyze run when snapshots already exist
papernexus analyze

# Install the recommended background mode on macOS
papernexus service install

# Inspect the automatic graph-build log
papernexus logs watch

# Check the current corpus and dashboard/service status
papernexus status

# List indexed corpora
papernexus list

# Inspect one corpus
papernexus status --corpus my-corpus

# Semantic graph search
papernexus query "retrieval augmented experiment planning" --corpus my-corpus

# Inspect a node neighborhood
papernexus context "knowledge graph" --corpus my-corpus

# Traverse upstream or downstream impact
papernexus impact "semi-supervised learning" --corpus my-corpus

# Generate research opportunities
papernexus ideas "experiment planning with evidence tracing" --corpus my-corpus

# Brainstorm candidate directions
papernexus brainstorm "semi-supervised learning" --corpus my-corpus --mode diverge

# Serve the local web UI
papernexus serve
```

### 3. Additional CLI Control

```bash
# Index PDFs or Markdown from an explicit path into a local corpus
papernexus analyze ./papers --name my-corpus

# Watch a corpus and incrementally rebuild on changes
papernexus watch ./papers --name my-corpus

# Store an OpenAI-compatible API key in macOS Keychain
papernexus auth llm set --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1

# Start the local MCP server
papernexus mcp
```

For long-running use on macOS, the recommended background mode is:

```bash
papernexus service install
```

By default this installs both:

- `watch` to monitor paper directory changes and keep the corpus incrementally updated
- `serve` to run the local dashboard/API and background enhancement worker

When `watch` is running, PaperNexus also writes automatic graph-build activity to a stable tmp log file. `papernexus service install` prints the exact path, and direct `papernexus watch` runs print it on startup.

You can still override the default explicitly:

```bash
papernexus service install --services watch
papernexus service install --services serve
papernexus service install --services watch,serve
```

### Commands

- `analyze <path>`
- `init`
- `watch <path>`
- `list`
- `status`
- `query <text>`
- `context <name-or-id>`
- `impact <name-or-id>`
- `ideas <topic>`
- `brainstorm <topic>`
- `clean`
- `logs watch`
- `auth llm set`
- `auth llm clear`
- `setup`
- `serve`
- `mcp`

### Useful Flags

- `--name <corpus>`
- `--force`
- `--continue`
- `--concurrency <n>`
- `--batch-size <n>`
- `--config <path>`
- `--no-config`
- `--semantic-extraction <heuristic-only|llm-assisted|llm-primary>`
- `--pdf-parser <docling|marker>`
- `--rebuild-pdf-markdown`
- `--pdf-cmd <cmd>`
- `--pdf-parser-ssh-host <host>`
- `--docling-cmd <cmd>`
- `--docling-ssh-host <host>`
- `--docling-ocr-engine <name>`
- `--marker-cmd <cmd>`
- `--marker-ssh-host <host>`
- `--marker-concurrency <n>`
- `--mineru-remote-failure <error|docling>`
- `--page-range <pages>`
- `--pdf-ssh-host <host>`
- `--watch`
- `--debounce-ms <ms>`
- `--poll-interval-ms <ms>`
- `--limit <n>`
- `--layers <csv>`
- `--layer-mode any|intra|cross`
- `--direction upstream|downstream`
- `--depth <n>`
- `--mode diverge|converge`
- `--hops <n>`
- `--host <host>`
- `--port <port>`
- `--provider <name>`
- `--base-url <url>`
- `--batch-size <n>`
- `--service <name>`
- `--account <name>`
- `--stdin`

### First-Run Wizard

Run:

```bash
papernexus init
```

The wizard asks for:

- paper source directory or directories
- corpus name
- index storage directory
- optional LLM provider, model, and base URL
- optional macOS Keychain setup for API-key providers

It then writes a usable `config.json` so the next step can be as short as:

```bash
papernexus materialize --continue
papernexus optimize --continue
```

### Legacy Ollama Flags

PaperNexus still supports the original Ollama CLI flags for backwards compatibility.

- `--ollama-model <name>`
- `--ollama-url <url>`
- `--ollama-relations`
- `--ollama-ssh-host <host>`
- `--ollama-timeout-ms <ms>`
- `--ollama-batch-size <n>`

Example:

```bash
papernexus analyze ./papers \
  --name ml-papers \
  --ollama-model qwen2.5:0.5b \
  --ollama-relations
```

For new multi-provider setups, prefer the `llm` section in `config.json` described below.

## Config File

PaperNexus can load a local `config.json` from the current working directory. This is useful when you want to keep frequently changed runtime options outside the codebase and avoid repeating long CLI commands.

Precedence is:

```text
CLI flags > config.json > environment variables > built-in defaults
```

You can also pass an explicit file path:

```bash
node ./src/cli/index.js analyze ./papers --config ./config.json
```

Or ignore the config file for one run:

```bash
node ./src/cli/index.js analyze ./papers --no-config
```

Example `config.json`:

```json
{
  "sources": {
    "inputs": ["./papers-a", "./papers-b"]
  },
  "storage": {
    "home": ".papernexus-home",
    "indexDir": "./index-store",
    "backupDir": "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/PaperNexusBackups"
  },
  "global": {
    "corpus": "sample-papers"
  },
  "analyze": {
    "name": "sample-papers",
    "concurrency": 8,
    "semanticExtraction": "heuristic-only",
    "rebuildPdfMarkdown": false,
    "pdfParser": "docling",
    "doclingCommand": "docling",
    "doclingOcrEngine": "ocrmac",
    "doclingSshHost": "your-docling-host",
    "pdfCommand": "docling",
    "markerCommand": "marker_single",
    "markerSshHost": "your-marker-host",
    "markerConcurrency": 4,
    "mineruRemoteFailureMode": "error",
    "pageRange": "0-5",
    "pdfSshHost": "your-ssh-host",
    "debounceMs": 700,
    "pollIntervalMs": 3000
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeySource": "keychain",
    "apiKeyService": "papernexus.llm",
    "apiKeyAccount": "openai:https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "relations": true,
    "timeoutMs": 45000,
    "batchSize": 8,
    "maxTokens": 2048
  },
  "query": {
    "limit": 5
  },
  "impact": {
    "direction": "upstream",
    "depth": 3,
    "layerMode": "cross"
  },
  "brainstorm": {
    "mode": "converge",
    "hops": 2,
    "limit": 5
  },
  "serve": {
    "host": "127.0.0.1",
    "port": 4821
  }
}
```

### LLM-Assisted Semantic Extraction

PaperNexus can now use an LLM to extract paper-local semantic objects before graph projection.

`analyze` and `analyze --force` are both cache-first now:

- every source records its markdown cache path, fingerprint, and refresh status in the source manifest
- if the source fingerprint is unchanged, PaperNexus rebuilds from the cached markdown copy instead of re-decoding the PDF
- `--force` still rebuilds the graph and reruns semantic extraction, but it prefers the cached markdown unless the source file itself changed

Supported modes:

- `heuristic-only`
- `llm-assisted`
- `llm-primary`

Recommended starting point:

```bash
papernexus analyze ./papers \
  --name my-corpus \
  --semantic-extraction llm-assisted \
  --concurrency 8 \
  --batch-size 8 \
  --provider openai \
  --model gpt-4o-mini
```

Config example:

```json
{
  "analyze": {
    "semanticExtraction": "llm-assisted",
    "concurrency": 8
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "relations": true,
    "batchSize": 8
  }
}
```

If your LLM provider supports large throughput, increase both worker parallelism and batch size explicitly:

```bash
papernexus analyze ./papers \
  --name my-corpus \
  --concurrency 16 \
  --batch-size 16
```

What this changes:

- `Problem`, `Method`, and `Claim` names can be normalized by the LLM
- the model can also extract `Finding`, `Limitation`, `Assumption`, `Evidence`, `FutureDirection`, `Benchmark`, `Dataset`, and `Metric` candidates
- semantic extraction and per-paper relation optimization can now be sent in batch during `analyze`
- outputs are still projected into the existing graph schema, so the workflow stays incremental and non-blocking

### Split Materialize / Optimize Workflow

If you want PDF conversion and LLM optimization to run as separate resumable stages, use:

```bash
papernexus materialize ./papers --name my-corpus --continue
papernexus optimize ./papers --name my-corpus --continue --semantic-extraction llm-primary --batch-size 16
```

This workflow is useful when:

- PDF parsing is expensive and you want to finish it first
- you want `continue`-style resume behavior for both stages
- you want to batch LLM requests after all markdown caches and semantic snapshots are ready

`papernexus materialize`:

- refreshes markdown cache and paper snapshots
- skips LLM extraction
- does not require the remote LLM to be available

`papernexus optimize`:

- reuses prepared markdown cache and snapshots
- batches LLM semantic extraction and per-paper relation optimization
- then builds the staged graph, merges near-duplicate evaluation nodes, and writes the index

### Split Staged Graph Workflow

If you want full manual control over the staged graph path, use:

```bash
papernexus materialize ./papers --name my-corpus --continue
papernexus llm-optimize ./papers --name my-corpus --continue --semantic-extraction llm-primary --batch-size 16
papernexus build-graph ./papers --name my-corpus --continue
papernexus merge-graph ./papers --continue
papernexus write-index ./papers --continue
```

Stage behavior:

- `materialize`: markdown cache + heuristic snapshots
- `llm-optimize`: batched LLM semantic objects and relation extraction
- `build-graph`: project snapshots into a staged graph artifact
- `merge-graph`: canonicalize near-duplicate `Dataset` / `Benchmark` nodes such as `Office-Home dataset` vs `Office Home benchmarks`
- `write-index`: commit the staged graph into the authoritative graph store and lite view

Resume semantics:

- `--continue` reuses the cached output of that stage when it is still fresh
- `--force` reruns that stage
- `write-index` remains backward-compatible: if a merge step was not run explicitly, it will auto-merge the staged graph before committing

### PDF Parser Selection

PaperNexus can switch between PDF parsers per run or in config.

Use the default Docling parser:

```bash
papernexus analyze ./papers --name my-corpus --pdf-parser docling
```

Use Docling with the macOS local OCR engine:

```bash
papernexus analyze ./papers --name my-corpus --pdf-parser docling --docling-ocr-engine ocrmac
```

Use Marker for a specific run:

```bash
papernexus analyze ./papers --name my-corpus --pdf-parser marker --marker-cmd marker_single
```

Run Docling on a remote server:

```bash
papernexus analyze ./papers --name my-corpus --pdf-parser docling --docling-ssh-host your-server
```

If you want this to be the default in config, set:

```json
{
  "analyze": {
    "pdfParser": "docling",
    "doclingCommand": "docling",
    "doclingOcrEngine": "ocrmac"
  }
}
```

When using `mineru` with a remote HTTP backend, PaperNexus now probes the endpoint before parsing. If the backend is unreachable, the default behavior is to stop with a warning instead of silently continuing. You can opt into automatic fallback with:

```bash
papernexus analyze ./papers --pdf-parser mineru --mineru-http-url http://host:30000 --mineru-remote-failure docling
```

If you need to forcibly regenerate every PDF-derived markdown cache, add:

```bash
papernexus analyze ./papers --force --rebuild-pdf-markdown
```

If you need page-range control, use Marker:

```bash
papernexus analyze ./papers --name my-corpus --pdf-parser marker --page-range 0-5
```

### LLM Provider Config

The preferred provider configuration lives under `llm`.

Supported `llm.provider` values:

- `ollama`
- `openai`
- `anthropic`
- `claude`
- `claudecode`

`claude` and `claudecode` are treated as Anthropic Claude-compatible providers and use the Anthropic Messages API.

OpenAI example:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "relations": true
  }
}
```

OpenAI-compatible DashScope example:

```json
{
  "llm": {
    "provider": "openai",
    "model": "qwen-plus",
    "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
    "apiKeySource": "keychain",
    "apiKeyService": "papernexus.llm",
    "apiKeyAccount": "openai:https://coding.dashscope.aliyuncs.com/v1",
    "relations": true
  }
}
```

Anthropic Claude example:

```json
{
  "llm": {
    "provider": "claudecode",
    "model": "claude-3-5-sonnet-latest",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "relations": true,
    "maxTokens": 2048
  }
}
```

Ollama example:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:0.5b",
    "baseUrl": "http://127.0.0.1:11434",
    "relations": true,
    "batchSize": 8,
    "sshHost": "your-remote-host"
  }
}
```

### Remote Ollama Deployment

If your Ollama server is deployed on a remote machine, there are two common ways to use it:

1. Direct HTTP access

Use this when the remote Ollama API is already reachable from your local machine:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:0.5b",
    "baseUrl": "http://your-remote-host:11434",
    "relations": true,
    "batchSize": 8
  }
}
```

2. SSH-wrapped remote access

Use this when you want PaperNexus to execute the Ollama request through SSH on the remote host:

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

In the SSH-wrapped mode:

- `sshHost` is the machine that runs Ollama
- `baseUrl` is the Ollama URL as seen from that remote machine, which is usually `http://127.0.0.1:11434`
- your local machine must be able to run `ssh your-remote-host`

You can also configure the same thing from the CLI for a one-off run:

```bash
papernexus analyze ./papers \
  --name my-corpus \
  --ollama-model qwen2.5:0.5b \
  --ollama-url http://127.0.0.1:11434 \
  --ollama-relations \
  --ollama-ssh-host your-remote-host
```

If you want this to persist, write the values into `config.json` and then use the normal commands:

```bash
papernexus analyze --force
papernexus watch
papernexus service install
```

The older top-level `ollama` config block is still supported for backwards compatibility, but `llm` is now the primary path.

### Encrypted API Key Storage

On macOS, PaperNexus can keep API keys in the system Keychain instead of storing them in plain text inside `config.json`.

Set a key interactively:

```bash
papernexus auth llm set --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1
```

Or pipe a key in non-interactively:

```bash
printf '%s' "$DASHSCOPE_API_KEY" | papernexus auth llm set --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1 --stdin
```

Clear the stored binding:

```bash
papernexus auth llm clear --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1
```

After `auth llm set`, PaperNexus updates `config.json` to point at:

- `llm.apiKeySource = "keychain"`
- `llm.apiKeyService`
- `llm.apiKeyAccount`

The actual secret stays in macOS Keychain. At runtime, PaperNexus resolves keys in this order:

- `llm.apiKey`
- Keychain when `llm.apiKeySource` is `keychain`
- `llm.apiKeyEnv`
- provider default env vars such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

When the Web UI is running, you can also view the current `provider / model` in the top bar and switch it there. The UI writes the change back to `config.json`. Any currently running `analyze` or `watch` process should be restarted to pick up the new provider.

If `sources.inputs` is set, `analyze` and `watch` can run without a positional path:

```bash
node ./src/cli/index.js analyze --force
node ./src/cli/index.js watch
```

`sources.inputs` is resolved relative to the config file location. When multiple inputs are used, the corpus index is currently written under the working corpus root, which for config-driven multi-input runs is the config directory itself.

If `storage.indexDir` is set, the corpus index is written under that directory instead. In other words, PaperNexus will place its `.papernexus/` folder inside `storage.indexDir` instead of next to the source papers.

If `storage.backupDir` is set, the Web UI backup action writes timestamped corpus snapshots there. This is a good place to point at an iCloud-backed folder when you want one-click off-device backups without making iCloud the live index store.

Supported top-level sections are:

- `sources`
- `storage`
- `global`
- `analyze`
- `watch`
- `llm`
- `query`
- `context`
- `impact`
- `ideas`
- `brainstorm`
- `serve`
- `ollama` (legacy compatibility)

## Incremental Storage Model

PaperNexus keeps everything local and file-based:

- corpus graph: `.papernexus/graph.kuzu` by default, or `.papernexus/graph.json` when `PAPERNEXUS_GRAPH_BACKEND=json`
- lite graph index: `.papernexus/graph.lite.json`
- corpus metadata: `.papernexus/meta.json`
- source manifest: `.papernexus/sources.json`
- per-paper semantic snapshots: `.papernexus/papers/*.json`
- converted markdown cache: `.papernexus/markdown/<parser>/`
- parser run output workspace: `.papernexus/marker/`
- global registry: `~/.papernexus/registry.json`

Use `PAPERNEXUS_GRAPH_BACKEND=json` to force the legacy JSON graph store, or leave it unset to auto-select Kuzu when the package is available.

No database server is required.

Concurrency notes:

- the local web server caches corpus payloads in memory and refreshes them when a new index is published
- index JSON writes use atomic temp-file replacement instead of in-place overwrite
- corpus and registry updates use single-writer file locks so concurrent write attempts serialize instead of clobbering each other

If `~/.papernexus` is not writable, PaperNexus falls back to a local `.papernexus-home/` directory under the current working directory. You can also pin the registry location explicitly with:

```bash
PAPERNEXUS_HOME=/path/to/home
```

## MCP Usage

Start the stdio server:

```bash
node ./src/cli/index.js mcp
```

### Tools

- `list_corpora`
- `corpus_status`
- `query`
- `context`
- `impact`
- `ideas`
- `brainstorm`
- `mutate_graph`

`mutate_graph` supports schema-aware create, update, and delete operations for nodes and relationships, with `dryRun: true` previews before saving.

### Resources

- `papernexus://corpora`
- `papernexus://corpus/{name}/context`
- `papernexus://corpus/{name}/problems`
- `papernexus://corpus/{name}/claims`
- `papernexus://corpus/{name}/findings`
- `papernexus://corpus/{name}/methods`
- `papernexus://corpus/{name}/benchmarks`
- `papernexus://corpus/{name}/limitations`
- `papernexus://corpus/{name}/assumptions`
- `papernexus://corpus/{name}/futures`

### Prompts

- `survey_literature`
- `trace_claim`
- `generate_research_ideas`
- `brainstorm_topic`

### Setup Snippets

Print editor MCP config snippets with:

```bash
node ./src/cli/index.js setup
```

## Web UI

PaperNexus includes a local visual workspace for browsing indexed corpora.

Features include:

- corpus switcher
- top-bar display of the current LLM provider and model
- in-UI LLM provider/model switching with config.json persistence
- one-click corpus backup from the top bar
- graph overview and corpus stats
- searchable node focus
- filter presets for full graph, research core, evidence lens, and transfer paths
- filters by node type, layer, and relationship type
- graph pan, zoom, fit, and focus controls
- left-hand navigator by semantic category
- right-hand inspector for node details and impact context
- automatic metadata polling and refresh when the corpus is reindexed

Start it with:

```bash
node ./src/cli/index.js serve
```

By default the UI is served at [http://127.0.0.1:4821](http://127.0.0.1:4821).

The usual flow is:

```bash
node ./src/cli/index.js analyze ./papers --name my-corpus
node ./src/cli/index.js serve
```

## Example Workflow

Use the included Markdown fixtures first:

```bash
node ./src/cli/index.js analyze ./examples --name sample-papers
node ./src/cli/index.js query "experiment planning" --corpus sample-papers
node ./src/cli/index.js context "knowledge graph" --corpus sample-papers
node ./src/cli/index.js impact "experiment planning" --corpus sample-papers --layers ProblemLayer,MethodLayer --layer-mode cross
node ./src/cli/index.js ideas "evidence tracing for experiment planning" --corpus sample-papers
node ./src/cli/index.js brainstorm "experiment planning" --corpus sample-papers --mode converge --hops 2
```

After that, point the analyzer at a folder of PDFs and it will invoke Marker automatically.

## Validation

The current test suite covers:

- CLI end-to-end analysis and brainstorming
- MCP initialization, tools, prompts, and resources
- graph mutations
- Ollama output sanitization
- multilayer graph construction and traversal

Run the tests with:

```bash
node --test
```
