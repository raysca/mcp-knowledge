import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type {
  ApiKey,
  ArchiveImport,
  ArchiveImportEntry,
  CatalogField,
  CatalogItem,
  CatalogPage,
  Collection,
  Document,
  DocumentRevision,
  IngestionJob,
  KnowledgeRepository,
  ListDocumentCatalogQuery,
  ListDocumentsQuery,
  SourceFileOutcome,
  SourceFileRecord,
  SourceScanCycle,
  StoredChunk,
} from "@mcp-knowledge/core";
import { AppError, newId, parseFilters } from "@mcp-knowledge/core";
import { createPostgresClient, createPostgresDb, type PostgresClient } from "./postgres.ts";
import {
  apiKeys,
  archiveImports,
  collections,
  corpusState,
  documentChunks,
  documentRevisions,
  documents,
  ingestionJobs,
  sourceFiles,
  sourceScanState,
} from "./schema/postgres.ts";

import {
  catalogFields,
  decodeCatalogCursor,
  decodeCursor,
  encodeCursor,
  toApiKey,
  toArchiveImport,
  toChunk,
  toCollection,
  toDocument,
  toJob,
  toRevision,
  toSourceFile,
} from "./repository-common.ts";

type Db = ReturnType<typeof createPostgresDb>;
type CommitSourceImportInput = Parameters<KnowledgeRepository["commitSourceImport"]>[0];
type CommitSourceImportResult = Awaited<
  ReturnType<KnowledgeRepository["commitSourceImport"]>
>;

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function jobFromRaw(row: Record<string, unknown>): IngestionJob {
  const createdAt = asDate(row.created_at);
  const updatedAt = asDate(row.updated_at);
  if (!createdAt || !updatedAt) {
    throw new Error("Corrupt job record: missing created_at or updated_at");
  }
  return toJob({
    id: String(row.id),
    documentId: String(row.document_id),
    revisionId: String(row.revision_id),
    status: String(row.status),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    lockedBy: (row.locked_by as string | null) ?? null,
    lockedAt: asDate(row.locked_at) ?? null,
    startedAt: asDate(row.started_at) ?? null,
    completedAt: asDate(row.completed_at) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt,
    updatedAt,
  });
}

