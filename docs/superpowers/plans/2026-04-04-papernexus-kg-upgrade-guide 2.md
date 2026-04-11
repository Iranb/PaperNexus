# PaperNexus: Knowledge Graph Upgrade Guide

**Date:** 2026-04-04
**Basis:** Paper `2603.12226v1` (Idea-Catalyst: Metacognition-Driven Interdisciplinary Inspiration)
**Scope:** Code modifications and new features for `PaperNexus` only

---

## 0. Current State Snapshot

PaperNexus's KG-relevant code lives in:

| Module | File | Maturity | Key Gap |
|---|---|---|---|
| Schema | `src/core/graph/schema.js` | Strong | 16 node types, 29 edge types. Sufficient for the paper's needs. |
| Domain Taxonomy | `src/core/graph/domain-taxonomy.js` | Functional | Jaccard-based distance; neighbor map built from config rows. **Not populated automatically.** |
| Abstract Mechanisms | `src/core/graph/abstract-mechanisms.js` | Basic | Simple normalization + node creation. No mechanism hierarchy or quality scoring. |
| Domain Bridges | `src/core/graph/domain-bridges.js` | Functional | `queryCrossDomainBridges()` works. Token overlap + domain distance scoring. |
| Brainstorm Communities | `src/core/search/brainstorm-communities.js` | **Strong** | Leiden community detection, boundary nodes, latent neighbors, cross-community bridges. 920 lines. |
| Brainstorm View | `src/core/graph/brainstorm-view.js` | Functional | Token index over brainstorm-eligible nodes. |
| Graph Core | `src/core/graph/graph.js` | Production | In-memory graph with type/search/adjacency indexes. |
| Mutations | `src/core/graph/mutations.js` | Production | Full CRUD with schema validation and audit trail. |
| MCP Tools | `src/mcp/tools.js` | Production | 7 tools: query, context, impact, ideas, brainstorm, mutate_graph, list_corpora. |

The paper's methodology requires PaperNexus to strengthen three areas:
1. **Domain taxonomy** — the substrate for domain distance and source-domain selection
2. **Cross-domain bridge intelligence** — the substrate for mechanism-based insight transfer
3. **Takeaway extraction** — new capability for producing structured insights per domain

---

## 1. CRITICAL: Auto-Populate Domain Distance Matrix

### Problem

`domain-taxonomy.js` has `buildDomainDistanceMatrix(rows)` that computes Jaccard-distance from a neighbor map. But the `rows` parameter expects a manually configured array of `{ targetDomain, relatedDomains }` entries. This means the domain distance matrix is only as good as the config — it is not derived from the graph itself.

Meanwhile, `openclaw-research`'s scout-adapter uses a fake `domain_distance: 0.55 + index * 0.05` because it has no way to get real distances.

### Design

**New function in `src/core/graph/domain-taxonomy.js`:**

```js
/**
 * Derive domain taxonomy rows from the graph itself by analyzing
 * which Domain nodes share papers, problems, or methods.
 */
export function deriveDomainTaxonomyFromGraph(graph) {
  const domainNodes = graph.getNodesByType(NODE_TYPES.DOMAIN);
  const domainPaperSets = new Map();

  // For each Domain node, collect its connected papers
  for (const domain of domainNodes) {
    const papers = new Set();
    for (const rel of graph.getIncoming(domain.id)) {
      if (rel.type === EDGE_TYPES.BELONGS_TO_DOMAIN) {
        papers.add(rel.sourceId);
      }
    }
    // Also collect Problems and Methods in this domain
    for (const rel of graph.getIncoming(domain.id)) {
      if (rel.type === EDGE_TYPES.STUDIED_IN || rel.type === EDGE_TYPES.ORIGINATED_IN) {
        papers.add(rel.sourceId);
      }
    }
    domainPaperSets.set(domain.name, papers);
  }

  // Build neighbor relationships based on shared entities
  const rows = [];
  for (const [domainName, papers] of domainPaperSets) {
    const relatedDomains = [];
    for (const [otherName, otherPapers] of domainPaperSets) {
      if (domainName === otherName) continue;
      // Domains that share papers/problems/methods are neighbors
      const overlap = [...papers].filter(id => otherPapers.has(id)).length;
      if (overlap > 0) {
        relatedDomains.push(otherName);
      }
    }
    if (relatedDomains.length > 0) {
      rows.push({ targetDomain: domainName, relatedDomains });
    }
  }

  return buildDomainDistanceMatrix(rows);
}
```

