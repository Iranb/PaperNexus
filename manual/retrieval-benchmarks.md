# Retrieval Benchmarks

PaperNexus can run literature-discovery benchmarks against public or private retrieval datasets:

```bash
papernexus benchmark-retrieval ./benchmarks/scifact \
  --format beir \
  --evaluation-mode fixed-corpus \
  --benchmark-limit 50 \
  --k 1,5,10,20 \
  --output .papernexus-benchmarks
```

Use `--evaluation-mode fixed-corpus` for BEIR/SAGE/CSFCube-style closed-corpus evaluation. Use `--evaluation-mode live` to run the existing PaperNexus discovery workflow against providers such as OpenAlex, Semantic Scholar, Crossref, and arXiv.

The command reports macro `hit@k`, `exact_match@k`, `recall@k`, `weighted_recall@k`, `precision@k`, `f1@k`, `mrr@k`, `map@k`, and graded `ndcg@k`.

## Formats

### Custom JSON / JSONL

Use this for private benchmarks, including licensed or institution-only corpora. Each query needs text and at least one relevant paper:

```json
{
  "queries": [
    {
      "id": "q1",
      "query": "scientific literature retrieval benchmarks",
      "relevant": [
        {
          "title": "LitSearch: A Retrieval Benchmark for Scientific Literature Search",
          "doi": "10.xxxx/example"
        }
      ]
    }
  ]
}
```

Relevant papers can be matched by DOI, arXiv ID, PMID, PMCID, or exact/fuzzy title. Identifier matches are preferred.

### BEIR / TREC qrels

Point the command at a BEIR-style directory:

```text
benchmark/
  corpus.jsonl
  queries.jsonl
  qrels/test.tsv
```

BEIR datasets such as SciFact, SCIDOCS, TREC-COVID, NFCorpus, and BioASQ-derived exports can use this path. PaperNexus evaluates against the qrels documents by matching returned paper metadata to the qrels corpus entries.

### LitSearch

Export LitSearch query and corpus splits to JSON/JSONL, then run:

```bash
papernexus benchmark-retrieval ./benchmarks/litsearch --format litsearch
```

Expected files:

```text
litsearch/
  query.jsonl
  corpus_clean.jsonl
```

The loader also accepts `queries.jsonl`, `query.json`, `queries.json`, `corpus.jsonl`, and `corpus.json`.

### BioASQ

BioASQ Task B question files can be loaded directly:

```bash
papernexus benchmark-retrieval ./benchmarks/bioasq/training.json --format bioasq
```

The loader reads `questions[].body` as the query and maps `questions[].documents` plus snippet document URLs to PMID-backed relevant papers.

### TREC Biomedical Tracks

Use either a BEIR-style export or native topics plus qrels:

```text
trec-pm/
  topics.xml
  qrels.txt
```

The native loader supports standard 4-column TREC qrels and topic XML fields such as `title`, `summary`, `description`, `disease`, `gene`, `demographic`, and `other`.

### SAGE, ScholarQABench / OpenScholar, PaperAsk, SPARBench, SciNetBench

These benchmark families are accepted through flexible JSON/JSONL schemas:

```text
benchmark/
  corpus.jsonl
  queries.jsonl
```

For SAGE, ScholarQABench, PaperAsk, and SciNetBench, you can also point `papernexus benchmark-retrieval` at the upstream repository root or released data root. PaperNexus recursively loads the official data layouts it recognizes:

- SAGE: `Sage_Short_Form_Questions/*.json` and `Sage_Open_Ended_Questions/*.json`. Short-form `complete_query` records become exact paper-finding cases; open-ended `ground_truth.most_relevant` / `ground_truth.relevant` papers are loaded with graded relevance.
- ScholarQABench: `data/single_paper_tasks/*_test.jsonl`, `data/scholarqa_cs/test_configs_snippets.json`, `data/scholarqa_multi/human_answers.json`, `data/scholarqa_bio/scholarqabench_bio.jsonl`, and `data/scholarqa_neuro/scholarqabench_neuro.jsonl`.
- PaperAsk: `test_cases/citation_retrieval/`, `test_cases/content_extraction/`, `test_cases/open_domain_QA/`, and `test_cases/open_book_CF/`.
- SciNetBench: `Queries/Task1/`, `Queries/Task2/`, and `Queries/Task3/` query-map files.

