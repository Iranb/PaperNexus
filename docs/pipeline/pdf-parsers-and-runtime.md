# PDF Parsers And Runtime

This page documents the current PDF parsing layer as it exists in the repository today.

It focuses on:

- which parser is used by default
- how fallback works
- how parser-local LLM assistance works
- how the optional Firecrawl network parser fits into academic-paper ingestion
- how GPU scheduling works for Docling
- where parser state and logs are persisted
- how to debug parser stalls without reverse-engineering the code

## Current Default

PaperNexus now defaults to:

- primary parser: `markitdown`
- fallback parser: `docling`

That means a normal `analyze`, `optimize`, `watch`, import queue run, or `test-pdf-to-markdown` invocation will attempt MarkItDown first unless you explicitly override `pdfParser`.

If the primary parser throws, PaperNexus retries the same PDF through Docling and records the fallback in parser state.

There is one important refinement: **a bad title alone no longer forces Docling fallback**. If the primary parser produced usable body text and section structure but the first heading looks like `Abstract`, `Introduction`, `r`, or another degenerate title, PaperNexus repairs the title from the filename and keeps the primary markdown. Docling is reserved for genuinely weak or failed markdown output.

## Supported Parser Families

The current parser layer is implemented in [`src/core/ingestion/pdf-parser.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/pdf-parser.js).

The supported parser families are:

- `markitdown`
- `markpdfdown`
- `opendataloader`
- `marker`
- `docling`
- `mineru`
- `paddleocr-vl`
- `firecrawl`

GROBID TEI is also supported as an offline citation-context adapter, not yet as the default PDF parser orchestrator. When you already have a GROBID TEI XML file, convert it into PaperNexus citation-context IR with:

```bash
npm run ingest:grobid-tei -- \
  --tei-path paper.tei.xml \
  --output-path citation-contexts.json \
  --paper-id paper:example \
  --paper-title "Example Paper" \
  --source-pdf-path paper.pdf
```

The adapter writes `papernexus-grobid-tei-citation-contexts-v1` artifacts with resolved bibliography metadata, per-citation sentence windows, reference identifiers, source paths, and diagnostics. These contexts use the same `papernexus-citation-contexts-v1` record shape consumed by method-evolution and evidence workflows. Missing bibliography entries are recorded as `reference-missing` instead of being silently dropped.

S2ORC JSON or JSONL slices are supported as an offline full-text/citation-mention supplement. This path is intended for licensed local S2ORC snapshots, not online discovery requests:

```bash
npm run ingest:s2orc -- \
  --s2orc-path s2orc-slice.jsonl \
  --output-path citation-contexts.json \
  --source-key s2orc-local-slice \
  --max-papers 1000
```

The S2ORC adapter writes `papernexus-s2orc-citation-contexts-v1` artifacts while preserving the downstream `papernexus-citation-contexts-v1` context shape. It normalizes `body_text` / `abstract` cite spans, `bib_entries` metadata, reference identifiers, sentence windows, section roles, source slice provenance, and unresolved-reference diagnostics.

COCI/OpenCitations dumps are supported as an offline DOI-to-DOI citation graph supplement. This path is for local CSV/TSV/JSON/JSONL slices and is not used as the only citation truth:

```bash
npm run ingest:coci -- \
  --coci-path coci.csv \
  --output-path coci-citation-graph.json \
  --source-key coci-local-slice \
  --max-records 100000
```

The COCI adapter writes `papernexus-coci-citation-graph-v1` artifacts with normalized citing/cited DOI endpoints, OCI provenance, creation/timespan metadata, self-citation flags, duplicate edge diagnostics, and a dry-run `graphProjection` of placeholder `Paper` nodes linked by `CITES` relationships. It records `licenseScope` on edges and does not write to the main graph by default.

Citation contexts can then be classified into a standalone citation-intent artifact:

```bash
npm run ingest:citation-intents -- \
  --contexts-path citation-contexts.json \
  --output-path citation-intents.json
```

The citation-intent adapter writes `papernexus-citation-intents-v1` artifacts with primary intent labels such as `method-use`, `baseline-comparison`, `limitation-contrast`, `motivation-gap`, `supporting-evidence`, `dataset`, and `evaluation-metric`. Each intent records confidence, matched evidence patterns, the source citation-context id, and a graph edge hint such as `CITES_FOR_METHOD`, `CITES_FOR_BASELINE`, or `CITES_FOR_CONTRAST`. When gold labels are available, pass `--gold-path`, `--min-accuracy`, and `--min-macro-f1` to turn the classifier into an explicit benchmark gate.

Claim extraction is a separate offline artifact so claim spans can be evaluated before any graph writeback:

```bash
npm run ingest:claim-extraction -- \
  --input-path parsed-paper.json \
  --output-path claims.json \
  --citation-contexts-path citation-contexts.json \
  --citation-intents-path citation-intents.json
```

The claim extractor writes `papernexus-claim-extraction-v1` artifacts with source-span-grounded claims, evidence span ids, linked citation-context ids, optional citation-intent ids, and a graph projection containing `Claim` / `EvidenceSnippet` nodes plus `CLAIMS`, `SUPPORTED_BY`, and `SUPPORTS_CLAIM` edges. When CLAIM-BENCH/CLAIMCHECK-style labels are available, pass `--gold-path`, `--min-claim-recall`, `--min-source-span-completeness`, and `--min-type-accuracy` to make claim extraction a benchmark gate.

The P1 parser orchestrator now wires these offline adapters into one default citation/claim substrate run:

```bash
npm run ingest:orchestrate -- \
  --output-dir .papernexus/ingestion-runs/example \
  --tei-path paper.tei.xml \
  --s2orc-path s2orc-slice.jsonl \
  --coci-path coci.csv \
  --multimodal-assets-path multimodal-assets.json \
  --paper-path parsed-paper.json
```

The orchestrator writes `papernexus-parser-orchestrator-v1` manifests plus normalized artifacts:

- `citation-contexts.json`: combined `papernexus-citation-contexts-v1` records, with GROBID TEI as the default citation parser and S2ORC as the supplement.
- `citation-intents.json`: `papernexus-citation-intents-v1` labels with optional SciCite-style gates.
- `claims.json`: `papernexus-claim-extraction-v1` claims with optional CLAIM-BENCH/CLAIMCHECK-style gates.
- `coci-citation-graph.json`: optional COCI/OpenCitations DOI graph projection.
- `multimodal-assets.json`: optional `papernexus-multimodal-assets-v1` figure/table/formula OCR assets, usually produced by PaddleOCR-VL, Docling, Marker, or an equivalent sidecar.
- `graph-mutations.json`: a dry-run `papernexus-ingestion-graph-mutations-v1` preview using the existing `mutate_graph` operation shape for `CitationContext`, `Claim`, `EvidenceSnippet`, `MultimodalAsset`, placeholder `Paper`, `SUPPORTED_BY`, `SUPPORTS_CLAIM`, `HAS_CITATION_INTENT`, `EXTRACTED_FROM_FIGURE`, `EXTRACTED_FROM_TABLE`, `EXTRACTED_FROM_FORMULA`, and `CITES` operations.

When `multimodal-assets.json` is supplied, the orchestrator projects each asset to a `MultimodalAsset` node and links it to referenced claims, citation contexts, or evidence spans using `EXTRACTED_FROM_FIGURE`, `EXTRACTED_FROM_TABLE`, or `EXTRACTED_FROM_FORMULA`. The asset record should preserve `asset_type`, `page`, `bbox`, `caption` or `ocr_text`, `source_parser`, `source_anchor`, `evidence_hash`, and `license_scope`. This keeps OCR/image/table/formula evidence auditable without storing full copyrighted assets in the KG by default. Release-gated apply plans now require at least one projected multimodal asset, and every projected asset must have license scope, evidence hash, an explicit source anchor, and at least one target graph link; empty or incomplete asset audit blocks `ready_to_apply`.

The manifest separates `status` from `releaseGateStatus`: a run can be `ready` because graph mutation previews exist while `releaseGateStatus` remains `incomplete` until gold citation-intent and claim-grounding labels are supplied. This prevents the adapter/orchestration layer from being mistaken for a real external benchmark pass.

The same orchestrator can now be enabled from the normal analyze/materialize runtime as an explicit P1 profile:

```bash
papernexus analyze ./papers \
  --ingestion-orchestrator \
  --grobid-tei-dir ./grobid-tei \
  --s2orc-path ./s2orc-slice.jsonl \
  --coci-path ./coci.csv \
  --multimodal-assets-path ./multimodal-assets.json
```

The orchestrator also supports a controlled default profile from config or CLI:

```json
{
  "analyze": {
    "ingestionOrchestratorProfile": "preview"
  }
}
```

Equivalent CLI:

```bash
papernexus analyze ./papers \
  --ingestion-orchestrator-profile preview
```

Supported profile values are `off`, `preview`, and `release-gated`. The `preview` profile is the intended default rollout profile: PaperNexus reuses the parser markdown cache, writes per-source parsed-paper inputs under `.papernexus/ingestion-orchestrator/`, runs the parser orchestrator for active sources, and stores an `ingestionOrchestrator` summary in `.papernexus/sources.json`. The runtime integration still writes dry-run graph mutation previews only (`writePolicy: preview-only`); it does not apply claim/citation operations to the main graph, and `releaseGateStatus` remains `incomplete` unless gold citation-intent or claim-grounding labels are provided. The `release-gated` profile now records stricter operator intent in `graph-apply-plan.json`: the plan becomes `ready_to_apply` only when graph mutations exist, at least one multimodal asset is fully audited, citation-intent benchmark gates pass, claim-extraction benchmark gates pass, and release-gated apply was explicitly requested. The plan also records SHA-256 input records for source paper/TEI, citation-intent gold labels, claim-extraction gold labels, and multimodal assets when those inputs are available, so the downstream apply report can carry them into `R3`. Even then, the orchestrator does not perform the graph write itself; an operator or graph mutation executor must review `graph-mutations.json` and apply it deliberately.

Standalone orchestration exposes the same plan:

```bash
npm run ingest:orchestrate -- \
  --output-dir artifacts/ingestion/run-001 \
  --tei-path artifacts/grobid/paper.tei.xml \
  --paper-path artifacts/parsed-paper.json \
  --citation-intent-gold-path artifacts/gold/citation-intents.json \
  --claim-gold-path artifacts/gold/claims.json \
  --graph-apply-mode release-gated
```

The command writes `graph-mutations.json` plus `graph-apply-plan.json`. The apply plan is the release-grade strategy boundary: it explains whether graph operations are preview-only, blocked, or ready for a separate explicit apply step.

The separate apply step is now handled by an explicit ingestion graph mutation executor:

```bash
npm run ingest:apply-graph-mutations -- \
  --graph-mutations-path artifacts/ingestion/run-001/graph-mutations.json \
  --graph-apply-plan-path artifacts/ingestion/run-001/graph-apply-plan.json \
  --corpus-root ./papers \
  --output-dir artifacts/ingestion/run-001/execution
```

This executor is dry-run by default. It validates the mutation operations against the selected corpus graph and writes `graph-mutation-execution-report.json`, `graph-mutation-execution-report.md`, `manifest.json`, and `rollback-manifest.json`. Preview runs are allowed even when the apply plan is `preview_only` or `blocked`, which is useful for operator review and schema validation, but they never write the authoritative graph.

Persisting requires an explicit apply flag:

```bash
npm run ingest:apply-graph-mutations -- \
  --graph-mutations-path artifacts/ingestion/run-001/graph-mutations.json \
  --graph-apply-plan-path artifacts/ingestion/run-001/graph-apply-plan.json \
  --corpus-root ./papers \
  --output-dir artifacts/ingestion/run-001/execution \
  --apply
```

The executor refuses actual writes unless `graph-apply-plan.json` has `status: "ready_to_apply"`, `canApply: true`, all apply gates passed, and non-empty mutation operations. When an authoritative write is performed, it records before/projected/after graph checksums, SHA-256 hashes for `graph-mutations.json` and `graph-apply-plan.json`, carries through the apply plan's source/gold-label/multimodal input hashes, and writes a pre-apply `before-graph-snapshot.json` referenced by the rollback manifest. This keeps P1 ingestion writes operator-controlled and auditable instead of letting parser artifacts silently mutate the main graph.

Pass `graph-mutation-execution-report.json` into `eval:idea-catalyst-release-gate` with `--ingestion-graph-mutation-execution` to satisfy `R3`. Dry-run or blocked reports remain useful for review, but they cannot pass the release gate.

Idea-Catalyst v2 artifacts can be converted into a dry-run graph mutation preview before any graph writeback:

```bash
npm run graph:innovation-writeback -- \
  --input-path idea-catalyst-artifact.json \
  --output-path mutation-preview.json
```

The writeback helper writes `papernexus-innovation-writeback-v1` artifacts using the existing `mutate_graph` operation shape. It maps contribution claims, source spans, citation contexts, must-cite papers, review concerns, storyline beats, and falsification plans to schema-valid node and relationship operations. By default it fails closed and emits no operations when contribution claims lack `source_span_ids`, storyline beats lack trace references, or must-cite evidence shows future leakage.

`POST /api/idea-catalyst-v2` and the MCP `idea_catalyst` tool can now run the same writeback path when `writeBack=true`. The default remains safe: PaperNexus builds and validates a dry-run preview against the selected corpus and returns `writeback.applyStatus="previewed"` without saving graph changes. Persisting requires an explicit apply signal, such as `writeBackApply=true`, `writeBackMode=apply`, or `writeBackDryRun=false`. Live-discovery-only responses can emit mutation operations, but graph validation/apply requires a corpus-backed graph path.

They all feed the same downstream contract:

- markdown cache under `.papernexus/markdown/<parser>/...`
- parsed paper structure
- semantic snapshot generation
- later graph stages

Parser choice should affect source preparation quality and runtime behavior, not the downstream graph engine contract.

## Parser Selection And Fallback

At runtime the parser flow is:

1. resolve the requested parser from CLI/config/defaults
2. reuse an existing parser-specific markdown cache when valid
3. run the selected parser
4. if that parser fails and a fallback is configured, rerun with the fallback parser
5. persist the parser run state and event log

Current fallback behavior:

| Primary parser | Fallback |
| --- | --- |
| `markitdown` | `docling` |
| `markpdfdown` | `docling` |
| `opendataloader` | `docling` |
| `marker` | `docling` |
| `mineru` | `docling` |
| `paddleocr-vl` | `docling` |
| `firecrawl` | `docling` |
| `docling` | none |

For `docling`, remote SSH fallback to `pdftotext` / `pypdf` is still available in the parser-specific code path when the configured remote host exists and the direct Docling parse fails.

### Degenerate title repair

Parser output from PDF tools can preserve the paper body but lose the title. Historically, PaperNexus treated that as a reason to re-run Docling. In production this caused unnecessary GPU work because many MarkItDown outputs were perfectly usable except for the title.

The current policy is:

- if the title is invalid and the body is weak, fallback to Docling
- if the title is invalid but the body is usable, repair the title from the source filename
- record the repair in `titleValidation`
- keep the primary parser markdown cache

The repaired snapshot records:

```json
{
  "titleValidation": {
    "usedFallbackTitle": true,
    "repairedFromDegenerateTitle": true,
    "needsReparse": false,
    "reason": "fallback-title-repair"
  }
}
```

This protects throughput while still preserving an audit signal that the parser did not recover a canonical title.

## Firecrawl Runtime

Firecrawl is an optional network-backed parser for teams that want a fast PDF-to-Markdown path without provisioning another local parser runtime. It is not the default parser. PaperNexus continues to default to `markitdown` with `docling` fallback, because academic-paper ingestion needs reproducibility, local cacheability, and careful validation of tables, formulas, citations, references, and figure evidence.

Firecrawl is best treated as a convenience parser for:

- quick paper import and triage
- public or locally staged PDFs where sending the file to Firecrawl is acceptable
- scanned PDFs when `firecrawlMode` is set to `ocr`
- throughput-sensitive queues where a remote parser is operationally simpler than local GPU scheduling

It should not be treated as the authoritative academic parser by itself. For submission-grade extraction, audit the generated markdown against the PDF, especially reference sections, mathematical notation, multi-column tables, algorithm blocks, figure captions, and citation anchors. If Firecrawl output is weak or the request fails, PaperNexus can still fall back to Docling unless fallback is explicitly disabled.

PaperNexus supports both Firecrawl document routes:

- local/private PDF upload through Firecrawl `/v2/parse`
- public PDF URL parsing through Firecrawl `/v2/scrape`

The default `firecrawlSourceMode` is `auto`: PaperNexus uses `/v2/scrape` only when a HTTP(S) PDF URL is available, otherwise it uploads the local PDF to `/v2/parse`. Set `firecrawlSourceMode` to `upload` or `url` when you need deterministic behavior.

Configuration uses environment-variable indirection for credentials. Do not put a raw Firecrawl API key in MCP arguments.

```json
{
  "analyze": {
    "pdfParser": "firecrawl",
    "firecrawlApiBaseUrl": "https://api.firecrawl.dev",
    "firecrawlApiKeyEnv": "FIRECRAWL_API_KEY",
    "firecrawlMode": "auto",
    "firecrawlSourceMode": "auto",
    "firecrawlMaxPages": null,
    "firecrawlTimeoutMs": 100000
  }
}
```

CLI example:

```bash
papernexus analyze ./papers \
  --pdf-parser firecrawl \
  --firecrawl-api-key-env FIRECRAWL_API_KEY \
  --firecrawl-mode auto
```

`firecrawlMode` accepts `fast`, `auto`, and `ocr`. `firecrawlMaxPages` can bound cost and latency for triage runs. Parser state and events record the endpoint, mode, and source mode, but never the resolved API key.

## MarkItDown Runtime

The PaperNexus wrapper for MarkItDown lives at [`scripts/markitdown_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/markitdown_to_markdown.py).