**New MCP tool** to expose this:

```js
{
  name: 'domain_distance',
  description: 'Compute or retrieve the domain distance matrix from the knowledge graph.',
  inputSchema: {
    type: 'object',
    properties: {
      corpus: { type: 'string' },
      targetDomain: { type: 'string', description: 'Optional: return distance from this domain to all others.' },
    },
    required: []
  }
}
```

**Integration with openclaw-research:** The materializer should call PaperNexus `domain_distance` MCP tool and pass the result to `deriveIdeaCatalystScoutReport()`.

---

## 2. CRITICAL: Upgrade `queryCrossDomainBridges()` — From Heuristic to Graph-Native

### Problem

Current `queryCrossDomainBridges()` in `domain-bridges.js` does:
1. Filter nodes outside target domain
2. Collect their mechanism neighbors
3. Score by `token_overlap * 2 + domain_distance`
4. Return top-k

This is a reasonable first pass, but the paper's approach requires:
- Querying based on **domain-agnostic challenges** (not just the target domain name)
- Returning **structured bridge evidence** with conceptual takeaways
- **Prioritizing non-proximal domains** (the paper explicitly excludes nearby fields)

### Design

**Extend `queryCrossDomainBridges()` with a new parameter signature:**

```js
export function queryCrossDomainBridges(graph, params = {}) {
  const targetDomain = normalizeFieldOfStudy(params.targetDomain);
  const limit = Math.max(1, Number(params.limit || 8));

  // NEW: Accept domain-agnostic challenges for targeted retrieval
  const agnosticChallenges = params.agnosticChallenges || [];

  // NEW: Minimum domain distance threshold (paper excludes proximal fields)
  const minDomainDistance = params.minDomainDistance ?? 0.3;

  // NEW: Domain distance matrix for real distance computation
  const distanceMatrix = params.domainDistanceMatrix || null;

  // ... existing filtering logic ...

  // NEW: Score each bridge node against the agnostic challenges
  const bridgeNodes = graph.nodes
    .filter(node => candidateTypes.has(node.type))
    .map(node => {
      const domain = normalizeFieldOfStudy(
        node.properties?.fieldOfStudy,
        node.properties?.domainTags || []
      );
      if (!domain || domain === targetDomain) return null;

      // Compute real domain distance
      const distance = distanceMatrix
        ? scoreDomainDistance(distanceMatrix, targetDomain, domain)
        : 1;

      // NEW: Filter out proximal domains
      if (distance < minDomainDistance) return null;

      const mechanisms = collectMechanismNodes(graph, node).map(e => e.name);

      // NEW: Score against each agnostic challenge
      const challengeScores = agnosticChallenges.map(challenge => ({
        challenge,
        score: scoreBridgeNode(node, {
          abstractChallenge: challenge,
          targetDomain,
          domainDistanceMatrix: distanceMatrix,
        }),
      }));
      const bestChallengeMatch = challengeScores.sort((a, b) => b.score - a.score)[0];

      return {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        domain,
        mechanisms,
        domainDistance: distance,
        score: bestChallengeMatch?.score ?? scoreBridgeNode(node, { ... }),
        matchedChallenge: bestChallengeMatch?.challenge ?? null,
        // NEW: Structured evidence for takeaway extraction
        evidence: {
          abstract: node.properties?.abstract || null,
          text: node.properties?.text || null,
          evidenceText: node.properties?.evidenceText || null,
          paperTitles: node.properties?.paperTitles || [],
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // ... rest of function ...
}
```

