# Zip Archive Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept a `.zip` upload on the existing upload endpoint and ingest its allowlisted entries as individual documents, extracted in the background worker as a one-shot bounded task.

**Architecture:** A new `ArchiveImportService` in `packages/core` stages an uploaded zip's bytes to a temporary blob and a new `archive_imports` row (`stage()`, called from the HTTP request), then the existing background worker loop claims and extracts it (`extract()`) by walking the zip's central directory, enforcing whole-archive and per-entry resource limits, and calling the existing `DocumentService.upload()` once per allowlisted entry — identical to a manual upload from that point on. No new job-queue mechanism: extraction reuses the same claim/stale-lease pattern already used for `ingestion_jobs`, and is safely re-runnable from the start on reclaim because `DocumentService.upload()` already dedups by sha256.

**Tech Stack:** Bun/TypeScript monorepo, libSQL via Drizzle, `adm-zip` (promoted from an existing transitive dependency) for zip central-directory reading.

**Spec:** [docs/superpowers/specs/2026-09-06-zip-archive-ingestion-design.md](../specs/2026-09-06-zip-archive-ingestion-design.md)

## Global Constraints

- `.zip` is handled as a distinct upload kind the HTTP router recognizes directly — it is never added to `isAllowedUpload`'s allowlist and never reaches `DocumentService.upload()` or the document parser registry as a document itself.
- No new environment variables. This feature is the first consumer of the already-declared `MAX_ARCHIVE_ENTRIES`, `MAX_ARCHIVE_UNCOMPRESSED_BYTES`, `MAX_ARCHIVE_COMPRESSION_RATIO`.
- The uploaded zip's own bytes are never stored past extraction; the staging blob is deleted whether extraction succeeds or fails.
- Every extracted document goes through the unchanged `DocumentService.upload()` path — same allowlist, size limit, sha256 dedup, and parser isolation as a manual upload.
- Whole-archive limits (entry count, aggregate uncompressed bytes) are checked from central-directory metadata before any entry is decompressed; a violation fails the entire import. Per-entry problems (unsupported, oversized, unsafe path, decompress failure) are skipped and counted, not fatal to the archive.
- No retry/cancel endpoints, no per-entry durable ledger table, no recursion into nested zips (counted `unsupported`), no MCP exposure.
- Every milestone ends with `bun run typecheck` and `bun test` green.

---

### Task 1: Core domain types, new ID prefix, and safe archive failure codes

**Files:**
- Create: `packages/core/src/domain/archive.ts`
- Create: `packages/core/src/archive-failure.ts`
- Create: `tests/unit/archive-failure.test.ts`
- Modify: `packages/core/src/ids.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: `ArchiveImportState`, `ArchiveImportEntryOutcome`, `ArchiveImportEntry`, `ArchiveImport` (types), `PUBLIC_ARCHIVE_FAILURES`, `publicArchiveFailure(error): {code, message}`, `ArchiveFailureCode`. `ID_PREFIXES` gains `"arc"`.

- [ ] **Step 1: Write the failing test for safe archive failure copy**

```ts
// tests/unit/archive-failure.test.ts
import { describe, expect, test } from "bun:test";
import { AppError, publicArchiveFailure, type ArchiveFailureCode } from "../../packages/core/src/index.ts";