function archiveImportFromRaw(row: Record<string, unknown>): ArchiveImport {
  const createdAt = asDate(row.created_at);
  if (!createdAt) {
    throw new Error("Corrupt archive import record: missing created_at");
  }
  return toArchiveImport({
    id: String(row.id),
    collectionId: (row.collection_id as string | null) ?? null,
    originalFilename: String(row.original_filename),
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : ((row.metadata ?? {}) as Record<string, unknown>),
    state: String(row.state),
    entries: typeof row.entries === "string" ? JSON.parse(row.entries) : ((row.entries ?? []) as ArchiveImportEntry[]),
    error: (row.error as string | null) ?? null,
    createdAt,
    startedAt: asDate(row.started_at) ?? null,
    completedAt: asDate(row.completed_at) ?? null,
  });
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  private readonly db: Db;
  private readonly client: PostgresClient;
  private readonly ownsClient: boolean;

  constructor(clientOrUrl: string | PostgresClient) {
    if (typeof clientOrUrl === "string") {
      this.client = createPostgresClient(clientOrUrl);
      this.ownsClient = true;
    } else {
      this.client = clientOrUrl;
      this.ownsClient = false;
    }
    this.db = createPostgresDb(this.client);
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.end();
    }
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

  async getCorpusGeneration(): Promise<number> {
    const rows = await this.db
      .select({ generation: corpusState.generation })
      .from(corpusState)
      .where(eq(corpusState.id, 1))
      .limit(1);
    return rows[0] ? Number(rows[0].generation) : 0;
  }

  async listDocumentCatalog(q: ListDocumentCatalogQuery): Promise<CatalogPage> {
    if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit >= Number.MAX_SAFE_INTEGER) {
      throw new AppError("INVALID_ARGUMENT", "Catalog limit must be a positive integer.");
    }
    const status = q.status ?? "ready";
    if (
      !["pending", "processing", "ready", "failed", "deleted"].includes(status) ||
      (q.collectionId !== undefined && (typeof q.collectionId !== "string" || !q.collectionId))
    ) {
      throw new AppError("INVALID_ARGUMENT", "Catalog status or collection is invalid.");
    }
    const fields = q.fields ?? catalogFields.slice(0, 5);
    if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => !catalogFields.includes(field))) {
      throw new AppError("INVALID_PROJECTION", "Catalog fields must come from the fixed projection.");
    }
    const predicates = [
      status === "deleted" ? isNotNull(documents.deletedAt) : isNull(documents.deletedAt),
      eq(documents.status, status),
    ];
    if (q.collectionId !== undefined) predicates.push(eq(documents.collectionId, q.collectionId));
    if (q.cursor !== undefined) {
      const { createdAt, id } = decodeCatalogCursor(q.cursor);
      predicates.push(
        or(
          lt(documents.createdAt, new Date(createdAt)),
          and(eq(documents.createdAt, new Date(createdAt)), lt(documents.id, id)),
        )!,
      );
    }
    if (q.filters !== undefined && !Array.isArray(q.filters)) {
      throw new AppError("INVALID_FILTER", "Catalog filters must be parsed metadata clauses.");
    }
    for (const clause of q.filters ?? []) {
      if (!clause || typeof clause.field !== "string" || typeof clause.op !== "string") {
        throw new AppError("INVALID_FILTER", "Invalid catalog filter clause.");
      }
      parseFilters({ [clause.field]: { [clause.op]: clause.value } });
      const path = `{${clause.field.split(".").join(",")}}`;
      const isJsonNull = sql`jsonb_typeof(${documents.metadata} #> ${path}::text[]) = 'null'`;
      const extract = sql`${documents.metadata} #>> ${path}::text[]`;
      switch (clause.op) {
        case "eq":
          predicates.push(clause.value === null ? isJsonNull : sql`${extract} = ${String(clause.value)}`);
          break;
        case "neq":
          predicates.push(sql`${extract} IS DISTINCT FROM ${String(clause.value)}`);
          break;
        case "exists":
          predicates.push(clause.value === false ? sql`${extract} IS NULL` : sql`${extract} IS NOT NULL`);
          break;
        case "gte":
          predicates.push(sql`CAST(${extract} AS NUMERIC) >= ${clause.value}`);
          break;
        case "lte":
          predicates.push(sql`CAST(${extract} AS NUMERIC) <= ${clause.value}`);
          break;
        case "in": {
          const values = clause.value as unknown[];
          const nonNull = values.filter((v) => v !== null);
          const membership = sql`${extract} IN (${sql.join(nonNull.map((v) => sql`${String(v)}`), sql`, `)})`;
          predicates.push(
            nonNull.length === 0
              ? isJsonNull
              : values.includes(null)
              ? or(membership, isJsonNull)!
              : membership,
          );
          break;
        }
      }
    }
    const rows = await this.db
      .select({
        id: documents.id,
        revisionId: documents.currentRevisionId,
        title: documents.title,
        originalFilename: documents.originalFilename,
        metadata: documents.metadata,
        status: documents.status,
        updatedAt: documents.updatedAt,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(and(...predicates))
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        const item: CatalogItem = {
          id: row.id,
          revisionId: row.revisionId ?? undefined,
          title: row.title ?? undefined,
          sourcePath: typeof metadata.sourcePath === "string" ? metadata.sourcePath : row.originalFilename,
          metadata,
          status: row.status as Document["status"],
          updatedAt: row.updatedAt,
        };
        return Object.fromEntries(fields.map((field) => [field, item[field]]));
      }),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : undefined,
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
    return rows[0] ? toRevision(rows[0]) : null;
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
    return toJob({
      ...row,
      lockedBy: null,
      lockedAt: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
  }

  async claimJob(workerId: string, leaseMs: number): Promise<IngestionJob | null> {
    const now = new Date();
    const leaseBefore = new Date(now.getTime() - leaseMs);
    const rows = await this.client`
      WITH next_job AS (
        SELECT id FROM ingestion_jobs
        WHERE status IN ('queued', 'retrying')
           OR (status = 'running' AND locked_at < ${leaseBefore.toISOString()}::timestamptz)
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ingestion_jobs
      SET status = 'running',
          locked_by = ${workerId},
          locked_at = ${now.toISOString()}::timestamptz,
          started_at = COALESCE(started_at, ${now.toISOString()}::timestamptz),
          attempt = attempt + 1,
          updated_at = ${now.toISOString()}::timestamptz
      FROM next_job
      WHERE ingestion_jobs.id = next_job.id
      RETURNING ingestion_jobs.*
    `;
    const row = rows[0];
    if (!row) return null;
    return jobFromRaw(row as Record<string, unknown>);
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

  async createArchiveImport(input: {
    id: string;
    originalFilename: string;
    collectionId?: string;
    stagingStorageKey: string;
    metadata: Record<string, unknown>;
  }): Promise<ArchiveImport> {
    const now = new Date();
    const row = {
      id: input.id,
      collectionId: input.collectionId ?? null,
      originalFilename: input.originalFilename,
      metadata: input.metadata,
      state: "queued" as const,
      stagingStorageKey: input.stagingStorageKey,
      entries: [] as ArchiveImportEntry[],
      createdAt: now,
    };
    await this.db.insert(archiveImports).values(row);
    return toArchiveImport({
      ...row,
      error: null,
      startedAt: null,
      completedAt: null,
    });
  }

  async getArchiveImport(id: string): Promise<ArchiveImport | null> {
    const rows = await this.db.select().from(archiveImports).where(eq(archiveImports.id, id)).limit(1);
    return rows[0] ? toArchiveImport(rows[0]) : null;
  }

  async getArchiveImportStagingKey(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ stagingStorageKey: archiveImports.stagingStorageKey })
      .from(archiveImports)
      .where(eq(archiveImports.id, id))
      .limit(1);
    return rows[0]?.stagingStorageKey ?? null;
  }

  async listArchiveImports(q: { cursor?: string; limit: number }): Promise<{
    items: ArchiveImport[];
    nextCursor?: string;
  }> {
    const cursorCondition = q.cursor
      ? (() => {
          const { createdAt, id } = decodeCursor(q.cursor!);
          return or(
            lt(archiveImports.createdAt, new Date(createdAt)),
            and(eq(archiveImports.createdAt, new Date(createdAt)), lt(archiveImports.id, id)),
          );
        })()
      : undefined;
    const rows = await this.db
      .select()
      .from(archiveImports)
      .where(cursorCondition)
      .orderBy(desc(archiveImports.createdAt), desc(archiveImports.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(toArchiveImport);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
    };
  }

  async claimArchiveImport(workerId: string, leaseMs: number): Promise<ArchiveImport | null> {
    const now = new Date();
    const leaseBefore = new Date(now.getTime() - leaseMs);
    const rows = await this.client`
      WITH next_import AS (
        SELECT id FROM archive_imports
        WHERE state = 'queued'
           OR (state = 'extracting' AND locked_at < ${leaseBefore.toISOString()}::timestamptz)
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE archive_imports
      SET state = 'extracting',
          locked_by = ${workerId},
          locked_at = ${now.toISOString()}::timestamptz,
          started_at = COALESCE(started_at, ${now.toISOString()}::timestamptz),
          entries = '[]'::jsonb
      FROM next_import
      WHERE archive_imports.id = next_import.id
      RETURNING archive_imports.*
    `;
    const row = rows[0];
    if (!row) return null;
    return archiveImportFromRaw(row as Record<string, unknown>);
  }

  async appendArchiveImportEntry(id: string, entry: ArchiveImportEntry): Promise<void> {
    await this.client`
      UPDATE archive_imports
      SET entries = entries || ${JSON.stringify([entry])}::jsonb
      WHERE id = ${id}
    `;
  }

  async finishArchiveImport(id: string, state: "completed" | "completed_with_errors"): Promise<void> {
    const now = new Date();
    await this.db
      .update(archiveImports)
      .set({ state, completedAt: now, lockedBy: null, lockedAt: null, stagingStorageKey: null })
      .where(eq(archiveImports.id, id));
  }

  async failArchiveImport(id: string, error: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(archiveImports)
      .set({
        state: "failed",
        error,
        completedAt: now,
        lockedBy: null,
        lockedAt: null,
        stagingStorageKey: null,
      })
      .where(eq(archiveImports.id, id));
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
    return toApiKey({
      ...row,
      lastUsedAt: null,
      revokedAt: null,
    });
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

  async listRevisionBlobKeys(): Promise<string[]> {
    const rows = await this.db
      .select({
        storageKey: documentRevisions.storageKey,
        normalizedStorageKey: documentRevisions.normalizedStorageKey,
      })
      .from(documentRevisions);
    const keys: string[] = [];
    for (const row of rows) {
      keys.push(row.storageKey);
      if (row.normalizedStorageKey) keys.push(row.normalizedStorageKey);
    }
    return keys;
  }

  async listDocumentBlobKeys(documentId: string): Promise<string[]> {
    const rows = await this.db
      .select({
        storageKey: documentRevisions.storageKey,
        normalizedStorageKey: documentRevisions.normalizedStorageKey,
      })
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, documentId));
    const keys: string[] = [];
    for (const row of rows) {
      keys.push(row.storageKey);
      if (row.normalizedStorageKey) keys.push(row.normalizedStorageKey);
    }
    return keys;
  }

  async purgeDocuments(): Promise<number> {
    const existing = await this.db.select({ id: documents.id }).from(documents);
    if (existing.length === 0) return 0;
    await this.db.delete(documents);
    return existing.length;
  }

  async openSourceScan(input: {
    sourceId: string;
    configurationFingerprint: string;
    proposedCycleId: string;
  }): Promise<SourceScanCycle> {
    return this.client.begin(async (sql: any) => {
      const now = new Date();
      const existing = await sql`
        SELECT configuration_fingerprint, active_cycle
        FROM source_scan_state
        WHERE source_id = ${input.sourceId}
      `;
      const row = existing[0];
      const resumed =
        row?.active_cycle != null &&
        String(row.configuration_fingerprint) === input.configurationFingerprint;
      const cycleId = resumed ? String(row.active_cycle) : input.proposedCycleId;

      if (resumed) {
        await sql`
          UPDATE source_scan_state
          SET configuration_fingerprint = ${input.configurationFingerprint},
              updated_at = ${now.toISOString()}::timestamptz
          WHERE source_id = ${input.sourceId}
        `;
      } else {
        await sql`
          INSERT INTO source_scan_state (
            source_id, configuration_fingerprint, active_cycle, limit_reached, started_at, updated_at
          ) VALUES (
            ${input.sourceId}, ${input.configurationFingerprint}, ${input.proposedCycleId}, false,
            ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
          )
          ON CONFLICT(source_id) DO UPDATE SET
            configuration_fingerprint = EXCLUDED.configuration_fingerprint,
            active_cycle = EXCLUDED.active_cycle,
            limit_reached = false,
            started_at = EXCLUDED.started_at,
            updated_at = EXCLUDED.updated_at
        `;
      }
      return { cycleId, resumed };
    });
  }

  async getSourceFile(
    sourceId: string,
    relativePath: string,
  ): Promise<SourceFileRecord | null> {
    const rows = await this.db
      .select()
      .from(sourceFiles)
      .where(
        and(eq(sourceFiles.sourceId, sourceId), eq(sourceFiles.relativePath, relativePath)),
      )
      .limit(1);
    return rows[0] ? toSourceFile(rows[0]) : null;
  }

  async findLiveOwnedSourceBySha256(
    sourceId: string,
    sha256: string,
  ): Promise<SourceFileRecord | null> {
    const rows = await this.db
      .select({ sourceFile: sourceFiles })
      .from(sourceFiles)
      .innerJoin(documents, eq(sourceFiles.documentId, documents.id))
      .where(
        and(
          eq(sourceFiles.sourceId, sourceId),
          eq(sourceFiles.sha256, sha256),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toSourceFile(rows[0].sourceFile) : null;
  }

  async recordSourceFile(input: {
    sourceId: string;
    relativePath: string;
    sha256: string | null;
    documentId: string | null;
    lastOutcome: SourceFileOutcome;
    scanCycle: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insert(sourceFiles)
      .values({ ...input, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [sourceFiles.sourceId, sourceFiles.relativePath],
        set: {
          sha256: input.sha256,
          documentId: input.documentId,
          lastOutcome: input.lastOutcome,
          scanCycle: input.scanCycle,
          updatedAt: now,
        },
      });
  }

  async commitSourceImport(
    input: CommitSourceImportInput,
  ): Promise<CommitSourceImportResult> {
    return this.client.begin(async (sql: any) => {
      const now = new Date();
      if (
        input.mode === "duplicate" &&
        input.duplicateDocumentId === input.replaceDocumentId
      ) {
        throw new Error("DUPLICATE_DOCUMENT_EQUALS_REPLACEMENT");
      }

      const destination = await sql`
        SELECT source_id, relative_path, sha256, document_id
        FROM source_files
        WHERE source_id = ${input.sourceId} AND relative_path = ${input.relativePath}
        LIMIT 1
      `;
      const destinationDocumentId = destination[0]?.document_id;
      if (
        destinationDocumentId != null &&
        String(destinationDocumentId) !== input.replaceDocumentId
      ) {
        throw new Error("SOURCE_DESTINATION_OWNED");
      }

      let replacementRelativePath: string | undefined;
      if (input.replaceDocumentId) {
        const ownership = await sql`
          SELECT relative_path
          FROM source_files
          WHERE source_id = ${input.sourceId}
            AND document_id = ${input.replaceDocumentId}
            AND document_id IS NOT NULL
          LIMIT 1
        `;
        const row = ownership[0];
        if (!row) throw new Error("SOURCE_DOCUMENT_NOT_OWNED");
        replacementRelativePath = String(row.relative_path);
      }

      const retireReplacement = async (): Promise<void> => {
        if (!input.replaceDocumentId) return;
        await sql`
          UPDATE documents
          SET status = 'deleted', deleted_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
          WHERE id = ${input.replaceDocumentId}
        `;
        if (replacementRelativePath !== input.relativePath) {
          await sql`
            DELETE FROM source_files
            WHERE source_id = ${input.sourceId}
              AND relative_path = ${replacementRelativePath!}
              AND document_id = ${input.replaceDocumentId}
          `;
        }
      };

      const upsertSourceFile = async (
        documentId: string | null,
        lastOutcome: "imported" | "duplicate",
      ): Promise<void> => {
        await sql`
          INSERT INTO source_files (
            source_id, relative_path, sha256, document_id, last_outcome, scan_cycle,
            created_at, updated_at
          ) VALUES (
            ${input.sourceId}, ${input.relativePath}, ${input.sha256}, ${documentId},
            ${lastOutcome}, ${input.scanCycle}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
          )
          ON CONFLICT(source_id, relative_path) DO UPDATE SET
            sha256 = EXCLUDED.sha256,
            document_id = EXCLUDED.document_id,
            last_outcome = EXCLUDED.last_outcome,
            scan_cycle = EXCLUDED.scan_cycle,
            updated_at = EXCLUDED.updated_at
        `;
      };

      if (input.mode === "duplicate") {
        const duplicate = await sql`
          SELECT id
          FROM documents
          WHERE id = ${input.duplicateDocumentId}
            AND sha256 = ${input.sha256}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        if (!duplicate[0]) throw new Error("DUPLICATE_DOCUMENT_NOT_LIVE");

        await retireReplacement();
        await upsertSourceFile(null, "duplicate");
        return {
          outcome: "duplicate",
          duplicateDocumentId: input.duplicateDocumentId,
          retiredDocumentId: input.replaceDocumentId,
        };
      }

      const liveHash = await sql`
        SELECT id
        FROM documents
        WHERE sha256 = ${input.prepared.sha256} AND deleted_at IS NULL
        LIMIT 1
      `;
      const liveDocumentId = liveHash[0] ? String(liveHash[0].id) : undefined;
      if (liveDocumentId && liveDocumentId !== input.replaceDocumentId) {
        await retireReplacement();
        await upsertSourceFile(null, "duplicate");
        return {
          outcome: "duplicate",
          duplicateDocumentId: liveDocumentId,
          ...(input.replaceDocumentId
            ? { retiredDocumentId: input.replaceDocumentId }
            : {}),
        };
      }

      await retireReplacement();
      await sql`
        INSERT INTO documents (
          id, current_revision_id, original_filename, mime_type, extension,
          size_bytes, sha256, status, metadata, created_at, updated_at
        ) VALUES (
          ${input.prepared.documentId}, ${input.prepared.revisionId},
          ${input.prepared.originalFilename}, ${input.prepared.mimeType},
          ${input.prepared.extension ?? null}, ${input.prepared.sizeBytes},
          ${input.prepared.sha256}, 'processing',
          ${JSON.stringify(input.prepared.metadata)}::jsonb,
          ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
        )
      `;
      await sql`
        INSERT INTO document_revisions (
          id, document_id, revision, storage_key, sha256, size_bytes,
          parser_name, parser_version, chunker_name, chunker_version,
          embedding_model, embedding_dimensions, embedding_version, chunk_count, created_at
        ) VALUES (
          ${input.prepared.revisionId}, ${input.prepared.documentId}, 1,
          ${input.prepared.storageKey}, ${input.prepared.sha256},
          ${input.prepared.sizeBytes}, 'none', '0', 'none', '0', 'none', 0, '0', 0, ${now.toISOString()}::timestamptz
        )
      `;

      const jobId = newId("job");
      await sql`
        INSERT INTO ingestion_jobs (
          id, document_id, revision_id, status, attempt, max_attempts, created_at, updated_at
        ) VALUES (
          ${jobId}, ${input.prepared.documentId}, ${input.prepared.revisionId},
          'queued', 0, 3, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
        )
      `;
      await upsertSourceFile(input.prepared.documentId, "imported");
      return {
        outcome: "imported",
        documentId: input.prepared.documentId,
        jobId,
        ...(input.replaceDocumentId
          ? { retiredDocumentId: input.replaceDocumentId }
          : {}),
      };
    });
  }

  async completeSourceScan(input: {
    sourceId: string;
    cycleId: string;
    limitReached: boolean;
  }): Promise<void> {
    return this.client.begin(async (sql: any) => {
      const state = await sql`
        SELECT active_cycle FROM source_scan_state WHERE source_id = ${input.sourceId}
      `;
      if (state[0]?.active_cycle !== input.cycleId) return;

      const now = new Date();
      if (input.limitReached) {
        await sql`
          UPDATE source_scan_state
          SET limit_reached = true, updated_at = ${now.toISOString()}::timestamptz
          WHERE source_id = ${input.sourceId} AND active_cycle = ${input.cycleId}
        `;
      } else {
        await sql`
          DELETE FROM source_files
          WHERE source_id = ${input.sourceId} AND document_id IS NULL AND scan_cycle <> ${input.cycleId}
        `;
        await sql`
          UPDATE source_scan_state
          SET active_cycle = NULL, limit_reached = false, updated_at = ${now.toISOString()}::timestamptz
          WHERE source_id = ${input.sourceId} AND active_cycle = ${input.cycleId}
        `;
      }
    });
  }
}

export function createPostgresKnowledgeRepository(clientOrUrl: string | PostgresClient): PostgresKnowledgeRepository {
  return new PostgresKnowledgeRepository(clientOrUrl);
}
