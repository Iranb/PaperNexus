---
name: papernexus-idea-catalyst
description: Use this skill when the goal is to decompose a research problem, abstract it into domain-agnostic challenges, search the local PaperNexus KG for interdisciplinary solutions, and either produce brainstorming ideas or output a data-ingestion requisition when the KG is data-starved. Based on the IDEA-CATALYST framework (2603.12226v1).
---

# PaperNexus IDEA-CATALYST

Use this skill when the task is: given a research problem statement, automatically decompose it, abstract it, search the **local** PaperNexus Knowledge Graph for cross-domain solutions, and produce either brainstorming ideas or a precise data-ingestion requisition.

## When To Use

- The user provides a research problem statement `p` and a target domain name.
- The goal is interdisciplinary ideation grounded in **existing KG data only**.
- The user wants to know whether the KG has enough cross-domain material to brainstorm, or needs more papers.

## Core Principle: Data Evaluator

This skill does **not** hallucinate ideas from parametric knowledge alone. It acts as a **Data Evaluator**:

- If the local KG contains sufficient relevant cross-domain data → generate brainstorming ideas.
- If the local KG is data-starved → halt generation and output a highly specific **Investigation Requisition** to guide future data ingestion.

## Prerequisites

- A running PaperNexus `serve` instance with an accessible HTTP API.
- Connection settings resolved: `PAPERNEXUS_API_BASE_URL`, `PAPERNEXUS_API_TOKEN`, `PAPERNEXUS_CORPUS` (or equivalents via `--api-base`, `--token`, `--corpus`).
- The LLM provider configured in `config.json` (the pipeline uses PaperNexus LLM for abstraction and synthesis phases).

## Entry Point

```bash
python3 SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py \
  --api-base "http://<host>:4821" \
  --corpus "<corpus>" \
  --problem "Your research problem statement here" \
  --target-domain "Computer Science" \
  [--num-questions 5] \
  [--num-source-domains 3] \
  [--relevance-threshold 3] \
  [--limit 8] \
  [--json]
```

## Execution Pipeline

### Phase 0: Target Domain Critical Reasoning (Local Gap Analysis)

1. **Decompose** the research problem `p` into core research questions using the LLM.
2. **Query the local KG** for papers and nodes in the target domain (`D_target`) via `POST /api/query`, `POST /api/context`, and `POST /api/brainstorm`.
3. **Identify unresolved challenges** by analyzing KG coverage vs. the decomposed questions.
4. **Early starvation check**: If even the target domain has essentially no data in the local KG (< 2 relevant concept nodes), trigger Data Starvation immediately.

### Phase 1: Domain-Agnostic Abstraction

1. For each unresolved challenge identified in Phase 0, translate it into a **domain-agnostic** question using the LLM.
   - Example: "How to prevent catastrophic forgetting in continual learning" → "How to prevent memory overwriting in a system that must keep learning without forgetting old patterns"
2. This dual representation (domain-specific + domain-agnostic) is the key to cross-domain bridging.

### Phase 2: Source Domain Creative Exploration (Matchmaking)

1. Select up to N external source domains (`D_source`) based on:
   - **Analogy** (e.g., how groups coordinate in Sociology vs. agent coordination)
   - **Shared Mechanisms** (e.g., adaptation through feedback in Psychology vs. RL)
   - **Transferable Principles** (e.g., uncertainty reasoning in Cognitive Science vs. ML)
2. Must **strictly exclude** the target domain and its close neighbors.
3. Generate local KG search queries/keywords for each `D_source` using the LLM.

### Phase 3: Local Data Sufficiency Evaluation (The Gatekeeper)

1. **Local Retrieval**: Query the local KG for each selected `D_source` using the generated keywords via `POST /api/query` and `POST /api/context`.
2. **Relevance Filter**: Evaluate retrieved nodes against the domain-agnostic question. Discard irrelevant nodes using LLM judgment.
3. **Data Sufficiency Check (CRITICAL)**:
   - **Threshold Rule**: To proceed to brainstorming, the system MUST have found **at least 1 external domain** containing **at least 3 highly relevant conceptual nodes/papers** in the local KG.
   - **Branch A (Sufficient)**: If threshold met → extract interdisciplinary insights → proceed to Phase 4.
   - **Branch B (Data Starved)**: If threshold NOT met → **HALT execution**. Do NOT force hallucinated ideas. Proceed to Phase 5 (Requisition Generation).

### Phase 4: Synthesis & Scoring (Only if Branch A)

1. **Translate** cross-domain insights back to target domain terminology using the LLM.
2. **Generate** Top 3 Ideas and rank by Novelty and Usefulness.
3. Output in the **Idea Fragment** format.

### Phase 5: Investigation Requisition (Only if Branch B)

1. Based on the failed Phase 2/3 attempts, outline exactly what external domains, specific theories, and keyword searches need to be fetched via a structured **Requisition Report**.

## Output Format

The script outputs a structured report with these exact sections:

