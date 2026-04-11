# Remote HTTP MCP-Only Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PaperNexus skill-side live graph control with remote HTTP MCP only by adding four high-level MCP workflow tools and migrating all PaperNexus Python wrappers and skill docs away from `/api/*`.

**Architecture:** Add four aggregated MCP tools on the PaperNexus server, keep the current Python wrapper entrypoints as thin clients over HTTP MCP JSON-RPC, and preserve SSH/rsync staging plus local task registry behavior in the wrappers. The migration is remote-only for skills: no stdio MCP and no direct `/api/*` control flow remain in skill-local wrappers.

**Tech Stack:** Node.js MCP server, existing PaperNexus API payload builders, Python CLI wrappers, JSON-RPC over HTTP, Node test runner, Python remote-script tests.

---

### Task 1: Add Red Tests For High-Level MCP Tool Discovery

**Files:**
- Modify: `test/mcp.test.js`
- Modify: `test/mcp-http.test.js`
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`

- [ ] **Step 1: Write failing MCP discovery assertions**

Add tests that expect `tools/list` to expose:
- `research_lookup`
- `research_briefing`
- `import_workflow`
- `idea_catalyst`

- [ ] **Step 2: Run focused MCP tests to verify they fail**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: FAIL because the new tools do not exist yet.

- [ ] **Step 3: Add one failing per-tool smoke call**

Write one minimal `tools/call` test per tool using invalid or incomplete arguments and assert that the server reaches tool dispatch far enough to return a validation-style error rather than “Unknown tool”.

- [ ] **Step 4: Re-run the focused MCP tests**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: FAIL for the right reason: missing tool registration.

### Task 2: Implement `research_lookup` And `research_briefing`

**Files:**
- Create: `src/mcp/tool-research-lookup.js`
- Create: `src/mcp/tool-research-briefing.js`
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/core.js`
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`

- [ ] **Step 1: Write failing operation-dispatch tests**

Add tests that call:
- `research_lookup` with `operation: "query"` and `operation: "brainstorm"`
- `research_briefing` with `operation: "evidence_chain"` and `operation: "paper_enhancement"`

Verify the returned payloads are structured JSON content rather than only human-rendered markdown.

- [ ] **Step 2: Run the focused MCP tests to verify they fail**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: FAIL because no handler exists yet.

- [ ] **Step 3: Implement `research_lookup`**

Route each lookup operation to the existing low-level graph builders:
- `queryGraphPayload`
- `contextGraphPayload`
- `impactGraphPayload`
- `ideasGraphPayload`
- `brainstormGraphPayload`
- plus domain-distance and takeaway helpers

- [ ] **Step 4: Implement `research_briefing`**

Route briefing operations to:
- `pathTraceGraphPayload`
- `evidenceChainPayload`
- `reflectionChainPayload`
- `theoryBriefPayload`
- `storylineBriefPayload`
- `researchBriefPayload`
- `brainstormBriefPayload`
- `paperEnhancementPayload`

- [ ] **Step 5: Register the new tool schemas and dispatcher branches**

Update `src/mcp/tools.js` and `src/mcp/core.js` so the new tools are first-class.

- [ ] **Step 6: Re-run focused MCP tests**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: PASS

### Task 3: Implement `import_workflow`

**Files:**
- Create: `src/mcp/tool-import-workflow.js`
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/core.js`
- Modify: `src/server/api.js`
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`
- Test: `test/python-remote-scripts.test.js`

- [ ] **Step 1: Write failing MCP import workflow tests**

Add tests for:
- `submit`
- `status`
- `log`
- `wait`

For `wait`, verify the server returns terminal task state plus log output without the client needing manual polling loops.

- [ ] **Step 2: Run the import-focused tests to verify they fail**

Run: `node --test test/mcp.test.js test/mcp-http.test.js test/python-remote-scripts.test.js`
Expected: FAIL because `import_workflow` does not exist.

- [ ] **Step 3: Add a shared server-side wait helper**

Move or extract the queue wait loop into server-side code so both MCP and any future internal callers can use one implementation.

- [ ] **Step 4: Implement `import_workflow` operations**

Support:
- `submit`
- `list`
- `status`
- `log`
- `wait`

Return structured task payloads that the Python registry helpers can consume without route-specific assumptions.

- [ ] **Step 5: Re-run the import-focused tests**

Run: `node --test test/mcp.test.js test/mcp-http.test.js test/python-remote-scripts.test.js`
Expected: PASS for the new tool behavior.

### Task 4: Implement `idea_catalyst` As One MCP Tool

**Files:**
- Create: `src/mcp/tool-idea-catalyst.js`
- Modify: `src/mcp/tools.js`
- Modify: `src/mcp/core.js`
- Modify: `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`

- [ ] **Step 1: Write failing `idea_catalyst` MCP tests**

Add coverage for:
- a data-starved output
- a success-path output with idea fragments

Use stub-friendly seams where necessary for LLM-backed phases.

- [ ] **Step 2: Run focused `idea_catalyst` tests to verify they fail**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: FAIL because `idea_catalyst` does not exist.

- [ ] **Step 3: Move the orchestration logic behind one server-side tool**

Implement a focused server module that performs:
- decomposition
- abstraction
- source-domain selection
- sufficiency evaluation
- requisition or idea-fragment result creation

- [ ] **Step 4: Make `pn_idea_catalyst.py` a thin MCP client**

Keep CLI flags and output contract, but replace direct `/api/*` calls with one `tools/call`.

- [ ] **Step 5: Re-run focused `idea_catalyst` tests**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: PASS

### Task 5: Migrate Python Wrappers To HTTP MCP

**Files:**
- Modify: `SKILL/PaperNexus/scripts/pn_common.py`
- Modify: `SKILL/PaperNexus/scripts/pn_graph_query.py`
- Modify: `SKILL/PaperNexus/scripts/pn_research_chains.py`
- Modify: `SKILL/PaperNexus/scripts/pn_import_submit.py`
- Modify: `SKILL/PaperNexus/scripts/pn_import_queue.py`
- Modify: `SKILL/PaperNexus/scripts/pn_batch_import.py`
- Modify: `scripts/pn_graph_query.py`
- Modify: `scripts/pn_import_queue.py`
- Test: `test/python-remote-scripts.test.js`

- [ ] **Step 1: Write failing wrapper transport tests**

Update Python wrapper tests so they expect:
- `--mcp-url` instead of `--api-base`
- MCP JSON-RPC over HTTP
- rejection of local MCP URLs unless a test-only override is enabled

- [ ] **Step 2: Run wrapper tests to verify they fail**

Run: `node --test test/python-remote-scripts.test.js`
Expected: FAIL because the wrappers still use `/api/*`.

- [ ] **Step 3: Add a shared HTTP MCP client in `pn_common.py`**

Implement:
- MCP URL normalization
- remote-only URL validation
- JSON-RPC request builder
- `tools/call` helper

- [ ] **Step 4: Rewrite the wrappers as thin clients**

Map wrappers to tools:
- `pn_graph_query.py` -> `research_lookup`
- `pn_research_chains.py` -> `research_briefing`
- `pn_import_submit.py`, `pn_import_queue.py`, `pn_batch_import.py` -> `import_workflow`

- [ ] **Step 5: Preserve staging and local task registry behavior**

Keep:
- `ssh`/`rsync` staging
- local temp task registry
- source-to-task resolution

Change only the PaperNexus transport layer.

- [ ] **Step 6: Re-run wrapper tests**

Run: `node --test test/python-remote-scripts.test.js`
Expected: PASS

### Task 6: Update All PaperNexus Skill Docs To MCP-Only

**Files:**
- Modify: `SKILL/PaperNexus/SKILL.md`
- Modify: `SKILL/PaperNexusBatchImport/SKILL.md`
- Modify: `SKILL/PaperNexusResearchChains/SKILL.md`
- Modify: `SKILL/PaperNexusIdeaCatalyst/SKILL.md`
- Modify: `SKILL/PaperNexusReflection/SKILL.md`
- Modify: `SKILL/PaperNexusAgenticReasoning/SKILL.md`

- [ ] **Step 1: Remove `/api/*` guidance**

Delete live-graph instructions that tell users or agents to call `/api/*` routes directly.

- [ ] **Step 2: Replace connection settings**

Document:
- `PAPERNEXUS_MCP_URL`
- `PAPERNEXUS_MCP_TOKEN`
- `PAPERNEXUS_CORPUS`

- [ ] **Step 3: Enforce remote-only wording**

State clearly:
- remote HTTP MCP is the only supported skill control plane
- local stdio MCP is not allowed for skill workflows
- local CLI is not the control plane for live corpora

### Task 7: Full Verification

**Files:**
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`
- Test: `test/python-remote-scripts.test.js`

- [ ] **Step 1: Run MCP tests**

Run: `node --test test/mcp.test.js test/mcp-http.test.js`
Expected: PASS

- [ ] **Step 2: Run Python wrapper tests**

Run: `node --test test/python-remote-scripts.test.js`
Expected: PASS

- [ ] **Step 3: Run combined targeted verification**

Run: `node --test test/mcp.test.js test/mcp-http.test.js test/python-remote-scripts.test.js`
Expected: PASS

- [ ] **Step 4: Spot-check skill docs**

Verify there are no remaining live-workflow `/api/*` instructions in:
- `SKILL/PaperNexus/*.md`
- `SKILL/PaperNexus*/*.md`
