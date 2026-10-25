# Explore a field's evolution

The evolution map connects papers through source-backed method relations. It shows a timeline, connected method families, structural mainlines and turning-point candidates. Each arrow opens the source quote and the recorded bottleneck, mechanism and tradeoff.

## Open the map

Select a corpus in the browser. Enter a **Topic**, a **Target domain**, or both, then choose **Build evolution map**. The optional year range limits the displayed history. **Coverage** controls traversal depth and the node budget.

Use **Papers** to follow the articles and **Methods** to inspect the mechanisms they connect. Arrows point from predecessor to successor. Paper arrows are projections of method evolution evidence, not ordinary citations. The family selector focuses on one connected set of methods; a paper associated with several families remains available in each of them.

Orange paths mark a structural mainline. Orange dots mark turning-point candidates. Select a node or arrow to open its evidence. **Clear selection** restores the family and turning-point navigator. **Find** highlights titles without hiding their context. Scroll across years, use the zoom controls, or choose **Fit** for an overview. Nodes and arrows also support keyboard focus and Enter or Space.

**SVG** downloads the current map, including the selected family and highlights. **JSON** downloads the full analysis and the current view settings. **Back to graph** returns to the existing knowledge graph and topic analysis.

## Scope and interpretation

Selection scans the eligible corpus rather than the ordinary search preview. All non-stopword query terms must match the paper's title, abstract, keywords or associated method/problem text. Short terms such as ML are retained; Chinese terms use normalized text matching. A target domain matches recorded domain labels without case sensitivity. When both selectors are present, both must match. This is lexical and metadata selection, so synonyms and missing domain labels can affect coverage.

Related methods can be added through validated evolution relations up to the requested depth. Dashed nodes are boundary context outside the core topic/domain selection. The year range applies to displayed papers and methods. Missing dates appear in a separate **Undated** column.

Each view has a node budget of 180 by default, up to 500, and an edge budget of 350 by default, up to 1,000. Core matches precede boundary context; otherwise selection is ordered by year and stable ID. **Coverage and evidence limits** reports matched, available and displayed counts, reached limits, excluded sources, missing dates and missing paper projections. A full display does not establish that the corpus covers the entire field.

Families are connected components of the displayed method graph, not automatically recognized academic schools. A mainline is the longest validated path in an acyclic family; equal-length paths use stable IDs to break ties. It is not an influence ranking. Cyclic families retain their relations and receive no mainline. A branch has at least two distinct successors; convergence has at least two distinct predecessors. Replacement and adaptation candidates come from the recorded source relation. These are prompts for historical interpretation, not proof of a scientific breakthrough or causal development.

Paper projection uses the relation's explicit citing/cited papers or an unambiguous endpoint association. It does not connect every possible pair when a method belongs to several papers. Within-paper method relations remain available in the method view. Ordinary citations, unvalidated candidates and rejected relations do not become evolution arrows. A missing arrow is a coverage or evidence limit, not proof that no predecessor exists.

## MCP and HTTP

Call `lineage_analysis` with `operation=landscape`:

```json
{
  "operation": "landscape",
  "corpus": "my-papers",
  "query": "continual learning",
  "fromYear": 2015,
  "toYear": 2026,
  "maxDepth": 3,
  "maxNodes": 300,
  "maxEdges": 600
}
```

The operation requires `query`, `targetDomain`, or a nonempty `seedNodeIds` array. Explicit seeds select exact graph anchors instead of reinterpreting the topic text. The response contains `methods`, `papers`, `relations`, `paperRelations`, `families`, `turningPoints`, `periods`, `scope` and `diagnostics` under the shared backend result. `sourceQuality` reports the existing research quality filter. `responseMode=summary` is a bounded preview; use its full-read instruction before interpreting all relations.

The authenticated HTTP equivalent is `POST /api/field-evolution?name=<corpus>` with the same analysis parameters in its JSON body. The legacy MCP equivalent is `research_lookup` with `operation=field_evolution`.

All three routes read committed evidence through the existing research quality view. They do not import papers, refresh the graph, call a model or write analysis state.

## Reproduce the interface checks

The repository includes a fictional history with two families, a long lineage, branching, convergence, replacement, a component relation and undated material. It is software acceptance data and must not be used as literature evidence.

```bash
node scripts/verify-field-evolution-browser.mjs /tmp/papernexus-field-acceptance
```

The script starts an isolated local server and Chromium, exercises the map and exports, and saves screenshots and a JSON report. It uses the installed Google Chrome on macOS; set `PAPERNEXUS_BROWSER_EXECUTABLE` to another Chromium executable when needed. The temporary corpus and registry are removed after the check.

To explore the fictional example interactively, append `--serve` to that command. The printed localhost URL uses the application's configured browser login. Stop the foreground process with Ctrl+C when finished.