describe("publicArchiveFailure", () => {
  test.each([
    ["ARCHIVE_TOO_LARGE", "This archive exceeds the configured entry or size limit."],
    ["ARCHIVE_MALFORMED", "This archive could not be read."],
  ])("returns stable public copy for %s", (code, message) => {
    expect(publicArchiveFailure(new AppError(code as ArchiveFailureCode, "untrusted zip library output"))).toEqual({
      code: code as ArchiveFailureCode,
      message,
    });
  });

  test("maps unknown archive errors to malformed without leaking paths", () => {
    const result = publicArchiveFailure(new Error("central directory read failed for /Users/private/upload.zip"));
    expect(result).toEqual({ code: "ARCHIVE_MALFORMED", message: "This archive could not be read." });
    expect(JSON.stringify(result)).not.toContain("/Users/private/upload.zip");
  });

  test.each(["toString", "constructor", "__proto__"])("rejects inherited failure code %s", (code) => {
    expect(publicArchiveFailure({ code })).toEqual({
      code: "ARCHIVE_MALFORMED",
      message: "This archive could not be read.",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/archive-failure.test.ts`
Expected: FAIL — `publicArchiveFailure` is not exported from `packages/core/src/index.ts`.

- [ ] **Step 3: Add the domain types**

```ts
// packages/core/src/domain/archive.ts
export type ArchiveImportState =
  | "queued"
  | "extracting"
  | "completed"
  | "completed_with_errors"
  | "failed";

export type ArchiveImportEntryOutcome =
  | "extracted"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";

export type ArchiveImportEntry = {
  path: string;
  outcome: ArchiveImportEntryOutcome;
  documentId?: string;
  error?: string;
};

export type ArchiveImport = {
  id: string;
  originalFilename: string;
  collectionId?: string;
  metadata: Record<string, unknown>;
  state: ArchiveImportState;
  entries: ArchiveImportEntry[];
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
};
```

- [ ] **Step 4: Implement the safe failure mapping**

```ts
// packages/core/src/archive-failure.ts
import { AppError } from "./errors.ts";

export type PublicArchiveFailure = {
  code: ArchiveFailureCode;
  message: string;
};

export const PUBLIC_ARCHIVE_FAILURES = {
  ARCHIVE_TOO_LARGE: "This archive exceeds the configured entry or size limit.",
  ARCHIVE_MALFORMED: "This archive could not be read.",
} as const;

export type ArchiveFailureCode = keyof typeof PUBLIC_ARCHIVE_FAILURES;

function codeOf(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return undefined;
}

export function publicArchiveFailure(error: unknown): PublicArchiveFailure {
  const code = codeOf(error);
  if (code && Object.hasOwn(PUBLIC_ARCHIVE_FAILURES, code)) {
    const knownCode = code as ArchiveFailureCode;
    return { code: knownCode, message: PUBLIC_ARCHIVE_FAILURES[knownCode] };
  }
  return { code: "ARCHIVE_MALFORMED", message: PUBLIC_ARCHIVE_FAILURES.ARCHIVE_MALFORMED };
}
```

- [ ] **Step 5: Add the new ID prefix**

In `packages/core/src/ids.ts`, change:

```ts
export const ID_PREFIXES = ["col", "doc", "rev", "chk", "job", "key", "req"] as const;
```

to:

```ts
export const ID_PREFIXES = ["col", "doc", "rev", "chk", "job", "key", "req", "arc"] as const;
```

- [ ] **Step 6: Export the new pieces from `packages/core/src/index.ts`**

Add alongside the existing `ingestion-failure.ts` export block:

```ts
export {
  PUBLIC_ARCHIVE_FAILURES,
  publicArchiveFailure,
  type ArchiveFailureCode,
  type PublicArchiveFailure,
} from "./archive-failure.ts";
```

Add to the existing `domain/normalized.ts`-adjacent type export block:

```ts
export type {
  ArchiveImport,
  ArchiveImportEntry,
  ArchiveImportEntryOutcome,
  ArchiveImportState,
} from "./domain/archive.ts";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/unit/archive-failure.test.ts tests/unit/ids.test.ts`
Expected: PASS (the existing `ids.test.ts` already loops `ID_PREFIXES`, so `"arc"` is covered automatically).

- [ ] **Step 8: Update CLAUDE.md's ID prefix list**

In `CLAUDE.md`, change:

```
- Chunk/document/job IDs are prefixed UUIDv7 strings (`doc_`, `rev_`, `chk_`, `col_`, `job_`, `key_`, `wh_`, `evt_`, `req_`) — see §110 for the full table.
```

to:

```
- Chunk/document/job IDs are prefixed UUIDv7 strings (`doc_`, `rev_`, `chk_`, `col_`, `job_`, `key_`, `wh_`, `evt_`, `req_`, `arc_` for archive imports) — see §110 for the full table.
```

- [ ] **Step 9: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/domain/archive.ts packages/core/src/archive-failure.ts \
  packages/core/src/ids.ts packages/core/src/index.ts tests/unit/archive-failure.test.ts CLAUDE.md
git commit -m "feat: add archive import domain types and safe failure codes"
```

---

### Task 2: Zip reading adapter

**Files:**
- Create: `packages/core/src/archive/reader.ts`
- Create: `tests/unit/archive-reader.test.ts`
- Modify: `packages/core/package.json`
- Modify: `package.json` (root, devDependencies)
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ArchiveEntry` type, `ArchiveReader` interface, `AdmZipArchiveReader` class — `entries(): ArchiveEntry[]`, `read(path: string, maxBytes: number): Uint8Array`. Task 6 depends on this exact shape.

- [ ] **Step 1: Add the dependency**

```bash
bun add adm-zip --cwd packages/core
bun add --dev @types/adm-zip
```

Run: `git diff bun.lock packages/core/package.json package.json | head -50`
Expected: `adm-zip` appears as a direct dependency of `@mcp-knowledge/core` (it was already resolved transitively via `onnxruntime-node`, so this should not change its resolved version); `@types/adm-zip` appears as a new root devDependency.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/archive-reader.test.ts
import { describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { AdmZipArchiveReader } from "../../packages/core/src/archive/reader.ts";

function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.name, Buffer.from(file.content, "utf8"));
  }
  return new Uint8Array(zip.toBuffer());
}

describe("AdmZipArchiveReader", () => {
  test("lists entries with declared sizes, skipping directories", () => {
    const zip = new AdmZip();
    zip.addFile("folder/", Buffer.alloc(0)); // a trailing slash makes adm-zip store a directory entry
    zip.addFile("notes.txt", Buffer.from("hello world", "utf8"));
    const reader = new AdmZipArchiveReader(new Uint8Array(zip.toBuffer()));
    const entries = reader.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("notes.txt");
    expect(entries[0]!.declaredUncompressedBytes).toBe(11);
    expect(entries[0]!.isDirectory).toBe(false);
    expect(entries[0]!.isSymlink).toBe(false);
  });

  test("reads an entry's decompressed bytes", () => {
    const bytes = buildZip([{ name: "a.txt", content: "content of a" }]);
    const reader = new AdmZipArchiveReader(bytes);
    const data = reader.read("a.txt", 1024);
    expect(new TextDecoder().decode(data)).toBe("content of a");
  });

  test("throws for an unknown entry path", () => {
    const bytes = buildZip([{ name: "a.txt", content: "x" }]);
    const reader = new AdmZipArchiveReader(bytes);
    expect(() => reader.read("missing.txt", 1024)).toThrow();
  });

  test("throws when the decompressed entry exceeds maxBytes", () => {
    const bytes = buildZip([{ name: "big.txt", content: "0123456789" }]);
    const reader = new AdmZipArchiveReader(bytes);
    expect(() => reader.read("big.txt", 5)).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/unit/archive-reader.test.ts`
Expected: FAIL — `packages/core/src/archive/reader.ts` does not exist.

- [ ] **Step 4: Implement the reader**

```ts
// packages/core/src/archive/reader.ts
import AdmZip from "adm-zip";

export type ArchiveEntry = {
  path: string;
  declaredUncompressedBytes: number;
  declaredCompressedBytes: number;
  isDirectory: boolean;
  isSymlink: boolean;
};

export interface ArchiveReader {
  entries(): ArchiveEntry[];
  read(path: string, maxBytes: number): Uint8Array;
}

// Unix file-type bits within a zip entry's external attributes, per the zip spec's
// (ab)use of the upper 16 bits for Unix st_mode when the archive was made on Unix.
const UNIX_MODE_MASK = 0o170000;
const UNIX_SYMLINK_MODE = 0o120000;

export class AdmZipArchiveReader implements ArchiveReader {
  private readonly zip: InstanceType<typeof AdmZip>;

  constructor(bytes: Uint8Array) {
    this.zip = new AdmZip(Buffer.from(bytes));
  }

  entries(): ArchiveEntry[] {
    return this.zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => {
        const unixMode = (entry.header.attr >>> 16) & 0xffff;
        return {
          path: entry.entryName,
          declaredUncompressedBytes: entry.header.size,
          declaredCompressedBytes: entry.header.compressedSize,
          isDirectory: entry.isDirectory,
          isSymlink: (unixMode & UNIX_MODE_MASK) === UNIX_SYMLINK_MODE,
        };
      });
  }

  read(path: string, maxBytes: number): Uint8Array {
    const entry = this.zip.getEntry(path);
    if (!entry) throw new Error(`archive entry not found: ${path}`);
    // ponytail: adm-zip's getData() fully materializes the decompressed entry in memory
    // before this length check can reject it - a central-directory size that lies small
    // but inflates huge still costs the memory spike first. MAX_ARCHIVE_COMPRESSION_RATIO
    // (checked by the caller from declared header sizes alone, before this is ever called)
    // already rejects the classic bomb case - extreme but *honestly declared* compression.
    // Upgrade to a streaming zlib.createInflateRaw() with a hard byte-count cap if a
    // hostile (lying) central directory becomes a real threat model, not just this.
    const data = entry.getData();
    if (data.byteLength > maxBytes) {
      throw new Error(`archive entry exceeds declared size: ${path}`);
    }
    return new Uint8Array(data);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/archive-reader.test.ts`
Expected: PASS.

- [ ] **Step 6: Export from `packages/core/src/index.ts`**

```ts
export { AdmZipArchiveReader, type ArchiveEntry, type ArchiveReader } from "./archive/reader.ts";
```

- [ ] **Step 7: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/archive/reader.ts tests/unit/archive-reader.test.ts \
  packages/core/package.json package.json bun.lock packages/core/src/index.ts
git commit -m "feat: add zip central-directory reader adapter"
```

---

### Task 3: `archive_imports` table and migration

**Files:**
- Modify: `packages/db/src/schema/libsql.ts`
- Create: `drizzle/0005_archive_imports.sql`
- Modify: `packages/db/src/libsql.ts`
- Create: `tests/unit/archive-imports-migration.test.ts`

**Interfaces:**
- Produces: `archiveImports` drizzle table, applied automatically by `migrateLibsql(url)`. Task 4 depends on this table existing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/archive-imports-migration.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateLibsql } from "../../packages/db/src/index.ts";

describe("archive_imports migration", () => {
  test("creates the table and its index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-archive-migration-"));
    const url = `file:${join(dir, "app.db")}`;
    try {
      await migrateLibsql(url);
      const client = createClient({ url });
      const table = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_imports'",
      );
      expect(table.rows).toHaveLength(1);
      const index = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'archive_imports_state_created_idx'",
      );
      expect(index.rows).toHaveLength(1);
      client.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrating twice is a no-op (idempotent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-archive-migration-"));
    const url = `file:${join(dir, "app.db")}`;
    try {
      await migrateLibsql(url);
      await migrateLibsql(url); // must not throw
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/archive-imports-migration.test.ts`
Expected: FAIL — table does not exist.

- [ ] **Step 3: Add the drizzle table**

In `packages/db/src/schema/libsql.ts`, add to the `import type` block at the top:

```ts
import type { ArchiveImportEntry, SourceFileOutcome } from "@mcp-knowledge/core";
```

(replacing the existing `import type { SourceFileOutcome } from "@mcp-knowledge/core";` line). Then add, after the `ingestionJobs` table definition:

```ts
export const archiveImports = sqliteTable(
  "archive_imports",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    originalFilename: text("original_filename").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    state: text("state").notNull(),
    stagingStorageKey: text("staging_storage_key"),
    lockedBy: text("locked_by"),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    entries: text("entries", { mode: "json" })
      .$type<ArchiveImportEntry[]>()
      .notNull()
      .default(sql`'[]'`),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("archive_imports_state_created_idx").on(table.state, table.createdAt),
  ],
);
```

- [ ] **Step 4: Write the migration SQL**

```sql
-- drizzle/0005_archive_imports.sql
CREATE TABLE IF NOT EXISTS archive_imports (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  original_filename TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  staging_storage_key TEXT,
  locked_by TEXT,
  locked_at INTEGER,
  entries TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS archive_imports_state_created_idx
  ON archive_imports(state, created_at);
```

- [ ] **Step 5: Apply it from `migrateLibsql`**

In `packages/db/src/libsql.ts`, add after the `source_scan_state` block, before `client.close();`:

```ts
  const archiveImports = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_imports'",
  );
  if (archiveImports.rows.length === 0) {
    const sql = await Bun.file(
      new URL("../../../drizzle/0005_archive_imports.sql", import.meta.url),
    ).text();
    await client.executeMultiple(sql);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/unit/archive-imports-migration.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass (this includes every existing repository test re-migrating cleanly, since the new block is additive and idempotent).

```bash
git add packages/db/src/schema/libsql.ts drizzle/0005_archive_imports.sql \
  packages/db/src/libsql.ts tests/unit/archive-imports-migration.test.ts
git commit -m "feat: add archive_imports table and migration"
```

---

### Task 4: Repository methods for archive imports

**Files:**
- Modify: `packages/core/src/ports.ts`
- Modify: `packages/db/src/libsql-repository.ts`
- Create: `tests/unit/archive-import-repository.test.ts`

**Interfaces:**
- Consumes: `archiveImports` table (Task 3), `ArchiveImport`/`ArchiveImportEntry`/`ArchiveImportState` types (Task 1).
- Produces on `KnowledgeRepository`: `createArchiveImport`, `getArchiveImport`, `getArchiveImportStagingKey`, `listArchiveImports`, `claimArchiveImport`, `appendArchiveImportEntry`, `finishArchiveImport`, `failArchiveImport`. Task 5 and Task 7 depend on these exact names/signatures.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/archive-import-repository.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";

async function withRepository(
  run: (repo: ReturnType<typeof createKnowledgeRepository>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-archive-import-repo-"));
  const url = `file:${join(dir, "app.db")}`;
  try {
    await migrateLibsql(url);
    await run(createKnowledgeRepository(url));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("archive import repository", () => {
  test("creates, reads, and lists", async () => {
    await withRepository(async (repo) => {
      const created = await repo.createArchiveImport({
        id: "arc_1",
        originalFilename: "export.zip",
        stagingStorageKey: "archives/arc_1/upload.zip",
        metadata: { source: "test" },
      });
      expect(created.state).toBe("queued");
      expect(created.entries).toEqual([]);
      expect(created.metadata).toEqual({ source: "test" });

      const fetched = await repo.getArchiveImport("arc_1");
      expect(fetched?.originalFilename).toBe("export.zip");

      const stagingKey = await repo.getArchiveImportStagingKey("arc_1");
      expect(stagingKey).toBe("archives/arc_1/upload.zip");

      const list = await repo.listArchiveImports({ limit: 10 });
      expect(list.items.map((item) => item.id)).toEqual(["arc_1"]);
      expect(list.nextCursor).toBeUndefined();
    });
  });

  test("returns null for an unknown id", async () => {
    await withRepository(async (repo) => {
      expect(await repo.getArchiveImport("arc_missing")).toBeNull();
      expect(await repo.getArchiveImportStagingKey("arc_missing")).toBeNull();
    });
  });

  test("claims a queued import and prevents a second concurrent claim", async () => {
    await withRepository(async (repo) => {
      await repo.createArchiveImport({
        id: "arc_2",
        originalFilename: "export.zip",
        stagingStorageKey: "archives/arc_2/upload.zip",
        metadata: {},
      });
      const claimed = await repo.claimArchiveImport("worker-a", 60_000);
      expect(claimed?.id).toBe("arc_2");
      expect(claimed?.state).toBe("extracting");

      const secondClaim = await repo.claimArchiveImport("worker-b", 60_000);
      expect(secondClaim).toBeNull();
    });
  });

  test("reclaims a stale extracting import and resets its entries", async () => {
    await withRepository(async (repo) => {
      await repo.createArchiveImport({
        id: "arc_3",
        originalFilename: "export.zip",
        stagingStorageKey: "archives/arc_3/upload.zip",
        metadata: {},
      });
      const first = await repo.claimArchiveImport("worker-a", 1); // 1ms lease, expires almost immediately
      expect(first?.id).toBe("arc_3");
      await repo.appendArchiveImportEntry("arc_3", { path: "a.txt", outcome: "extracted", documentId: "doc_1" });
      await Bun.sleep(5);

      const reclaimed = await repo.claimArchiveImport("worker-b", 1);
      expect(reclaimed?.id).toBe("arc_3");
      expect(reclaimed?.entries).toEqual([]); // reset on reclaim
    });
  });

  test("appends entries and derives terminal state", async () => {
    await withRepository(async (repo) => {
      await repo.createArchiveImport({
        id: "arc_4",
        originalFilename: "export.zip",
        stagingStorageKey: "archives/arc_4/upload.zip",
        metadata: {},
      });
      await repo.claimArchiveImport("worker-a", 60_000);
      await repo.appendArchiveImportEntry("arc_4", { path: "a.txt", outcome: "extracted", documentId: "doc_1" });
      await repo.appendArchiveImportEntry("arc_4", { path: "b.exe", outcome: "unsupported" });
      await repo.finishArchiveImport("arc_4", "completed_with_errors");

      const finished = await repo.getArchiveImport("arc_4");
      expect(finished?.state).toBe("completed_with_errors");
      expect(finished?.entries).toEqual([
        { path: "a.txt", outcome: "extracted", documentId: "doc_1" },
        { path: "b.exe", outcome: "unsupported" },
      ]);
      expect(await repo.getArchiveImportStagingKey("arc_4")).toBeNull();
    });
  });

  test("fails a whole-archive import with a safe message and clears the staging key", async () => {
    await withRepository(async (repo) => {
      await repo.createArchiveImport({
        id: "arc_5",
        originalFilename: "export.zip",
        stagingStorageKey: "archives/arc_5/upload.zip",
        metadata: {},
      });
      await repo.failArchiveImport("arc_5", "ARCHIVE_TOO_LARGE: This archive is too large uncompressed.");
      const failed = await repo.getArchiveImport("arc_5");
      expect(failed?.state).toBe("failed");
      expect(failed?.error).toBe("ARCHIVE_TOO_LARGE: This archive is too large uncompressed.");
      expect(await repo.getArchiveImportStagingKey("arc_5")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/archive-import-repository.test.ts`
Expected: FAIL — `createArchiveImport` etc. do not exist on `KnowledgeRepository`.

- [ ] **Step 3: Add the port methods**

In `packages/core/src/ports.ts`, add the import:

```ts
import type { ArchiveImport, ArchiveImportEntry } from "./domain/archive.ts";
```

and add to the `KnowledgeRepository` type, after `completeSourceScan`:

```ts
  createArchiveImport(input: {
    id: string;
    originalFilename: string;
    collectionId?: string;
    stagingStorageKey: string;
    metadata: Record<string, unknown>;
  }): Promise<ArchiveImport>;
  getArchiveImport(id: string): Promise<ArchiveImport | null>;
  getArchiveImportStagingKey(id: string): Promise<string | null>;
  listArchiveImports(q: {
    cursor?: string;
    limit: number;
  }): Promise<{ items: ArchiveImport[]; nextCursor?: string }>;
  claimArchiveImport(workerId: string, leaseMs: number): Promise<ArchiveImport | null>;
  appendArchiveImportEntry(id: string, entry: ArchiveImportEntry): Promise<void>;
  finishArchiveImport(id: string, state: "completed" | "completed_with_errors"): Promise<void>;
  failArchiveImport(id: string, error: string): Promise<void>;
```

- [ ] **Step 4: Implement the methods in `libsql-repository.ts`**

Add `archiveImports` to the schema import block at the top:

```ts
import {
  apiKeys,
  archiveImports,
  collections,
  documentChunks,
  documentRevisions,
  documents,
  ingestionJobs,
  sourceFiles,
} from "./schema/libsql.ts";
```

Add `ArchiveImport` and `ArchiveImportEntry` to the `@mcp-knowledge/core` type import block. Then add these methods to the repository class, near the job methods:

```ts
  async createArchiveImport(input: {
    id: string;
    originalFilename: string;
    collectionId?: string;
    stagingStorageKey: string;
    metadata: Record<string, unknown>;
  }): Promise<ArchiveImport> {
    const now = new Date();
    const row = {
      id: input.id,
      collectionId: input.collectionId,
      originalFilename: input.originalFilename,
      metadata: input.metadata,
      state: "queued" as const,
      stagingStorageKey: input.stagingStorageKey,
      entries: [] as ArchiveImportEntry[],
      createdAt: now,
    };
    await this.db.insert(archiveImports).values(row);
    return toArchiveImport({
      ...row,
      lockedBy: null,
      lockedAt: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
  }

  async getArchiveImport(id: string): Promise<ArchiveImport | null> {
    const rows = await this.db.select().from(archiveImports).where(eq(archiveImports.id, id)).limit(1);
    return rows[0] ? toArchiveImport(rows[0]) : null;
  }

  async getArchiveImportStagingKey(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ stagingStorageKey: archiveImports.stagingStorageKey })
      .from(archiveImports)
      .where(eq(archiveImports.id, id))
      .limit(1);
    return rows[0]?.stagingStorageKey ?? null;
  }

  async listArchiveImports(q: { cursor?: string; limit: number }): Promise<{
    items: ArchiveImport[];
    nextCursor?: string;
  }> {
    const cursorCondition = q.cursor
      ? (() => {
          const { createdAt, id } = decodeCursor(q.cursor!);
          return or(
            lt(archiveImports.createdAt, new Date(createdAt)),
            and(eq(archiveImports.createdAt, new Date(createdAt)), lt(archiveImports.id, id)),
          );
        })()
      : undefined;
    const rows = await this.db
      .select()
      .from(archiveImports)
      .where(cursorCondition)
      .orderBy(desc(archiveImports.createdAt), desc(archiveImports.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(toArchiveImport);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
    };
  }

  async claimArchiveImport(workerId: string, leaseMs: number): Promise<ArchiveImport | null> {
    return this.runInTransaction(async () => {
      const now = Date.now();
      const leaseBefore = now - leaseMs;
      const result = await this.client.execute({
        sql: `UPDATE archive_imports
SET state = 'extracting', locked_by = ?, locked_at = ?, started_at = COALESCE(started_at, ?), entries = '[]'
WHERE id = (
  SELECT id FROM archive_imports
  WHERE state = 'queued'
     OR (state = 'extracting' AND locked_at < ?)
  ORDER BY created_at
  LIMIT 1
)
AND state IN ('queued', 'extracting')
RETURNING *`,
        args: [workerId, now, now, leaseBefore],
      });
      const row = result.rows[0];
      if (!row) return null;
      return archiveImportFromRaw(row);
    });
  }

  async appendArchiveImportEntry(id: string, entry: ArchiveImportEntry): Promise<void> {
    await this.client.execute({
      sql: `UPDATE archive_imports SET entries = json_insert(entries, '$[#]', json(?)) WHERE id = ?`,
      args: [JSON.stringify(entry), id],
    });
  }

  async finishArchiveImport(id: string, state: "completed" | "completed_with_errors"): Promise<void> {
    const now = new Date();
    await this.db
      .update(archiveImports)
      .set({ state, completedAt: now, lockedBy: null, lockedAt: null, stagingStorageKey: null })
      .where(eq(archiveImports.id, id));
  }

  async failArchiveImport(id: string, error: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(archiveImports)
      .set({
        state: "failed",
        error,
        completedAt: now,
        lockedBy: null,
        lockedAt: null,
        stagingStorageKey: null,
      })
      .where(eq(archiveImports.id, id));
  }
```

Add the row-mapping helpers near `toJob`/`jobFromRaw`:

```ts
function toArchiveImport(row: {
  id: string;
  collectionId?: string | null;
  originalFilename: string;
  metadata: Record<string, unknown>;
  state: string;
  entries: ArchiveImportEntry[];
  error?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}): ArchiveImport {
  return {
    id: row.id,
    collectionId: row.collectionId ?? undefined,
    originalFilename: row.originalFilename,
    metadata: row.metadata,
    state: row.state as ArchiveImport["state"],
    entries: row.entries,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

function archiveImportFromRaw(row: Record<string, unknown>): ArchiveImport {
  return toArchiveImport({
    id: String(row.id),
    collectionId: row.collection_id as string | null,
    originalFilename: String(row.original_filename),
    metadata: JSON.parse(String(row.metadata ?? "{}")),
    state: String(row.state),
    entries: JSON.parse(String(row.entries ?? "[]")),
    error: row.error as string | null,
    createdAt: asDate(row.created_at) ?? new Date(),
    startedAt: asDate(row.started_at) ?? null,
    completedAt: asDate(row.completed_at) ?? null,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/archive-import-repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/ports.ts packages/db/src/libsql-repository.ts \
  tests/unit/archive-import-repository.test.ts
git commit -m "feat: add archive import repository operations"
```

---

### Task 5: `ArchiveImportService.stage()`

**Files:**
- Create: `packages/core/src/services/archive-import-service.ts`
- Create: `tests/unit/archive-import-service-stage.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `KnowledgeRepository` (Task 4), `BlobStore`, `DocumentService` (existing).
- Produces: `ArchiveImportService` class with `stage(input): Promise<{ archiveId: string }>`. Task 6 adds `extract()` to the same class; Task 8 depends on `stage()`'s exact signature and thrown errors.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/archive-import-service-stage.test.ts
import { describe, expect, test } from "bun:test";
import { AppError, ArchiveImportService, type BlobStore, type DocumentService, type KnowledgeRepository } from "../../packages/core/src/index.ts";

function limits() {
  return {
    MAX_UPLOAD_BYTES: 1024,
    MAX_ARCHIVE_ENTRIES: 10,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: 10_000,
    MAX_ARCHIVE_COMPRESSION_RATIO: 100,
  };
}

describe("ArchiveImportService.stage", () => {
  test("rejects an oversized zip before writing anything", async () => {
    const puts: string[] = [];
    const blobs = { put: async (key: string) => { puts.push(key); } } as unknown as BlobStore;
    const repo = {} as KnowledgeRepository;
    const documents = {} as DocumentService;
    const service = new ArchiveImportService(repo, blobs, documents, limits());

    await expect(
      service.stage({ filename: "big.zip", bytes: new Uint8Array(2048) }),
    ).rejects.toThrow(AppError);
    expect(puts).toEqual([]);
  });

  test("rejects an unknown collectionId before writing anything", async () => {
    const puts: string[] = [];
    const blobs = { put: async (key: string) => { puts.push(key); } } as unknown as BlobStore;
    const repo = { getCollection: async () => null } as unknown as KnowledgeRepository;
    const documents = {} as DocumentService;
    const service = new ArchiveImportService(repo, blobs, documents, limits());

    await expect(
      service.stage({ filename: "export.zip", bytes: new Uint8Array(10), collectionId: "col_missing" }),
    ).rejects.toThrow(AppError);
    expect(puts).toEqual([]);
  });

  test("stages the zip bytes and creates a queued archive import", async () => {
    const puts: Array<{ key: string; size: number }> = [];
    const created: unknown[] = [];
    const blobs = {
      put: async (key: string, blob: Blob) => { puts.push({ key, size: blob.size }); },
    } as unknown as BlobStore;
    const repo = {
      getCollection: async () => ({ id: "col_1", name: "x", createdAt: new Date(), updatedAt: new Date() }),
      createArchiveImport: async (input: unknown) => {
        created.push(input);
        return { id: (input as { id: string }).id } as never;
      },
    } as unknown as KnowledgeRepository;
    const documents = {} as DocumentService;
    const service = new ArchiveImportService(repo, blobs, documents, limits());

    const result = await service.stage({
      filename: "export.zip",
      bytes: new Uint8Array(10),
      collectionId: "col_1",
      metadata: { source: "test" },
    });

    expect(result.archiveId.startsWith("arc_")).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`archives/${result.archiveId}/upload.zip`);
    expect(puts[0]!.size).toBe(10);
    expect(created).toEqual([
      {
        id: result.archiveId,
        originalFilename: "export.zip",
        collectionId: "col_1",
        stagingStorageKey: `archives/${result.archiveId}/upload.zip`,
        metadata: { source: "test" },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/archive-import-service-stage.test.ts`
Expected: FAIL — `ArchiveImportService` does not exist.

- [ ] **Step 3: Implement `stage()`**

```ts
// packages/core/src/services/archive-import-service.ts
import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { ArchiveImport } from "../domain/archive.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import type { DocumentService } from "./document-service.ts";

export type ArchiveImportLimits = {
  MAX_UPLOAD_BYTES: number;
  MAX_ARCHIVE_ENTRIES: number;
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: number;
  MAX_ARCHIVE_COMPRESSION_RATIO: number;
};

export function archiveStagingKey(archiveId: string): string {
  return `archives/${archiveId}/upload.zip`;
}

export class ArchiveImportService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly documents: DocumentService,
    private readonly limits: ArchiveImportLimits,
  ) {}

  async stage(input: {
    filename: string;
    bytes: Uint8Array;
    collectionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ archiveId: string }> {
    if (input.bytes.byteLength > this.limits.MAX_UPLOAD_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Upload exceeds MAX_UPLOAD_BYTES.", 413);
    }
    if (input.collectionId) {
      const collection = await this.repo.getCollection(input.collectionId);
      if (!collection) {
        throw new AppError("COLLECTION_NOT_FOUND", "Collection was not found.", 404);
      }
    }
    const archiveId = newId("arc");
    const stagingStorageKey = archiveStagingKey(archiveId);
    // ponytail: same BlobPart lib quirk as document-service.ts (Uint8Array<ArrayBufferLike>
    // vs BlobPart's stricter ArrayBuffer bound) - Bun's Blob accepts a Uint8Array at runtime.
    await this.blobs.put(stagingStorageKey, new Blob([input.bytes as unknown as BlobPart]));
    const created = await this.repo.createArchiveImport({
      id: archiveId,
      originalFilename: input.filename,
      collectionId: input.collectionId,
      stagingStorageKey,
      metadata: input.metadata ?? {},
    });
    return { archiveId: created.id };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/archive-import-service-stage.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from `packages/core/src/index.ts`**

```ts
export {
  ArchiveImportService,
  archiveStagingKey,
  type ArchiveImportLimits,
} from "./services/archive-import-service.ts";
```

- [ ] **Step 6: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/services/archive-import-service.ts \
  tests/unit/archive-import-service-stage.test.ts packages/core/src/index.ts
git commit -m "feat: add ArchiveImportService.stage()"
```

---

### Task 6: `ArchiveImportService.extract()` — classification and limits

**Files:**
- Modify: `packages/core/src/services/archive-import-service.ts`
- Create: `tests/unit/archive-import-service-extract.test.ts`

**Interfaces:**
- Consumes: `ArchiveReader`/`AdmZipArchiveReader` (Task 2), repository archive methods (Task 4), `DocumentService.upload()` (existing), `publicArchiveFailure` (Task 1).
- Produces: `extract(archiveId, signal?): Promise<void>` on `ArchiveImportService`. Task 7 (worker loop) depends on this exact signature and on `extract()` never throwing for per-entry problems.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/archive-import-service-extract.test.ts
import { describe, expect, test } from "bun:test";
import {
  ArchiveImportService,
  type ArchiveEntry,
  type ArchiveImport,
  type ArchiveImportEntry,
  type ArchiveReader,
  type BlobStore,
  type DocumentService,
  type KnowledgeRepository,
} from "../../packages/core/src/index.ts";

function limits(overrides: Partial<{
  MAX_UPLOAD_BYTES: number;
  MAX_ARCHIVE_ENTRIES: number;
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: number;
  MAX_ARCHIVE_COMPRESSION_RATIO: number;
}> = {}) {
  return {
    MAX_UPLOAD_BYTES: 1024,
    MAX_ARCHIVE_ENTRIES: 10,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: 10_000,
    MAX_ARCHIVE_COMPRESSION_RATIO: 100,
    ...overrides,
  };
}

function fakeReader(entries: ArchiveEntry[], contents: Record<string, string> = {}): ArchiveReader {
  return {
    entries: () => entries,
    read: (path, maxBytes) => {
      const text = contents[path] ?? "";
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > maxBytes) throw new Error("exceeds maxBytes");
      return bytes;
    },
  };
}

function record(overrides: Partial<ArchiveImport> = {}): ArchiveImport {
  return {
    id: "arc_1",
    originalFilename: "export.zip",
    metadata: {},
    state: "extracting",
    entries: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function harness(input: {
  reader: ArchiveReader;
  archiveRecord?: ArchiveImport;
  uploadResult?: { duplicate: boolean; documentId: string };
}) {
  const appended: ArchiveImportEntry[] = [];
  const deletedKeys: string[] = [];
  let finished: { state: string } | undefined;
  let failed: { error: string } | undefined;
  const repo = {
    getArchiveImportStagingKey: async () => "archives/arc_1/upload.zip",
    getArchiveImport: async () => input.archiveRecord ?? record(),
    appendArchiveImportEntry: async (_id: string, entry: ArchiveImportEntry) => {
      appended.push(entry);
    },
    finishArchiveImport: async (_id: string, state: string) => {
      finished = { state };
    },
    failArchiveImport: async (_id: string, error: string) => {
      failed = { error };
    },
  } as unknown as KnowledgeRepository;
  const blobs = {
    get: async () => new Blob([new Uint8Array(1)]),
    delete: async (key: string) => { deletedKeys.push(key); },
  } as unknown as BlobStore;
  const documents = {
    upload: async () => ({
      document: { id: input.uploadResult?.documentId ?? "doc_1" },
      revision: 1,
      duplicate: input.uploadResult?.duplicate ?? false,
      status: 202,
    }),
  } as unknown as DocumentService;
  const service = new ArchiveImportService(repo, blobs, documents, limits(), {
    openReader: () => input.reader,
  });
  return { service, appended, deletedKeys, getFinished: () => finished, getFailed: () => failed };
}

describe("ArchiveImportService.extract", () => {
  test("fails the whole archive when entry count exceeds the limit", async () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({
      path: `f${i}.txt`,
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
      isDirectory: false,
      isSymlink: false,
    }));
    const { service, getFailed, deletedKeys } = harness({ reader: fakeReader(entries) });
    await service.extract("arc_1");
    expect(getFailed()?.error).toContain("ARCHIVE_TOO_LARGE");
    expect(deletedKeys).toEqual(["archives/arc_1/upload.zip"]);
  });

  test("fails the whole archive when aggregate uncompressed bytes exceed the limit", async () => {
    const entries = [
      { path: "a.txt", declaredUncompressedBytes: 6000, declaredCompressedBytes: 100, isDirectory: false, isSymlink: false },
      { path: "b.txt", declaredUncompressedBytes: 6000, declaredCompressedBytes: 100, isDirectory: false, isSymlink: false },
    ];
    const { service, getFailed } = harness({ reader: fakeReader(entries) });
    await service.extract("arc_1");
    expect(getFailed()?.error).toContain("ARCHIVE_TOO_LARGE");
  });

  test("classifies unsupported, oversized-by-size, oversized-by-ratio, unsafe, and extracted entries", async () => {
    const entries = [
      { path: "notes.exe", declaredUncompressedBytes: 10, declaredCompressedBytes: 10, isDirectory: false, isSymlink: false },
      { path: "huge.txt", declaredUncompressedBytes: 2000, declaredCompressedBytes: 100, isDirectory: false, isSymlink: false },
      { path: "bomb.txt", declaredUncompressedBytes: 500, declaredCompressedBytes: 1, isDirectory: false, isSymlink: false },
      { path: "../escape.txt", declaredUncompressedBytes: 10, declaredCompressedBytes: 10, isDirectory: false, isSymlink: false },
      { path: "link.txt", declaredUncompressedBytes: 10, declaredCompressedBytes: 10, isDirectory: false, isSymlink: true },
      { path: "good.txt", declaredUncompressedBytes: 5, declaredCompressedBytes: 5, isDirectory: false, isSymlink: false },
    ];
    const { service, appended, getFinished } = harness({
      reader: fakeReader(entries, { "good.txt": "hello" }),
    });
    await service.extract("arc_1");

    expect(appended).toEqual([
      { path: "notes.exe", outcome: "unsupported" },
      { path: "huge.txt", outcome: "oversized" },
      { path: "bomb.txt", outcome: "oversized" },
      { path: "../escape.txt", outcome: "failed", error: "unsafe entry path" },
      { path: "link.txt", outcome: "failed", error: "unsafe entry path" },
      { path: "good.txt", outcome: "extracted", documentId: "doc_1" },
    ]);
    expect(getFinished()?.state).toBe("completed_with_errors");
  });

  test("records a duplicate outcome without treating it as a failure", async () => {
    const entries = [
      { path: "good.txt", declaredUncompressedBytes: 5, declaredCompressedBytes: 5, isDirectory: false, isSymlink: false },
    ];
    const { service, appended, getFinished } = harness({
      reader: fakeReader(entries, { "good.txt": "hello" }),
      uploadResult: { duplicate: true, documentId: "doc_existing" },
    });
    await service.extract("arc_1");
    expect(appended).toEqual([{ path: "good.txt", outcome: "duplicate", documentId: "doc_existing" }]);
    expect(getFinished()?.state).toBe("completed");
  });

  test("completes cleanly with no failing entries", async () => {
    const entries = [
      { path: "good.txt", declaredUncompressedBytes: 5, declaredCompressedBytes: 5, isDirectory: false, isSymlink: false },
    ];
    const { service, getFinished, deletedKeys } = harness({
      reader: fakeReader(entries, { "good.txt": "hello" }),
    });
    await service.extract("arc_1");
    expect(getFinished()?.state).toBe("completed");
    expect(deletedKeys).toEqual(["archives/arc_1/upload.zip"]);
  });

  test("a malformed central directory fails the archive without throwing", async () => {
    const reader: ArchiveReader = {
      entries: () => { throw new Error("bad central directory"); },
      read: () => new Uint8Array(),
    };
    const { service, getFailed } = harness({ reader });
    await expect(service.extract("arc_1")).resolves.toBeUndefined();
    expect(getFailed()?.error).toContain("ARCHIVE_MALFORMED");
  });

  test("does nothing when the archive import has vanished (purged mid-flight)", async () => {
    const repo = {
      getArchiveImportStagingKey: async () => null,
      getArchiveImport: async () => null,
    } as unknown as KnowledgeRepository;
    const blobs = {} as BlobStore;
    const documents = {} as DocumentService;
    const service = new ArchiveImportService(repo, blobs, documents, limits(), {
      openReader: () => fakeReader([]),
    });
    await expect(service.extract("arc_gone")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/archive-import-service-extract.test.ts`
Expected: FAIL — `extract` is not a method, and the constructor does not accept a fourth `deps` argument.

- [ ] **Step 3: Implement `extract()` and its helpers**

Replace the full content of `packages/core/src/services/archive-import-service.ts` with:

```ts
import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import { publicArchiveFailure } from "../archive-failure.ts";
import { isAllowedUpload } from "../mime.ts";
import { AdmZipArchiveReader, type ArchiveEntry, type ArchiveReader } from "../archive/reader.ts";
import type { ArchiveImport, ArchiveImportEntry } from "../domain/archive.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import type { DocumentService } from "./document-service.ts";

export type ArchiveImportLimits = {
  MAX_UPLOAD_BYTES: number;
  MAX_ARCHIVE_ENTRIES: number;
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: number;
  MAX_ARCHIVE_COMPRESSION_RATIO: number;
};

export function archiveStagingKey(archiveId: string): string {
  return `archives/${archiveId}/upload.zip`;
}

// A zip's entry list is flat, but a path can still nest arbitrarily deep segments.
// This bounds pathological entries; it is not user configuration.
const MAX_ENTRY_PATH_SEGMENTS = 32;

function isSafeEntryPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > MAX_ENTRY_PATH_SEGMENTS) return false;
  return !segments.includes("..");
}

export class ArchiveImportService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly documents: DocumentService,
    private readonly limits: ArchiveImportLimits,
    private readonly deps: { openReader?: (bytes: Uint8Array) => ArchiveReader } = {},
  ) {}

  async stage(input: {
    filename: string;
    bytes: Uint8Array;
    collectionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ archiveId: string }> {
    if (input.bytes.byteLength > this.limits.MAX_UPLOAD_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Upload exceeds MAX_UPLOAD_BYTES.", 413);
    }
    if (input.collectionId) {
      const collection = await this.repo.getCollection(input.collectionId);
      if (!collection) {
        throw new AppError("COLLECTION_NOT_FOUND", "Collection was not found.", 404);
      }
    }
    const archiveId = newId("arc");
    const stagingStorageKey = archiveStagingKey(archiveId);
    // ponytail: same BlobPart lib quirk as document-service.ts (Uint8Array<ArrayBufferLike>
    // vs BlobPart's stricter ArrayBuffer bound) - Bun's Blob accepts a Uint8Array at runtime.
    await this.blobs.put(stagingStorageKey, new Blob([input.bytes as unknown as BlobPart]));
    const created = await this.repo.createArchiveImport({
      id: archiveId,
      originalFilename: input.filename,
      collectionId: input.collectionId,
      stagingStorageKey,
      metadata: input.metadata ?? {},
    });
    return { archiveId: created.id };
  }

  async extract(archiveId: string, signal?: AbortSignal): Promise<void> {
    const throwIfAborted = () => signal?.throwIfAborted();
    const stagingKey = await this.repo.getArchiveImportStagingKey(archiveId);
    const record = await this.repo.getArchiveImport(archiveId);
    if (!stagingKey || !record) return; // vanished (purged mid-flight) - nothing to do

    try {
      const blob = await this.blobs.get(stagingKey);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      throwIfAborted();
      const reader = this.deps.openReader?.(bytes) ?? new AdmZipArchiveReader(bytes);
      const entries = reader.entries().filter((entry) => !entry.isDirectory);

      if (entries.length > this.limits.MAX_ARCHIVE_ENTRIES) {
        await this.repo.failArchiveImport(
          archiveId,
          "ARCHIVE_TOO_LARGE: This archive has too many entries.",
        );
        return;
      }
      const totalDeclaredBytes = entries.reduce((sum, entry) => sum + entry.declaredUncompressedBytes, 0);
      if (totalDeclaredBytes > this.limits.MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        await this.repo.failArchiveImport(
          archiveId,
          "ARCHIVE_TOO_LARGE: This archive is too large uncompressed.",
        );
        return;
      }

      let hadFailure = false;
      for (const entry of entries) {
        throwIfAborted();
        const outcome = await this.classifyAndImport(reader, entry, record);
        if (outcome.outcome === "failed") hadFailure = true;
        await this.repo.appendArchiveImportEntry(archiveId, outcome);
      }
      await this.repo.finishArchiveImport(archiveId, hadFailure ? "completed_with_errors" : "completed");
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = publicArchiveFailure(error);
      await this.repo.failArchiveImport(archiveId, `${failure.code}: ${failure.message}`);
    } finally {
      await this.blobs.delete(stagingKey).catch(() => undefined);
    }
  }

  private async classifyAndImport(
    reader: ArchiveReader,
    entry: ArchiveEntry,
    record: ArchiveImport,
  ): Promise<ArchiveImportEntry> {
    if (entry.isSymlink || !isSafeEntryPath(entry.path)) {
      return { path: entry.path, outcome: "failed", error: "unsafe entry path" };
    }
    if (!isAllowedUpload(entry.path)) {
      return { path: entry.path, outcome: "unsupported" };
    }
    if (entry.declaredUncompressedBytes > this.limits.MAX_UPLOAD_BYTES) {
      return { path: entry.path, outcome: "oversized" };
    }
    const ratio =
      entry.declaredCompressedBytes > 0
        ? entry.declaredUncompressedBytes / entry.declaredCompressedBytes
        : 1;
    if (ratio > this.limits.MAX_ARCHIVE_COMPRESSION_RATIO) {
      return { path: entry.path, outcome: "oversized" };
    }
    try {
      const bytes = reader.read(entry.path, this.limits.MAX_UPLOAD_BYTES);
      const result = await this.documents.upload({
        filename: entry.path,
        bytes,
        collectionId: record.collectionId,
        metadata: record.metadata,
      });
      return {
        path: entry.path,
        outcome: result.duplicate ? "duplicate" : "extracted",
        documentId: result.document.id,
      };
    } catch (error) {
      return {
        path: entry.path,
        outcome: "failed",
        error: error instanceof Error ? error.message : "failed to import entry",
      };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/archive-import-service-extract.test.ts tests/unit/archive-import-service-stage.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/services/archive-import-service.ts \
  tests/unit/archive-import-service-extract.test.ts
git commit -m "feat: add ArchiveImportService.extract() classification and limits"
```

---

### Task 7: Worker loop integration

**Files:**
- Modify: `apps/server/src/workers/loop.ts`
- Modify: `tests/unit/worker-loop.test.ts`

**Interfaces:**
- Consumes: `repo.claimArchiveImport` (Task 4), `ArchiveImportService.extract` (Task 6).
- Produces: `startWorkerLoop(input)` gains an optional `archives?: Pick<ArchiveImportService, "extract">` field. Task 9 depends on this exact field name.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/worker-loop.test.ts` (new `describe` block, keep the existing ones unchanged):

```ts
describe("startWorkerLoop archive extraction", () => {
  test("claims and extracts a queued archive import before falling back to job claims", async () => {
    let archiveClaims = 0;
    let jobClaims = 0;
    let resolveExtracted!: () => void;
    const extracted = new Promise<void>((resolve) => { resolveExtracted = resolve; });
    const extractedIds: string[] = [];
    const repo = {
      async claimArchiveImport() {
        archiveClaims += 1;
        return archiveClaims === 1 ? { id: "arc_1" } : null;
      },
      async claimJob() {
        jobClaims += 1;
        return null;
      },
    } as unknown as KnowledgeRepository;
    const ingestion = { async process() {} } as unknown as IngestionService;
    const archives = {
      async extract(id: string) {
        extractedIds.push(id);
        resolveExtracted();
      },
    };

    const stop = startWorkerLoop({ repo, ingestion, archives, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([
        extracted,
        Bun.sleep(500).then(() => { throw new Error("archive was not extracted"); }),
      ]);
      expect(extractedIds).toEqual(["arc_1"]);
    } finally {
      stop();
    }
  });

  test("an extraction error does not crash the loop; it keeps claiming", async () => {
    let archiveClaims = 0;
    let jobClaims = 0;
    let resolveJobClaimed!: () => void;
    const jobClaimed = new Promise<void>((resolve) => { resolveJobClaimed = resolve; });
    const repo = {
      async claimArchiveImport() {
        archiveClaims += 1;
        return archiveClaims === 1 ? { id: "arc_1" } : null;
      },
      async claimJob() {
        jobClaims += 1;
        resolveJobClaimed();
        return null;
      },
    } as unknown as KnowledgeRepository;
    const ingestion = { async process() {} } as unknown as IngestionService;
    const archives = {
      async extract() {
        throw new Error("unexpected extraction failure");
      },
    };

    const stop = startWorkerLoop({ repo, ingestion, archives, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([
        jobClaimed,
        Bun.sleep(500).then(() => { throw new Error("loop stalled after extraction error"); }),
      ]);
      expect(jobClaims).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/worker-loop.test.ts`
Expected: FAIL — `startWorkerLoop` does not accept `archives`, and `claimArchiveImport` is never called.

- [ ] **Step 3: Implement the loop change**

In `apps/server/src/workers/loop.ts`, add an `ArchiveImportService` type-only import and extend the input type:

```ts
import { AppError, publicIngestionFailure, type IngestionService } from "@mcp-knowledge/core";
import type { ArchiveImportService, KnowledgeRepository } from "@mcp-knowledge/core";
import { newId } from "@mcp-knowledge/core";

export function startWorkerLoop(input: {
  repo: KnowledgeRepository;
  ingestion: IngestionService;
  archives?: Pick<ArchiveImportService, "extract">;
  leaseMs: number;
  ingestionTimeoutMs: number;
}): () => void {
```

Change the body of `tick()`'s `while (!stopped)` loop to try an archive import first each iteration:

```ts
  async function tick() {
    while (!stopped) {
      if (input.archives) {
        let archiveImport: { id: string } | null = null;
        try {
          archiveImport = await input.repo.claimArchiveImport(workerId, input.leaseMs);
        } catch (error) {
          console.error("worker loop: claimArchiveImport failed", error);
        }
        if (archiveImport) {
          const operation = new AbortController();
          activeOperation = operation;
          try {
            const result = await Promise.race([
              input.archives.extract(archiveImport.id, operation.signal).then(() => "completed" as const),
              stopRequested,
            ]);
            if (result === "stopped") break;
          } catch (error) {
            console.error("worker loop: archive extraction failed", archiveImport.id, error);
          } finally {
            if (activeOperation === operation) activeOperation = undefined;
          }
          if (stopped) break;
          continue;
        }
      }
      let job;
      try {
        job = await input.repo.claimJob(workerId, input.leaseMs);
      } catch (error) {
        console.error("worker loop: claimJob failed", error);
        await Bun.sleep(250);
        continue;
      }
      if (stopped) break;
      if (!job) {
        await Bun.sleep(250);
        continue;
      }
      try {
        const operation = new AbortController();
        activeOperation = operation;
        let timeout!: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            if (activeTimeout === timeout) activeTimeout = undefined;
            const error = new AppError("INGESTION_TIMEOUT", "ingestion timed out");
            reject(error);
            operation.abort(error);
          }, input.ingestionTimeoutMs);
          activeTimeout = timeout;
        });
        try {
          const result = await Promise.race([
            input.ingestion.process(job, operation.signal).then(() => "completed" as const),
            deadline,
            stopRequested,
          ]);
          if (result === "stopped") break;
        } finally {
          clearTimeout(timeout);
          if (activeTimeout === timeout) activeTimeout = undefined;
          if (activeOperation === operation) activeOperation = undefined;
        }
      } catch (error) {
        if (stopped) break;
        try {
          const failure = publicIngestionFailure(error);
          const publicError = new Error(`${failure.code}: ${failure.message}`);
          const failed = await input.repo.failJob(job.id, publicError);
          await input.repo.setDocumentStatus(
            job.documentId,
            failed.status === "failed" ? "failed" : "processing",
            publicError.message,
          );
        } catch {
          // job vanished (purge mid-flight); keep claiming
        }
      }
    }
  }
```

(Only the top of the loop body changed — the job-claiming branch below it is unchanged from today, reproduced here in full so the file is unambiguous to edit.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/worker-loop.test.ts`
Expected: PASS, including the pre-existing tests in this file.

- [ ] **Step 5: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add apps/server/src/workers/loop.ts tests/unit/worker-loop.test.ts
git commit -m "feat: claim and extract archive imports from the worker loop"
```

---

### Task 8: HTTP router — upload dispatch and read endpoints

**Files:**
- Modify: `apps/server/src/http/router.ts`
- Create: `tests/integration/archive-upload-api.test.ts`

**Interfaces:**
- Consumes: `ArchiveImportService` (Tasks 5–6).
- Produces: `AppServices.archives`; `.zip` dispatch on `POST /api/v1/documents`; `GET /api/v1/archives/:id`; `GET /api/v1/archives`. Task 9 depends on `AppServices.archives` existing; Task 10 depends on the exact JSON shape from `GET /api/v1/archives`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/archive-upload-api.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("archive upload API", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-archive-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    app = await createApp(env);
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    app.stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.name, Buffer.from(file.content, "utf8"));
    return new Uint8Array(zip.toBuffer());
  }

  test("uploading a .zip returns an archiveId, not a document id", async () => {
    const bytes = buildZip([{ name: "a.txt", content: "hello archive" }]);
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "export.zip"));
    const res = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { archiveId: string; status: string };
    expect(body.archiveId.startsWith("arc_")).toBe(true);
    expect(body.status).toBe("queued");
  });

  test("archive status reaches completed and documents become ready", async () => {
    const bytes = buildZip([
      { name: "one.txt", content: "first document body" },
      { name: "two.txt", content: "second document body" },
      { name: "skip.exe", content: "not allowlisted" },
    ]);
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "batch.zip"));
    const upload = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const { archiveId } = (await upload.json()) as { archiveId: string };

    let status: { state: string; counts: Record<string, number>; documentIds: string[] } | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/v1/archives/${archiveId}`);
      status = (await res.json()) as typeof status;
      if (status?.state === "completed" || status?.state === "completed_with_errors") break;
      await Bun.sleep(100);
    }
    expect(status?.state).toBe("completed_with_errors"); // skip.exe is unsupported
    expect(status?.counts.extracted).toBe(2);
    expect(status?.counts.unsupported).toBe(1);
    expect(status?.documentIds).toHaveLength(2);

    for (const documentId of status!.documentIds) {
      let ready = false;
      const docDeadline = Date.now() + 15_000;
      while (Date.now() < docDeadline) {
        const res = await fetch(`${base}/api/v1/documents/${documentId}`);
        const doc = (await res.json()) as { status: string };
        if (doc.status === "ready") { ready = true; break; }
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
    }
  });

  test("GET /api/v1/archives lists recent imports newest first", async () => {
    const res = await fetch(`${base}/api/v1/archives?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; originalFilename: string }> };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.map((item) => item.originalFilename)).toContain("batch.zip");
  });

  test("GET /api/v1/archives/:id 404s for an unknown id", async () => {
    const res = await fetch(`${base}/api/v1/archives/arc_missing`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/integration/archive-upload-api.test.ts`
Expected: FAIL — uploading a `.zip` today goes through `DocumentService.upload()` and returns a document shape; `/api/v1/archives*` routes don't exist.

- [ ] **Step 3: Add `archives` to `AppServices` and the JSON mapper**

In `apps/server/src/http/router.ts`, extend the imports:

```ts
import type {
  ApiKeyService,
  ArchiveImportService,
  CollectionService,
  DocumentService,
  SearchService,
  UrlIngestService,
} from "@mcp-knowledge/core";
import { AppError, extensionOf, type ArchiveImport, type ArchiveImportEntryOutcome } from "@mcp-knowledge/core";
```

Add `archives` to `AppServices`:

```ts
export type AppServices = {
  env: AppEnv;
  documents: DocumentService;
  archives: ArchiveImportService;
  collections: CollectionService;
  search: SearchService;
  keys: ApiKeyService;
  urls: UrlIngestService;
  startupScan: Pick<StartupIngestionCoordinator, "status">;
};
```

Add the JSON mapper near `documentJson`:

```ts
function archiveImportJson(record: ArchiveImport) {
  const counts: Record<ArchiveImportEntryOutcome | "examined", number> = {
    examined: 0,
    extracted: 0,
    duplicate: 0,
    unsupported: 0,
    oversized: 0,
    failed: 0,
  };
  const documentIds: string[] = [];
  for (const entry of record.entries) {
    counts.examined += 1;
    counts[entry.outcome] += 1;
    if (entry.outcome === "extracted" && entry.documentId) documentIds.push(entry.documentId);
  }
  return {
    id: record.id,
    originalFilename: record.originalFilename,
    collectionId: record.collectionId ?? null,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    counts,
    documentIds,
    error: record.error ?? null,
  };
}
```

- [ ] **Step 4: Dispatch `.zip` uploads before the existing single-document upload**

Replace the entire `if (url.pathname === "/api/v1/documents" && req.method === "POST") { ... }` block in `apps/server/src/http/router.ts` with:

```ts
    if (url.pathname === "/api/v1/documents" && req.method === "POST") {
      // ponytail: Content-Length bounds the whole multipart body (boundary + headers + file),
      // not just the file bytes MAX_UPLOAD_BYTES is checked against downstream — so this can
      // only reject bodies that are already way past any reasonable multipart overhead, not
      // enforce the limit precisely (that stays DocumentService's job, post-parse). It's also
      // client-declared and spoofable via chunked encoding. Good enough to stop a multi-GB
      // body from being buffered at all; a real streaming multipart cap is the full fix, add
      // it if a public server-profile deployment makes the spoofed case a real threat.
      const MULTIPART_OVERHEAD_SLACK = 64 * 1024;
      const declaredLength = Number(req.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > svc.env.MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_SLACK
      ) {
        return json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Upload exceeds MAX_UPLOAD_BYTES.", requestId } },
          413,
          requestId,
        );
      }
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return json(
          { error: { code: "INVALID_UPLOAD", message: "Missing file field.", requestId } },
          400,
          requestId,
        );
      }
      const collectionId = form.get("collectionId");
      let metadata: Record<string, unknown> = {};
      const rawMeta = form.get("metadata");
      if (typeof rawMeta === "string" && rawMeta.length > 0) {
        metadata = JSON.parse(rawMeta) as Record<string, unknown>;
      }
      if (extensionOf(file.name) === "zip") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { archiveId } = await svc.archives.stage({
          filename: file.name,
          bytes,
          collectionId: typeof collectionId === "string" ? collectionId : undefined,
          metadata,
        });
        return json({ archiveId, status: "queued" }, 202, requestId);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await svc.documents.upload({
        filename: file.name,
        bytes,
        collectionId: typeof collectionId === "string" ? collectionId : undefined,
        metadata,
      });
      return json(
        {
          id: result.document.id,
          status: result.document.status,
          revision: result.revision,
          duplicate: result.duplicate,
        },
        result.status,
        requestId,
      );
    }
```

This is the same handler as today with one change: `metadata`/`collectionId` are parsed once, right after `file` is validated, instead of after the `svc.documents.upload(...)` call — so the new `.zip` branch can use them before deciding which service to call.

- [ ] **Step 5: Add the two read routes**

Add near the other `/api/v1/documents/:id` routes:

```ts
    const archiveMatch = url.pathname.match(/^\/api\/v1\/archives\/([^/]+)$/);
    if (archiveMatch && req.method === "GET") {
      const id = decodeURIComponent(archiveMatch[1]!);
      const record = await svc.archives.get(id);
      return json(archiveImportJson(record), 200, requestId);
    }

    if (url.pathname === "/api/v1/archives" && req.method === "GET") {
      const limit = clampLimit(url.searchParams.get("limit"), svc.env.MAX_LIST_LIMIT, 50);
      const result = await svc.archives.list({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit,
      });
      return json(
        { items: result.items.map(archiveImportJson), nextCursor: result.nextCursor ?? null },
        200,
        requestId,
      );
    }
```

- [ ] **Step 6: Add `get`/`list` passthroughs to `ArchiveImportService`**

In `packages/core/src/services/archive-import-service.ts`, add these methods to the class (they belong in Task 6's file; add them now since the router needs them):

```ts
  async get(id: string): Promise<ArchiveImport> {
    const record = await this.repo.getArchiveImport(id);
    if (!record) throw new AppError("ARCHIVE_NOT_FOUND", "Archive import was not found.", 404);
    return record;
  }

  list(q: { cursor?: string; limit: number }) {
    return this.repo.listArchiveImports(q);
  }
```

- [ ] **Step 7: Run the tests — still expected to fail**

Run: `bun test tests/integration/archive-upload-api.test.ts`
Expected: FAIL — `AppServices.archives` isn't wired in `app.ts` yet (Task 9). Confirm the failure is specifically about missing wiring, not a router logic error, by checking the error message names `archives` as undefined.

- [ ] **Step 8: Run full gates for the files touched so far**

Run: `bun run typecheck`
Expected: Errors only in `apps/server/src/app.ts` (missing `archives` in the `AppServices` object literal) — confirms the router/service side compiles.

- [ ] **Step 9: Commit this task's changes together with Task 9**

Do not commit yet — Task 9 completes the wiring this task's test depends on. Proceed directly to Task 9.

---

### Task 9: Wire `ArchiveImportService` into the app

**Files:**
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `ArchiveImportService` constructor (Task 6), `startWorkerLoop`'s `archives` field (Task 7), `AppServices.archives` (Task 8).
- Produces: a fully wired app where `createApp()` returns working archive upload/status endpoints and a worker loop that extracts them.

- [ ] **Step 1: Wire the service and worker loop**

In `apps/server/src/app.ts`, add `ArchiveImportService` to the `@mcp-knowledge/core` import list:

```ts
import {
  ApiKeyService,
  ArchiveImportService,
  CollectionService,
  DocumentService,
  IngestionService,
  SearchService,
  SourceImportService,
  UrlIngestService,
  loadWordPiece,
} from "@mcp-knowledge/core";
```

After `const documents = new DocumentService(repo, blobs, env.MAX_UPLOAD_BYTES);`, add:

```ts
  const archives = new ArchiveImportService(repo, blobs, documents, {
    MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES,
    MAX_ARCHIVE_ENTRIES: env.MAX_ARCHIVE_ENTRIES,
    MAX_ARCHIVE_UNCOMPRESSED_BYTES: env.MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    MAX_ARCHIVE_COMPRESSION_RATIO: env.MAX_ARCHIVE_COMPRESSION_RATIO,
  });
```

Change the `stopWorker` block to pass `archives`:

```ts
  const stopWorker =
    env.ROLE === "api"
      ? () => undefined
      : startWorkerLoop({
          repo,
          ingestion,
          archives,
          leaseMs: env.JOB_LEASE_MS,
          ingestionTimeoutMs: env.INGESTION_TIMEOUT_MS,
        });
```

Add `archives` to the `services` object:

```ts
  const services: AppServices = {
    env,
    documents,
    archives,
    collections: new CollectionService(repo),
    search: new SearchService(embedder, vectors, lexical, repo, env),
    keys: new ApiKeyService(repo),
    urls: new UrlIngestService(documents, env),
    startupScan,
  };
```

- [ ] **Step 2: Run the archive upload API tests to verify they pass**

Run: `bun test tests/integration/archive-upload-api.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full gates and commit Tasks 8 and 9 together**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add apps/server/src/app.ts apps/server/src/http/router.ts \
  packages/core/src/services/archive-import-service.ts \
  tests/integration/archive-upload-api.test.ts
git commit -m "feat: expose zip archive upload and status over HTTP"
```

---

### Task 10: Dashboard panel

**Files:**
- Create: `apps/server/src/ui/components/archive-imports-panel.tsx`
- Create: `tests/unit/archive-imports-panel.test.tsx`
- Modify: `apps/server/src/ui/App.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/archives` JSON shape (Task 8).
- Produces: `ArchiveImportsPanel` component rendered on the Jobs page.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/archive-imports-panel.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArchiveImportsPanel,
  type ArchiveImportSummary,
} from "../../apps/server/src/ui/components/archive-imports-panel.tsx";

const base: ArchiveImportSummary = {
  id: "arc_1",
  originalFilename: "export.zip",
  state: "extracting",
  counts: { examined: 2, extracted: 1, duplicate: 0, unsupported: 1, oversized: 0, failed: 0 },
  error: null,
};

describe("ArchiveImportsPanel", () => {
  test("renders nothing when there are no imports and no error", () => {
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[]} error={null} />);
    expect(html).toBe("");
  });

  test("lists an in-progress import with its counts", () => {
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[base]} error={null} />);
    expect(html).toContain("Archive imports");
    expect(html).toContain("export.zip");
    expect(html).toContain("1 extracted");
  });

  test("shows a failed import's safe error without leaking paths", () => {
    const failed: ArchiveImportSummary = {
      ...base,
      state: "failed",
      error: "ARCHIVE_TOO_LARGE: This archive is too large uncompressed.",
    };
    const html = renderToStaticMarkup(<ArchiveImportsPanel items={[failed]} error={null} />);
    expect(html).toContain("ARCHIVE_TOO_LARGE: This archive is too large uncompressed.");
    expect(html).not.toContain("/Users/");
  });

  test("surfaces a fetch error without hiding existing items", () => {
    const html = renderToStaticMarkup(
      <ArchiveImportsPanel items={[base]} error="Could not load archive imports." />,
    );
    expect(html).toContain("export.zip");
    expect(html).toContain("Could not load archive imports.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/archive-imports-panel.test.tsx`
Expected: FAIL — the component doesn't exist.

- [ ] **Step 3: Implement the panel**

```tsx
// apps/server/src/ui/components/archive-imports-panel.tsx
export type ArchiveImportSummary = {
  id: string;
  originalFilename: string;
  state: "queued" | "extracting" | "completed" | "completed_with_errors" | "failed";
  counts: {
    examined: number;
    extracted: number;
    duplicate: number;
    unsupported: number;
    oversized: number;
    failed: number;
  };
  error: string | null;
};

const STATE_LABEL: Record<ArchiveImportSummary["state"], string> = {
  queued: "Queued",
  extracting: "Extracting",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
};

export function ArchiveImportsPanel({
  items,
  error,
}: {
  items: ArchiveImportSummary[];
  error: string | null;
}) {
  if (items.length === 0 && !error) return null;
  return (
    <section className="mb-6 border border-rule bg-shelf/40 p-4">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-navy">
        Archive imports
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate">No archive imports yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-mono">{item.originalFilename}</span>
              <span className="border border-rule px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-slate">
                {STATE_LABEL[item.state]}
              </span>
              <span className="font-mono text-xs text-slate">
                {item.counts.extracted} extracted, {item.counts.failed} failed
              </span>
              {item.state === "failed" && item.error ? (
                <p className="w-full text-sm text-stamp">{item.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-3 text-sm text-stamp">{error}</p> : null}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/archive-imports-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the panel into `JobsPage`**

In `apps/server/src/ui/App.tsx`, add the import:

```ts
import { ArchiveImportsPanel, type ArchiveImportSummary } from "./components/archive-imports-panel.tsx";
```

Inside `JobsPage`, add state and a poller alongside the existing scan-status state:

```ts
  const [archiveImports, setArchiveImports] = useState<ArchiveImportSummary[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const reloadArchiveImports = useCallback(async () => {
    const res = await fetch("/api/v1/archives?limit=5");
    const data = (await res.json()) as { items?: ArchiveImportSummary[]; error?: { message: string } };
    if (!res.ok) {
      setArchiveError(data.error?.message ?? "Could not load archive imports.");
      return;
    }
    setArchiveImports(data.items ?? []);
    setArchiveError(null);
  }, []);
```

Change the existing polling effect to include it:

```ts
  useEffect(() => {
    const poll = () => void Promise.allSettled([reload(), reloadScanStatus(), reloadArchiveImports()]);
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [reload, reloadScanStatus, reloadArchiveImports]);
```

Render the panel above `ScanStatusPanel`:

```tsx
      <ArchiveImportsPanel items={archiveImports} error={archiveError} />
      {scanStatus ? <ScanStatusPanel status={scanStatus} error={scanError} /> : null}
```

- [ ] **Step 6: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add apps/server/src/ui/components/archive-imports-panel.tsx \
  tests/unit/archive-imports-panel.test.tsx apps/server/src/ui/App.tsx
git commit -m "feat: show archive imports on the Jobs dashboard"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/supported-formats.md`
- Modify: `docs/troubleshooting.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Document zip upload in `docs/supported-formats.md`**

Add a new section after the existing "File types accepted for upload" section:

```markdown
## Zip archives

Uploading a `.zip` does not create one document — the server extracts every
allowlisted entry (recursively, across subfolders) and ingests each as its
own document, exactly as if uploaded individually. The upload response
returns an `archiveId` (`GET /api/v1/archives/:id` to poll progress), not a
document id.

The zip container itself is never stored past extraction — only the
documents it produces are canonical originals. A nested `.zip` inside the
archive is not expanded; it is counted `unsupported`, same as any other
disallowed extension.

Whole-archive resource limits (checked from the zip's central directory
before any entry is decompressed): `MAX_ARCHIVE_ENTRIES` (default `1024`)
total entries, `MAX_ARCHIVE_UNCOMPRESSED_BYTES` (default 100 MiB) aggregate
declared size. Exceeding either fails the entire import. A single entry
exceeding `MAX_UPLOAD_BYTES`, or whose declared compression ratio exceeds
`MAX_ARCHIVE_COMPRESSION_RATIO` (default `100`), is skipped without being
decompressed — the rest of the archive still imports.
```

- [ ] **Step 2: Add the new failure codes to `docs/troubleshooting.md`**

Add two rows to the existing failure-code table:

```markdown
| `ARCHIVE_TOO_LARGE` | The uploaded zip has too many entries or is too large uncompressed. | Split the archive into smaller zips, then upload each again. |
| `ARCHIVE_MALFORMED` | The uploaded zip could not be read. | Re-create the zip archive, then upload it again. |
```

- [ ] **Step 3: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add docs/supported-formats.md docs/troubleshooting.md
git commit -m "docs: describe zip archive upload and its failure codes"
```

---

## Self-Review Notes

- **Spec coverage:** every spec section has a task — domain/ID prefix (Task 1), central-directory reading (Task 2), persistence (Task 3–4), `stage`/`extract` (Task 5–6), worker integration (Task 7), HTTP API (Task 8), app wiring (Task 9), dashboard (Task 10), docs (Task 11). The spec's "Testing strategy" section maps directly to each task's TDD steps.
- **Restart safety** (spec's key idempotency guarantee) is exercised directly in Task 4's "reclaims a stale extracting import and resets its entries" test, and relied upon (not re-tested) in Task 6/7 since `extract()`'s idempotency comes from `DocumentService.upload()`'s existing sha256 dedup, already covered by that service's own tests.
- **Type consistency check:** `ArchiveImportEntry`, `ArchiveImportState`, `ArchiveImport` (Task 1) are used with the same field names throughout Tasks 3–10 (`entries`, `state`, `collectionId`, `metadata`, `originalFilename`). `ArchiveReader`/`ArchiveEntry` (Task 2) field names (`declaredUncompressedBytes`, `declaredCompressedBytes`, `isDirectory`, `isSymlink`, `path`) match between the adapter (Task 2) and the service's classification logic (Task 6). Repository method names (`createArchiveImport`, `getArchiveImport`, `getArchiveImportStagingKey`, `listArchiveImports`, `claimArchiveImport`, `appendArchiveImportEntry`, `finishArchiveImport`, `failArchiveImport`) are identical across the port declaration (Task 4), the libsql implementation (Task 4), and every consumer (Tasks 5, 6, 8).
