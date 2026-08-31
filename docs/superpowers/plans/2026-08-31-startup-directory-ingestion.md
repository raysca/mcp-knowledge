# Startup Directory Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan one configured local directory after server startup, queue new or changed files through the existing ingestion pipeline, avoid duplicate work across restarts, and report current scan progress on the Jobs page.

**Architecture:** A concrete `LocalDirectorySource` streams bounded, safe filesystem candidates. A core `SourceImportService` classifies candidates through a small structural constructor type, while new repository operations persist scan cycles and atomically replace scanner-owned documents. A server-side coordinator starts only after `Bun.serve()`, owns in-memory status, and exposes that status to the existing HTTP/UI adapters.

**Tech Stack:** Bun 1.3, TypeScript, `fast-glob`, React 19, Drizzle ORM, libSQL, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-31-startup-directory-ingestion-design.md`

## Global Constraints

- Scanning is enabled only with `INGEST_DATA_DIR`, `APP_PROFILE=local`, and `ROLE=all`.
- `INGEST_DATA_MAX_DEPTH` defaults to `8`; `0` means root files only.
- `INGEST_DATA_MAX_FILES` defaults to `10000` and must be a positive integer.
- HTTP must start before scanning; root and per-file scan failures must not stop the server or worker.
- Ignore hidden entries, reject child symlinks and non-regular files, and never escape the canonical root.
- Process source files sequentially and enforce the existing `MAX_UPLOAD_BYTES` limit.
- Missing source files never delete corpus documents.
- Only a non-null scanner-owned source mapping may trigger automatic document deletion or replacement.
- Changed and inferred-renamed owned files use delete-old-and-ingest-new semantics in one database transaction.
- Manual uploads and unowned duplicate documents are never modified or claimed.
- Scan status is current-run memory only; continuation state is durable but scan history is not.
- The browser receives root-relative paths only; never expose the canonical root or stack traces.
- Do not build watches, scheduled scans, manual scan controls, multiple roots, collections-from-folders, configurable scanner concurrency, or remote connectors.
- To preserve package direction while keeping the streamlined design, `SourceImportService` defines only the structural source methods it consumes in its own file. `packages/core` must not import `LocalDirectorySource` from `apps/server`, and no general connector registry is introduced.
- Preserve the existing uncommitted document-detail/dashboard work; stage only files named by the current task.

---

## File structure

### New files

- `apps/server/src/startup-scan/local-directory-source.ts` — canonical-root discovery, symlink/path safety, bounded stable reads, and hashing.
- `apps/server/src/startup-scan/coordinator.ts` — feature gating, scan loop, scan-cycle continuation, counters, status snapshots, and cancellation.
- `apps/server/src/ui/components/scan-status-panel.tsx` — presentational scan-status panel.
- `packages/core/src/domain/source.ts` — persistence and commit types shared by core and database adapters.
- `packages/core/src/services/source-import-service.ts` — candidate classification, staging, atomic import/replacement orchestration, and blob cleanup.
- `drizzle/0004_source_scans.sql` — `source_files` and `source_scan_state` tables and indexes.
- `tests/unit/local-directory-source.test.ts` — traversal and safe-read behavior.
- `tests/unit/source-scan-repository.test.ts` — migration, scan-cycle, cleanup, and purge behavior.
- `tests/unit/source-import-transaction.test.ts` — atomic create/replace/duplicate transaction behavior.
- `tests/unit/source-import-service.test.ts` — classification matrix and blob orchestration.
- `tests/unit/startup-scan-coordinator.test.ts` — lifecycle, limits, counters, continuation, and cancellation.
- `tests/unit/scan-status-panel.test.tsx` — scan panel states and sanitized rendering.
- `tests/integration/startup-directory-ingestion.test.ts` — user-visible ingestion, restart, update, rename, copy, and missing-file behavior.
- `tests/integration/startup-scan-resilience.test.ts` — startup ordering, continuation, bad roots, and per-file failures.

### Modified files

- `apps/server/package.json` and `bun.lock` — add `fast-glob`.
- `apps/server/src/config/env.ts` — add and validate the three scan settings.
- `apps/server/src/app.ts` — construct the source/import/coordinator objects and expose `startStartupScan()`.
- `apps/server/src/index.ts` — call `startStartupScan()` after `Bun.serve()`.
- `apps/server/src/http/router.ts` — add the read-only scan-status route.
- `apps/server/src/ui/App.tsx` — poll and render scan status without coupling it to job-list errors.
- `packages/core/src/index.ts` — export source domain types and `SourceImportService`.
- `packages/core/src/ports.ts` — add source-index and atomic-source-import repository operations.
- `packages/db/src/schema/libsql.ts` — add Drizzle table declarations.
- `packages/db/src/libsql.ts` — run migration `0004_source_scans.sql` idempotently.
- `packages/db/src/libsql-repository.ts` — implement source state, lookup, cleanup, blob-key, and transaction operations.
- `README.md` — document local startup scan configuration and behavior.
- `tests/unit/env.test.ts` — cover scan defaults and validation.
- `tests/unit/purge-corpus.test.ts` — verify purge removes scanner ownership.

---

### Task 1: Configuration and safe local traversal

**Files:**
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Modify: `apps/server/src/config/env.ts`
- Create: `apps/server/src/startup-scan/local-directory-source.ts`
- Modify: `tests/unit/env.test.ts`
- Create: `tests/unit/local-directory-source.test.ts`

**Interfaces:**
- Produces: `AppEnv.INGEST_DATA_DIR?: string`
- Produces: `AppEnv.INGEST_DATA_MAX_DEPTH: number`
- Produces: `AppEnv.INGEST_DATA_MAX_FILES: number`
- Produces: `SourceCandidate = { relativePath: string }`
- Produces: `LocalDirectorySource.create(input): Promise<LocalDirectorySource>`
- Produces: `candidates(signal): AsyncIterable<SourceCandidate>`
- Produces: `inspectAndRead(candidate, maxBytes, signal)` and `pathState(relativePath)`

- [ ] **Step 1: Add failing configuration tests**

Append tests that establish exact defaults and integer constraints:

```ts
test("startup scan defaults are disabled, depth 8, and 10,000 files", () => {
  const env = loadEnv({});
  expect(env.INGEST_DATA_DIR).toBeUndefined();
  expect(env.INGEST_DATA_MAX_DEPTH).toBe(8);
  expect(env.INGEST_DATA_MAX_FILES).toBe(10_000);
});

