# ResearchStudio-Style Innovation Discovery for PaperNexus ExecPlan

Created: 2026-07-10 22:48 CST
Updated: 2026-07-10 23:09 CST
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `main` at baseline `d3d0018`, with pre-existing uncommitted user changes that must be preserved
Related docs:

- `/Users/iranb/Library/Mobile Documents/iCloud~md~obsidian/Documents/001-WIKI/synthesis/AutoResearch/papers/2607.04439-ResearchStudio-Idea.md`: local ResearchStudio-Idea analysis. The implementation borrows its ordered reasoning contract, not its unverified empirical outcome claims.
- `AGENTS.md`: requires GitNexus impact analysis before editing symbols and GitNexus change detection before commit.
- `docs/agent-material-backend.md`: public semantics and evidence boundaries for Agent-facing material packs.
- `docs/interfaces/mcp-skill-contracts.md`: compatibility contract between PaperNexus MCP tools and AutoResearch skills.
- `src/mcp/tools.js`: authoritative `agent_materials` MCP input schema.

This ExecPlan is a living document. Update `Progress`, `Surprises & Discoveries`, `Decision Log`, `Artifacts and Notes`, and `Outcomes & Retrospective` as implementation and validation proceed. A future implementer must be able to resume from the repository and this file without chat history. Proceed milestone by milestone unless blocked by a missing decision, missing permission, or unsafe side effect.

No repository-level `PLANS.md` was present when this plan was created. This file follows the `execplan-builder` content contract directly.

## Purpose / Big Picture

After completion, a PaperNexus/AutoResearch caller can ask PaperNexus to discover innovation opportunities in the following observable order:

1. compile source-backed material and a validated method lineage;
2. distinguish additive frontier gaps from subtractive persistent-assumption gaps;
3. record historical capabilities that a candidate must not regress;
4. match a bounded research-action pattern only after a structural gap exists;
5. decompose a candidate mechanism into collision-search queries and preserve the entire trace for an episode-local `proposal_graph_session`.

The primary success scenarios are:

- `agent_materials(operation="structural_gap_pack", corpus=..., method=..., targetProblem=...)` returns typed additive gaps, subtractive gaps, persistent assumptions, frontier candidates, historical-regression watch items, evidence references, and explicit data-starvation boundaries.
- `agent_materials(operation="innovation_pattern_pack", ...)` returns deterministic gap-to-pattern matches using a 15-card seed taxonomy. Built-in cards are labeled `seed_taxonomy`, not falsely represented as learned Oral/Reject outcome evidence. Caller-supplied cards with evidence references remain distinguishable from seed heuristics.
- `agent_materials(operation="innovation_evidence_pack", ...)` embeds the structural-gap and pattern analyses, attaches their provenance to idea cards, produces mechanism-level collision query plans, and exports an episode-local proposal-graph handoff without mutating the raw corpus graph.
- Existing `agent_materials` operations and existing response fields continue to work. New operations and fields are additive.

Current problem:

- PaperNexus already exposes method lineage, material gap maps, closest-prior checks, component collision screening, falsifiers, and proposal commit gates, but these capabilities are not connected by the ResearchStudio order `evidence -> structural bottleneck -> research action -> concrete mechanism -> collision/regression/falsification audit`.
- `buildGapCandidates` combines bottleneck and trade-off dimensions but does not identify frontier candidates, cross-generation persistent assumptions, or historical regression.
- `buildGapMap` mixes limitations, assumptions, claims, and fallback text into one flat list, so additive and subtractive opportunities cannot be audited separately.
- `buildCompositionCollisionMatrix` is intentionally lexical/component-based. It does not expose a mechanism fingerprint or query-decomposition trace, and therefore must not be described as semantic mechanism collision detection.
- `proposal_graph_session` accepts episode-local actions and evidence export, but `innovation_evidence_pack` does not currently prepare a structural-gap/pattern provenance handoff.
- PaperNexus has no outcome-labeled ResearchStudio corpus. Treating a copied 15-pattern taxonomy as empirical acceptance/rejection evidence would create a false evidence claim.

## Progress

- [x] 2026-07-10 22:32 CST Read the complete `execplan-builder` content contract, the `karpathy-guidelines` guardrails, and the PaperNexus innovation skill plus its evidence-policy references.
- [x] 2026-07-10 22:39 CST Audited the local ResearchStudio-Idea note and extracted the required ordered workflow, 15 research actions, additive/subtractive gap distinction, historical regression check, collision audit, and evidence boundaries.
- [x] 2026-07-10 22:44 CST Audited the current PaperNexus method-lineage, material-pack, innovation-evidence, collision, proposal-session, MCP schema, documentation, and test surfaces.
- [x] 2026-07-10 22:46 CST Established the focused baseline: 45 tests passed, 0 failed across method lineage, innovation evidence, sufficiency, collision, proposal controller, Agent materials, and MCP schema snapshot.
- [x] 2026-07-10 22:48 CST Drafted the initial outcome-driven ExecPlan and current-code gap matrix.
- [x] 2026-07-10 22:54 CST Ran GitNexus impact analysis. `buildInnovationEvidencePack`, dispatcher, renderer, and `PAPERNEXUS_TOOLS` are LOW; shared `maybeExportPayload` is MEDIUM with six direct callers and two Materials flows. No HIGH/CRITICAL edit target was found.
- [x] 2026-07-10 22:58 CST Implemented the pure ResearchStudio structural-gap, 15-card pattern, idea-trace, collision-query, and proposal-handoff compilers with deterministic tests.
- [x] 2026-07-10 23:01 CST Added `structural_gap_pack` and `innovation_pattern_pack`, integrated the analyses into `innovation_evidence_pack`, and exported four replayable JSON artifacts.
- [x] 2026-07-10 23:04 CST Synchronized MCP schema, Python wrapper, schema snapshot, generated references, canonical SKILL guidance, and human-facing contracts.
- [x] 2026-07-10 23:09 CST Completed syntax/CLI checks, 52-test focused regression, full 979-test regression, `git diff --check`, and GitNexus combined-worktree change detection.
- [x] 2026-07-10 23:09 CST Re-audited intent fit and all ten ExecPlan dimensions; the implementation meets the planned conservative slice and retains explicit empirical/semantic/autonomy boundaries.

