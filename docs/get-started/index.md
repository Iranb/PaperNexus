# Get Started

This section is the shortest correct path from a fresh clone to a working PaperNexus graph and browser UI.

## 1. Install Dependencies

From the repository root:

```bash
npm install
npm link
```

PaperNexus itself is a Node-based application, but PDF analysis depends on parser tooling. The default parser path uses MarkItDown. If the first parser run fails or produces weak markdown, PaperNexus automatically retries the PDF with Docling before indexing it:

```bash
python -m pip install -U markitdown
```

If you want one shared Python runtime setting for MarkItDown, MarkPDFDown, OpenDataLoader, Docling VLM, and PaddleOCR-VL, set `analyze.pythonCommand`. Parser-specific fields like `markitdownPython` and `markpdfdownPython` still work and override the shared default when needed.

Optional parser families can be installed separately:

```bash
python -m pip install -U markpdfdown
python -m pip install -U opendataloader-pdf
pip install docling marker-pdf
python -m pip install -U "paddleocr[doc-parser]"
```

If you want Docling to use its VLM pipeline during fallback parsing, enable `analyze.doclingUseVlm` and reuse the normal PaperNexus `llm` config.

For the default Docling CLI fallback path, PaperNexus now assumes a GPU-first profile:

- `analyze.doclingDevice = "cuda"`
- `analyze.doclingImageExportMode = "placeholder"`
- `analyze.doclingEnrichPictureClasses = false`
- `analyze.doclingEnrichPictureDescription = false`
- `analyze.doclingPreload = true`

If a machine has multiple GPUs, set `analyze.doclingCudaVisibleDevices` to a value such as `"0"` or `"2"`. If you want Docling to reuse a shared model cache across runs, set `analyze.doclingArtifactsPath`.

## 2. Create Or Choose A Paper Source Directory

The conventional default is:

```text
~/.papernexus/papers
```

You can put one paper per file under that tree. Markdown should be full-paper markdown rather than notes.

## 3. Initialize Runtime Config

Run:

```bash
papernexus init
```

The main values it helps you establish are:

- source paper directory
- corpus name
- index root
- optional LLM provider settings
- serve token and interface defaults

The runtime config usually lives at `~/.papernexus/config.json`.

## 4. Build The First Corpus

For the first build, use:

```bash
papernexus analyze --force
```

That runs the full staged pipeline over the provided source directory and writes the first authoritative graph plus lite view.

## 5. Start The Browser UI

Run:

```bash
papernexus serve
```

Then open:

```text
http://127.0.0.1:4821
```

If `serve.apiToken` is configured, the dashboard expects that bearer token for `/api/*` and remote MCP access.

## 6. Optional: Use The Remote MCP Surface

When `serve.mcp.enabled` is true, `papernexus serve` exposes a streamable HTTP MCP endpoint, typically:

```text
http://127.0.0.1:4821/mcp
```

This is the preferred control plane for live graph automation, especially for remote imports and queue monitoring.

## 7. Optional: Run Fresh Literature Discovery

Fresh topic search is not part of `papernexus analyze`. It is an explicit MCP workflow exposed as `literature_discovery`.

Use it when you need new candidate papers before importing them into the graph:

```json
{
  "operation": "search",
  "topic": "retrieval augmented experiment planning",
  "searchMode": "quick",
  "allowDownloads": false
}
```

Use `operation=run` or `resolve` when you want source-resolution artifacts. Use `importResolved=true`, `operation=import`, `operation=ingest`, or `import_workflow` only when resolved full-text sources should enter the import queue.

The important boundary is graph visibility:

```text
literature_discovery artifacts
  -> optional import task
  -> import worker
  -> authoritative graph sync
  -> research_lookup / query / context / agent_materials
```

Do not expect `query`, `research_lookup`, or `agent_materials` to see newly discovered papers until the relevant import task reports completed graph sync.

## Recommended First Reads After Setup

- [Pipeline Overview](/pipeline/)
- [Literature Discovery](/literature-discovery/)
- [Interfaces Overview](/interfaces/)
- [Remote Import And Skills](/interfaces/remote-import-and-skills)
- [Storage Overview](/storage/)
- [Generated Configuration Reference](/reference/generated/config)
