# Zip Archive Ingestion Design

**Date:** 2026-09-06

**Status:** Approved design
**Scope:** Uploading a `.zip` archive and ingesting its allowlisted contents as individual documents

## Summary

Accept `.zip` as an uploadable extension on the existing upload endpoint. Instead of becoming one document, a zip's allowlisted entries each become their own document through the same `DocumentService.upload()` path used by manual uploads and the directory scanner — same sha256 dedup, same storage, same ingestion pipeline. Extraction runs in the background worker, not inline on the HTTP request, and is a one-shot bounded task: no continuation cycles, no rename inference, no filesystem watching. The zip container itself is never stored; each extracted file is its own canonical original, identical to uploading that file directly.

Resource limits already declared in `AppEnv` (`MAX_ARCHIVE_UNCOMPRESSED_BYTES`, `MAX_ARCHIVE_ENTRIES`, `MAX_ARCHIVE_COMPRESSION_RATIO`) get their first real consumer here, checked from the zip's central directory before any entry is decompressed.

## Goals

- Accept `.zip` uploads on the existing `POST /api/v1/documents` endpoint.
- Extract every allowlisted entry into its own document via the existing `DocumentService.upload()`, unchanged.
- Run extraction in the background worker, off the HTTP request path.
- Bound total cost from the zip's central directory (entry count, aggregate uncompressed size) before decompressing anything.
- Skip and count individually unsupported, oversized, or unsafe entries without failing the whole archive.
- Make extraction safely restartable: a crashed worker's reclaimed archive import re-extracts from the start without duplicating documents (sha256 dedup already guarantees this).
- Apply an optional `collectionId` to every resulting document, exactly like today's single-file upload form field.
- Expose per-archive status (state, counts, resulting document ids) for polling.

## Non-goals

