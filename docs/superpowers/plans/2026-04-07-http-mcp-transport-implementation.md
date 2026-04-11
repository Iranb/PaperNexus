# HTTP MCP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated remote HTTP MCP support to PaperNexus while preserving the existing stdio MCP entrypoint.

**Architecture:** Extract MCP JSON-RPC business logic into a shared core, keep stdio framing in a thin adapter, and add a dedicated HTTP `/mcp` adapter mounted inside the existing `serve` server. Reuse the current bearer-token auth and keep the first version stateless with one JSON-RPC request per HTTP request.

**Tech Stack:** Node.js HTTP server, existing PaperNexus MCP JSON-RPC implementation, Node test runner.

---

### Task 1: Extract Shared MCP Core

**Files:**
- Create: `src/mcp/core.js`
- Create: `src/mcp/stdio.js`
- Modify: `src/mcp/server.js`
- Test: `test/mcp.test.js`

- [ ] **Step 1: Keep current stdio MCP behavior covered**

Read `test/mcp.test.js` and preserve the existing request/response contract for:
- `initialize`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

- [ ] **Step 2: Move transport-agnostic logic into `src/mcp/core.js`**

Export:
- `SERVER_INFO`
- `executeTool(name, args)`
- `normalizeToolContent(result)`
- `handleMessage(message)`
- a small helper to build JSON-RPC error objects consistently

- [ ] **Step 3: Move stdio framing into `src/mcp/stdio.js`**

Keep only:
- `Content-Length` parsing
- stdin/stdout read loop
- JSON parse failure handling
- request/response emission

- [ ] **Step 4: Make `src/mcp/server.js` a compatibility shim**

Re-export the stdio entrypoint so current CLI wiring still works without further call-site changes.

- [ ] **Step 5: Run stdio MCP regression tests**

Run: `node --test test/mcp.test.js`
Expected: PASS

### Task 2: Add HTTP MCP Adapter

**Files:**
- Create: `src/mcp/http.js`
- Test: `test/mcp-http.test.js`

- [ ] **Step 1: Write failing HTTP MCP tests**

Cover:
- `initialize` over HTTP
- `tools/list`
- representative `tools/call`
- representative `resources/read`
- representative `prompts/get`
- invalid JSON
- batch array rejection
- unsupported method rejection

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test test/mcp-http.test.js`
Expected: FAIL because HTTP MCP route/adapter does not exist yet.

- [ ] **Step 3: Implement `src/mcp/http.js`**

Add a thin adapter that:
- accepts Node `request` / `response`
- reads one JSON body
- rejects request arrays
- calls shared `handleMessage`
- returns JSON-RPC result or error payload

- [ ] **Step 4: Keep v1 transport stateless**

Do not add session storage, SSE, or websocket behavior in this pass.

- [ ] **Step 5: Re-run HTTP MCP tests**

Run: `node --test test/mcp-http.test.js`
Expected: PASS

### Task 3: Integrate HTTP MCP Into `serve`

**Files:**
- Modify: `src/server/http.js`
- Modify: `src/cli/index.js`
- Test: `test/http-auth.test.js`
- Test: `test/mcp-http.test.js`

- [ ] **Step 1: Add serve MCP config resolution**

Read `options.config.serve.mcp` with defaults:
- `enabled: false`
- `path: "/mcp"`
- `transport: "streamable-http"`
- `allowSseFallback: false`

- [ ] **Step 2: Mount the dedicated MCP route**

In `serveCommand`, route requests matching the configured MCP path to the HTTP MCP adapter before static-file fallback.

- [ ] **Step 3: Apply the existing bearer-token policy**

Require the same token used for `/api/*`.

Behavior:
- MCP disabled -> `404`
- MCP enabled with missing token -> fail closed
- bad or missing token -> `401`

- [ ] **Step 4: Add startup logging**

Print whether HTTP MCP is enabled and, if enabled, the bound path and transport mode.

- [ ] **Step 5: Re-run auth and route tests**

Run: `node --test test/http-auth.test.js test/mcp-http.test.js`
Expected: PASS

### Task 4: Update CLI Snippets And Docs

**Files:**
- Modify: `src/cli/index.js`
- Modify: `README.md`
- Modify: `manual/README_zh.md` (or the closest existing Chinese manual path if this file is absent)

- [ ] **Step 1: Update MCP setup/help output**

When serving config enables MCP, print a remote HTTP MCP example snippet in addition to the stdio snippet.

- [ ] **Step 2: Document remote MCP usage**

Add an OpenClaw example with:
- `url`
- `transport: "streamable-http"`
- `Authorization: Bearer ...`

- [ ] **Step 3: Mention that stdio remains supported**

Keep docs explicit that `papernexus mcp` still works for local workflows.

### Task 5: Full Verification

**Files:**
- Test: `test/mcp.test.js`
- Test: `test/mcp-http.test.js`
- Test: `test/http-auth.test.js`

- [ ] **Step 1: Run stdio MCP regression tests**

Run: `node --test test/mcp.test.js`
Expected: PASS

- [ ] **Step 2: Run HTTP MCP test suite**

Run: `node --test test/mcp-http.test.js`
Expected: PASS

- [ ] **Step 3: Run auth regression tests**

Run: `node --test test/http-auth.test.js`
Expected: PASS

- [ ] **Step 4: Run combined targeted verification**

Run: `node --test test/mcp.test.js test/mcp-http.test.js test/http-auth.test.js`
Expected: PASS
