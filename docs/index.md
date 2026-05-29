---
layout: home

hero:
  name: PaperNexus
  text: Analysis-first research knowledge graphs for paper corpora
  tagline: Build reusable paper snapshots, multilayer graphs, remote MCP workflows, bounded literature-discovery bridges, and cross-domain ideation over committed graph evidence.
  actions:
    - theme: brand
      text: Get Started
      link: /get-started/
    - theme: alt
      text: Architecture Overview
      link: /overview/
    - theme: alt
      text: Generated Reference
      link: /reference/

features:
  - title: Cache-first staged pipeline
    details: Materialize, optimize, build, merge, and write are resumable stages rather than a monolithic all-or-nothing rebuild.
  - title: Recoverable import queues
    details: Upload tasks keep durable logs, retry failed work when source files still exist, and mark historical failures completed when later equivalent imports already succeeded.
  - title: Graph-native research analysis
    details: Query, context, impact, brainstorming, catalyst, bridge retrieval, structural analogy, and interdisciplinary ranking all operate on indexed graph state.
  - title: Remote MCP control plane
    details: Live graph automation flows through authenticated streamable HTTP MCP instead of brittle ad-hoc API calls.
  - title: Incremental by design
    details: Lite views, import queues, authoritative sync, derived graph summaries, and domain distance metadata all support fast refresh paths.
---

## What This Site Covers

This site is the maintained technical documentation for the current `PaperNexus` system. It replaces the older split between README notes, `docs/` pages, manual walkthrough fragments, and scattered design markdown.

The goal is to make three things easy:

1. understand what PaperNexus is responsible for
2. understand how the codebase is organized internally
3. find an authoritative operational or reference answer without reverse-engineering the repository

## Scope Boundary

PaperNexus is an **analysis and knowledge-graph engine for paper corpora**, with a clear separation between committed graph state and optional upstream discovery/import workflows.

It is responsible for:

- PDF and Markdown ingestion
- cache-first semantic snapshot generation
- multilayer graph construction
- graph-native search, context, impact, and ideation
- queued import processing and background graph refresh
- bounded MCP literature discovery, legal source-resolution reporting, and optional import submission
- local and remote MCP interfaces over already-indexed corpora and selected upstream workflows

It is not responsible for:

- making discovery results graph-visible before import tasks and authoritative graph sync complete
- bypassing paywalls, CAPTCHAs, institutional authentication, or anti-bot restrictions
- selecting final research directions, proving novelty, or running experiments
- orchestrating a general autonomous multi-agent research workflow outside the graph/material backend

## Docs Hubs

<div class="paper-grid">
  <a class="paper-card" href="/overview/">
    <strong>Overview</strong>
    <span>System goals, architecture, responsibility boundaries, and the conceptual model behind PaperNexus.</span>
  </a>
  <a class="paper-card" href="/get-started/">
    <strong>Get Started</strong>
    <span>Installation, first corpus build, dashboard startup, and remote MCP entry paths.</span>
  </a>
  <a class="paper-card" href="/pipeline/">
    <strong>Pipeline</strong>
    <span>Detailed coverage of staged analysis, imports, queueing, workers, and incremental refresh.</span>
  </a>
  <a class="paper-card" href="/literature-discovery/">
    <strong>Literature Discovery</strong>
    <span>MCP topic search, provider defaults, legal source resolution, and the import boundary before graph visibility.</span>
  </a>
  <a class="paper-card" href="/graph/">
    <strong>Graph</strong>
    <span>Node layers, schema, catalyst extensions, challenge and takeaway layers, and cross-domain reasoning.</span>
  </a>
  <a class="paper-card" href="/interfaces/">
    <strong>Interfaces</strong>
    <span>CLI, MCP, browser UI, authenticated HTTP serve routes, and skill-local remote wrappers.</span>
  </a>
  <a class="paper-card" href="/agent-materials/">
    <strong>Agent Materials</strong>
    <span>Material packs, project overlays, source-discovery plans, innovation evidence packs, and research-controller artifacts.</span>
  </a>
  <a class="paper-card" href="/storage/">
    <strong>Storage</strong>
    <span>Corpus layout, source manifests, snapshots, lite graph, queues, and background state stores.</span>
  </a>
  <a class="paper-card" href="/operations/">
    <strong>Operations</strong>
    <span>Configuration, deployment, PM2 and service management, logs, and troubleshooting.</span>
  </a>
  <a class="paper-card" href="/reference/">
    <strong>Reference</strong>
    <span>Auto-generated CLI, MCP, config, graph schema, HTTP route, module map, and script references.</span>
  </a>
</div>

## Maintenance Model

This site is designed around **automatic regeneration where possible**.

- Narrative guides and architecture explanations are curated Markdown pages.
- CLI, MCP, graph schema, config, HTTP route, module map, and script references are generated with `npm run docs:generate`.
- GitHub Pages deployment is driven by the repository workflow at [docs.yml](https://github.com/papernexus/PaperNexus/blob/main/.github/workflows/docs.yml).

If you change runtime behavior, the expected maintenance path is:

```bash
npm run docs:generate
npm run docs:build
```

Then update any surrounding narrative pages whose conceptual explanation changed.
