# Literature Discovery

`literature_discovery` is the explicit MCP bridge for fresh topic search. It searches configured providers, merges candidate metadata, optionally resolves legal full-text sources, persists discovery artifacts, and can submit resolved sources to the import queue.

It is upstream of the graph. Discovery candidates are not graph evidence until an import task completes and the authoritative graph sync is visible through `import_workflow`.

## Code-Aligned Contract

The public tool is declared in `src/mcp/tools.js`, implemented by `src/mcp/tool-literature-discovery.js`, and backed by `src/core/discovery`.

| Operation | Main Behavior | Graph Visibility |
| --- | --- | --- |
| `plan` | Build a query plan without resolving a corpus. | None |
| `search` | Run bounded metadata search. Source resolution is disabled by default for this operation. | None |
| `resolve` | Search and resolve legal Markdown/PDF sources or access hints. | None |
| `run` | Default discovery run with persisted artifacts and source-resolution behavior from arguments/config. | None |
| `import` | Submit resolved full-text sources to the import queue. | Not visible until import and graph sync complete |
| `ingest`, `import_and_process` | Submit resolved sources and run import processing inline. | Visible only after completed import and graph sync |
| `supplement` | Add or correct one candidate in an existing run, optionally importing it. | Same import boundary |
| `status`, `report`, `list` | Inspect persisted discovery runs. | Read-only |

Use `import_workflow wait` or `queue_progress` as the readiness check before depending on newly discovered papers in `query`, `research_lookup`, `research_briefing`, `idea_catalyst mode=graph`, or most `agent_materials` reads.

## Providers

The default provider set is:

- `openalex`
- `semantic_scholar`
- `crossref`
- `arxiv`

PaperNexus can add provider families based on hints and config:

- `dblp` for computer-science plans
- `europe_pmc` / `pubmed` for biomedical plans
- `core` when a CORE API key is configured
- opt-in `papers_cool` and `pasa`

`unpaywall` is not a general search provider. It is used during DOI/source resolution. `openreview`, `papers_with_code`, and `datacite` are recognized provider names in the allow-list, but the stable documented workflow should rely on the implemented provider paths above unless code support is expanded.

## Search Profiles

`operation=search` uses bounded profiles and returns partial diagnostics when the budget, query cap, timeout, or provider rate limit truncates work.

| `searchMode` | Budget | Query Cap | Queries Per Provider |
| --- | ---: | ---: | ---: |
| `quick` | 25s | 4 | 2 |
| `balanced` | 45s | 6 | 3 |
| `deep` | 90s | 10 | 3 |

Through the MCP tool, `searchMode` defaults to `deep`. Set `quick` for interactive probes and `balanced` when latency matters more than recall.

Search-mode LLM query planning is rule-based by default unless `llmQueryPlanner=true` or `planningMode=llm_augmented` is passed. If LLM planning is enabled and fails or times out, deterministic planning is used.

## Source Resolution And Access Policy

Source resolution is open-access first. PaperNexus records status instead of bypassing access controls.

Important statuses include:

- `open_pdf`
- `open_markdown`
- `needs_institution`
- `no_open_pdf`
- `anti_bot_blocked`
- `html_not_pdf`
- `metadata_only`

When `allowDownloads=false`, PaperNexus records URLs and access hints without downloading files. When downloads are enabled, Markdown is preferred before PDF unless configured otherwise.

## Import Boundary

Import is explicit:

```text
literature_discovery search/resolve/run
  -> discovery artifacts
  -> importResolved=true or operation=import/ingest/import_and_process
  -> import queue task
  -> import_workflow wait
  -> completed authoritative graph sync
  -> graph-visible evidence
```

Inline import processing defaults to logical batching with `importBatchEnabled=true` and `importBatchMaxTasks=8`. Even when inline processing is requested, callers should still check the final task and graph-sync state before calling a paper "in graph".

## Artifacts

Persisted runs live under the selected corpus `.papernexus` state and include machine-readable run JSON plus a Markdown report. A run records:

- query plan
- provider query results
- merged candidates
- source-resolution summary
- citation expansion summary
- metadata graph
- coverage verdict
- access policy
- optional import status per candidate

## Read Next

- [Remote Import And Skills](/interfaces/remote-import-and-skills)
- [Pipeline Overview](/pipeline/)
- [Generated MCP Tool Reference](/reference/generated/mcp-tools)
