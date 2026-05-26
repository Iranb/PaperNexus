---
name: papernexus-agent-materials
description: Use when an agent needs PaperNexus to build a multi-domain research material pack from a target domain, target problem, and constraints; discover target, near-source, and far-source papers through PaperNexus graph/provider/live/literature-discovery evidence; generate import requisitions; optionally submit resolved imports; and preserve project overlay, evidence cart, or workflow state.
---

# PaperNexus Agent Materials

Use this skill when the user wants PaperNexus to support a research story, novelty check, related-work expansion, or cross-domain idea workflow with reusable materials.

PaperNexus is the material backend:

- it finds, organizes, resolves, imports, and tracks paper materials
- it separates target prior, near-source method, far-source story, novelty-risk, baseline, negative evidence, and missing-paper roles
- it can compile innovation evidence packs with idea evidence cards, storyline chains, falsifiers, experiment anchors, and explicit evidence boundaries for AutoResearch handoff
- it records provenance, availability, import status, and project overlay state

The Agent or user remains responsible for final novelty, method, story, reviewer, and experiment judgments.

## Control Plane

For live graph work, use the configured `papernexus-remote` MCP server first.

Preferred MCP tool:

- `agent_materials`

Shell fallback wrapper:

- `python3 SKILL/PaperNexus/scripts/pn_agent_materials.py`

Do not call raw `/api/*`, do not use local graph reads for a live corpus, and do not hardcode MCP URLs, IPs, or bearer tokens in examples.

## Phased MCP Workflow

### Phase 0: Resolve Scope

Before graph-specific work:

- resolve the corpus with `list_corpora` if the active corpus is unclear
- choose a stable `project` id for overlay and evidence reuse
- define `targetDomain`, `targetProblem`, and `constraints`
- request roles explicitly when the task needs separated packs

Typical roles:

- `target_prior`
- `near_source_method`
- `far_source_story`
- `novelty_risk`
- `baseline_candidate`
- `negative_evidence`

### Phase 1: Build Graph-First Material Pack

Call `agent_materials` with `operation=research_material_pack`.

Use this first because it is predictable, graph-grounded, and side-effect free by default.

Canonical MCP payload shape:

```json
{
  "operation": "research_material_pack",
  "corpus": "<corpus>",
  "project": "<project>",
  "targetDomain": "<target scientific or engineering domain>",
  "targetProblem": "<research problem>",
  "constraints": ["<venue, compute, data, task, or domain constraint>"],
  "roles": [
    "target_prior",
    "near_source_method",
    "far_source_story",
    "novelty_risk",
    "baseline_candidate",
    "negative_evidence"
  ],
  "autoDiscoverSources": true
}
```

Expected use:

- read role-grouped materials, not a single mixed ranking
- inspect `source_discovery_plan`, `candidate_source_domains`, `source_domain_queries`, `import_requisitions`, and `negative_evidence`
- treat missing papers as requisitions, not as graph facts

### Phase 2: Expand Discovery Evidence Explicitly

Use online evidence only when graph materials are sparse, the user asks for broader discovery, or near/far sources need PaperNexus-owned discovery beyond the committed graph.

Recommended expansion flags:

```json
{
  "includeProviderEvidence": true,
  "includeLiveDiscoveryEvidence": true,
  "includeLiteratureDiscoveryEvidence": true,
  "literatureDiscoverySeedProviderPapers": true,
  "literatureDiscoverySeedLivePapers": true
}
```

Use each layer for a distinct purpose:

- `includeProviderEvidence`: bounded Semantic Scholar snippet evidence over generated target/source queries
- `includeLiveDiscoveryEvidence`: bounded `idea_catalyst live_discovery` for source-domain analyses, supporting papers, source spans, and idea fragments
- `includeLiteratureDiscoveryEvidence`: bounded `literature_discovery` search and legal source resolution
- `literatureDiscoverySeedProviderPapers`: pass provider hits into literature discovery as exact paper seeds
- `literatureDiscoverySeedLivePapers`: pass live-discovery supporting papers into literature discovery as exact paper seeds

