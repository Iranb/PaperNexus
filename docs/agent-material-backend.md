# Agent Material Backend

`agent_materials` is the Agent-facing material backend surface. It keeps PaperNexus focused on materials, provenance, and recoverable state while leaving novelty, story, and reviewer judgment to the Agent or user.

## Operations

Read-only material operations:

- `paper_material_view`: returns one paper's source availability, graph context, chunks, source spans, lightweight markdown table/figure materials, and matching project overlay roles.
- `source_discovery_plan`: generates target, near-source, and far-source queries, committed-graph candidates, optional provider snippet evidence, optional live-discovery evidence, optional literature-discovery resolve/import readiness, sparse-role negative evidence, and import requisitions.
- `research_material_pack`: returns role-grouped materials plus source discovery metadata, source-domain item annotations, optional provider/live-discovery/literature-discovery materials, missing materials, import requisitions, and project overlay summary.
- `structural_gap_pack`: compiles evidence-first additive and subtractive gaps, persistent assumptions, bounded method-lineage frontier candidates, and historical-regression watch items. It reuses validated exact-quote method-evolution edges when a method anchor is supplied.
- `innovation_pattern_pack`: matches ResearchStudio-style research-action cards only after structural gaps have been compiled. Built-in cards are a seed taxonomy, not empirical accepted/rejected outcome evidence.
- `innovation_evidence_pack`: compiles AutoResearch handoff materials from existing material packs into novelty baselines, structural-gap and innovation-pattern analyses, closest-prior risk signals, mechanism-to-intervention maps, experiment anchors, idea evidence cards with ResearchStudio traceability, storyline chains, evidence sufficiency, coverage matrix, lexical composition-collision screening, mechanism-collision query plans, proposal-graph handoff, provider-to-import priorities, and required follow-up actions. It is an evidence compiler and novelty auditor only: it does not prove novelty, choose the final idea, or run experiments.
- `import_requisition_pack`: returns missing-but-useful import requests, generated queries, and optional literature-discovery import readiness.
- `negative_evidence_pack`: records searched queries, filters, direct hits, adjacent hits, absence confidence, and recommended next queries from committed graph state; with `includeProviderEvidence=true`, it also records bounded Semantic Scholar snippet query runs and direct/adjacent provider hit counts. Live-discovery evidence is exposed through `source_discovery_plan` and `research_material_pack`, not persisted by this negative-evidence operation.
- `experiment_cost_materials`: extracts GPU/runtime/epoch/batch-size/dataset/backbone/code-availability snippets from chunks, source spans, markdown tables, table captions, and figure captions with provenance for Agent inspection.
- `proposal_graph_session`: runs an episode-local typed proposal graph controller. It validates role actions against frozen snapshots, merges accepted actions deterministically, gates commits on required problem/hypothesis/mechanism/method/novelty/eval/risk structure, and writes committed proposal artifacts without mutating the raw corpus graph.

Project overlay operations:

- `paper_role_overlay`: add, update, list, or remove project-local paper role judgments.
- `evidence_cart`: add, list, remove, or export project-local evidence items.
- `workflow_state`: get or update the current project hypothesis, accepted/rejected directions, open questions, and needed materials.

Overlay state is stored under the selected corpus root:

```text
.papernexus/agent-materials/projects/<project>/
  roles.jsonl
  evidence-cart.jsonl
  workflow-state.json
```

These files are project memory, not raw graph facts. They must not be merged into the corpus graph as paper truth.

## ResearchStudio-Style Ordered Innovation Audit

The structural and pattern operations enforce the order `committed evidence -> structural gap -> research action -> concrete mechanism -> collision/regression/falsification audit`. A topic string alone cannot select a pattern. Sparse evidence produces `partial` or `starved` status and reason codes instead of a manufactured gap.

Request a structural audit with an optional method-lineage anchor:

```json
{
  "operation": "structural_gap_pack",
  "corpus": "<corpus>",
  "targetProblem": "<problem without a preselected solution>",
  "method": "<method name or Method node id>",
  "maxDepth": 4,
  "lineageLimit": 8,
  "persistentAssumptionMinPapers": 2
}
```

The result keeps four boundaries explicit:

- `additive_gaps` describe missing capabilities or unresolved failures supported by current materials or bounded lineage endpoints.
- `subtractive_gaps` are repeated assumptions or component dependencies that might be removed or replaced. A repeated role for the same paper counts once; the default persistence threshold is two distinct graph-backed papers.
- `frontier_candidates` are terminal methods observed within bounded traversal. `global_leaf_proven=false` prevents a depth/limit boundary from being misreported as a corpus-global leaf.
- `historical_regression_watchlist` records earlier lineage bottlenecks or capabilities that a candidate mechanism must not reintroduce.

