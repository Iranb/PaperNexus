---
name: papernexus-research-chains
description: Use this skill when an agent needs typed multi-hop research chains, evidence bundles, reflection bundles, or brief-style API outputs from a live PaperNexus graph over authenticated HTTP.
---

# PaperNexus Research Chains

Use this skill when the task is to answer a research question through explicit graph-supported chains rather than raw graph inspection.

## Why This Skill Exists

Humans and agents both struggle when asked to reason over a full graph dump for too long.

Prefer small, typed structures that are easy to inspect, compare, and cite:

- paths
- evidence chains
- reflection chains
- theory briefs
- storyline briefs
- research briefs
- brainstorm briefs

These are easier to validate, easier to summarize, and less likely to drift into unsupported inference than free-form traversal over the entire graph.

## Live Graph Access Policy

For a running user graph, prefer the skill-local Python wrappers in `SKILL/PaperNexusResearchChains/scripts/` first. They call the authenticated HTTP API and are easier for agents to use correctly than raw `curl`.

Do not use local CLI graph-query commands against the live graph.

Every `/api/*` request must include:

- `Authorization: Bearer <token>`

## Preferred API Order

Start from the narrowest API that directly answers the task.

Default script mapping:

- anchor resolution: `python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py`
- chains and briefs: `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py`

### 1. Anchor resolution

Use:

- `POST /api/query`
- `POST /api/context`
- `POST /api/impact`

### 2. Explicit chain retrieval

Use:

- `POST /api/path-trace`
- `POST /api/evidence-chain`
- `POST /api/reflection-chain`

### 3. Cognitive compression

Use:

- `POST /api/theory-brief`
- `POST /api/storyline-brief`
- `POST /api/research-brief`
- `POST /api/brainstorm-brief`

Only fall back to `GET /api/corpus` or `GET /api/paper-enhancement` when the typed APIs are insufficient.

## Which API Matches Which Task

### Trace a concrete multi-hop path

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py path-trace`

Best for:

- why is this method connected to this claim
- how do these two concepts meet in the graph
- can I show a concrete typed path between two anchors

### Validate a paper-supported argument

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py evidence-chain`

Best for:

- `Problem -> Method -> Claim -> Evidence -> Limitation`
- what support exists for this method
- what evidence and limitations travel with a claim

### Extract experiment lessons

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py reflection-chain`

Best for:

- `Innovation -> Experiment -> Outcome -> Reflection`
- what lesson transfers from a paper
- which outcomes were mixed or weak

### Compress mechanisms and assumptions

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py theory-brief`

Best for:

- assumptions
- mechanisms
- proof ideas
- failure modes

### Compress narrative and persuasion flow

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py storyline-brief`

Best for:

- what the paper is trying to argue
- where the story is weak
- missing narrative beats

### Build a compact research package

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py research-brief`

Best for:

- a topic-level summary with evidence, reflection, theory, and storyline in one response

### Build ideation support

Use:

- `python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py brainstorm-brief`

## Minimal Script Examples

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py --api-base "http://<host>:4821" --corpus "<corpus>" query "<topic>" --limit 8
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --api-base "http://<host>:4821" --corpus "<corpus>" evidence-chain "<topic>" --limit 5
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --api-base "http://<host>:4821" --corpus "<corpus>" reflection-chain "<topic>" --limit 5
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --api-base "http://<host>:4821" --corpus "<corpus>" research-brief "<topic>" --limit 5
```

Best for:

- generating candidate directions
- gathering supporting chains
- surfacing constraints and risks

## Output Discipline

When writing results from these APIs, keep the distinction between:

- graph fact
- overlay fact
- inference
- open risk

Do not flatten them into one statement.

Preferred output shape:

```text
Question:
Anchor:
Chain:
Support:
Inference:
Open risks:
Next action:
```

## Failure Policy

If a typed API returns no usable chain:

1. report that the chain was not found
2. mention the closest available evidence
3. say whether the failure is due to missing anchors, missing overlay data, or a true graph gap

Do not repeatedly retry the same API call without a new query, new anchor, or new graph update.
