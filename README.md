<p align="center">
  <strong style="font-size:2em;">PaperNexus</strong>
</p>

<p align="center">Local-first research knowledge graph for paper corpora, literature discovery, method evolution, and evidence-grounded research intelligence.</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" />
  <img src="https://img.shields.io/badge/storage-local--first-0f766e" />
  <img src="https://img.shields.io/badge/interface-CLI%20%7C%20Web%20%7C%20MCP-2563eb" />
  <img src="https://img.shields.io/badge/license-custom%20MIT-1f2937" />
</p>

<p align="center">
  <a href="docs/index.md">Docs</a> |
  <a href="docs/get-started/index.md">Get Started</a> |
  <a href="docs/pipeline/index.md">Pipeline</a> |
  <a href="docs/graph/index.md">Graph</a> |
  <a href="docs/interfaces/index.md">Interfaces</a> |
  <a href="docs/reference/index.md">Reference</a>
</p>

---

## News

- `2026-05-09` Added a NeurIPS-style technical report source under `papers/`, with an arXiv-ready source package workflow.
- `2026-05-09` Added a literature-discovery backbone with query planning, provider aggregation, legal full-text resolution, coverage reporting, and import-queue bridging.
- `2026-05-09` Added method-evolution evidence: method registry, citation-context validation, typed method-to-method edges, lineage lookup, and method evidence APIs.
- `2026-04-07` Added remote streamable HTTP MCP support on top of `papernexus serve`.
- `2026-04-07` Added PaddleOCR-VL parser integration and remote parser runtime support.

---

## What Is PaperNexus?

PaperNexus turns paper sources into a reusable research knowledge graph. Its core pipeline ingests PDF or Markdown files you provide, materializes cacheable semantic snapshots, builds a typed multilayer graph, and exposes that graph through a CLI, browser dashboard, authenticated HTTP APIs, local stdio MCP, remote HTTP MCP, and Python helper scripts. It also includes an explicit MCP `literature_discovery` bridge for bounded fresh search, legal source resolution, and optional import submission.

> PaperNexus is not just a paper folder or an embedding index. Its core artifact is an inspectable graph of papers, problems, methods, claims, evidence, datasets, benchmarks, ideas, and method-evolution relationships.

**Local-first**: source files, snapshots, graph stores, import queues, and discovery artifacts live on your machine.

**Graph-native**: research questions, method lineage, cross-domain evidence, impact, context, ideas, and brainstorming operate over committed graph state.

**Discovery-aware**: fresh topic search is a separate MCP workflow. Discovery artifacts exist before graph ingestion, and graph tools only see newly found papers after import tasks and graph sync complete.

**Evidence-aware**: method-evolution edges require citation context, exact quotes, temporal checks, confidence, and evidence completeness gates.

**Interface-complete**: CLI for operators, Web UI for inspection, HTTP APIs for apps, and MCP tools for agents.

**Recoverable**: staged analysis, dirty-only rebuilds, import queues, retry/quarantine, backup export, and backup unpack are first-class workflows.

## Quick Start

```bash
npm install
npm link
python -m pip install -U markitdown

papernexus init
papernexus analyze --force
papernexus serve
```

Open the local dashboard:

```text
http://127.0.0.1:4821
```

If the global command is not found, inspect your global npm binary directory and add it to `PATH`:

```bash
npm bin -g
```

## Core Capabilities

**Corpus ingestion**

- PDF and Markdown ingestion with cache-first reuse.
- MarkItDown as the default parser path, with Docling fallback for failed or weak parses.
- Optional parser backends: MarkPDFDown, OpenDataLoader, Docling, Marker, MinerU, and PaddleOCR-VL.
- Import queue for uploaded `pdf/md` files, with per-task logs and resumable worker state.

**Literature discovery**