**Key addition:** Each bridge node now carries `evidence` and `matchedChallenge`, which openclaw-research's scout-adapter can use to produce structured takeaways without needing a separate round-trip to PaperNexus.

---

## 3. HIGH: New Capability — Source-Domain Takeaway Extraction

### Problem

The paper's most distinctive contribution is extracting **conceptual takeaways** from source domains (Section 3.4.1, Table 3). PaperNexus currently returns bridge nodes and mechanisms, but not structured takeaways that explain *how a source-domain concept works and why it might transfer*.

### Design

**New file:** `src/core/graph/takeaway-extraction.js`

```js
/**
 * Extract structured takeaways from bridge nodes for a given challenge.
 *
 * A takeaway = {
 *   takeaway_id: string,
 *   source_domain: string,
 *   concept: string,           // the source-domain concept name
 *   mechanism: string,         // the underlying mechanism
 *   source_domain_formulation: string,  // how this works in the source domain
 *   mechanism_explanation: string,       // the underlying logic/principle
 *   kg_evidence: {
 *     node_id: string,
 *     node_type: string,
 *     paper_titles: string[],
 *     evidence_text: string,
 *   },
 *   relevance_to_challenge: string,  // which agnostic challenge this addresses
 * }
 */
export function extractTakeawaysFromBridgeNodes(graph, params) {
  const { bridgeNodes, targetDomain, agnosticChallenges } = params;

  const takeaways = [];

  for (const bridge of bridgeNodes) {
    // Get mechanism nodes connected to this bridge
    const mechanisms = graph.getOutgoing(bridge.nodeId)
      .filter(rel => [
        EDGE_TYPES.INSTANTIATES,
        EDGE_TYPES.IMPLEMENTS,
        EDGE_TYPES.CONSTRAINS,
      ].includes(rel.type))
      .map(rel => graph.getNode(rel.targetId))
      .filter(Boolean);

    // Get papers that support this bridge node
    const papers = graph.getIncoming(bridge.nodeId)
      .filter(rel => rel.type === EDGE_TYPES.CONTAINS || rel.type === EDGE_TYPES.CLAIMS)
      .map(rel => graph.getNode(rel.sourceId))
      .filter(node => node?.type === NODE_TYPES.PAPER);

    // Build source_domain_formulation from the node's evidence
    const sourceFormulation = buildSourceFormulation({
      nodeName: bridge.nodeName,
      nodeType: bridge.nodeType,
      domain: bridge.domain,
      abstract: bridge.evidence?.abstract,
      text: bridge.evidence?.text,
      mechanisms: mechanisms.map(m => m.name),
    });

    // Build mechanism_explanation from AbstractMechanism nodes
    const mechanismExplanation = mechanisms.length > 0
      ? `${mechanisms[0].name}: ${mechanisms[0].properties?.description || 'domain-agnostic mechanism'}`
      : `${bridge.nodeName} represents a transferable pattern from ${bridge.domain}`;

    takeaways.push({
      takeaway_id: `t-${bridge.nodeId}-${takeaways.length + 1}`,
      source_domain: bridge.domain,
      concept: bridge.nodeName,
      mechanism: mechanisms[0]?.name || bridge.nodeName,
      source_domain_formulation: sourceFormulation,
      mechanism_explanation: mechanismExplanation,
      kg_evidence: {
        node_id: bridge.nodeId,
        node_type: bridge.nodeType,
        paper_titles: papers.map(p => p.name).slice(0, 5),
        evidence_text: bridge.evidence?.evidenceText || bridge.evidence?.abstract || '',
      },
      relevance_to_challenge: bridge.matchedChallenge || '',
    });
  }

  return takeaways;
}

function buildSourceFormulation({ nodeName, nodeType, domain, abstract, text, mechanisms }) {
  // Prefer evidence text from the graph, fall back to constructing from metadata
  if (abstract) {
    return abstract.length > 300 ? abstract.slice(0, 300) + '...' : abstract;
  }
  if (text) {
    return text.length > 300 ? text.slice(0, 300) + '...' : text;
  }
  const mechanismPart = mechanisms.length > 0
    ? ` through ${mechanisms.join(' and ')}`
    : '';
  return `In ${domain}, ${nodeName} addresses this challenge${mechanismPart}.`;
}
```

