# Brainstorm Local Leiden Design

## Summary

This design adds a one-shot, query-local Leiden-style hierarchical community step to brainstorm-oriented graph reasoning in PaperNexus.

The goal is to improve two outcomes inside the existing `brainstorm` and `ideas` flows:

- surface nearby concepts that are relevant but not directly connected in the current graph neighborhood
- find cross-theme combination opportunities, especially `Problem -> Method`, `Limitation -> Method`, and `Method -> Method`

The design is intentionally local and ephemeral:

- no full-graph precomputation
- no persistent cluster storage
- no API/schema/storage changes
- no background update pipeline

The clustering result exists only for the current query execution and is discarded immediately after use.

## Context

PaperNexus already has the right building blocks for this feature:

- the authoritative graph and lite view are already separated
- brainstorm quality nodes are already filtered through `brainstormEligible`
- `src/core/search/search.js` already builds local query-centered reasoning contexts
- existing brainstorm and idea generation logic already ranks and filters concept candidates

This means community detection should act as an internal enhancement layer on top of the existing local search path rather than as a new stored graph product.

## Goals

- improve brainstorming expansion by adding same-community latent neighbors that are not directly linked
- improve idea generation by surfacing bridge opportunities across adjacent communities
- keep latency low enough for interactive query use
- preserve current behavior when the local graph is too small, too sparse, or too noisy
- keep the design compatible with the current graph model and lite-view loading path

## Non-Goals

- computing communities for the entire corpus
- saving cluster ids or cluster summaries to graph storage
- exposing community outputs as a new public API
- replacing existing heuristic brainstorming and idea generation logic
- introducing a long-running update or invalidation pipeline

## Query-Local Subgraph Definition

The clustering input is a query-local subgraph built at request time.

Included node classes:

- brainstorm-eligible concept nodes only
- supported types: `Problem`, `Method`, `Claim`, `Finding`, `Limitation`, `Assumption`, `FutureDirection`, and `ResearchGoal` if needed by the local seed

Bridge nodes:

- `Paper` nodes may participate during subgraph expansion and weak-edge construction
- `Paper` nodes never become final community members

Excluded from the initial clustering graph:

- `Dataset`, `Benchmark`, and `Metric` as primary community members
- all non-eligible concept nodes
- negative edges such as `CONTRADICTS` as modularity input

## Recommended Approach

Use a query-local, two-level community pass:

1. build a small local seed context using the current `search.js` helpers
2. project the local graph into a concept-only weighted graph
3. run a first-pass Leiden partition over the projected graph
4. re-run a second pass only for large first-level communities to get lightweight subcommunities
5. derive latent neighbors, boundary nodes, and cross-community bridge candidates
6. feed those candidates back into the existing brainstorm and ideas ranking paths

This keeps the scope small enough for interactive use while still giving the system a useful hierarchical notion of topic structure.

## Module Layout

Add a new internal helper module:

- `src/core/search/brainstorm-communities.js`

Responsibilities:

- collect and score local candidate concept nodes
- build a concept-only temporary weighted graph
- run the local two-level Leiden pass
- derive query-local outputs:
  - `latentNeighbors`
  - `boundaryNodes`
  - `crossCommunityBridges`
  - `communities`
  - `subcommunities`

Keep orchestration in:

- `src/core/search/search.js`

Responsibilities there:

- create one query-local brainstorm session
- share it between `buildDivergence` and `buildResearchIdeas`
- fall back to the current heuristic path when community enhancement is not worthwhile

## Session Model

Create a one-shot in-memory session for a single query execution.

Suggested internal shape:

```js
{
  query,
  relationIndex,
  seedPapers,
  seedNodes,
  candidateConcepts,
  communityContext
}
```

Properties:

- computed once per query execution
- never stored on disk
- never attached to the graph object
- can be shared by both brainstorm expansion and idea generation inside the same request

## Candidate Selection And Pruning

The system should prune before building weak edges or running Leiden.

Candidate concept score should combine:

- whether the node is directly matched by the query
- whether the node has a strong explicit relation to a seed node
- how many seed papers support it
- token overlap with the query or seed concept names
- type priority, favoring `Problem`, `Method`, and `Limitation`

Suggested hard limits:

- seed papers: up to 8
- seed concepts: up to 24
- projected concept nodes: up to 96-128
- per-paper concepts used for weak-edge generation: up to 10-12
- projected edges: up to 400-600

Nodes that only appear through a single weak co-occurrence and have no meaningful query or explicit-edge support should be dropped before clustering.

## Projection To A Concept-Only Weighted Graph

The clustering graph should contain concept nodes only.

Edge categories:

- explicit concept-to-concept edges as the main structure
- weak concept-to-concept co-occurrence edges derived from shared seed papers

### Strong Edges

Use explicit graph relations as the backbone.

Highest weight:

- `COMBINES_WITH`
- `COMPATIBLE_WITH`

High weight:

- `APPLIES_TO`
- `TRANSFERABLE_TO`
- `MAY_BE_ADDRESSED_BY`

Medium weight:

- `RELATED_TO`
- `SIMILAR_TO`
- selected `LEADS_TO` style semantic transitions if locally useful

### Weak Edges

Weak edges should be created only inside small local paper buckets.

Conditions for creating a weak edge:

- both concepts are supported by the same seed paper bucket
- at least one endpoint is a high-value type such as `Problem`, `Method`, or `Limitation`
- the pair also has one of:
  - repeated co-occurrence across seed papers
  - token similarity above threshold
  - a meaningful type pairing such as `Problem-Method`, `Method-Limitation`, or `Method-Method`