- MCP-only topic-to-candidate workflow with query planning, bounded provider execution, merge, optional citation expansion, source resolution, and coverage reporting.
- Default provider support for OpenAlex, Semantic Scholar, Crossref, and arXiv, with implemented opt-in providers for DBLP, Europe PMC/PubMed alias, CORE, papers.cool, and PASA. Unpaywall is used during DOI source resolution rather than as a general search provider.
- Legal full-text handling with explicit statuses such as `open_pdf`, `needs_institution`, `no_open_pdf`, `anti_bot_blocked`, and `html_not_pdf`.
- Discovery artifacts include `discovery.json`, `report.md`, `download-manifest.json`, and `latest.json`.
- Import submission is explicit: use `importResolved`, `processImports`, or `import_workflow`, then wait for completed graph sync before treating results as graph evidence.
- Broad or long-running discovery should use `operation=submit` plus `progress`/`report` polling; a client timeout after submit is an unknown state, not success.

**Knowledge graph**

- Typed graph layers for papers, problems, methods, claims, evidence, datasets, benchmarks, takeaways, idea fragments, and future directions.
- Staged graph build, graph merge, authoritative graph commit, lite read projection, and generated graph metadata.
- Kuzu-backed authoritative storage when available, JSON fallback storage, and a lightweight read-optimized lite view.

**Research intelligence**

- Graph-only research lookup paths with `queryTimeLlmCalls: 0`.
- Cross-domain evidence, method lineage, method evidence, method registry, and unified research answers.
- Idea catalyst, challenge graph, domain bridge, analogy, brainstorm, and interdisciplinary ranking helpers.

**Operations**

- Browser dashboard, local MCP, remote HTTP MCP, authenticated HTTP routes, macOS background services, logs, backup export, and backup unpack.
- Python wrapper scripts for remote import, queue inspection, timeout-resilient discovery ledgers, graph queries, paper index lookup, research chains, and stage sync.

## System Workflow

```text
papers (.pdf / .md)
  -> materialize
  -> llm-optimize
  -> build-graph
  -> merge-graph
  -> write-index
  -> query / answer / brainstorm / serve / MCP
```

Fresh literature search is an optional upstream bridge, not an implicit part of `analyze`:

```text
literature_discovery search/run or submit -> progress/report
  -> discovery artifacts and legal source-resolution status
  -> optional importResolved / import_workflow
  -> import worker + graph sync
  -> query / answer / agent_materials over committed graph state
```

Key storage rule:

- Source files stay under the configured paper source directory.
- Markdown cache, parser metadata, source manifests, semantic snapshots, queues, and graph artifacts live under the PaperNexus storage layout.
- Graph commit is separated from earlier stages so interrupted runs can resume cleanly.

## Capability Matrix

| Area | Main entry points | Output |
|------|-------------------|--------|
| Setup | `papernexus init`, `papernexus setup`, `papernexus apikey` | Runtime config and secure LLM credentials |
| Corpus build | `analyze`, `materialize`, `llm-optimize`, `build-graph`, `merge-graph`, `write-index` | Snapshots, graph store, lite index |
| Import queue | `papernexus imports`, Web upload API, Python import scripts | Import tasks, logs, recovered source files |
| Discovery | MCP `literature_discovery` | Candidate lists, source-resolution status, manifests, optional import tasks |
| Graph lookup | `query`, `context`, `impact`, `answer` | Evidence-backed graph results |
| Ideation | `ideas`, `brainstorm`, `catalyst` | Idea fragments, cross-domain mechanisms, research packets |
| Serving | `serve`, HTTP API, Web UI, remote MCP | Local dashboard and agent control plane |
| Operations | `watch`, `enhance`, `service`, `logs`, `backup-export` | Background refresh, overlays, archives |

## Install

From the project root:

```bash
npm install
npm link
```

Default parser dependency:

```bash
python -m pip install -U markitdown
```

Optional parser dependencies:

```bash
python -m pip install -U markpdfdown
python -m pip install -U opendataloader-pdf
pip install docling marker-pdf
python -m pip install -U "paddleocr[doc-parser]"
```