test("startup scan configuration accepts depth zero and rejects invalid bounds", () => {
  expect(loadEnv({
    INGEST_DATA_DIR: " ./knowledge ",
    INGEST_DATA_MAX_DEPTH: "0",
    INGEST_DATA_MAX_FILES: "1",
  })).toMatchObject({
    INGEST_DATA_DIR: "./knowledge",
    INGEST_DATA_MAX_DEPTH: 0,
    INGEST_DATA_MAX_FILES: 1,
  });
  expect(() => loadEnv({ INGEST_DATA_MAX_DEPTH: "-1" })).toThrow(/INGEST_DATA_MAX_DEPTH/);
  expect(() => loadEnv({ INGEST_DATA_MAX_DEPTH: "1.5" })).toThrow(/INGEST_DATA_MAX_DEPTH/);
  expect(() => loadEnv({ INGEST_DATA_MAX_FILES: "0" })).toThrow(/INGEST_DATA_MAX_FILES/);
});
```

- [ ] **Step 2: Run the configuration tests and verify failure**

Run: `bun test tests/unit/env.test.ts`

Expected: FAIL because the three `INGEST_DATA_*` properties do not exist.

- [ ] **Step 3: Implement configuration parsing**

Add fields to `AppEnv` and a strict helper used only for these new settings:

```ts
function boundedInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}
```

Trim `INGEST_DATA_DIR`, converting blank strings to `undefined`, and parse depth/file defaults exactly as specified.

- [ ] **Step 4: Add the dependency and failing traversal tests**

From `apps/server`, run: `bun add fast-glob`

Create tests using a temporary tree containing root files, nested files, dot files, a normal directory entry, a directory symlink, and a file symlink. Cover these assertions:

```ts
const source = await LocalDirectorySource.create({ root, maxDepth: 0 });
expect(await collect(source.candidates(new AbortController().signal))).toEqual([
  { relativePath: "root.txt" },
]);

const nested = await LocalDirectorySource.create({ root, maxDepth: 2 });
expect((await collect(nested.candidates(signal))).map((x) => x.relativePath).sort()).toEqual([
  "one/one.txt",
  "one/two/two.txt",
  "root.txt",
]);
expect(await nested.pathState("missing.txt")).toBe("missing");
expect(await nested.pathState("../outside.txt")).toBe("unknown");
```

Also assert that directories, hidden entries, and both symlink forms are absent; a read over `maxBytes` rejects with code `PAYLOAD_TOO_LARGE`; and a unit-level before/after metadata comparison detects changed size, modification time, or inode as `SOURCE_FILE_UNSTABLE`.

- [ ] **Step 5: Run traversal tests and verify failure**

Run: `bun test tests/unit/local-directory-source.test.ts`

Expected: FAIL because `LocalDirectorySource` does not exist.

- [ ] **Step 6: Implement `LocalDirectorySource` minimally**

Export these shapes:

```ts
export type SourceCandidate = { relativePath: string };

export function fileSnapshotChanged(
  before: { size: number; mtimeMs: number; ino: number },
  after: { size: number; mtimeMs: number; ino: number },
): boolean;

export class LocalDirectorySource {
  readonly sourceId: string;
  readonly configurationFingerprint: string;

