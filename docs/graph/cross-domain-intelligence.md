# Cross-Domain Intelligence

The most distinctive recent PaperNexus work sits above the base graph schema: domain reasoning, mechanism reasoning, challenge abstraction, takeaway extraction, bridge retrieval, structural analogy, and interdisciplinary ranking.

## Domain Layer

PaperNexus now derives a graph-native domain taxonomy instead of treating domain labels as loose tags only.

This supports:

- target-domain status inspection
- cross-domain bridge retrieval
- domain distance measurement
- filtering out overly proximal source domains when needed

The derived `domainDistanceMatrix` is now persisted into corpus metadata and lite state so incremental updates do not lose higher-order domain structure.

## Mechanism Layer

`AbstractMechanism` nodes represent cross-paper mechanisms rather than paper-specific method names.

Mechanisms carry support and provenance signals such as:

- supporting paper count
- supporting domains
- supporting source nodes
- aliases and normalized forms

This is the substrate for structural transfer. Without it, cross-domain matching degenerates into topic similarity.

## ResearchQuestion, Challenge, Takeaway, IdeaFragment

PaperNexus now includes explicit graph layers for:

- `ResearchQuestion`
- `Challenge`
- `Takeaway`
- `IdeaFragment`
- `EvidenceSnippet`

These are important because they bridge the gap between “a paper said X” and “this graph can reason about transferable scientific structure.”

## Bridge Retrieval

Bridge retrieval looks for promising cross-domain paths from a target domain and challenge to external mechanisms, takeaways, and related concepts.

The current system already supports a graph-native fallback version that uses:

- challenge-aware retrieval text
- domain distance
- shared mechanisms
- transferable concept edges

## Structural Analogy

Structural analogy goes beyond word overlap. It attempts to align motifs such as:

- challenge to takeaway
- takeaway to idea transfer
- mechanism transfer
- evidence grounding

This is an intentionally graph-native step. It uses typed structure to determine whether an external domain is analogous in a way that is worth recontextualizing.

## Interdisciplinary Potential Ranking

Ranking is not just “which result sounds interesting.” It is meant to estimate which external domains are promising for further synthesis.

Current ranking signals include:

- novelty proxy
- grounding score
- challenge coverage
- story completeness proxy
- analogy score

## Practical Meaning

These layers make PaperNexus suitable for:

- challenge-aware research lookup
- cross-domain bridge analysis
- catalyst-style ideation
- identifying promising source domains for further exploration

They do **not** mean PaperNexus is now a full autonomous research workflow. The graph engine produces structured analytical context. Storyline orchestration and broader scientific workflow planning still belong outside this repository.