### Default behavior

By default PaperNexus attempts to reuse the project-level `llm.*` configuration for MarkItDown.

The behavior is:

- if project `llm.model` and `llm.baseUrl` are present, MarkItDown LLM mode auto-activates
- if an API key is required for the configured provider, PaperNexus resolves it the same way other LLM flows do
- if the project LLM config is missing or incomplete, MarkItDown automatically falls back to non-LLM mode
- if you explicitly set `markitdownUseLlm: false`, LLM mode is disabled even if project `llm.*` exists
- DeepSeek is treated as an OpenAI-compatible JSON-mode endpoint, but PaperNexus forces DeepSeek LLM extraction to single-item requests because DeepSeek does not support multi-paper batch prompts

This makes MarkItDown align with the rest of the system instead of demanding a second, parser-specific LLM configuration block.

### What MarkItDown receives

When LLM mode is active, PaperNexus passes these concepts into the wrapper:

- model name
- OpenAI-compatible base URL
- API key
- optional `llm_prompt`
- plugin enablement

Operationally, this means the same project LLM configuration can influence:

- MarkItDown parser assistance during `PDF -> Markdown`
- Stage 2 semantic extraction and relation extraction during `Markdown -> Graph`

Those are still separate phases, but they can now share one config source.

### MarkItDown logs

