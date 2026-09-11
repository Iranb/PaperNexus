# CLI Reference

This page is generated from the live `papernexus help` output plus a thin layer of command notes. Run `npm run docs:generate` after changing CLI behavior so the docs stay aligned with the code.

## Global Help Snapshot

```text
PaperNexus

Analysis and knowledge-graph engine for already-provided academic papers and corpora.
PaperNexus builds graph intelligence over provided corpora and exposes an explicit MCP literature-discovery bridge for fresh search and optional imports.

Global options:
  --config <path>     Use an explicit config JSON file
  --no-config         Ignore the default config search paths
  --no-secure-env     Do not load ~/.papernexus/secure-env.enc.json
  --quiet             Show minimal output with progress bar only

Commands:
  papernexus init [--force]
  papernexus analyze [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--ingestion-orchestrator] [--ingestion-orchestrator-profile <off|preview|release-gated>] [--ingestion-orchestrator-output-dir <dir>] [--grobid-tei-dir <dir>] [--s2orc-path <jsonl>] [--coci-path <file>] [--multimodal-assets-path <json>] [--pdf-parser <markitdown|markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl|firecrawl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markitdown-python <python>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--docling-device <device>] [--docling-cuda-visible-devices <ids>] [--docling-auto-gpu <true|false>] [--docling-gpu-min-free-mb <mb>] [--docling-gpu-wait-timeout-ms <ms>] [--docling-gpu-poll-interval-ms <ms>] [--docling-cpu-threads <n>] [--docling-artifacts-path <path>] [--docling-image-export-mode <mode>] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms <ms>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--firecrawl-api-base-url <url>] [--firecrawl-api-key-env <env>] [--firecrawl-mode <fast|auto|ocr>] [--firecrawl-source-mode <auto|upload|url>] [--firecrawl-max-pages <n>] [--firecrawl-timeout-ms <ms>] [--page-range <pages>] [--pdf-ssh-host <host>] [--watch] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus materialize [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--pdf-parser <markitdown|markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl|firecrawl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markitdown-python <python>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--docling-device <device>] [--docling-cuda-visible-devices <ids>] [--docling-auto-gpu <true|false>] [--docling-gpu-min-free-mb <mb>] [--docling-gpu-wait-timeout-ms <ms>] [--docling-gpu-poll-interval-ms <ms>] [--docling-cpu-threads <n>] [--docling-artifacts-path <path>] [--docling-image-export-mode <mode>] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms <ms>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--firecrawl-api-base-url <url>] [--firecrawl-api-key-env <env>] [--firecrawl-mode <fast|auto|ocr>] [--firecrawl-source-mode <auto|upload|url>] [--firecrawl-max-pages <n>] [--firecrawl-timeout-ms <ms>] [--page-range <pages>] [--pdf-ssh-host <host>]
  papernexus llm-optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus build-graph [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>]
  papernexus merge-graph [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus write-index [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus stage1 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage2 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage3 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage4 [<path>] [--continue] [--force]
  papernexus optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--pdf-parser <markitdown|markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl|firecrawl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markitdown-python <python>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--docling-device <device>] [--docling-cuda-visible-devices <ids>] [--docling-auto-gpu <true|false>] [--docling-gpu-min-free-mb <mb>] [--docling-gpu-wait-timeout-ms <ms>] [--docling-gpu-poll-interval-ms <ms>] [--docling-cpu-threads <n>] [--docling-artifacts-path <path>] [--docling-image-export-mode <mode>] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms <ms>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--firecrawl-api-base-url <url>] [--firecrawl-api-key-env <env>] [--firecrawl-mode <fast|auto|ocr>] [--firecrawl-source-mode <auto|upload|url>] [--firecrawl-max-pages <n>] [--firecrawl-timeout-ms <ms>] [--page-range <pages>] [--pdf-ssh-host <host>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus watch [<path>] [--name <corpus>] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--pdf-parser <markitdown|markpdfdown|opendataloader|docling|marker|mineru|paddleocr-vl|firecrawl>] [--pdf-cmd <cmd>] [--python-command <python>] [--pdf-parser-ssh-host <host>] [--markitdown-python <python>] [--markpdfdown-python <python>] [--opendataloader-pdf-python <python>] [--docling-python <python>] [--docling-cmd <cmd>] [--docling-vlm] [--docling-vlm-preset <preset>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--docling-device <device>] [--docling-cuda-visible-devices <ids>] [--docling-auto-gpu <true|false>] [--docling-gpu-min-free-mb <mb>] [--docling-gpu-wait-timeout-ms <ms>] [--docling-gpu-poll-interval-ms <ms>] [--docling-cpu-threads <n>] [--docling-artifacts-path <path>] [--docling-image-export-mode <mode>] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms <ms>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--firecrawl-api-base-url <url>] [--firecrawl-api-key-env <env>] [--firecrawl-mode <fast|auto|ocr>] [--firecrawl-source-mode <auto|upload|url>] [--firecrawl-max-pages <n>] [--firecrawl-timeout-ms <ms>] [--page-range <pages>] [--pdf-ssh-host <host>] [--debounce-ms <ms>] [--poll-interval-ms <ms>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus probe [--provider <name>] [--model <name>] [--base-url <url>]  Test LLM connectivity
  papernexus clean [--corpus <name>]
  papernexus clean --corpora <name[,name...]> [--apply] [--allow-non-temp]
  papernexus scrub-degenerate-papers [--corpus <name>]
  papernexus catalyst --target-domain <domain> [--challenge <text>] [--mechanism <name[,name...]>] [--limit <n>] [--corpus <name>]
  papernexus answer <query> [--mode <cross_domain_evidence|method_lineage|both>] [--target-domain <domain>] [--method <name>] [--direction <backward|forward|both>] [--max-depth <n>] [--limit <n>] [--corpus <name>]
  papernexus catalyst-backfill [<path>] [--name <corpus>] [--semantic-extraction <llm-assisted|llm-primary>] [--force]
  papernexus imports [status] [<corpus>] [--limit <n>] [--json]
  papernexus imports running [<corpus>] [--limit <n>] [--json]
  papernexus imports log [<task-id>] [<corpus>] [--task-id <id>] [--tail <n>] [--json]
  papernexus run status [<corpus>] [--run-id <id|latest>] [--json]
  papernexus run tail [<corpus>] [--run-id <id|latest>] [--tail <n>] [--json]
  papernexus run report [<corpus>] [--run-id <id|latest>] [--tail <n>] [--json]
  papernexus run continue [<corpus>] [--run-id <id|latest>] [--json]
  papernexus run retry-failed [<corpus>] [--run-id <id|latest>] [--json]
  papernexus run abort [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 inventory [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 build-shadow [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 verify [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 cutover [<corpus>] [--run-id <id|latest>] [--force] [--json]
  papernexus graph-v2 rollback [<corpus>] [--run-id <id|latest>] [--backup-dir <dir>] [--json]
  papernexus graph-v2 status [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 tail [<corpus>] [--run-id <id|latest>] [--tail <n>] [--json]
  papernexus graph-v2 continue [<corpus>] [--run-id <id|latest>] [--json]
  papernexus graph-v2 report [<corpus>] [--run-id <id|latest>] [--tail <n>] [--json]
  papernexus benchmark-retrieval <benchmark-path> [--format <auto|custom|beir|litsearch|bioasq|trec|sage|scholarqa|paperask|sparbench|scholargym|scinetbench|csfcube>] [--evaluation-mode <live|fixed-corpus>] [--fixed-corpus-retrieval-mode <lexical|dense|hybrid|rerank|hybrid-rerank>] [--fixed-corpus-dense-scores <path>] [--fixed-corpus-rerank-scores <path>] [--fixed-corpus-rrf-k <n>] [--fixed-corpus-query-analysis <off|heuristic|llm>] [--fixed-corpus-query-analysis-extra-limit <n>] [--task-evaluation <off|rules|llm>] [--generate-task-answers <true|false>] [--max-task-context <n>] [--corpus <name|path>] [--providers <name[,name...]>] [--depth <quick|default|deep>] [--query-decomposition <auto|true|false>] [--benchmark-limit <n>] [--max-queries <n>] [--max-discovery-queries <n>] [--max-results-per-query <n>] [--max-candidates <n>] [--fixed-corpus-scan-limit <n>] [--fixed-corpus-cache-dir <dir>] [--k <1,5,10,20>] [--output <dir>] [--run-id <id>] [--resume] [--continue-on-error <true|false>] [--json]
  papernexus backup-export [archive-path] [--corpus <name>]
  papernexus backup-unpack <archive-path> --output <dir>
  papernexus backup-load <archive-path> --output <dir>
  papernexus logs watch
  papernexus test-pdf-config <pdf-path> [--json] [--verify-docling-fallback]
  papernexus test-pdf-to-markdown <pdf-path> [--json] [--verify-docling-fallback]
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus apikey [--provider <name>] [--base-url <url>]  Set LLM API key securely
  papernexus secure-env set|delete|list|path [NAME] [--stdin]
  papernexus setup
  papernexus serve [--host 127.0.0.1] [--port 4821] [--api-token <token>]
  papernexus mcp

Scope boundary:
  - analyze and materialize process local papers, corpora, or manifests you already provide.
  - literature_discovery can run bounded fresh search/source resolution, but graph tools see those papers only after import_workflow reports completed graph sync.
  - query, catalyst, agent_materials, and briefing APIs operate on already-committed graph state unless an explicit provider/live/literature opt-in is passed.
  - broader autonomous multi-agent orchestration and final research decisions live outside PaperNexus.

LLM Fallback Options:
  --fallback-provider <openai|deepseek|anthropic|ollama>
    Provider to use when the primary LLM is rate limited. Fallback is off unless a fallback model is configured.
  --fallback-model <name>
    Model identifier for the fallback provider.
  --fallback-base-url <url>
    Fallback API root. For Ollama this defaults to http://127.0.0.1:11434.
  --fallback-ssh-host <host>
    Run fallback Ollama HTTP calls and bootstrap commands through SSH on the remote host.
  --fallback-auto-start <true|false>
    Start fallback Ollama automatically when its HTTP endpoint is unavailable.
  --fallback-auto-pull <true|false>
    Pull the fallback Ollama model automatically when it is missing.
  --fallback-ollama-bootstrap <native|docker>
    Bootstrap Ollama with the local ollama binary or a Docker container.
  --llm-chunk-pipeline <true|false|paper>
    Use chunk-level LLM map/reduce for Stage 2. Default: true.
  --llm-chunk-limit-per-paper <n>
    Maximum selected chunks per paper for chunk-level LLM extraction. Default: 12.
  --llm-batch-ledger-dir <dir>
    Directory for resumable LLM batch ledger JSONL files. Stage 2 uses a corpus-local default when omitted.
  --llm-batch-run-id <id>
    Stable run id recorded in LLM batch ledger rows.
  --llm-batch-resume <true|false>
    Reuse completed LLM batch rows from the ledger. Defaults to on for continue mode.

MarkItDown Options:
  --markitdown-python <python>
    Python executable used for the Microsoft MarkItDown wrapper.
  --markitdown-use-llm <true|false>
    Reuse PaperNexus `llm.*` config for MarkItDown image descriptions / OCR-capable plugins. Default: auto-on when project LLM config is available.
  --markitdown-enable-plugins <true|false>
    Enable MarkItDown plugins. Defaults to on when MarkItDown LLM auto-activation succeeds.
  --markitdown-llm-prompt <text>
    Optional custom prompt forwarded to MarkItDown's llm_prompt parameter.

Firecrawl PDF Options:
  --firecrawl-api-base-url <url>
    Firecrawl API base URL. Default: https://api.firecrawl.dev
  --firecrawl-api-key-env <env>
    Environment variable containing the Firecrawl API key. Default: FIRECRAWL_API_KEY
  --firecrawl-mode <fast|auto|ocr>
    Firecrawl PDF parsing mode. Default: auto.
  --firecrawl-source-mode <auto|upload|url>
    Use upload for local/private PDFs, url for public PDF URLs, or auto to prefer a trusted source URL when available.
  --firecrawl-max-pages <n>
    Optional maximum number of PDF pages to parse.
  --firecrawl-timeout-ms <ms>
    Optional Firecrawl request timeout. Defaults to the PDF parser timeout.

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
  --docling-device <device>
    Execution device for Docling CLI parsing. Default: cuda
  --docling-cuda-visible-devices <ids>
    Optional CUDA_VISIBLE_DEVICES value for Docling, for example "0" or "2".
    When omitted, PaperNexus automatically waits for an available GPU slot.
  --docling-auto-gpu <true|false>
    Enable automatic Docling GPU selection and queueing. Default: true.
  --docling-gpu-lock-root <path>
    Shared lock directory used to reserve GPU slots across PaperNexus workers.
  --docling-gpu-min-free-mb <mb>
    Minimum free GPU memory required before starting Docling. Default: 18000.
  --docling-gpu-wait-timeout-ms <ms>
    Maximum time to wait for a free Docling GPU slot. Default: 1800000.
  --docling-gpu-poll-interval-ms <ms>
    Poll interval while waiting for a free Docling GPU slot. Default: 5000.
  --docling-gpu-lock-stale-ms <ms>
    Age after which abandoned GPU lock directories can be reclaimed. Default: 7200000.
  --docling-cpu-threads <n>
    Thread cap for OpenBLAS/OMP/MKL/NumExpr during Docling parsing. Default: 4.
  --docling-artifacts-path <path>
    Optional Docling model cache path to reuse downloaded artifacts across runs.
  --docling-image-export-mode <mode>
    Image export mode for Docling. Default: placeholder
  --docling-enrich-picture-classes
    Re-enable picture class enrichment. Disabled by default for faster batch parsing.
  --docling-enrich-picture-description
    Re-enable picture description enrichment. Disabled by default for faster batch parsing.
  --docling-preload
    Warm Docling once before the first parse in the current process. Enabled by default in config.
  --docling-preload-timeout-ms <ms>
    Timeout for Docling warmup runs. Default: 120000

Examples:
  papernexus init
  papernexus service install
  papernexus logs watch
  papernexus test-pdf-config ./paper.pdf --json
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus analyze ./papers --name ml-papers
  papernexus analyze ./papers --name ml-papers --concurrency 4
  papernexus analyze ./papers --name ml-papers --pdf-parser markitdown
  papernexus analyze ./papers --name ml-papers --pdf-parser markpdfdown --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pypdfium2
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pdfplumber
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-vlm --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --semantic-extraction auto --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --pdf-parser marker --marker-cmd marker_single --pdf-ssh-host user@example-gpu --ollama-model qwen2.5:0.5b --ollama-relations --ollama-ssh-host user@example-gpu
  papernexus analyze ./papers --name ml-papers --pdf-parser mineru --mineru-http-url http://gpu.example.internal:30000
  papernexus analyze ./papers --name ml-papers --pdf-parser paddleocr-vl
  papernexus analyze ./papers --name ml-papers --pdf-parser firecrawl --firecrawl-api-key-env FIRECRAWL_API_KEY
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
  papernexus imports status --corpus ml-papers
  papernexus imports running --corpus ml-papers
  papernexus imports log --corpus ml-papers --task-id imp:1234567890abcdef
  papernexus benchmark-retrieval ./benchmarks/scholarqa --format scholarqa --task-evaluation llm --generate-task-answers true --model gpt-4o-mini
  papernexus auth llm set --provider openai --base-url https://api.openai.com/v1
  papernexus query "retrieval augmented experiment planning" --corpus ml-papers
  papernexus catalyst --target-domain Education --challenge "reduce confirmation bias during tutoring feedback" --mechanism "metacontrol policy" --corpus ml-papers
  papernexus answer "reduce confirmation bias during tutoring feedback" --mode cross_domain_evidence --target-domain Education --mechanism "metacontrol policy" --corpus ml-papers
  papernexus answer --method Transformer --mode method_lineage --direction backward --corpus ml-papers
  papernexus catalyst-backfill ./papers --name ml-papers --semantic-extraction llm-assisted
  papernexus impact "semi-supervised learning" --corpus ml-papers --layers ProblemLayer,MethodLayer --layer-mode cross
  papernexus context "knowledge graph" --corpus ml-papers
  papernexus impact "Graph-Augmented Literature Mapping for Biomedical Discovery" --corpus ml-papers
  papernexus ideas "experiment planning with evidence tracing" --corpus ml-papers
  papernexus brainstorm "semi-supervised learning" --corpus ml-papers --mode diverge --hops 2
  papernexus scrub-degenerate-papers --corpus ml-papers
  papernexus serve
```

