# Import Dedupe And Persistent Import Source Design

## Summary

This design reduces API import latency in two places:

- duplicate uploads should reuse the existing import task instead of creating a new task and reparsing the same PDF
- completed import task directories should stop participating in repeated source-directory scans

The design keeps imported papers query-visible after completion by treating completed import sources as persistent manifest-backed sources rather than rediscovering them from completed task directories on every run.

## Context

The current API import flow accepts uploaded files, writes them into a task-local source directory under `.papernexus/imports/tasks/<taskId>/sources/`, and then lets the import worker rebuild the corpus through `materialize -> llm-optimize -> fast-commit`.

Two structural issues make repeated imports slow:

- duplicate uploads are keyed by task-local file paths, so the same PDF uploaded twice becomes a brand-new source key and misses markdown/snapshot reuse
- completed import task directories remain part of active source discovery, so later imports keep rescanning historical import directories

The current code also depends on those completed import paths for future rediscovery, so simply filtering them out would make previously imported papers look removed on later runs.

## Goals

- make duplicate uploads return the existing task immediately
- avoid writing duplicate uploaded files and duplicate task directories
- stop scanning completed import task directories during later imports
- preserve previously imported papers as durable corpus sources
- keep the change compatible with the current queue, manifest, and snapshot model

## Non-Goals

- redesigning the overall import queue
- changing the import worker stage order
- moving imported files into the user-managed paper source directory
- changing the public polling API shape beyond small dedupe metadata

## Recommended Approach

Use content-fingerprint dedupe plus manifest-backed persistent import source reuse.

### 1. Content Fingerprints

For each uploaded file:

- decode the uploaded bytes once
- compute a stable content fingerprint from the raw bytes
- record the fingerprint in task metadata

Then compute a task-level `importFingerprint` from:

- `rootPath`
- normalized file entries
- normalized file entries are sorted by content fingerprint and kind, not filename

This means:

- same content, different filename => dedupe hit
- same filename, different content => new task
- same files, different upload order => dedupe hit

### 2. Task-Level Reuse

Before creating a new task:

- look up `importFingerprint`
- if it already points to a `pending`, `running`, or `completed` task, return that task immediately
- if it points to a missing or stale task, clear the stale index entry and continue
- if it points to a `failed` task, do not reuse it; allow a new task to be created

The API response should include:

- the matched task
- `deduped: true` when the request reused an existing task
- `deduped: false` for a genuinely new task

## Import Index Storage

Add a lightweight import dedupe index under:

```text
.papernexus/imports/content-index.json
```

Suggested shape:

```json
{
  "version": 1,
  "updatedAt": "2026-03-27T00:00:00.000Z",
  "entries": {
    "<importFingerprint>": {
      "taskId": "imp:...",
      "updatedAt": "2026-03-27T00:00:00.000Z"
    }
  }
}
```

The existing import queue lock should guard:

- index lookup
- stale-entry cleanup
- task creation
- index update

This prevents concurrent identical uploads from racing past the dedupe check.

## Completed Import Persistence

Completed task directories should no longer be treated as active source roots for future discovery scans.

However, imported papers must remain part of the corpus. The persistence rule should be:

- running import task directories remain discoverable as temporary live sources
- completed import task directories are not rediscovered by directory scanning
- completed imported sources are instead reintroduced from `sources.json` / manifest entries when the file still exists on disk

This preserves imported papers without repeatedly scanning every completed task directory.

## Discovery Model

Source discovery should effectively become:

1. configured base input paths
2. currently running import source directories
3. manifest-backed completed import sources whose files still exist

Important nuance:

- step 3 should add source records to `discovery.sources`
- it should not expand `discovery.inputEntries`
- watch targets should continue to track the real base input paths plus running import directories only

This keeps future scans bounded while preserving current graph membership.

## Failure And Recovery Rules

- missing index target => delete index entry and continue with new task creation
- `failed` task target => ignore for dedupe and allow retry
- duplicate request during `running` => return the running task
- duplicate request after `completed` => return the completed task
- corrupted index file => fall back to an empty index, then rebuild entries lazily through new writes

## Testing Strategy

Add tests for:

- duplicate uploads with different filenames but identical bytes return the same task
- `failed` tasks are not reused
- API payload helpers surface `deduped: true`
- `listActiveImportSourceDirs(...)` excludes completed tasks
- source discovery still keeps completed imported sources alive through manifest-backed reuse
- repeated identical imports do not create additional queued tasks

## Expected Outcome

After this change:

- repeated uploads of the same PDF should short-circuit at task creation time
- completed task directories should stop inflating future source discovery scans
- imported papers should remain durable corpus sources without depending on completed task-directory rescans