Match research actions after the gap audit:

```json
{
  "operation": "innovation_pattern_pack",
  "corpus": "<corpus>",
  "targetProblem": "<problem>",
  "method": "<method anchor>",
  "patternLimit": 2
}
```

Every match references a `structural_gap_id` and exposes its score, trigger terms, success recipe, failure recipe, required evidence, and evidence origin. The 15 built-in cards use `source_type=seed_taxonomy`, `empirical_outcome_backed=false`, and `outcome_evidence_status=seed_taxonomy_only`. Caller-supplied cards retain empirical-outcome status only when they explicitly opt in and provide outcome evidence references.

The integrated `innovation_evidence_pack` adds `structural_gap_analysis`, `innovation_pattern_analysis`, `mechanism_collision_audit`, and `proposal_graph_handoff`. The collision audit emits a deterministic mechanism fingerprint, decomposed search queries, and lexical candidates, but always reports `semantic_equivalence_checked=false` and `novelty_claim_allowed=false`. The proposal handoff is `episode_local=true` and `raw_graph_mutation=false`; it is evidence input for `proposal_graph_session`, not a corpus fact or autonomously generated role-action slate.

## Source Router

`source_discovery_plan` and `research_material_pack` include a graph-native source router in the additive fields `router_policy`, `candidate_source_domains`, `source_domain_queries`, and `source_relevance_scores`.

The router uses committed graph domain nodes and paper/node domain properties. It can accept explicit source-domain hints without requiring them:

- `preferDomains`: promote source domains while still allowing graph-derived candidates.
- `excludeDomains`: remove source domains from the router.
- `nearSourceDomains`: force domains into the near-source method layer.
- `farSourceDomains`: force domains into the far-source story layer.
- `minDomainDistance`: mark below-threshold domains as `proximal_leakage`.
- `maxProximalResults`: cap how many `proximal_leakage=true` domains remain in the plan.
- `sourceDomainLimit`: cap returned source domains.
- `autoDiscoverSources`: compatibility flag accepted by the MCP schema and wrapper; source discovery is generated by default in the current material-pack backend.

Source-domain candidates promoted into `research_material_pack.groups[].items[]` keep additive `source_domain`, `domain_distance`, and `proximal_leakage` fields so Agents can inspect where near/far materials came from.

Paper candidate arrays are publication-date aware. `candidate_papers`, provider-derived candidates, live-discovery supporting papers, and literature-discovery candidates are sorted newest-first when `publicationDate`, `publicationDateOrYear`, or `year` metadata is present. Role grouping remains intact in `source_discovery_plan`; within each role, dated papers precede undated papers, and undated papers use the previous stable score/title fallback.

Provider evidence is explicit opt-in. Set `includeProviderEvidence=true` to run bounded read-only Semantic Scholar snippet searches over generated target/source queries. The backend records `provider_evidence.query_runs[]`, discovered provider candidates, provider-backed import requisitions, and `materials.provider_snippets[]` for material-pack items. This does not resolve PDFs, enqueue imports, or write graph facts.

Set `persistProviderEvidence=true` with a `project` to copy returned provider snippets into the project `evidence_cart` as `provider_snippet` items. This creates recoverable Agent memory while keeping raw corpus graph state unchanged. Use `providerEvidencePersistLimit` to cap persisted snippets.

Live discovery evidence is also explicit opt-in. Set `includeLiveDiscoveryEvidence=true` to run bounded `idea_catalyst live_discovery` inside `source_discovery_plan`, `research_material_pack`, or `import_requisition_pack`. The backend records `live_discovery_evidence.source_domain_analyses[]`, `source_domain_queries[]`, `source_spans[]`, `supporting_papers[]`, and `idea_fragments[]`; supporting papers become discovered candidate materials and import requisitions when they are not materialized in the selected corpus. This remains read-only against the raw graph and does not submit imports or produce novelty verdicts.

For controlled sparse fallback, set `runLiveIdeaCatalystIfNeeded=true` or `liveDiscoveryFallbackIfSparse=true`. The backend first counts committed-graph candidates for requested roles, then runs live discovery only when the sparse-role threshold is met. Use `liveDiscoverySparseRoleThreshold` and `liveDiscoverySparseMinScore` to tune that trigger.

Set `persistLiveDiscoveryEvidence=true` with a `project` to copy returned live-discovery spans/fragments into the project `evidence_cart` as `idea_catalyst_live_discovery` items. Use `liveDiscoveryNumQuestions`, `liveDiscoverySourceDomainLimit`, `liveDiscoveryMaxPapersPerQuery`, `liveDiscoveryIdeaFragmentLimit`, and `liveDiscoveryPersistLimit` to keep the live run bounded.

