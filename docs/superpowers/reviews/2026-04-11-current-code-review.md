# PaperNexus Current Code Review

Date: 2026-04-11
Branch reviewed: `main`
Scope: current code under `src/`, `scripts/`, `web/`, `SKILL/`, `test/`, `config.example.json`, and `package.json`
Files inventoried: 183 tracked code/config/test files
Recommendation: REQUEST CHANGES

## Executive Summary

The current codebase is materially healthier than the earlier review baseline. The previously observed high-impact issues around repository-wide tests, stale lock heartbeats, quarantined task lookup, browser token persistence, and `update --force` have been addressed. The staged pipeline, import queue, parser state, and remote MCP surfaces are now much more operationally coherent.

The main remaining risks are concentrated in newer recovery/security edges rather than broad architectural problems:

1. failed-import recovery can mark a failed task completed by filename identity even when content fingerprints differ
2. Linux system keyring writes use `require()` inside an ES module and therefore cannot actually use `secret-tool` or `pass` for storage
3. backup archive unpack delegates extraction directly to `tar` without validating archive member paths or link targets
4. authenticated `serverFilePath` import can read any server-side regular file reachable by the PaperNexus process
5. bearer-token comparison uses direct string comparison rather than timing-safe comparison

No critical vulnerabilities were found in this pass, and the full test suite is green.

## Verification Performed

```bash
npm test
```

Result:

```text
264/264 passing
```

Additional inspection:

- static scans for hardcoded secrets, shell execution, token handling, `innerHTML`, file writes, JSON parsing, and lock usage
- manual review of highest-risk modules:
  - `src/storage/import-store.js`
  - `src/core/imports/worker.js`
  - `src/core/ingestion/pipeline.js`
  - `src/core/ingestion/pdf-parser.js`
  - `src/server/api.js`
  - `src/server/http.js`
  - `src/lib/fs.js`
  - `src/lib/keychain*.js`
  - `src/storage/backup-archive.js`
  - `web/app.js`
  - skill wrapper scripts under `SKILL/PaperNexus/scripts`

## Findings

### HIGH: failed-import recovery can false-complete a different file with the same normalized name

Files:

- `src/storage/import-store.js:263`
- `src/storage/import-store.js:269`
- `src/storage/import-store.js:284`
- `src/storage/import-store.js:607`
- `src/storage/import-store.js:613`
- `src/storage/import-store.js:642`

What happens:

- `createImportTaskContentKey()` creates a strong identity from `kind:size:contentFingerprint`.
- `findCompletedEquivalentImportTasks()` first checks that content key.
- If the content key exists but does not match any completed task, the code still falls back to `createImportTaskNameKey()`.
- The name key normalizes away punctuation and case, then treats same-name tasks as equivalent.

Why this is risky:

- A failed upload and a completed upload can share a filename while containing different papers or different PDF revisions.
- This is especially risky for generic names such as `paper.pdf`, `cvpr_iccv_2024_13.pdf`, `supplement.pdf`, or reused local filenames.
- In that case, recovery can mark the failed task as `completed / completed` even though its actual content never entered the graph.
- Agents will then continue incorrectly because the task looks successful.

Recommended fix:

- If a failed task has a complete content key, only use content-key equivalence.
- Use filename equivalence only when content fingerprints are missing from one or both tasks, and mark it as a weaker recovery mode.
- Consider a stricter fallback for arXiv-like identifiers only:
  - safe-ish: `2603.24268.pdf` vs `260324268.pdf`
  - unsafe: arbitrary identical basenames
- Add tests:
  - same filename, different content must requeue or remain failed
  - same arXiv-like normalized id, missing content key may supersede only with explicit `recovery.matchMode = normalized-id`

### MEDIUM: Linux keyring storage paths use `require()` inside an ES module

Files:

- `src/lib/keychain-linux.js:37`
- `src/lib/keychain-linux.js:80`

What happens:

- The package is ESM (`"type": "module"` in `package.json`).
- `keychain-linux.js` imports `execFile` with ESM syntax but calls `require('child_process').spawn(...)` inside `storeViaSecretTool()` and `storeViaPass()`.
- In an ES module, `require` is not defined.

Why this matters:

- On Linux systems where `secret-tool` or `pass` is available, `setSecret()` tries to use those backends.
- The first write path throws before the tool can receive the secret.
- `keychain.js` catches the failure and falls back to encrypted local storage, so the user may think they are using the system keyring while PaperNexus actually stores the key in the fallback backend.
- This weakens the security expectation and can confuse operational diagnostics.

Recommended fix:

- Import `spawn` at module top level:

```js
import { execFile, spawn } from 'node:child_process';
```

- Replace both `require('child_process').spawn(...)` calls with `spawn(...)`.
- Add a Linux-backend unit test using injected fake runners or a mocked child process interface.
- Consider surfacing fallback backend selection more explicitly in `papernexus auth llm set`.

### MEDIUM: backup unpack trusts archive extraction without validating members

