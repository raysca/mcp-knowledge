import { AppError } from "../errors.ts";
import { chunkBlocks, type CountTokens } from "../chunking/chunk.ts";
import type {
  BlobStore,
  DocumentParser,
  EmbeddedChunk,
  Embedder,
  KnowledgeRepository,
  VectorIndex,
} from "../ports.ts";
import type { IngestionJob, StoredChunk } from "../domain/types.ts";

export type ParserRegistry = {
  find(input: { mimeType?: string; extension?: string }): DocumentParser | undefined;
};

export function normalizedStorageKey(documentId: string, revisionId: string): string {
  return `documents/${documentId}/revisions/${revisionId}/normalized.json`;
}

function cellCount(blocks: { type: string; rows?: string[][]; headers?: string[] }[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "table" && b.rows) {
      n += b.rows.reduce((sum, row) => sum + row.length, 0);
      n += b.headers?.length ?? 0;
    }
  }
  return n;
}

export class IngestionService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly blobs: BlobStore,
    private readonly registry: ParserRegistry,
    private readonly countTokens: CountTokens,
    private readonly embedder: Embedder,
    private readonly vectors: VectorIndex,
    private readonly limits: {
      MAX_EXTRACT_BYTES: number;
      MAX_SPREADSHEET_CELLS: number;
      MAX_CHUNKS_PER_DOCUMENT: number;
      EMBEDDING_BATCH_SIZE: number;
    },
  ) {}

  async process(job: IngestionJob): Promise<void> {
    const doc = await this.repo.getDocument(job.documentId);
    if (!doc) throw new AppError("DOCUMENT_NOT_FOUND", "Document was not found.", 404);
    const revision = await this.repo.getRevision(job.revisionId);
    if (!revision) throw new AppError("DOCUMENT_NOT_FOUND", "Revision was not found.", 404);
    const blob = await this.blobs.get(revision.storageKey);
    const parser = this.registry.find({
      mimeType: doc.mimeType,
      extension: doc.extension,
    });
    if (!parser) {
      throw new AppError("DOCUMENT_UNSUPPORTED_FORMAT", "No parser for this file type.", 415);
    }
    const normalized = await parser.parse({
      data: blob,
      filename: doc.originalFilename,
      mimeType: doc.mimeType,
    });
    const extractBytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
    if (extractBytes > this.limits.MAX_EXTRACT_BYTES) {
      throw new AppError("DOCUMENT_RESOURCE_LIMIT", "Extracted text exceeds MAX_EXTRACT_BYTES.", 400);
    }
    // ponytail: MAX_DOCUMENT_PAGES is not enforced here. @firecrawl/anydoc's Block/Document
    // types (checked against 0.2.4) carry no page, slide, or section location at all for any
    // format's success path - the field only exists on NeedsOcrError. A pages-based check
    // against blocks that never carry a page number is dead code that only looks like a
    // guard; MAX_EXTRACT_BYTES and MAX_CHUNKS_PER_DOCUMENT (both enforced below/above) are
    // the real resource bounds for this parser. Revisit if a future anydoc version exposes
    // page/slide provenance, which spec SourceLocation also needs for retrieval (M4+).
    if (cellCount(normalized.blocks) > this.limits.MAX_SPREADSHEET_CELLS) {
      throw new AppError("DOCUMENT_RESOURCE_LIMIT", "Spreadsheet exceeds MAX_SPREADSHEET_CELLS.", 400);
    }
    const title =
      normalized.title ??
      normalized.blocks.find((b) => b.type === "heading")?.text ??
      doc.originalFilename;
    const drafts = chunkBlocks(normalized.blocks, {
      title,
      revisionHash: revision.sha256,
      countTokens: this.countTokens,
    });
    if (drafts.length > this.limits.MAX_CHUNKS_PER_DOCUMENT) {
      throw new AppError("DOCUMENT_RESOURCE_LIMIT", "Chunk count exceeds MAX_CHUNKS_PER_DOCUMENT.", 400);
    }
    const key = normalizedStorageKey(doc.id, revision.id);
    await this.blobs.put(key, new Blob([JSON.stringify(normalized)], { type: "application/json" }));
    const now = new Date();
    const chunks: StoredChunk[] = drafts.map((d) => ({
      ...d,
      collectionId: doc.collectionId,
      documentId: doc.id,
      revisionId: revision.id,
      metadata: {},
      createdAt: now,
    }));
    await this.repo.replaceChunks(revision.id, chunks);
    const embedded: EmbeddedChunk[] = [];
    const batchSize = this.limits.EMBEDDING_BATCH_SIZE;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const vecs = await this.embedder.embed(batch.map((c) => c.embeddingText));
      for (let j = 0; j < batch.length; j++) {
        const vector = vecs[j];
        if (!vector) {
          throw new AppError("INTERNAL_ERROR", "Embedder returned fewer vectors than texts.", 500);
        }
        embedded.push({ chunkId: batch[j]!.id, vector });
      }
    }
    await this.vectors.insert(embedded);
    await this.repo.updateRevision(revision.id, {
      parserName: parser.name,
      parserVersion: parser.version,
      chunkerName: "structure-v1",
      chunkerVersion: "1",
      embeddingModel: this.embedder.model,
      embeddingDimensions: this.embedder.dimensions,
      embeddingVersion: this.embedder.version,
      normalizedStorageKey: key,
      chunkCount: chunks.length,
    });
    await this.repo.setDocumentStatus(doc.id, "ready", null, title);
    await this.repo.completeJob(job.id);
  }
}

export function errorCodeOf(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return "DOCUMENT_MALFORMED";
}
