# Paper Identity Model

## Goal

Split “paper identity” from “source artifact identity” so PaperNexus can answer both:

- is this the same paper?
- is this the same fulltext artifact?

without using file paths or upload task ids as paper identity.

## Design

PaperNexus keeps three identity layers:

1. `paperId`
   Existing internal stable graph/snapshot paper primary key.
   This is the current system's durable paper uid and remains stable for backward compatibility.
2. `canonicalId`
   Preferred paper-level identity key.
   This answers “is this the same paper?”
3. `sourceId`
   Preferred source-artifact identity key.
   This answers “is this the same original fulltext artifact?”

## Paper-Level Identity

`canonicalId` selection order:

1. `arxiv:<normalized_arxiv_id>`
2. `doi:<normalized_doi>`
3. `pmid:<normalized_pmid>`
4. `pmcid:<normalized_pmcid>`
5. `title:<normalized_title>`

Paper-level identity is not based on:

- filesystem paths
- upload task ids
- parser cache paths

### Strong vs Provisional Identity

`identityConfidence` is:

- `strong` for `arxiv/doi/pmid/pmcid`
- `provisional` for title fallback

Title fallback is allowed as a last resort, but it must not be treated as equally trustworthy as strong identifiers.

## Identity Aliases

One paper can expose multiple identity aliases at once.

Example:

- `arxiv:2410.11206`
- `doi:10.48550/arxiv.2410.11206`

Paper merge and duplicate detection must use alias overlap, not only the selected `canonicalId`.

Stored fields:

- `identityAliases`
- `canonicalId`
- `canonicalIdSource`
- `identityConfidence`

## Title-Derived Identity

Stored fields:

- `title`
- `normalizedTitle`
- `titleSignature`

`titleSignature` is a stable hash of normalized title text.
It is used for exact-title lookup and migration diagnostics, not as a stronger identity than `normalizedTitle`.

## Source-Level Identity

Each manifest source entry represents one original fulltext artifact.

Stored fields:

- `sourceKey`
  Existing runtime/source-discovery key. Usually path-based. Remains unchanged.
- `sourceKind`
  `pdf` or `markdown`
- `sourceProvider`
  Source origin/provider label. Defaults to `filesystem` unless explicitly provided.
- `contentSha256`
  Hash of the original source artifact bytes
- `normalizedTextSha256`
  Optional hash of normalized parsed fulltext text when available
- `sourceId`
  `<canonicalId>#<sourceKind>#<sourceProvider>#sha256:<content>`

`sourceId` should be null only when content cannot yet be validated.

## Resolution Status

Stored field:

- `resolutionStatus`

Allowed values:

- `fulltext_ready`
- `metadata_only`
- `source_missing`
- `source_invalid`

“Paper has fulltext” means:

- paper-level identity resolved
- at least one source entry with `sourceKind in {pdf, markdown}`
- `resolutionStatus = fulltext_ready`
- source artifact validated

## Persistent Surfaces

The identity envelope is stored on:

- semantic paper snapshots
- manifest source entries
- paper graph nodes
- lite graph node payloads

Import task file metadata may carry a partial identity envelope before graph materialization.

## Migration Rules

Legacy records missing new identity fields are upgraded by derivation:

- derive `normalizedTitle` and `titleSignature` from existing title
- derive strong aliases from `arxivId`, `doi`, `pmid`, `pmcid` when present
- select `canonicalId` from alias priority order
- preserve existing `paperId`
- derive `sourceProvider` from metadata or default to `filesystem`
- compute `contentSha256` when source file exists
- derive `sourceId` only when `contentSha256` is available

Migration is write-through and non-destructive:

- old records continue loading
- new writes persist the upgraded envelope
- no bulk offline migration is required for correctness

## Backward Compatibility

Existing fields remain available:

- `paperId`
- `paperTitle`
- `sourceKey`
- `sourcePath`
- `sourceMarkdownPath`
- `sourcePdfPath`

New identity fields extend rather than replace the legacy API contract.

## Duplicate Handling

Import/task dedupe:

- same uploaded bytes -> same import task

Paper dedupe:

- overlapping strong identity alias -> same paper
- conflicting strong aliases -> different papers
- no strong aliases -> title fallback plus author overlap guard

Source dedupe:

- same `sourceId` -> same artifact
- same `canonicalId` but different `sourceId` -> same paper, different fulltext source
