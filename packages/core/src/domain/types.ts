export type DocumentStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "deleting"
  | "deleted";

export type Collection = {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Document = {
  id: string;
  collectionId?: string;
  currentRevisionId?: string;
  title?: string;
  originalFilename: string;
  mimeType: string;
  extension?: string;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  metadata: Record<string, unknown>;
  latestError?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
};

export type DocumentRevision = {
  id: string;
  documentId: string;
  revision: number;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  parserName: string;
  parserVersion: string;
  chunkerName: string;
  chunkerVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  normalizedStorageKey?: string;
  chunkCount: number;
  createdAt: Date;
};

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "cancelled";

export type IngestionJob = {
  id: string;
  documentId: string;
  revisionId: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  lockedBy?: string;
  lockedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredChunk = {
  id: string;
  collectionId?: string;
  documentId: string;
  revisionId: string;
  sequence: number;
  content: string;
  embeddingText: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  tokenCount: number;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdAt: Date;
};

export type SearchHit = {
  chunkId: string;
  documentId: string;
  revisionId: string;
  title?: string;
  content: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  score: number;
  ranking: {
    finalRank: number;
    vectorRank?: number;
    lexicalRank?: number;
    vectorScore?: number;
    lexicalScore?: number;
    fusionScore?: number;
  };
  metadata: Record<string, unknown>;
};