The wrapper now emits a much more informative stderr stream.

You should expect to see:

- input file name and size
- whether plugins are enabled
- whether LLM mode is enabled
- model and endpoint summary when LLM mode is active
- runtime loading
- conversion start
- periodic heartbeat messages during long runs
- output write completion and final markdown size

This is especially useful when one PDF takes much longer than others and you need to distinguish “deadlocked” from “still converting”.

## Docling Runtime And GPU Scheduling

Docling remains the heavy-duty fallback parser and the parser most likely to contend for GPU memory.

### Automatic GPU scheduling

When Docling is running on CUDA and `CUDA_VISIBLE_DEVICES` is not pinned, PaperNexus now:

- probes available GPUs with `nvidia-smi`
- filters by free memory threshold
- acquires a filesystem lock for the chosen GPU
- waits if no eligible GPU slot is available
- releases the GPU lock when parsing exits

This prevents the older failure mode where multiple Docling workers all pile onto one card and produce:

- CUDA OOM
- thread exhaustion
- downstream timeout cascades

### CPU thread caps

Docling runs now clamp:

- `OPENBLAS_NUM_THREADS`
- `OMP_NUM_THREADS`
- `MKL_NUM_THREADS`
- `NUMEXPR_NUM_THREADS`
- `VECLIB_MAXIMUM_THREADS`