Literature discovery evidence is explicit opt-in. Set `includeLiteratureDiscoveryEvidence=true` to run bounded `literature_discovery` search and source resolution inside `source_discovery_plan`, `research_material_pack`, or `import_requisition_pack`. The backend records `literature_discovery_evidence.plan_queries[]`, resolved/metadata-only candidates, `importable_candidates[]`, and import requisitions for candidates not materialized in the corpus.

When `includeProviderEvidence=true` and `includeLiteratureDiscoveryEvidence=true` are both enabled, set `literatureDiscoverySeedProviderPapers=true` to pass provider evidence hits into `literature_discovery` as exact seed papers. This can turn snippet-only provider discoveries into source-resolution attempts, while still avoiding import submission unless `submitLiteratureDiscoveryImports=true` is also set.

When `includeLiveDiscoveryEvidence=true` and `includeLiteratureDiscoveryEvidence=true` are both enabled, set `literatureDiscoverySeedLivePapers=true` to pass live-discovery supporting papers into `literature_discovery` as exact seed papers. This is still an explicit bridge: it helps resolve live-discovered papers, but it does not submit imports unless `submitLiteratureDiscoveryImports=true` is also set.

By default this bridge does not submit imports. Set `submitLiteratureDiscoveryImports=true` to enqueue resolved full-text candidates, and set `processLiteratureDiscoveryImports=true` only when the caller intentionally wants the import worker to run inline. Inline processing uses progressive logical batching by default with `literatureDiscoveryImportBatchEnabled=true`, `literatureDiscoveryImportBatchInitialTasks=4`, and `literatureDiscoveryImportBatchMaxTasks=16`.

For controlled sparse fallback, set `runLiteratureDiscoveryIfSparse=true` or `literatureDiscoveryFallbackIfSparse=true`. The backend first counts committed-graph candidates for requested roles, then runs literature discovery only when the sparse-role threshold is met.

## Wrapper Examples

Create a paper role overlay:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py paper-role-overlay \
  --corpus <corpus> \
  --project <project> \
  --action add \
  --paper-id <paper-id> \
  --role novelty_risk \
  --layer target_domain \
  --confidence medium
```

Add evidence:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py evidence-cart \
  --corpus <corpus> \
  --project <project> \
  --action add \
  --paper-id <paper-id> \
  --role novelty_risk \
  --item-type snippet \
  --source-type chunk \
  --source-id <chunk-id> \
  --text "<short evidence excerpt>"
```

Update workflow state:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py workflow-state \
  --corpus <corpus> \
  --project <project> \
  --action update \
  --hypothesis "<current hypothesis>" \
  --open-question "<question>" \
  --needed-material "<material gap>"
```

Inspect experiment cost snippets:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py experiment-cost-materials \
  --corpus <corpus> \
  --paper-id <paper-id>
```

By default the cost extractor is material-only and deterministic: it uses regex over paper chunks, source excerpts, markdown tables, table captions, and figure captions. It returns snippet provenance such as `source_type=markdown_table` or `source_type=figure_caption`, but does not decide whether an experiment is feasible.

For papers where regex snippets are too noisy, explicitly opt in to bounded LLM structured extraction:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py experiment-cost-materials \
  --corpus <corpus> \
  --paper-id <paper-id> \
  --include-cost-llm-extraction \
  --cost-llm-model <model>
```

The LLM layer reads only capped material records from the selected paper and writes an additive `llm_extraction` block. It is not enabled by default and still returns provenance-linked materials rather than final feasibility judgments.

Record negative-evidence material:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py negative-evidence-pack \
  --corpus <corpus> \
  --project <project> \
  --target-domain "<target domain>" \
  --target-problem "<direct setting query>" \
  --time-window "2020-2026" \
  --role negative_evidence \
  --include-provider-evidence \
  --persist-provider-evidence
```

Generate a source-discovery plan with router hints:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py source-discovery-plan \
  --corpus <corpus> \
  --project <project> \
  --target-domain "<target domain>" \
  --target-problem "<research problem>" \
  --near-source-domain "<method source domain>" \
  --far-source-domain "<story source domain>" \
  --min-domain-distance 0.5 \
  --source-domain-limit 8 \
  --include-provider-evidence \
  --persist-provider-evidence \
  --provider-evidence-query-limit 6 \
  --provider-evidence-limit 3 \
  --include-live-discovery-evidence \
  --live-discovery-num-questions 1 \
  --live-discovery-source-domain-limit 2 \
  --live-discovery-max-papers-per-query 5
