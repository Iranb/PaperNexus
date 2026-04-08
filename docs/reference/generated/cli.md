# CLI Reference

This page is generated from the live `papernexus help` output plus a thin layer of command notes. Run `npm run docs:generate` after changing CLI behavior so the docs stay aligned with the code.

## Global Help Snapshot

```text
PaperNexus

Analysis and knowledge-graph engine for already-provided academic papers and corpora.
PaperNexus does not discover external literature or orchestrate multi-agent research workflows for you.

Global options:
  --config <path>     Use an explicit config JSON file
  --no-config         Ignore the default config search paths
  --quiet             Show minimal output with progress bar only

Commands:
  papernexus init [--force]
  papernexus analyze [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--pdf-parser <markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--watch] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus materialize [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--pdf-parser <markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>]
  papernexus llm-optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus build-graph [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>]
  papernexus merge-graph [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus write-index [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus stage1 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage2 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage3 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage4 [<path>] [--continue] [--force]
  papernexus optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--pdf-parser <markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus watch [<path>] [--name <corpus>] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--pdf-parser <markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--debounce-ms <ms>] [--poll-interval-ms <ms>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus probe [--provider <name>] [--model <name>] [--base-url <url>]  Test LLM connectivity
  papernexus clean [--corpus <name>]
  papernexus catalyst --target-domain <domain> [--challenge <text>] [--mechanism <name[,name...]>] [--limit <n>] [--corpus <name>]
  papernexus catalyst-backfill [<path>] [--name <corpus>] [--semantic-extraction <llm-assisted|llm-primary>] [--force]
  papernexus backup-export [archive-path] [--corpus <name>]
  papernexus backup-unpack <archive-path> --output <dir>
  papernexus backup-load <archive-path> --output <dir>
  papernexus logs watch
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus apikey [--provider <name>] [--base-url <url>]  Set LLM API key securely
  papernexus setup
  papernexus serve [--host 127.0.0.1] [--port 4821] [--api-token <token>]
  papernexus mcp

Scope boundary:
  - analyze, materialize, and import process papers, corpora, or manifests you already provide.
  - query, catalyst, and enhancement APIs operate on already-indexed graph state.
  - Discovery, external search, and orchestration live outside PaperNexus.

Docling PDF Backend Options:
  --docling-pdf-backend <backend>
    Choose the PDF parsing backend for Docling. Available backends:
    - pypdfium2    PyPDFium2 (recommended, fast and reliable)
    - pdfplumber   PdfPlumber (high precision, good for complex layouts)
    - fitz         PyMuPDF/Fitz (good for OCR-heavy documents)
    - pypdf        PyPDF (lightweight, basic functionality)
    Default: pypdfium2

Docling VLM Options:
  --docling-python <python>
    Python executable used for Docling's Python API wrapper.
  --docling-vlm
    Run Docling through its VLM pipeline using the configured PaperNexus LLM endpoint.
  --docling-vlm-preset <preset>
    Docling VLM preset to use. Default: granite_docling

Examples:
  papernexus init
  papernexus service install
  papernexus logs watch
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus analyze ./papers --name ml-papers
  papernexus analyze ./papers --name ml-papers --concurrency 4
  papernexus analyze ./papers --name ml-papers --pdf-parser markpdfdown --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pypdfium2
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pdfplumber
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-vlm --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --semantic-extraction auto --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --pdf-parser marker --marker-cmd marker_single --pdf-ssh-host 211.71.76.29 --ollama-model qwen2.5:0.5b --ollama-relations --ollama-ssh-host 211.71.76.29
  papernexus analyze ./papers --name ml-papers --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
  papernexus analyze ./papers --name ml-papers --pdf-parser paddleocr-vl
  papernexus materialize ./papers --name ml-papers --continue
  papernexus llm-optimize ./papers --name ml-papers --continue --semantic-extraction llm-primary --batch-size 16
  papernexus build-graph ./papers --name ml-papers --continue
  papernexus merge-graph ./papers --continue --node-llm-check
  papernexus write-index ./papers --continue --node-llm-check
  papernexus optimize ./papers --name ml-papers --continue --semantic-extraction llm-primary --node-llm-check --batch-size 16
  papernexus watch ./papers --name ml-papers
  papernexus enhance --once
  papernexus backup-export
  papernexus backup-export ./papernexus-backup.tgz
  papernexus backup-unpack ./papernexus-backup.tgz --output ./restored-papernexus
  papernexus auth llm set --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1
  papernexus query "retrieval augmented experiment planning" --corpus ml-papers
  papernexus catalyst --target-domain Education --challenge "reduce confirmation bias during tutoring feedback" --mechanism "metacontrol policy" --corpus ml-papers
  papernexus catalyst-backfill ./papers --name ml-papers --semantic-extraction llm-assisted
  papernexus impact "semi-supervised learning" --corpus ml-papers --layers ProblemLayer,MethodLayer --layer-mode cross
  papernexus context "knowledge graph" --corpus ml-papers
  papernexus impact "Graph-Augmented Literature Mapping for Biomedical Discovery" --corpus ml-papers
  papernexus ideas "experiment planning with evidence tracing" --corpus ml-papers
  papernexus brainstorm "semi-supervised learning" --corpus ml-papers --mode diverge --hops 2
  papernexus serve
```

