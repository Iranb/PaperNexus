# Research workflows and MCP migration

PaperNexus now organizes its default MCP tool list by research task. The original 23 tools combined atomic graph actions, aggregate lookups, report formats, materials, queue control and runtime maintenance. The same search or brainstorming capability could appear in several tools. The default is four entry points with operation-specific schemas and validation.

| User task | Default tool | Operations |
| --- | --- | --- |
| Find and understand papers | `literature_review` | corpora, status, sources, search, paper, survey, discover, discovery_status, discovery_report, import, import_status |
| Analyze research lineage | `lineage_analysis` | landscape, overview, problem, method, evidence, path, context, impact |
| Generate and assess ideas | `idea_generation` | generate, diverge, converge, gaps, evaluate, experiment_materials |
| Decide from experimental feedback | `research_decision` | init, status, evidence_view, register_hypotheses, register_actions, record_run, assess_results, recommend_next, update_opportunities, refresh_evidence, export |

## How capabilities were merged

`query` and `research_lookup/query` become `literature_review/search`. Single-paper index/source reading and `agent_materials/paper_material_view` are presented through `paper`; material grouping becomes `survey`. Literature discovery and its standalone progress tool share the same review entry point, alongside explicit source import and status tracking.

`research_lookup` method lineage, method evidence, problem evolution and topic analysis move to `lineage_analysis`. `context`, `impact` and briefing path tracing join them. Distinct graph evidence operations stay selectable because they answer different questions; a traversal and a validated evolution edge are not interchangeable.

`ideas`, `brainstorm`, `idea_catalyst` and innovation material packs move to `idea_generation`. `generate` uses graph ideas by default and cross-domain catalyst when `targetDomain` is supplied. Optional `project` adds saved experimental feedback and explicit candidate links. `diverge` and `converge` express the two brainstorming stages. `gaps` compiles structural gaps; default `evaluate` audits a concrete `candidateMechanism`. Its `mechanism_diagnosis` and `performance_validation` purposes instead require project/actionId and review a registered action. `experiment_materials` collects source-backed experimental and cost anchors; it does not execute or complete an experiment.

Runtime initialization, corpus creation/refresh, raw graph mutation, overlay editing, evidence-cart persistence and the research controller remain advanced operations. They are available through their unchanged old tool names in the legacy/all catalog. They are not hidden arbitrary subcommands inside the original three research tools. Project decision state has its own explicit [research_decision contract](./research-decision.md).

## Normal research flow

    {"operation":"corpora"}

Call that through `literature_review` when the corpus is unknown. Then:

    {"operation":"search","corpus":"demo","query":"feedback calibration","limit":5}
    {"operation":"paper","corpus":"demo","paperId":"paper:example"}
    {"operation":"survey","corpus":"demo","query":"feedback calibration"}

For lineage, call `lineage_analysis`:

    {"operation":"landscape","corpus":"demo","query":"feedback calibration","fromYear":2010,"maxNodes":300}
    {"operation":"overview","corpus":"demo","query":"feedback calibration","maxDepth":2,"maxNodes":180}
    {"operation":"overview","corpus":"demo","query":"feedback calibration","constraints":{"labelsAvailable":false,"maxLatencyMs":40}}
    {"operation":"method","corpus":"demo","method":"method:example","direction":"backward","maxDepth":3}
    {"operation":"evidence","corpus":"demo","edgeId":"edge:example"}

`landscape` returns a field timeline with paper/method views, connected families, structural mainlines and source-backed turning-point candidates. The browser's **Build evolution map** uses the same result. See [field evolution](../operations/field-evolution.md) for selection, coverage, evidence and visualization semantics.

For proposals, call `idea_generation`:

    {"operation":"generate","corpus":"demo","query":"feedback calibration","targetDomain":"Education"}
    {"operation":"evaluate","corpus":"demo","query":"feedback calibration","candidateMechanism":"Calibrate confidence before feedback control"}