Each query can use `query`, `question`, `input`, `body`, `claim`, `prompt`, `initial_prompt`, SAGE `complete_query`, or the ScholarQABench `metric_config.config.question`. Relevant papers can be supplied as `relevant`, `relevantPapers`, `relevantDocs`, `goldPapers`, `documents`, `citations`, `references`, `paper`, `papers`, `url`, `sourceUrl`, `paperUrl`, `paperUrls`, `evidencePapers`, `targetPapers`, `pathPapers`, SAGE `ground_truth.most_relevant` / `ground_truth.relevant`, ScholarQABench `gold_ctx` / `gold_ctxs` contexts, ScholarQABench reference `ctxs` from `human_answers.json`, PaperAsk `ground_truth_papers`, PaperAsk content-extraction `url`, SPARBench `answers[].paperID`, or ID lists such as `goldIds`, `corpusIds`, `paperIds`, and `documentIds`. Object-map query files such as SciNetBench `{"subfield": "query"}` files are expanded into one case per map entry.

Task-level fields are also recognized:

- Reference answers: `referenceAnswer`, `referenceAnswers`, `idealAnswer`, `idealAnswers`, `expectedAnswer`, `expectedOutput`, `answer`, non-paper-like `answers`, or ScholarQABench `human_answers.json` `output`.
- ScholarQABench rubrics: `rubric`, `rubrics`, `criteria`, `referenceRubric`, `metric_config.config.other_properties`, and `ingredients.most_important` / `ingredients.nice_to_have`.
- Claim labels: `expectedLabel`, `expectedLabels`, `label`, `labels`, `verdict`, `verdicts`, `claimLabel`, `claimLabels`, `goldLabel`, `goldLabels`, `classification`, or expected verdict fields.
- PaperAsk structured answers: content-extraction `ground_truth` objects are compared field by field against JSON/Python-dict-shaped system answers.
- Gold relations/paths: `goldRelations`, `expectedRelations`, `relations`, `paths`, `paperPath`, `evolutionPath`, `trajectory`, `goldPaths`, or `evidencePaths`.
- Pair-wise relation labels: `citationSentiment`, `citeSentiment`, `coMention`, `coMentionLabel`, `relationLabel`, plus `sourcePaper` / `targetPaper` and citation context fields.
- Existing system outputs: `systemAnswer`, `generatedAnswer`, `predictedAnswer`, `prediction`, `output`, `answer_txt`, `predictedLabel`, `predictedLabels`, `predictedRelations`, `predictedPaths`, `predictedCitations`, and ScholarQABench prediction `ctxs`.

By default, task evaluation uses rule metrics only: token-overlap answer correctness, exact answer match, field-level content-extraction accuracy, citation precision/recall/F1/success, claim-label accuracy, and relation/path overlap. PaperAsk reports `paperask_success_rate` and `paperask_failure_rate` when task-level success can be derived. SciNetBench reports relation-aware aliases such as `scinet_pair_cite_acc`, `scinet_pair_cite_sentiment`, `scinet_path_consistency`, and `scinet_path_connectivity`.

For LLM-judged QA, citation faithfulness, claim verification, and relation reasoning, run:

```bash
papernexus benchmark-retrieval ./benchmarks/scholarqa \
  --format scholarqa \
  --task-evaluation llm \
  --generate-task-answers true \
  --model gpt-4o-mini
```