## Surprises & Discoveries

- Observation: PaperNexus already has most of the required evidence vocabulary in the raw graph: `Method`, `Assumption`, `Challenge`, `Limitation`, `Hypothesis`, `FalsificationPlan`, and method-evolution edges such as `EXTENDS_METHOD`, `IMPROVES_METHOD`, `REPLACES_METHOD`, and `ADAPTS_METHOD`.
  Evidence: `src/core/graph/schema.js` and `src/core/graph/rules.js`.
  Action: derive the new audit as a material layer; do not duplicate candidate ideas, threats, or experiments into the raw corpus graph.

- Observation: default method-lineage traversal accepts only validated/authoritative, exact-quote-backed edges and already returns bottleneck, mechanism, trade-off, paper, source-span, and confidence fields.
  Evidence: `validateMethodEvolutionEdge`, `buildMethodEdgeRecord`, and `buildMethodEvolutionGapAnalysis` in `src/core/graph/research-intelligence.js`.
  Action: reuse this authority instead of constructing a second lineage engine. Label bounded traversal endpoints as `frontier_candidate`, not globally proven leaf nodes.

- Observation: `proposal_graph_session` is an episode-local validator/merger and accepts arbitrary `evidenceExport`, but through MCP it does not autonomously generate role actions.
  Evidence: `runProposalGraphSession` in `src/core/graph/proposal-controller.js` consumes supplied runners/actions/slates and passes `evidenceExport` through to artifacts.
  Action: produce a replayable proposal handoff from the innovation pack; do not claim this slice makes the proposal session autonomous.

- Observation: the current worktree contains prior AutoResearch non-blocking, Firecrawl, ingestion, generated-doc, and test edits.
  Evidence: `git status --short --branch` shows modified and untracked files outside this task.
  Action: use surgical patches, do not clean/revert/stage/commit unrelated work, and report aggregate change-detection risk honestly.

- Observation: the current collision matrix is useful as a lexical prefilter but not as semantic equivalence evidence.
  Evidence: `componentTerms`, `textMatchesComponent`, and `buildCompositionCollisionMatrix` operate on normalized substrings and term counts.
  Action: retain it for compatibility, add a separately named `mechanism_collision_audit` with explicit `semantic_equivalence_checked=false`, decomposed queries, lexical candidates, and a required external/source-backed follow-up boundary.

- Observation: the only MEDIUM-risk planned edit is `maybeExportPayload`; its six direct callers are the existing material-pack builders and the operation dispatcher.
  Evidence: GitNexus reported 15 upstream impacts, six direct callers, two affected Materials processes, and no cross-module fan-out.
  Action: leave every existing export branch intact and add new integrated export paths only inside the existing `innovation_evidence_pack` branch.

- Observation: `pn_agent_materials.py` is part of the stable public fallback contract, so runtime/schema-only changes would leave shell-based AutoResearch clients unable to use the new controls.
  Evidence: `docs/interfaces/mcp-skill-contracts.md` names the wrapper as the canonical Agent-material entrypoint.
  Action: add both subcommands and all bounded ResearchStudio inputs to the wrapper, then verify both `--help` surfaces and Python compilation.

- Observation: GitNexus final change detection reports CRITICAL aggregate risk because the shared dirty worktree contains 300 changed symbols across 40 files, including prior import, Firecrawl, server, and controller work.
  Evidence: `gitnexus_detect_changes(scope="all")` reports 57 affected flows; this slice's directly relevant flows are `BuildInnovationEvidencePack` and `ExecuteAgentMaterialsOperation`, while most reported flows originate in pre-existing changes.
  Action: do not attribute the aggregate rating to this slice alone; retain the exact pre-edit LOW/MEDIUM symbol impacts, full green regression, and task-file list as the scoped evidence.

## Decision Log

- Decision: add `structural_gap_pack` and `innovation_pattern_pack` as public, additive `agent_materials` operations, and embed the same compiled analyses in `innovation_evidence_pack`.
  Rationale: independent operations make intermediate evidence inspectable and reusable, while integration preserves the existing one-call AutoResearch path.
  Date/Author: 2026-07-10 / Codex

- Decision: implement the analytical core as a small pure module under `src/core/materials/`, with corpus loading and public dispatch left in `agent-materials.js`.
  Rationale: the current Agent-material backend is already large. Pure inputs/outputs permit deterministic unit tests and avoid introducing a second datastore or graph mutation path.
  Date/Author: 2026-07-10 / Codex

- Decision: call method-lineage analysis with `direction=both` for structural-gap work, while preserving caller bounds for depth and result limit.
  Rationale: backward edges expose previously solved bottlenecks and regression watch items; forward edges expose bounded frontier candidates. A single direction cannot support both audits.
  Date/Author: 2026-07-10 / Codex

