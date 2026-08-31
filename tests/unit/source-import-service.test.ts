import { describe, expect, test } from "bun:test";
import { AppError } from "../../packages/core/src/errors.ts";
import type { Document } from "../../packages/core/src/domain/types.ts";
import type {
  CommitSourceImportInput,
  CommitSourceImportResult,
  SourceFileRecord,
} from "../../packages/core/src/domain/source.ts";
import type { BlobStore, KnowledgeRepository } from "../../packages/core/src/ports.ts";
import { SourceImportService } from "../../packages/core/src/services/source-import-service.ts";

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
  commitResult: CommitSourceImportResult = {
    outcome: "imported",
    documentId: "doc_new",
    jobId: "job_new",
  };

  async getSourceFile(_sourceId: string, relativePath: string): Promise<SourceFileRecord | null> {
    return this.sourceFile?.relativePath === relativePath ? this.sourceFile : null;
  }

  async getDocument(id: string): Promise<Document | null> {
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
    return this.documentBlobKeys.get(documentId) ?? [];
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
    if (this.inspectError) throw this.inspectError;
    return { bytes: this.bytes, sizeBytes: this.bytes.byteLength, sha256: this.sha256 };
  }

  async pathState(relativePath: string): Promise<"present" | "missing" | "unknown"> {
    return this.states.get(relativePath) ?? "present";
  }
}

function setup() {
  const source = new FakeSource();
  const repo = new FakeRepository();
  const blobs = new FakeBlobs();
  const service = new SourceImportService({
    source,
    repo,
    blobs,
    maxUploadBytes: 64,
    signal: new AbortController().signal,
  });
  return { source, repo, blobs, service };
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
