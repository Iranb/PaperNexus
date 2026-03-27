---
name: papernexus-agentic-reasoning
description: Use this skill when an agent needs to perform stepwise reasoning and structured problem solving for automated research tasks on top of the existing PaperNexus graph. It adapts Agentic Reasoning's mind-map style workflow to PaperNexus commands, graph structure, and enhancement overlays.
---

# PaperNexus Agentic Reasoning

Use this skill when the goal is not just to retrieve graph facts, but to reason through a research problem step by step using the PaperNexus graph as structured memory.

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

In PaperNexus, the default reasoning tools are:

- `papernexus query`
- `papernexus context`
- `papernexus impact`
- `papernexus ideas`
- `papernexus brainstorm`
- paper enhancement overlays from the API or local files

For ideation, prefer the brainstorm-quality node view over the raw full graph. The full graph can still contain supporting nodes that are useful for provenance but too noisy to use as primary anchors.

## Core Reasoning Loop

For any non-trivial research task, use this loop:

1. Define the current research objective in one sentence.
2. Resolve the best anchor nodes with `query`.
3. Inspect local structure with `context`.
4. Traverse dependencies or consequences with `impact`.
5. If designing new ideas, run `ideas` or `brainstorm`.
6. If validating a claim, inspect theory and reflection overlays.
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
papernexus query "<topic>" --corpus <name>
papernexus context "<best-node>" --corpus <name>
papernexus impact "<best-node>" --corpus <name> --direction upstream
papernexus impact "<best-node>" --corpus <name> --direction downstream
```

Use this to answer:

- what is the core problem
- what methods are attached
- what evidence supports the claims
- where the biggest limitations are

### B. Generate a new research direction

```bash
papernexus query "<topic>" --corpus <name>
papernexus ideas "<topic>" --corpus <name>
papernexus brainstorm "<topic>" --corpus <name> --mode diverge
papernexus brainstorm "<topic>" --corpus <name> --mode converge
```

Use this to produce:

- candidate problem-method combinations
- likely constraints
- converged directions worth testing

Important:

- `ideas` and `brainstorm` already prioritize the brainstorm-quality node view
- when manually inspecting nodes, trust `brainstormEligible`, `brainstormScore`, and `brainstormTier` over raw visual prominence on the canvas

### C. Evaluate whether an idea is well supported

Use:

- `query` for the main claim or keyword
- `context` around the strongest `Claim`, `Method`, or `Finding`
- theory overlay for assumptions, mechanisms, proof ideas, and failure modes
- reflection overlay for innovations, experiments, outcomes, and takeaways

## How To Think With The Graph

### For literature understanding

Use this chain:

`Problem -> Method -> Claim -> Evidence -> Limitation`

Prefer `Problem` and `Method` nodes whose names are multi-word research objects rather than single generic nouns.

### For theory support

Use this chain:

`Claim -> Assumption / Mechanism / Proof idea -> Failure mode`

### For experiment reflection

Use this chain:

`Innovation -> Experiment -> Outcome -> Reflection`

### For future work

Use this chain:

`Problem -> Limitation -> FutureDirection -> transferable Method`

## When To Use Enhancement Overlays

Use overlays when the raw graph alone is too flat.

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

If source papers changed, refresh the graph before trusting the reasoning state:

```bash
papernexus analyze
papernexus enhance --once
```

If the refresh involves PDFs and you need to be explicit about parser choice, prefer the remote MinerU path first:

```bash
papernexus analyze --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
papernexus enhance --once
```

Agent rule:

- prefer remote MinerU for PDF ingestion and rebuilds
- do not recommend local Docling or Marker as the first option unless the remote backend is unavailable or the user asks for a local parser
- do not add `--force` by default; reserve it for explicit full-rebuild requests or known-corrupt staged/cache recovery cases
- if the cache-first graph build still fails and the user can operate locally, hand the exact command to the user instead of forcing a rebuild

If you want a staged, resumable refresh instead of a monolithic rebuild, use:

```bash
papernexus materialize --continue
papernexus llm-optimize --continue
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
papernexus enhance --once
```

Treat that staged path as single-graph continuation. Once an index root already has a committed graph or snapshots, do not point these stage commands at a narrower paper subdirectory on the same root.

If source files did not change and the only failure was LLM extraction or relation requests, prefer:

```bash
papernexus analyze
```

This now retries only previously failed LLM-assisted papers and reuses snapshots for papers that already succeeded.

If the new material enters through a UI or API upload, prefer the queued import-task path instead of manually moving files into the main paper source directory. Import tasks keep their own logs under `.papernexus/imports/` and merge into the main single graph after processing.
If a queued import or staged pipeline appears stalled, pause and report the exact stage, latest log evidence, and likely blocker. Do not keep retrying the same path without new diagnostic evidence.

For ongoing usage:

```bash
papernexus service install
papernexus service status
papernexus logs watch
```

When the background services are healthy:

- `watch` keeps the graph fresh
- `serve` keeps dashboard/API and enhancement workers alive
- remote dashboard/API access now requires the configured PaperNexus token, so agent workflows that call `/api/*` must include `Authorization: Bearer <token>`

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
