---
name: papernexus-precise-paper-index
description: Use when an agent needs exact PaperNexus paper lookup by canonicalId, sourceId, DOI, arXiv ID, PMID, PMCID, ISBN, ISSN, paperId, sourceKey, source path, or exact title before upload, dedupe checks, or identifier backfill.
---

# PaperNexus Precise Paper Index

Use this skill when fuzzy graph search is not good enough and the task needs exact paper resolution.

Preferred remote MCP surface:

- `research_lookup` with `operation="paper_index"`

Exact selectors supported:

- `canonicalId`
- `sourceId`
- `doi`
- `arxivId`
- `pmid`
- `pmcid`
- `isbn`
- `issn`
- `paperId`
- `sourceKey`
- `source`
- `paperTitle`

Use this before:

- uploading a paper that might already exist in the corpus
- checking whether an old paper is missing DOI / arXiv / PMID / PMCID metadata
- deciding whether a new upload should backfill identifiers onto an existing canonical paper

Shell fallback:

```bash
python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py \
  --corpus "<corpus>" \
  --doi "10.48550/arXiv.2401.12345" \
  --json

python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py \
  --corpus "<corpus>" \
  --arxiv-id "2401.12345" \
  --json

python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py \
  --corpus "<corpus>" \
  --canonical-id "arxiv:2401.12345" \
  --json

python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py \
  --corpus "<corpus>" \
  --paper-title "Attention Is All You Need" \
  --json
```

Response contract highlights:

- `result.contractVersion = "paper-precise-index-v1"`
- `result.query` returns the normalized exact selectors that were applied
- `result.matches` is grouped by canonical paper
- each match includes merged `identifiers`, `identifierKeys`, and its contributing `sources`

Rules:

- prefer `canonicalId` and `sourceId` when you already have them
- otherwise prefer DOI / arXiv / PMID / PMCID over exact title
- treat ISBN / ISSN as auxiliary bibliographic metadata unless the object is actually a book or serial container record
- paper-level identity is strongest with DOI / arXiv / PMID / PMCID
- `canonicalId` answers “is this the same paper?”
- `sourceId` answers “is this the same fulltext artifact?”
- treat `matchCount = 0` as “safe to upload”, not as a fuzzy-search failure
- when `matchCount > 0`, inspect `matches[*].sources[*].activeInGraph` and `canonicalSourceKey`
- if a match exists but identifiers are incomplete, update/backfill metadata instead of creating a second logical paper
