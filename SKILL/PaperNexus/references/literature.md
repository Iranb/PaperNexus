# Literature: reuse, select, then read

1. Resolve corpus if unknown. Use `literature_review/status` and `sources` only when coverage/source state matters; do not fetch them before every query.
2. Search committed evidence with `search`. Resolve exact DOI/arXiv identity before downloading or importing another version. Use `paper` with paperId/identifier and a bounded chunkLimit to read selected sources.
3. Use `survey` when grouped roles are useful. Record closest prior, baseline/protocol, method source and negative evidence. Do not confuse automatic role assignment with actual reading.
4. If sources are missing and discovery is in scope, call `discover`, persist runId, inspect `discovery_status` then `discovery_report`. Discovery never imports automatically. Select high-signal sources before an explicit import; a saved-run import submits all its resolved candidates, so prefer individually selected staged paths when only part of a run is wanted.
5. Before graph-dependent follow-up, inspect `import_status` through jobId then taskId/taskIds. Confirm authoritative sync and semantic readiness for semantic relations. If incomplete, use labeled discovery evidence or wait, never fabricate graph evidence.

Keep an incremental ledger: canonical identifier and version, source hash/span, evidence role, protocol, verified claim, missing material and next action. For a baseline/closest prior read methods, evaluation protocol and claim-bearing tables; abstract triage alone is insufficient. Numerical comparisons must name their source and align protocols; otherwise state `paper-report comparison not established`.

Quick questions stop once the bounded question is answered. A deep survey stops when required evidence roles and known objections are covered or limitations are explicitly recorded. Counts of papers and fixed selection percentages are budgets, not proof of coverage. Existing AutoResearch hard gates must still be met or changed by their owning workflow, never bypassed in prose.
