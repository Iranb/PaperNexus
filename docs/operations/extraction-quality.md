# Research extraction quality

Extraction preserves the scope of a source statement from model output through the semantic snapshot and graph. A model response, a completed processing stage, and a source-verified claim are separate facts.

## Evidence and scientific scope

Research objects and relations accept these optional properties:

| Property | Meaning |
|---|---|
| `evidenceText` | Source passage, including qualifications and comparison scope. Missing quotes stay absent or empty. |
| `supportingSnippets` | Separate source passages with section and chunk locations. |
| `sectionHeading`, `sectionRole`, `sourceChunkIds` | Location in the selected source. |
| `attribution` | Named `subject` and `role`: `proposed`, `baseline`, `prior-work`, or `experiment`. |
| `epistemicStatus` | `asserted`, `observed`, `hypothesis`, `refuted`, or `uncertain`. |
| `relationContext` | `method`, `ablation`, `comparison`, `hypothesis`, or `background`. |
| `experimentContext` | Source-supported dataset, task split, backbone, pretraining, memory budget, metric, value, unit, baseline, comparison, variant, and source location. |

Research questions and challenges carry the same provenance. `abstractMechanismObjects` contains a name, substantive description, aliases and provenance; legacy mechanism names remain readable. Exact duplicates combine their supporting passages. Distinct ownership, epistemic status, experiment conditions or relation contexts remain separate.

All six single-paper, batch and chunk prompt paths use the evidence contract. Chunk prompts retain their supplied text; the existing prompt budget controls batching. This does not recover information missing from the parsed source.

For shared graph nodes, source-specific provenance is on the paper-to-object edge. Paper-scoped Finding, Evidence and Claim nodes also retain it in node properties. Structured mechanisms remain on the paper's `abstractMechanismObjects` property.

## Graph admission

A baseline, prior-work or experimental assumption remains discussion content through `CONTAINS`; it does not become the paper's `ASSUMES` relation. The same ownership rule applies to `USES` and `HAS_LIMITATION`. Explicitly refuted, hypothetical, uncertain or non-method context also qualifies these paper relations. The edge retains `originalRelationType` and `admissionReason`.

Method adoption and lineage relations are excluded when explicitly marked as ablation, comparison, hypothesis, background, or a non-factual epistemic status. The candidate stays in `llmRelations` with `graphAdmission` and the evidence. Negative findings remain available. `USES_COMPONENT_METHOD` means whole method to adopted component; `COMPONENT_OF` means component to whole method.

These checks consume structured meaning. They do not infer scientific ownership or direction from keywords. Missing new properties do not remove historical records. Unqualified historical mistakes require source review or fresh extraction.

## Completion and recovery

Taxonomy labels and bare mechanism names do not count as research content. Empty model output has `participated: false` and reason `empty-semantic-result`. Existing snapshots are counted from their actual research arrays, rather than cached success flags or counts.

Background enrichment checks each job's selected source snapshots. Required semantic and relation stages must finish; successful relation extraction may legitimately return zero edges. Partial chunk processing or provider failure leaves the semantic job failed, with details in `result.semanticCompletion`. A mixed batch settles successful jobs independently. Graph visibility remains a separate lifecycle state.

Incomplete semantic jobs stop without automatic queue retries. HTTP 402 / insufficient-balance errors also skip chunk fallback. Inspect the saved error, repair the provider configuration or source problem, then explicitly requeue the selected failed job through the existing store API:

```js
import {
  listImportSemanticEnrichmentJobs,
  enqueueImportSemanticEnrichmentJobs
} from './src/storage/import-semantic-store.js';

const queue = await listImportSemanticEnrichmentJobs(corpusRoot);
const job = queue.jobs.find(entry => entry.id === selectedJobId && entry.status === 'failed');
if (!job) throw new Error('Selected failed semantic job was not found');
await enqueueImportSemanticEnrichmentJobs(corpusRoot, [job]);
```

The worker may call the configured model when it consumes the requeued job. Prompt version changes invalidate prior extraction configuration signatures. A separately scheduled `papernexus llm-optimize <path> --continue --semantic-extraction llm-primary` can refresh existing snapshots; this stage does not itself rebuild the graph. Use the staged graph build and write workflow after reviewing the output.

## Offline audit

Run the audit against a directory of saved `*.snapshot.json` files:

```sh
node scripts/audit-extraction-quality.mjs \
  --input /path/to/snapshot-copies \
  --output /path/to/quality-report
```

The script writes `audit.json`, `report.md`, and reviewed copies under `corrected/`. It reads the original files without changing them and makes no model or network requests. The included review fixture covers eight confirmed issues and four positive cases. Four source-reviewed corrections preserve baseline attribution, exclude a negative SwAV ablation from adoption, separate C-Flat Turbo comparison baselines, and retain SLCA's tentative explanation. Corrections require the reviewed object to match; a different extraction needs a new review.

For other corpora, pass `--reviewed-cases /path/to/reviews.json`. Use `{"cases":[]}` for diagnostics without reviewed corrections. Do not use the corrected copies as a blanket replacement for current production snapshots.

## Limitations

Offline replay verifies field preservation and graph behavior, not real-model extraction accuracy. Missing historical evidence and experiment protocols still require source review or re-extraction. Broken PDF reading order, semantic aliases, and unsupported scientific claims are not repaired by exact deduplication. Cross-paper performance comparisons require verified protocol alignment in addition to these fields.
