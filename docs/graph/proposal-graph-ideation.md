# Proposal Graph Ideation

The proposal graph is an episode-local ideation state used to turn research briefs into auditable full-paper idea bundles. It is deliberately separate from the long-lived corpus graph.

## Boundary With The Corpus Graph

The corpus graph stores indexed papers, concepts, claims, evidence, and derived cross-domain links. It is durable project knowledge.

The proposal graph stores a temporary candidate idea under construction. It may reference corpus evidence, live-discovery snippets, or imported paper spans, but it does not mutate the corpus graph. A committed proposal can later be imported or cited by another workflow, but the commit operation itself only freezes the session-local idea state.

This separation keeps LLM-heavy ideation from polluting persistent paper facts.

## Core Contract

Every proposal session uses:

- typed nodes such as `Problem`, `Hypothesis`, `Mechanism`, `Method`, `NoveltyClaim`, `EvalPlan`, `Risk`, `EvidenceAttachment`, `Repair`, and `StoryBeat`
- typed edges such as `supports`, `contradicts`, `depends_on`, `grounded_in`, `must_cite`, `overlaps_prior`, `evaluated_by`, `falsified_by`, and `repairs`
- provenance on every node and edge
- frozen graph snapshots for role-local action slates
- deterministic patch merge and conflict reporting

Role agents propose actions against a snapshot. They do not mutate the graph directly. The controller validates those actions, accepts valid ones, rejects invalid or stale ones, and then merges accepted actions into a deterministic patch.

The role-action trace is replayable. `replayProposalActionTrace()` rebuilds the graph from the original session input and accepted role actions, preserving edit-decision ids so the replayed committed graph hash matches the original committed graph.

## Commit Gates

The controller only commits a proposal when the active connected subgraph includes:

- a problem
- a hypothesis
- a mechanism
- a method
- a novelty claim
- an evaluation plan
- at least one risk

The commit decision also requires grounded evidence-supported claims, no unresolved contradictions, no unresolved high-severity risks, a ready evaluation plan, a falsification route, a novelty contrast, and a storyline.

If a gate fails, the session remains in diagnosis mode and records the blocking reasons for the next round.

## Output Artifacts

Committed sessions can write:

- `input.json`
- `proposal-graph.json`
- `role-action-trace.jsonl`
- `patches.jsonl`
- `edit-decisions.jsonl`
- `commit-decisions.jsonl`
- `validation-report.json`
- `evidence-export.json`
- `proposal.json`
- `proposal.md`
- `proposal-session-manifest.json`

The manifest records artifact paths, hashes, final status, graph schema version, and the committed subgraph id. The paper idea bundle is synthesized only from the committed graph.

## Why This Helps Slow LLM Workflows

LLM calls remain expensive, but the proposal graph reduces wasted calls by making each role action incremental and replayable. The controller can reject stale or invalid actions without asking another model, and failed commit gates tell the next round exactly what must be repaired.

Combined with progressive import batching, this keeps corpus ingestion and idea synthesis on separate throughput paths: imports can batch queued PDF/LLM parsing work, while proposal sessions can focus expensive calls on missing graph evidence, contradictions, risks, and evaluation design.

## Related Implementation

- `src/core/graph/proposal-graph.js`
- `src/core/graph/proposal-controller.js`
- `src/core/graph/proposal-synthesis.js`
- `test/proposal-graph.test.js`
- `test/proposal-controller.test.js`
