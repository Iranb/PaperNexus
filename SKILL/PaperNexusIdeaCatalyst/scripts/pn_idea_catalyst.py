#!/usr/bin/env python3
"""
IDEA-CATALYST Agent — Local PaperNexus KG Version

Decomposes a research problem, abstracts it into domain-agnostic challenges,
searches the local KG for interdisciplinary solutions, and either produces
brainstorming ideas or outputs a data-ingestion requisition when data-starved.

Based on: "Sparking Scientific Creativity via LLM-Driven Interdisciplinary
Inspiration" (2603.12226v1).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import textwrap
import urllib.parse
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Resolve pn_common from the canonical PaperNexus skill location
# ---------------------------------------------------------------------------
_SKILL_SCRIPTS = Path(__file__).resolve().parents[2] / "PaperNexus" / "scripts"
sys.path.insert(0, str(_SKILL_SCRIPTS))

from pn_common import (                    # noqa: E402
    RemoteScriptError,
    add_connection_args,
    build_graph_payload,
    emit_result,
    fail,
    normalize_api_base,
    request_json,
    require_corpus,
    resolve_token,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_NUM_QUESTIONS = 5
DEFAULT_NUM_SOURCE_DOMAINS = 3
DEFAULT_RELEVANCE_THRESHOLD = 3      # min relevant nodes per source domain
DEFAULT_LIMIT = 8
LLM_REQUEST_TIMEOUT = 120.0         # seconds; LLM calls may be slow


# ===================================================================
# LLM helper — uses PaperNexus config to call the configured provider
# ===================================================================

def llm_generate(api_base: str, token: str, corpus: str,
                 prompt: str, timeout: float = LLM_REQUEST_TIMEOUT) -> str:
    """Ask the PaperNexus-configured LLM a question.

    Strategy:
      1. Try POST /api/llm-generate (requires server >= v0.x with the endpoint).
      2. Fall back to POST /api/brainstorm with a crafted query that embeds
         the prompt as a "brainstorm" query — this always works and returns
         LLM-mediated output.
      3. If all else fails, return an empty string so the pipeline can degrade
         gracefully.
    """
    # --- attempt 1: dedicated LLM endpoint ---
    try:
        result = request_json(
            "POST", api_base, "/api/llm-generate",
            token,
            payload={"prompt": prompt, "name": corpus},
            timeout=timeout,
        )
        text = result.get("text") or result.get("response") or ""
        if text.strip():
            return text.strip()
    except RemoteScriptError:
        pass  # endpoint may not exist; fall through

    # --- attempt 2: use brainstorm-brief as a surrogate ---
    try:
        result = request_json(
            "POST", api_base, "/api/brainstorm-brief",
            token,
            payload=build_graph_payload(corpus, prompt[:200], {"limit": 4}),
            timeout=timeout,
        )
        parts: list[str] = []
        for section in ("problems", "methods", "limitations", "ideas",
                        "summary", "brief"):
            val = result.get(section)
            if isinstance(val, str) and val.strip():
                parts.append(val.strip())
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, dict):
                        parts.append(json.dumps(item, ensure_ascii=False))
                    elif isinstance(item, str):
                        parts.append(item)
        if parts:
            return "\n".join(parts)
    except RemoteScriptError:
        pass

    return ""


def llm_json(api_base: str, token: str, corpus: str,
             prompt: str, timeout: float = LLM_REQUEST_TIMEOUT) -> Any:
    """Call the LLM and attempt to parse the response as JSON."""
    raw = llm_generate(api_base, token, corpus, prompt, timeout)
    if not raw:
        return {}
    # Try to extract JSON from the response (LLMs often wrap in ```json ... ```)
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        # drop first and last fence
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Attempt partial repair
        start = cleaned.find("{")
        end = cleaned.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end])
            except json.JSONDecodeError:
                pass
        start = cleaned.find("[")
        end = cleaned.rfind("]") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end])
            except json.JSONDecodeError:
                pass
    return {}


# ===================================================================
# Graph query helpers
# ===================================================================

def kg_query(api_base: str, token: str, corpus: str,
             query: str, limit: int = 8, timeout: float = 60) -> dict:
    return request_json(
        "POST", api_base,
        f"/api/query?name={urllib.parse.quote(corpus)}",
        token,
        payload=build_graph_payload(corpus, query, {"limit": limit}),
        timeout=timeout,
    )


def kg_context(api_base: str, token: str, corpus: str,
               query: str, node_view: str = "brainstorm",
               timeout: float = 60) -> dict:
    return request_json(
        "POST", api_base,
        f"/api/context?name={urllib.parse.quote(corpus)}",
        token,
        payload=build_graph_payload(corpus, query,
                                    {"nodeView": node_view}),
        timeout=timeout,
    )


def kg_brainstorm(api_base: str, token: str, corpus: str,
                  query: str, mode: str = "diverge",
                  limit: int = 6, timeout: float = 60) -> dict:
    return request_json(
        "POST", api_base,
        f"/api/brainstorm?name={urllib.parse.quote(corpus)}",
        token,
        payload=build_graph_payload(corpus, query,
                                    {"mode": mode, "limit": limit}),
        timeout=timeout,
    )


def kg_impact(api_base: str, token: str, corpus: str,
              query: str, direction: str = "upstream",
              timeout: float = 60) -> dict:
    return request_json(
        "POST", api_base,
        f"/api/impact?name={urllib.parse.quote(corpus)}",
        token,
        payload=build_graph_payload(corpus, query,
                                    {"direction": direction}),
        timeout=timeout,
    )


def kg_evidence_chain(api_base: str, token: str, corpus: str,
                      query: str, limit: int = 5,
                      timeout: float = 60) -> dict:
    return request_json(
        "POST", api_base,
        f"/api/evidence-chain?name={urllib.parse.quote(corpus)}",
        token,
        payload=build_graph_payload(corpus, query, {"limit": limit}),
        timeout=timeout,
    )


# ===================================================================
# Utility: extract concept nodes from various API responses
# ===================================================================

CONCEPT_TYPES = {
    "Problem", "Method", "Claim", "Finding", "Limitation",
    "Assumption", "FutureDirection", "ResearchGoal", "Evidence",
    "Dataset", "Benchmark", "Metric",
}

def extract_concept_nodes(api_response: dict) -> list[dict]:
    """Pull concept-level nodes out of any PaperNexus API response."""
    nodes: list[dict] = []
    seen_ids: set[str] = set()

    def _add(n: dict):
        nid = n.get("id") or n.get("nodeId") or ""
        ntype = n.get("type") or n.get("nodeType") or ""
        if nid in seen_ids or ntype not in CONCEPT_TYPES:
            return
        seen_ids.add(nid)
        nodes.append({
            "id": nid,
            "name": n.get("name") or n.get("nodeName") or "",
            "type": ntype,
            "excerpt": (n.get("excerpt") or n.get("evidenceText") or
                        n.get("text") or "")[:280],
        })

    # search / query response
    for group in api_response.get("groups", []):
        for match in group.get("matches", []):
            _add(match)

    # context response
    if api_response.get("node"):
        _add(api_response["node"])
    for rel in api_response.get("outgoing", []):
        _add({"id": rel.get("targetId"), "name": rel.get("targetName"),
               "type": rel.get("targetType")})
    for rel in api_response.get("incoming", []):
        _add({"id": rel.get("sourceId"), "name": rel.get("sourceName"),
               "type": rel.get("sourceType")})

    # brainstorm response — problems, methods, limitations, ideas, etc.
    for key in ("problems", "methods", "limitations", "claims",
                "findings", "assumptions", "futureDirections",
                "ideas", "latentNeighbors", "boundaryNodes",
                "communityBridges"):
        for item in api_response.get(key, []):
            if isinstance(item, dict):
                _add(item)

    # impact response
    for bucket in api_response.get("byDepth", []):
        for item in bucket.get("nodes", []):
            _add(item)

    # evidence-chain response
    for chain in api_response.get("chains", []):
        for step in chain.get("steps", []):
            _add(step)

    return nodes


# ===================================================================
# Phase 0 — Target Domain Critical Reasoning
# ===================================================================

def phase0_target_analysis(api_base: str, token: str, corpus: str,
                           problem: str, target_domain: str,
                           num_questions: int, limit: int) -> dict:
    """Decompose problem, query local KG for target domain coverage."""

    # Step 0.1: Decompose the problem into core research questions (LLM)
    decompose_prompt = textwrap.dedent(f"""\
    You are a research strategist. Given the following research problem and
    its target domain, decompose it into {num_questions} core research
    questions that together cover the essential facets of solving this problem.

    For each question, also provide a very short domain-agnostic version that
    strips away jargon and is understandable by someone outside {target_domain}.

    Research Problem: {problem}
    Target Domain: {target_domain}

    Return strict JSON:
    {{
      "questions": [
        {{
          "id": "q1",
          "domain_specific": "How can ...",
          "domain_agnostic": "How to ...",
          "search_keywords": ["keyword1", "keyword2", "keyword3"]
        }}
      ]
    }}
    """)
    decomposition = llm_json(api_base, token, corpus, decompose_prompt)
    questions = decomposition.get("questions", [])
    if not questions:
        # Fallback: generate minimal questions from the problem itself
        questions = [{
            "id": "q1",
            "domain_specific": problem,
            "domain_agnostic": problem,
            "search_keywords": problem.split()[:5],
        }]

    # Step 0.2: Query the local KG for target domain data
    all_target_nodes: list[dict] = []

    # broad search on the problem itself
    try:
        resp = kg_query(api_base, token, corpus, problem, limit=limit)
        all_target_nodes.extend(extract_concept_nodes(resp))
    except RemoteScriptError:
        pass

    # search per-question keywords
    for q in questions:
        for kw in q.get("search_keywords", [])[:3]:
            try:
                resp = kg_query(api_base, token, corpus, kw, limit=4)
                all_target_nodes.extend(extract_concept_nodes(resp))
            except RemoteScriptError:
                pass

    # brainstorm view
    try:
        resp = kg_brainstorm(api_base, token, corpus, problem,
                             mode="diverge", limit=limit)
        all_target_nodes.extend(extract_concept_nodes(resp))
    except RemoteScriptError:
        pass

    # deduplicate
    seen: set[str] = set()
    deduped: list[dict] = []
    for n in all_target_nodes:
        if n["id"] not in seen:
            seen.add(n["id"])
            deduped.append(n)
    all_target_nodes = deduped

    # Step 0.3: Identify unresolved challenges
    challenge_prompt = textwrap.dedent(f"""\
    You are analyzing a local knowledge graph for the following research problem.
    Below is a summary of what the KG contains (nodes found).

    Research Problem: {problem}
    Target Domain: {target_domain}

    KG Nodes Found ({len(all_target_nodes)} concept nodes):
    {json.dumps(all_target_nodes[:30], ensure_ascii=False, indent=1)}

    Decomposed Questions:
    {json.dumps(questions, ensure_ascii=False, indent=1)}

    Identify the TOP unresolved challenge that (a) is not already well-covered
    by the KG nodes and (b) has the highest potential for cross-domain insight.

    Return strict JSON:
    {{
      "unresolved_challenge": {{
        "domain_specific": "...",
        "domain_agnostic": "...",
        "parent_question_id": "q1",
        "coverage_assessment": "largely_unexplored | partially_addressed | well_covered",
        "rationale": "Why this is the most promising gap"
      }},
      "target_coverage_summary": "Brief summary of what the KG already covers"
    }}
    """)
    challenge_result = llm_json(api_base, token, corpus, challenge_prompt)

    unresolved = challenge_result.get("unresolved_challenge", {})
    if not unresolved.get("domain_specific"):
        unresolved = {
            "domain_specific": problem,
            "domain_agnostic": problem,
            "parent_question_id": "q1",
            "coverage_assessment": "largely_unexplored",
            "rationale": "Fallback: using the original problem as the challenge",
        }

    return {
        "questions": questions,
        "target_nodes": all_target_nodes,
        "target_node_count": len(all_target_nodes),
        "unresolved_challenge": unresolved,
        "coverage_summary": challenge_result.get(
            "target_coverage_summary",
            f"Found {len(all_target_nodes)} concept nodes in the target domain."
        ),
        "early_starvation": len(all_target_nodes) < 2,
    }


# ===================================================================
# Phase 1 — Domain-Agnostic Abstraction
# ===================================================================

def phase1_abstraction(phase0: dict) -> dict:
    """Return the domain-agnostic form of the unresolved challenge.

    The LLM already produced this in Phase 0, so we just structure it.
    """
    challenge = phase0["unresolved_challenge"]
    return {
        "domain_specific_challenge": challenge.get("domain_specific", ""),
        "domain_agnostic_challenge": challenge.get("domain_agnostic", ""),
        "coverage_assessment": challenge.get("coverage_assessment", ""),
    }


# ===================================================================
# Phase 2 — Source Domain Creative Exploration
# ===================================================================

def phase2_matchmaking(api_base: str, token: str, corpus: str,
                       phase0: dict, phase1: dict,
                       target_domain: str,
                       num_source_domains: int) -> dict:
    """Select source domains and generate KG search queries."""
    abstract_challenge = phase1["domain_agnostic_challenge"]

    matchmaking_prompt = textwrap.dedent(f"""\
    You are an interdisciplinary research strategist.

    An unresolved challenge has been identified:
    - Domain-Specific: {phase1['domain_specific_challenge']}
    - Domain-Agnostic: {abstract_challenge}

    Target domain: {target_domain}

    Select exactly {num_source_domains} external source domains that could
    provide insights into this challenge. Choose domains based on:
    1. Analogy (similar structural problems)
    2. Shared Mechanisms (common underlying principles)
    3. Transferable Principles (general frameworks that might apply)

    STRICTLY EXCLUDE: {target_domain} and its direct sub-fields.
    Prefer distant domains that maximize the chance of novel insight.

    For each source domain, generate 3-5 search keywords that would find
    relevant concepts in a research knowledge graph containing papers from
    diverse fields.

    Return strict JSON:
    {{
      "source_domains": [
        {{
          "domain": "Psychology",
          "selection_basis": "shared_mechanisms",
          "rationale": "Why this domain is relevant to the abstract challenge",
          "search_keywords": ["keyword1", "keyword2", "keyword3"]
        }}
      ]
    }}
    """)
    result = llm_json(api_base, token, corpus, matchmaking_prompt)
    source_domains = result.get("source_domains", [])

    if not source_domains:
        # Fallback: generate generic cross-domain suggestions
        source_domains = [
            {"domain": "Biology", "selection_basis": "analogy",
             "rationale": "Biological systems solve analogous problems",
             "search_keywords": [abstract_challenge.split()[0], "adaptation", "mechanism"]},
            {"domain": "Psychology", "selection_basis": "shared_mechanisms",
             "rationale": "Cognitive science principles may transfer",
             "search_keywords": [abstract_challenge.split()[0], "cognition", "learning"]},
            {"domain": "Economics", "selection_basis": "transferable_principles",
             "rationale": "Optimization and decision theory",
             "search_keywords": [abstract_challenge.split()[0], "optimization", "decision"]},
        ]

    return {
        "abstract_challenge": abstract_challenge,
        "source_domains": source_domains[:num_source_domains],
    }


# ===================================================================
# Phase 3 — Local Data Sufficiency Evaluation
# ===================================================================

def phase3_evaluation(api_base: str, token: str, corpus: str,
                      phase1: dict, phase2: dict,
                      relevance_threshold: int,
                      limit: int) -> dict:
    """Query local KG for each source domain, evaluate sufficiency."""
    abstract_challenge = phase2["abstract_challenge"]
    domain_results: list[dict] = []

    for sd in phase2["source_domains"]:
        domain_name = sd["domain"]
        keywords = sd.get("search_keywords", [])
        domain_nodes: list[dict] = []

        # Query the KG with each keyword
        for kw in keywords[:5]:
            try:
                resp = kg_query(api_base, token, corpus, kw, limit=limit)
                domain_nodes.extend(extract_concept_nodes(resp))
            except RemoteScriptError:
                pass

            # Also try context
            try:
                resp = kg_context(api_base, token, corpus, kw,
                                  node_view="brainstorm")
                domain_nodes.extend(extract_concept_nodes(resp))
            except RemoteScriptError:
                pass

        # Deduplicate
        seen: set[str] = set()
        deduped: list[dict] = []
        for n in domain_nodes:
            if n["id"] not in seen:
                seen.add(n["id"])
                deduped.append(n)
        domain_nodes = deduped

        # Relevance filtering via LLM
        relevant_nodes: list[dict] = []
        if domain_nodes:
            filter_prompt = textwrap.dedent(f"""\
            You are evaluating whether knowledge graph nodes are relevant to
            a domain-agnostic research challenge.

            Abstract Challenge: {abstract_challenge}
            Source Domain: {domain_name}
            Selection Rationale: {sd.get('rationale', '')}

            Candidate nodes from the local KG:
            {json.dumps(domain_nodes[:20], ensure_ascii=False, indent=1)}

            For each node, decide if it is "relevant" or "irrelevant" to
            solving the abstract challenge from the perspective of {domain_name}.

            Return strict JSON:
            {{
              "evaluations": [
                {{
                  "node_id": "...",
                  "node_name": "...",
                  "relevant": true,
                  "relevance_reason": "How this node connects to the challenge"
                }}
              ]
            }}
            """)
            eval_result = llm_json(api_base, token, corpus, filter_prompt)
            evaluations = eval_result.get("evaluations", [])

            eval_map = {e.get("node_id"): e for e in evaluations
                        if e.get("relevant") is True}

            for n in domain_nodes:
                if n["id"] in eval_map:
                    n["relevance_reason"] = eval_map[n["id"]].get(
                        "relevance_reason", "")
                    relevant_nodes.append(n)
                elif not evaluations:
                    # If LLM didn't return evaluations, keep all nodes
                    relevant_nodes.append(n)

        domain_results.append({
            "domain": domain_name,
            "search_keywords": keywords,
            "total_nodes_found": len(domain_nodes),
            "relevant_nodes": relevant_nodes,
            "relevant_count": len(relevant_nodes),
            "sufficient": len(relevant_nodes) >= relevance_threshold,
        })

    # Data Sufficiency Check
    sufficient_domains = [d for d in domain_results if d["sufficient"]]
    is_sufficient = len(sufficient_domains) >= 1

    return {
        "domain_results": domain_results,
        "sufficient_domains": sufficient_domains,
        "is_sufficient": is_sufficient,
        "conclusion": ("BRAINSTORM" if is_sufficient
                       else "INVESTIGATION_REQUISITION"),
    }


# ===================================================================
# Phase 4 — Synthesis & Scoring (Branch A)
# ===================================================================

def phase4_synthesis(api_base: str, token: str, corpus: str,
                     problem: str, target_domain: str,
                     phase1: dict, phase3: dict) -> dict:
    """Generate interdisciplinary idea fragments from sufficient domains."""
    sufficient_domains = phase3["sufficient_domains"]

    # Collect all relevant nodes across sufficient domains
    all_insights: list[dict] = []
    for d in sufficient_domains:
        for n in d["relevant_nodes"]:
            all_insights.append({
                "source_domain": d["domain"],
                "node_id": n["id"],
                "node_name": n["name"],
                "node_type": n["type"],
                "excerpt": n.get("excerpt", ""),
                "relevance_reason": n.get("relevance_reason", ""),
            })

    synthesis_prompt = textwrap.dedent(f"""\
    You are synthesizing interdisciplinary insights into actionable research
    idea fragments.

    Research Problem: {problem}
    Target Domain: {target_domain}
    Domain-Specific Challenge: {phase1['domain_specific_challenge']}
    Domain-Agnostic Challenge: {phase1['domain_agnostic_challenge']}

    Cross-domain insights found in the local knowledge graph:
    {json.dumps(all_insights[:25], ensure_ascii=False, indent=1)}

    Generate the TOP 3 interdisciplinary idea fragments. Each idea should:
    1. Clearly trace the insight back to a source domain concept
    2. Explain how it addresses the target challenge
    3. Be grounded in the actual KG nodes (cite node names)
    4. Be ranked by a combination of Novelty and Usefulness

    Return strict JSON:
    {{
      "idea_fragments": [
        {{
          "rank": 1,
          "title": "Concise idea title",
          "target_challenge": "The specific target-domain challenge",
          "abstract_challenge": "The domain-agnostic version",
          "source_domain": "Psychology",
          "source_takeaways": [
            {{
              "concept": "Name of the source concept",
              "mechanism": "How it works in the source domain",
              "source_papers": ["Paper titles from KG if available"]
            }}
          ],
          "integration_rationale": "How the source insight addresses the target challenge",
          "novelty_score": 4.2,
          "usefulness_score": 3.8,
          "supporting_kg_nodes": ["node-name-1", "node-name-2"]
        }}
      ]
    }}
    """)
    result = llm_json(api_base, token, corpus, synthesis_prompt)
    return result


# ===================================================================
# Phase 5 — Investigation Requisition (Branch B)
# ===================================================================

def phase5_requisition(api_base: str, token: str, corpus: str,
                       target_domain: str,
                       phase1: dict, phase2: dict,
                       phase3: dict) -> dict:
    """Generate a structured requisition for missing data."""
    abstract_challenge = phase1["domain_agnostic_challenge"]
    domain_results = phase3["domain_results"]

    # Build context about what was missing
    missing_domains = [d["domain"] for d in domain_results
                       if not d["sufficient"]]

    requisition_prompt = textwrap.dedent(f"""\
    You are generating a precise data-ingestion requisition for a knowledge
    graph. The local KG lacks sufficient cross-domain data to brainstorm
    interdisciplinary solutions.

    Target Domain: {target_domain}
    Domain-Specific Challenge: {phase1['domain_specific_challenge']}
    Domain-Agnostic Challenge: {abstract_challenge}

    Attempted source domains and their results:
    {json.dumps([
        {
            "domain": d["domain"],
            "keywords_tried": d["search_keywords"],
            "nodes_found": d["total_nodes_found"],
            "relevant_nodes": d["relevant_count"],
            "sufficient": d["sufficient"]
        }
        for d in domain_results
    ], ensure_ascii=False, indent=1)}

    Generate a precise requisition specifying what papers need to be ingested.
    For each domain that was insufficient, specify:
    1. The core concepts/theories that should be retrieved
    2. Specific search keywords for academic paper search
    3. Why this specific data is expected to help solve the challenge

    Return strict JSON:
    {{
      "requisition_report": {{
        "status": "DATA_STARVATION",
        "target_challenge": "{abstract_challenge}",
        "missing_domains": {json.dumps(missing_domains)},
        "required_topics": [
          {{
            "topic": "Specific mechanism or theory",
            "domain": "Source domain name",
            "search_keywords": ["keyword1", "keyword2"],
            "expected_paper_count": 5,
            "reason": "Why we need papers on this topic"
          }}
        ]
      }}
    }}
    """)
    result = llm_json(api_base, token, corpus, requisition_prompt)

    # Ensure the result has the right shape
    if "requisition_report" not in result:
        result = {
            "requisition_report": {
                "status": "DATA_STARVATION",
                "target_challenge": abstract_challenge,
                "missing_domains": missing_domains,
                "required_topics": [
                    {
                        "topic": f"Cross-domain insights for: {abstract_challenge}",
                        "domain": d,
                        "search_keywords": next(
                            (dr["search_keywords"]
                             for dr in domain_results if dr["domain"] == d),
                            []),
                        "expected_paper_count": 5,
                        "reason": f"KG has insufficient {d} coverage "
                                  f"for the abstract challenge",
                    }
                    for d in missing_domains
                ],
            }
        }

    return result


# ===================================================================
# Text report formatter
# ===================================================================

def format_text_report(problem: str, target_domain: str,
                       phase0: dict, phase1: dict,
                       phase2: dict, phase3: dict,
                       phase4_or_5: dict) -> str:
    """Format the full pipeline output as a human-readable text report."""
    lines: list[str] = []

    # Section 0
    lines.append("=" * 72)
    lines.append("[0. Local KG Target Analysis]")
    lines.append(f"- Macro Goal: {problem}")
    lines.append(f"- Target Domain: {target_domain}")
    lines.append(f"- KG Concept Nodes Found: {phase0['target_node_count']}")
    challenge = phase0["unresolved_challenge"]
    lines.append(f"- Local KG Target Challenge: "
                 f"{challenge.get('domain_specific', 'N/A')}")
    lines.append(f"- Coverage: {phase0['coverage_summary']}")
    lines.append("")

    # Section 1
    lines.append("[1. Domain-Agnostic Abstraction]")
    lines.append(f"- Jargon-Free Abstract Challenge: "
                 f"{phase1['domain_agnostic_challenge']}")
    lines.append(f"- Coverage Assessment: "
                 f"{phase1['coverage_assessment']}")
    lines.append("")

    # Section 2
    lines.append("[2. Cross-Domain Matchmaking Plan]")
    for sd in phase2["source_domains"]:
        lines.append(f"  • {sd['domain']} ({sd.get('selection_basis', '?')})")
        lines.append(f"    Rationale: {sd.get('rationale', '')}")
        lines.append(f"    Search terms: {', '.join(sd.get('search_keywords', []))}")
    lines.append("")

    # Section 3
    lines.append("[3. Local Data Sufficiency Evaluation]")
    for d in phase3["domain_results"]:
        status = "✅ SUFFICIENT" if d["sufficient"] else "❌ INSUFFICIENT"
        lines.append(f"  • {d['domain']}: "
                     f"{d['relevant_count']}/{d['total_nodes_found']} "
                     f"relevant nodes → {status}")
    lines.append(f"- Evaluation Conclusion: {phase3['conclusion']}")
    lines.append("")

    # Section 4 or 5
    if phase3["is_sufficient"]:
        lines.append("[4. Final Brainstorming Ideas (Data is Sufficient)]")
        lines.append("")
        fragments = phase4_or_5.get("idea_fragments", [])
        for frag in fragments:
            lines.append(f"### 💡 Idea {frag.get('rank', '?')}: "
                         f"{frag.get('title', 'Untitled')}")
            lines.append(f"- **Source Domain**: "
                         f"{frag.get('source_domain', '?')}")
            lines.append(f"- **Inspiration Source**:")
            for t in frag.get("source_takeaways", []):
                lines.append(f"    • {t.get('concept', '?')}: "
                             f"{t.get('mechanism', '')}")
            lines.append(f"- **Integration Approach**: "
                         f"{frag.get('integration_rationale', '')}")
            lines.append(f"- **Novelty**: "
                         f"{frag.get('novelty_score', '?')}/5  "
                         f"**Usefulness**: "
                         f"{frag.get('usefulness_score', '?')}/5")
            kg_nodes = frag.get("supporting_kg_nodes", [])
            if kg_nodes:
                lines.append(f"- **KG Evidence**: "
                             f"{', '.join(str(n) for n in kg_nodes[:5])}")
            lines.append("")
    else:
        lines.append("[5. Data Ingestion Requisition (Data is Starved)]")
        lines.append("")
        lines.append("> ⚠️ WARNING: Insufficient cross-domain data in the "
                     "Local KG. Unable to generate high-quality ideas. "
                     "Please ingest literature based on the following "
                     "requisition:")
        lines.append("")
        report = phase4_or_5.get("requisition_report", {})
        for topic in report.get("required_topics", []):
            domain_label = topic.get("domain", "Unknown Domain")
            lines.append(f"- **Urgent Domain: {domain_label}**")
            lines.append(f"  - Core Concepts/Theories to Retrieve: "
                         f"{topic.get('topic', '?')}")
            kws = topic.get("search_keywords", [])
            lines.append(f"  - Suggested Search Keywords: "
                         f"{', '.join(kws)}")
            lines.append(f"  - Expected Papers Needed: "
                         f"~{topic.get('expected_paper_count', 5)}")
            lines.append(f"  - Rationale: {topic.get('reason', '')}")
            lines.append("")

    lines.append("=" * 72)
    return "\n".join(lines)


# ===================================================================
# CLI
# ===================================================================

def parse_args():
    parser = argparse.ArgumentParser(
        description="IDEA-CATALYST: Interdisciplinary ideation over a "
                    "PaperNexus Knowledge Graph."
    )
    add_connection_args(parser)
    parser.add_argument("--problem", required=True,
                        help="The research problem statement.")
    parser.add_argument("--target-domain", default="Computer Science",
                        help="The target domain name "
                             "(default: Computer Science).")
    parser.add_argument("--num-questions", type=int,
                        default=DEFAULT_NUM_QUESTIONS,
                        help="Number of decomposed research questions.")
    parser.add_argument("--num-source-domains", type=int,
                        default=DEFAULT_NUM_SOURCE_DOMAINS,
                        help="Number of external source domains to explore.")
    parser.add_argument("--relevance-threshold", type=int,
                        default=DEFAULT_RELEVANCE_THRESHOLD,
                        help="Min relevant nodes per source domain to pass "
                             "the sufficiency check.")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help="Max results per KG query.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        api_base = normalize_api_base(args.api_base)
        token = resolve_token(args.token)
        corpus = require_corpus(args.corpus)
    except RemoteScriptError as exc:
        return fail(str(exc), getattr(args, "json", False))

    problem = args.problem
    target_domain = args.target_domain

    try:
        # ---- Phase 0 ----
        print("[Phase 0] Target Domain Critical Reasoning ...",
              file=sys.stderr)
        p0 = phase0_target_analysis(
            api_base, token, corpus, problem, target_domain,
            args.num_questions, args.limit,
        )

        # Early starvation check
        if p0["early_starvation"]:
            print("[Phase 0] EARLY DATA STARVATION — "
                  "target domain has < 2 concept nodes.",
                  file=sys.stderr)

        # ---- Phase 1 ----
        print("[Phase 1] Domain-Agnostic Abstraction ...",
              file=sys.stderr)
        p1 = phase1_abstraction(p0)

        # ---- Phase 2 ----
        print("[Phase 2] Cross-Domain Matchmaking ...",
              file=sys.stderr)
        p2 = phase2_matchmaking(
            api_base, token, corpus, p0, p1,
            target_domain, args.num_source_domains,
        )

        # ---- Phase 3 ----
        print("[Phase 3] Local Data Sufficiency Evaluation ...",
              file=sys.stderr)
        p3 = phase3_evaluation(
            api_base, token, corpus, p1, p2,
            args.relevance_threshold, args.limit,
        )

        # ---- Phase 4 or 5 ----
        if p3["is_sufficient"]:
            print("[Phase 4] Synthesis & Scoring ...",
                  file=sys.stderr)
            p4 = phase4_synthesis(
                api_base, token, corpus,
                problem, target_domain, p1, p3,
            )
            final = p4
        else:
            print("[Phase 5] Investigation Requisition ...",
                  file=sys.stderr)
            p5 = phase5_requisition(
                api_base, token, corpus,
                target_domain, p1, p2, p3,
            )
            final = p5

        # ---- Output ----
        if getattr(args, "json", False):
            full_output = {
                "phase0": {
                    "questions": p0["questions"],
                    "target_node_count": p0["target_node_count"],
                    "unresolved_challenge": p0["unresolved_challenge"],
                    "coverage_summary": p0["coverage_summary"],
                    "early_starvation": p0["early_starvation"],
                },
                "phase1": p1,
                "phase2": p2,
                "phase3": {
                    "domain_results": [
                        {
                            "domain": d["domain"],
                            "total_nodes_found": d["total_nodes_found"],
                            "relevant_count": d["relevant_count"],
                            "sufficient": d["sufficient"],
                        }
                        for d in p3["domain_results"]
                    ],
                    "conclusion": p3["conclusion"],
                },
            }
            if p3["is_sufficient"]:
                full_output["phase4"] = final
            else:
                full_output["phase5"] = final
            return emit_result(full_output, True)
        else:
            report = format_text_report(
                problem, target_domain,
                p0, p1, p2, p3, final,
            )
            print(report)
            return 0

    except RemoteScriptError as exc:
        return fail(str(exc), getattr(args, "json", False))
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
