# Paper Identity Migration Plan

## Goal

Upgrade PaperNexus from path-driven paper/source coupling to explicit paper identity and source identity while preserving current graph, import, and API behavior.

## Execution Plan

1. Introduce one shared identity helper that derives:
   - strong paper aliases
   - `canonicalId`
   - `identityConfidence`
   - `normalizedTitle`
   - `titleSignature`
   - `sourceProvider`
   - `sourceId`
2. Thread the identity envelope through:
   - import task file metadata
   - semantic snapshots
   - manifest source entries
   - paper graph nodes
   - lite graph payloads
3. Keep `paperId` as the existing stable internal uid to avoid breaking graph/node references.
4. Change duplicate detection to:
   - alias overlap first
   - alias conflict veto
   - title + author fallback only for provisional identity
5. Add exact lookup APIs over:
   - `canonicalId`
   - aliases
   - `sourceId`
   - exact normalized title
6. Write-through migrate legacy records during normal analyze/import/refresh flows.
7. Add regression coverage for:
   - multi-alias same-paper merge
   - canonical/source identity persistence
   - legacy manifest/snapshot upgrade
   - exact lookup
   - deduped import backfill

## Safety Constraints

- Do not reuse file paths as paper identity.
- Do not treat title fallback as strong identity.
- Do not change existing `paperId` values for already-indexed papers.
- Do not require a one-shot offline migration.

## Verification

Run focused tests covering:

- import store
- import API
- query API
- MCP lookup
- python wrappers
- legacy snapshot/manifest upgrade paths
