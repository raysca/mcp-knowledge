import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { SourceFileOutcome } from "@mcp-knowledge/core";

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

export const sourceScanState = sqliteTable("source_scan_state", {
  sourceId: text("source_id").primaryKey(),
  configurationFingerprint: text("configuration_fingerprint").notNull(),
  activeCycle: text("active_cycle"),
  limitReached: integer("limit_reached", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sourceFiles = sqliteTable(
  "source_files",
  {
    sourceId: text("source_id").notNull(),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256"),
    documentId: text("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    lastOutcome: text("last_outcome").$type<SourceFileOutcome>().notNull(),
    scanCycle: text("scan_cycle").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.relativePath] }),
    uniqueIndex("source_files_document_owned")
      .on(table.documentId)
      .where(sql`${table.documentId} is not null`),
    index("source_files_source_sha").on(table.sourceId, table.sha256),
    index("source_files_source_cycle").on(table.sourceId, table.scanCycle),
  ],
);

// ponytail: webhooks/webhook_deliveries/system_settings dropped - post-v1 per CLAUDE.md,
// no reader/writer existed. Re-add when a real integration needs push delivery.