```

Regenerate a material pack after overlay writes:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py research-material-pack \
  --corpus <corpus> \
  --project <project> \
  --target-domain "<target domain>" \
  --target-problem "<research problem>" \
  --role target_prior \
  --role novelty_risk \
  --output-dir /tmp/papernexus-material-pack
```

When `--output-dir` is provided for `research-material-pack`, the backend writes:

```text
material_pack.json
material_pack.md
source_discovery_plan.json
missing_materials.json
negative_evidence.json
overlay_summary.json
```

Compile structural gaps and then match research-action patterns from the wrapper:

```bash
python SKILL/PaperNexus/scripts/pn_agent_materials.py structural-gap-pack \
  --corpus <corpus> \
  --target-problem "<research problem>" \
  --method "<method anchor>" \
  --max-depth 4 \
  --lineage-limit 8 \
  --persistent-assumption-min-papers 2

python SKILL/PaperNexus/scripts/pn_agent_materials.py innovation-pattern-pack \
  --corpus <corpus> \
  --target-problem "<research problem>" \
  --method "<method anchor>" \
  --pattern-limit 2
```

Compile an AutoResearch innovation evidence handoff through MCP:

```json
{
  "operation": "innovation_evidence_pack",
  "corpus": "<corpus>",
  "project": "<project>",
  "targetDomain": "<target domain>",
  "targetProblem": "<research problem>",
  "outputDir": "/tmp/papernexus-innovation-evidence"
}
```

Its output groups the same underlying materials into:

- `evidence_sufficiency`: `status`, `reason_codes`, `novelty_claim_allowed`, and `experiment_planning_allowed`. If the status is `insufficient` or `inconclusive`, the consumer must continue approved follow-up research or report a blocker.
- `coverage_matrix`: committed-graph coverage, provider-only coverage, provider failures, required queries, and required imports by coverage area.
- `composition_collision_matrix`: single-component, pairwise-combination, and full-combination collision audit without treating graph-scope absence as novelty proof.
- `negative_evidence_assessment`: emits `negative_inconclusive` when provider 429/timeout/error weakens absence evidence.
- `required_followup`: executable next actions such as `literature_discovery`, `import_requisition_pack`, `import_workflow`, or rerunning `innovation_evidence_pack`.
- `provider_to_import_priority`: P0/P1/P2 import priorities for provider-only or discovery-only priors that are not yet graph evidence.
- `idea_evidence_cards`: candidate problem/gap/mechanism/intervention/falsifier cards for AutoResearch review.
- `structural_gap_analysis`: evidence-first additive/subtractive gaps, persistent assumptions, bounded frontier candidates, and historical-regression references.
- `innovation_pattern_analysis`: gap-linked research-action matches with seed-taxonomy versus caller-evidence provenance.
- `mechanism_collision_audit`: decomposed mechanism search plan and lexical prefilter with an explicit semantic-equivalence boundary.
- `proposal_graph_handoff`: episode-local evidence/provenance input for a later `proposal_graph_session`, with no raw graph mutation.
- `storyline_chains`: status-quo, tension, gap, mechanism, intervention, validation, contribution-boundary, and risk beats.
- `evidence_boundaries`: what is evidence-supported, Agent-inferred, and speculative.
- `autoresearch_handoff`: required consumer checks before experiment planning.

Guardrail:

- If `evidence_sufficiency.novelty_claim_allowed=false`, do not write a final novelty claim. Treat the idea as an open hypothesis until `required_followup` is completed or explicitly blocked.
- Provider-only papers and literature-discovery candidates remain discovery evidence until import tasks complete and graph sync is visible through `import_workflow`.
- `negative_inconclusive` means provider failures weakened absence evidence; it is not a weak novelty proof.

When `outputDir` is provided through MCP, the backend writes machine-readable and human-readable handoff artifacts:

```text
innovation_evidence_pack.json
innovation_evidence_pack.md
innovation-evidence-pack.json
innovation-evidence-pack.md
evidence_sufficiency.json
coverage_matrix.json
composition_collision_matrix.json
structural_gap_analysis.json
innovation_pattern_analysis.json
mechanism_collision_audit.json
proposal_graph_handoff.json
required_followup.json
provider_to_import_priority.json
novelty_audit_pack.json
novelty_audit_pack.md
idea_evidence_cards.json
idea-evidence-cards.jsonl
idea-evidence-cards.md
storyline_chains.json
storyline-chains.json
storyline-chains.md
autoresearch_handoff.json
autoresearch-handoff.json
autoresearch-handoff.md
```

The hyphenated files match the AutoResearch handoff artifact names. The underscore files preserve the existing `agent_materials` operation naming convention.
