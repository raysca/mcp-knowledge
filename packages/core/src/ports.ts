import type { Collection, Document, DocumentRevision, IngestionJob, StoredChunk } from "./domain/types.ts";
import type { NormalizedDocument } from "./domain/normalized.ts";

export type DocumentParser = {
  name: string;
  version: string;
  supports(input: { mimeType?: string; extension?: string }): boolean;
  parse(input: {
    data: Blob;
    filename: string;
    mimeType?: string;
  }): Promise<NormalizedDocument>;
};

export type ListDocumentsQuery = {
  collectionId?: string;
  status?: string;
  cursor?: string;
  limit: number;
};

export type KnowledgeRepository = {
  createCollection(input: { name: string; description?: string }): Promise<Collection>;
  listCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection | null>;
  updateCollection(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Collection>;
  countDocumentsInCollection(id: string): Promise<number>;
  deleteCollection(id: string): Promise<void>;
  createDocument(input: {
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
  }): Promise<{ document: Document; revision: number }>;
  getDocument(id: string): Promise<Document | null>;
  getLiveDocumentBySha256(sha256: string): Promise<Document | null>;
  listDocuments(q: ListDocumentsQuery): Promise<{ items: Document[]; nextCursor?: string }>;
  getRevisionStorageKey(documentId: string): Promise<string | null>;
  getRevision(revisionId: string): Promise<DocumentRevision | null>;
  setDocumentStatus(
    id: string,
    status: Document["status"],
    latestError?: string | null,
    title?: string,
  ): Promise<void>;
  updateRevision(
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
  ): Promise<void>;
  replaceChunks(revisionId: string, chunks: StoredChunk[]): Promise<void>;
  listChunks(
    documentId: string,
    q: { limit: number; cursor?: string },
  ): Promise<{ items: StoredChunk[]; nextCursor?: string }>;
  getChunk(id: string): Promise<StoredChunk | null>;
  listRevisionChunks(revisionId: string): Promise<StoredChunk[]>;
  enqueueJob(input: { documentId: string; revisionId: string }): Promise<IngestionJob>;
  claimJob(workerId: string, leaseMs: number): Promise<IngestionJob | null>;
  completeJob(id: string): Promise<void>;
  failJob(id: string, error: Error): Promise<IngestionJob>;
  retryJob(id: string): Promise<IngestionJob>;
  listJobs(): Promise<IngestionJob[]>;
  getJob(id: string): Promise<IngestionJob | null>;
  softDeleteDocument(id: string): Promise<void>;
};

export type BlobStore = {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};

export type Embedder = {
  name: string;
  model: string;
  version: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

export type EmbeddedChunk = {
  chunkId: string;
  vector: number[];
};

export type VectorHit = {
  chunkId: string;
  documentId: string;
  revisionId: string;
  title?: string;
  content: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  score: number;
  vectorRank: number;
  vectorScore: number;
};

export type LexicalHit = {
  chunkId: string;
  documentId: string;
  revisionId: string;
  title?: string;
  content: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  score: number;
  lexicalRank: number;
  lexicalScore: number;
};

export type FilterClause = {
  field: string;
  op: "eq" | "neq" | "in" | "exists" | "gte" | "lte";
  value?: unknown;
};

export type VectorIndex = {
  insert(chunks: EmbeddedChunk[]): Promise<void>;
  search(input: {
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    vector: number[];
    limit: number;
  }): Promise<VectorHit[]>;
  deleteRevision(revisionId: string): Promise<void>;
};

export type LexicalIndex = {
  search(input: {
    query: string;
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    limit: number;
  }): Promise<LexicalHit[]>;
};
