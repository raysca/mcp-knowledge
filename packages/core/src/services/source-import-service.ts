import { basename } from "node:path";
import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import { extensionOf, isAllowedUpload, sniffMime } from "../mime.ts";
import type { SourceFileOutcome, SourceFileRecord } from "../domain/source.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import { originalStorageKey } from "./document-service.ts";

type SourceReader = {
  readonly sourceId: string;
  inspectAndRead(
    candidate: { relativePath: string },
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>;
  pathState(relativePath: string): Promise<"present" | "missing" | "unknown">;
};

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

type SourceImportBlobStore = Pick<BlobStore, "delete" | "put">;

type LivePathOwnership = {
  documentId: string;
  sha256: string;
};

export type SourceProcessResult = {
  outcome: "queued" | "unchanged" | "duplicate" | "unsupported" | "oversized" | "failed";
  documentId?: string;
  replacedDocumentId?: string;
  renamed?: boolean;
  error?: string;
};

function errorCode(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

function shortErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "Source file could not be processed.";
}

export class SourceImportService {
  constructor(
    private readonly input: {
      source: SourceReader;
      repo: SourceImportRepository;
      blobs: SourceImportBlobStore;
      maxUploadBytes: number;
      signal: AbortSignal;
    },
  ) {}

  async process(
    candidate: { relativePath: string },
    scanCycle: string,
  ): Promise<SourceProcessResult> {
    const filename = basename(candidate.relativePath);
    let samePath: SourceFileRecord | null = null;
    let samePathDocument: { id: string; sha256: string } | null = null;
    try {
      this.throwIfAborted();
      samePath = await this.input.repo.getSourceFile(
        this.input.source.sourceId,
        candidate.relativePath,
      );
      this.throwIfAborted();
      samePathDocument = samePath?.documentId
        ? await this.input.repo.getDocument(samePath.documentId)
        : null;
      this.throwIfAborted();
    } catch (error) {
      this.throwIfCancellation(error);
      if (!samePath) {
        return { outcome: "failed", error: shortErrorMessage(error) };
      }
      return this.recordOutcome({
        candidate,
        scanCycle,
        outcome: "failed",
        sha256: samePath?.documentId ? samePath.sha256 ?? null : null,
        documentId: samePath?.documentId ?? null,
        error: shortErrorMessage(error),
      });
    }
    const livePathOwnership = this.liveOwnership(samePath, samePathDocument);

    if (!isAllowedUpload(filename)) {
      this.throwIfAborted();
      return this.recordOutcome({
        candidate,
        scanCycle,
        outcome: "unsupported",
        sha256: livePathOwnership?.sha256 ?? null,
        documentId: livePathOwnership?.documentId ?? null,
      });
    }

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
        sha256: livePathOwnership?.sha256 ?? null,
        documentId: livePathOwnership?.documentId ?? null,
        error: outcome === "failed" ? shortErrorMessage(error) : undefined,
      });
    }
    this.throwIfAborted();

    if (livePathOwnership && samePath?.sha256 === inspected.sha256) {
      return this.recordOutcome({
        candidate,
        scanCycle,
        outcome: "unchanged",
        sha256: inspected.sha256,
        documentId: livePathOwnership.documentId,
      });
    }

    try {
      const [ownedSameHash, existingSameHash] = await Promise.all([
        this.input.repo.findLiveOwnedSourceBySha256(this.input.source.sourceId, inspected.sha256),
        this.input.repo.getLiveDocumentBySha256(inspected.sha256),
      ]);

      let replaceDocumentId = samePath?.documentId;
      let renamed = false;

      if (
        !samePath?.documentId &&
        ownedSameHash?.documentId &&
        ownedSameHash.relativePath !== candidate.relativePath
      ) {
        const oldPathState = await this.input.source.pathState(ownedSameHash.relativePath);
        if (oldPathState === "missing") {
          replaceDocumentId = ownedSameHash.documentId;
          renamed = true;
        } else {
          return this.recordOutcome({
            candidate,
            scanCycle,
            outcome: "duplicate",
            sha256: inspected.sha256,
            documentId: null,
            resultDocumentId: ownedSameHash.documentId,
          });
        }
      }

      if (existingSameHash && existingSameHash.id !== replaceDocumentId && !renamed) {
        if (livePathOwnership) {
          return await this.commitDuplicate({
            candidate,
            scanCycle,
            sha256: inspected.sha256,
            duplicateDocumentId: existingSameHash.id,
            replaceDocumentId: livePathOwnership.documentId,
          });
        }
        return this.recordOutcome({
          candidate,
          scanCycle,
          outcome: "duplicate",
          sha256: inspected.sha256,
          documentId: null,
          resultDocumentId: existingSameHash.id,
        });
      }

      return await this.commitImport({
        candidate,
        filename,
        scanCycle,
        inspected,
        replaceDocumentId,
        renamed,
      });
    } catch (error) {
      this.throwIfCancellation(error);
      return this.recordOutcome({
        candidate,
        scanCycle,
        outcome: "failed",
        sha256: livePathOwnership?.sha256 ?? inspected.sha256,
        documentId: livePathOwnership?.documentId ?? null,
        error: shortErrorMessage(error),
      });
    }
  }

  private liveOwnership(
    sourceFile: SourceFileRecord | null,
    document: { id: string; sha256: string } | null,
  ): LivePathOwnership | undefined {
    if (!sourceFile?.documentId || !document) return undefined;
    return {
      documentId: document.id,
      sha256: sourceFile.sha256 ?? document.sha256,
    };
  }

  private async commitDuplicate(input: {
    candidate: { relativePath: string };
    scanCycle: string;
    sha256: string;
    duplicateDocumentId: string;
    replaceDocumentId: string;
  }): Promise<SourceProcessResult> {
    const oldBlobKeys = await this.input.repo.listDocumentBlobKeys(input.replaceDocumentId);
    this.throwIfAborted();
    const committed = await this.input.repo.commitSourceImport({
      mode: "duplicate",
      sourceId: this.input.source.sourceId,
      relativePath: input.candidate.relativePath,
      scanCycle: input.scanCycle,
      sha256: input.sha256,
      duplicateDocumentId: input.duplicateDocumentId,
      replaceDocumentId: input.replaceDocumentId,
    });
    if (committed.outcome !== "duplicate") {
      throw new Error("Source duplicate commit returned an import result.");
    }
    await this.deleteRetiredBlobs(committed.retiredDocumentId, oldBlobKeys);
    return {
      outcome: "duplicate",
      documentId: committed.duplicateDocumentId,
      ...(committed.retiredDocumentId
        ? { replacedDocumentId: committed.retiredDocumentId }
        : {}),
    };
  }

  private async commitImport(input: {
    candidate: { relativePath: string };
    filename: string;
    scanCycle: string;
    inspected: { bytes: Uint8Array; sizeBytes: number; sha256: string };
    replaceDocumentId?: string;
    renamed: boolean;
  }): Promise<SourceProcessResult> {
    const documentId = newId("doc");
    const revisionId = newId("rev");
    const storageKey = originalStorageKey(documentId, revisionId);
    const oldBlobKeys = input.replaceDocumentId
      ? await this.input.repo.listDocumentBlobKeys(input.replaceDocumentId)
      : [];

    this.throwIfAborted();
    await this.input.blobs.put(
      storageKey,
      new Blob([input.inspected.bytes as unknown as BlobPart], {
        type: sniffMime(input.inspected.bytes, input.filename),
      }),
    );

    let committed;
    try {
      this.throwIfAborted();
      committed = await this.input.repo.commitSourceImport({
        mode: "import",
        sourceId: this.input.source.sourceId,
        relativePath: input.candidate.relativePath,
        scanCycle: input.scanCycle,
        sha256: input.inspected.sha256,
        ...(input.replaceDocumentId ? { replaceDocumentId: input.replaceDocumentId } : {}),
        prepared: {
          documentId,
          revisionId,
          originalFilename: input.filename,
          mimeType: sniffMime(input.inspected.bytes, input.filename),
          extension: extensionOf(input.filename),
          sizeBytes: input.inspected.sizeBytes,
          sha256: input.inspected.sha256,
          metadata: {},
          storageKey,
        },
      });
    } catch (error) {
      await this.deleteStagedBlob(storageKey);
      throw error;
    }

    if (committed.outcome === "duplicate") {
      await this.deleteStagedBlob(storageKey);
      await this.deleteRetiredBlobs(committed.retiredDocumentId, oldBlobKeys);
      return {
        outcome: "duplicate",
        documentId: committed.duplicateDocumentId,
        ...(committed.retiredDocumentId
          ? { replacedDocumentId: committed.retiredDocumentId }
          : {}),
      };
    }

    await this.deleteRetiredBlobs(committed.retiredDocumentId, oldBlobKeys);
    return {
      outcome: "queued",
      documentId: committed.documentId,
      ...(committed.retiredDocumentId
        ? { replacedDocumentId: committed.retiredDocumentId }
        : {}),
      ...(input.renamed ? { renamed: true } : {}),
    };
  }

  private async recordOutcome(input: {
    candidate: { relativePath: string };
    scanCycle: string;
    outcome: Exclude<SourceFileOutcome, "imported">;
    sha256: string | null;
    documentId: string | null;
    resultDocumentId?: string;
    error?: string;
  }): Promise<SourceProcessResult> {
    this.throwIfAborted();
    await this.input.repo.recordSourceFile({
      sourceId: this.input.source.sourceId,
      relativePath: input.candidate.relativePath,
      sha256: input.sha256,
      documentId: input.documentId,
      lastOutcome: input.outcome,
      scanCycle: input.scanCycle,
    });
    const resultDocumentId = input.resultDocumentId ?? input.documentId ?? undefined;
    return {
      outcome: input.outcome,
      ...(resultDocumentId ? { documentId: resultDocumentId } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
  }

  private async deleteStagedBlob(storageKey: string): Promise<void> {
    try {
      await this.input.blobs.delete(storageKey);
    } catch (error) {
      console.warn("Failed to remove staged source blob.", error);
    }
  }

  private async deleteRetiredBlobs(
    retiredDocumentId: string | undefined,
    oldBlobKeys: string[],
  ): Promise<void> {
    if (!retiredDocumentId) return;
    for (const key of oldBlobKeys) {
      try {
        await this.input.blobs.delete(key);
      } catch (error) {
        console.warn("Failed to remove retired source blob.", { retiredDocumentId, key, error });
      }
    }
  }

  private throwIfAborted(): void {
    if (this.input.signal.aborted) {
      throw this.input.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
  }

  private throwIfCancellation(error: unknown): void {
    if (this.input.signal.aborted) {
      throw this.input.signal.reason ?? error;
    }
  }
}
