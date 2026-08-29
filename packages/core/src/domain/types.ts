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
