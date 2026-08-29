import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type {
  ApiKey,
  Collection,
  Document,
  DocumentRevision,
  IngestionJob,
  KnowledgeRepository,
  ListDocumentsQuery,
  StoredChunk,
} from "@mcp-knowledge/core";
import { newId } from "@mcp-knowledge/core";
import { createClient, type Client } from "@libsql/client";
import { createLibsqlDb } from "./libsql.ts";
import {
  apiKeys,
  collections,
  documentChunks,
  documentRevisions,
  documents,
  ingestionJobs,
} from "./schema/libsql.ts";

type Db = ReturnType<typeof createLibsqlDb>;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}:${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const idx = raw.indexOf(":");
  return { createdAt: Number(raw.slice(0, idx)), id: raw.slice(idx + 1) };
}

function toCollection(row: typeof collections.$inferSelect): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDocument(row: typeof documents.$inferSelect): Document {
  return {
    id: row.id,
    collectionId: row.collectionId ?? undefined,
    currentRevisionId: row.currentRevisionId ?? undefined,
    title: row.title ?? undefined,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    extension: row.extension ?? undefined,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    status: row.status as Document["status"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    latestError: row.latestError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

export class LibSqlKnowledgeRepository implements KnowledgeRepository {
  private readonly client: Client;

  constructor(
    private readonly db: Db,
    url: string,
  ) {
    this.client = createClient({ url });
  }

  async createCollection(input: {
    name: string;
    description?: string;
  }): Promise<Collection> {
    const now = new Date();
    const row = {
      id: newId("col"),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(collections).values(row);
    return toCollection(row);
  }

  async listCollections(): Promise<Collection[]> {
    const rows = await this.db.select().from(collections).orderBy(desc(collections.createdAt));
    return rows.map(toCollection);
  }

  async getCollection(id: string): Promise<Collection | null> {
    const rows = await this.db.select().from(collections).where(eq(collections.id, id)).limit(1);
    return rows[0] ? toCollection(rows[0]) : null;
  }

  async updateCollection(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Collection> {
    const existing = await this.getCollection(id);
    if (!existing) throw new Error("COLLECTION_NOT_FOUND");
    const now = new Date();
    await this.db
      .update(collections)
      .set({
        name: patch.name ?? existing.name,
        description:
          patch.description === undefined ? existing.description : patch.description,
        updatedAt: now,
      })
      .where(eq(collections.id, id));
    const updated = await this.getCollection(id);
    if (!updated) throw new Error("COLLECTION_NOT_FOUND");
    return updated;
  }

  async countDocumentsInCollection(id: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(documents)
      .where(and(eq(documents.collectionId, id), isNull(documents.deletedAt)));
    return Number(rows[0]?.n ?? 0);
  }

  async deleteCollection(id: string): Promise<void> {
    await this.db.delete(collections).where(eq(collections.id, id));
  }

  async createDocument(input: {
    documentId: string;
    revisionId: string;
    collectionId?: string;
    originalFilename: string;
    mimeType: string;
    extension?: string;
    sizeBytes: number;
    sha256: string;
    metadata: Record<string, unknown>;
    storageKey: string;
  }): Promise<{ document: Document; revision: number }> {
    const now = new Date();
    await this.db.insert(documents).values({
      id: input.documentId,
      collectionId: input.collectionId,
      currentRevisionId: input.revisionId,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      extension: input.extension,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      status: "pending",
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
    await this.db.insert(documentRevisions).values({
      id: input.revisionId,
      documentId: input.documentId,
      revision: 1,
      storageKey: input.storageKey,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      parserName: "none",
      parserVersion: "0",
      chunkerName: "none",
      chunkerVersion: "0",
      embeddingModel: "none",
      embeddingDimensions: 0,
      embeddingVersion: "0",
      chunkCount: 0,
      createdAt: now,
    });
    const document = await this.getDocument(input.documentId);
    if (!document) throw new Error("DOCUMENT_NOT_FOUND");
    return { document, revision: 1 };
  }

  async getDocument(id: string): Promise<Document | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .limit(1);
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async getLiveDocumentBySha256(sha256: string): Promise<Document | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.sha256, sha256), isNull(documents.deletedAt)))
      .limit(1);
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async listDocuments(
    q: ListDocumentsQuery,
  ): Promise<{ items: Document[]; nextCursor?: string }> {
    const filters = [isNull(documents.deletedAt)];
    if (q.collectionId) filters.push(eq(documents.collectionId, q.collectionId));
    if (q.status) filters.push(eq(documents.status, q.status));
    if (q.cursor) {
      const { createdAt, id } = decodeCursor(q.cursor);
      filters.push(
        or(
          lt(documents.createdAt, new Date(createdAt)),
          and(eq(documents.createdAt, new Date(createdAt)), lt(documents.id, id)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(...filters))
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDocument),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(last.createdAt, last.id)
          : undefined,
    };
  }

  async getRevisionStorageKey(documentId: string): Promise<string | null> {
    const doc = await this.getDocument(documentId);
    if (!doc?.currentRevisionId) return null;
    const rows = await this.db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.id, doc.currentRevisionId))
      .limit(1);
    return rows[0]?.storageKey ?? null;
  }

  async getRevision(revisionId: string): Promise<DocumentRevision | null> {
    const rows = await this.db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.id, revisionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      documentId: row.documentId,
      revision: row.revision,
      storageKey: row.storageKey,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      parserName: row.parserName,
      parserVersion: row.parserVersion,
      chunkerName: row.chunkerName,
      chunkerVersion: row.chunkerVersion,
      embeddingModel: row.embeddingModel,
      embeddingDimensions: row.embeddingDimensions,
      embeddingVersion: row.embeddingVersion,
      normalizedStorageKey: row.normalizedStorageKey ?? undefined,
      chunkCount: row.chunkCount,
      createdAt: row.createdAt,
    };
  }

  async setDocumentStatus(
    id: string,
    status: Document["status"],
    latestError?: string | null,
    title?: string,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(documents)
      .set({
        status,
        updatedAt: now,
        ...(latestError !== undefined ? { latestError } : {}),
        ...(title !== undefined ? { title } : {}),
      })
      .where(eq(documents.id, id));
  }

  async updateRevision(
    revisionId: string,
    patch: {
      parserName: string;
      parserVersion: string;
      chunkerName: string;
      chunkerVersion: string;
      embeddingModel: string;
      embeddingDimensions: number;
      embeddingVersion: string;
      normalizedStorageKey: string;
      chunkCount: number;
    },
  ): Promise<void> {
    await this.db
      .update(documentRevisions)
      .set(patch)
      .where(eq(documentRevisions.id, revisionId));
  }

  async replaceChunks(revisionId: string, chunks: StoredChunk[]): Promise<void> {
    await this.db.delete(documentChunks).where(eq(documentChunks.revisionId, revisionId));
    if (chunks.length === 0) return;
    await this.db.insert(documentChunks).values(
      chunks.map((c) => ({
        id: c.id,
        collectionId: c.collectionId,
        documentId: c.documentId,
        revisionId: c.revisionId,
        sequence: c.sequence,
        content: c.content,
        embeddingText: c.embeddingText,
        headingPath: c.headingPath,
        location: c.location,
        tokenCount: c.tokenCount,
        metadata: c.metadata,
        contentHash: c.contentHash,
        createdAt: c.createdAt,
      })),
    );
  }

  async listChunks(
    documentId: string,
    q: { limit: number; cursor?: string },
  ): Promise<{ items: StoredChunk[]; nextCursor?: string }> {
    const doc = await this.getDocument(documentId);
    if (!doc?.currentRevisionId) return { items: [] };
    const after = q.cursor ? Number(q.cursor) : -1;
    const rows = await this.db
      .select()
      .from(documentChunks)
      .where(
        and(eq(documentChunks.revisionId, doc.currentRevisionId), sql`${documentChunks.sequence} > ${after}`),
      )
      .orderBy(documentChunks.sequence)
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toChunk),
      nextCursor: rows.length > q.limit && last ? String(last.sequence) : undefined,
    };
  }

  async getChunk(id: string): Promise<StoredChunk | null> {
    const rows = await this.db.select().from(documentChunks).where(eq(documentChunks.id, id)).limit(1);
    return rows[0] ? toChunk(rows[0]) : null;
  }

  async listRevisionChunks(revisionId: string): Promise<StoredChunk[]> {
    const rows = await this.db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.revisionId, revisionId))
      .orderBy(documentChunks.sequence);
    return rows.map(toChunk);
  }

  async enqueueJob(input: { documentId: string; revisionId: string }): Promise<IngestionJob> {
    const now = new Date();
    const row = {
      id: newId("job"),
      documentId: input.documentId,
      revisionId: input.revisionId,
      status: "queued" as const,
      attempt: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(ingestionJobs).values(row);
    return toJob(row);
  }

  async claimJob(workerId: string, leaseMs: number): Promise<IngestionJob | null> {
    const now = Date.now();
    const leaseBefore = now - leaseMs;
    await this.client.execute("BEGIN IMMEDIATE");
    try {
      const result = await this.client.execute({
        sql: `UPDATE ingestion_jobs
SET status = 'running', locked_by = ?, locked_at = ?, started_at = COALESCE(started_at, ?), attempt = attempt + 1, updated_at = ?
WHERE id = (
  SELECT id FROM ingestion_jobs
  WHERE status IN ('queued', 'retrying')
     OR (status = 'running' AND locked_at < ?)
  ORDER BY created_at
  LIMIT 1
)
AND status IN ('queued', 'retrying', 'running')
RETURNING *`,
        args: [workerId, now, now, now, leaseBefore],
      });
      await this.client.execute("COMMIT");
      const row = result.rows[0];
      if (!row) return null;
      return jobFromRaw(row);
    } catch (error) {
      await this.client.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async completeJob(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(ingestionJobs)
      .set({ status: "completed", completedAt: now, updatedAt: now, lockedBy: null, lockedAt: null })
      .where(eq(ingestionJobs.id, id));
  }

  async failJob(id: string, error: Error): Promise<IngestionJob> {
    const existing = await this.getJob(id);
    if (!existing) throw new Error("JOB_NOT_FOUND");
    const now = new Date();
    const message = error.message.slice(0, 2000);
    const terminal = existing.attempt >= existing.maxAttempts;
    await this.db
      .update(ingestionJobs)
      .set({
        status: terminal ? "failed" : "retrying",
        error: message,
        updatedAt: now,
        lockedBy: null,
        lockedAt: null,
        completedAt: terminal ? now : null,
      })
      .where(eq(ingestionJobs.id, id));
    const updated = await this.getJob(id);
    if (!updated) throw new Error("JOB_NOT_FOUND");
    return updated;
  }

  async retryJob(id: string): Promise<IngestionJob> {
    const now = new Date();
    await this.db
      .update(ingestionJobs)
      .set({ status: "retrying", error: null, updatedAt: now, lockedBy: null, lockedAt: null })
      .where(eq(ingestionJobs.id, id));
    const updated = await this.getJob(id);
    if (!updated) throw new Error("JOB_NOT_FOUND");
    return updated;
  }

  async listJobs(): Promise<IngestionJob[]> {
    const rows = await this.db
      .select()
      .from(ingestionJobs)
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(100);
    return rows.map(toJob);
  }

  async getJob(id: string): Promise<IngestionJob | null> {
    const rows = await this.db.select().from(ingestionJobs).where(eq(ingestionJobs.id, id)).limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async softDeleteDocument(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(documents)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(eq(documents.id, id));
  }

  async createApiKey(input: {
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
  }): Promise<ApiKey> {
    const now = new Date();
    const row = {
      id: newId("key"),
      name: input.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      scopes: input.scopes,
      createdAt: now,
    };
    await this.db.insert(apiKeys).values(row);
    return toApiKey(row);
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKey | null> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return rows[0] ? toApiKey(rows[0]) : null;
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const rows = await this.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKey);
  }

  async touchApiKey(id: string): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }
}

export function createKnowledgeRepository(url: string): KnowledgeRepository {
  return new LibSqlKnowledgeRepository(createLibsqlDb(url), url);
}

function toApiKey(row: {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
}): ApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    scopes: row.scopes ?? [],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
  };
}

