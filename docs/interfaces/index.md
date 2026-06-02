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

The public MCP surface has five practical groups:

| Group | Tools | What They Operate On |
| --- | --- | --- |
| Corpus and graph reads | `list_corpora`, `corpus_status`, `corpus_sources`, `query`, `context`, `impact`, `ideas`, `brainstorm`, `domain_distance`, `extract_takeaways`, `interdisciplinary_potential` | Already committed corpus graph state |
| High-level research reads | `research_lookup`, `research_briefing`, `idea_catalyst` | Already committed graph state plus bounded derived packets |
| Import and discovery | `literature_discovery`, `literature_discovery_progress`, `import_workflow` | Discovery artifacts, progress snapshots, and import queues |
| Runtime and graph maintenance | `runtime_init`, `create_corpus`, `refresh_corpus`, `refresh_paper_graph`, `mutate_graph` | Runtime config, corpus build/refresh jobs, and schema-aware graph mutations |
| Agent material backend | `agent_materials` | Committed graph/source materials plus project overlay state outside the raw graph |

Two boundaries matter for callers:

- `literature_discovery` produces candidate and source-resolution artifacts before graph ingestion.
- `literature_discovery_progress` is the read-only status/ETA check for long-running discovery jobs.
- `research_lookup`, `query`, `context`, and most `agent_materials` material reads only treat papers as graph evidence after import completion and graph sync.

## Skill-Local Wrappers

The repository also ships Python wrappers inside `SKILL/**/scripts`.

These wrappers are important because they solve real integration problems for agents:

- staging local files to a remote server
- resolving task ids from paper ids and local registries
- querying queue progress in batch form
- hiding JSON-RPC details behind typed command wrappers

The wrappers are convenience entrypoints over MCP contracts. They should not fork protocol behavior, call private `/api/*` routes for live graph work, or treat provider-only discovery hits as committed graph evidence.

## Interface Selection Rule Of Thumb

- use CLI for local operator workflows
- use browser UI for live inspection
- use remote HTTP MCP for live automation
- use skill-local wrappers for agent workflows that need remote import, queue, or graph lookup convenience
- use `literature_discovery` for fresh topic search and source resolution
- use `import_workflow` as the readiness check before graph queries depend on newly imported papers
- use `runtime_init` and `create_corpus` for server-side setup/build workflows exposed through MCP
- use `agent_materials` for evidence packs, overlay memory, and approval-gated research-controller artifacts

## Contract Stability Strategy

PaperNexus tries to keep interface stability highest at these layers:

1. MCP tool names and input contracts
2. canonical skill-local wrapper commands
3. CLI commands intended for operators

Raw `/api/*` route usage is intentionally de-emphasized for live automation because agents are more likely to invent or drift from those contracts over time.

## Read Next

- [MCP And Skill Contract Guardrails](/interfaces/mcp-skill-contracts)
- [Literature Discovery](/literature-discovery/)
- [Remote Import And Skills](/interfaces/remote-import-and-skills)
- [Agent Material Backend](/agent-materials/)
- [Generated MCP Tool Reference](/reference/generated/mcp-tools)
- [Generated HTTP Serve Reference](/reference/generated/http-serve)
