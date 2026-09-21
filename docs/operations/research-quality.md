# Research graph quality

PaperNexus preserves the authoritative corpus and builds a conservative research view for the web graph, HTTP/MCP research APIs, and CLI `query`, `context`, `impact`, `ideas`, `brainstorm`, `answer`, and `catalyst`. No source files or historical snapshots are deleted.

## Admission and identity

- Full HTML documents and recognizable access/error pages are rejected before Markdown parsing. HTML tables and code examples inside real Markdown remain supported.
- Placeholder and HTML titles are invalid. Existing records with those titles are isolated pending source recovery.
- arXiv identity uses the base identifier. Versions remain in source identifiers and aliases; merges retain the highest observed version and aliases. Different public identifiers remain a conflict, never a fuzzy title merge.
- Explicit test sources, self-declared throughput fixtures, and internal `10.48550/papernexus.*` identities without independent arXiv/PMID/PMCID identity are excluded. An internal identifier does **not** mean a document is fake: it requires source review. Eligible sources are not automatically certified as verified publications.

## Limitation evidence

A limitation needs a stated failure, dependency, scope boundary, or missing validation. “However”, “only”, or “drop” alone are insufficient. Extraction prompts request verbatim evidence; deterministic admission applies to heuristic and LLM outputs:

- Explicit boundaries remain limitations, including sentences with both benefits and failures.
- Positive results without a boundary become findings.
- Captions and ambiguous records enter `semanticQualityReview` and are omitted from active limitation analysis.

The runtime view also applies this check to old nodes, retaining review decisions and original provenance. Reclassified findings lose invalid constraint edges. This conservative lexical check is not a substitute for human semantic review or verification of source attribution.

## Existing corpus audit

Duplicates are coalesced on strong identities, never titles alone. The representative retains `paperVersions`; affected records/relations retain original paper IDs and endpoints. Shared nodes supported by eligible papers remain. Excluded papers, nodes supported only by those papers, and their relations are isolated. Cached corpus overlays referencing the raw graph are invalidated.

Graph and metadata API responses expose `quality`: isolated IDs and reasons, version groups, limitation decisions and effective counts. `meta.rawPaperCount` preserves the original metadata count; `meta.paperCount` counts the research view. Registry counts still describe stored sources.

Generate a report and standalone view without modifying the corpus:

```sh
node scripts/audit-research-quality.mjs \
  --input /path/to/corpus/.papernexus/graph.lite.json \
  --output /path/to/new-audit-directory
```

The output directory must not exist. `report.json` records decisions; `research-graph.json` contains the view with rebuilt indexes. No LLM jobs or source downloads run. Keep audit output outside import directories. Uncertain records require verified source recovery, not bulk deletion.

## Rollback

Back up application files before deployment. Restoring the previous code restores prior research behavior because the underlying corpus remains unchanged. Raw files and snapshots retain evidence for manual review and recovery.