## Build Pipeline

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `init` | Interactive bootstrap for runtime config, paths, and provider setup. | `papernexus init [--force]` |
| `analyze` | Full end-to-end build for one provided corpus: materialize, optimize, build, merge, and write. | `papernexus analyze [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--node-llm-check] [--ingestion-orchestrator] [--ingestion-orchestrator-profile &lt;off\|preview\|release-gated&gt;] [--ingestion-orchestrator-output-dir &lt;dir&gt;] [--grobid-tei-dir &lt;dir&gt;] [--s2orc-path &lt;jsonl&gt;] [--coci-path &lt;file&gt;] [--multimodal-assets-path &lt;json&gt;] [--pdf-parser &lt;markitdown\|markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl\|firecrawl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markitdown-python &lt;python&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--docling-device &lt;device&gt;] [--docling-cuda-visible-devices &lt;ids&gt;] [--docling-auto-gpu &lt;true\|false&gt;] [--docling-gpu-min-free-mb &lt;mb&gt;] [--docling-gpu-wait-timeout-ms &lt;ms&gt;] [--docling-gpu-poll-interval-ms &lt;ms&gt;] [--docling-cpu-threads &lt;n&gt;] [--docling-artifacts-path &lt;path&gt;] [--docling-image-export-mode &lt;mode&gt;] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms &lt;ms&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--firecrawl-api-base-url &lt;url&gt;] [--firecrawl-api-key-env &lt;env&gt;] [--firecrawl-mode &lt;fast\|auto\|ocr&gt;] [--firecrawl-source-mode &lt;auto\|upload\|url&gt;] [--firecrawl-max-pages &lt;n&gt;] [--firecrawl-timeout-ms &lt;ms&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--watch] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `materialize` | Stage 1 only: convert PDFs or cache Markdown, then write reusable snapshots. | `papernexus materialize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency &lt;n&gt;] [--pdf-parser &lt;markitdown\|markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl\|firecrawl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markitdown-python &lt;python&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--docling-device &lt;device&gt;] [--docling-cuda-visible-devices &lt;ids&gt;] [--docling-auto-gpu &lt;true\|false&gt;] [--docling-gpu-min-free-mb &lt;mb&gt;] [--docling-gpu-wait-timeout-ms &lt;ms&gt;] [--docling-gpu-poll-interval-ms &lt;ms&gt;] [--docling-cpu-threads &lt;n&gt;] [--docling-artifacts-path &lt;path&gt;] [--docling-image-export-mode &lt;mode&gt;] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms &lt;ms&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--firecrawl-api-base-url &lt;url&gt;] [--firecrawl-api-key-env &lt;env&gt;] [--firecrawl-mode &lt;fast\|auto\|ocr&gt;] [--firecrawl-source-mode &lt;auto\|upload\|url&gt;] [--firecrawl-max-pages &lt;n&gt;] [--firecrawl-timeout-ms &lt;ms&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;]` |
| `llm-optimize` | Stage 2 only: refresh semantic extraction and relation quality without re-parsing source files. | `papernexus llm-optimize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `build-graph` | Stage 3 only: project semantic snapshots into a staged multilayer graph. | `papernexus build-graph [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;]` |
| `merge-graph` | Stage 4 only: canonicalize near-duplicate datasets and benchmarks before commit. | `papernexus merge-graph [&lt;path&gt;] [--continue] [--force] [--quiet] [--node-llm-check]` |
| `write-index` | Stage 5 only: commit staged graph state, lite view, meta, and registries. | `papernexus write-index [&lt;path&gt;] [--continue] [--force] [--quiet] [--node-llm-check]` |
| `stage1` | Alias for `materialize`. | `papernexus stage1 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage2` | Alias for `llm-optimize`. | `papernexus stage2 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage3` | Alias for `build-graph`. | `papernexus stage3 [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force]` |
| `stage4` | Alias for `write-index` plus staged commit compatibility path. | `papernexus stage4 [&lt;path&gt;] [--continue] [--force]` |
| `optimize` | Resume from existing snapshots and run stages 2-5 together. | `papernexus optimize [&lt;path&gt;] [--name &lt;corpus&gt;] [--continue] [--force] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--node-llm-check] [--pdf-parser &lt;markitdown\|markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl\|firecrawl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markitdown-python &lt;python&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--docling-device &lt;device&gt;] [--docling-cuda-visible-devices &lt;ids&gt;] [--docling-auto-gpu &lt;true\|false&gt;] [--docling-gpu-min-free-mb &lt;mb&gt;] [--docling-gpu-wait-timeout-ms &lt;ms&gt;] [--docling-gpu-poll-interval-ms &lt;ms&gt;] [--docling-cpu-threads &lt;n&gt;] [--docling-artifacts-path &lt;path&gt;] [--docling-image-export-mode &lt;mode&gt;] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms &lt;ms&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--firecrawl-api-base-url &lt;url&gt;] [--firecrawl-api-key-env &lt;env&gt;] [--firecrawl-mode &lt;fast\|auto\|ocr&gt;] [--firecrawl-source-mode &lt;auto\|upload\|url&gt;] [--firecrawl-max-pages &lt;n&gt;] [--firecrawl-timeout-ms &lt;ms&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |
| `watch` | Long-running rebuild loop for already-provided paper directories. | `papernexus watch [&lt;path&gt;] [--name &lt;corpus&gt;] [--quiet] [--concurrency &lt;n&gt;] [--semantic-extraction &lt;auto\|heuristic-only\|llm-assisted\|llm-primary&gt;] [--pdf-parser &lt;markitdown\|markpdfdown\|opendataloader\|docling\|marker\|mineru\|paddleocr-vl\|firecrawl&gt;] [--pdf-cmd &lt;cmd&gt;] [--python-command &lt;python&gt;] [--pdf-parser-ssh-host &lt;host&gt;] [--markitdown-python &lt;python&gt;] [--markpdfdown-python &lt;python&gt;] [--opendataloader-pdf-python &lt;python&gt;] [--docling-python &lt;python&gt;] [--docling-cmd &lt;cmd&gt;] [--docling-vlm] [--docling-vlm-preset &lt;preset&gt;] [--docling-ssh-host &lt;host&gt;] [--docling-ocr-engine &lt;name&gt;] [--docling-pdf-backend &lt;backend&gt;] [--docling-device &lt;device&gt;] [--docling-cuda-visible-devices &lt;ids&gt;] [--docling-auto-gpu &lt;true\|false&gt;] [--docling-gpu-min-free-mb &lt;mb&gt;] [--docling-gpu-wait-timeout-ms &lt;ms&gt;] [--docling-gpu-poll-interval-ms &lt;ms&gt;] [--docling-cpu-threads &lt;n&gt;] [--docling-artifacts-path &lt;path&gt;] [--docling-image-export-mode &lt;mode&gt;] [--docling-enrich-picture-classes] [--docling-enrich-picture-description] [--docling-preload] [--docling-preload-timeout-ms &lt;ms&gt;] [--marker-cmd &lt;cmd&gt;] [--marker-ssh-host &lt;host&gt;] [--mineru-cmd &lt;url&gt;] [--mineru-http-url &lt;url&gt;] [--mineru-remote-failure &lt;error\|docling&gt;] [--firecrawl-api-base-url &lt;url&gt;] [--firecrawl-api-key-env &lt;env&gt;] [--firecrawl-mode &lt;fast\|auto\|ocr&gt;] [--firecrawl-source-mode &lt;auto\|upload\|url&gt;] [--firecrawl-max-pages &lt;n&gt;] [--firecrawl-timeout-ms &lt;ms&gt;] [--page-range &lt;pages&gt;] [--pdf-ssh-host &lt;host&gt;] [--debounce-ms &lt;ms&gt;] [--poll-interval-ms &lt;ms&gt;] [--ollama-model &lt;name&gt;] [--ollama-url &lt;url&gt;] [--ollama-relations] [--ollama-ssh-host &lt;host&gt;]` |

## Operations

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `probe` | Connectivity check for the configured LLM provider. | `papernexus probe [--provider &lt;name&gt;] [--model &lt;name&gt;] [--base-url &lt;url&gt;]  Test LLM connectivity` |
| `clean` | Remove or reset stored corpus state. | `papernexus clean [--corpus &lt;name&gt;]` |
| `clean` | Remove or reset stored corpus state. | `papernexus clean --corpora &lt;name[,name...]&gt; [--apply] [--allow-non-temp]` |
| `backup-export` | Pack the current corpus environment into a portable archive. | `papernexus backup-export [archive-path] [--corpus &lt;name&gt;]` |
| `backup-unpack` | Unpack a backup archive into an inspectable directory. | `papernexus backup-unpack &lt;archive-path&gt; --output &lt;dir&gt;` |
| `backup-load` | Restore a backup archive into a fresh output directory. | `papernexus backup-load &lt;archive-path&gt; --output &lt;dir&gt;` |
| `update` | Self-update the repository checkout. | `papernexus update [--force]                          Update PaperNexus to latest version from GitHub` |
| `apikey` | Store or rotate provider API keys in secure local storage. | `papernexus apikey [--provider &lt;name&gt;] [--base-url &lt;url&gt;]  Set LLM API key securely` |

## Other

| Command | Purpose | Synopsis |
| --- | --- | --- |
| `scrub-degenerate-papers` | See synopsis and in-command help. | `papernexus scrub-degenerate-papers [--corpus &lt;name&gt;]` |
| `answer` | See synopsis and in-command help. | `papernexus answer &lt;query&gt; [--mode &lt;cross_domain_evidence\|method_lineage\|both&gt;] [--target-domain &lt;domain&gt;] [--method &lt;name&gt;] [--direction &lt;backward\|forward\|both&gt;] [--max-depth &lt;n&gt;] [--limit &lt;n&gt;] [--corpus &lt;name&gt;]` |
| `imports` | See synopsis and in-command help. | `papernexus imports [status] [&lt;corpus&gt;] [--limit &lt;n&gt;] [--json]` |
| `imports` | See synopsis and in-command help. | `papernexus imports running [&lt;corpus&gt;] [--limit &lt;n&gt;] [--json]` |
| `imports` | See synopsis and in-command help. | `papernexus imports log [&lt;task-id&gt;] [&lt;corpus&gt;] [--task-id &lt;id&gt;] [--tail &lt;n&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run status [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run tail [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--tail &lt;n&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run report [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--tail &lt;n&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run continue [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run retry-failed [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `run` | See synopsis and in-command help. | `papernexus run abort [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 inventory [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 build-shadow [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 verify [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 cutover [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--force] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 rollback [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--backup-dir &lt;dir&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 status [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 tail [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--tail &lt;n&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 continue [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--json]` |
| `graph-v2` | See synopsis and in-command help. | `papernexus graph-v2 report [&lt;corpus&gt;] [--run-id &lt;id\|latest&gt;] [--tail &lt;n&gt;] [--json]` |
| `benchmark-retrieval` | See synopsis and in-command help. | `papernexus benchmark-retrieval &lt;benchmark-path&gt; [--format &lt;auto\|custom\|beir\|litsearch\|bioasq\|trec\|sage\|scholarqa\|paperask\|sparbench\|scholargym\|scinetbench\|csfcube&gt;] [--evaluation-mode &lt;live\|fixed-corpus&gt;] [--fixed-corpus-retrieval-mode &lt;lexical\|dense\|hybrid\|rerank\|hybrid-rerank&gt;] [--fixed-corpus-dense-scores &lt;path&gt;] [--fixed-corpus-rerank-scores &lt;path&gt;] [--fixed-corpus-rrf-k &lt;n&gt;] [--fixed-corpus-query-analysis &lt;off\|heuristic\|llm&gt;] [--fixed-corpus-query-analysis-extra-limit &lt;n&gt;] [--task-evaluation &lt;off\|rules\|llm&gt;] [--generate-task-answers &lt;true\|false&gt;] [--max-task-context &lt;n&gt;] [--corpus &lt;name\|path&gt;] [--providers &lt;name[,name...]&gt;] [--depth &lt;quick\|default\|deep&gt;] [--query-decomposition &lt;auto\|true\|false&gt;] [--benchmark-limit &lt;n&gt;] [--max-queries &lt;n&gt;] [--max-discovery-queries &lt;n&gt;] [--max-results-per-query &lt;n&gt;] [--max-candidates &lt;n&gt;] [--fixed-corpus-scan-limit &lt;n&gt;] [--fixed-corpus-cache-dir &lt;dir&gt;] [--k &lt;1,5,10,20&gt;] [--output &lt;dir&gt;] [--run-id &lt;id&gt;] [--resume] [--continue-on-error &lt;true\|false&gt;] [--json]` |
| `test-pdf-config` | See synopsis and in-command help. | `papernexus test-pdf-config &lt;pdf-path&gt; [--json] [--verify-docling-fallback]` |
| `test-pdf-to-markdown` | See synopsis and in-command help. | `papernexus test-pdf-to-markdown &lt;pdf-path&gt; [--json] [--verify-docling-fallback]` |
| `secure-env` | See synopsis and in-command help. | `papernexus secure-env set\|delete\|list\|path [NAME] [--stdin]` |

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
