# Directory Scan Zip Ingestion Design

**Date:** 2026-09-06

**Status:** Approved design
**Scope:** Extend the startup directory scanner (`INGEST_DATA_DIR`) to stage discovered `.zip` files as archive imports, instead of skipping them as unsupported

## Summary

Today, `SourceImportService` classifies every discovered file with `isAllowedUpload`, and `.zip` is not in that allowlist — a zip found by the startup scanner is silently marked `unsupported` and never expanded, even though uploading the same file through `POST /api/v1/documents` (per [2026-09-06-zip-archive-ingestion-design.md](2026-09-06-zip-archive-ingestion-design.md)) extracts and ingests its contents.

This closes that gap by giving `SourceImportService` a new branch for `.zip` paths that calls the existing `ArchiveImportService.stage()` — the same call the HTTP upload path makes — instead of trying to force a zip through the single-document `commitSourceImport` transaction. The one constraint that makes this necessary rather than a trivial wire-up: `source_files.document_id` carries a **unique partial index**, so one tracked path can own at most one document, and the scanner's rename-inference logic depends on that 1:1 mapping. A zip produces N documents from one path, so it must never claim document ownership through `source_files` at all.

The fix stores a zip's tracking row with `document_id` always `null`. That sidesteps the ownership constraint entirely, still lets the next scan detect an unchanged zip (via `sha256` + `scan_cycle`), and gets its stale-row cleanup for free from the *existing* end-of-cycle deletion (`... WHERE document_id IS NULL AND scan_cycle <> current`) — a renamed or removed zip's tracking row is pruned with no new code.

## Goals

- Discover `.zip` files during a directory scan and stage them via `ArchiveImportService.stage()` instead of marking them `unsupported`.
- Detect an unchanged zip (same path, same content hash) across scans and skip re-staging it.
- Extraction happens in the background worker, exactly like every other file — the scan discovers and stages, then moves on to the next candidate immediately.
- Keep the scan-status counters, dashboard panel, and `StartupIngestionCoordinator` unchanged: a staged archive counts as `queued`, the same bucket a normal file's queued ingestion job already uses.
- Automatically clean up a zip's tracking row when its path disappears or is renamed, reusing the existing unowned-row pruning — no new cleanup logic.

## Non-goals

- Rename inference for zips. A renamed zip is treated as a new path and re-staged; its old tracking row is pruned as unowned at the next complete cycle, same as any other file that stops appearing.
- Retiring documents extracted from a previous version of a changed zip. A changed zip (new hash, same path) is simply re-staged and re-extracted; entries already represented as live documents come back `duplicate` via `DocumentService.upload()`'s existing sha256 dedup. Documents from the old version are not retired — the same conservative stance the scanner already takes for missing files.
- Any change to `ArchiveImportService.extract()`, its resource limits, or its per-entry classification — all of that is reused exactly as built.
- Any change to the `archive_imports` table, the `/api/v1/archives*` endpoints, or the Archive imports dashboard panel.
- Mapping scanned zips (or their extracted documents) to a collection — scanned imports stay unfiled, same as every other startup-scan document today.
- New environment variables or a new migration.

## User-visible behavior

A `.zip` file placed in the `INGEST_DATA_DIR` tree is discovered on the next scan (subject to the existing depth/file-count/hidden/symlink rules — nothing about discovery itself changes) and staged as an archive import. Its resulting entries appear as ordinary documents once the background worker extracts them, exactly as if that same zip had been uploaded through the dashboard or API. The **Startup directory scan** panel's `queued` counter includes staged zips alongside normal files; the **Archive imports** panel shows the staged import's own progress, identical to a manually uploaded zip. There is no new UI surface.

Re-running the scan with the same unchanged zip does not re-stage it. Editing the zip's contents (new bytes, same path) re-stages and re-extracts it; already-known entries come back as `duplicate`, new or changed entries get ingested as new documents. Renaming or deleting the zip does not remove any document already extracted from it — same guarantee the scanner already gives for every other file type.

## Architecture

### `SourceImportService` changes

Add a new constructor dependency:

```ts
type SourceImportArchiveStager = Pick<ArchiveImportService, "stage">;
```

`SourceImportService`'s constructor input gains `archives: SourceImportArchiveStager`.

In `process()`, immediately after `samePath`/`samePathDocument`/`livePathOwnership` are resolved (unchanged from today) and **before** the existing `isAllowedUpload(filename)` check, add:

```ts
if (extensionOf(filename) === "zip") {
  return this.processArchive(candidate, filename, samePath, scanCycle);
}
```

