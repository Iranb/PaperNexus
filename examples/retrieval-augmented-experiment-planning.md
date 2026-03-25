# Retrieval-Augmented Experiment Planning with Lab Notebooks

Mina Lee, Tomas Hsu

## Abstract

This paper studies how retrieval augmented generation and knowledge graph summaries can support experiment planning from fragmented lab notebooks. We connect notebook evidence, methods, and benchmark outcomes with a local graph representation that can be explored without a server.

## Related Work

Graph-augmented literature mapping has shown that local graph neighborhoods help scientists compare claims, methods, and references across papers. Prior biomedical discovery workflows also point to the value of explicit citation graphs.

## Method

Our approach builds a retrieval layer over notebook passages and then links those passages to graph concepts such as experiment planning, knowledge graph curation, and biomedical discovery. We also encode reference edges to prior literature, including Graph-Augmented Literature Mapping for Biomedical Discovery (Lin and Rivera, 2025).

## Discussion

The strongest gains appeared when users could move from a retrieved paragraph to the paper section, then to supporting references, then to related concepts. This made evidence tracing substantially easier than flat semantic search.

## References

[1] Lin, Ada and Rivera, Marco. 2025. Graph-Augmented Literature Mapping for Biomedical Discovery. Workshop on Research Infrastructure.
[2] Gomez, Irene. 2022. Auditable Experiment Design Systems. Research Engineering Letters.