- Decision: call traversal endpoints `frontier_candidate`, never `confirmed_leaf`, unless the implementation can prove no accepted successor exists in the whole committed graph.
  Rationale: `maxDepth` and branch limits can truncate a lineage. Stronger wording would overstate the graph evidence.
  Date/Author: 2026-07-10 / Codex

- Decision: seed the 15 ResearchStudio-style research actions locally but mark every built-in card as `seed_taxonomy` and `empirical_outcome_backed=false`.
  Rationale: PaperNexus does not currently contain the outcome-labeled Oral/high-citation/Reject corpus needed to substantiate success/failure rates. The seed cards are action vocabulary and audit prompts, not acceptance predictors.
  Date/Author: 2026-07-10 / Codex

- Decision: derive subtractive gaps only from assumptions repeated across distinct graph-backed papers; repeated roles for the same paper do not count as persistence.
  Rationale: this creates a testable minimum evidence bar and avoids turning one paper's assumption into a cross-generation claim.
  Date/Author: 2026-07-10 / Codex

- Decision: preserve candidate mechanisms and their audit trace in the episode-local proposal handoff, not as new raw graph nodes or edges.
  Rationale: candidate ideas are provisional and may be rejected. The raw graph remains source authority; proposal artifacts remain episode authority.
  Date/Author: 2026-07-10 / Codex

## Outcomes & Retrospective

Actual outcome:

- Added a pure, dependency-free `researchstudio-innovation.js` material-analysis layer. It derives additive/subtractive structural gaps, distinct-paper persistent assumptions, bounded frontier candidates, historical-regression watch items, 15 provenance-labeled seed action cards, gap-first pattern matches, idea traces, mechanism collision query plans, and proposal evidence handoff.
- Added public `structural_gap_pack` and `innovation_pattern_pack` runtime/MCP/CLI operations. `innovation_evidence_pack` remains backward compatible and now includes `structural_gap_analysis`, `innovation_pattern_analysis`, `mechanism_collision_audit`, traced idea cards, and `proposal_graph_handoff`.
- Added four integrated export artifacts: `structural_gap_analysis.json`, `innovation_pattern_analysis.json`, `mechanism_collision_audit.json`, and `proposal_graph_handoff.json`; the novelty audit export also embeds the three analysis sections.
- Preserved raw graph authority: all candidate reasoning is returned/exported material, and the handoff states `episode_local=true` and `raw_graph_mutation=false`.
- Validation passed: syntax checks and both wrapper help commands; 52/52 focused tests; full suite 977 passed, 0 failed, 2 skipped out of 979; a final 12/12 focused run includes the added sparse/ambiguous starvation case; schema snapshot, generated docs, and `git diff --check` are clean.

Post-implementation code-to-plan audit:

| Planned result | Current implementation evidence | Status | Residual gap |
|---|---|---|---|
| Evidence-first ordered trace | `sequence_contract`, gap-linked matches, idea-card `researchstudio_trace` | Met | Match quality still depends on available graph/material evidence |
| Additive frontier gaps | validated lineage reuse plus `frontier_candidate` and `global_leaf_proven=false` | Met | Bounded traversal cannot certify a corpus-global leaf |
| Subtractive persistent assumptions | distinct-paper grouping and counterfactual-ablation boundary | Met | Semantic aliases of differently named assumptions are not merged |
| Historical regression protection | backward-lineage evidence refs and required tests | Met | The watchlist proposes tests; it does not execute them |
| Fifteen research actions | versioned seed cards, gap-first matching, success/failure recipes | Met as taxonomy | No empirical Oral/high-citation/Reject outcome corpus |
| Mechanism collision discovery | fingerprint, decomposed queries, lexical prior candidates | Partially met by design | Semantic equivalence requires imported full text plus embedding/model review |
| Proposal integration | episode-local `proposal_graph_handoff.evidence_export` | Met as handoff | Role-action generation remains external/supplied |
| Public and recoverable interface | MCP operations, wrapper commands, JSON exports, docs, schema snapshot | Met | Live remote deployment/restart was outside authorization |

Remaining gaps:

- Outcome-conditioned pattern mining from real Oral/high-citation/Reject records is not part of this slice.
- True semantic mechanism-equivalence search requires embeddings or a model-backed comparison over imported full-text evidence; this slice creates an auditable query plan and lexical candidate prefilter only.
- Automatic generation of proposal role actions is not added; the handoff remains input to an Agent or supplied proposal actions.

Lessons for future harness:

- Keep structural inference, action selection, and candidate-mechanism generation as separate typed stages. This makes data starvation and evidence promotion visible instead of hiding them inside one generative prompt.
- Treat outcome-conditioned pattern learning and semantic collision closure as later evidence-acquisition capabilities, not flags that can be inferred from a seed taxonomy or lexical absence.
- In a dirty shared repository, pre-edit symbol impacts plus focused/full tests are more informative for slice-level risk than the aggregate GitNexus final rating alone.

## Context and Orientation

### User-Visible Outcome

Scenario A — structural gap discovery:

    agent_materials({
      operation: "structural_gap_pack",
      corpus: "<active corpus>",
      targetProblem: "<problem without a preselected solution>",
      method: "<lineage anchor method>",
      maxDepth: 4,
      limit: 8
    })

Expected behavior:

- The response separates `additive_gaps` and `subtractive_gaps`.
- `persistent_assumptions` count distinct papers and identify whether they align to multiple lineage steps.
- `frontier_leaf_status` states the traversal boundary and never treats a bounded endpoint as global proof.
- `historical_regression_watchlist` identifies earlier evidence-backed capabilities that a future mechanism must preserve.
- Sparse or ambiguous evidence yields `partial` or `starved`, plus reason codes; it never manufactures a gap.