This is meant to limit the “too many threads + too many parser processes” failure mode that showed up in real queue logs.

### Warmup behavior

When imports are enabled and Docling preload is on, `serve` performs a background Docling warmup. This does not replace actual parsing, but it reduces first-request cold start and surfaces obvious runtime issues earlier.

### When Docling is not the bottleneck

A common debugging mistake is to assume every slow PDF import is a Docling/GPU issue. Recent production timing showed the opposite for many imports:

- PDF to Markdown: roughly sub-second to low seconds
- materialize: roughly one or two seconds
- LLM Stage 2: tens of seconds
- fast commit: a few seconds

If `nvidia-smi` shows idle GPUs and the task is in `llm-optimize`, tuning Docling parallelism will not improve the current task. Focus on import batching, LLM provider latency, and `changedSourceKeys` scope instead.

## Parser State Persistence

One of the biggest operational changes is that PDF parser runs are now persisted.

Global parser state is stored under:

```text
~/.papernexus/pdf-parser/
```

The layout is:

```text
~/.papernexus/pdf-parser/
  latest/
    <sourceHash>.json
  runs/
    <runId>/
      state.json
      events.log
```

### `runs/<runId>/state.json`

This file records the latest durable state for one parser run. Typical fields include:

- `selectedParser`
- `activeParser`
- `fallbackFromParser`
- `status`
- `currentStep`
- `message`
- `parserCommand`
- `sourcePath`
- `sourceKey`
- `importTaskId`
- `importStage`
- `startedAt`
- `updatedAt`
- `finishedAt`

