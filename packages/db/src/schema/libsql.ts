import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    currentRevisionId: text("current_revision_id"),
    title: text("title"),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    extension: text("extension"),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    latestError: text("latest_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("documents_collection_id_idx").on(table.collectionId),
    index("documents_status_idx").on(table.status),
    index("documents_deleted_at_idx").on(table.deletedAt),
    uniqueIndex("documents_sha256_live")
      .on(table.sha256)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const documentRevisions = sqliteTable(
  "document_revisions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    parserName: text("parser_name").notNull(),
    parserVersion: text("parser_version").notNull(),
    chunkerName: text("chunker_name").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingVersion: text("embedding_version").notNull(),
    normalizedStorageKey: text("normalized_storage_key"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("document_revisions_document_id_idx").on(table.documentId),
    uniqueIndex("document_revisions_doc_rev").on(table.documentId, table.revision),
  ],
);

export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id"),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    content: text("content").notNull(),
    embeddingText: text("embedding_text").notNull(),
    headingPath: text("heading_path", { mode: "json" }).$type<string[]>().notNull(),
    location: text("location", { mode: "json" }).$type<Record<string, unknown>>(),
    tokenCount: integer("token_count").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("document_chunks_rev_seq").on(table.revisionId, table.sequence),
    uniqueIndex("document_chunks_rev_hash").on(table.revisionId, table.contentHash),
    index("document_chunks_document_id_idx").on(table.documentId),
  ],
);

export const ingestionJobs = sqliteTable(
  "ingestion_jobs",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ingestion_jobs_status_created_idx").on(table.status, table.createdAt),
    index("ingestion_jobs_revision_id_idx").on(table.revisionId),
  ],
);

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  secret: text("secret").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id")
    .notNull()
    .references(() => webhooks.id, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(0),
  httpStatus: integer("http_status"),
  lastError: text("last_error"),
  nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
});

export const systemSettings = sqliteTable("system_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
