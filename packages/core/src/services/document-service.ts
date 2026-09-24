import { randomBytes } from "node:crypto";
import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import { logger, serializeError } from "../logger.ts";
import type { Document } from "../domain/types.ts";
import type { NormalizedDocument } from "../domain/normalized.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import { extensionOf, isAllowedUpload, sniffMime } from "../mime.ts";
import { decodeBoundBlockCursor, pageNormalizedDocument, type DocumentPageResult } from "./document-page.ts";

function contentUnavailable(documentId: string, revisionId: string, error: unknown): never {
  logger.error({
    event: "normalized_document_content_unavailable",
    documentId,
    revisionId,
    error: serializeError(error),
  });
  throw new AppError("DOCUMENT_CONTENT_UNAVAILABLE", "Normalized document content is unavailable.", 500);
}

export function originalStorageKey(documentId: string, revisionId: string): string {
  return `documents/${documentId}/revisions/${revisionId}/original`;
}

export class DocumentService {
  private readonly cursorKey: Uint8Array;

  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly maxUploadBytes: number,
    cursorKey: Uint8Array = randomBytes(32),
  ) {
    this.cursorKey = Uint8Array.from(cursorKey);
  }

  async upload(input: {
    filename: string;
    bytes: Uint8Array;
    collectionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    document: Document;
    revision: number;
    duplicate: boolean;
    status: number;
  }> {
    if (input.bytes.byteLength > this.maxUploadBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Upload exceeds MAX_UPLOAD_BYTES.", 413);
    }
    if (!isAllowedUpload(input.filename)) {
      throw new AppError(
        "DOCUMENT_UNSUPPORTED_FORMAT",
        "This file type is not in the v1 allowlist.",
        415,
      );
    }
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input.bytes);
    const sha256 = hasher.digest("hex");
    const existing = await this.repo.getLiveDocumentBySha256(sha256);
    if (existing) {
      return { document: existing, revision: 1, duplicate: true, status: 200 };
    }
    if (input.collectionId) {
      const col = await this.repo.getCollection(input.collectionId);
      if (!col) {
        throw new AppError("COLLECTION_NOT_FOUND", "Collection was not found.", 404);
      }
    }
    const documentId = newId("doc");
    const revisionId = newId("rev");
    const storageKey = originalStorageKey(documentId, revisionId);
    // ponytail: cast is a TS lib quirk (Uint8Array<ArrayBufferLike> vs BlobPart's stricter
    // ArrayBuffer bound), not a real type hole — Bun's Blob accepts a Uint8Array at runtime.
    await this.blobs.put(storageKey, new Blob([input.bytes as unknown as BlobPart]));
    const created = await this.repo.createDocument({
      documentId,
      revisionId,
      collectionId: input.collectionId,
      originalFilename: input.filename,
      mimeType: sniffMime(input.bytes, input.filename),
      extension: extensionOf(input.filename),
      sizeBytes: input.bytes.byteLength,
      sha256,
      metadata: input.metadata ?? {},
      storageKey,
    });
    await this.repo.enqueueJob({ documentId, revisionId });
    await this.repo.setDocumentStatus(documentId, "processing", null);
    const document = await this.get(documentId);
    return {
      document,
      revision: created.revision,
      duplicate: false,
      status: 202,
    };
  }

  async get(id: string): Promise<Document> {
    const doc = await this.repo.getDocument(id);
    if (!doc) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    return doc;
  }

  list(q: {
    collectionId?: string;
    status?: string;
    cursor?: string;
    limit: number;
  }) {
    return this.repo.listDocuments(q);
  }

  async file(id: string): Promise<{ blob: Blob; filename: string; mimeType: string }> {
    const doc = await this.get(id);
    const key = await this.repo.getRevisionStorageKey(id);
    if (!key) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    const blob = await this.blobs.get(key);
    return { blob, filename: doc.originalFilename, mimeType: doc.mimeType };
  }

  async delete(id: string): Promise<void> {
    const key = await this.repo.getRevisionStorageKey(id);
    await this.get(id);
    await this.repo.softDeleteDocument(id);
    if (key) await this.blobs.delete(key);
  }

  async chunks(id: string, q: { limit: number; cursor?: string }) {
    await this.get(id);
    return this.repo.listChunks(id, q);
  }

  async chunk(id: string, q: { before?: number; after?: number }) {
    const chunk = await this.repo.getChunk(id);
    if (!chunk) throw new AppError("NOT_FOUND", "Chunk was not found.", 404);
    const before = Math.min(5, Math.max(0, q.before ?? 0));
    const after = Math.min(5, Math.max(0, q.after ?? 0));
    const all = await this.repo.listRevisionChunks(chunk.revisionId);
    const neighbors = all.filter(
      (c) => c.sequence >= chunk.sequence - before && c.sequence <= chunk.sequence + after,
    );
    return { items: neighbors };
  }

  async normalized(id: string): Promise<unknown> {
    const doc = await this.get(id);
    if (!doc.currentRevisionId) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    const revision = await this.repo.getRevision(doc.currentRevisionId);
    if (!revision?.normalizedStorageKey) {
      throw new AppError("DOCUMENT_NOT_FOUND", "Normalized document is not ready.", 404);
    }
    const blob = await this.blobs.get(revision.normalizedStorageKey);
    return JSON.parse(await blob.text());
  }

  async normalizedPage(documentOrId: string | Document, options: {
    cursor?: string;
    blockLimit?: number;
    maxChars?: number;
    headings?: string[];
  } = {}): Promise<DocumentPageResult & { document: Document }> {
    const doc = typeof documentOrId === "string" ? await this.get(documentOrId) : documentOrId;
    const id = doc.id;
    if (!doc.currentRevisionId) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    if (options.cursor !== undefined) {
      decodeBoundBlockCursor(options.cursor, this.cursorKey, {
        documentId: id, revisionId: doc.currentRevisionId, headings: options.headings,
      });
    }
    const revision = await this.repo.getRevision(doc.currentRevisionId);
    if (!revision?.normalizedStorageKey) {
      throw new AppError("DOCUMENT_NOT_FOUND", "Normalized document is not ready.", 404);
    }
    let normalized: NormalizedDocument;
    try {
      const blob = await this.blobs.get(revision.normalizedStorageKey);
      const parsed: unknown = JSON.parse(await blob.text());
      if (typeof parsed !== "object" || parsed === null ||
          !Array.isArray((parsed as NormalizedDocument).blocks) ||
          (parsed as NormalizedDocument).blocks.some((block) =>
            typeof block !== "object" || block === null ||
            (block.type === "heading" &&
              (typeof block.text !== "string" || !Number.isSafeInteger(block.level) || block.level < 1)))) {
        throw new Error("Invalid normalized document content.");
      }
      normalized = parsed as NormalizedDocument;
    } catch (error) {
      return contentUnavailable(id, revision.id, error);
    }
    try {
      const page = pageNormalizedDocument({
        documentId: id,
        revisionId: revision.id,
        normalized,
        cursor: options.cursor,
        blockLimit: options.blockLimit ?? Math.max(1, normalized.blocks.length),
        maxChars: options.maxChars ?? 32_000,
        headings: options.headings,
        cursorKey: this.cursorKey,
      });
      return { document: doc, ...page };
    } catch (error) {
      if (error instanceof AppError) throw error;
      return contentUnavailable(id, revision.id, error);
    }
  }

  async reindex(id: string) {
    const doc = await this.get(id);
    if (!doc.currentRevisionId) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    const job = await this.repo.enqueueJob({ documentId: id, revisionId: doc.currentRevisionId });
    await this.repo.setDocumentStatus(id, "processing", null);
    return job;
  }

  listJobs() {
    return this.repo.listJobs();
  }

  async retryJob(id: string) {
    const job = await this.repo.getJob(id);
    if (!job) throw new AppError("JOB_NOT_FOUND", "Job was not found.", 404);
    const retried = await this.repo.retryJob(id);
    await this.repo.setDocumentStatus(retried.documentId, "processing", null);
    return retried;
  }

  async purgeCorpus(): Promise<{ deletedDocuments: number; deletedBlobs: number }> {
    const keys = await this.repo.listRevisionBlobKeys();
    let deletedBlobs = 0;
    for (const key of keys) {
      await this.blobs.delete(key);
      deletedBlobs += 1;
    }
    const deletedDocuments = await this.repo.purgeDocuments();
    return { deletedDocuments, deletedBlobs };
  }
}
