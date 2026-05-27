# Graph Reasoning Report

`papernexus-graph-reasoning-report-v1` is the E5 evidence contract for SciRepEval/OAG-Bench/GraphRAG-Bench style graph reasoning. The release gate checks these benchmark families separately; either provide one combined report whose benchmark metadata explicitly covers all three, or provide separate reports for SciRepEval, OAG-Bench, and GraphRAG-Bench.

The command builds an auditable report from a frozen graph snapshot, graph reasoning tasks with gold node ids, and GraphRAG/global-local summaries. Summaries can be omitted for plumbing checks, but `E5` release evidence requires hashed `graph_snapshot`, `graph_reasoning_tasks`, and `graphrag_summaries` inputs. It is intentionally conservative: the default deterministic backend is useful for artifact plumbing and regression tests, but it is not release-pass evidence.

## Command

```bash
npm run eval:graph-reasoning -- \
  --graph-path artifacts/graph/graph-snapshot.json \
  --tasks-path artifacts/graph-reasoning/tasks.json \
  --summaries-path artifacts/graphrag/community-summaries.json \
  --output-dir artifacts/graph-reasoning/run-001 \
  --benchmark-name "SciRepEval OAG-Bench GraphRAG-Bench release slice" \
  --benchmark-format scirepeval-oag-graphrag \
  --dataset-source "https://example.org/frozen-benchmark-snapshot" \
  --license-scope "public benchmark research use" \
  --release-evidence
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `graph-reasoning-report.json` | Machine-readable E5 report with benchmark metadata, metrics, gates, inputs, and task-level rankings. |
| `graph-reasoning-report.md` | Human-readable report summary. |
| `manifest.json` | Run manifest with artifact paths and release-gate status. |

Pass `graph-reasoning-report.json` into the release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --output-dir artifacts/idea-catalyst-release-gate/run-001 \
  --graph-reasoning-report artifacts/graph-reasoning/run-001/graph-reasoning-report.json
```

`E5` remains incomplete if any of the three benchmark families is missing, even when another graph reasoning report passes. This prevents a SciRepEval-only run from being promoted as evidence for OAG-Bench or GraphRAG-Bench. `E5` also rejects summary-only plumbing: GraphRAG/global-local summaries must have their own input hash and must produce a positive `global_local_summary_delta`.

## Input Shape

The graph snapshot accepts common PaperNexus graph fields:

```json
{
  "graph": {
    "nodes": [
      { "id": "method:reflective-prompts", "type": "Method", "name": "Reflective prompts" }
    ],
    "relationships": [
      { "sourceId": "challenge:bias", "targetId": "method:reflective-prompts", "type": "ADDRESSED_BY" }
    ]
  }
}
```

Tasks need a query and gold/relevant node ids:

```json
{
  "tasks": [
    {
      "id": "q1",
      "query": "mitigate confirmation bias in tutoring",
      "seed_node_ids": ["challenge:bias"],
      "gold_node_ids": ["method:reflective-prompts"]
    }
  ]
}
```

Summaries are optional for plumbing, but release-oriented GraphRAG runs must provide them:

```json
{
  "summaries": [
    {
      "id": "community:calibration",
      "node_ids": ["method:reflective-prompts"],
      "summary": "Reflective prompts mitigate confirmation bias in tutoring."
    }
  ]
}
```

## Metrics

The report records:

| Metric | Meaning |
| --- | --- |
| `retrieval_score_delta` | Graph-aware recall@k minus lexical baseline recall@k. |
| `graph_reasoning_score_delta` | Graph-aware MRR minus lexical baseline MRR. |
| `global_local_summary_delta` | Summary-aware graph recall@k minus local graph recall@k. |
| `storyline_coherence_delta` | Graph-ranked result coherence minus lexical baseline coherence. |

## Release Semantics

The report status becomes `passed` only when all of the following are true:

- at least one task has gold node ids,
- graph reasoning meets the configured delta thresholds,
- GraphRAG/global-local summaries are present and produce positive `global_local_summary_delta`,
- storyline coherence does not regress,
- `--release-evidence` is set,
- benchmark source, license scope, and role-specific input SHA-256 hashes are present for `graph_snapshot`, `graph_reasoning_tasks`, and `graphrag_summaries`,
- benchmark metadata does not look like fixture, synthetic, mock, toy, mini, example, demo, sample, or unit-test evidence.

Without `--release-evidence`, or with fixture-only inputs, the report remains `incomplete` even if the local metrics are positive. This keeps R8 aligned with the deep-research report without promoting deterministic placeholders to release-grade evidence.