Weak edges should never dominate explicit edges.

## Efficiency Constraints

This feature must behave like an interactive query helper, not an offline analytics pass.

Efficiency rules:

- only inspect a local query-centered frontier
- never scan the full graph to generate pairwise concept combinations
- generate weak edges from paper buckets only
- avoid all-pairs matching on the projected node set
- run at most two levels of community detection
- stop early when the graph is already small or fragmented

Suggested time budget:

- target community stage budget: roughly 40-80 ms on normal local subgraphs
- if the budget is exceeded, abort enhancement and return the existing heuristic result

## Two-Level Hierarchical Leiden

The design only needs lightweight hierarchy, not deep recursive decomposition.

Level 1:

- run Leiden on the full projected local graph
- treat the resulting communities as local themes

Level 2:

- only re-run Leiden on oversized Level 1 communities
- use a slightly higher resolution to split broad themes into subthemes

Stop conditions:

- too few nodes
- too few edges
- too many singleton communities
- no community large enough to merit a second pass

## Derived Outputs

The community module should return temporary analytical outputs rather than user-facing graph objects.

### Latent Neighbors

Concepts in the same community as the seed concepts that are not directly linked by the existing visible neighborhood.

Use in brainstorm:

- augment `similarProblems`
- augment `relatedConcepts`
- optionally boost same-community constraints when they are well supported

### Boundary Nodes

Concepts with meaningful weighted ties to more than one community.

Use in brainstorm:

- raise their ranking because they often indicate where expansion should move next

Use in ideas:

- treat them as high-value sources for transfer or combination suggestions

### Cross-Community Bridges

Candidate pairs that sit across adjacent communities but have enough local support to justify an idea proposal.

Primary bridge families:

- `Problem -> Method`
- `Limitation -> Method`
- `Method -> Method`

Use in ideas:

- convert them into additional candidate idea objects
- feed them into the existing scoring and deduplication path

## Integration In `buildDivergence`

`buildDivergence` should keep its current neighborhood traversal and ranking behavior.

Community enhancement should be additive:

- retain existing direct-neighborhood results
- add selected `latentNeighbors` into `similarProblems` and `relatedConcepts`
- promote selected `boundaryNodes` in ranking
- mark internally that a candidate came from community expansion for debugging

Guardrails:

- community-derived items should stay near the seed communities
- do not flood the result list with community-only nodes
- if explicit neighborhood signals are already strong enough, use community output mainly as a ranking boost

## Integration In `buildResearchIdeas`

`buildResearchIdeas` should continue to rely on its current heuristic idea builders.

Community enhancement should generate a small number of extra candidate ideas:

- cross-community method transfer ideas
- limitation-remedy ideas from neighboring communities
- method combination ideas from adjacent communities even when no direct `COMBINES_WITH` edge exists

Guardrails:

- cap community-derived ideas to a small number, such as 2-3
- convert them into the same shape used by the current idea ranking system
- rank, deduplicate, and trim them together with the existing heuristic ideas
- if community evidence is weak, produce no extra idea at all

## Failure And Fallback Rules

The community layer is optional enhancement, not a mandatory dependency.

Return the current heuristic behavior without community output when:

- the local seed set is too small
- the projected graph is too sparse
- the projected graph exceeds budget after pruning
- the Leiden pass yields mostly noise or singletons
- the time budget is exceeded

This keeps brainstorming responsive and avoids regressions on small or low-signal corpora.

## Determinism

To reduce result jitter across similar repeated queries:

- sort nodes and edges stably before projection
- use stable tie-breakers in candidate scoring
- keep deterministic traversal order
- if the Leiden implementation supports it, use a fixed seed for repeatability

This will not make results globally identical across graph edits, but it will reduce unnecessary drift.

## Testing Strategy

Add focused tests around the new local enhancement path rather than broad end-to-end clustering snapshots.

Recommended test areas:

- local projection includes only brainstorm-eligible concept nodes and uses `Paper` only as a bridge
- weak-edge generation is local and bounded
- same-community latent neighbors can surface a relevant concept without a direct explicit edge
- cross-community bridges can produce a valid `Problem -> Method` or `Method -> Method` idea candidate
- fallback works when the projected graph is too small or too sparse
- `brainstormBriefPayload` or equivalent shared call paths do not needlessly rebuild multiple local community contexts inside a single logical request

Likely file locations:

- `test/brainstorm-view.test.js`
- `test/query-api.test.js`
- a new focused search/community test if the logic becomes too large for existing files

## Implementation Notes

- keep the algorithm adapter isolated so the package choice for Leiden can change later without reshaping `search.js`
- do not modify graph storage, lite view serialization, or corpus metadata
- do not write cluster ids into node properties
- prefer community-derived scores as additive evidence rather than as hard replacement of current heuristics

## Open Questions Deferred

These do not block the first implementation and can be deferred:

- exact Leiden package choice versus a small internal adapter
- final numeric weights for each relation type
- whether `ResearchGoal` should always be included or only when query-local support is strong
- whether `Dataset` or `Benchmark` should later contribute as auxiliary bridge evidence without becoming cluster members

## Recommendation

Implement the feature as a query-local internal enhancement in `search.js` with a dedicated `brainstorm-communities.js` helper.

This is the smallest design that:

- matches the current architecture
- improves brainstorming on latent same-theme concepts
- improves idea generation on cross-theme combinations
- keeps runtime bounded
- avoids introducing any stored cluster state
