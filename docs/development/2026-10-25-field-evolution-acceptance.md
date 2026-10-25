# Field evolution map acceptance

Date: 2026-10-25. Branch: `codex/field-evolution-atlas`. Baseline: `ea70833973108a485581cd44030faa14abd0b162`.

The browser now presents papers and methods on a dated, interactive evolution map. Users can focus on a connected family, trace a structural mainline, inspect branching and convergence, open source quotes and locations, filter years, and export SVG or the full analysis JSON. HTTP and MCP use the same admitted research evidence.

## Verification

| Check | Result | Behavior covered |
| --- | --- | --- |
| Related automated regression suite | 94 passed, 0 failed | Field model, HTTP/MCP consistency, source admission, method evidence, workflow contracts, schema snapshots and HTTP authentication |
| Final view tests | 4 passed, 0 failed | Timeline geometry, undated material, readable fitted layout, family scope, evidence details, text escaping and source links |
| Real Chromium browser acceptance | 10 passed, 0 failed | Topic/domain selection, paper/method switching, source quotes and span IDs, convergence, family and keyboard navigation, SVG/JSON downloads, year filtering, empty results, pending corpus loads, stale responses and the existing topic view |
| Documentation site | Build passed | Generated interface references and the new operations page with sidebar navigation |

The regression command was:

```bash
node --test test/field-evolution.test.js test/field-evolution-api.test.js test/field-evolution-view.test.js test/topic-analysis.test.js test/method-evolution-overlay.test.js test/method-evolution-validator.test.js test/research-intelligence.test.js test/research-workflow-views.test.js test/mcp-research-workflows.test.js test/mcp-schema-snapshot.test.js test/mcp-research-workflow-boundaries.test.js test/research-quality.test.js test/research-pipeline-contract.test.js test/mcp-http.test.js test/http-auth.test.js
```

After the final browser integration and timeline label changes:

```bash
node --test test/field-evolution-view.test.js
node scripts/verify-field-evolution-browser.mjs /tmp/papernexus-field-acceptance-final
npm run docs:build
```

The browser report records no page script errors. The fixture includes two connected families, a long lineage, branching, convergence, replacement, a component relation, boundary context and undated material. The selected view contains 17 methods. The server uses temporary corpora and an isolated registry, with background workers disabled; both are removed when the browser check finishes.

Saved browser evidence is under:

```text
/Users/iranb/.codex/visualizations/2026/10/25/01a171d8-38ed-79a3-8475-497530e3f10d/field-evolution/
```

`papers.png`, `evidence.png` and `narrow.png` show the timeline, source details and narrow viewport. `report.json` lists the ten behavior checks. `filtered-map.svg` and `analysis.json` are the verified downloads.

## Review and change scope

The implementation preserves source-quality filtering and the existing method-edge validator. It merges duplicate citation/DAG projections, normalizes predecessor-to-successor direction, rejects reverse dated relations, and derives families and mainlines only from the displayed validated graph. A cyclic family has no mainline. Paper projection uses explicit citing/cited ownership or a unique association, without generating Cartesian pairs. Diagnostics expose evidence rejection, missing dates, ambiguous paper projection and display limits.

GitNexus upstream analysis flagged the shared method evidence function as HIGH, with five upstream symbols and two MCP execution flows. The function body remains unchanged; the only modification is an export used by the new analyzer. Existing entry points had LOW reported risk. Browser closures and the documentation sidebar require source-call inspection because the index does not report every such dependency. The final view integration affects only the evolution map, corpus switching and return to the existing graph.

The feature adds no production dependency or stored graph state. The implementation is confined to the new analysis and view, their HTTP/MCP integration, focused tests, browser verification and documentation. Commit-time GitNexus change analysis reports 30 files, 319 symbols including documentation headings, and eight affected execution flows. All reported flows belong to research lookup, corpus reading or result presentation. The aggregate risk is HIGH; the staged diff and the related tests cover these expected integrations. The local merge is recorded in the ExecPlan.

## Limitations

The fixture verifies software behavior, not literature completeness or the historical accuracy of a real field. Selection is lexical and metadata based; missing papers, aliases, domain labels or relation evidence limit the map. Families and longest paths describe graph structure, not recognized schools or scientific influence. Turning points are candidates grounded in structure or reported relations.

Only the listed related regression suite was run, not every repository test. The documentation build emits a non-blocking warning that some minified chunks exceed 500 kB. No remote service or production corpus was changed, and no remote deployment was tested.