Scenario B — pattern matching after gap formation:

    agent_materials({
      operation: "innovation_pattern_pack",
      corpus: "<active corpus>",
      targetProblem: "<problem>",
      method: "<lineage anchor method>",
      patternLimit: 2
    })

Expected behavior:

- Every match references an existing `structural_gap_id`.
- No pattern is selected directly from the topic string when the structural pack has no gap.
- Match basis, score, trigger terms, success recipe, failure recipe, required evidence, and evidence origin are inspectable.
- Built-in cards report `outcome_evidence_status=seed_taxonomy_only` unless caller-supplied cards include evidence references.

Scenario C — integrated AutoResearch handoff:

    agent_materials({
      operation: "innovation_evidence_pack",
      corpus: "<active corpus>",
      targetProblem: "<problem>",
      method: "<lineage anchor method>",
      ideaComponents: ["<candidate component>"]
    })

Expected behavior:

- Existing fields remain present.
- New `structural_gap_analysis`, `innovation_pattern_analysis`, `mechanism_collision_audit`, and `proposal_graph_handoff` fields appear.
- Each generated idea card carries `researchstudio_trace` with structural gap, pattern application, and historical-regression references.
- The handoff explicitly says `episode_local=true` and `raw_graph_mutation=false`.

### Current State Snapshot

Current code and responsibilities:

- `src/core/graph/research-intelligence.js`: authoritative method resolution and validated method-evolution traversal. `buildMethodEvolutionGapAnalysis` currently returns lineages, trajectories, and generic next-gap candidates.
- `src/core/materials/agent-materials.js`: builds source plans, research material packs, negative evidence, gap maps, closest-prior maps, experiment anchors, collision matrices, idea cards, storylines, proposal sessions, exports, and operation dispatch.
- `src/core/graph/proposal-controller.js`: episode-local typed proposal graph, deterministic action merge, commit gate, evidence export, and artifact persistence.
- `src/mcp/tools.js`: JSON schema for public MCP tools. `agent_materials.operation` currently omits the two proposed operations.
- `docs/agent-material-backend.md`, `docs/agent-materials/index.md`, and `docs/interfaces/mcp-skill-contracts.md`: human-facing capability and boundary contracts.
- `test/innovation-evidence-pack.test.js`, `test/evidence-sufficiency.test.js`, `test/composition-collision.test.js`, `test/proposal-controller.test.js`, `test/agent-materials-tool.test.js`, and `test/mcp-schema-snapshot.test.js`: principal regression surfaces.

Focused baseline from the current dirty worktree:

    node --test test/research-intelligence.test.js test/method-evolution-overlay.test.js test/innovation-evidence-pack.test.js test/evidence-sufficiency.test.js test/composition-collision.test.js test/proposal-controller.test.js test/agent-materials-tool.test.js test/mcp-schema-snapshot.test.js

Result: 45 passed, 0 failed.

Current-code gap analysis:

| Desired behavior | Existing authority | Current gap | Planned minimum change |
|---|---|---|---|
| Evidence-first ordered discovery | `buildResearchMaterialPack` | Stages are not represented as one trace | Add a sequence contract and cross-references in new packs |
| Additive frontier gaps | validated method lineages plus flat `gap_map` | No bounded frontier classification | Derive `frontier_candidate` endpoints and attach matching material gaps |
| Subtractive gaps | graph-backed Assumption nodes in paper contexts | Assumptions are mixed into flat gaps; no persistence count | Group assumptions by distinct paper and lineage evidence |
| Historical regression audit | backward lineage bottleneck/trade-off evidence | No protected-capability watchlist | Derive evidence-backed watch items; require candidate counterfactual tests |
| Pattern/action matching | no dedicated layer | Generic mechanism transfer occurs without an explicit action vocabulary | Add 15 seed cards and gap-first deterministic matching |
| Outcome-aware recipes | review/outcome fields exist in graph schema, but no ResearchStudio outcome corpus | No defensible accepted-vs-reject statistics | Keep seed recipes heuristic; accept evidence-backed caller cards additively |
| Mechanism collision | `composition_collision_matrix` | Lexical components are easily mistaken for mechanism equivalence | Add explicit mechanism fingerprint/query plan and semantic boundary |
| Proposal provenance | `evidenceExport` pass-through | Integrated pack does not prepare structured refs | Add `proposal_graph_handoff`; no raw graph mutation |
| Public MCP use | `agent_materials` schema and dispatcher | Operations/parameters absent | Extend enum and add bounded optional inputs |
| Recovery/audit | JSON export and tests | New intermediates not independently replayable | New operations return/export complete deterministic JSON |

Expectation-fit audit before implementation:

- The user's desired improvement is not “more generated ideas”; it is better innovation-point discovery from PaperNexus evidence. The plan therefore changes the ordering and audit trace before adding any generation behavior.
- The plan directly covers additive gaps, subtractive gaps, historical regression, research-action matching, collision decomposition, falsification handoff, and proposal-local provenance from the ResearchStudio note.
- The plan deliberately does not claim outcome-learned pattern quality, semantic equivalence, autonomous proposal generation, or scientific novelty. Those claims require evidence that the current repository does not possess.
- The smallest coherent slice is two inspectable material operations plus integrated fields. Adding raw graph node types such as `InnovationPattern` or `CandidateMechanism` would increase schema and ingestion risk without improving this episode's evidence authority.
- Therefore the plan is aligned with the improvement goal at the reasoning-contract level and conservative at the empirical-claim level.

### Terms and System Map