## Build Pipeline

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `init` | Interactive bootstrap for runtime config, paths, and provider setup. | `papernexus init [--force]` |
| `analyze` | Full end-to-end build for one provided corpus: materialize, optimize, build, merge, and write. | `papernexus analyze [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--node-llm-check] [--pdf-parser &lt;markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--watch] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `materialize` | Stage 1 only: convert PDFs or cache Markdown, then write reusable snapshots. | `papernexus materialize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency &lt;n&gt;] [--pdf-parser &lt;markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;]` |
| `llm-optimize` | Stage 2 only: refresh semantic extraction and relation quality without re-parsing source files. | `papernexus llm-optimize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `build-graph` | Stage 3 only: project semantic snapshots into a staged multilayer graph. | `papernexus build-graph [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;]` |
| `merge-graph` | Stage 4 only: canonicalize near-duplicate datasets and benchmarks before commit. | `papernexus merge-graph [&lt;path&gt;] [--continue] [--force] [--quiet] [--node-llm-check]` |
| `write-index` | Stage 5 only: commit staged graph state, lite view, meta, and registries. | `papernexus write-index [&lt;path&gt;] [--continue] [--force] [--quiet] [--node-llm-check]` |
| `stage1` | Alias for `materialize`. | `papernexus stage1 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage2` | Alias for `llm-optimize`. | `papernexus stage2 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage3` | Alias for `build-graph`. | `papernexus stage3 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage4` | Alias for `merge-graph` plus staged commit compatibility path. | `papernexus stage4 [&lt;path&gt;] [--continue] [--force]` |
| `optimize` | Resume from existing snapshots and run stages 2-5 together. | `papernexus optimize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--node-llm-check] [--pdf-parser &lt;markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `watch` | Long-running rebuild loop for already-provided paper directories. | `papernexus watch [&lt;path&gt;] [--name &lt;corpus&gt;] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--pdf-parser &lt;markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--debounce-ms &lt;ms&gt;] [--poll-interval-ms &lt;ms&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |

## Operations

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `probe` | Connectivity check for the configured LLM provider. | `papernexus probe [--provider &lt;name&gt;] [--model &lt;name&gt;] [--base-url &lt;url&gt;]  Test LLM connectivity` |
| `clean` | Remove or reset stored corpus state. | `papernexus clean [--corpus &lt;name&gt;]` |
| `backup-export` | Pack the current corpus environment into a portable archive. | `papernexus backup-export [archive-path] [--corpus &lt;name&gt;]` |
| `backup-unpack` | Unpack a backup archive into an inspectable directory. | `papernexus backup-unpack &lt;archive-path&gt; --output &lt;dir&gt;` |
| `backup-load` | Restore a backup archive into a fresh output directory. | `papernexus backup-load &lt;archive-path&gt; --output &lt;dir&gt;` |
| `update` | Self-update the repository checkout. | `papernexus update [--force]                          Update PaperNexus to latest version from GitHub` |
| `apikey` | Store or rotate provider API keys in secure local storage. | `papernexus apikey [--provider &lt;name&gt;] [--base-url &lt;url&gt;]  Set LLM API key securely` |

## Idea Catalyst

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `catalyst` | Run graph-native Idea-Catalyst style interdisciplinary ideation over an indexed corpus. | `papernexus catalyst --target-domain &lt;domain&gt; [--challenge &lt;text&gt;] [--mechanism &lt;name[,name...]&gt;] [--limit &lt;n&gt;] [--corpus &lt;name&gt;]` |
| `catalyst-backfill` | Backfill catalyst metadata for older corpora that predate the newer graph layers. | `papernexus catalyst-backfill [&lt;path&gt;] [--name &lt;corpus&gt;] [--semantic-extraction &lt;llm-assisted\|llm-primary&gt;] [--force]` |

## Interfaces & Services

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `logs` | Inspect local service and watch logs. | `papernexus logs watch` |
| `setup` | Print connection snippets and setup guidance for MCP clients. | `papernexus setup` |
| `serve` | Run the browser UI, authenticated HTTP API, and remote HTTP MCP surface. | `papernexus serve [--host 127.0.0.1] [--port 4821] [--api-token &lt;token&gt;]` |
| `mcp` | Run PaperNexus as a local stdio MCP server. | `papernexus mcp` |
