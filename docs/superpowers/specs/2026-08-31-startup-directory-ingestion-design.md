# Startup Directory Ingestion Design

**Date:** 2026-08-31

**Status:** Approved design
**Scope:** Local-profile startup discovery and ingestion only

## Summary

Add an optional background scan of one configured local data directory after the server starts. The scanner discovers eligible files, applies the existing upload limits and allowlist, and queues normal ingestion jobs. A durable source-file index prevents unchanged files from being re-ingested and gives locally imported documents path identity, so changed and renamed files can replace the prior imported document.

The scan is deliberately non-critical: HTTP and the ingestion worker start normally even when the directory is missing, unreadable, or contains individual files that cannot be processed. The existing Jobs page shows the current scan's discovery and queueing progress; normal job rows remain the source of truth for parsing, chunking, and embedding progress.

V1 supports one local directory under `APP_PROFILE=local` and `ROLE=all`. It does not implement file watching, scheduled rescans, multiple roots, or remote-drive synchronization.

## Goals

- Discover supported files recursively from a configured directory after startup.
- Bound traversal by configurable depth and bound work per startup by a configurable file limit.
- Never follow child symlinks and ignore hidden files and directories.
- Queue the same durable ingestion jobs used by manual uploads.
- Avoid re-ingesting unchanged files and duplicate content.
- Replace a previously imported document when its source file changes.
- Treat an absent tracked path plus the same content at a new path as a rename, replacing the old document with a newly queued document.
- Preserve corpus documents when source files disappear.
- Start serving HTTP before the scan begins and continue serving if the scan fails.
- Expose current-run scan progress on the existing Jobs page.
- Keep the source boundary narrow enough for a future remote source without building a connector framework now.

## Non-goals

- Filesystem watching or scheduled rescans.
- Manual scan start, cancel, or retry controls.
- Deleting a corpus document because a source path disappeared.
- More than one configured local root.
- Mapping directories to collections; imported documents are unfiled.
- Configurable scanner concurrency.
- Durable scan-run history or an audit UI.
- Remote-drive authentication, provider metadata, native change cursors, or synchronization for OneDrive, Google Drive, iCloud, or similar providers.
- Updating or taking ownership of manually uploaded documents.
- Changing the existing ingestion worker's parsing, chunking, embedding, lease, or retry behavior.

## User-visible behavior

When startup scanning is enabled, the server becomes reachable and the worker begins normally. A background scan then appears in a compact **Startup directory scan** panel above the current Jobs list.

The panel shows:

- state: `disabled`, `scanning`, `completed`, `completed_with_errors`, or `failed`;
- started and completed timestamps;
- current root-relative path while scanning;
- discovered, examined, queued, unchanged, duplicate, unsupported, oversized, and failed counts;
- whether the per-startup file limit was reached;
- a concise terminal error when the root itself could not be scanned.

The scan panel describes discovery and queueing only. Once a document is queued, its existing ingestion-job row communicates processing progress and retry state.

No absolute source path is returned to the browser. Detailed per-file errors remain in server logs; the panel exposes only counts and a concise fatal error.

## Configuration

Add these fields to `AppEnv` and parse them in `apps/server/src/config/env.ts`:

| Environment variable | Type | Default | Meaning |
| --- | --- | --- | --- |
| `INGEST_DATA_DIR` | optional string | unset | One local directory to scan. Unset or blank disables scanning. |
| `INGEST_DATA_MAX_DEPTH` | non-negative integer | `8` | Maximum directory levels below the root. `0` means root files only. |
| `INGEST_DATA_MAX_FILES` | positive integer | `10000` | Maximum previously unexamined file entries processed during one startup run. |

Relative `INGEST_DATA_DIR` values are resolved once against the process working directory. The scanner canonicalizes the configured root after confirming that it exists and is a directory. The canonical root becomes the containment boundary and contributes to the source identity.

Invalid numeric values fail ordinary environment validation. A valid configuration whose root is missing, not a directory, or unreadable does **not** fail server startup; it produces a `failed` scan state.

Scanning is enabled only when all of the following are true:

- `INGEST_DATA_DIR` is configured;
- `APP_PROFILE=local`;
- `ROLE=all`.

When a data directory is configured for another profile or role, scanning stays disabled, the status endpoint returns a reason, and the server logs one warning. This prevents multiple API/worker replicas from independently scanning the same source before distributed source coordination exists.

## Architecture

### Components

#### `LocalDirectorySource` adapter

