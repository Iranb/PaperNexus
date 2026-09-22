# Shared remote contract

Prefer the configured remote HTTP MCP named `papernexus-remote`. Never embed secrets, server addresses or guessed filesystem roots in task prompts. Keep configured, reachable and callable separate; only a successful tool call proves that tool works. If the active client cannot mount tools, report that layer; a configured shell MCP wrapper can be used when the user has authorized that execution path. Do not silently replace a remote corpus with a local graph or another host.

`tools/list` owns advertised capabilities. New research servers support `literature_review/capabilities`; older servers require reading actual operation enums. The `research` profile advertises three tools, `legacy` the old surface, `all` both. Old direct calls remain supported on new servers, but clients may require advertised schemas; reconnect after profile/deployment changes. Do not probe capabilities by attempting a write.

Use `responseMode=summary` only when supported. It limits the presentation to 32 KiB of pretty JSON, preserves root admission/coverage gates, and records omissions and full-read instructions. It does not guarantee fewer backend computations or contain the full evidence set. Repeat a read with `full`, then select exact papers/spans for claim review. Never replay discovery/import merely to get a fuller result; use its status/report operation and saved runId/jobId/taskId.

The canonical Python `pn_common.py` handles JSON-RPC and configured token resolution. Do not print or persist token values. Server-owned paths should retain returned `~/...` forms; do not replace them with guessed `/home/...`. A local `/Users/...` file must be staged before it is a remote serverFilePath.

For async work retain runId, jobId, taskId, idempotency key and status authority. Submission timeout means unknown_after_timeout: reconcile existing remote jobs before retrying. Discovery completion, import acceptance, graph visibility, authoritative sync and semantic readiness are distinct. Reuse existing authorization in scope; request new approval only for an unapproved side effect. Do not use a canned approval_required hint to ask again for already authorized work.
