# Field research acceptance

Date: 2026-10-25. Feature branch: `codex/field-evolution-research`. Local `main` contains implementation `496f3f5` and integration `dd2bbc8`.

The browser's **Research and build map** runs bounded literature discovery, missing-paper import, configured relation extraction, graph synchronization and field evolution analysis. **Map existing corpus** remains a committed-evidence read. HTTP and MCP use the same durable coordination service.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Discovery, import, worker, synchronization, HTTP/MCP and field regression suite | 195 passed, 0 failed | `test/field-research.test.js`, `test/field-research-api.test.js` and existing pipeline suites |
| Research browser acceptance | 8 passed, 0 page errors | `scripts/verify-field-research-browser.mjs` |
| Existing map browser regression | 10 passed, 0 page errors | `scripts/verify-field-evolution-browser.mjs` |
| Documentation | Build passed | `npm run docs:build` |
| Integration with project research feedback | 46 passed, 0 failed | Shared MCP workflows, field research and research feedback suites |

The research browser check covers a lost submission response followed by replay of the same request key, one real import task, refresh recovery through status reads, admission of newly imported papers with different domain metadata, missing full-text coverage, JSON export, explicit resume and corpus changes and explicit server failure.

Core tests verify chronology-aware selection in the actual discovery workflow, reliable paper identity, exact import-task state, semantic and synchronization boundaries, durable request conflicts and reuse of saved discovery reports during recovery. A missing report yields `needs_attention` and cannot report terminal success. Existing import-worker and synchronization tests exercise the reused execution pipeline.

The integrated MCP dispatcher supports field research and project evaluation. The measured replay fixture includes every source declared in its source map, including `BEFORE_GRAPH.md`.

## Artifacts

The ExecPlan and its reviewed contracts are in `.agent/plans/2026-10-25-field-evolution-research.md` and `.agent/plans/2026-10-25-field-evolution-research-review.md`. Usage and API examples are in [field evolution](../operations/field-evolution.md).

Local browser artifacts are saved under `/Users/iranb/.codex/visualizations/2026/10/25/01a171d8-38ed-79a3-8475-497530e3f10d/field-research`: `research-map.png`, `progress.png`, `research-map.json`, `acceptance.json`, and `readonly-regression/`. The screenshots and export contain fictional acceptance data.

## Limitations

Provider responses are offline fixtures. The browser uses real authentication, HTTP routing, import submission and status storage, but task completion and graph publication are supplied fixtures. This acceptance run did not execute a production import or a paid extraction model. External availability, credentials, configured extraction and paper coverage determine live results.

The paper budget is a candidate limit, not a guarantee of successful full-text imports. Chronological selection improves temporal coverage but cannot establish a complete field survey. Missing dates remain unknown. Source-backed method relations determine evolution arrows; search metadata and ordinary citations alone cannot create them.