**New MCP tool:**

```js
{
  name: 'extract_takeaways',
  description: 'Extract structured interdisciplinary takeaways from cross-domain bridge nodes for given conceptual challenges.',
  inputSchema: {
    type: 'object',
    properties: {
      corpus: { type: 'string' },
      targetDomain: { type: 'string', description: 'The target research domain.' },
      agnosticChallenges: {
        type: 'array',
        items: { type: 'string' },
        description: 'Domain-agnostic challenge formulations to find takeaways for.'
      },
      limit: { type: 'number', default: 8 },
      minDomainDistance: { type: 'number', default: 0.3 },
    },
    required: ['targetDomain', 'agnosticChallenges']
  }
}
```

---

## 4. HIGH: Upgrade Abstract Mechanism Layer

### Problem

`abstract-mechanisms.js` is only 35 lines — it normalizes mechanism names and creates nodes with `{ mechanismType: 'general', description: mechanism }`. This is insufficient for the paper's approach where mechanism quality and transferability need to be assessed.

### Design

**Extend `buildAbstractMechanismNode()` with quality metadata:**

```js
export function buildAbstractMechanismNode(name, properties = {}) {
  const mechanism = normalizeMechanismName(name);
  if (!mechanism) return null;
  return {
    id: `${NODE_TYPES.ABSTRACT_MECHANISM.toLowerCase()}:${slugify(mechanism)}:${stableHash(`mechanism:${mechanism}`)}`,
    type: NODE_TYPES.ABSTRACT_MECHANISM,
    name: mechanism,
    properties: {
      layer: getNodeLayer(NODE_TYPES.ABSTRACT_MECHANISM),
      mechanismType: properties.mechanismType || 'general',
      description: properties.description || mechanism,
      // NEW fields:
      domainCount: properties.domainCount || 0,        // how many domains instantiate this mechanism
      instanceCount: properties.instanceCount || 0,     // total instantiation edges
      transferPotential: properties.transferPotential || null,  // derived: high if domainCount >= 2
      canonicalForm: properties.canonicalForm || mechanism,     // normalized canonical name
      relatedMechanisms: properties.relatedMechanisms || [],    // sibling mechanisms
    }
  };
}
```

**New function: `scoreMechanismTransferability()`**

```js
/**
 * Score how transferable a mechanism is based on its graph structure.
 * A mechanism that appears in many domains is more transferable.
 */
export function scoreMechanismTransferability(graph, mechanismNode) {
  const instantiators = graph.getIncoming(mechanismNode.id)
    .filter(rel => rel.type === EDGE_TYPES.INSTANTIATES || rel.type === EDGE_TYPES.IMPLEMENTS)
    .map(rel => graph.getNode(rel.sourceId))
    .filter(Boolean);

  const domains = new Set();
  for (const node of instantiators) {
    const domain = normalizeFieldOfStudy(
      node.properties?.fieldOfStudy,
      node.properties?.domainTags || []
    );
    if (domain) domains.add(domain);
  }

  return {
    domainCount: domains.size,
    instanceCount: instantiators.length,
    domains: [...domains],
    transferPotential: domains.size >= 3 ? 'high' : domains.size >= 2 ? 'medium' : 'low',
  };
}
```

**Integration with enrichment:** Update `enrichGraphWithDomainAndMechanismNodes()` in `domain-bridges.js` to call `scoreMechanismTransferability()` after enrichment and update node properties:

