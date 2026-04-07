# Services And UI

PaperNexus can run as a foreground CLI tool, a local dashboard server, or a macOS background service pair.

## Scope Boundary

PaperNexus owns analysis and knowledge-graph construction for papers and corpora you already provide.

It is responsible for:

- PDF / Markdown ingestion
- semantic extraction
- evidence grounding
- graph construction and graph-native analysis views

It is not responsible for:

- finding papers from external literature sources
- web search, Semantic Scholar, or arXiv discovery flows
- multi-agent workflow orchestration outside the graph

In practice:

- use `analyze`, `materialize`, or `POST /api/imports` with already-provided files, corpora, or manifests
- use `query`, `catalyst`, `context`, `impact`, and enhancement APIs on already-indexed graph state
- keep discovery and orchestration in the surrounding system that calls PaperNexus

## Dashboard

Start the local UI with:

```bash
papernexus serve
```

Default address:

```text
http://127.0.0.1:4821
```

All `/api/*` routes require an API token. Configure it with `serve.apiToken` or `PAPERNEXUS_API_TOKEN`.

If you open the dashboard in a browser, you can pass the token once as:

```text
http://127.0.0.1:4821/?token=your-secret-token
```

The client stores it locally and reuses it for later API calls.

The dashboard is the easiest way to inspect:

- corpus metadata
- current graph state
- enhancement summaries
- paper-level overlays
- current provider and runtime settings

## Background Services

Install the default background setup with:

```bash
papernexus service install
```

This installs both:

- `watch`
- `serve`

Check status:

```bash
papernexus service status
```

Remove services:

```bash
papernexus service uninstall
```

### macOS Launchd Behavior

PaperNexus currently uses `launchd` on macOS.

Installed services map to:

- `com.papernexus.watch`
- `com.papernexus.serve`

They are stored under:

```text
~/Library/LaunchAgents/
```

## What `watch` Does

`watch` is the background file-monitoring service.

It:

- monitors the configured paper source directories
- triggers incremental rebuilds when source files change
- writes a temporary watch log for quick health checks

You normally do not need to run both `papernexus watch` and `papernexus service install`. The foreground command is best for debugging; the installed service is best for daily background operation.

## Watch Logs

Show the watch log with:

```bash
papernexus logs watch
```

This command prints the current temp log path and, when the file exists, its contents.

PaperNexus also writes structured watch output to a temp file derived from the corpus root, so you can check whether background reindexing is actually happening.

## What `serve` Does

`serve` provides:

- the dashboard
- the local API used by the UI
- the enhancement worker
- the import-task worker that processes queued uploaded PDF/Markdown jobs

It does not replace `watch`. If you want both live file monitoring and the UI in the background, use `papernexus service install`.

## Import API

The dashboard server now exposes queued import-task endpoints for ad hoc paper uploads.

Routes:

- `GET /api/imports`
- `POST /api/imports`
- `GET /api/imports/:taskId`
- `GET /api/imports/:taskId/log`
- `POST /api/query`
- `POST /api/context`
- `POST /api/impact`
- `POST /api/ideas`
- `POST /api/brainstorm`
- `POST /api/path-trace`
- `POST /api/evidence-chain`
- `POST /api/reflection-chain`
- `POST /api/research-brief`
- `POST /api/brainstorm-brief`
- `POST /api/theory-brief`
- `POST /api/storyline-brief`

`POST /api/imports` currently accepts JSON, not multipart form data.
All of these routes require the PaperNexus API token as `Authorization: Bearer <token>` or `x-papernexus-token`.

Body shape for content upload:

```json
{
  "files": [
    {
      "name": "paper.md",
      "mimeType": "text/markdown",
      "contentBase64": "..."
    }
  ]
}
```

Body shape for server-side single-file import:

```json
{
  "serverFilePath": "/absolute/path/on/the/api/server/paper.pdf"
}
```

Important behavior:

- uploaded files are written under `.papernexus/imports/tasks/<taskId>/sources/`
- they stay outside the main paper source directory
- `serverFilePath` is resolved on the API server machine, not on the client that sent the HTTP request
- `serverFilePath` must point to a single absolute file path; directories and recursive collection are not supported
- provide either `files` or `serverFilePath`, not both
- the import worker processes them asynchronously
- successful tasks can merge into the main graph
- task-specific logs are available through `GET /api/imports/:taskId/log`

## Checking Whether Background Work Is Real

The practical checklist is:

1. `papernexus service status`
2. `papernexus logs watch`
3. touch or edit a file under the paper source directory
4. rerun `papernexus logs watch`

You should see either:

- a scheduled rebuild
- a completed reindex
- or a no-change decision

## MCP Mode

PaperNexus also exposes an MCP server:

```bash
papernexus mcp
papernexus setup
```

This is useful when another agent or tool should query the graph, request context, or perform controlled graph mutation flows.

For remote MCP over HTTP, enable `serve.mcp.enabled`, restart `papernexus serve`, and connect to `http://<host>:4821/mcp` with the same bearer token used for `/api/*`.

## Service-Friendly Daily Workflow

For normal long-lived operation:

```bash
papernexus init
papernexus analyze
papernexus service install
papernexus service status
papernexus logs watch
```

After that, add or edit papers under the configured source directory and let the background services keep the corpus fresh.
