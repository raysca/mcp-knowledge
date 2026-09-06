import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { BlobStore, KnowledgeRepository } from "../ports.ts";
import type { DocumentService } from "./document-service.ts";

export type ArchiveImportLimits = {
  MAX_UPLOAD_BYTES: number;
  MAX_ARCHIVE_ENTRIES: number;
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: number;
  MAX_ARCHIVE_COMPRESSION_RATIO: number;
};

export function archiveStagingKey(archiveId: string): string {
  return `archives/${archiveId}/upload.zip`;
}

export class ArchiveImportService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly documents: DocumentService,
    private readonly limits: ArchiveImportLimits,
  ) {}

  async stage(input: {
    filename: string;
    bytes: Uint8Array;
    collectionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ archiveId: string }> {
    if (input.bytes.byteLength > this.limits.MAX_UPLOAD_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Upload exceeds MAX_UPLOAD_BYTES.", 413);
    }
    if (input.collectionId) {
      const collection = await this.repo.getCollection(input.collectionId);
      if (!collection) {
        throw new AppError("COLLECTION_NOT_FOUND", "Collection was not found.", 404);
      }
    }
    const archiveId = newId("arc");
    const stagingStorageKey = archiveStagingKey(archiveId);
    // ponytail: same BlobPart lib quirk as document-service.ts (Uint8Array<ArrayBufferLike>
    // vs BlobPart's stricter ArrayBuffer bound) - Bun's Blob accepts a Uint8Array at runtime.
    await this.blobs.put(stagingStorageKey, new Blob([input.bytes as unknown as BlobPart]));
    const created = await this.repo.createArchiveImport({
      id: archiveId,
      originalFilename: input.filename,
      collectionId: input.collectionId,
      stagingStorageKey,
      metadata: input.metadata ?? {},
    });
    return { archiveId: created.id };
  }
}
