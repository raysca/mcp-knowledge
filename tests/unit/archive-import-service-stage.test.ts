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