```js
export function enrichGraphWithDomainAndMechanismNodes(graph) {
  // ... existing enrichment logic ...

  // NEW: Post-enrichment scoring pass
  for (const mechNode of graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)) {
    const score = scoreMechanismTransferability(graph, mechNode);
    graph.updateNode({
      ...mechNode,
      properties: {
        ...mechNode.properties,
        domainCount: score.domainCount,
        instanceCount: score.instanceCount,
        transferPotential: score.transferPotential,
      }
    });
  }

  return graph;
}
```

---

## 5. HIGH: Add Domain Exploration to Brainstorm Communities

### Problem

`brainstorm-communities.js` has a powerful Leiden-based community detection system (920 lines) that finds latent neighbors, boundary nodes, and cross-community bridges. But it operates on concept-level nodes (Problem, Method, Claim, etc.) — it does not reason about **domains** as first-class entities in the community structure.

The paper requires identifying which source domains have the highest interdisciplinary potential. The community structure already contains this signal implicitly (cross-community bridges often span domains), but it's not surfaced explicitly.

### Design

**New function in `brainstorm-communities.js`:**

```js
/**
 * After community detection, analyze which domains appear in which
 * communities and identify cross-domain community bridges.
 */
export function deriveDomainCommunityProfile(graph, communityContext) {
  const { communities, crossCommunityBridges, latentNeighbors } = communityContext;

  // Map each community to its dominant domains
  const communityDomains = new Map();
  for (const community of communities) {
    const domainCounts = {};
    for (const nodeId of community.nodeIds) {
      const node = graph.getNode(nodeId);
      if (!node) continue;
      const domain = normalizeFieldOfStudy(
        node.properties?.fieldOfStudy,
        node.properties?.domainTags || []
      );
      if (domain) {
        domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      }
    }
    communityDomains.set(community.id, domainCounts);
  }

  // Identify cross-domain bridges: bridges where source and target
  // belong to different domains
  const crossDomainBridges = crossCommunityBridges
    .map(bridge => {
      const sourceNode = graph.getNode(bridge.sourceId);
      const targetNode = graph.getNode(bridge.targetId);
      const sourceDomain = normalizeFieldOfStudy(sourceNode?.properties?.fieldOfStudy);
      const targetDomain = normalizeFieldOfStudy(targetNode?.properties?.fieldOfStudy);
      if (!sourceDomain || !targetDomain || sourceDomain === targetDomain) return null;
      return {
        ...bridge,
        sourceDomain,
        targetDomain,
        bridgeType: 'cross-domain',
      };
    })
    .filter(Boolean);

  // Rank domains by their bridge connectivity
  const domainBridgeScores = {};
  for (const bridge of crossDomainBridges) {
    domainBridgeScores[bridge.sourceDomain] = (domainBridgeScores[bridge.sourceDomain] || 0) + bridge.score;
    domainBridgeScores[bridge.targetDomain] = (domainBridgeScores[bridge.targetDomain] || 0) + bridge.score;
  }

  return {
    communityDomains: Object.fromEntries(communityDomains),
    crossDomainBridges,
    domainBridgeScores,
    topBridgeDomains: Object.entries(domainBridgeScores)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([domain, score]) => ({ domain, score })),
  };
}
```

**Integration:** The `brainstorm` MCP tool should include `domainProfile` in its output when `mode === 'diverge'`.

---

## 6. MEDIUM: New MCP Tool — `interdisciplinary_potential`

### Problem

openclaw-research's gatekeeper needs to assess whether there is sufficient cross-domain bridge evidence. Currently it makes this judgment based on the scout-adapter's output. But PaperNexus has much richer community and bridge data that could directly answer "which external domains have the highest interdisciplinary potential for this problem?"

### Design

**New MCP tool:**