For saved project feedback, call `research_decision`, then `idea_generation`:

    {"operation":"evidence_view","corpus":"demo","project":"calibration-study","limit":10}
    {"operation":"generate","corpus":"demo","project":"calibration-study","query":"feedback calibration"}
    {"operation":"evaluate","corpus":"demo","project":"calibration-study","purpose":"mechanism_diagnosis","actionId":"matched-control","actionVersion":1}

Project evaluation returns `task_gate` and keeps novelty unestablished. Design readiness does not authorize an experiment. Source-only paper views expose graph readiness and a specific import/status handoff without importing during the read.

The generated MCP reference lists accepted and required fields for every operation. Unrecognized fields and fields intended for another operation are rejected before backend execution. There is no free-form options/backend passthrough. The default graph operations cannot enable live providers, LLM extraction, automatic imports, controller actions, exports, or writeback through extra arguments.

For `overview` and `problem`, structured `constraints` compare primitive method requirements and exclude conflicting transfers. Missing requirements remain unknown. Free text requires source review. Material operations such as `survey`, `gaps` and `evaluate` accept text or text arrays only; they do not silently convert structured requirements to a search string.

## Missing papers, asynchronous work and evidence state

Explicitly call `literature_review/discover` to submit network discovery. `discoveryMode` defaults to metadata `search`; `resolve` and `run` may fetch lawful full text. The operation never imports automatically. Keep the returned `runId`; use `discovery_status` and then `discovery_report` to read its state and sources.

Import only when requested. `literature_review/import` accepts either an already staged `serverFilePath` or a resolved discovery `runId`. File import uses the durable async submission wrapper and accepts `idempotencyKey`. Supply `doi` or `arxivId` when required by the original precise-identity import policy; merely having a staged file does not satisfy that policy. Run import reads only saved fulltext-ready candidates and calls the existing import bridge, without rerunning provider search or source resolution; it accepts at most 100 ready sources. It does not expose automatic retry or force processing controls. Query `import_status` by returned `jobId`, then by the resulting `taskId`; saved-run imports return a `taskIds` batch. With no id, it returns queue progress.

The async job completing means the submission finished. It does not prove the paper graph is ready. The original task result and authoritative synchronization state retain that authority. A network timeout after a submission is an unknown outcome: inspect existing state before resubmitting. Discovery-run submissions should not be automatically repeated.

## Response contract

The original three workflow tools return a JSON object in the existing MCP text content format:

    {
      "contractVersion":"papernexus-research-tools-v1",
      "tool":"lineage_analysis",
      "operation":"method",
      "backend":{"tool":"research_lookup","operation":"method_lineage"},
      "result":{},
      "evidenceBoundary":{"basis":"committed_read","statusAuthority":"...","limitation":"..."},
      "nextActions":[]
    }

`result` preserves the original backend object; old text-only results are represented as `{text: ...}`. The envelope does not invent a completion state. `nextActions` contain callable tool names and arguments, not authorizations to run paid work or imports. Backend failures remain errors and are not converted to successful empty results.

Generated candidates, bounded frontiers, lexical collision checks and novelty audit artifacts are evidence for further research. They do not prove novelty, causal transfer or improvement over a paper baseline. `problem` contains dated source observations; graph paths alone do not establish causal development.

## Compatibility and rollout

`research` is the default advertised list of 4 tools. `legacy` restores the original 23 tools. `all` lists 27 tools. Old tool names remain callable under every profile; this setting is not an access-control mechanism. Existing Python wrappers retain their entrypoints and payloads.

Selection precedence is explicit server options, `PAPERNEXUS_MCP_TOOL_PROFILE`, `serve.mcp.toolProfile`, then `research`. HTTP and stdio use the same dispatcher. For runtime configuration:

    {"serve":{"mcp":{"enabled":true,"toolProfile":"research"}}}

For a client that must discover old names, set the profile to `legacy` and reconnect. Tool listings are static for the configured session; this change does not add list-change notifications or change the negotiated protocol version. MCP prompts use task-oriented tool names in research/all mode and retain original instructions in legacy mode.

Rollout requires deploying the new dispatcher and catalog together. Back up those code files and the profile setting before deployment. Reverting the setting to legacy restores the old advertised list without a database migration. This repository change does not itself restart a live server or refresh an already connected client's tool cache.