### `runs/<runId>/events.log`

This is an append-only event stream for the parser run.

It records:

- parser stdout/stderr lines that PaperNexus forwarded
- fallback transitions
- waiting-for-resource messages
- completion/failure markers

### `latest/<sourceHash>.json`

This file is a per-PDF pointer to the newest known run. It lets you find the active or most recent parser run without scanning the entire `runs/` directory.

### Restart semantics

If PaperNexus starts a new parse for the same PDF while an older run is still non-terminal, the old run is marked `interrupted` and the new run becomes the active `latest` pointer.

This is important for restart recovery because it lets you distinguish:

- the currently relevant run
- an abandoned pre-restart run

## Import Queue And Parser State

When PDF parsing happens through the import worker, parser state is linked back to the queue task.

The parser state includes:

- `importTaskId`
- `importStage`
- corpus `rootPath`
- optional `sourceKey`

That means you can connect:

- import task logs under `.papernexus/imports/tasks/...`
- parser state under `~/.papernexus/pdf-parser/...`

without guessing which PDF run belongs to which queue item.

## Queue Interaction

Parser state is only one part of the operational story. The current import queue protections are:

- background PDF preparse for later queued tasks
- timeout-based failure for `running` tasks that stop emitting progress
- quarantine for stale `pending` tasks that sit in `queued` for too long while no task is actively running
- automatic failed-task recovery when uploaded source files still exist
- automatic completed/superseded marking when an equivalent later task already succeeded

