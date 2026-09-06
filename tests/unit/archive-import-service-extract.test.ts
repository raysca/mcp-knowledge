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
