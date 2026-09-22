---
name: papernexus-ingest-maintain
description: Stage and import papers, track asynchronous graph readiness, or repair and refresh an existing PaperNexus corpus. Use for explicit ingestion and maintenance work.
---

# PaperNexus Ingest and Maintain

Read [the shared remote contract](../PaperNexus/references/remote-contract.md). Research questions alone do not require maintenance. Inspect the actual MCP tool schema before choosing an operation.

For discovered sources use explicit literature_review/import after selecting papers; poll import_status by jobId then taskId/taskIds. A saved discovery run imports all resolved sources from that run. Prefer selected file submissions if only a subset is wanted.

For local files use canonical `SKILL/PaperNexus/scripts/pn_import_submit.py --source <local-file>` or `pn_batch_import.py --manifest <manifest> submit` to stage before remote submit. For two or more files use the manifest/batch workflow; `pn_batch_import.py template` generates the current schema. Every paper needs a precise DOI/arXiv/PMID/PMCID identity. Never use a local workstation path as serverFilePath. Existing specialized wrapper paths remain compatible.

Store the manifest, task IDs and idempotency keys. `pn_batch_import.py ... status` and `SKILL/PaperNexus/scripts/pn_import_queue.py` read actual queue state. Submission, completed parsing, authoritative sync and semantic readiness are separate. Do not infer completion from elapsed time. Reconcile timeout-ambiguous state before retrying submission.

For existing one-paper or duplicate-group repair, use advertised refresh_paper_graph. For authorized corpus maintenance, use refresh_corpus: materialize updates snapshots only; llm_optimize updates semantic snapshots; analyze and optimize perform their documented commit phases. Match the requested scope; do not force a full reprocess for a small read problem.

Before a write: identify affected sources, reuse existing authorization, use supported dry-run/staging, preserve audit logs and a rollback point. Do not delete or mark internal identities as fake merely because source review is required. Graph quality quarantine is reversible and leaves raw sources intact.

Legacy advanced import/refresh operations remain available on supported profiles. Do not pass their hidden options through the strict three-tool schema. Status/read calls never authorize new provider spend or training.