When `--generate-task-answers true` is enabled, PaperNexus asks the configured LLM to answer from the retrieved paper contexts and emit citations, claim verdicts, and relations as JSON. The LLM judge then scores answer correctness, answer grounding, citation faithfulness, claim-label accuracy, relation reasoning, SciNetBench path rationality, and task success.

### CSFCube

CSFCube faceted query-by-example files can be loaded with:

```text
csfcube/
  abstracts-csfcube-preds.jsonl
  test-pid2anns-csfcube-background.json
  test-pid2anns-csfcube-method.json
  test-pid2anns-csfcube-result.json
```

The loader also recognizes `corpus.jsonl`, `papers.jsonl`, `pid2anns.json`, `test-pid2anns-csfcube.json`, and split official facet files. It creates one case per query paper and facet.

## Alignment Matrix

| Benchmark family | Loader | Best evaluation mode | Current alignment |
|---|---|---|---|
| BEIR / SciFact / SCIDOCS / TREC-COVID / NFCorpus | `beir` | `fixed-corpus` | Native corpus/query/qrels support |
| LitSearch | `litsearch` | `fixed-corpus` or `live` | Native exported query/corpus support |
| BioASQ | `bioasq` or BEIR export | `live` or `fixed-corpus` with a corpus export | Native question JSON maps PubMed documents |
| TREC Biomedical / CDS / Precision Medicine | `trec` | `fixed-corpus` when corpus metadata is available | Native topics plus qrels, or BEIR export |
| SAGE | `sage` | `fixed-corpus` | Official short-form and open-ended directory schemas; `complete_query`, exact paper finding, and graded `most_relevant` / `relevant` recall |
| ScholarQABench / OpenScholar | `scholarqa` | `live` or `fixed-corpus` + `--task-evaluation llm` | Official data schemas for single-paper tasks, ScholarQA-CS rubric configs, and ScholarQA-Multi human answers; internal answer/citation/rubric approximations unless official scripts are run externally |
| PaperAsk | `paperask` | `live` or `fixed-corpus` + `--task-evaluation llm` | Released `test_cases/` schemas for citation retrieval, content extraction, paper discovery, and claim verification; BibTeX parsing, field-level content accuracy, claim-label accuracy, failure-rate aliases; upstream official evaluator is not yet released |
| SPARBench | `sparbench` | `live` or `fixed-corpus` | Flexible schema plus F1 / recall / precision; `answers[].paperID` records are normalized as gold papers |
| SciNetBench | `scinetbench` | `fixed-corpus` + `--task-evaluation llm` | Query-map loading, ego novelty/disruption prompts, pair-wise citation/co-mention prompts, path prompts, relation/path overlap when gold relations are supplied, LLM path rationality; official metrics require upstream `Evaluation/*.py` plus OpenAlex/relation DB artifacts |
| CSFCube | `csfcube` | `fixed-corpus` | Native faceted annotation loader |

## Notes

By default, `benchmark-retrieval` sets `resolveSources=false`, so it evaluates search result quality without downloading full text. Enable source resolution explicitly only when you want to measure OA/full-text availability:

```bash
papernexus benchmark-retrieval ./benchmarks/private.json \
  --format custom \
  --resolve-sources true \
  --allow-downloads true \
  --output .papernexus-benchmarks
```

Public benchmark files normally do not contain paywalled full text. For paid or licensed collections, use the custom JSON/JSONL format and store only metadata plus identifiers unless your local license allows full-text handling.

Closed-corpus scores and live-discovery scores are intentionally separated. Closed-corpus runs are closer to official IR leaderboard semantics; live-discovery runs measure PaperNexus behavior against real external scholarly APIs and are not directly comparable to official fixed-corpus scores.

ScholarQABench, PaperAsk, and SciNetBench reports intentionally mark `officialComparable=false` even in fixed-corpus mode unless their upstream evaluators are run outside PaperNexus. The built-in metrics are schema-aligned diagnostics for PaperNexus regression testing, not a claim of leaderboard-equivalent scoring.
