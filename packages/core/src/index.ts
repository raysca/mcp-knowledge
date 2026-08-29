export { AppError, errorBody, type ErrorBody } from "./errors.ts";
export { ID_PREFIXES, newId, uuidv7, type IdPrefix } from "./ids.ts";
export { CollectionService } from "./services/collection-service.ts";
export { IngestionService, errorCodeOf, normalizedStorageKey } from "./services/ingestion-service.ts";
export { SearchService } from "./services/search-service.ts";
export { DocumentService, originalStorageKey } from "./services/document-service.ts";
export { extensionOf, isAllowedUpload, sniffMime } from "./mime.ts";
export type {
  Collection,
  Document,
  DocumentRevision,
  DocumentStatus,
  IngestionJob,
  JobStatus,
  StoredChunk,
  SearchHit,
} from "./domain/types.ts";
export type {
  DocumentBlock,
  NormalizedDocument,
  SourceLocation,
} from "./domain/normalized.ts";
export type {
  BlobStore,
  EmbeddedChunk,
  Embedder,
  FilterClause,
  KnowledgeRepository,
  LexicalHit,
  LexicalIndex,
  ListDocumentsQuery,
  VectorHit,
  VectorIndex,
} from "./ports.ts";
export type { DocumentParser } from "./ports.ts";
export { chunkBlocks } from "./chunking/chunk.ts";
export { loadWordPiece } from "./chunking/wordpiece.ts";
export { compileFilters, parseFilters } from "./retrieval/filters.ts";
export { hybridRrf, rrf } from "./retrieval/rrf.ts";
