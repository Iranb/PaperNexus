# Idea-Catalyst V2 Migration Notes

These notes track the release-relevant contract changes introduced for the deep-research alignment work. They are intentionally part of the docs-sync release evidence so schema, snapshots, packet fixtures, and migration guidance cannot drift silently.

## Compatibility Boundary

The v1 Idea-Catalyst packet fields remain readable. V2 adds evidence-bearing artifacts rather than replacing the legacy bundle shape:

| Artifact | Purpose |
| --- | --- |
| `must_cite_set` | Prior-art and baseline obligations used by must-cite retrieval gates. |
| `contribution_claims` | Claim-level proposal statements with source-span provenance. |
| `novelty_certificate` | Multi-axis novelty, significance, feasibility, grounding, and temporal-validity evidence. |
| `review_packet` | Reviewer-facing concerns, rebuttal hooks, and source-backed critique material. |
| `storyline_dag` | Traceable story beats linking claims, evidence, and remaining challenges. |
| `counterfactuals` | Bounded failure and alternative-hypothesis plans. |

Callers should treat missing v2 artifacts as incomplete release evidence, not as a hard runtime failure, unless they are running a release gate.

## Invariant Hardening

The v2 invariant harness is intentionally stricter for source-backed packets:

- `source_backed` evidence exports must carry auditable source evidence. Each `source_spans` and `supporting_papers` record needs a `license_scope` plus an audit hash such as `evidence_hash` or `sha256`; evidence export builders now also add `source_anchor`.
- `source_backed` contribution claims now require `source_span_ids` that resolve to source evidence records in the same packet, such as `source_spans[].span_id`, `evidence_spans[].span_id`, citation contexts, or supporting-paper snippet ids. A stale or orphaned span id is treated as an ungrounded claim.
- `must_cite_set` entries still need `citation_id` plus `title` or `paper_key`. When the surrounding packet is `evidence_status: "source_backed"`, each entry also needs span or citation-context evidence such as `evidence_span_ids`, `source_span_ids`, or `citation_context_ids`; explicit ids must resolve to source evidence records in the same packet, or to embedded evidence records on the entry.
- `novelty_certificate.reasons` must be non-empty, textual, and cover every score axis: `novelty`, `significance`, `feasibility`, `grounding`, `must_cite_completeness`, and `temporal_validity`. Structured reason entries should carry an `axis` field; legacy string reasons are only accepted when the combined text explicitly names every required axis. Bounded scores with generic reasons are not enough for release evidence.
- `review_packet` must include the four report-required reviewer roles (`novelty`, `methods`, `reproducibility`, `outsider`), a `meta_review` recommendation or decision, and structured `major_concerns` entries with concern id, reviewer role, severity, concern text, and explicit `addressed` state. Each concern's reviewer role must resolve to the reviewer panel, and any reviewer-level `concerns` refs must resolve to `major_concerns` in the same packet. Any non-empty `affected_claim_ids` on a concern must resolve to `contribution_claims` in the same packet. Any contribution claim without `source_span_ids` must be covered by an unresolved concern, so a review packet cannot silently mark ungrounded claims as reviewed. If an unresolved concern has `severity: "major"`, the meta-review recommendation must be blocking, such as `major_revision`, `reject`, `blocked`, or `not_ready`.
- `storyline_dag` beats may only count as traceable when they link to claim, challenge, takeaway, or review-concern references, and those references must resolve to records in the same packet. Paper-only, artifact-only, stale-id, or object-stringified trace refs are intentionally rejected.
- V2 graph writeback preserves source-span audit fields on persisted `EvidenceSnippet` nodes (`licenseScope`, `evidenceHash`, `sourceAnchor`) and blocks default writeback when a claim references a `source_span_id` that is not present in the artifact source-span records. Use weak-evidence override only for non-release debugging.
- V2 graph writeback now treats the review packet as graph evidence, not just JSON decoration. Default writeback requires the full reviewer panel plus `meta_review`, persists reviewers and the meta-review as `ReviewAspect` nodes, persists major concerns as `ReviewConcern` nodes, and links reviewer aspects to affected claims when the concern references a claim. Writeback also rejects reviewer concern refs that do not resolve to same-packet concerns, concern reviewer roles outside the panel, affected-claim refs outside same-packet contribution claims, and non-blocking meta-review decisions when unresolved major concerns remain.
- V2 graph writeback now persists the novelty certificate as a `NoveltyClaim` node linked to the artifact and writeback provenance. Default writeback requires all six bounded novelty-certificate scores, textual reasons for every score axis, finite zero future leakage, and positive temporal validity before contribution claims can enter the graph. Persisted `NoveltyClaim` nodes retain both flattened `reasons` and structured `reasonAxes` / `axisReasons`, so downstream graph consumers can audit which score dimension each rationale supports. New packets should emit structured `{ axis, reason }` entries.

## Required Sync Points

When changing the v2 contract, update these together:

| Area | Required update |
| --- | --- |
| MCP schema | Update `test/fixtures/mcp-tools-schema.snapshot.json` only after reviewing `docs/interfaces/mcp-skill-contracts.md`. |
| Packet fixtures | Re-run packet/schema focused tests and update fixtures only when the new shape is intentional. |
| Generated docs | Run `npm run docs:build`, which refreshes generated reference pages before VitePress builds. |
| Release gate | Update `docs/eval/idea-catalyst-release-gate.md` and the release-gate requirement mapping if a new evidence class is required. |
| Migration notes | Update this file with compatibility or operator-facing changes. |

## Release Evidence

The docs-sync release evidence contract is `papernexus-docs-sync-release-evidence-v1`. A release candidate needs a passed report from:

```bash
npm run eval:docs-sync-release-evidence -- \
  --output-dir artifacts/docs-sync-release-evidence/run-001 \
  --run-id docs-sync-run-001 \
  --require-passed
```

The report must include:

- `docs_build`
- `mcp_schema_snapshot`
- `packet_fixture_drift`
- `migration_notes_present`

Each check records command status, duration, output tails, and hashes for the required docs, schema snapshots, packet tests, and migration notes. The Idea-Catalyst release gate consumes this report as `D1`; a green docs build alone is not enough.
