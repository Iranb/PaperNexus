# Explore a field's evolution

The evolution map connects papers through source-backed method relations. It shows a timeline, connected method families, structural mainlines and turning-point candidates. Each arrow opens the source quote and the recorded bottleneck, mechanism and tradeoff.

## Open the map

Select a corpus in the browser. Enter a **Topic**, a **Target domain**, or both, then choose **Map existing corpus**. The optional year range limits the displayed history. **Coverage** controls traversal depth and the node budget.

Use **Papers** to follow the articles and **Methods** to inspect the mechanisms they connect. Arrows point from predecessor to successor. Paper arrows are projections of method evolution evidence, not ordinary citations. The family selector focuses on one connected set of methods; a paper associated with several families remains available in each of them.

Orange paths mark a structural mainline. Orange dots mark turning-point candidates. Select a node or arrow to open its evidence. **Clear selection** restores the family and turning-point navigator. **Find** highlights titles without hiding their context. Scroll across years, use the zoom controls, or choose **Fit** for an overview. Nodes and arrows also support keyboard focus and Enter or Space.

**SVG** downloads the current map, including the selected family and highlights. **JSON** downloads the full analysis and the current view settings. **Back to graph** returns to the existing knowledge graph and topic analysis.

## Research and build the map

Choose **Research and build map** to search configured literature providers, download available full text, import missing papers and run the configured relation extraction. **New paper budget** defaults to 20 and allows 1–100 candidates. The action may use configured models and incur API charges. The corpus must be covered by enabled import and graph synchronization workers.

The progress panel follows discovery, full-text resolution, import, semantic processing and graph synchronization. The map appears after the submitted tasks reach confirmed terminal states. Unavailable full text, failed processing, unresolved paper identity and provider failures remain visible as coverage gaps. Unknown or missing task states require attention and cannot establish a ready map. **Resume latest research** reads the existing task. Reloading an open task restores its corpus and run; closing the view leaves the server work running.

Search uses a bounded query plan and citation expansion. Selection alternates across publication decades to retain earlier and recent research. Within each decade it preserves relevance and provider agreement ordering. Known papers are matched by strong identifiers before the full-text budget is spent. The year range limits dated candidates; undated candidates remain eligible. Failed downloads do not increase the paper budget.

The final map combines current query matches with uniquely identified papers from this research run, including existing papers found during discovery. This allows imported papers with different vocabulary or incomplete domain labels to appear. Arrows still require admitted method evidence. The JSON export includes the request, sources, import states and coverage gaps with the map.

### Start and inspect research through MCP or HTTP

Use `literature_review` with `operation=field_research`. A dry run returns scope and worker readiness without searching or creating a task:

```json
{"operation":"field_research","corpus":"my-papers","query":"continual learning","maxPapers":20,"dryRun":true}
```

To start, omit `dryRun` and supply a stable `idempotencyKey`:

```json
{"operation":"field_research","corpus":"my-papers","query":"continual learning","fromYear":1990,"maxPapers":20,"idempotencyKey":"continual-learning-2026-10-25"}
```

Keep the returned `runId`, then read it with:

```json
{"operation":"field_research_status","corpus":"my-papers","runId":"field-continual-learning-2026-10-25"}
```

The authenticated HTTP routes are `POST /api/field-research?name=<corpus>` and `GET /api/field-research?name=<corpus>&runId=<runId>`. POST accepts the same fields without `operation` or `corpus`; it returns 202, or 200 for a dry run. Omitting `runId` on a status read selects the latest saved run. Reusing a key with the same normalized request returns the existing run; different parameters return a conflict. After an unknown submission outcome, retry the same request and key.

Requests and import references are saved under the corpus's `field-research/runs` directory. Discovery reports retain queries, candidate decisions and retrieval evidence. Server recovery resumes incomplete discovery/import handoffs and reuses saved discovery results. Status reads do not restart work. Failed runs require an explicit new request after the cause is resolved.

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

The research flow has a separate offline browser check:

```bash
node scripts/verify-field-research-browser.mjs /tmp/papernexus-field-research-acceptance
```

It exercises actual authenticated HTTP routes and import storage with fictional discovery sources. Import completion and graph publication are supplied fixtures; this check does not verify a live provider or a paid extraction model.

## Refine and publish lineage evidence

