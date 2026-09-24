import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ArchiveImportEntry, SourceFileOutcome } from "@mcp-knowledge/core";

export const collections = pgTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const documents = pgTable(
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
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    latestError: text("latest_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
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

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    parserName: text("parser_name").notNull(),
    parserVersion: text("parser_version").notNull(),
    chunkerName: text("chunker_name").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingVersion: text("embedding_version").notNull(),
    normalizedStorageKey: text("normalized_storage_key"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("document_revisions_document_id_idx").on(table.documentId),
    uniqueIndex("document_revisions_doc_rev").on(table.documentId, table.revision),
  ],
);

export const documentChunks = pgTable(
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
    headingPath: jsonb("heading_path").$type<string[]>().notNull(),
    location: jsonb("location").$type<Record<string, unknown>>(),
    tokenCount: integer("token_count").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("document_chunks_rev_seq").on(table.revisionId, table.sequence),
    uniqueIndex("document_chunks_rev_hash").on(table.revisionId, table.contentHash),
    index("document_chunks_document_id_idx").on(table.documentId),
  ],
);

export const ingestionJobs = pgTable(
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
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    index("ingestion_jobs_status_created_idx").on(table.status, table.createdAt),
    index("ingestion_jobs_revision_id_idx").on(table.revisionId),
    uniqueIndex("ingestion_jobs_active_rev")
      .on(table.revisionId)
      .where(sql`${table.status} in ('queued', 'running', 'retrying')`),
  ],
);

export const archiveImports = pgTable(
  "archive_imports",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    originalFilename: text("original_filename").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text("state").notNull(),
    stagingStorageKey: text("staging_storage_key"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
    entries: jsonb("entries")
      .$type<ArchiveImportEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("archive_imports_state_created_idx").on(table.state, table.createdAt),
  ],
);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
});

export const sourceScanState = pgTable("source_scan_state", {
  sourceId: text("source_id").primaryKey(),
  configurationFingerprint: text("configuration_fingerprint").notNull(),
  activeCycle: text("active_cycle"),
  limitReached: boolean("limit_reached").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const sourceFiles = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
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

export const corpusState = pgTable("corpus_state", {
  id: integer("id").primaryKey(),
  generation: bigint("generation", { mode: "number" }).notNull(),
});