- Structural gap: a source-backed unresolved constraint inferred from material evidence and, when supplied, a validated method lineage.
- Additive gap: a missing capability or unresolved failure at a bounded frontier candidate or current material set.
- Subtractive gap: a repeated assumption or component dependency that may be removable or replaceable. It remains a hypothesis until a counterfactual test is specified.
- Frontier candidate: the terminal method observed within a bounded accepted-edge traversal. It is not necessarily a global leaf.
- Persistent assumption: the same normalized Assumption node/name observed in at least the configured number of distinct graph-backed papers.
- Historical regression watch item: an earlier bottleneck/capability supported by lineage evidence that a new mechanism must not reintroduce.
- Pattern card: a research-action recipe with triggers, success/failure checks, required evidence, anti-patterns, and evidence origin.
- Mechanism collision audit: a deterministic decomposition of gap, action, and intervention into exact queries and lexical prior candidates. It is not a semantic novelty certificate.
- Proposal graph handoff: compact evidence/provenance fields intended for `proposal_graph_session.evidenceExport`; it is episode-local and non-authoritative for raw corpus facts.

System flow:

    committed corpus graph + source/material views
      -> validated method lineage (optional but preferred)
      -> structural_gap_pack
           -> additive_gaps
           -> subtractive_gaps / persistent_assumptions
           -> frontier candidates
           -> historical-regression watchlist
      -> innovation_pattern_pack
           -> gap-first research-action matches
           -> heuristic-vs-evidence-backed origin boundary
      -> innovation_evidence_pack
           -> mechanism collision query plan
           -> enriched idea cards and falsifiers
           -> proposal_graph_handoff.evidence_export
      -> episode-local proposal_graph_session

## Scope

This plan includes:

- One pure ResearchStudio innovation-analysis module with deterministic structural-gap, pattern, collision, idea-trace, and proposal-handoff functions.
- Public `structural_gap_pack` and `innovation_pattern_pack` operations.
- Additive integration into `innovation_evidence_pack`.
- Optional inputs for method anchor/depth/limits, persistence threshold, pattern limit, caller-supplied pattern cards, candidate mechanism, and removed components.
- Focused unit/integration tests, MCP schema snapshot, generated reference docs, and interface documentation.
- Explicit evidence boundaries and data-starvation states.

## Non-Goals

This plan does not include:

- Scraping or importing the ResearchStudio 1,947-paper outcome dataset.
- Estimating acceptance probability, pattern success rate, or causal effect of Oral/Reject evidence.
- Adding UMAP, HDBSCAN, a vector database, or an LLM call to pattern matching.
- Claiming semantic equivalence from lexical search.
- Mutating the raw corpus graph with candidate mechanisms, pattern applications, threats, or planned experiments.
- Making `proposal_graph_session` autonomously generate role actions.
- Changing existing synchronous/async import behavior or deploying/restarting the remote server.
- Cleaning, reverting, staging, committing, or pushing unrelated dirty-worktree changes.

## Non-Negotiable Rules

1. Every pattern match must reference a pre-existing structural gap; no topic-to-pattern shortcut.
2. Every cross-paper persistence count deduplicates by paper identity; repeated material roles never inflate evidence.
3. Bounded traversal endpoints are `frontier_candidate`, never global leaf proof.
4. Built-in pattern cards are `seed_taxonomy` and `empirical_outcome_backed=false`.
5. Provider/discovery-only records do not become graph-grounded evidence before import completion and authoritative sync.
6. Collision outputs state whether semantic equivalence was checked; lexical absence is never novelty proof.
7. Raw corpus graph state is unchanged. Candidate reasoning lives in returned/exported packs and proposal-session artifacts.
8. Existing public operation behavior and fields remain compatible when new inputs are omitted.
9. Run GitNexus impact analysis before editing every existing function/class/method symbol; announce HIGH/CRITICAL risk first.
10. Preserve all unrelated uncommitted changes and perform no remote, paid, destructive, commit, or push action.

## Authority / Evidence Model

Direct authority:

- Committed PaperNexus graph and material/source records: decide what paper, method, assumption, relationship, and source span is graph-grounded.
- Validated method-evolution edges returned by `buildMethodEvolutionGapAnalysis`: decide accepted lineage and quoted bottleneck/trade-off evidence.
- Episode-local proposal graph and its commit decision: decide proposal-session completeness only.

Evidence only:

- Structural-gap classification: deterministic synthesis over direct authorities.
- Seed pattern match: heuristic action recommendation, not outcome evidence or idea validity.
- Mechanism collision lexical hit: prior candidate for review, not semantic equivalence.
- Negative-evidence absence confidence: bounded search scope, not novelty proof.

State transition:

    source/graph evidence
      -> method-lineage + material gap audit
      -> structural_gap_pack (derived evidence)
      -> innovation_pattern_pack (heuristic action matches)
      -> mechanism collision/falsifier audit
      -> proposal_graph_session evidence export
      -> human/AutoResearch review decision

No derived pack may promote itself back into raw graph authority without a separate approved ingestion/writeback workflow.

## Plan of Work

### Phase 0: Context and Contract Inventory

Goal:

- Freeze current behavior, dirty-worktree boundaries, existing authorities, and observable acceptance scenarios.

Edits:

- This ExecPlan only.

Validation:

- Focused baseline is green.
- Current-code gap matrix identifies exact files and public contracts.
- GitNexus pre-edit impact reports are recorded before Phase 1 source edits.

Risks:

- GitNexus index may describe baseline `d3d0018` while the worktree contains newer uncommitted changes.

Artifacts:

- `.agent/plans/2026-07-10-papernexus-researchstudio-innovation.md`.

