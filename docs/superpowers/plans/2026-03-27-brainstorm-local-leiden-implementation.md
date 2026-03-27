# Brainstorm Local Leiden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot, query-local community enhancement layer that improves `brainstorm` and `ideas` by surfacing latent same-theme concepts and cross-theme bridge opportunities without storing any cluster state.

**Architecture:** Keep all orchestration inside `src/core/search/search.js`, but move projection and local community analysis into a focused helper module at `src/core/search/brainstorm-communities.js`. Build one in-memory session per query, share it between divergence and idea generation, and keep the enhancement strictly additive with hard pruning and fallback rules.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing graph/search helpers in `src/core/search/search.js`, local graph model in `src/core/graph/*`

---

## File Map

- Create: `src/core/search/brainstorm-communities.js`
  Purpose: query-local candidate pruning, concept projection, local community grouping, latent-neighbor and bridge extraction
- Modify: `src/core/search/search.js`
  Purpose: create a shared brainstorm session, integrate community-derived candidates into `buildDivergence` and `buildResearchIdeas`
- Modify: `test/brainstorm-view.test.js`
  Purpose: focused local search/community regression coverage close to existing brainstorm tests
- Modify: `test/query-api.test.js`
  Purpose: verify the API-level brainstorm and ideas flows still return useful results after integration

### Task 1: Add Tests For Query-Local Community Expansion

**Files:**
- Modify: `test/brainstorm-view.test.js`
- Test: `test/brainstorm-view.test.js`

- [ ] **Step 1: Write failing tests for latent same-community expansion**

```js
test('brainstorm divergence can surface same-community latent neighbors without direct edges', () => {
  const graph = createKnowledgeGraph();
  // Build two seed-supported problems plus a method that co-occurs through Paper support.
  // Omit the direct concept-concept edge for the latent concept.
  const result = buildBrainstorm(graph, 'planning', { mode: 'diverge', maxHops: 2 });
  assert.ok(result.relatedConcepts.some((entry) => entry.name === 'latent method name'));
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the right reason**

Run: `node --test test/brainstorm-view.test.js`
Expected: FAIL because the latent community concept is not yet surfaced by `buildBrainstorm`

- [ ] **Step 3: Write failing tests for cross-community bridge idea generation**

```js
test('research ideas can add a cross-community method combination candidate', () => {
  const graph = createKnowledgeGraph();
  // Build two neighboring method communities connected through seed papers and compatible local structure.
  const result = buildResearchIdeas(graph, 'planning', { limit: 6 });
  assert.ok(result.ideas.some((idea) => idea.template === 'community_method_combination'));
});
```

- [ ] **Step 4: Run the focused test again and verify the new idea test fails cleanly**

Run: `node --test test/brainstorm-view.test.js`
Expected: FAIL because the community bridge idea path does not exist yet

- [ ] **Step 5: Commit the red tests**

```bash
git add test/brainstorm-view.test.js
git commit -m "test: cover local brainstorm community expansion"
```

### Task 2: Implement The Local Community Helper

**Files:**
- Create: `src/core/search/brainstorm-communities.js`
- Modify: `test/brainstorm-view.test.js`
- Test: `test/brainstorm-view.test.js`

- [ ] **Step 1: Write the helper API with pure input/output boundaries**

```js
export function buildBrainstormCommunityContext(graph, session, options = {}) {
  return {
    communities: [],
    subcommunities: [],
    latentNeighbors: [],
    boundaryNodes: [],
    crossCommunityBridges: [],
    stats: { prunedNodeCount: 0, edgeCount: 0, fallback: true }
  };
}
```

- [ ] **Step 2: Implement candidate pruning and concept-only projection**

```js
function collectCandidateConcepts(graph, relationIndex, seedPapers, seedNodes, query, options) {
  // Score brainstorm-eligible concept nodes using query overlap, explicit edges, seed-paper support, and type priority.
}

