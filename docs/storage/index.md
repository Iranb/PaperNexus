# Storage Overview

PaperNexus persists more than just one graph file. The storage model is what makes resumability, queue recovery, and incremental refresh practical.

## Main Persistent Artifacts

Each corpus maintains several classes of stored state:

- markdown cache
- semantic snapshots
- source manifest
- authoritative graph
- lite graph
- corpus metadata
- import queue state
- enhancement queue state
- authoritative sync queue state
- registry entries

## Typical Corpus Layout

The exact layout varies by corpus root, but conceptually you should expect:

```text
index-store/
  <corpus>/
    graph.json or graph.kuzu
    meta.json
    sources.json
    staging/
    snapshots/
    markdown/
    imports/
    enhancements/
    authoritative-sync/
    lite/
```

The important design point is that not all of these files serve the same audience. Some are for build resumability, some are for interactive reads, and some are purely worker-facing.

## Why So Many Files Exist

The storage model is intentionally decomposed because each artifact answers a different operational question.

- markdown cache answers “do I need to parse the PDF again?”
- semantic snapshot answers “do I need to rerun extraction?”
- source manifest answers “which sources currently define this corpus?”
- authoritative graph answers “what is the full source of truth?”
- lite graph answers “what should interactive reads and search use?”
- queue stores answer “what background work is still in flight?”

## Lite Graph

The lite graph is a materialized view optimized for fast read access, search token lookups, and incremental delta application. It is not an unrelated second graph model; it is a derivative optimized for responsiveness.

## Corpus Meta

`meta.json` is more than a count summary. It now also carries derived graph metadata such as persisted domain distance information so those higher-order structures survive incremental update paths.

## Incremental Consistency

Recent work ensures that derived graph structures are refreshed not only during full rebuilds but also during:

- fast commit
- authoritative sync
- graph mutation writeback

That closes one of the common consistency gaps where lite state could be fresher than higher-order metadata.

## Storage Design Tradeoff

PaperNexus favors **more explicit files with narrower responsibility** over a single opaque blob. That increases the number of artifacts, but it makes the system dramatically easier to recover, inspect, and incrementally refresh.

## Read Next

- [Generated Module Map](/reference/generated/module-map)
- [Generated Graph Schema](/reference/generated/graph-schema)
