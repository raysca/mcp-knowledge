import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SourceFileRecord,
  SourceScanCycle,
} from "../../packages/core/src/index.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";

async function withRepository(
  run: (repo: ReturnType<typeof createKnowledgeRepository>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-source-scan-repo-"));
  const url = `file:${join(dir, "app.db")}`;
  try {
    await migrateLibsql(url);
    await run(createKnowledgeRepository(url));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createDocument(
  repo: ReturnType<typeof createKnowledgeRepository>,
  documentId: string,
  sha256: string,
): Promise<void> {
  await repo.createDocument({
    documentId,
    revisionId: `rev_${documentId}`,
    originalFilename: `${documentId}.md`,
    mimeType: "text/markdown",
    extension: "md",
    sizeBytes: 3,
    sha256,
    metadata: {},
    storageKey: `documents/${documentId}/revisions/rev_${documentId}/original`,
  });
}

describe("source scan repository", () => {
  test("resumes an active cycle only when the source fingerprint is unchanged", async () => {
    await withRepository(async (repo) => {
      const opened: SourceScanCycle = await repo.openSourceScan({
        sourceId: "source-a",
        configurationFingerprint: "fp-a",
        proposedCycleId: "cycle-a",
      });
      expect(opened).toEqual({ cycleId: "cycle-a", resumed: false });

      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "a.txt",
        sha256: "sha-a",
        documentId: null,
        lastOutcome: "unsupported",
        scanCycle: "cycle-a",
      });

      const resumed: SourceScanCycle = await repo.openSourceScan({
        sourceId: "source-a",
        configurationFingerprint: "fp-a",
        proposedCycleId: "cycle-b",
      });
      expect(resumed).toEqual({ cycleId: "cycle-a", resumed: true });

      const replaced = await repo.openSourceScan({
        sourceId: "source-a",
        configurationFingerprint: "fp-b",
        proposedCycleId: "cycle-b",
      });
      expect(replaced).toEqual({ cycleId: "cycle-b", resumed: false });
    });
  });

  test("upserts source file state and finds only live owned files by hash", async () => {
    await withRepository(async (repo) => {
      await createDocument(repo, "doc_source1", "sha-owned");
      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "owned.md",
        sha256: "sha-owned",
        documentId: "doc_source1",
        lastOutcome: "imported",
        scanCycle: "cycle-a",
      });

      const record: SourceFileRecord | null = await repo.getSourceFile(
        "source-a",
        "owned.md",
      );
      expect(record).toEqual({
        sourceId: "source-a",
        relativePath: "owned.md",
        sha256: "sha-owned",
        documentId: "doc_source1",
        lastOutcome: "imported",
        scanCycle: "cycle-a",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(await repo.findLiveOwnedSourceBySha256("source-a", "sha-owned")).toEqual(
        expect.objectContaining({ relativePath: "owned.md", documentId: "doc_source1" }),
      );

      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "owned.md",
        sha256: "sha-owned",
        documentId: "doc_source1",
        lastOutcome: "failed",
        scanCycle: "cycle-b",
      });
      expect(await repo.getSourceFile("source-a", "owned.md")).toEqual(
        expect.objectContaining({
          sha256: "sha-owned",
          documentId: "doc_source1",
          lastOutcome: "failed",
          scanCycle: "cycle-b",
        }),
      );
      expect(await repo.findLiveOwnedSourceBySha256("source-a", "sha-owned")).toEqual(
        expect.objectContaining({ relativePath: "owned.md", documentId: "doc_source1" }),
      );

      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "duplicate.md",
        sha256: null,
        documentId: null,
        lastOutcome: "duplicate",
        scanCycle: "cycle-b",
      });
      expect(await repo.getSourceFile("source-a", "duplicate.md")).toEqual(
        expect.objectContaining({ sha256: undefined, documentId: undefined }),
      );

      await repo.softDeleteDocument("doc_source1");
      expect(await repo.findLiveOwnedSourceBySha256("source-a", "sha-owned")).toBeNull();
    });
  });

  test("retains an incomplete cycle then removes only stale unowned rows after completion", async () => {
    await withRepository(async (repo) => {
      await createDocument(repo, "doc_source2", "sha-owned");
      await repo.openSourceScan({
        sourceId: "source-a",
        configurationFingerprint: "fp",
        proposedCycleId: "cycle-a",
      });
      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "stale-unowned.txt",
        sha256: "sha-unowned",
        documentId: null,
        lastOutcome: "duplicate",
        scanCycle: "cycle-a",
      });
      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "stale-owned.md",
        sha256: "sha-owned",
        documentId: "doc_source2",
        lastOutcome: "imported",
        scanCycle: "cycle-a",
      });

      await repo.completeSourceScan({
        sourceId: "source-a",
        cycleId: "cycle-a",
        limitReached: true,
      });
      expect(
        (
          await repo.openSourceScan({
            sourceId: "source-a",
            configurationFingerprint: "fp",
            proposedCycleId: "cycle-b",
          })
        ).cycleId,
      ).toBe("cycle-a");

      await repo.completeSourceScan({
        sourceId: "source-a",
        cycleId: "cycle-a",
        limitReached: false,
      });
      await repo.openSourceScan({
        sourceId: "source-a",
        configurationFingerprint: "fp",
        proposedCycleId: "cycle-b",
      });
      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "current.txt",
        sha256: null,
        documentId: null,
        lastOutcome: "unsupported",
        scanCycle: "cycle-b",
      });
      await repo.completeSourceScan({
        sourceId: "source-a",
        cycleId: "cycle-wrong",
        limitReached: false,
      });
      expect(await repo.getSourceFile("source-a", "stale-unowned.txt")).not.toBeNull();
      expect(
        await repo.openSourceScan({
          sourceId: "source-a",
          configurationFingerprint: "fp",
          proposedCycleId: "cycle-c",
        }),
      ).toEqual({ cycleId: "cycle-b", resumed: true });

      await repo.completeSourceScan({
        sourceId: "source-a",
        cycleId: "cycle-b",
        limitReached: false,
      });

      expect(await repo.getSourceFile("source-a", "stale-unowned.txt")).toBeNull();
      expect(await repo.getSourceFile("source-a", "stale-owned.md")).toEqual(
        expect.objectContaining({ documentId: "doc_source2", scanCycle: "cycle-a" }),
      );
      expect(await repo.getSourceFile("source-a", "current.txt")).toEqual(
        expect.objectContaining({ scanCycle: "cycle-b" }),
      );
    });
  });

  test("concurrent claimJob and openSourceScan calls never interleave raw transactions", async () => {
    await withRepository(async (repo) => {
      // ponytail: regression for the shared-connection BEGIN IMMEDIATE race —
      // before serializing raw transactions this threw
      // "cannot start a transaction within a transaction" under real interleaving.
      const calls = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? repo.claimJob(`worker-${i}`, 30_000)
          : repo.openSourceScan({
              sourceId: `source-${i}`,
              configurationFingerprint: "fp",
              proposedCycleId: `cycle-${i}`,
            }),
      );
      await expect(Promise.all(calls)).resolves.toBeDefined();
    });
  });
});