- Storing or retaining the uploaded `.zip` itself as a document or long-lived blob.
- Recursing into a nested `.zip` found inside the archive — counted `unsupported`, never expanded.
- Retry or cancel endpoints for an archive import — a failed or partial import is fixed by re-uploading; dedup makes that safe.
- Auto-creating a collection named after the archive.
- A per-entry durable ledger table, scan-cycle continuation, or rename inference (all directory-scanner concepts that don't apply to a one-shot bounded upload).
- MCP exposure — MCP is read-only and never exposed uploads; this doesn't change that.
- Archive-import history pruning/retention policy.
- Configurable archive traversal depth as a new environment variable — a fixed internal bound is enough (see Security and safety).

## User-visible behavior

Uploading a `.zip` to `POST /api/v1/documents` returns `202` with an archive id instead of a document id:

```json
{ "archiveId": "arc_01j...", "status": "queued" }
```

The background worker picks it up on its next tick, validates the archive's resource limits, and extracts allowlisted entries one at a time, each going through the normal upload → ingestion-job → parse/chunk/embed pipeline exactly as if uploaded individually. Polling `GET /api/v1/archives/:id` shows live progress:

```json
{
  "id": "arc_01j...",
  "originalFilename": "pocketguide-library.zip",
  "state": "extracting",
  "collectionId": null,
  "createdAt": "2026-09-06T10:00:00.000Z",
  "startedAt": "2026-09-06T10:00:01.000Z",
  "completedAt": null,
  "counts": { "examined": 40, "extracted": 38, "duplicate": 1, "unsupported": 1, "oversized": 0, "failed": 0 },
  "documentIds": ["doc_...", "doc_..."],
  "error": null
}
```

Each resulting document then behaves like any other: it shows up in Documents/Jobs, is searchable once `ready`, and can be reindexed from its own canonical original. There is no dependency back on the archive import or the original zip file after extraction completes.

## Configuration

No new environment variables. This feature is the first consumer of three that already exist in `AppEnv` ([`env.ts`](../../../apps/server/src/config/env.ts)):

| Environment variable | Default | Meaning here |
| --- | ---: | --- |
| `MAX_ARCHIVE_ENTRIES` | `1024` | Maximum entries in one archive's central directory. Exceeding it fails the whole import before extraction starts. |
| `MAX_ARCHIVE_UNCOMPRESSED_BYTES` | `104,857,600` (100 MiB) | Maximum sum of declared uncompressed sizes across all entries. Exceeding it fails the whole import before extraction starts. |
| `MAX_ARCHIVE_COMPRESSION_RATIO` | `100` | Maximum declared-uncompressed ÷ declared-compressed ratio for any single entry. An entry exceeding it is skipped (`oversized`), not decompressed. |

The zip container's own upload size is bounded by the existing `MAX_UPLOAD_BYTES` check already applied to every upload in `router.ts` — no separate cap. A single extracted entry is bounded by the same `MAX_UPLOAD_BYTES` DocumentService already enforces for any upload.

Archive traversal depth (folders inside the zip) is bounded by a fixed internal constant, not a new environment variable — the entry-count and aggregate-byte caps already bound the real resource risk, and depth by itself isn't a meaningful cost signal for a zip's flat entry list.

## Architecture

### Components

#### `ArchiveImportService`

New application service in `packages/core/src/services/`, sibling to `SourceImportService`. It depends only on `KnowledgeRepository`, `BlobStore`, `DocumentService`, and the shared archive-reading adapter below. Much lighter than `SourceImportService`: no continuation cycles, no rename inference, no filesystem watching — one archive upload is one bounded unit of work.

Two entry points:

- `stage(input): Promise<{ archiveId: string }>` — called synchronously from the HTTP handler. Validates `collectionId` if given (same check `DocumentService.upload()` already does), writes the raw zip bytes to a temporary blob key (`archives/{archiveId}/upload.zip`), and inserts an `archive_imports` row in state `queued`. Does not open or validate the zip itself — that's the worker's job, off the request path.
- `extract(archiveId, signal): Promise<void>` — called from the worker tick. Reads the staged blob, opens it with the archive-reading adapter, checks whole-archive limits from the central directory, then iterates entries: classify, and for each allowlisted, safe, in-limit entry call `DocumentService.upload()` with `{ filename, bytes, collectionId, metadata }`. Appends one outcome to the row's `entries` JSON column per processed entry (durable progress, not in-memory-only). Deletes the staging blob and marks the row terminal when done, whether that's `completed`, `completed_with_errors`, or `failed`.

#### Zip reading adapter

A small wrapper around `adm-zip` (promoted from a transitive dependency of `onnxruntime-node` to a direct one — already resolved in `bun.lock`, zero new install). Exposes only what the service needs:

```ts
type ArchiveEntry = {
  path: string;
  declaredUncompressedBytes: number;
  declaredCompressedBytes: number;
  isDirectory: boolean;
  isSymlink: boolean;
};

interface ArchiveReader {
  entries(): ArchiveEntry[];               // from the central directory, no decompression
  read(path: string, maxBytes: number): Uint8Array; // decompresses one entry, throws if actual bytes exceed maxBytes
}
```

Keeping this behind a narrow interface (not calling `adm-zip` directly from the service) means the service's classification and limit logic is testable with a fake reader, without real zip fixtures for every branch.

#### Worker integration

The existing background worker loop gains one more thing to check each tick, alongside its ingestion-job polling: is there a `queued` (or stale-claimed and reclaimable, using the existing `JOB_LEASE_MS` pattern already used for `ingestion_jobs.locked_at`) `archive_imports` row? If so, claim it (`BEGIN IMMEDIATE`, same pattern as job claiming) and call `ArchiveImportService.extract()`. No second poll loop, no second concurrency knob — same interval, same worker.

#### HTTP router

`POST /api/v1/documents` gains one branch: if the uploaded filename's extension (via the existing `extensionOf` in [`mime.ts`](../../../packages/core/src/mime.ts)) is `zip`, call `ArchiveImportService.stage()` instead of `DocumentService.upload()`, and return its `202` shape instead of the single-document shape. `zip` is **not** added to `isAllowedUpload`'s allowlist — it is handled as a distinct upload kind the router recognizes directly, so a `.zip` never reaches `DocumentService.upload()` or the document parser registry as if it were a normal document.

### Dependency direction

```text
HTTP router
  -> ArchiveImportService.stage()   (request path — synchronous, fast)
  -> ArchiveImportService.extract() (worker tick — background)
       -> ArchiveReader (adm-zip adapter)
       -> DocumentService.upload()  (unchanged — same path as manual upload)
       -> KnowledgeRepository / BlobStore (archive_imports row, staging blob)
```

`DocumentService.upload()` has no knowledge that a call came from archive extraction rather than a direct upload. The ingestion worker downstream of it is equally unaware — a document created from a zip entry is indistinguishable from a manually uploaded one once created.

## Persistence model

One new table, `archive_imports`, following existing schema conventions (JSON columns already used for `documents.metadata`, `apiKeys.scopes`; locking columns already used on `ingestion_jobs`):

| Column | Notes |
| --- | --- |
| `id` | `arc_` + UUIDv7. New ID prefix — add `"arc"` to `ID_PREFIXES` in [`packages/core/src/ids.ts`](../../../packages/core/src/ids.ts) and to CLAUDE.md's ID table alongside `doc_`, `job_`, etc. |
| `collection_id` | Nullable FK to `collections`, `onDelete: set null` (same convention as `documents.collection_id`). Applied to every resulting document. |
| `original_filename` | The uploaded zip's filename, for display only. |
| `state` | `queued` \| `extracting` \| `completed` \| `completed_with_errors` \| `failed`. |
| `staging_storage_key` | Blob key holding the temporary zip bytes; set to `null` once deleted. |
| `locked_by` / `locked_at` | Stale-claim reclaim, mirroring `ingestion_jobs`, governed by the existing `JOB_LEASE_MS`. |
| `entries` | JSON array, appended to as each entry is processed: `{ path, outcome, documentId?, error? }` where `outcome` is `extracted` \| `duplicate` \| `unsupported` \| `oversized` \| `failed`. |
| `error` | Nullable safe message for a whole-archive failure (`ARCHIVE_TOO_LARGE`, `ARCHIVE_MALFORMED`) recorded before any entry was processed. |
| `created_at` / `started_at` / `completed_at` | Millisecond timestamps, existing schema convention. |

No per-entry table. Counts and `documentIds` in API responses are derived from `entries`, not stored redundantly.

### Restart safety

If the worker crashes mid-extraction, the stale `locked_at` claim is reclaimed by a later tick (same mechanism already protecting `ingestion_jobs`). Reclaiming an `archive_imports` row **restarts extraction from the first entry**, resetting `entries` to `[]` for the new attempt. This is safe because every entry still goes through `DocumentService.upload()`'s sha256 dedup: documents already created on the failed attempt come back as `duplicate` outcomes, never doubled. This is why no per-entry durable ledger is needed beyond the current attempt's `entries` column — idempotency is already guaranteed one layer down.

## Classification and resource limits

The archive reader parses the central directory once, giving entry count and each entry's declared compressed/uncompressed size **before decompressing anything**.

### Whole-archive checks (fail the entire import)

| Check | Limit | On violation |
| --- | --- | --- |
| Total entry count | `MAX_ARCHIVE_ENTRIES` | `state: failed`, `error: "ARCHIVE_TOO_LARGE: ..."`, nothing extracted. |
| Sum of declared uncompressed sizes | `MAX_ARCHIVE_UNCOMPRESSED_BYTES` | Same. |
| Central directory cannot be parsed | — | `state: failed`, `error: "ARCHIVE_MALFORMED: ..."`. |

These bound total cost before any work happens, so a violation is treated as adversarial or corrupt input, not a partial-success case.

### Per-entry checks (skip that entry, continue the archive)

| Observation | Outcome |
| --- | --- |
| Extension not in the existing upload allowlist (`isAllowedUpload`), or entry is `.zip`/nested archive | `unsupported` |
| `isDirectory` | not counted at all (not a file to import) |
| `isSymlink`, or path contains `..`, is absolute, or resolves outside the archive root after normalization | `failed` |
| Declared uncompressed size > `MAX_UPLOAD_BYTES` | `oversized` (not decompressed) |
| declared-uncompressed ÷ declared-compressed > `MAX_ARCHIVE_COMPRESSION_RATIO` | `oversized` (not decompressed) |
| Actual decompressed bytes exceed the declared size while streaming (lying header) | `failed` |
| Content already live elsewhere (sha256 match via `DocumentService.upload()`) | `duplicate` |
| Otherwise | `extracted`; `documentId` recorded |

Path depth is bounded by a fixed internal constant (32 segments) purely to reject pathological entries; it is not configuration.

## HTTP API

### `POST /api/v1/documents` (extended)

Same multipart form (`file`, `collectionId`, `metadata`). When `file`'s extension is `zip`:

```json
202 { "archiveId": "arc_01j...", "status": "queued" }
```

`collectionId`, if given, is validated the same way as today (`COLLECTION_NOT_FOUND` on an unknown id) before staging. `metadata`, if given, is passed through to every resulting document, same as a direct upload.

### `GET /api/v1/archives/:id` (new)

Returns the shape shown under User-visible behavior. `404` (`ARCHIVE_NOT_FOUND`) for an unknown id. Uses the same dashboard/API-key authentication as other `/api/v1/*` routes (`read` scope).

### `GET /api/v1/archives` (new)

Lists recent archive imports, cursor/limit paginated the same way as `GET /api/v1/documents`, newest first. Each item is the same shape as the single-archive response minus `entries`-derived detail beyond `counts`.

No mutation endpoints (no retry, cancel, or delete) — consistent with the directory scanner's status-only surface. A failed or partial import is corrected by re-uploading the zip; dedup makes that safe and idempotent.

## Dashboard

Extend the existing Documents or Jobs page with a compact **Archive imports** panel — no new navigation destination, same visual language as the directory-scan panel added in the startup-ingestion feature:

- State, timestamps, counts (`examined`/`extracted`/`duplicate`/`unsupported`/`oversized`/`failed`).
- A link from a completed import to its resulting documents (filtered by `collectionId` if one was given, otherwise by `documentIds`).
- Poll on the same cadence as the existing Jobs polling.
- A status-request failure must not hide or break the rest of the page.

## Observability

Log one structured event when an archive import starts extracting and one when it ends, including state, duration, and counts — same shape as the directory scanner's scan-start/scan-end events. Log per-entry `failed` outcomes with the archive id, in-archive path, and outcome/error code, never entry contents. Never log the staged blob's absolute path or the zip's raw bytes.

## Security and safety

- The zip container itself is never persisted past extraction; the staging blob is deleted whether extraction succeeds or fails.
- Whole-archive limits are checked from central-directory metadata before any entry is decompressed — a hostile payload is rejected before it costs meaningful CPU/memory.
- Every entry path is normalized and containment-checked before being read; symlink and traversal entries are rejected, never followed or opened.
- A lying central-directory size is caught during streaming decompression, not trusted.
- Extracted files go through the exact same allowlist, size limit, and parser isolation as a manual upload — no separate, weaker validation path.
- Never return the staged blob's storage key or absolute paths through the archive status API.

## Testing strategy

### Unit tests

- Whole-archive limit checks (entry count, aggregate uncompressed bytes) against a fake `ArchiveReader`, including the boundary values.
- Per-entry classification table: unsupported extension, nested zip, directory, symlink, traversal path, oversized by declared size, oversized by compression ratio, lying-header abort, duplicate, extracted.
- `entries` JSON accumulation and derived counts/`documentIds`.
- Restart/reclaim resets `entries` and re-processes from the start without assuming prior state.

### Repository tests

- `archive_imports` CRUD, stale-claim reclaim using the existing `JOB_LEASE_MS` pattern.
- Concurrent claim attempts only let one worker extract a given archive at a time.

### Integration tests

- Upload a real small fixture zip (mixed supported/unsupported entries, one subfolder) → resulting documents ingest end-to-end and become `ready`.
- A corrupt zip fails with `ARCHIVE_MALFORMED` and leaves the server otherwise operational.
- A fixture exceeding `MAX_ARCHIVE_ENTRIES` or `MAX_ARCHIVE_UNCOMPRESSED_BYTES` fails without creating any documents.
- A fixture containing a zip-bomb-shaped entry (extreme compression ratio) is skipped as `oversized` without exhausting memory, while sibling entries still extract.
- Re-uploading a zip whose entries were already extracted produces `duplicate` outcomes, not new documents.
- A worker restart mid-extraction resumes via reclaim and reaches a terminal state without duplicating documents.

### Router/API tests

- `.zip` upload dispatches to `ArchiveImportService.stage()`, not `DocumentService.upload()`; response shape is the archive shape, not the document shape.
- `GET /api/v1/archives/:id` and `GET /api/v1/archives` shapes, pagination, and `404` for an unknown id.
- `collectionId`/`metadata` passthrough to resulting documents.

## Acceptance criteria

1. Uploading a `.zip` to the existing upload endpoint returns an archive id, not a document id.
2. Every allowlisted entry becomes its own document via the unchanged `DocumentService.upload()` path, indistinguishable afterward from a direct upload.
3. Whole-archive resource limits are enforced from central-directory metadata before any decompression.
4. A single bad, oversized, or unsafe entry does not fail the rest of the archive; a whole-archive resource violation fails before any entry is processed.
5. The zip container is never stored past extraction.
6. Re-uploading the same or a partially-processed zip never creates duplicate documents.
7. A worker restart mid-extraction resumes safely via the existing stale-claim reclaim pattern.
8. Archive import status is visible via `GET /api/v1/archives/:id` and the dashboard, without exposing absolute paths or raw contents.
9. Tests cover the full per-entry classification table, whole-archive limit boundaries, restart idempotency, and the router dispatch change.

## Dependency rationale

Promote `adm-zip` from a transitive dependency (currently pulled in only via `onnxruntime-node`) to a direct dependency of the server/core package. It is already resolved in `bun.lock`, so this adds no new download or supply-chain surface. It is used only behind the narrow `ArchiveReader` interface for central-directory inspection and on-demand per-entry decompression; all resource-limit and path-safety logic remains this feature's own code, not delegated to the library.
