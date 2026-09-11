# Research workflow integration review

Reviewed on 2026-09-11 against `main` at `d3d0018`, including the existing `2e567c6` ingestion/innovation change and the subsequent topic workflow, PDF runtime and MCP changes.

## Resulting behavior

The default MCP catalog exposes three research tasks: literature review, lineage analysis and idea generation. Original tool names remain callable, and the `legacy` profile restores the original advertised catalog. Topic analysis returns a bounded evidence graph with method-condition checks; parser runtimes use recorded releases and separate environments.

Source discovery, import submission and authoritative graph synchronization retain distinct states. Read-only research operations reject hidden provider/writeback controls. Generated mechanisms, graph paths and bounded gaps do not establish novelty, causality or experimental gains.

## Findings resolved before merge

| Priority | Finding | Resolution and regression |
| --- | --- | --- |
| P2 | The new default lineage tool omitted structured constraints, making existing method compatibility checks unreachable through that entry point. | `overview` and `problem` now accept bounded primitive conditions. A real graph test confirms that `labelsAvailable=false` excludes methods requiring labels and preserves graph bytes. Material queries still accept text conditions only. |
| P2 | Linux secret retrieval accepted an injected command runner but bypassed it during tool discovery and retrieval. | Secret Service and `pass` reads now consistently use the provided runner. Tests verify command routing and the missing-tool result without accessing a real keyring. |
| P2 | The CLI credential test provided only a macOS `security` stub, so Linux used a different storage backend. | The test also supplies a temporary `secret-tool` implementation and verifies the actual stored fixture secret. |
| P2 | Two fake Docling integration fixtures inherited automatic GPU scheduling and could wait for real GPU availability. | Both fixtures explicitly select CPU and disable GPU scheduling and model preloading. Their parser contract assertions remain enabled. |
| P2 | Generated source links, the documentation GitHub link and the CLI clone hint pointed to an unavailable repository namespace. | Defaults now point to `Iranb/PaperNexus`; generated references are rebuilt and the explicit source-link override remains available. |

## Validation

Runtime validation uses an isolated Linux environment with Node 22.16.0, temporary corpora, mocked network providers and isolated credential stores. The first full run found the two credential failures; focused execution reproduced the missing lineage constraint field. A subsequent bounded run exposed the hardware-dependent fixtures. These failures were investigated rather than removed from the suite.

The final full run passed **1012 tests**, with **zero failures or cancellations**. Two opt-in fast-Markdown throughput benchmarks were skipped because `PAPERNEXUS_THROUGHPUT_TEST` was not enabled. The focused CPU/credential CLI checks passed 2/2. `npm ci` and the complete VitePress documentation build passed; VitePress reported a non-fatal large-bundle warning.

Commands:

```sh
node --test --test-timeout=120000 test/*.test.js
npm ci --no-audit --no-fund
PAPERNEXUS_DOCS_BASE=/PaperNexus/ npm run docs:build
git diff --check
```

The dependency installation and VitePress build use a separate checkout; they do not modify a serving installation's dependencies. Parser package installation and real conversion evidence from the preceding parser review remain separately described in the [parser runtime guide](../pipeline/pdf-parsers-and-runtime.md).

## Compatibility and deployment

The new catalog deliberately changes tool discovery. Use `PAPERNEXUS_MCP_TOOL_PROFILE=legacy` or `serve.mcp.toolProfile=legacy` when a client needs the old listing, then reconnect. See the [MCP migration guide](../interfaces/mcp-three-workflows.md) for operation mappings and state boundaries.

Merging source does not deploy a running PaperNexus MCP service or switch its Python runtimes. The repository includes a main-branch documentation publishing workflow. Its previous run built the documentation successfully but failed at `Setup Pages`; the repository Pages API currently returns 404. Enabling GitHub Pages is a separate repository configuration action. No production corpus rebuild or service restart is part of this integration.
