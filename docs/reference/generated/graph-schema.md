# Graph Schema Reference

This page is generated from [`src/core/graph/schema.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/schema.js) and [`src/core/graph/rules.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/rules.js). It reflects the actual node, layer, edge, and compatibility definitions used by the graph engine.

## Graph Layers

| Layer | Identifier |
| --- | --- |
| CorpusLayer | `CorpusLayer` |
| DocumentLayer | `DocumentLayer` |
| DomainLayer | `DomainLayer` |
| ProblemLayer | `ProblemLayer` |
| QuestionLayer | `QuestionLayer` |
| ChallengeLayer | `ChallengeLayer` |
| MethodLayer | `MethodLayer` |
| MechanismLayer | `MechanismLayer` |
| ClaimLayer | `ClaimLayer` |
| TakeawayLayer | `TakeawayLayer` |
| IdeaLayer | `IdeaLayer` |
| ConstraintLayer | `ConstraintLayer` |
| EvidenceLayer | `EvidenceLayer` |
| EvaluationLayer | `EvaluationLayer` |
| FutureLayer | `FutureLayer` |
| GoalLayer | `GoalLayer` |

## Node Types

| Node Type | Layer |
| --- | --- |
| `Corpus` | `CorpusLayer` |
| `Paper` | `DocumentLayer` |
| `Domain` | `DomainLayer` |
| `Problem` | `ProblemLayer` |
| `Claim` | `ClaimLayer` |
| `Finding` | `ClaimLayer` |
| `Method` | `MethodLayer` |
| `ResearchQuestion` | `QuestionLayer` |
| `Challenge` | `ChallengeLayer` |
| `AbstractMechanism` | `MechanismLayer` |
| `Dataset` | `EvaluationLayer` |
| `Benchmark` | `EvaluationLayer` |
| `Metric` | `EvaluationLayer` |
| `Limitation` | `ConstraintLayer` |
| `Assumption` | `ConstraintLayer` |
| `Evidence` | `EvidenceLayer` |
| `EvidenceSnippet` | `EvidenceLayer` |
| `Takeaway` | `TakeawayLayer` |
| `IdeaFragment` | `IdeaLayer` |
| `FutureDirection` | `FutureLayer` |
| `ResearchGoal` | `GoalLayer` |

## Edge Types

| Edge Type |
| --- |
| `CONTAINS` |
| `BELONGS_TO_DOMAIN` |
| `STUDIED_IN` |
| `ORIGINATED_IN` |
| `SOLVES` |
| `USES` |
| `DECOMPOSES_TO` |
| `HAS_OPEN_CHALLENGE` |
| `ABSTRACTS_TO` |
| `INSTANTIATES` |
| `IMPLEMENTS` |
| `CONSTRAINS` |
| `EVALUATES_ON` |
| `BENCHMARKED_ON` |
| `REPORTS` |
| `REPORTS_FINDING` |
| `CLAIMS` |
| `HAS_LIMITATION` |
| `ASSUMES` |
| `SUGGESTS_FUTURE` |
| `SUPPORTED_BY` |
| `SUPPORTED_BY_SNIPPET` |
| `OBSERVED_ON` |
| `MEASURED_BY` |
| `HAS_TAKEAWAY` |
| `RECONTEXTUALIZES_TO` |
| `ADDRESSES` |
| `APPLIES_TO` |
| `TRANSFERABLE_TO` |
| `REQUIRES` |
| `DEPENDS_ON` |
| `FAILS_UNDER` |
| `HAS_GAP` |
| `RELATED_TO` |
| `SIMILAR_TO` |
| `COMPATIBLE_WITH` |
| `COMBINES_WITH` |
| `MAY_BE_ADDRESSED_BY` |
| `CONTRADICTS` |
| `CITES` |
| `EXTENDS_METHOD` |
| `IMPROVES_METHOD` |
| `REPLACES_METHOD` |
| `ADAPTS_METHOD` |
| `USES_COMPONENT_METHOD` |
| `COMPARES_METHOD` |
| `BACKGROUND_METHOD` |
| `VARIANT_OF` |
| `SPECIALIZES` |
| `COMPONENT_OF` |
| `LEADS_TO` |
| `BLOCKED_BY` |
| `FALSIFIED_BY` |

