# Docs Sync Release Evidence

`papernexus-docs-sync-release-evidence-v1` turns the deep-research completion requirement for synchronized docs, schema snapshots, packet fixtures, and migration notes into a release-gate artifact.

## Command

```bash
npm run eval:docs-sync-release-evidence -- \
  --output-dir artifacts/docs-sync-release-evidence/run-001 \
  --run-id docs-sync-run-001 \
  --require-passed
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `docs-sync-release-evidence.json` | Machine-readable D1 evidence report. |
| `docs-sync-release-evidence.md` | Human-readable check summary. |
| `manifest.json` | Compact status and artifact pointer. |

## Required Checks

| ID | Coverage |
| --- | --- |
| `docs_build` | Runs `npm run docs:build`, including generated reference refresh. |
| `mcp_schema_snapshot` | Runs `node --test test/mcp-schema-snapshot.test.js`. |
| `packet_fixture_drift` | Runs Idea-Catalyst packet/live/schema focused tests. |
| `migration_notes_present` | Checks `docs/eval/idea-catalyst-v2-migration-notes.md` exists and is non-empty. |

The report also records SHA-256 hashes for the relevant docs, generated reference files, MCP schema snapshot, packet tests, and migration notes. Missing hashes keep the report `incomplete`.

The CLI records those required input hashes twice: before running the checks and after they finish. If `npm run docs:build` or a snapshot/fixture check rewrites any required synced input, the report fails with `docs_sync_inputs_changed_during_checks`. That makes D1 a stability check, not just a final hash manifest.

## Release Gate

Pass the full report to the Idea-Catalyst release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --docs-sync-evidence artifacts/docs-sync-release-evidence/run-001/docs-sync-release-evidence.json
```

The release gate exposes this as `D1`. It fails or remains incomplete when the docs evidence is missing, uses an unsupported contract version, lacks required checks, has failed checks, omits required input hashes, or reports that synced docs/schema/fixture inputs changed during the checks. A standalone `npm run docs:build` pass is useful but is not release evidence by itself.
