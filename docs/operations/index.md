# Operations Overview

This section focuses on running PaperNexus as a durable system rather than as a one-off local CLI command.

## Configuration

Runtime behavior is controlled by the discovered or explicitly supplied config file, usually `~/.papernexus/config.json`. Configuration decides:

- source inputs
- storage roots
- parser defaults
- LLM provider defaults
- server host, port, token, and MCP settings

## Deployment Modes

The system supports several deployment patterns:

- foreground local CLI use
- local browser dashboard
- background services
- remote authenticated HTTP serve with remote MCP

## PM2 And Service Wrappers

For long-running server processes, the repository includes service wrappers and a PM2-oriented serve wrapper that handles:

- starting `papernexus serve`
- daily log rollover
- status inspection
- focused recent import log extraction

## Logs

There are several useful log perspectives:

- CLI stdout for one-shot local commands
- serve logs for browser/API/MCP and worker startup
- import task logs for per-task detail
- PM2 wrapper daily logs for recent processing history

## Documentation Maintenance

The docs site itself is now part of operations because it ships with the repository and deploys through GitHub Pages.

The maintenance loop is:

```bash
npm run docs:generate
npm run docs:build
```

When behavior changes, update whichever of these two layers is affected:

- generated references if the code contract changed
- curated narrative pages if the design explanation changed

## Troubleshooting Style

Operational debugging in PaperNexus usually works best when you identify the failing layer first:

- source parsing
- semantic extraction
- graph commit
- queue state
- interface misuse
- background worker scheduling

Trying to debug everything at the HTTP surface alone usually hides the real cause.

## Read Next

- [Generated Config Reference](/reference/generated/config)
- [Generated HTTP Serve Reference](/reference/generated/http-serve)
- [Generated Scripts Reference](/reference/generated/scripts)
