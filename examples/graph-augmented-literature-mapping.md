# Graph-Augmented Literature Mapping for Biomedical Discovery

Ada Lin, Marco Rivera

## Abstract

We present a serverless workflow for literature mapping that converts PDF papers into markdown, builds a local knowledge graph, and supports evidence tracing without a central database. Our graph connects papers, sections, chunked claims, concepts, and references so researchers can inspect methodological overlap and citation structure quickly.

## Introduction

Biomedical teams often explore hundreds of papers before forming an experiment plan. Standard retrieval surfaces text snippets, but it does not preserve research flow, citation links, or concept neighborhoods. We therefore construct a local knowledge graph that keeps paper structure, concept mentions, and cross-paper reference links aligned.

## Method

The system uses markdown conversion, section parsing, chunking, concept extraction, and graph construction. It emphasizes knowledge graph organization, citation impact, and reusable local artifacts. In our experiments, the graph made retrieval augmented experiment planning more transparent and easier to audit.

## Results

Researchers used the graph to discover method clusters, trace evidence behind claims, and compare experiment design decisions. The graph also exposed repeated references to retrieval augmented experiment planning strategies from prior work [1].

## References

[1] Lee, Mina. 2024. Retrieval-Augmented Experiment Planning with Lab Notebooks. Journal of Scientific Automation.
[2] Patel, R. 2023. Local Knowledge Graphs for Evidence Synthesis. Computational Biology Review.
