# HTTP Serve Reference

This page is generated from route declarations in [`src/server/http.js`](https://github.com/papernexus/PaperNexus/blob/main/src/server/http.js). It focuses on the authenticated HTTP server rather than the preferred remote MCP control plane.

## Routes

| Method | Path |
| --- | --- |
| `GET` | `/api/health` |
| `GET` | `/api/corpora` |
| `GET` | `/api/corpus` |
| `GET` | `/api/corpus-meta` |
| `GET` | `/api/corpus-sources` |
| `GET` | `/api/method-registry` |
| `GET` | `/api/enhancements` |
| `GET` | `/api/imports` |
| `POST` | `/api/imports` |
| `POST` | `/api/paper-index` |
| `POST` | `/api/query` |
| `POST` | `/api/context` |
| `POST` | `/api/impact` |
| `POST` | `/api/ideas` |
| `POST` | `/api/brainstorm` |
| `POST` | `/api/catalyst` |
| `POST` | `/api/idea-catalyst-v2` |
| `POST` | `/api/novelty-eval` |
| `POST` | `/api/storyline` |
| `POST` | `/api/reviewer-simulate` |
| `POST` | `/api/path-trace` |
| `POST` | `/api/evidence-chain` |
| `POST` | `/api/method-lineage` |
| `POST` | `/api/method-evidence` |
| `POST` | `/api/reflection-chain` |
| `POST` | `/api/theory-brief` |
| `POST` | `/api/storyline-brief` |
| `POST` | `/api/research-brief` |
| `POST` | `/api/brainstorm-brief` |
| `GET` | `/api/paper-enhancement` |
| `POST` | `/api/backup` |
| `GET` | `/api/llm-config` |
| `POST` | `/api/llm-config` |

## Notes

- All `/api/*` routes require the configured bearer token.
- Live graph automation should prefer the remote HTTP MCP surface at `/mcp` even when these routes exist.