`SourceImportService` calls this adapter directly — there is no `IngestionSource` port in v1. A single source type exists, so an interface with one implementation would only add indirection; extract a port when a second source (e.g. a remote drive) is actually being built.

```ts
type SourceCandidate = {
  relativePath: string;
};
```

`filename` is not a stored field; derive it with `path.basename(relativePath)` at the point of use.

The adapter exposes:

- `sourceId: string` — stable opaque identifier derived from the canonical root;
- `configurationFingerprint: string` — detects root/depth/enumeration-policy changes;
- `candidates(signal: AbortSignal): AsyncIterable<SourceCandidate>`;
- `inspectAndRead(candidate, maxBytes, signal): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>`;
- `pathState(relativePath: string): Promise<"present" | "missing" | "unknown">`.

It exposes discovery, bounded reading, stable source identity, and a conservative presence check. It does not expose credentials, provider-specific metadata, or remote cursors.

Place the local-filesystem adapter under the server/adapters boundary. It uses `fast-glob`'s asynchronous stream API in object mode for discovery with:

- `deep` set to `INGEST_DATA_MAX_DEPTH + 1`, translating the product's root-file depth of `0` to `fast-glob`'s entry depth of `1`;
- `dot: false`;
- `followSymbolicLinks: false`;
- `onlyFiles: true`.

The adapter accepts only entries whose `Dirent` is a regular file, normalizes emitted separators to `/`, rejects absolute or escaping relative paths, and resolves every opened candidate beneath the canonical root. It explicitly rejects symbolic links and other non-directory/non-regular entries rather than relying on `onlyFiles`, whose meaning is broader than regular files. Child symlinks are never followed. The explicitly configured root may resolve through a symlink during canonicalization, but the resulting real directory is the fixed containment boundary for the scan.

Discovery enumerates files before applying the upload-extension allowlist so unsupported files can be counted. It must not load the full directory listing into memory.

`inspectAndRead` opens the file, checks size against `MAX_UPLOAD_BYTES`, performs a bounded read and SHA-256 calculation, and checks file metadata again before accepting the result. A file that changes during the read is reported as unstable and skipped. Files are processed sequentially, so at most one source file of up to `MAX_UPLOAD_BYTES` is held by the scanner.

#### `SourceImportService`

Add an application service in `packages/core` that owns source-file classification and import orchestration. It depends only on `LocalDirectorySource`, `KnowledgeRepository`, `BlobStore`, and shared document validation helpers.

The service reuses the existing extension, MIME, size, hashing, storage-key, ID, and document-creation rules rather than maintaining a second upload policy. Refactor validation/preparation shared with `DocumentService` if needed; do not call the HTTP layer or duplicate the allowlist.

The service is the only component allowed to infer an update or rename and request an owned-document replacement.

#### `StartupIngestionCoordinator`

Construct the coordinator with the application services, but do not begin scanning inside `createApp()`. Add `startStartupScan(): void` to the object returned by `createApp()` and invoke it from `apps/server/src/index.ts` only after `Bun.serve()` succeeds.