File:

- `src/storage/backup-archive.js:359`

What happens:

- `unpackCorpusArchive()` prepares the output directory and directly runs:

```js
tar -xzf <archive> -C <output>
```

- It then reads `export.json` from the output directory.

Why this matters:

- A malicious or malformed tarball can contain surprising entries:
  - absolute paths
  - `../` traversal attempts
  - symlinks or hardlinks pointing outside the restore directory
  - device-like or special entries, depending on tar behavior/platform
- GNU tar blocks some unsafe patterns by default, but relying on platform-specific tar safety is brittle.
- The backup loader is likely used with archives that users downloaded or received from another system, so it should fail closed before extraction.

Recommended fix:

- List archive contents first with `tar -tzf`.
- Reject members that:
  - are absolute
  - contain `..`
  - contain empty path segments
  - are symlinks/hardlinks if not explicitly supported
- Extract into a fresh temporary directory first, validate `export.json`, then move or return the prepared restore directory.
- Add tests with malicious entries and symlink entries.

### MEDIUM: authenticated server-side import can read any regular file accessible to the service process

Files:

- `src/server/api.js:1235`
- `src/server/api.js:1239`
- `src/server/api.js:1255`
- `src/server/api.js:1259`

What happens:

- `serverFilePath` accepts any absolute path or `~/...` path on the API server.
- If the path is a regular file, PaperNexus reads it into memory and creates an import task from it.

Why this matters:

- The route is authenticated, so this is not an unauthenticated file-read issue.
- However, remote MCP/API tokens are often used by automation agents.
- If an agent is over-permissioned or a token leaks, that token can cause PaperNexus to ingest arbitrary readable files from the server.
- Even if file content is not returned directly in the create response, the file may be copied into task storage, parsed, logged, indexed, or later exposed through graph/search behavior.

Recommended fix:

- Add an optional allowlist root for server-side imports, for example:

```json
{
  "serve": {
    "importAllowRoots": ["~/papernexus-staging", "~/papers"]
  }
}
```

- Require `serverFilePath` to resolve under one of those roots when configured.
- Keep current behavior only for local/dev deployments with an explicit opt-in.
- Document that the API token is an administrative token if unrestricted server-side import remains supported.

### LOW: bearer-token comparison is direct string equality

File:

- `src/server/http.js:123`
- `src/server/http.js:124`

What happens:

- `requireApiToken()` compares the provided bearer token to the expected token with direct string inequality.

Why this matters:

- For most PaperNexus deployments this is low risk because the token is a long shared secret over local/private HTTP.
- Still, direct comparison is not timing-safe.
- If PaperNexus is exposed across a hostile network, a timing oracle is theoretically avoidable.

Recommended fix:

- Use `crypto.timingSafeEqual()` after converting both tokens to buffers of equal length.
- Keep the existing behavior for missing or length-mismatched tokens, but normalize the code path enough to avoid obvious prefix timing differences.

## Non-Findings / Checked Areas

### Browser dashboard `innerHTML`

`web/app.js` uses many `innerHTML` render paths, but the reviewed dynamic values are generally wrapped in `escapeHtml(...)`, and token persistence has moved to `sessionStorage`. I did not find a concrete XSS issue in this pass.

### File locks

`withFileLock()` now writes a heartbeat and refreshes lock mtime while the holder is alive. This addresses the prior live-lock reaping issue. Tests also cover heartbeat behavior.

### Repository-level test command

`npm test` now runs the `test/` suite explicitly and passed during this review. The earlier utility-script auto-discovery failure is no longer present.

### Quarantined task lookup

`loadImportTask()` and `loadImportTaskLog()` now search quarantine records when active task records are absent. This addresses the prior task-disappears-after-quarantine observability issue.

## Test Coverage Notes

Strong coverage exists for:

- staged ingestion
- import queue creation/reservation/completion/failure
- failed import recovery and superseded task behavior
- parser fallback and parser state
- HTTP/MCP authentication paths
- remote Python wrapper behavior
- graph schema, graph mutation, lite view, and domain/catalyst behavior

Coverage gaps worth closing:

- Linux keyring write path with `secret-tool` / `pass`
- malicious backup archive extraction
- failed import recovery with same filename but different content
- unrestricted `serverFilePath` policy boundaries
- timing-safe token comparison helper

## Suggested Fix Order

1. Tighten failed-import equivalent matching so filename fallback cannot override mismatched content fingerprints.
2. Fix Linux keychain `require()` usage and add backend tests.
3. Harden archive unpack with a preflight member validation step.
4. Add configurable allow roots for `serverFilePath`.
5. Replace direct bearer token comparison with a timing-safe helper.

## Coverage Inventory

The review inventoried 183 tracked code/config/test files across:

- `src/`
- `scripts/`
- `SKILL/`
- `web/`
- `test/`
- `config.example.json`
- `package.json`

The deepest manual inspection focused on runtime code paths where security, recovery, queue correctness, and graph consistency matter most.