  static async create(input: { root: string; maxDepth: number }): Promise<LocalDirectorySource>;
  candidates(signal: AbortSignal): AsyncIterable<SourceCandidate>;
  inspectAndRead(
    candidate: SourceCandidate,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>;
  pathState(relativePath: string): Promise<"present" | "missing" | "unknown">;
}
```

Use `realpath()` and `stat()` in `create()`. Derive `sourceId` from SHA-256 of `local\0${canonicalRoot}` and the fingerprint from source ID, depth, and an explicit enumeration version such as `local-directory-v1`. Use `fg.globStream("**/*", { cwd, objectMode: true, deep: maxDepth + 1, dot: false, followSymbolicLinks: false, onlyFiles: true, signal })`. Accept only `entry.dirent.isFile()` and reject `entry.dirent.isSymbolicLink()`.

Before opening, normalize separators, reject absolute paths and `..` segments, resolve beneath the canonical root, and `lstat()` the candidate. Read through a file handle, enforce the byte limit, hash with `Bun.CryptoHasher("sha256")`, compare pre/post `fstat()` size, `mtimeMs`, and inode with `fileSnapshotChanged`, and always close the handle. Map only `ENOENT` to `missing`; map permission and other uncertainty to `unknown`.

- [ ] **Step 7: Run focused tests and type-check**

Run: `bun test tests/unit/env.test.ts tests/unit/local-directory-source.test.ts`

Run: `bunx tsc --noEmit`

Expected: both commands pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/server/package.json bun.lock apps/server/src/config/env.ts apps/server/src/startup-scan/local-directory-source.ts tests/unit/env.test.ts tests/unit/local-directory-source.test.ts
git commit -m "feat: add safe startup directory traversal"
```

---

### Task 2: Durable source index and scan-cycle continuation

**Files:**
- Create: `packages/core/src/domain/source.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/ports.ts`
- Create: `drizzle/0004_source_scans.sql`
- Modify: `packages/db/src/schema/libsql.ts`
- Modify: `packages/db/src/libsql.ts`
- Modify: `packages/db/src/libsql-repository.ts`
- Create: `tests/unit/source-scan-repository.test.ts`
- Modify: `tests/unit/purge-corpus.test.ts`

**Interfaces:**
- Produces: `SourceFileOutcome`, `SourceFileRecord`, and `SourceScanCycle`
- Produces repository methods `openSourceScan`, `getSourceFile`, `findLiveOwnedSourceBySha256`, `recordSourceFile`, and `completeSourceScan`

- [ ] **Step 1: Define source-domain types in a failing repository test**

Write tests against these exact exported types and methods:

```ts
export type SourceFileOutcome =
  | "imported"
  | "unchanged"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";

export type SourceFileRecord = {
  sourceId: string;
  relativePath: string;
  sha256?: string;
  documentId?: string;
  lastOutcome: SourceFileOutcome;
  scanCycle: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SourceScanCycle = { cycleId: string; resumed: boolean };
```

The first test opens cycle `cycle-a`, records `a.txt`, reopens with the same fingerprint and proposed `cycle-b`, and expects `{ cycleId: "cycle-a", resumed: true }`. Reopening with a changed fingerprint must return `cycle-b` and `resumed: false`.

- [ ] **Step 2: Run the repository test and verify failure**

Run: `bun test tests/unit/source-scan-repository.test.ts`

Expected: FAIL because source tables and repository methods do not exist.

- [ ] **Step 3: Add migration and Drizzle schema**

Create `0004_source_scans.sql` with concrete constraints:

```sql
CREATE TABLE IF NOT EXISTS source_scan_state (
  source_id TEXT PRIMARY KEY,
  configuration_fingerprint TEXT NOT NULL,
  active_cycle TEXT,
  limit_reached INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  last_outcome TEXT NOT NULL,
  scan_cycle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, relative_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS source_files_document_owned
  ON source_files(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_source_sha
  ON source_files(source_id, sha256);
CREATE INDEX IF NOT EXISTS source_files_source_cycle
  ON source_files(source_id, scan_cycle);
```

Add matching Drizzle declarations. Update `migrateLibsql()` to detect `source_scan_state` and execute migration 0004 once, following the existing 0002/0003 pattern.

- [ ] **Step 4: Add repository contracts**

Add these signatures to `KnowledgeRepository`:

```ts
openSourceScan(input: {
  sourceId: string;
  configurationFingerprint: string;
  proposedCycleId: string;
}): Promise<SourceScanCycle>;
getSourceFile(sourceId: string, relativePath: string): Promise<SourceFileRecord | null>;
findLiveOwnedSourceBySha256(sourceId: string, sha256: string): Promise<SourceFileRecord | null>;
recordSourceFile(input: {
  sourceId: string;
  relativePath: string;
  sha256: string | null;
  documentId: string | null;
  lastOutcome: SourceFileOutcome;
  scanCycle: string;
}): Promise<void>;
completeSourceScan(input: {
  sourceId: string;
  cycleId: string;
  limitReached: boolean;
}): Promise<void>;
```

Export the new types from `packages/core/src/index.ts`.

- [ ] **Step 5: Implement cycle operations and cleanup**

Use an upsert in `openSourceScan`: reuse the active cycle only when it is non-null and the fingerprint matches; otherwise store `proposedCycleId` and the new fingerprint. `recordSourceFile` always writes an explicit nullable `document_id`; callers preserve the current owner for rejected/failed updates whose old document remains live and pass null only for genuinely unowned duplicates or paths.

In `completeSourceScan`, when `limitReached` is true, retain `active_cycle` and set the flag. When false, delete rows for the source where `document_id IS NULL AND scan_cycle <> cycleId`, then clear `active_cycle` and `limit_reached`. Require the stored active cycle to equal `cycleId` before changing state.

- [ ] **Step 6: Cover continuation cleanup and purge**

Add assertions that:

```ts
await repo.completeSourceScan({ sourceId, cycleId: "cycle-a", limitReached: true });
expect((await repo.openSourceScan({
  sourceId,
  configurationFingerprint: "fp",
  proposedCycleId: "cycle-b",
})).cycleId).toBe("cycle-a");
```

After a complete later cycle, stale unowned rows disappear while stale owned rows remain. Extend `purge-corpus.test.ts` by recording ownership for `doc_purge1`, purging documents, and asserting `getSourceFile(sourceId, "a.md")` is null due to `ON DELETE CASCADE`.

- [ ] **Step 7: Run focused tests and type-check**

Run: `bun test tests/unit/source-scan-repository.test.ts tests/unit/purge-corpus.test.ts`

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/core/src/domain/source.ts packages/core/src/index.ts packages/core/src/ports.ts drizzle/0004_source_scans.sql packages/db/src/schema/libsql.ts packages/db/src/libsql.ts packages/db/src/libsql-repository.ts tests/unit/source-scan-repository.test.ts tests/unit/purge-corpus.test.ts
git commit -m "feat: persist startup scan source state"
```

---

### Task 3: Atomic source-document commit

**Files:**
- Modify: `packages/core/src/domain/source.ts`
- Modify: `packages/core/src/ports.ts`
- Modify: `packages/db/src/libsql-repository.ts`
- Create: `tests/unit/source-import-transaction.test.ts`

**Interfaces:**
- Consumes: source tables and source-domain records from Task 2
- Produces: `PreparedSourceDocument`, `CommitSourceImportInput`, and `CommitSourceImportResult`
- Produces repository methods `commitSourceImport` and `listDocumentBlobKeys`

- [ ] **Step 1: Add failing atomic-commit tests**

Define and test these types:

```ts
export type PreparedSourceDocument = {
  documentId: string;
  revisionId: string;
  originalFilename: string;
  mimeType: string;
  extension?: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  storageKey: string;
};

type CommitSourceImportBase = {
  sourceId: string;
  relativePath: string;
  scanCycle: string;
  sha256: string;
};

export type CommitSourceImportInput = CommitSourceImportBase & (
  | { mode: "import"; prepared: PreparedSourceDocument; replaceDocumentId?: string }
  | {
      mode: "duplicate";
      duplicateDocumentId: string;
      replaceDocumentId: string;
    }
);

export type CommitSourceImportResult =
  | { outcome: "imported"; documentId: string; jobId: string; retiredDocumentId?: string }
  | { outcome: "duplicate"; duplicateDocumentId: string; retiredDocumentId?: string };
```

Tests must prove:

- a new commit creates one `processing` document, revision, queued job, and owned source row;
- a same-hash rename retires the old live document before inserting the new one, removes the old-path source row, and creates ownership at the new path;
- a changed owned path whose new hash already exists retires only the old owned document and records an unowned duplicate with no job;
- an injected statement failure rolls back the old document and mapping;
- `listDocumentBlobKeys(documentId)` returns original and normalized keys for all revisions.

- [ ] **Step 2: Run the transaction tests and verify failure**

Run: `bun test tests/unit/source-import-transaction.test.ts`

Expected: FAIL because the commit operation is absent.

- [ ] **Step 3: Add repository signatures**

Extend `KnowledgeRepository`:

```ts
commitSourceImport(input: CommitSourceImportInput): Promise<CommitSourceImportResult>;
listDocumentBlobKeys(documentId: string): Promise<string[]>;
```

- [ ] **Step 4: Implement one `BEGIN IMMEDIATE` transaction**

Implement the transaction on the repository's raw libSQL client in this order:

1. Load the source row at `(sourceId, relativePath)`. When `replaceDocumentId` is supplied, separately load its non-null ownership row by `(sourceId, documentId)`; reject the transaction if no such owned row exists. This lookup intentionally supports a rename whose owner is at a different path.
2. For `mode: "duplicate"`, recheck that `duplicateDocumentId` is live with the supplied hash, soft-delete `replaceDocumentId`, remove its old ownership row when it is at a different path, upsert an unowned `duplicate` row at `relativePath`, and return without a job.
3. For `mode: "import"`, recheck the live document owning `prepared.sha256`.
4. If another live document appeared, soft-delete only `replaceDocumentId` when present, remove its different-path ownership row, upsert an unowned `duplicate` source row at `relativePath`, and return the duplicate result.
5. Otherwise soft-delete `replaceDocumentId` first, remove its old ownership row when it is at a different path, insert the prepared document with status `processing`, insert revision 1, insert one queued job, upsert the owned `imported` source row at `relativePath`, and return the imported result.
6. Commit; on every error issue `ROLLBACK` and rethrow.

Generate the job ID before its insert with `newId("job")`. Do not call existing non-transactional repository methods from inside this transaction.

- [ ] **Step 5: Run atomic tests plus existing document tests**

Run: `bun test tests/unit/source-import-transaction.test.ts tests/integration/documents-api.test.ts`

Run: `bunx tsc --noEmit`

Expected: PASS, including unchanged manual upload behavior.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/core/src/domain/source.ts packages/core/src/ports.ts packages/db/src/libsql-repository.ts tests/unit/source-import-transaction.test.ts
git commit -m "feat: atomically commit source imports"
```

---

### Task 4: Source classification and replacement orchestration

**Files:**
- Create: `packages/core/src/services/source-import-service.ts`
- Modify: `packages/core/src/index.ts`
- Create: `tests/unit/source-import-service.test.ts`

**Interfaces:**
- Consumes: Task 1's object shape without importing its class
- Consumes: Task 2 source lookups/records and Task 3 atomic commit
- Produces: `SourceImportService.process(candidate, scanCycle)`
- Produces: `SourceProcessResult`

- [ ] **Step 1: Write the failing classification matrix**

Build fake repository, blob-store, and source objects. Use this result type:

```ts
export type SourceProcessResult = {
  outcome: "queued" | "unchanged" | "duplicate" | "unsupported" | "oversized" | "failed";
  documentId?: string;
  replacedDocumentId?: string;
  renamed?: boolean;
  error?: string;
};
```

Test each approved branch: same path/same hash, same path/changed hash, mapped deleted document, new unique path, copy with old path present, rename with old path missing, `unknown` old-path state, manual duplicate, changed-owned-to-existing-content, unsupported extension, oversized read, staging failure, commit failure, and successful old-blob cleanup.

Representative assertions:

```ts
expect(await service.process({ relativePath: "renamed.txt" }, "cycle-1")).toMatchObject({
  outcome: "queued",
  replacedDocumentId: "doc_old",
  renamed: true,
});
expect(repo.commitSourceImport).toHaveBeenCalledWith(
  expect.objectContaining({ replaceDocumentId: "doc_old" }),
);

source.pathState = async () => "unknown";
expect(await service.process({ relativePath: "copy.txt" }, "cycle-1")).toMatchObject({
  outcome: "duplicate",
});
expect(repo.softDeleteDocument).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/unit/source-import-service.test.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement a local structural source dependency**

Inside `source-import-service.ts`, define only what the service consumes:

```ts
type SourceReader = {
  readonly sourceId: string;
  inspectAndRead(
    candidate: { relativePath: string },
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>;
  pathState(relativePath: string): Promise<"present" | "missing" | "unknown">;
};
```

Do not export this as a general connector port and do not import from `apps/server`. TypeScript structural compatibility lets the concrete `LocalDirectorySource` satisfy it at composition time.

- [ ] **Step 4: Implement classification before mutation**

Add a constructor accepting `{ source, repo, blobs, maxUploadBytes, signal }`. In `process()`:

1. Derive `filename` with `path.basename(relativePath)`, load the same-path source row, and resolve whether its mapped document is still live.
2. Reject unsupported uploads with `isAllowedUpload` before reading. Record the outcome while preserving the prior SHA/owner when an owned document remains live.
3. Read/hash once through `inspectAndRead`. On oversized or failed reads, likewise preserve the prior live ownership rather than silently converting an owned path into an unowned row.
4. Look up a live owned row by hash and the existing live document by hash.
5. Return and record `unchanged` when same path, same hash, and mapped document are live.
6. Treat a new path as rename only when a same-hash owned path returns `missing`; `present` or `unknown` is duplicate.
7. Never set `replaceDocumentId` from a manual/unowned live hash.
8. For a changed owned path whose hash already exists, call `commitSourceImport` in `duplicate` mode so retirement and ownership clearing are atomic; do not stage a blob.
9. Otherwise generate document/revision IDs, sniff MIME, calculate `originalStorageKey`, stage the blob, and call `commitSourceImport` in `import` mode.
10. Remove the staged blob if the transaction throws or an import-mode commit returns a race-time duplicate.
11. After a returned `retiredDocumentId`, delete the previously captured old document blob keys best-effort and log cleanup failures.

Map `PAYLOAD_TOO_LARGE` to `oversized`; persist all non-mutating outcomes with `recordSourceFile`. Return `failed` with a short message for other file-level errors, leaving logging to the coordinator.

- [ ] **Step 5: Run service and type tests**

Run: `bun test tests/unit/source-import-service.test.ts`

Run: `bunx tsc --noEmit`

Expected: PASS and no import path from `packages/core` to `apps/server`.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/core/src/services/source-import-service.ts packages/core/src/index.ts tests/unit/source-import-service.test.ts
git commit -m "feat: classify startup source files"
```

---

### Task 5: Background coordinator and startup lifecycle

**Files:**
- Create: `apps/server/src/startup-scan/coordinator.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Create: `tests/unit/startup-scan-coordinator.test.ts`

**Interfaces:**
- Consumes: `LocalDirectorySource`, `SourceImportService`, source scan-cycle repository operations, and scan config
- Produces: `StartupScanStatus`, `StartupIngestionCoordinator.start()`, `.status()`, and `.stop()`
- Produces from `createApp`: `startStartupScan(): void`
- Produces: `AppOverrides.createDirectorySource` as a narrow deterministic test seam

- [ ] **Step 1: Add failing coordinator state tests**

Use this exact public status shape:

```ts
export type StartupScanStatus = {
  state: "disabled" | "scanning" | "completed" | "completed_with_errors" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  currentPath: string | null;
  counts: {
    discovered: number;
    examined: number;
    queued: number;
    unchanged: number;
    duplicates: number;
    unsupported: number;
    oversized: number;
    failed: number;
  };
  limitReached: boolean;
  error: string | null;
  disabledReason: "not_configured" | "unsupported_profile" | "unsupported_role" | null;
};
```

Tests cover all disabled reasons, immutable snapshots, successful completion, completed-with-errors, fatal discovery failure, exact limit behavior, resumed-cycle skips, abort retaining the active cycle, and one structured start/end log pair whose payload contains counters but no absolute root.

- [ ] **Step 2: Run coordinator tests and verify failure**

Run: `bun test tests/unit/startup-scan-coordinator.test.ts`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement the coordinator**

Give it a single-start guard so repeated `start()` calls are no-ops. On start, launch the async loop with `void this.run().catch(...)`; never return a promise to startup. Pass a lazy `createSource(): Promise<LocalDirectorySource>` factory and an importer factory into the coordinator. Invoke both inside `run()`, after status moves to `scanning`, so canonicalization or root failures cannot reject `createApp()`.

The loop must:

```ts
const cycle = await repo.openSourceScan({
  sourceId: source.sourceId,
  configurationFingerprint: source.configurationFingerprint,
  proposedCycleId: crypto.randomUUID(),
});
for await (const candidate of source.candidates(signal)) {
  counts.discovered += 1;
  if ((await repo.getSourceFile(source.sourceId, candidate.relativePath))?.scanCycle === cycle.cycleId) {
    continue;
  }
  if (counts.examined >= maxFiles) {
    limitReached = true;
    break;
  }
  counts.examined += 1;
  currentPath = candidate.relativePath;
  const result = await importer.process(candidate, cycle.cycleId);
  // update exactly one outcome counter
}
await repo.completeSourceScan({ sourceId: source.sourceId, cycleId: cycle.cycleId, limitReached });
```

Set `completed_with_errors` only when `counts.failed > 0`; `limitReached` alone remains `completed`. On an abort, exit without calling `completeSourceScan`, so the database retains the active cycle. On any fatal discovery error, retain the cycle and set `failed`. Clear `currentPath` in every terminal state and sanitize fatal errors to a short message without the canonical root. Inject `logger: Pick<Console, "info" | "error">` with `console` as the production default. Emit one object payload at start, one at completion with duration/counters/limit state, and one error payload per failed relative path; never include bytes or the canonical root.

- [ ] **Step 4: Compose without starting inside `createApp()`**

Construct source and importer factories only when profile/role/config permit scanning. Root creation failures are caught by the coordinator and move status to `failed`; they must not reject `createApp()`.

Add the deterministic test seam now:

```ts
export type AppOverrides = {
  createDirectorySource?: (input: {
    root: string;
    maxDepth: number;
  }) => Promise<Pick<
    LocalDirectorySource,
    "sourceId" | "configurationFingerprint" | "candidates" | "inspectAndRead" | "pathState"
  >>;
};

export async function createApp(env: AppEnv, overrides: AppOverrides = {}) {
  const createDirectorySource = overrides.createDirectorySource ?? LocalDirectorySource.create;
  const scanEnabled = Boolean(env.INGEST_DATA_DIR) && env.APP_PROFILE === "local" && env.ROLE === "all";
  const sourceFactory = scanEnabled
    ? () => createDirectorySource({
        root: env.INGEST_DATA_DIR!,
        maxDepth: env.INGEST_DATA_MAX_DEPTH,
      })
    : undefined;
}
```

Extend the return type:

```ts
return {
  services,
  startStartupScan: () => startupScan.start(),
  stop: () => {
    startupScan.stop();
    stopWorker();
  },
  fetch: ...,
};
```

In `index.ts`, preserve existing routes and call `app.startStartupScan()` only after `Bun.serve()` returns.

- [ ] **Step 5: Run coordinator, app, and type tests**

Run: `bun test tests/unit/startup-scan-coordinator.test.ts tests/integration/documents-api.test.ts`

Run: `bunx tsc --noEmit`

Expected: PASS. Existing callers that do not call `startStartupScan()` must continue working.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/server/src/startup-scan/coordinator.ts apps/server/src/app.ts tests/unit/startup-scan-coordinator.test.ts
git add -p apps/server/src/index.ts
git diff --cached --check
git commit -m "feat: run startup scans in the background"
```

For `index.ts`, stage only the startup-scan call; leave the pre-existing document-detail route hunk untouched if it is still uncommitted.

---

### Task 6: Scan-status API and Jobs dashboard panel

**Files:**
- Modify: `apps/server/src/http/router.ts`
- Create: `apps/server/src/ui/components/scan-status-panel.tsx`
- Modify: `apps/server/src/ui/App.tsx`
- Create: `tests/unit/scan-status-panel.test.tsx`
- Create: `tests/integration/scan-status-api.test.ts`

**Interfaces:**
- Consumes: `StartupScanStatus` and `StartupIngestionCoordinator.status()` from Task 5
- Produces: `GET /api/v1/ingest/scan-status`
- Produces: `ScanStatusPanel({ status, error })`

- [ ] **Step 1: Write a failing API test**

Start an app without `INGEST_DATA_DIR` and assert:

```ts
const response = await fetch(`${base}/api/v1/ingest/scan-status`);
expect(response.status).toBe(200);
expect(await response.json()).toMatchObject({
  state: "disabled",
  currentPath: null,
  limitReached: false,
  disabledReason: "not_configured",
});
```

With dashboard auth enabled, also assert the endpoint follows the existing read-route authentication behavior.

- [ ] **Step 2: Run the API test and verify failure**

Run: `bun test tests/integration/scan-status-api.test.ts`

Expected: FAIL with 404.

- [ ] **Step 3: Wire the read-only route**

Add `startupScan: Pick<StartupIngestionCoordinator, "status">` to `AppServices`, and before the jobs route return:

```ts
if (url.pathname === "/api/v1/ingest/scan-status" && req.method === "GET") {
  return json(svc.startupScan.status(), 200, requestId);
}
```

Do not add a special auth exception; the existing `GET /api/v1/*` rule requires read access when a passphrase is configured.

- [ ] **Step 4: Write failing panel-render tests**

Use `renderToStaticMarkup` from `react-dom/server` and assert disabled, scanning, completed, limit-reached, completed-with-errors, failed, and fetch-error output. Example:

```tsx
const html = renderToStaticMarkup(
  <ScanStatusPanel status={{ ...scanning, currentPath: "handbook/runbook.pdf" }} error={null} />,
);
expect(html).toContain("Startup directory scan");
expect(html).toContain("handbook/runbook.pdf");
expect(html).not.toContain("/Users/");
```

- [ ] **Step 5: Run panel tests and verify failure**

Run: `bun test tests/unit/scan-status-panel.test.tsx`

Expected: FAIL because the component is absent.

- [ ] **Step 6: Implement the panel and independent polling**

Create a presentational panel using existing typography, borders, and colors. It receives data; it does not fetch. Import `StartupScanStatus` with `import type` so the browser bundle does not pull server-side coordinator dependencies.

In `JobsPage`, add separate `scanStatus` and `scanError` state. On the existing two-second interval, fetch jobs and scan status independently with `Promise.allSettled()` or two guarded requests so either endpoint can fail without clearing the other's data. Render `<ScanStatusPanel>` above the existing jobs description/list.

Show “File limit reached; scanning will continue on the next startup.” when `limitReached` is true. Display counters with explicit labels and never reconstruct or display an absolute root.

- [ ] **Step 7: Run API, UI, CSS, and type verification**

Run: `bun test tests/integration/scan-status-api.test.ts tests/unit/scan-status-panel.test.tsx`

Run: `bun run ui:css`

Run: `bunx tsc --noEmit`

Expected: PASS. Inspect `git status` and do not stage unrelated document-detail files or generated CSS unless it was already tracked and changed by the required build.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/server/src/http/router.ts apps/server/src/ui/components/scan-status-panel.tsx tests/unit/scan-status-panel.test.tsx tests/integration/scan-status-api.test.ts
git add -p apps/server/src/ui/App.tsx
git diff --cached --check
git commit -m "feat: show startup scan progress"
```

For `App.tsx`, stage only Jobs-page scan-status hunks; leave pre-existing document-detail/dashboard edits untouched if they are still uncommitted.

---

### Task 7: End-to-end deduplication, update, rename, and copy semantics

**Files:**
- Create: `tests/integration/startup-directory-ingestion.test.ts`
- Modify implementation files from Tasks 1–5 only when a failing integration test reveals a contract defect

**Interfaces:**
- Consumes: `createApp(env).startStartupScan()`, document APIs, job APIs, and scan-status API
- Produces: proven user-visible source synchronization semantics

- [ ] **Step 1: Add a polling helper and first failing import test**

Use isolated temp paths for source root, database, and blobs. Start `Bun.serve()`, call `app.startStartupScan()` afterward, and poll status without sleeping blindly:

```ts
async function waitForScan(base: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await fetch(`${base}/api/v1/ingest/scan-status`).then((r) => r.json()) as StartupScanStatus;
    if (["completed", "completed_with_errors", "failed"].includes(status.state)) return status;
    await Bun.sleep(20);
  }
  throw new Error("scan did not finish");
}
```

Write `note.txt`, run the scan, and assert one queued job and one live document named `note.txt`.

- [ ] **Step 2: Run the first integration test and verify its failure reason**

Run: `bun test tests/integration/startup-directory-ingestion.test.ts -t "imports a new file"`

Expected: FAIL only on missing or incorrect end-to-end scan behavior, not fixture setup.

- [ ] **Step 3: Add the full approved scenario matrix**

Use a fresh app instance against the same database/source where restart behavior matters. Add separate tests that assert:

```text
unchanged restart     -> same live document ID, no additional job
changed same path     -> old ID returns 404, new ID exists, one additional job
rename same bytes     -> old ID returns 404, new filename/path owns a new ID, one additional job
copy while old exists -> one live document, no additional job
missing source path   -> prior document remains live
manual duplicate     -> manual document remains live, no scanner ownership or new job
manual delete/purge   -> present source imports on the next complete cycle
```

Query repository source rows directly only for ownership assertions that the public API cannot express.

- [ ] **Step 4: Run the full scenario matrix**

Run: `bun test tests/integration/startup-directory-ingestion.test.ts`

Expected: PASS. If a test fails, make the smallest correction in the task that owns the behavior and rerun that task's unit test before rerunning this file.

- [ ] **Step 5: Run regression tests for ingestion and purge**

Run: `bun test tests/integration/documents-api.test.ts tests/integration/ingestion.test.ts tests/integration/purge-corpus.test.ts tests/integration/startup-directory-ingestion.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add tests/integration/startup-directory-ingestion.test.ts packages/core/src/services/source-import-service.ts apps/server/src/startup-scan/local-directory-source.ts apps/server/src/startup-scan/coordinator.ts packages/db/src/libsql-repository.ts
git commit -m "test: verify startup directory synchronization"
```

Before committing, omit unchanged implementation paths and verify the staged diff contains no unrelated user work.

---

### Task 8: Continuation, failure resilience, documentation, and final verification

**Files:**
- Create: `tests/integration/startup-scan-resilience.test.ts`
- Modify: `README.md`
- Modify implementation files from Tasks 1–6 only for defects exposed by these tests

**Interfaces:**
- Consumes: all prior tasks
- Produces: verified non-blocking startup, eventual progress, failure isolation, cancellation, and operator documentation

- [ ] **Step 1: Add failing continuation and resilience tests**

Cover these cases with a low `INGEST_DATA_MAX_FILES` such as `2`:

```ts
expect((await runOneStartup()).limitReached).toBe(true);
expect((await runOneStartup()).limitReached).toBe(true);
expect((await runOneStartup()).limitReached).toBe(false);
expect((await repo.listDocuments({ limit: 50 })).items).toHaveLength(5);
```

Also test:

- `createApp()` returns and `/health` responds before a deliberately blocked fake source is released; only then call `startStartupScan()`;
- a missing root reaches `failed` while `/health` and job APIs remain available;
- one unreadable/unstable candidate produces `completed_with_errors` and a later valid candidate still queues;
- `stop()` aborts an active scan and the next app instance resumes the same cycle;
- status never includes the absolute temp root.

Use the `AppOverrides.createDirectorySource` seam from Task 5 for deterministic blocked and unstable sources. The default production path always uses `LocalDirectorySource.create`.

- [ ] **Step 2: Run resilience tests and verify failure**

Run: `bun test tests/integration/startup-scan-resilience.test.ts`

Expected: PASS because Tasks 1–6 already implement the exercised contracts. If it fails, stop and use `superpowers:systematic-debugging` before changing code; rerun the narrow named test and its owning component's unit file after the diagnosed fix.

- [ ] **Step 3: Document operator usage**

Add a concise README section:

````markdown
### Import a local directory on startup

Set `INGEST_DATA_DIR` to scan one local directory in the background after the server starts:

```bash
INGEST_DATA_DIR=./knowledge bun dev
```

`INGEST_DATA_MAX_DEPTH` defaults to `8` (`0` means root files only) and
`INGEST_DATA_MAX_FILES` defaults to `10000`. Scanning runs only with the local
profile and `ROLE=all`. Missing files do not remove documents; changed and
renamed scanner-owned files replace the prior document. Progress appears on
the Jobs page.
````

- [ ] **Step 4: Run complete verification**

Run: `bun test`

Run: `bunx tsc --noEmit`

Run: `bun run ui:css`

Run: `git diff --check`

Expected: every command passes. Review `git status --short` and distinguish pre-existing user changes from feature changes.

- [ ] **Step 5: Commit Task 8**

```bash
git add tests/integration/startup-scan-resilience.test.ts README.md
git commit -m "docs: finish startup directory ingestion"
```

Do not include the pre-existing document-detail work or the user's edited design spec unless the user explicitly asks to commit it.

---

## Final review checklist

- Every spec decision maps to a task and an automated test.
- `packages/core` has no import from `apps/server` or `fast-glob`.
- Only owned source rows can retire documents.
- Replacement, source ownership, revision creation, and job creation share one transaction.
- A concurrent duplicate never leaks the staged blob on a handled path.
- A scan-cycle limited on one startup advances on later startups.
- Root failures and file failures remain operationally distinct.
- Status counters follow the API definitions and contain only relative paths.
- Existing manual upload, purge, worker, search, and Jobs UI behavior still pass.
- No remote-source framework, watcher, scheduler, scan controls, or history table was added.
