# Research pipeline contracts and migration

PaperNexus supplies literature and source evidence. The calling research agent owns hypotheses and scientific judgment; AutoResearch retains experiment and project-state authority. A committed proposal is not a novelty certificate or a measured improvement.

## Three research tools

Deploy the complete application version and reconnect the MCP client. The default `research` profile advertises `literature_review`, `lineage_analysis`, `idea_generation`. Existing legacy names remain callable; clients needing their schemas can use `legacy` or `all`. `literature_review` with `operation=capabilities` reports actual workflow operations, contract version, presentation modes and advanced proposal requirements without reading a corpus or using the network.

An older server advertising only 23 tools does not implement these new routes. Detect operations from the server, not from locally installed skill text. Never rely on unknown fields being accepted by a legacy tool.

## Material admission

All material contexts use the same non-mutating research-quality graph projection as regular research reads. Direct reads of quarantined sources return `paper.status=quarantined`, `paper.source_admission.eligible=false`, reasons and no active research material or graph context. Project overlay roles cannot promote those records into role-grouped material evidence. Version aliases resolve to the canonical paper while retaining source access. Raw corpus files remain untouched.

`in_graph`, source eligibility, publication verification, authoritative synchronization and semantic readiness are different facts. `source_admission.eligible=true` is not bibliographic verification. A missing source remains missing, not quarantined. Correcting the authoritative source/identity and rebuilding through the existing authorized maintenance workflow can restore admission.

Material context reuse is scoped to one read-only pack request. There is no persistent result cache to outlive a corpus or quality revision. Import-enabled material operations do not enable that request cache.

## Bounded presentation

The three research tools accept `responseMode=full|summary`, default `full` for compatibility. Summary is an opt-in preview with a 32 KiB UTF-8 budget for the pretty-printed workflow JSON envelope. MCP transport framing and escaping add bytes outside this envelope. It preserves small root admission/sufficiency gates, records the full-result size/hash, identifies omissions and supplies full-read instructions. It does not reduce the evidence retrieval computation or certify a complete review.

Null or omitted evidence is unknown. The caller must not infer permission from a truncated gate or missing risk. Use exact `paper`, `evidence` and source spans for claim-bearing details. Read `presentation.read_more`; do not replay a discovery/import submission just to obtain full output—read its saved report/status instead. Responses with mutable timestamps can have different hashes between calls; the digest identifies the exact response content, not a stable corpus snapshot.

## Proposal actions

`agent_materials/proposal_graph_session` accepts caller-supplied `proposalActions` or `proposalSlates`. A request containing only problem/evidenceRefs returns `final_status=diagnosis`, `input_status=needs_actions`, `round_count=0` and required inputs. It makes no model call or artifact write. The existing action validation/commit path remains available.

The caller constructs grounded candidate actions, then the service validates structure, risks and evaluation readiness. See [the action guide](../../SKILL/PaperNexus/references/advanced.md). Do not repeatedly run the proposal validator, research_controller and an ideation panel as three redundant generators. A connected, committed graph still needs independent source-backed semantic review.

Keyword collision only flags a candidate prior. Respect `mechanism_collision_audit.semantic_equivalence_checked=false` and `novelty_claim_allowed=false` even if other coverage fields are sufficient. Compare precise assumptions, interventions and predicted effects before judging novelty.

## Skills and project handoff

The primary entrypoints are [research](../../SKILL/PaperNexus/SKILL.md), [ingestion and maintenance](../../SKILL/PaperNexusMaintenance/SKILL.md) and [reflection](../../SKILL/PaperNexusReflection/SKILL.md). Old skill names and script paths remain forwarding compatibility entrypoints. Stage details and remote rules are loaded on demand.

[AutoResearch adaptation](../../SKILL/PaperNexus/references/autoresearch-adapter.md) explains evidence reuse and state ownership. Quick standalone questions do not initialize a full project. Deep selected ideas retain the project's reading, breadth, protocol and evidence gates; this migration does not replace their validators.

## Acceptance and rollback

Run material-quality-admission, research-pipeline-contract, existing MCP workflow and proposal-controller tests, then the full Node suite. Fixed synthetic fixtures must show normal sources still usable, quarantined sources excluded even via project overlays, versions resolvable, denial gates retained and valid proposal actions still committed. No scientific productivity claim follows from smaller schemas alone.

Before deployment archive affected application files and record raw graph hashes. Stage and test the candidate application with existing dependencies and isolated test corpora. Keep config, credentials and real corpus files outside the application archive. On failed health/MCP/admission checks restore the previous application and restart via the existing service script. Restore locally installed skill backups independently if needed.
