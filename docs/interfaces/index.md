# Interfaces Overview

PaperNexus exposes the same underlying graph state through several interface styles, each optimized for a different class of user or caller.

## CLI

The CLI is the operator surface for:

- first-time setup
- staged builds
- local inspection
- service startup
- backup and restore

It is the best interface for humans running the system directly.

## Browser UI

`papernexus serve` exposes a browser dashboard for inspecting corpora, runtime config, graph summaries, and paper-level overlays. It is the easiest way to visualize the current state of one running graph.

## Authenticated HTTP Server

The server also exposes authenticated `/api/*` routes. These are real and useful, but they are no longer the recommended control plane for live automation.

## MCP

PaperNexus supports both:

- local stdio MCP
- remote streamable HTTP MCP

Remote HTTP MCP is the recommended control plane for live graph operations because it gives callers typed tool surfaces instead of forcing them to invent raw route shapes.

## Skill-Local Wrappers

The repository also ships Python wrappers inside `SKILL/**/scripts`.

These wrappers are important because they solve real integration problems for agents:

- staging local files to a remote server
- resolving task ids from paper ids and local registries
- querying queue progress in batch form
- hiding JSON-RPC details behind typed command wrappers

## Interface Selection Rule Of Thumb

- use CLI for local operator workflows
- use browser UI for live inspection
- use remote HTTP MCP for live automation
- use skill-local wrappers for agent workflows that need remote import, queue, or graph lookup convenience

## Contract Stability Strategy

PaperNexus tries to keep interface stability highest at these layers:

1. MCP tool names and input contracts
2. canonical skill-local wrapper commands
3. CLI commands intended for operators

Raw `/api/*` route usage is intentionally de-emphasized for live automation because agents are more likely to invent or drift from those contracts over time.

## Read Next

- [Remote Import And Skills](/interfaces/remote-import-and-skills)
- [Generated MCP Tool Reference](/reference/generated/mcp-tools)
- [Generated HTTP Serve Reference](/reference/generated/http-serve)
