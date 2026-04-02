---
name: papernexus-agentic-reasoning
description: Use this skill when an agent needs to perform stepwise reasoning for automated research tasks on top of an existing PaperNexus graph while keeping live-graph reads and imports on authenticated HTTP API endpoints.
---

# PaperNexus Agentic Reasoning

Use this skill when the goal is not just to retrieve graph facts, but to reason through a research problem step by step using the PaperNexus graph as structured memory.

## Live Graph Access Policy

For a running user graph, prefer the skill-local Python wrappers in `SKILL/PaperNexusAgenticReasoning/scripts/` as the default interface. They still use the authenticated HTTP API underneath, but they are safer for agents than raw `curl`.

If both a remote server API and a local checkout are available, use the remote API path first.
Do not call local CLI helpers such as `papernexus query`, `papernexus context`, `papernexus impact`, `papernexus ideas`, `papernexus brainstorm`, or local staged build commands against the live graph.
If a single PDF or Markdown file exists only on the local agent machine, prefer `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`. That wrapper stages the file and submits the import in one step.
If you need to ingest multiple local files before reasoning, prefer `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py --manifest <json> submit` and then `status` or `wait` with that same manifest.
If you need explicit staging control for a directory, use `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py` first and then import the chosen remote file with `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py --server-file-path <remote-file>`.
Do not write ad-hoc shell loops for batch imports.
Do not default to `files[].contentBase64` for large local PDFs.

Allowed live-graph entrypoints:

- `GET /api/corpora`
- `GET /api/corpus?name=<corpus>`
- `GET /api/corpus-meta?name=<corpus>`
- `GET /api/enhancements?name=<corpus>`
- `GET /api/paper-enhancement?name=<corpus>&paperId=<paperId>`
- `GET /api/imports?name=<corpus>`
- `GET /api/imports/:taskId`
- `GET /api/imports/:taskId/log`
- `POST /api/imports?name=<corpus>`
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

Every API request must include:

- `Authorization: Bearer <token>`

Important query policy:

- prefer typed query APIs over pulling the full graph whenever they can answer the task
- use `/api/corpus` only when you need raw graph inspection that the typed endpoints do not provide
- if the available API response is too limited for the requested reasoning task, report the missing server capability instead of falling back to local CLI

## What This Skill Is For

This skill adapts the core ideas behind Agentic Reasoning to the current PaperNexus system:

- use a structured graph as long-horizon memory
- use a small, disciplined tool set instead of calling many tools blindly
- decompose a hard research task into explicit reasoning steps
- keep uncertainty, evidence, and open gaps visible during the reasoning process

In PaperNexus, the "Mind Map" equivalent is:

- the main research graph
- the lite graph read model
- enhancement overlays for theory, storyline, and reflection
- the brainstorm-quality node view, which filters the graph down to nodes marked `brainstormEligible`

## Available Graph Memory

### Main graph node types

- `Paper`
- `Problem`
- `Method`
- `Claim`
- `Finding`
- `Evidence`
- `Limitation`
- `Assumption`
- `Dataset`
- `Benchmark`
- `Metric`
- `FutureDirection`

### Reflection overlay entities

- `Innovation`
- `Experiment`
- `Outcome`
- `Reflection`

### Useful edge patterns

- `Paper -> Problem / Method / Claim / Finding / Limitation / Assumption`
- `Claim -> Evidence`
- `Method -> Problem / Dataset / Benchmark / Assumption`
- `Problem -> Limitation / FutureDirection`
- reflection links:
  - `Innovation -> TESTED_BY -> Experiment`
  - `Experiment -> PRODUCED -> Outcome`
  - `Outcome -> SUMMARIZED_AS -> Reflection`

## Tool Policy: Less Is More

Prefer this order of operations:

1. Graph retrieval and traversal
2. Enhancement overlays
3. External search or code only if the graph cannot answer the current sub-question

Do not start with broad web search if the graph already has enough structure to narrow the problem.

In PaperNexus, the default live-graph reasoning inputs are:

- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py query`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py context`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py impact`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py ideas`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py brainstorm`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py path-trace`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py evidence-chain`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py reflection-chain`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py research-brief`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py brainstorm-brief`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py theory-brief`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py storyline-brief`
- `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py paper-enhancement` when paper-local overlay detail is still needed

