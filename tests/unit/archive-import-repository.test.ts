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