function buildProjectedConceptGraph(graph, relationIndex, candidates, seedPapers, options) {
  // Keep explicit concept edges as backbone and add only bounded paper-derived weak edges.
}
```

- [ ] **Step 3: Implement a lightweight two-level local community pass**

```js
function partitionProjectedGraph(projected, options) {
  // Group strongly connected local concepts into first-level communities,
  // then split only oversized communities into shallow subcommunities.
}
```

- [ ] **Step 4: Derive latent neighbors, boundary nodes, and cross-community bridges**

```js
function deriveLatentNeighbors(projected, communities, seedNodeIds) {}
function deriveBoundaryNodes(projected, communities) {}
function deriveCrossCommunityBridges(projected, communities, boundaryNodes) {}
```

- [ ] **Step 5: Run the focused tests and make sure the helper behavior passes**

Run: `node --test test/brainstorm-view.test.js`
Expected: PASS for the new community-focused tests and existing brainstorm tests

- [ ] **Step 6: Commit the helper implementation**

```bash
git add src/core/search/brainstorm-communities.js test/brainstorm-view.test.js
git commit -m "feat: add local brainstorm community helper"
```

### Task 3: Integrate Shared Session Plumbing In Search

**Files:**
- Modify: `src/core/search/search.js`
- Modify: `test/brainstorm-view.test.js`
- Test: `test/brainstorm-view.test.js`

- [ ] **Step 1: Add a shared brainstorm session creator**

```js
function createBrainstormSession(graph, query, options = {}) {
  const relationIndex = buildRelationIndex(graph);
  const seedPapers = collectRelevantPaperIds(graph, query, relationIndex, { nodeView: 'brainstorm' });
  const seedNodes = resolveNodeCandidates(graph, query, { nodeView: 'brainstorm' });
  let communityContext = null;

  return {
    relationIndex,
    seedPapers,
    seedNodes,
    getCommunityContext() {
      if (!communityContext) {
        communityContext = buildBrainstormCommunityContext(graph, { query, relationIndex, seedPapers, seedNodes }, options);
      }
      return communityContext;
    }
  };
}
```

- [ ] **Step 2: Thread the shared session through `buildDivergence`**

```js
function buildDivergence(graph, query, options = {}) {
  const session = createBrainstormSession(graph, query, options);
  const base = /* existing divergence logic */;
  const community = session.getCommunityContext();
  // Merge in latent neighbors and boundary nodes conservatively.
}
```

- [ ] **Step 3: Thread the shared session through `buildResearchIdeas`**

```js
export function buildResearchIdeas(graph, query, options = {}) {
  const session = createBrainstormSession(graph, query, options);
  const community = session.getCommunityContext();
  // Convert cross-community bridges into a small number of idea candidates.
}
```

- [ ] **Step 4: Add fallback guards so sparse local graphs return existing behavior**

```js
if (!community || community.stats.fallback) {
  return existingResult;
}
```

- [ ] **Step 5: Run the focused search tests and verify the integration passes**

Run: `node --test test/brainstorm-view.test.js`
Expected: PASS with both existing and new community-enhanced assertions

- [ ] **Step 6: Commit the search integration**

```bash
git add src/core/search/search.js test/brainstorm-view.test.js
git commit -m "feat: integrate local communities into brainstorm search"
```

### Task 4: Verify API Behavior And Regressions

**Files:**
- Modify: `test/query-api.test.js`
- Test: `test/query-api.test.js`
- Test: `test/brainstorm-view.test.js`

- [ ] **Step 1: Add a narrow API regression assertion**

```js
test('query APIs still return brainstorm and idea results after local community integration', async () => {
  const ideas = await api.ideasGraphPayload(fixture.indexRoot, { query: 'experiment planning', options: { limit: 5 } });
  const brainstorm = await api.brainstormGraphPayload(fixture.indexRoot, { query: 'experiment planning', options: { mode: 'converge', limit: 5, maxHops: 2 } });
  assert.ok(ideas.result.ideas.length > 0);
  assert.ok(brainstorm.result.convergedDirections.length > 0);
});
```

- [ ] **Step 2: Run the API-focused regression test first and verify behavior**

Run: `node --test test/query-api.test.js`
Expected: PASS with unchanged API contract and valid brainstorm/idea results

- [ ] **Step 3: Run the full relevant regression slice**

Run: `node --test test/brainstorm-view.test.js test/query-api.test.js`
Expected: PASS

- [ ] **Step 4: Run the broader suite before closing the task**

Run: `node --test`
Expected: PASS, or if unrelated pre-existing failures appear, capture them immediately before proceeding

- [ ] **Step 5: Commit verification updates**

```bash
git add test/query-api.test.js
git commit -m "test: cover brainstorm community integration regressions"
```

### Task 5: Final Review And Branch Readiness

**Files:**
- Review only

- [ ] **Step 1: Review the diff for scope and fallback behavior**

Run: `git diff --stat HEAD~4..HEAD`
Expected: Only community helper, search integration, and targeted tests are included

- [ ] **Step 2: Re-run the most important targeted tests**

Run: `node --test test/brainstorm-view.test.js test/query-api.test.js`
Expected: PASS

- [ ] **Step 3: Prepare branch summary**

Capture:
- what changed
- how fallback works
- which tests passed
- any remaining tuning risks in edge weights or thresholds

- [ ] **Step 4: Commit any last small cleanups if needed**

```bash
git add -A
git commit -m "chore: polish local brainstorm community heuristics"
```

- [ ] **Step 5: Hand off for branch finishing**

Next required skill: `superpowers:finishing-a-development-branch`