For ideation, prefer the brainstorm-quality node view over the raw full graph. The full graph can still contain supporting nodes that are useful for provenance but too noisy to use as primary anchors.

## Core Reasoning Loop

For any non-trivial research task, use this loop:

1. Define the current research objective in one sentence.
2. Start with the narrowest typed API that matches the task.
3. Resolve anchors with `query`, `context`, `impact`, or `path-trace`.
4. If validating a claim, inspect `evidence-chain`, `theory-brief`, and `reflection-chain`.
5. If designing new ideas, inspect `ideas`, `brainstorm`, and `brainstorm-brief`.
6. Only fetch `/api/corpus` when the typed APIs still leave a structural gap.
7. Write a short structured state update before moving to the next step.

Each step should end with one of:

- confirmed
- uncertain
- contradicted
- needs external evidence

## Structured State Format

Maintain reasoning state in this compact format:

```text
Objective:
Current anchor:
Known support:
Known limitation:
Open gap:
Next action:
```

Do not let the reasoning jump ahead without filling these fields.

## Recommended Command Sequence

### A. Understand a topic

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --api-base "http://<host>:4821" --corpus "<corpus>" query "<topic>" --limit 8
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --api-base "http://<host>:4821" --corpus "<corpus>" context "<topic>" --node-view brainstorm
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --api-base "http://<host>:4821" --corpus "<corpus>" evidence-chain "<topic>" --limit 5
```

Use this to answer:

- what is the core problem
- what methods are attached
- what evidence supports the claims
- where the biggest limitations are

### B. Generate a new research direction

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --api-base "http://<host>:4821" --corpus "<corpus>" ideas "<topic>" --limit 6
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --api-base "http://<host>:4821" --corpus "<corpus>" brainstorm "<topic>" --mode converge --limit 6
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --api-base "http://<host>:4821" --corpus "<corpus>" brainstorm-brief "<topic>" --limit 6
```

Use this to produce:

- candidate problem-method combinations
- likely constraints
- converged directions worth testing

Important:

- use nodes marked `brainstormEligible` as the primary ideation anchors
- when manually inspecting nodes, trust `brainstormEligible`, `brainstormScore`, and `brainstormTier` over raw visual prominence on the canvas

### C. Evaluate whether an idea is well supported

Use:

- `/api/evidence-chain` for `Problem -> Method -> Claim -> Evidence -> Limitation`
- `/api/reflection-chain` for `Innovation -> Experiment -> Outcome -> Reflection`
- `/api/theory-brief` for assumptions, mechanisms, proof ideas, and failure modes
- `/api/storyline-brief` for narrative beats and argument gaps
- `GET /api/paper-enhancement` when you need the raw overlay card inventory

## How To Think With The Graph

### For literature understanding

Use this chain:

`Problem -> Method -> Claim -> Evidence -> Limitation`

Prefer `POST /api/evidence-chain` before reconstructing this chain yourself.

Prefer `Problem` and `Method` nodes whose names are multi-word research objects rather than single generic nouns.

### For theory support

Use this chain:

`Claim -> Assumption / Mechanism / Proof idea -> Failure mode`

Prefer `POST /api/theory-brief`.

### For experiment reflection

Use this chain:

`Innovation -> Experiment -> Outcome -> Reflection`

Prefer `POST /api/reflection-chain`.

### For future work

Use this chain:

`Problem -> Limitation -> FutureDirection -> transferable Method`

Start with `POST /api/impact`, then refine with `POST /api/path-trace` if you need a concrete typed path.

## When To Use Enhancement Overlays

Use overlays when the raw graph alone is too flat.

When a typed second-layer API already packages the needed overlay content, prefer that over reading the raw overlay first.

### Theory overlay

Use when asking:

- why might this work
- what assumptions does it rely on
- when would it fail

### Storyline overlay

Use when asking:

- how does the paper persuade the reader
- what is the main narrative thread
- where does the argument jump too fast

### Reflection overlay

Use when asking:

- what is the core innovation
- what experiments actually tested it
- did the evidence indicate success, failure, or a mixed result
- what lesson should transfer into future work

## Output Style

For automated research tasks, prefer this output structure:

```text
Question:
Anchor graph nodes:
Stepwise reasoning:
Conclusion:
Confidence:
Open risks:
Next best action:
```

### Stepwise reasoning rules

- each step should cite a graph fact, overlay fact, or explicit inference
- mark inferences as inferences
- do not collapse evidence and conclusion into one sentence
- surface contradictions instead of smoothing them over