```js
{
  name: 'interdisciplinary_potential',
  description: 'Given a target domain and research problem, identify source domains with the highest interdisciplinary potential by analyzing cross-domain bridges, shared mechanisms, and community structure in the knowledge graph.',
  inputSchema: {
    type: 'object',
    properties: {
      corpus: { type: 'string' },
      targetDomain: { type: 'string' },
      query: { type: 'string', description: 'Research problem statement.' },
      agnosticChallenges: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional domain-agnostic challenge formulations.'
      },
      excludeProximalDomains: { type: 'boolean', default: true },
      limit: { type: 'number', default: 5 },
    },
    required: ['targetDomain', 'query']
  }
}
```

**Implementation:** This tool would orchestrate:
1. Run `brainstorm` in diverge mode to get community context
2. Run `deriveDomainCommunityProfile()` to get domain-level bridge analysis
3. Run `queryCrossDomainBridges()` with the agnostic challenges
4. Combine the signals into a ranked list of source domains with evidence

**Output format:**
```json
{
  "targetDomain": "Computer Science",
  "rankedSourceDomains": [
    {
      "domain": "Psychology",
      "interdisciplinaryPotentialScore": 0.87,
      "bridgeNodeCount": 5,
      "sharedMechanisms": ["adaptation", "feedback loop"],
      "communityBridgeWeight": 4.2,
      "domainDistance": 0.72,
      "topTakeaways": [ ... ],
      "evidence": {
        "crossCommunityBridges": 3,
        "latentNeighborOverlap": 0.4
      }
    }
  ]
}
```

---

## 7. MEDIUM: Enrich Ingestion Pipeline with Domain/Mechanism Quality

### Problem

The ingestion pipeline (`src/core/ingestion/pipeline.js` + `graph-precompute.js`) already extracts `fieldOfStudy`, `domainTags`, and `abstractMechanisms` during paper processing. But these are extracted once and never refined. As more papers are ingested, the domain and mechanism metadata should improve.

### Design

**Add a post-ingestion refinement pass in `graph-precompute.js`:**

```js
/**
 * After all papers in a batch are processed, run a graph-wide
 * refinement pass to:
 * 1. Propagate domain tags from papers to their problems/methods
 * 2. Merge near-duplicate mechanisms
 * 3. Update mechanism transferability scores
 * 4. Rebuild the domain distance matrix
 */
export function postIngestionRefinement(graph) {
  // 1. Propagate domain information
  propagateDomainTagsFromPapers(graph);

  // 2. Merge similar mechanisms (e.g., "attention mechanism" and "attention-based mechanism")
  mergeNearDuplicateMechanisms(graph);

  // 3. Re-score mechanism transferability
  for (const mechNode of graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)) {
    const score = scoreMechanismTransferability(graph, mechNode);
    graph.updateNode({
      ...mechNode,
      properties: {
        ...mechNode.properties,
        domainCount: score.domainCount,
        instanceCount: score.instanceCount,
        transferPotential: score.transferPotential,
      }
    });
  }

  // 4. Rebuild domain distance matrix and cache it
  const matrix = deriveDomainTaxonomyFromGraph(graph);
  return { graph, domainDistanceMatrix: matrix };
}
```

**`mergeNearDuplicateMechanisms()`** should use the existing `merge-similar.js` patterns to consolidate mechanisms that differ only in phrasing.

---

## 8. LOW: Add `TRANSFERABLE_TO` Edge Population

### Problem

`EDGE_TYPES.TRANSFERABLE_TO` exists in the schema but is not systematically populated. The paper's approach requires knowing which methods/concepts are transferable between domains.

### Design

During `enrichGraphWithDomainAndMechanismNodes()`, if two nodes from different domains share the same `AbstractMechanism` node, create a `TRANSFERABLE_TO` edge between them:

