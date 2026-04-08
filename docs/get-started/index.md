# Get Started

This section is the shortest correct path from a fresh clone to a working PaperNexus graph and browser UI.

## 1. Install Dependencies

From the repository root:

```bash
npm install
npm link
```

PaperNexus itself is a Node-based application, but PDF analysis depends on parser tooling. The default parser path uses MarkPDFDown with the same `llm` configuration PaperNexus already uses for semantic extraction. If the first parser run fails or produces a degenerate title such as `Abstract`, PaperNexus automatically retries the PDF with Docling before indexing it:

```bash
python -m pip install -U markpdfdown
```

Optional parser families can be installed separately:

```bash
python -m pip install -U opendataloader-pdf
pip install docling marker-pdf
python -m pip install -U "paddleocr[doc-parser]"
```

If you want Docling to use its VLM pipeline during fallback parsing, enable `analyze.doclingUseVlm` and reuse the normal PaperNexus `llm` config.

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

## Recommended First Reads After Setup

- [Pipeline Overview](/pipeline/)
- [Interfaces Overview](/interfaces/)
- [Storage Overview](/storage/)
- [Generated Configuration Reference](/reference/generated/config)