## Configuration

The default runtime config lives at:

```text
~/.papernexus/config.json
```

This repository ships a portable template:

```bash
cp ./config.example.json ~/.papernexus/config.json
```

Minimal default parser and LLM config:

```json
{
  "analyze": {
    "pdfParser": "markitdown",
    "pythonCommand": "python3",
    "doclingCommand": "docling",
    "doclingDevice": "cuda",
    "doclingImageExportMode": "placeholder",
    "doclingPreload": true,
    "doclingUseVlm": false
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

If Docling should reuse a shared model cache or pin a GPU:

```json
{
  "analyze": {
    "doclingCudaVisibleDevices": "0",
    "doclingArtifactsPath": "/path/to/docling/models"
  }
}
```

## Common Commands

```bash
# Interactive setup
papernexus init

# Full rebuild
papernexus analyze --force

# Incremental rebuild / resume
papernexus analyze

# Stage-by-stage rebuild
papernexus materialize --continue
papernexus llm-optimize --continue --semantic-extraction llm-primary --batch-size 16
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue

# Query and research intelligence
papernexus status
papernexus query "experiment planning"
papernexus context "knowledge graph"
papernexus impact "knowledge graph" --direction upstream
papernexus answer "reduce confirmation bias during tutoring feedback" --mode cross_domain_evidence --target-domain Education
papernexus answer --method Transformer --mode method_lineage --direction backward

# Ideation
papernexus ideas "evidence tracing"
papernexus brainstorm "semi-supervised learning" --mode diverge
papernexus catalyst --target-domain Education --challenge "reduce confirmation bias during tutoring feedback"

# Import queue
papernexus imports status
papernexus imports running
papernexus imports log --task-id <task-id>

# Dashboard, services, logs
papernexus serve
papernexus service install
papernexus service status
papernexus logs watch

