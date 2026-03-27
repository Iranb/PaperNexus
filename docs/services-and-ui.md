# Services And UI

PaperNexus can run as a foreground CLI tool, a local dashboard server, or a macOS background service pair.

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

`POST /api/imports` currently accepts JSON, not multipart form data.
All of these routes require the PaperNexus API token as `Authorization: Bearer <token>` or `x-papernexus-token`.

Body shape:

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

Important behavior:

- uploaded files are written under `.papernexus/imports/tasks/<taskId>/sources/`
- they stay outside the main paper source directory
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
