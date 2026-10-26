# Build a field method lineage

Use this workflow when the user requests a field history, method genealogy, a broader rebuild, or literature completion followed by an evolution map. Use `analysis.md` for a bounded question about already committed methods. Preserve the user's scope and prior authorization. A representative seed set is a starting point unless the user requested that limited deliverable.

## Establish the research scope

Read capabilities. On supported servers, `literature_review/studies` lists saved studies and `study` reads their selections and current graph. Reuse exact paper identities, selected source versions, extraction receipts and verified relation evidence.

Define what belongs to the field, the time range, terminology variants, related settings that need separate treatment, and substantive research branches. Use relevant surveys and primary sources to check the branch structure. Do not silently equate multi-label with multi-class, task-incremental with class-incremental, or all uses of a method with its introduction. Resolve consequential ambiguity; choose and state ordinary reversible scope details without repeated permission requests.

Record the scope and branch plan before substantial acquisition. The study title and visible counts must describe that scope. Do not reduce a field request to a hand-picked seed list without saying the larger work remains unfinished.

## Expand according to evidence gaps

Search both the current corpus and external primary sources. Retain query, provider, date, raw candidate record and the screening decision. Search distinct branches and terminology; check older foundations and recent work. Use surveys and backward/forward citations to identify missing predecessors, successors and competing approaches. Provider failures and unavailable full text are named gaps, not evidence that the literature is absent.

`field_research` starts one bounded search/import/extraction batch. Its defaults and `maxPapers` are execution budgets, not acceptance targets. Use separate rounds or targeted `discover` calls for unresolved branches; read saved reports instead of repeating completed work. Keep runId/taskId and exact synchronization state. If importing only a reviewed subset, use selected staged files instead of importing an entire saved discovery run.

Maintain inclusion, context and exclusion decisions by canonical DOI/arXiv identity and selected version. Read decisive source passages before assigning a paper to a mechanism or declaring a lineage. Do not silently exclude existing relevant corpus papers merely because they were not in the initial list.

## Identify methods and substantiate relations

A paper can introduce several methods, meaningful variants or reusable components. Preserve those identities when the source distinguishes them. Do not enforce one method per paper. Conversely, a backbone, dataset, baseline or every extracted noun is not automatically an introduced method. Record method, variant, component and background roles using the available source evidence.

For each proposed lineage relation retain the citing and cited paper identities, method endpoints, relation type, exact source quote, section/page or span, and the claimed change. Distinguish extension, adaptation, replacement and component use. A citation, shared keyword, chronological order or performance comparison alone does not establish a lineage. Validate quotations against the selected full text and check their meaning in context. Leave uncertain relations as candidates with a reason; only accepted source-backed relations become map arrows.

Keep model-extracted objects and relationships separate from individually checked claims. Reuse graph identity where unambiguous. Repair only affected source identities and preserve provenance; do not rewrite the entire corpus to obtain a clean display.

## Review coverage separately from execution

After a round, review each branch: which relevant evidence is present, which important methods or direct predecessors are absent, which search terms or sources have not been checked, and which acquisition or interpretation gaps remain. Use the evidence to choose the next targeted action. Do not stop because a paper count, batch limit, token budget or map-rendering test was reached.

A coverage review is ready when the agreed branches and settings have been examined, important known omissions have been resolved or explicitly bounded, and a further round is not expected to change the principal lineage materially. Record the basis and remaining limits. This is a research judgment supported by search and source records, not a numeric coverage score or a claim of universal exhaustiveness. A known unexamined major branch remains pending; merely listing that omission does not finish it.

`field_research_status.coverageAssessment=not_assessed` is expected even after a batch is `completed`. In a saved study, `coverage.status=reviewed` records a supported analyst review. It does not certify every model output or prove the entire literature has been found. Missing selected graph evidence must remain visible when a study is read later.

## Save and verify the native result

Use `literature_review/study_save` with a stable `studyId`, `expectedRevision=0` for creation or the revision just read for an update, and the advertised `study` schema. Record scope, branch reviews, search records, paper inclusion/exclusion reasons, all selected `methodIds`, evidence references, and remaining gaps/actions. Saving a study changes the research record; it does not import papers or mutate graph evidence.

The `study` read builds its map from the current admitted corpus. Do not substitute an unrelated local graph, a static HTML report or a generated SVG for a requested native Web result. Open the PaperNexus Web with `?corpus=<name>&study=<studyId>`, or select **Field studies → Open study**. Check branch selection, Papers/Methods switching, source evidence on arrows, counts and display limits. Exported research data should keep the scope and coverage record with the graph.

Report the actual selected papers, distinct methods/variants, accepted relations and unresolved evidence separately. Link to the native Web view and the review record. Software tests establish interface behavior; source review and search records establish the research result.
