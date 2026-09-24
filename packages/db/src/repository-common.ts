import {
  AppError,
  type ApiKey,
  type ArchiveImport,
  type ArchiveImportEntry,
  type CatalogField,
  type Collection,
  type Document,
  type DocumentRevision,
  type IngestionJob,
  type SourceFileOutcome,
  type SourceFileRecord,
  type StoredChunk,
} from "@mcp-knowledge/core";

export const catalogFields: CatalogField[] = [
  "id",
  "revisionId",
  "title",
  "sourcePath",
  "metadata",
  "status",
  "updatedAt",
];

export function decodeCatalogCursor(cursor: string): { createdAt: number; id: string } {
  if (typeof cursor !== "string" || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AppError("INVALID_CURSOR", "The catalog cursor is invalid.");
  }
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^(0|[1-9]\d*):([^\s:]+)$/.exec(raw);
  const createdAt = Number(match?.[1]);
  if (!match || Buffer.from(raw).toString("base64url") !== cursor || !Number.isSafeInteger(createdAt)
    || !Number.isFinite(new Date(createdAt).getTime())) {
    throw new AppError("INVALID_CURSOR", "The catalog cursor is invalid.");
  }
  return { createdAt, id: match[2]! };
}

export function encodeCursor(createdAt: Date | number, id: string): string {
  const time = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return Buffer.from(`${time}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const idx = raw.indexOf(":");
  return { createdAt: Number(raw.slice(0, idx)), id: raw.slice(idx + 1) };
}

export function toCollection(row: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDocument(row: {
  id: string;
  collectionId: string | null;
  currentRevisionId: string | null;
  title: string | null;
  originalFilename: string;
  mimeType: string;
  extension: string | null;
  sizeBytes: number | bigint;
  sha256: string;
  status: string;
  metadata: unknown;
  latestError: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}): Document {
  return {
    id: row.id,
    collectionId: row.collectionId ?? undefined,
    currentRevisionId: row.currentRevisionId ?? undefined,
    title: row.title ?? undefined,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    extension: row.extension ?? undefined,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    status: row.status as Document["status"],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    latestError: row.latestError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

export function toRevision(row: {
  id: string;
  documentId: string;
  revision: number;
  storageKey: string;
  sha256: string;
  sizeBytes: number | bigint;
  parserName: string;
  parserVersion: string;
  chunkerName: string;
  chunkerVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  normalizedStorageKey: string | null;
  chunkCount: number;
  createdAt: Date;
}): DocumentRevision {
  return {
    id: row.id,
    documentId: row.documentId,
    revision: row.revision,
    storageKey: row.storageKey,
    sha256: row.sha256,
    sizeBytes: Number(row.sizeBytes),
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

export function toChunk(row: {
  id: string;
  collectionId: string | null;
  documentId: string;
  revisionId: string;
  sequence: number;
  content: string;
  embeddingText: string;
  headingPath: string[] | null;
  location: Record<string, unknown> | null;
  tokenCount: number;
  metadata: unknown;
  contentHash: string;
  createdAt: Date;
}): StoredChunk {
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

export function toJob(row: {
  id: string;
  documentId: string;
  revisionId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
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

export function toArchiveImport(row: {
  id: string;
  collectionId: string | null;
  originalFilename: string;
  metadata: unknown;
  state: string;
  entries: ArchiveImportEntry[] | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): ArchiveImport {
  return {
    id: row.id,
    collectionId: row.collectionId ?? undefined,
    originalFilename: row.originalFilename,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    state: row.state as ArchiveImport["state"],
    entries: (row.entries ?? []) as ArchiveImportEntry[],
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

export function toApiKey(row: {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    scopes: (row.scopes ?? []) as string[],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
  };
}

export function toSourceFile(row: {
  sourceId: string;
  relativePath: string;
  sha256: string | null;
  documentId: string | null;
  lastOutcome: string;
  scanCycle: string;
  createdAt: Date;
  updatedAt: Date;
}): SourceFileRecord {
  return {
    sourceId: row.sourceId,
    relativePath: row.relativePath,
    sha256: row.sha256 ?? undefined,
    documentId: row.documentId ?? undefined,
    lastOutcome: row.lastOutcome as SourceFileOutcome,
    scanCycle: row.scanCycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
