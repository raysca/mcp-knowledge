import type { Collection, Document } from "./domain/types.ts";

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
  softDeleteDocument(id: string): Promise<void>;
};

export type BlobStore = {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
};
