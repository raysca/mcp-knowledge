import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  newId,
  type Collection,
  type Document,
  type KnowledgeRepository,
  type ListDocumentsQuery,
} from "@mcp-knowledge/core";
import { createLibsqlDb } from "./libsql.ts";
import {
  collections,
  documentRevisions,
  documents,
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
  constructor(private readonly db: Db) {}

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

  async softDeleteDocument(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(documents)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(eq(documents.id, id));
  }
}

export function createKnowledgeRepository(url: string): KnowledgeRepository {
  return new LibSqlKnowledgeRepository(createLibsqlDb(url));
}