```js
// After all domain/mechanism edges are created:
const mechanismInstancers = new Map(); // mechanismId -> [nodeIds]

for (const mechNode of graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)) {
  const instancers = graph.getIncoming(mechNode.id)
    .filter(rel => [EDGE_TYPES.INSTANTIATES, EDGE_TYPES.IMPLEMENTS].includes(rel.type))
    .map(rel => graph.getNode(rel.sourceId))
    .filter(Boolean);
  mechanismInstancers.set(mechNode.id, instancers);
}

for (const [mechId, instancers] of mechanismInstancers) {
  // Find pairs from different domains
  for (let i = 0; i < instancers.length; i++) {
    for (let j = i + 1; j < instancers.length; j++) {
      const domainA = normalizeFieldOfStudy(instancers[i].properties?.fieldOfStudy);
      const domainB = normalizeFieldOfStudy(instancers[j].properties?.fieldOfStudy);
      if (domainA && domainB && domainA !== domainB) {
        ensureRelationship(graph, instancers[i].id, instancers[j].id, EDGE_TYPES.TRANSFERABLE_TO, {
          viaMechanism: mechId,
          source: 'idea-catalyst-transfer-enrichment',
        });
      }
    }
  }
}
```

This directly populates the transfer edges that `queryCrossDomainBridges()` can traverse, making bridge discovery more precise.

---

## 9. LOW: Expose Domain Taxonomy as MCP Resource

### Design

**New resource in `src/mcp/resources.js`:**

```js
{
  uri: `papernexus://corpus/{corpus}/domain-taxonomy`,
  name: 'Domain Taxonomy',
  description: 'The graph-derived domain taxonomy including distance matrix, neighbor relationships, and mechanism coverage per domain.',
  mimeType: 'application/json'
}
```

This allows openclaw-research to subscribe to domain taxonomy changes and refresh its scout-adapter's domain distance data automatically.

---

## Summary: Implementation Priority

| Priority | Change | Files | Effort |
|---|---|---|---|
| P0 | Auto-populate domain distance matrix from graph | `domain-taxonomy.js` | Low |
| P0 | Expose `domain_distance` MCP tool | `tools.js`, new handler | Low |
| P1 | Upgrade `queryCrossDomainBridges()` with agnostic challenges + evidence | `domain-bridges.js` | Medium |
| P1 | New takeaway extraction capability | new `takeaway-extraction.js` | Medium |
| P1 | New `extract_takeaways` MCP tool | `tools.js`, new handler | Medium |
| P1 | Upgrade abstract mechanism layer with transferability scoring | `abstract-mechanisms.js`, `domain-bridges.js` | Medium |
| P2 | Domain-aware community analysis | `brainstorm-communities.js` | Medium |
| P2 | New `interdisciplinary_potential` MCP tool | `tools.js`, new handler | High |
| P2 | Post-ingestion refinement pass | `graph-precompute.js` | Medium |
| P3 | `TRANSFERABLE_TO` edge population | `domain-bridges.js` | Low |
| P3 | Domain taxonomy MCP resource | `resources.js` | Low |

---

## Cross-System Integration Points

The upgrades in both systems connect through these interfaces:

```
PaperNexus                          openclaw-research
───────────                         ─────────────────
domain_distance MCP tool      →     scout-adapter.ts (replace fake distance)
extract_takeaways MCP tool    →     integrator.ts (structured fragments)
queryCrossDomainBridges(      →     scout-adapter.ts (richer bridge evidence)
  agnosticChallenges)
interdisciplinary_potential   →     gatekeeper.ts (better sufficiency judgment)
  MCP tool
domain taxonomy resource      →     materializers.ts (auto-refresh distance data)
```

The recommended implementation order across both systems:

1. **PaperNexus P0** (domain distance) + **openclaw-research P0** (scout-adapter fix) — unblocks real domain distance
2. **PaperNexus P1** (bridge upgrade + takeaways) + **openclaw-research P0** (integrator rewrite) — unblocks structured fragments
3. **openclaw-research P1** (decomposer + translator) — improves question quality feeding into PaperNexus queries
4. Everything else in priority order
