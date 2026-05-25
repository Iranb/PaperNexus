# Idea Catalyst Live Discovery Alignment

This document describes the PaperNexus implementation of the live cross-domain literature survey workflow aligned with Kargupta et al., *Sparking Scientific Creativity via LLM-Driven Interdisciplinary Inspiration* (`2603.12226v1`).

## Goal

The original paper starts from only:

- a short research problem statement
- a target scientific domain

It then retrieves Semantic Scholar snippets, reasons over target-domain progress, searches distant source domains, prunes weakly grounded domains, extracts source-domain takeaways, recontextualizes them into idea fragments, and ranks fragments with pairwise interdisciplinary-potential judgments.

PaperNexus now supports two Idea Catalyst modes:

- `graph`: the existing graph-grounded workflow over already indexed papers.
- `live_discovery`: a paper-faithful online workflow driven by Semantic Scholar Snippets API retrieval and LLM reasoning.

## Alignment Matrix

| Paper step | PaperNexus implementation |
| --- | --- |
| Input `problem + target domain` | `idea_catalyst` accepts `problem`, `targetDomain`, and `mode: "live_discovery"`. |
| Decompose into target-domain research questions | Live workflow asks the configured LLM for domain-specific and domain-agnostic question pairs. If no LLM is configured, it falls back to a conservative single-question decomposition. |
| Retrieve target-domain literature snippets | `searchSemanticScholarSnippets()` calls `GET /graph/v1/snippet/search` with `query`, `fieldsOfStudy`, and `limit`. |
| Fallback when snippet text is degenerate | Degenerate title-like snippets can be hydrated with `GET /graph/v1/paper/{id}` and replaced by the paper abstract when available. |
| Assess target-domain progress | LLM classifies each question as `largely resolved`, `partially addressed`, or `largely unexplored` using retrieved snippets. |
| Surface unresolved conceptual challenges | LLM returns domain-specific and domain-agnostic remaining challenges grounded in target evidence IDs. |
| Select distant source domains | LLM selects source domains from the Semantic Scholar coarse field list while excluding the target field. |
| Generate source-domain queries | LLM generates source-domain vocabulary queries for each unresolved challenge. |
| Retrieve source-domain snippets | Same S2 snippet adapter, filtered by selected `fieldsOfStudy`. |
| Prune weak source domains | Source domains are accepted only when `relevant_paper_count / retrieved_paper_count >= sourceRelevanceThreshold`, default `0.5`. Relevance is assessed per paper, not per snippet. |
| Extract source takeaways | LLM extracts source-domain concepts and mechanisms from accepted relevant papers/snippets. |
| Generate idea fragments | LLM recontextualizes accepted source takeaways back to the target challenge. |
| Rank by pairwise potential | LLM compares all fragment pairs and PaperNexus aggregates wins into a final ranking. A deterministic score fallback is used only when LLM judging is unavailable. |

## MCP Usage

```json
{
  "tool": "idea_catalyst",
  "arguments": {
    "mode": "live_discovery",
    "problem": "How can models adapt to changing user intent in human-AI collaboration?",
    "targetDomain": "Natural Language Processing",
    "numQuestions": 4,
    "numSourceDomains": 3,
    "maxPapersPerQuery": 20,
    "sourceRelevanceThreshold": 0.5,
    "outputMode": "packet_bundle",
    "includeAnalysis": true
  }
}
```

The workflow uses the same LLM configuration as PaperNexus ingestion and discovery. Semantic Scholar API authentication is optional but recommended through `SEMANTIC_SCHOLAR_API_KEY` or `S2_API_KEY`.

## Output Contract

`mode: "live_discovery"` returns:

- `decomposition`: domain-specific and domain-agnostic research question pairs.
- `target_domain_analysis`: target-domain progress and unresolved challenges.
- `cross_domain_queries`: selected source domains and generated source-domain queries.
- `source_domain_analyses`: retrieved source-domain evidence, per-paper relevance, and pruning decisions.
- `idea_fragments`: ranked fragments with target challenge, source takeaways, rationale, and evidence.
- `interdisciplinary_ranking`: pairwise comparison records and aggregate ranking.
- `live_retrieval`: API settings, retrieval counts, and pruning threshold.

## Implemented Modules

### 1. Semantic Scholar Snippets Adapter

File: `src/core/discovery/semantic-scholar-snippets.js`

The adapter provides a normalized PaperNexus wrapper around Semantic Scholar's snippet search endpoint:

- `searchSemanticScholarSnippets(params)` performs online snippet retrieval.
- `normalizeS2FieldOfStudy(value)` maps fine-grained user domains such as `NLP`, `HCI`, or `biomedicine` to Semantic Scholar coarse fields.
- `fetchSemanticScholarPaperAbstract(paper, params)` hydrates title-like or very short snippets with paper abstracts when Semantic Scholar returns insufficient snippet text.

Supported retrieval controls:

- `fieldsOfStudy` / `targetFieldOfStudy`
- `limit`
- `year`
- `publicationDateOrYear`
- `insertedBefore`
- `paperIds`
- `authors`
- `minCitationCount`
- `venue`

The adapter reuses PaperNexus discovery scheduling, retry, timeout, and optional API key handling. Set `SEMANTIC_SCHOLAR_API_KEY` or `S2_API_KEY` for authenticated Semantic Scholar calls.

### 2. Live Target/Source Retrieval Loop

File: `src/core/graph/idea-catalyst-live.js`

`runLiveIdeaCatalyst(params, options)` implements the paper-faithful online loop:

