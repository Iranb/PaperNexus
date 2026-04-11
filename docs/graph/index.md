# Graph Overview

PaperNexus builds a **multilayer research graph** rather than a flat document index.

## Core Graph Purpose

The graph is designed to support both:

- paper-centered inspection
- concept-centered reasoning across many papers

That means the graph has to preserve paper provenance while also exposing reusable conceptual structure such as problems, methods, questions, mechanisms, takeaways, and challenges.

## Main Node Families

The graph schema includes several families of node types:

### Document And Corpus

- `Corpus`
- `Paper`

These anchor everything else.

### Problem And Reasoning

- `Problem`
- `ResearchQuestion`
- `Challenge`
- `ResearchGoal`

These represent the “what remains unresolved” side of the graph.

### Method And Mechanism

- `Method`
- `AbstractMechanism`

This is where PaperNexus starts to become useful for cross-domain transfer instead of just paper search.

### Evidence And Evaluation

- `Claim`
- `Finding`
- `Evidence`
- `EvidenceSnippet`
- `Dataset`
- `Benchmark`
- `Metric`

These ground the graph in what papers actually reported.

### Future And Ideation

- `Takeaway`
- `IdeaFragment`
- `FutureDirection`

These layers support higher-order analysis such as bridge retrieval, research ideas, and catalyst-style ideation.

## Core Relationship Families

The graph is not only typed by nodes; edge families are equally important. The practical edge groups are:

- containment and corpus membership
- paper-to-problem and paper-to-method projection
- evidence grounding and evaluation
- challenge abstraction and decomposition
- takeaway and idea-fragment transfer
- transferable and compatibility edges across concepts

The full compatibility matrix is generated in the [Graph Schema Reference](/reference/generated/graph-schema), but the key idea is simple: PaperNexus tries to keep graph edges semantically constrained so higher-order traversal is reliable.

## Layer Model

Node types are grouped into graph layers such as:

- document
- problem
- question
- challenge
- method
- mechanism
- claim
- takeaway
- idea
- constraint
- evidence
- evaluation
- future
- goal

This layer model matters because query, context, impact, and brainstorming operations can restrict traversal to intra-layer or cross-layer paths.

## What Makes The Graph More Than A Search Index

PaperNexus goes beyond flat semantic retrieval by adding:

- compatibility-constrained edge types
- domain and mechanism abstractions
- challenge and takeaway layers
- transferable edges
- bridge-native retrieval
- structural analogy
- interdisciplinary potential ranking

Those capabilities are what make the graph useful for research reasoning rather than keyword lookup alone.

## Innovation Discovery View

The graph can also be interpreted as an innovation-discovery substrate.

In that mode, the important objects are not only papers and keywords, but potential new links such as:

- `Problem -> Method`
- `Challenge -> AbstractMechanism`
- `Limitation -> Takeaway`
- `Domain -> Transferable method`
- `Evidence -> Research direction`

The system already supports several ingredients for this style of analysis:

- typed heterogeneous graph structure
- domain distance and bridge profiles
- mechanism abstraction
- challenge decomposition
- takeaway and idea-fragment nodes
- evidence-grounded path tracing
- catalyst and brainstorming views

The Chinese review page linked below summarizes the broader research literature behind knowledge-graph-based innovation discovery and how it maps onto PaperNexus.

## Provenance And Grounding

A key design rule is that higher-level abstractions should still point back to paper evidence.

That is why the graph stores:

- paper-local semantic snapshots before commit
- evidence and evidence-snippet nodes
- support counts and supporting-paper fields on abstract mechanisms

The graph is allowed to abstract, but it should not become detached from papers.

## Derived Graph Structures

Several useful structures are not entered manually by users. They are derived from the graph and refreshed through the pipeline:

- domain taxonomy
- domain distance matrix
- mechanism support and provenance
- transferable edges
- lite graph token indices

These derived structures are part of the practical contract of the system, because search and ideation depend on them being refreshed correctly after incremental updates.

## Read Next

- [Cross-Domain Intelligence](/graph/cross-domain-intelligence)
- [KG Innovation Discovery Review](/graph/knowledge-graph-innovation-discovery-review.zh-CN)
- [Generated Graph Schema Reference](/reference/generated/graph-schema)