```text
[0. Local KG Target Analysis]
- Macro Goal: ...
- Local KG Target Challenge: ...

[1. Domain-Agnostic Abstraction]
- Jargon-Free Abstract Challenge: ...

[2. Cross-Domain Matchmaking Plan]
- Targeted External Domains: [A, B, C] and corresponding search terms.

[3. Local Data Sufficiency Evaluation]
- Retrieval Results: Local KG found X valid nodes in [Domain A], Y nodes in [Domain B]...
- Evaluation Conclusion: [Trigger Brainstorming / Trigger Investigation Requisition]
```

Then **ONLY ONE** of:

```text
[4. Final Brainstorming Ideas (If Data is Sufficient)]
### 💡 Idea 1: [Title]
- Inspiration Source: ...
- Integration Approach: ...
```

OR:

```text
[5. Data Ingestion Requisition (If Data is Starved)]
> ⚠️ WARNING: Insufficient cross-domain data in the Local KG.
- Urgent Domain 1: [Domain Name]
  - Core Concepts/Theories to Retrieve: [Specific Concept]
  - Suggested Search Keywords: [Keyword 1, Keyword 2...]
  - Rationale: [How this data is expected to solve the abstract challenge]
```

## JSON Output Schemas

### Investigation Requisition (Data Starvation)

```json
{
  "requisition_report": {
    "status": "DATA_STARVATION",
    "target_challenge": "The domain-agnostic challenge we were trying to solve",
    "missing_domains": ["Domain A", "Domain B"],
    "required_topics": [
      {
        "topic": "Specific mechanism or theory",
        "search_keywords": ["keyword1", "keyword2"],
        "reason": "Why we need papers on this topic"
      }
    ]
  }
}
```

### Idea Fragment (Success)

```json
{
  "idea_fragments": [
    {
      "rank": 1,
      "title": "Idea title",
      "target_challenge": "The unresolved challenge in D_target",
      "abstract_challenge": "The domain-agnostic version",
      "source_domain": "Psychology",
      "source_takeaways": [
        {
          "concept": "Metacontrol State Model",
          "mechanism": "How it works in the source domain",
          "source_papers": ["Paper title from KG"]
        }
      ],
      "integration_rationale": "How source insights address the target challenge",
      "novelty_score": 4.2,
      "usefulness_score": 3.8,
      "supporting_kg_nodes": ["node-id-1", "node-id-2"]
    }
  ]
}
```

## LLM Usage

This skill uses the PaperNexus LLM (configured in `config.json`) for three internal tasks:

1. **Problem decomposition** (Phase 0): Breaking the research problem into core questions.
2. **Domain-agnostic abstraction** (Phase 1): Translating challenges into jargon-free formulations.
3. **Cross-domain matchmaking** (Phase 2): Selecting source domains and generating search keywords.
4. **Relevance filtering** (Phase 3): Judging whether retrieved KG nodes are relevant to the abstract challenge.
5. **Synthesis** (Phase 4): Translating insights back and generating idea fragments.

The LLM calls go through the PaperNexus HTTP API's `/api/llm-generate` endpoint when available, or fall back to direct provider calls using the same config.

## Graph API Usage

The script uses these PaperNexus APIs (all require `Authorization: Bearer <token>`):

| Phase | API | Purpose |
|-------|-----|---------|
| 0 | `POST /api/query` | Find target domain papers/nodes |
| 0 | `POST /api/context` | Get neighborhood of target concepts |
| 0 | `POST /api/brainstorm` | Get existing brainstorm view for target |
| 0 | `POST /api/evidence-chain` | Understand claim support structure |
| 2-3 | `POST /api/query` | Search KG for source domain concepts |
| 2-3 | `POST /api/context` | Get neighborhood of cross-domain nodes |
| 2-3 | `POST /api/impact` | Trace upstream/downstream connections |
| 4 | `POST /api/brainstorm-brief` | Get structured brainstorm summary |

## Important Rules

1. **Never hallucinate ideas** when the KG is data-starved. Output the Requisition instead.
2. **Never generate ideas from both Phase 4 and Phase 5**. Output exactly one.
3. **Strictly exclude the target domain** from source domain candidates.
4. **Ground all insights in actual KG node data**. Cite node IDs and paper titles from the KG.
5. **Use the brainstorm-quality node view** (`--node-view brainstorm`) when possible for higher signal anchors.

## Relationship to Other Skills

- **PaperNexusAgenticReasoning**: Use that skill for general stepwise research reasoning. Use **this** skill specifically when the goal is structured interdisciplinary ideation with the IDEA-CATALYST pipeline.
- **PaperNexus**: Use that skill for graph management, imports, and operational tasks. This skill assumes the graph is already built and queryable.

## Debugging

If the script reports DATA_STARVATION when you believe the KG has relevant data:

1. Check corpus name: `python3 SKILL/PaperNexus/scripts/pn_graph_query.py --api-base <url> --corpus <corpus> query "<topic>" --limit 8`
2. Check node types: Are there Problem, Method, Limitation nodes, or only Paper nodes?
3. Check brainstorm eligibility: Are nodes marked `brainstormEligible`?
4. Try broadening search terms or lowering the relevance threshold.