# Backup
papernexus backup-export
papernexus backup-export ./papernexus-backup.tgz
papernexus backup-unpack ./papernexus-backup.tgz --output ./restored-papernexus
```

## MCP And HTTP

Local stdio MCP:

```bash
papernexus mcp
```

Remote HTTP MCP uses the same server as the dashboard. Add this to `config.json`:

```json
{
  "serve": {
    "host": "0.0.0.0",
    "port": 4821,
    "apiToken": "replace-with-your-api-token",
    "mcp": {
      "enabled": true,
      "path": "/mcp",
      "transport": "streamable-http",
      "allowSseFallback": false
    }
  }
}
```

Then start:

```bash
papernexus serve
```

Client target:

```text
http://<host>:4821/mcp
Authorization: Bearer <token>
```

Important MCP tools include:

| Tool | Purpose |
|------|---------|
| `research_lookup` | Graph search, cross-domain evidence, method lineage, method evidence, method registry, research answers |
| `literature_discovery` | Plan/search/resolve/run/import/ingest/status/report/list for bounded topic-level discovery |
| `research_briefing` | Briefing-oriented research summaries over existing graph state |
| `idea_catalyst` | Cross-domain idea generation and research packet support |
| `import_workflow` | Import task submission and queue inspection |
| `agent_materials` | Material packs, project overlays, evidence carts, and research-controller artifacts |
| `runtime_init` / `create_corpus` | Server-side config initialization and first graph build over MCP |
| `refresh_corpus` / `refresh_paper_graph` | Corpus-scale and per-paper maintenance jobs |

## Access And Full-Text Policy

PaperNexus prefers structured open APIs and legal open-access sources.

| Source | Access mode |
|--------|-------------|
| OpenAlex | REST API |
| Semantic Scholar | REST API |
| Crossref | REST API |
| arXiv | REST API |
| DBLP | REST/API-style metadata access |
| Europe PMC / PubMed alias | REST API |
| CORE | REST API when configured |
| papers.cool / PASA | Optional configured search providers |
| Unpaywall | DOI-based OA status and PDF lookup during source resolution |

Full-text resolution only uses legal open-access PDF sources. If a source needs institutional access, returns HTML instead of PDF, is blocked by anti-bot checks, or has no open PDF, PaperNexus records that status instead of attempting to bypass the restriction.

## Documentation Map

- [Docs Home](docs/index.md): high-level entry point.
- [Overview](docs/overview/index.md): system summary and core concepts.
- [Get Started](docs/get-started/index.md): beginner setup and first corpus.
- [Pipeline](docs/pipeline/index.md): staged build, imports, parser runtime, recovery, and performance.
- [Literature Discovery](docs/literature-discovery/index.md): MCP topic search, provider defaults, source resolution, and import-readiness boundaries.
- [Graph](docs/graph/index.md): graph model and cross-domain intelligence.
- [Interfaces](docs/interfaces/index.md): CLI, Web, HTTP, MCP, and remote import workflows.
- [Agent Materials](docs/agent-materials/index.md): material packs, project overlays, source-discovery plans, and research-controller artifacts.
- [Storage](docs/storage/index.md): local storage layout and graph artifacts.
- [Operations](docs/operations/index.md): service mode, backup, logs, and runtime operations.
- [Reference](docs/reference/index.md): generated CLI, config, graph schema, HTTP, MCP, script, and module references.

Regenerate reference docs:

```bash
npm run docs:generate
```

Serve the documentation site locally:

```bash
npm run docs:dev
npm run docs:build
```

## Project Structure

```text
PaperNexus/
├── src/
│   ├── cli/                    # CLI entry point and command dispatch
│   ├── core/
│   │   ├── discovery/          # Literature discovery workflow and providers
│   │   ├── ingestion/          # Materialize, parser, pipeline, method evidence
│   │   ├── graph/              # Graph schema, intelligence, catalyst, lineage
│   │   ├── enhancements/       # Theory/storyline/reflection overlays
│   │   ├── imports/            # Import queue worker
│   │   └── search/             # Search and brainstorm helpers
│   ├── mcp/                    # Local and remote MCP tools/resources/prompts
│   ├── server/                 # HTTP server and API routes
│   ├── storage/                # Corpus, Kuzu, import, backup, lite stores
│   └── lib/                    # Config, keychain, launchd, server paths, utils
├── scripts/                    # Python wrappers, parser adapters, service helpers
├── web/                        # Browser dashboard
├── docs/                       # VitePress docs and generated references
├── examples/                   # Example paper sources
├── test/                       # Node test suite
├── papers/                     # Generated technical reports and paper sources
├── config.example.json         # Runtime config template
└── package.json
```

## Design Philosophy

The bottleneck in research automation is not only retrieval. It is preserving enough structure that later reasoning can be inspected, reused, and challenged.

PaperNexus therefore keeps four boundaries explicit:

- **Source vs snapshot**: parsing and semantic extraction are cached separately.
- **Snapshot vs graph**: graph construction is staged and recoverable.
- **Evidence vs answer**: research answers should cite graph evidence rather than invent it at query time.
- **Open access vs restricted access**: discovery reports legal availability instead of bypassing access controls.

## Development

Run the full test suite:

```bash
npm test
```

Focused checks:

```bash
node --test test/workflow.test.js
node --test test/materialize-optimize.test.js
node --test test/literature-discovery.test.js
node --test test/method-evolution-overlay.test.js
node --test test/research-intelligence.test.js
```

Useful development commands:

```bash
node ./src/cli/index.js help
node ./src/cli/index.js test-pdf-config ./paper.pdf --json
npm run docs:generate
```

## License

PaperNexus is released under an MIT-based license with an additional attribution requirement. Any use, redistribution, modification, publication, or derivative work based on PaperNexus must clearly identify PaperNexus as the source and include a link to the original repository when reasonably possible.

See [LICENSE](LICENSE) for the full terms.
