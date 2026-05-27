# Ingestion Graph Mutation Execution Evidence

`papernexus-ingestion-graph-mutation-execution-v1` records the controlled apply step for ingestion-derived graph mutations.

This is the `R3` evidence lane for the Idea-Catalyst release gate. It proves that P1 claim/citation extraction did not stop at preview artifacts: a release-gated apply plan was reviewed, its benchmark gates passed, an explicit apply was requested, the authoritative graph changed, and rollback evidence exists.

## Command

```bash
npm run ingest:apply-graph-mutations -- \
  --graph-mutations-path artifacts/ingestion/run-001/graph-mutations.json \
  --graph-apply-plan-path artifacts/ingestion/run-001/graph-apply-plan.json \
  --corpus-root /path/to/corpus \
  --output-dir artifacts/ingestion-graph-mutation-execution/run-001 \
  --actor release-operator \
  --apply
```

The executor is dry-run by default. Omit `--apply` for operator review; that produces useful preview evidence, but it cannot satisfy `R3`.

Outputs:

| Artifact | Purpose |
| --- | --- |
| `graph-mutation-execution-report.json` | Full execution report consumed by the release gate. |
| `graph-mutation-execution-report.md` | Human-readable execution summary. |
| `manifest.json` | Compact execution manifest with artifact paths. |
| `rollback-manifest.json` | Rollback instruction manifest. |
| `before-graph-snapshot.json` | Pre-apply graph snapshot, written only for actual apply runs. |

Pass the full execution report into the release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --ingestion-graph-mutation-execution artifacts/ingestion-graph-mutation-execution/run-001/graph-mutation-execution-report.json
```

## R3 Gate Semantics

`R3` passes only when all of the following are true:

- report contract is `papernexus-ingestion-graph-mutation-execution-v1`
- `status: "applied"` and `applyStatus: "applied"`
- `dryRun: false`
- operation count is positive
- apply plan contract is `papernexus-ingestion-graph-apply-plan-v1`
- apply plan is `ready_to_apply` with `canApply: true`
- multimodal asset audit gate passed with at least one projected `MultimodalAsset`: every asset has license scope, evidence hash, explicit source anchor, and at least one figure/table/formula graph link
- claim extraction and citation intent benchmark gates passed
- explicit release-gated apply gate passed
- authoritative graph write was performed
- rollback manifest was required
- before, projected-after, and authoritative-after graph checksums are present
- authoritative checksum differs from the before checksum
- projected and authoritative checksums match
- graph mutation, graph apply plan, citation-intent gold labels, claim-extraction gold labels, and multimodal asset inputs each have role-specific SHA-256 hashes
- provenance is not fixture, synthetic, mock, toy, mini, example, demo, sample, or unit-test evidence

Preview-only, blocked, dry-run, missing-hash, missing role-specific input hash, empty multimodal, or failed claim/citation gate reports remain `incomplete` or `failed` and cannot promote R3.

## Release Boundary

This gate does not create real claim or citation labels. It verifies that the ingestion apply step consumed a release-gated plan whose claim/citation benchmark gates had already passed. The full deep-research alignment still requires real claim/citation gold labels and a real corpus apply run, not only unit-test fixtures.