### Phase 1: Pure Structural-Gap and Pattern Slice

Goal:

- Produce deterministic, evidence-bounded structural and pattern analyses independent of corpus I/O.

Edits:

- `src/core/materials/researchstudio-innovation.js`: define the 15 seed cards and pure compilers.
- `test/researchstudio-innovation.test.js`: verify gap ordering, paper deduplication, lineage boundaries, pattern provenance, collision boundaries, and proposal handoff.

Validation:

- Pure tests pass with a fixed material-pack and lineage fixture.
- A pattern match cannot exist when no structural gap exists.
- Two role entries for one paper count once; two distinct papers can satisfy the default persistence threshold.
- `semantic_equivalence_checked` is false and lexical absence carries a non-novelty boundary.

Risks:

- Trigger vocabulary may overfit English phrasing.

Mitigation:

- Expose match basis and low/medium/high bounded score; keep unmatched gaps; permit caller-supplied cards; do not call the match a scientific judgment.

### Phase 2: Agent-Materials Operations and Integrated Trace

Goal:

- Expose the pure compilers through corpus-backed operations and enrich the existing innovation pack.

Edits:

- `src/core/materials/agent-materials.js`:
  - import `buildMethodEvolutionGapAnalysis` and the pure compilers;
  - add an internal bounded method-lineage/material analysis helper;
  - add `buildStructuralGapPack` and `buildInnovationPatternPack`;
  - dispatch the two operations;
  - enrich `buildInnovationEvidencePack` with structural analysis, pattern analysis, idea traces, mechanism collision audit, and proposal handoff;
  - render/export the new integrated sections without removing existing files.

Validation:

- Sparse corpus returns `starved`/`partial` with no fabricated pattern match.
- A graph fixture with validated lineage and repeated assumptions returns both additive and subtractive gaps.
- Existing innovation pack fields and tests remain present and green.
- `outputDir` exports remain replayable JSON; integrated export exposes paths for the new analyses.

Risks:

- `agent-materials.js` is a broad shared backend and may have a HIGH blast radius.

Mitigation:

- Run GitNexus impact first, keep compilers pure, add only two dispatcher branches and additive fields, and validate the full Agent-material suite.

### Phase 3: Public Contract and Documentation

Goal:

- Make the operations discoverable and prevent consumers from overstating the result.

Edits:

- `src/mcp/tools.js`: extend `agent_materials.operation` and add bounded optional inputs.
- `test/fixtures/mcp-tools-schema.snapshot.json`: regenerate through the repository's reviewed snapshot flow.
- `docs/agent-material-backend.md`: add operation examples, output semantics, and outcome/collision boundaries.
- `docs/agent-materials/index.md`: list the two new material packs.
- `docs/interfaces/mcp-skill-contracts.md`: document the ordered evidence contract and proposal-local boundary.
- `docs/reference/generated/mcp-tools.md`: regenerate with `npm run docs:generate`.

Validation:

- MCP schema snapshot passes.
- Generated docs match the runtime schema.
- Documentation uses `frontier_candidate`, `seed_taxonomy`, and `semantic_equivalence_checked=false` terminology.

### Phase 4: Regression, Change Detection, and Plan Re-Audit

Goal:

- Prove compatibility in the combined dirty worktree and record residual risk.

Validation:

    node --check src/core/materials/researchstudio-innovation.js
    node --check src/core/materials/agent-materials.js
    node --check src/mcp/tools.js
    node --test test/researchstudio-innovation.test.js test/research-intelligence.test.js test/method-evolution-overlay.test.js test/innovation-evidence-pack.test.js test/evidence-sufficiency.test.js test/composition-collision.test.js test/proposal-controller.test.js test/agent-materials-tool.test.js test/mcp-schema-snapshot.test.js
    npm test
    npm run docs:generate
    git diff --check

- Run `gitnexus_detect_changes(scope="all")`; separate this slice's flows from pre-existing Firecrawl/non-blocking/import changes.
- Re-score the ExecPlan against all ten 0–2 dimensions and record final score.

## Implementation Slices

- Slice: pure ResearchStudio analysis
  Files: `src/core/materials/researchstudio-innovation.js`, `test/researchstudio-innovation.test.js`
  Acceptance: deterministic unit tests prove gap-first ordering, evidence boundaries, and no raw graph mutation dependency.

- Slice: corpus-backed structural operation
  Files: `src/core/materials/agent-materials.js`, `test/agent-materials-tool.test.js`
  Acceptance: `structural_gap_pack` returns evidence-linked additive/subtractive/frontier/regression sections on a fixture corpus.

- Slice: pattern operation and integrated innovation trace
  Files: `src/core/materials/agent-materials.js`, `test/innovation-evidence-pack.test.js`
  Acceptance: `innovation_pattern_pack` matches only compiled gaps; `innovation_evidence_pack` attaches trace, collision audit, and proposal handoff while preserving old fields.

- Slice: public contract
  Files: `src/mcp/tools.js`, schema snapshot, three docs, generated tool reference
  Acceptance: schema test passes and generated docs enumerate the new operations/inputs.

## Agent / Tool Contracts

This implementation uses no sub-agents, paid APIs, remote PaperNexus calls, SSH commands, or graph mutations.

Tool inputs and outputs:

- GitNexus `impact`: read-only pre-edit blast-radius evidence for each existing symbol to be modified.
- Local Node tests: read/write temporary fixture directories only; no production corpus mutation.
- `npm run docs:generate`: mechanically regenerates repository documentation from local schemas.
- GitNexus `detect_changes`: read-only combined-worktree impact report.