Open a saved study or an existing field map, then expand **完善谱系证据**. The workflow extracts source-versioned evidence cards, reviews each candidate against the complete child and available predecessor sources, and records supported, rejected and uncertain decisions. Use **预览发布** to inspect the supported subset, then **发布到图谱** to publish it. **预览撤回** withdraws the selected publication. Reloading the page reads the saved task without starting another model call.

For a saved study, refinement selects from all included branches. For an ordinary map, it selects up to the first 100 displayed papers. `maxPapers` limits processing and favors papers without recorded method relations. The response reports omitted papers. Missing connections remain evidence gaps; they do not establish independent origin or research novelty.

The `literature_review` MCP tool exposes three operations:

```json
{
  "operation": "lineage_refine",
  "corpus": "my-field",
  "papers": [{"paperId": "paper:child"}],
  "idempotencyKey": "review-batch-1",
  "maxPapers": 20,
  "maxQueries": 0,
  "maxNewPapers": 0,
  "maxRounds": 1
}
```

Use `studyId` instead of `papers` to select a saved study. Use `dryRun: true` to inspect selection and effects without creating a task. Source text must be available as full Markdown or text. If multiple active sources exist for a paper, include its exact `sourceKey`. Evidence cards v2 retain separate bottleneck or adoption reason, mechanism, and tradeoff quotations with attribution and epistemic status. Missing explanations remain unknown. Old cards remain readable but require v2 extraction before this review flow.

```json
{"operation":"lineage_refine_status","corpus":"my-field","runId":"refine-review-batch-1","responseMode":"full"}
```

Status is read-only. `completed` means the bounded processing finished; it does not mean every relation was accepted or the field is covered. Each relation retains the model decision, reason, deterministic blockers and explanation gaps. Authentication, provider and source failures remain visible. Reuse the same request key for reconciliation. Use `retryFailed: true` on the original start request to retry failed or pending work; successful extraction and review caches, including valid saved model responses, remain reusable. Retrying a fully completed run does not start new work. A new selection or configured model requires a new key.

External supplementation is disabled by default. Set both `maxQueries` (1–8) and `maxNewPapers` (1–20) to enable it. `maxRounds` permits 1–3 supplementation rounds, followed by review. Budgets are cumulative across rounds and recovery, and reserved selections consume the import budget even if import fails. Each planned query searches one configured provider, with citation expansion disabled. Markdown sources use `fast-md-structural`; other supported sources use `full`. Import workers and authoritative graph synchronization must be enabled. A source is reviewed only after the existing import task confirms graph visibility and synchronization. Failed searches, unavailable full text, import failures and exhausted budgets remain in the result.

```json
{"operation":"lineage_publish","corpus":"my-field","runId":"refine-review-batch-1","requestId":"publication-1","apply":false}
```

Publication defaults to preview. Repeat with `apply: true` to publish. Only terminal refinement runs are eligible; partial runs can publish their successfully reviewed subset. The API accepts saved run and request IDs, never caller-supplied graph operations. Unsupported, ambiguous, unmatched or stale evidence is excluded. Component adoption retains its distinct relationship type. Missing bottleneck evidence does not invalidate an otherwise supported relationship.

Publication responses include the actual relationship readback. Receipts bind source content and paper identity and preserve previous graph values. They are replayed by full and lite graph reads, so a graph rebuild does not discard valid published relations. Source changes, deactivation or deletion stop the affected publication from being treated as current evidence. Subsequent graph edits produce conflicts instead of being overwritten. Saved-study views include valid published methods and direct predecessor context in `analysis.result.scope.study.publishedContext`; the saved membership, revision and coverage review remain unchanged.

To preview withdrawal, send the same `runId` and `requestId` with `revoke: true`; add `apply: true` to execute it. Withdrawal restores or removes only the publication's owned changes, preserving unrelated edits. An old request ID cannot republish a revoked receipt; use a new explicit publication request.

HTTP uses the same service and authentication:

| Request | Behavior |
| --- | --- |
| `POST /api/lineage-refinement?name=<corpus>` | Start or preview refinement |
| `GET /api/lineage-refinement?name=<corpus>&runId=<id>` | Read saved state and decisions |
| `POST /api/lineage-publication?name=<corpus>` | Preview, apply or revoke publication |

Both model stages use the configured research model. A second model call is a review step, not independent scientific validation. Published evidence is marked `model_reviewed`, with `scientificValidation: false`. No experimental performance or novelty claim follows from publication.

The browser acceptance uses temporary corpora and fixed model responses:

```sh
node scripts/verify-lineage-refinement-browser.mjs /tmp/papernexus-lineage-refinement
```
