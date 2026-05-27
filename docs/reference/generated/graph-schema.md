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
| ReviewLayer | `ReviewLayer` |
| StoryLayer | `StoryLayer` |
| HypothesisLayer | `HypothesisLayer` |
| ArtifactLayer | `ArtifactLayer` |
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
| `ContributionClaim` | `ClaimLayer` |
| `NoveltyClaim` | `ClaimLayer` |
| `Finding` | `ClaimLayer` |
| `Method` | `MethodLayer` |
| `ResearchQuestion` | `QuestionLayer` |
| `Challenge` | `ChallengeLayer` |
| `AbstractMechanism` | `MechanismLayer` |
| `CitationContext` | `EvidenceLayer` |
| `ReviewAspect` | `ReviewLayer` |
| `ReviewConcern` | `ReviewLayer` |
| `StoryBeat` | `StoryLayer` |
| `Hypothesis` | `HypothesisLayer` |
| `FalsificationPlan` | `HypothesisLayer` |
| `MultimodalAsset` | `ArtifactLayer` |
| `ProvenanceRecord` | `ArtifactLayer` |
| `VersionedArtifact` | `ArtifactLayer` |
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
| `HAS_CITATION_INTENT` |
| `CITES_FOR_BASELINE` |
| `CITES_FOR_METHOD` |
| `CITES_FOR_CONTRAST` |
| `SUPPORTS_CLAIM` |
| `DISPUTES_CLAIM` |
| `REFUTES_CLAIM` |
| `QUALIFIES_CLAIM` |
| `RAISES_CONCERN` |
| `ADDRESSES_CONCERN` |
| `FORMS_BEAT` |
| `PRECEDES_BEAT` |
| `TESTED_BY` |
| `HAS_FALSIFICATION_PLAN` |
| `DERIVED_FROM_VERSION` |
| `EXTRACTED_FROM_FIGURE` |
| `EXTRACTED_FROM_TABLE` |
| `EXTRACTED_FROM_FORMULA` |
| `VALID_DURING` |
| `HAS_UNCERTAINTY` |
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
| `CONTAINS` | `Corpus` | `Paper`, `Domain`, `Problem`, `Claim`, `ContributionClaim`, `NoveltyClaim`, `Finding`, `Method`, `ResearchQuestion`, `Challenge`, `AbstractMechanism`, `CitationContext`, `ReviewAspect`, `ReviewConcern`, `StoryBeat`, `Hypothesis`, `FalsificationPlan`, `MultimodalAsset`, `ProvenanceRecord`, `VersionedArtifact`, `Dataset`, `Benchmark`, `Metric`, `Limitation`, `Assumption`, `Evidence`, `EvidenceSnippet`, `Takeaway`, `IdeaFragment`, `FutureDirection`, `ResearchGoal` |
| `CONTAINS` | `Paper` | `Evidence` |
| `SOLVES` | `Paper` | `Problem` |
| `USES` | `Paper` | `Method` |
| `EVALUATES_ON` | `Paper` | `Dataset` |
| `BENCHMARKED_ON` | `Paper` | `Benchmark` |
| `BENCHMARKED_ON` | `Claim`, `Finding`, `Evidence` | `Benchmark` |
| `REPORTS` | `Paper` | `Metric` |
| `REPORTS_FINDING` | `Paper` | `Finding` |
| `CLAIMS` | `Paper` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `HAS_LIMITATION` | `Paper`, `Problem` | `Limitation` |
| `ASSUMES` | `Paper` | `Assumption` |
| `SUGGESTS_FUTURE` | `Paper` | `FutureDirection` |
| `SUPPORTED_BY` | `Claim`, `ContributionClaim`, `NoveltyClaim` | `Evidence`, `EvidenceSnippet`, `Finding`, `CitationContext` |
| `SUPPORTS_CLAIM` | `Evidence`, `EvidenceSnippet`, `CitationContext` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `DISPUTES_CLAIM` | `Evidence`, `EvidenceSnippet`, `CitationContext`, `ReviewConcern` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `REFUTES_CLAIM` | `Evidence`, `EvidenceSnippet`, `CitationContext`, `ReviewConcern` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `QUALIFIES_CLAIM` | `Evidence`, `EvidenceSnippet`, `CitationContext`, `ReviewConcern` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `FALSIFIED_BY` | `Finding`, `Claim`, `ContributionClaim`, `NoveltyClaim`, `Hypothesis` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Finding`, `FalsificationPlan` |
| `OBSERVED_ON` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Finding`, `Evidence` | `Dataset` |
| `MEASURED_BY` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Finding`, `Evidence` | `Metric` |
| `APPLIES_TO` | `Method` | `Problem` |
| `TRANSFERABLE_TO` | `Problem`, `ResearchQuestion`, `Challenge`, `Method`, `Takeaway`, `IdeaFragment`, `Limitation`, `Assumption` | `Problem`, `ResearchQuestion`, `Challenge`, `Method`, `Takeaway`, `IdeaFragment`, `Limitation`, `Assumption` |
| `REQUIRES` | `Method` | `Assumption` |
| `DEPENDS_ON` | `Method`, `Claim`, `ContributionClaim`, `NoveltyClaim`, `Hypothesis`, `Finding` | `Assumption`, `Dataset`, `Benchmark`, `Metric` |
| `FAILS_UNDER` | `Method`, `Claim`, `ContributionClaim`, `NoveltyClaim`, `Hypothesis`, `Finding` | `Assumption`, `Dataset`, `Benchmark` |
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
| `CONTRADICTS` | `Claim`, `ContributionClaim`, `NoveltyClaim` | `Claim`, `ContributionClaim`, `NoveltyClaim` |
| `HAS_CITATION_INTENT` | `CitationContext` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Method` |
| `CITES_FOR_BASELINE` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Method` | `Paper` |
| `CITES_FOR_METHOD` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Method` | `Paper` |
| `CITES_FOR_CONTRAST` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Method` | `Paper` |
| `RAISES_CONCERN` | `ReviewAspect`, `ReviewConcern` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `StoryBeat`, `FalsificationPlan` |
| `ADDRESSES_CONCERN` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Method`, `FalsificationPlan` | `ReviewConcern` |
| `FORMS_BEAT` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `Challenge`, `Takeaway`, `ReviewConcern` | `StoryBeat` |
| `PRECEDES_BEAT` | `StoryBeat` | `StoryBeat` |
| `TESTED_BY` | `Hypothesis`, `Claim`, `ContributionClaim`, `NoveltyClaim` | `FalsificationPlan`, `Benchmark`, `Dataset` |
| `HAS_FALSIFICATION_PLAN` | `Hypothesis`, `Claim`, `ContributionClaim`, `NoveltyClaim` | `FalsificationPlan` |
| `DERIVED_FROM_VERSION` | `VersionedArtifact`, `Claim`, `ContributionClaim`, `NoveltyClaim` | `VersionedArtifact`, `Paper`, `ProvenanceRecord` |
| `EXTRACTED_FROM_FIGURE` | `MultimodalAsset` | `EvidenceSnippet`, `CitationContext`, `Claim`, `ContributionClaim` |
| `EXTRACTED_FROM_TABLE` | `MultimodalAsset` | `EvidenceSnippet`, `CitationContext`, `Claim`, `ContributionClaim` |
| `EXTRACTED_FROM_FORMULA` | `MultimodalAsset` | `EvidenceSnippet`, `CitationContext`, `Claim`, `ContributionClaim` |
| `VALID_DURING` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `CitationContext` | `VersionedArtifact`, `ProvenanceRecord` |
| `HAS_UNCERTAINTY` | `Claim`, `ContributionClaim`, `NoveltyClaim`, `ReviewConcern`, `StoryBeat` | `Evidence`, `ProvenanceRecord` |
| `CITES` | `Paper` | `Paper` |
| `LEADS_TO` | `Method`, `Finding`, `Claim` | `ResearchGoal`, `Problem` |
| `BLOCKED_BY` | `ResearchGoal`, `Problem`, `Method` | `Limitation`, `Assumption`, `Problem` |