Failure boundary:

- If a source symbol is HIGH or CRITICAL, warn before editing and constrain the patch to additive fields/branches.
- If a focused baseline fails before the new slice is applied, record the failure and do not attribute it to this implementation.
- If full tests fail only in unrelated pre-existing areas, retain evidence and report the exact separation; do not repair unrelated code without authority.

## Concrete Steps

Run from `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`:

1. Inspect current status and target diffs:

       git status --short --branch
       git diff -- src/core/materials/agent-materials.js src/mcp/tools.js docs/agent-material-backend.md docs/agent-materials/index.md docs/interfaces/mcp-skill-contracts.md test/fixtures/mcp-tools-schema.snapshot.json

2. Run GitNexus context/impact for the exact symbols selected after the pure-module design is fixed.

3. Add the pure module and focused test with `apply_patch`; run:

       node --test test/researchstudio-innovation.test.js

4. Add corpus-backed operations and integrated fields with `apply_patch`; run:

       node --test test/researchstudio-innovation.test.js test/innovation-evidence-pack.test.js test/agent-materials-tool.test.js

5. Extend the MCP schema and docs, then regenerate:

       npm run docs:generate
       node --test test/mcp-schema-snapshot.test.js

6. Run the full validation commands from Phase 4 and GitNexus change detection.

Expected:

- All focused tests pass.
- Full test suite has no new failures.
- `git diff --check` emits no output.
- New public fields are additive and no raw corpus graph file is written by the new operations.

## Validation and Acceptance

This ExecPlan is complete when:

- [x] `structural_gap_pack` exists in runtime dispatch and MCP schema.
- [x] A validated-lineage fixture returns at least one additive gap, one cross-paper persistent assumption/subtractive gap, bounded frontier status, and a historical-regression watch item with evidence refs.
- [x] Sparse/ambiguous fixtures return explicit starvation/partial states without invented gaps.
- [x] `innovation_pattern_pack` exists and every match references a structural gap.
- [x] All built-in patterns declare `seed_taxonomy` and `empirical_outcome_backed=false`.
- [x] `innovation_evidence_pack` preserves old fields and adds structural, pattern, mechanism-collision, idea-trace, and proposal-handoff fields.
- [x] Mechanism collision output declares `semantic_equivalence_checked=false` and does not convert absence into novelty proof.
- [x] Proposal handoff declares episode-local scope and no raw graph mutation.
- [x] MCP schema snapshot and generated docs match runtime.
- [x] Focused and full tests, syntax checks, and `git diff --check` pass.
- [x] GitNexus change detection is reviewed and recorded.
- [x] `Outcomes & Retrospective` records actual results and remaining gaps.

## Idempotence and Recovery

Repeatable commands:

- All `node --test ...` commands use temporary fixture corpora and are safe to repeat.
- `npm run docs:generate` deterministically regenerates reference docs from local schemas.
- `git diff --check`, `git status`, GitNexus impact, and GitNexus change detection are read-only.

Checkpoint / ledger / manifest:

- This ExecPlan is the implementation ledger.
- Runtime outputs are complete JSON documents; when `outputDir` is supplied, their `exports.json_path` is the replay checkpoint.
- Proposal-session artifacts remain governed by `proposal-session-manifest.json`; the new handoff is only input evidence.

Resume:

- Run `git status --short --branch` and inspect `Progress`.
- Run the most recent focused command recorded in `Artifacts and Notes`.
- If the pure module exists but public dispatch does not, resume at Phase 2.
- If runtime tests pass but snapshot/docs fail, resume at Phase 3 without rewriting analytical logic.
- If full validation fails, rerun the smallest failing test file before making another edit.

Must not retry automatically:

- Remote deployment, server restart, SSH, provider search, imports, downloads, or graph mutations.
- Any operation that would clean, revert, stage, commit, or push the user's unrelated worktree changes.

## Risks and Rollback

| Risk | Signal | Mitigation | Rollback |
|---|---|---|---|
| Shared Agent-material backend regression | Existing operation test fails | Pure module plus additive dispatch/fields; focused baseline | Remove only new branches/imports/fields using a reverse `apply_patch` |
| False leaf claim | Endpoint exists only because depth/branch bound ended | Use `frontier_candidate` and expose traversal boundary | Drop frontier classification while retaining lineage evidence |
| False persistent assumption | Same paper appears under several roles | Deduplicate by stable paper id/title before counting | Raise threshold or mark result `single_paper_only` |
| Pattern overmatching | Match has only generic topic overlap | Require a compiled gap, expose score/basis, top-k bound | Raise threshold or leave gap unmatched |
| False empirical pattern claim | Seed recipe described as Oral/Reject result | Mandatory origin flags and documentation | Remove empirical wording; retain seed action vocabulary |
| Collision overclaim | Lexical absence interpreted as novelty | Separate audit, `semantic_equivalence_checked=false`, follow-up boundary | Remove lexical verdict; retain query plan only |
| Dirty-worktree overlap | Patch touches lines already modified by user | Inspect file-specific diff before/after every patch | Reapply only this slice manually; never reset the worktree |
| Generated-doc noise | Generator rewrites unrelated docs | Review `git diff --stat` and file diff | Restore only generator-created unrelated hunks with `apply_patch` if necessary |

## Artifacts and Notes