The quarantine path is stored per corpus under:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

Each quarantine batch contains:

- `summary.json`
- one directory per quarantined task
- the preserved task metadata and logs

This is intentionally not a hard delete. The purpose is to unblock the live queue while keeping enough evidence to audit and selectively resubmit work.

## Parser State Versus Import State

Use parser state when you need to know what happened inside `PDF -> Markdown`.

Use import state when you need to know whether the paper entered the graph.

Those are related but not identical:

- a parser run can complete while import fast-commit later fails
- a failed import task can be superseded by a later completed task
- a parser run can be interrupted and replaced by a newer parser run for the same source
- a PDF can have a successful MarkItDown run and never need Docling

For workflow automation, the final success condition is still:

```text
import task status = completed
import task stage = completed
```

If a task is `completed` with `recovery.status = superseded`, it is also safe to continue; the paper was recovered by an equivalent completed task.

## Recommended Config Shapes

### Normal local default

```json
{
  "analyze": {
    "pdfParser": "markitdown",
    "markitdownPython": "python3",
    "doclingCommand": "docling"
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeySource": "keychain"
  }
}
```

### DeepSeek JSON-mode cloud provider

```json
{
  "analyze": {
    "pdfParser": "markitdown",
    "markitdownPython": "python3",
    "doclingCommand": "docling"
  },
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com",
    "batchSize": 1,
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  }
}
```

### Remote Docling with GPU scheduling

```json
{
  "analyze": {
    "pdfParser": "markitdown",
    "doclingCommand": "docling",
    "doclingSshHost": "user@example-gpu",
    "doclingAutoGpu": true,
    "doclingGpuMinFreeMb": 18000,
    "doclingGpuWaitTimeoutMs": 1800000,
    "doclingCpuThreads": 4
  }
}
```

### Explicitly disable MarkItDown LLM reuse

```json
{
  "analyze": {
    "pdfParser": "markitdown",
    "markitdownUseLlm": false
  }
}
```

### Firecrawl network parser

```json
{
  "analyze": {
    "pdfParser": "firecrawl",
    "firecrawlApiBaseUrl": "https://api.firecrawl.dev",
    "firecrawlApiKeyEnv": "FIRECRAWL_API_KEY",
    "firecrawlMode": "auto",
    "firecrawlSourceMode": "auto",
    "firecrawlTimeoutMs": 100000
  }
}
```

## Operational Debug Checklist

When a PDF parse appears stuck, check these in order:

1. Does `test-pdf-to-markdown` print a `Parse state:` path?
2. Does `events.log` show heartbeats or did it stop entirely?
3. Is `state.json` in `waiting-resource`, `running`, `fallback`, or `interrupted`?
4. If Docling is involved, is it waiting for GPU or did it already secure one?
5. If the parse came from the import queue, what does the matching import task log say?
6. If the task never became `running`, the problem is queue consumption rather than parser execution.

## Read Next

- [Imports And Queue](/pipeline/imports-and-queue)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
- [Operations Overview](/operations/)
