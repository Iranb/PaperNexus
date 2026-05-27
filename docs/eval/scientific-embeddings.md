# Scientific Embeddings Sidecar

`papernexus-scientific-embeddings-v1` is the artifact path for scientific dense retrieval and reranking experiments.

The first implementation is deliberately conservative. It owns the sidecar contracts and produces benchmark-consumable dense scores, but the default backend is deterministic token hashing. That backend is useful for plumbing, local regression tests, and fixed-corpus benchmark integration. It is not SPECTER2, SciRepEval, OAG-Bench, or GraphRAG-Bench release evidence.

## Command

```bash
npm run index:scientific-embeddings -- \
  --benchmark-path artifacts/retrieval/fixed-corpus.json \
  --output-dir artifacts/scientific-embeddings/run-001 \
  --run-id run-001 \
  --dimension 128 \
  --top-k 100 \
  --dataset-source "frozen retrieval benchmark snapshot" \
  --license-scope "internal evaluation"
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `dense-scores.json` | `fixed-corpus-dense-scores-v1` rankings consumable by `benchmark-retrieval` dense/hybrid modes. |
| `embedding-index.json` | Local query/document vector index with normalized vectors and provenance. |
| `manifest.json` | Run metadata, diagnostics, release-gate status, and artifact paths. |

## Fixed-Corpus Retrieval

Use the generated dense scores with the existing retrieval benchmark:

```bash
papernexus benchmark-retrieval artifacts/retrieval/fixed-corpus.json \
  --evaluation-mode fixed-corpus \
  --fixed-corpus-retrieval-mode dense \
  --fixed-corpus-dense-scores artifacts/scientific-embeddings/run-001/dense-scores.json \
  --k 10,100 \
  --output artifacts/retrieval/scientific-dense-run-001
```

Hybrid lexical+dense evaluation uses the same dense score artifact:

```bash
papernexus benchmark-retrieval artifacts/retrieval/fixed-corpus.json \
  --evaluation-mode fixed-corpus \
  --fixed-corpus-retrieval-mode hybrid \
  --fixed-corpus-dense-scores artifacts/scientific-embeddings/run-001/dense-scores.json
```

## External Embeddings

External vectors can be supplied when a Python sidecar or model runner has already produced embeddings:

```bash
npm run index:scientific-embeddings -- \
  --benchmark-path artifacts/retrieval/fixed-corpus.json \
  --embedding-source artifacts/specter2-sidecar/vectors.json \
  --output-dir artifacts/scientific-embeddings/specter2-run-001 \
  --run-id specter2-run-001 \
  --model specter2 \
  --method external-scientific-embedding-vectors \
  --dataset-source "SciRepEval task snapshot id" \
  --license-scope "dataset/model license summary"
```

Expected JSON shape:

```json
{
  "documents": [
    { "documentId": "d1", "embedding": [0.1, 0.2, 0.3] }
  ],
  "queries": [
    { "queryId": "q1", "embedding": [0.2, 0.1, 0.4] }
  ]
}
```

The loader also accepts `id`, `title`, `query`, `text`, and common paper id aliases as vector keys. Vectors are normalized before scoring.

## Release Semantics

The manifest intentionally separates artifact readiness from release evidence:

| Backend | `releaseGateStatus` | Meaning |
| --- | --- | --- |
| Deterministic token hash | `incomplete` | Contract and benchmark plumbing only. Not release-grade scientific representation evidence. |
| External vectors without source/license/model metadata | `incomplete` | Vectors exist, but provenance is insufficient. |
| External vectors with source/license/model metadata | `ready_for_evaluation` | Ready to run SciRepEval/OAG/GraphRAG-style gates. Still not a pass until those gates produce passing reports. |

Generate `R4` release evidence only after running the fixed-corpus suite over lexical, dense, and hybrid modes:

```bash
npm run eval:scientific-embedding-release-evidence -- \
  --output-dir artifacts/scientific-embedding-release-evidence/specter2-run-001 \
  --scientific-embedding-manifest artifacts/scientific-embeddings/specter2-run-001/manifest.json \
  --retrieval-suite-report artifacts/fixed-corpus-retrieval-suite/specter2-run-001/report.json \
  --require-passed
```

This keeps the deep-research alignment boundary explicit: the sidecar contract now exists, but real SPECTER2/SciRepEval/OAG/GraphRAG benchmark artifacts are still required before `R4` can pass. Graph reasoning evidence remains a separate `E5` requirement.