The coordinator owns current-run status directly — there is no separate `ScanStatusService`. One producer (the coordinator's scan loop) and one consumer (the HTTP status route) don't need a reporter interface between them.

The coordinator:

- owns an `AbortController` for shutdown;
- holds current-run status in process memory, starting `disabled` or an initial non-running value, moving to `scanning`, and ending in a terminal state — there is no scan history table;
- exposes a `status()` method returning an immutable snapshot, read directly by the HTTP adapter;
- resumes or creates a scan cycle;
- streams candidates sequentially, updating its own status fields as it goes;
- applies the per-run examination limit;
- logs per-file failures and continues;
- completes status without throwing into the server lifecycle.

The application `stop()` path aborts an active scan as well as stopping the worker. An aborted scan retains its active cycle so a later startup can continue it.

### Dependency direction

The dependency flow remains:

```text
index/startup + HTTP/UI
        -> startup coordinator
        -> source import application service
        -> LocalDirectorySource / KnowledgeRepository / BlobStore
        -> local directory / libSQL / local blob adapters
```

The ingestion worker remains downstream of the database job queue and does not know how a document was discovered.

## Persistence model

Add two libSQL tables and matching repository operations. Their exact migration filenames follow the project's next migration sequence.

### `source_files`

| Column | Notes |
| --- | --- |
| `source_id` | Stable opaque identifier derived from source kind and canonical root. |
| `relative_path` | Normalized root-relative path. |
| `sha256` | Nullable; absent when the file could not be read or hashed. |
| `document_id` | Nullable FK to `documents`; non-null means the scanner owns this document association. |
| `last_outcome` | `imported`, `unchanged`, `duplicate`, `unsupported`, `oversized`, or `failed`. |
| `scan_cycle` | Cycle identifier in which this path was most recently examined. |
| `created_at` / `updated_at` | Millisecond timestamps following existing schema conventions. |

Use `(source_id, relative_path)` as the primary or unique key. A document can be owned by at most one source-file row in v1. A nullable document reference must not imply ownership when no document was created.

Define `document_id` as a nullable FK with `ON DELETE CASCADE`, and add a unique partial index on non-null `document_id`. Hard deletion therefore removes an imported ownership row and cannot leave a dangling mapping. Rows for unowned duplicates/rejections have a null reference and are unaffected.

Soft deletion leaves the reference available. When a source path remains present but its mapped document is no longer live, the next eligible scan imports a new document and replaces the mapping.

### `source_scan_state`

| Column | Notes |
| --- | --- |
| `source_id` | Primary key for the configured source. |
| `configuration_fingerprint` | Detects root/depth or scanner-enumeration changes. |
| `active_cycle` | Nullable identifier for an incomplete pass. |
| `limit_reached` | Whether the last run stopped at its examination limit. |
| `started_at` / `updated_at` | Operational timestamps, not UI history. |

This table is continuation state, not a scan-run audit log.

### Scan-cycle continuation

A scan cycle guarantees eventual progress without relying on filesystem enumeration order:

1. Reuse `active_cycle` when the prior run was aborted or reached its limit; otherwise create a new cycle identifier.
2. Stream every discoverable path.
3. If a `source_files` row already carries the active cycle, count it as discovered for this process but do not re-examine it or consume the limit.
4. Otherwise classify the path, persist its outcome with the active cycle, and increment `examined`.
5. Stop after `INGEST_DATA_MAX_FILES` newly examined paths, retain the active cycle, and set `limitReached: true`.
6. If discovery reaches the end, mark the cycle complete by clearing `active_cycle`.
7. After a complete pass, remove stale rows that have no owned document. Retain owned rows even when their source path was not seen, because missing files do not delete documents and those rows enable later rename inference.

A changed canonical root, maximum depth, or enumeration-policy version changes the configuration fingerprint and starts a new cycle. Changing only the per-run file limit does not need to invalidate the active cycle.

This approach may revisit directory entries while continuing a large scan, but it holds no unbounded list in memory and prevents the same prefix from consuming the limit on every startup.

## Classification and deduplication

All comparisons use normalized relative paths and SHA-256 content hashes. Modification time is not a correctness signal.

### Decision table

| Source observation | Existing state | Action |
| --- | --- | --- |
| Same path and same hash | Mapped document is live | Mark `unchanged`; do not queue. |
| Same path and different hash | Mapped document is live; new hash is otherwise unique | Atomically replace the mapped document and queue the new document. |
| Same path | Mapped document is soft-deleted or was purged | Import a new document and update/recreate ownership. |
| New path and same hash as an owned import | Old tracked path is confirmed missing | Infer a rename; atomically replace the old document, move ownership to the new path, and queue the new document. |
| New path and same hash as an owned import | Old tracked path is present or its state is unknown | Treat as a copy; mark duplicate without ownership and do not queue. |
| New path and same hash as a manual/unowned live document | No owned mapping | Mark duplicate without ownership and do not queue. |
| New path and unique hash | No live document has the hash | Import, queue, and record ownership. |
| Tracked path absent from discovery | Owned document exists | Do nothing; retain both document and mapping. |

Rename inference is intentionally conservative. Only a definite `missing` result permits replacement. Permission errors, transient I/O errors, and other uncertain presence checks yield `unknown` and therefore cannot delete an owned document.

If a changed owned path now has content already represented by another live document, delete the old owned document as an update but do not create or claim a second document with the duplicate hash. Record the source path as an unowned duplicate. The existing live document—manual or imported—remains untouched. This respects both update semantics and the live SHA-256 uniqueness constraint.

If several new paths contain the same hash after an old owned path disappears, one can become the inferred rename owner and the others remain unowned duplicates. Corpus content remains unique; no attempt is made to infer user intent among identical copies.

## Atomic import and replacement

The current live-document SHA-256 unique index means same-content renames cannot insert a new live document before retiring the old one. At the same time, deleting the old document before a later insert would risk data loss. Source imports therefore require a transactional repository operation.

### Preparation

For a unique import or replacement:

1. Validate extension and bounded size using shared document rules.
2. Read and hash stable bytes.
3. Generate new document and revision IDs and the final original-storage key.
4. Write the new original blob before changing database ownership.

The new blob is safe for the worker to read as soon as a committed job becomes visible.

### Repository commit

Add a repository operation equivalent to `commitSourceImport`, accepting prepared document/revision data, the source path/hash/cycle, and an optional owned document to replace. In one libSQL `BEGIN IMMEDIATE` transaction it must:

1. Recheck the relevant source mapping and live hash to protect against races.
2. If replacing, soft-delete the previously owned document first.
3. Insert the new document and initial revision when content is not already represented.
4. Insert the ingestion job and set the new document to `processing` as part of the same commit.
5. Upsert the source-file outcome and ownership mapping.

For a changed path whose new hash already belongs to another live document, the transaction soft-deletes only the old owned document and records an unowned duplicate; it does not insert a document or job.

If the live-hash recheck detects a concurrent manual or source import after blob staging, commit only the appropriate unowned duplicate outcome and remove the staged blob. Do not surface the database uniqueness error as a failed scan entry.

If the transaction fails, rollback restores the old live document and mapping. The service deletes the newly written blob on handled failure. A process crash between blob creation and the transaction can leave the same kind of unreferenced blob already possible in the manual upload path; crash-wide orphan collection is not added in this feature.

After a successful replacement, remove all blobs belonging exclusively to the old document using the existing document-deletion cleanup semantics. Cleanup is best-effort and logged. A cleanup failure does not roll back the new document or job.

Manual upload behavior remains unchanged. The scanner never changes a manually uploaded document or assigns an unowned duplicate row to it.

## Failure handling

### Fatal scan failures

The following produce scan state `failed` while leaving the server and worker running:

- configured root missing;
- root is not a directory;
- root cannot be read;
- discovery cannot be initialized or cannot continue at the root level.

There is no automatic retry loop. A later process startup attempts another scan.

### Per-file failures

The scanner logs the root-relative path and reason, increments `failed`, persists a `failed` outcome for the active cycle when possible, and continues when a file:

- disappears between discovery and open;
- is unreadable;
- changes during its read;
- violates path containment;
- cannot be hashed, staged, classified, or committed.

Unsupported files increment `unsupported`; files over `MAX_UPLOAD_BYTES` increment `oversized`. Neither is an error state by itself.

The terminal state is:

- `completed` after a run with no per-file failures, including a successful partial run with `limitReached: true`;
- `completed_with_errors` after traversal completes or reaches the limit with one or more per-file failures;
- `failed` when the root scan itself cannot run.

An aborted shutdown does not manufacture a completed status; its durable active cycle remains resumable.

## HTTP API

Add:

```http
GET /api/v1/ingest/scan-status
```

The endpoint uses the dashboard's existing authentication/session behavior and returns `200` for every status, including disabled and failed. Example:

```json
{
  "state": "scanning",
  "startedAt": "2026-08-31T10:15:00.000Z",
  "completedAt": null,
  "currentPath": "handbook/operations.pdf",
  "counts": {
    "discovered": 48,
    "examined": 31,
    "queued": 8,
    "unchanged": 17,
    "duplicates": 2,
    "unsupported": 3,
    "oversized": 0,
    "failed": 1
  },
  "limitReached": false,
  "error": null,
  "disabledReason": null
}
```

Rules:

- `currentPath` is null outside an active scan and is always root-relative.
- `error` is a short sanitized root-level error, not a stack trace or absolute path.
- `disabledReason` distinguishes at least `not_configured`, `unsupported_profile`, and `unsupported_role`.
- `discovered` counts file entries emitted during this process, including entries already handled in a resumed cycle.
- `examined` counts entries newly classified during this process and is the counter bounded by `INGEST_DATA_MAX_FILES`.
- `queued` counts new ingestion jobs, not documents that were merely discovered.
- `duplicates` excludes same-path unchanged files.

Do not add mutation endpoints for starting, stopping, or retrying a scan.

## Jobs dashboard

Extend the existing `JobsPage` rather than creating a new navigation destination.

- Poll scan status on the existing two-second jobs cadence.
- Render a compact panel above the jobs description/list.
- Show the state, timestamps, current relative path, counters, and a clear “file limit reached; continuation will resume on next startup” message.
- Use the existing visual language and components; this feature does not redesign the dashboard.
- Show concise error copy for `completed_with_errors` and `failed`, with detailed diagnostics delegated to logs.
- A scan-status request failure must not hide or break the jobs list; report the panel error independently.

## Observability

Log one structured event when a scan starts and one when it ends. The completion event includes state, duration, counters, and `limitReached`. Log per-file failures with source ID, root-relative path, outcome, and error code/message, never file contents.

Log automatic replacements and inferred renames with old and new document IDs and root-relative paths. Do not log the canonical absolute root in HTTP-visible data; normal server startup logs may identify the configured root for the local operator.

No new metrics series are required for v1.

## Security and safety

- Treat the configured root as the sole filesystem authority granted to this feature.
- Normalize and validate every relative path before open; reject traversal segments and absolute paths.
- Verify containment against the canonical root at open time.
- Do not follow child symlinks.
- Apply `MAX_UPLOAD_BYTES` before and during reads.
- Use the existing upload extension/MIME policy and parser isolation.
- Never return absolute paths or file contents through scan status.
- Only delete documents associated through a non-null owned source mapping.
- When rename presence is uncertain, preserve the old document.

## Testing strategy

### Unit tests

- Environment defaults, disabled behavior, non-negative depth, positive file limit, and invalid-number rejection.
- Local source normalization, containment, depth `0`, default depth, hidden paths, and child-symlink exclusion.
- Supported, unsupported, oversized, disappearing, unreadable, and unstable files.
- Every decision-table branch, including copy versus rename and manual duplicate ownership.
- Conservative `unknown` path state preserving the old document.
- Scan status transitions, counter definitions, sanitized error output, and immutable snapshots.
- Active-cycle skip and examination-limit behavior.

### Repository tests

- Source-file and scan-state CRUD and constraints.
- Hard purge removes imported ownership without leaving a dangling reference.
- Soft-deleted mapped documents can be replaced by a new import.
- `commitSourceImport` atomically creates document, revision, job, processing status, and ownership.
- Same-hash rename soft-deletes old before inserting new while satisfying `documents_sha256_live`.
- Injected transaction failures preserve the old live document and source mapping.
- Duplicate-hash races do not claim or mutate the other live document.
- Changed-source-to-existing-content retires only the previously owned document and creates no job.

### Integration tests

- The server becomes ready before a deliberately blocked scan finishes.
- A new file creates one document and one queued job.
- Restart with unchanged content creates no additional job.
- Editing a tracked file soft-deletes the old document and queues a new document.
- Renaming a tracked file soft-deletes the old document and queues a new document even with identical bytes.
- Copying a tracked file while the old path remains creates no document or job.
- Removing a tracked source file leaves the corpus document intact.
- Manually deleting or purging an imported document causes a still-present source file to import on a later complete cycle.
- A manual-upload duplicate is skipped without source ownership.
- More than one startup run progresses through a directory larger than `INGEST_DATA_MAX_FILES` without starvation.
- Missing and unreadable roots leave HTTP and the worker operational and expose `failed` status.
- One bad file yields `completed_with_errors` while later files still queue.
- Shutdown aborts scanning and the next startup resumes the active cycle.

### UI tests

- Disabled, scanning, completed, limit-reached, completed-with-errors, and failed panels.
- Counters and root-relative current path rendering.
- Scan-status polling alongside jobs.
- Scan endpoint failure does not suppress the jobs list.

## Acceptance criteria

The feature is complete when:

1. A local `ROLE=all` process with `INGEST_DATA_DIR` starts serving before scanning and queues supported new files in the background.
2. Unchanged files do not create new documents or jobs across restarts.
3. Changed and renamed owned files follow the approved delete-old-and-ingest-new behavior without a window that loses the old document on failure.
4. Copies and manually uploaded duplicate content are not re-ingested or automatically owned.
5. Missing source files never delete corpus documents.
6. Hidden entries and child symlinks are ignored, recursion obeys the configured depth, and file processing obeys the startup limit.
7. An incomplete large scan advances on later startups.
8. Root and per-file failures do not prevent normal server operation.
9. The Jobs page accurately reports current-run scan progress while existing job rows report ingestion progress.
10. Tests cover the classification matrix, transaction rollback, continuation, startup ordering, and UI states.

## Dependency rationale

Add `fast-glob` to the server package and use it only for bounded local traversal. Its [documented stream API and traversal options](https://github.com/mrmlnc/fast-glob#api) provide the required discovery primitives. Source identity, deduplication, ownership, continuation, and replacement remain application/database concerns rather than being delegated to the traversal library.
