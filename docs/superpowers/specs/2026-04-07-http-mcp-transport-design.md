# HTTP MCP Transport Design

## Summary

This design adds a real remote HTTP MCP transport to PaperNexus so OpenClaw and other MCP clients can connect to a running PaperNexus server without SSH stdio bridging.

The recommended shape is:

- keep the current `papernexus mcp` stdio entrypoint working
- extract the MCP business logic into a transport-agnostic core
- expose that same MCP surface from the existing `papernexus serve` HTTP server
- make `streamable-http` the first-class remote transport
- optionally add `sse` compatibility later if a concrete client still needs it

## Context

PaperNexus already has two useful pieces:

- a hand-rolled stdio MCP server in [src/mcp/server.js](../../../src/mcp/server.js)
- an authenticated HTTP server in [src/server/http.js](../../../src/server/http.js)

Today these paths are disconnected:

- remote clients that want MCP must use SSH or some other stdio bridge
- the existing HTTP server already has token auth, port binding, lifecycle, and logging, but it does not expose MCP
- the current MCP implementation mixes transport framing and business logic, which makes a second transport harder to add cleanly

This creates friction for OpenClaw because OpenClaw already supports remote MCP over HTTP with `url`, `transport`, and `headers`, while PaperNexus only exposes MCP over stdio.

## Goals

- make PaperNexus usable as a real remote MCP server over HTTP
- let OpenClaw connect directly to PaperNexus with a normal MCP server entry
- reuse the existing `serve` process, token auth, and config surface
- preserve the current stdio MCP entrypoint for local tools and tests
- avoid duplicating tool, prompt, and resource business logic across transports
- keep the first version small and testable

## Non-Goals

- replacing the existing PaperNexus Web API
- redesigning tool names, prompt names, or resource URIs
- adding multi-tenant auth or per-tool authorization
- introducing WebSocket transport in v1
- removing the current stdio MCP mode

## Recommended Approach

Build a transport-agnostic MCP core, then mount it behind both stdio and HTTP adapters.

### 1. Extract A Shared MCP Core

Refactor [src/mcp/server.js](../../../src/mcp/server.js) into two layers:

- `src/mcp/core.js`
- `src/mcp/stdio.js`

`src/mcp/core.js` should own:

- `SERVER_INFO`
- `executeTool(name, args)`
- prompt listing and prompt lookup
- resource listing and resource reads
- `handleMessage(message)` for JSON-RPC request-to-result handling
- normalization of tool content and error shaping

`src/mcp/stdio.js` should own only:

- stdin/stdout framing
- Content-Length parsing
- process lifecycle and exit behavior

This keeps all MCP semantics in one place so HTTP transport does not need to reimplement tool logic.

### 2. Add An HTTP MCP Adapter

Add a new module:

- `src/mcp/http.js`

This module should:

- accept Node HTTP `request` and `response`
- parse one MCP JSON-RPC request per HTTP request
- call the shared `handleMessage(...)`
- serialize the JSON-RPC result back to the client
- translate thrown errors into protocol-safe JSON-RPC errors

Recommended v1 scope:

- support single-request JSON payloads only
- reject batch arrays with a clear `-32600` style invalid-request error
- support the request types already covered by stdio tests:
  - `initialize`
  - `tools/list`
  - `tools/call`
  - `resources/list`
  - `resources/read`
  - `prompts/list`
  - `prompts/get`

### 3. Make `streamable-http` The Primary Remote Transport

The first-class remote transport should be `streamable-http`.

Why:

- it matches OpenClaw's native HTTP MCP support well
- it avoids the operational awkwardness of SSH stdio bridges
- it fits the mostly stateless nature of PaperNexus MCP calls
- it is easier to secure and observe behind a normal HTTP service boundary

Implementation guidance:

- expose a dedicated MCP endpoint, preferably `/mcp`
- keep the endpoint stateless in v1
- use normal request/response semantics for each JSON-RPC request
- do not require server-side session state unless a later client proves it is necessary

Optional follow-up:

- add an SSE compatibility mode only if a real target client still requires it

### 4. Reuse Existing HTTP Auth And Serve Lifecycle

Do not create a second standalone web server for MCP unless there is a hard protocol blocker.

Instead:

- extend [src/server/http.js](../../../src/server/http.js)
- route requests matching the configured MCP path into `src/mcp/http.js`
- protect that route with the same bearer-token logic already used for `/api/*`
- reuse the same host, port, startup, shutdown, and worker lifecycle as `papernexus serve`

This keeps remote deployment simple:

- one process
- one port
- one auth token
- one place for logs and health checks

## Configuration Shape

Add an MCP section under `serve`:

```json
{
  "serve": {
    "host": "0.0.0.0",
    "port": 4821,
    "apiToken": "replace-with-your-api-token",
    "mcp": {
      "enabled": true,
      "path": "/mcp",
      "transport": "streamable-http",
      "allowSseFallback": false
    }
  }
}
```

Recommended behavior:

- `enabled` default: `false`
- `path` default: `/mcp`
- `transport` default: `streamable-http`
- `allowSseFallback` default: `false`

If MCP is disabled:

- requests to the MCP path should return `404`

If MCP is enabled but auth is not configured:

