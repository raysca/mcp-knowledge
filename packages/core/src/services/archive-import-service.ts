import { AppError } from "../errors.ts";
import { newId } from "../ids.ts";
import { publicArchiveFailure } from "../archive-failure.ts";
import { isAllowedUpload } from "../mime.ts";
import { AdmZipArchiveReader, type ArchiveEntry, type ArchiveReader } from "../archive/reader.ts";
import type { ArchiveImport, ArchiveImportEntry } from "../domain/archive.ts";
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

// A zip's entry list is flat, but a path can still nest arbitrarily deep segments.
// This bounds pathological entries; it is not user configuration.
const MAX_ENTRY_PATH_SEGMENTS = 32;

function isSafeEntryPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > MAX_ENTRY_PATH_SEGMENTS) return false;
  return !segments.includes("..");
}

export class ArchiveImportService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly documents: DocumentService,
    private readonly limits: ArchiveImportLimits,
    private readonly deps: { openReader?: (bytes: Uint8Array) => ArchiveReader } = {},
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

  async extract(archiveId: string, signal?: AbortSignal): Promise<void> {
    const throwIfAborted = () => signal?.throwIfAborted();
    const stagingKey = await this.repo.getArchiveImportStagingKey(archiveId);
    const record = await this.repo.getArchiveImport(archiveId);
    if (!stagingKey || !record) return; // vanished (purged mid-flight) - nothing to do

    try {
      const blob = await this.blobs.get(stagingKey);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      throwIfAborted();
      const reader = this.deps.openReader?.(bytes) ?? new AdmZipArchiveReader(bytes);
      const entries = reader.entries().filter((entry) => !entry.isDirectory);

      if (entries.length > this.limits.MAX_ARCHIVE_ENTRIES) {
        await this.repo.failArchiveImport(
          archiveId,
          "ARCHIVE_TOO_LARGE: This archive has too many entries.",
        );
        return;
      }
      const totalDeclaredBytes = entries.reduce((sum, entry) => sum + entry.declaredUncompressedBytes, 0);
      if (totalDeclaredBytes > this.limits.MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        await this.repo.failArchiveImport(
          archiveId,
          "ARCHIVE_TOO_LARGE: This archive is too large uncompressed.",
        );
        return;
      }

      let hadFailure = false;
      for (const entry of entries) {
        throwIfAborted();
        const outcome = await this.classifyAndImport(reader, entry, record);
        if (outcome.outcome === "failed") hadFailure = true;
        await this.repo.appendArchiveImportEntry(archiveId, outcome);
      }
      await this.repo.finishArchiveImport(archiveId, hadFailure ? "completed_with_errors" : "completed");
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = publicArchiveFailure(error);
      await this.repo.failArchiveImport(archiveId, `${failure.code}: ${failure.message}`);
    } finally {
      await this.blobs.delete(stagingKey).catch(() => undefined);
    }
  }

  async get(id: string): Promise<ArchiveImport> {
    const record = await this.repo.getArchiveImport(id);
    if (!record) throw new AppError("ARCHIVE_NOT_FOUND", "Archive import was not found.", 404);
    return record;
  }

  list(q: { cursor?: string; limit: number }) {
    return this.repo.listArchiveImports(q);
  }

  private async classifyAndImport(
    reader: ArchiveReader,
    entry: ArchiveEntry,
    record: ArchiveImport,
  ): Promise<ArchiveImportEntry> {
    if (entry.isSymlink || !isSafeEntryPath(entry.path)) {
      return { path: entry.path, outcome: "failed", error: "unsafe entry path" };
    }
    if (!isAllowedUpload(entry.path)) {
      return { path: entry.path, outcome: "unsupported" };
    }
    if (entry.declaredUncompressedBytes > this.limits.MAX_UPLOAD_BYTES) {
      return { path: entry.path, outcome: "oversized" };
    }
    const ratio =
      entry.declaredCompressedBytes > 0
        ? entry.declaredUncompressedBytes / entry.declaredCompressedBytes
        : 1;
    if (ratio > this.limits.MAX_ARCHIVE_COMPRESSION_RATIO) {
      return { path: entry.path, outcome: "oversized" };
    }
    try {
      const bytes = reader.read(entry.path, this.limits.MAX_UPLOAD_BYTES);
      const result = await this.documents.upload({
        filename: entry.path,
        bytes,
        collectionId: record.collectionId,
        metadata: record.metadata,
      });
      return {
        path: entry.path,
        outcome: result.duplicate ? "duplicate" : "extracted",
        documentId: result.document.id,
      };
    } catch (error) {
      return {
        path: entry.path,
        outcome: "failed",
        error: error instanceof Error ? error.message : "failed to import entry",
      };
    }
  }
}