function toChunk(row: typeof documentChunks.$inferSelect): StoredChunk {
  return {
    id: row.id,
    collectionId: row.collectionId ?? undefined,
    documentId: row.documentId,
    revisionId: row.revisionId,
    sequence: row.sequence,
    content: row.content,
    embeddingText: row.embeddingText,
    headingPath: row.headingPath ?? [],
    location: row.location ?? undefined,
    tokenCount: row.tokenCount,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  };
}

function toJob(row: {
  id: string;
  documentId: string;
  revisionId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): IngestionJob {
  return {
    id: row.id,
    documentId: row.documentId,
    revisionId: row.revisionId,
    status: row.status as IngestionJob["status"],
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    lockedBy: row.lockedBy ?? undefined,
    lockedAt: row.lockedAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function asDate(value: unknown): Date | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value;
  const n = Number(value);
  return Number.isFinite(n) ? new Date(n) : undefined;
}

function jobFromRaw(row: Record<string, unknown>): IngestionJob {
  return toJob({
    id: String(row.id),
    documentId: String(row.document_id),
    revisionId: String(row.revision_id),
    status: String(row.status),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    lockedBy: row.locked_by as string | null,
    lockedAt: asDate(row.locked_at) ?? null,
    startedAt: asDate(row.started_at) ?? null,
    completedAt: asDate(row.completed_at) ?? null,
    error: row.error as string | null,
    createdAt: asDate(row.created_at) ?? new Date(),
    updatedAt: asDate(row.updated_at) ?? new Date(),
  });
}