## Dynamic Update Rules

If source papers changed, refresh the live graph through the import API before trusting the reasoning state:

1. `POST /api/imports?name=<corpus>`
2. `GET /api/imports/:taskId`
3. `GET /api/imports/:taskId/log`
4. `GET /api/corpus?name=<corpus>`
5. `GET /api/enhancements?name=<corpus>`

Read import state like this:

- `pending` + `queued`: waiting for the worker
- `running` + `materialize|llm-optimize|fast-commit`: import is active; use `/log` for the freshest evidence
- `completed` + `completed`: import finished; then inspect graph state
- `failed`: read `error.message` and the newest log lines before taking any next step

Agent rule:

- prefer the existing remote `serve` + import workflow for PDF ingestion
- if a single PDF exists only on the local agent machine, prefer `python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>` so staging and `serverFilePath` submission stay coupled
- do not default to `files[].contentBase64` for large local PDFs; prefer stable remote staging such as `rsync`
- do not replace live-graph import or query requests with local CLI fallback
- if import or enhancement is blocked by missing API capability, lock contention, or missing data, report the blocker directly
- do not keep retrying the same live-graph path without new evidence

If the new material enters through a UI or API upload, prefer the queued import-task path instead of manually moving files into the main paper source directory. Import tasks keep their own logs under `.papernexus/imports/` and merge into the main single graph after processing.
If a queued import or staged pipeline appears stalled, pause and report the exact stage, latest log evidence, and likely blocker. Do not keep retrying the same path without new diagnostic evidence.

For ongoing live usage:

- assume the remote `serve` process is already the system entrypoint
- do not start `watch` or `service install` as part of a reasoning workflow
- remote dashboard/API access requires the configured PaperNexus token, so agent workflows that call `/api/*` must include `Authorization: Bearer <token>`

Important Stage 4 boundary:

- `merge-graph` canonicalizes near-duplicate `Dataset` / `Benchmark` nodes inside the staged graph before final commit
- merge-time LLM node deletion is currently disabled; do not rely on `--node-llm-check` for staged graph cleanup
- `write-index` commits the staged graph that Stage 3 and `merge-graph` prepared
- `write-index` creates a backup under `<rootPath>/.papernexus-backups/` before overwriting the committed graph
- if raw paper files changed after Stage 3 and those new files must be included in reasoning, rerun Stage 1-3 before Stage 4
- if you want to inspect or clean duplicate evaluation nodes before final commit, run `papernexus merge-graph --continue`
- if the staged graph still contains low-value generic evaluation nodes, handle them through merge heuristics or later manual review; do not rely on `--node-llm-check` right now
- if you only need to finish committing an already-built staged graph, `papernexus write-index --continue` is the right recovery path; it will auto-run merge if needed

## Mutation Decision Policy

During stepwise reasoning, do not jump from "this seems wrong" to editing the graph.

Use this policy:

1. retrieve the relevant graph neighborhood first
2. inspect theory, storyline, or reflection overlays if available
3. decide whether the issue is a clear factual graph error or only an interpretation gap
4. mutate only if the correction is explicit, local, and high-confidence

Agent safety rule:

- reasoning agents may add or update understanding in the current graph
- they must not delete corpus data, restore whole-database archives, or run backup/restore commands unless a human explicitly requests it

Good mutation cases:

- a clearly wrong relationship
- a mislabeled or duplicated node
- a missing schema-valid edge with direct paper support
- a narrow property correction

Prefer not to mutate when:

- the issue is really uncertainty in the paper
- the claim needs more evidence rather than a graph edit
- the conclusion depends on interpretation or synthesis
- the right action is to record a reflection, limitation, or open question

Operational rule:

- use `mutate_graph` with `dryRun: true` first
- treat graph edits as local curation of the current indexed graph
- remember that a later full rebuild can overwrite those edits

So the reasoning workflow should favor:

- explicit uncertainty
- reflection notes
- limitation tracking
- operator-approved corrective edits only when the evidence is strong

## Good Defaults For Agents

When uncertain, prefer:

- a narrow anchor node over a broad topic
- fewer tool calls over more tool calls
- graph-supported conclusions over speculative conclusions
- explicit open questions over hidden uncertainty

If the graph is sparse, say so and then escalate to search or code, rather than pretending the graph answered the question.
