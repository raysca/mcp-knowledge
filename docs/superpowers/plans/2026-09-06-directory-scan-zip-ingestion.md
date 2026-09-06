# Directory Scan Zip Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `.zip` file discovered by the startup directory scanner (`INGEST_DATA_DIR`) is staged via `ArchiveImportService.stage()` instead of being marked `unsupported`, so its allowlisted entries get ingested the same way a manually uploaded zip's entries do.

**Architecture:** `SourceImportService` gains one new branch, intercepting `.zip` paths before the existing `isAllowedUpload` check, plus a new constructor dependency on `ArchiveImportService.stage()`. The zip's `source_files` tracking row always has `document_id: null` (a new `SourceFileOutcome` value, `"archived"`, marks it), which sidesteps the existing unique-ownership-index constraint entirely and gets unowned-row cleanup for free from code that already exists. No schema change, no new repository method, no dashboard change — a staged archive is reported to `StartupIngestionCoordinator` as the existing `"queued"` outcome.

**Tech Stack:** Same Bun/TypeScript monorepo as the parent feature; no new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-06-directory-scan-zip-ingestion-design.md](../specs/2026-09-06-directory-scan-zip-ingestion-design.md)

## Global Constraints

- `.zip` tracking rows in `source_files` must never set `document_id` — the unique partial index on that column enforces one document per owned row, and a zip produces N documents.
- `.zip` is intercepted before `isAllowedUpload(filename)` — it must never fall through to the `unsupported` branch, and `isAllowedUpload` itself is unchanged (still correctly rejects `.zip` for the single-document path).
- No rename inference and no retirement of previously-extracted documents when a zip changes — re-staging and re-extracting is the whole mechanism, relying on `DocumentService.upload()`'s existing sha256 dedup for safety.
- No new environment variables, no migration, no change to `ArchiveImportService.extract()`, the `archive_imports` table, the `/api/v1/archives*` endpoints, or the Archive imports dashboard panel.
- Every milestone ends with `bun run typecheck` and `bun test` green.

---

### Task 1: `SourceImportService` stages `.zip` paths as archive imports

**Files:**
- Modify: `packages/core/src/domain/source.ts`
- Modify: `packages/core/src/services/source-import-service.ts`
- Modify: `tests/unit/source-import-service.test.ts`

**Interfaces:**
- Consumes: `ArchiveImportService.stage()` (existing, from the parent feature).
- Produces: `SourceFileOutcome` gains `"archived"`; `SourceProcessResult` gains `archiveId?: string`; `SourceImportService`'s constructor input gains `archives: Pick<ArchiveImportService, "stage">`. Task 2 depends on this exact field name.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/source-import-service.test.ts`. First add a fake archives stager near the other fakes (`FakeRepository`, `FakeBlobs`, `FakeSource`):

```ts
class FakeArchives implements Pick<ArchiveImportService, "stage"> {
  staged: Array<{ filename: string; bytes: Uint8Array }> = [];
  nextArchiveId = "arc_1";
  stageError: Error | undefined;

  async stage(input: { filename: string; bytes: Uint8Array }): Promise<{ archiveId: string }> {
    if (this.stageError) throw this.stageError;
    this.staged.push({ filename: input.filename, bytes: input.bytes });
    return { archiveId: this.nextArchiveId };
  }
}
```

Add the imports:

```ts
import { isAllowedUpload } from "../../packages/core/src/mime.ts";
import type { ArchiveImportService } from "../../packages/core/src/services/archive-import-service.ts";
```

Update `setup()` to construct and return a `FakeArchives`, passing it to the service:

```ts
function setup(signal = new AbortController().signal) {
  const source = new FakeSource();
  const repo = new FakeRepository();
  const blobs = new FakeBlobs();
  const archives = new FakeArchives();
  const service = new SourceImportService({
    source,
    repo,
    blobs,
    archives,
    maxUploadBytes: 64,
    signal,
  });
  return { source, repo, blobs, archives, service };
}
```

Then add a new `describe` block with the zip-specific tests:

```ts
describe("SourceImportService zip archives", () => {
  test("stages a new zip and records an unowned archived row", async () => {
    const { source, repo, archives, service } = setup();
    source.bytes = new TextEncoder().encode("pkzip bytes");
    source.sha256 = "sha-zip-1";

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-1");

    expect(result).toEqual({ outcome: "queued", archiveId: "arc_1" });
    expect(archives.staged).toEqual([{ filename: "bundle.zip", bytes: source.bytes }]);
    expect(repo.recorded).toEqual([
      {
        sourceId: "source-a",
        relativePath: "bundle.zip",
        sha256: "sha-zip-1",
        documentId: null,
        lastOutcome: "archived",
        scanCycle: "cycle-1",
      },
    ]);
  });

  test("does not restage an unchanged zip", async () => {
    const { repo, source, archives, service } = setup();
    repo.sourceFile = sourceRecord({
      relativePath: "bundle.zip",
      sha256: "sha-zip-1",
      lastOutcome: "archived",
      scanCycle: "cycle-old",
    });
    source.sha256 = "sha-zip-1";

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-2");

    expect(result).toEqual({ outcome: "unchanged" });
    expect(archives.staged).toEqual([]);
    expect(repo.recorded).toEqual([
      {
        sourceId: "source-a",
        relativePath: "bundle.zip",
        sha256: "sha-zip-1",
        documentId: null,
        lastOutcome: "unchanged",
        scanCycle: "cycle-2",
      },
    ]);
  });

  test("restages a changed zip", async () => {
    const { repo, source, archives, service } = setup();
    repo.sourceFile = sourceRecord({
      relativePath: "bundle.zip",
      sha256: "sha-zip-old",
      lastOutcome: "archived",
      scanCycle: "cycle-old",
    });
    source.sha256 = "sha-zip-new";
    archives.nextArchiveId = "arc_2";

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-2");

    expect(result).toEqual({ outcome: "queued", archiveId: "arc_2" });
    expect(archives.staged).toHaveLength(1);
    expect(repo.recorded).toEqual([
      {
        sourceId: "source-a",
        relativePath: "bundle.zip",
        sha256: "sha-zip-new",
        documentId: null,
        lastOutcome: "archived",
        scanCycle: "cycle-2",
      },
    ]);
  });

  test("a zip that fails to read is failed and never staged", async () => {
    const { source, archives, service } = setup();
    source.inspectError = new Error("disk read error");

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-1");

    expect(result.outcome).toBe("failed");
    expect(archives.staged).toEqual([]);
  });

  test("a zip exceeding MAX_UPLOAD_BYTES is oversized and never staged", async () => {
    const { source, archives, service } = setup();
    const error = new AppError("PAYLOAD_TOO_LARGE", "too big", 413);
    source.inspectError = error;

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-1");

    expect(result.outcome).toBe("oversized");
    expect(archives.staged).toEqual([]);
  });

  test("a zip for which stage() throws is failed with a sanitized message", async () => {
    const { archives, service } = setup();
    archives.stageError = new Error("blob store unavailable at /Users/private/data");

    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-1");

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("blob store unavailable");
  });

  test("is intercepted before isAllowedUpload, which still rejects .zip on its own", async () => {
    expect(isAllowedUpload("bundle.zip")).toBe(false);

    const { archives, service } = setup();
    const result = await service.process({ relativePath: "bundle.zip" }, "cycle-1");

    expect(result.outcome).toBe("queued");
    expect(archives.staged).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/source-import-service.test.ts`
Expected: FAIL — `SourceImportService`'s constructor does not accept `archives`, and `.zip` paths currently return `unsupported`.

- [ ] **Step 3: Add the domain type changes**

In `packages/core/src/domain/source.ts`, change:

```ts
export type SourceFileOutcome =
  | "imported"
  | "unchanged"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";
```

to:

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

- [ ] **Step 4: Implement the `SourceImportService` changes**

In `packages/core/src/services/source-import-service.ts`, add the import:

```ts
import type { ArchiveImportService } from "./archive-import-service.ts";
```

Add `archives` to the constructor's input type:

```ts
export class SourceImportService {
  constructor(
    private readonly input: {
      source: SourceReader;
      repo: SourceImportRepository;
      blobs: SourceImportBlobStore;
      archives: Pick<ArchiveImportService, "stage">;
      maxUploadBytes: number;
      signal: AbortSignal;
    },
  ) {}
```

Add `archiveId?: string` to `SourceProcessResult`:

```ts
export type SourceProcessResult = {
  outcome: "queued" | "unchanged" | "duplicate" | "unsupported" | "oversized" | "failed";
  documentId?: string;
  replacedDocumentId?: string;
  renamed?: boolean;
  archiveId?: string;
  error?: string;
};
```

In `process()`, immediately after the `livePathOwnership` assignment and before the existing `if (!isAllowedUpload(filename))` check, add:

```ts
    const livePathOwnership = this.liveOwnership(samePath, samePathDocument);

    if (extensionOf(filename) === "zip") {
      return this.processArchive(candidate, filename, samePath, scanCycle);
    }

    if (!isAllowedUpload(filename)) {
```

(This inserts the new branch between the existing `livePathOwnership` line and the existing `isAllowedUpload` check — every other line in `process()` is unchanged.)

Add the new private method, placed after `commitImport` and before `recordOutcome`:

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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/source-import-service.test.ts`
Expected: PASS, including every pre-existing test in this file (they now construct their `service` with a `FakeArchives` too, via the updated `setup()`).

- [ ] **Step 6: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add packages/core/src/domain/source.ts packages/core/src/services/source-import-service.ts \
  tests/unit/source-import-service.test.ts
git commit -m "feat: stage zip files found by the directory scanner as archive imports"
```

---

### Task 2: Wire `archives` into the scanner and prove it end-to-end

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `tests/integration/startup-directory-ingestion.test.ts`

**Interfaces:**
- Consumes: `SourceImportService`'s `archives` field (Task 1), the already-constructed `ArchiveImportService` instance (existing, from the parent feature's app wiring).
- Produces: a working end-to-end path from a `.zip` sitting in `INGEST_DATA_DIR` to ready documents.

