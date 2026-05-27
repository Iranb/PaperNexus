# Scientific Embedding Release Evidence

`papernexus-scientific-embedding-release-evidence-v1` wraps the scientific embedding manifest and fixed-corpus retrieval suite into the `R4` release-gate evidence record.

It is intentionally stricter than the sidecar manifest. A deterministic token-hash manifest or a fixture retrieval run can prove plumbing, but cannot pass `R4`.

## Command

```bash
npm run eval:scientific-embedding-release-evidence -- \
  --output-dir artifacts/scientific-embedding-release-evidence/run-001 \
  --run-id scientific-embedding-release-001 \
  --scientific-embedding-manifest artifacts/scientific-embeddings/specter2-run-001/manifest.json \
  --retrieval-suite-report artifacts/fixed-corpus-retrieval-suite/specter2-run-001/report.json \
  --require-passed
```

The command writes:

| Artifact | Purpose |
| --- | --- |
| `scientific-embedding-release-evidence.json` | Machine-readable `R4` evidence. |
| `scientific-embedding-release-evidence.md` | Human-readable requirement summary. |
| `manifest.json` | Lightweight pointer manifest for the evidence run. |

## Pass Criteria

`R4` passes only when all of the following are true:

| Gate | Requirement |
| --- | --- |
| External encoder | Scientific embedding manifest is `completed`, `ready_for_evaluation`, and not `deterministic-scientific-token-hash-v1`. |
| Provenance | Dataset source, license scope, SHA-256 input hashes, and role-specific hashes are present. |
| Manifest input roles | The embedding manifest hashes both `scientific_embedding_benchmark` and `scientific_embedding_source` inputs. |
| Retrieval input roles | The retrieval suite hashes `fixed_corpus_dataset`, `fixed_corpus_lexical_scores`, `fixed_corpus_dense_scores`, and `fixed_corpus_hybrid_scores` inputs. |
| Family coverage | Evidence text covers SPECTER2 or an equivalent scientific encoder, SciRepEval, OAG, and GraphRAG. |
| Retrieval modes | Fixed-corpus suite includes lexical, dense, and hybrid rows. |
| Comparable metrics | Primary metrics such as `ndcg@10`, `recall@10`, `hit@10`, `mrr@10`, `recall@100`, or `hit@100` exist across modes. |
| Dense/hybrid lift | Dense or hybrid improves over lexical on at least one primary metric. |
| Release provenance | Fixture, synthetic, mock, toy, mini, demo, sample, or test-only evidence remains incomplete by default. |

## Release-Gate Integration

Pass the full evidence report to the aggregate release gate:

```bash
npm run eval:idea-catalyst-release-gate -- \
  --scientific-embedding-evidence artifacts/scientific-embedding-release-evidence/run-001/scientific-embedding-release-evidence.json \
  --output-dir artifacts/idea-catalyst-release-gate/run-001
```

The aggregate gate consumes the wrapper report, not the raw embedding manifest. This keeps deterministic sidecar runs and real scientific embedding benchmark evidence separate.