1. Decompose the input problem into target-domain and domain-agnostic research questions.
2. Retrieve target-domain snippets for each question.
3. Assess target progress and unresolved challenges from retrieved evidence.
4. Select distant source domains for each unresolved challenge.
5. Generate source-domain search queries using source-domain vocabulary.
6. Retrieve source-domain snippets from Semantic Scholar.
7. Group snippets by paper before relevance judgment.
8. Retain source domains only after paper-level relevance pruning.
9. Extract grounded source takeaways.
10. Recontextualize takeaways into idea fragments.
11. Rank fragments with pairwise interdisciplinary-potential judgments.

The implementation keeps this loop separate from the existing graph catalyst path so indexed-corpus behavior remains the default and existing packet contracts remain stable.

### 3. Source-Domain 50% Paper Pruning

Source-domain pruning happens in `analyzeSourceDomain()`.

The denominator is the number of unique retrieved source-domain papers after snippet grouping. The numerator is the number of papers judged relevant by the LLM relevance judge, with lexical fallback only when no LLM is available.

```text
relevance_ratio = relevant_paper_count / retrieved_paper_count
accepted = retrieved_paper_count > 0 && relevance_ratio >= sourceRelevanceThreshold
```

The default `sourceRelevanceThreshold` is `0.5`, matching the paper's majority-relevant filter. Output records include:

- `retrieved_paper_count`
- `relevant_paper_count`
- `relevance_ratio`
- `relevance_threshold`
- `accepted`
- `pruning_decision`
- per-paper `relevance` judgments

### 4. Pairwise LLM Interdisciplinary-Potential Judge

The ranking stage asks the configured LLM to judge every pair of generated fragments. The prompt explicitly evaluates:

- depth of target-source integration
- non-trivial novelty from a distant source domain
- grounding in source evidence
- ability to address unresolved target-domain challenges
- plausible usefulness without collapsing into adjacent work

The returned pairwise wins are aggregated into `interdisciplinary_ranking.ranked_fragments`. PaperNexus requires one valid LLM judgment for every requested fragment pair before reporting `ranking_backend: "llm-pairwise-v1"`. If LLM ranking is unavailable, invalid, or incomplete, PaperNexus emits `ranking_backend: "heuristic-pairwise-fallback-v1"` so benchmark runs can distinguish faithful LLM-judged runs from degraded runs.

## MCP Integration

The existing `idea_catalyst` tool now accepts:

- `mode: "graph"`: existing indexed-graph workflow, still the default.
- `mode: "live_discovery"`: online Semantic Scholar Snippets workflow.
- `mode: "hybrid"`: returns the graph result plus live discovery output.
- `liveDiscovery: true`: alias for `mode: "live_discovery"`.
- `selectionMode: "topk" | "mmr" | "submodular" | "dpp"`: optional post-generation selector that returns selected idea fragments and a `selection_trace`; omitted/default keeps the legacy output unchanged.

The remote wrapper `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py` exposes:

```bash
python pn_idea_catalyst.py \
  --problem "adaptive human-AI collaboration under changing user intent" \
  --target-domain "Natural Language Processing" \
  --mode live_discovery \
  --num-questions 4 \
  --num-source-domains 3 \
  --max-papers-per-query 20 \
  --source-relevance-threshold 0.5 \
  --output-mode packet_bundle \
  --include-analysis
```

## Reproducibility Guidance

For paper-aligned evaluation runs:

- Use `mode: "live_discovery"`.
- Use `maxPapersPerQuery: 20`.
- Keep `sourceRelevanceThreshold: 0.5`.
- Configure an LLM provider so target assessment, relevance pruning, takeaway extraction, fragment generation, and pairwise ranking are LLM-driven.
- Set `year`, `publicationDateOrYear`, or `insertedBefore` when reproducing a historical evaluation window.
- Store the returned `packet_bundle` because it contains retrieval counts, source-domain pruning decisions, evidence IDs, and pairwise comparison records.

## Test Coverage

The implementation has focused tests for:

- fine-grained domain normalization to Semantic Scholar fields
- snippet search parameter construction
- abstract fallback for degenerate snippet text
- live target/source retrieval loop
- source-domain majority relevance pruning
- pairwise LLM ranking aggregation
- MCP schema exposure and remote wrapper forwarding

## Design Notes

- The implementation is intentionally separate from the existing graph core because `buildCatalystQuery()` is a high-impact symbol used by CLI, server API, research lookup, and tests.
- `live_discovery` does not mutate the corpus graph. It is a survey/evaluation workflow. Users can still import papers through `literature_discovery` and then run `mode: "graph"` for graph-grounded analysis.
- The S2 Snippets API works at the coarse `fieldsOfStudy` level. Fine-grained domains such as NLP are mapped to `Computer Science`.
- The pruning rule is applied after grouping snippets by paper, matching the paper's "majority of retrieved papers" requirement.
- Pairwise ranking is the authoritative ranking path when an LLM is configured. The fallback is labeled `heuristic-pairwise-fallback-v1` in output so benchmark runs can separate faithful and degraded executions.

## Operational Constraints

- Live retrieval is network-bound and subject to Semantic Scholar rate limits.
- Snippet search may retrieve title or abstract snippets; body snippets depend on Semantic Scholar's indexed content.
- The workflow should be run with `maxPapersPerQuery: 20` when reproducing the paper setting.
- For benchmark reproducibility, set `year` or `publicationDateOrYear` to enforce temporal cutoffs and prevent future-paper leakage.