- [ ] **Step 1: Write the failing integration test**

Add to `tests/integration/startup-directory-ingestion.test.ts`. First add the import:

```ts
import AdmZip from "adm-zip";
```

Then add a helper alongside the existing `runScan`/`withApp` (it does not replace them — this scenario additionally needs to wait for the worker to extract a staged archive, which `runScan` does not do):

```ts
  async function runScanAndWaitForArchives(): Promise<{ status: StartupScanStatus; docs: Doc[] }> {
    const env = loadEnv({
      DATABASE_URL: `file:${dbPath}`,
      STORAGE_PATH: blobsPath,
      INGEST_DATA_DIR: sourceRoot,
    });
    const app = await createApp(env);
    const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      app.startStartupScan();
      const status = await waitForScan(base);
      const terminal = new Set(["completed", "completed_with_errors", "failed"]);
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const archives = (await fetch(`${base}/api/v1/archives?limit=20`).then((r) => r.json())) as {
          items: Array<{ state: string }>;
        };
        if (archives.items.every((a) => terminal.has(a.state))) break;
        await Bun.sleep(20);
      }
      const docs = (await fetch(`${base}/api/v1/documents?limit=100`).then((r) => r.json())) as {
        items: Doc[];
      };
      return { status, docs: docs.items };
    } finally {
      app.stop();
      server.stop(true);
    }
  }
```

Then add the test itself:

```ts
  test("stages and extracts a zip found in the scanned directory", async () => {
    const zip = new AdmZip();
    zip.addFile("first.txt", Buffer.from("first entry\n", "utf8"));
    zip.addFile("second.txt", Buffer.from("second entry\n", "utf8"));
    await writeFile(join(sourceRoot, "bundle.zip"), zip.toBuffer());

    const { status, docs } = await runScanAndWaitForArchives();
    expect(status.state).toBe("completed");

    const extracted = docs.filter(
      (d) => d.originalFilename === "first.txt" || d.originalFilename === "second.txt",
    );
    expect(extracted).toHaveLength(2);
    for (const doc of extracted) {
      expect(["processing", "ready"]).toContain(doc.status);
    }
  });

  test("does not restage an unchanged zip on a second scan", async () => {
    const zip = new AdmZip();
    zip.addFile("only.txt", Buffer.from("steady state\n", "utf8"));
    await writeFile(join(sourceRoot, "steady.zip"), zip.toBuffer());

    async function countArchives(): Promise<number> {
      const res = (await withApp((base) =>
        fetch(`${base}/api/v1/archives?limit=50`).then((r) => r.json()),
      )) as { items: unknown[] };
      return res.items.length;
    }

    await runScanAndWaitForArchives();
    const firstCount = await countArchives();

    const second = await runScanAndWaitForArchives();
    expect(second.status.state).toBe("completed");
    expect(await countArchives()).toBe(firstCount);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/integration/startup-directory-ingestion.test.ts`
Expected: FAIL — `app.ts` still constructs `SourceImportService` without `archives` (required as of Task 1). `bun test` runs on Bun's transpiler without type-checking, so this isn't a compile error here: at runtime, `this.input.archives.stage(...)` throws (`archives` is `undefined`), `processArchive()`'s own catch reports that as a `failed` outcome, and the scan reaches `completed_with_errors` with no extracted documents — failing both assertions.

- [ ] **Step 3: Wire it in `app.ts`**

In `apps/server/src/app.ts`, change the `createImporter` factory:

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

(Adds the single `archives,` line — `archives` is the same instance already constructed earlier in this function for the HTTP upload path; no new construction.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/integration/startup-directory-ingestion.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full gates and commit**

Run: `bun run typecheck && bun test`
Expected: 0 errors, all tests pass.

```bash
git add apps/server/src/app.ts tests/integration/startup-directory-ingestion.test.ts
git commit -m "feat: extract zip files discovered by the directory scanner"
```

---

## Self-Review Notes

- **Spec coverage:** domain/service changes (Task 1) and end-to-end wiring/proof (Task 2) cover every spec section — the classification table (unchanged/changed/failed/oversized/stage-throws) is exercised directly in Task 1's unit tests; the cleanup-for-free claim (unowned rows pruned by existing `completeSourceScan` logic) is not re-tested here since it's exercised by that logic's own existing tests and no code changes touch it.
- **Type consistency check:** `SourceFileOutcome`'s new `"archived"` value (Task 1, Step 3) is used identically in the `recordSourceFile` call (Step 4) and the unit test's `repo.recorded` expectations (Step 1). `SourceProcessResult.archiveId` (Step 4) matches the field name asserted in Task 1's tests and unused (but available) in Task 2's integration test. The `archives` constructor field name is identical across `SourceImportService`'s type (Task 1), `app.ts`'s wiring (Task 2), and the parent feature's already-existing `ArchiveImportService` instance.
- **No repository or schema changes**, confirmed by inspecting `SourceImportRepository`'s existing `Pick<KnowledgeRepository, ...>` list in `source-import-service.ts` — `recordSourceFile` was already present; nothing new needed there.
