# PDF Parsers And Runtime

This page documents the current PDF parsing layer as it exists in the repository today.

It focuses on:

- which parser is used by default
- how fallback works
- how parser-local LLM assistance works
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

## MarkItDown Runtime

The PaperNexus wrapper for MarkItDown lives at [`scripts/markitdown_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/markitdown_to_markdown.py).

### Default behavior

By default PaperNexus attempts to reuse the project-level `llm.*` configuration for MarkItDown.

The behavior is:

- if project `llm.model` and `llm.baseUrl` are present, MarkItDown LLM mode auto-activates
- if an API key is required for the configured provider, PaperNexus resolves it the same way other LLM flows do
- if the project LLM config is missing or incomplete, MarkItDown automatically falls back to non-LLM mode
- if you explicitly set `markitdownUseLlm: false`, LLM mode is disabled even if project `llm.*` exists

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
