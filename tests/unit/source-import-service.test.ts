import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../packages/core/src/errors.ts";
import type { Document } from "../../packages/core/src/domain/types.ts";
import type {
  CommitSourceImportInput,
  CommitSourceImportResult,
  SourceFileRecord,
} from "../../packages/core/src/domain/source.ts";
import type { BlobStore, KnowledgeRepository } from "../../packages/core/src/ports.ts";
import { isAllowedUpload } from "../../packages/core/src/mime.ts";
import { SourceImportService } from "../../packages/core/src/services/source-import-service.ts";
import type { ArchiveImportService } from "../../packages/core/src/services/archive-import-service.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";

type SourceImportRepository = Pick<
  KnowledgeRepository,
  | "commitSourceImport"
  | "findLiveOwnedSourceBySha256"
  | "getDocument"
  | "getLiveDocumentBySha256"
  | "getSourceFile"
  | "listDocumentBlobKeys"
  | "recordSourceFile"
>;

type SourceReader = {
  sourceId: string;
  inspectAndRead(
    candidate: { relativePath: string },
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>;
  pathState(relativePath: string): Promise<"present" | "missing" | "unknown">;
};

type RecordInput = Parameters<SourceImportRepository["recordSourceFile"]>[0];

function document(input: Partial<Document> & Pick<Document, "id" | "sha256">): Document {
  const { id, sha256, ...patch } = input;
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    id,
    originalFilename: patch.originalFilename ?? "document.txt",
    mimeType: patch.mimeType ?? "text/plain",
    sizeBytes: patch.sizeBytes ?? 4,
    sha256,
    status: patch.status ?? "ready",
    metadata: patch.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

function sourceRecord(input: Partial<SourceFileRecord> & Pick<SourceFileRecord, "relativePath">): SourceFileRecord {
  const { relativePath, ...patch } = input;
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    sourceId: "source-a",
    relativePath,
    lastOutcome: "imported",
    scanCycle: "cycle-old",
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

class FakeRepository implements SourceImportRepository {
  sourceFile: SourceFileRecord | null = null;
  ownedByHash: SourceFileRecord | null = null;
  liveDocumentByHash: Document | null = null;
  documents = new Map<string, Document>();
  documentBlobKeys = new Map<string, string[]>();
  recorded: RecordInput[] = [];
  committed: CommitSourceImportInput[] = [];
  commitError: Error | undefined;
  getDocumentError: Error | undefined;
  getSourceFileError: Error | undefined;
  onListDocumentBlobKeys: (() => void) | undefined;
  commitResult: CommitSourceImportResult = {
    outcome: "imported",
    documentId: "doc_new",
    jobId: "job_new",
  };

  async getSourceFile(_sourceId: string, relativePath: string): Promise<SourceFileRecord | null> {
    if (this.getSourceFileError) throw this.getSourceFileError;
    return this.sourceFile?.relativePath === relativePath ? this.sourceFile : null;
  }

  async getDocument(id: string): Promise<Document | null> {
    if (this.getDocumentError) throw this.getDocumentError;
    return this.documents.get(id) ?? null;
  }

  async findLiveOwnedSourceBySha256(
    _sourceId: string,
    _sha256: string,
  ): Promise<SourceFileRecord | null> {
    return this.ownedByHash;
  }

  async getLiveDocumentBySha256(_sha256: string): Promise<Document | null> {
    return this.liveDocumentByHash;
  }

  async recordSourceFile(input: RecordInput): Promise<void> {
    this.recorded.push(input);
  }

  async commitSourceImport(input: CommitSourceImportInput): Promise<CommitSourceImportResult> {
    this.committed.push(input);
    if (this.commitError) throw this.commitError;
    return this.commitResult;
  }

  async listDocumentBlobKeys(documentId: string): Promise<string[]> {
    this.onListDocumentBlobKeys?.();
    return this.documentBlobKeys.get(documentId) ?? [];
  }
}

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

class FakeBlobs implements Pick<BlobStore, "delete" | "put"> {
  puts: { key: string; data: Blob }[] = [];
  deleted: string[] = [];
  putError: Error | undefined;

  async put(key: string, data: Blob): Promise<void> {
    if (this.putError) throw this.putError;
    this.puts.push({ key, data });
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

class FakeSource implements SourceReader {
  readonly sourceId = "source-a";
  bytes = new TextEncoder().encode("text");
  sha256 = "sha-new";
  inspectError: Error | undefined;
  states = new Map<string, "present" | "missing" | "unknown">();
  reads: { candidate: { relativePath: string }; maxBytes: number; signal: AbortSignal }[] = [];

  async inspectAndRead(
    candidate: { relativePath: string },
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }> {
    this.reads.push({ candidate, maxBytes, signal });
    if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    if (this.inspectError) throw this.inspectError;
    return { bytes: this.bytes, sizeBytes: this.bytes.byteLength, sha256: this.sha256 };
  }

  async pathState(relativePath: string): Promise<"present" | "missing" | "unknown"> {
    return this.states.get(relativePath) ?? "present";
  }
}

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

async function withRepository(
  run: (repo: ReturnType<typeof createKnowledgeRepository>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-source-import-service-"));
  const url = `file:${join(dir, "app.db")}`;
  try {
    await migrateLibsql(url);
    await run(createKnowledgeRepository(url));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ownCurrentPath(
  repo: FakeRepository,
  input: { path?: string; documentId?: string; sha256?: string } = {},
): Document {
  const owned = document({
    id: input.documentId ?? "doc_old",
    sha256: input.sha256 ?? "sha-old",
  });
  repo.documents.set(owned.id, owned);
  repo.sourceFile = sourceRecord({
    relativePath: input.path ?? "current.txt",
    documentId: owned.id,
    sha256: owned.sha256,
  });
  return owned;
}

describe("SourceImportService", () => {
  test("propagates an already-aborted scan without recording an outcome", async () => {
    const controller = new AbortController();
    const shutdown = new Error("startup scan stopped");
    controller.abort(shutdown);
    const { repo, service } = setup(controller.signal);

    await expect(service.process({ relativePath: "interrupted.txt" }, "cycle-1")).rejects.toBe(
      shutdown,
    );

    expect(repo.recorded).toEqual([]);
    expect(repo.committed).toEqual([]);
  });

  test("does not persist an unknown outcome when same-path source lookup fails", async () => {
    const { repo, service } = setup();
    repo.getSourceFileError = new Error("source state unavailable");

    await expect(service.process({ relativePath: "new.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "failed",
      error: "source state unavailable",
    });

    expect(repo.recorded).toEqual([]);
    expect(repo.committed).toEqual([]);
  });

  test("does not clear a real owned source row after a transient source lookup failure", async () => {
    await withRepository(async (repo) => {
      await repo.createDocument({
        documentId: "doc_owned",
        revisionId: "rev_owned",
        originalFilename: "owned.txt",
        mimeType: "text/plain",
        extension: "txt",
        sizeBytes: 4,
        sha256: "sha-owned",
        metadata: {},
        storageKey: "documents/doc_owned/revisions/rev_owned/original",
      });
      await repo.recordSourceFile({
        sourceId: "source-a",
        relativePath: "owned.txt",
        sha256: "sha-owned",
        documentId: "doc_owned",
        lastOutcome: "imported",
        scanCycle: "cycle-old",
      });

      const flakyRepo: SourceImportRepository = {
        getSourceFile: async () => {
          throw new Error("temporary source lookup failure");
        },
        getDocument: repo.getDocument.bind(repo),
        findLiveOwnedSourceBySha256: repo.findLiveOwnedSourceBySha256.bind(repo),
        getLiveDocumentBySha256: repo.getLiveDocumentBySha256.bind(repo),
        recordSourceFile: repo.recordSourceFile.bind(repo),
        commitSourceImport: repo.commitSourceImport.bind(repo),
        listDocumentBlobKeys: repo.listDocumentBlobKeys.bind(repo),
      };
      const service = new SourceImportService({
        source: new FakeSource(),
        repo: flakyRepo,
        blobs: new FakeBlobs(),
        archives: new FakeArchives(),
        maxUploadBytes: 64,
        signal: new AbortController().signal,
      });

      await expect(service.process({ relativePath: "owned.txt" }, "cycle-new")).resolves.toEqual({
        outcome: "failed",
        error: "temporary source lookup failure",
      });

      expect(await repo.getSourceFile("source-a", "owned.txt")).toEqual(
        expect.objectContaining({
          sha256: "sha-owned",
          documentId: "doc_owned",
          lastOutcome: "imported",
          scanCycle: "cycle-old",
        }),
      );
      expect(await repo.getDocument("doc_owned")).toEqual(
        expect.objectContaining({ id: "doc_owned", sha256: "sha-owned" }),
      );
    });
  });

  test("records a document lookup failure without clearing the prior source ownership", async () => {
    const { repo, service } = setup();
    const owned = ownCurrentPath(repo);
    repo.getDocumentError = new Error("document lookup unavailable");

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "failed",
      documentId: owned.id,
      error: "document lookup unavailable",
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "failed",
        scanCycle: "cycle-1",
      }),
    ]);
    expect(repo.committed).toEqual([]);
  });

  test("records a local AbortError as a file failure while the scan signal remains active", async () => {
    const { repo, source, service } = setup();
    const owned = ownCurrentPath(repo);
    source.inspectError = new DOMException("local read cancelled", "AbortError");

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "failed",
      documentId: owned.id,
      error: "local read cancelled",
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "failed",
        scanCycle: "cycle-1",
      }),
    ]);
  });

  test("does not stage a blob after cancellation during retired-key lookup", async () => {
    const controller = new AbortController();
    const shutdown = new Error("startup scan stopped");
    const { blobs, repo, service } = setup(controller.signal);
    ownCurrentPath(repo);
    repo.onListDocumentBlobKeys = () => controller.abort(shutdown);

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).rejects.toBe(
      shutdown,
    );

    expect(blobs.puts).toEqual([]);
    expect(repo.recorded).toEqual([]);
    expect(repo.committed).toEqual([]);
  });

  test("records an unchanged live owned path when its inspected hash matches", async () => {
    const { source, repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo, { sha256: "sha-same" });
    source.sha256 = "sha-same";

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "unchanged",
      documentId: owned.id,
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-same",
        documentId: owned.id,
        lastOutcome: "unchanged",
      }),
    ]);
    expect(repo.committed).toEqual([]);
    expect(blobs.puts).toEqual([]);
  });

  test("queues a changed live owned path and atomically replaces its document", async () => {
    const { repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo);
    repo.commitResult = {
      outcome: "imported",
      documentId: "doc_new",
      jobId: "job_new",
      retiredDocumentId: owned.id,
    };

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "queued",
      documentId: "doc_new",
      replacedDocumentId: owned.id,
    });

    expect(repo.committed).toEqual([
      expect.objectContaining({
        mode: "import",
        sha256: "sha-new",
        replaceDocumentId: owned.id,
        prepared: expect.objectContaining({ sha256: "sha-new" }),
      }),
    ]);
    expect(blobs.puts).toHaveLength(1);
  });

  test("imports a path whose previous document has already been deleted by replacing its stale association", async () => {
    const { repo, service } = setup();
    repo.sourceFile = sourceRecord({
      relativePath: "deleted.txt",
      documentId: "doc_deleted",
      sha256: "sha-old",
    });

    await expect(service.process({ relativePath: "deleted.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "queued",
      documentId: "doc_new",
    });

    expect(repo.committed).toEqual([
      expect.objectContaining({ mode: "import", replaceDocumentId: "doc_deleted" }),
    ]);
  });

  test("stages and queues a new unique path exactly once", async () => {
    const { source, repo, blobs, service } = setup();

    await expect(service.process({ relativePath: "new.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "queued",
      documentId: "doc_new",
    });

    expect(blobs.puts).toHaveLength(1);
    expect(await blobs.puts[0]!.data.text()).toBe("text");
    expect(source.reads).toHaveLength(1);
    expect(repo.committed).toEqual([
      expect.objectContaining({
        mode: "import",
        sha256: "sha-new",
        prepared: expect.objectContaining({ sha256: "sha-new" }),
      }),
    ]);
  });

  test("records a copy as duplicate while its same-hash owned path remains present", async () => {
    const { source, repo, blobs, service } = setup();
    repo.ownedByHash = sourceRecord({
      relativePath: "original.txt",
      documentId: "doc_old",
      sha256: "sha-new",
    });
    source.states.set("original.txt", "present");

    await expect(service.process({ relativePath: "copy.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_old",
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({ documentId: null, lastOutcome: "duplicate", sha256: "sha-new" }),
    ]);
    expect(repo.committed).toEqual([]);
    expect(blobs.puts).toEqual([]);
  });

  test("queues a rename only when its same-hash owned old path is missing", async () => {
    const { source, repo, service } = setup();
    repo.ownedByHash = sourceRecord({
      relativePath: "old-name.txt",
      documentId: "doc_old",
      sha256: "sha-new",
    });
    source.states.set("old-name.txt", "missing");
    repo.commitResult = {
      outcome: "imported",
      documentId: "doc_new",
      jobId: "job_new",
      retiredDocumentId: "doc_old",
    };

    await expect(service.process({ relativePath: "renamed.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "queued",
      documentId: "doc_new",
      replacedDocumentId: "doc_old",
      renamed: true,
    });

    expect(repo.committed).toEqual([
      expect.objectContaining({ mode: "import", replaceDocumentId: "doc_old" }),
    ]);
  });

  test("records an unknown same-hash old path as a duplicate rather than a rename", async () => {
    const { source, repo, service } = setup();
    repo.ownedByHash = sourceRecord({
      relativePath: "old-name.txt",
      documentId: "doc_old",
      sha256: "sha-new",
    });
    source.states.set("old-name.txt", "unknown");

    await expect(service.process({ relativePath: "copy.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_old",
    });

    expect(repo.committed).toEqual([]);
  });

  test("records a manual live document with the same hash as an unowned duplicate", async () => {
    const { repo, blobs, service } = setup();
    repo.liveDocumentByHash = document({ id: "doc_manual", sha256: "sha-new" });

    await expect(service.process({ relativePath: "manual-copy.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_manual",
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({ documentId: null, lastOutcome: "duplicate", sha256: "sha-new" }),
    ]);
    expect(repo.committed).toEqual([]);
    expect(blobs.puts).toEqual([]);
  });

  test("atomically clears ownership when a changed owned path now matches existing content", async () => {
    const { repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo);
    repo.liveDocumentByHash = document({ id: "doc_existing", sha256: "sha-new" });
    repo.commitResult = {
      outcome: "duplicate",
      duplicateDocumentId: "doc_existing",
      retiredDocumentId: owned.id,
    };

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_existing",
      replacedDocumentId: owned.id,
    });

    expect(repo.committed).toEqual([
      expect.objectContaining({
        mode: "duplicate",
        duplicateDocumentId: "doc_existing",
        replaceDocumentId: owned.id,
        sha256: "sha-new",
      }),
    ]);
    expect(blobs.puts).toEqual([]);
  });

  test("treats a changed owned path as an update even when another same-hash path is missing", async () => {
    const { source, repo, blobs, service } = setup();
    const current = ownCurrentPath(repo);
    repo.ownedByHash = sourceRecord({
      relativePath: "other-old-name.txt",
      documentId: "doc_other",
      sha256: "sha-new",
    });
    repo.liveDocumentByHash = document({ id: "doc_other", sha256: "sha-new" });
    source.states.set("other-old-name.txt", "missing");
    repo.commitResult = {
      outcome: "duplicate",
      duplicateDocumentId: "doc_other",
      retiredDocumentId: current.id,
    };

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_other",
      replacedDocumentId: current.id,
    });

    expect(repo.committed).toEqual([
      expect.objectContaining({
        mode: "duplicate",
        duplicateDocumentId: "doc_other",
        replaceDocumentId: current.id,
      }),
    ]);
    expect(blobs.puts).toEqual([]);
  });

  test("records an unsupported update without reading or clearing the live owner", async () => {
    const { source, repo, service } = setup();
    const owned = ownCurrentPath(repo, { path: "current.exe", sha256: "sha-old" });

    await expect(service.process({ relativePath: "current.exe" }, "cycle-1")).resolves.toEqual({
      outcome: "unsupported",
      documentId: owned.id,
    });

    expect(source.reads).toEqual([]);
    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "unsupported",
      }),
    ]);
  });

  test("records an oversized update without clearing the live owner", async () => {
    const { repo, source, service } = setup();
    const owned = ownCurrentPath(repo);
    source.inspectError = new AppError("PAYLOAD_TOO_LARGE", "Source file is too large.", 413);

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "oversized",
      documentId: owned.id,
    });

    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "oversized",
      }),
    ]);
  });

  test("reports a staging failure and preserves the prior live ownership", async () => {
    const { repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo);
    blobs.putError = new Error("blob storage unavailable");

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "failed",
      documentId: owned.id,
      error: "blob storage unavailable",
    });

    expect(repo.committed).toEqual([]);
    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "failed",
      }),
    ]);
  });

  test("removes a staged blob after an import transaction fails", async () => {
    const { repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo);
    repo.commitError = new Error("transaction failed");

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "failed",
      documentId: owned.id,
      error: "transaction failed",
    });

    expect(blobs.puts).toHaveLength(1);
    expect(blobs.deleted).toEqual([blobs.puts[0]!.key]);
    expect(repo.recorded).toEqual([
      expect.objectContaining({
        sha256: "sha-old",
        documentId: owned.id,
        lastOutcome: "failed",
      }),
    ]);
  });

  test("removes a staged blob when an import commit becomes a duplicate during a race", async () => {
    const { repo, blobs, service } = setup();
    repo.commitResult = {
      outcome: "duplicate",
      duplicateDocumentId: "doc_race_winner",
    };

    await expect(service.process({ relativePath: "new.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "duplicate",
      documentId: "doc_race_winner",
    });

    expect(blobs.puts).toHaveLength(1);
    expect(blobs.deleted).toEqual([blobs.puts[0]!.key]);
  });

  test("deletes captured retired document blobs after a successful replacement", async () => {
    const { repo, blobs, service } = setup();
    const owned = ownCurrentPath(repo);
    repo.documentBlobKeys.set(owned.id, ["old-original", "old-normalized"]);
    repo.commitResult = {
      outcome: "imported",
      documentId: "doc_new",
      jobId: "job_new",
      retiredDocumentId: owned.id,
    };

    await expect(service.process({ relativePath: "current.txt" }, "cycle-1")).resolves.toEqual({
      outcome: "queued",
      documentId: "doc_new",
      replacedDocumentId: owned.id,
    });

    expect(blobs.deleted).toEqual(["old-original", "old-normalized"]);
  });
});

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