Sparse-only alternatives:

```json
{
  "runLiveIdeaCatalystIfNeeded": true,
  "runLiteratureDiscoveryIfSparse": true
}
```

These keep graph-first behavior unless requested role groups are sparse.

### Phase 3: Generate Import Requisitions

Call `agent_materials` with `operation=import_requisition_pack` when the Agent needs a concrete missing-paper queue.

Use the same target/domain/role inputs and, when needed, the same evidence expansion flags from Phase 2.

Read:

- `import_requisitions`
- `literature_discovery_evidence.importable_candidates`
- candidate status: `discovered`, `resolved_source`, `submitted_import`, `in_graph`, or `material_unavailable`

Do not call a paper graph-visible until its import task is completed and graph-synced.

### Phase 4: Compile AutoResearch Innovation Evidence

Call `agent_materials` with `operation=innovation_evidence_pack` when AutoResearch needs grounded idea inputs rather than another material list.

Canonical MCP payload shape:

```json
{
  "operation": "innovation_evidence_pack",
  "corpus": "<corpus>",
  "project": "<project>",
  "targetDomain": "<target scientific or engineering domain>",
  "targetProblem": "<research problem>",
  "ideaComponents": ["<optional component for collision audit>"],
  "coverageAreas": ["<optional coverage area override>"],
  "outputDir": "/tmp/papernexus-innovation-evidence"
}
```

Read:

- `evidence_sufficiency`: the direct gate for whether the current material set can support novelty or experiment-planning claims.
- `coverage_matrix`: graph coverage, provider coverage, missing areas, provider failures, required queries, and required imports.
- `composition_collision_matrix`: single component, pairwise combination, and full-combination collision signals.
- `negative_evidence_assessment`: `negative_inconclusive` when provider 429/timeout/error makes absence evidence unreliable.
- `required_followup`: concrete next actions. Run them when approved, or report the missing approvals/blockers.
- `provider_to_import_priority`: provider-only or discovery-only prior papers that need materialization before they count as graph evidence.
- `novelty_baseline`: prior coverage, not novelty proof
- `gap_map`: limitation, missing experiment, claim-evidence mismatch, benchmark failure, or assumption risk
- `closest_prior_map`: collision and overlap risk signals
- `experiment_anchors`: baseline, evaluator, ablation, guard metric, and cost/code signals
- `idea_evidence_cards`: gap/hypothesis/intervention/expected signal/falsifier cards
- `storyline_chains`: status-quo, tension, gap, mechanism, intervention, validation, contribution-boundary, and risk beats
- `evidence_boundaries`: evidence-supported vs Agent-inferred vs speculative material

Do not treat this pack as a final research decision. Use it as AutoResearch input for proposal review, novelty checks, and experiment planning.

Gate rule:

- If `evidence_sufficiency.status` is `insufficient` or `inconclusive`, do not produce a final novelty judgment.
- If `novelty_claim_allowed=false`, write only an open hypothesis or blocker report.
- Continue through `required_followup` when the needed provider/literature/import actions are approved.
- If approval is missing, stop with the exact missing action and why it matters.

### Phase 5: Submit Or Process Imports Only On Explicit Request

By default, `agent_materials` does not submit imports.

When the user explicitly wants resolved full-text sources queued:

```json
{
  "includeLiteratureDiscoveryEvidence": true,
  "submitLiteratureDiscoveryImports": true
}
```

When the user explicitly wants inline import worker processing:

```json
{
  "includeLiteratureDiscoveryEvidence": true,
  "submitLiteratureDiscoveryImports": true,
  "processLiteratureDiscoveryImports": true,
  "literatureDiscoveryImportBatchEnabled": true,
  "literatureDiscoveryImportBatchMaxTasks": 8
}
```

