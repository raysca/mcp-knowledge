import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { Document } from "../domain/types.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import { extensionOf, isAllowedUpload, sniffMime } from "../mime.ts";

export function originalStorageKey(documentId: string, revisionId: string): string {
  return `documents/${documentId}/revisions/${revisionId}/original`;
}

export class DocumentService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly maxUploadBytes: number,
  ) {}

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
}