- follow the same fail-closed rule as the authenticated API
- return a clear `503` or `401` style error instead of silently exposing MCP

## Protocol Strategy

Preferred implementation strategy:

- keep PaperNexus business logic local
- keep the transport boundary thin
- prefer standards-compliant transport behavior over clever shortcuts

If integrating the official MCP SDK transport layer is low-friction, that is preferable for HTTP transport correctness.

If SDK integration would force a large rewrite, implement a thin in-house HTTP adapter around the extracted shared core first. The important constraint is that transport framing must remain isolated from tool logic so the implementation can later swap to an SDK-backed transport without rewriting the business layer again.

## Route Design

Recommended route behavior:

- `POST /mcp`
  - authenticated MCP request handling
- `GET /mcp`
  - optional protocol discovery or a simple explanatory error, depending on transport needs

Do not overload the existing `/api/*` JSON endpoints with MCP semantics.

The MCP endpoint should stay separate so:

- clients can point directly at a conventional MCP URL
- logs clearly distinguish MCP traffic from the PaperNexus Web API
- future transport behavior can evolve without breaking existing API clients

## Logging And Observability

Add lightweight request logging for MCP HTTP traffic:

- timestamp
- remote address if available
- MCP method
- status code
- duration in milliseconds
- transport mode

Avoid logging:

- raw bearer tokens
- full request bodies for large tool calls
- sensitive paper contents

## CLI And Documentation Changes

Keep:

- `papernexus mcp` for stdio

Update:

- `papernexus serve` docs to mention optional HTTP MCP exposure
- `papernexus setup` output to print an HTTP MCP snippet when `serve.mcp.enabled` is configured
- README and `manual/README_zh.md` with a remote MCP example for OpenClaw

Recommended OpenClaw example:

```json
{
  "mcp": {
    "servers": {
      "papernexus-remote": {
        "url": "https://your-host.example.com/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${PAPERNEXUS_MCP_TOKEN}"
        },
        "connectionTimeoutMs": 30000
      }
    }
  }
}
```

## Implementation Phases

### Phase 1. Shared-Core Refactor

- extract `src/mcp/core.js`
- keep current stdio behavior unchanged
- update stdio tests to target the extracted core behavior indirectly

Exit criteria:

- `papernexus mcp` still passes the current MCP test suite

### Phase 2. HTTP Transport Adapter

- add `src/mcp/http.js`
- implement HTTP request parsing and JSON-RPC response shaping
- reject unsupported request forms cleanly

Exit criteria:

- HTTP transport can successfully run `initialize`, `tools/list`, and `tools/call`

### Phase 3. `serve` Integration And Auth

- add `serve.mcp` config parsing
- mount the MCP route in `src/server/http.js`
- apply the same auth policy used for protected API routes
- add startup logging that prints whether MCP HTTP is enabled and at what path

Exit criteria:

- `papernexus serve` exposes an authenticated `/mcp` endpoint when enabled

### Phase 4. Tests And Docs

- add dedicated HTTP MCP tests
- update README, manual, and setup snippets
- add at least one config example for OpenClaw remote MCP

Exit criteria:

- a clean-room user can start `papernexus serve`, point OpenClaw at the MCP URL, and complete a basic tool call

## Testing Strategy

Add a new test file:

- `test/mcp-http.test.js`

Test coverage should include:

- `initialize` over HTTP
- `tools/list` over HTTP
- representative `tools/call` success case
- representative `resources/read` success case
- representative `prompts/get` success case
- invalid auth returns `401`
- missing auth when enabled returns `401`
- MCP disabled returns `404`
- unsupported HTTP method returns `405`
- invalid JSON returns a protocol-safe error
- batch request array returns a clear invalid-request error

Keep the current [test/mcp.test.js](../../../test/mcp.test.js) as the regression suite for stdio mode.

## Rollout Plan

1. Land the shared-core refactor with no behavior change.
2. Land HTTP MCP behind `serve.mcp.enabled = false`.
3. Enable it on one remote host only.
4. Validate with a real OpenClaw server entry using `streamable-http`.
5. After real-client validation, document it as the recommended remote MCP path.

## Risks And Mitigations

- Risk: protocol drift from MCP expectations.
  Mitigation: isolate the transport layer and prefer a standards-compliant transport implementation.

- Risk: auth accidentally left open on the MCP endpoint.
  Mitigation: fail closed when MCP is enabled but no token is configured.

- Risk: duplicated logic between stdio and HTTP modes.
  Mitigation: force all request handling through a single shared core.

- Risk: existing `serve` route handling becomes harder to maintain.
  Mitigation: keep MCP route handling in `src/mcp/http.js` and make `src/server/http.js` only dispatch to it.

## Open Questions

- Whether to expose only `/mcp`, or both `/mcp` and `/api/mcp` for transition convenience.
- Whether to add SSE compatibility in the first release or defer until a client actually needs it.
- Whether to adopt the official MCP SDK immediately or keep the first HTTP transport implementation dependency-light.

## Expected Outcome

After this change:

- PaperNexus can run as a real remote MCP server over HTTP
- OpenClaw can connect to PaperNexus directly without SSH stdio bridging
- stdio MCP continues to work for local workflows
- remote MCP deployment becomes easier to secure, observe, and document