## Relation Compatibility Rules

| Relation | Allowed Sources | Allowed Targets |
| --- | --- | --- |
| `CONTAINS` | `Corpus` | `Paper`, `Domain`, `Problem`, `Claim`, `Finding`, `Method`, `ResearchQuestion`, `Challenge`, `AbstractMechanism`, `Dataset`, `Benchmark`, `Metric`, `Limitation`, `Assumption`, `Evidence`, `EvidenceSnippet`, `Takeaway`, `IdeaFragment`, `FutureDirection`, `ResearchGoal` |
| `CONTAINS` | `Paper` | `Evidence` |
| `SOLVES` | `Paper` | `Problem` |
| `USES` | `Paper` | `Method` |
| `EVALUATES_ON` | `Paper` | `Dataset` |
| `BENCHMARKED_ON` | `Paper` | `Benchmark` |
| `BENCHMARKED_ON` | `Claim`, `Finding`, `Evidence` | `Benchmark` |
| `REPORTS` | `Paper` | `Metric` |
| `REPORTS_FINDING` | `Paper` | `Finding` |
| `CLAIMS` | `Paper` | `Claim` |
| `HAS_LIMITATION` | `Paper`, `Problem` | `Limitation` |
| `ASSUMES` | `Paper` | `Assumption` |
| `SUGGESTS_FUTURE` | `Paper` | `FutureDirection` |
| `SUPPORTED_BY` | `Claim` | `Evidence`, `Finding` |
| `FALSIFIED_BY` | `Finding`, `Claim` | `Claim`, `Finding` |
| `OBSERVED_ON` | `Claim`, `Finding`, `Evidence` | `Dataset` |
| `MEASURED_BY` | `Claim`, `Finding`, `Evidence` | `Metric` |
| `APPLIES_TO` | `Method` | `Problem` |
| `TRANSFERABLE_TO` | `Problem`, `ResearchQuestion`, `Challenge`, `Method`, `Takeaway`, `IdeaFragment`, `Limitation`, `Assumption` | `Problem`, `ResearchQuestion`, `Challenge`, `Method`, `Takeaway`, `IdeaFragment`, `Limitation`, `Assumption` |
| `REQUIRES` | `Method` | `Assumption` |
| `DEPENDS_ON` | `Method`, `Claim`, `Finding` | `Assumption`, `Dataset`, `Benchmark`, `Metric` |
| `FAILS_UNDER` | `Method`, `Claim`, `Finding` | `Assumption`, `Dataset`, `Benchmark` |
| `HAS_GAP` | `Problem` | `Limitation` |
| `RELATED_TO` | `Problem`, `FutureDirection`, `Limitation`, `ResearchGoal` | `Problem`, `FutureDirection`, `Limitation`, `ResearchGoal` |
| `SIMILAR_TO` | `Method`, `Problem`, `Benchmark` | `Method`, `Problem`, `Benchmark` |
| `COMPATIBLE_WITH` | `Method` | `Method` |
| `COMBINES_WITH` | `Method` | `Method` |
| `EXTENDS_METHOD` | `Method` | `Method` |
| `IMPROVES_METHOD` | `Method` | `Method` |
| `REPLACES_METHOD` | `Method` | `Method` |
| `ADAPTS_METHOD` | `Method` | `Method` |
| `USES_COMPONENT_METHOD` | `Method` | `Method` |
| `COMPARES_METHOD` | `Method` | `Method` |
| `BACKGROUND_METHOD` | `Method` | `Method` |
| `VARIANT_OF` | `Method` | `Method` |
| `SPECIALIZES` | `Method` | `Method` |
| `COMPONENT_OF` | `Method` | `Method` |
| `MAY_BE_ADDRESSED_BY` | `Limitation` | `Method` |
| `CONTRADICTS` | `Claim` | `Claim` |
| `CITES` | `Paper` | `Paper` |
| `LEADS_TO` | `Method`, `Finding`, `Claim` | `ResearchGoal`, `Problem` |
| `BLOCKED_BY` | `ResearchGoal`, `Problem`, `Method` | `Limitation`, `Assumption`, `Problem` |