After submission or processing, use `import_workflow queue_progress`, `status`, or `wait`.

Only claim graph visibility when the relevant task reports:

- `status=completed`
- `stage=completed`

MCP/serve workers default logical batching on with `imports.batchEnabled=true` and `batchMaxTasks=8`, so several task ids may complete from one shared graph commit. Continue tracking every task id.

### Phase 6: Preserve Project Memory

Use project overlay operations when a research workflow should resume later.

Operations:

- `paper_role_overlay`: store role judgments such as closest prior, near-source method, far-source story, novelty risk, or baseline candidate
- `evidence_cart`: store useful snippets, tables, figures, source spans, provider snippets, live-discovery spans, or negative evidence
- `workflow_state`: store current hypothesis, accepted/rejected directions, open questions, and needed materials

Keep these as project-local overlay records. They must not mutate the raw corpus graph.

### Phase 7: Re-read After Graph Sync

After imports finish, rerun:

- `paper_material_view` for specific papers
- `research_material_pack` for the project
- graph tools such as `research_lookup`, `research_briefing`, or `idea_catalyst mode=graph`

This distinguishes discovery evidence from graph evidence and refreshes role packs with newly materialized papers.

## Shell Fallback Example

Use the wrapper only when shell execution is needed.

```bash
python3 SKILL/PaperNexus/scripts/pn_agent_materials.py \
  innovation-evidence-pack \
  --corpus "<corpus>" \
  --project "<project>" \
  --target-domain "<target domain>" \
  --target-problem "<research problem>" \
  --idea-component "Absorb" \
  --idea-component "Separate" \
  --idea-component "Buffer" \
  --idea-component "non-identifiable reporting" \
  --constraint "<constraint>" \
  --auto-discover-sources \
  --role target_prior \
  --role near_source_method \
  --role far_source_story \
  --role novelty_risk \
  --role baseline_candidate \
  --role negative_evidence \
  --include-provider-evidence \
  --include-live-discovery-evidence \
  --include-literature-discovery-evidence \
  --literature-discovery-seed-provider-papers \
  --literature-discovery-seed-live-papers \
  --output-dir /tmp/papernexus-innovation-evidence
```

Add these only when import submission is explicitly requested:

```bash
  --submit-literature-discovery-imports \
  --process-literature-discovery-imports \
  --literature-discovery-import-batch-enabled \
  --literature-discovery-import-batch-max-tasks 8
```

## Output Reading Rules

- `provider_evidence` is snippet evidence, not graph evidence.
- `live_discovery_evidence` is source-domain evidence and candidate material, not graph evidence.
- `literature_discovery_evidence` may include resolved sources and importable candidates, but those are not graph-visible until import completion.
- `negative_evidence_pack` records committed-graph misses and optional provider snippet hits; live-discovery evidence is exposed through source/material packs instead.
- `innovation_evidence_pack` compiles idea evidence cards and storyline chains, but still does not prove novelty or experimental success.
- `evidence_sufficiency.status=insufficient` or `inconclusive` means continue approved follow-up research or report a blocker; do not stop at “graph scope did not see it”.
- `provider_only` and `discovery_only` papers must become completed imports before they are treated as committed graph evidence.
- `negative_inconclusive` means provider failures weakened absence evidence and cannot support a novelty claim.
- `import_requisitions` are work items for graph materialization, not proof that the papers are already indexed.
- `paper_role_overlay` and `evidence_cart` are Agent memory, not raw graph facts.

## Do Not

- Do not make provider, live-discovery, literature-discovery, import submission, or import processing implicit.
- Do not collapse target, near-source, and far-source papers into one ranking when the task is a research-material workflow.
- Do not claim novelty from `direct_hit_count=0`; report searched scope, adjacent hits, and limitations.
- Do not claim a submitted or deduped import is graph-synced.
- Do not use GCD-specific source domains as defaults for unrelated fields. Let PaperNexus propose source domains from the target problem and constraints.