`.zip` is intercepted before the allowlist check — it never falls through to the existing `unsupported` branch, and it never reaches `isAllowedUpload` at all (which correctly continues to reject `.zip` for the *single-document* path, since that's still not a real document format).

New private method:

```ts
private async processArchive(
  candidate: { relativePath: string },
  filename: string,
  samePath: SourceFileRecord | null,
  scanCycle: string,
): Promise<SourceProcessResult> {
  let inspected: { bytes: Uint8Array; sizeBytes: number; sha256: string };
  try {
    inspected = await this.input.source.inspectAndRead(
      candidate,
      this.input.maxUploadBytes,
      this.input.signal,
    );
  } catch (error) {
    this.throwIfCancellation(error);
    const outcome: SourceFileOutcome =
      errorCode(error) === "PAYLOAD_TOO_LARGE" ? "oversized" : "failed";
    return this.recordOutcome({
      candidate,
      scanCycle,
      outcome,
      sha256: samePath?.sha256 ?? null,
      documentId: null,
      error: outcome === "failed" ? shortErrorMessage(error) : undefined,
    });
  }
  this.throwIfAborted();

  if (samePath?.sha256 === inspected.sha256) {
    return this.recordOutcome({
      candidate,
      scanCycle,
      outcome: "unchanged",
      sha256: inspected.sha256,
      documentId: null,
    });
  }

  try {
    const { archiveId } = await this.input.archives.stage({ filename, bytes: inspected.bytes });
    this.throwIfAborted();
    // Bypasses recordOutcome deliberately, the same way commitImport already does for its
    // "queued" result: recordOutcome's persisted outcome and its reported outcome are the
    // same value for every other branch, but "archived" (persisted) and "queued" (reported)
    // are deliberately different here, so this writes the source_files row directly with
    // "archived" and returns its own SourceProcessResult with "queued".
    await this.input.repo.recordSourceFile({
      sourceId: this.input.source.sourceId,
      relativePath: candidate.relativePath,
      sha256: inspected.sha256,
      documentId: null,
      lastOutcome: "archived",
      scanCycle,
    });
    return { outcome: "queued", archiveId };
  } catch (error) {
    this.throwIfCancellation(error);
    return this.recordOutcome({
      candidate,
      scanCycle,
      outcome: "failed",
      sha256: inspected.sha256,
      documentId: null,
      error: shortErrorMessage(error),
    });
  }
}
```

Two distinct vocabularies stay intentionally separate here, matching the split that already exists between `SourceFileOutcome` (the persisted, audited value) and `SourceProcessResult["outcome"]` (what the coordinator counts):

- **Persisted** `SourceFileOutcome` gets a new value, `"archived"` — meaning "this path was staged as an archive import; this row never owns a document." This is distinct from `"imported"`, which (via the existing `commitSourceImport` transaction) always implies a live owned document.
- **Reported** `SourceProcessResult.outcome` is `"queued"` — from `StartupIngestionCoordinator`'s point of view, staging an archive *is* queuing background work, identical in kind to a normal file's ingestion job being queued. `countOutcome()` requires no new case.

`SourceProcessResult` gains one new optional field, `archiveId?: string`, purely for observability (so a completion log line can name the staged archive) — it does not participate in counting.

`stage()`'s `metadata`/`collectionId` are intentionally omitted from the call (undefined) — scanned imports stay unfiled and untagged, consistent with how `commitImport` already omits `collectionId` for normal scanned files.

### Domain and port changes

Add `"archived"` to `SourceFileOutcome` in `packages/core/src/domain/source.ts`:

```ts
export type SourceFileOutcome =
  | "imported"
  | "archived"
  | "unchanged"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";
```

Add `archiveId?: string` to `SourceProcessResult` in `packages/core/src/services/source-import-service.ts`.

No changes to `KnowledgeRepository`, no new repository methods, no schema migration. `recordSourceFile` and the unique partial index on `source_files.document_id` are used exactly as they exist today — a `null` `documentId` was always a valid, unowned row.

### Wiring

In `apps/server/src/app.ts`, the existing `createImporter` factory passes one more field:

```ts
createImporter: sourceFactory
  ? (source, signal) =>
      new SourceImportService({
        source,
        repo,
        blobs,
        archives,
        maxUploadBytes: env.MAX_UPLOAD_BYTES,
        signal,
      })
  : undefined,
```

(`archives` is the same `ArchiveImportService` instance already constructed for the HTTP upload path — see the parent spec's Task 9 wiring. No second instance, no duplicated limits configuration.)

### Dependency direction

```text
StartupIngestionCoordinator
  -> SourceImportService.process()
       -> LocalDirectorySource.inspectAndRead()  (unchanged)
       -> ArchiveImportService.stage()            (new — same call the HTTP router makes)
       -> KnowledgeRepository.recordSourceFile()  (unchanged method, new outcome value)
```

The worker loop's existing `claimArchiveImport`/`extract()` cycle (from the parent feature) picks up a scanner-staged archive import exactly the same way it picks up an HTTP-staged one — the worker has no notion of who called `stage()`.

## Classification and cleanup, worked through the existing rules

| Scan observation | `source_files` state | Result |
| --- | --- | --- |
| New `.zip` path, never seen | No row | Stage via `ArchiveImportService.stage()`; record row with `document_id: null`, `last_outcome: "archived"`. Reported `queued`. |
| Same `.zip` path, same hash | Row exists, same `sha256` | `unchanged`; no restage. |
| Same `.zip` path, different hash | Row exists, different `sha256` | Stage the new bytes; record row with the new hash and current `scan_cycle`, `last_outcome: "archived"`. Reported `queued`. Entries already live come back `duplicate` inside `ArchiveImportService.extract()`; nothing here retires the old entries. |
| `.zip` path disappears (renamed or deleted) | Row exists, `document_id` is `null` | Row is deleted by the existing end-of-cycle cleanup (`... WHERE document_id IS NULL AND scan_cycle <> current`) — no new code. Any documents already extracted from it are untouched, per the scanner's existing "missing files never delete documents" guarantee (they simply were never owned by this row in the first place). |
| Zip read fails (permission, disappears mid-read, unstable) | — | `failed`, same as any other file's read failure. |
| Zip exceeds `MAX_UPLOAD_BYTES` while reading | — | `oversized`, same as any other oversized file — before `ArchiveImportService.stage()` is ever called (`stage()` itself also enforces this bound, but `inspectAndRead` already rejects it first). |
| `ArchiveImportService.stage()` itself throws (e.g. blob store failure) | — | `failed`. |

Once staged, everything downstream — central-directory limits, per-entry classification, path safety, dedup — is exactly the parent feature's `ArchiveImportService.extract()`, run by the same worker loop, completely unaware of whether `stage()` was called by the HTTP router or the scanner.

## Observability

The scanner's existing per-file failure/completion logging is unchanged. When a path is staged as an archive, include `archiveId` in that log line (from the new `SourceProcessResult.archiveId` field) so an operator can correlate a scanned path with its entry in `GET /api/v1/archives`. No new log events, no new metrics.

## Security and safety

No new surface: `inspectAndRead` still enforces containment, symlink exclusion, and `MAX_UPLOAD_BYTES` before any bytes reach `ArchiveImportService.stage()`; everything `stage()`/`extract()` does from there is the parent feature's already-reviewed logic, run unmodified.

## Testing strategy

### Unit tests (`SourceImportService`)

- A new `.zip` path stages via a fake `archives.stage()` and records `document_id: null`, `last_outcome: "archived"`; reported outcome is `"queued"` with `archiveId` set.
- An unchanged `.zip` (same path, same hash on record) returns `unchanged` without calling `stage()`.
- A changed `.zip` (same path, new hash) calls `stage()` again and updates the recorded hash/cycle.
- A `.zip` that fails to read is `failed`; one that exceeds `MAX_UPLOAD_BYTES` is `oversized` — neither calls `stage()`.
- A `.zip` for which `stage()` itself throws is `failed`, with the stage failure's message captured (sanitized, no absolute paths).
- `.zip` is intercepted before `isAllowedUpload`, confirmed by a test asserting `stage()` is called even though `isAllowedUpload("x.zip")` is `false`.

### Repository-level behavior (no new repository code, but verify the reused path)

- A `source_files` row with `document_id: null` and `last_outcome: "archived"` round-trips through `getSourceFile`/`recordSourceFile` unchanged from how any other unowned row already does — covered by exercising `SourceImportService` against the real libsql repository (mirrors the existing `source-import-service.test.ts` pattern), not by new repository unit tests.
- The existing `completeSourceScan` end-of-cycle deletion removes a zip's row once its path is no longer observed — one integration-style test confirms this without needing new SQL.

### Integration tests

- A directory containing a `.zip` alongside ordinary files: after a scan and a worker tick, the zip's entries become ready documents, ordinary files ingest as today, and the scan-status `queued` count includes the staged zip.
- Restarting with the same unchanged zip does not create a second `archive_imports` row.
- Replacing the zip's contents (new hash, same path) creates a new `archive_imports` row and does not delete documents from the prior version.
- Deleting the zip file and completing a scan cycle removes its `source_files` tracking row (queryable via the existing repository test helpers) while any already-extracted documents remain untouched.

## Acceptance criteria

1. A `.zip` discovered by the directory scanner is staged via `ArchiveImportService.stage()` and its entries become documents through the normal worker-driven extraction, with no scan-side blocking.
2. An unchanged zip is never re-staged across scans.
3. A changed zip is re-staged; no attempt is made to retire documents from its previous version.
4. A removed or renamed zip's tracking row is pruned by the existing unowned-row cleanup, and no document is deleted as a result.
5. No schema migration, no new environment variable, no dashboard change, and no change to `ArchiveImportService.extract()`'s behavior.
6. Tests cover the new classification branch, the reused unchanged/failed/oversized paths, and end-to-end scan-to-ready-documents behavior for a zip.