- `.agent/plans/2026-07-10-papernexus-researchstudio-innovation.md`: authority for scope, decisions, progress, and acceptance.
- Focused baseline on 2026-07-10: 45 passed, 0 failed.
- Post-implementation focused regression: 52 passed, 0 failed. Final ResearchStudio/schema check after the sparse-evidence assertion: 12 passed, 0 failed.
- Post-implementation full regression: 977 passed, 0 failed, 2 skipped out of 979 tests in 68.5 seconds.
- Syntax and wrapper validation: three Node syntax checks, Python bytecode compilation, and both new subcommand help surfaces passed.
- Documentation/schema validation: reviewed MCP snapshot regeneration and `npm run docs:generate` passed; generated MCP reference exposes both new operations and inputs.
- Whitespace validation: `git diff --check` returned no output.
- GitNexus conceptual query returned no ranked process because this index lacks usable semantic/BM25 hits for the broad query. Exact impacts were available: four LOW targets and one MEDIUM shared exporter; no HIGH/CRITICAL target.
- GitNexus final combined-worktree detection reports CRITICAL aggregate risk across 300 symbols/40 files and 57 flows because it includes unrelated pre-existing changes. Task-scoped direct impacts remained LOW except the MEDIUM shared exporter, and the full suite is green.

## Interfaces and Dependencies

Required public operation shapes at completion:

- `agent_materials.operation` adds:
  - `structural_gap_pack`
  - `innovation_pattern_pack`

- Optional additive inputs:
  - `method` / `methodName`: method-lineage anchor.
  - `maxDepth`: bounded lineage depth.
  - `patternLimit`: maximum research actions per structural gap.
  - `persistentAssumptionMinPapers`: distinct-paper threshold, default 2.
  - `patternCards`: optional caller-supplied cards; cards with evidence refs are labeled separately from seed taxonomy.
  - `candidateMechanism` and `removedComponents`: optional text used only to focus historical-regression/collision queries.

- `structural_gap_pack` minimum output:
  - `contractVersion`, `operation`, corpus/project/problem/method metadata.
  - `status`, `reason_codes`, and `sequence_contract`.
  - `method_lineage`, `frontier_leaf_status`.
  - `additive_gaps`, `subtractive_gaps`, `persistent_assumptions`.
  - `historical_regression_watchlist`.
  - `evidence_boundaries`, `data_starvation`, `generatedAt`.

- `innovation_pattern_pack` minimum output:
  - embedded structural-gap summary.
  - versioned `pattern_cards`.
  - `matches`, `unmatched_gap_ids`, and `outcome_evidence_status`.
  - policy stating gap-first selection, non-final-judge status, and evidence-origin boundary.

- `innovation_evidence_pack` additive output:
  - `structural_gap_analysis`.
  - `innovation_pattern_analysis`.
  - `mechanism_collision_audit`.
  - idea-card `researchstudio_trace`.
  - `proposal_graph_handoff` with `evidence_export`, `episode_local=true`, and `raw_graph_mutation=false`.

Dependencies:

- No new package dependency.
- Reuse `buildMethodEvolutionGapAnalysis`, existing graph/material packs, `stableHash`, `truncate`, and current JSON export utilities.
- No LLM, network provider, embedding, database, or raw graph write is required.

## ExecPlan Audit

Initial score before implementation: 20/20. Final score after implementation: 20/20.

- User result: 2 — three observable MCP scenarios and exact output behavior are defined.
- Self-contained: 2 — current architecture, terminology, scope, interfaces, and commands are summarized here.
- Current state: 2 — paths, symbols, dirty state, focused baseline, and code gaps are recorded.
- Scope boundary: 2 — scope, non-goals, evidence invariants, and side-effect boundaries are explicit.
- Work slices: 2 — pure logic, runtime integration, public contract, and regression phases are independently verifiable.
- Acceptance: 2 — runtime fields, fixtures, commands, and non-overclaim checks are specified.
- Recovery: 2 — checkpoints, resume branches, repeatable commands, and no-retry actions are explicit.
- Risk control: 2 — risks include signals, mitigations, and rollback actions; no external mutation is authorized.
- Progress log: 2 — timestamped evidence and pending next steps are maintained.
- Decisions/discoveries: 2 — architectural and evidence-boundary decisions are auditable.

Final intent-fit review:

- The implementation improves evidence-backed innovation discovery, not idea volume: structural gaps precede patterns, and every later artifact keeps gap/provenance references.
- Additive, subtractive, lineage-regression, collision-query, falsification, and proposal-handoff objectives from the ResearchStudio note are represented and tested.
- The implementation correctly remains partial for three expectations the current data cannot support: empirical Oral/Reject pattern learning, semantic mechanism equivalence, and autonomous proposal role-action generation.
- No raw graph schema or write path was added, so the change remains within the smallest compatible material-layer slice.

Hard-gate review: user result, current state, acceptance, recovery, and risk control all score 2. All acceptance checks are complete; remaining gaps are deliberate non-goals rather than hidden implementation omissions.

## Revision Notes

- 2026-07-10 22:48 CST: Created the initial self-contained plan after code, note, skill-contract, dirty-worktree, and focused-test audits. Optimized scope away from raw graph schema changes and unverifiable outcome claims toward two additive material packs plus an integrated proposal-local trace.
- 2026-07-10 22:54 CST: Recorded pre-edit GitNexus blast radii and constrained the only MEDIUM-risk shared exporter edit to additive innovation-pack artifacts.
- 2026-07-10 23:04 CST: Expanded the public-contract phase to include the canonical Python wrapper and PaperNexus SKILL guidance after confirming they are stable fallback surfaces.
- 2026-07-10 23:09 CST: Closed every acceptance item, recorded test/schema/docs/change-detection evidence, and retained the outcome-corpus, semantic-collision, and autonomous-proposal limitations as explicit future work.
