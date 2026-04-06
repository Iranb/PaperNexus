# 🤖 Claude Code Implementation Plan: IDEA-CATALYST Agent (Local KG Version V5.0)

## 1. System Overview & Architecture
This system implements the IDEA-CATALYST framework for interdisciplinary scientific ideation, but is strictly constrained to operate over a **PaperNexus Knowledge Graph (KG)**. 

**Core Objective:** Make a skill，which decompose a target research problem, abstract it, and search the LOCAL KG for interdisciplinary solutions. 

**Crucial Adaptive Logic:** The Agent must act as a Data Evaluator. If the local KG contains sufficient relevant cross-domain data -> generate brainstorming ideas. If the local KG is data-starved -> halt generation and output a highly specific "Investigation Requisition" to guide future data ingestion.

The idea come from the paper in 2603.12226v1.md，you can check if you don't understand what i say!

---

## 2. Core Data Structures (JSON Schemas)
*(Claude Code: Implement these data schemas in your code)*

### 2.1 Investigation Requisition (Data Starvation Output)
If local graph data is insufficient, output this exact schema (represented as standard JSON):

    {
      "requisition_report": {
        "status": "DATA_STARVATION",
        "target_challenge": "The domain-agnostic challenge we were trying to solve",
        "missing_domains": [
          "Domain A",
          "Domain B"
        ],
        "required_topics": [
          {
            "topic": "Specific mechanism or theory",
            "search_keywords": ["keyword1", "keyword2"],
            "reason": "Why we need papers on this topic to solve the challenge"
          }
        ]
      }
    }

### 2.2 Idea Fragment Output (Success Output)
*(Claude Code: Implement the standard Idea Fragment JSON Schema linking the target challenge, source takeaways, and integration rationale based on the IDEA-CATALYST paper).*

---

## 3. Execution Pipeline (Control Flow)

### Phase 0: Target Domain Critical Reasoning (Local Gap Analysis)
* **Step 0.1:** Decompose the initial research problem `p` into core questions.
* **Step 0.2:** Query the **LOCAL KG** for papers in the target domain (`D_target`).
* **Step 0.3:** Identify an unresolved challenge. *Check:* If even the target domain data is missing in the local KG, trigger Data Starvation immediately.

### Phase 1: Domain-Agnostic Abstraction
* **Step 1.1:** Translate the unresolved challenge into a `q_domain_agnostic` (e.g., "How to prevent memory overwriting in a system?").

### Phase 2: Source Domain Creative Exploration (Matchmaking)
* **Step 2.1:** Select 3 external source domains (`D_source`) based on Analogy, Shared Mechanisms, or Transferable Principles. (Must strictly exclude `D_target`).
* **Step 2.2:** Generate local KG search queries/keywords for each `D_source`.

### Phase 3: Local Data Sufficiency Evaluation (The Gatekeeper)
* **Step 3.1 (Local Retrieval):** Query the local KG for the 3 selected `D_source` using the generated keywords.
* **Step 3.2 (Relevance Filter):** Evaluate the retrieved nodes against `q_domain_agnostic`. Discard nodes that are irrelevant.
* **Step 3.3 (Data Sufficiency Check - CRITICAL):**
    * *Threshold Rule:* To proceed to brainstorming, the system MUST have found **at least 1 external domain** containing **at least 3 highly relevant conceptual nodes/papers** in the local KG.
    * *Branch A (Sufficient):* If threshold met, extract interdisciplinary insights and proceed to Phase 4.
    * *Branch B (Data Starved):* If threshold NOT met (i.e., local KG has no relevant papers for these domains, or too few), **HALT execution**. Do not force a hallucinated idea. Proceed immediately to Phase 5 (Requisition Generation).

### Phase 4: Synthesis & Scoring (Only if Branch A)
* **Step 4.1:** Translate cross-domain insights back to `D_target` terminology.
* **Step 4.2:** Generate Top 3 Ideas and rank by Novelty and Usefulness.

### Phase 5: Investigation Requisition (Only if Branch B)
* **Step 5.1:** Based on the failed Phase 2/3 attempts, outline exactly what external domains, specific theories, and keyword searches the human researchers (or web crawlers) need to fetch and add to the KG.

---

## 4. Required Output Format (Strict Text Template)

**[0. Local KG Target Analysis]**
- Macro Goal: ...
- Local KG Target Challenge: ...

**[1. Domain-Agnostic Abstraction]**
- Jargon-Free Abstract Challenge: ...

**[2. Cross-Domain Matchmaking Plan]**
- Targeted External Domains: [A, B, C] and corresponding search terms.

**[3. Local Data Sufficiency Evaluation]**
- Retrieval Results: Local KG found X valid nodes in [Domain A], Y nodes in [Domain B]...
- Evaluation Conclusion: [Trigger Brainstorming / Trigger Investigation Requisition]

*(Depending on the conclusion, output ONLY Section [4] OR Section [5]. NEVER output both.)*

**[4. Final Brainstorming Ideas (If Data is Sufficient)]**
### 💡 Idea 1: [Title]
- **Inspiration Source**: ...
- **Integration Approach**: ...

**[5. Data Ingestion Requisition (If Data is Starved)]**
> ⚠️ **WARNING: Insufficient cross-domain data in the Local KG. Unable to generate high-quality ideas. Please ingest literature based on the following requisition:**
- **Urgent Domain 1**: [Domain Name]
  - **Core Concepts/Theories to Retrieve**: [Specific Concept]
  - **Suggested Search Keywords**: [Keyword 1, Keyword 2...]
  - **Rationale**: [How this data is expected to solve the abstract challenge]